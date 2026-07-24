/**
 * Catalogue serveur des prix Stripe (CDC tarification V2).
 *
 * 3 offres x 2 periodicites = 6 prix recurrents.
 *
 * REGLE DE SECURITE (CDC §5.6 / §16) :
 * le frontend ne transmet JAMAIS un montant ni un Price ID. Il envoie
 * uniquement un couple (planCode, billingPeriod) ; le serveur resout
 * lui-meme le Price ID via cette table. Tout couple inconnu est rejete.
 */

export type PlanCode = 'standard' | 'premium' | 'premium_duo';
export type BillingPeriod = 'monthly' | 'yearly';

export interface PriceDefinition {
  /** Variable d'environnement portant le Price ID Stripe. */
  envVar: string;
  /** Montant TTC en centimes — sert a creer/verifier le prix, jamais a facturer directement. */
  amountCents: number;
  /** Intervalle Stripe. */
  interval: 'month' | 'year';
}

/** Libelles produits Stripe (un produit par offre). */
export const PLAN_PRODUCTS: Record<PlanCode, { name: string; description: string }> = {
  standard: {
    name: 'Verebona Standard',
    description: "L'essentiel pour organiser vos biens et vos documents.",
  },
  premium: {
    name: 'Verebona Premium',
    description: 'Toute la puissance de Verebona.',
  },
  premium_duo: {
    name: 'Verebona Premium Duo',
    description: 'Toute la puissance de Verebona, a deux.',
  },
};

/** Les 6 prix du CDC. */
export const PRICE_CATALOG: Record<PlanCode, Record<BillingPeriod, PriceDefinition>> = {
  standard: {
    monthly: { envVar: 'STRIPE_PRICE_STANDARD_MONTHLY', amountCents: 290, interval: 'month' },
    yearly: { envVar: 'STRIPE_PRICE_STANDARD_YEARLY', amountCents: 2900, interval: 'year' },
  },
  premium: {
    monthly: { envVar: 'STRIPE_PRICE_PREMIUM_MONTHLY', amountCents: 590, interval: 'month' },
    yearly: { envVar: 'STRIPE_PRICE_PREMIUM_YEARLY', amountCents: 5900, interval: 'year' },
  },
  premium_duo: {
    monthly: { envVar: 'STRIPE_PRICE_PREMIUM_DUO_MONTHLY', amountCents: 890, interval: 'month' },
    yearly: { envVar: 'STRIPE_PRICE_PREMIUM_DUO_YEARLY', amountCents: 8900, interval: 'year' },
  },
};

const PLAN_CODES: PlanCode[] = ['standard', 'premium', 'premium_duo'];
const BILLING_PERIODS: BillingPeriod[] = ['monthly', 'yearly'];

/** Garde de type : le planCode recu est-il une offre souscriptible ? */
export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && (PLAN_CODES as string[]).includes(value);
}

/** Garde de type : la periodicite recue est-elle valide ? */
export function isBillingPeriod(value: unknown): value is BillingPeriod {
  return typeof value === 'string' && (BILLING_PERIODS as string[]).includes(value);
}

/**
 * Resout le Price ID Stripe autorise pour un couple (offre, periodicite).
 * Leve une erreur si le couple est inconnu ou si la variable d'env est absente.
 */
export function resolvePriceId(planCode: PlanCode, period: BillingPeriod): string {
  const def = PRICE_CATALOG[planCode]?.[period];
  if (!def) {
    throw new Error(`Couple offre/periodicite invalide : ${planCode}/${period}`);
  }
  const priceId = process.env[def.envVar];
  if (!priceId) {
    throw new Error(`Price ID Stripe manquant : ${def.envVar} n'est pas defini`);
  }
  return priceId;
}

/** Montant attendu (centimes) pour un couple — utilise pour verification/affichage serveur. */
export function expectedAmountCents(planCode: PlanCode, period: BillingPeriod): number {
  return PRICE_CATALOG[planCode][period].amountCents;
}

/**
 * Retrouve l'offre et la periodicite a partir d'un Price ID Stripe.
 * Indispensable au traitement des webhooks (on ne fait jamais confiance
 * a des metadonnees seules).
 */
export function resolvePlanFromPriceId(
  priceId: string | null | undefined,
): { planCode: PlanCode; period: BillingPeriod } | null {
  if (!priceId) return null;
  for (const planCode of PLAN_CODES) {
    for (const period of BILLING_PERIODS) {
      if (process.env[PRICE_CATALOG[planCode][period].envVar] === priceId) {
        return { planCode, period };
      }
    }
  }
  return null;
}

/** Liste des 6 variables d'environnement attendues (diagnostic / demarrage). */
export function listRequiredPriceEnvVars(): string[] {
  return PLAN_CODES.flatMap((p) => BILLING_PERIODS.map((b) => PRICE_CATALOG[p][b].envVar));
}

/** Retourne les variables de prix manquantes — utile pour un health-check. */
export function missingPriceEnvVars(): string[] {
  return listRequiredPriceEnvVars().filter((name) => !process.env[name]);
}
