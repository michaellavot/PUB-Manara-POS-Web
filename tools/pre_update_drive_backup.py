#!/usr/bin/env python3
"""Fail-closed pre-release gate. Run BEFORE any production DB/code changes."""
import argparse
import json
import os
import re
import time
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError

def call(action, **payload):
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    secret = os.environ.get("POS_DRIVE_RELEASE_SECRET", "")
    public_key = os.environ.get("SUPABASE_PUBLIC_KEY", "")
    if not re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co", url) or not secret:
        raise RuntimeError("Configure approved project URL and protected release secret")
    req = Request(url + "/functions/v1/pos-drive-backup",
                  data=json.dumps({"action": action, **payload}).encode(),
                  headers={"Content-Type": "application/json", "x-pos-backup-release": secret,
                           **({"apikey": public_key} if public_key else {})}, method="POST")
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except HTTPError as e:
        raise RuntimeError("Release backup API refused request: HTTP " + str(e.code)) from None

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--expected-version", required=True)
    p.add_argument("--expected-commit", required=True)
    p.add_argument("--request-id", default=None)
    p.add_argument("--timeout-seconds", type=int, default=1200)
    args = p.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.expected_version) or not re.fullmatch(r"[a-f0-9]{40}", args.expected_commit):
        raise RuntimeError("Exact live version and commit required")
    request_id = str(uuid.UUID(args.request_id)) if args.request_id else str(uuid.uuid4())
    print("Backup request ID:", request_id, flush=True)
    r = call("before_update", requestId=request_id,
             expectedVersion=args.expected_version, expectedCommit=args.expected_commit)
    job_id = str(uuid.UUID(r["id"]))
    until = time.monotonic() + args.timeout_seconds
    while time.monotonic() < until:
        j = call("release_job_status", id=job_id)
        status = j.get("status")
        if status == "succeeded":
            if j.get("kind") != "both" or not all(re.fullmatch(r"[a-f0-9]{64}", j.get(k) or "") for k in ("data_sha256", "system_sha256")):
                raise RuntimeError("Pre-release files not both verified")
            print(json.dumps({"verified": True, "backupId": job_id,
                              "version": args.expected_version, "commit": args.expected_commit,
                              "dataSha256": j["data_sha256"], "systemSha256": j["system_sha256"]}))
            return
        if status == "failed":
            raise RuntimeError("Pre-release backup failed; deployment must stop")
        time.sleep(10)
    raise RuntimeError("Backup not verified within gate window; deployment must stop. Resume with same request ID.")

if __name__ == "__main__":
    main()
