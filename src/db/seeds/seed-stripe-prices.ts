/**
 * Creation des produits et prix Stripe (CDC tarification V2).
 *
 * Cree — de maniere idempotente — 3 produits et 6 prix recurrents,
 * puis affiche les variables d'environnement a renseigner et met a jour
 * subscription_plans en base.
 *
 * Usage :
 *   npx tsx src/db/seeds/stripe-prices.ts            # cree/verifie + met a jour la base
 *   npx tsx src/db/seeds/stripe-prices.ts --dry-run  # affiche seulement ce qui serait fait
 *
 * L'environnement (Test ou Production) depend de STRIPE_SECRET_KEY :
 *   sk_test_... -> mode Test | sk_live_... -> mode Production
 *
 * Les anciens prix ne sont JAMAIS modifies ni supprimes (CDC §5.4) : ce script
 * ne fait que creer les nouveaux et laisser les anciens en place.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { db } from '../index';
import { subscriptionPlans } from '../schema';
import { eq } from 'drizzle-orm';
import {
  PLAN_PRODUCTS,
  PRICE_CATALOG,
  type PlanCode,
  type BillingPeriod,
} from '../../lib/stripe-prices';

const DRY_RUN = process.argv.includes('--dry-run');

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error('STRIPE_SECRET_KEY est absent. Verifiez votre .env.');
  process.exit(1);
}
const stripe = new Stripe(secretKey, { apiVersion: '2025-08-27.basil', typescript: true });
const MODE = secretKey.startsWith('sk_live') ? 'PRODUCTION' : 'TEST';

/** Cle stable permettant de retrouver un produit deja cree. */
const productLookup = (plan: PlanCode) => `verebona_${plan}`;
/** Cle stable Stripe (lookup_key) permettant l'idempotence des prix. */
const priceLookup = (plan: PlanCode, period: BillingPeriod) => `verebona_${plan}_${period}`;

async function ensureProduct(plan: PlanCode): Promise<string> {
  const lookup = productLookup(plan);
  const existing = await stripe.products.search({ query: `metadata['verebona_plan']:'${lookup}'` });
  if (existing.data.length > 0) {
    console.log(`  produit existant : ${existing.data[0].id} (${plan})`);
    return existing.data[0].id;
  }
  if (DRY_RUN) {
    console.log(`  [dry-run] creerait le produit ${PLAN_PRODUCTS[plan].name}`);
    return 'prod_DRYRUN';
  }
  const created = await stripe.products.create({
    name: PLAN_PRODUCTS[plan].name,
    description: PLAN_PRODUCTS[plan].description,
    metadata: { verebona_plan: lookup },
  });
  console.log(`  produit CREE : ${created.id} (${plan})`);
  return created.id;
}

async function ensurePrice(
  plan: PlanCode,
  period: BillingPeriod,
  productId: string,
): Promise<string> {
  const def = PRICE_CATALOG[plan][period];
  const lookup = priceLookup(plan, period);

  const existing = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
  if (existing.data.length > 0) {
    const price = existing.data[0];
    if (price.unit_amount !== def.amountCents) {
      console.warn(
        `  ATTENTION ${lookup} : montant en place ${price.unit_amount} != attendu ${def.amountCents}. ` +
          `Un prix Stripe est immuable : creez un nouveau prix si le tarif doit changer.`,
      );
    }
    console.log(`  prix existant : ${price.id} (${lookup})`);
    return price.id;
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] creerait le prix ${lookup} = ${def.amountCents} cents / ${def.interval}`);
    return 'price_DRYRUN';
  }

  const created = await stripe.prices.create({
    product: productId,
    currency: 'eur',
    unit_amount: def.amountCents,
    recurring: { interval: def.interval },
    lookup_key: lookup,
    metadata: { verebona_plan: plan, verebona_period: period },
  });
  console.log(`  prix CREE : ${created.id} (${lookup})`);
  return created.id;
}

async function main() {
  console.log(`\n=== Stripe — mode ${MODE}${DRY_RUN ? ' (DRY RUN)' : ''} ===\n`);

  const plans: PlanCode[] = ['standard', 'premium', 'premium_duo'];
  const periods: BillingPeriod[] = ['monthly', 'yearly'];
  const result: Record<string, { monthly: string; yearly: string }> = {};

  for (const plan of plans) {
    console.log(`${PLAN_PRODUCTS[plan].name}`);
    const productId = await ensureProduct(plan);
    const ids = { monthly: '', yearly: '' };
    for (const period of periods) {
      ids[period] = await ensurePrice(plan, period, productId);
    }
    result[plan] = ids;
    console.log('');
  }

  // --- Variables d'environnement a renseigner ---
  console.log('--- A copier dans votre .env ---');
  for (const plan of plans) {
    for (const period of periods) {
      console.log(`${PRICE_CATALOG[plan][period].envVar}=${result[plan][period]}`);
    }
  }
  console.log('');

  // --- Mise a jour de la base ---
  if (DRY_RUN) {
    console.log('[dry-run] la base n\'a pas ete modifiee.');
    return;
  }
  for (const plan of plans) {
    await db
      .update(subscriptionPlans)
      .set({
        stripePriceIdMonthly: result[plan].monthly,
        stripePriceIdYearly: result[plan].yearly,
        monthlyPriceCents: PRICE_CATALOG[plan].monthly.amountCents,
        yearlyPriceCents: PRICE_CATALOG[plan].yearly.amountCents,
        updatedAt: new Date(),
      })
      .where(eq(subscriptionPlans.code, plan));
    console.log(`base mise a jour : ${plan}`);
  }
  console.log('\nTermine.\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[stripe-prices] Erreur :', err instanceof Error ? err.message : err);
    process.exit(1);
  });
