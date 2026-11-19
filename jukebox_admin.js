'use strict';
/* Owner-only POS jukebox. No real charges or code issuance from this client. */
const JukeboxAdmin=(()=>{
 const $=id=>document.getElementById(id);
 const URL='https://srudevbrupqaemgrrhcg.supabase.co/functions/v1/jukebox-pos-owner';
 const KEY='sb_publishable_c4yDW12R7D3SZej11VNPpg_ZI_CiHC-';
 const errors={owner_required:'נדרש אימות בעלים מחדש בקופה.',owner_or_action_denied:'הפעולה אינה זמינה או אינה מורשית.',action_disabled:'הפעולה אינה זמינה.',invalid_payload:'הפרטים אינם תקינים.',jukebox_operation_failed:'פעולת הג׳וקבוקס נכשלה. נסה שוב.',jukebox_unavailable:'שרת הג׳וקבוקס אינו זמין כרגע.'};
 const labels={queued:'בתור',playing:'מתנגן',held:'מושהה',failed:'נכשל',completed:'הושלם',verified:'נוגן ואומת',cancelled:'בוטל',pending_approval:'דורש בדיקה · ללא חיוב',expired:'פג תוקף',active:'ממתין לבחירת שיר'};
 let initialized=false,epoch=0,busy=false,controller=null,snapshot=null,settingsDirty=false,pairTimer=null,opened=false,systemSettingsSession=false,quickSaleSession=false,searchGeneration=0,selectedCustomer=null,employeePerson='',apiKey='',advancedOpen=false,snapshotAt=0,queueTimes=new Map(),recoveredId=null,pendingSale=null,keyConfigured=false,keyImportPending=false,saleNotice='',issuedCode=null,polling=false,mutation=0,selectedQueueKey=null,queueSignature='',deviceSignature='',settingsSignature='',requests=new Set();
 function allowed(){const u=RemotePos.employee||{};return RemotePos.active===true&&RemotePos.authenticated===true&&u.active===true&&u.is_owner===true&&u.owner_terminal===true&&u.pin_login===true&&Number(RemotePos.session?.pos_valid_until)>Date.now();}
 const onPage=()=>opened&&allowed()&&($('jukeboxPage')?.classList.contains('active')||(systemSettingsSession&&$('systemPage')?.classList.contains('active'))||(quickSaleSession&&$('posPage')?.classList.contains('active')&&$('jukeboxSaleDialog')?.open));
 function node(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=String(text);if(cls)x.className=cls;return x;}
 function button(text,fn,kind='secondary',label=''){const b=node('button',text,'button '+kind);b.type='button';b.dataset.jbAction='';b.disabled=busy;if(label){b.setAttribute('aria-label',label);b.title=label;}b.addEventListener('click',fn);return b;}
 function message(t,error=false){const el=$('jukeboxMessage');const value=error?t:'';if(el.textContent!==value)el.textContent=value;const cls='status jukebox-message '+(error?'error':'');if(el.className!==cls)el.className=cls;const quick=$('jukeboxQuickMessage');if(quick){quick.textContent=value;quick.classList.toggle('hidden',!value);quick.classList.toggle('error',!!value);}}
 function connection(available){
  const el=$('jukeboxConnection'),next=available===true?'online':available===false?'offline':'checking';
  if(el.dataset.state===next)return;
  el.dataset.state=next;
  const label=next==='online'?'הטאבלט מחובר ומדווח פעילות':next==='offline'?'טאבלט הג׳וקבוקס אינו מחובר':'בודק את חיבור הג׳וקבוקס';
  el.title=label;el.setAttribute('aria-label',label);
 }
 let searchTimer=null,searchAbort=null,searchCache=new Map(),confirmResolve=null;
 function ask(title,description,track=null,danger=false){if(!onPage()||confirmResolve)return Promise.resolve(false);const d=$('jukeboxConfirmDialog');$('jukeboxConfirmTitle').textContent=title;$('jukeboxConfirmText').textContent=description;$('jukeboxConfirmTrack').classList.toggle('hidden',!track);$('jukeboxConfirmTrackTitle').textContent=track?.title||'';$('jukeboxConfirmTrackMeta').textContent=track?[track.channel,track.duration?fmt(track.duration):''].filter(Boolean).join(' · '):'';const img=$('jukeboxConfirmImage');if(track?.thumbnail){img.src=track.thumbnail;img.classList.remove('hidden');}else{img.removeAttribute('src');img.classList.add('hidden');}$('jukeboxConfirmYes').classList.toggle('warning',danger);$('jukeboxConfirmYes').classList.toggle('primary',!danger);d.returnValue='cancel';return new Promise(resolve=>{confirmResolve=resolve;d.showModal();});}
 function finishConfirm(){const d=$('jukeboxConfirmDialog'),resolve=confirmResolve;confirmResolve=null;if(resolve)resolve(d.returnValue==='yes'&&onPage());}
 function stopSearch(){clearTimeout(searchTimer);searchAbort?.abort();searchAbort=null;searchGeneration++;}
 function go(id){document.querySelector('.tab[data-page="'+id+'"]')?.click();}
 function keyStatus(){return keyImportPending?'ממתין לייבוא מהמכשיר המצומד.':keyConfigured?'מפתח מוגדר בענן · משותף לקופה ולטאבלט':'לא הוגדר מפתח בענן. אפשר לייבא מהטאבלט או להזין מפתח.';}
 function setAdvanced(open){advancedOpen=!!open;const d=$('jukeboxAdvanced');if(open&&!d.open)d.showModal();else if(!open&&d.open)d.close();$('jukeboxSystemSettingsOpen').setAttribute('aria-expanded',String(advancedOpen));if(open)$('jukeboxKeyStatus').textContent=keyStatus();}
 const pendingKey=()=> 'manara-jukebox-pending-v2025:'+String(RemotePos.session?.user?.id||'');
 function savePending(p){if(p){localStorage.setItem(pendingKey(),JSON.stringify(p));pendingSale=p;}else{localStorage.removeItem(pendingKey());pendingSale=null;}renderSale();}
 function loadPending(){try{pendingSale=JSON.parse(localStorage.getItem(pendingKey())||'null');}catch{pendingSale=null;}}
 function showIssued(r){issuedCode=r;$('jukeboxIssuedValue').textContent=r.code;$('jukeboxIssuedExpiry').textContent='תקף עד '+new Date(r.expires_at).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})+(r.is_test?' · D':'');$('jukeboxIssuedCode').classList.remove('hidden');}
 function resetIssued(){issuedCode=null;$('jukeboxIssuedValue').textContent='';$('jukeboxIssuedExpiry').textContent='';$('jukeboxIssuedCode').classList.add('hidden');}
 function renderSale(){const settings=snapshot?.settings||{},paired=(snapshot?.devices||[]).some(d=>!d.revoked_at),price=Number(settings.price),maintenance=Date.parse(settings.maintenance_until||'')>Date.now(),synced=maintenance===(RemotePos.testMode===true);const enabled=synced&&settings.enabled&&settings.is_open&&paired&&settings.price!=null&&Number.isFinite(price);$('jukeboxSaleConfirm').disabled=busy||!snapshot||(!pendingSale&&(!selectedCustomer||!enabled));$('jukeboxSaleConfirm').textContent=pendingSale?'נסה שוב לקבל את אותו קוד':'צור קוד לשיר · חיוב לאחר ניגון';$('jukeboxAbandonSale').classList.toggle('hidden',!pendingSale);$('jukeboxAbandonSale').disabled=busy;$('jukeboxSaleNotice').textContent=saleNotice||(pendingSale?'הזמנה ממתינה. ניסיון חוזר משתמש באותו מזהה ולא יוצר חיוב כפול.':(!synced?'מצב תחזוקה בקופה ובג׳וקבוקס אינו מסונכרן. הנפקת קודים חסומה.':(maintenance?'מצב תחזוקה D · קודי בדיקה בלבד · ללא חיובי אמת. ':'')+(enabled?'חיוב רק לאחר ניגון מאומת.':'הפעל את הג׳וקבוקס, פתח הזמנות וצמד טאבלט.')));const notice=$('jukeboxSaleNotice');notice.classList.toggle('hidden',!saleNotice&&!pendingSale&&synced&&!maintenance&&enabled);}
 async function issueSale(){if(!onPage()||busy||$('jukeboxSaleConfirm').disabled)return;const settings=snapshot?.settings||{};let p=pendingSale;if(!p){if(!selectedCustomer)return;const customer=selectedCustomer,person=employeePerson,price=Number(settings.price),isTest=RemotePos.testMode===true;if(!await ask('אישור הנפקת קוד','להפיק קוד עבור '+customer.name+' במחיר '+price.toFixed(2)+' ₪? החיוב יירשם רק לאחר ניגון.'))return;if(!onPage()||busy||pendingSale||selectedCustomer?.id!==customer.id||employeePerson!==person||Number(snapshot?.settings?.price)!==price||(RemotePos.testMode===true)!==isTest)return;p={id:crypto.randomUUID(),customer_id:customer.id,person:person||null,device_id:getDeviceId(),is_test:isTest,price};try{savePending(p);}catch{saleNotice='לא ניתן לשמור מזהה הזמנה במכשיר. הפעולה לא נשלחה.';renderSale();return;}}
  const e=epoch;setBusy(true);saleNotice='מפיק קוד…';renderSale();try{
   await RemotePos.request('/rest/v1/rpc/pos_jukebox_prepare_v2025',{method:'POST',body:{p_operation_id:p.id,p_customer_id:p.customer_id,p_person:p.person,p_device_id:p.device_id,p_is_test:p.is_test,p_maintenance_token:p.is_test?RemotePos.maintenanceToken():null,p_price:p.price}});
   const result=await RemotePos.request('/rest/v1/rpc/pos_jukebox_issue_v2025',{method:'POST',body:{p_operation_id:p.id}});
   if(e!==epoch||!onPage())return;if(!result?.ok||!/^\d{4}$/.test(result.code||''))throw Error('code unavailable');savePending(null);showIssued(result);saleNotice='הקוד הופק. לא נרשם חיוב עדיין.';const snap=await api('snapshot');if(e===epoch&&onPage())render(snap);
  }catch(err){if(e===epoch&&onPage()){saleNotice='הקוד טרם התקבל. נסה שוב באותה הזמנה או בטל אותה. '+String(err?.message||'').slice(0,180);}}finally{if(e===epoch){setBusy(false);renderSale();}}}
 async function abandonSale(){if(!onPage()||busy||!pendingSale)return;const p=pendingSale;if(!await ask('ביטול הזמנה','לבטל את ההזמנה הממתינה?',null,true)||!onPage()||busy||pendingSale?.id!==p.id)return;const e=epoch;setBusy(true);try{const r=await RemotePos.request('/rest/v1/rpc/pos_jukebox_abandon_v2025',{method:'POST',body:{p_operation_id:p.id}});if(e!==epoch)return;savePending(null);saleNotice=r?.status==='settled'?'השיר כבר נוגן והחיוב נרשם.':'ההזמנה בוטלה.';const snap=await api('snapshot');if(onPage())render(snap);}catch{if(e===epoch)saleNotice='לא ניתן לאשר ביטול. נסה שוב.';}finally{if(e===epoch){setBusy(false);renderSale();}}}
 function closeCustomer(){ $('jukeboxCustomerResults').classList.add('hidden');$('jukeboxCustomerSearch').setAttribute('aria-expanded','false'); }
 function setCustomer(c,person=''){selectedCustomer=c||null;employeePerson=person;$('jukeboxCustomerSearch').value=c?.name||'';$('jukeboxSaleCustomer').textContent=person?'חשבון עובד: '+(c?.name||'')+' · '+person:c?'לקוח: '+c.name:'לא נבחר לקוח';$('jukeboxEmployeeCharge').classList.toggle('active',!!person);$('jukeboxEmployeeCharge').textContent=person?'עבור '+person+' ✎':'חיוב על עובד';closeCustomer();saleNotice='';resetIssued();renderSale();}
 function renderCustomerChoices(){if(!onPage())return;const host=$('jukeboxCustomerResults'),q=norm($('jukeboxCustomerSearch').value);host.replaceChildren();for(const c of (state.customers||[]).filter(c=>c.active&&customerNameMatches(c.name,q)).slice(0,100)){const b=node('button',c.name,'desktop-customer-option');b.type='button';b.setAttribute('role','option');b.setAttribute('aria-selected',String(selectedCustomer?.id===c.id));b.addEventListener('click',()=>setCustomer(c));host.append(b);}if(!host.children.length)host.append(node('div','לא נמצאו לקוחות','desktop-customer-empty'));host.classList.remove('hidden');$('jukeboxCustomerSearch').setAttribute('aria-expanded','true');}
 function clearPair(){clearTimeout(pairTimer);pairTimer=null;$('jukeboxPairToken').value='';$('jukeboxPairBox').classList.add('hidden');}
 function clearRecovery(){recoveredId=null;$('jukeboxRecoveredValue').textContent='';$('jukeboxRecoveredExpiry').textContent='';$('jukeboxRecoveredCode').classList.add('hidden');}
 function clear(){epoch++;opened=false;systemSettingsSession=false;quickSaleSession=false;if($('jukeboxSaleDialog').open)$('jukeboxSaleDialog').close();stopSearch();searchCache.clear();if($('jukeboxConfirmDialog').open)$('jukeboxConfirmDialog').close('cancel');for(const req of requests)req.abort();requests.clear();controller=null;polling=false;mutation++;queueSignature='';deviceSignature='';settingsSignature='';selectedQueueKey=null;snapshot=null;settingsDirty=false;pendingSale=null;keyConfigured=false;keyImportPending=false;saleNotice='';setCustomer(null);setAdvanced(false);apiKey='';clearPair();clearRecovery();for(const id of ['jukeboxQueueDialog','jukeboxEmployeeDialog'])if($(id).open)$(id).close();for(const id of ['jukeboxQueueList','jukeboxQueueDetails','jukeboxQueueActions','jukeboxDevices','jukeboxSearchResults'])$(id).replaceChildren();$('jukeboxSearchQuery').value='';$('jukeboxSearchStatus').textContent='';$('jukeboxSearchKey').value='';$('jukeboxEmployeePerson').value='';$('jukeboxQueueNotice').textContent='';$('jukeboxContent').classList.add('hidden');$('jukeboxSettingsForm').reset();queueTimes.clear();message('');setBusy(false);}
 let indicatorBusy=false,lastIndicatorRequest=0;
 async function refreshRecordIndicator(force=false){
  if(!initialized||!allowed()){connection(null);return;}
  // Management view already polls the authenticated live snapshot.
  if(onPage()&&snapshot)return;
  const now=Date.now();
  if(indicatorBusy||(!force&&now-lastIndicatorRequest<15000))return;
  lastIndicatorRequest=now;indicatorBusy=true;
  const userId=RemotePos.session?.user?.id;
  let timeout=null;
  try{
   RemotePos.assertShift();
   if(RemotePos.session?.expires_at-Date.now()<75000)await RemotePos.refreshSession();
   if(!allowed()||RemotePos.session?.user?.id!==userId)return;
   const abort=new AbortController();
   timeout=setTimeout(()=>abort.abort(),12000);
   const response=await fetch(URL,{method:'POST',cache:'no-store',headers:{
    apikey:KEY,'Content-Type':'application/json',
    Authorization:'Bearer '+RemotePos.session.access_token
   },body:JSON.stringify({action:'snapshot',data:{}}),signal:abort.signal});
   const reply=await response.json().catch(()=>({}));
   if(!response.ok||reply.ok!==true)throw Error('Jukebox status is unavailable');
   if(allowed()&&RemotePos.session?.user?.id===userId)
    connection(reply.result?.player_control?.available===true);
  }catch{
   if(allowed()&&RemotePos.session?.user?.id===userId)connection(null);
  }finally{if(timeout!==null)clearTimeout(timeout);indicatorBusy=false;}
 }
 function syncVisibility(){if(!initialized)return;const ok=allowed();$('jukeboxOwnerEntry').classList.toggle('hidden',!ok);$('jukeboxSellBtn').classList.toggle('hidden',!ok);$('posChargeRow').classList.toggle('jukebox-owner-enabled',ok);$('jukeboxPage').classList.toggle('hidden',!ok);$('jukeboxSystemSettingsOpen').classList.toggle('hidden',!ok);
 $('jukeboxConnection').classList.toggle('hidden',!ok);
 if(ok)refreshRecordIndicator();else connection(null);
 if(!ok&&opened){const active=$('jukeboxPage').classList.contains('active');clear();if(active)go('posPage');}}
 function closeForLock(){if(!initialized)return;if(opened){clear();go('systemPage');}$('jukeboxPage').classList.add('hidden');}
 function onNavigation(id){if(!initialized)return;
 if(id==='jukeboxPage'){
  if(!allowed()){clear();$('jukeboxPage').classList.add('hidden');return;}
  if(systemSettingsSession)clear();
  if(opened)return;
  opened=true;$('jukeboxPage').classList.remove('hidden');
  setCustomer(state.employeeCharge?linkedEmployeeCustomer():state.selectedCustomer,state.employeeCharge?state.employeeChargePerson:'');
  apiKey='';loadPending();setAdvanced(false);refresh(true);
 }else if(id==='systemPage'&&systemSettingsSession){return;}
 else if(opened){clear();refreshRecordIndicator(true);}
}
function openSaleDialog(){
 if(!initialized||!allowed()||!$('posPage')?.classList.contains('active'))return;
 const dialog=$('jukeboxSaleDialog');if(dialog.open)return;
 if(opened)clear();
 opened=true;quickSaleSession=true;systemSettingsSession=false;apiKey='';
 dialog.showModal();
 setCustomer(state.employeeCharge?linkedEmployeeCustomer():state.selectedCustomer,state.employeeCharge?state.employeeChargePerson:'');
 loadPending();setAdvanced(false);refresh(true);
}
function closeSaleDialog(){const dialog=$('jukeboxSaleDialog');if(dialog.open)dialog.close();}
function openSystemSettings(){
 if(!initialized||!allowed()||!$('systemPage')?.classList.contains('active'))return;
 if(opened&&!systemSettingsSession)clear();
 systemSettingsSession=true;opened=true;apiKey='';
 setAdvanced(true);
 refresh(true);
}
 async function syncMaintenance(enabled,deviceId){
  if(!allowed())throw Error('סנכרון תחזוקה בג׳וקבוקס דורש בעלים מחובר במסוף מורשה');
  RemotePos.assertShift();
  const token=enabled?RemotePos.maintenanceToken():null;
  if(RemotePos.session.expires_at-Date.now()<75000)await RemotePos.refreshSession();
  const response=await fetch(URL,{method:'POST',cache:'no-store',headers:{apikey:KEY,'Content-Type':'application/json',Authorization:'Bearer '+RemotePos.session.access_token},body:JSON.stringify({action:'configure',data:{maintenance_sync:{device_id:deviceId,enabled, ...(enabled?{token}:{})}}}),signal:AbortSignal.timeout(20000)});
  const reply=await response.json().catch(()=>({}));
  if(!response.ok||reply.ok!==true||reply.result?.maintenance!==enabled){
   const hint={pending_live_jukebox_sale:'יש הזמנת שיר אמת שטרם הושלמה או פגה. יש לבטל אותה לפני הפעלת תחזוקה.',
    maintenance_state_mismatch:'הרשאת תחזוקה בקופה עדיין אינה תואמת לבקשה.',
    maintenance_verification_unavailable:'לא ניתן לאמת כרגע מצב תחזוקה מול שרת הקופה.'};
   throw Error(hint[reply.error]||reply.error||'jukebox_maintenance_sync_failed');
  }
  if(onPage()&&!busy){try{render(await api('snapshot'),true);}catch{}}
  return reply.result;
 }
 async function api(action,data={}){if(!onPage())throw Error('owner_required');RemotePos.assertShift();const e=epoch,original=RemotePos.session?.user?.id;if(RemotePos.session.expires_at-Date.now()<75000)await RemotePos.refreshSession();if(!onPage()||e!==epoch||RemotePos.session?.user?.id!==original)throw Error('owner_required');const abort=new AbortController();controller=abort;requests.add(abort);const timer=setTimeout(()=>abort.abort(),22000);try{const response=await fetch(URL,{method:'POST',cache:'no-store',headers:{apikey:KEY,'Content-Type':'application/json',Authorization:'Bearer '+RemotePos.session.access_token},body:JSON.stringify({action,data}),signal:abort.signal});const result=await response.json().catch(()=>({}));if(!onPage()||e!==epoch||RemotePos.session?.user?.id!==original)throw Error('owner_required');if(!response.ok||result.ok!==true)throw Error(result.error||'jukebox_unavailable');return result.result;}finally{clearTimeout(timer);requests.delete(abort);if(controller===abort)controller=null;}}
 function setBusy(value){if(value)mutation++;busy=value;for(const b of document.querySelectorAll('#jukeboxPage [data-jb-action], #jukeboxAdvanced [data-jb-action]'))b.disabled=value;
  if(selectedQueueKey&&$('jukeboxQueueDialog')?.open){const entry=queueEntries(snapshot).find(o=>queueKey(o)===selectedQueueKey);if(entry)queueDetails(entry);}
  renderTransport();renderSale();}
 function row(host,title,detail,actions=[]){const div=node('div',undefined,'jukebox-row'),label=node('div',title,'jukebox-row-label');if(detail)label.append(node('small',detail));div.append(label);if(actions.length){const controls=node('div',undefined,'jukebox-actions');for(const [t,fn,kind] of actions)controls.append(button(t,fn,kind));div.append(controls);}host.append(div);}
 const fmt=n=>{n=Math.max(0,Math.ceil(Number(n)||0));const h=Math.floor(n/3600),m=Math.floor(n/60)%60,s=n%60;return (h?h+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');};
 function position(o){const s=snapshot,p=s?.guest_progress;if(o.status!=='playing'||p?.order_id!==o.id)return 0;const base=Number(p.position)||0;const at=Date.parse(p.sample_at||''),progress=Date.parse(p.progress_at||'');const running=s.settings?.enabled&&!s.settings?.paused&&!p.invalid&&Number.isFinite(at)&&Number.isFinite(progress)&&at-progress<3000&&Date.now()-snapshotAt<6500;return Math.min(Number(o.duration)||0,base+(running?Math.max(0,Math.min(5,(Date.now()-at)/1000)):0));}
 function remaining(o){return Math.max(0,(Number(o.duration)||0)-position(o));}
 function updateClocks(){if(!onPage()||!snapshot)return;const all=snapshot.orders||[],playing=all.find(o=>o.status==='playing');let total=0;for(const o of all){if(o.status==='queued'||o.status==='playing')total+=remaining(o);const cell=queueTimes.get(o.id);if(cell&&cell.textContent!==fmt(remaining(o)))cell.textContent=fmt(remaining(o));} if($('jukeboxQueueTotal').textContent!==fmt(total))$('jukeboxQueueTotal').textContent=fmt(total);if(playing){$('jukeboxNowDetail').textContent='זמן שנותר · '+fmt(remaining(playing));$('jukeboxProgress').value=playing.duration?100*position(playing)/playing.duration:0;} }
 function iconAction(symbol,label,fn,kind='secondary'){const b=button(symbol,fn,kind,label);b.classList.add('jukebox-icon-btn');return b;}

 const queueRetentionMs=24*60*60*1000;
 const terminalQueueStatuses=new Set(['completed','verified','cancelled','expired']);
 function queueEntries(s,now=Date.now()){
  const names=new Map((s?.queue_customers||[]).map(x=>[x.order_id,x]));
  return [...(s?.orders||[]).map(o=>({...o,...names.get(o.id)})),
   ...(s?.pending_codes||[]).map(c=>({...c,codeOnly:true,code_id:c.id,title:'קוד ממתין לבחירת שיר'}))]
   .filter(o=>{
    // Only terminal entries expire; waiting, playing, paused or review-required entries remain.
    if(!terminalQueueStatuses.has(o.status))return true;
    // Prefer playback verification time where present, then original creation timestamp.
    // When neither is valid, retain the entry rather than risk hiding active data.
    const at=Date.parse(o.verified_at||o.created_at||'');
    return !Number.isFinite(at)||now-at<queueRetentionMs;
   })
   .sort((a,b)=>Date.parse(b.created_at||0)-Date.parse(a.created_at||0));
 }
 const queueKey=o=>o.codeOnly?'code:'+o.code_id:'order:'+o.id;
 const queueCustomer=o=>o.customer_name?(o.person_name?o.customer_name+' · '+o.person_name:o.customer_name):'לקוח לא ידוע';
 function queueDetails(o){
  const host=$('jukeboxQueueDetails'),actions=$('jukeboxQueueActions');
  host.replaceChildren();actions.replaceChildren();
  if(!o)return;
  const isCode=o.codeOnly===true,canManage=o.is_test===true||(snapshot?.queue_customers||[]).some(x=>x.order_id===o.id);
  const head=node('div',undefined,'jukebox-queue-detail-heading');
  head.append(node('strong',o.title||'—','jukebox-queue-detail-title'));
  const st=node('span',(labels[o.status]||o.status)+(o.is_test?' · D':''),'jukebox-status-pill');st.dataset.state=o.status;head.append(st);host.append(head);
  const grid=node('div',undefined,'jukebox-queue-detail-fields');
  for(const [caption,value] of [['לקוח',queueCustomer(o)],['משך שיר',isCode?'טרם נבחר':fmt(o.duration)],['מצב',labels[o.status]||o.status]]){
   const cell=node('div',undefined,'jukebox-queue-detail-field');cell.append(node('small',caption),node('b',value));grid.append(cell);
  }
  host.append(grid);
  const action=(label,enabled,handler,warning=false)=>{
   const b=node('button',label,'button '+(warning?'warning':'secondary')+' jukebox-queue-action');
   b.type='button';b.disabled=busy||!enabled;
   b.setAttribute('aria-disabled',String(b.disabled));
   if(!enabled)b.title='הפעולה אינה זמינה במצב השיר הנוכחי';
   b.addEventListener('click',()=>{if(!onPage()||busy||b.disabled)return;handler();});
   actions.append(b);
  };
  if(isCode){
   const active=o.status==='active';
   action('◎ הצג קוד',active,()=>recoverCode(o.code_id));
   action('✕ בטל קוד',active,async()=>{
    if(await ask('ביטול קוד','לבטל את הקוד הקיים?',null,true)&&onPage())
     run(()=>api('configure',{cancel_code_id:o.code_id}));
   },true);
  }else{
   action('Ⅱ השהה',canManage&&o.status==='queued',()=>run(()=>api('hold',{id:o.id})));
   action('▶ חדש בתור',canManage&&o.status==='held',()=>run(()=>api('release',{id:o.id})));
   action('↻ נגן שוב',canManage&&['failed','pending_approval'].includes(o.status),async()=>{
    if(await ask('ניסיון ניגון נוסף','להחזיר את השיר לתור? לא יירשם חיוב עד לניגון מאומת.',null,true)&&onPage())
     run(()=>api('retry',{id:o.id}));
   });
   action('✕ בטל שיר',canManage&&['queued','held','failed','pending_approval'].includes(o.status),async()=>{
    if(await ask('ביטול שיר','לבטל את השיר '+o.title+'?',null,true)&&onPage())
     run(()=>api('cancel',{id:o.id}));
   },true);
  }
 }
 function openQueueActions(key){
  if(!onPage()||busy)return;
  const o=queueEntries(snapshot).find(x=>queueKey(x)===key);
  if(!o)return;
  selectedQueueKey=key;clearRecovery();
  $('jukeboxQueueNotice').textContent='';
  queueDetails(o);
  if(!$('jukeboxQueueDialog').open)$('jukeboxQueueDialog').showModal();
 }
 function queueRows(s){
  const now=Date.now(),all=queueEntries(s,now);
  // Re-evaluate age each minute even when queue data did not change.
  const sig=JSON.stringify([Math.floor(now/60000),all.map(o=>[o.id,o.code_id,o.title,o.duration,o.status,o.is_test,o.created_at,o.verified_at,o.customer_name]),s.queue_customers||[]]);
  if(sig===queueSignature)return;
  queueSignature=sig;
  const host=$('jukeboxQueueList');host.replaceChildren();queueTimes.clear();
  const active=all.filter(o=>['queued','playing','held','failed','pending_approval','active'].includes(o.status));
  $('jukeboxQueueCount').textContent=String(active.length);
  for(const o of all){
   const key=queueKey(o),item=node('button',undefined,'jukebox-queue-item');
   item.type='button';item.dataset.jbAction='';item.disabled=busy;item.dataset.state=o.status;
   if(o.status==='playing')item.classList.add('is-playing');
   const primary=node('span',undefined,'jukebox-queue-item-primary');
   primary.append(node('strong',o.title||'—','jukebox-queue-item-title'));
   const meta=node('span',undefined,'jukebox-queue-item-meta');
   meta.append(node('span',queueCustomer(o),'jukebox-queue-customer'));
   const duration=node('span',undefined,'jukebox-queue-time');
   duration.append(node('small',o.status==='playing'?'נותרו':'משך'));
   const clock=node('b',o.codeOnly?'—':fmt(remaining(o)));
   duration.append(clock);meta.append(duration);primary.append(meta);
   const st=node('span',(labels[o.status]||o.status)+(o.is_test?' · D':''),'jukebox-status-pill');st.dataset.state=o.status;
   const stateWrap=node('span',undefined,'jukebox-queue-item-state');stateWrap.append(st);
   if(o.status==='playing')stateWrap.append(node('span','♫ מתנגן כעת','jukebox-queue-playing-label'));
   item.append(primary,stateWrap);
   item.setAttribute('aria-label',[o.title,queueCustomer(o),o.codeOnly?'ממתין לבחירת שיר':fmt(o.duration),labels[o.status]||o.status].join(' · '));
   item.addEventListener('click',()=>openQueueActions(key));
   host.append(item);
   if(!o.codeOnly)queueTimes.set(o.id,clock);
  }
  if(!all.length)host.append(node('p','התור ריק כרגע. שירים שיתווספו יוצגו כאן.','jukebox-queue-empty'));
  if(selectedQueueKey&&$('jukeboxQueueDialog').open){
   const selected=all.find(o=>queueKey(o)===selectedQueueKey);
   if(selected)queueDetails(selected);
   else $('jukeboxQueueDialog').close();
  }
  if(recoveredId&&!all.some(o=>o.codeOnly&&o.code_id===recoveredId&&o.status==='active'))clearRecovery();
 }
 async function recoverCode(id){if(!onPage()||busy||!$('jukeboxQueueDialog').open)return;setBusy(true);const e=epoch;try{const r=await api('snapshot',{recover_code_id:id});if(e!==epoch||!$('jukeboxQueueDialog').open)return;if(!/^\d{4}$/.test(r?.code||''))throw Error('jukebox_operation_failed');recoveredId=id;$('jukeboxRecoveredValue').textContent=r.code;$('jukeboxRecoveredExpiry').textContent='תקף עד '+new Date(r.expires_at).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'});$('jukeboxRecoveredCode').classList.remove('hidden');$('jukeboxQueueNotice').textContent='זהו הקוד הקיים — לא נוצר חיוב נוסף.';}catch(err){$('jukeboxQueueNotice').textContent=errors[err.message]||'הקוד אינו זמין.';}finally{if(e===epoch)setBusy(false);}}
 function renderPower(){const s=snapshot?.settings||{},c=snapshot?.player_control||{},on=s.player_enabled!==false;const b=$('jukeboxPowerBtn');b.disabled=busy||!snapshot;b.textContent=on?'כבה נגן':'הפעל נגן';b.classList.toggle('warning',on);b.classList.toggle('primary',!on);$('jukeboxPowerStatus').textContent=!snapshot?'ממתין לשרת':!on?'הנגן כבוי':c.autoplay_blocked&&c.available?'נדרשת לחיצה חד־פעמית בטאבלט לאפשר שמע':!c.available?'הפעלה מוגדרת · ממתין לטאבלט':c.power===false?'ממתין לאישור הטאבלט':c.state==='playing'||c.state==='guest'?'הנגן פעיל · מתנגן':s.paused?'הנגן פעיל · מושהה':'הנגן פעיל';}
 function renderTransport(){const s=snapshot?.settings||{},playing=(snapshot?.orders||[]).find(o=>o.status==='playing'),control=snapshot?.player_control||{},count=(snapshot?.items||[]).filter(i=>i.playlist_id===s.active_playlist&&!i.archived_at).length,seedMode=(snapshot?.playlists||[]).some(p=>p.id===s.active_playlist&&p.is_temporary);$('jukeboxPauseBtn').textContent=s.paused?'▶ המשך':'⏸ השהה';$('jukeboxPauseBtn').disabled=busy||!snapshot||!s.enabled;const available=!busy&&s.enabled&&s.player_enabled!==false&&control.available===true&&count>0&&!playing;$('jukeboxPrevBtn').disabled=!available||(!seedMode&&count<2);$('jukeboxNextBtn').disabled=!available||(!seedMode&&count<2);$('jukeboxStopBtn').disabled=!available;$('jukeboxTransportNote').textContent=playing?'שיר לקוח מתנגן. דילוג ועצירה חסומים.':!control.available?'ממתין לדיווח מהטאבלט.':seedMode?'רקע מתמשך לפי השיר שנבחר.':count>0?'':'בחר שיר רקע ביוטיוב.';renderPower();}
 function render(s,force=false){if(!onPage())return;snapshot=s;snapshotAt=Date.now();$('jukeboxContent').classList.remove('hidden');const settings=s.settings||{},maintenance=Date.parse(settings.maintenance_until||'')>Date.now(),devices=s.devices||[],playing=(s.orders||[]).find(o=>o.status==='playing'),control=s.player_control||{},track=(s.items||[]).find(i=>i.id===control.item_id&&!i.archived_at),seed=(s.items||[]).find(i=>i.playlist_id===settings.active_playlist&&!i.archived_at);connection(s.player_control?.available===true);$('jukeboxMaintenanceBanner').classList.toggle('hidden',!maintenance);
  keyConfigured=s.youtube_configured===true;keyImportPending=s.youtube_import_pending===true;if(advancedOpen)$('jukeboxKeyStatus').textContent=keyStatus();renderSale();
  if(selectedCustomer&&!state.customers.some(c=>c.id===selectedCustomer.id&&c.active))setCustomer(null);
  const actual=control.available&&control.state!=='idle'&&track;
  const mode=settings.player_enabled===false?'off':settings.paused?'paused':playing?'guest':settings.enabled?'background':'off';
  $('jukeboxPlayerMode').dataset.mode=mode;
  $('jukeboxPlayerMode').textContent=mode==='guest'?'שיר לקוח':mode==='background'?'מוזיקת רקע':mode==='paused'?'מושהה':'כבוי';$('jukeboxNow').textContent=playing?.title||(actual?(control.title||track.title):seed?.title||'ממתין לניגון');$('jukeboxNowDetail').textContent=playing?'זמן שנותר · '+fmt(remaining(playing)):actual?'מוזיקת רקע · '+fmt(Math.max(0,Number(control.duration)-Number(control.position)))+' נותרו':seed?'ממתין לניגון בטאבלט':'בחר שיר רקע';$('jukeboxProgress').value=playing&&playing.duration?100*position(playing)/playing.duration:actual&&control.duration?100*Number(control.position)/Number(control.duration):0;
  const settingsSig=JSON.stringify([settings.enabled,settings.is_open,settings.paused,settings.price]);if(!settingsDirty&&(force||settingsSig!==settingsSignature)){$('jukeboxEnabled').checked=settings.enabled===true;$('jukeboxIsOpen').checked=settings.is_open===true;$('jukeboxPaused').checked=settings.paused===true;$('jukeboxPrice').value=settings.price??'';settingsSignature=settingsSig;}const activeDevices=devices.filter(x=>!x.revoked_at),deviceSig=JSON.stringify(activeDevices.map(d=>[d.id,d.name]));if(deviceSig!==deviceSignature){deviceSignature=deviceSig;const d=$('jukeboxDevices');d.replaceChildren();for(const dev of activeDevices)row(d,dev.name||'טאבלט','מצומד');if(!d.children.length)d.append(node('p','אין טאבלט מצומד.','small-note'));}queueRows(s);renderTransport();updateClocks();
 }
 function handleError(e,expected){if(expected!==epoch||!opened)return;if(e?.message==='owner_required'){if(RemotePos.employee)RemotePos.employee={...RemotePos.employee,is_owner:false};clear();$('jukeboxPage').classList.add('hidden');go('systemPage');renderPermissions();return;}const msg=errors[e?.message]||'לא ניתן להשלים את הפעולה. בדוק את החיבור ונסה שוב.';message(msg,true);if($('jukeboxQueueDialog').open)$('jukeboxQueueNotice').textContent=msg;}
 async function refresh(force=false){if(!onPage()||busy||polling)return;const e=epoch,m=mutation;polling=true;try{const s=await api('snapshot');if(e===epoch&&m===mutation&&!busy&&onPage()){if(keyConfigured!==(s.youtube_configured===true))apiKey='';render(s,force);if(force||$('jukeboxMessage').dataset.pollError==='true'){message('');delete $('jukeboxMessage').dataset.pollError;}}}catch(err){if(e===epoch&&m===mutation&&!busy){if(!snapshot)connection(null);if(err?.message==='owner_required')handleError(err,e);else if(force||!snapshot||!$('jukeboxMessage').textContent){message('חיבור הג׳וקבוקס אינו זמין כרגע. מנסה שוב ברקע.',true);$('jukeboxMessage').dataset.pollError='true';}}}finally{if(e===epoch)polling=false;}}
 async function run(fn){if(!onPage()||busy)return;const e=epoch;setBusy(true);try{await fn();if(e!==epoch||!onPage())return;const s=await api('snapshot');if(e===epoch&&onPage()){render(s);message('');}}catch(err){handleError(err,e);}finally{if(e===epoch)setBusy(false);}}
 function isoSeconds(d){const m=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d||'');return m?Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0):0;}
 function decodeTitle(value){const t=document.createElement('textarea');t.innerHTML=String(value||'');return t.value;}
 function renderTracks(tracks){const host=$('jukeboxSearchResults');host.replaceChildren();for(const t of tracks){const item=node('button',undefined,'jukebox-track');item.type='button';item.dataset.jbAction='';item.disabled=busy;item.setAttribute('aria-label','נגן כרקע: '+t.title);if(t.thumbnail){const img=node('img');img.src=t.thumbnail;img.alt='';img.loading='lazy';item.append(img);}else{item.append(node('span','♪','jukebox-track-placeholder'));}const text=node('span',undefined,'jukebox-track-text');text.append(node('strong',t.title),node('small',[t.channel,t.duration?fmt(t.duration):''].filter(Boolean).join(' · ')));item.append(text,node('span','+','jukebox-track-plus'));item.addEventListener('click',()=>playBackground(t));host.append(item);}$('jukeboxSearchStatus').textContent=tracks.length?'בחר שיר לרקע.':'לא נמצאו תוצאות.';}
 function scheduleSearch(){stopSearch();const query=$('jukeboxSearchQuery').value.trim();$('jukeboxSearchResults').replaceChildren();if(query.length<2){$('jukeboxSearchStatus').textContent='הקלד לפחות שתי אותיות.';return;}$('jukeboxSearchStatus').textContent='מחפש…';searchTimer=setTimeout(searchYoutube,850);}
 async function searchYoutube(){if(!onPage())return;stopSearch();const query=$('jukeboxSearchQuery').value.trim(),host=$('jukeboxSearchResults'),notice=$('jukeboxSearchStatus'),g=searchGeneration;host.replaceChildren();if(query.length<2){notice.textContent='יש להזין לפחות שתי אותיות.';return;}const cacheKey=query.toLocaleLowerCase();if(searchCache.has(cacheKey)){renderTracks(searchCache.get(cacheKey));return;}notice.textContent='מחפש…';const controller=new AbortController();searchAbort=controller;const timer=setTimeout(()=>controller.abort(),15000);try{if(!apiKey){const config=await api('snapshot',{youtube_key:true});if(!onPage()||g!==searchGeneration)return;apiKey=config?.key||'';}if(!apiKey){notice.textContent='הגדר מפתח YouTube בהגדרות מתקדמות.';return;}const params=new URLSearchParams({part:'snippet',type:'video',videoEmbeddable:'true',videoSyndicated:'true',maxResults:'12',q:query,key:apiKey});const response=await fetch('https://www.googleapis.com/youtube/v3/search?'+params,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('YouTube '+response.status);const result=await response.json();const found=(result.items||[]).filter(x=>/^[A-Za-z0-9_-]{11}$/.test(x.id?.videoId||'')&&x.snippet?.title);let details=[];if(found.length){const d=await fetch('https://www.googleapis.com/youtube/v3/videos?'+new URLSearchParams({part:'contentDetails,status',id:found.map(x=>x.id.videoId).join(','),key:apiKey}),{signal:controller.signal,cache:'no-store'});if(!d.ok)throw Error('YouTube '+d.status);details=(await d.json()).items||[];}if(!onPage()||g!==searchGeneration)return;const tracks=found.map(x=>{const detail=details.find(d=>d.id===x.id.videoId);return {id:x.id.videoId,title:decodeTitle(x.snippet.title).slice(0,300),channel:decodeTitle(x.snippet.channelTitle),thumbnail:x.snippet.thumbnails?.medium?.url||x.snippet.thumbnails?.default?.url||'',duration:isoSeconds(detail?.contentDetails?.duration),embeddable:detail?.status?.embeddable===true};}).filter(t=>t.embeddable&&t.duration>0);if(searchCache.size>=30)searchCache.delete(searchCache.keys().next().value);searchCache.set(cacheKey,tracks);renderTracks(tracks);}catch{if(onPage()&&g===searchGeneration)notice.textContent='החיפוש נכשל. בדוק את מפתח YouTube, הרשאות האתר והמכסה.';}finally{clearTimeout(timer);if(searchAbort===controller)searchAbort=null;}}
 async function playBackground(track){if(!onPage()||busy||!await ask('בחירת מוזיקת רקע','להפעיל את השיר כמוזיקת רקע?',track))return;if(!onPage()||busy)return;await run(async()=>{await api('configure',{background_seed:{video_id:track.id,title:track.title,channel:track.channel||''}});stopSearch();$('jukeboxSearchResults').replaceChildren();$('jukeboxSearchQuery').value='';$('jukeboxSearchStatus').textContent='נבחר שיר רקע. ההמשך יגיע מפלייליסט YouTube ציבורי מתאים, לאחר סיום תור הלקוחות.';});}
 function init(){if(initialized)return;initialized=true;
  $('jukeboxOpenBtn').addEventListener('click',()=>{if(allowed())go('jukeboxPage');});
  $('jukeboxSellBtn').addEventListener('click',openSaleDialog);
  $('jukeboxQuickClose').addEventListener('click',closeSaleDialog);
  $('jukeboxSaleDialog').addEventListener('close',()=>{if(quickSaleSession){clear();refreshRecordIndicator(true);}});
  $('jukeboxAdvancedClose').addEventListener('click',()=>setAdvanced(false));$('jukeboxAdvanced').addEventListener('close',()=>{advancedOpen=false;$('jukeboxSystemSettingsOpen').setAttribute('aria-expanded','false');if(systemSettingsSession)clear();});$('jukeboxSaleConfirm').addEventListener('click',issueSale);$('jukeboxAbandonSale').addEventListener('click',abandonSale);
  $('jukeboxCustomerSearch').addEventListener('focus',renderCustomerChoices);$('jukeboxCustomerSearch').addEventListener('input',()=>{selectedCustomer=null;employeePerson='';$('jukeboxSaleCustomer').textContent='לא נבחר לקוח';$('jukeboxEmployeeCharge').classList.remove('active');$('jukeboxEmployeeCharge').textContent='חיוב על עובד';saleNotice='';resetIssued();renderSale();renderCustomerChoices();});$('jukeboxCustomerSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('jukeboxCustomerResults').querySelector('button')?.click();}else if(e.key==='Escape')closeCustomer();else if(e.key==='ArrowDown'){e.preventDefault();$('jukeboxCustomerResults').querySelector('button')?.focus();}});
  document.addEventListener('click',e=>{if(!e.target.closest('.jukebox-customer-wrap'))closeCustomer();});
  $('jukeboxEmployeeCharge').addEventListener('click',()=>{if(!onPage())return;const c=linkedEmployeeCustomer();$('jukeboxEmployeeNote').textContent=c?'חשבון עובד: '+c.name:'לא קושר חשבון לקוח פעיל לעובד בניהול עובדים.';$('jukeboxEmployeePerson').value=employeePerson;$('jukeboxEmployeeDialog').showModal();$('jukeboxEmployeePerson').focus();});
  $('jukeboxEmployeeClose').addEventListener('click',()=>$('jukeboxEmployeeDialog').close());$('jukeboxEmployeeForm').addEventListener('submit',e=>{e.preventDefault();const c=linkedEmployeeCustomer(),name=$('jukeboxEmployeePerson').value.normalize('NFKC').trim().replace(/\s+/g,' ');if(!c||!name||name.length>100){$('jukeboxEmployeeNote').textContent=!c?'נדרש חשבון עובד פעיל.':'יש להזין שם עד 100 תווים.';return;}setCustomer(c,name);$('jukeboxEmployeeDialog').close();});
  $('jukeboxQueueClose').addEventListener('click',()=>$('jukeboxQueueDialog').close());$('jukeboxQueueDialog').addEventListener('close',()=>{selectedQueueKey=null;clearRecovery();});
  $('jukeboxPowerBtn').addEventListener('click',async()=>{if(!snapshot||busy)return;const on=snapshot.settings?.player_enabled!==false;if(on&&!await ask('כיבוי נגן','לכבות את הנגן בטאבלט? שיר לקוח שלא הושלם יעבור לבדיקה ללא חיוב.',null,true))return;if(onPage())run(()=>api('configure',{player_enabled:!on}));});$('jukeboxPauseBtn').addEventListener('click',()=>{if(snapshot?.settings?.enabled)run(()=>api('configure',{paused:!snapshot.settings.paused}));});for(const [id,cmd] of [['jukeboxPrevBtn','previous'],['jukeboxNextBtn','next'],['jukeboxStopBtn','stop']])$(id).addEventListener('click',()=>{if(!$(id).disabled)run(()=>api('configure',{background_command:cmd}));});
  $('jukeboxSearchForm').addEventListener('submit',e=>{e.preventDefault();searchYoutube();});$('jukeboxSearchQuery').addEventListener('input',scheduleSearch);$('jukeboxConfirmDialog').addEventListener('close',finishConfirm);
  $('jukeboxSaveKey').addEventListener('click',()=>{if(!onPage()||!advancedOpen||busy)return;const key=$('jukeboxSearchKey').value.trim();if(!/^[A-Za-z0-9_-]{20,100}$/.test(key)){$('jukeboxKeyStatus').textContent='מפתח לא תקין.';return;}run(async()=>{await api('configure',{youtube_api_key:key});apiKey=key;searchCache.clear();$('jukeboxSearchKey').value='';try{localStorage.removeItem('jukebox-dev-key');}catch{};});});
  $('jukeboxImportKey').addEventListener('click',()=>{if(!onPage()||!advancedOpen||busy)return;run(()=>api('configure',{youtube_import:true}));});
  $('jukeboxSettingsForm').addEventListener('input',()=>{settingsDirty=true;});$('jukeboxSettingsForm').addEventListener('submit',e=>{e.preventDefault();run(async()=>{const price=Number($('jukeboxPrice').value);if(!Number.isFinite(price)||price<0||price>10000)throw Error('invalid_payload');await api('configure',{enabled:$('jukeboxEnabled').checked,open:$('jukeboxIsOpen').checked,paused:$('jukeboxPaused').checked,price});settingsDirty=false;});});
  $('jukeboxPairBtn').addEventListener('click',async()=>{if(await ask('צימוד טאבלט','ליצור אסימון צימוד חדש לטאבלט?'))run(async()=>{const r=await api('pair');if(!/^[0-9]{6}$/.test(r?.pair_token||''))throw Error('jukebox_operation_failed');clearPair();$('jukeboxPairToken').value=r.pair_token;$('jukeboxPairBox').classList.remove('hidden');pairTimer=setTimeout(clearPair,300000);});});
  $('jukeboxCopyPair').addEventListener('click',async()=>{if(!onPage()||!$('jukeboxPairToken').value)return;try{await navigator.clipboard.writeText($('jukeboxPairToken').value);}catch{$('jukeboxPairToken').focus();$('jukeboxPairToken').select();}});
  $('jukeboxUnlockBtn').addEventListener('click',()=>run(()=>api('unlock')));$('jukeboxRevokeBtn').addEventListener('click',async()=>{if(await ask('ביטול צימוד','לבטל את צימוד הטאבלט?',null,true))run(()=>api('revoke_device'));});
  window.addEventListener('pagehide',()=>{if(opened)clear();});setInterval(()=>{if(opened&&!allowed())syncVisibility();else if(onPage()&&!busy)refresh(false);},3000);setInterval(updateClocks,250);setInterval(()=>{if(allowed())refreshRecordIndicator();else if(!$('jukeboxConnection').classList.contains('hidden'))syncVisibility();},15000);syncVisibility();
 }
 return {init,allowed,syncVisibility,onNavigation,openSystemSettings,closeForLock,syncMaintenance};
})();
