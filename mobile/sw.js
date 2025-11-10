// Minimal SW for PWA installability without caching.
// - Keeps PWA eligibility (manifest + SW)
// - Clears any existing caches from older versions
// - Forwards all requests directly to the network

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
