/**
 * Lot 109B — paramètres centralisés de la fiche fournisseur unique et de la
 * liste `/fournisseurs`. Aucune autre valeur en dur ailleurs.
 *
 * Pagination : les sections de la fiche (documents, biens, équipements) et la
 * liste générale sont paginées avec un TOTAL EXACT calculé sur le même
 * périmètre que les lignes ; aucune troncature silencieuse. Les tailles
 * ci-dessous ne bornent qu'une page, jamais l'accès à la totalité.
 */

/** Lignes chargées par page dans une section de la fiche. */
export const SUPPLIER_SECTION_PAGE_SIZE = 25;
/** Taille maximale d'une page demandée à l'API d'une section. */
export const SUPPLIER_SECTION_PAGE_MAX = 100;

/** Fournisseurs chargés par page dans la liste (avec ou sans recherche). */
export const SUPPLIER_LIST_PAGE_SIZE = 50;
/** Taille maximale d'une page demandée à `GET /api/suppliers`. */
export const SUPPLIER_LIST_PAGE_MAX = 100;
/** Longueur maximale d'une recherche (au-delà : tronquée). */
export const SUPPLIER_SEARCH_MAX_LENGTH = 120;

/** Sections paginées de la fiche. */
export const SUPPLIER_SECTIONS = ['documents', 'assets', 'equipments'] as const;
export type SupplierSection = (typeof SUPPLIER_SECTIONS)[number];

export function isSupplierSection(v: unknown): v is SupplierSection {
  return typeof v === 'string' && (SUPPLIER_SECTIONS as readonly string[]).includes(v);
}

/**
 * Lot 113Y (#721) — rubrique « Documents » UNIQUE de la fiche : documents liés
 * directement au fournisseur ∪ documents d'un événement de référence auquel il
 * est EFFECTIVEMENT et PERTINEMMENT associé. Rôles du fournisseur dans
 * l'événement (`business_operation_suppliers.role`, lien ACTIF) qui ouvrent ce
 * second chemin :
 *   · PROVIDER    prestataire de l'événement (preuve documentaire T3 ou choix
 *                 de l'utilisateur) ;
 *   · INTERVENER  intervenant posé par l'utilisateur.
 * Jamais : DOCUMENT_ISSUER (émetteur d'UNE pièce de l'événement, qui n'en
 * devient pas le prestataire : il ne voit que ses propres documents, par le
 * lien direct) ni BRAND (marque). Un document attribué directement à un AUTRE
 * fournisseur n'est jamais montré par ce chemin.
 */
export const SUPPLIER_VIA_EVENT_ROLES = ['PROVIDER', 'INTERVENER'] as const;

/**
 * Contexte discret d'un document visible SEULEMENT par un événement de
 * référence (pure) : « Via Achat — Maison », « Via Achat — Maison et 1 autre
 * événement ». `null` quand aucun titre lisible n'existe (rien d'inventé) ou
 * pour un document lié directement (sa preuve propre prime).
 */
export function supplierViaEventContext(titles: readonly string[] | null | undefined, eventCount: number | null | undefined): string | null {
  const t = [...new Set((titles ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  if (t.length === 0) return null;
  const n = Math.max(t.length, Number.isSafeInteger(eventCount) ? Number(eventCount) : 0);
  const autres = n - 1;
  if (autres <= 0) return `Via ${t[0]}`;
  return `Via ${t[0]} et ${autres} autre${autres > 1 ? 's' : ''} événement${autres > 1 ? 's' : ''}`;
}

/** Tris de la liste générale. */
export const SUPPLIER_LIST_SORTS = ['name_asc', 'name_desc', 'recent'] as const;
export type SupplierListSort = (typeof SUPPLIER_LIST_SORTS)[number];
export const SUPPLIER_LIST_SORT_LABELS: Record<SupplierListSort, string> = {
  name_asc: 'Nom (A → Z)',
  name_desc: 'Nom (Z → A)',
  recent: 'Ajoutés récemment',
};

/** Statuts consultables dans la liste (un fournisseur supprimé n'est jamais listé). */
export const SUPPLIER_LIST_STATUSES = ['active', 'archived'] as const;
export type SupplierListStatus = (typeof SUPPLIER_LIST_STATUSES)[number];

/** Libellés des champs de coordonnées (conflits, édition) — jamais la clé technique. */
export const SUPPLIER_FIELD_LABELS: Record<string, string> = {
  name: 'Nom',
  email: 'E-mail',
  phone: 'Téléphone',
  website: 'Site web',
  addressLine1: 'Adresse',
  addressLine2: 'Complément d’adresse',
  postalCode: 'Code postal',
  city: 'Ville',
  country: 'Pays',
  siren: 'SIREN',
  siret: 'SIRET',
  vatNumber: 'N° de TVA',
  iban: 'IBAN',
  ibanHolderName: 'Titulaire du compte',
};

/**
 * Champs dont un conflit peut être tranché par « Utiliser » (valeur relevée
 * appliquée). L'IBAN en est EXCLU (règle existante de
 * `/api/to-process/suppliers/[id]/resolve`) : une nouvelle valeur bancaire
 * n'est jamais appliquée d'un clic ; l'utilisateur la vérifie sur le
 * document source puis la saisit lui-même.
 */
export const SUPPLIER_CONFLICT_APPLICABLE_FIELDS: Record<string, string> = {
  email: 'email', phone: 'phone', website: 'website',
  addressLine1: 'address_line_1', addressLine2: 'address_line_2',
  postalCode: 'postal_code', city: 'city', country: 'country',
  siren: 'siren', siret: 'siret', vatNumber: 'vat_number',
  ibanHolderName: 'iban_holder_name',
};

/**
 * IBAN masqué : 4 premiers caractères (pays + clé) et 4 derniers, le reste
 * remplacé. Jamais l'IBAN complet dans une liste, une fiche ou un conflit.
 */
export function maskIban(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = String(value).replace(/\s+/g, '').toUpperCase();
  if (!v) return null;
  if (v.length <= 8) return '•••• ' + v.slice(-2);
  return `${v.slice(0, 4)} •••• •••• ${v.slice(-4)}`;
}

/** Adresse de la liste pour ses critères (pure) : rien d'inutile dans l'URL. */
export function suppliersListPath(q: string, statut: SupplierListStatus, tri: SupplierListSort): string {
  const p = new URLSearchParams();
  if (q.trim()) p.set('q', q.trim());
  if (statut !== 'active') p.set('statut', statut);
  if (tri !== 'name_asc') p.set('tri', tri);
  const s = p.toString();
  return `/fournisseurs${s ? `?${s}` : ''}`;
}
