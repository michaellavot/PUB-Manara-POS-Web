'use strict';
/* Native POS owner screen. The only backend is Jukebox's scoped owner bridge. */
const JukeboxAdmin=(()=>{
 const $=id=>document.getElementById(id);
 const URL='https://srudevbrupqaemgrrhcg.supabase.co/functions/v1/jukebox-pos-owner';
 const KEY='sb_publishable_c4yDW12R7D3SZej11VNPpg_ZI_CiHC-';
 const errors={owner_required:'נדרש אימות בעלים מחדש בקופה.',owner_or_action_denied:'הפעולה אינה מורשית. פעולות חיוב וקודים אמיתיים אינן זמינות.',action_disabled:'פעולה זו אינה זמינה דרך הקופה.',invalid_payload:'הפרטים אינם תקינים.',jukebox_operation_failed:'פעולת הג׳וקבוקס נכשלה. בדוק את הנתונים ונסה שוב.',jukebox_unavailable:'שרת הג׳וקבוקס אינו זמין כרגע.',origin_denied:'הכתובת אינה מורשית.'};
 const labels={queued:'בתור',playing:'מתנגן',held:'בהשהיה',failed:'נכשל',completed:'הושלם',cancelled:'בוטל',pending_approval:'ממתין לאישור',expired:'פג תוקף'};
 let initialized=false,epoch=0,busy=false,controller=null,snapshot=null,editing=null,settingsDirty=false,pairTimer=null,opened=false,searchGeneration=0;
 // A separate sale permission will be enabled for employees later; currently owner only.
 const canSell=()=>allowed();
 const saleOpen=()=>canSell()&&$('jukeboxSaleDialog')?.open&&$('posPage')?.classList.contains('active');
 function closeSale(){const d=$('jukeboxSaleDialog');if(d?.open)d.close();}
 function clearSearch(){searchGeneration++;$('jukeboxSearchResults').replaceChildren();$('jukeboxSearchQuery').value='';$('jukeboxSearchStatus').textContent='';$('jukeboxSearchKey').value='';}
 async function openSale(){
  if(!canSell()||!$('posPage').classList.contains('active'))return;
  const c=state.employeeCharge?null:state.selectedCustomer;
  if(!c){toastCustomer();status('יש לבחור לקוח לפני חיוב שיר','error');return;}
  $('jukeboxSaleCustomer').textContent=c.name;$('jukeboxSalePrice').textContent='טוען…';
  $('jukeboxSaleNotice').textContent='תצוגת ממשק בלבד — חיוב ויצירת קוד טרם הופעלו.';
  $('jukeboxSaleDialog').showModal();
  try{const s=await api('snapshot',{},'sale');if(saleOpen()){const p=s?.settings?.price; $('jukeboxSalePrice').textContent=p==null?'לא הוגדר':Number(p).toFixed(2)+' ₪';}}
  catch{if(saleOpen()){$('jukeboxSalePrice').textContent='לא זמין';$('jukeboxSaleNotice').textContent='לא ניתן לקרוא את מחיר השיר. חיוב ויצירת קוד אינם פעילים.';}}
 }
 function allowed(){const u=RemotePos.employee||{};return RemotePos.active===true&&RemotePos.authenticated===true&&u.active===true&&u.is_owner===true&&u.owner_terminal===true&&u.pin_login===true&&Number(RemotePos.session?.pos_valid_until)>Date.now();}
 const onPage=()=>opened&&$('jukeboxPage')?.classList.contains('active')&&allowed();
 function message(t,error=false){const el=$('jukeboxMessage');el.textContent=t;el.className='status '+(error?'error':t?'success':'');}
 function connection(t,ok=null){const el=$('jukeboxConnection');el.textContent=t;el.classList.toggle('jukebox-connected',ok===true);el.classList.toggle('jukebox-disconnected',ok===false);}
 function node(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=String(text);if(cls)x.className=cls;return x;}
 function button(text,fn,kind='secondary'){const b=node('button',text,'button '+kind);b.type='button';b.dataset.jbAction='';b.disabled=busy;b.addEventListener('click',fn);return b;}
 function setBusy(value){busy=value;for(const b of $('jukeboxPage').querySelectorAll('[data-jb-action]'))b.disabled=value;$('jukeboxRefreshBtn').disabled=value;}
 function closeEdit(){editing=null;$('jukeboxEditPlaylist').classList.add('hidden');$('jukeboxEditName').value='';$('jukeboxEditItems').value='';}
 function clearPair(){clearTimeout(pairTimer);pairTimer=null;$('jukeboxPairToken').value='';$('jukeboxPairBox').classList.add('hidden');}
 function clear(){epoch++;opened=false;clearSearch();controller?.abort();controller=null;snapshot=null;settingsDirty=false;clearPair();closeEdit();for(const id of ['jukeboxDevices','jukeboxPlaylists','jukeboxQueue'])$(id).replaceChildren();$('jukeboxCodeSummary').textContent='';$('jukeboxNewName').value='';$('jukeboxPlaylistCount').textContent='0 רשימות';$('jukeboxQueueCount').textContent='0 בתור';$('jukeboxContent').classList.add('hidden');$('jukeboxSettingsForm').reset();message('');connection('ממתין לחיבור');setBusy(false);}
 function go(id){document.querySelector('.tab[data-page="'+id+'"]')?.click();}
 function syncVisibility(){if(!initialized)return;const ok=allowed();$('jukeboxOwnerEntry').classList.toggle('hidden',!ok);$('jukeboxSellBtn').classList.toggle('hidden',!canSell());if(!canSell())closeSale();$('jukeboxPage').classList.toggle('hidden',!ok);if(!ok&&opened){const wasActive=$('jukeboxPage').classList.contains('active');clear();if(wasActive)go('posPage');}}
 function closeForLock(){if(!initialized)return;closeSale();if(opened){clear();go('systemPage');}$('jukeboxPage').classList.add('hidden');}
 function onNavigation(id){if(!initialized)return;if(id!=='posPage')closeSale();if(id==='jukeboxPage'){if(!allowed()){clear();$('jukeboxPage').classList.add('hidden');return;}if(opened)return;opened=true;$('jukeboxPage').classList.remove('hidden');refresh(true);}else if(opened){clear();}}
 async function api(action,data={},scope='admin'){
  const valid=scope==='sale'?saleOpen:onPage;
  if(!valid()||(scope==='sale'&&action!=='snapshot'))throw Error('owner_required');
  RemotePos.assertShift();
  const e=epoch,original=RemotePos.session?.user?.id;
  if(RemotePos.session.expires_at-Date.now()<75000)await RemotePos.refreshSession();
  if(!valid()||e!==epoch||RemotePos.session?.user?.id!==original)throw Error('owner_required');
  const abort=new AbortController();controller=abort;const timer=setTimeout(()=>abort.abort(),22000);
  try{
   const response=await fetch(URL,{method:'POST',cache:'no-store',headers:{apikey:KEY,'Content-Type':'application/json',Authorization:'Bearer '+RemotePos.session.access_token},body:JSON.stringify({action,data}),signal:abort.signal});
   const result=await response.json().catch(()=>({}));
   if(!valid()||e!==epoch||RemotePos.session?.user?.id!==original)throw Error('owner_required');
   if(!response.ok||result.ok!==true)throw Error(result.error||'jukebox_unavailable');
   return result.result;
  }finally{clearTimeout(timer);if(controller===abort)controller=null;}
 }
 function row(host,title,detail,actions=[]){const div=node('div',undefined,'jukebox-row'),label=node('div',title,'jukebox-row-label');if(detail)label.append(node('small',detail));div.append(label);if(actions.length){const controls=node('div',undefined,'jukebox-actions');for(const [t,fn,kind] of actions)controls.append(button(t,fn,kind));div.append(controls);}host.append(div);}
 function render(s,forceSettings=false){
  if(!onPage())return;
  snapshot=s;$('jukeboxContent').classList.remove('hidden');connection('מחובר לג׳וקבוקס',true);
  const settings=s.settings||{};
  if(forceSettings||!settingsDirty){$('jukeboxEnabled').checked=settings.enabled===true;$('jukeboxIsOpen').checked=settings.is_open===true;$('jukeboxPaused').checked=settings.paused===true;$('jukeboxPrice').value=settings.price??'';settingsDirty=false;}
  const devices=$('jukeboxDevices');devices.replaceChildren();
  for(const d of s.devices||[])row(devices,d.name||'טאבלט',d.revoked_at?'מנותק':d.locked_until&&Date.parse(d.locked_until)>Date.now()?'מצומד · נעול':'מצומד');
  if(!devices.children.length)devices.append(node('p','אין טאבלט מצומד.','small-note'));
  const lists=$('jukeboxPlaylists');lists.replaceChildren();
  const playlists=s.playlists||[],items=s.items||[];
  const searchSelect=$('jukeboxSearchPlaylist'),prev=searchSelect.value;
  searchSelect.replaceChildren(new Option('בחר רשימת רקע',''));
  for(const p of playlists.filter(p=>!p.deleted_at))searchSelect.add(new Option(p.name,p.id));
  if([...searchSelect.options].some(o=>o.value===prev))searchSelect.value=prev;
  else if(settings.active_playlist)searchSelect.value=settings.active_playlist;
  $('jukeboxPlaylistCount').textContent=playlists.filter(p=>!p.deleted_at).length+' רשימות';
  for(const p of [...playlists].sort((a,b)=>Number(Boolean(a.deleted_at))-Number(Boolean(b.deleted_at))||String(a.name).localeCompare(String(b.name),'he'))){
   const count=items.filter(i=>i.playlist_id===p.id&&!i.archived_at).length;
   const active=settings.active_playlist===p.id;
   const actions=p.deleted_at?[['שחזר',()=>run(()=>api('playlist_restore',{id:p.id}))]]:[['ערוך',()=>openEdit(p.id)],['בחר לרקע',()=>run(()=>api('playlist_select',{id:p.id})),'primary'],['העבר לארכיון',()=>{if(confirm('להעביר את הרשימה לארכיון?'))run(()=>api('playlist_archive',{id:p.id}));},'warning']];
   row(lists,p.name,(p.deleted_at?'בארכיון':active?'פעילה ברקע':'רשימת רקע')+' · '+count+' שירים',actions);
  }
  if(!lists.children.length)lists.append(node('p','עדיין אין רשימות רקע. צור רשימה חדשה.','small-note'));
  const q=$('jukeboxQueue');q.replaceChildren();
  const all=s.orders||[],current=all.filter(o=>['playing','queued','held','failed','pending_approval'].includes(o.status));
  const orderPriority=o=>o.status==='playing'?0:o.status==='queued'?1:2;
  current.sort((a,b)=>orderPriority(a)-orderPriority(b)||Number(a.position)-Number(b.position));
  $('jukeboxQueueCount').textContent=current.length+' בתור';
  for(const o of current){
   const actions=[];
   if(o.is_test===true)for(const [action,label,states] of [['hold','השהה',['queued']],['release','שחרר',['held']],['retry','נסה שוב',['failed']],['cancel','בטל',['queued','held','failed','pending_approval']]])if(states.includes(o.status))actions.push([label,()=>{if(action!=='cancel'||confirm('לבטל את שיר הבדיקה?'))run(()=>api(action,{id:o.id}));},action==='cancel'?'warning':'secondary']);
   row(q,o.title,(labels[o.status]||o.status)+(o.is_test?' · בדיקה':''),actions);
  }
  if(!q.children.length)q.append(node('p','התור ריק. רשימת הרקע תמשיך להתנגן כאשר הנגן פעיל.','small-note'));
  $('jukeboxCodeSummary').textContent='קודי בדיקה פעילים: '+Number(s.code_summary?.active||0)+' · אין הנפקת קודים או חיובים אמיתיים מהקופה.';
 }
 function errorText(e){return errors[e?.message]||'לא ניתן להשלים את הפעולה. בדוק את החיבור ונסה שוב.';}
 function handleError(e,expected){if(expected!==epoch||!opened)return;if(e?.message==='owner_required'){if(RemotePos.employee)RemotePos.employee={...RemotePos.employee,is_owner:false};clear();$('jukeboxPage').classList.add('hidden');go('systemPage');renderPermissions();return;}message(errorText(e),true);connection('נדרש רענון',false);}
 async function refresh(force=false){if(!onPage()||busy)return;const e=epoch;setBusy(true);if(!snapshot)connection('מתחבר…');try{const s=await api('snapshot');if(e===epoch&&onPage()){render(s,force);if(force)message('מצב הג׳וקבוקס עודכן');}}catch(err){handleError(err,e);}finally{if(e===epoch)setBusy(false);}}
 async function run(fn){if(!onPage()||busy)return;const e=epoch;setBusy(true);try{await fn();if(e!==epoch||!onPage())return;const s=await api('snapshot');if(e===epoch&&onPage()){render(s,false);message('השינויים נשמרו');}}catch(err){handleError(err,e);}finally{if(e===epoch)setBusy(false);}}
 function openEdit(id){if(!onPage()||busy)return;const p=snapshot?.playlists?.find(x=>x.id===id&&!x.deleted_at);if(!p)return;editing=id;$('jukeboxEditTitle').textContent='עריכת רשימת רקע';$('jukeboxEditName').value=p.name;$('jukeboxEditItems').value=(snapshot.items||[]).filter(x=>x.playlist_id===id&&!x.archived_at).sort((a,b)=>a.position-b.position).map(x=>[x.video_id,x.title,x.kind].join(' | ')).join('\n');$('jukeboxEditPlaylist').classList.remove('hidden');$('jukeboxEditName').focus();}
 function parseItems(){const lines=$('jukeboxEditItems').value.split(/\r?\n/).filter(x=>x.trim());if(lines.length>500)throw Error('invalid_payload');return lines.map(line=>{const [video_id,title,kind,...extra]=line.split('|').map(x=>x.trim());if(extra.length||!/^[A-Za-z0-9_-]{11}$/.test(video_id||'')||!title||title.length>300||!['regular','mix'].includes(kind))throw Error('invalid_payload');return {video_id,title,kind};});}
 async function searchYoutube(){
  if(!onPage()||busy)return;
  const query=$('jukeboxSearchQuery').value.trim(),key=$('jukeboxSearchKey').value.trim()||localStorage.getItem('jukebox-dev-key')||'';
  const host=$('jukeboxSearchResults'),notice=$('jukeboxSearchStatus'),g=++searchGeneration;
  host.replaceChildren();
  if(query.length<2){notice.textContent='יש להזין לפחות שתי אותיות.';return;}
  if(!key){notice.textContent='נדרש מפתח YouTube API מוגבל לאתר. הזן אותו בשדה שמעל החיפוש.';return;}
  notice.textContent='מחפש…';
  try{
   const params=new URLSearchParams({part:'snippet',type:'video',videoEmbeddable:'true',videoSyndicated:'true',maxResults:'20',q:query,key});
   const response=await fetch('https://www.googleapis.com/youtube/v3/search?'+params,{cache:'no-store',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('YouTube '+response.status);
   const result=await response.json();
   if(!onPage()||g!==searchGeneration)return;
   const tracks=(result.items||[]).filter(x=>/^[A-Za-z0-9_-]{11}$/.test(x.id?.videoId||''));
   notice.textContent=tracks.length?'נמצאו '+tracks.length+' תוצאות. בחר רשימת רקע להוספה.':'לא נמצאו תוצאות מתאימות.';
   for(const t of tracks){
    const video_id=t.id.videoId,title=String(t.snippet?.title||'').slice(0,300);
    row(host,title,String(t.snippet?.channelTitle||''),[['הוסף לרקע',()=>addSearchTrack(video_id,title),'primary']]);
   }
  }catch(e){if(onPage()&&g===searchGeneration)notice.textContent='החיפוש נכשל. בדוק את מפתח YouTube, הרשאות האתר והמכסה.';}
 }
 async function addSearchTrack(video_id,title){
  const id=$('jukeboxSearchPlaylist').value;
  if(!id){$('jukeboxSearchStatus').textContent='יש לבחור רשימת רקע קיימת.';return;}
  await run(async()=>{
   const latest=await api('snapshot'),p=latest.playlists?.find(x=>x.id===id&&!x.deleted_at);
   if(!p)throw Error('invalid_payload');
   const items=(latest.items||[]).filter(x=>x.playlist_id===id&&!x.archived_at).sort((a,b)=>a.position-b.position).map(x=>({video_id:x.video_id,title:x.title,kind:x.kind}));
   if(items.some(x=>x.video_id===video_id)){ $('jukeboxSearchStatus').textContent='השיר כבר נמצא ברשימה.';return;}
   if(items.length>=500)throw Error('invalid_payload');
   items.push({video_id,title,kind:'regular'});
   await api('playlist_save',{id,name:p.name,items});
   $('jukeboxSearchStatus').textContent='השיר נוסף לרשימת הרקע.';
  });
 }
 function init(){if(initialized)return;initialized=true;
  $('jukeboxSellBtn').addEventListener('click',openSale);
  $('jukeboxSaleClose').addEventListener('click',closeSale);
  $('jukeboxSearchForm').addEventListener('submit',e=>{e.preventDefault();searchYoutube();});
  $('jukeboxOpenBtn').addEventListener('click',()=>{if(allowed())go('jukeboxPage');});
  $('jukeboxBackSystem').addEventListener('click',()=>go('systemPage'));
  $('jukeboxBackPos').addEventListener('click',()=>go('posPage'));
  $('jukeboxRefreshBtn').addEventListener('click',()=>refresh(false));
  $('jukeboxSettingsForm').addEventListener('input',()=>{settingsDirty=true;});
  $('jukeboxSettingsForm').addEventListener('submit',e=>{e.preventDefault();run(async()=>{const price=Number($('jukeboxPrice').value);if(!Number.isFinite(price)||price<0||price>10000)throw Error('invalid_payload');await api('configure',{enabled:$('jukeboxEnabled').checked,open:$('jukeboxIsOpen').checked,paused:$('jukeboxPaused').checked,price});settingsDirty=false;});});
  $('jukeboxPairBtn').addEventListener('click',()=>{if(confirm('ליצור אסימון צימוד חדש לטאבלט?'))run(async()=>{const r=await api('pair');if(!/^[a-f0-9]{64}$/i.test(r?.pair_token||''))throw Error('jukebox_operation_failed');clearPair();$('jukeboxPairToken').value=r.pair_token;$('jukeboxPairBox').classList.remove('hidden');pairTimer=setTimeout(clearPair,300000);});});
  $('jukeboxCopyPair').addEventListener('click',async()=>{if(!onPage()||!$('jukeboxPairToken').value)return;try{await navigator.clipboard.writeText($('jukeboxPairToken').value);message('אסימון הצימוד הועתק');}catch{$('jukeboxPairToken').focus();$('jukeboxPairToken').select();}});
  $('jukeboxUnlockBtn').addEventListener('click',()=>run(()=>api('unlock')));
  $('jukeboxRevokeBtn').addEventListener('click',()=>{if(confirm('לבטל את צימוד הטאבלט?'))run(()=>api('revoke_device'));});
  $('jukeboxCreatePlaylist').addEventListener('submit',e=>{e.preventDefault();run(async()=>{const name=$('jukeboxNewName').value.trim();if(!name)throw Error('invalid_payload');await api('playlist_create',{name});$('jukeboxNewName').value='';});});
  $('jukeboxEditPlaylist').addEventListener('submit',e=>{e.preventDefault();run(async()=>{const id=editing,name=$('jukeboxEditName').value.trim();if(!id||!name)throw Error('invalid_payload');await api('playlist_save',{id,name,items:parseItems()});closeEdit();});});
  $('jukeboxCloseEdit').addEventListener('click',closeEdit);
  window.addEventListener('pagehide',()=>{if(opened)clear();});
  setInterval(()=>{if(opened&&!allowed())syncVisibility();else if(onPage()&&!busy)refresh(false);},15000);
  syncVisibility();
 }
 return {init,allowed,syncVisibility,onNavigation,closeForLock};
})();
