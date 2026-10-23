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
}

export type GroupingCandidateKind = 'elements' | 'documents' | 'biens' | 'pieces' | 'equipements';
export const GROUPING_CANDIDATE_KINDS: readonly GroupingCandidateKind[] = ['elements', 'documents', 'biens', 'pieces', 'equipements'];

export interface GroupingCandidate { id: number; title: string; meta: string | null }

/** Gestes du tiroir (route `POST /api/agenda/[id]/liens`). */
export const GROUPING_ACTIONS = [
  'relier-element', 'retirer-element', 'quitter-ensemble',
  'relier-document', 'retirer-document',
  'relier-bien', 'retirer-bien',
  'relier-piece', 'retirer-piece',
  'relier-equipement', 'retirer-equipement',
  'designer-reference', 'retirer-reference',
] as const;
export type GroupingAction = (typeof GROUPING_ACTIONS)[number];
export const isGroupingAction = (v: unknown): v is GroupingAction => typeof v === 'string' && (GROUPING_ACTIONS as readonly string[]).includes(v);

/** Libellés visibles (langage utilisateur). */
export const GROUPING_LABELS = {
  sectionMain: 'Tout ce qui se rattache à cet événement',
  sectionLinked: 'Éléments reliés',
  sectionAlone: 'Relier cet élément',
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
    elements: 'Relier un élément de l’agenda',
    documents: 'Relier un document',
    biens: 'Relier un bien',
    pieces: 'Relier une pièce',
    equipements: 'Relier un équipement',
  } satisfies Record<GroupingCandidateKind, string>,
  createStep: 'Créer une étape',
  empty: {
    elements: 'Aucune autre étape.',
    documents: 'Aucun document.',
    biens: 'Aucun bien.',
    pieces: 'Aucune pièce.',
    equipements: 'Aucun équipement.',
  } satisfies Record<GroupingCandidateKind, string>,
  search: 'Rechercher',
  noCandidate: 'Aucun résultat.',
  remove: 'Retirer',
  directLink: 'Lien direct',
  documentAgendaTitle: 'Relier à un élément de l’agenda',
} as const;

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
