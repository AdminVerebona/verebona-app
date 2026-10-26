/**
 * Premium Duo — période de souscription en cours (lot 61B, ticket P1 « écarts
 * résiduels de la proposition Inviter quelqu'un »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DATE RÉELLE DE DÉBUT DU DUO (écart D)
 *
 * Le déclencheur 0385 posait `now()` à l'activation locale : une
 * synchronisation Stripe tardive repoussait la période d'invitation. La date
 * est désormais celle de la PRISE D'EFFET confirmée par Stripe :
 *
 *   1. événement `customer.subscription.updated` dont `previous_attributes`
 *      prouve le passage d'une autre offre à Premium Duo (upgrade, retour en
 *      Duo sur le même abonnement) → `event.created` ;
 *   2. marqueur du changement d'offre BO posé sur l'abonnement Stripe
 *      (`admin_plan_change`, offre cible premium_duo) → sa date ;
 *   3. NOUVEL abonnement pour le compte (Checkout Duo) → `start_date`.
 *
 * Exclus : création technique du Duo (avant paiement), début d'un Premium
 * antérieur (même abonnement → `start_date` jamais retenu), renouvellement
 * (`current_period_start`), heure de la synchronisation. Une date antérieure
 * à la dernière sortie locale de l'offre (`duo_subscription_ended_at`) est
 * refusée (webhook ancien ou rejoué, marqueur d'une souscription précédente).
 * Aucune source fiable : NULL, aucune suggestion — complétée plus tard par le
 * webhook de la transition s'il arrive après (jamais modifiée ensuite).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { duoAccounts } from '@/db/schema';

/** Statuts Duo « dans l'offre » (impayé compris : restreint, pas sorti). */
const DUO_OFFER_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'TRIALING', 'UNPAID_RECOVERY']);
/** Statuts Duo qui ouvrent une souscription (droits Duo actifs). */
export const DUO_ACTIVE_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'TRIALING']);

export const isDuoInOffer = (s: string | null | undefined): boolean => DUO_OFFER_STATUSES.has(String(s ?? '').toUpperCase());
export const isDuoActive = (s: string | null | undefined): boolean => DUO_ACTIVE_STATUSES.has(String(s ?? '').toUpperCase());

/** Tolérance d'horloge pour une date Stripe « dans le futur ». */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const unix = (v: number | null | undefined): Date | null => (typeof v === 'number' && v > 0 ? new Date(v * 1000) : null);

/**
 * Dates candidates, par ordre de fiabilité (pure). `accountSubscriptionIdBefore` :
 * abonnement Stripe du compte AVANT cette synchronisation.
 */
export function duoStartCandidates(input: {
  subscription: Pick<Stripe.Subscription, 'id' | 'start_date' | 'metadata'>;
  accountSubscriptionIdBefore: string | null | undefined;
  duoEnteredAt?: Date | null;
}): Date[] {
  const out: Array<Date | null> = [input.duoEnteredAt ?? null];
  const md = input.subscription.metadata ?? {};
  if (md.admin_plan_change_to === 'premium_duo') {
    const at = Date.parse(md.admin_plan_change ?? '');
    out.push(Number.isNaN(at) ? null : new Date(at));
  }
  if (input.accountSubscriptionIdBefore !== input.subscription.id) out.push(unix(input.subscription.start_date));
  return out.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
}

/** Première date acceptable : après la dernière sortie, pas dans le futur (pure). */
export function pickDuoStartDate(candidates: Date[], endedAt: Date | string | null | undefined, now: Date = new Date()): Date | null {
  const ended = endedAt ? new Date(endedAt).getTime() : null;
  for (const d of candidates) {
    if (ended !== null && !Number.isNaN(ended) && d.getTime() <= ended) continue;
    if (d.getTime() > now.getTime() + CLOCK_SKEW_MS) continue;
    return d;
  }
  return null;
}

/**
 * Statut Duo correspondant au statut de compte appliqué par le BO (écart F,
 * pure) : jamais ACTIVE depuis un impayé ou un état sans droits.
 *   ACTIVE / TRIALING / CANCELED (résiliation programmée, droits conservés
 *   jusqu'à l'échéance) → ACTIVE ; PAST_DUE → UNPAID_RECOVERY ; autres
 *   (EXPIRED, WITHDRAWN, NONE…) → CANCELED.
 */
