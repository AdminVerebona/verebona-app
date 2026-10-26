/**
 * Rappel J−7 des abonnements annuels — RÉCONCILIATION PLANIFIÉE avec Stripe
 * (lot 72F, ticket P1 « Fiabiliser le rappel J−7 », §5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * Le traitement du rappel ne revérifie chez Stripe que les candidats
 * PRÉSÉLECTIONNÉS par la copie locale (`account_subscriptions`). Un webhook
 * manqué (local « mensuel », « résilié », échéance périmée, abonnement absent)
 * écartait donc SILENCIEUSEMENT un rappel légitime.
 *
 * Désormais, chaque jour avant la fenêtre d'envoi (tâche
 * `subscription-annual-renewal-reconcile`, créée suspendue, activée à la
 * bascule) :
 *   1. liste chez Stripe les abonnements ACTIFS (pages de 100, bornée par le
 *      délai) ; ne retient que les abonnements ANNUELS dont l'échéance tombe
 *      dans l'horizon (9 jours) — le pré-filtre local du rappel reste la règle
 *      pour limiter les appels ;
 *   2. compare à la copie locale : abonnement absent, statut, périodicité,
 *      échéance, résiliation programmée ;
 *   3. écart → resynchronisation par le service EXISTANT
 *      (`subscription-sync.service.ts`, `syncSubscriptionFromStripe`, sans
 *      notification client), puis relecture ; écart persistant ou compte
 *      introuvable → anomalie journalisée (`annual_renewal_reminder_checks` :
 *      DESYNC_UNRESOLVED / STRIPE_ONLY), visible dans le BO ;
 *   4. sens inverse (liste complète seulement) : abonnement local annuel actif
 *      dans l'horizon mais absent des abonnements actifs Stripe → relu et
 *      resynchronisé (résiliation immédiate, impayé…).
 * Une échéance resynchronisée est vérifiée par le passage suivant du rappel
 * (aucun envoi ici). Rien n'est jamais déduit de la seule copie locale.
 *
 * LOT 76D
 *   · statut comparé dans les DEUX sens selon les correspondances de
 *     subscription-sync (active/trialing → active, past_due → past_due,
 *     canceled/unpaid/incomplete_expired → canceled ; paused/incomplete : non
 *     écrits par la synchronisation → un local « active » est une divergence
 *     persistante, journalisée) ;
 *   · parcours inverse : chaque relecture Stripe en échec est PERSISTÉE
 *     (`annual-renewal-reconcile:<abonnement>:<échéance locale>`, résultat
 *     RECONCILE_ERROR, échéance locale marquée non revérifiée, étape, motif
 *     expurgé, prochaine tentative = prochain passage) et visible dans le BO ;
 *     reprise réussie → RECONCILE_RESOLVED (historique conservé) ; un passage
 *     partiel ou en erreur n'est jamais présenté comme réussi.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { pgClient } from '@/db';
import { parisNow } from '@/lib/notifications/time-paris';
import { annualRenewalDedupeKey, parisDateOf, redactSecrets } from './annual-renewal-reminder.rules';
import { recordCheck, stripeErrorReason } from './annual-renewal-reminder.service';

/** Sous-ensemble du client Stripe (injectable dans les tests). */
interface ReconcileStripe {
  subscriptions: {
    list(p: { status?: string; limit?: number; starting_after?: string }): Promise<{ data: unknown[]; has_more: boolean }>;
    retrieve(id: string): Promise<unknown>;
  };
}

/** Horizon : un peu plus que le rappel (J−7) et son pré-filtre (8 jours). */
const RECONCILE_HORIZON_DAYS = 9;
const DAY_MS = 86_400_000;
const PAGE = 100;

interface ReconcileResult {
  /** Abonnements actifs lus chez Stripe. */
  scanned: number;
  /** Annuels dont l'échéance tombe dans l'horizon. */
  inWindow: number;
  consistent: number;
  resynced: number;
  unresolved: number;
  stripeOnly: number;
  /** Abonnements locaux absents des actifs Stripe, relus. */
  localOnlyChecked: number;
  errors: number;
  /** Liste Stripe parcourue jusqu'au bout. */
  complete: boolean;
  /** Lot 76D : parcours inverse mené jusqu'au bout (non interrompu par le délai). */
  reverseComplete: boolean;
}

