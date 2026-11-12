// DEV ONLY until isolated integration tests and owner Google consent are complete.
// Supabase gateway verify_jwt=false is required for the Google callback; all other
// routes explicitly verify a user JWT + live owner grant, or a dedicated worker secret.
import { createClient } from "npm:@supabase/supabase-js@2.102.0";
import { zipSync, unzipSync } from "npm:fflate@0.8.2";
import {utf8,decodeUtf8,sha256,uuidPattern,hashPattern,driveIdPattern,randomUrlBytes,b64ToBytes,bytesToB64,encryptToken,decryptToken,assertSnapshot,validateSchedule,localStamp,fileName,safeError,fixedTimeEqual,requirePrivateMeta,verifyBytes} from "./core.ts";
const env=k=>Deno.env.get(k)||'';
const keyFor=(modern,legacy)=>{try{return JSON.parse(env(modern)).default||env(legacy);}catch{return env(legacy);}};
const SUPABASE_URL=env('SUPABASE_URL');
const PUBLIC_KEY=keyFor('SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY');
const SERVICE_KEY=keyFor('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY');
let runtimeKeys=null,runtimeLoadedAt=0;
const config=()=>({clientId:env('POS_DRIVE_CLIENT_ID'),clientSecret:env('POS_DRIVE_CLIENT_SECRET'),
 redirectUri:env('POS_DRIVE_REDIRECT_URI')||SUPABASE_URL+'/functions/v1/pos-drive-backup',
 tokenKey:runtimeKeys?.tokenKey||env('POS_DRIVE_TOKEN_KEY'),
 workerSecret:runtimeKeys?.workerSecret||env('POS_DRIVE_WORKER_SECRET'),releaseSecret:runtimeKeys?.releaseSecret||env('POS_DRIVE_RELEASE_SECRET'),
 appOrigin:env('POS_DRIVE_APP_ORIGIN')||'https://michaellavot.github.io'});
const opts={auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}};
const service=createClient(SUPABASE_URL,SERVICE_KEY,opts);
const db=async(name,args)=>{const {data,error}=await service.rpc(name,args);if(error){
 if(error.message==='Invalid or expired OAuth state')throw Object.assign(Error('oauth_state_expired'),{status:409});
 if(error.code==='42501')throw Object.assign(Error('owner_required'),{status:403});
 if(error.code==='23505')throw Object.assign(Error('duplicate_schedule'),{status:409});
 if(error.message==='Verified release artifact required'||error.message==='System package missing')throw Object.assign(Error('system_package_missing'),{status:409});
 if(error.message==='Drive not connected')throw Object.assign(Error('drive_not_connected'),{status:409});
 if(error.message==='Backup in progress')throw Object.assign(Error('backup_in_progress'),{status:409});
 throw Error('database_operation_failed');
 }return data;};
