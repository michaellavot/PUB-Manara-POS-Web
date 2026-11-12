'use strict';
/* V2.0.17 DEV: Owner-only Google Drive backup controls. No secrets in client storage. */
const DriveBackup=(()=>{
 const $=id=>document.getElementById(id);
 const days=['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
 const errors={
  owner_required:'יש לאמת מחדש את בעל המערכת.',google_configuration_missing:'חיבור Google טרם הוגדר בשרת.',
  drive_not_connected:'יש לחבר את Google Drive תחילה.',google_reconnect_required:'הרשאת Google פגה או בוטלה. נדרש חיבור מחדש.',
  drive_folder_not_private:'תיקיית הגיבוי אינה פרטית. בטל את השיתוף לפני גיבוי.',
  system_package_missing:'טרם הוכנה חבילת מערכת מאומתת לגרסה הפעילה.',
  system_package_unavailable:'חבילת המערכת אינה זמינה בשרת.',
  system_package_checksum_mismatch:'בדיקת תקינות חבילת המערכת נכשלה.',
  duplicate_schedule:'כבר קיים גיבוי ביום ובשעה שנבחרו.',
  invalid_schedule:'מועד הגיבוי אינו תקין.',
  drive_checksum_mismatch:'הקובץ בדרייב לא תואם לגיבוי המקורי.',
  backup_in_progress:'גיבוי מתבצע כרגע. נסה שוב לאחר סיומו.',
  invalid_credentials:'המייל או הסיסמה אינם נכונים.',
  too_many_attempts:'יותר מדי ניסיונות אימות. נסה שוב מאוחר יותר.',
  google_permission_denied:'לשרת אין הרשאה מתאימה בדרייב.',
  google_rate_limited:'Google מגבילה זמנית את הפעולות.',
  backup_too_large:'קובץ הגיבוי גדול ממגבלת הגיבוי המאובטחת.',
  disconnected:'החיבור לדרייב נותק.',attempts_exhausted:'ניסיונות הגיבוי הסתיימו ללא הצלחה.',
  backup_failed:'הגיבוי נכשל. בדוק את מצב החיבור ונסה שוב.'
 };
 let initialized=false,last=null,visible=false,epoch=0,busy=false,refreshing=false,proofPending=null;
 let requestIds={data:null,both:null};
 const owner=()=>RemotePos.active&&RemotePos.authenticated&&RemotePos.employee?.is_owner===true&&RemotePos.employee?.owner_terminal===true;
 const when=s=>s?new Date(s).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'}):'—';
 const clock=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
 function errText(e){return errors[e?.message]||'פעולת הגיבוי נכשלה. בדוק את החיבור לשרת.';}
 function message(value,error=false){const x=$('driveBackupMessage');if(x){x.textContent=value;x.classList.toggle('backup-error',error);}}
 function node(tag,text,classes){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(classes)x.className=classes;return x;}
 function button(text,handler,classes='button secondary'){const b=node('button',text,classes);b.type='button';b.addEventListener('click',handler);return b;}
 function link(text,id){if(!/^[A-Za-z0-9_-]{8,200}$/.test(id||''))return null;const a=node('a',text,'button secondary');a.href='https://drive.google.com/open?id='+encodeURIComponent(id);a.target='_blank';a.rel='noopener noreferrer';return a;}
 async function api(action,payload={}){
  if(!owner())throw Error('owner_required');
  RemotePos.assertShift();
  if(RemotePos.session.expires_at-Date.now()<75000)await RemotePos.refreshSession();
  if(!owner())throw Error('owner_required');
  const original=RemotePos.session.user.id;
  const response=await fetch(POS_CLOUD_URL+'/functions/v1/pos-drive-backup',{
   method:'POST',cache:'no-store',headers:{apikey:POS_PUBLISHABLE_KEY,'Content-Type':'application/json',
    Authorization:'Bearer '+RemotePos.session.access_token},body:JSON.stringify({action,...payload})});
  const data=await response.json().catch(()=>({}));
  if(!owner()||RemotePos.session?.user?.id!==original)throw Error('owner_required');
  if(!response.ok)throw Error(data.error||'backup_failed');
  return data;
 }
 function clearProof(result=null){
  const p=proofPending;proofPending=null;
  if($('driveRestoreProofModal')){
   $('driveRestoreProofModal').classList.add('hidden');
   $('driveRestorePassword').value='';$('driveRestoreEmail').value='';$('driveRestoreProofMessage').textContent='';
  }
  p?.resolve(result);
 }
 function clear(){
  epoch++;last=null;requestIds={data:null,both:null};busy=false;refreshing=false;
  $('driveScheduleRows')?.replaceChildren();$('driveBackupHistory')?.replaceChildren();
  $('driveConnectLink')?.replaceChildren();$('driveFolderLink')?.replaceChildren();
  if($('driveConnectionState'))$('driveConnectionState').textContent='נדרש אימות בעלים';
  message('');clearProof();
 }
 function syncVisibility(){
  if(!initialized)return;
  const allowed=owner();
  $('driveBackupSection').classList.toggle('hidden',!allowed);
  if(!allowed){if(visible)clear();visible=false;return;}
  if(!visible){visible=true;loadStatus(true);}
 }
 function rowEditor(row){
  const wrap=node('div',undefined,'drive-schedule-row');
  const grid=node('div',undefined,'drive-schedule-fields');
  const day=node('select',undefined,'field');
  for(let i=0;i<7;i++){const opt=node('option',days[i]);opt.value=String(i);day.append(opt);}day.value=String(row.weekday);
  const time=node('select',undefined,'field');
  for(let i=0;i<1440;i+=15){const opt=node('option',clock(i));opt.value=String(i);time.append(opt);}time.value=String(row.minute_of_day);
  const kind=node('select',undefined,'field');
  for(const [k,t] of [['both','נתונים + נקודת שחזור'],['data','נתונים בלבד']]){const opt=node('option',t);opt.value=k;kind.append(opt);}kind.value=row.kind;
  const enabled=node('input');enabled.type='checkbox';enabled.checked=row.enabled;
  for(const [label,control] of [['יום',day],['שעה (ישראל)',time],['סוג גיבוי',kind]]){
   const l=node('label',label);l.append(control);grid.append(l);
  }
  const active=node('label',undefined,'pos-backup-toggle');active.append(enabled,document.createTextNode(' מועד פעיל'));grid.append(active);
  const actions=node('div',undefined,'pos-backup-actions');
  actions.append(button('שמור מועד',()=>perform(async()=>{
   await api('save_schedule',{schedule:{id:row.id||null,weekday:Number(day.value),minute_of_day:Number(time.value),kind:kind.value,enabled:enabled.checked}});
   message('מועד הגיבוי נשמר.');await loadStatus(true);
  }),'button primary'),button('הסר מועד',()=>{
   if(!row.id){wrap.remove();return;}
   if(!confirm('להסיר מועד זה? קבצי הגיבוי שכבר נוצרו יישמרו.'))return;
   perform(async()=>{await api('delete_schedule',{id:row.id});message('המועד הוסר.');await loadStatus(true);});
  }));
  wrap.append(grid,actions);return wrap;
 }
 function renderJobs(jobs){
  const host=$('driveBackupHistory');host.replaceChildren();
  if(!jobs.length){host.append(node('p','טרם נוצר גיבוי לדרייב.','small-note'));return;}
  const names={queued:'ממתין',running:'מתבצע',retry:'ממתין לניסיון נוסף',succeeded:'אומת ונשמר',failed:'נכשל'};
  const reasons={scheduled:'אוטומטי',manual:'ידני','before-update':'לפני עדכון'};
  for(const job of jobs){
   const card=node('article',undefined,'drive-job');
   card.append(node('strong',when(job.due_at)+' · '+(reasons[job.reason]||job.reason)),
    node('p',(job.kind==='both'?'נתונים + נקודת שחזור':'נתונים בלבד')+' · '+(names[job.status]||job.status),'small-note'));
   if(job.error_code)card.append(node('p',errors[job.error_code]||'ניסיון הגיבוי נכשל.','small-note backup-error'));
   if(job.status==='retry')card.append(node('p','ניסיון הבא: '+when(job.next_at),'small-note'));
   if(job.data_sha256)card.append(node('p','קובץ נתונים: SHA-256 אומת','small-note'));
   if(job.system_sha256)card.append(node('p','נקודת שחזור מערכת: SHA-256 אומת','small-note'));
   const actions=node('div',undefined,'pos-backup-actions');
   if(job.data_sha256&&job.data_file_id){const a=link('פתח קובץ נתונים',job.data_file_id);if(a)actions.append(a);}
   if(job.system_sha256&&job.system_file_id){const a=link('פתח נקודת שחזור',job.system_file_id);if(a)actions.append(a);}
   if(job.status==='succeeded'&&job.data_sha256)actions.append(button('הכן לשחזור נתונים',()=>perform(async()=>{
    if(!confirm('הקובץ ייבדק ויוכן לבחירה במסך השחזור. בשלב זה לא יוחלפו נתונים. להמשיך?'))return;
    const r=await api('prepare_restore',{id:job.id});
    await BackupManager.selectSnapshot(r.snapshotId);
    message('הגיבוי אומת והוכן במסך העותקים השמורים. שחזור דורש אישור ואימות נוסף.');
    $('backupHistorySection').scrollIntoView({behavior:'smooth',block:'start'});
   })));
   if(actions.childNodes.length)card.append(actions);
   host.append(card);
  }
 }
 function render(data,schedules){
  last=data;
  const connected=data.connected===true,configured=data.configured===true;
  $('driveConnectionState').textContent=!configured?'נדרשת הגדרת Google בשרת':connected?'מחובר — בדיקת חיבור ראשונית עברה':'לא מחובר';
  $('driveConnectBtn').disabled=!configured||connected;
  $('driveDisconnectBtn').disabled=!connected;
  $('driveAutoEnabled').checked=data.enabled===true;
  $('driveAutoEnabled').disabled=!connected;
  $('driveAutoSave').disabled=!connected;
  $('driveDataNow').disabled=!connected;
  $('driveSystemNow').disabled=!connected||data.systemReady!==true;
  $('driveSystemStatus').textContent=data.systemReady?'חבילת מערכת מאומתת: V'+data.release?.version:'חבילת מערכת מאומתת טרם הוגדרה; גיבוי מערכת לא יופעל.';
  $('driveFolderLink').replaceChildren();
  if(connected){const a=link('פתח את תיקיית הגיבויים',data.folderId);if(a)$('driveFolderLink').append(a);$('driveConnectLink').replaceChildren();}
  if(schedules){$('driveScheduleRows').replaceChildren();for(const row of data.schedules||[])$('driveScheduleRows').append(rowEditor(row));}
  renderJobs(data.jobs||[]);
  const latest=(data.jobs||[]).find(j=>j.status==='succeeded');
  $('driveLastSuccess').textContent=latest?'גיבוי אחרון שאומת: '+when(latest.completed_at):'טרם אומת גיבוי לדרייב.';
 }
 async function loadStatus(schedules=true){
  if(!owner()||refreshing)return;refreshing=true;const e=epoch;
  try{const result=await api('status');if(e===epoch&&owner())render(result,schedules);}
  catch(error){if(e===epoch&&owner()){message(errText(error),true);if(!last){$('driveConnectionState').textContent='לא ניתן לטעון מצב גיבויים';$('driveConnectBtn').disabled=true;}}}
  finally{if(e===epoch)refreshing=false;}
 }
 async function perform(fn){
  if(busy||!owner())return;busy=true;const e=epoch;
  try{await fn();}
  catch(error){if(e===epoch)message(errText(error),true);}
  finally{if(e===epoch)busy=false;}
 }
 function manual(kind){
  perform(async()=>{
   requestIds[kind]||=crypto.randomUUID();
   const result=await api('manual',{kind,requestId:requestIds[kind]});
   requestIds[kind]=null;
   message('הגיבוי הועבר לתור השרת. הצלחה תופיע רק לאחר אימות הקבצים בדרייב.');
   await loadStatus(false);
  });
 }
 function connect(){
  perform(async()=>{
   const result=await api('connect');
   const u=new URL(result.authorizationUrl);
   if(u.origin!=='https://accounts.google.com'||u.pathname!=='/o/oauth2/v2/auth')throw Error('backup_failed');
   const a=node('a','אשר חיבור בחשבון Google שלך','button primary');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';
   $('driveConnectLink').replaceChildren(a);
   message('פתח את קישור Google בחלון נוסף. לאחר האישור, חזור לכאן ולחץ רענן מצב.');
  });
 }
 function requestRestoreProof(snapshotId,checksum){
  if(!owner()||proofPending)return Promise.resolve(null);
  $('driveRestoreProofModal').classList.remove('hidden');
  $('driveRestoreEmail').value='';$('driveRestorePassword').value='';$('driveRestoreProofMessage').textContent='';
  $('driveRestoreEmail').focus();
  return new Promise(resolve=>{proofPending={snapshotId,checksum,resolve};});
 }
 async function submitProof(event){
  event.preventDefault();const p=proofPending;if(!p||!owner())return clearProof();
  const b=$('driveRestoreProofSubmit');if(b.disabled)return;b.disabled=true;
  $('driveRestoreProofMessage').textContent='מאמת מחדש את בעל המערכת…';
  try{
   const proof=await api('restore_proof',{snapshotId:p.snapshotId,checksum:p.checksum,email:$('driveRestoreEmail').value,password:$('driveRestorePassword').value});
   $('driveRestorePassword').value='';
   if(proofPending===p&&owner())clearProof(proof.proof);
  }catch(error){$('driveRestorePassword').value='';if(proofPending===p)$('driveRestoreProofMessage').textContent=errText(error);}
  finally{b.disabled=false;}
 }
 function init(){
  if(initialized)return;initialized=true;
  $('driveConnectBtn').addEventListener('click',connect);
  $('driveDisconnectBtn').addEventListener('click',()=>perform(async()=>{
   if(!confirm('לנתק את Google Drive ולעצור גיבויים עתידיים? קבצים קיימים לא יימחקו.'))return;
   const r=await api('disconnect');message(r.revoked?'החיבור נותק וההרשאה בוטלה.':'החיבור נותק מהקופה. אם נדרש, בטל את הרשאת האפליקציה בחשבון Google.');
   await loadStatus(true);
  }));
  $('driveRefreshBtn').addEventListener('click',()=>loadStatus(true));
  $('driveDataNow').addEventListener('click',()=>manual('data'));
  $('driveSystemNow').addEventListener('click',()=>manual('both'));
  $('driveAddSchedule').addEventListener('click',()=>{if(owner())$('driveScheduleRows').append(rowEditor({weekday:3,minute_of_day:420,kind:'both',enabled:true}));});
  $('driveAutoSave').addEventListener('click',()=>perform(async()=>{await api('enable',{enabled:$('driveAutoEnabled').checked});message('הגדרת התזמון נשמרה.');await loadStatus(true);}));
  $('driveRestoreProofForm').addEventListener('submit',submitProof);
  $('driveRestoreProofCancel').addEventListener('click',()=>clearProof());
  $('driveRestoreProofModal').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();clearProof();}});
  // Do not overwrite unsaved schedule edits while tracking background jobs.
  setInterval(()=>{if(owner()&&$('systemPage')?.classList.contains('active')&&last?.jobs?.some(j=>['queued','running','retry'].includes(j.status)))loadStatus(false);},15000);
  syncVisibility();
 }
 return {init,syncVisibility,refresh:loadStatus,clear,requestRestoreProof};
})();