/** Lot 76D : clé du journal d'une relecture en échec du parcours inverse (hors présélection du rappel). */
const reconcileErrorKey = (subscriptionId: string, localRenewalDate: string) => `annual-renewal-reconcile:${subscriptionId}:${localRenewalDate}`;
/** Heure de la tâche planifiée (catalogue), pour la prochaine tentative affichée. */
async function reconcileTaskAt(): Promise<[number, number]> {
  const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
  const sch = SCHEDULED_TASKS.find((t) => t.code === 'subscription-annual-renewal-reconcile')?.schedule as { kind?: string; at?: [number, number] } | undefined;
  return sch?.kind === 'daily' && sch.at ? [sch.at[0], sch.at[1]] : [7, 40];
}

interface StripeView {
  id: string;
  customer: string | null;
  status: string;
  annual: boolean;
  renewalTs: number | null;
  cancelScheduled: boolean;
}

/** Vue comparable d'un abonnement Stripe (pure ; lot 83E : réutilisée par le contrôle de cohérence COH-BILLING-STRIPE). */
export function viewOf(raw: unknown): StripeView {
  const s = raw as {
    id: string; status: string; customer?: string | { id: string } | null; cancel_at_period_end?: boolean | null; cancel_at?: number | null;
    items?: { data?: Array<{ current_period_end?: number | null; price?: { recurring?: { interval?: string | null; interval_count?: number | null } | null } | null }> };
  };
  const items = s.items?.data ?? [];
  const recurring = items.filter((i) => i.price?.recurring);
  const annual = recurring.length > 0 && recurring.every((i) => i.price?.recurring?.interval === 'year' && (i.price?.recurring?.interval_count ?? 1) === 1);
  const ends = items.map((i) => i.current_period_end).filter((v): v is number => typeof v === 'number' && v > 0);
  return {
    id: s.id,
    customer: !s.customer ? null : typeof s.customer === 'string' ? s.customer : s.customer.id,
    status: s.status,
    annual,
    renewalTs: ends.length ? Math.min(...ends) : null,
    cancelScheduled: !!s.cancel_at_period_end || !!s.cancel_at,
  };
}

interface LocalRow {
  account_id: number;
  status: string | null;
  billing_period: string | null;
  cancel_at_period_end: boolean | null;
  current_period_end_at: string | null;
}

async function readLocal(subscriptionId: string): Promise<LocalRow | null> {
  const [r] = await pgClient.unsafe<LocalRow[]>(
    `SELECT s.account_id, s.status, s.billing_period, s.cancel_at_period_end, s.current_period_end_at
       FROM account_subscriptions s WHERE s.stripe_subscription_id = $1
     UNION ALL
     SELECT a.id, s.status, s.billing_period, s.cancel_at_period_end, s.current_period_end_at
       FROM accounts a LEFT JOIN account_subscriptions s ON s.account_id = a.id
      WHERE a.stripe_subscription_id = $1 AND (s.stripe_subscription_id IS NULL OR s.stripe_subscription_id <> $1)
     LIMIT 1`,
    [subscriptionId as never],
  );
  return r ?? null;
}

/**
 * Lot 76D — statut local attendu pour un statut Stripe (correspondances de
 * `subscription-sync.service.ts`) ; null : état que la synchronisation n'écrit
 * pas (paused, incomplete) — l'abonnement n'est alors jamais « active » localement.
 */
export function expectedLocalStatus(stripeStatus: string): 'active' | 'past_due' | 'canceled' | null {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  if (stripeStatus === 'past_due') return 'past_due';
  if (stripeStatus === 'canceled' || stripeStatus === 'unpaid' || stripeStatus === 'incomplete_expired') return 'canceled';
  return null;
}

/** Écarts entre Stripe et la copie locale qui faussent la présélection du rappel (pur). */
export function desyncReasons(v: StripeView, local: LocalRow | null): string[] {
  if (!local) return ['LOCAL_MISSING'];
  const out: string[] = [];
  // Lot 76D : dans les deux sens (local actif devenu past_due / unpaid / canceled / paused chez Stripe).
  const expected = expectedLocalStatus(v.status);
  if (expected ? local.status !== expected : local.status === 'active') out.push('STATUS');
  if (v.annual && local.billing_period !== 'yearly') out.push('BILLING_PERIOD');
  if (!!local.cancel_at_period_end !== v.cancelScheduled) out.push('CANCELLATION');
  const localEnd = local.current_period_end_at ? Math.floor(new Date(local.current_period_end_at).getTime() / 1000) : null;
  if (v.renewalTs != null && (localEnd == null || Math.abs(localEnd - v.renewalTs) > 120)) out.push('PERIOD_END');
  return out;
}

