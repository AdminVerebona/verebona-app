/**
 * Carte #806 §6 (lot 116C, seconde partie) — opérations des éléments de la
 * LISTE de l'Agenda. Module à part de `AgendaQueryService` : la lecture de la
 * liste (filtres, facettes) n'est pas modifiée, et rien n'est ajouté aux autres
 * lectures (accueil, export de calendrier, fiches).
 */
import type { AgendaItemFull } from './AgendaQueryService';

/**
 * Carte #806 §6 — joint à chaque élément TOUTES ses opérations actives, lues
 * dans le graphe canonique par la lecture EXISTANTE du tiroir et de la Timeline
 * (`readAgendaItemsReferenceEvents`) : même source de vérité, mêmes libellés,
 * UNE requête pour toute la liste (jamais une par élément). Bornée au compte ;
 * une opération invalidée ou fusionnée n'est jamais rendue. Lecture seule :
 * aucun élément, aucun rappel, aucune opération n'est créé ni modifié, et
 * l'ordre comme le nombre des éléments sont inchangés.
 */
export async function attachReferenceEvents(accountId: number, items: readonly AgendaItemFull[]): Promise<AgendaItemFull[]> {
  if (items.length === 0) return [...items];
  const { readAgendaItemsReferenceEvents } = await import('@/services/business-operations/graph/read');
  const parElement = await readAgendaItemsReferenceEvents(accountId, items.map((i) => i.id));
  return items.map((i) => ({ ...i, referenceEvents: (parElement.get(i.id) ?? []).map((e) => ({ id: e.operationId, label: e.label })) }));
}
