/**
 * POST /api/assets/[id]/tco/decisions — « Ajouter au TCO » / « Retirer du
 * TCO » sur une ligne du coût de possession (lot 80A).
 *
 * Corps : `{ lineId, lineKey?, action: 'INCLUDE' | 'EXCLUDE', confirmDuplicate? }`.
 * Décision de l'utilisateur, persistée par compte et par bien, réversible
 * (le geste inverse annule une décision), journalisée (qui, quand), prioritaire
 * sur les règles automatiques ; un ajout qui crée un doublon présumé est
 * refusé (409 `DUPLICATE_CONFIRMATION_REQUIRED`, message à afficher) tant que
 * l'utilisateur ne l'a pas confirmé.
 *
 * Droits : mêmes règles que les forfaits d'usage (édition du bien) — Premium,
 * Premium Duo (propriétaire et membre du compte) et essai, bien modifiable ;
 * Standard → 403 `PREMIUM_REQUIRED` avant toute lecture financière.
 * Réponse : le TCO recalculé (même forme que GET), pour une mise à jour
 * immédiate des totaux.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { notFound, parsePositiveId, writableAssetOr } from '@/services/assets/asset-route-helpers';
import { AssetNotFoundForTcoError } from '@/services/business-operations/tco/service';
import { toTcoDto } from '@/services/business-operations/tco/dto';
import { decideTcoLine, parseTcoDecisionBody, TcoDecisionError } from '@/services/business-operations/tco/user-decisions.service';

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
    const p = parseTcoDecisionBody(body);
    if (!p.ok) return NextResponse.json({ error: 'VALIDATION', code: 'VALIDATION', message: p.message }, { status: 422 });
    const r = await decideTcoLine(accountId, assetId, session.userId ?? null, p.value);
    return NextResponse.json({
      assetId, outcome: r.outcome, lineKey: r.line?.decisionKey ?? null,
      tco: toTcoDto(r.result), canEdit: true,
    });
  } catch (error) {
    if (error instanceof TcoDecisionError) {
      return NextResponse.json({ error: error.code, code: error.code, message: error.message, ...error.details }, { status: error.status });
    }
    if (error instanceof AssetNotFoundForTcoError) return notFound();
    console.error('[tco] POST décision :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'La décision n’a pas pu être enregistrée. Réessayez.' }, { status: 500 });
  }
}
