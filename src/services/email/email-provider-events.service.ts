/**
 * Webhooks Resend — suivi de LIVRAISON des e-mails (lot 57A, P1-D).
 *
 * `email_logs.status = 'sent'` signifie « accepté par Resend » et le reste
 * (consommateurs existants : Communications, santé des notifications,
 * historique utilisateur). La livraison est suivie à part, dans
 * `email_logs.delivery_status`, à partir des événements Resend :
 *
 *   email.sent             → accepted          (rang 1)
 *   email.delivery_delayed → delivery_delayed  (rang 2)
 *   email.delivered        → delivered         (rang 3)
 *   email.complained       → complained        (rang 4)
 *   email.bounced          → bounced           (rang 5)
 *   email.failed           → failed            (rang 5)
 *   email.suppressed       → suppressed        (rang 5)
 *   autres (opened, clicked, scheduled…) : enregistrés, sans effet.
 *
 * SIGNATURE : Resend signe ses webhooks avec Svix. La signature est vérifiée
 * avec le secret de la variable d'environnement RESEND_WEBHOOK_SECRET
 * (« whsec_… », fourni par le tableau de bord Resend) : HMAC-SHA256 de
 * « svix-id.svix-timestamp.corps », comparaison à temps constant, horodatage
 * à ±5 min (anti-rejeu). Sans secret configuré, rien n'est accepté.
 *
 * IDEMPOTENCE : `svix-id` unique (`email_provider_events`) — un événement
 * rejoué n'a aucun effet. ORDRE INDIFFÉRENT : un état n'est remplacé que par
 * un état de rang supérieur (ou égal et plus récent) ; un événement arrivé
 * AVANT l'enregistrement de l'identifiant du message est conservé et rejoué
 * dès que l'e-mail est journalisé (`replayStoredProviderEvents`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pgClient } from '@/db';

const RESEND_WEBHOOK_SECRET_ENV = 'RESEND_WEBHOOK_SECRET';
const WEBHOOK_TOLERANCE_S = 5 * 60;

const EVENT_STATUS: Record<string, { status: string; rank: number }> = {
  'email.sent': { status: 'accepted', rank: 1 },
  'email.delivery_delayed': { status: 'delivery_delayed', rank: 2 },
  'email.delivered': { status: 'delivered', rank: 3 },
  'email.complained': { status: 'complained', rank: 4 },
  'email.bounced': { status: 'bounced', rank: 5 },
  'email.failed': { status: 'failed', rank: 5 },
  'email.suppressed': { status: 'suppressed', rank: 5 },
};

const RANK_SQL = `CASE delivery_status
  WHEN 'accepted' THEN 1 WHEN 'delivery_delayed' THEN 2 WHEN 'delivered' THEN 3 WHEN 'complained' THEN 4
  WHEN 'bounced' THEN 5 WHEN 'failed' THEN 5 WHEN 'suppressed' THEN 5 ELSE 0 END`;

type SignatureCheck = { ok: true } | { ok: false; code: 'NOT_CONFIGURED' | 'MISSING_HEADERS' | 'STALE_TIMESTAMP' | 'BAD_SIGNATURE' };

/** Vérification Svix (Resend). Pure : secret et horloge injectables. */
export function verifySvixSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string | undefined = process.env[RESEND_WEBHOOK_SECRET_ENV],
  nowMs: number = Date.now(),
): SignatureCheck {
  if (!secret) return { ok: false, code: 'NOT_CONFIGURED' };
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, code: 'MISSING_HEADERS' };
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > WEBHOOK_TOLERANCE_S) return { ok: false, code: 'STALE_TIMESTAMP' };
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = Buffer.from(createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest('base64'));
  for (const part of headers.signature.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, code: 'BAD_SIGNATURE' };
}

/** Signature Svix (tests et outils) : même calcul que Resend. */
export function signSvixPayload(secret: string, id: string, timestamp: number, rawBody: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string; created_at?: string; bounce?: { message?: string; type?: string; subType?: string }; failed?: { reason?: string };
    /** Lot 72F : étiquettes posées à l'envoi (objet dans les webhooks, tableau dans l'API). */
    tags?: Record<string, string> | Array<{ name: string; value: string }>;
  };
}

