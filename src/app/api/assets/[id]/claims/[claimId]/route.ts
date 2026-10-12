/**
 * GET    /api/assets/[id]/claims/[claimId] — Un sinistre du bien (formulaire)
 * PATCH  /api/assets/[id]/claims/[claimId] — Correctif enregistré
 *        automatiquement (lot 44, O5 ; même contrat que l'ancienne
 *        sous-rubrique : champ par champ, listes remplacées en bloc)
 * DELETE /api/assets/[id]/claims/[claimId] — Suppression (annulation)
 *
 * PATCH : `{ claim?: {...}, version?, assetIds? }`. `version` (celle lue) est
 * OBLIGATOIRE dès qu'une liste est modifiée : 409 `CONFLICT` si le sinistre a
 * changé depuis, avec l'état courant dans `details.current` (`{ claim,
 * version, ... }`, rejoué par `rebaseAfterConflict` côté client).
 * `assetIds` : biens concernés (au moins un, du compte).
 *
 * DELETE : la saisie est retirée ; un sinistre encore établi par des
 * documents reste (`remains: true`, F-088), sinon il disparaît (F-089).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { ClaimFormError, ClaimOperationService } from '@/services/business-operations/claims/claim-operation.service';
import {
  claimErrorResponse, notFound, parseClaimBody, parsePositiveId, validationError, writableAssetOr,
} from '@/services/business-operations/claims/claim-route';

type Ctx = { params: Promise<{ id: string; claimId: string }> };

const claimNotFound = () => NextResponse.json({ error: 'CLAIM_NOT_FOUND', code: 'NOT_FOUND', message: 'Sinistre introuvable.' }, { status: 404 });

async function ids(params: Ctx['params']) {
  const p = await params;
  return { assetId: parsePositiveId(p.id), claimId: parsePositiveId(p.claimId) };
}

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const { assetId, claimId } = await ids(params);
    if (!assetId || !claimId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return notFound();
    const claim = await ClaimOperationService.get(asset.accountId, assetId, claimId);
    return claim ? NextResponse.json(claim) : claimNotFound();
  } catch (error) {
    return claimErrorResponse('GET one', error);
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const { assetId, claimId } = await ids(params);
    if (!assetId || !claimId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    if (!session.currentAccountId) return notFound();
    const accountId = session.currentAccountId;
    const w = await writableAssetOr(assetId, accountId);
    if ('response' in w) return w.response;
    const current = await ClaimOperationService.get(accountId, assetId, claimId);
    if (!current) return claimNotFound();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Corps JSON invalide.', fields: [] }, { status: 400 });
    }
    const requested = body && typeof body === 'object' && Array.isArray((body as { assetIds?: unknown }).assetIds)
      ? ((body as { assetIds: unknown[] }).assetIds).filter((x): x is number => Number.isSafeInteger(x)) : [];
    const parsed = await parseClaimBody(body, {
      category: w.asset.category, accountId, refAssetIds: [...current.assets.map((a) => a.id), ...requested], requireFields: true,
    });
    if (!parsed.ok) return validationError(parsed.issues);
    try {
      const claim = await ClaimOperationService.update(accountId, session.userId, assetId, claimId, {
        patch: parsed.value.patch,
        // Contrôle optimiste dès qu'une liste est touchée (ou qu'une version est fournie).
        expectedVersion: parsed.value.touchesLists || parsed.value.expectedVersion !== null ? parsed.value.expectedVersion : null,
        assetIds: parsed.value.assetIds,
      });
      return claim ? NextResponse.json(claim) : claimNotFound();
    } catch (e) {
      if (!(e instanceof ClaimFormError) || e.code !== 'CONFLICT') throw e;
      const now = await ClaimOperationService.get(accountId, assetId, claimId);
      return NextResponse.json(
        {
          error: 'CONFLICT', code: 'CONFLICT',
          message: 'Ce sinistre a été modifié entre-temps (autre onglet ou co-titulaire).',
          current: now, details: { current: now },
        },
        { status: 409 },
      );
    }
  } catch (error) {
    return claimErrorResponse('PATCH', error);
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const { assetId, claimId } = await ids(params);
    if (!assetId || !claimId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    if (!session.currentAccountId) return notFound();
    const accountId = session.currentAccountId;
    const w = await writableAssetOr(assetId, accountId);
    if ('response' in w) return w.response;
    const r = await ClaimOperationService.remove(accountId, session.userId, assetId, claimId);
    return NextResponse.json(r);
  } catch (error) {
    return claimErrorResponse('DELETE', error);
  }
}
