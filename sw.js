const CACHE_NAME = "emeraldnetwork-v2026-08-08";
const OFFLINE_URL = "./offline.html";
const APP_SHELL = [
  "./",
  "./offline.html",
  "./index.html",
  "./404.html",
  "./assets/styles/style.css",
  "./assets/styles/legal.css",
  "./assets/images/ui/nointernet.webp",
  "./assets/images/icons/favicon.webp",
  "./assets/scripts/animationvisible.js",
  "./assets/scripts/scrollice.js",
  "./assets/scripts/rightclick.js"
];

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const offline = await cache.match(OFFLINE_URL);
    return offline || Response.error();
  }
}

async function networkFirst(request, fallbackUrl = OFFLINE_URL) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request) || await cache.match(fallbackUrl);
    return cached || Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(networkFirst(request, OFFLINE_URL));
    return;
  }

  if (request.destination === "script" || request.destination === "style" || request.destination === "font" || request.destination === "image" || request.destination === "manifest") {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
