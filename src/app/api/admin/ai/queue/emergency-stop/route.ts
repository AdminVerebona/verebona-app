/**
 * POST /api/admin/ai/queue/emergency-stop — CDC BO IA §4.3, WF-08.
 *
 * Bloque ou relâche les appels IA de tout l'environnement.
 *
 * ── IL N'ÉCRASE PAS LES ÉTATS LOCAUX ───────────────────────────────────────
 * Le §4.3 est explicite : l'arrêt d'urgence est « distinct des états locaux »
 * et les préserve. Il est donc porté par sa propre ligne, et non appliqué en
 * passant tous les traitements à « suspendu » — au relâchement, un traitement
 * que quelqu'un avait désactivé la veille doit le rester.
 *
 * Les exécutions en cours reviennent en tête de file et reprendront depuis le
 * début, avec la configuration alors effective.
 */
import { NextRequest, NextResponse } from 'next/server';
import { setEmergencyStop, getEmergencyStop } from '@/services/ai/queue/job-queue.repository';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));
  if (typeof body.active !== 'boolean') {
    return NextResponse.json(
      { error: 'INVALID_PAYLOAD', message: 'Indiquez `active` : true pour engager, false pour relâcher.' },
      { status: 400 },
    );
  }

  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
  if (body.active && !reason) {
    // Un arrêt d'urgence sans motif laisse la personne suivante sans moyen de
    // savoir s'il peut être relâché.
    return NextResponse.json(
      { error: 'REASON_REQUIRED', message: 'Indiquez le motif de l’arrêt.' },
      { status: 400 },
    );
  }

  try {
    await setEmergencyStop(body.active, guard.ctx.adminUserId, reason);
    return NextResponse.json(await getEmergencyStop());
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/queue/emergency-stop');
  }
}
