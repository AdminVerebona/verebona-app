import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';

/**
 * Lot 113P (#715, décision PO du 06/11/2026) : les événements de l'agenda
 * n'ont PLUS de statut (« Réalisé », « Annulé »…). Cette route, appelée par
 * d'anciennes versions de l'interface (cache PWA), ne modifie plus rien :
 * 410 Gone, code stable `AGENDA_STATUS_REMOVED`. Un événement inexistant ou
 * annulé se SUPPRIME (`DELETE /api/agenda/:id`) ; une date se MODIFIE
 * (`PUT /api/agenda/:id`).
 *
 * Gardes conservées (session, lecture seule — lot 85D) : une route ancienne
 * reste une route d'écriture du point de vue des contrôles, et ne répond
 * rien à un appelant non connecté. Aucune écriture, donc aucun événement
 * métier émis.
 */
export const AGENDA_STATUS_REMOVED = 'AGENDA_STATUS_REMOVED';

export async function PATCH(req: NextRequest) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

  const refus = await refuserSiLectureSeule(accountId);
  if (refus) return refus;

  return NextResponse.json(
    { error: 'Les événements n’ont plus de statut : modifiez la date ou supprimez l’événement.', code: AGENDA_STATUS_REMOVED },
    { status: 410 },
  );
}
