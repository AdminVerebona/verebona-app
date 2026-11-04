/**
 * POST /api/documents/[id]/notify-analyzed — CONSERVÉE POUR COMPATIBILITÉ.
 *
 * Ancienne route (« analyse terminée », une notification PAR document, écrite
 * directement dans la cloche avec une clé horodatée — donc jamais dédupliquée,
 * et affichée en toast). Le lot 0 l'avait retirée de l'interface ; le
 * résultat d'une analyse est notifié par `lot-notification.ts` (une seule
 * notification, lot 81E ; une seule par document et seulement si
 * l'utilisateur ne suit pas l'analyse, lot 108I).
 *
 * Lot 108I : la route ne crée plus rien (un appel d'une interface ancienne ou
 * forgé produisait un doublon « … a été analysé »). Les lignes
 * `DOCUMENT_ANALYZED` historiques restent affichées dans la cloche.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';

export async function POST(request: NextRequest) {
  try { await getSession(request); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  return NextResponse.json({ ok: true, emitted: false }, { status: 202 });
}
