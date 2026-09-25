import { NextRequest, NextResponse } from 'next/server';
import { getMascotPresentation } from '@/services/home/mascot/mascot.service';
import { mascotSession } from './_session';

/**
 * GET /api/home/mascot — prise de parole de la mascotte d'accueil
 * (CDC Mascotte d'accueil & T6, §16 : MascotPresentation).
 *
 * Calculée au niveau du COMPTE (DUO-001) ; salutation et prénom sont rendus
 * par le client, hors T6 et hors cache (UX-002, RUN-005).
 */
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  try {
    const presentation = await getMascotPresentation(s.accountId, 'display');
    return NextResponse.json(presentation, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('GET /api/home/mascot', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
