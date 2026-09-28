/**
 * GET /api/admin/ai/t2-unanswered?days=30 — CDC §10.4 : questions d'aide de
 * l'assistant restées sans article, regroupées par intention et formulation
 * (texte expurgé, sans compte ni utilisateur). Lecture seule, administrateurs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listUnansweredHelpQuestions } from '@/services/verebona-assistant/core/unanswered-help.repository';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  const days = /^\d{1,2}$/.test(p.get('days') ?? '') ? Number(p.get('days')) : 30;
  try {
    return NextResponse.json({ days, questions: await listUnansweredHelpQuestions({ days, limit: 50 }) });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/t2-unanswered');
  }
}
