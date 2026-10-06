// Service worker : rend le site installable et consultable hors connexion.
//  - pages : réseau d'abord, copie gardée en secours ;
//  - code et styles (leur adresse change à chaque publication) : copie
//    locale d'abord, mise à jour en arrière-plan ;
//  - données (data/*.json) : réseau d'abord, dernière copie si hors ligne.
// Les appels aux API externes (Polymarket…) ne sont pas interceptés.

const VERSION = "dev"; // remplacé à chaque publication par la GitHub Action
const CACHE = `pm-viewer-${VERSION}`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pm-viewer-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, key = request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const update = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit ?? update;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    // Une seule copie de la page, quelle que soit l'ancre (#radar…)
    event.respondWith(networkFirst(request, new URL("./", self.registration.scope).href));
  } else if (url.pathname.includes("/data/")) {
    // Les données sont demandées avec ?t=… : une seule copie par fichier
    event.respondWith(networkFirst(request, url.origin + url.pathname));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});
