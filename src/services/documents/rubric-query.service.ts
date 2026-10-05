/**
 * Consultation documentaire par Rubrique — CDC V2.0 §4.1 à §4.6, §6.2, §16.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CONTRAT POUR DEUX ÉCRANS
 *
 * Le §4.1 impose que « Mes documents » et l'onglet « Documents » d'un bien
 * partagent « les mêmes composants, états, règles de rendu et contrats de
 * données. Seul le contexte change ».
 *
 * La page globale est le cas `assetIds: []`, l'onglet d'un bien le cas
 * `assetIds: [42]`. Rien d'autre ne les distingue — pas même la zone « Sans
 * rubrique », qui se restreint d'elle-même aux documents du bien par le jeu
 * du filtre.
 *
 * ── TROIS RÈGLES DE VISIBILITÉ QUI SE CONTREDISENT EN APPARENCE ───────────
 *
 * · §4.4 — « Sans rubrique » DISPARAÎT à 0 ;
 * · §3.3 — les Rubriques métier RESTENT visibles à 0 ;
 * · §6.2 — « Gestion locative » peut disparaître, mais pas pour la même
 *   raison : sa visibilité dépend d'un état métier, pas d'un compteur.
 *
 * Elles ne se contredisent pas : « Sans rubrique » n'est pas une Rubrique
 * (§2.1), c'est une zone temporaire. Une Rubrique vide dit « rien ici pour
 * l'instant » ; une zone « Sans rubrique » vide ne dirait rien du tout.
 *
 * ── LES COMPTEURS VIENNENT D'ICI, PAS DU TABLEAU RENDU ────────────────────
 *
 * §4.6 et §16.3 : le compteur porte sur l'ensemble filtré, pas sur l'aperçu
 * affiché. Le calculer à partir de `documents.length` le plafonnerait à la
 * taille de la page, et une Rubrique de 40 documents en annoncerait 6.
 *
 * ── CHARGEMENT PROGRESSIF (DOC-PERF) ──────────────────────────────────────
 *
 * Le périmètre n'est plus transmis d'un bloc (`pageSize=all`, 2 000
 * documents au plus) : tri et filtres sont appliqués ici, sur tout le
 * périmètre, puis la liste est découpée en lots par curseur (voir
 * `document-cursor.ts`). Les compteurs accompagnent le premier lot.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles, assetTypes, assets } from '@/db/schema';
import { isRentedFromCharacteristics } from '@/lib/assets/occupancy';
import {
  ASSET_FAMILIES,
  getDocumentType,
  getVisibleRubrics,
  type AssetFamily,
} from '@/lib/referential/v2';
import { RUBRICS } from '@/lib/referential/v2/rubrics';
import { rubricsForPage } from '@/lib/documents/rubric-page';
import {
  FEED_NO_ASSET,
  FEED_NO_TYPE,
  FEED_UNFILED,
  type FeedDocument,
  type FeedFacet,
  type FeedFilters,
  type FeedMeta,
  type FeedParams,
  type FeedResponse,
} from '@/lib/documents/document-feed';
import {
  UNFILED_RANK,
  UNKNOWN_RUBRIC_RANK,
  decodeFeedCursor,
  encodeFeedCursor,
  keyComponents,
  keysetCondition,
  orderSignature,
  type FeedKey,
  type KeysetNode,
} from './document-cursor';

/** Identifiant de la zone « Sans rubrique ». Jamais un code de Rubrique (§2.1). */
export const UNFILED_GROUP = FEED_UNFILED;

/** Document d'un lot (contrat partagé avec l'écran). */
export type RubricDocumentView = FeedDocument;

/** Curseur illisible ou d'un autre tri : la route répond 400, sans deviner. */
export class InvalidCursorError extends Error {
  constructor() {
    super('INVALID_CURSOR');
    this.name = 'InvalidCursorError';
  }
}

export interface DocumentFeedQuery extends Omit<FeedParams, 'cursor'> {
  accountId: number;
  cursor?: string | null;
  /** Compteurs et options de filtre : par défaut avec le premier lot seulement. */
  withMeta?: boolean;
}

// ── Expressions SQL des composantes d'ordre ──────────────────────────────

/**
 * Rang de Rubrique en SQL — même règle que `rubricRank` (document-cursor).
 * Littéraux et non paramètres : les codes viennent du référentiel versionné,
 * et un paramètre non typé dans un CASE ferait échouer l'inférence de type.
 */
const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;
const RUBRIC_RANK_SQL = sql.raw(
  `(CASE WHEN "asset_files"."rubric_code" IS NULL THEN ${UNFILED_RANK} `
  + RUBRICS.map((r, i) => `WHEN "asset_files"."rubric_code" = ${literal(r.code)} THEN ${i} `).join('')
  + `ELSE ${UNKNOWN_RUBRIC_RANK} END)`,
);

