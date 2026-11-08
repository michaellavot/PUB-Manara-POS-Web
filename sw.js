const CACHE='manara-pos-web-v0.5-20261108';
const PRECACHE=['./','./index.html','./styles.css','./app.js','./db.js','./xlsx.js','./manifest.webmanifest','./assets/main_logo.gif','./assets/billing_left_texture.gif','./assets/beer_icon.gif','./assets/app_icon_192.png','./assets/app_icon_512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('manara-pos-web-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));});
