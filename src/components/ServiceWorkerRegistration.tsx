"use client";

import { useEffect } from 'react';
import { registerServiceWorker } from '@/lib/push/push-client';

/**
 * Enregistre le service worker `/sw.js` une seule fois au montage (CDC §14.1).
 * Ne demande JAMAIS la permission de notification (§9.1) : cela reste réservé
 * à une action explicite de l'utilisateur, gérée ailleurs.
 *
 * Écoute aussi les messages `NOTIFICATION_NAVIGATE` renvoyés par le SW lorsque
 * la navigation directe d'un client n'est pas possible.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    void registerServiceWorker();

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NOTIFICATION_NAVIGATE' && typeof event.data.href === 'string') {
        window.location.href = event.data.href;
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  return null;
}
