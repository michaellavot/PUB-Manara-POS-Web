// V0.6 migration from V0.5: activate without reloading existing clients. Later versions will wait for user approval.
const CACHE='manara-pos-web-v0.7-20261108';
const PRECACHE=['./','./index.html','./styles.css','./app.js','./updater.js','./db.js','./xlsx.js','./manifest.webmanifest','./assets/main_logo.gif','./assets/billing_left_texture.gif','./assets/beer_icon.gif','./assets/app_icon_192.png','./assets/app_icon_512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('manara-pos-web-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('message',event=>{if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
 const url=new URL(event.request.url);
 if(url.pathname.endsWith('/version.json')){event.respondWith(fetch(event.request,{cache:'no-store'}));return;}
 event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});
