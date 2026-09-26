/**
 * GET /api/admin/ai/t2-requests — CDC BO IA LOG-UI-06, LOG-UI-07, T2-046,
 * SCR-07 : routage des requêtes de l'assistant (mode, cascade, appels, coût).
 * Une requête tranchée sans IA y figure avec zéro appel et un coût nul.
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchT2Requests } from '@/services/ai/telemetry/t2-routing.repository';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

const entier = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
const date = (v: string | null) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  try {
    return NextResponse.json(await searchT2Requests({
      accountId: entier(p.get('accountId')),
      userId: entier(p.get('userId')),
      deterministicOnly: p.get('route') === 'deterministic',
      aiOnly: p.get('route') === 'ai',
      since: date(p.get('from')),
      until: date(p.get('to') ? `${p.get('to')}T23:59:59.999Z` : null),
      limit: entier(p.get('limit')),
      offset: entier(p.get('offset')),
    }));
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/t2-requests');
  }
}
