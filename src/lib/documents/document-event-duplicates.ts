/**
 * Carte Trello #830 (P2, Pré-MEP) — FICHE D'UN DOCUMENT : un événement déjà
 * représenté par une opération affichée sur la même fiche n'y est pas répété.
 *
 * RÈGLE D'AFFICHAGE SEULEMENT, PURE (aucune dépendance serveur, aucune
 * écriture) : rien n'est supprimé, détaché ni fusionné en base ; l'Agenda, la
 * fiche de l'opération et leurs tiroirs ne lisent pas ce module.
 *
 * Correspondance (règle A) — par les RELATIONS MÉTIER, jamais par les titres
 * ni par les dates : un événement lié au document est un doublon quand il
 * PORTE UN FAIT d'une opération (lien actif événement ↔ opération qualifié
 * par `fact_key` : il est la représentation de l'opération dans l'Agenda — la
 * carte qui portait la vignette « Jalon de l'opération »), que le document
 * est membre actif de cette opération, ET que la rubrique « Opérations » de la
 * fiche l'affiche effectivement. La route
 * `GET /api/documents/:id/agenda-liens` fournit ces opérations pour chaque
 * événement (`representedOperationIds`) ; la rubrique « Opérations » fournit
 * celles qu'elle affiche.
 *
 * Reste un événement DISTINCT, toujours affiché : un événement lié
 * directement au document hors de toute opération, et un événement
 * simplement rattaché à l'opération sans en porter un fait (visite, rappel,
 * événement associé par l'utilisateur avec « Associer à l'agenda »).
 *
 * Prudence : on ne masque que ce qui est PROUVÉ doublon.
 *   · lecture des liens en échec → tous les événements restent affichés ;
 *   · événement inconnu de la lecture des liens → affiché ;
 *   · opération non affichée (lecture en échec, opération retirée) → ses
 *     événements restent affichés ;
 *   · tant que les deux lectures ne sont pas arrivées, le bloc n'est pas
 *     rendu : un doublon n'apparaît jamais un instant avant de disparaître
 *     (ni à l'ouverture, ni à la réouverture, ni au rafraîchissement).
 */

/** Nature du lien d'un événement avec le document (réponse de `GET /api/documents/:id/agenda-liens`). */
export interface DocumentAgendaLinkFacts {
  itemId: number;
  direct: boolean;
  viaGroup: boolean;
  isMain: boolean;
  outsideOperation?: boolean;
  /** Opérations actives du document dont cet événement porte un fait (absent : serveur antérieur à la carte #830 → jamais doublon). */
  representedOperationIds?: number[];
}

/** État de la lecture des liens pour le document affiché. */
export type DocumentAgendaLinksState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; links: ReadonlyMap<number, DocumentAgendaLinkFacts> };

export interface DocumentEventsView<T> {
  /** Faux : la correspondance n'est pas encore connue — le bloc « Événements associés » et son bouton ne sont pas rendus. */
  ready: boolean;
  /** Événements à afficher (autonomes, ou dont l'opération n'est pas affichée), dans l'ordre reçu. */
  events: T[];
  /** Identifiants des événements masqués parce qu'une opération affichée les représente. */
  hiddenIds: number[];
  /**
   * Bouton « Associer à l'agenda » du bloc : absent quand TOUS les événements du document sont des doublons
   * (le bloc entier disparaît) ; présent sinon — y compris quand le document n'a aucun événement.
   */
  showAssociate: boolean;
}

/** Vrai si l'événement représente une opération AFFICHÉE sur la fiche (relation métier, jamais titre ni date). */
export function isEventOfDisplayedOperation(link: DocumentAgendaLinkFacts | undefined, displayedOperationIds: ReadonlySet<number>): boolean {
  if (!link?.representedOperationIds?.length) return false;
  return link.representedOperationIds.some((id) => displayedOperationIds.has(id));
}

/**
 * Événements à afficher dans la fiche d'un document.
 * `displayedOperationIds` : opérations que la rubrique « Opérations » affiche (null : lecture en cours).
 */
export function documentEventsView<T extends { id: number }>(
  items: readonly T[], links: DocumentAgendaLinksState, displayedOperationIds: readonly number[] | null,
): DocumentEventsView<T> {
  if (links.status === 'failed') return { ready: true, events: [...items], hiddenIds: [], showAssociate: true };
  if (links.status === 'loading' || displayedOperationIds === null) return { ready: false, events: [], hiddenIds: [], showAssociate: false };
  const affichees = new Set(displayedOperationIds);
  const events: T[] = [];
  const hiddenIds: number[] = [];
  for (const item of items) {
    if (isEventOfDisplayedOperation(links.links.get(item.id), affichees)) hiddenIds.push(item.id);
    else events.push(item);
  }
  // Tous les liens connus du serveur sont des doublons : le bloc entier disparaît (titre, cartes, bouton, espace).
  const tousDoublons = links.links.size > 0 && [...links.links.values()].every((l) => isEventOfDisplayedOperation(l, affichees));
  return { ready: true, events, hiddenIds, showAssociate: events.length > 0 || !tousDoublons };
}
