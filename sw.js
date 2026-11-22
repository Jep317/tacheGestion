// Service worker minimal : rend l'appli installable et l'ouvre même sans réseau.
// Les fichiers de l'appli sont pris sur le réseau d'abord (pour avoir la dernière version), le cache sert de secours.
const CACHE = 'taches-v12';
const FICHIERS = ['./', './index.html', './style.css', './app.js', './config.js', './vendor/supabase-js-2.45.4.js', './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // Supabase et CDN : jamais en cache ici
  e.respondWith(
    // « no-cache » : on redemande toujours au site si le fichier a changé (réponse légère s'il n'a pas changé).
    // Sans ça, le cache HTTP de GitHub Pages (10 min) gardait l'ancienne version après une mise à jour.
    fetch(e.request.mode === 'navigate' ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(e.request, { cache: 'no-cache' }))
      .then((rep) => {
        const copie = rep.clone();
        caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copie)); // sans « ?v= » : une seule copie par fichier
        return rep;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
