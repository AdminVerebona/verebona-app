/**
 * Outils communs des routes d'un bien (`/api/assets/[id]/tco*`,
 * `/api/assets/[id]/usage-budgets*`) : identifiant, 404 sans révéler
 * l'existence, bien modifiable du compte (mêmes règles que la fiche —
 * `loadWritableAsset` : bien archivé ou verrouillé, compte restreint ou
 * au-dessus du quota refusés).
 *
 * Lot 83D : déplacés depuis `business-operations/claims/claim-route.ts`
 * (routes Sinistre retirées, V-Q1) — comportement inchangé.
 */
import { NextResponse } from 'next/server';
import { AssetDetailsError, loadWritableAsset } from '@/services/asset-details-write.service';

export function parsePositiveId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const notFound = (message = 'Bien introuvable.') => NextResponse.json(
  { error: 'ASSET_NOT_FOUND', code: 'INVALID_ASSET', message },
  { status: 404 },
);

/** Bien modifiable du compte, ou réponse de refus (corps lu par `parseWriteBlocked`). */
export async function writableAssetOr(assetId: number, accountId: number): Promise<{ asset: Awaited<ReturnType<typeof loadWritableAsset>> } | { response: NextResponse }> {
  try {
    return { asset: await loadWritableAsset(assetId, accountId) };
  } catch (e) {
    if (!(e instanceof AssetDetailsError)) throw e;
    if (e.code === 'NOT_FOUND') return { response: notFound() };
    if (e.code === 'WRITE_BLOCKED') {
      const code = e.details.writeBlocked?.code ?? 'ASSET_QUOTA_EXCEEDED';
      return { response: NextResponse.json({ error: code, code, message: e.message, limit: e.details.writeBlocked?.limit }, { status: 403 }) };
    }
    if (e.code === 'ASSET_UNAVAILABLE') {
      return { response: NextResponse.json({ error: 'ASSET_UNAVAILABLE', code: 'FORBIDDEN', reason: e.details.reason, message: e.message }, { status: 403 }) };
    }
    throw e;
  }
}
