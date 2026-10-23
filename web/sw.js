// Offline voor de gsm-app dE3p: eerst het netwerk (zo heb je altijd de nieuwste versie), en als dat
// niet lukt of te lang duurt, wat er de vorige keer geladen werd. Je gegevens zelf staan in de app
// (IndexedDB); de website (/api) en de handleiding (/download) worden nooit bewaard.
const CACHE = 'dE3p-app';
const SLOW = 4000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/download') || url.pathname.startsWith('/strava-sync') || url.pathname.startsWith('/assets/')) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const nav = req.mode === 'navigate';
  const key = nav ? new URL('./', self.registration.scope).href : req;
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => { setTimeout(() => no(new Error('traag')), SLOW); })]);
    if (res.ok && res.type === 'basic') cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key, { ignoreSearch: nav });
    if (hit) return hit;
    throw err;
  }
}
