/**
 * Accès aux exports d'un bien (CDC Exports V12 — DRH-001 / DRH-002, ALT-005).
 *
 * Les routes d'export filtraient sur `assets.userId = session.userId` : le
 * co-titulaire d'un compte Duo ne voyait ni l'historique ni ne pouvait
 * générer, télécharger ou supprimer un dossier d'un bien du compte.
 *
 * La règle est désormais celle des autres routes `/api/assets/[id]/*` : le
 * bien appartient au compte courant de la session (`assets.accountId =
 * session.currentAccountId`) et n'est pas supprimé. Un bien d'un autre compte
 * reste introuvable (404, sans révéler son existence).
 */

import { db } from '@/db';
import { assets } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

export type ExportAccessSession = { userId: number; currentAccountId?: number | null };

/** `accountId` non nul : c'est le compte courant, vérifié par la requête. */
export type AccessibleAsset = typeof assets.$inferSelect & { accountId: number };

/**
 * Charge le bien s'il est accessible depuis le compte courant, sinon `null`.
 * Sans compte courant (session incomplète), aucun bien n'est accessible.
 */
export async function findAccessibleAssetForExport(
  session: ExportAccessSession,
  assetId: number,
): Promise<AccessibleAsset | null> {
  if (!session.currentAccountId) return null;
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(
      eq(assets.id, assetId),
      eq(assets.accountId, session.currentAccountId),
      isNull(assets.deletedAt),
    ))
    .limit(1);
  return asset ? { ...asset, accountId: session.currentAccountId } : null;
}
