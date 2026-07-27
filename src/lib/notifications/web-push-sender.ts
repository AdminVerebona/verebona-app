/**
 * Envoi Web Push signé VAPID (CDC §14.5 / §18.2).
 *
 * Enveloppe la bibliothèque `web-push`. La clé privée VAPID n'est jamais
 * exposée au client. Distingue les erreurs « abonnement disparu » (404/410),
 * qui doivent désactiver l'abonnement sans retry ni toucher aux préférences,
 * des erreurs techniques temporaires.
 */

import webpush from 'web-push';

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@verebona.fr';
  if (!publicKey || !privateKey) {
    console.warn('[web-push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY absents — push serveur désactivé.');
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// Champs autorisés dans un payload push (vie privée, §4.3). Tout autre champ est
// écarté et les textes sont plafonnés : aucune donnée patrimoniale, aucun jeton.
const ALLOWED_PUSH_KEYS = ['notificationId', 'title', 'body', 'href', 'tag', 'category'] as const;

export function sanitizePushPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ALLOWED_PUSH_KEYS) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (typeof value === 'string') {
      safe[key] = value.slice(0, key === 'body' ? 180 : 120);
    } else {
      safe[key] = value ?? null;
    }
  }
  return safe;
}

export type PushSendResult =
  | { ok: true }
  | { ok: false; gone: boolean; statusCode?: number; error: string };

export async function sendWebPush(target: PushTarget, payload: Record<string, unknown>): Promise<PushSendResult> {
  if (!ensureConfigured()) {
    return { ok: false, gone: false, error: 'vapid_not_configured' };
  }
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(sanitizePushPayload(payload)),
      { TTL: 60 * 60 * 24 }, // 24 h
    );
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { statusCode?: number; body?: string; message?: string };
    const statusCode = e?.statusCode;
    // 404 = endpoint inconnu, 410 = abonnement expiré → ne plus jamais retenter.
    const gone = statusCode === 404 || statusCode === 410;
    return { ok: false, gone, statusCode, error: (e?.body || e?.message || 'push_error').toString().slice(0, 300) };
  }
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}
