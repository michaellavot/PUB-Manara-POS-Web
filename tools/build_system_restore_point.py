#!/usr/bin/env python3
"""Build/verify an immutable, secret-free POS system release artifact.

The operator runs this on a protected runner with read-only schema access and
Supabase Management access. Never pass credentials on the command line. This
script does not deploy, restore, charge, or modify POS business data.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import zipfile

MAX_BYTES = 64 * 1024 * 1024
BUCKET = "pos-system-release-artifacts"
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
SHA_RE = re.compile(r"^[a-f0-9]{40}$")
SOURCE_EXT = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".json",
              ".webmanifest", ".svg", ".md", ".txt", ".py", ".sql", ".sh", ".toml",
              ".yaml", ".yml", ".png", ".gif", ".jpg", ".jpeg", ".webp", ".ico",
              ".ttf", ".woff", ".woff2", ".wasm"}
SECRET_NAME = re.compile(r"(^|[/._-])(?:\.?env|secret[s]?|credentials?|private[-_]?key)([/._-]|$)", re.I)
SECRET_BYTES = [re.compile(x, re.I) for x in (
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    rb"sb_secret_[A-Za-z0-9_-]{15,}",
    rb"GOCSPX-[A-Za-z0-9_-]{12,}",
    rb"(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}",
    rb"postgres(?:ql)?://[^ \r\n:@/]+:[^ \r\n@/]+@",
    rb"ya29\.[A-Za-z0-9_-]{20,}",
)]
def digest(data):
    return hashlib.sha256(data).hexdigest()

def allowed_path(path):
    p = PurePosixPath(path)
    return (not p.is_absolute() and ".." not in p.parts and
            p.suffix.lower() in SOURCE_EXT and not SECRET_NAME.search(path) and
            not any(x in {".git", "node_modules", "__pycache__", "backups", ".supabase"} for x in p.parts))

def scan(path, data):
    if any(p.search(data) for p in SECRET_BYTES):
        raise RuntimeError("Potential secret in " + path + "; artifact refused")
    for jwt in re.findall(rb"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", data):
        try:
            mid = jwt.split(b".")[1]
            payload = json.loads(base64.urlsafe_b64decode(mid + b"=" * (-len(mid) % 4)))
        except Exception:
            continue
        if payload.get("role") == "service_role":
            raise RuntimeError("Service-role token in " + path + "; artifact refused")

def run(args, cwd=None, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        # Avoid printing CLI stderr that might contain connection details.
        raise RuntimeError("Command failed: " + args[0] + " " + " ".join(args[1:3]))
    return result.stdout

def git_files(repo, commit):
    paths = run(["git", "ls-tree", "-r", "--name-only", "-z", commit], cwd=repo).decode().split("\0")
    files = {}
    for path in paths:
        if path and allowed_path(path):
            data = run(["git", "show", commit + ":" + path], cwd=repo)
            scan(path, data)
            files["app/" + path] = data
    for required in ("index.html", "app.js", "remote.js", "styles.css", "sw.js", "version.json"):
        if "app/" + required not in files:
            raise RuntimeError("Missing application source: " + required)
    return files

def database_schema():
    # PGHOST, PGPORT, PGUSER, PGPASSWORD (or PGPASSFILE), PGDATABASE, PGSSLMODE
    # must already be configured on this protected runner.
    if not os.environ.get("PGHOST") or not os.environ.get("PGUSER"):
        raise RuntimeError("Configure protected PostgreSQL connection environment")
    env = dict(os.environ)
    env.setdefault("PGSSLMODE", "require")
    schema = run(["pg_dump", "--schema-only", "--no-owner", "--schema=public",
                  "--schema=pos_private"], env=env)
    if b"CREATE TABLE" not in schema or b"pos_owner_grants" not in schema or b"ROW LEVEL SECURITY" not in schema:
        raise RuntimeError("Schema is incomplete or wrong project")
    def query(sql):
        return run(["psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], env=env).strip()
    extensions = query("SELECT coalesce(json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname),'[]'::json) FROM pg_extension")
    realtime = query("SELECT coalesce(json_agg(json_build_object('publication',pubname,'schema',schemaname,'table',tablename) ORDER BY pubname,schemaname,tablename),'[]'::json) FROM pg_publication_tables WHERE schemaname IN ('public','pos_private')")
    schedules = query("SELECT coalesce(json_agg(json_build_object('name',jobname,'schedule',schedule,'active',active) ORDER BY jobname),'[]'::json) FROM cron.job WHERE jobname LIKE 'manara-pos-%'")
    for value in (extensions, realtime, schedules):
        json.loads(value)
    return {"database/schema.sql": schema, "database/extensions.json": extensions,
            "database/realtime.json": realtime, "database/cron-schedules.json": schedules}

def edge_sources(project_ref, temp):
    if not re.fullmatch(r"[a-z0-9]{20}", project_ref):
        raise RuntimeError("Invalid Supabase project reference")
    if not os.environ.get("SUPABASE_ACCESS_TOKEN"):
        raise RuntimeError("Configure a protected Supabase Management access token")
    help_text = run(["supabase", "functions", "list", "--help"]).decode()
    flag = ["--remote=" + project_ref] if "--remote" in help_text else ["--project-ref", project_ref]
    listing = json.loads(run(["supabase", "functions", "list", *flag, "--output", "json"], cwd=temp))
    if isinstance(listing, dict):
        listing = listing.get("functions", [])
    if not isinstance(listing, list) or not listing:
        raise RuntimeError("No deployed Edge Functions found")
    files = {}
    metadata = []
    for row in listing:
        slug = row.get("slug") or row.get("name")
        if not re.fullmatch(r"[a-z0-9-]+", slug or ""):
            raise RuntimeError("Invalid function metadata")
        run(["supabase", "functions", "download", slug, *flag, "--use-api"], cwd=temp)
        folder = Path(temp) / "supabase" / "functions" / slug
        if not folder.is_dir():
            raise RuntimeError("Function source download missing: " + slug)
        names = []
        for f in folder.rglob("*"):
            if not f.is_file() or f.is_symlink():
                continue
            rel = f.relative_to(folder).as_posix()
            if not allowed_path(rel):
                raise RuntimeError("Unexpected function file; review " + slug + "/" + rel)
            data = f.read_bytes()
            scan(slug + "/" + rel, data)
            names.append(rel)
            files["edge-functions/" + slug + "/" + rel] = data
        if not names or not any(n.endswith((".ts", ".js")) for n in names):
            raise RuntimeError("Incomplete deployed function: " + slug)
        # CLI downloads may omit import maps and deno.json. Refuse a partial artifact
        # when the remote function declares an import map that is not present.
        if row.get("import_map") and not any("import_map" in n or n.endswith("deno.json") for n in names):
            raise RuntimeError("Missing deployed import map for " + slug)
        metadata.append({"slug": slug, "version": row.get("version"), "verify_jwt": row.get("verify_jwt"),
                         "files": sorted(names)})
    if "pos-staff-auth" not in {x["slug"] for x in metadata}:
        raise RuntimeError("Staff authentication function missing")
    files["edge-functions/metadata.json"] = json.dumps(metadata, indent=2).encode()
    return files

RESTORE = """PUB Manara POS — SYSTEM RECOVERY POINT
This archive is source + schema + permissions + deployed Edge Functions, NOT a
physical Supabase database backup and not a one-click restore.

