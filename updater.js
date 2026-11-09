'use strict';
/* V1.0.5 mandatory updates: fail closed, preserve in-progress transactions. */
const softwareUpdate={registration:null,info:null,checking:false,applying:false,verified:false,pendingForCart:false,checkPromise:null,initialized:false};
const versionSegments=v=>String(v||'').replace(/^v/i,'').split('.').map(x=>parseInt(x,10)||0);
function isNewerVersion(remote,local=APP_VERSION){
 const a=versionSegments(remote),b=versionSegments(local);
 for(let i=0;i<Math.max(a.length,b.length);i++){const diff=(a[i]||0)-(b[i]||0);if(diff)return diff>0;}
 return false;
}
function updateStatus(message){el('updateStatus').textContent=message;}
function transactionStillOpen(){return Boolean(state.busy||state.cart.length||state.pendingOperation);}
function blockForUpdate(message){
 softwareUpdate.verified=false;
 el('updateDialog').classList.remove('hidden');
 el('updateDialogTitle').textContent='נדרשת בדיקת גרסה';
 el('updateDialogVersion').textContent='הקופה נעולה עד לאימות הגרסה';
 el('updateChanges').replaceChildren();
 el('updateModalMessage').textContent=message;
 el('applyUpdateBtn').classList.add('hidden');
 el('updateRetryBtn').classList.remove('hidden');
 el('updateRetryBtn').disabled=false;
 el('laterUpdateBtn').classList.add('hidden');
}
function updateUiFromInfo(info){
 softwareUpdate.info=info;
 el('updateBadgeVersion').textContent='V'+info.version;
 el('updateBadge').classList.remove('hidden');
 updateStatus('עדכון חובה V'+info.version+' · קוד טעון V'+APP_VERSION);
}
function showUpdateDialog(){
 if(!softwareUpdate.info){blockForUpdate('יש לאמת את הגרסה כדי להמשיך.');return;}
 const info=softwareUpdate.info;
 el('updateDialogTitle').textContent='עדכון תוכנה חובה';
 el('updateDialogVersion').textContent='PUB Manara POS Web · V'+info.version;
 const changes=el('updateChanges');changes.replaceChildren();
 for(const change of (Array.isArray(info.changes)?info.changes:[])){
  const li=document.createElement('li');li.textContent=String(change);changes.append(li);
 }
 if(!changes.children.length){const li=document.createElement('li');li.textContent='שיפורים ועדכוני מערכת';changes.append(li);}
 el('applyUpdateBtn').classList.remove('hidden');
 el('updateRetryBtn').classList.add('hidden');
 el('laterUpdateBtn').classList.add('hidden');
 el('updateModalMessage').textContent='יש להתקין את העדכון כדי להמשיך לעבוד בקופה.';
 el('applyUpdateBtn').disabled=transactionStillOpen();
 el('updateDialog').classList.remove('hidden');
}
function hideUpdateDialog(){if(softwareUpdate.verified&&!softwareUpdate.applying)el('updateDialog').classList.add('hidden');}
function settlePendingMandatoryUpdate(){
 if(softwareUpdate.pendingForCart&&!transactionStillOpen()){
  softwareUpdate.pendingForCart=false;
  softwareUpdate.verified=false;
  if(softwareUpdate.info)showUpdateDialog();
  else blockForUpdate('לא ניתן לאמת את הגרסה. בדוק חיבור ונסה שוב.');
 }
}
async function getLiveVersion(){
 if(!navigator.onLine)throw new Error('אין חיבור לאינטרנט');
 const url=new URL('./version.json',location.href);url.searchParams.set('t',String(Date.now()));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await fetch(url,{cache:'no-store',signal:controller.signal});
  if(!response.ok)throw new Error('שרת הגרסאות אינו זמין');
  const info=await response.json();
  if(!info||!/^\\d+(\\.\\d+)*$/.test(String(info.version)))throw new Error('מספר גרסה לא תקין');
  return info;
 }finally{clearTimeout(timer);}
}
async function checkSoftwareUpdates(manual=false){
 if(softwareUpdate.checkPromise)return softwareUpdate.checkPromise;
 softwareUpdate.checking=true;
 const deferred=transactionStillOpen();
 if(!deferred&&!softwareUpdate.applying){
  softwareUpdate.verified=false;
  blockForUpdate('בודק את הגרסה העדכנית בשרת…');
  el('updateRetryBtn').disabled=true;
 }
 softwareUpdate.checkPromise=(async()=>{
  try{
   const info=await getLiveVersion();
   if(isNewerVersion(info.version)){
    updateUiFromInfo(info);
    if(deferred||transactionStillOpen()){
     softwareUpdate.pendingForCart=true;
     updateStatus('עדכון חובה ממתין לסיום החיוב הפתוח');
    }else{
     softwareUpdate.pendingForCart=false;
     softwareUpdate.verified=false;
     showUpdateDialog();
    }
    try{await softwareUpdate.registration?.update();}catch(e){console.warn('Worker update retry pending:',e);}
    return 'update';
   }
   softwareUpdate.info=null;softwareUpdate.pendingForCart=false;softwareUpdate.verified=true;
   el('updateBadge').classList.add('hidden');
   updateStatus('מעודכן — קוד טעון V'+APP_VERSION);
   el('updateDialog').classList.add('hidden');
   return 'current';
  }catch(error){
   console.warn('Version verification failed:',error);
   updateStatus('בדיקת גרסה נכשלה: '+error.message);
   if(deferred||transactionStillOpen()){
    softwareUpdate.info=null;
    softwareUpdate.pendingForCart=true;
    updateStatus('נדרשת בדיקת גרסה לאחר סיום החיוב');
   }else{
    blockForUpdate('בדיקת הגרסה נכשלה: '+error.message+'. בדוק אינטרנט ונסה שוב.');
   }
   return 'error';
  }finally{softwareUpdate.checking=false;softwareUpdate.checkPromise=null;}
 })();
 return softwareUpdate.checkPromise;
}
async function setupSoftwareUpdater(){
 if(softwareUpdate.initialized)return checkSoftwareUpdates();
 if(!('serviceWorker' in navigator)){
  blockForUpdate('הדפדפן אינו תומך במנגנון העדכונים. יש לפתוח בדפדפן נתמך.');
  return 'error';
 }
 try{
  softwareUpdate.registration=await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
  softwareUpdate.initialized=true;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
   if(softwareUpdate.applying&&!transactionStillOpen())location.reload();
  });
  window.addEventListener('online',()=>checkSoftwareUpdates());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSoftwareUpdates();});
  setInterval(settlePendingMandatoryUpdate,400);
  return await checkSoftwareUpdates();
 }catch(error){
  blockForUpdate('לא ניתן להפעיל את העדכונים: '+error.message+'. נסה שוב.');
  return 'error';
 }
}
async function retryMandatoryVersionCheck(){
 el('updateRetryBtn').disabled=true;
 try{return softwareUpdate.initialized?await checkSoftwareUpdates(true):await setupSoftwareUpdater();}
 finally{el('updateRetryBtn').disabled=false;}
}
async function applySoftwareUpdate(){
 if(transactionStillOpen()){
  el('updateModalMessage').textContent='יש לסיים או לנקות את החיוב הפתוח לפני העדכון.';
  el('applyUpdateBtn').disabled=true;return;
 }
 if(softwareUpdate.applying)return;
 softwareUpdate.verified=false;softwareUpdate.applying=true;
 el('applyUpdateBtn').disabled=true;
 el('updateModalMessage').textContent='מכין את העדכון…';
 try{
  const r=softwareUpdate.registration;
  if(!r)throw new Error('שירות העדכונים לא הופעל');
  await r.update();
  let waiting=r.waiting;
  if(!waiting){
   waiting=await new Promise(resolve=>{
    const timeout=setTimeout(()=>resolve(null),14000);
    function ready(){if(r.waiting){clearTimeout(timeout);resolve(r.waiting);}}
    function listen(worker){if(worker)worker.addEventListener('statechange',ready);}
    listen(r.installing);
    r.addEventListener('updatefound',()=>{listen(r.installing);ready();},{once:true});
    ready();
   });
  }
  if(!waiting){
   const next=softwareUpdate.info?.version||'unknown';
   const recoveryKey='manara-pos-update-retry-'+next;
   if(sessionStorage.getItem(recoveryKey)!=='done'){
    sessionStorage.setItem(recoveryKey,'done');
    el('updateModalMessage').textContent='בודק אם הגרסה החדשה כבר הופעלה…';
    const recovery=new URL('./index.html',location.href);
    recovery.searchParams.set('refresh',next);
    location.replace(recovery.toString());
    return;
   }
   throw new Error('העדכון עדיין לא מוכן. ודא שאתה מחובר לאינטרנט ונסה שוב.');
  }
  el('updateModalMessage').textContent='מפעיל את הגרסה החדשה…';
  waiting.postMessage({type:'SKIP_WAITING'});
  setTimeout(()=>{if(softwareUpdate.applying&&!transactionStillOpen())location.reload();},3500);
 }catch(error){
  softwareUpdate.applying=false;softwareUpdate.verified=false;
  el('applyUpdateBtn').disabled=false;
  el('updateModalMessage').textContent='העדכון נכשל: '+error.message+'. נסה שוב.';
  updateStatus('שגיאה בעדכון — נתוני הקופה לא שונו');
 }
}
