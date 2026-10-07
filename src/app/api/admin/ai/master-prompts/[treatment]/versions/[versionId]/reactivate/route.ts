/**
 * POST /api/admin/ai/master-prompts/[treatment]/versions/[versionId]/reactivate
 * — « Réactiver cette version » depuis l'historique. Ticket BO-IA-PROMPTS-01
 * (AC11) : l'Actif courant reste dans l'historique (« Ancienne »), le texte
 * de la version choisie redevient actif, l'opération est journalisée.
 */
import { NextRequest, NextResponse } from 'next/server';
import { reactivateVersion, getPromptDetail } from '@/services/ai/master-prompts/master-prompt.service';
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
    const r = await reactivateVersion(t.treatment, id, guard.ctx.adminUserId);
    return NextResponse.json({ activated: true, ...r, detail: await getPromptDetail(t.treatment) });
  } catch (e) {
    return masterPromptError(e, 'POST /api/admin/ai/master-prompts/[treatment]/versions/[versionId]/reactivate');
  }
}
