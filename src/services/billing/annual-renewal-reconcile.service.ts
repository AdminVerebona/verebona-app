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
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { pgClient } from '@/db';
import { parisNow } from '@/lib/notifications/time-paris';
import { annualRenewalDedupeKey, parisDateOf, redactSecrets } from './annual-renewal-reminder.rules';
import { recordCheck, stripeErrorReason } from './annual-renewal-reminder.service';

/** Sous-ensemble du client Stripe (injectable dans les tests). */
export interface ReconcileStripe {
  subscriptions: {
    list(p: { status?: string; limit?: number; starting_after?: string }): Promise<{ data: unknown[]; has_more: boolean }>;
    retrieve(id: string): Promise<unknown>;
  };
}

/** Horizon : un peu plus que le rappel (J−7) et son pré-filtre (8 jours). */
export const RECONCILE_HORIZON_DAYS = 9;
const DAY_MS = 86_400_000;
const PAGE = 100;

export interface ReconcileResult {
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
}

interface StripeView {
  id: string;
  customer: string | null;
  status: string;
  annual: boolean;
  renewalTs: number | null;
  cancelScheduled: boolean;
}

function viewOf(raw: unknown): StripeView {
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

/** Écarts entre Stripe et la copie locale qui faussent la présélection du rappel (pur). */
export function desyncReasons(v: StripeView, local: LocalRow | null): string[] {
  if (!local) return ['LOCAL_MISSING'];
  const out: string[] = [];
  if (v.status === 'active' && local.status !== 'active') out.push('STATUS');
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
  const result: ReconcileResult = { scanned: 0, inWindow: 0, consistent: 0, resynced: 0, unresolved: 0, stripeOnly: 0, localOnlyChecked: 0, errors: 0, complete: false };
  const seen = new Set<string>();

  const journal = async (v: StripeView, accountId: number | null, outcome: 'DESYNC_RESYNCED' | 'DESYNC_UNRESOLVED' | 'STRIPE_ONLY', reason: string) => {
    if (v.renewalTs == null) return;
    const renewalDate = parisDateOf(new Date(v.renewalTs * 1000));
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
      if (left.length === 0) {
        result.resynced += 1;
        await journal(v, after?.account_id ?? synced?.accountId ?? null, 'DESYNC_RESYNCED', `Écarts corrigés : ${diff.join(', ')}`);
      } else {
        result.unresolved += 1;
        await journal(v, after?.account_id ?? synced?.accountId ?? null, 'DESYNC_UNRESOLVED', `Écarts persistants : ${left.join(', ')}`);
      }
    } catch (e) {
      result.errors += 1;
      result.unresolved += 1;
      await journal(v, before?.account_id ?? null, 'DESYNC_UNRESOLVED', `Resynchronisation impossible : ${stripeErrorReason(e)}`);
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

  // 4. Sens inverse : locaux annuels actifs dans l'horizon, absents des actifs Stripe.
  if (result.complete) {
    const locals = await pgClient.unsafe<{ stripe_subscription_id: string }[]>(
      `SELECT s.stripe_subscription_id FROM account_subscriptions s
        WHERE s.stripe_subscription_id IS NOT NULL AND s.status = 'active' AND s.billing_period = 'yearly'
          AND s.current_period_end_at > $1::timestamptz AND s.current_period_end_at <= $2::timestamptz
        ORDER BY s.current_period_end_at LIMIT 500`,
      [now.toISOString(), new Date(horizonEnd).toISOString()] as never[],
    );
    for (const l of locals) {
      if (seen.has(l.stripe_subscription_id) || Date.now() >= deadline) continue;
      result.localOnlyChecked += 1;
      try {
        const raw = await stripe.subscriptions.retrieve(l.stripe_subscription_id);
        const v = viewOf(raw);
        await handle(raw, v);
      } catch (e) {
        result.errors += 1;
        console.error(`[annual-renewal-reconcile] relecture impossible (${l.stripe_subscription_id}) : ${stripeErrorReason(e)}`);
      }
    }
  }

  const note = redactSecrets(`${result.scanned} abonnement(s) actifs lus${result.complete ? '' : ' (liste incomplète)'}, ${result.inWindow} annuel(s) à échéance proche, `
    + `${result.resynced} resynchronisé(s), ${result.unresolved} non résolu(s), ${result.stripeOnly} absent(s) localement, ${result.errors} erreur(s)`);
  await pgClient.unsafe(
    `INSERT INTO annual_renewal_reminder_state (id, last_reconcile_at, last_reconcile_note, updated_at) VALUES (1, $1::timestamptz, $2, $1::timestamptz)
     ON CONFLICT (id) DO UPDATE SET last_reconcile_at = EXCLUDED.last_reconcile_at, last_reconcile_note = EXCLUDED.last_reconcile_note, updated_at = EXCLUDED.updated_at`,
    [now.toISOString(), note] as never[],
  );
  return result;
}
