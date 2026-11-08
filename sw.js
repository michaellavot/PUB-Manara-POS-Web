/* PUB Manara POS Web V0.9.23 — network-first, safe offline cache fallback.
   Do not clear IndexedDB or localStorage: they contain the original POS archive.
   Waiting workers activate only after explicit approval through the updater UI. */
const CACHE='manara-pos-web-v0.9.23-20261108';
const PRECACHE=["./","./index.html","./styles.css?v=0.9.23","./app.js?v=0.9.23","./updater.js?v=0.9.23","./db.js","./xlsx.js","./manifest.webmanifest","./assets/main_logo.gif","./assets/billing_left_texture.gif","./assets/beer_icon.gif","./assets/app_icon_192.png","./assets/app_icon_512.png","./assets/rubik-variable.ttf","./remote.js?v=0.9.23"];
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
