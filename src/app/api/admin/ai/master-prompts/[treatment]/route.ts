/**
 * GET /api/admin/ai/master-prompts/[treatment] — un prompt maître : version
 * active (texte), brouillon (texte, contrôles techniques), historique des
 * versions, journal des activations. Ticket BO-IA-PROMPTS-01.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getPromptDetail } from '@/services/ai/master-prompts/master-prompt.service';
import { requireAdminContext, parseTreatment, masterPromptError } from '../_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ treatment: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const t = parseTreatment((await params).treatment);
  if (!t.ok) return t.response;
  try {
    return NextResponse.json(await getPromptDetail(t.treatment));
  } catch (e) {
    return masterPromptError(e, 'GET /api/admin/ai/master-prompts/[treatment]');
  }
}
