import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SKIP_KEY_PATTERN, recordSuggestionSkip } from '@/services/home/mascot/discovery';
import { mascotSession } from '../../_session';

/**
 * POST /api/home/mascot/suggestions/skip — « Autre suggestion » (lot 106B).
 *
 * Préférence PERSONNELLE de l'utilisateur de la session (Duo : la sienne),
 * dans le compte de la session (aucun identifiant reçu n'est cru) : la
 * suggestion n'est plus proposée pendant sa période de repos. Aucune donnée
 * métier, aucune tâche « À traiter », aucun appel IA ; autorisée en lecture
 * seule (simple préférence d'affichage).
 */
const Body = z.object({ key: z.string().min(1).max(200).regex(SKIP_KEY_PATTERN) });

export async function POST(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  const recorded = await recordSuggestionSkip(s.accountId, s.userId, parsed.data.key);
  // Jamais bloquant pour l'utilisateur : la suggestion est déjà retirée à l'écran.
  return NextResponse.json({ recorded });
}
