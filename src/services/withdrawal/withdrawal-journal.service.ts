/**
 * Journal de rétractation — CDC 6 §18 et §16.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX GARANTIES, ET ELLES SE COMPLÈTENT
 *
 * 1. AJOUT SEUL. Un déclencheur en base interdit toute modification. Ce
 *    service n'expose donc aucune fonction de mise à jour : l'absence de
 *    verbe est le premier rempart, le déclencheur est le second.
 *
 * 2. MASQUAGE. Le §16 exige « le masquage des données sensibles dans les
 *    journaux ». Un journal de rétractation manipule des adresses IP, des
 *    identifiants Stripe, parfois des adresses électroniques. Il est conservé
 *    longtemps, et consulté par des administrateurs qui n'ont pas à tout voir.
 *    Le masquage est appliqué à L'ÉCRITURE, jamais à l'affichage : masquer au
 *    rendu laisserait la donnée en clair dans la base et dans les exports.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { withdrawalEvents, withdrawalRequests } from '@/db/schema';
import { asc, eq } from 'drizzle-orm';

export type WithdrawalEventType =
  | 'JOURNEY_VIEWED'
  | 'DECLARATION_RECEIVED'
  | 'RECEIPT_SENT'
  | 'SUBSCRIPTION_CANCELLED'
  | 'SUBSCRIPTION_CANCEL_FAILED'
  | 'PAYMENTS_IDENTIFIED'
  | 'REFUND_REQUESTED'
  | 'REFUND_STATUS_CHANGED'
  | 'WEBHOOK_RECEIVED'
  | 'EXPORT_ONLY_ENTERED'
  | 'DELETION_SCHEDULED'
  | 'DELETION_EXECUTED'
  | 'DELETION_CANCELLED'
  | 'ADMIN_NOTE'
  | 'ADMIN_RETRY'
  | 'ADMIN_MANUAL_REFUND'
  | 'ADMIN_STATUS_CHANGED'
  | 'ADMIN_REJECTED';

export interface RecordEventInput {
  publicReference: string;
  eventType: WithdrawalEventType;
  summary: string;
  actor?: string;
  actorUserId?: number | null;
  result?: 'success' | 'failure' | 'info';
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Champs dont la valeur ne doit jamais figurer en clair (§16). */
const SENSITIVE_KEYS = new Set([
  'ip', 'ipAddress', 'ip_address',
  'userAgent', 'user_agent',
  'email', 'receiptEmail', 'receipt_email',
  'cardNumber', 'card', 'last4', 'iban',
  'token', 'tokenHash', 'authorization',
]);

/** Masque une adresse électronique en conservant de quoi la reconnaître. */
function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/** Masque une adresse IP en conservant le réseau, utile au diagnostic. */
function maskIp(value: string): string {
  if (value.includes(':')) return `${value.split(':').slice(0, 2).join(':')}:***`;
  const parts = value.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : '***';
}

/**
 * Applique le masquage en profondeur.
 *
 * Exportée pour être testable : c'est la fonction qui décide ce qui finit
 * écrit noir sur blanc dans une table conservée des années.
 */
export function maskSensitive(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string' && key && SENSITIVE_KEYS.has(key)) {
    if (key.toLowerCase().includes('email')) return maskEmail(value);
    if (key.toLowerCase().includes('ip')) return maskIp(value);
    // Jetons, empreintes, numéros : seule la longueur est conservée, elle
    // suffit à distinguer « absent » de « présent mais invalide ».
    return `***(${value.length})`;
  }

  if (Array.isArray(value)) return value.map((v) => maskSensitive(v));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskSensitive(v, k);
    }
    return out;
  }

  return value;
}

/**
 * Écrit un événement.
 *
 * NE LÈVE JAMAIS. Un journal indisponible ne doit pas faire échouer une
 * annulation d'abonnement ni un remboursement : perdre une trace est fâcheux,
 * laisser un consommateur non remboursé l'est infiniment plus. L'échec est
 * lui-même journalisé en console.
 */
export async function recordWithdrawalEvent(input: RecordEventInput): Promise<void> {
  try {
    const [request] = await db
      .select({ id: withdrawalRequests.id })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.publicReference, input.publicReference))
      .limit(1);

    if (!request) {
      console.warn(
        `[withdrawal-journal] demande ${input.publicReference} introuvable — ` +
        `événement ${input.eventType} non consigné.`,
      );
      return;
    }

    await db.insert(withdrawalEvents).values({
      withdrawalId: request.id,
      publicReference: input.publicReference,
      occurredAt: input.occurredAt ?? new Date(),
      eventType: input.eventType,
      actor: input.actor ?? (input.actorUserId ? `admin:${input.actorUserId}` : 'system'),
      actorUserId: input.actorUserId ?? null,
      result: input.result ?? 'success',
      summary: input.summary.slice(0, 500),
      payloadJson: input.payload
        ? JSON.stringify(maskSensitive(input.payload)).slice(0, 4000)
        : null,
    });
  } catch (e) {
    console.error(
      `[withdrawal-journal] écriture impossible (${input.eventType}) : ${(e as Error).message}`,
    );
  }
}

export interface WithdrawalEvent {
  id: number;
  occurredAt: Date;
  eventType: string;
  actor: string;
  result: string;
  summary: string;
  payload: Record<string, unknown> | null;
}

/** Histoire complète d'une demande, du plus ancien au plus récent. */
export async function listWithdrawalEvents(
  publicReference: string,
): Promise<WithdrawalEvent[]> {
  const rows = await db
    .select()
    .from(withdrawalEvents)
    .where(eq(withdrawalEvents.publicReference, publicReference))
    .orderBy(asc(withdrawalEvents.occurredAt), asc(withdrawalEvents.id));

  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt,
    eventType: r.eventType,
    actor: r.actor,
    result: r.result,
    summary: r.summary,
    payload: r.payloadJson ? (JSON.parse(r.payloadJson) as Record<string, unknown>) : null,
  }));
}
