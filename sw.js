// The release builder updates this revision when the shell changes.
const REVISION = "af8b0ec712c4079f";
const base = new URL(self.registration.scope);
const prefix = "felt-notes-shell:" + base.pathname + ":";
const currentCache = prefix + REVISION;
const assets = [
  "index.html", "style.css", "app.js", "engine.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png"
];
const assetUrls = assets.map(name => new URL(name, base).href);
const indexUrl = assetUrls[0];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(currentCache);
    await cache.addAll(assetUrls.map(url => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(prefix) && name !== currentCache) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const target = new URL(request.url);
  if (target.origin !== base.origin || target.search) return;
  // Only precached application assets can be served offline.
  const key = target.href === base.href ? indexUrl : target.href;
  if (!assetUrls.includes(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(currentCache);
    return (await cache.match(key)) || fetch(request);
  })());
});
