-- V2.0.17 DEV: private Drive backup queue. Review and test in an isolated DB.
-- Do NOT apply this file to production or activate cron until the OAuth and release tests pass.
BEGIN;
CREATE TABLE pos_private.drive_backup_connection (
 id integer PRIMARY KEY CHECK(id=1),
 generation uuid NOT NULL DEFAULT gen_random_uuid(),
 encrypted_refresh_token text,
 root_folder text, data_folder text, system_folder text,
 connected_at timestamptz, enabled boolean NOT NULL DEFAULT false,
 enabled_since timestamptz,
 CHECK(NOT enabled OR (encrypted_refresh_token IS NOT NULL AND root_folder IS NOT NULL
  AND data_folder IS NOT NULL AND system_folder IS NOT NULL AND enabled_since IS NOT NULL))
);
INSERT INTO pos_private.drive_backup_connection(id) VALUES(1);
CREATE TABLE pos_private.drive_backup_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 weekday smallint NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 minute_of_day smallint NOT NULL CHECK(minute_of_day BETWEEN 0 AND 1439 AND minute_of_day%15=0),
 kind text NOT NULL CHECK(kind IN ('data','both')),
 enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(weekday,minute_of_day)
);
INSERT INTO pos_private.drive_backup_schedules(weekday,minute_of_day,kind) VALUES(6,420,'both');
CREATE TABLE pos_private.drive_release_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version text NOT NULL CHECK(version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
 commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
 storage_path text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 67108864),
 created_at timestamptz NOT NULL DEFAULT now(),
 active boolean NOT NULL DEFAULT false,
 UNIQUE(version,commit_sha)
);
CREATE UNIQUE INDEX drive_one_active_release ON pos_private.drive_release_artifacts(active) WHERE active;
CREATE TABLE pos_private.drive_backup_oauth_states (
 state_hash text PRIMARY KEY CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 session_id uuid NOT NULL, user_id uuid NOT NULL, verifier text NOT NULL,
 generation uuid NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE pos_private.drive_backup_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_key text NOT NULL UNIQUE, generation uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('scheduled','manual','before-update')),
 kind text NOT NULL CHECK(kind IN ('data','both')),
 due_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 release_id uuid REFERENCES pos_private.drive_release_artifacts(id),
 snapshot_text text,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','succeeded','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 next_at timestamptz NOT NULL DEFAULT now(), lease uuid, lease_until timestamptz,
 data_file_id text, system_file_id text, data_sha256 text, system_sha256 text,
 error_code text, completed_at timestamptz,
 CHECK(kind='data' OR release_id IS NOT NULL)
);
CREATE INDEX drive_jobs_pending ON pos_private.drive_backup_jobs(next_at) WHERE status IN ('queued','retry','running');
CREATE TABLE pos_private.drive_restore_proofs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL,user_id uuid NOT NULL,
 snapshot_id uuid NOT NULL, checksum text NOT NULL, expires_at timestamptz NOT NULL
);
ALTER TABLE pos_private.drive_backup_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_private.drive_backup_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_private.drive_release_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_private.drive_backup_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_private.drive_backup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_private.drive_restore_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos_private.drive_backup_connection,pos_private.drive_backup_schedules,pos_private.drive_release_artifacts,
 pos_private.drive_backup_oauth_states,pos_private.drive_backup_jobs,pos_private.drive_restore_proofs FROM PUBLIC,anon,authenticated;
-- Authenticated client never receives credentials. Edge service passes its verified JWT identity;
-- this SQL assertion independently checks the current live owner grant.
CREATE FUNCTION pos_private.drive_assert_owner(p_session uuid,p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pos_staff_sessions s
 JOIN public.pos_staff_logins l ON l.user_id=s.user_id
 JOIN public.employees e ON e.user_id=s.user_id
 JOIN public.pos_owner_grants g ON g.session_id=s.session_id
 WHERE s.session_id=p_session AND s.user_id=p_user AND s.revoked_at IS NULL
 AND s.expires_at>now() AND g.expires_at>now() AND l.owner_terminal AND e.active)
 THEN RAISE EXCEPTION 'Owner authentication required' USING ERRCODE='42501'; END IF;
