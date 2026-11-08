'use strict';
/* V0.6 — updater: no refresh during an open transaction */
const softwareUpdate={registration:null,info:null,checking:false,applying:false};
const versionSegments=v=>String(v||'').replace(/^v/i,'').split('.').map(x=>parseInt(x,10)||0);
function isNewerVersion(remote,local=APP_VERSION){const a=versionSegments(remote),b=versionSegments(local);for(let i=0;i<Math.max(a.length,b.length);i++){const diff=(a[i]||0)-(b[i]||0);if(diff)return diff>0;}return false;}
function updateStatus(message){el('updateStatus').textContent=message;}
function updateUiFromInfo(info){softwareUpdate.info=info;el('updateBadgeVersion').textContent='V'+info.version;el('updateBadge').classList.remove('hidden');updateStatus('זמינה גרסה V'+info.version+' · קוד טעון V'+APP_VERSION);}
function showUpdateDialog(){if(!softwareUpdate.info)return;const info=softwareUpdate.info;el('updateDialogVersion').textContent='PUB Manara POS Web · V'+info.version;const changes=el('updateChanges');changes.replaceChildren();for(const change of (Array.isArray(info.changes)?info.changes:[])){const li=document.createElement('li');li.textContent=String(change);changes.append(li);}if(!changes.children.length){const li=document.createElement('li');li.textContent='שיפורי תוכנה ותיקוני יציבות';changes.append(li);}el('updateModalMessage').textContent=state.cart.length?'יש חיוב פתוח — סיים או נקה אותו לפני העדכון.':'';el('applyUpdateBtn').disabled=!!state.cart.length||state.busy;el('updateDialog').classList.remove('hidden');}
function hideUpdateDialog(){if(!softwareUpdate.applying)el('updateDialog').classList.add('hidden');}
async function checkSoftwareUpdates(manual=false){
 if(softwareUpdate.checking)return;softwareUpdate.checking=true;
 try{
  if(!navigator.onLine){if(manual)updateStatus('אין אינטרנט — הקופה ממשיכה לפעול כרגיל');return;}
  if(manual)updateStatus('בודק עדכונים…');
  const registration=softwareUpdate.registration||await navigator.serviceWorker.ready;
  softwareUpdate.registration=registration;
  const url=new URL('./version.json',location.href);url.searchParams.set('t',Date.now().toString());
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok)throw new Error('version.json לא זמין');
  const info=await response.json();
  if(!info||!/^\d+(\.\d+)*$/.test(String(info.version)))throw new Error('גרסה לא תקינה');
  if(isNewerVersion(info.version)){updateUiFromInfo(info);await registration.update();}
  else{softwareUpdate.info=null;el('updateBadge').classList.add('hidden');updateStatus('מעודכן — קוד טעון V'+APP_VERSION);}
 }catch(e){if(manual)updateStatus('לא ניתן לבדוק כרגע — '+e.message);}
 finally{softwareUpdate.checking=false;}
}
async function setupSoftwareUpdater(){
 const registration=await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
 softwareUpdate.registration=registration;
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(softwareUpdate.applying&&state.cart.length===0&&!state.busy)location.reload();});
 window.addEventListener('online',()=>checkSoftwareUpdates(false));
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSoftwareUpdates(false);});
 await checkSoftwareUpdates(false);
}
async function applySoftwareUpdate(){
 if(state.cart.length||state.busy){el('updateModalMessage').textContent='יש לסיים או לנקות את החיוב הפתוח לפני עדכון.';el('applyUpdateBtn').disabled=true;return;}
 if(softwareUpdate.applying)return;
 softwareUpdate.applying=true;el('applyUpdateBtn').disabled=true;el('laterUpdateBtn').disabled=true;
 el('updateModalMessage').textContent='מכין את העדכון…';
 try{
  const r=softwareUpdate.registration||await navigator.serviceWorker.ready;
  await r.update();
  let waiting=r.waiting;
  if(!waiting){waiting=await new Promise(resolve=>{const timeout=setTimeout(()=>resolve(null),12000);function ready(){if(r.waiting){clearTimeout(timeout);resolve(r.waiting);}}function listen(worker){if(worker)worker.addEventListener('statechange',ready);}listen(r.installing);r.addEventListener('updatefound',()=>{listen(r.installing);ready();},{once:true});ready();});}
  if(!waiting){
    // A worker may already have activated while we were waiting. Attempt one safe
    // cache-busting navigation before reporting a stalled installation.
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
  setTimeout(()=>{if(softwareUpdate.applying&&state.cart.length===0&&!state.busy)location.reload();},3500);
 }catch(e){softwareUpdate.applying=false;el('applyUpdateBtn').disabled=false;el('laterUpdateBtn').disabled=false;el('updateModalMessage').textContent=e.message;updateStatus('שגיאה בעדכון — נתוני הקופה לא שונו');}
}
