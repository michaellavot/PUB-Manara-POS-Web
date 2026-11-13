'use strict';
/* Native POS owner screen. The only backend is Jukebox's scoped owner bridge. */
const JukeboxAdmin=(()=>{
 const $=id=>document.getElementById(id);
 const URL='https://srudevbrupqaemgrrhcg.supabase.co/functions/v1/jukebox-pos-owner';
 const KEY='sb_publishable_c4yDW12R7D3SZej11VNPpg_ZI_CiHC-';
 const errors={owner_required:'נדרש אימות בעלים מחדש בקופה.',owner_or_action_denied:'הפעולה אינה מורשית. פעולות חיוב וקודים אמיתיים אינן זמינות.',action_disabled:'פעולה זו אינה זמינה דרך הקופה.',invalid_payload:'הפרטים אינם תקינים.',jukebox_operation_failed:'פעולת הג׳וקבוקס נכשלה. בדוק את הנתונים ונסה שוב.',jukebox_unavailable:'שרת הג׳וקבוקס אינו זמין כרגע.',origin_denied:'הכתובת אינה מורשית.'};
 const labels={queued:'בתור',playing:'מתנגן',held:'בהשהיה',failed:'נכשל',completed:'הושלם',verified:'נוגן ואומת',cancelled:'בוטל',pending_approval:'ממתין לאישור',expired:'פג תוקף'};
 let initialized=false,epoch=0,busy=false,controller=null,snapshot=null,editing=null,settingsDirty=false,pairTimer=null,opened=false,searchGeneration=0;
 // A separate sale permission will be enabled for employees later; currently owner only.
 const canSell=()=>allowed();
 let selectedCustomer=null,backgroundMode='song',libraryMode='pub',apiKey='',advancedOpen=false;
 const personalPrefix=()=>{const id=RemotePos.session?.user?.id||'';return id?'[personal:'+id+'] ':'';};
 const isPersonal=p=>p?.is_personal===true||String(p?.name||'').startsWith('[personal:');
 const ownPersonal=p=>p?.is_personal===true||(Boolean(personalPrefix())&&String(p?.name||'').startsWith(personalPrefix()));
 const publicName=p=>String(p?.name||'').startsWith(personalPrefix())&&personalPrefix()?p.name.slice(personalPrefix().length):p.name;
 let searchTracks=[];
 function clearSearch(){searchGeneration++;searchTracks=[];$('jukeboxSearchResults').replaceChildren();$('jukeboxSearchQuery').value='';$('jukeboxSearchStatus').textContent='';$('jukeboxSearchKey').value='';}
 function openSale(){if(canSell())go('jukeboxPage');}
 function setAdvanced(open){advancedOpen=!!open;$('jukeboxAdvanced').classList.toggle('hidden',!advancedOpen);$('jukeboxAdvancedBtn').setAttribute('aria-expanded',String(advancedOpen));if(advancedOpen){$('jukeboxKeyStatus').textContent=apiKey?'מפתח שמור במחשב זה. עדיין אינו מסונכרן לטאבלט.':'לא הוגדר מפתח במחשב זה.';}}
 function showMode(mode){backgroundMode=mode;const library=mode==='pub'||mode==='personal';if(library)libraryMode=mode;for(const [id,m] of [['jukeboxModeSong','song'],['jukeboxModeMix','mix'],['jukeboxModePub','pub'],['jukeboxModePersonal','personal']])$(id).setAttribute('aria-pressed',String(mode===m));$('jukeboxSearchPanel').classList.toggle('hidden',library);$('jukeboxLibraryPanel').classList.toggle('hidden',!library);$('jukeboxSearchQuery').placeholder=mode==='mix'?'חפש מיקס ארוך ביוטיוב...':'חפש שיר או אמן ביוטיוב...';$('jukeboxAutoMixLabel').classList.toggle('hidden',mode!=='song');if(library){closeEdit();renderLibrary();}else{clearSearch();renderSearchOptions();}}
 function selectSaleCustomer(c){selectedCustomer=c||null;$('jukeboxCustomerSearch').value=c?.name||'';$('jukeboxSaleCustomer').textContent=c?'לקוח: '+c.name:'לא נבחר לקוח';$('jukeboxCustomerResults').classList.add('hidden');$('jukeboxCustomerSearch').setAttribute('aria-expanded','false');}
 function renderCustomerChoices(){const host=$('jukeboxCustomerResults'),q=norm($('jukeboxCustomerSearch').value);host.replaceChildren();const customers=(state.customers||[]).filter(c=>c.active&&customerNameMatches(c.name,q)).slice(0,40);for(const c of customers){const b=node('button',c.name,'button secondary');b.type='button';b.setAttribute('role','option');b.setAttribute('aria-selected',String(selectedCustomer?.id===c.id));b.addEventListener('click',()=>selectSaleCustomer(c));host.append(b);}if(!customers.length)host.append(node('p','לא נמצאו לקוחות','small-note'));host.classList.remove('hidden');$('jukeboxCustomerSearch').setAttribute('aria-expanded','true');}
 function allowed(){const u=RemotePos.employee||{};return RemotePos.active===true&&RemotePos.authenticated===true&&u.active===true&&u.is_owner===true&&u.owner_terminal===true&&u.pin_login===true&&Number(RemotePos.session?.pos_valid_until)>Date.now();}
 const onPage=()=>opened&&$('jukeboxPage')?.classList.contains('active')&&allowed();
 function message(t,error=false){const el=$('jukeboxMessage');el.textContent=t;el.className='status '+(error?'error':t?'success':'');}
 function connection(t,ok=null){const el=$('jukeboxConnection');el.textContent=t;el.classList.toggle('jukebox-connected',ok===true);el.classList.toggle('jukebox-disconnected',ok===false);}
 function node(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=String(text);if(cls)x.className=cls;return x;}
 function button(text,fn,kind='secondary'){const b=node('button',text,'button '+kind);b.type='button';b.dataset.jbAction='';b.disabled=busy;b.addEventListener('click',fn);return b;}
 function setBusy(value){busy=value;for(const b of $('jukeboxPage').querySelectorAll('[data-jb-action]'))b.disabled=value;$('jukeboxRefreshBtn').disabled=value;renderTransport();}
 function closeEdit(){editing=null;$('jukeboxEditPlaylist').classList.add('hidden');$('jukeboxEditName').value='';$('jukeboxEditItems').value='';}
 function clearPair(){clearTimeout(pairTimer);pairTimer=null;$('jukeboxPairToken').value='';$('jukeboxPairBox').classList.add('hidden');}
 function clear(){epoch++;opened=false;clearSearch();selectSaleCustomer(null);setAdvanced(false);apiKey='';$('jukeboxHistory').replaceChildren();$('jukeboxIssuedCode').classList.add('hidden');$('jukeboxIssuedCode').textContent='';controller?.abort();controller=null;snapshot=null;settingsDirty=false;clearPair();closeEdit();for(const id of ['jukeboxDevices','jukeboxPlaylists','jukeboxQueue'])$(id).replaceChildren();$('jukeboxCodeSummary').textContent='';$('jukeboxNewName').value='';$('jukeboxPlaylistCount').textContent='0 רשימות';$('jukeboxQueueCount').textContent='0 בתור';$('jukeboxContent').classList.add('hidden');$('jukeboxSettingsForm').reset();message('');connection('ממתין לחיבור');setBusy(false);}
 function go(id){document.querySelector('.tab[data-page="'+id+'"]')?.click();}
 function syncVisibility(){if(!initialized)return;const ok=allowed();$('jukeboxOwnerEntry').classList.toggle('hidden',!ok);$('jukeboxSellBtn').classList.toggle('hidden',!canSell());$('jukeboxPage').classList.toggle('hidden',!ok);if(!ok&&opened){const wasActive=$('jukeboxPage').classList.contains('active');clear();if(wasActive)go('posPage');}}
 function closeForLock(){if(!initialized)return;if(opened){clear();go('systemPage');}$('jukeboxPage').classList.add('hidden');}
 function onNavigation(id){if(!initialized)return;if(id==='jukeboxPage'){if(!allowed()){clear();$('jukeboxPage').classList.add('hidden');return;}if(opened)return;opened=true;$('jukeboxPage').classList.remove('hidden');selectSaleCustomer(state.employeeCharge?null:state.selectedCustomer);try{apiKey=localStorage.getItem('jukebox-dev-key')||'';}catch{apiKey='';}setAdvanced(false);showMode('song');refresh(true);}else if(opened){clear();}}
 async function api(action,data={}){
  const valid=onPage;
  if(!valid())throw Error('owner_required');
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
 function visiblePlaylists(){return (snapshot?.playlists||[]).filter(p=>!p.is_temporary&&(!isPersonal(p)||ownPersonal(p)));}
 function renderSearchOptions(){const select=$('jukeboxSearchPlaylist'),prev=select.value;select.replaceChildren(new Option('בחר רשימת רקע',''));for(const p of visiblePlaylists().filter(p=>!p.deleted_at))select.add(new Option((ownPersonal(p)?'אישי · ':'')+publicName(p),p.id));if([...select.options].some(o=>o.value===prev))select.value=prev;else if(snapshot?.settings?.active_playlist)select.value=snapshot.settings.active_playlist;}
 function renderLibrary(){
  const host=$('jukeboxPlaylists');host.replaceChildren();const personal=libraryMode==='personal',lists=visiblePlaylists().filter(p=>personal?ownPersonal(p):!isPersonal(p));
  $('jukeboxLibraryTitle').textContent=personal?'הפלייליסטים שלי':'פלייליסטים של הפאב';
  $('jukeboxLibraryNote').textContent=personal?'רשימות אישיות נשמרות בענן תחת החשבון שלך. הרשאות עובדים טרם נפתחו.':'בחר רשימה קיימת או צור רשימה חדשה.';
  $('jukeboxPlaylistCount').textContent=lists.filter(p=>!p.deleted_at).length+' רשימות';
  for(const p of lists){const count=(snapshot?.items||[]).filter(i=>i.playlist_id===p.id&&!i.archived_at).length,active=snapshot?.settings?.active_playlist===p.id;
   const actions=p.deleted_at?[['שחזר',()=>run(()=>api('playlist_restore',{id:p.id}))]]:[['ערוך',()=>openEdit(p.id)],['בחר לרקע',()=>run(()=>api('playlist_select',{id:p.id})),'primary'],['העבר לארכיון',()=>{if(confirm('להעביר את הרשימה לארכיון?'))run(()=>api('playlist_archive',{id:p.id}));},'warning']];
   row(host,publicName(p),(p.deleted_at?'בארכיון':active?'פעילה ברקע':'רשימת רקע')+' · '+count+' שירים',actions);
  }
  if(!host.children.length)host.append(node('p','אין עדיין רשימות. צור רשימה חדשה.','small-note'));
 }
 function queueRow(host,o,history=false){const tr=node('tr'),title=node('td',o.title||'—'),st=node('td'),pill=node('span',(labels[o.status]||o.status)+(o.is_test?' · D':''),'jukebox-status-pill'),td=node('td'),controls=node('div',undefined,'jukebox-actions');pill.dataset.state=o.status;st.append(pill);tr.append(title,st,td);
  const a=[];if(!history&&o.is_test===true)for(const [action,label,states] of [['hold','השהה',['queued']],['release','שחרר',['held']],['retry','נסה שוב',['failed']],['cancel','בטל',['queued','held','failed','pending_approval']]])if(states.includes(o.status))a.push([label,()=>{if(action!=='cancel'||confirm('לבטל את שיר הבדיקה?'))run(()=>api(action,{id:o.id}));},action==='cancel'?'warning':'secondary']);
  for(const [label,fn,kind] of a)controls.append(button(label,fn,kind));if(!a.length)controls.append(node('span',history?'היסטוריה':o.status==='playing'?'מתנגן בטאבלט':'—','small-note'));td.append(controls);host.append(tr);
 }
 function emptyTable(host,txt){const tr=node('tr'),td=node('td',txt,'small-note');td.colSpan=3;tr.append(td);host.append(tr);}
 function renderTransport(){const s=snapshot?.settings||{},playing=(snapshot?.orders||[]).find(o=>o.status==='playing'),control=snapshot?.player_control||{},hasBackground=(snapshot?.items||[]).some(i=>i.playlist_id===s.active_playlist&&!i.archived_at);$('jukeboxPauseBtn').textContent=s.paused?'▶ המשך':'⏸ השהה';$('jukeboxPauseBtn').disabled=busy||!snapshot||!s.enabled;const available=!busy&&s.enabled&&control.available===true&&hasBackground&&!playing;$('jukeboxPrevBtn').disabled=!available;$('jukeboxNextBtn').disabled=!available;$('jukeboxStopBtn').disabled=!available;$('jukeboxTransportNote').textContent=playing?'שיר לקוח מתנגן. הבא, הקודם ועצור חסומים.':!control.available?'יש לרענן ולהפעיל את הטאבלט המעודכן כדי לשלוט בשירי הרקע.':!hasBackground?'בחר רשימת רקע המכילה שירים.':'שליטה במוזיקת הרקע זמינה.';}
 function render(s,forceSettings=false){
  if(!onPage())return;snapshot=s;$('jukeboxContent').classList.remove('hidden');connection('מחובר לג׳וקבוקס',true);
  const settings=s.settings||{},devices=s.devices||[],playing=(s.orders||[]).find(o=>o.status==='playing'),list=(s.playlists||[]).find(p=>p.id===settings.active_playlist);
  $('jukeboxMode').textContent=RemotePos.testMode?'מצב תחזוקה · D':'מצב עבודה';
  $('jukeboxDeviceStatus').textContent=devices.some(d=>!d.revoked_at)?'טאבלט מצומד':'אין טאבלט מצומד';
  $('jukeboxSalePrice').textContent=settings.price==null?'מחיר לא הוגדר':Number(settings.price).toFixed(2)+' ₪ לשיר';
  $('jukeboxSaleConfirm').disabled=true;$('jukeboxSaleNotice').textContent='חיוב יירשם רק לאחר ניגון מאומת. חיבור הנפקת הקוד והחיוב טרם הושלם.';
  if(selectedCustomer&&!state.customers.some(c=>c.id===selectedCustomer.id&&c.active))selectSaleCustomer(null);
  $('jukeboxPlayerMode').textContent=settings.paused?'מושהה':playing?'שיר לקוח':settings.enabled?'רקע':'כבוי';
  const control=s.player_control||{},track=(s.items||[]).find(i=>i.id===control.item_id&&!i.archived_at);
  const actual=control.available===true&&control.state!=='idle'&&track;
  $('jukeboxNow').textContent=playing?.title||(actual?track.title:list?'רשימת רקע: '+publicName(list):'אין שיר לקוח מתנגן');
  const pos=playing?Number(s.guest_progress?.position||0):actual?Number(control.position||0):0,duration=playing?Number(playing.duration||0):actual?Number(control.duration||0):0;
  const fmt=n=>Math.floor(Math.max(0,n)/60)+':'+String(Math.floor(Math.max(0,n)%60)).padStart(2,'0');
  $('jukeboxNowDetail').textContent=playing?'שיר לקוח · '+fmt(pos)+' / '+fmt(duration):actual?(track.kind==='mix'?'מיקס · ':'מוזיקת רקע · ')+fmt(pos)+' / '+fmt(duration):list?'הרשימה הפעילה · ממתין לדיווח מהטאבלט':'בחר רשימת רקע כדי להתחיל.';
  $('jukeboxProgress').value=duration>0?Math.min(100,100*pos/duration):0;
  renderTransport();
  if(forceSettings||!settingsDirty){$('jukeboxEnabled').checked=settings.enabled===true;$('jukeboxIsOpen').checked=settings.is_open===true;$('jukeboxPaused').checked=settings.paused===true;$('jukeboxPrice').value=settings.price??'';settingsDirty=false;}
  const d=$('jukeboxDevices');d.replaceChildren();for(const dev of devices)row(d,dev.name||'טאבלט',dev.revoked_at?'מנותק':dev.locked_until&&Date.parse(dev.locked_until)>Date.now()?'מצומד · נעול':'מצומד');if(!d.children.length)d.append(node('p','אין טאבלט מצומד.','small-note'));
  renderSearchOptions();renderLibrary();
  const q=$('jukeboxQueue'),history=$('jukeboxHistory');q.replaceChildren();history.replaceChildren();const all=s.orders||[],active=all.filter(o=>['playing','queued','held','failed','pending_approval'].includes(o.status));
  const rank=o=>o.status==='playing'?0:o.status==='queued'?1:2;active.sort((a,b)=>rank(a)-rank(b)||Number(a.position)-Number(b.position));
  $('jukeboxQueueCount').textContent=active.length+' בתור';for(const o of active)queueRow(q,o);if(!active.length)emptyTable(q,'התור ריק. מוזיקת הרקע תמשיך להתנגן.');
  const past=all.filter(o=>['verified','completed','cancelled'].includes(o.status)).slice(0,100);for(const o of past)queueRow(history,o,true);if(!past.length)emptyTable(history,'אין שירים בהיסטוריה.');
  $('jukeboxCodeSummary').textContent='קודי בדיקה פעילים: '+Number(s.code_summary?.active||0)+' · חיובים והנפקת קודים מהקופה עדיין חסומים.';
 }
 function errorText(e){return errors[e?.message]||'לא ניתן להשלים את הפעולה. בדוק את החיבור ונסה שוב.';}
 function handleError(e,expected){if(expected!==epoch||!opened)return;if(e?.message==='owner_required'){if(RemotePos.employee)RemotePos.employee={...RemotePos.employee,is_owner:false};clear();$('jukeboxPage').classList.add('hidden');go('systemPage');renderPermissions();return;}message(errorText(e),true);connection('נדרש רענון',false);}
 async function refresh(force=false){if(!onPage()||busy)return;const e=epoch;setBusy(true);if(!snapshot)connection('מתחבר…');try{const s=await api('snapshot');if(e===epoch&&onPage()){render(s,force);if(force)message('מצב הג׳וקבוקס עודכן');}}catch(err){handleError(err,e);}finally{if(e===epoch)setBusy(false);}}
 async function run(fn){if(!onPage()||busy)return;const e=epoch;setBusy(true);try{await fn();if(e!==epoch||!onPage())return;const s=await api('snapshot');if(e===epoch&&onPage()){render(s,false);message('השינויים נשמרו');}}catch(err){handleError(err,e);}finally{if(e===epoch)setBusy(false);}}
 function openEdit(id){if(!onPage()||busy)return;const p=snapshot?.playlists?.find(x=>x.id===id&&!x.deleted_at);if(!p)return;editing=id;$('jukeboxEditTitle').textContent='עריכת רשימת רקע';$('jukeboxEditName').value=publicName(p);$('jukeboxEditItems').value=(snapshot.items||[]).filter(x=>x.playlist_id===id&&!x.archived_at).sort((a,b)=>a.position-b.position).map(x=>[x.video_id,x.title,x.kind].join(' | ')).join('\n');$('jukeboxEditPlaylist').classList.remove('hidden');$('jukeboxEditName').focus();}
 function parseItems(){const lines=$('jukeboxEditItems').value.split(/\r?\n/).filter(x=>x.trim());if(lines.length>500)throw Error('invalid_payload');return lines.map(line=>{const [video_id,title,kind,...extra]=line.split('|').map(x=>x.trim());if(extra.length||!/^[A-Za-z0-9_-]{11}$/.test(video_id||'')||!title||title.length>300||!['regular','mix'].includes(kind))throw Error('invalid_payload');return {video_id,title,kind};});}
 async function searchYoutube(){
  if(!onPage()||busy)return;
  const query=$('jukeboxSearchQuery').value.trim(),key=apiKey;
  const host=$('jukeboxSearchResults'),notice=$('jukeboxSearchStatus'),g=++searchGeneration;
  host.replaceChildren();
  if(query.length<2){notice.textContent='יש להזין לפחות שתי אותיות.';return;}
  if(!key){notice.textContent='נדרש מפתח YouTube API מוגבל לאתר. הגדר אותו פעם אחת בניהול מתקדם.';return;}
  notice.textContent='מחפש…';
  try{
   const mode=backgroundMode;const params=new URLSearchParams({part:'snippet',type:'video',videoEmbeddable:'true',videoSyndicated:'true',maxResults:'20',q:query,key,...(mode==='mix'?{videoDuration:'long'}:{})});
   const response=await fetch('https://www.googleapis.com/youtube/v3/search?'+params,{cache:'no-store',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('YouTube '+response.status);
   const result=await response.json();
   if(!onPage()||g!==searchGeneration)return;
   const tracks=(result.items||[]).filter(x=>/^[A-Za-z0-9_-]{11}$/.test(x.id?.videoId||''));searchTracks=tracks.map(t=>({video_id:t.id.videoId,title:String(t.snippet?.title||'').slice(0,300),kind:mode==='mix'?'mix':'regular'})).filter(t=>t.title);
   notice.textContent=tracks.length?'נמצאו '+tracks.length+' תוצאות. בחר רשימת רקע להוספה.':'לא נמצאו תוצאות מתאימות.';
   for(const t of tracks){
    const video_id=t.id.videoId,title=String(t.snippet?.title||'').slice(0,300);
    row(host,title,String(t.snippet?.channelTitle||''),[['נגן כרקע',()=>playBackground(video_id,title,mode==='mix'?'mix':'regular'),'primary'],['הוסף לפלייליסט',()=>addSearchTrack(video_id,title,mode==='mix'?'mix':'regular')]]);
   }
  }catch(e){if(onPage()&&g===searchGeneration)notice.textContent='החיפוש נכשל. בדוק את מפתח YouTube, הרשאות האתר והמכסה.';}
 }
 async function playBackground(video_id,title,kind='regular'){
  if(!onPage()||busy)return;
  if(!snapshot?.settings?.enabled){$('jukeboxSearchStatus').textContent='הפעל את הג׳וקבוקס בניהול מתקדם לפני בחירת רקע.';return;}
  const items=[{video_id,title,kind}];
  if(kind==='regular'&&$('jukeboxAutoMix').checked){const seen=new Set([video_id]);for(const t of searchTracks){if(!seen.has(t.video_id)&&items.length<12){seen.add(t.video_id);items.push({...t,kind:'regular'});}}}
  await run(async()=>{const temp=await api('playlist_create',{name:'רקע מיידי',temporary:true});if(!temp?.id)throw Error('jukebox_operation_failed');await api('playlist_save',{id:temp.id,name:'רקע מיידי',items});await api('playlist_select',{id:temp.id});$('jukeboxSearchStatus').textContent='הרקע נבחר. '+(items.length>1?'אחריו יתנגנו עוד '+(items.length-1)+' שירים מתוצאות החיפוש.':'');});
 }
 async function addSearchTrack(video_id,title,kind='regular'){
  const id=$('jukeboxSearchPlaylist').value;
  if(!id){$('jukeboxSearchStatus').textContent='יש לבחור רשימת רקע קיימת.';return;}
  await run(async()=>{
   const latest=await api('snapshot'),p=latest.playlists?.find(x=>x.id===id&&!x.deleted_at);
   if(!p||(isPersonal(p)&&!ownPersonal(p)))throw Error('invalid_payload');
   const items=(latest.items||[]).filter(x=>x.playlist_id===id&&!x.archived_at).sort((a,b)=>a.position-b.position).map(x=>({video_id:x.video_id,title:x.title,kind:x.kind}));
   if(items.some(x=>x.video_id===video_id)){ $('jukeboxSearchStatus').textContent='השיר כבר נמצא ברשימה.';return;}
   if(items.length>=500)throw Error('invalid_payload');
   items.push({video_id,title,kind});
   await api('playlist_save',{id,name:p.name,items});
   $('jukeboxSearchStatus').textContent='השיר נוסף לרשימת הרקע.';
  });
 }
 function init(){if(initialized)return;initialized=true;
  $('jukeboxSellBtn').addEventListener('click',openSale);
  $('jukeboxAdvancedBtn').addEventListener('click',()=>{if(onPage())setAdvanced(!advancedOpen);});
  $('jukeboxCustomerSearch').addEventListener('focus',renderCustomerChoices);
  $('jukeboxCustomerSearch').addEventListener('input',()=>{selectedCustomer=null;$('jukeboxSaleCustomer').textContent='לא נבחר לקוח';renderCustomerChoices();});
  $('jukeboxCustomerSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('jukeboxCustomerResults').querySelector('button')?.click();}else if(e.key==='Escape'){$('jukeboxCustomerResults').classList.add('hidden');$('jukeboxCustomerSearch').setAttribute('aria-expanded','false');}});
  document.addEventListener('click',e=>{if(!e.target.closest('.jukebox-sale-panel')){$('jukeboxCustomerResults').classList.add('hidden');$('jukeboxCustomerSearch').setAttribute('aria-expanded','false');}});
  for(const [id,m] of [['jukeboxModeSong','song'],['jukeboxModeMix','mix'],['jukeboxModePub','pub'],['jukeboxModePersonal','personal']])$(id).addEventListener('click',()=>{if(onPage())showMode(m);});
  $('jukeboxPauseBtn').addEventListener('click',()=>{if(snapshot?.settings?.enabled)run(()=>api('configure',{paused:!snapshot.settings.paused}));});
  for(const [id,cmd] of [['jukeboxPrevBtn','previous'],['jukeboxNextBtn','next'],['jukeboxStopBtn','stop']])$(id).addEventListener('click',()=>{if(!$(id).disabled)run(()=>api('configure',{background_command:cmd}));});
  $('jukeboxSaveKey').addEventListener('click',()=>{if(!onPage()||!advancedOpen)return;const key=$('jukeboxSearchKey').value.trim();if(!/^[A-Za-z0-9_-]{20,100}$/.test(key)){$('jukeboxKeyStatus').textContent='מפתח לא תקין.';return;}try{localStorage.setItem('jukebox-dev-key',key);apiKey=key;$('jukeboxSearchKey').value='';$('jukeboxKeyStatus').textContent='המפתח נשמר במחשב זה בלבד.';}catch{$('jukeboxKeyStatus').textContent='לא ניתן לשמור את המפתח במכשיר.';}});
  $('jukeboxForgetKey').addEventListener('click',()=>{if(!onPage()||!advancedOpen)return;try{localStorage.removeItem('jukebox-dev-key');apiKey='';$('jukeboxSearchKey').value='';$('jukeboxKeyStatus').textContent='המפתח הוסר מהמחשב.';}catch{$('jukeboxKeyStatus').textContent='לא ניתן להסיר את המפתח.';}});
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
  $('jukeboxCreatePlaylist').addEventListener('submit',e=>{e.preventDefault();run(async()=>{const name=$('jukeboxNewName').value.trim();if(!name)throw Error('invalid_payload');if(name.startsWith('[personal:'))throw Error('invalid_payload');await api('playlist_create',{name,personal:libraryMode==='personal'});$('jukeboxNewName').value='';});});
  $('jukeboxEditPlaylist').addEventListener('submit',e=>{e.preventDefault();run(async()=>{const id=editing,name=$('jukeboxEditName').value.trim();if(!id||!name)throw Error('invalid_payload');const p=snapshot?.playlists?.find(x=>x.id===id);if(!p||(isPersonal(p)&&!ownPersonal(p))||name.startsWith('[personal:'))throw Error('invalid_payload');const stored=String(p.name).startsWith('[personal:')?personalPrefix()+name:name;if(stored.length>100)throw Error('invalid_payload');await api('playlist_save',{id,name:stored,items:parseItems()});closeEdit();});});
  $('jukeboxCloseEdit').addEventListener('click',closeEdit);
  window.addEventListener('pagehide',()=>{if(opened)clear();});
  setInterval(()=>{if(opened&&!allowed())syncVisibility();else if(onPage()&&!busy)refresh(false);},5000);
  syncVisibility();
 }
 return {init,allowed,syncVisibility,onNavigation,closeForLock};
})();