1. Keep production untouched. Unzip and verify all manifest SHA-256 hashes.
2. Use a new isolated Supabase project. Provision the listed extensions,
   managed auth/storage roles, grants and realtime publication configuration.
3. Review database/schema.sql against managed schemas and restore the application
   schemas with a compatible PostgreSQL version. Reapply default privilege
   revocations before importing. Do not execute a schema dump over a live DB.
4. Deploy the captured Edge Function versions with their recorded auth settings.
   Restore missing dependency configuration only from reviewed source.
5. Recreate owner and worker Auth identities, PINs and credentials securely.
   The data.json companion includes employee UUIDs/metadata, not Auth secrets.
   Preserve or explicitly remap all employee IDs and foreign-key references.
6. Recreate Vault/Edge secrets and Google OAuth consent. Review cron schedules;
   activate them only after the recovery environment has been verified.
7. Restore data separately and verify counts, historical totals, permissions,
   charge/refund and reporting behavior using synthetic transactions only.
8. For a software-only rollback, restore the known app commit and compatible
   server functions. Never roll back data or incompatible schema automatically.
9. Obtain explicit owner approval and a fresh recovery backup before cutover.

Excluded: passwords, PINs, auth.users credentials, refresh/access tokens, Vault
contents, OAuth secrets, live sessions, and unrelated Drive files. A managed
Supabase physical/PITR backup is separate from this recovery point.
"""
def build(repo, commit, project_ref, output):
    commit = run(["git", "rev-parse", commit + "^{commit}"], cwd=repo).decode().strip()
    if not SHA_RE.fullmatch(commit):
        raise RuntimeError("Invalid commit")
    files = git_files(repo, commit)
    version = json.loads(files["app/version.json"])["version"]
    if not VERSION_RE.fullmatch(version):
        raise RuntimeError("Invalid release version")
    files.update(database_schema())
    with tempfile.TemporaryDirectory(prefix="manara-edge-") as temp:
        files.update(edge_sources(project_ref, temp))
    files["RESTORE.md"] = RESTORE.encode()
    for path, data in files.items():
        scan(path, data)
    manifest = {"format": "manara-release-artifact-v1", "version": version, "commit": commit,
                "files": [{"path": path, "sha256": digest(data), "bytes": len(data)}
                          for path, data in sorted(files.items())]}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise RuntimeError("Refusing to overwrite existing artifact")
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path, data in sorted(files.items()):
            z.writestr(path, data)
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode())
    verify(output)
    return manifest

def verify(path):
    path = Path(path)
    if not 0 < path.stat().st_size <= MAX_BYTES:
        raise RuntimeError("Archive size outside allowed range")
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if len(names) != len(set(names)) or any(PurePosixPath(n).is_absolute() or ".." in PurePosixPath(n).parts for n in names):
            raise RuntimeError("Unsafe archive member")
        m = json.loads(z.read("manifest.json"))
        if m.get("format") != "manara-release-artifact-v1" or not VERSION_RE.fullmatch(m.get("version", "")) or not SHA_RE.fullmatch(m.get("commit", "")):
            raise RuntimeError("Invalid archive manifest")
        records = m.get("files", [])
        expected = {r["path"] for r in records} | {"manifest.json"}
        if expected != set(names) or len(records) != len(expected) - 1:
            raise RuntimeError("Archive file list mismatch")
        for r in records:
            data = z.read(r["path"])
            if len(data) != r["bytes"] or digest(data) != r["sha256"]:
                raise RuntimeError("Archive checksum mismatch: " + r["path"])
            scan(r["path"], data)
        if "database/schema.sql" not in names or "edge-functions/metadata.json" not in names or "app/version.json" not in names:
            raise RuntimeError("Incomplete release artifact")
        if json.loads(z.read("app/version.json")).get("version") != m["version"]:
            raise RuntimeError("Application version mismatch")
    return m

def request(url, method, headers, body=None):
    try:
        with urlopen(Request(url, data=body, headers=headers, method=method), timeout=120) as response:
            return response.status, response.read()
    except HTTPError as e:
        return e.code, b""

def register(path):
    manifest = verify(path)
    body = Path(path).read_bytes()
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co", url):
        raise RuntimeError("SUPABASE_URL must be the approved project URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    release_secret = os.environ.get("POS_DRIVE_RELEASE_SECRET", "")
    if not service_key or not release_secret:
        raise RuntimeError("Protected storage and release credentials required")
    storage_path = manifest["version"] + "/" + manifest["commit"] + ".zip"
    object_url = url + "/storage/v1/object/" + BUCKET + "/" + quote(storage_path, safe="/")
    headers = {"Authorization": "Bearer " + service_key, "apikey": service_key}
    status, _ = request(object_url, "POST", {**headers, "Content-Type": "application/zip", "x-upsert": "false"}, body)
    if status not in (200, 201, 400, 409):
        raise RuntimeError("Storage upload failed")
    status, actual = request(url + "/storage/v1/object/authenticated/" + BUCKET + "/" + quote(storage_path, safe="/"), "GET", headers)
    if status != 200 or digest(actual) != digest(body):
        raise RuntimeError("Storage readback mismatch; refusing release registration")
    payload = json.dumps({"action": "release_register", "release": {"version": manifest["version"],
                          "commit_sha": manifest["commit"], "storage_path": storage_path,
                          "sha256": digest(body), "byte_size": len(body)}}).encode()
    status, response = request(url + "/functions/v1/pos-drive-backup", "POST",
                               {"Content-Type": "application/json", "x-pos-backup-release": release_secret,
                                "apikey": service_key}, payload)
    if status != 200 or not json.loads(response).get("ok"):
        raise RuntimeError("Release registration failed")
    print("Verified and registered release", manifest["version"], manifest["commit"])

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)
    b = sub.add_parser("build")
    b.add_argument("--repo", default=".")
    b.add_argument("--commit", required=True)
    b.add_argument("--project-ref", required=True)
    b.add_argument("--output", required=True)
    for name in ("verify", "register"):
        p = sub.add_parser(name)
        p.add_argument("archive")
    args = parser.parse_args()
    if args.mode == "build":
        m = build(args.repo, args.commit, args.project_ref, args.output)
        print("Built verified artifact", m["version"], m["commit"], len(m["files"]), "files")
    elif args.mode == "verify":
        m = verify(args.archive)
        print("Verified", m["version"], m["commit"], len(m["files"]), "files")
    else:
        register(args.archive)

if __name__ == "__main__":
    main()