END $$;
-- One SQL statement creates a consistent data snapshot. Only whitelisted employee
-- metadata; never auth.users, credentials, PINs, session tokens, Vault or Drive tokens.
CREATE FUNCTION pos_private.drive_snapshot() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('format','manara-cloud-snapshot-v1','createdAt',now(),
 'customers',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM public.customers c),
 'products',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM public.products p),
 'transactions',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM public.transactions t),
 'transaction_items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM public.transaction_items i),
 'pos_settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM public.pos_settings s),
 'backup_schedule_settings',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'enabled',s.enabled,'frequency',s.frequency,'hour_local',s.hour_local,'weekday',s.weekday) ORDER BY s.id),'[]'::jsonb) FROM pos_private.pos_backup_settings s),
 'drive_backup_schedules',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'weekday',s.weekday,'minute_of_day',s.minute_of_day,'kind',s.kind,'enabled',s.enabled) ORDER BY s.weekday,s.minute_of_day),'[]'::jsonb) FROM pos_private.drive_backup_schedules s),
 'pos_audit_log',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.pos_audit_log a),
 'pos_employee_audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.pos_employee_audit a),
 'employees',(SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',e.user_id,'display_name',e.display_name,
 'role',e.role,'active',e.active,'is_owner',e.is_owner,'permissions',e.permissions,'linked_customer_id',e.linked_customer_id)
 ORDER BY e.user_id),'[]'::jsonb) FROM public.employees e),
 'staff_login_metadata',(SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',l.user_id,'username',l.username,
 'owner_terminal',l.owner_terminal,'removed_at',l.removed_at) ORDER BY l.user_id),'[]'::jsonb) FROM public.pos_staff_logins l))::text
