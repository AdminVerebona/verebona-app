/**
 * Types et règles PURES du catalogue Stripe par lookup_key — CDC V4 §5.3,
 * LK-10 à LK-16, LK-30, §17.2.
 *
 * Aucun accès réseau ni base : tout ce qui est ici est testable seul.
 */
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import {
  PERIOD_INTERVAL,
  coupleKey,
  planFromMetadataValue,
  type BillingPeriod,
  type CatalogCouple,
  type PlanCode,
} from '@/lib/billing/plan-catalog';

export type TaxBehavior = 'inclusive' | 'exclusive' | 'unspecified';
export type CoupleKey = `${PlanCode}:${BillingPeriod}`;

/** Prix courant résolu et validé (contrat §5.3). */
export interface ResolvedPrice {
  planCode: PlanCode;
  billingPeriod: BillingPeriod;
  lookupKey: string;
  priceId: string;
  productId: string;
  unitAmountCents: number;
  currency: 'eur';
  interval: 'month' | 'year';
  intervalCount: 1;
  taxBehavior: TaxBehavior;
  livemode: boolean;
  priceRevision: string;
  verifiedAt: string;
}

/** Photographie d'une révision de catalogue (persistée en JSON). */
export interface CatalogSnapshot {
  version: string;
  verifiedAt: string;
  entries: Partial<Record<CoupleKey, ResolvedPrice>>;
  /** Couples indisponibles et motif stable (clé absente, conflit…). */
  unavailable: Partial<Record<CoupleKey, string>>;
  source: 'sync' | 'publish' | 'rollback' | 'bootstrap';
}

// ─── Erreurs stables (§17.2) ─────────────────────────────────────────────────

export type BillingCatalogErrorCode =
  | 'INVALID_PLAN'
  | 'INVALID_BILLING_PERIOD'
  | 'FORBIDDEN_BILLING_ACTION'
  | 'PRICE_CONFIRMATION_REQUIRED'
  | 'PRICE_CHANGED'
  | 'BILLING_CATALOG_UPDATING'
  | 'PRICE_UNAVAILABLE'
  | 'CATALOG_INVALID'
  | 'STRIPE_UNAVAILABLE';

export const CATALOG_ERROR_HTTP: Record<BillingCatalogErrorCode, number> = {
  INVALID_PLAN: 400,
  INVALID_BILLING_PERIOD: 400,
  FORBIDDEN_BILLING_ACTION: 403,
  PRICE_CONFIRMATION_REQUIRED: 409,
  PRICE_CHANGED: 409,
  BILLING_CATALOG_UPDATING: 503,
  PRICE_UNAVAILABLE: 503,
  CATALOG_INVALID: 503,
  STRIPE_UNAVAILABLE: 503,
};

export const CATALOG_ERROR_MESSAGES: Record<BillingCatalogErrorCode, string> = {
  INVALID_PLAN: "L'offre demandée est invalide.",
  INVALID_BILLING_PERIOD: 'La périodicité demandée est invalide.',
  FORBIDDEN_BILLING_ACTION: "Seul le titulaire de l'abonnement peut effectuer cette action. Aucun changement n'a été fait.",
  PRICE_CONFIRMATION_REQUIRED: 'Merci de confirmer le tarif affiché avant de continuer.',
  PRICE_CHANGED: "Le tarif a changé depuis l'affichage de cette page. Vérifiez le nouveau montant avant de continuer.",
  BILLING_CATALOG_UPDATING: "Les offres sont momentanément en cours de mise à jour. Aucun paiement n'a été lancé.",
  PRICE_UNAVAILABLE: "Cette offre est momentanément indisponible. Aucun paiement n'a été lancé.",
  CATALOG_INVALID: "Cette offre est momentanément indisponible. Aucun paiement n'a été lancé.",
  STRIPE_UNAVAILABLE: "Le paiement est momentanément indisponible. Aucun paiement n'a été lancé.",
};

/** Offre publique renvoyée avec un 409 PRICE_CHANGED (nouveau montant à confirmer). */
export interface PublicOffer {
  plan_code: PlanCode;
  billing_period: BillingPeriod;
  unit_amount_cents: number;
  currency: 'eur';
  interval: 'month' | 'year';
  interval_count: 1;
  price_revision: string;
  available: boolean;
  tax_included: boolean;
}

