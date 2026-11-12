// V2.0.17 DEV. Pure helpers, with no production credentials or side effects.
export const utf8 = value => new TextEncoder().encode(value);
export const decodeUtf8 = bytes => new TextDecoder('utf-8',{fatal:true}).decode(bytes);
export const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export async function sha256(bytes){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}
export const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hashPattern=/^[a-f0-9]{64}$/;
export const driveIdPattern=/^[A-Za-z0-9_-]{8,200}$/;
export function randomUrlBytes(n=32){
 const a=crypto.getRandomValues(new Uint8Array(n));
 return btoa(String.fromCharCode(...a)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export function b64ToBytes(s){
 const normal=s.replaceAll('-','+').replaceAll('_','/');
 return Uint8Array.from(atob(normal+'='.repeat((4-normal.length%4)%4)),x=>x.charCodeAt(0));
}
export function bytesToB64(bytes){let out='';for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(out);}
export async function encryptToken(token,generation,keyText){
 const raw=b64ToBytes(keyText);if(raw.length!==32)throw Error('invalid_token_key');
 const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8('manara-drive-v1:'+generation)},key,utf8(token));
 return 'v1.'+bytesToB64(iv)+'.'+bytesToB64(new Uint8Array(cipher));
}
export async function decryptToken(envelope,generation,keyText){
 const [v,iv,cipher,extra]=String(envelope).split('.');
 if(v!=='v1'||extra||!iv||!cipher)throw Error('invalid_token_envelope');
 const raw=b64ToBytes(keyText);if(raw.length!==32)throw Error('invalid_token_key');
 const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
 return decodeUtf8(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(iv),additionalData:utf8('manara-drive-v1:'+generation)},key,b64ToBytes(cipher))));
}
export function assertSnapshot(text){
 const value=JSON.parse(text);
 if(value?.format!=='manara-cloud-snapshot-v1'||!Number.isFinite(Date.parse(value.createdAt)))throw Error('invalid_snapshot_format');
 const arrays=['customers','products','transactions','transaction_items','pos_settings','backup_schedule_settings','drive_backup_schedules','pos_audit_log','pos_employee_audit','employees','staff_login_metadata'];
 for(const k of arrays)if(!Array.isArray(value[k]))throw Error('snapshot_missing_'+k);
 const ids=(rows,k='id')=>{
  const seen=new Set();
  for(const row of rows){const id=row?.[k];if(typeof id!=='string'||!uuidPattern.test(id)||seen.has(id))throw Error('snapshot_invalid_id');seen.add(id);}
  return seen;
 };
 ids(value.customers);ids(value.products);const tx=ids(value.transactions);ids(value.transaction_items);ids(value.employees,'user_id');
 for(const row of value.transaction_items)if(!tx.has(row.transaction_id))throw Error('snapshot_orphan_item');
 for(const row of value.employees)for(const k of Object.keys(row))if(!['user_id','display_name','role','active','is_owner','permissions','linked_customer_id'].includes(k))throw Error('snapshot_unexpected_employee_field');
 for(const row of value.staff_login_metadata)for(const k of Object.keys(row))if(!['user_id','username','owner_terminal','removed_at'].includes(k))throw Error('snapshot_unexpected_login_field');
 return value;
}
export function validateSchedule(value){
 if(!value||!Number.isInteger(value.weekday)||value.weekday<0||value.weekday>6||
 !Number.isInteger(value.minute_of_day)||value.minute_of_day<0||value.minute_of_day>=1440||value.minute_of_day%15!==0||
 !['data','both'].includes(value.kind)||typeof value.enabled!=='boolean'||
 (value.id!==undefined&&value.id!==null&&!uuidPattern.test(value.id)))throw Error('invalid_schedule');
 return {id:value.id||null,weekday:value.weekday,minute_of_day:value.minute_of_day,kind:value.kind,enabled:value.enabled};
}
export function localStamp(date){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(date)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 return parts.year+'-'+parts.month+'-'+parts.day+'_'+parts.hour+parts.minute;
}
export function fileName(job,kind,version){
 const base='PUB_Manara_POS_'+(kind==='system'?'System_V'+version:'Backup')+'_'+localStamp(job.due_at||job.created_at)+'_'+job.id.slice(0,8);
 return base+(kind==='system'?'.zip':'.json');
}
export function safeError(err){
 const s=String(err?.message||err||'');
 return /^[a-z0-9_]{1,80}$/.test(s)?s:'backup_failed';
}
export function fixedTimeEqual(a,b){
 const x=utf8(String(a)),y=utf8(String(b));let v=x.length^y.length;
 for(let i=0;i<Math.max(x.length,y.length);i++)v|=(x[i]||0)^(y[i]||0);
 return v===0;
}
export function requirePrivateMeta(meta,expectedParent,folder=false){
 if(!meta||!driveIdPattern.test(meta.id)||meta.trashed!==false||meta.shared!==false||meta.driveId||
    !Array.isArray(meta.owners)||meta.owners.length!==1||meta.owners[0].me!==true||
    !Array.isArray(meta.parents)||meta.parents.length!==1||meta.parents[0]!==expectedParent||
    (folder&&meta.mimeType!=='application/vnd.google-apps.folder'))throw Error('drive_folder_not_private');
}
export async function verifyBytes(expected,actual){
 if(expected.byteLength!==actual.byteLength||await sha256(expected)!==await sha256(actual))throw Error('drive_checksum_mismatch');
 return await sha256(expected);
}
