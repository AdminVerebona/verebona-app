// Service Worker pour Verebona PWA
// Version 5.3.0 — cache statique + signalement des chunks Next.js manquants
//                 (APP-PERF-10). AUCUN Web Push.
//
// 5.3.0 (lot 94, décision PO M3 du 26/10/2026 — aucun Web Push / PWA) :
//   · les gestionnaires `push`, `notificationclick` et
//     `pushsubscriptionchange` sont retirés : ce SW n'affiche plus aucune
//     notification et ne recrée jamais d'abonnement ;
//   · à l'activation, un éventuel abonnement push RÉSIDUEL du navigateur
//     (créé avant le lot 97) est résilié localement — aucun appel serveur,
//     aucune permission demandée ;
//   · version de cache inchangée (v5.2.0) : le contenu mis en cache est le
//     même, rien n'est vidé inutilement.
//
// 5.2.0 (lot 79B, icônes PWA) :
//   · nouvelle version de cache : à l'activation, les caches `verebona-*`
//     de la 5.1.0 (manifeste statique et images mises en cache, dont les
//     anciennes icônes) sont supprimés — aucune ancienne référence d'icône
//     ne peut plus être resservie hors ligne. Seuls les caches de CE SW sont
//     concernés : cookies, stockage local, IndexedDB et abonnement aux
//     notifications push sont conservés ;
//   · icône des notifications : fichier versionné `/pwa/` (src/lib/pwa/icons.ts).
//
// 5.1.0 (APP-PERF-10) :
//   · un 404/410 sur `/_next/static/` (version retirée par un déploiement)
//     est signalé aux onglets (`CHUNK_LOAD_ERROR`, reason `missing`) : ce
//     n'est pas un rejet réseau, l'ancien `catch` ne le voyait pas ;
//   · un échec de transport est signalé à part (reason `network`) et rendu
//     comme une vraie erreur réseau (plus de faux 408) ;
//   · la décision (recharger une fois, proposer, attendre le réseau)
//     appartient à la page (`src/lib/pwa/chunk-recovery.ts`) ;
//   · `CLEAR_CACHE` ne vide plus que les caches de ce SW (`verebona-*`),
//     plus toute l'origine.
// Les chunks ne sont JAMAIS mis en cache ici (réseau seul) ; les fichiers
// hashés restent cacheables par HTTP, leur nom change avec leur contenu.

const CACHE_VERSION = 'v5.2.0';
const CACHE_PREFIX = 'verebona-';
const CACHE_NAME = `verebona-${CACHE_VERSION}`;
const STATIC_CACHE = `verebona-static-${CACHE_VERSION}`;

const STATIC_ASSETS = ['/manifest.json'];

// Installation
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })))
        .catch(() => { }); // ne pas bloquer si un asset manque
    })
  );
});

// Lot 94 (M3) : résilie l'abonnement push laissé par une ancienne version.
// Silencieux, sans réseau ; navigateur sans Push API → rien à faire.
async function retirerAbonnementPushResiduel () {
  try {
    const pushManager = self.registration && self.registration.pushManager;
    if (!pushManager || typeof pushManager.getSubscription !== 'function') return;
    const subscription = await pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    /* best-effort : jamais bloquant pour l'activation */
  }
}

// Activation — nettoyer les anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    retirerAbonnementPushResiduel().then(() => caches.keys()).then((cacheNames) => {
      return Promise.all(
        cacheNames
          // Seulement les anciennes versions de CE service worker.
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME && name !== STATIC_CACHE)
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
    // Network-only. Pour le code de l'application (`/_next/static/`), le
    // statut HTTP et l'échec de transport sont signalés séparément.
    if (isNextChunk && url.pathname.startsWith('/_next/static/')) {
      event.respondWith(
        fetch(request).then((response) => {
          if (response.status === 404 || response.status === 410) {
            notifyChunkProblem('missing', response.status, url.pathname);
          }
          return response;
        }, (error) => {
          notifyChunkProblem('network', 0, url.pathname);
          // Vraie erreur réseau pour la page (et non une réponse inventée).
          throw error;
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

// Un signalement par ressource et par période : une page qui retente ne
// submerge pas les onglets de messages.
const recentChunkNotices = new Map();
const CHUNK_NOTICE_TTL_MS = 10000;

async function notifyChunkProblem (reason, status, path) {
  const now = Date.now();
  const key = `${reason}:${path}`;
  const last = recentChunkNotices.get(key);
  if (last && now - last < CHUNK_NOTICE_TTL_MS) return;
  recentChunkNotices.set(key, now);
  if (recentChunkNotices.size > 100) recentChunkNotices.clear();
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => client.postMessage({ type: 'CHUNK_LOAD_ERROR', reason, status, path }));
}

// Messages du client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(
        names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => caches.delete(n))
      ))
    );
  }
});
