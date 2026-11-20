/**
 * Carte Trello #806, volet B §8 — LISTE DES OPÉRATIONS du compte : modèle,
 * textes, lecture de la demande, tri et pagination. PUR (aucune dépendance
 * serveur) : partagé par la route, la page et les tests.
 *
 * La liste est une PAGE sous l'Agenda (`/agenda/evenements-reference`), sans
 * entrée de menu (la carte interdit un menu « Opérations ») : on y arrive
 * depuis la fiche d'une opération. Elle montre TOUTES les opérations actives
 * du compte — y compris celles qui n'ont ni bien, ni document, ni événement,
 * ni date — et ne coupe rien en silence : le nombre total est dit, les pages
 * se suivent.
 *
 * L'état interne (envisagé / réalisé / annulé) n'est NI affiché NI proposé en
 * filtre : décision du PO du 12/11/2026 (« il reste interne, jamais affiché
 * comme un pipeline »). Les « états » de la liste sont des faits visibles :
 * avec ou sans date, avec ou sans justificatif.
 *
 * Textes NOUVEAUX (« opération », décision du PO du 17/11/2026) : « à valider
 * par le PO » (fiche de recette 116C, §8).
 */
import { REFERENCE_EVENT_ROUTE } from './reference-event-page';

/** Adresse de la liste (la racine des pages d'opération, sous l'Agenda). */
export const OPERATION_LIST_ROUTE = REFERENCE_EVENT_ROUTE;

export const OPERATION_LIST_SORTS = ['DATE_DESC', 'DATE_ASC', 'TITLE', 'AMOUNT_DESC'] as const;
export type OperationListSort = (typeof OPERATION_LIST_SORTS)[number];

/** Filtre « état visible » : tout, avec date, sans date, sans justificatif. */
export const OPERATION_LIST_STATES = ['ALL', 'DATED', 'UNDATED', 'NO_DOCUMENT'] as const;
export type OperationListState = (typeof OPERATION_LIST_STATES)[number];

/** Valeur du filtre de type pour « type non précisé ». */
export const OPERATION_LIST_TYPE_NONE = 'NONE';

export const OPERATION_LIST_PAGE_SIZE = 25;
export const OPERATION_LIST_PAGE_SIZE_MAX = 100;

export interface OperationListQuery {
  q: string;
  /** Code de type, `NONE` (non précisé) ou null (tous). */
  type: string | null;
  assetId: number | null;
  state: OperationListState;
  sort: OperationListSort;
  page: number;
  pageSize: number;
}

/** Une ligne de la liste : tout ce qui est affiché est cliquable ou nommé, rien n'est tronqué. */
export interface OperationListItem {
  id: number;
  title: string;
  typeCode: string | null;
  /** Nom utilisateur du type ; null : non précisé. */
  typeLabel: string | null;
  /** Date de présentation (même règle que la fiche et la Timeline) ; null : sans date. */
  date: string | null;
  assets: Array<{ id: number; name: string }>;
  rooms: string[];
  equipments: string[];
  suppliers: string[];
  /** Prestataire désigné par les justificatifs (texte), quand aucun fournisseur n'est relié. */
  provider: string | null;
  documentCount: number;
  agendaItemCount: number;
  /** Contrats associés (libellés) — le contrat d'assurance d'un sinistre, par exemple. */
  contracts: Array<{ id: number; label: string }>;
  /** Net indicatif en centimes d'euro (règle existante de la fiche) ; null : aucun coût réalisé connu. */
  netCents: number | null;
  /** Montants dans une autre devise, non convertis et non comptés. */
  unconvertedCount: number;
}

export interface OperationListPage {
  items: OperationListItem[];
  /** Nombre d'opérations qui répondent à la demande (toutes pages confondues). */
  total: number;
  /** Nombre d'opérations actives du compte, sans filtre. */
  totalAll: number;
  page: number;
  pageSize: number;
  pages: number;
  query: OperationListQuery;
  /** Types proposés au filtre (référentiel), avec leur nom utilisateur. */
  types: Array<{ code: string; label: string }>;
  /** Biens proposés au filtre (ceux que portent des opérations du compte). */
  assets: Array<{ id: number; name: string }>;
}

export const OPERATION_LIST_LABELS = {
  title: 'Opérations',
  intro: 'Toutes les opérations de votre compte : achats, interventions, contrats, financements, sinistres, cessions. Chacune réunit ses justificatifs et ses événements de l’agenda.',
  back: 'Retour',
  openAll: 'Toutes les opérations',
  search: 'Rechercher une opération',
  searchHint: 'Intitulé, type, bien, pièce, équipement, fournisseur, justificatif ou référence',
  filterType: 'Type',
  filterTypeAll: 'Tous les types',
  filterTypeNone: 'Type non précisé',
  filterAsset: 'Bien',
  filterAssetAll: 'Tous les biens',
  filterState: 'Afficher',
  states: {
    ALL: 'Toutes', DATED: 'Avec une date', UNDATED: 'Sans date', NO_DOCUMENT: 'Sans justificatif',
  } as Readonly<Record<OperationListState, string>>,
  sort: 'Trier par',
  sorts: {
    DATE_DESC: 'Date, la plus récente d’abord', DATE_ASC: 'Date, la plus ancienne d’abord', TITLE: 'Intitulé', AMOUNT_DESC: 'Montant, le plus élevé d’abord',
  } as Readonly<Record<OperationListSort, string>>,
  reset: 'Réinitialiser',
  undated: 'Sans date',
  noType: 'Type non précisé',
  colDate: 'Date',
  colAssets: 'Biens',
  colRooms: 'Pièces',
  colEquipments: 'Équipements',
  colSuppliers: 'Fournisseurs',
  colContracts: 'Contrats associés',
  colAmount: 'Total dépensé',
  open: (title: string): string => `Ouvrir l’opération : ${title}`,
  documents: (n: number): string => (n === 0 ? 'Aucun justificatif' : n === 1 ? '1 justificatif' : `${n} justificatifs`),
  events: (n: number): string => (n === 0 ? 'Aucun événement' : n === 1 ? '1 événement' : `${n} événements`),
  unconverted: (n: number): string => (n === 1 ? '1 montant dans une autre devise, non compté' : `${n} montants dans une autre devise, non comptés`),
  count: (total: number, totalAll: number): string => {
    const nb = (n: number) => (n === 0 ? 'Aucune opération' : n === 1 ? '1 opération' : `${n} opérations`);
    return total === totalAll ? nb(total) : `${nb(total)} sur ${totalAll}`;
  },
  pageOf: (page: number, pages: number): string => `Page ${page} sur ${pages}`,
  previous: 'Page précédente',
  next: 'Page suivante',
  empty: 'Aucune opération pour le moment. Elles apparaissent quand Verebona réunit vos justificatifs, ou quand vous en déclarez une à l’Assistant.',
  emptyFiltered: 'Aucune opération ne correspond à votre recherche.',
  loadError: 'La liste n’a pas pu être chargée.',
  retry: 'Réessayer',
} as const;

