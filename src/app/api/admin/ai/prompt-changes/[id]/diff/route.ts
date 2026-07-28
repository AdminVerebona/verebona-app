/**
 * GET /api/admin/ai/prompt-changes/[id]/diff
 *
 * Aperçu des modifications — CDC §4.5.3, critère d'acceptation n°18.
 *
 * Cette route est le point exact où l'ancienne implémentation faisait défaut :
 * `admin/ai-instructions/apply` appliquait les patchs sans jamais les montrer.
 * Ici, le diff est consultable et la validation qui suit est un acte distinct.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { pgClient, ensureMigrations } from '@/db';
import { computeDiff } from '@/services/ai/governance/diff.service';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    `SELECT cr.id, cr.prompt_code, cr.status, cr.instruction, cr.impact_analysis, cr.risks,
            base.content     AS base_content,
            cand.content     AS candidate_content,
            cand.version     AS candidate_version
       FROM ai_prompt_change_requests cr
       LEFT JOIN ai_prompt_versions base ON base.id = cr.base_version_id
       LEFT JOIN ai_prompt_versions cand ON cand.id = cr.candidate_version_id
      WHERE cr.id = $1 LIMIT 1`,
    [Number(id)] as never[],
  );
  const cr = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!cr) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

  const diff = computeDiff(
    String(cr.base_content ?? ''),
    String(cr.candidate_content ?? ''),
  );

  return NextResponse.json({
    id: Number(cr.id),
    promptCode: String(cr.prompt_code),
    status: String(cr.status),
    instruction: String(cr.instruction),
    impactAnalysis: cr.impact_analysis ?? null,
    risks: cr.risks ?? [],
    candidateVersion: cr.candidate_version ?? null,
    diff,
  });
}
