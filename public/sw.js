/* CryptoIn PWA service worker (hand-rolled, no build step).
 * Scope-safe: works at "/" (dev/preview) and "/crypto-paper/" (GitHub Pages)
 * because everything keys off the registration scope.
 *
 * Strategy:
 * - Navigations: network-first, fallback to the cached app shell when offline.
 * - Same-origin static assets (hashed JS/CSS/icons): stale-while-revalidate.
 * - Cross-origin (Hyperliquid API, etc.): network-only — market data is live
 *   by design and the app already labels stale states itself. Never cached.
 */

const VERSION = "cryptoin-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.add(self.registration.scope))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // live market data: never cache

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(self.registration.scope)),
    );
    return;
  }

  // Same-origin static asset: serve cache now, refresh in background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
