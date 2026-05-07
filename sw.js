/* iFocus service worker — offline-first for app shell, network-first for MediaPipe CDN */
const VERSION = 'ifocus-v1.0.0';
const APP_SHELL = `${VERSION}-shell`;
const RUNTIME   = `${VERSION}-runtime`;

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './tracker.js',
  './gaze-map.js',
  './session.js',
  './manifest.json',
  './apple-touch-icon.png',
  './favicon-32.png',
  './favicon-16.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== APP_SHELL && k !== RUNTIME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isMediapipe = /jsdelivr\.net.*mediapipe/.test(req.url);
  const isFont      = /fonts\.(googleapis|gstatic)\.com/.test(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Navigation: app shell / offline fallback
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(APP_SHELL);
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // MediaPipe / fonts: stale-while-revalidate
  if (isMediapipe || isFont) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(req);
      const fetchPromise = fetch(req).then((res) => {
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })());
    return;
  }

  // Same-origin static: cache-first
  if (isSameOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch {
        return cached || Response.error();
      }
    })());
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
