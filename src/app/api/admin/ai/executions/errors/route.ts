/**
 * GET /api/admin/ai/executions/errors — CDC BO IA NFR-004, SCR-07.
 *
 * Répartition des erreurs sur une fenêtre : par traitement, code d'erreur et
 * modèle. C'est le point d'entrée du diagnostic — le NFR-004 veut qu'une erreur
 * soit diagnostiçable, encore faut-il savoir par où commencer.
 *
 * Ce regroupement répond à « qu'est-ce qui échoue le plus » avant même
 * d'ouvrir une ligne, et distingue d'emblée les trois causes qui n'appellent
 * pas le même geste : un traitement, un modèle, ou un type d'erreur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getErrorBreakdown } from '@/services/ai/telemetry/execution-log.repository';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const raw = new URL(req.url).searchParams.get('days');
  const days = raw && /^\d+$/.test(raw) ? Math.min(Number(raw), 90) : 7;

  try {
    return NextResponse.json({ days, breakdown: await getErrorBreakdown(days) });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/executions/errors');
  }
}
