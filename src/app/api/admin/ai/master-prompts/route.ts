/**
 * GET /api/admin/ai/master-prompts — vue d'ensemble des prompts maîtres
 * administrables (T1–T4, T6) : version active, brouillon, état des tests
 * (information, jamais condition). Ticket BO-IA-PROMPTS-01.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listPromptSummaries } from '@/services/ai/master-prompts/master-prompt.service';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { requireAdminContext, masterPromptError } from './_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ environment: getAiEnvironment(), prompts: await listPromptSummaries() });
  } catch (e) {
    return masterPromptError(e, 'GET /api/admin/ai/master-prompts');
  }
}
