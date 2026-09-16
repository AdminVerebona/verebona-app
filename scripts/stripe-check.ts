/**
 * Diagnostic de la configuration Stripe d'un environnement.
 *
 *   npm run stripe:check            # lecture seule
 *   npm run stripe:check -- --fix   # purge les identifiants Stripe orphelins (mode test uniquement)
 *
 * Vérifie, avec la clé chargée depuis l'env :
 *   1. le mode de la clé (test/live) et sa cohérence avec NEXT_PUBLIC_APP_ENV ;
 *   2. le mode réellement renvoyé par l'API ;
 *   3. l'URL publique de l'app, le secret de webhook, et l'endpoint déclaré
 *      chez Stripe (URL, activation, événements) ;
 *   4. les 6 prix V2 : existence, actifs, bon mode, bon montant, bon intervalle ;
 *   5. les comptes dont le `stripe_customer_id` est introuvable dans ce mode.
 *
 * Sort en code 1 si un problème est détecté.
 */
import '@/lib/load-env';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, accountSubscriptions, duoAccounts } from '@/db/schema';
import {
  assertStripeConfig,
  getExpectedStripeMode,
  getStripeKeyMode,
  getStripeServer,
  StripeConfigError,
} from '@/lib/stripe';
import { isStripeResourceMissing } from '@/lib/stripe-customer';
import { getAppBaseUrl } from '@/lib/app-url';

/** Événements dont dépend l'activation d'un abonnement. */
const REQUIRED_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];
import { PRICE_CATALOG, type BillingPeriod, type PlanCode } from '@/lib/stripe-prices';

const FIX = process.argv.includes('--fix');
let problems = 0;

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const ko = (msg: string) => { problems += 1; console.log(`  ✗ ${msg}`); };
const info = (msg: string) => console.log(`    ${msg}`);

