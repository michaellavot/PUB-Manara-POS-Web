// Deployed to Jukebox Supabase, not POS. POS JWT is verified online against
// the original POS Auth and current owner grant on EVERY request.
import { createClient } from "npm:@supabase/supabase-js@2.102.0";
const env=k=>Deno.env.get(k)||"";
const keyFor=(modern,legacy)=>{try{return JSON.parse(env(modern)).default||env(legacy);}catch{return env(legacy);}};
const POS_URL="https://vvrilytybmrutxzeknab.supabase.co";
const POS_KEY="sb_publishable_igJ3C6h4Mm7qkkBMcj2Qjw_aSZW5z4d";
const ORIGIN="https://michaellavot.github.io";
const SERVICE_KEY=keyFor("SUPABASE_SECRET_KEYS","SUPABASE_SERVICE_ROLE_KEY");
const service=createClient(env("SUPABASE_URL"),SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const actions=new Set(["snapshot","configure","pair","hold","release","cancel","retry","playlist_create","playlist_replace","playlist_rename","playlist_save","playlist_archive","playlist_restore","playlist_select","unlock","revoke_device"]);
const cors={"Access-Control-Allow-Origin":ORIGIN,"Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin","Cache-Control":"no-store"};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json; charset=utf-8"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function verifiedOwner(token){
 const headers={apikey:POS_KEY,Authorization:"Bearer "+token,"Content-Type":"application/json"};
 const userResponse=await fetch(POS_URL+"/auth/v1/user",{headers,signal:AbortSignal.timeout(10000),redirect:"error"});
 if(!userResponse.ok)return null;
 const user=await userResponse.json();
 if(!uuid.test(user.id||""))return null;
 const profileResponse=await fetch(POS_URL+"/rest/v1/rpc/pos_session_profile",{method:"POST",headers,body:"{}",signal:AbortSignal.timeout(10000),redirect:"error"});
 if(!profileResponse.ok)return null;
 const profile=await profileResponse.json();
 if(profile.user_id!==user.id||profile.active!==true||profile.is_owner!==true||profile.owner_terminal!==true||profile.pin_login!==true||!(Date.parse(profile.valid_until)>Date.now()))return null;
 return user.id;
}
Deno.serve(async req=>{
 if(req.headers.get("Origin")!==ORIGIN)return json({error:"origin_denied"},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
 if(req.method!=="POST")return json({error:"method_not_allowed"},405);
 const match=/^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.get("Authorization")||"");
 if(!match||match[1].length>12000)return json({error:"owner_required"},401);
 try{
  const owner=await verifiedOwner(match[1]);
  if(!owner)return json({error:"owner_required"},403);
  const raw=await req.text();
  if(raw.length>160000)return json({error:"invalid_payload"},413);
  let body;try{body=JSON.parse(raw);}catch{return json({error:"invalid_payload"},400);}
  if(!body||!actions.has(body.action))return json({error:"action_disabled"},403);
  const data=body.data??{};
  if(!data||Array.isArray(data)||typeof data!=="object")return json({error:"invalid_payload"},400);
  const result=await service.rpc("jukebox_pos_owner_v2019",{p_action:body.action,p_data:data,p_pos_user:owner});
  if(result.error){
   const code=result.error.code==="42501"?"owner_or_action_denied":result.error.code==="22P02"?"invalid_payload":"jukebox_operation_failed";
   return json({error:code},code==="owner_or_action_denied"?403:400);
  }
  return json({ok:true,result:result.data});
 }catch{return json({error:"jukebox_unavailable"},503);}
});