const entier = (v: string | null): number | null => (v !== null && /^\d{1,9}$/.test(v) ? Number(v) : null);

/** Lit une demande depuis les paramètres d'adresse (forme et bornes seulement ; valeurs inconnues : défaut). */
export function operationListQueryOf(params: { get: (k: string) => string | null }): OperationListQuery {
  const sort = params.get('tri');
  const state = params.get('etat');
  const type = (params.get('type') ?? '').trim().toUpperCase();
  const page = entier(params.get('page'));
  const size = entier(params.get('taille'));
  const assetId = entier(params.get('bien'));
  return {
    q: (params.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    type: /^[A-Z_]{1,40}$/.test(type) ? type : null,
    assetId: assetId !== null && assetId > 0 ? assetId : null,
    state: (OPERATION_LIST_STATES as readonly string[]).includes(state ?? '') ? (state as OperationListState) : 'ALL',
    sort: (OPERATION_LIST_SORTS as readonly string[]).includes(sort ?? '') ? (sort as OperationListSort) : 'DATE_DESC',
    page: page !== null && page >= 1 ? page : 1,
    pageSize: size !== null && size >= 1 ? Math.min(size, OPERATION_LIST_PAGE_SIZE_MAX) : OPERATION_LIST_PAGE_SIZE,
  };
}

/** Paramètres d'adresse d'une demande (les valeurs par défaut sont omises). */
export function operationListSearchParams(q: Partial<OperationListQuery>): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.type) p.set('type', q.type);
  if (q.assetId) p.set('bien', String(q.assetId));
  if (q.state && q.state !== 'ALL') p.set('etat', q.state);
  if (q.sort && q.sort !== 'DATE_DESC') p.set('tri', q.sort);
  if (q.page && q.page > 1) p.set('page', String(q.page));
  if (q.pageSize && q.pageSize !== OPERATION_LIST_PAGE_SIZE) p.set('taille', String(q.pageSize));
  return p.toString();
}

const sansAccent = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Texte de recherche d'une ligne (pur) : tout ce que la ligne nomme. */
export function operationListHaystack(i: OperationListItem, extra: readonly string[] = []): string {
  return sansAccent([
    i.title, i.typeLabel ?? OPERATION_LIST_LABELS.noType, i.provider ?? '', ...i.assets.map((a) => a.name), ...i.rooms, ...i.equipments,
    ...i.suppliers, ...i.contracts.map((c) => c.label), ...extra,
  ].join(' \u0001 '));
}

/** Tous les mots saisis figurent dans la ligne (pur ; sans accent ni casse). Recherche vide : vrai. */
export function operationListMatches(haystack: string, q: string): boolean {
  const mots = sansAccent(q).split(/\s+/).filter((m) => m.length > 0);
  return mots.every((m) => haystack.includes(m));
}

/**
 * Ordre de la liste (pur, total et stable : l'identifiant départage toujours).
 * Par date : les opérations SANS date sont en fin de liste dans les deux sens
 * (aucune date n'est inventée pour les classer). Par montant : celles sans
 * montant connu en fin de liste.
 */
export function compareOperationListItems(sort: OperationListSort): (a: OperationListItem, b: OperationListItem) => number {
  const parId = (a: OperationListItem, b: OperationListItem) => b.id - a.id;
  const nulEnFin = <T>(x: T | null, y: T | null, cmp: (p: T, q: T) => number): number =>
    (x === null ? (y === null ? 0 : 1) : y === null ? -1 : cmp(x, y));
  switch (sort) {
    case 'DATE_ASC': return (a, b) => nulEnFin(a.date, b.date, (p, q) => p.localeCompare(q)) || parId(a, b);
    case 'TITLE': return (a, b) => sansAccent(a.title).localeCompare(sansAccent(b.title), 'fr') || parId(a, b);
    case 'AMOUNT_DESC': return (a, b) => nulEnFin(a.netCents, b.netCents, (p, q) => q - p) || parId(a, b);
    default: return (a, b) => nulEnFin(a.date, b.date, (p, q) => q.localeCompare(p)) || parId(a, b);
  }
}

/** Découpe en pages (pur) : la page demandée au-delà de la dernière est ramenée à la dernière. */
export function paginateOperationList<T>(items: readonly T[], page: number, pageSize: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  return { items: items.slice((p - 1) * pageSize, p * pageSize), page: p, pages };
}
