/**
 * Opérations engageant un prix — CDC lookup_key V4 LK-40, LK-42 à LK-45,
 * LK-54, LK-63, TC-30, TC-31, TC-32, TC-34.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE TENTATIVE, UNE CLÉ, UN ÉTAT PARTAGÉ
 *
 * Chaque opération (Checkout, montée en gamme, programmation, changement
 * admin) est enregistrée avec le prix EXACT résolu, sa révision, l'offre, la
 * cadence et le compte : c'est la référence acceptée de l'opération, qu'une
 * publication ultérieure ne modifie pas (LK-54, LK-95).
 *
 * Checkout : une seule tentative OUVERTE par compte (index unique partiel),
 * en base — donc partagée entre instances (TC-30). Clé d'idempotence Stripe
 * stable pour une même tentative (mêmes paramètres), nouvelle si les
 * paramètres changent ou si la tentative précédente est terminée — jamais
 * une clé unique à vie, jamais une valeur aléatoire par réessai réseau (LK-45).
 * Une réponse Stripe perdue laisse l'opération `uncertain` : la demande
 * suivante rejoue la MÊME clé et retrouve la session créée (TC-31).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { getStripeCatalogContext } from '@/lib/stripe-client';
import type { ResolvedPrice } from './catalog-types';

type Row = Record<string, unknown>;
type Exec = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
async function q<T = Row>(text: string, params: unknown[] = [], exec: Exec = pgClient as unknown as Exec): Promise<T[]> {
  return (await exec.unsafe(text, params as never[])) as T[];
}

export type OperationKind = 'checkout' | 'upgrade' | 'schedule' | 'admin';
export type OperationStatus = 'reserved' | 'created' | 'completed' | 'expired' | 'superseded' | 'failed' | 'uncertain';

export interface PriceOperation {
  id: number;
  kind: OperationKind;
  accountId: number | null;
  planCode: string;
  billingPeriod: string;
  stripePriceId: string;
  priceRevision: string;
  unitAmountCents: number;
  idempotencyKey: string;
  paramsHash: string;
  status: OperationStatus;
  stripeReference: string | null;
}

/** Empreinte des paramètres d'une tentative (pure). */
export function operationParamsHash(p: { accountId: number; price: Pick<ResolvedPrice, 'priceId' | 'priceRevision' | 'planCode' | 'billingPeriod'>; promoContext?: string | null; referralCode?: string | null; customerId?: string | null }): string {
  return createHash('sha256')
    .update([p.accountId, p.price.planCode, p.price.billingPeriod, p.price.priceId, p.price.priceRevision, p.promoContext ?? '', p.referralCode ?? '', p.customerId ?? ''].join('|'))
    .digest('hex')
    .slice(0, 20);
}

function map(r: Row): PriceOperation {
  const key = String(r.idempotency_key);
  return {
    id: Number(r.id),
    kind: r.kind as OperationKind,
    accountId: (r.account_id as number) ?? null,
    planCode: String(r.plan_code),
    billingPeriod: String(r.billing_period),
    stripePriceId: String(r.stripe_price_id),
    priceRevision: String(r.price_revision),
    unitAmountCents: Number(r.unit_amount_cents),
    idempotencyKey: key,
    paramsHash: key.split('.')[3] ?? '',
    status: r.status as OperationStatus,
    stripeReference: (r.stripe_reference as string) ?? null,
  };
}

export type CheckoutReservation =
  | { kind: 'new'; op: PriceOperation; superseded: PriceOperation | null }
  | { kind: 'same'; op: PriceOperation };

/**
 * Réserve la tentative de souscription du compte (LK-44). `same` : une
 * tentative ouverte aux MÊMES paramètres existe (double clic, deux
 * instances) — l'appelant la reprend. `new` : nouvelle tentative ; une
 * tentative ouverte aux paramètres différents est marquée remplacée et
 * renvoyée pour que sa session Stripe soit expirée.
 */