type Sync = (sub: unknown) => Promise<{ accountId: number } | null>;

async function defaultSync(sub: unknown): Promise<{ accountId: number } | null> {
  const { syncSubscriptionFromStripe } = await import('./subscription-sync.service');
  const r = await syncSubscriptionFromStripe({ subscription: sub as Stripe.Subscription, source: 'annual-reminder-reconcile', notify: false });
  return r && !r.skipped ? { accountId: r.accountId } : null;
}

async function defaultStripe(): Promise<ReconcileStripe> {
  const { getStripeServer } = await import('@/lib/stripe');
  return getStripeServer() as unknown as ReconcileStripe;
}

/** Un passage de réconciliation. Idempotent ; n'envoie jamais d'e-mail. */
export async function runAnnualRenewalReconciliation(opts: { now?: Date; stripe?: ReconcileStripe; deadline?: number; sync?: Sync; horizonDays?: number } = {}): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Date.now() + 8 * 60_000;
  const stripe = opts.stripe ?? await defaultStripe();
  const sync = opts.sync ?? defaultSync;
  const horizonEnd = now.getTime() + (opts.horizonDays ?? RECONCILE_HORIZON_DAYS) * DAY_MS;
  const today = parisNow(now).dateStr;
  const result: ReconcileResult = { scanned: 0, inWindow: 0, consistent: 0, resynced: 0, unresolved: 0, stripeOnly: 0, localOnlyChecked: 0, errors: 0, complete: false, reverseComplete: false };
  const seen = new Set<string>();

  const journal = async (v: StripeView, accountId: number | null, outcome: 'DESYNC_RESYNCED' | 'DESYNC_UNRESOLVED' | 'STRIPE_ONLY', reason: string, localEnd: string | null = null) => {
    // Lot 76D : sans échéance Stripe (abonnement terminé), échéance locale — jamais d'écart silencieux.
    const endTs = v.renewalTs ?? (localEnd ? Math.floor(new Date(localEnd).getTime() / 1000) : null);
    if (endTs == null) return;
    const renewalDate = parisDateOf(new Date(endTs * 1000));
    // Prochaine vérification : IMMÉDIATE (le passage suivant du rappel revérifie chez Stripe).
    await recordCheck({
      key: annualRenewalDedupeKey(v.id, renewalDate), accountId, subscriptionId: v.id, renewalDate, today,
      outcome, reason: reason.slice(0, 300), jobId: null, step: 'RECONCILE', now, next: now,
    });
  };

  const handle = async (raw: unknown, v: StripeView): Promise<void> => {
    const before = await readLocal(v.id);
    const diff = desyncReasons(v, before);
    if (diff.length === 0) { result.consistent += 1; return; }
    try {
      const synced = await sync(raw);
      const after = await readLocal(v.id);
      if (!synced && !after) {
        result.stripeOnly += 1;
        await journal(v, null, 'STRIPE_ONLY', 'Aucun compte Verebona pour cet abonnement Stripe');
        return;
      }
      const left = desyncReasons(v, after);
      const localEnd = after?.current_period_end_at ?? before?.current_period_end_at ?? null;
      if (left.length === 0) {
        result.resynced += 1;
        await journal(v, after?.account_id ?? synced?.accountId ?? null, 'DESYNC_RESYNCED', `Écarts corrigés : ${diff.join(', ')}`, localEnd);
      } else {
        result.unresolved += 1;
        console.warn(`[annual-renewal-reconcile] divergence persistante (${v.id}, Stripe ${v.status}) : ${left.join(', ')}`);
        await journal(v, after?.account_id ?? synced?.accountId ?? null, 'DESYNC_UNRESOLVED', `Écarts persistants : ${left.join(', ')} (Stripe : ${v.status})`, localEnd);
      }
    } catch (e) {
      result.errors += 1;
      result.unresolved += 1;
      await journal(v, before?.account_id ?? null, 'DESYNC_UNRESOLVED', `Resynchronisation impossible : ${stripeErrorReason(e)}`, before?.current_period_end_at ?? null);
    }
  };

  // 1-3. Abonnements ACTIFS chez Stripe.
  let after: string | undefined;
  try {
    for (;;) {
      if (Date.now() >= deadline) break;
      const page = await stripe.subscriptions.list({ status: 'active', limit: PAGE, ...(after ? { starting_after: after } : {}) });
      for (const raw of page.data) {
        const v = viewOf(raw);
        result.scanned += 1;
        seen.add(v.id);
        if (!v.annual || v.renewalTs == null) continue;
        const end = v.renewalTs * 1000;
        if (end <= now.getTime() || end > horizonEnd) continue;
        result.inWindow += 1;
        await handle(raw, v);
      }
      if (!page.has_more || page.data.length === 0) { result.complete = true; break; }
      after = (page.data[page.data.length - 1] as { id: string }).id;
    }
  } catch (e) {
    result.errors += 1;
    console.error(`[annual-renewal-reconcile] liste Stripe interrompue : ${stripeErrorReason(e)}`);
  }

  // 4. Sens inverse : locaux annuels actifs dans l'horizon, absents des actifs Stripe,
  //    et (lot 76D) abonnements dont une relecture précédente a échoué (reprise).
  if (result.complete) {
    const nextAttempt = await nextReconcileRun(now);
    const locals = await pgClient.unsafe<{ stripe_subscription_id: string; account_id: number | null; current_period_end_at: string | null }[]>(
      `SELECT s.stripe_subscription_id, s.account_id, s.current_period_end_at FROM account_subscriptions s
        WHERE s.stripe_subscription_id IS NOT NULL AND s.status = 'active' AND s.billing_period = 'yearly'
          AND s.current_period_end_at > $1::timestamptz AND s.current_period_end_at <= $2::timestamptz
       UNION
       SELECT k.stripe_subscription_id, k.account_id, s.current_period_end_at FROM annual_renewal_reminder_checks k
         LEFT JOIN account_subscriptions s ON s.stripe_subscription_id = k.stripe_subscription_id
        WHERE k.outcome = 'RECONCILE_ERROR' AND k.candidate_key LIKE 'annual-renewal-reconcile:%'
        ORDER BY 3 NULLS LAST LIMIT 500`,
      [now.toISOString(), new Date(horizonEnd).toISOString()] as never[],
    );
    result.reverseComplete = true;
    const done = new Set<string>();
    for (const l of locals) {
      if (done.has(l.stripe_subscription_id)) continue;
      done.add(l.stripe_subscription_id);
      if (seen.has(l.stripe_subscription_id)) {
        // Relu avec succès dans la liste des actifs : une erreur antérieure est reprise.
        await resolveReconcileErrors(l.stripe_subscription_id, now, today);
        continue;
      }
      if (Date.now() >= deadline) { result.reverseComplete = false; break; }
      result.localOnlyChecked += 1;
      let raw: unknown;
      try {
        raw = await stripe.subscriptions.retrieve(l.stripe_subscription_id);
      } catch (e) {
        result.errors += 1;
        const why = stripeErrorReason(e);
        console.error(`[annual-renewal-reconcile] relecture impossible (${l.stripe_subscription_id}) : ${why}`);
        // Lot 76D : trace INDIVIDUELLE persistante (échéance locale non revérifiée, prochaine tentative).
        const localDate = l.current_period_end_at ? parisDateOf(new Date(l.current_period_end_at)) : today;
        await recordCheck({
          key: reconcileErrorKey(l.stripe_subscription_id, localDate), accountId: l.account_id, subscriptionId: l.stripe_subscription_id,
          renewalDate: localDate, today, outcome: 'RECONCILE_ERROR', reason: `Relecture Stripe impossible : ${why}`.slice(0, 300),
          jobId: null, step: 'RECONCILE_REVERSE', now, next: nextAttempt, renewalDateVerified: false,
        });
        continue;
      }
      await handle(raw, viewOf(raw));
      await resolveReconcileErrors(l.stripe_subscription_id, now, today);
    }
  }

  const partial = !result.complete || !result.reverseComplete || result.errors > 0;
  const note = redactSecrets(`${partial ? 'PASSAGE PARTIEL — ' : ''}${result.scanned} abonnement(s) actifs lus${result.complete ? '' : ' (liste incomplète)'}, ${result.inWindow} annuel(s) à échéance proche, `
    + `${result.resynced} resynchronisé(s), ${result.unresolved} non résolu(s), ${result.stripeOnly} absent(s) localement, ${result.localOnlyChecked} local(aux) relu(s), ${result.errors} erreur(s)`);
  await pgClient.unsafe(
    `INSERT INTO annual_renewal_reminder_state (id, last_reconcile_at, last_reconcile_note, updated_at) VALUES (1, $1::timestamptz, $2, $1::timestamptz)
     ON CONFLICT (id) DO UPDATE SET last_reconcile_at = EXCLUDED.last_reconcile_at, last_reconcile_note = EXCLUDED.last_reconcile_note, updated_at = EXCLUDED.updated_at`,
    [now.toISOString(), note] as never[],
  );
  return result;
}