export function duoStatusForAccountStatus(accountStatus: string | null | undefined): 'ACTIVE' | 'UNPAID_RECOVERY' | 'CANCELED' {
  const s = String(accountStatus ?? '').toUpperCase();
  if (s === 'ACTIVE' || s === 'TRIALING' || s === 'CANCELED') return 'ACTIVE';
  if (s === 'PAST_DUE') return 'UNPAID_RECOVERY';
  return 'CANCELED';
}

/**
 * Événement Stripe prouvant le passage À Premium Duo depuis une autre offre
 * reconnue (même abonnement) : sa date de création, sinon null. Les prix sont
 * reconnus par le registre historique (jamais par montant).
 */
export async function duoEntryFromEvent(
  event: Pick<Stripe.Event, 'type' | 'created' | 'data'>,
  recognize?: (priceId: string, price: Stripe.Price | null) => Promise<string | null>,
): Promise<Date | null> {
  if (event.type !== 'customer.subscription.updated') return null;
  const prev = (event.data as { previous_attributes?: { items?: { data?: Array<{ price?: Stripe.Price | string | null }> } } })
    .previous_attributes?.items?.data;
  if (!Array.isArray(prev) || prev.length === 0) return null;
  const planOf = recognize ?? (async (priceId: string, price: Stripe.Price | null) => {
    const { resolveHistoricalPrice } = await import('@/services/billing/price-history.service');
    const r = await resolveHistoricalPrice(priceId, { source: 'webhook:duo-entry', price });
    return r.status === 'recognized' ? r.planCode : null;
  });
  const idOf = (p: Stripe.Price | string | null | undefined) => (!p ? null : typeof p === 'string' ? p : p.id);
  const objOf = (p: Stripe.Price | string | null | undefined) => (p && typeof p === 'object' ? p : null);

  const current = (event.data.object as Stripe.Subscription).items?.data ?? [];
  const currentPlans: string[] = [];
  for (const it of current) {
    const id = idOf(it.price);
    if (id) { const p = await planOf(id, objOf(it.price)); if (p) currentPlans.push(p); }
  }
  if (currentPlans.length !== 1 || currentPlans[0] !== 'premium_duo') return null;
  const previousPlans: string[] = [];
  for (const it of prev) {
    const id = idOf(it.price);
    if (id) { const p = await planOf(id, objOf(it.price)); if (p) previousPlans.push(p); }
  }
  if (previousPlans.length === 0 || previousPlans.includes('premium_duo')) return null;
  return unix(event.created);
}

// ── Écritures (synchronisation Stripe, BO) ──────────────────────────────────

/**
 * Valeur de `duo_subscription_started_at` à l'ouverture d'une souscription
 * Duo (lot 61B), évaluée sur la ligne COURANTE : déjà dans l'offre → inchangée.
 */
export function openingStart(start: Date | null) {
  return sql`CASE WHEN ${duoAccounts.subscriptionStatus} IN ('ACTIVE', 'TRIALING', 'UNPAID_RECOVERY')
                  THEN ${duoAccounts.duoSubscriptionStartedAt} ELSE ${start ? start.toISOString() : null}::timestamptz END`;
}

/** Complète une date de début inconnue (une fois ; postérieure à la dernière sortie). */
export async function fillDuoStart(exec: { update: PgDatabase<PgQueryResultHKT>['update'] }, duoId: number, start: Date): Promise<void> {
  await exec
    .update(duoAccounts)
    .set({ duoSubscriptionStartedAt: start })
    .where(and(
      eq(duoAccounts.id, duoId),
      isNull(duoAccounts.duoSubscriptionStartedAt),
      inArray(duoAccounts.subscriptionStatus, ['ACTIVE', 'TRIALING', 'UNPAID_RECOVERY']),
      or(isNull(duoAccounts.duoSubscriptionEndedAt), lt(duoAccounts.duoSubscriptionEndedAt, start)),
    ));
}

