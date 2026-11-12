-- DEV activation step. Never run before verified Google consent and package registration.
-- Create these Vault secrets through the protected dashboard, NOT in source:
-- pos_drive_project_url, pos_drive_public_key, pos_drive_worker_secret.
-- The last must match POS_DRIVE_WORKER_SECRET in the Edge Function environment.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pos_private.drive_backup_connection WHERE id=1 AND encrypted_refresh_token IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM pos_private.drive_release_artifacts WHERE active)
 THEN RAISE EXCEPTION 'Connect and verify Google, then register the current system package first'; END IF;
 IF (SELECT count(DISTINCT name) FROM vault.decrypted_secrets
     WHERE name IN ('pos_drive_project_url','pos_drive_public_key','pos_drive_worker_secret')
       AND decrypted_secret IS NOT NULL AND length(decrypted_secret)>0)<>3
 THEN RAISE EXCEPTION 'Required Vault secrets missing'; END IF;
END $$;
CREATE FUNCTION pos_private.drive_cron_dispatch_v2017() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE url text; public_key text; worker_secret text;
BEGIN
 -- Snapshot is taken at the due Israeli local time; external transfer is queued.
 PERFORM pos_private.drive_backup_tick();
 IF NOT EXISTS(SELECT 1 FROM pos_private.drive_backup_jobs j
 JOIN pos_private.drive_backup_connection c ON c.id=1 AND c.generation=j.generation
 WHERE c.encrypted_refresh_token IS NOT NULL
 AND ((j.attempts<3 AND j.status IN ('queued','retry') AND j.next_at<=now()) OR (j.status='running' AND j.lease_until<=now())))
 THEN RETURN; END IF;
 SELECT decrypted_secret INTO url FROM vault.decrypted_secrets WHERE name='pos_drive_project_url';
 SELECT decrypted_secret INTO public_key FROM vault.decrypted_secrets WHERE name='pos_drive_public_key';
 SELECT decrypted_secret INTO worker_secret FROM vault.decrypted_secrets WHERE name='pos_drive_worker_secret';
 IF url IS NULL OR public_key IS NULL OR worker_secret IS NULL OR url !~ '^https://[a-z0-9]+\.supabase\.co$'
 THEN RAISE EXCEPTION 'Backup worker configuration missing'; END IF;
 PERFORM net.http_post(url:=url||'/functions/v1/pos-drive-backup',
  headers:=jsonb_build_object('Content-Type','application/json','apikey',public_key,'x-pos-backup-worker',worker_secret),
  body:='{"action":"run"}'::jsonb,timeout_milliseconds:=150000);
END $$;
REVOKE ALL ON FUNCTION pos_private.drive_cron_dispatch_v2017() FROM PUBLIC,anon,authenticated;
SELECT cron.schedule('manara-pos-drive-worker-v2017','* * * * *',
 'SELECT pos_private.drive_cron_dispatch_v2017();');
COMMIT;
-- Existing manara-pos-daily-snapshot-check cron is deliberately untouched.
