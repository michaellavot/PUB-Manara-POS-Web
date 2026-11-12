# PUB Manara POS V2.0.17 — DEV activation checklist

**This branch is not deployed.** Main remains V2.0.16. Do not point a DEV POS at
production for charge/refund tests. The new SQL and Edge Function must first be
validated in an isolated project, and Google consent must be completed by the
owner. No secret is stored in Git or in the browser.

## 1. Google authorization (owner action)

- Create or choose a Google Cloud project and enable Google Drive API.
- Configure OAuth consent for the owner's Google account. Use the scope
  https://www.googleapis.com/auth/drive.file (no full Drive access).
- Create an OAuth Web application client. Add the exact authorized redirect URI
  https://<approved-project-ref>.supabase.co/functions/v1/pos-drive-backup
- Use an appropriate published/production OAuth consent configuration; test-only
  external apps can issue short-lived refresh tokens. Complete Google's consent
  steps and any verification required for the configured app.
- Never paste client secrets, database passwords, refresh tokens or service-role
  tokens into the POS, chat, a commit, a URL or a test fixture. Configure secrets
  through the Supabase dashboard / protected deployment environment.

Edge Function secrets: POS_DRIVE_CLIENT_ID, POS_DRIVE_CLIENT_SECRET,
POS_DRIVE_REDIRECT_URI, POS_DRIVE_TOKEN_KEY (base64 of 32 random bytes),
POS_DRIVE_WORKER_SECRET and POS_DRIVE_RELEASE_SECRET (distinct high-entropy
random values), POS_DRIVE_APP_ORIGIN (exact approved app origin).
Keep the token encryption key securely backed up separately from the Drive
archives. Rotate/reconnect if compromised; never include it in recovery ZIPs.

## 2. Database and Edge Function

- Apply dev/drive_backup_v2017.sql in isolated target after review.
- Apply dev/prepare_drive_storage_v2017.sql. Confirm private bucket and no broad
  storage policy. Do not activate cron or change production yet.
- Deploy pos-drive-backup with its index.ts and core.ts. Gateway verify_jwt=false
  is necessary for Google's callback; the function verifies user JWTs and live
  owner grants explicitly, and verifies separate worker/release secrets.
- Verify ordinary and manage_system staff cannot use any Drive route, inspect
  grants/RLS, and test owner lock/expiry, invalid OAuth state, connection failure.
- The legacy restore guard must be released in coordination with the new
  BackupManager UI. The old public restore RPC is retired at cutover, not during
  an unrelated production update.

## 3. Connect and verify before any real data transfer

After the owner unlocks system management, open the Drive panel, choose Connect,
open the Google link in another tab and consent. The callback creates dedicated
private folders in My Drive, uploads a synthetic connection test, downloads it
and compares its SHA-256. Only then is the encrypted token saved. Refresh the panel.
A separate app-created folder is used; no existing user folder is modified or shared.

Automatic backups remain disabled until the owner enables them. Do not send real
data until the connection and folder permissions have been verified.

## 4. Register an exact, immutable system package

Use a protected runner with Git, compatible pg_dump/psql and the Supabase CLI.
Configure PostgreSQL connection via PGHOST, PGPORT, PGUSER, PGPASSWORD/PGPASSFILE,
PGDATABASE, PGSSLMODE=require, and SUPABASE_ACCESS_TOKEN as protected credentials.
The builder downloads deployed Edge Functions and exports application schema
(public, pos_private), including grants/RLS and publication/cron metadata. It
archives source from an exact Git commit, not from an uncommitted directory.

    python tools/build_system_restore_point.py build --commit <live-commit> --project-ref <target-ref> --output /secure/path/System.zip
    python tools/build_system_restore_point.py verify /secure/path/System.zip

Register using protected SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
POS_DRIVE_RELEASE_SECRET. Verify the storage upload and register exact hash:

    python tools/build_system_restore_point.py register /secure/path/System.zip

A system point contains the immutable release ZIP plus the current verified
data JSON and manifest. It is not a physical database/PITR backup. Auth identity
credentials, tokens and secrets must be recreated; recovery must be rehearsed in
an isolated project. Do not register an app commit that does not match the
deployed backend/schema. For schema-only changes create a new release commit.

## 5. Activate scheduling

Create Vault secrets pos_drive_project_url, pos_drive_public_key,
pos_drive_worker_secret (same worker secret as Edge). Review and apply
dev/activate_drive_backup_v2017.sql. It queues due Israel-local slots every minute,
then invokes the private worker only when work exists. Existing cron is unchanged.

Test a manual synthetic job first, then the first real read-only backup by owner
consent; verify Drive file metadata, size and downloaded checksum. Enable the
weekly schedule only after the full system package is registered and the first
real data + system job succeeds. Default Saturday 07:00 Israel time; each slot
supports day/time/type/enabled. No automatic deletion of Drive backups.

## 6. Mandatory pre-update release gate (not activated yet)

Before **any** change to live source, DB migration or Edge deployment, invoke:

    python tools/pre_update_drive_backup.py --expected-version <current-version> --expected-commit <current-live-commit>

The gate queues a both-files backup against the exact active release, waits for
verified data and system hashes, exits nonzero on any failure or timeout, and
prints a receipt. Do not deploy unless exit code is zero. Retries can resume with
the same request ID. After an approved deployment, build and register its exact
new release artifact. Enforce the gate in a protected release pipeline before
publishing GitHub Pages and applying production migrations. A direct push to
main currently bypasses any CI release gate; switch Pages to a gated deployment
workflow / protect the release path before claiming this is automatic.

Software rollback is an owner-approved deployment of a compatible known
commit/backend. Data rollback is a separate destructive operation using a fresh
owner-password proof, typed confirmation, preview and before-restore snapshot.
Never automatically roll back live data or schema. Current snapshot restore
restores transactions and matching catalog records; recreating all settings,
Auth identities, audit and a new project remains a separate recovery procedure.

## 7. Acceptance / blockers

- PostgreSQL synthetic integration tests: isolated schema-renamed migration and
  fake dependencies inside ROLLBACK. No charge, live restore or customer changes.
- JavaScript tests: actual SHA-256 and AES-GCM, mocked Drive HTTP, access-control
  and corruption/duplicate handling. Test suite does not call Google or Supabase.
- Real OAuth credentials/consent, isolated project deployment, actual Google
  upload and downloaded checksum, package build against the approved live
  schema/functions and a recovery rehearsal are mandatory before production release.
- No auto-activation until all acceptance tests pass. No production data is
  transferred merely by merging or loading this branch.
