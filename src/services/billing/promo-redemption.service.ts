/**
 * Usages des codes promotionnels Stripe — CDC Back-Office V1 §8.3 (PRO-001 à
 * PRO-003).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Les codes promotionnels sont créés et configurés dans Stripe (PRO-001).
 * L'écran « Parrainages & promotions » affiche leurs usages, conversions
 * payantes et comptes concernés (PRO-002) en lisant `promo_codes` et
 * `signup_contexts` (resolved_code_type = 'promo_code'). Aucun code
 * n'enregistrait ces usages : l'écran restait vide et
 * `promo_codes.redemption_count` à 0 (audit BO §2.7).
 *
 * À la souscription (`checkout.session.completed`, `customer.subscription.
 * created` / `updated` portant une remise issue d'un code promotionnel), le
 * webhook enregistre :
 *   1. le code dans `promo_codes` s'il n'y figure pas encore (créé dans
 *      Stripe, jamais dans le BO) ;
 *   2. un usage `signup_contexts` (compte, code, identifiant Stripe) ;
 *   3. +1 sur `promo_codes.redemption_count`, SEULEMENT si l'usage est
 *      nouveau.
 *
 * IDEMPOTENCE : un usage par (compte, code promotionnel Stripe), garanti par
 * l'index unique partiel de la migration 0181. Les étapes 2 et 3 sont dans la
 * même transaction : le compteur ne peut pas diverger des usages.
 *
 * La ligne d'usage n'a PAS de user_id (l'unique `signup_contexts_user_uidx`
 * réserve cette ligne au contexte d'inscription/parrainage) et son statut est
 * 'redeemed', jamais 'valid' : `getStoredReferralCode` relirait sinon le code
 * promo comme un code de parrainage au checkout suivant.
 *
 * Un code appliqué via un coupon seul (sans code promotionnel) n'est pas un
 * « code promo » au sens du BO : ignoré.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { promoCodes, signupContexts } from '@/db/schema';
import { getStripeServer } from '@/lib/stripe';

type DiscountLike =
  | string
  | { promotion_code?: string | { id: string; code?: string } | null }
  | null
  | undefined;

/**
 * Identifiants de codes promotionnels présents dans une liste de remises
 * (session Checkout ou abonnement). Pure.
 *
 * `needsExpand` : l'abonnement ne porte que des identifiants de remise
 * (`di_…`) non développés ; il faut relire l'abonnement avec
 * `expand: ['discounts']` pour connaître leur code promotionnel.
 */
export function extractPromotionCodeIds(discounts: ReadonlyArray<DiscountLike> | null | undefined): {
  ids: string[];
  needsExpand: boolean;
} {
  const ids = new Set<string>();
  let needsExpand = false;
  for (const d of discounts ?? []) {
    if (!d) continue;
    if (typeof d === 'string') {
      needsExpand = true;
      continue;
    }
    const pc = d.promotion_code;
    const id = !pc ? null : typeof pc === 'string' ? pc : pc.id;
    if (id) ids.add(id);
  }
  return { ids: [...ids], needsExpand };
}

export interface PromoRedemptionInput {
  accountId: number;
  stripePromotionCodeId: string;
  /** Code lisible, s'il est déjà connu (objet développé). */
  code?: string | null;
  now?: Date;
}

type StripePromo = Pick<Stripe, 'promotionCodes'>;

/** Ligne `promo_codes` du code, créée si besoin. */
async function ensurePromoCode(
  stripePromotionCodeId: string,
  knownCode: string | null | undefined,
  stripe: StripePromo,
  now: Date,
): Promise<number> {
  const [existing] = await db
    .select({ id: promoCodes.id })
    .from(promoCodes)
    .where(eq(promoCodes.stripePromotionCodeId, stripePromotionCodeId))
    .limit(1);
  if (existing) return existing.id;

  let code = knownCode ?? null;
  let maxRedemptions: number | null = null;
  if (!code) {
    const promo = await stripe.promotionCodes.retrieve(stripePromotionCodeId);
    code = promo.code;
    maxRedemptions = promo.max_redemptions ?? null;
  }

  // Code saisi à la main dans une ligne existante sans identifiant Stripe :
  // on le rattache plutôt que d'échouer sur l'unicité de `code`.
  const [row] = await db
    .insert(promoCodes)
    .values({
      code: code!,
      status: 'active',
      stripePromotionCodeId,
      maxRedemptions,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: promoCodes.code,
      set: {
        stripePromotionCodeId: sql`COALESCE(${promoCodes.stripePromotionCodeId}, excluded.stripe_promotion_code_id)`,
        updatedAt: now,
      },
    })
    .returning({ id: promoCodes.id });
  return row.id;
}

