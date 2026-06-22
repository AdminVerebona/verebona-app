// Service Worker pour Verebona PWA
// Version 4.0.0 — gestion robuste des chunks Next.js obsolètes

const CACHE_VERSION = 'v4.0.0';
const CACHE_NAME = `verebona-${CACHE_VERSION}`;
const STATIC_CACHE = `verebona-static-${CACHE_VERSION}`;

const STATIC_ASSETS = ['/manifest.json'];

// Installation
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })))
        .catch(() => {}); // ne pas bloquer si un asset manque
    })
  );
});

// Activation — nettoyer les anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch — stratégie adaptée par type de ressource
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorer les requêtes non-GET
  if (request.method !== 'GET') return;

  // Ignorer les autres origines (sauf ressources statiques publiques)
  if (url.origin !== location.origin) return;

  // HTML + chunks Next.js : toujours network-only
  // Les chunks ont des hashes qui changent à chaque déploiement.
  // Les servir depuis le cache après un déploiement = ChunkLoadError.
  const isHtml = request.headers.get('accept')?.includes('text/html');
  const isNextChunk = url.pathname.startsWith('/_next/');
  const isApiRoute = url.pathname.startsWith('/api/');

  if (isHtml || isNextChunk || isApiRoute) {
    // Network-only, avec fallback de rechargement propre pour les chunks manquants
    if (isNextChunk) {
      event.respondWith(
        fetch(request).catch(async () => {
          // Chunk introuvable → notifier tous les onglets ouverts
          const clients = await self.clients.matchAll({ type: 'window' });
          clients.forEach(client => client.postMessage({ type: 'CHUNK_LOAD_ERROR' }));
          return new Response(null, { status: 408 });
        })
      );
    }
    return;
  }

  // Autres ressources statiques (images, fonts, manifest, icônes) : Network First + cache
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => {
        if (cached) return cached;
        return new Response(null, { status: 408 });
      }))
  );
});

// Messages du client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))))
    );
  }
});