/** Le titre trié est celui affiché (repli compris), sans tenir compte de la casse. */
const TITLE_SQL = sql`lower(COALESCE(${assetFiles.retainedTitle}, ${assetFiles.originalFilename}, ${assetFiles.filename}, 'Document'))`;

const KEY_SQL: Record<FeedKey, { expr: SQL; cast: string }> = {
  rubricRank: { expr: RUBRIC_RANK_SQL, cast: 'int' },
  rubricCode: { expr: sql`COALESCE(${assetFiles.rubricCode}, '')`, cast: 'text' },
  uploadedAt: { expr: sql`${assetFiles.uploadedAt}`, cast: 'timestamptz' },
  documentDate: { expr: sql`${assetFiles.documentDate}`, cast: 'date' },
  title: { expr: TITLE_SQL, cast: 'text' },
  assetName: { expr: sql`lower(${assets.name})`, cast: 'text' },
  id: { expr: sql`${assetFiles.id}`, cast: 'int' },
};

/** Traduit l'arbre de condition du curseur en SQL (valeurs liées, typées). */
function keysetSql(node: KeysetNode, keys: FeedKey[], values: Array<string | null>): SQL {
  switch (node.op) {
    case 'false': return sql`FALSE`;
    case 'and': return sql`(${sql.join(node.items.map((n) => keysetSql(n, keys, values)), sql` AND `)})`;
    case 'or': return sql`(${sql.join(node.items.map((n) => keysetSql(n, keys, values)), sql` OR `)})`;
    case 'isNull': return sql`${KEY_SQL[keys[node.index]].expr} IS NULL`;
    case 'cmp': {
      const { expr, cast } = KEY_SQL[keys[node.index]];
      return sql`${expr} ${sql.raw(node.cmp)} ${values[node.index]}::${sql.raw(cast)}`;
    }
  }
}

// ── Périmètre et filtres ─────────────────────────────────────────────────

/** Périmètre : compte courant, non supprimé, biens de l'onglet, résultats de recherche. */
function scopeConditions(query: { accountId: number; assetIds: number[]; ids: number[] | null }): SQL[] {
  const scope = [eq(assetFiles.accountId, query.accountId), isNull(assetFiles.deletedAt)];
  if (query.assetIds.length > 0) {
    scope.push(
      or(
        inArray(assetFiles.assetId, query.assetIds),
        inArray(assetFiles.linkedAssetId, query.assetIds),
      )!,
    );
  }
  if (query.ids) scope.push(inArray(assetFiles.id, query.ids));
  return scope;
}

