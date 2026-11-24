'use strict';

// Bump on every deploy so clients pick up the new shell.
const CACHE = 'jot-v9';

const SHELL = [
  './', // not 'index.html': some hosts redirect it to './'
  'main.js',
  'capture.js',
  'recorder.js',
  'silence.js',
  'mic-errors.js',
  'queue.js',
  'store.js',
  'uploader.js',
  'recent.js',
  'strip.js',
  'vocabulary.js',
  'vocab-screen.js',
  'v1import.js',
  'inbox.js',
  'signin.js',
  'auth-errors.js',
  'ui.js',
  'config.js',
  'vendor/supabase.js',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Bypass the HTTP cache so a new version never caches stale files.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jot-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Cross-origin requests (Supabase: auth, the Inbox, transcribe) and writes always go to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') {
        return caches.match('./').then((shell) => shell || fetch(req));
      }
      return fetch(req);
    })
  );
});
