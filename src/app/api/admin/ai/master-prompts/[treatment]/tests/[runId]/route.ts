/**
 * GET /api/admin/ai/master-prompts/[treatment]/tests/[runId] — résultat d'un
 * test du corpus : date, version testée, scénarios, succès, échecs, et pour
 * chaque scénario en échec le résultat attendu et le résultat obtenu.
 * Ticket BO-IA-PROMPTS-01 (AC13).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getPromptTestRun } from '@/services/ai/master-prompts/master-prompt.service';
import { requireAdminContext, parseTreatment, parseId, invalidId, masterPromptError } from '../../../_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ treatment: string; runId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = await params;
  const t = parseTreatment(p.treatment);
  if (!t.ok) return t.response;
  const id = parseId(p.runId);
  if (id === null) return invalidId(p.runId);
  try {
    return NextResponse.json(await getPromptTestRun(t.treatment, id));
  } catch (e) {
    return masterPromptError(e, 'GET /api/admin/ai/master-prompts/[treatment]/tests/[runId]');
  }
}
