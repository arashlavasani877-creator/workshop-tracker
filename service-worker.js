const CACHE_NAME = 'afrachoob-tracker-v18';
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
  // نسخه تازه منتظر بسته‌شدن نسخه قبلی نمی‌ماند.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();

    // کلاینت‌های باز از فعال‌شدن نسخه جدید باخبر می‌شوند. اپ جدید وقتی امن باشد
    // خودش Refresh می‌کند؛ کلاینت‌های پس‌زمینه نیز در صورت پشتیبانی همان‌جا نوسازی می‌شوند.
    const clients = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    await Promise.all(clients.map(async (client) => {
      try{ client.postMessage({ type:'AFRACHOOB_SW_ACTIVATED', version:CACHE_NAME }); }catch(e){}
      try{
        if(client.visibilityState && client.visibilityState !== 'visible' && typeof client.navigate === 'function'){
          await client.navigate(client.url);
        }
      }catch(e){}
    }));
  })());
});

self.addEventListener('message', (event) => {
  if(event && event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request){
  const cache = await caches.open(CACHE_NAME);
  try{
    // no-store مانع ماندن نسخه قدیمی در HTTP cache مرورگر می‌شود.
    const freshRequest = new Request(request, { cache:'no-store' });
    const response = await fetch(freshRequest);
    if(response && response.ok) await cache.put(request, response.clone());
    return response;
  }catch(error){
    const exact = await cache.match(request);
    if(exact) return exact;
    const withoutQuery = await cache.match(request, { ignoreSearch:true });
    if(withoutQuery) return withoutQuery;
    if(request.mode === 'navigate'){
      const fallback = await cache.match('./index.html');
      if(fallback) return fallback;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  if(event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  // Firebase/CDN و سایر سرویس‌های بیرونی را Service Worker دستکاری نمی‌کند.
  if(url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(event.request));
});