export class BillingCatalogError extends Error {
  readonly httpStatus: number;
  constructor(
    public readonly code: BillingCatalogErrorCode,
    detail?: string,
    public readonly offer?: PublicOffer,
  ) {
    super(detail ?? CATALOG_ERROR_MESSAGES[code]);
    this.name = 'BillingCatalogError';
    this.httpStatus = CATALOG_ERROR_HTTP[code];
  }
  /** Corps JSON d'API : code stable + message sobre (jamais le détail technique). */
  toBody(): Record<string, unknown> {
    return {
      code: this.code,
      error: this.code,
      message: CATALOG_ERROR_MESSAGES[this.code],
      ...(this.offer ? { offer: this.offer, details: { offer: this.offer } } : {}),
    };
  }
}

// ─── Empreintes (LK-30) ──────────────────────────────────────────────────────

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Révision d'un prix : empreinte stable de ses caractéristiques tarifaires.
 * Un simple rafraîchissement ne la change pas ; un nouveau Price, oui.
 */
export function priceRevisionOf(p: Pick<ResolvedPrice, 'priceId' | 'unitAmountCents' | 'currency' | 'interval' | 'intervalCount' | 'taxBehavior'>): string {
  return `pr_${sha([p.priceId, p.unitAmountCents, p.currency, p.interval, p.intervalCount, p.taxBehavior].join('|')).slice(0, 16)}`;
}

/** Version globale d'un catalogue : empreinte des révisions disponibles. */
export function catalogVersionOf(entries: CatalogSnapshot['entries']): string {
  const parts = Object.entries(entries)
    .filter((e): e is [string, ResolvedPrice] => Boolean(e[1]))
    .map(([k, v]) => `${k}=${v.priceRevision}`)
    .sort();
  return `cv_${sha(parts.join('\n')).slice(0, 16)}`;
}

/** Le montant est-il TTC sans taxe ajoutée (LK-15, LK-16) ? */
export function isTaxIncluded(taxBehavior: TaxBehavior): boolean {
  // `inclusive` : TTC. `unspecified` (prix historiques créés sans réglage) :
  // aucun calcul de taxe n'est activé dans les parcours Verebona (pas de
  // `automatic_tax`) — le montant facturé est exactement `unit_amount`.
  // `exclusive` est refusé à la vente (une TVA pourrait s'ajouter).
  return taxBehavior !== 'exclusive';
}

export function toPublicOffer(p: ResolvedPrice, available = true): PublicOffer {
  return {
    plan_code: p.planCode,
    billing_period: p.billingPeriod,
    unit_amount_cents: p.unitAmountCents,
    currency: p.currency,
    interval: p.interval,
    interval_count: 1,
    price_revision: p.priceRevision,
    available,
    tax_included: isTaxIncluded(p.taxBehavior),
  };
}

// ─── Validation d'un Price Stripe (LK-11, LK-12, TC-04 à TC-08) ──────────────

export type PriceValidationCode =
  | 'PRICE_INACTIVE'
  | 'LOOKUP_KEY_MISMATCH'
  | 'WRONG_MODE'
  | 'WRONG_CURRENCY'
  | 'NOT_RECURRING'
  | 'WRONG_INTERVAL'
  | 'USAGE_METERED'
  | 'NOT_PER_UNIT'
  | 'INVALID_AMOUNT'
  | 'CUSTOM_AMOUNT'
  | 'TRANSFORM_QUANTITY'
  | 'TAX_EXCLUSIVE'
  | 'PRODUCT_NOT_APPROVED'
  | 'PRODUCT_INACTIVE'
  | 'METADATA_CONFLICT';

export type PriceValidation =
  | { ok: true; resolved: ResolvedPrice }
  | { ok: false; code: PriceValidationCode; detail: string };

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  !v ? null : typeof v === 'string' ? v : v.id;

export function productIdOf(price: Pick<Stripe.Price, 'product'>): string | null {
  return idOf(price.product as string | { id: string } | null);
}

/**
 * Valide un Price Stripe pour la VENTE d'un couple. Pure.
 *
 * `saleProductId` : produit de vente approuvé pour l'offre dans ce contexte
 * (LK-03) — une recherche par nom n'est jamais une preuve. Aucun montant
 * n'est comparé à une constante (LK-13) : seul le modèle V1 est contrôlé.
 */
