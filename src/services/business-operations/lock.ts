/**
 * Verrou des écritures Opération par compte — CDC Opérations V1 C24
 * (NFR-OP-001), B26.
 *
 * Toute écriture Opération d'un compte prend le verrou consultatif
 * TRANSACTIONNEL `pg_advisory_xact_lock(espace, compte)` : deux consolidations
 * concurrentes d'un même compte (deux instances, deux jobs) sont sérialisées,
 * un même candidat ne peut pas produire deux Opérations. Relâché au commit ou
 * à l'annulation. Même forme à deux entiers que
 * `field-evidence.service.ts` (`supersedeLockKeys`) et
 * `supplier-from-analysis.ts` (espace 22410).
 *
 * Plusieurs comptes (transfert de bien, Q14) : verrous pris dans l'ordre
 * croissant des comptes, jamais d'interblocage entre deux transferts croisés.
 */
import { sql } from 'drizzle-orm';
import type { db } from '@/db';

export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Espace du verrou consultatif des Opérations (distinct des autres espaces du code). */
export const BUSINESS_OPERATION_LOCK_SPACE = 39101;

/** Comptes à verrouiller, dédoublonnés et triés (ordre stable, sans interblocage). */
export function lockOrder(accountIds: readonly number[]): number[] {
  return [...new Set(accountIds.filter((a) => Number.isInteger(a) && a > 0))].sort((a, b) => a - b);
}

export async function lockOperationAccounts(tx: DbTx, accountIds: readonly number[]): Promise<number[]> {
  const ordre = lockOrder(accountIds);
  for (const accountId of ordre) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUSINESS_OPERATION_LOCK_SPACE}::int, ${accountId}::int)`);
  }
  return ordre;
}
