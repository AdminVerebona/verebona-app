/**
 * POST /api/admin/ai/prompt-changes/[id]/rollback
 *
 * Retour arrière — CDC §4.5.3, critère d'acceptation n°19.
 * « Une version antérieure doit pouvoir être restaurée. »
 *
 * Opération d'urgence : elle doit rester possible en un geste, sans
 * redéploiement, sans migration et sans intervention technique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { pgClient, ensureMigrations } from '@/db';
import { transition } from '@/services/ai/governance/state-machine';
import { rollbackToPrevious } from '@/services/ai/governance/activation.service';
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

  const rows = await pgClient.unsafe(
    `SELECT id, prompt_code, status FROM ai_prompt_change_requests WHERE id = $1 LIMIT 1`,
    [Number(id)] as never[],
  );
  const cr = (rows as unknown as Array<{ id: number; prompt_code: string; status: ChangeRequestStatus }>)[0];
  if (!cr) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

  let nextStatus: ChangeRequestStatus;
  try {
    nextStatus = transition(cr.status, 'rollback');
  } catch (e) {
    return NextResponse.json({ error: 'INVALID_TRANSITION', message: (e as Error).message }, { status: 409 });
  }

  try {
    const result = await rollbackToPrevious(cr.prompt_code, adminUserId);
    await pgClient.unsafe(
      `UPDATE ai_prompt_change_requests SET status = $2, updated_at = NOW() WHERE id = $1`,
      [cr.id, nextStatus] as never[],
    );
    return NextResponse.json({ status: nextStatus, ...result });
  } catch (e) {
    return NextResponse.json({ error: 'ROLLBACK_IMPOSSIBLE', message: (e as Error).message }, { status: 409 });
  }
}
