'use strict';
/* V1.0.0 owner-controlled cloud snapshots and scheduled server backup UI. */
const BackupManager=(()=>{
 const $=id=>document.getElementById(id);
 let busy=false;
 const request=(path,body={})=>RemotePos.request('/rest/v1/rpc/'+path,{method:'POST',body});
 function owner(){return RemotePos.active&&RemotePos.authenticated&&RemotePos.employee?.is_owner===true&&RemotePos.employee?.owner_terminal===true;}
 function msg(value,error=false){const x=$('backupManagerMessage');if(!x)return;x.textContent=value;x.classList.toggle('backup-error',error);}
 function saveJson(fileName,payload){
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=fileName;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
 }
 async function loadStatus(){
  if(!owner())return;
  try{
   const data=await request('pos_backup_status_v0945');
   $('backupAutoEnabled').checked=!!data.enabled;
   $('backupAutoFrequency').value=data.frequency||'daily';
   $('backupAutoHour').value=String(data.hour??3);
   $('backupAutoWeekday').value=String(data.weekday??0);
   $('backupAutoWeekdayLabel').classList.toggle('hidden',data.frequency!=='weekly');
   const list=$('backupSnapshotSelect'),old=list.value;list.replaceChildren();
   const snapshots=Array.isArray(data.snapshots)?data.snapshots:[];
   for(const row of snapshots){
    const opt=document.createElement('option');opt.value=row.id;
    opt.textContent=new Date(row.createdAt).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'})+
      ' · '+(({scheduled:'אוטומטי',manual:'ידני','drive-scheduled':'Drive אוטומטי','drive-manual':'Drive ידני','drive-before-update':'Drive לפני עדכון','drive-import':'ייבוא מ־Drive'})[row.reason]||'גיבוי לפני פעולה')+
      ' · '+row.items+' שורות';
    list.append(opt);
   }
   if(snapshots.some(x=>x.id===old))list.value=old;
   $('backupSnapshotDownloadBtn').disabled=!snapshots.length;
   const latest=snapshots[0];
   $('backupLastSummary').textContent=latest?'גיבוי אחרון: '+new Date(latest.createdAt).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'})+
    ' · '+latest.items+' שורות':'טרם נשמר גיבוי';
  }catch(e){msg('טעינת מצב הגיבוי נכשלה: '+e.message,true);}
 }
 async function downloadSnapshot(id){
  if(!id)throw new Error('לא נבחר גיבוי');
  const snapshot=await request('pos_backup_download_v0945',{p_id:id});
  if(snapshot?.format!=='manara-cloud-snapshot-v1')throw new Error('תוכן הגיבוי אינו תקין');
  saveJson('Manara_POS_Cloud_'+new Date().toISOString().replaceAll(':','-').slice(0,19)+'.json',snapshot);
 }
 async function immediate(){
  if(busy||!owner())return;busy=true;
  $('backupImmediateBtn').disabled=true;
  try{
   msg('יוצר גיבוי בשרת ומכין קובץ להורדה…');
   const id=await request('pos_backup_create_v0945');
   await downloadSnapshot(id);
   msg('גיבוי נוצר והורדת הקובץ הופעלה. ודא שהקובץ נמצא בתיקיית ההורדות.');
   await loadStatus();
  }catch(e){msg('יצירת הגיבוי נכשלה: '+e.message,true);}
  finally{busy=false;$('backupImmediateBtn').disabled=false;}
 }
 async function selected(){
  if(busy||!owner())return;busy=true;$('backupSnapshotDownloadBtn').disabled=true;
  try{
   msg('מכין עותק שמור…');await downloadSnapshot($('backupSnapshotSelect').value);
   msg('הורדת העותק השמור הופעלה.');
  }catch(e){msg(e.message,true);}
  finally{busy=false;$('backupSnapshotDownloadBtn').disabled=false;}
 }
 async function schedule(e){
  e.preventDefault();if(busy||!owner())return;busy=true;$('backupScheduleSaveBtn').disabled=true;
  try{
   msg('שומר את תזמון הגיבוי בשרת…');
   await request('pos_backup_schedule_v0945',{
    p_enabled:$('backupAutoEnabled').checked,
    p_frequency:$('backupAutoFrequency').value,
    p_hour:Number($('backupAutoHour').value),
    p_weekday:Number($('backupAutoWeekday').value)
   });
   msg('תזמון הגיבוי נשמר. בדיקת השרת רצה חמש דקות אחרי תחילת השעה לפי שעון ישראל.');
   await loadStatus();
  }catch(e){msg('שמירת התזמון נכשלה: '+e.message,true);}
  finally{busy=false;$('backupScheduleSaveBtn').disabled=false;}
 }
 async function restoreSelected(){
  if(busy||!owner())return;
  const id=$('backupSnapshotSelect').value;
  if(!id){msg('יש לבחור עותק לשחזור',true);return;}
  busy=true;$('backupRestoreSnapshotBtn').disabled=true;
  try{
   const preview=await request('pos_backup_restore_preview_v0945',{p_id:id});
   const time=new Date(preview.createdAt).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'});
   if(!confirm('שחזור מלא של העסקאות למצב מתאריך '+time+'!\n'+
    'כרגע: '+preview.currentTransactions+' עסקאות ו-'+preview.currentItems+' שורות.\n'+
    'בעותק: '+preview.transactionCount+' עסקאות ו-'+preview.itemCount+' שורות.\n'+
    'כל חיוב ועריכת ארכיון שנעשו מאז העותק יוחלפו.\n'+
    'הקופה תיצור גיבוי חדש לפני השחזור. האם להמשיך?'))return;
   const phrase=prompt('כדי לשחזר, הקלד בדיוק: אני מאשר שחזור מלא');
   if(phrase!=='אני מאשר שחזור מלא'){msg('השחזור בוטל. לא שונו נתונים.');return;}
   if(!confirm('אישור סופי: האם כל הקופות הפסיקו לבצע חיובים? להתחיל שחזור כעת?'))return;
   msg('משחזר באופן מבוקר בשרת. אין לרענן את הדף…');
   const proof=await DriveBackup.requestRestoreProof(id,preview.checksum);
   if(!proof||!owner()){msg('השחזור בוטל. לא שונו נתונים.');return;}
   const result=await request('pos_backup_restore_v2017',{
    p_id:id,p_checksum:preview.checksum,p_confirmation:phrase,p_proof:proof
   });
   if(!result?.restored)throw new Error('תוצאת שחזור לא תקינה');
   await RemotePos.loadAll();
   await refresh({fromRemote:true});
   renderPermissions();
   await refreshBackupAfterRestore();
   msg('השחזור הושלם: '+result.transactions+' עסקאות ו-'+result.items+' שורות. גיבוי המצב הקודם נשמר לפני השחזור.');
  }catch(e){msg('לא ניתן לאשר שהשחזור הושלם: '+e.message+' — בדוק את הארכיון לפני ניסיון נוסף.',true);}
  finally{busy=false;$('backupRestoreSnapshotBtn').disabled=false;}
 }
 async function refreshBackupAfterRestore(){await loadStatus();}
 function init(){
  $('backupImmediateBtn').addEventListener('click',immediate);
  $('backupSnapshotDownloadBtn').addEventListener('click',selected);
  $('backupRefreshBtn').addEventListener('click',loadStatus);
  $('backupScheduleForm').addEventListener('submit',schedule);
  $('backupAutoFrequency').addEventListener('change',()=>$('backupAutoWeekdayLabel').classList.toggle('hidden',$('backupAutoFrequency').value!=='weekly'));
  $('backupArchiveManageBtn').addEventListener('click',()=>{$('archiveManageBtn').click();});
  $('backupRestoreSnapshotBtn').addEventListener('click',restoreSelected);
 }
 async function selectSnapshot(id){
  if(!owner())throw Error('נדרש אימות בעלים');
  await loadStatus();
  const list=$('backupSnapshotSelect');
  if(![...list.options].some(o=>o.value===id))throw Error('לא ניתן לאתר את העותק שהוכן');
  list.value=id;
 }
 return{init,refresh:loadStatus,selectSnapshot};
})();