export function validateSalePrice(
  price: Stripe.Price,
  expected: CatalogCouple,
  opts: { livemode: boolean | null; saleProductId: string | null; checkLookupKey?: boolean; verifiedAt: string },
): PriceValidation {
  const fail = (code: PriceValidationCode, detail: string): PriceValidation => ({ ok: false, code, detail });
  if (!price.active) return fail('PRICE_INACTIVE', `${price.id} inactif`);
  if (opts.checkLookupKey !== false && price.lookup_key !== expected.lookupKey) {
    return fail('LOOKUP_KEY_MISMATCH', `${price.id} porte ${price.lookup_key ?? '∅'} et non ${expected.lookupKey}`);
  }
  if (opts.livemode !== null && price.livemode !== opts.livemode) {
    return fail('WRONG_MODE', `${price.id} livemode=${price.livemode}`);
  }
  if ((price.currency ?? '').toLowerCase() !== 'eur') return fail('WRONG_CURRENCY', `${price.id} en ${price.currency}`);
  if (price.type !== 'recurring' || !price.recurring) return fail('NOT_RECURRING', `${price.id} non récurrent`);
  if (price.recurring.interval !== PERIOD_INTERVAL[expected.billingPeriod] || (price.recurring.interval_count ?? 1) !== 1) {
    return fail('WRONG_INTERVAL', `${price.id} : ${price.recurring.interval_count ?? 1} ${price.recurring.interval} pour ${expected.lookupKey}`);
  }
  if ((price.recurring.usage_type ?? 'licensed') !== 'licensed') return fail('USAGE_METERED', `${price.id} usage ${price.recurring.usage_type}`);
  if ((price.billing_scheme ?? 'per_unit') !== 'per_unit') return fail('NOT_PER_UNIT', `${price.id} paliers`);
  if (price.custom_unit_amount) return fail('CUSTOM_AMOUNT', `${price.id} prix libre`);
  if (price.transform_quantity) return fail('TRANSFORM_QUANTITY', `${price.id} quantité transformée`);
  if (!Number.isInteger(price.unit_amount) || (price.unit_amount ?? 0) <= 0) return fail('INVALID_AMOUNT', `${price.id} montant ${price.unit_amount}`);
  const taxBehavior = (price.tax_behavior ?? 'unspecified') as TaxBehavior;
  if (taxBehavior === 'exclusive') return fail('TAX_EXCLUSIVE', `${price.id} hors taxes`);

  const productId = productIdOf(price);
  if (!productId || !opts.saleProductId || productId !== opts.saleProductId) {
    return fail('PRODUCT_NOT_APPROVED', `${price.id} sous ${productId ?? '∅'} (attendu ${opts.saleProductId ?? 'aucun produit approuvé'})`);
  }
  const product = typeof price.product === 'object' && price.product && !('deleted' in price.product && price.product.deleted)
    ? (price.product as Stripe.Product)
    : null;
  if (product && product.active === false) return fail('PRODUCT_INACTIVE', `${productId} inactif`);

  // Métadonnées : contrôlées lorsqu'elles existent, jamais suffisantes (LK-12).
  const metaPlan = planFromMetadataValue(price.metadata?.verebona_plan);
  const metaPeriod = price.metadata?.verebona_period;
  const productPlan = planFromMetadataValue(product?.metadata?.verebona_plan);
  if ((price.metadata?.verebona_plan && metaPlan !== expected.planCode)
    || (metaPeriod && metaPeriod !== expected.billingPeriod)
    || (product?.metadata?.verebona_plan && productPlan !== expected.planCode)) {
    return fail('METADATA_CONFLICT', `${price.id} : métadonnées contradictoires avec ${expected.lookupKey}`);
  }

  const base = {
    priceId: price.id,
    unitAmountCents: price.unit_amount as number,
    currency: 'eur' as const,
    interval: PERIOD_INTERVAL[expected.billingPeriod],
    intervalCount: 1 as const,
    taxBehavior,
  };
  return {
    ok: true,
    resolved: {
      planCode: expected.planCode,
      billingPeriod: expected.billingPeriod,
      lookupKey: expected.lookupKey,
      productId,
      livemode: price.livemode,
      priceRevision: priceRevisionOf(base),
      verifiedAt: opts.verifiedAt,
      ...base,
    },
  };
}

/**
 * Regroupe les prix par `lookup_key` — jamais par la position dans la
 * réponse (LK-09, TC-02). Les prix sans clé sont ignorés.
 */
export function groupByLookupKey(prices: Stripe.Price[]): Map<string, Stripe.Price[]> {
  const out = new Map<string, Stripe.Price[]>();
  for (const p of prices) {
    if (!p.lookup_key) continue;
    out.set(p.lookup_key, [...(out.get(p.lookup_key) ?? []), p]);
  }
  return out;
}

export { coupleKey };
