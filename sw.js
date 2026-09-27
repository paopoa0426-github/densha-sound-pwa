const CACHE = 'densha-sound-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=4',
  './app.js?v=4',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(res => res || fetch(e.request).then(networkRes => {
    const copy = networkRes.clone();
    caches.open(CACHE).then(cache => cache.put(e.request, copy));
    return networkRes;
  }).catch(() => caches.match('./index.html'))));
});
