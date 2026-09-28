/**
 * Écriture des biens au-dessus du quota — Centre d'aide GAP-11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE RÈGLE APRÈS UN CHANGEMENT D'OFFRE
 *
 * Deux logiques coexistaient :
 *   - `enforceStandardLimits` (webhook Stripe, synchronisation) passait en
 *     INACTIF tous les biens au-delà du 2e lors d'un retour en Standard ;
 *   - `entitlements.canModifyAssets` conservait tout, en lecture et export,
 *     et ne suspendait que la modification — mais seulement sur
 *     `PATCH /api/assets`.
 *
 * Règle retenue (celle des droits effectifs, CDC Centre d'aide AID-BILL-004 /
 * AID-DUO-005) : aucun bien n'est désactivé ni supprimé. Tant que le compte
 * dépasse son quota, ses biens restent consultables, exportables,
 * transmissibles et supprimables ; leur modification est refusée (403
 * `ASSET_QUOTA_EXCEEDED`, déjà compris par le client) sur toutes les routes
 * qui modifient un bien, pas seulement sur la fiche principale.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { canModifyAssets, type Decision } from '@/services/entitlements.service';

/** Nombre de biens comptés dans le quota (non supprimés). */
export async function countAccountAssets(accountId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(assets)
    .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)));
  return Number(row?.value ?? 0);
}

/** Décision « les biens de ce compte peuvent-ils être modifiés ? ». */
export async function assetModificationDecision(accountId: number): Promise<Decision> {
  return canModifyAssets(accountId, await countAccountAssets(accountId));
}

/**
 * Refus prêt à renvoyer si la modification d'un bien est suspendue, sinon
 * `null`. Même corps que `PATCH /api/assets` (lu par `parseWriteBlocked`).
 *
 *     const refus = await refuserSiModificationBiensSuspendue(accountId);
 *     if (refus) return refus;
 */
export async function refuserSiModificationBiensSuspendue(accountId: number): Promise<NextResponse | null> {
  const decision = await assetModificationDecision(accountId);
  if (decision.allowed) return null;
  const code = decision.reason ?? 'ASSET_QUOTA_EXCEEDED';
  const message = decision.message ?? 'Modification non autorisée';
  return NextResponse.json(
    { error: message, code, message, details: { max_assets: decision.limit } },
    { status: 403 },
  );
}