$$;
CREATE FUNCTION pos_private.drive_enqueue(p_key text,p_reason text,p_kind text,p_due timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c pos_private.drive_backup_connection%rowtype; r uuid; jid uuid;
BEGIN
 SELECT * INTO c FROM pos_private.drive_backup_connection WHERE id=1 FOR UPDATE;
 IF c.encrypted_refresh_token IS NULL THEN RAISE EXCEPTION 'Drive not connected'; END IF;
 IF p_kind NOT IN ('data','both') OR p_kind IS NULL THEN RAISE EXCEPTION 'Invalid backup kind'; END IF;
 IF p_kind='both' THEN
  SELECT id INTO r FROM pos_private.drive_release_artifacts WHERE active;
  IF r IS NULL THEN RAISE EXCEPTION 'Verified release artifact required'; END IF;
 END IF;
 SELECT id INTO jid FROM pos_private.drive_backup_jobs WHERE job_key=p_key;
 IF jid IS NOT NULL THEN RETURN jid; END IF;
 INSERT INTO pos_private.drive_backup_jobs(job_key,generation,reason,kind,due_at,release_id,snapshot_text)
 VALUES(p_key,c.generation,p_reason,p_kind,p_due,r,pos_private.drive_snapshot()) RETURNING id INTO jid;
 RETURN jid;
END $$;
-- Called every minute by a server scheduler. Weekly local-time slots have a unique
-- occurrence key, including across DST fallback; missed occurrences catch up <=24h.
CREATE FUNCTION pos_private.drive_backup_tick() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c pos_private.drive_backup_connection%rowtype; s record; d date;
 local_due timestamp; due timestamptz; k text; n integer:=0; israel_date date;
BEGIN
 SELECT * INTO c FROM pos_private.drive_backup_connection WHERE id=1 FOR UPDATE;
 IF NOT c.enabled OR c.encrypted_refresh_token IS NULL THEN RETURN 0; END IF;
 israel_date:=(now() AT TIME ZONE 'Asia/Jerusalem')::date;
 FOR s IN SELECT * FROM pos_private.drive_backup_schedules WHERE enabled LOOP
  FOR d IN SELECT israel_date-g.i FROM generate_series(0,1) AS g(i) LOOP
   IF extract(dow FROM d)::int<>s.weekday THEN CONTINUE; END IF;
   local_due:=d::timestamp+make_interval(mins=>s.minute_of_day::int);
   due:=local_due AT TIME ZONE 'Asia/Jerusalem';
   IF due>now() OR due<=now()-interval '24 hours'
      OR due<greatest(c.enabled_since,s.updated_at) THEN CONTINUE; END IF;
   k:='weekly:'||to_char(local_due,'YYYY-MM-DD"T"HH24:MI');
   IF NOT EXISTS(SELECT 1 FROM pos_private.drive_backup_jobs WHERE job_key=k) THEN
    PERFORM pos_private.drive_enqueue(k,'scheduled',s.kind,due); n:=n+1;
   END IF;
  END LOOP;
 END LOOP;
 RETURN n;
END $$;
-- Only the verified service backend can invoke these RPCs. No browser calls to them.
CREATE FUNCTION public.pos_drive_owner_v2017(p_action text,p_session uuid,p_user uuid,p_body jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c pos_private.drive_backup_connection%rowtype; jid uuid; sid uuid; n integer; s jsonb;
BEGIN
 PERFORM pos_private.drive_assert_owner(p_session,p_user);
 SELECT * INTO c FROM pos_private.drive_backup_connection WHERE id=1 FOR UPDATE;
 IF p_action='status' THEN
  RETURN jsonb_build_object('connected',c.encrypted_refresh_token IS NOT NULL,'enabled',c.enabled,
   'folderId',c.root_folder,'connectedAt',c.connected_at,'systemReady',EXISTS(SELECT 1 FROM pos_private.drive_release_artifacts WHERE active),
   'release',(SELECT jsonb_build_object('version',version,'commit',commit_sha) FROM pos_private.drive_release_artifacts WHERE active),
   'schedules',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.weekday,x.minute_of_day),'[]'::jsonb) FROM pos_private.drive_backup_schedules x),
   'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC),'[]'::jsonb) FROM
      (SELECT id,reason,kind,due_at,created_at,status,attempts,next_at,error_code,completed_at,
       data_file_id,system_file_id,data_sha256,system_sha256 FROM pos_private.drive_backup_jobs
       WHERE generation=c.generation ORDER BY created_at DESC LIMIT 40) x));
 ELSIF p_action='save_schedule' THEN
  IF jsonb_typeof(p_body->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid schedule'; END IF;
  IF c.enabled AND (p_body->>'enabled')::boolean AND p_body->>'kind'='both'
   AND NOT EXISTS(SELECT 1 FROM pos_private.drive_release_artifacts WHERE active) THEN RAISE EXCEPTION 'System package missing'; END IF;
  sid:=nullif(p_body->>'id','')::uuid;
  IF sid IS NULL THEN
   INSERT INTO pos_private.drive_backup_schedules(weekday,minute_of_day,kind,enabled)
    VALUES((p_body->>'weekday')::int,(p_body->>'minute_of_day')::int,p_body->>'kind',(p_body->>'enabled')::boolean) RETURNING id INTO sid;
  ELSE
   UPDATE pos_private.drive_backup_schedules SET weekday=(p_body->>'weekday')::int,
    minute_of_day=(p_body->>'minute_of_day')::int,kind=p_body->>'kind',enabled=(p_body->>'enabled')::boolean,
    updated_at=now() WHERE id=sid;
   IF NOT FOUND THEN RAISE EXCEPTION 'Schedule not found'; END IF;
  END IF;
  RETURN jsonb_build_object('id',sid);
 ELSIF p_action='delete_schedule' THEN
  DELETE FROM pos_private.drive_backup_schedules WHERE id=(p_body->>'id')::uuid;
  RETURN jsonb_build_object('ok',true);
 ELSIF p_action='enable' THEN
  IF jsonb_typeof(p_body->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid setting'; END IF;
  IF (p_body->>'enabled')::boolean THEN
   IF c.encrypted_refresh_token IS NULL THEN RAISE EXCEPTION 'Drive not connected'; END IF;
   IF EXISTS(SELECT 1 FROM pos_private.drive_backup_schedules WHERE enabled AND kind='both')
      AND NOT EXISTS(SELECT 1 FROM pos_private.drive_release_artifacts WHERE active) THEN RAISE EXCEPTION 'System package missing'; END IF;
  END IF;
  UPDATE pos_private.drive_backup_connection SET enabled=(p_body->>'enabled')::boolean,
    enabled_since=CASE WHEN (p_body->>'enabled')::boolean AND NOT enabled THEN now() ELSE enabled_since END WHERE id=1;
  RETURN jsonb_build_object('ok',true);
 ELSIF p_action='manual' THEN
  jid:=pos_private.drive_enqueue('manual:'||(p_body->>'requestId')::uuid::text,'manual',p_body->>'kind',now());
  RETURN jsonb_build_object('id',jid);
 ELSIF p_action='oauth_start' THEN
  DELETE FROM pos_private.drive_backup_oauth_states WHERE expires_at<=now() OR session_id=p_session;
  INSERT INTO pos_private.drive_backup_oauth_states(state_hash,session_id,user_id,verifier,generation,expires_at)
   VALUES(p_body->>'stateHash',p_session,p_user,p_body->>'verifier',c.generation,now()+interval '10 minutes');
  RETURN jsonb_build_object('ok',true);
 ELSIF p_action='disconnect' THEN
  IF EXISTS(SELECT 1 FROM pos_private.drive_backup_jobs WHERE generation=c.generation AND status='running' AND lease_until>now())
    THEN RAISE EXCEPTION 'Backup in progress'; END IF;
  UPDATE pos_private.drive_backup_jobs SET status='failed',error_code='disconnected',completed_at=now(),lease=NULL,lease_until=NULL
   WHERE generation=c.generation AND status IN ('queued','retry','running');
  UPDATE pos_private.drive_backup_connection SET generation=gen_random_uuid(),enabled=false,enabled_since=NULL,
   encrypted_refresh_token=NULL,root_folder=NULL,data_folder=NULL,system_folder=NULL,connected_at=NULL WHERE id=1;
  RETURN jsonb_build_object('ok',true,'encryptedRefreshToken',c.encrypted_refresh_token,'generation',c.generation);
 ELSIF p_action='proof' THEN
  -- Only callable by the Edge service after fresh password verification.
  INSERT INTO pos_private.drive_restore_proofs(session_id,user_id,snapshot_id,checksum,expires_at)
   VALUES(p_session,p_user,(p_body->>'snapshotId')::uuid,p_body->>'checksum',now()+interval '5 minutes') RETURNING id INTO sid;
  DELETE FROM pos_private.drive_restore_proofs WHERE expires_at<=now();
  RETURN jsonb_build_object('proof',sid);
 ELSIF p_action='import_verified' THEN
  -- Edge downloads a job file and checks its exact SHA-256 before calling.
  s:=p_body->'snapshot';
  IF s->>'format' IS DISTINCT FROM 'manara-cloud-snapshot-v1'
    OR jsonb_typeof(s->'customers') IS DISTINCT FROM 'array'
    OR jsonb_typeof(s->'products') IS DISTINCT FROM 'array'
    OR jsonb_typeof(s->'transactions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(s->'transaction_items') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'Invalid backup'; END IF;
  INSERT INTO pos_private.pos_backup_snapshots(reason,snapshot,transaction_count,item_count)
   VALUES('drive-import',s,jsonb_array_length(s->'transactions'),jsonb_array_length(s->'transaction_items')) RETURNING id INTO sid;
  RETURN jsonb_build_object('snapshotId',sid);
 ELSE RAISE EXCEPTION 'Unknown action'; END IF;
END $$;
CREATE FUNCTION public.pos_drive_oauth_v2017(p_action text,p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o pos_private.drive_backup_oauth_states%rowtype; c pos_private.drive_backup_connection%rowtype;
BEGIN
 IF p_action='consume' THEN
  DELETE FROM pos_private.drive_backup_oauth_states WHERE state_hash=p_body->>'stateHash' AND expires_at>now() RETURNING * INTO o;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid or expired OAuth state'; END IF;
  PERFORM pos_private.drive_assert_owner(o.session_id,o.user_id);
  RETURN to_jsonb(o);
 ELSIF p_action='finish' THEN
  PERFORM pos_private.drive_assert_owner((p_body->>'session_id')::uuid,(p_body->>'user_id')::uuid);
  SELECT * INTO c FROM pos_private.drive_backup_connection WHERE id=1 FOR UPDATE;
  IF c.generation<>(p_body->>'generation')::uuid OR c.encrypted_refresh_token IS NOT NULL THEN RAISE EXCEPTION 'Disconnect previous account before reconnecting'; END IF;
  UPDATE pos_private.drive_backup_connection SET encrypted_refresh_token=p_body->>'encryptedToken',
   root_folder=p_body->>'rootFolder',data_folder=p_body->>'dataFolder',system_folder=p_body->>'systemFolder',
   connected_at=now(),enabled=false WHERE id=1;
  RETURN jsonb_build_object('ok',true);
 END IF;
 RAISE EXCEPTION 'Unknown OAuth operation';
END $$;
CREATE FUNCTION public.pos_drive_worker_v2017(p_action text,p_body jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j pos_private.drive_backup_jobs%rowtype; c pos_private.drive_backup_connection%rowtype; r pos_private.drive_release_artifacts%rowtype; l uuid;
BEGIN
 SELECT * INTO c FROM pos_private.drive_backup_connection WHERE id=1 FOR UPDATE;
 IF p_action='connection' THEN RETURN to_jsonb(c); END IF;
 IF p_action='tick' THEN RETURN jsonb_build_object('queued',pos_private.drive_backup_tick()); END IF;
 IF p_action='claim' THEN
  UPDATE pos_private.drive_backup_jobs SET status='failed',error_code='attempts_exhausted',completed_at=now(),lease=NULL,lease_until=NULL
   WHERE status='running' AND lease_until<=now() AND attempts>=3;
  IF c.encrypted_refresh_token IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO j FROM pos_private.drive_backup_jobs WHERE generation=c.generation AND attempts<3
   AND ((status IN ('queued','retry') AND next_at<=now()) OR (status='running' AND lease_until<=now()))
   ORDER BY next_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  l:=gen_random_uuid();
  UPDATE pos_private.drive_backup_jobs SET status='running',attempts=attempts+1,lease=l,lease_until=now()+interval '10 minutes'
   WHERE id=j.id RETURNING * INTO j;
  IF j.release_id IS NOT NULL THEN SELECT * INTO r FROM pos_private.drive_release_artifacts WHERE id=j.release_id; END IF;
  RETURN jsonb_build_object('job',to_jsonb(j),'connection',to_jsonb(c),'release',CASE WHEN j.release_id IS NULL THEN NULL ELSE to_jsonb(r) END);
 END IF;
 IF p_action='register_release' THEN
  IF p_body->>'storage_path' IS DISTINCT FROM ((p_body->>'version')||'/'||(p_body->>'commit_sha')||'.zip') THEN RAISE EXCEPTION 'Invalid artifact path'; END IF;
  UPDATE pos_private.drive_release_artifacts SET active=false WHERE active;
  INSERT INTO pos_private.drive_release_artifacts(version,commit_sha,storage_path,sha256,byte_size,active)
   VALUES(p_body->>'version',p_body->>'commit_sha',p_body->>'storage_path',p_body->>'sha256',(p_body->>'byte_size')::bigint,true)
   ON CONFLICT(version,commit_sha) DO UPDATE SET active=true
   WHERE drive_release_artifacts.sha256=excluded.sha256 AND drive_release_artifacts.storage_path=excluded.storage_path AND drive_release_artifacts.byte_size=excluded.byte_size;
  IF NOT FOUND THEN RAISE EXCEPTION 'Immutable release artifact mismatch'; END IF;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF p_action='before_update' THEN
  IF NOT EXISTS(SELECT 1 FROM pos_private.drive_release_artifacts WHERE active AND version=p_body->>'expectedVersion' AND commit_sha=p_body->>'expectedCommit') THEN
   RAISE EXCEPTION 'Active release does not match expected version and commit'; END IF;
  RETURN jsonb_build_object('id',pos_private.drive_enqueue('release:'||(p_body->>'requestId')::uuid::text,'before-update','both',now()));
 END IF;
 IF p_action='job_status' THEN
  SELECT * INTO j FROM pos_private.drive_backup_jobs WHERE id=(p_body->>'id')::uuid AND generation=c.generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;
  RETURN to_jsonb(j)-'snapshot_text'-'lease'-'generation';
 END IF;
 SELECT * INTO j FROM pos_private.drive_backup_jobs WHERE id=(p_body->>'id')::uuid AND generation=c.generation FOR UPDATE;
 IF NOT FOUND OR j.status<>'running' OR j.lease IS DISTINCT FROM (p_body->>'lease')::uuid OR j.lease_until<=now() THEN
  RAISE EXCEPTION 'Invalid or expired job lease'; END IF;
 IF p_action='reserve' THEN
  IF p_body->>'kind'='data' THEN
   UPDATE pos_private.drive_backup_jobs SET data_file_id=coalesce(data_file_id,p_body->>'fileId') WHERE id=j.id RETURNING data_file_id INTO c.data_folder;
   RETURN jsonb_build_object('fileId',c.data_folder);
  ELSIF p_body->>'kind'='system' AND j.kind='both' THEN
   UPDATE pos_private.drive_backup_jobs SET system_file_id=coalesce(system_file_id,p_body->>'fileId') WHERE id=j.id RETURNING system_file_id INTO c.system_folder;
   RETURN jsonb_build_object('fileId',c.system_folder);
  END IF;
 ELSIF p_action='verified' THEN
  IF coalesce(p_body->>'sha256','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid hash'; END IF;
  IF p_body->>'kind'='data' AND j.data_file_id=p_body->>'fileId' THEN
   UPDATE pos_private.drive_backup_jobs SET data_sha256=p_body->>'sha256' WHERE id=j.id;
  ELSIF p_body->>'kind'='system' AND j.system_file_id=p_body->>'fileId' THEN
   UPDATE pos_private.drive_backup_jobs SET system_sha256=p_body->>'sha256' WHERE id=j.id;
  ELSE RAISE EXCEPTION 'Invalid file'; END IF;
  RETURN jsonb_build_object('ok',true);
 ELSIF p_action='complete' THEN
  IF j.data_sha256 IS NULL OR (j.kind='both' AND j.system_sha256 IS NULL) THEN RAISE EXCEPTION 'Files not verified'; END IF;
  UPDATE pos_private.drive_backup_jobs SET status='succeeded',completed_at=now(),error_code=NULL,snapshot_text=NULL,lease=NULL,lease_until=NULL WHERE id=j.id;
  RETURN jsonb_build_object('ok',true);
 ELSIF p_action='fail' THEN
  UPDATE pos_private.drive_backup_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'retry' END,
   next_at=now()+CASE WHEN attempts=1 THEN interval '15 minutes' ELSE interval '1 hour' END,
   completed_at=CASE WHEN attempts>=3 THEN now() ELSE NULL END,error_code=left(coalesce(p_body->>'errorCode','backup_failed'),80),
   lease=NULL,lease_until=NULL WHERE id=j.id;
  RETURN jsonb_build_object('ok',true);
 END IF;
 RAISE EXCEPTION 'Unknown worker operation';
END $$;
-- Fresh reauthentication requirement for every existing cloud snapshot restore.
-- Retire the old public RPC rather than leave an alternate unguarded entry point.
ALTER FUNCTION public.pos_backup_restore_v0945(uuid,text,text) SET SCHEMA pos_private;
REVOKE ALL ON FUNCTION pos_private.pos_backup_restore_v0945(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.pos_backup_restore_v2017(p_id uuid,p_checksum text,p_confirmation text,p_proof uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT pos_private.is_owner() OR p_confirmation IS DISTINCT FROM 'אני מאשר שחזור מלא' THEN RAISE EXCEPTION 'Owner authentication and confirmation required' USING ERRCODE='42501'; END IF;
 DELETE FROM pos_private.drive_restore_proofs WHERE id=p_proof AND session_id=pos_private.current_session_id()
  AND user_id=auth.uid() AND snapshot_id=p_id AND checksum=p_checksum AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'Fresh owner authentication required' USING ERRCODE='42501'; END IF;
 RETURN pos_private.pos_backup_restore_v0945(p_id,p_checksum,p_confirmation);
END $$;
-- Explicit grants, including removal of default execute from PUBLIC.
REVOKE ALL ON FUNCTION pos_private.drive_assert_owner(uuid,uuid),pos_private.drive_snapshot(),
 pos_private.drive_enqueue(text,text,text,timestamptz),pos_private.drive_backup_tick() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_drive_owner_v2017(text,uuid,uuid,jsonb),
 public.pos_drive_oauth_v2017(text,jsonb),public.pos_drive_worker_v2017(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pos_drive_owner_v2017(text,uuid,uuid,jsonb),
 public.pos_drive_oauth_v2017(text,jsonb),public.pos_drive_worker_v2017(text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.pos_backup_restore_v2017(uuid,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pos_backup_restore_v2017(uuid,text,text,uuid) TO authenticated;
COMMIT;
