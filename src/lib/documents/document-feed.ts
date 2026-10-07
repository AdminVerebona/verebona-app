/**
 * Chargement progressif des documents — contrat partagé entre la route
 * `GET /api/v2/documents`, son service (`rubric-query.service.ts`) et l'écran
 * (`DocumentsByRubric`). Ticket DOC-PERF.
 *
 * Fichier sans dépendance serveur : l'écran l'importe sans embarquer l'accès
 * à la base.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN LOT, PAS UNE PAGE
 *
 * « Mes documents » recevait tout le périmètre (`pageSize=all`, jusqu'à
 * 2 000 documents) puis triait, filtrait et regroupait dans le navigateur.
 * Désormais le serveur trie et filtre l'ENSEMBLE du périmètre, puis découpe
 * en lots de 50 ; l'écran demande le lot suivant à l'approche du bas. Aucun
 * numéro de page : le curseur est opaque, le client se contente de le
 * renvoyer.
 *
 * Les compteurs (total, Rubriques, options de filtre) sont calculés en base
 * sur l'ensemble filtré et transmis avec le PREMIER lot : les déduire des
 * documents déjà chargés les plafonnerait à la taille du lot.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Taille d'un lot (valeur indicative du ticket, ajustable après mesure). */
export const FEED_DEFAULT_LIMIT = 50;
/** Plafond serveur, quoi que demande le client. */
export const FEED_MAX_LIMIT = 100;
/** Valeurs retenues au plus par filtre (biens, Rubriques, Types, résultats). */
export const FEED_MAX_FILTER_VALUES = 100;

/** Zone « Sans rubrique », document sans bien, document sans Type. */
export const FEED_UNFILED = '__UNFILED__';
export const FEED_NO_ASSET = '__NO_ASSET__';
export const FEED_NO_TYPE = '__NO_TYPE__';

export type FeedSort = 'added' | 'docDate' | 'title' | 'bien' | 'rubric';
export type FeedDirection = 'asc' | 'desc';

export interface FeedFilters {
  /** Identifiants de biens (`String(assetId)`) ou `FEED_NO_ASSET`. */
  biens: string[];
  /** Codes de Rubrique ou `FEED_UNFILED`. */
  rubrics: string[];
  /** Codes de Type ou `FEED_NO_TYPE`. */
  types: string[];
}

export interface FeedParams {
  /** Vide = « Mes documents » ; sinon onglet d'un (ou plusieurs) bien(s). */
  assetIds: number[];
  sort: FeedSort;
  direction: FeedDirection;
  /**
   * Regroupement par Rubrique : l'ordre global devient « Rubrique, puis
   * tri choisi ». Sans cette règle, le lot 2 ajouterait des documents dans
   * des sections déjà affichées plus haut, et le contenu sauterait sous les
   * yeux de l'utilisateur.
   */
  grouped: boolean;
  filters: FeedFilters;
  /**
   * Résultats d'une recherche de l'assistant (`?resultats=`) : restreint le
   * PÉRIMÈTRE (compteurs compris). `null` = pas de restriction, `[]` = aucun.
   */
  ids: number[] | null;
  limit: number;
  cursor: string | null;
}

/** Document d'un lot — identique à l'ancienne réponse par Rubrique. */
export interface FeedDocument {
  id: number;
  publicId: string;
  title: string;
  originalFilename: string | null;
  assetId: number | null;
  rubricCode: string | null;
  documentTypeCode: string | null;
  documentTypeLabel: string | null;
  documentDate: string | null;
  uploadedAt: string | null;
  mimeType: string | null;
  assetNames: string[];
  /**
   * Lot 32C (PO 9) : tous les biens du document — principal d'abord, puis
   * les biens liés (PRIMARY / SECONDARY) ; `assetNames` dans le même ordre.
   */
  assetIds?: number[];
}

export interface FeedFacet {
  value: string;
  /** `null` pour un Type inconnu du référentiel (« Type à compléter »). */
  label: string | null;
  count: number;
}

