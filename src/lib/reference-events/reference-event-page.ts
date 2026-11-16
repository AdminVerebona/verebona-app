/**
 * Carte #744, travaux D (« Fiche et parcours », CDC « Opérations / Agenda
 * V2.0 » §14, §15 ; AC01, AC22, AC41, AC56) — PAGE ENTIÈRE de l'événement de
 * référence : adresse, textes et règles d'affichage. PUR (aucune dépendance
 * serveur) : partagé par la page, la recherche, les liens et les tests.
 *
 * Adresse stable : `/agenda/evenements-reference/<identifiant>`. La page vit
 * SOUS l'Agenda (aucune entrée de menu, aucune rubrique nouvelle : la carte
 * l'interdit) ; elle hérite ainsi de la protection de session des pages de
 * l'Agenda. Un ancien identifiant regroupé est redirigé vers l'identifiant
 * courant par la page elle-même.
 *
 * Le mot « Opération » n'apparaît jamais ; aucun état (« envisagé »,
 * « réalisé », « annulé ») n'est affiché : les dates sont QUALIFIÉES par leur
 * rôle, sans comparaison avec la date du jour. Aucune date n'est inventée :
 * sans date propre, la page dit « Sans date ».
 *
 * Textes nouveaux : « à valider par le PO » (fiche de recette 114O,
 * section « Travaux D »).
 */

/** Racine des pages d'événement de référence (sous l'Agenda). */
export const REFERENCE_EVENT_ROUTE = '/agenda/evenements-reference';

/** Adresse stable de la page d'un événement de référence. */
export function referenceEventHref(id: number): string {
  return `${REFERENCE_EVENT_ROUTE}/${id}`;
}

/** Identifiant porté par une adresse de page (null : adresse invalide). */
export function referenceEventIdFromParam(v: unknown): number | null {
  const s = typeof v === 'string' ? v : '';
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Catégorie des résultats de recherche (décision PO n° 1 : la catégorie porte ce nom). */
export const REFERENCE_EVENT_SEARCH_CATEGORY = 'Événement de référence' as const;

/** Rôles des dates PROPRES d'un événement de référence, dans l'ordre d'affichage. */
export const REFERENCE_EVENT_DATE_ROLES = ['PLANNED', 'START', 'REALIZED', 'END'] as const;
export type ReferenceEventDateRole = (typeof REFERENCE_EVENT_DATE_ROLES)[number];

/** Textes de la page (à valider par le PO, sauf mention « existant »). */
export const REFERENCE_EVENT_PAGE_LABELS = {
  /** Existant (tiroir de l'Agenda, Timeline) : aucune date propre. */
  undated: 'Sans date',
  back: 'Retour',
  backToAgenda: 'Ouvrir l’agenda',
  datesTitle: 'Dates',
  dateRoles: { PLANNED: 'Prévu le', START: 'Début', REALIZED: 'Réalisé le', END: 'Fin' } as Readonly<Record<ReferenceEventDateRole, string>>,
  providerTitle: 'Prestataire',
  declarationsTitle: 'Votre déclaration',
  declaredOn: 'Déclaré le',
  assetsTitle: 'Biens',
  equipmentsTitle: 'Équipements',
  suppliersTitle: 'Fournisseurs',
  /** Existant (vocabulaire de l'Agenda). */
  eventsTitle: 'Événements',
  relationsTitle: 'Événements de référence associés',
  empty: 'Aucun bien, aucun document ni aucun événement n’est encore relié à cet événement de référence.',
  notFound: 'Cet événement de référence est introuvable dans votre compte.',
  notFoundHint: 'Il a peut-être été regroupé ou supprimé, ou il appartient à un autre compte.',
  /** Existants (fiche fournisseur). */
  loadError: 'La fiche n’a pas pu être chargée.',
  loadErrorHint: 'Vérifiez votre connexion puis réessayez.',
  retry: 'Réessayer',
  shared: 'Partagé avec un autre événement de référence',
} as const;

/** Nature et sens d'une relation, tels que la page les nomme (à valider par le PO). */
export type ReferenceEventRelationNature = 'FINANCING' | 'CLAIM_REPAIR' | 'ASSOCIATED' | 'CLAIM_CONTRACT';
export type ReferenceEventRelationDirection = 'OUTGOING' | 'INCOMING' | 'UNDIRECTED';

const RELATION_LABELS: Readonly<Record<ReferenceEventRelationNature, Readonly<Record<ReferenceEventRelationDirection, string>>>> = {
  FINANCING: { OUTGOING: 'Finance', INCOMING: 'Financé par', UNDIRECTED: 'Associé à' },
  CLAIM_REPAIR: { OUTGOING: 'Réparé par', INCOMING: 'Répare le sinistre', UNDIRECTED: 'Associé à' },
  ASSOCIATED: { OUTGOING: 'Associé à', INCOMING: 'Associé à', UNDIRECTED: 'Associé à' },
  CLAIM_CONTRACT: { OUTGOING: 'Contrat d’assurance', INCOMING: 'Sinistre déclaré', UNDIRECTED: 'Associé à' },
};

/** « Financé par », « Finance », « Associé à »… — lu dans les deux sens à partir de la même relation. */
export function referenceEventRelationLabel(nature: ReferenceEventRelationNature, direction: ReferenceEventRelationDirection): string {
  return RELATION_LABELS[nature][direction];
}

/** `AAAA-MM-JJ` → `JJ/MM/AAAA` ; toute autre valeur : null (jamais une date fabriquée). */
export function referenceEventDay(d: string | null | undefined): string | null {
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null;
}

/** Longueur maximale du complément du titre (même borne que la règle existante `referenceEventLabel`). */
export const REFERENCE_EVENT_TITLE_MAX = 80;

/**
 * TITRE de la page et du résultat de recherche (pur).
 *
 * `baseLabel` est le libellé de la règle EXISTANTE (`referenceEventLabel` :
 * « type — intitulé », sinon titre du premier justificatif, sinon
 * prestataire) et `hasComplement` dit si ce libellé porte déjà un complément.
 * Quand il n'en porte pas (le type seul), on complète :
 *   1. par le nom du bien — décision PO n° 2 (« si aucun titre n'est proposé,
 *      on affiche le type + le bien ») ; plusieurs biens : le premier, par nom ;
 *   2. à défaut de bien, par le début de la déclaration de l'utilisateur
 *      (événement de référence fondé sur une déclaration, sans rien d'autre).
 * Sans type ET avec une déclaration seule : la déclaration est le titre (on
 * n'affiche pas « Dépense » pour une déclaration non qualifiée).
 */
export function referenceEventPageTitle(o: {
  baseLabel: string; hasComplement: boolean; typeCode: string | null; assetNames: readonly string[]; declaration: string | null;
}): string {
  if (o.hasComplement) return o.baseLabel;
  const court = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, REFERENCE_EVENT_TITLE_MAX);
  const bien = o.assetNames.map((n) => n.trim()).find((n) => n.length > 0);
  if (bien) return `${o.baseLabel} — ${court(bien)}`;
  const decl = o.declaration ? court(o.declaration) : '';
  if (decl) return o.typeCode ? `${o.baseLabel} — ${decl}` : decl;
  return o.baseLabel;
}
