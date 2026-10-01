/**
 * GET /api/admin/ai/t2-unanswered?days=30 — CDC Assistant §10.4, §32.5.
 *
 *   · `questions` : questions d'aide restées sans article, regroupées par
 *     intention et formulation (texte expurgé, sans compte ni utilisateur) ;
 *   · `motifs` (§32.5, lot 19) : TOUTES les demandes non résolues, comptées
 *     par motif et par intention — compteurs seulement, aucun texte.
 *     `null` si la lecture a échoué (la liste des questions reste servie).
 *
 * Lecture seule, administrateurs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listUnansweredByMotive, listUnansweredHelpQuestions } from '@/services/verebona-assistant/core/unanswered-help.repository';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  const days = /^\d{1,2}$/.test(p.get('days') ?? '') ? Number(p.get('days')) : 30;
  try {
    const questions = await listUnansweredHelpQuestions({ days, limit: 50 });
    const motifs = await listUnansweredByMotive({ days }).catch((e) => {
      console.warn('[t2-unanswered] regroupement par motif indisponible :', (e as Error).message);
      return null;
    });
    return NextResponse.json({ days, questions, motifs });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/t2-unanswered');
  }
}
