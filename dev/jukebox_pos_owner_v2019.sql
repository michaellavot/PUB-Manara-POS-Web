-- Deploy ONLY in Jukebox Supabase. Owner mapping is provisioned separately from verified accounts.
BEGIN;
CREATE TABLE IF NOT EXISTS jukebox_private.pos_owner_bridge_v2019(pos_terminal_id uuid PRIMARY KEY,jukebox_owner_id uuid NOT NULL REFERENCES public.employees(user_id),enabled boolean NOT NULL DEFAULT true);
ALTER TABLE jukebox_private.pos_owner_bridge_v2019 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jukebox_private.pos_owner_bridge_v2019 FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.jukebox_pos_owner_v2019(p_action text, p_data jsonb, p_pos_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target_owner uuid; previous_claims text; previous_sub text; result jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'owner bridge denied' using errcode='42501'; end if;
 select b.jukebox_owner_id into target_owner from jukebox_private.pos_owner_bridge_v2019 b
 join public.employees e on e.user_id=b.jukebox_owner_id
 where b.pos_terminal_id=p_pos_user and b.enabled and e.active and e.is_owner;
 if target_owner is null then raise exception 'owner bridge denied' using errcode='42501'; end if;
 if p_action is null or p_action not in ('snapshot','configure','pair','hold','release','cancel','retry','playlist_create','playlist_replace','playlist_rename','playlist_save','playlist_archive','playlist_restore','playlist_select','unlock','revoke_device') then
  raise exception 'action not available through POS' using errcode='42501';
 end if;
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>160000 then raise exception 'invalid payload'; end if;
 -- Keep actual song-code issuance and all live charge/refund actions outside this bridge.
 if p_action in ('hold','release','cancel','retry') and not exists(
  select 1 from jukebox_private.orders where id=(p_data->>'id')::uuid and is_test
 ) then raise exception 'only test orders can be changed' using errcode='42501'; end if;
 perform jukebox_private.lock_state();
 if p_action in ('configure','revoke_device') then
  if p_action='configure' and exists(select 1 from jsonb_object_keys(p_data) as x(k) where k not in ('enabled','open','paused','price')) then raise exception 'invalid settings'; end if;
  if (p_data ? 'price') and ((p_data->>'price')::numeric < 0 or (p_data->>'price')::numeric > 10000) then raise exception 'invalid price'; end if;
  if exists(select 1 from jukebox_private.codes where not is_test and status='active') or
     exists(select 1 from jukebox_private.orders where not is_test and status in ('queued','held','playing','failed','pending_approval')) then
    raise exception 'live song operations unavailable' using errcode='42501';
  end if;
 end if;
 if p_action in ('playlist_create','playlist_rename','playlist_save') and (length(btrim(coalesce(p_data->>'name',''))) not between 1 and 100) then raise exception 'invalid playlist name'; end if;
 if p_action in ('playlist_replace','playlist_save') then
  if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items')>500 then raise exception 'invalid playlist'; end if;
  if exists(select 1 from jsonb_array_elements(p_data->'items') as x(i) where
    jsonb_typeof(i) is distinct from 'object' or coalesce(i->>'video_id','') !~ '^[A-Za-z0-9_-]{11}$' or
    length(btrim(coalesce(i->>'title',''))) not between 1 and 300 or coalesce(i->>'kind','') not in ('regular','mix')) then raise exception 'invalid playlist item'; end if;
 end if;
 -- Scoped delegation to the already-existing Jukebox owner; never expose service keys or
 -- an impersonation token to a browser. Restore the request claims before returning.
 previous_claims:=current_setting('request.jwt.claims',true);
 previous_sub:=current_setting('request.jwt.claim.sub',true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','service_role','sub',target_owner::text)::text,true);
 perform set_config('request.jwt.claim.sub',target_owner::text,true);
 if p_action='playlist_save' then
  perform public.jukebox_a_owner('playlist_replace',jsonb_build_object('id',p_data->>'id','items',p_data->'items'));
  result:=public.jukebox_a_owner('playlist_rename',jsonb_build_object('id',p_data->>'id','name',p_data->>'name'));
 else
  result:=public.jukebox_a_owner(p_action,p_data);
 end if;
 perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
 perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 if p_action='snapshot' then
  -- Do not send song codes or customer identities to this management screen.
  result:=(result-'codes') || jsonb_build_object('code_summary',
    jsonb_build_object('active',(select count(*) from jukebox_private.codes where is_test and status='active'),
    'total',(select count(*) from jukebox_private.codes where is_test)));
 else
  insert into jukebox_private.audit_log(action,actor,detail) values('pos_owner_bridge',target_owner,jsonb_build_object('action',p_action,'pos_terminal',p_pos_user));
 end if;
 return result;
end $function$
;
REVOKE ALL ON FUNCTION public.jukebox_pos_owner_v2019(text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.jukebox_pos_owner_v2019(text,jsonb,uuid) TO service_role;
COMMIT;