/** Informations globales — transmises avec le premier lot seulement. */
export interface FeedMeta {
  /** Documents correspondant aux filtres actifs (tout le périmètre). */
  total: number;
  /** Documents du périmètre, filtres ignorés (« 4 documents sur 19 »). */
  scopeTotal: number;
  /**
   * Rubriques de la page, dans l'ordre du référentiel. `count` : ensemble
   * filtré ; `scopeCount` : périmètre (ligne « Rubriques sans document »).
   */
  rubrics: Array<{ code: string; label: string; count: number; scopeCount: number }>;
  /** « Sans rubrique », ensemble filtré. */
  unfiledCount: number;
  /** Options de filtre, comptées sur le périmètre (pas sur le résultat filtré). */
  facets: { biens: FeedFacet[]; rubrics: FeedFacet[]; types: FeedFacet[] };
}

export interface FeedResponse {
  documents: FeedDocument[];
  /** `null` en fin de liste : aucun nouvel appel ne doit partir. */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  meta?: FeedMeta;
}

const SORTS: readonly FeedSort[] = ['added', 'docDate', 'title', 'bien', 'rubric'];
/** Anciens noms acceptés, pour ne pas casser un lien ou un client en cache. */
const LEGACY_SORTS: Record<string, FeedSort> = { uploadedAt: 'added', documentDate: 'docDate' };

function list(raw: string | null): string[] {
  return [...new Set((raw ?? '').split(',').map((v) => v.trim()).filter(Boolean))].slice(0, FEED_MAX_FILTER_VALUES);
}

function positiveIds(values: string[]): number[] {
  return values.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
}

/**
 * Lecture défensive des paramètres de la route. Une valeur illisible retombe
 * sur son défaut plutôt que de provoquer une erreur : un lien abîmé doit
 * rendre la liste, pas un écran d'erreur. `pageSize=all` n'existe plus.
 */
export function parseFeedParams(p: URLSearchParams): FeedParams {
  const sortRaw = p.get('sort') ?? '';
  const sort: FeedSort = (SORTS as readonly string[]).includes(sortRaw)
    ? (sortRaw as FeedSort)
    : (LEGACY_SORTS[sortRaw] ?? 'added');
  const limitRaw = Number(p.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1
    ? Math.min(Math.floor(limitRaw), FEED_MAX_LIMIT)
    : FEED_DEFAULT_LIMIT;
  const idsRaw = p.get('ids');
  return {
    assetIds: positiveIds(list(p.get('assets'))),
    sort,
    direction: p.get('direction') === 'asc' ? 'asc' : 'desc',
    grouped: p.get('grouped') === '1',
    filters: {
      biens: list(p.get('biens')).filter((v) => v === FEED_NO_ASSET || positiveIds([v]).length === 1),
      rubrics: list(p.get('rubrics')),
      // `types` : ancien nom du filtre Type, conservé.
      types: list(p.get('types')),
    },
    ids: idsRaw === null ? null : idsRaw === 'none' ? [] : positiveIds(list(idsRaw)),
    limit,
    cursor: p.get('cursor') || null,
  };
}

/**
 * Chaîne de requête d'un lot. Les valeurs sont triées : deux états d'écran
 * équivalents produisent la même clé, donc la même requête.
 */
export function buildFeedQuery(params: Omit<FeedParams, 'cursor' | 'limit'> & { cursor?: string | null; limit?: number }): string {
  const q = new URLSearchParams();
  if (params.assetIds.length) q.set('assets', [...params.assetIds].sort((a, b) => a - b).join(','));
  q.set('sort', params.sort);
  q.set('direction', params.direction);
  if (params.grouped) q.set('grouped', '1');
  const join = (v: string[]) => [...v].sort().join(',');
  if (params.filters.biens.length) q.set('biens', join(params.filters.biens));
  if (params.filters.rubrics.length) q.set('rubrics', join(params.filters.rubrics));
  if (params.filters.types.length) q.set('types', join(params.filters.types));
  if (params.ids) q.set('ids', params.ids.length ? [...params.ids].sort((a, b) => a - b).join(',') : 'none');
  q.set('limit', String(params.limit ?? FEED_DEFAULT_LIMIT));
  if (params.cursor) q.set('cursor', params.cursor);
  return q.toString();
}
