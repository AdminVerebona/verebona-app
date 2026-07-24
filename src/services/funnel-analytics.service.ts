/**
 * Suivi analytique du parcours de souscription (CDC tarification §17).
 *
 * Quinze evenements, de la creation du compte a la conversion, permettant de
 * calculer les indicateurs d'activation et de conversion.
 *
 * Aucune donnee personnelle n'est enregistree au-dela des identifiants de
 * compte et d'utilisateur : ni adresse electronique, ni contenu de document.
 */
import { db } from '@/db';
import { funnelEvents } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

/** Les quinze evenements du cahier des charges. */
export type FunnelEvent =
  // Activation
  | 'account_created'
  | 'trial_started'
  | 'first_asset_added'
  | 'first_document_added'
  | 'first_question_asked'
  | 'first_export_generated'
  // Parcours de souscription
  | 'offers_viewed'
  | 'plan_selected'
  | 'billing_period_selected'
  | 'checkout_opened'
  | 'checkout_abandoned'
  | 'payment_succeeded'
  // Denouement
  | 'converted_before_expiry'
  | 'converted_after_expiry'
  | 'expired_without_conversion';

/** Evenements ne devant etre comptes qu'une fois par compte. */
const ONCE_PER_ACCOUNT: FunnelEvent[] = [
  'account_created',
  'trial_started',
  'first_asset_added',
  'first_document_added',
  'first_question_asked',
  'first_export_generated',
];

export interface TrackParams {
  event: FunnelEvent;
  accountId: number;
  userId?: number | null;
  planCode?: string | null;
  billingPeriod?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Enregistre un evenement du parcours.
 *
 * Ne leve jamais : un echec de mesure ne doit pas interrompre une action
 * metier. Les evenements « une fois par compte » sont dedupliques par un
 * index unique en base, ce qui rend la fonction rejouable sans risque.
 */
export async function trackFunnelEvent(params: TrackParams): Promise<void> {
  try {
    const now = new Date();
    const query = db.insert(funnelEvents).values({
      accountId: params.accountId,
      userId: params.userId ?? null,
      eventType: params.event,
      planCode: params.planCode ?? null,
      billingPeriod: params.billingPeriod ?? null,
      metadata: params.metadata ?? null,
      occurredAt: now,
      createdAt: now,
    });

    if (ONCE_PER_ACCOUNT.includes(params.event)) {
      await query.onConflictDoNothing();
    } else {
      await query;
    }
  } catch (error) {
    console.error('[funnel] enregistrement impossible:', error);
  }
}

/** Nombre de comptes distincts ayant declenche un evenement donne. */
async function countAccounts(event: FunnelEvent, since?: Date): Promise<number> {
  const conditions = since
    ? and(eq(funnelEvents.eventType, event), sql`${funnelEvents.occurredAt} >= ${since}`)
    : eq(funnelEvents.eventType, event);

  const [row] = await db
    .select({ value: sql<number>`count(distinct ${funnelEvents.accountId})` })
    .from(funnelEvents)
    .where(conditions);

  return Number(row?.value ?? 0);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export interface FunnelIndicators {
  /** Comptes ayant demarre un essai. */
  trialsStarted: number;
  /** Part des essais ayant abouti a l'ajout d'un premier bien (%). */
  activationRate: number;
  /** Part des essais ayant abouti a l'ajout d'un premier document (%). */
  firstDocumentRate: number;
  /** Part des essais ayant utilise une fonction Premium (%). */
  premiumUsageRate: number;
  /** Part des essais convertis en abonnement (%). */
  conversionRate: number;
  /** Conversions par offre. */
  conversionByPlan: Record<string, number>;
  /** Conversions par periodicite. */
  conversionByPeriod: Record<string, number>;
  /** Delai moyen entre demarrage de l'essai et souscription, en jours. */
  averageDaysToSubscribe: number | null;
  /** Part des essais expires sans conversion (%). */
  expirationRate: number;
}

/**
 * Calcule les huit indicateurs du cahier des charges.
 * `since` limite le calcul a une periode ; sans lui, tout l'historique.
 */
export async function computeIndicators(since?: Date): Promise<FunnelIndicators> {
  const [trials, firstAsset, firstDoc, firstQuestion, paid, expired] = await Promise.all([
    countAccounts('trial_started', since),
    countAccounts('first_asset_added', since),
    countAccounts('first_document_added', since),
    countAccounts('first_question_asked', since),
    countAccounts('payment_succeeded', since),
    countAccounts('expired_without_conversion', since),
  ]);

  // Repartition des conversions par offre et par periodicite
  const breakdown = await db
    .select({
      planCode: funnelEvents.planCode,
      billingPeriod: funnelEvents.billingPeriod,
      value: sql<number>`count(distinct ${funnelEvents.accountId})`,
    })
    .from(funnelEvents)
    .where(eq(funnelEvents.eventType, 'payment_succeeded'))
    .groupBy(funnelEvents.planCode, funnelEvents.billingPeriod);

  const conversionByPlan: Record<string, number> = {};
  const conversionByPeriod: Record<string, number> = {};
  for (const row of breakdown) {
    const plan = row.planCode ?? 'inconnu';
    const period = row.billingPeriod ?? 'inconnu';
    conversionByPlan[plan] = (conversionByPlan[plan] ?? 0) + Number(row.value);
    conversionByPeriod[period] = (conversionByPeriod[period] ?? 0) + Number(row.value);
  }

  // Delai moyen entre le demarrage de l'essai et le paiement
  const [delay] = await db
    .select({
      days: sql<number>`
        avg(extract(epoch from (paid.occurred_at - started.occurred_at)) / 86400)
      `,
    })
    .from(sql`funnel_events started`)
    .innerJoin(
      sql`funnel_events paid`,
      sql`paid.account_id = started.account_id and paid.event_type = 'payment_succeeded'`,
    )
    .where(sql`started.event_type = 'trial_started'`);

  return {
    trialsStarted: trials,
    activationRate: ratio(firstAsset, trials),
    firstDocumentRate: ratio(firstDoc, trials),
    premiumUsageRate: ratio(firstQuestion, trials),
    conversionRate: ratio(paid, trials),
    conversionByPlan,
    conversionByPeriod,
    averageDaysToSubscribe: delay?.days != null ? Math.round(Number(delay.days) * 10) / 10 : null,
    expirationRate: ratio(expired, trials),
  };
}
