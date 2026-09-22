// @ts-check
// This standalone script runs exclusively in a service-worker global scope.
const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
const CACHE_NAME = "hint-runtime-__BUILD_ID__";
const APP_SHELL = [
  "/offline.html",
  "/manifest.json",
  "/assets/icon-192-v4.png",
  "/assets/icon-512-v4.png",
  "/assets/icon-maskable-512-v4.png",
  "/assets/apple-touch-icon-v4.png",
  "/assets/favicon-16-v4.png",
  "/assets/favicon-32-v4.png",
  "/assets/favicon-48-v4.png",
  "/favicon.ico?v=4",
  "/assets/logo-v4.png",
];

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL);

  const appResponse = await fetch(new Request("/", { cache: "reload" }));
  if (!appResponse.ok) throw new Error("Unable to cache the app shell");
  const html = await appResponse.clone().text();
  await cache.put("/", appResponse);

  const assetUrls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .flatMap((match) => (match[1] ? [new URL(match[1], worker.location.origin)] : []))
    .filter(
      (url) => url.origin === worker.location.origin && url.pathname !== "/service-worker.js",
    );

  await Promise.all(
    assetUrls.map(async (url) => {
      const response = await fetch(new Request(url.href, { cache: "reload" }));
      if (!response.ok) throw new Error(`Unable to cache app asset: ${url.pathname}`);
      await cache.put(url.href, response);
    }),
  );
}

worker.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell());
});

worker.addEventListener("message", (event) => {
  /** @type {unknown} */
  const data = event.data;
  if (data && typeof data === "object" && "type" in data && data.type === "SKIP_WAITING") {
    event.waitUntil(worker.skipWaiting());
  }
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("hint-runtime-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(async () => {
        if (worker.registration.navigationPreload) {
          await worker.registration.navigationPreload.enable();
        }
        await worker.clients.claim();
      }),
  );
});

/** @param {FetchEvent} event @param {RequestInfo} cacheKey @param {Response} response */
function remember(event, cacheKey, response) {
  if (!response?.ok) return;
  const copy = response.clone();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.put(cacheKey, copy))
      .catch(() => {
        /* Storage failure must not block online play. */
      }),
  );
}

/** @param {FetchEvent} event @returns {Promise<Response>} */
async function navigationResponse(event) {
  try {
    /** @type {unknown} */
    const preload = await event.preloadResponse;
    const response = preload instanceof Response ? preload : await fetch(event.request);
    remember(event, "/", response);
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (
      (await cache.match("/")) ||
      (await cache.match("/offline.html")) ||
      new Response("Offline", { status: 503 })
    );
  }
}

/** @param {FetchEvent} event */
async function cacheFirst(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  if (cached) return cached;

  try {
    const response = await fetch(event.request);
    remember(event, event.request, response);
    return response;
  } catch {
    return new Response("", { status: 408, statusText: "Offline" });
  }
}

/** @param {FetchEvent} event */
async function networkFirst(event) {
  try {
    const response = await fetch(event.request);
    remember(event, event.request, response);
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (
      (await cache.match(event.request)) || new Response("", { status: 408, statusText: "Offline" })
    );
  }
}

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== worker.location.origin) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(navigationResponse(event));
    return;
  }

  // Live readiness and Socket.IO transport state must never come from a cache.
  if (url.pathname === "/health" || url.pathname.startsWith("/socket.io/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Vite's hashed bundles and the versioned local media are immutable for the
  // lifetime of this build. Serving them from cache avoids weak-network stalls.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(event));
    return;
  }

  event.respondWith(networkFirst(event));
});
