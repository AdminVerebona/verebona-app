/**
 * Lot 103D — réponse HTTP d'un refus « pièce / équipement sans logement
 * rattaché » (routes Agenda) : 409, code STABLE, identifiants concernés
 * (objets du compte seulement : la référence étrangère est refusée avant, en
 * 400, par le contrôle d'appartenance SEC-07). Rien n'a été écrit.
 */
import { NextResponse } from 'next/server';
import { AgendaStructuralLinkError } from './write-agenda-item';

export function structuralLinkRefusal(err: unknown): NextResponse | null {
  if (!(err instanceof AgendaStructuralLinkError)) return null;
  return NextResponse.json({
    error: err.message,
    code: err.code,
    // `details` : relu par `apiClient` (ApiClientError.details).
    details: { substructureIds: err.incompatible.roomIds, equipmentIds: err.incompatible.equipmentIds },
  }, { status: 409 });
}
