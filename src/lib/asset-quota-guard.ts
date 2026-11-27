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
 *
 * Carte #849 — QUOTA DES BIENS ACTIFS, BIEN TRANSMIS EN LECTURE SEULE :
 *   · décompte CENTRALISÉ (`countAccountAssets`, `quotaCountedAssetSql`) :
 *     seuls les biens EN_SERVICE non supprimés comptent — création,
 *     réactivation, droits, accueil, BO, Standard / Premium / Duo ;
 *   · un bien TRANSMIS refuse toute écriture (403 `ASSET_READ_ONLY`) :
 *     `refuserSiModificationBiensSuspendue(accountId, assetId)` contrôle les
 *     deux, le statut du bien d'abord.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { canModifyAssets, type Decision } from '@/services/entitlements.service';
import { ASSET_READ_ONLY_MESSAGE, QUOTA_COUNTED_ASSET_STATUS, isReadOnlyAssetStatus } from '@/lib/asset-status';

/** Nombre de biens comptés dans le quota (#849 : EN_SERVICE et non supprimés). */
export async function countAccountAssets(accountId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(assets)
    .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt), eq(assets.status, QUOTA_COUNTED_ASSET_STATUS)));
  return Number(row?.value ?? 0);
}

/** Décision « les biens de ce compte peuvent-ils être modifiés ? ». */
export async function assetModificationDecision(accountId: number): Promise<Decision> {
  return canModifyAssets(accountId, await countAccountAssets(accountId));
}

/**
 * #849 — refus prêt à renvoyer si le bien est TRANSMIS (consultation seule),
 * sinon `null`. Bien introuvable : `null` (la route répond elle-même 404).
 */
export async function refuserSiBienEnLectureSeule(assetId: number): Promise<NextResponse | null> {
  const [row] = await db.select({ status: assets.status }).from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!row || !isReadOnlyAssetStatus(row.status)) return null;
  return NextResponse.json(
    { error: ASSET_READ_ONLY_MESSAGE, code: 'ASSET_READ_ONLY', message: ASSET_READ_ONLY_MESSAGE, details: { status: 'TRANSMIS' } },
    { status: 403 },
  );
}

/**
 * Refus prêt à renvoyer si la modification d'un bien est suspendue, sinon
 * `null`. Même corps que `PATCH /api/assets` (lu par `parseWriteBlocked`).
 * #849 : `assetId` fourni → un bien TRANSMIS est refusé d'abord.
 *
 *     const refus = await refuserSiModificationBiensSuspendue(accountId, assetId);
 *     if (refus) return refus;
 */
export async function refuserSiModificationBiensSuspendue(accountId: number, assetId?: number | null): Promise<NextResponse | null> {
  if (assetId) {
    const lectureSeule = await refuserSiBienEnLectureSeule(assetId);
    if (lectureSeule) return lectureSeule;
  }
  const decision = await assetModificationDecision(accountId);
  if (decision.allowed) return null;
  const code = decision.reason ?? 'ASSET_QUOTA_EXCEEDED';
  const message = decision.message ?? 'Modification non autorisée';
  return NextResponse.json(
    { error: message, code, message, details: { max_assets: decision.limit } },
    { status: 403 },
  );
}