async function main() {
  console.log('\n[stripe:check] 1. Clé et environnement');
  const keyMode = getStripeKeyMode(process.env.STRIPE_SECRET_KEY);
  info(`NEXT_PUBLIC_APP_ENV = ${process.env.NEXT_PUBLIC_APP_ENV ?? '(absente)'}`);
  info(`STRIPE_EXPECTED_MODE = ${process.env.STRIPE_EXPECTED_MODE ?? '(absente)'}`);
  info(`mode attendu = ${getExpectedStripeMode() ?? 'non déterminé'} · mode de la clé = ${keyMode ?? 'inconnu'}`);
  try {
    assertStripeConfig();
    ok('clé cohérente avec l\'environnement');
  } catch (e) {
    if (e instanceof StripeConfigError) {
      ko(`${e.code} : ${e.message}`);
      console.log('\nArrêt : corriger la clé avant tout autre contrôle.\n');
      process.exit(1);
    }
    throw e;
  }
  const stripe = getStripeServer();

  console.log('\n[stripe:check] 2. Mode confirmé par l\'API');
  const balance = await stripe.balance.retrieve();
  const apiMode = balance.livemode ? 'live' : 'test';
  if (apiMode === keyMode) ok(`l'API répond en mode ${apiMode}`);
  else ko(`l'API répond en mode ${apiMode}, la clé annonce ${keyMode}`);

  console.log('\n[stripe:check] 3. URL publique et webhook');
  const appUrl = getAppBaseUrl();
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    ko('NEXT_PUBLIC_APP_URL absente : les retours Stripe dépendront des en-têtes du proxy');
  } else if (/localhost|127\.0\.0\.1/.test(appUrl) && (process.env.NEXT_PUBLIC_APP_ENV ?? 'local') !== 'local') {
    ko(`NEXT_PUBLIC_APP_URL pointe sur ${appUrl} : Stripe renverrait le client vers une adresse locale`);
  } else {
    ok(`retours Stripe vers ${appUrl}`);
  }

  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (whsec?.startsWith('whsec_')) ok('STRIPE_WEBHOOK_SECRET renseigné');
  else ko('STRIPE_WEBHOOK_SECRET absent ou mal formé (whsec_…)');

  const expectedWebhookUrl = `${appUrl}/api/billing/stripe-webhook`;
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const endpoint = endpoints.data.find((e) => e.url.replace(/\/+$/, '') === expectedWebhookUrl);
  if (!endpoint) {
    ko(`aucun endpoint webhook en mode ${apiMode} sur ${expectedWebhookUrl}`);
    for (const e of endpoints.data) info(`existant : ${e.url} (${e.status})`);
  } else {
    if (endpoint.status === 'enabled') ok(`endpoint ${endpoint.id} actif sur ${endpoint.url}`);
    else ko(`endpoint ${endpoint.id} désactivé`);
    const events = endpoint.enabled_events;
    const missing = events.includes('*') ? [] : REQUIRED_WEBHOOK_EVENTS.filter((ev) => !events.includes(ev));
    if (missing.length === 0) ok('événements requis abonnés');
    else ko(`événements manquants : ${missing.join(', ')}`);
    info('le secret whsec_ de cet endpoint doit être celui de STRIPE_WEBHOOK_SECRET (non vérifiable par l\'API)');
  }

  console.log('\n[stripe:check] 4. Prix V2');
  for (const [plan, periods] of Object.entries(PRICE_CATALOG) as [PlanCode, typeof PRICE_CATALOG[PlanCode]][]) {
    for (const [period, def] of Object.entries(periods) as [BillingPeriod, typeof periods[BillingPeriod]][]) {
      const priceId = process.env[def.envVar];
      const label = `${def.envVar}`.padEnd(34);
      if (!priceId) { ko(`${label} non définie`); continue; }
      try {
        const price = await stripe.prices.retrieve(priceId);
        const issues: string[] = [];
        if (!price.active) issues.push('inactif');
        if (price.livemode !== (apiMode === 'live')) issues.push(`mode ${price.livemode ? 'live' : 'test'}`);
        if (price.unit_amount !== def.amountCents) issues.push(`montant ${price.unit_amount} ≠ ${def.amountCents}`);
        if (price.recurring?.interval !== def.interval) issues.push(`intervalle ${price.recurring?.interval ?? 'aucun'} ≠ ${def.interval}`);
        if (price.currency !== 'eur') issues.push(`devise ${price.currency}`);
        if (issues.length === 0) ok(`${label} ${priceId} (${plan}/${period})`);
        else ko(`${label} ${priceId} : ${issues.join(', ')}`);
      } catch (e) {
        if (isStripeResourceMissing(e)) ko(`${label} ${priceId} introuvable en mode ${apiMode}`);
        else throw e;
      }
    }
  }

  console.log('\n[stripe:check] 5. Clients Stripe des comptes');
  const rows = await db
    .select({
      id: accounts.id,
      ownerUserId: accounts.ownerUserId,
      stripeCustomerId: accounts.stripeCustomerId,
      subscriptionStatus: accounts.subscriptionStatus,
    })
    .from(accounts)
    .where(isNotNull(accounts.stripeCustomerId));

  const orphans: typeof rows = [];
  for (const row of rows) {
    try {
      const customer = await stripe.customers.retrieve(row.stripeCustomerId!);
      if ((customer as { deleted?: boolean }).deleted) orphans.push(row);
    } catch (e) {
      if (isStripeResourceMissing(e)) orphans.push(row);
      else throw e;
    }
  }

  if (orphans.length === 0) {
    ok(`${rows.length} compte(s) avec client Stripe, tous valides en mode ${apiMode}`);
  } else {
    ko(`${orphans.length}/${rows.length} compte(s) pointent vers un client introuvable en mode ${apiMode}`);
    for (const o of orphans) {
      const warn = ['ACTIVE', 'TRIALING', 'PAST_DUE_GRACE'].includes((o.subscriptionStatus ?? '').toUpperCase())
        ? '  ⚠ statut d\'abonnement actif à revoir manuellement'
        : '';
      info(`compte ${o.id} → ${o.stripeCustomerId} (statut ${o.subscriptionStatus ?? 'NONE'})${warn}`);
    }

    if (FIX && apiMode === 'live') {
      console.log('\n  --fix refusé en mode live : aucune purge automatique en production.');
    } else if (FIX) {
      for (const o of orphans) {
        const oldId = o.stripeCustomerId!;
        await db.update(accounts).set({
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          checkoutSessionId: null,
          checkoutSessionCreatedAt: null,
          updatedAt: new Date(),
        }).where(eq(accounts.id, o.id));
        await db.update(accountSubscriptions).set({
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          updatedAt: new Date(),
        }).where(and(eq(accountSubscriptions.accountId, o.id), eq(accountSubscriptions.stripeCustomerId, oldId)));
        await db.update(duoAccounts).set({
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          updatedAt: new Date(),
        }).where(and(eq(duoAccounts.billingOwnerUserId, o.ownerUserId), eq(duoAccounts.stripeCustomerId, oldId)));
      }
      console.log(`\n  ${orphans.length} compte(s) purgé(s). Un nouveau client sera créé au prochain paiement.`);
      problems -= 1;
    } else {
      info('relancer avec --fix pour purger ces identifiants (sinon ils sont réparés au prochain clic « Choisir »)');
    }
  }

  console.log(problems > 0 ? `\n[stripe:check] ✗ ${problems} problème(s) détecté(s).\n` : '\n[stripe:check] ✓ configuration Stripe cohérente.\n');
  process.exit(problems > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[stripe:check] erreur inattendue :', e instanceof Error ? e.message : e);
  process.exit(1);
});
