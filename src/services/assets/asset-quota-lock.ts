/**
 * Carte #849 (A2) — décompte ATOMIQUE du quota de biens actifs.
 *
 * Création d'un bien, remise en service d'un bien transmis, annulation d'une
 * carte « À traiter » qui le remet en service : chacune compte les biens
 * EN_SERVICE non supprimés puis écrit. Deux demandes simultanées du même
 * compte pouvaient lire le même décompte et dépasser ensemble le quota.
 *
 * Verrou consultatif TRANSACTIONNEL par compte (`pg_advisory_xact_lock`,
 * espace 849) pris AVANT le décompte, libéré au commit : les écritures qui
 * consomment le quota d'un même compte sont sérialisées ; les autres comptes
 * ne sont jamais bloqués.
 */
import { sql } from 'drizzle-orm';
import type { db } from '@/db';
import { quotaCountedAssetSql } from '@/lib/asset-status';

type Runner = Pick<typeof db, 'execute'>;

/** Espace du verrou consultatif du quota de biens (distinct des autres espaces du code). */
export const ASSET_QUOTA_LOCK_SPACE = 849;

export async function lockAssetQuota(tx: Runner, accountId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ASSET_QUOTA_LOCK_SPACE}::int, ${accountId}::int)`);
}

/** Biens comptés dans le quota (EN_SERVICE non supprimés), lus par `runner` (sous verrou de préférence). */
export async function countQuotaAssetsIn(runner: Runner, accountId: number): Promise<number> {
  const r = (await runner.execute(sql.raw(
    `SELECT count(*)::int AS n FROM assets WHERE account_id = ${Math.trunc(Number(accountId))} AND ${quotaCountedAssetSql()}`,
  ))) as unknown as Array<{ n: number }>;
  return Number(r[0]?.n ?? 0);
}
