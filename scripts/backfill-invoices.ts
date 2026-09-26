/**
 * Rattrapage du registre `invoices` depuis Stripe (CDC BO DOV-002, SUB-009).
 *
 *   npx tsx scripts/backfill-invoices.ts              # tous les comptes
 *   npx tsx scripts/backfill-invoices.ts 42 57        # comptes 42 et 57
 *
 * La table n'était alimentée par aucun code avant la migration 0180 : les
 * factures antérieures au déploiement du webhook n'y figurent pas. Ce script
 * relit, compte par compte, toutes les factures du client Stripe et les
 * écrit par le MÊME chemin que le webhook (`recordStripeInvoice`) : il est
 * idempotent et peut être relancé sans risque.
 */
import '@/lib/load-env';
import { isNotNull } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { accounts } from '@/db/schema';
import { backfillInvoicesForCustomer } from '@/services/billing/invoice-ledger.service';

async function main() {
  const only = new Set(process.argv.slice(2).map(Number).filter(Number.isFinite));
  const rows = await db
    .select({ id: accounts.id, customerId: accounts.stripeCustomerId })
    .from(accounts)
    .where(isNotNull(accounts.stripeCustomerId));

  let seen = 0;
  let recorded = 0;
  for (const row of rows) {
    if (only.size > 0 && !only.has(row.id)) continue;
    try {
      const r = await backfillInvoicesForCustomer(row.customerId!);
      seen += r.seen;
      recorded += r.recorded;
      console.info(`[backfill-invoices] compte ${row.id} : ${r.recorded}/${r.seen} facture(s)`);
    } catch (e) {
      console.error(`[backfill-invoices] compte ${row.id} :`, (e as Error).message);
    }
  }
  console.info(`[backfill-invoices] terminé : ${recorded} facture(s) enregistrée(s) sur ${seen} lue(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
