/**
 * Lot 72D — routes Premium Duo RETIRÉES (ticket P0 « compte partagé » §4 et
 * §7, décision PO Q11).
 *
 * Les deux membres d'un Premium Duo travaillent désormais dans le MÊME compte,
 * avec les mêmes droits métier : les validations croisées (demande de
 * déplacement ou de suppression d'un bien soumise à l'autre membre) et la
 * « récupération » de biens vers un compte personnel n'ont plus d'objet. Elles
 * étaient d'ailleurs injoignables (`assets.duo_id` n'était écrit par aucun
 * code). Les routes répondent 410 avec un code stable et laissent une trace ;
 * les tables restent en base jusqu'à la contraction (lot ultérieur).
 * Les confirmations de suppression et protections générales sont inchangées.
 */
import { NextResponse, type NextRequest } from 'next/server';

export const DUO_CROSS_VALIDATION_REMOVED = 'DUO_CROSS_VALIDATION_REMOVED';
export const DUO_TRANSFER_LEAVE_REMOVED = 'DUO_TRANSFER_LEAVE_REMOVED';

const MESSAGES: Record<string, string> = {
  [DUO_CROSS_VALIDATION_REMOVED]:
    'Les deux membres d’un Premium Duo partagent le même espace : un bien se modifie, se déplace ou se supprime directement, sans validation de l’autre membre.',
  [DUO_TRANSFER_LEAVE_REMOVED]:
    'Quitter un Premium Duo ne déplace plus aucun bien : les données restent dans l’espace partagé. Utilisez « Quitter l’espace » depuis Mon compte.',
};

export function duoRouteRemoved(request: NextRequest, code: string = DUO_CROSS_VALIDATION_REMOVED): NextResponse {
  console.warn(JSON.stringify({
    event: 'duo.removed_route_called',
    code,
    path: request.nextUrl?.pathname ?? null,
    method: request.method ?? null,
  }));
  return NextResponse.json({ error: code, code, message: MESSAGES[code] ?? MESSAGES[DUO_CROSS_VALIDATION_REMOVED] }, { status: 410 });
}
