/**
 * Lot 113X (#722) — « Renseigner les dates » du coût de possession.
 *
 * GET  /api/assets/[id]/tco/dates — dépenses retenues sans date fiable (même
 *      liste que l'alerte de la fiche : DTO `undatedExpenses`) et, pour
 *      chacune, l'événement de référence ouvrable (élément d'agenda) s'il
 *      existe. Lecture : mêmes droits que GET /tco (Premium / Duo / essai ;
 *      Standard → 403 avant toute lecture financière ; autre compte → 404).
 * POST /api/assets/[id]/tco/dates — corps `{ entries: [{ lineId, lineKey?,
 *      date, confirm? }] }` : date effective de chaque dépense écrite dans son
 *      champ métier canonique (`undated-dates.service`). Mêmes droits que les
 *      décisions du TCO : écriture autorisée (lecture seule refusée), bien
 *      modifiable du compte de la session. Réponse : issue de chaque saisie
 *      et TCO recalculé (même forme que GET /tco), pour une mise à jour sans
 *      rechargement.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { canUsePremiumFeature, getEntitlements } from '@/services/entitlements.service';
import { notFound, parsePositiveId, writableAssetOr } from '@/services/assets/asset-route-helpers';
import { AssetNotFoundForTcoError, readAssetTco } from '@/services/business-operations/tco/service';
import { TCO_PREMIUM_MESSAGE, toTcoDto } from '@/services/business-operations/tco/dto';
import { parseTcoDatesBody } from '@/services/business-operations/tco/undated-expenses';
import { readTcoUndatedReferences, saveTcoUndatedDates } from '@/services/business-operations/tco/undated-dates.service';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const assetId = parsePositiveId((await params).id);
    if (!assetId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return notFound();
    const droits = await getEntitlements(asset.accountId);
    if (!droits.premiumFeatures) {
      return NextResponse.json({ error: 'PREMIUM_REQUIRED', code: 'PREMIUM_REQUIRED', message: TCO_PREMIUM_MESSAGE, locked: true }, { status: 403 });
    }
    const u = toTcoDto(await readAssetTco(asset.accountId, assetId), { linesLimit: 1 }).undatedExpenses;
    const refs = await readTcoUndatedReferences(asset.accountId, u.items.map((i) => i.operationId ?? 0));
    return NextResponse.json({
      assetId, canEdit: droits.canWrite,
      undated: { ...u, items: u.items.map((i) => ({ ...i, agendaItemId: i.operationId != null ? refs.get(i.operationId) ?? null : null })) },
    });
  } catch (error) {
    if (error instanceof AssetNotFoundForTcoError) return notFound();
    console.error('[tco] GET dates :', (error as Error).message);
    return NextResponse.json({ error: 'TCO_UNAVAILABLE', code: 'TCO_UNAVAILABLE', message: 'Le coût de possession n’a pas pu être calculé. Réessayez plus tard.' }, { status: 500 });
  }
}

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
    const p = parseTcoDatesBody(body);
    if (!p.ok) return NextResponse.json({ error: 'VALIDATION', code: 'VALIDATION', message: p.message }, { status: 422 });
    const r = await saveTcoUndatedDates(accountId, assetId, session.userId ?? null, p.value);
    return NextResponse.json({ assetId, results: r.results, tco: toTcoDto(r.result), canEdit: true });
  } catch (error) {
    if (error instanceof AssetNotFoundForTcoError) return notFound();
    console.error('[tco] POST dates :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'Les dates n’ont pas pu être enregistrées. Réessayez.' }, { status: 500 });
  }
}
