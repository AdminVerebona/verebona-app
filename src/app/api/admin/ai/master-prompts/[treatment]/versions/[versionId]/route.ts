/**
 * GET /api/admin/ai/master-prompts/[treatment]/versions/[versionId] — une
 * version (texte compris) et l'historique de ses tests. BO-IA-PROMPTS-01 (AC13).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getPromptVersionDetail } from '@/services/ai/master-prompts/master-prompt.service';
import { requireAdminContext, parseTreatment, parseId, invalidId, masterPromptError } from '../../../_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ treatment: string; versionId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = await params;
  const t = parseTreatment(p.treatment);
  if (!t.ok) return t.response;
  const id = parseId(p.versionId);
  if (id === null) return invalidId(p.versionId);
  try {
    return NextResponse.json(await getPromptVersionDetail(t.treatment, id));
  } catch (e) {
    return masterPromptError(e, 'GET /api/admin/ai/master-prompts/[treatment]/versions/[versionId]');
  }
}