/**
 * Enregistre l'usage d'un code promotionnel par un compte. Idempotent.
 * @returns `true` si l'usage est nouveau (compteur incrémenté).
 */
export async function recordPromoRedemption(
  input: PromoRedemptionInput,
  stripe: StripePromo = getStripeServer(),
): Promise<boolean> {
  const now = input.now ?? new Date();
  const promoId = await ensurePromoCode(input.stripePromotionCodeId, input.code, stripe, now);
  const [promo] = await db.select({ code: promoCodes.code }).from(promoCodes).where(eq(promoCodes.id, promoId)).limit(1);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(signupContexts)
      .values({
        userId: null,
        accountId: input.accountId,
        entryPoint: 'stripe_checkout',
        rawCode: promo?.code ?? input.code ?? null,
        codeSource: 'stripe_promotion_code',
        resolvedCodeType: 'promo_code',
        resolvedCodeId: promoId,
        validationStatus: 'redeemed',
        stripePromotionCodeId: input.stripePromotionCodeId,
        createdAt: now,
        // Sans objet pour un usage ; la colonne est NOT NULL.
        expiresAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: signupContexts.id });

    if (inserted.length === 0) return false;

    await tx
      .update(promoCodes)
      .set({ redemptionCount: sql`${promoCodes.redemptionCount} + 1`, updatedAt: now })
      .where(eq(promoCodes.id, promoId));
    return true;
  });
}

/** Usages portés par une session Checkout terminée. Ne lève jamais. */
export async function recordCheckoutPromoRedemptions(
  session: Pick<Stripe.Checkout.Session, 'id' | 'discounts'>,
  accountId: number,
  stripe: StripePromo = getStripeServer(),
): Promise<number> {
  const { ids } = extractPromotionCodeIds(session.discounts as DiscountLike[] | null);
  return recordAll(ids, accountId, stripe, `session ${session.id}`);
}

/**
 * Usages portés par un abonnement (code saisi hors Checkout, portail…).
 * Relit l'abonnement développé si ses remises ne sont que des identifiants.
 * Ne lève jamais.
 */
export async function recordSubscriptionPromoRedemptions(
  subscription: Pick<Stripe.Subscription, 'id' | 'discounts'>,
  accountId: number,
  stripe: StripePromo & Pick<Stripe, 'subscriptions'> = getStripeServer(),
): Promise<number> {
  try {
    const first = extractPromotionCodeIds(subscription.discounts as DiscountLike[]);
    const ids = first.needsExpand
      ? extractPromotionCodeIds(
          (await stripe.subscriptions.retrieve(subscription.id, { expand: ['discounts'] })).discounts as DiscountLike[],
        ).ids
      : first.ids;
    return recordAll(ids, accountId, stripe, `abonnement ${subscription.id}`);
  } catch (e) {
    console.error(`[promo] lecture des remises de ${subscription.id} impossible :`, (e as Error).message);
    return 0;
  }
}

async function recordAll(ids: string[], accountId: number, stripe: StripePromo, label: string): Promise<number> {
  let created = 0;
  for (const id of ids) {
    try {
      if (await recordPromoRedemption({ accountId, stripePromotionCodeId: id }, stripe)) created += 1;
    } catch (e) {
      // Un avantage commercial ne doit jamais faire échouer la souscription.
      console.error(`[promo] usage du code ${id} (${label}) non enregistré :`, (e as Error).message);
    }
  }
  return created;
}