/** Lot 76D : prochain passage de la tâche de réconciliation (prochaine tentative d'une relecture en échec). */
async function nextReconcileRun(now: Date): Promise<Date> {
  const { parisWallTimeToDate } = await import('@/services/scheduling/task-calendar');
  const { addDaysToDateStr } = await import('@/lib/notifications/time-paris');
  const today = parisNow(now).dateStr;
  const at = await reconcileTaskAt();
  const todayRun = parisWallTimeToDate(today, at);
  return todayRun.getTime() > now.getTime() ? todayRun : parisWallTimeToDate(addDaysToDateStr(today, 1), at);
}

/** Lot 76D : reprise réussie — anomalies de relecture closes, historique conservé. */
async function resolveReconcileErrors(subscriptionId: string, now: Date, today: string): Promise<void> {
  const open = await pgClient.unsafe<{ candidate_key: string; account_id: number | null; renewal_date: string }[]>(
    `SELECT candidate_key, account_id, renewal_date::text AS renewal_date FROM annual_renewal_reminder_checks
      WHERE stripe_subscription_id = $1 AND outcome = 'RECONCILE_ERROR' AND candidate_key LIKE 'annual-renewal-reconcile:%'`,
    [subscriptionId as never],
  );
  if (!open.length) return;
  for (const o of open) {
    await recordCheck({
      key: o.candidate_key, accountId: o.account_id, subscriptionId, renewalDate: o.renewal_date, today, outcome: 'RECONCILE_RESOLVED',
      reason: 'Relecture Stripe réussie : réconciliation reprise', jobId: null, step: 'RECONCILE_REVERSE', now, next: null, renewalDateVerified: false,
    });
  }
}