export async function reserveCheckout(p: {
  accountId: number; userId: number; price: ResolvedPrice; promoContext?: string | null; referralCode?: string | null; customerId?: string | null;
}): Promise<CheckoutReservation> {
  const ctx = getStripeCatalogContext().catalogContext;
  const ctxSafe = ctx.replace(/[^a-z0-9_-]/gi, '_');
  const hash = operationParamsHash(p);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await pgClient.begin(async (tx) => {
        const exec = tx as unknown as Exec;
        const [open] = await q(
          `SELECT * FROM billing_price_operations WHERE account_id = $1 AND kind = 'checkout' AND status IN ('reserved','created','uncertain') FOR UPDATE`,
          [p.accountId], exec,
        );
        if (open && map(open).paramsHash === hash) return { kind: 'same' as const, op: map(open) };
        let superseded: PriceOperation | null = null;
        if (open) {
          await q(`UPDATE billing_price_operations SET status = 'superseded', updated_at = now() WHERE id = $1`, [open.id], exec);
          superseded = map(open);
        }
        const [{ n }] = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM billing_price_operations WHERE account_id = $1 AND kind = 'checkout' AND idempotency_key LIKE $2`,
          [p.accountId, `vb-checkout.${ctxSafe}.${p.accountId}.${hash}.%`], exec,
        );
        // Format : vb-checkout.<contexte>.<compte>.<empreinte>.<n° de tentative>
        const key = `vb-checkout.${ctxSafe}.${p.accountId}.${hash}.${Number(n) + 1}`;
        const [row] = await q(
          `INSERT INTO billing_price_operations
             (catalog_context, kind, account_id, user_id, plan_code, billing_period, stripe_price_id, price_revision, unit_amount_cents,
              currency, idempotency_key, promo_context, referral_code, status, initiator)
           VALUES ($1,'checkout',$2,$3,$4,$5,$6,$7,$8,'eur',$9,$10,$11,'reserved','user') RETURNING *`,
          [ctx, p.accountId, p.userId, p.price.planCode, p.price.billingPeriod, p.price.priceId, p.price.priceRevision, p.price.unitAmountCents,
            key, p.promoContext ?? null, p.referralCode ?? null], exec,
        );
        return { kind: 'new' as const, op: map(row), superseded };
      });
    } catch (e) {
      // Course entre deux instances : l'index unique partiel en refuse une ;
      // la seconde relit et reprend la tentative gagnante.
      if ((e as { code?: string }).code === '23505' && attempt < 2) continue;
      throw e;
    }
  }
  throw new Error('Réservation de tentative impossible');
}

export async function markOperation(id: number, status: OperationStatus, patch: { stripeReference?: string | null; error?: string | null } = {}): Promise<void> {
  await q(
    `UPDATE billing_price_operations SET status = $2, stripe_reference = COALESCE($3, stripe_reference), error = COALESCE($4, error), updated_at = now() WHERE id = $1`,
    [id, status, patch.stripeReference ?? null, patch.error ?? null],
  );
}

/** Clôt la tentative ouverte d'un compte (paiement appliqué). */
export async function completeOpenCheckout(accountId: number, sessionId?: string | null): Promise<void> {
  await q(
    `UPDATE billing_price_operations SET status = 'completed', updated_at = now()
      WHERE account_id = $1 AND kind = 'checkout' AND status IN ('reserved','created','uncertain')
        AND ($2::text IS NULL OR stripe_reference = $2 OR stripe_reference IS NULL)`,
    [accountId, sessionId ?? null],
  ).catch(() => undefined);
}

/**
 * Trace d'une opération hors Checkout (montée en gamme, programmation,
 * admin) : prix accepté, ancien prix, initiateur (LK-40, LK-54, LK-63).
 */
export async function recordPriceOperation(p: {
  kind: Exclude<OperationKind, 'checkout'>;
  accountId: number;
  userId?: number | null;
  price: ResolvedPrice;
  previousPriceId?: string | null;
  previousAmountCents?: number | null;
  initiator: string;
  stripeReference?: string | null;
  status?: OperationStatus;
}): Promise<number | null> {
  const ctx = getStripeCatalogContext().catalogContext;
  const key = `vb-${p.kind}.${ctx.replace(/[^a-z0-9_-]/gi, '_')}.${p.accountId}.${p.price.priceRevision}.${Date.now()}`;
  try {
    const [row] = await q<{ id: number }>(
      `INSERT INTO billing_price_operations
         (catalog_context, kind, account_id, user_id, plan_code, billing_period, stripe_price_id, price_revision, unit_amount_cents,
          currency, previous_price_id, previous_amount_cents, idempotency_key, status, stripe_reference, initiator)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'eur',$10,$11,$12,$13,$14,$15) RETURNING id`,
      [ctx, p.kind, p.accountId, p.userId ?? null, p.price.planCode, p.price.billingPeriod, p.price.priceId, p.price.priceRevision,
        p.price.unitAmountCents, p.previousPriceId ?? null, p.previousAmountCents ?? null, key, p.status ?? 'created', p.stripeReference ?? null, p.initiator],
    );
    return Number(row.id);
  } catch (e) {
    console.error('[price-operations] trace non écrite :', (e as Error).message);
    return null;
  }
}

/**
 * Opération de changement de prix encore en cours sur un compte (LK-54) :
 * montée en gamme (session de portail ouverte, paiement possible) ou
 * changement admin de moins de 10 minutes, vers une AUTRE cible que celle
 * demandée. Un nouveau clic vers la même cible reste permis.
 */
export async function pendingMutation(accountId: number, opts: { targetRevision?: string | null; now?: Date } = {}): Promise<PriceOperation | null> {
  const now = opts.now ?? new Date();
  const [r] = await q(
    `SELECT * FROM billing_price_operations WHERE account_id = $1 AND kind IN ('upgrade','admin') AND status IN ('reserved','created','uncertain')
       AND created_at > $2::timestamptz AND ($3::text IS NULL OR price_revision <> $3) ORDER BY id DESC LIMIT 1`,
    [accountId, new Date(now.getTime() - 10 * 60_000).toISOString(), opts.targetRevision ?? null],
  ).catch(() => []);
  return r ? map(r) : null;
}

/** L'abonnement porte désormais le prix d'une montée en gamme : opération close. */
export async function completeMutationsForPrice(accountId: number, priceId: string): Promise<void> {
  await q(
    `UPDATE billing_price_operations SET status = 'completed', updated_at = now()
      WHERE account_id = $1 AND kind IN ('upgrade','admin','schedule') AND status IN ('reserved','created','uncertain') AND stripe_price_id = $2`,
    [accountId, priceId],
  ).catch(() => undefined);
}
