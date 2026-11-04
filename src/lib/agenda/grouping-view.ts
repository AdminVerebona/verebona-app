/**
 * Regroupement d'éléments d'agenda — CONTRAT D'AFFICHAGE partagé client /
 * serveur (lot 84B, CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot
 * O-3 : §7, §8, §11.9, §14 ; AC01–AC08, AC27, AC28, AC32).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'OPÉRATION EST INVISIBLE (P1, AC03)
 *
 * Le regroupement technique (« Opération ») et le rôle « principal » ne sont
 * JAMAIS nommés à l'écran. L'utilisateur voit :
 *   · un « événement de référence » (le principal) et « tout ce qui s'y
 *     rattache » : étapes et rendez-vous, documents, biens, Pièces,
 *     équipements (tiroir du principal, §14.2, AC27) ;
 *   · pour une étape : « Fait partie de « Dégât des eaux » » et l'accès à cet
 *     événement (tiroir secondaire léger, §14.3, AC28) ;
 *   · pour un document : l'événement de référence retrouvé par le lien
 *     propagé et ses liens précis (§14.4).
 * Aucun libellé ici ne contient « Opération » ni « principal » (test
 * L84B-U-VOC). Aucun import serveur : importable par les composants.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Place de l'élément : événement de référence, élément rattaché, ou seul. */
export type GroupingRole = 'MAIN' | 'MEMBER' | 'NONE';

export interface GroupingItemRef { id: number; title: string; startDate: string | null; isMain: boolean }
export interface GroupingDocumentRef {
  id: number;
  title: string;
  documentDate: string | null;
  /** Lot 108D : libellé du Type documentaire (sous-titre de la ligne), null si inconnu. */
  typeLabel?: string | null;
  /** Lien de CET élément vers le document : précis (saisi / IA), seulement par l'ensemble, ou aucun. */
  link: 'DIRECT' | 'GROUP' | null;
}
export interface GroupingNamedRef { id: number; name: string; assetId?: number | null }

export interface GroupingCounts { items: number; documents: number; assets: number; rooms: number; equipments: number }

export interface AgendaGroupingView {
  itemId: number;
  role: GroupingRole;
  /** Événement de référence de l'ensemble (pour un élément rattaché), sinon null. */
  main: { id: number; title: string; startDate: string | null } | null;
  /** L'utilisateur a retiré le rôle d'événement de référence dans cet ensemble (décision mémorisée). */
  mainWithdrawn: boolean;
  /**
   * Contenu de l'ensemble : COMPLET pour l'événement de référence (cinq
   * catégories) ; pour un élément d'un ensemble SANS événement de référence,
   * seulement les autres éléments (aucun autre accès à l'ensemble) ; null
   * pour un élément rattaché à un événement de référence (tiroir léger).
   */
  ensemble: {
    items: GroupingItemRef[];
    documents: GroupingDocumentRef[];
    assets: GroupingNamedRef[];
    rooms: GroupingNamedRef[];
    equipments: GroupingNamedRef[];
  } | null;
  /** Indication du contexte global (tiroir léger) : nombres, jamais le détail. */
  counts: GroupingCounts | null;
  /**
   * Lot 86D : documents reliés à CET élément (lien précis ou propagé), quel que
   * soit son rôle — consulter, ouvrir, détacher individuellement (ticket
   * « Documents / Agenda » §2). Pour l'événement de référence, la catégorie
   * « Documents » de l'ensemble les présente déjà (avec leur nature de lien).
   */
  linkedDocuments: GroupingDocumentRef[];
  /**
   * Lot 103D (règle `lib/agenda/housing-scope`) : les catégories « Pièces » et
   * « Équipements » n'existent que si au moins un LOGEMENT est rattaché
   * (biens de l'ensemble et de l'événement de référence). Absent ou
   * `allowed: false` : aucune des deux catégories (ni titre, ni « Aucun… », ni
   * bouton).
   */
  structuralScope?: { allowed: boolean; housingAssetIds: number[] };
}