/**
 * Lot 76D — compte rendu de la tâche planifiée : un passage partiel (liste
 * incomplète, parcours inverse interrompu, relecture en échec) ou avec des
 * désynchronisations non résolues est en ÉCHEC, jamais « réussi ».
 */
export function describeReconcileRun(r: ReconcileResult): { note: string; error?: string } {
  const note = `${r.scanned} abonnement(s) actifs lus, ${r.inWindow} annuel(s) à échéance proche, ${r.resynced} resynchronisé(s), `
    + `${r.unresolved} non résolu(s), ${r.stripeOnly} absent(s) localement, ${r.localOnlyChecked} local(aux) relu(s), ${r.errors} erreur(s)`;
  if (!r.complete) return { note, error: 'Liste des abonnements Stripe incomplète (délai ou erreur Stripe) : nouvel essai demain ; voir BO › Communications › Rappel J−7.' };
  if (r.errors > 0) return { note, error: `${r.errors} relecture(s) ou resynchronisation(s) Stripe en échec : réconciliation PARTIELLE, nouvel essai au prochain passage ; voir BO › Communications › Rappel J−7.` };
  if (!r.reverseComplete) return { note, error: 'Contrôle des abonnements locaux interrompu (délai) : réconciliation PARTIELLE, nouvel essai au prochain passage.' };
  if (r.unresolved > 0 || r.stripeOnly > 0) return { note, error: `${r.unresolved + r.stripeOnly} désynchronisation(s) non résolue(s) : voir BO › Communications › Rappel J−7.` };
  return { note };
}