/** Une dimension : OU entre ses valeurs, la valeur spéciale désignant l'absence. */
function dimension(values: string[], absent: string, column: SQL, nullColumn: SQL, toValue: (v: string) => unknown): SQL | null {
  if (values.length === 0) return null;
  const present = values.filter((v) => v !== absent).map(toValue);
  const parts: SQL[] = [];
  if (present.length) parts.push(sql`${column} IN (${sql.join(present.map((v) => sql`${v}`), sql`, `)})`);
  if (values.includes(absent)) parts.push(sql`${nullColumn} IS NULL`);
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` OR `)})`;
}

/** Filtres combinés : ET entre dimensions, OU à l'intérieur — comme l'écran. */
function filterConditions(f: FeedFilters): SQL[] {
  return [
    dimension(f.biens, FEED_NO_ASSET, sql`${assetFiles.assetId}`, sql`${assetFiles.assetId}`, Number),
    dimension(f.rubrics, FEED_UNFILED, sql`${assetFiles.rubricCode}`, sql`${assetFiles.rubricCode}`, String),
    dimension(f.types, FEED_NO_TYPE, sql`${assetFiles.documentTypeCode}`, sql`${assetFiles.documentTypeCode}`, String),
  ].filter((c): c is SQL => c !== null);
}

/** Même règle que `filterConditions`, sur une ligne agrégée (compteurs). */
export function matchesFilters(
  row: { assetId: number | null; rubricCode: string | null; documentTypeCode: string | null },
  f: FeedFilters,
): boolean {
  const bien = row.assetId ? String(row.assetId) : FEED_NO_ASSET;
  const rubric = row.rubricCode ?? FEED_UNFILED;
  const type = row.documentTypeCode ?? FEED_NO_TYPE;
  return (f.biens.length === 0 || f.biens.includes(bien))
    && (f.rubrics.length === 0 || f.rubrics.includes(rubric))
    && (f.types.length === 0 || f.types.includes(type));
}

// ── Compteurs ────────────────────────────────────────────────────────────

export interface ScopeCountRow {
  assetId: number | null;
  assetName: string | null;
  rubricCode: string | null;
  documentTypeCode: string | null;
  count: number;
}

/**
 * Compteurs globaux à partir d'une seule agrégation du périmètre.
 *
 * Les trois filtres portent sur des colonnes de la clé d'agrégation (bien,
 * Rubrique, Type) : l'ensemble filtré se déduit donc des mêmes lignes, sans
 * seconde requête, et ne peut pas diverger des options proposées. Fonction
 * pure et exportée, testée sans base.
 */
export function buildFeedMeta(
  rows: readonly ScopeCountRow[],
  filters: FeedFilters,
  context: { families: AssetFamily[]; hasRentedAsset: boolean },
): FeedMeta {
  const scopeByRubric = new Map<string, number>();
  const filteredByRubric = new Map<string, number>();
  const biens = new Map<string, FeedFacet>();
  const types = new Map<string, FeedFacet>();
  let scopeTotal = 0;
  let total = 0;
  for (const row of rows) {
    const rubric = row.rubricCode ?? FEED_UNFILED;
    scopeTotal += row.count;
    scopeByRubric.set(rubric, (scopeByRubric.get(rubric) ?? 0) + row.count);
    if (matchesFilters(row, filters)) {
      total += row.count;
      filteredByRubric.set(rubric, (filteredByRubric.get(rubric) ?? 0) + row.count);
    }
    const bien = row.assetId ? String(row.assetId) : FEED_NO_ASSET;
    const b = biens.get(bien) ?? { value: bien, label: row.assetId ? row.assetName : null, count: 0 };
    b.count += row.count;
    biens.set(bien, b);
    const type = row.documentTypeCode ?? FEED_NO_TYPE;
    const t = types.get(type) ?? { value: type, label: getDocumentType(row.documentTypeCode)?.label ?? null, count: 0 };
    t.count += row.count;
    types.set(type, t);
  }

  const visibleRubrics = getVisibleRubrics({
    families: context.families,
    hasRentedAsset: context.hasRentedAsset,
    // Un historique locatif reste consultable même si plus aucun bien n'est
    // loué (§6.2, RENT-03) : le compteur suffit à le prouver.
    hasRentalDocuments: (scopeByRubric.get('RENTAL_MANAGEMENT') ?? 0) > 0,
  });
  // Toute Rubrique contenant un document est rendue, même hors du périmètre de
  // visibilité — sinon ses documents seraient comptés mais inatteignables.
  const pageRubrics = rubricsForPage(visibleRubrics, scopeByRubric, true);

  return {
    total,
    scopeTotal,
    rubrics: pageRubrics.map((r) => ({
      code: r.code,
      label: r.label,
      count: filteredByRubric.get(r.code) ?? 0,
      scopeCount: scopeByRubric.get(r.code) ?? 0,
    })),
    unfiledCount: filteredByRubric.get(FEED_UNFILED) ?? 0,
    facets: {
      biens: [...biens.values()],
      rubrics: [...scopeByRubric.entries()].map(([value, count]) => ({ value, label: null, count })),
      types: [...types.values()],
    },
  };
}

// ── Lot ──────────────────────────────────────────────────────────────────

/**
 * Un lot de documents, trié et filtré sur TOUT le périmètre, puis découpé.
 *
 * `limit + 1` lignes sont lues : la ligne en trop dit s'il reste une suite,
 * sans requête de comptage. Le curseur suivant est construit à partir des
 * valeurs de tri du dernier document rendu, lues en base sous forme de texte
 * (`::text`) — une date convertie en `Date` JavaScript perdrait ses
 * microsecondes, et deux documents ajoutés dans la même milliseconde
 * sortiraient de la pagination.
 */
export async function getDocumentFeed(query: DocumentFeedQuery): Promise<FeedResponse> {
  const components = keyComponents(query.sort, query.direction, query.grouped);
  const keys = components.map((c) => c.key);
  const signature = orderSignature(query.sort, query.direction, query.grouped);
  const values = query.cursor ? decodeFeedCursor(query.cursor, signature, components.length) : null;
  if (query.cursor && !values) throw new InvalidCursorError();
  const withMeta = query.withMeta ?? !query.cursor;

  // `?resultats=aucun` : périmètre vide, inutile d'interroger la base.
  if (query.ids && query.ids.length === 0) {
    return {
      documents: [],
      nextCursor: null,
      hasMore: false,
      limit: query.limit,
      ...(withMeta ? { meta: buildFeedMeta([], query.filters, await loadVisibilityContext(query.accountId, query.assetIds)) } : {}),
    };
  }

  const scope = scopeConditions(query);
  const where = [...scope, ...filterConditions(query.filters)];
  if (values) where.push(keysetSql(keysetCondition(components, values), keys, values));

  const keyColumns = Object.fromEntries(
    keys.map((k, i) => [`k${i}`, sql<string | null>`(${KEY_SQL[k].expr})::text`]),
  ) as Record<string, SQL<string | null>>;

  const [rows, meta] = await Promise.all([
    db
      .select({
        id: assetFiles.id,
        publicId: assetFiles.publicId,
        rubricCode: assetFiles.rubricCode,
        title: assetFiles.retainedTitle,
        filename: assetFiles.originalFilename,
        fallback: assetFiles.filename,
        documentTypeCode: assetFiles.documentTypeCode,
        documentDate: assetFiles.documentDate,
        uploadedAt: assetFiles.uploadedAt,
        mimeType: assetFiles.mimeType,
        assetId: assetFiles.assetId,
        assetName: assets.name,
        ...keyColumns,
      })
      .from(assetFiles)
      .leftJoin(assets, eq(assetFiles.assetId, assets.id))
      .where(and(...where))
      .orderBy(...components.map((c) => sql`${KEY_SQL[c.key].expr} ${sql.raw(c.dir === 'asc' ? 'ASC' : 'DESC')} NULLS LAST`))
      .limit(query.limit + 1),
    withMeta ? loadMeta(query, scope) : Promise.resolve(undefined),
  ]);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1] as Record<string, unknown> | undefined;
  const nextCursor = hasMore && last
    ? encodeFeedCursor(signature, keys.map((_, i) => (last[`k${i}`] as string | null) ?? null))
    : null;

  const documents: RubricDocumentView[] = page.map((row) => {
    const type = getDocumentType(row.documentTypeCode);
    return {
      id: row.id,
      publicId: row.publicId,
      // §4.3 : jamais le nom de fichier comme titre principal, mais un repli
      // vaut mieux qu'une carte anonyme.
      title: row.title ?? row.filename ?? row.fallback ?? 'Document',
      originalFilename: row.filename ?? row.fallback ?? null,
      assetId: row.assetId ?? null,
      rubricCode: row.rubricCode ?? null,
      documentTypeCode: row.documentTypeCode,
      documentTypeLabel: type?.label ?? null,
      documentDate: row.documentDate ?? null,
      uploadedAt: row.uploadedAt instanceof Date
        ? row.uploadedAt.toISOString()
        : (row.uploadedAt ?? null),
      mimeType: row.mimeType,
      assetNames: row.assetName ? [row.assetName] : [],
    };
  });

  return { documents, nextCursor, hasMore, limit: query.limit, ...(meta ? { meta } : {}) };
}

/** Compteurs du premier lot : une agrégation du périmètre, agrégée en base (§16.3). */
async function loadMeta(query: DocumentFeedQuery, scope: SQL[]): Promise<FeedMeta> {
  const [rows, context] = await Promise.all([
    db
      .select({
        assetId: assetFiles.assetId,
        assetName: assets.name,
        rubricCode: assetFiles.rubricCode,
        documentTypeCode: assetFiles.documentTypeCode,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(assetFiles)
      .leftJoin(assets, eq(assetFiles.assetId, assets.id))
      .where(and(...scope))
      .groupBy(assetFiles.assetId, assets.name, assetFiles.rubricCode, assetFiles.documentTypeCode),
    loadVisibilityContext(query.accountId, query.assetIds),
  ]);
  return buildFeedMeta(rows.map((r) => ({ ...r, count: Number(r.count) })), query.filters, context);
}

/**
 * Familles présentes et état locatif du périmètre.
 *
 * Sans bien, toutes les familles sont retenues : le §3.3 prévoit qu'on affiche
 * alors « les Rubriques du référentiel de base » plutôt qu'un écran vide.
 */
async function loadVisibilityContext(
  accountId: number,
  assetIds: number[],
): Promise<{ families: AssetFamily[]; hasRentedAsset: boolean }> {
  const scope = [eq(assets.accountId, accountId), isNull(assets.deletedAt)];
  if (assetIds.length > 0) scope.push(inArray(assets.id, assetIds));

  const rows = await db
    .select({ code: assetTypes.code, keyCharacteristics: assets.keyCharacteristics })
    .from(assets)
    .leftJoin(assetTypes, eq(assets.assetTypeId, assetTypes.id))
    .where(and(...scope));

  const families = rows
    .map((r) => r.code)
    .filter((c): c is AssetFamily => !!c && (ASSET_FAMILIES as readonly string[]).includes(c));

  return {
    families: families.length > 0 ? [...new Set(families)] : [...ASSET_FAMILIES],
    // « Mis en location » se lit sur l'usage du bien — seule donnée qui le dit.
    hasRentedAsset: rows.some((r) => isRentedFromCharacteristics(r.keyCharacteristics)),
  };
}
