import { NextRequest, NextResponse } from 'next/server';
import { scheduleMascotPregeneration } from '@/services/home/mascot/mascot.service';
import { mascotSession } from '../_session';

/**
 * POST /api/home/mascot/pregenerate — un changement métier vient d'être
 * validé : la prise de parole du compte est préparée en arrière-plan, après
 * 3 s sans autre changement (RUN-007 à RUN-009). Ne compte jamais comme une
 * exposition (RUN-011).
 */
export async function POST(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  scheduleMascotPregeneration(s.accountId);
  return NextResponse.json({ scheduled: true }, { status: 202 });
}
