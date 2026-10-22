import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { IdentityRestoreRefusedError, revertIdentitySeparation } from '@/services/business-operations/consolidation/identity-review';
import { positiveInt } from '@/services/business-operations/diagnostics/model';
import {
  RESTORE_AUDIT_ACTION, RESTORE_AUDIT_TARGET, RESTORE_BLOCK_MESSAGES, RESTORE_REASON_MAX, RESTORE_REASON_MIN,
  normalizeRestoreReason, restoreBlockStatus,
} from '@/services/business-operations/identity-restore.model';
import { guardAdmin, NO_STORE } from '../../../../_shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; reviewId: string }> };

/**
 * POST /api/admin/operations/:id/identity-reviews/:reviewId/restore — lot 79A,
 * bouton « Rétablir » de BO › Opérations › détail, section « Identité
 * économique et provenance ».
 *
 * SEULE route d'écriture sous `/api/admin/operations` : exception PO du
 * 22/10/2026 à la lecture seule Q9 (test `o9-routes.test.ts`). Aucune valeur
 * métier n'est transmise : la route enregistre, via
 * `revertIdentitySeparation` (lot 78A), une décision de rapprochement
 * CONFIRMED (origine ADMIN_REVIEW) que le moteur T3 réapplique — TCO, agenda,
 * champs dérivés et anomalies suivent par les mécanismes existants.
 *
 * Corps : `{ reason: string }` — motif obligatoire (10 à 500 caractères).
 *   200 { accountId, operationId, fileId, jobId }
 *   400 INVALID_ID | INVALID_REASON
 *   404 NOT_FOUND (séparation inconnue, d'un autre compte, ou sans rapport avec l'Opération)
 *   409 ALREADY_RESTORED | SOURCE_DELETED | CANDIDATE_GONE | ORIGIN_MERGED | ORIGIN_INVALIDATED | ALREADY_ATTACHED | NOT_A_SEPARATION
 *   500 RESTORE_FAILED
 * Idempotente : verrou Opérations du compte + `FOR UPDATE` du journal — un
 * double clic ou deux administrateurs ne rétablissent qu'une fois (le second
 * reçoit 409 ALREADY_RESTORED). Journalisée (AUD-001) : `OPERATION_IDENTITY_RESTORE`,
 * cible OPERATION_IDENTITY_REVIEW ; succès (atomique avec la décision, avant /
 * après, motif), refus (DENIED) et échec (FAILURE). CSRF : `src/middleware.ts`.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const adminId = g.adminId;
  const p = await params;
  const operationId = positiveInt(p.id);
  const reviewId = positiveInt(p.reviewId);
  if (!operationId || !reviewId) return NextResponse.json({ error: 'Identifiant invalide.', code: 'INVALID_ID' }, { status: 400, headers: NO_STORE });

  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = normalizeRestoreReason(body?.reason);
  const audit = (result: 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId, adminEmail, action: RESTORE_AUDIT_ACTION, targetType: RESTORE_AUDIT_TARGET, targetId: reviewId, result,
    details: { reason, operationId, reviewId, ...details },
  });
  if (reason === null) {
    return NextResponse.json(
      { error: `Motif obligatoire (${RESTORE_REASON_MIN} à ${RESTORE_REASON_MAX} caractères).`, code: 'INVALID_REASON' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    // Le journal d'audit du succès est écrit DANS la transaction du rétablissement.
    const r = await revertIdentitySeparation(reviewId, { adminId, adminEmail, operationId, reason });
    return NextResponse.json({ accountId: r.accountId, operationId: r.operationId, fileId: r.fileId, jobId: r.jobId }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof IdentityRestoreRefusedError) {
      await audit('DENIED', { code: error.code });
      return NextResponse.json({ error: RESTORE_BLOCK_MESSAGES[error.code], code: error.code }, { status: restoreBlockStatus(error.code), headers: NO_STORE });
    }
    console.error(`[admin/operations] rétablissement ${reviewId} (Opération ${operationId}) :`, (error as Error).message);
    await audit('FAILURE', { code: 'RESTORE_FAILED' });
    return NextResponse.json(
      { error: 'Rétablissement impossible. Réessayez dans un instant.', code: 'RESTORE_FAILED' },
      { status: 500, headers: NO_STORE },
    );
  }
}