async function loadRuntime(){
 if(runtimeKeys&&Date.now()-runtimeLoadedAt<60000)return;
 const v=await db('pos_drive_runtime_v2017',{});
 if(!v?.tokenKey||!v?.workerSecret||!v?.releaseSecret)throw Error('server_configuration_missing');
 runtimeKeys=v;runtimeLoadedAt=Date.now();
}
const worker=(p_action,p_body={})=>db('pos_drive_worker_v2017',{p_action,p_body});
const oauth=(p_action,p_body={})=>db('pos_drive_oauth_v2017',{p_action,p_body});
const ownerRpc=(who,p_action,p_body={})=>db('pos_drive_owner_v2017',{p_action,p_session:who.session,p_user:who.user,p_body});
const fail=(code,status=400)=>{throw Object.assign(Error(code),{status});};
const GOOGLE='https://www.googleapis.com/drive/v3';
const UPLOAD='https://www.googleapis.com/upload/drive/v3';
const MAX_BYTES=64*1024*1024;
const FOLDER_MIME='application/vnd.google-apps.folder';
const META='id,name,mimeType,parents,trashed,shared,driveId,owners(me),appProperties,size,sha256Checksum';
const SCOPE='https://www.googleapis.com/auth/drive.file';
function readyConfig(){
 const c=config();if(!c.clientId||!c.clientSecret||!c.redirectUri||!c.tokenKey)fail('google_configuration_missing',503);
 if(b64ToBytes(c.tokenKey).length!==32)fail('invalid_token_key',503);
 return c;
}
function jwtSession(jwt){
 const parts=jwt.split('.');if(parts.length!==3)fail('owner_required',401);
 try{const id=JSON.parse(decodeUtf8(b64ToBytes(parts[1]))).session_id;if(!uuidPattern.test(id))fail('owner_required',401);return id;}catch{fail('owner_required',401);}
}
async function owner(req){
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
 if(!token)fail('owner_required',401);
 const {data,error}=await service.auth.getUser(token);
 if(error||!data?.user?.id)fail('owner_required',401);
 const client=createClient(SUPABASE_URL,PUBLIC_KEY,{...opts,global:{headers:{Authorization:'Bearer '+token}}});
 const {data:p,error:e}=await client.rpc('pos_session_profile');
 if(e||p?.active!==true||p.is_owner!==true||p.owner_terminal!==true||p.pin_login!==true)fail('owner_required',403);
 return {user:data.user.id,session:jwtSession(token),token};
}
async function freshOwnerPassword(req,email,password){
 if(typeof email!=='string'||typeof password!=='string'||!password||email.length>254||password.length>1024)fail('invalid_credentials',401);
 const ip=(req.headers.get('cf-connecting-ip')||req.headers.get('x-forwarded-for')||'unknown').split(',')[0].trim();
 const {data:th,error:te}=await service.rpc('pos_pin_attempt',{p_username_key:'drive-restore-owner',p_ip_hash:await sha256(utf8('drive-proof|'+ip+'|'+SERVICE_KEY))});
 if(te||th?.allowed!==true)fail('too_many_attempts',429);
 const {data:account,error:ae}=await service.from('employees').select('user_id').eq('is_owner',true).eq('active',true).maybeSingle();
 if(ae||!account)fail('owner_required',403);
 const auth=createClient(SUPABASE_URL,PUBLIC_KEY,opts);
 const {data,error}=await auth.auth.signInWithPassword({email:email.trim(),password});
 try{if(error||data?.user?.id!==account.user_id)fail('invalid_credentials',401);}
 finally{if(data?.session)await auth.auth.signOut({scope:'local'}).catch(()=>{});}
}
async function tokenRequest(fields){
 const c=readyConfig();
 const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,...fields}),signal:AbortSignal.timeout(20000)});
 const v=await res.json().catch(()=>({}));
 if(!res.ok||typeof v.access_token!=='string')fail(v.error==='invalid_grant'?'google_reconnect_required':'google_token_failed',502);
 return v;
}
async function accessFor(c){
 if(!c?.encrypted_refresh_token)fail('drive_not_connected',409);
 const refresh=await decryptToken(c.encrypted_refresh_token,c.generation,readyConfig().tokenKey);
 return (await tokenRequest({grant_type:'refresh_token',refresh_token:refresh})).access_token;
}
async function google(token,url,options={},allow=[]){
 const u=new URL(url);if(u.protocol!=='https:'||!['www.googleapis.com','oauth2.googleapis.com'].includes(u.hostname))fail('invalid_google_url',502);
 const res=await fetch(u,{...options,headers:{Authorization:'Bearer '+token,...options.headers},signal:AbortSignal.timeout(options.method==='PUT'?65000:25000),redirect:'error'});
 if(!res.ok&&!allow.includes(res.status)){
  const err=await res.json().catch(()=>({}));
  const reason=String(err.error?.errors?.[0]?.reason||'');
  const stage=u.pathname.startsWith('/upload/')?'upload':u.pathname.endsWith('/permissions')?'permissions':u.pathname.endsWith('/generateIds')?'generate_ids':u.pathname==='/drive/v3/files'?(options.method==='POST'?'create':'list'):'metadata';
  console.error('pos-drive-backup google',stage,res.status,/^[a-zA-Z0-9_]{1,80}$/.test(reason)?reason:'unknown');
  fail(res.status===401?'google_reconnect_required':res.status===429?'google_rate_limited':reason==='accessNotConfigured'||reason==='serviceDisabled'?'google_api_disabled':reason==='storageQuotaExceeded'?'google_storage_full':res.status===403?'google_permission_denied':res.status===404?'google_file_not_found':'google_'+stage+'_failed',502);
 }
 return res;
}
const gj=async(token,path,options={},allow=[])=>{
 const res=await google(token,GOOGLE+path,options,allow);return {status:res.status,data:await res.json().catch(()=>({}))};
};
const jsonHeaders={'Content-Type':'application/json'};
const filePath=id=>{if(!driveIdPattern.test(id))fail('invalid_drive_file_id');return '/files/'+encodeURIComponent(id);};
async function metadata(token,id,allow404=false){
 const r=await gj(token,filePath(id)+'?fields='+encodeURIComponent(META),{},allow404?[404]:[]);
 return r.status===404?null:r.data;
}
async function privateFile(token,id,parent,folder=false){
 const m=await metadata(token,id);requirePrivateMeta(m,parent,folder);
 const {data:p}=await gj(token,filePath(id)+'/permissions?fields=nextPageToken,permissions(id,type,role,deleted)&pageSize=100');
 if(p.nextPageToken||!Array.isArray(p.permissions)||p.permissions.length!==1||p.permissions[0].role!=='owner'||p.permissions[0].type!=='user'||p.permissions[0].deleted===true)
  fail('drive_folder_not_private',403);
 return m;
}
// drive.file does not require reading the user's My Drive root metadata.
// Use the documented root alias only in queries, and omit parents on root creation.
async function markedFolders(token,parent,marker){
 const q="'"+parent+"' in parents and trashed = false and mimeType = '"+FOLDER_MIME+"' and appProperties has { key='manaraBackupFolder' and value='"+marker+"' }";
 const {data:r}=await gj(token,'/files?'+new URLSearchParams({q,fields:'nextPageToken,files(id)',pageSize:'100',spaces:'drive'}));
 if(r.nextPageToken||!Array.isArray(r.files)||r.files.length>1)fail('drive_duplicate_folder',409);
 return r.files;
}
async function verifyRoot(token,id){
 const rows=await markedFolders(token,'root','root');
 if(rows.length!==1||rows[0].id!==id)fail('drive_folder_not_private',403);
 const m=await metadata(token,id);
 if(!Array.isArray(m.parents)||m.parents.length!==1||!driveIdPattern.test(m.parents[0]))fail('drive_folder_not_private',403);
 await privateFile(token,id,m.parents[0],true);
}
async function findFolder(token,parent,marker,name){
 const rows=await markedFolders(token,parent,marker);
 let id=rows[0]?.id;
 if(!id){
  const body={name,mimeType:FOLDER_MIME,appProperties:{manaraBackupFolder:marker}};
  if(parent!=='root')body.parents=[parent];
  const {data:f}=await gj(token,'/files?fields=id',{method:'POST',headers:jsonHeaders,body:JSON.stringify(body)});
  id=f.id;
 }
 if(parent==='root')await verifyRoot(token,id);
 else await privateFile(token,id,parent,true);
 return id;
}
async function assertFolders(token,c){
 await verifyRoot(token,c.root_folder);
 await privateFile(token,c.data_folder,c.root_folder,true);
 await privateFile(token,c.system_folder,c.root_folder,true);
}
async function newDriveId(token){
 const {data:r}=await gj(token,'/files/generateIds?count=1&space=drive&type=files');
 const id=r.ids?.[0];if(!driveIdPattern.test(id))fail('drive_id_missing',502);return id;
}
async function downloadedBytes(token,id,expectedSize){
 const r=await google(token,GOOGLE+filePath(id)+'?alt=media');
 const len=Number(r.headers.get('Content-Length')||0);
 if(len>MAX_BYTES||expectedSize>MAX_BYTES)fail('backup_too_large',413);
 // A size/hash check follows. Abort a malicious or unexpectedly oversized body.
 const reader=r.body?.getReader();if(!reader)fail('drive_download_failed',502);
 let total=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>MAX_BYTES||total>expectedSize)fail('drive_checksum_mismatch',502);chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(total);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;
}
async function uploadVerified(token,{id,parent,name,mime,bytes,jobId,kind}){
 if(bytes.byteLength>MAX_BYTES||bytes.byteLength<1)fail('backup_too_large',413);
 const digest=await sha256(bytes);
 let meta=await metadata(token,id,true);
 if(!meta){
  const start=await google(token,UPLOAD+'/files?uploadType=resumable&fields='+encodeURIComponent(META),{
   method:'POST',headers:{...jsonHeaders,'X-Upload-Content-Type':mime,'X-Upload-Content-Length':String(bytes.byteLength)},
   body:JSON.stringify({id,name,mimeType:mime,parents:[parent],appProperties:{manaraBackupJob:jobId,manaraBackupKind:kind,manaraBackupSha256:digest}})},[409]);
  if(start.status!==409){
   const loc=start.headers.get('Location');if(!loc)fail('drive_upload_failed',502);
   const put=await google(token,loc,{method:'PUT',headers:{'Content-Type':mime,'Content-Length':String(bytes.byteLength)},body:bytes},[409,308]);
   if(put.status===308)fail('drive_upload_incomplete',502);
  }
 }
 meta=await privateFile(token,id,parent);
 if(meta.name!==name||meta.appProperties?.manaraBackupJob!==jobId||meta.appProperties?.manaraBackupKind!==kind||
  meta.appProperties?.manaraBackupSha256!==digest||Number(meta.size)!==bytes.byteLength||
  (meta.sha256Checksum&&meta.sha256Checksum!==digest))fail('drive_checksum_mismatch',502);
 const actual=await downloadedBytes(token,id,bytes.byteLength);
 return await verifyBytes(bytes,actual);
}
async function beginOAuth(who){
 const c=readyConfig(),state=randomUrlBytes(),verifier=randomUrlBytes();
 const stateHash=await sha256(utf8(state)),challenge=bytesToB64(new Uint8Array(await crypto.subtle.digest('SHA-256',utf8(verifier)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 const status=await ownerRpc(who,'status');if(status.connected)fail('disconnect_first',409);
 await ownerRpc(who,'oauth_start',{stateHash,verifier});
 const url='https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:c.clientId,redirect_uri:c.redirectUri,response_type:'code',
 scope:SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'});
 return {authorizationUrl:url};
}
async function callback(req){
 const u=new URL(req.url),state=u.searchParams.get('state'),code=u.searchParams.get('code');
 if(!state||!code||u.searchParams.has('error'))fail('google_authorization_cancelled');
 const o=await oauth('consume',{stateHash:await sha256(utf8(state))});
 const c=readyConfig();
 const t=await tokenRequest({grant_type:'authorization_code',code,code_verifier:o.verifier,redirect_uri:c.redirectUri});
 if(!t.refresh_token||!String(t.scope||'').split(' ').includes(SCOPE))fail('google_refresh_permission_missing',403);
 const rootFolder=await findFolder(t.access_token,'root','root','PUB Manara POS');
 const dataFolder=await findFolder(t.access_token,rootFolder,'data','Backups');
 const systemFolder=await findFolder(t.access_token,rootFolder,'system','System Restore Points');
 // Only synthetic content is uploaded during connection validation.
 const testId=await newDriveId(t.access_token),testJob=crypto.randomUUID();
 const testBytes=utf8(JSON.stringify({format:'manara-drive-connection-test-v1',createdAt:new Date().toISOString(),synthetic:true}));
 await uploadVerified(t.access_token,{id:testId,parent:dataFolder,name:'Connection_Test_'+testJob.slice(0,8)+'.json',mime:'application/json',bytes:testBytes,jobId:testJob,kind:'test'});
 await oauth('finish',{session_id:o.session_id,user_id:o.user_id,generation:o.generation,
  encryptedToken:await encryptToken(t.refresh_token,o.generation,c.tokenKey),rootFolder,dataFolder,systemFolder});
 return new Response('החיבור ל-Google Drive הצליח וקובץ הבדיקה אומת. חזור לקופה ולחץ על רענן מצב.',{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
async function buildRelease(version,commit){
 if(!/^\d+\.\d+\.\d+$/.test(version)||!/^[a-f0-9]{40}$/.test(commit))fail('invalid_release');
 const cp=await db('pos_drive_release_checkpoint_v2017',{p_version:version,p_commit:commit});
 if(!cp||cp.version!==version||cp.commit!==commit||cp.schema?.format!=='manara-schema-catalog-v1'||!Array.isArray(cp.edge)||!cp.edge.length)fail('release_checkpoint_missing',409);
 const response=await fetch('https://codeload.github.com/michaellavot/PUB-Manara-POS-Web/zip/'+commit,{signal:AbortSignal.timeout(35000)});
 if(!response.ok)fail('source_archive_unavailable',502);
 const reader=response.body?.getReader();if(!reader)fail('source_archive_unavailable',502);
 let total=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>24*1024*1024)fail('source_archive_too_large',413);chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const source=new Uint8Array(total);let at=0;for(const chunk of chunks){source.set(chunk,at);at+=chunk.length;}
 const root='PUB-Manara-POS-Web-'+commit+'/';
 const sv=unzipSync(source,{filter:f=>[root+'version.json',root+'index.html',root+'app.js'].includes(f.name)});
 if(!sv[root+'version.json']||!sv[root+'index.html']||!sv[root+'app.js']||JSON.parse(decodeUtf8(sv[root+'version.json'])).version!==version)fail('source_version_mismatch',502);
 const files={'source.zip':source,'database/schema.json':utf8(JSON.stringify(cp.schema,null,2))};
 for(const edge of cp.edge){
  if(!/^[a-z0-9-]+$/.test(edge.slug)||!Array.isArray(edge.files)||!edge.files.length)fail('release_checkpoint_invalid',502);
  for(const f of edge.files){
   const name=String(f.name||'');
   if(!/^[a-zA-Z0-9_./-]+$/.test(name)||name.startsWith('/')||name.split('/').includes('..')||typeof f.content!=='string')fail('release_checkpoint_invalid',502);
   files['edge-functions/'+edge.slug+'/'+name]=utf8(f.content);
  }
  files['edge-functions/'+edge.slug+'/deployment.json']=utf8(JSON.stringify({slug:edge.slug,version:edge.version,verify_jwt:edge.verify_jwt,sha256:edge.sha256},null,2));
 }
 files['RESTORE_README.txt']=utf8(['PUB Manara POS V'+version+' / '+commit,'source.zip: exact Git source and assets.','database/schema.json: schema catalog with definitions, constraints, policies, grants and functions.','edge-functions: deployed source and deployment metadata.','Software recovery package, not a physical DB dump or one-click database restore. Recreate authentication identities and secrets separately.','Keep new transactions unless owner explicitly approves a data restore.'].join('\n'));
 const list=[];for(const [path,bytes] of Object.entries(files))list.push({path,sha256:await sha256(bytes),size:bytes.byteLength});
 files['manifest.json']=utf8(JSON.stringify({format:'manara-release-v1',version,commit,createdAt:cp.createdAt,files:list},null,2));
 const artifact=zipSync(files,{level:0,mtime:new Date('2000-01-01T00:00:00Z')});
 if(artifact.length>MAX_BYTES)fail('backup_too_large',413);
 const digest=await sha256(artifact),storage_path=version+'/'+commit+'.zip',bucket=service.storage.from('pos-system-release-artifacts');
 const uploaded=await bucket.upload(storage_path,artifact,{contentType:'application/zip',upsert:false});
 if(uploaded.error){
  const existing=await bucket.download(storage_path);if(existing.error||!existing.data)fail('system_package_upload_failed',502);
  const bytes=new Uint8Array(await existing.data.arrayBuffer());if(bytes.length!==artifact.length||await sha256(bytes)!==digest)fail('immutable_release_artifact_mismatch',409);
 }
 const saved=await bucket.download(storage_path);if(saved.error||!saved.data)fail('system_package_unavailable',502);
 const bytes=new Uint8Array(await saved.data.arrayBuffer());if(bytes.length!==artifact.length||await sha256(bytes)!==digest)fail('system_package_checksum_mismatch',502);
 const verified=unzipSync(bytes);for(const f of list){if(!verified[f.path]||await sha256(verified[f.path])!==f.sha256)fail('system_package_checksum_mismatch',502);}
 const registered=await worker('register_release',{version,commit_sha:commit,storage_path,sha256:digest,byte_size:artifact.length});
 return {...registered,version,commit,sha256:digest,byteSize:artifact.length};
}
async function systemPackage(release,dataBytes,job){
 if(!release||!hashPattern.test(release.sha256)||Number(release.byte_size)>MAX_BYTES)fail('system_package_missing',409);
 const {data,error}=await service.storage.from('pos-system-release-artifacts').download(release.storage_path);
 if(error||!data)fail('system_package_unavailable',502);
 const artifact=new Uint8Array(await data.arrayBuffer());
 if(artifact.byteLength!==Number(release.byte_size)||await sha256(artifact)!==release.sha256)fail('system_package_checksum_mismatch',502);
 // Validate presence of the manifest and schema in the trusted, hash-pinned release archive.
 const files=unzipSync(artifact,{filter:f=>['manifest.json','database/schema.sql','database/schema.json'].includes(f.name)});
 if(!files['manifest.json']||(!files['database/schema.sql']&&!files['database/schema.json']))fail('system_package_incomplete',502);
 const m=JSON.parse(decodeUtf8(files['manifest.json']));
 if(m.version!==release.version||m.commit!==release.commit_sha||!Array.isArray(m.files)||!m.files.some(f=>f.path==='database/schema.sql'||f.path==='database/schema.json')||!m.files.some(f=>f.path.startsWith('edge-functions/')))fail('system_package_manifest_invalid',502);
 const manifest=utf8(JSON.stringify({format:'manara-system-restore-v1',version:release.version,commit:release.commit_sha,
  backupId:job.id,createdAt:job.created_at,releaseSha256:release.sha256,dataSha256:await sha256(dataBytes),
  exclusions:['passwords','PINs','OAuth tokens','Vault and project secrets','auth.users credentials'],
  note:'Restore source/schema/functions separately from data. Recreate authentication identities and secrets; test in isolated project before production.'}));
 const zip=zipSync({'release.zip':artifact,'data.json':dataBytes,'manifest.json':manifest},{level:0,mtime:new Date('2000-01-01T00:00:00Z')});
 if(zip.length>MAX_BYTES)fail('backup_too_large',413);return zip;
}
async function runOne(){
 const claim=await worker('claim');if(!claim)return {processed:false};
 const {job,connection,release}=claim,ref={id:job.id,lease:job.lease};
 try{
  const token=await accessFor(connection);
  await assertFolders(token,connection);
  assertSnapshot(job.snapshot_text);
  const dataBytes=utf8(job.snapshot_text);
  // Save data even if packaging the system archive later fails. "Both" only
  // succeeds after both independent files are verified; retries reuse their IDs.
  const kinds=job.kind==='both'?['data','system']:['data'];
  for(const kind of kinds){
   const item=kind==='data'?{kind,parent:connection.data_folder,mime:'application/json',bytes:dataBytes}:
    {kind,parent:connection.system_folder,mime:'application/zip',bytes:await systemPackage(release,dataBytes,job)};
   let id=job[item.kind+'_file_id'];
   if(!id)id=(await worker('reserve',{...ref,kind:item.kind,fileId:await newDriveId(token)})).fileId;
   const digest=await uploadVerified(token,{...item,id,name:fileName(job,item.kind,release?.version),jobId:job.id});
   await worker('verified',{...ref,kind:item.kind,fileId:id,sha256:digest});
  }
  await worker('complete',ref);return {processed:true,id:job.id,status:'succeeded'};
 }catch(e){
  const errorCode=safeError(e);
  await worker('fail',{...ref,errorCode}).catch(()=>{});
  return {processed:true,id:job.id,status:'retry_or_failed',errorCode};
 }
}
async function prepareDriveRestore(who,id){
 if(!uuidPattern.test(id))fail('invalid_job');
 const job=await worker('job_status',{id}),c=await worker('connection');
 if(!job.data_sha256||!job.data_file_id)fail('unverified_backup',409);
 const token=await accessFor(c);await assertFolders(token,c);
 const meta=await privateFile(token,job.data_file_id,c.data_folder),size=Number(meta.size);
 if(!Number.isSafeInteger(size)||size<1||size>MAX_BYTES)fail('backup_too_large');
 const bytes=await downloadedBytes(token,job.data_file_id,size);
 if(bytes.length!==size||await sha256(bytes)!==job.data_sha256)fail('drive_checksum_mismatch',502);
 const snapshot=assertSnapshot(decodeUtf8(bytes));
 return ownerRpc(who,'import_verified',{snapshot});
}
function headers(req){
 const origin=req.headers.get('Origin')||'';
 const allowed=origin===config().appOrigin?origin:config().appOrigin;
 return {'Access-Control-Allow-Origin':allowed,'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info',
  'Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'};
}
const answer=(req,data,status=200)=>new Response(JSON.stringify(data),{status,headers:headers(req)});
Deno.serve(async req=>{
 try{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:headers(req)});
  if(req.method==='GET'){await loadRuntime();return await callback(req);}
  if(req.method!=='POST')return answer(req,{error:'method_not_allowed'},405);
  const raw=await req.text();if(raw.length>16384)fail('request_too_large',413);
  const body=JSON.parse(raw||'{}'),action=body.action;await loadRuntime();const c=config();
  // Scheduler and release runner have distinct secrets; neither is in the browser.
  if(action==='tick'||action==='run'){
   if(!c.workerSecret||!fixedTimeEqual(req.headers.get('x-pos-backup-worker')||'',c.workerSecret))fail('worker_required',403);
   if(action==='tick')await worker('tick');
   return answer(req,await runOne());
  }
  if(['release_build','release_register','before_update','release_job_status'].includes(action)){
   if(!c.releaseSecret||!fixedTimeEqual(req.headers.get('x-pos-backup-release')||'',c.releaseSecret))fail('release_required',403);
   if(action==='release_build')return answer(req,await buildRelease(body.version,body.commit));
   if(action==='release_register'){
    const r=body.release||{};
    if(!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(r.version)||!/^[a-f0-9]{40}$/.test(r.commit_sha)||!hashPattern.test(r.sha256)||
      r.storage_path!==r.version+'/'+r.commit_sha+'.zip'||!Number.isSafeInteger(r.byte_size)||r.byte_size<1||r.byte_size>MAX_BYTES)fail('invalid_release');
    // Verify the complete archive from private storage before marking it active.
    const {data,error}=await service.storage.from('pos-system-release-artifacts').download(r.storage_path);
    if(error||!data)fail('system_package_unavailable',502);
    const bytes=new Uint8Array(await data.arrayBuffer());
    if(bytes.length!==r.byte_size||await sha256(bytes)!==r.sha256)fail('system_package_checksum_mismatch',502);
    const z=unzipSync(bytes);
    const m=JSON.parse(decodeUtf8(z['manifest.json']));
    if(m.version!==r.version||m.commit!==r.commit_sha||!Array.isArray(m.files)||(!z['database/schema.sql']&&!z['database/schema.json'])||!m.files.some(f=>f.path.startsWith('edge-functions/')))fail('system_package_incomplete',502);
    for(const f of m.files){if(!z[f.path]||await sha256(z[f.path])!==f.sha256)fail('system_package_checksum_mismatch',502);}
    return answer(req,await worker('register_release',r));
   }
   if(action==='before_update'){
    if(!uuidPattern.test(body.requestId)||!/^\d+\.\d+\.\d+$/.test(body.expectedVersion)||!/^[a-f0-9]{40}$/.test(body.expectedCommit))fail('invalid_request');
    return answer(req,await worker('before_update',{requestId:body.requestId,expectedVersion:body.expectedVersion,expectedCommit:body.expectedCommit}));
   }
   if(!uuidPattern.test(body.id))fail('invalid_job');
   return answer(req,await worker('job_status',{id:body.id}));
  }
  const who=await owner(req);
  if(action==='status')return answer(req,{...await ownerRpc(who,'status'),configured:!!(c.clientId&&c.clientSecret&&c.redirectUri&&c.tokenKey)});
  if(action==='connect')return answer(req,await beginOAuth(who));
  if(action==='save_schedule')return answer(req,await ownerRpc(who,action,validateSchedule(body.schedule)));
  if(action==='delete_schedule'){
   if(!uuidPattern.test(body.id))fail('invalid_schedule');
   return answer(req,await ownerRpc(who,action,{id:body.id}));
  }
  if(action==='enable'){
   if(typeof body.enabled!=='boolean')fail('invalid_schedule');
   return answer(req,await ownerRpc(who,action,{enabled:body.enabled}));
  }
  if(action==='manual'){
   if(!uuidPattern.test(body.requestId)||!['data','both'].includes(body.kind))fail('invalid_request');
   return answer(req,await ownerRpc(who,action,{kind:body.kind,requestId:body.requestId}));
  }
  if(action==='disconnect'){
   // Disable/clear connection first; then attempt OAuth revocation. Never delete Drive files.
   const result=await ownerRpc(who,action);
   let revoked=false;
   if(result.encryptedRefreshToken){
    try{const refresh=await decryptToken(result.encryptedRefreshToken,result.generation,readyConfig().tokenKey);
     const res=await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({token:refresh}),signal:AbortSignal.timeout(15000)});
     revoked=res.ok;
    }catch{}
   }
   return answer(req,{ok:true,revoked});
  }
  if(action==='prepare_restore')return answer(req,await prepareDriveRestore(who,body.id));
  if(action==='restore_proof'){
   if(!uuidPattern.test(body.snapshotId)||!/^[a-f0-9]{32}$/.test(body.checksum))fail('invalid_restore');
   await freshOwnerPassword(req,body.email,body.password);
   return answer(req,await ownerRpc(who,'proof',{snapshotId:body.snapshotId,checksum:body.checksum}));
  }
  fail('unknown_action');
 }catch(e){
  const status=Number(e?.status)||500,error=safeError(e);
  // Never log credentials, tokens, response bodies, backup contents or URLs with OAuth codes.
  if(status>=500)console.error('pos-drive-backup',error);
  if(req.method==='GET'){
   const messages={oauth_state_expired:'קישור האימות כבר נוצל או פג תוקף. חזור לקופה ולחץ שוב על חבר Google Drive כדי ליצור קישור חדש.',google_authorization_cancelled:'החיבור לא הושלם. התחל חיבור חדש מתוך הקופה.',owner_required:'הרשאת הבעלים אינה פעילה. חזור לקופה והתחבר מחדש לניהול מערכת.',google_api_disabled:'Google Drive API אינו מופעל בפרויקט Google Cloud.',google_permission_denied:'Google סירבה להרשאת הגישה לקובץ או לתיקייה.',google_file_not_found:'Google לא מצאה קובץ או תיקייה שהקופה רשאית לגשת אליהם.',google_storage_full:'אין מספיק נפח אחסון בדרייב.',drive_folder_not_private:'תיקיית הגיבוי אינה פרטית או אינה במיקום הנדרש.',drive_duplicate_folder:'נמצאו כמה תיקיות גיבוי זהות. נדרשת בדיקה.',google_reconnect_required:'הרשאת Google פגה. התחבר מחדש.',google_list_failed:'נכשלה בדיקת תיקיות הגיבוי בדרייב.',google_create_failed:'נכשלה יצירת תיקיית גיבוי בדרייב.',google_metadata_failed:'נכשלה קריאת פרטי הקובץ בדרייב.',google_permissions_failed:'נכשלה בדיקת הרשאות התיקייה.',google_upload_failed:'נכשלה העלאת קובץ הבדיקה.'};
   return new Response((messages[error]||'החיבור לדרייב נכשל. חזור לקופה והתחל חיבור חדש.')+' ('+error+')',{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
  return answer(req,{error},status);
 }
});
