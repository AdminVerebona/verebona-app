/**
 * Carte Trello #806, volet B §7 (CDC « Opérations / Agenda V2.0 » §14, §19 ;
 * AC43, AC44) — NATURE DES LIENS d'un document avec une opération : textes et
 * règles d'affichage. PUR (aucune dépendance serveur) : partagé par la fiche
 * de l'opération, le tiroir du document, le tiroir d'un événement de l'Agenda,
 * les routes et les tests.
 *
 * Quatre natures, jamais confondues, et un document n'apparaît qu'UNE fois :
 *   · MEMBER  — le document APPARTIENT à l'opération (appartenance enregistrée) ;
 *   · EVENT   — il est lié DIRECTEMENT à un événement de l'Agenda de l'opération,
 *               sans appartenir à l'opération (lecture calculée, rien n'est écrit) ;
 *   · RELATED — il est porté par une opération ASSOCIÉE (le contrat d'assurance
 *               consulté depuis le sinistre) : ni copié, ni rattaché, ni compté ;
 *   · « partagé » est une qualité d'un document MEMBER qui appartient aussi à
 *     une autre opération.
 *
 * Vocabulaire (décision du PO du 17/11/2026, carte #806 §1) : ces textes sont
 * NOUVEAUX, ils disent « opération ». Tous sont « à valider par le PO » (fiche
 * de recette 116C, §7).
 */

export type OperationDocumentNature = 'MEMBER' | 'EVENT' | 'RELATED';

/** Autre opération qui porte aussi le document (identifiant cliquable, libellé utilisateur). */
export interface OperationRef { operationId: number; label: string }

/** Document lié DIRECTEMENT à un ou plusieurs événements de l'Agenda de l'opération, sans lui appartenir. */
export interface OperationEventDocument {
  fileId: number;
  title: string;
  date: string | null;
  /** Événements de l'opération auxquels le document est lié directement (au moins un). */
  agendaItems: Array<{ id: number; title: string }>;
}

/** Document porté par une opération ASSOCIÉE, consultable d'ici sans copie. */
export interface OperationRelatedDocument {
  fileId: number;
  title: string;
  date: string | null;
  operationId: number;
  operationLabel: string;
}

/** Tiroir d'un document : opération à laquelle il appartient. */
export interface DocumentOperationRef {
  id: number;
  label: string;
  /** Événements de l'Agenda de CETTE opération auxquels le document est aussi lié directement. */
  directAgendaItemIds: number[];
}

/** Borne des opérations proposées au rattachement (au-delà : « précisez votre recherche », jamais une coupe muette). */
export const DOCUMENT_OPERATION_CANDIDATE_LIMIT = 30;

export const OPERATION_LINK_LABELS = {
  // ── Fiche de l'opération et tiroir d'un événement de l'Agenda ──
  member: 'Appartient à cette opération',
  memberOfOperation: 'Appartient à l’opération',
  shared: 'Justificatif partagé',
  sharedWith: (labels: readonly string[]): string => (labels.length === 1
    ? `Justificatif partagé avec l’opération « ${labels[0]} »`
    : `Justificatif partagé avec ${labels.length} autres opérations`),
  directToEvent: 'Lié directement à cet événement',
  directToEvents: (titles: readonly string[]): string => (titles.length === 1
    ? `Lié directement à l’événement « ${titles[0]} »`
    : `Lié directement à ${titles.length} événements de cette opération`),
  related: (label: string): string => `Document de l’opération associée « ${label} »`,
  associatedOperation: 'Opération associée',
  /** Phrase d'aide sous la liste quand elle mêle plusieurs natures. */
  mixedHint: 'Un document n’est listé qu’une fois. Seuls les documents qui appartiennent à cette opération peuvent en être retirés ici.',
  // ── Tiroir d'un document ──
  drawerTitle: 'Opérations',
  drawerEmpty: 'Ce document n’appartient à aucune opération.',
  open: (label: string): string => `Ouvrir l’opération « ${label} »`,
  attach: 'Rattacher à une opération',
  remove: 'Retirer',
  removeAria: (label: string): string => `Retirer ce document de l’opération « ${label} »`,
  removeTitle: 'Retirer ce document de cette opération ?',
  removeBody: 'Seul ce lien est retiré. Le document, ses autres opérations et ses liens directs avec votre agenda ne changent pas. Verebona ne le rattachera plus de lui-même à cette opération.',
  removeConfirm: 'Retirer de l’opération',
  cancel: 'Annuler',
  pickerTitle: 'Choisir une opération',
  pickerSearch: 'Rechercher une opération',
  pickerHint: 'Le document sera rattaché à l’opération choisie. Ses autres liens ne changent pas.',
  pickerMore: 'D’autres opérations existent : précisez votre recherche.',
  /** Événement de l'Agenda lié au document sans passer par une de ses opérations. */
  outsideOperation: 'Lien direct, hors opération',
  failed: 'Ce geste n’a pas abouti. Rien n’a été modifié.',
} as const;

/** Sous-titre d'un justificatif MEMBRE de la fiche (pur). */
export function memberDocumentSubtitle(sharedWith: readonly OperationRef[] | undefined, directEvents: readonly { title: string }[] | undefined): string {
  const parts: string[] = [OPERATION_LINK_LABELS.member];
  if (sharedWith?.length) parts.push(OPERATION_LINK_LABELS.sharedWith(sharedWith.map((o) => o.label)));
  if (directEvents?.length) parts.push(OPERATION_LINK_LABELS.directToEvents(directEvents.map((e) => e.title)));
  return parts.join(' · ');
}

/**
 * Liste UNIQUE des documents d'une fiche, dédoublonnée (pur) : un fichier
 * n'apparaît qu'une fois, sous sa nature la plus forte — membre, puis lié
 * directement à un événement, puis porté par une opération associée. L'ordre
 * de chaque groupe est conservé.
 */
export function dedupeOperationDocuments<M extends { fileId: number }, E extends { fileId: number }, R extends { fileId: number }>(
  members: readonly M[], events: readonly E[], related: readonly R[],
): { members: M[]; events: E[]; related: R[] } {
  const vus = new Set<number>();
  const garder = <T extends { fileId: number }>(xs: readonly T[]): T[] => xs.filter((x) => (vus.has(x.fileId) ? false : (vus.add(x.fileId), true)));
  return { members: garder(members), events: garder(events), related: garder(related) };
}