/** Lot 72F — étiquette de la demande d'origine (`vb_email_job`), ou null. */
export function emailJobIdFromTags(tags: Record<string, string> | Array<{ name: string; value: string }> | null | undefined): number | null {
  if (!tags) return null;
  const list = Array.isArray(tags) ? tags : Object.entries(tags).map(([name, value]) => ({ name, value }));
  const v = list.find((t) => t?.name === EMAIL_JOB_TAG)?.value;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Lot 72F — nom de l'étiquette Resend portant l'identifiant de la demande. */
export const EMAIL_JOB_TAG = 'vb_email_job';

/** Motif technique sans donnée personnelle (pas de destinataire, pas d'objet). */
function detailOf(evt: ResendEvent): string | null {
  const b = evt.data?.bounce;
  if (b) return [b.type, b.subType, b.message].filter(Boolean).join(' — ').slice(0, 500) || null;
  if (evt.data?.failed?.reason) return String(evt.data.failed.reason).slice(0, 500);
  return null;
}

/** Applique un événement à la ligne `email_logs` du message. Renvoie true si elle existe. */
async function apply(messageId: string, type: string, occurredAt: string, detail: string | null): Promise<boolean> {
  const map = EVENT_STATUS[type];
  const [exists] = await pgClient.unsafe<{ id: number }[]>(
    `SELECT id FROM email_logs WHERE provider_message_id = $1 LIMIT 1`, [messageId as never],
  );
  if (!exists) return false;
  if (!map) return true;
  await pgClient.unsafe(
    `UPDATE email_logs
        SET delivery_status = $2, delivery_status_at = $4::timestamptz,
            delivery_error = CASE WHEN $3 >= 4 THEN $5 ELSE delivery_error END
      WHERE provider_message_id = $1
        AND ((${RANK_SQL}) < $3 OR ((${RANK_SQL}) = $3 AND (delivery_status_at IS NULL OR delivery_status_at <= $4::timestamptz)))`,
    [messageId, map.status, map.rank, occurredAt, detail] as never[],
  );
  if (map.status === 'delivered') {
    await pgClient.unsafe(
      `UPDATE email_logs SET delivered_at = LEAST(COALESCE(delivered_at, $2::timestamptz), $2::timestamptz) WHERE provider_message_id = $1`,
      [messageId, occurredAt] as never[],
    );
  }
  return true;
}

export type WebhookOutcome = { duplicate: true } | { duplicate: false; applied: boolean; type: string };

/** Enregistre puis applique un événement déjà AUTHENTIFIÉ. Idempotent. */
export async function recordResendEvent(eventId: string, evt: ResendEvent, now: Date = new Date()): Promise<WebhookOutcome> {
  const type = String(evt.type ?? 'unknown').slice(0, 100);
  const messageId = evt.data?.email_id ? String(evt.data.email_id) : null;
  const occurredAt = new Date(evt.created_at ?? evt.data?.created_at ?? now.toISOString());
  const occurred = Number.isNaN(occurredAt.getTime()) ? now.toISOString() : occurredAt.toISOString();
  const detail = detailOf(evt);
  const jobId = emailJobIdFromTags(evt.data?.tags);
  const [row] = await pgClient.unsafe<{ id: number }[]>(
    `INSERT INTO email_provider_events (provider, event_id, event_type, provider_message_id, occurred_at, detail, received_at, email_job_id)
     VALUES ('resend', $1, $2, $3, $4::timestamptz, $5, $6::timestamptz, $7)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [eventId, type, messageId, occurred, detail, now.toISOString(), jobId] as never[],
  );
  if (!row) return { duplicate: true };
  const applied = messageId ? await apply(messageId, type, occurred, detail) : false;
  if (applied) await pgClient.unsafe(`UPDATE email_provider_events SET applied_at = $2::timestamptz WHERE id = $1`, [row.id, now.toISOString()] as never[]);
  return { duplicate: false, applied, type };
}

/** Rejoue les événements reçus avant la journalisation du message (ordre indifférent). */
export async function replayStoredProviderEvents(messageId: string): Promise<number> {
  const events = await pgClient.unsafe<{ id: number; event_type: string; occurred_at: string; detail: string | null }[]>(
    `SELECT id, event_type, occurred_at, detail FROM email_provider_events
      WHERE provider_message_id = $1 AND applied_at IS NULL ORDER BY occurred_at, id`,
    [messageId as never],
  );
  for (const e of events) {
    if (await apply(messageId, e.event_type, new Date(e.occurred_at).toISOString(), e.detail)) {
      await pgClient.unsafe(`UPDATE email_provider_events SET applied_at = now() WHERE id = $1`, [e.id as never]);
    }
  }
  return events.length;
}
