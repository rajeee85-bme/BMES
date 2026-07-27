const CACHE_NAME = "bme-equipment-v1";
const SHELL_FILES = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App shell: cache-first (fast load, works offline).
// Everything else (the Apps Script API calls): network-first, since that
// data should be as fresh as possible — app.js has its own localStorage
// cache and offline queue for when the network truly isn't there.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const isShellFile = SHELL_FILES.some((f) => req.url.endsWith(f.replace("./", "")));

  if (isShellFile) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
    return;
  }

  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
