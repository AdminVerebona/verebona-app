import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { recordMascotEvents } from '@/services/home/mascot/actions.service';
import { mascotSession } from '../_session';

/** Télémétrie produit de la mascotte — CDC Mascotte §17. */
const Body = z.object({
  events: z.array(z.object({
    visitId: z.string().min(8).max(64),
    occurrenceKey: z.string().min(1).max(200),
    sourceCode: z.string().min(1).max(80),
    placement: z.enum(['subject', 'secondary']),
    eventType: z.enum(['displayed', 'clicked', 'disappeared']),
    actionId: z.string().max(200).nullish(),
  })).max(20),
});

export async function POST(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  try {
    const recorded = await recordMascotEvents(s.accountId, s.userId, parsed.data.events);
    return NextResponse.json({ recorded });
  } catch (e) {
    // La télémétrie ne doit jamais gêner l'utilisateur.
    console.error('[api/home/mascot/events]', (e as Error).message);
    return NextResponse.json({ recorded: 0 });
  }
}
