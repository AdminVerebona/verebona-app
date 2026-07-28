/**
 * POST /api/admin/ai/prompt-changes/[id]/activate
 *
 * SECONDE validation humaine et activation — CDC §4.5.3, critère n°18.
 *
 * Trois garanties, dans cet ordre :
 *   1. la demande doit être à l'état `READY_FOR_APPROVAL`, seul état d'où
 *      `ACTIVE` est atteignable ;
 *   2. le validateur final doit être DISTINCT de celui qui a approuvé le diff —
 *      une double validation par la même personne n'est pas une double
 *      validation ;
 *   3. l'activation est transactionnelle en base.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { pgClient, ensureMigrations } from '@/db';
import { transition } from '@/services/ai/governance/state-machine';
import { activateVersion } from '@/services/ai/governance/activation.service';
import type { ChangeRequestStatus } from '@/services/ai/governance/types';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // requireAdmin lève si l'utilisateur n'est pas administrateur.
  // Convention du dépôt, identique aux autres routes /api/admin (§7.2).
  let adminUserId: number;
  try {
    adminUserId = await requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();
  const { id } = await params;
  const requestId = Number(id);

  const rows = await pgClient.unsafe(
    `SELECT id, prompt_code, status, candidate_version_id, approved_by
       FROM ai_prompt_change_requests WHERE id = $1 LIMIT 1`,
    [requestId] as never[],
  );
  const cr = (rows as unknown as Array<{
    id: number; prompt_code: string; status: ChangeRequestStatus;
    candidate_version_id: number | null; approved_by: number | null;
  }>)[0];

  if (!cr) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  if (!cr.candidate_version_id) {
    return NextResponse.json({ error: 'NO_CANDIDATE_VERSION' }, { status: 409 });
  }

  // Séparation des validateurs : la validation du diff et celle des tests
  // doivent émaner de deux personnes différentes (§4.5.3).
  if (cr.approved_by === adminUserId) {
    return NextResponse.json({
      error: 'SAME_APPROVER',
      message:
        'La validation finale doit être effectuée par une personne différente de celle ' +
        'ayant approuvé la proposition.',
    }, { status: 409 });
  }

  let nextStatus: ChangeRequestStatus;
  try {
    nextStatus = transition(cr.status, 'final_approve');
  } catch (e) {
    return NextResponse.json({ error: 'INVALID_TRANSITION', message: (e as Error).message }, { status: 409 });
  }

  const result = await activateVersion(cr.prompt_code, cr.candidate_version_id, adminUserId);

  await pgClient.unsafe(
    `UPDATE ai_prompt_change_requests
        SET status = $2, activated_by = $3, activated_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [requestId, nextStatus, adminUserId] as never[],
  );

  return NextResponse.json({ status: nextStatus, ...result });
}
