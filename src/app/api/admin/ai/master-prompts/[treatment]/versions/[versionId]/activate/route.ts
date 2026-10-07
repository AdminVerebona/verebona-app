/**
 * POST /api/admin/ai/master-prompts/[treatment]/versions/[versionId]/activate
 * — « Activer » un brouillon. Ticket BO-IA-PROMPTS-01 (AC03 à AC06, AC09,
 * AC10, AC15).
 *
 * Aucun corpus exigé, aucun autre prompt consulté. Seuls les contrôles
 * techniques bloquent (422 `TECHNICAL_CHECK_FAILED`, motifs en français).
 * La réponse porte des informations NON bloquantes (`notices` : « Cette
 * version n'a pas encore été testée avec le corpus. », échecs du dernier test).
 */
import { NextRequest, NextResponse } from 'next/server';
import { activateDraft, getPromptDetail } from '@/services/ai/master-prompts/master-prompt.service';
import { requireAdminContext, parseTreatment, parseId, invalidId, masterPromptError } from '../../../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ treatment: string; versionId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = await params;
  const t = parseTreatment(p.treatment);
  if (!t.ok) return t.response;
  const id = parseId(p.versionId);
  if (id === null) return invalidId(p.versionId);
  try {
    const r = await activateDraft(t.treatment, id, guard.ctx.adminUserId);
    return NextResponse.json({ activated: true, ...r, detail: await getPromptDetail(t.treatment) });
  } catch (e) {
    return masterPromptError(e, 'POST /api/admin/ai/master-prompts/[treatment]/versions/[versionId]/activate');
  }
}