export type GroupingCandidateKind = 'elements' | 'documents' | 'biens' | 'pieces' | 'equipements';
export const GROUPING_CANDIDATE_KINDS: readonly GroupingCandidateKind[] = ['elements', 'documents', 'biens', 'pieces', 'equipements'];

export interface GroupingCandidate { id: number; title: string; meta: string | null }

/** Gestes du tiroir (route `POST /api/agenda/[id]/liens`). */
export const GROUPING_ACTIONS = [
  'relier-element', 'retirer-element', 'quitter-ensemble',
  'relier-document', 'retirer-document', 'detacher-document',
  'relier-bien', 'retirer-bien',
  'relier-piece', 'retirer-piece',
  'relier-equipement', 'retirer-equipement',
  'designer-reference', 'retirer-reference',
] as const;
export type GroupingAction = (typeof GROUPING_ACTIONS)[number];
export const isGroupingAction = (v: unknown): v is GroupingAction => typeof v === 'string' && (GROUPING_ACTIONS as readonly string[]).includes(v);

/**
 * Libellés visibles (langage utilisateur).
 *
 * Lot 103D (ticket « Agenda — wording des associations », décision PO du
 * 31/10) : dans le parcours d'association entre deux entrées de l'Agenda,
 * « événement » est le terme générique visible pour l'AUTRE entrée (contrôle,
 * échéance, rappel…) ; « élément de l'agenda » n'est plus jamais affiché. Les
 * titres et types métier des entrées restent inchangés. Retirer un lien se
 * dit « Dissocier » / « Retirer l'association » — jamais « Supprimer ».
 */
export const GROUPING_LABELS = {
  sectionMain: 'Tout ce qui se rattache à cet événement',
  sectionLinked: 'Événements associés',
  sectionAlone: 'Associations',
  partOf: 'Fait partie de',
  openMain: 'Voir l’ensemble',
  mainBadge: 'Événement de référence',
  makeMain: 'En faire l’événement de référence',
  releaseMain: 'Ne plus en faire l’événement de référence',
  releaseTitle: 'Ne plus en faire l’événement de référence ?',
  releaseBody: 'Les éléments, documents, biens, pièces et équipements restent reliés entre eux : rien n’est supprimé. Verebona ne rétablira pas cet événement de référence de lui-même ; vous pourrez en désigner un autre à tout moment.',
  leave: 'Retirer de cet ensemble',
  withdrawnNote: 'Aucun événement de référence : vous l’avez retiré.',
  categories: {
    elements: 'Étapes et rendez-vous',
    documents: 'Documents',
    biens: 'Biens',
    pieces: 'Pièces',
    equipements: 'Équipements',
  } satisfies Record<GroupingCandidateKind, string>,
  add: {
    elements: 'Associer à un autre événement',
    // Lot 89B (demande PO 25/10) : libellé d'association agenda → document.
    documents: 'Associer un document',
    biens: 'Relier un bien',
    pieces: 'Relier une pièce',
    equipements: 'Relier un équipement',
  } satisfies Record<GroupingCandidateKind, string>,
  createStep: 'Créer une étape',
  empty: {
    elements: 'Aucune autre étape.',
    documents: 'Aucun document associé.',
    biens: 'Aucun bien.',
    pieces: 'Aucune pièce.',
    equipements: 'Aucun équipement.',
  } satisfies Record<GroupingCandidateKind, string>,
  search: 'Rechercher',
  /** Lot 103D : état vide de la liste des événements associés (ensemble sans événement de référence). */
  emptyLinkedEvents: 'Aucun événement associé.',
  /** Lot 103D : titre, aide et recherche du sélecteur selon ce qui est choisi. */
  pickerTitle: {
    elements: 'Choisir un événement à associer',
    documents: 'Choisir un document à associer',
    biens: 'Relier un bien',
    pieces: 'Relier une pièce',
    equipements: 'Relier un équipement',
  } satisfies Record<GroupingCandidateKind, string>,
  pickerHint: {
    elements: 'Choisissez l’événement à associer.',
    documents: 'Choisissez le document à associer.',
    biens: 'Choisissez le bien à relier.',
    pieces: 'Choisissez la pièce à relier.',
    equipements: 'Choisissez l’équipement à relier.',
  } satisfies Record<GroupingCandidateKind, string>,
  pickerSearch: {
    elements: 'Rechercher un événement',
    documents: 'Rechercher un document',
    biens: 'Rechercher',
    pieces: 'Rechercher',
    equipements: 'Rechercher',
  } satisfies Record<GroupingCandidateKind, string>,
  noCandidate: 'Aucun résultat.',
  remove: 'Retirer',
  /** Lot 103D : retrait d'un événement associé (lien seul, jamais l'événement). */
  dissociate: 'Dissocier',
  dissociateEvent: (title: string) => `Dissocier « ${title} »`,
  /** Lot 103D : confirmations des gestes d'association. */
  eventAssociatedToast: 'Événement associé',
  associationRemovedToast: 'Association retirée',
  savedToast: 'C’est enregistré',
  directLink: 'Lien direct',
  // Lot 89B (demande PO 25/10) : association document → agenda — ouvre la SÉLECTION des éléments
  // existants, ne crée jamais d'élément ; la création reste une action distincte et explicite.
  documentAgendaTitle: 'Associer à l’agenda',
  documentAgendaPickerHint: 'Choisissez un événement existant.',
  createAgendaItem: 'Créer un événement',
  /** Lot 103D : liste des événements associés dans la fiche d'un document. */
  documentLinkedEvents: 'Événements associés',
  associatedToast: 'Document associé',
  // Lot 86D : détachement individuel (le document et l'élément restent, rien n'est supprimé).
  linkedDocuments: 'Documents associés',
  // Lot 89B : « Retirer l’association » (lien seul ; document et élément restent).
  detach: 'Retirer l’association',
  detachFromItem: (title: string) => `Retirer l’association avec « ${title} »`,
  detachItemFromDocument: (title: string) => `Retirer l’association avec « ${title} »`,
  removeFromEnsemble: (title: string) => `Retirer « ${title} » de l’ensemble`,
  detachedToast: 'Association retirée. Le document reste disponible dans vos documents.',
} as const;

