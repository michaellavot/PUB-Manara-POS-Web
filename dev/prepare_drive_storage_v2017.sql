-- DEV activation prerequisite. Run only in the approved target project.
BEGIN;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('pos-system-release-artifacts','pos-system-release-artifacts',false,67108864,ARRAY['application/zip'])
ON CONFLICT(id) DO NOTHING;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='pos-system-release-artifacts' AND NOT public)
 THEN RAISE EXCEPTION 'System release bucket must be private'; END IF;
 -- Fail closed if a non-service-role policy could expose this private bucket.
 -- Current production storage has no user policies. A future policy requires review.
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
  AND roles && ARRAY['public','anon','authenticated']::name[])
 THEN RAISE EXCEPTION 'Review existing Storage policies before activation'; END IF;
END $$;
COMMIT;
