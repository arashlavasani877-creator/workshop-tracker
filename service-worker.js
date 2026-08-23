const CACHE_NAME = 'afrachoob-tracker-v15';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: هر بار تلاش می‌کند نسخه‌ی تازه را از سرور بگیرد؛ کش فقط
// برای حالت آفلاین (نبود اینترنت) استفاده می‌شود، نه به‌جای نسخه‌ی جدید.
// این تغییر مشکل «نسخه‌ی قدیمی برای همیشه کش می‌ماند» را برطرف می‌کند.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then((res) => {
      if(res && res.ok){
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
      }
      return res;
    }).catch(() => caches.match(event.request))
  );
});
