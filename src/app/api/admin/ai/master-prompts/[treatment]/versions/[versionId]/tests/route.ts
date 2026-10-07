/**
 * POST /api/admin/ai/master-prompts/[treatment]/versions/[versionId]/tests —
 * « Tester avec le corpus » / « Relancer les tests ». Ticket BO-IA-PROMPTS-01
 * (AC12, AC13). `versionId` = `active` : version active (la version initiale
 * est alors historisée en v1).
 *
 * Facultatif, jamais exigé. Rejeu sur sorties enregistrées : aucun appel
 * modèle, aucun coût, quelques secondes au plus — exécuté dans la requête,
 * borné ; l'exécution est enregistrée (statut consultable par
 * `GET …/tests/[runId]`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { runPromptTest } from '@/services/ai/master-prompts/master-prompt.service';
import { requireAdminContext, parseTreatment, parseId, invalidId, masterPromptError } from '../../../../_shared';

export const maxDuration = 150;

export async function POST(req: NextRequest, { params }: { params: Promise<{ treatment: string; versionId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = await params;
  const t = parseTreatment(p.treatment);
  if (!t.ok) return t.response;
  const id = p.versionId === 'active' ? 'active' as const : parseId(p.versionId);
  if (id === null) return invalidId(p.versionId);
  try {
    return NextResponse.json(await runPromptTest(t.treatment, id, guard.ctx.adminUserId), { status: 201 });
  } catch (e) {
    return masterPromptError(e, 'POST /api/admin/ai/master-prompts/[treatment]/versions/[versionId]/tests');
  }
}
