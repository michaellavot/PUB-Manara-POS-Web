'use strict';
/* V0.9.45 owner-controlled cloud snapshots and scheduled server backup UI. */
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
 async function refresh(){
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
      ' · '+(row.reason==='scheduled'?'אוטומטי':row.reason==='manual'?'ידני':'גיבוי לפני פעולה')+
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
   await refresh();
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
   await refresh();
  }catch(e){msg('שמירת התזמון נכשלה: '+e.message,true);}
  finally{busy=false;$('backupScheduleSaveBtn').disabled=false;}
 }
 function init(){
  $('backupImmediateBtn').addEventListener('click',immediate);
  $('backupSnapshotDownloadBtn').addEventListener('click',selected);
  $('backupRefreshBtn').addEventListener('click',refresh);
  $('backupScheduleForm').addEventListener('submit',schedule);
  $('backupAutoFrequency').addEventListener('change',()=>$('backupAutoWeekdayLabel').classList.toggle('hidden',$('backupAutoFrequency').value!=='weekly'));
  $('backupArchiveManageBtn').addEventListener('click',()=>{$('archiveManageBtn').click();});
  $('backupRestoreHelpBtn').addEventListener('click',()=>{
   alert('ניתן להוריד כל עותק שמור, והוא מכיל את הנתונים הדרושים לשחזור. שחזור מלא לענן דורש פעולה מאומתת של בעל החשבון; לא מבצעים דריסה אוטומטית של עסקאות פעילות כדי למנוע אובדן מידע. שמור את קובץ הגיבוי לצורך שחזור מבוקר.');
  });
 }
 return{init,refresh};
})();
