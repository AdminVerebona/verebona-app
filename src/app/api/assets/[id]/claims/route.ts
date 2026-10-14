/**
 * GET  /api/assets/[id]/claims — Sinistres du bien (lot 44, O5 ; CDC
 *      Opérations V1 ch. 15, C14 ; décisions PO Q2, Q3, Q11)
 * POST /api/assets/[id]/claims — Nouveau sinistre
 *
 * Plusieurs sinistres par bien ; un sinistre peut concerner plusieurs biens
 * (`assetIds`). Saisie ouverte à toutes les offres (Q3) ; l'export du dossier
 * Assurance-sinistre reste Premium (moteur de dossiers).
 *
 * GET : `{ claims: [...résumés], legacy: {...} | null }` — `legacy` :
 * ancienne saisie du bien qui n'est pas (encore) devenue un sinistre
 * (lecture de compatibilité, Q11). `?include=references` : pièces, photos et
 * événements « sinistre » proposés par le formulaire. Lot 53 (retour PO
 * Q18) : `&claimId=N` — ceux aussi des AUTRES biens concernés par ce
 * sinistre du compte, accessibles seulement (bien du compte, non supprimé) ;
 * un sinistre introuvable dans le compte n'élargit rien.
 *
 * POST : `{ assetIds?: number[], claim?: {...}, version? }` → le sinistre
 * créé (forme du formulaire, `version` pour le verrou optimiste).
 * `{ resumeLegacy: true }` : reprise de l'ancienne saisie (« Reprendre »).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { loadAdditionalInfoReferences, loadClaimReferences } from '@/services/exports/additional-infos-references.service';
import { ClaimOperationService } from '@/services/business-operations/claims/claim-operation.service';
import {
  claimErrorResponse, notFound, parseClaimBody, parsePositiveId, validationError, writableAssetOr,
} from '@/services/business-operations/claims/claim-route';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const assetId = parsePositiveId((await params).id);
    if (!assetId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return notFound();
    const withReferences = request.nextUrl.searchParams.get('include') === 'references';
    const claimId = parsePositiveId(request.nextUrl.searchParams.get('claimId') ?? '');
    const references = async () => {
      if (claimId) {
        // Biens concernés lus DANS le compte courant (sinistre d'un autre compte : rien).
        const claim = await ClaimOperationService.get(asset.accountId, assetId, claimId);
        if (claim) {
          return loadClaimReferences({ assetId, accountId: asset.accountId, userId: session.userId, claimAssetIds: claim.assets.map((a) => a.id) });
        }
      }
      return loadAdditionalInfoReferences({ assetId, accountId: asset.accountId, userId: session.userId });
    };
    const [list, refs] = await Promise.all([
      ClaimOperationService.list(asset.accountId, assetId),
      withReferences ? references() : Promise.resolve(undefined),
    ]);
    return NextResponse.json({ assetId, ...list, ...(refs ? { references: refs } : {}) });
  } catch (error) {
    return claimErrorResponse('GET', error);
  }
}

export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const assetId = parsePositiveId((await params).id);
    if (!assetId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    if (!session.currentAccountId) return notFound();
    const accountId = session.currentAccountId;
    const w = await writableAssetOr(assetId, accountId);
    if ('response' in w) return w.response;

    let body: Record<string, unknown>;
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (body.resumeLegacy === true) {
      const claim = await ClaimOperationService.resumeLegacy(accountId, assetId);
      if (!claim) return validationError([{ path: '', message: 'Aucune ancienne saisie à reprendre.' }]);
      return NextResponse.json(claim, { status: 201 });
    }
    const requested = Array.isArray(body.assetIds) ? (body.assetIds as unknown[]).filter((x): x is number => Number.isSafeInteger(x)) : [assetId];
    const parsed = await parseClaimBody(body, { category: w.asset.category, accountId, refAssetIds: [assetId, ...requested] });
    if (!parsed.ok) return validationError(parsed.issues);
    const assetIds = parsed.value.assetIds ?? [assetId];
    if (!assetIds.includes(assetId)) return validationError([{ path: 'assetIds', message: 'Le sinistre doit concerner ce bien.' }]);
    const claim = await ClaimOperationService.create(accountId, session.userId, assetId, { patch: parsed.value.patch, assetIds });
    return NextResponse.json(claim, { status: 201 });
  } catch (error) {
    return claimErrorResponse('POST', error);
  }
}
