/**
 * POST /api/assets/[id]/tco/usage-assignments — « Classer en dépense d'usage »
 * (lot 108C, ticket TCO-646 §E).
 *
 * Corps : `{ lineId, lineKey?, category: 'FUEL' | 'CHARGING' | 'TOLLS' | 'OTHER' | 'NONE' | null, otherLabel? }`.
 * Classement par l'utilisateur d'une dépense RÉELLE retenue : il sert
 * seulement au rapprochement forfait / réel (complément estimé), ne modifie
 * jamais la dépense ni son justificatif, ne crée aucune Opération ;
 * `category: null` annule (retour au classement automatique).
 *
 * Droits : mêmes règles que les forfaits d'usage (Premium, Premium Duo,
 * essai ; bien modifiable) ; Standard → 403 `PREMIUM_REQUIRED`.
 * Réponse : le TCO recalculé (même forme que GET).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { notFound, parsePositiveId, writableAssetOr } from '@/services/assets/asset-route-helpers';
import { AssetNotFoundForTcoError } from '@/services/business-operations/tco/service';
import { toTcoDto } from '@/services/business-operations/tco/dto';
import { assignUsageLine, parseUsageAssignmentBody, UsageAssignmentError } from '@/services/business-operations/tco/usage-assignments.service';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const assetId = parsePositiveId((await params).id);
    if (!assetId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    if (!session.currentAccountId) return notFound();
    const accountId = session.currentAccountId;
    const droit = await canUsePremiumFeature(accountId);
    if (!droit.allowed) return NextResponse.json({ error: droit.reason ?? 'PREMIUM_REQUIRED', code: droit.reason ?? 'PREMIUM_REQUIRED', message: droit.message, locked: true }, { status: 403 });
    const w = await writableAssetOr(assetId, accountId);
    if ('response' in w) return w.response;
    let body: unknown = null;
    try { body = await request.json(); } catch { body = null; }
    const p = parseUsageAssignmentBody(body);
    if (!p.ok) return NextResponse.json({ error: 'VALIDATION', code: 'VALIDATION', message: p.message }, { status: 422 });
    const result = await assignUsageLine(accountId, assetId, session.userId ?? null, p.value);
    return NextResponse.json({ assetId, tco: toTcoDto(result), canEdit: true });
  } catch (error) {
    if (error instanceof UsageAssignmentError) return NextResponse.json({ error: error.code, code: error.code, message: error.message }, { status: error.status });
    if (error instanceof AssetNotFoundForTcoError) return notFound();
    console.error('[tco] POST classement usage :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'Le classement n’a pas pu être enregistré. Réessayez.' }, { status: 500 });
  }
}
