import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { AccountNotFoundError, requestAccountReconsolidation } from '@/services/business-operations/admin-reconsolidation';
import {
  RECONSOLIDATION_REASON_MAX, RECONSOLIDATION_REASON_MIN, normalizeReconsolidationReason,
} from '@/services/business-operations/admin-reconsolidation.model';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * POST /api/admin/accounts/:id/operations-reconsolidation — « Reconsolider ce
 * compte » (lot 48, O10 ; BO › Opérations du compte, fiche compte).
 *
 * Met en file le travail T3 Opérations du compte (sorte `business_operations`,
 * dédoublonnée) et sa projection Agenda : le moteur de production recalcule
 * l'état depuis les preuves. Ce n'est PAS une édition d'Opération (décision PO
 * Q9, INV-032) : aucune valeur métier n'est transmise.
 *
 * Corps : `{ reason: string }` — motif obligatoire (5 à 500 caractères).
 *   202 { accountId, operationsJobId, agendaJobId, correlationId, waitsForReactivation }
 *   400 INVALID_ACCOUNT_ID | INVALID_REASON · 404 ACCOUNT_NOT_FOUND · 500
 * Journalisé (AUD-001) : `OPERATIONS_RECONSOLIDATE`, cible ACCOUNT, motif,
 * travaux créés ; succès, refus et échec. CSRF : `src/middleware.ts`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    return NextResponse.json({ error: 'Vérification impossible', code: 'GUARD_FAILED' }, { status: 500, headers: NO_STORE });
  }

  const accountId = Number((await params).id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return NextResponse.json({ error: 'Identifiant de compte invalide.', code: 'INVALID_ACCOUNT_ID' }, { status: 400, headers: NO_STORE });
  }
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = normalizeReconsolidationReason(body?.reason);
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId, adminEmail, action: 'OPERATIONS_RECONSOLIDATE', targetType: 'ACCOUNT', targetId: accountId, result,
    details: { reason, ...details },
  });
  if (reason === null) {
    return NextResponse.json(
      { error: `Motif obligatoire (${RECONSOLIDATION_REASON_MIN} à ${RECONSOLIDATION_REASON_MAX} caractères).`, code: 'INVALID_REASON' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const r = await requestAccountReconsolidation(accountId, { adminId });
    await audit('SUCCESS', {
      operationsJobId: r.operationsJobId, agendaJobId: r.agendaJobId, correlationId: r.correlationId, waitsForReactivation: r.waitsForReactivation,
    });
    return NextResponse.json(r, { status: 202, headers: NO_STORE });
  } catch (error) {
    if (error instanceof AccountNotFoundError) {
      await audit('DENIED', { code: 'ACCOUNT_NOT_FOUND' });
      return NextResponse.json({ error: 'Compte introuvable.', code: 'ACCOUNT_NOT_FOUND' }, { status: 404, headers: NO_STORE });
    }
    console.error(`[admin/operations-reconsolidation] compte ${accountId} :`, (error as Error).message);
    await audit('FAILURE', { code: 'ENQUEUE_FAILED' });
    return NextResponse.json(
      { error: 'Mise en file impossible. Réessayez dans un instant.', code: 'RECONSOLIDATION_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}
