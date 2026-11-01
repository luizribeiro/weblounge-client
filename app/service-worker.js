const SHELL_VERSION = "__SHELL_VERSION__";
const SHELL_CACHE = `weblounge-shell-${SHELL_VERSION}`;
const CONFIG_CACHE = "weblounge-runtime-config";
const PRECACHE_URLS = Object.freeze(/* __PRECACHE_URLS__ */);
const PRECACHE_PATHS = new Set(PRECACHE_URLS);
const PRECACHE_BATCH_SIZE = 2;

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
});

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const requests = PRECACHE_URLS.map(
    (url) => new Request(url, { priority: "low" }),
  );
  for (
    let offset = 0;
    offset < requests.length;
    offset += PRECACHE_BATCH_SIZE
  ) {
    await cache.addAll(requests.slice(offset, offset + PRECACHE_BATCH_SIZE));
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith("weblounge-shell-") && name !== SHELL_CACHE,
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/config.json") {
    event.respondWith(networkFirstConfig(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(shellResponse("/index.html", request));
    return;
  }
  if (PRECACHE_PATHS.has(url.pathname)) {
    event.respondWith(shellResponse(url.pathname, request));
  }
});

async function shellResponse(cacheKey, request) {
  const cached = await caches.match(cacheKey, { cacheName: SHELL_CACHE });
  return cached ?? fetch(request);
}

async function networkFirstConfig(request) {
  const cache = await caches.open(CONFIG_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put("/config.json", response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match("/config.json");
    if (cached !== undefined) return cached;
    throw error;
  }
}
