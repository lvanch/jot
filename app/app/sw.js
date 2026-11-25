// Jot v1 was served from this directory and left a service worker here that keeps serving its cached app. v2 lives
// one level up (#14). When v1's worker checks for an update, it gets this one instead, which takes over, removes
// itself, and reloads the page from the network: the "Jot has moved" page. It leaves storage alone, so v1's list is
// still there for v2's import (#12).

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: 'window' });
      await Promise.all(windows.map((w) => w.navigate(w.url).catch(() => {})));
    })(),
  );
});
