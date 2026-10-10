/**
 * Dictionnaire STATIQUE des six couples offre × périodicité — CDC
 * « Migration Stripe vers lookup_key » V4, LK-01, LK-04, LK-08, §5.2.
 *
 * Module pur, utilisable côté client comme côté serveur : AUCUN secret,
 * AUCUN montant, AUCUN appel Stripe. Les montants vivent dans le manifeste
 * tarifaire serveur (`services/billing/pricing-manifest.ts`) et, pour la
 * vente, dans la révision active publiée (`price-catalog.service.ts`).
 *
 * Les clés stables reprennent la convention déjà posée par l'ancien seed
 * (`verebona_<offre>_<monthly|yearly>`) : aucun montant, année, version ou
 * environnement dans la clé (LK-01). Les mêmes noms servent en test et en
 * live : le cloisonnement est assuré par le contexte de catalogue (LK-02).
 */

export type PlanCode = 'standard' | 'premium' | 'premium_duo';
export type BillingPeriod = 'monthly' | 'yearly';
export type StripeInterval = 'month' | 'year';

export const PLAN_CODES: readonly PlanCode[] = ['standard', 'premium', 'premium_duo'];
export const BILLING_PERIODS: readonly BillingPeriod[] = ['monthly', 'yearly'];

export const PERIOD_INTERVAL: Readonly<Record<BillingPeriod, StripeInterval>> = {
  monthly: 'month',
  yearly: 'year',
};

/** Clé stable Stripe (`lookup_key`) d'un couple. */
export function lookupKeyFor(plan: PlanCode, period: BillingPeriod): string {
  return `verebona_${plan}_${period}`;
}

export interface CatalogCouple {
  planCode: PlanCode;
  billingPeriod: BillingPeriod;
  lookupKey: string;
  interval: StripeInterval;
}

/** Les six couples, dans l'ordre d'affichage. */
export const CATALOG_COUPLES: readonly CatalogCouple[] = PLAN_CODES.flatMap((planCode) =>
  BILLING_PERIODS.map((billingPeriod) => ({
    planCode,
    billingPeriod,
    lookupKey: lookupKeyFor(planCode, billingPeriod),
    interval: PERIOD_INTERVAL[billingPeriod],
  })),
);

export const ALL_LOOKUP_KEYS: readonly string[] = CATALOG_COUPLES.map((c) => c.lookupKey);

/** Couple d'une clé stable, ou `null` si la clé n'appartient pas au catalogue. */
export function coupleFromLookupKey(key: string | null | undefined): CatalogCouple | null {
  if (!key) return null;
  return CATALOG_COUPLES.find((c) => c.lookupKey === key) ?? null;
}

/** Clé de dictionnaire interne `offre:périodicité`. */
export function coupleKey(plan: PlanCode, period: BillingPeriod): `${PlanCode}:${BillingPeriod}` {
  return `${plan}:${period}`;
}

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && (PLAN_CODES as readonly string[]).includes(value);
}

export function isBillingPeriod(value: unknown): value is BillingPeriod {
  return typeof value === 'string' && (BILLING_PERIODS as readonly string[]).includes(value);
}

/** Périodicité Verebona d'un intervalle Stripe (`interval_count` = 1 uniquement). */
export function periodOfInterval(interval: string | null | undefined, intervalCount: number | null | undefined = 1): BillingPeriod | null {
  if ((intervalCount ?? 1) !== 1) return null;
  if (interval === 'month') return 'monthly';
  if (interval === 'year') return 'yearly';
  return null;
}

/** Rang des offres : une montée en gamme va vers un rang supérieur. */
export const PLAN_RANK: Readonly<Record<PlanCode, number>> = {
  standard: 1,
  premium: 2,
  premium_duo: 3,
};

/** Vrai si `to` est une offre supérieure à `from` (montée en gamme). */
export function isUpgrade(from: string | null | undefined, to: string): boolean {
  if (!from || !isPlanCode(from) || !isPlanCode(to)) return false;
  return PLAN_RANK[to] > PLAN_RANK[from];
}

// ─── Validation stricte des entrées (LK-37, LK-08, EC-13, TC-09) ─────────────

export type PlanInputResult =
  | { ok: true; plan: PlanCode }
  | { ok: false; code: 'INVALID_PLAN' };

/**
 * Offre demandée par un navigateur. Seule une CHAÎNE est acceptée ; l'alias
 * historique `duo` est normalisé explicitement. Aucune valeur inconnue ne
 * retombe sur Premium ; Premium Pro (à venir) n'est pas souscriptible.
 */
export function parsePlanInput(value: unknown): PlanInputResult {
  if (typeof value !== 'string') return { ok: false, code: 'INVALID_PLAN' };
  const normalized = value.trim().toLowerCase();
  const plan = normalized === 'duo' ? 'premium_duo' : normalized;
  return isPlanCode(plan) ? { ok: true, plan } : { ok: false, code: 'INVALID_PLAN' };
}

export type PeriodInputResult =
  | { ok: true; period: BillingPeriod }
  | { ok: false; code: 'INVALID_BILLING_PERIOD' };

/** Périodicité demandée : chaîne `monthly` | `yearly`, jamais de défaut silencieux. */
export function parseBillingPeriodInput(value: unknown): PeriodInputResult {
  if (typeof value !== 'string') return { ok: false, code: 'INVALID_BILLING_PERIOD' };
  const normalized = value.trim().toLowerCase();
  return isBillingPeriod(normalized) ? { ok: true, period: normalized } : { ok: false, code: 'INVALID_BILLING_PERIOD' };
}

/**
 * Révision de prix affichée, transmise par le navigateur (LK-34). Contrôle de
 * cohérence seulement : jamais une autorisation ni un montant.
 */
export function parseDisplayedRevision(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return /^pr_[a-f0-9]{8,64}$/.test(v) ? v : null;
}

// ─── Métadonnées Stripe (LK-04) ──────────────────────────────────────────────

/**
 * Offre lue dans une métadonnée `verebona_plan`. L'ancien seed écrivait
 * `verebona_<offre>` sur le PRODUIT et `<offre>` sur le PRIX : les deux formes
 * sont reconnues, explicitement. Une métadonnée n'autorise jamais seule un
 * prix (LK-04) : elle sert à l'audit et à détecter une contradiction.
 */
export function planFromMetadataValue(value: string | null | undefined): PlanCode | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const stripped = v.startsWith('verebona_') ? v.slice('verebona_'.length) : v;
  return isPlanCode(stripped) ? stripped : null;
}

// ─── Affichage (LK-32) ───────────────────────────────────────────────────────

const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

/** Montant en centimes → « 3,90 € », « 39,00 € ». Calculs toujours en centimes entiers. */
export function formatEuroCents(cents: number): string {
  return EUR.format(cents / 100);
}

/** Libellé court d'une offre. */
export const PLAN_LABELS: Readonly<Record<PlanCode, string>> = {
  standard: 'Standard',
  premium: 'Premium',
  premium_duo: 'Premium Duo',
};
