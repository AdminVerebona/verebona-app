/**
 * Primitives client Web Push (CDC §9 / §10 / §14.1).
 *
 * IMPORTANT : `subscribeCurrentDevice()` appelle `Notification.requestPermission()`
 * et NE DOIT être invoqué qu'après une action explicite de l'utilisateur
 * (bouton), jamais automatiquement (§9.1). Le composant d'enregistrement se
 * contente d'enregistrer le service worker, sans jamais demander la permission.
 */

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function getPermissionState(): PushPermission {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission as PushPermission;
}

/** Enregistre le service worker une seule fois. N'affecte pas la permission. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.error('[push] échec enregistrement service worker:', err);
    return null;
  }
}

async function getPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/push/public-key');
    if (!res.ok) return null;
    const data = await res.json();
    return data.publicKey ?? null;
  } catch {
    return null;
  }
}

export interface SubscribeResult {
  ok: boolean;
  permission: PushPermission;
  reason?: 'unsupported' | 'denied' | 'no_public_key' | 'error';
}

/**
 * Demande la permission (si nécessaire) puis crée l'abonnement et l'enregistre
 * côté serveur. À appeler UNIQUEMENT sur clic utilisateur (§9.2).
 */
export async function subscribeCurrentDevice(deviceLabel?: string): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, permission: 'unsupported', reason: 'unsupported' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, permission: permission as PushPermission, reason: 'denied' };
  }

  const registration = (await navigator.serviceWorker.ready) ?? (await registerServiceWorker());
  if (!registration) return { ok: false, permission, reason: 'error' };

  const publicKey = await getPublicKey();
  if (!publicKey) return { ok: false, permission, reason: 'no_public_key' };

  try {
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });

    const json = subscription.toJSON();
    const res = await fetch('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys,
        userAgent: navigator.userAgent.slice(0, 160),
        platform: 'web',
        deviceLabel,
      }),
    });
    return { ok: res.ok, permission, reason: res.ok ? undefined : 'error' };
  } catch (err) {
    console.error('[push] échec souscription:', err);
    return { ok: false, permission, reason: 'error' };
  }
}

/**
 * Désassocie l'appareil courant côté serveur (déconnexion, §10.2). On conserve
 * la souscription navigateur locale pour un rattachement propre ultérieur.
 */
export async function unsubscribeCurrentDevice(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await fetch('/api/push/subscriptions/current', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);
  } catch {
    /* best-effort */
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
