'use strict';
const CACHE='installation-progress-shell-1.6.1';
const ASSETS=['./','./index.html','./app.css','./app.js','./storage.js','./manifest.webmanifest','./icon.svg',
  './icon-192.png','./icon-512.png','./shared/gate-config.js','./shared/production-core.js','./shared/weekly-core.js','./shared/files.js','./vendor/pako.min.js','./vendor/jszip.min.js'];
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(ASSETS.map(path=>new Request(new URL(path,self.registration.scope),{cache:'reload'})));if(!self.registration.active)await self.skipWaiting();})());
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const names=await caches.keys();await Promise.all(names.filter(name=>name.startsWith('installation-progress-shell-') && name !== CACHE).map(name=>caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('message',event=>{
  if(event.data?.type === 'ACTIVATE_UPDATE')self.skipWaiting();
  if(event.data?.type === 'VERIFY_OFFLINE')event.waitUntil((async()=>{
    const cache=await caches.open(CACHE),missing=[];
    for(const path of ASSETS)if(!await cache.match(new URL(path,self.registration.scope)))missing.push(path);
    event.ports[0]?.postMessage({cache:CACHE,ready:missing.length === 0,missing});
  })());
});
self.addEventListener('fetch',event=>{
  if(event.request.method !== 'GET')return;
  const url=new URL(event.request.url);
  if(url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),cached=await cache.match(event.request,{ignoreSearch:true});
    if(cached)return cached;
    if(event.request.mode === 'navigate' && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')))return await cache.match(new URL('index.html',self.registration.scope)) || Response.error();
    return fetch(event.request);
  })());
});
