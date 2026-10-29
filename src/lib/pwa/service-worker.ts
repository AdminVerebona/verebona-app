/**
 * Enregistrement du service worker `/sw.js` (PWA : manifeste, cache des
 * ressources statiques, signalement des chunks manquants — APP-PERF-10).
 *
 * Lot 94 (décision PO M3 du 26/10/2026) : le Web Push est supprimé. Ce module
 * remplace `lib/push/push-client.ts` ; il n'a plus aucun lien avec les
 * notifications (ni permission, ni abonnement). Même chemin `/sw.js`, même
 * périmètre : le service worker déjà installé est simplement mis à jour.
 *
 * Lot 95 (PO M3) : aucun service worker dans l'application iOS / Android —
 * ni Web Push, ni cache de navigateur ; les notifications y sont natives.
 */
import { isNativeApp } from '@/lib/native/bridge';

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (isNativeApp()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.error('[pwa] échec enregistrement service worker:', err);
    return null;
  }
}
