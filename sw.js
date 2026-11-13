/* PUB Manara POS Web V2.0.23 — network-first, safe offline cache fallback.
   Do not clear IndexedDB or localStorage: they contain the original POS archive.
   Waiting workers activate only after explicit approval through the updater UI. */
const CACHE='manara-pos-web-v2.0.23-jukebox';
const PRECACHE=["./","./index.html","./share.html","./qrcode.min.js?v=2.0.23","./styles.css?v=2.0.23","./draft_guard.js?v=2.0.23","./report_widgets.js?v=2.0.23","./app.js?v=2.0.23","./updater.js?v=2.0.23","./db.js","./xlsx.js","./manifest.webmanifest?v=0.9.29","./assets/dark_wood_background.svg","./assets/main_logo.gif","./assets/billing_left_texture.gif","./assets/beer_icon.gif","./assets/app_icon_192.png?v=0.9.29","./assets/app_icon_512.png?v=0.9.29","./assets/app_icon_maskable_192.png?v=0.9.29","./assets/app_icon_maskable_512.png?v=0.9.29","./assets/rubik-variable.ttf","./legacy_db_import.js?v=2.0.23","./remote.js?v=2.0.23","./archive_admin.js?v=2.0.23","./backup_manager.js?v=2.0.23","./drive_backup.js?v=2.0.23","./jukebox_admin.js?v=2.0.23"];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PRECACHE)));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys()
  .then(keys=>Promise.all(keys.filter(key=>key.startsWith('manara-pos-web-')&&key!==CACHE).map(key=>caches.delete(key))))
  .then(()=>self.clients.claim()));
});
self.addEventListener('message',event=>{
 if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting();
});
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 if(url.pathname.endsWith('/version.json')){
  event.respondWith(fetch(request,{cache:'no-store'}));
  return;
 }
 event.respondWith((async()=>{
  try{
   // Refresh static code from the network, bypassing both browser HTTP cache
   // and old PWA cache. Cache the response for the next offline opening.
   const response=await fetch(request,{cache:'no-store'});
   if(response.ok){
    try{const cache=await caches.open(CACHE);await cache.put(request,response.clone());}
    catch(error){console.warn('Could not refresh offline cache:',error);}
   }
   return response;
  }catch(error){
   // Retain offline app availability; query strings on scripts are intentionally
   // ignored so a versioned script may match its pre-cached counterpart.
   const cached=await caches.match(request,{ignoreSearch:true});
   if(cached)return cached;
   if(request.mode==='navigate'){
    const fallback=await caches.match('./index.html');
    if(fallback)return fallback;
   }
   throw error;
  }
 })());
});
