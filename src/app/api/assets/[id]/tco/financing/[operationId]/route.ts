/**
 * PUT /api/assets/[id]/tco/financing/[operationId] — conditions d'un prêt
 * saisies par l'utilisateur pour établir le capital restant dû (lot 112D).
 *
 * Corps : `{ terms?: { principalCents?, ratePct?, periodicity?, durationMonths?,
 * firstInstallmentDate?, installmentCents?, insuranceCents?, deferral? },
 * events?: [{ id?, kind: 'BALANCE' | 'EARLY_REPAYMENT', date, amountCents,
 * mode?, newInstallmentCents? }] }` — un champ à `null` efface la saisie
 * (la lecture documentaire reprend), un champ absent est inchangé ; `events`
 * remplace la liste saisie.
 *
 * Saisie USER : origine par champ, journalisée ; jamais remplacée par une
 * lecture documentaire. Le capital restant dû reste une information, jamais
 * un coût (aucun total TCO modifié).
 *
 * Droits : Premium, Premium Duo (propriétaire et membre du compte) et essai,
 * bien modifiable (mêmes règles que les décisions TCO) ; Standard → 403
 * `PREMIUM_REQUIRED` avant toute lecture financière ; prêt d'un autre compte
 * ou non lié au bien → 404.
 * Réponse : le TCO recalculé (même forme que GET).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { notFound, parsePositiveId, writableAssetOr } from '@/services/assets/asset-route-helpers';
import { AssetNotFoundForTcoError, readAssetTco } from '@/services/business-operations/tco/service';
import { toTcoDto } from '@/services/business-operations/tco/dto';
import { LoanTermsError, parseLoanTermsBody, saveLoanTerms } from '@/services/business-operations/financing/loan-terms-decisions';

type Ctx = { params: Promise<{ id: string; operationId: string }> };

export async function PUT(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const p = await params;
    const assetId = parsePositiveId(p.id);
    const operationId = parsePositiveId(p.operationId);
    if (!assetId || !operationId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ID' }, { status: 400 });
    if (!session.currentAccountId) return notFound();
    const accountId = session.currentAccountId;
    const droit = await canUsePremiumFeature(accountId);
    if (!droit.allowed) return NextResponse.json({ error: droit.reason ?? 'PREMIUM_REQUIRED', code: droit.reason ?? 'PREMIUM_REQUIRED', message: droit.message, locked: true }, { status: 403 });
    const w = await writableAssetOr(assetId, accountId);
    if ('response' in w) return w.response;
    let body: unknown = null;
    try { body = await request.json(); } catch { body = null; }
    const parsed = parseLoanTermsBody(body);
    if (!parsed.ok) return NextResponse.json({ error: 'VALIDATION', code: 'VALIDATION', message: parsed.message }, { status: 422 });
    const r = await saveLoanTerms(accountId, assetId, operationId, { userId: session.userId ?? null, origin: 'USER' }, parsed.value);
    const tco = await readAssetTco(accountId, assetId);
    return NextResponse.json({ assetId, operationId, changed: r.changed, eventsChanged: r.eventsChanged, tco: toTcoDto(tco), canEdit: true });
  } catch (error) {
    if (error instanceof LoanTermsError) return NextResponse.json({ error: error.code, code: error.code, message: error.message }, { status: error.status });
    if (error instanceof AssetNotFoundForTcoError) return notFound();
    console.error('[tco] PUT financement :', (error as Error).message);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'Les conditions du prêt n’ont pas pu être enregistrées. Réessayez.' }, { status: 500 });
  }
}
