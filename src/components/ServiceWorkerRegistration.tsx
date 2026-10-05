"use client";

import { useEffect } from 'react';
import { registerServiceWorker } from '@/lib/push/push-client';
import { reportServiceWorkerChunkProblem } from '@/lib/pwa/chunk-recovery';

/**
 * Enregistre le service worker `/sw.js` une seule fois au montage (CDC §14.1).
 * Ne demande JAMAIS la permission de notification (§9.1) : cela reste réservé
 * à une action explicite de l'utilisateur, gérée ailleurs.
 *
 * Écoute aussi les messages du SW :
 *   · `NOTIFICATION_NAVIGATE` : navigation demandée par un clic sur une
 *     notification quand le SW ne peut pas naviguer lui-même ;
 *   · `CHUNK_LOAD_ERROR` (APP-PERF-10) : un chunk `/_next/static/` a échoué,
 *     avec sa cause — `missing` (404/410 : version retirée par un
 *     déploiement) ou `network` (transport). Le signal classe l'erreur de
 *     chargement qui suit et, pour `missing`, propose la nouvelle version ;
 *     il ne recharge jamais à lui seul (un préchargement peut échouer sans
 *     rien casser).
 *
 * Mise à jour du SW : une nouvelle version installée prend la main sans
 * attendre la fermeture de tous les onglets. Elle ne sert que du réseau et
 * les notifications : aucun rechargement de page n'est nécessaire.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    let cancelled = false;
    void registerServiceWorker().then((registration) => {
      if (cancelled || !registration) return;
      const activerSiEnAttente = () => {
        // Seulement s'il y a déjà un SW actif (mise à jour, pas première installation).
        if (registration.waiting && navigator.serviceWorker.controller) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      };
      activerSiEnAttente();
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed') activerSiEnAttente();
        });
      });
    });

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'NOTIFICATION_NAVIGATE' && typeof data.href === 'string') {
        window.location.href = data.href;
        return;
      }
      if (data?.type === 'CHUNK_LOAD_ERROR') {
        // L'ancien SW (v5.0.0) n'envoyait ce message que sur échec réseau, sans `reason`.
        reportServiceWorkerChunkProblem(data.reason === 'missing' ? 'missing' : 'network');
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, []);

  return null;
}
