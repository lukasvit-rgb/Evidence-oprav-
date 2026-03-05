// Service Worker v2 - force update
const CACHE = 'evidence-oprav-v2';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if(e.request.url.includes('firestore.googleapis.com')) return;
  if(e.request.url.includes('script.google.com')) return;
  if(e.request.url.includes('firebase')) return;
  if(e.request.url.includes('fonts.googleapis')) return;

  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
