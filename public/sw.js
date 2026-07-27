// Service Worker pour Verebona PWA
// Version 5.0.0 — Web Push (push, notificationclick, pushsubscriptionchange)
//                 + gestion robuste des chunks Next.js obsolètes

const CACHE_VERSION = 'v5.0.0';
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

// ═══════════════════════════════════════════════════════════════════════════
// Web Push (CDC §14)
// ═══════════════════════════════════════════════════════════════════════════

const NOTIFICATION_ICON = '/android-chrome-192x192.png';
const NOTIFICATION_BADGE = '/favicon-96x96.png';

// §14.2 — Réception d'un push. Payload minimal, déjà sans donnée sensible.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = typeof data.title === 'string' && data.title.trim() ? data.title : 'Verebona';
  const body = typeof data.body === 'string' ? data.body : '';
  const href = typeof data.href === 'string' ? data.href : '/';
  const tag = typeof data.tag === 'string' ? data.tag : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
      tag,               // remplace un doublon éventuel (§14.2)
      renotify: false,
      data: {
        href,
        notificationId: data.notificationId ?? null,
        category: data.category ?? null,
      },
    })
  );
});

// §14.3 — Clic sur une notification : focus fenêtre existante puis navigation,
// sinon ouverture. L'application vérifie l'authentification elle-même.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || '/';
  const targetUrl = new URL(href, self.location.origin).href;

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      // Réutiliser un onglet Verebona déjà ouvert.
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          try { await client.navigate(targetUrl); } catch { /* origine identique requise */ }
        } else {
          client.postMessage({ type: 'NOTIFICATION_NAVIGATE', href });
        }
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

// §14.4 — Renouvellement de souscription : recréer et resynchroniser le serveur.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch('/api/push/public-key');
      if (!res.ok) return;
      const { publicKey } = await res.json();
      if (!publicKey) return;

      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const json = subscription.toJSON();
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          platform: 'web',
        }),
      });
    } catch (err) {
      // Sinon : appareil à réactiver au prochain lancement (le client re-souscrit).
    }
  })());
});

function urlBase64ToUint8Array (base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