/** Lot 103D : message de confirmation d'un geste réussi du tiroir (pur). */
export function groupingActionToast(action: GroupingAction): string {
  switch (action) {
    case 'relier-element': return GROUPING_LABELS.eventAssociatedToast;
    case 'relier-document': return GROUPING_LABELS.associatedToast;
    case 'detacher-document': return GROUPING_LABELS.detachedToast;
    case 'retirer-element': case 'quitter-ensemble': case 'retirer-document':
    case 'retirer-bien': case 'retirer-piece': case 'retirer-equipement':
      return GROUPING_LABELS.associationRemovedToast;
    default: return GROUPING_LABELS.savedToast;
  }
}

/** Action « retirer » de chaque catégorie. */
export const REMOVE_ACTION: Record<GroupingCandidateKind, GroupingAction> = {
  elements: 'retirer-element', documents: 'retirer-document', biens: 'retirer-bien', pieces: 'retirer-piece', equipements: 'retirer-equipement',
};
/** Action « relier » de chaque catégorie. */
export const LINK_ACTION: Record<GroupingCandidateKind, GroupingAction> = {
  elements: 'relier-element', documents: 'relier-document', biens: 'relier-bien', pieces: 'relier-piece', equipements: 'relier-equipement',
};

/** Résumé du contexte global d'un élément rattaché (« 2 étapes · 5 documents »). Pur. */
export function groupingCountsSummary(c: GroupingCounts | null): string {
  if (!c) return '';
  const part = (n: number, one: string, many: string) => (n > 0 ? `${n} ${n > 1 ? many : one}` : null);
  return [
    part(c.items, 'étape', 'étapes'), part(c.documents, 'document', 'documents'), part(c.assets, 'bien', 'biens'),
    part(c.rooms, 'pièce', 'pièces'), part(c.equipments, 'équipement', 'équipements'),
  ].filter(Boolean).join(' · ');
}
