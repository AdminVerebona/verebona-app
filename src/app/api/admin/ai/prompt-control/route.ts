/**
 * /api/admin/ai/prompt-control — RETIRÉ (lot 49, ticket 12 « Supprimer
 * définitivement T5 (Prompt Control) »).
 *
 * T5 n'existe plus : cette route ne fait plus AUCUN appel modèle et AUCUNE
 * écriture. Elle est conservée uniquement pour rejeter EXPLICITEMENT une
 * invocation résiduelle (ancien onglet ouvert, script, favori) par un
 * 410 Gone au lieu d'un 404 ambigu. Garde administrateur conservée (GEN-002 :
 * toute route /api/admin/** la porte) : un non-administrateur reçoit le refus
 * de session habituel. Aucune donnée renvoyée : rien n'est exposé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';

export const dynamic = 'force-dynamic';

const T5_RETIRED_BODY = {
  error: 'T5_RETIRED',
  message: 'Prompt Control (T5) est retiré : les prompts maîtres s’administrent manuellement dans « Prompts maîtres ».',
} as const;

async function retire(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(req);
  } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e) as NextResponse;
    throw e;
  }
  return NextResponse.json(T5_RETIRED_BODY, { status: 410 });
}

export const GET = retire;
export const POST = retire;
export const PUT = retire;
export const PATCH = retire;
export const DELETE = retire;
