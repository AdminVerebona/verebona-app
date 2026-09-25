/**
 * Suivi des remboursements d'une rétractation — CDC 6 §9.5, §9.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CLÔTURE PORTE SUR LES MONTANTS, PAS SUR LE NOMBRE DE REMBOURSEMENTS
 *
 * « Deux remboursements réussis » ne dit pas que le consommateur a récupéré
 * ce qu'il a payé. Une demande n'est close (`completed`) que si :
 *   - l'abonnement est annulé (ou sans objet) ;
 *   - aucun remboursement n'est encore en cours ;
 *   - total remboursé === montant attendu.
 * Elle reste `processing` tant que le total est inférieur, passe en `failed`
 * (anomalie) si un remboursement échoue ou si les montants sont incohérents
 * (total supérieur à l'attendu, montant inconnu irrécupérable…).
 *
 * Module pur : chaque remboursement est une entrée identifiée ; un événement
 * rejoué ou reçu dans le désordre met à jour l'entrée, sans jamais compter
 * deux fois un montant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { classifyRefundStatus } from './refund-calculator';

export interface RefundEntry {
  refundId: string;
  paymentId: string | null;
  /** Centimes. `null` : montant pas encore reconstruit (ancienne demande). */
  amount: number | null;
  status: string;
  /** Horodatage Stripe (secondes) de l'événement ayant écrit l'entrée. */
  eventCreated: number | null;
  updatedAt: string | null;
}

export function parseEntries(raw: unknown): RefundEntry[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? safeJson(raw) : [];
  return (list as Array<Partial<RefundEntry>>)
    .filter((e) => e && typeof e.refundId === 'string')
    .map((e) => ({
      refundId: e.refundId as string,
      paymentId: e.paymentId ?? null,
      amount: typeof e.amount === 'number' ? e.amount : null,
      status: e.status ?? 'pending',
      eventCreated: typeof e.eventCreated === 'number' ? e.eventCreated : null,
      updatedAt: e.updatedAt ?? null,
    }));
}

function safeJson(s: string): unknown[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Insère ou met à jour un remboursement.
 *
 * Idempotent et insensible à l'ordre : un événement plus ANCIEN que celui qui
 * a déjà écrit l'entrée est ignoré (Stripe ne garantit pas l'ordre de
 * livraison) ; le même événement rejoué produit la même entrée.
 */
export function upsertRefund(
  entries: RefundEntry[],
  update: { refundId: string; paymentId?: string | null; amount?: number | null; status?: string | null },
  eventCreated: number | null = null,
  now: Date = new Date(),
): RefundEntry[] {
  const i = entries.findIndex((e) => e.refundId === update.refundId);
  if (i === -1) {
    return [...entries, {
      refundId: update.refundId,
      paymentId: update.paymentId ?? null,
      amount: update.amount ?? null,
      status: update.status ?? 'pending',
      eventCreated,
      updatedAt: now.toISOString(),
    }];
  }
  const cur = entries[i];
  const older = eventCreated !== null && cur.eventCreated !== null && eventCreated < cur.eventCreated;
  const next: RefundEntry = {
    refundId: cur.refundId,
    paymentId: cur.paymentId ?? update.paymentId ?? null,
    // Le montant d'un remboursement ne change pas : une valeur connue n'est
    // jamais écrasée, une valeur inconnue est complétée.
    amount: cur.amount ?? update.amount ?? null,
    status: older ? cur.status : (update.status ?? cur.status),
    eventCreated: older ? cur.eventCreated : (eventCreated ?? cur.eventCreated),
    updatedAt: older ? cur.updatedAt : now.toISOString(),
  };
  const copy = [...entries];
  copy[i] = next;
  return copy;
}

/** Total effectivement remboursé : somme des remboursements réussis. */
export function settledAmount(entries: RefundEntry[]): number {
  return entries
    .filter((e) => classifyRefundStatus(e.status) === 'settled')
    .reduce((sum, e) => sum + (e.amount ?? 0), 0);
}

export interface StatusDecision {
  status: 'processing' | 'completed' | 'failed';
  amountRefunded: number;
  reason?: 'CANCELLATION_FAILED' | 'REFUND_FAILED' | 'AMOUNT_EXCEEDS_EXPECTED' | 'AMOUNT_UNKNOWN' | 'EXPECTED_UNKNOWN';
}

export function decideWithdrawalStatus(p: {
  cancellationStatus: string;
  entries: RefundEntry[];
  amountExpected: number | null;
}): StatusDecision {
  const amountRefunded = settledAmount(p.entries);
  if (p.cancellationStatus === 'failed') return { status: 'failed', amountRefunded, reason: 'CANCELLATION_FAILED' };
  if (p.entries.some((e) => classifyRefundStatus(e.status) === 'needs_attention')) {
    return { status: 'failed', amountRefunded, reason: 'REFUND_FAILED' };
  }
  if (p.amountExpected !== null && amountRefunded > p.amountExpected) {
    return { status: 'failed', amountRefunded, reason: 'AMOUNT_EXCEEDS_EXPECTED' };
  }

  const cancellationDone = p.cancellationStatus === 'cancelled' || p.cancellationStatus === 'not_applicable';
  const inFlight = p.entries.some((e) => classifyRefundStatus(e.status) === 'in_flight');
  // Un remboursement réussi dont le montant n'est pas connu empêche toute
  // conclusion sur le total : la demande reste en cours jusqu'à reconstruction.
  const unknown = p.entries.some((e) => e.amount === null && classifyRefundStatus(e.status) === 'settled');

  if (!cancellationDone || inFlight) return { status: 'processing', amountRefunded };
  if (unknown) return { status: 'processing', amountRefunded, reason: 'AMOUNT_UNKNOWN' };
  if (p.amountExpected === null) return { status: 'processing', amountRefunded, reason: 'EXPECTED_UNKNOWN' };
  if (amountRefunded === p.amountExpected) return { status: 'completed', amountRefunded };
  return { status: 'processing', amountRefunded };
}

/** Listes historiques, tenues à jour pour les lecteurs existants. */
export function legacyLists(entries: RefundEntry[]): { ids: string; statuses: string } {
  return {
    ids: JSON.stringify(entries.map((e) => e.refundId)),
    statuses: JSON.stringify(entries.map((e) => e.status)),
  };
}
