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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles, assetTypes, assets } from '@/db/schema';
import {
  ASSET_FAMILIES,
  getDocumentType,
  getVisibleRubrics,
  type AssetFamily,
  type RubricDefinition,
} from '@/lib/referential/v2';

/** Identifiant de la zone « Sans rubrique ». Jamais un code de Rubrique (§2.1). */
export const UNFILED_GROUP = '__UNFILED__';

export interface RubricDocumentView {
  /** Identifiant numérique, attendu par la suppression groupée existante. */
  id: number;
  publicId: string;
  title: string;
  documentTypeCode: string | null;
  /** `null` ⇒ la carte affiche « Type à compléter » (§4.3). */
  documentTypeLabel: string | null;
  documentDate: string | null;
  mimeType: string | null;
  assetNames: string[];
}

export interface RubricGroupView {
  code: string;
  label: string;
  count: number;
  documents: RubricDocumentView[];
  hasMore: boolean;
}

/** Types réellement présents dans le périmètre — §4.6, filtre contextuel. */
export interface TypeOption {
  code: string;
  label: string;
}

export interface RubricDocumentsPage {
  groups: RubricGroupView[];
  /** « Le filtre Type ne propose que les Types pertinents dans le contexte. » */
  typeOptions: TypeOption[];
  /** Compteur global, « Sans rubrique » inclus (§4.6). */
  total: number;
  unfiledCount: number;
}

export type DocumentSort = 'uploadedAt' | 'documentDate' | 'title';
export type SortDirection = 'asc' | 'desc';

export interface RubricQuery {
  accountId: number;
  /** Vide = page globale ; un ou plusieurs identifiants = onglet de bien(s). */
  assetIds?: number[];
  typeCodes?: string[];
  pageSize?: number;
  /** §4.6 — un tri unique s'applique à TOUTES les Rubriques. */
  sort?: DocumentSort;
  direction?: SortDirection;
  /**
   * Décalage par code de groupe, pour « Voir les N autres ».
   *
   * Par groupe et non global : chaque Rubrique se déplie indépendamment, et un
   * décalage commun ferait avancer toutes les autres en même temps.
   */
  offsets?: Record<string, number>;
}

/**
 * Tri appliqué en base — §4.6.
 *
 * Le défaut est « date d'ajout décroissante, document le plus récent en
 * premier ». Les documents sans date de document passent en dernier quand on
 * trie par cette date : les remonter en tête ferait croire à une donnée
 * récente là où il n'y a pas de donnée du tout.
 */
function orderClause(sort: DocumentSort, direction: SortDirection) {
  const column =
    sort === 'documentDate' ? assetFiles.documentDate
      : sort === 'title' ? assetFiles.retainedTitle
        : assetFiles.uploadedAt;
  return direction === 'asc'
    ? sql`${column} ASC NULLS LAST`
    : sql`${column} DESC NULLS LAST`;
}

/**
 * Ordonne les groupes — §3.3 et §4.4.
 *
 * Fonction pure et exportée : l'ordre est une règle du CDC, pas une propriété
 * d'affichage, et c'est la première chose qu'une refonte de l'écran casserait
 * sans s'en apercevoir.
 */
export function orderGroups(
  rubricGroups: RubricGroupView[],
  visibleRubrics: readonly RubricDefinition[],
  unfiled: RubricGroupView | null,
): RubricGroupView[] {
  const order = new Map<string, number>(
    visibleRubrics.map((r, index) => [r.code as string, index]),
  );
  const sorted = [...rubricGroups].sort(
    (a, b) => (order.get(a.code) ?? 998) - (order.get(b.code) ?? 998),
  );
  // « Sans rubrique » toujours avant les Rubriques, et seulement s'il contient
  // au moins un document (§4.4). « Autres documents » est déjà dernier par son
  // `displayOrder`, ce qui évite un cas particulier ici.
  return unfiled && unfiled.count > 0 ? [unfiled, ...sorted] : sorted;
}

export async function getDocumentsByRubric(
  query: RubricQuery,
): Promise<RubricDocumentsPage> {
  const pageSize = query.pageSize ?? 6;
  const assetIds = query.assetIds ?? [];

  const scope = [eq(assetFiles.accountId, query.accountId), isNull(assetFiles.deletedAt)];
  if (assetIds.length > 0) {
    scope.push(
      or(
        inArray(assetFiles.assetId, assetIds),
        inArray(assetFiles.linkedAssetId, assetIds),
      )!,
    );
  }
  if (query.typeCodes?.length) {
    scope.push(inArray(assetFiles.documentTypeCode, query.typeCodes));
  }

  const [counts, documents, context] = await Promise.all([
    // Compteurs sur l'ensemble filtré, agrégés en base (§16.3).
    db
      .select({
        rubricCode: assetFiles.rubricCode,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(assetFiles)
      .where(and(...scope))
      .groupBy(assetFiles.rubricCode),
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
        mimeType: assetFiles.mimeType,
        assetName: assets.name,
      })
      .from(assetFiles)
      .leftJoin(assets, eq(assetFiles.assetId, assets.id))
      .where(and(...scope))
      // Tri par défaut : date d'ajout décroissante (§4.6).
      .orderBy(orderClause(query.sort ?? 'uploadedAt', query.direction ?? 'desc'))
      .limit(2_000),
    loadVisibilityContext(query.accountId, assetIds),
  ]);

  const countByRubric = new Map(counts.map((c) => [c.rubricCode ?? UNFILED_GROUP, c.count]));
  const unfiledCount = countByRubric.get(UNFILED_GROUP) ?? 0;

  const visibleRubrics = getVisibleRubrics({
    families: context.families,
    hasRentedAsset: context.hasRentedAsset,
    // Un historique locatif reste consultable même si plus aucun bien n'est
    // loué (§6.2, RENT-03) : le compteur suffit à le prouver.
    hasRentalDocuments: (countByRubric.get('RENTAL_MANAGEMENT') ?? 0) > 0,
  });

  const byGroup = new Map<string, RubricDocumentView[]>();
  for (const row of documents) {
    const key = row.rubricCode ?? UNFILED_GROUP;
    const bucket = byGroup.get(key) ?? [];
    const type = getDocumentType(row.documentTypeCode);
    bucket.push({
      id: row.id,
      publicId: row.publicId,
      // §4.3 : jamais le nom de fichier comme titre principal, mais un repli
      // vaut mieux qu'une carte anonyme.
      title: row.title ?? row.filename ?? row.fallback ?? 'Document',
      documentTypeCode: row.documentTypeCode,
      documentTypeLabel: type?.label ?? null,
      documentDate: row.documentDate ?? null,
      mimeType: row.mimeType,
      assetNames: row.assetName ? [row.assetName] : [],
    });
    byGroup.set(key, bucket);
  }

  // §3.3 : les Rubriques métier pertinentes restent listées même à 0.
  const offsets = query.offsets ?? {};
  const take = (code: string, all: RubricDocumentView[], count: number) => {
    // `offset + pageSize` et non une fenêtre glissante : « Voir les N autres »
    // AJOUTE à ce qui est déjà affiché. Une fenêtre remplacerait la page
    // précédente, et l'utilisateur perdrait le document qu'il venait de voir.
    const shown = (offsets[code] ?? 0) + pageSize;
    return { documents: all.slice(0, shown), hasMore: count > shown };
  };

  const rubricGroups: RubricGroupView[] = visibleRubrics.map((rubric) => {
    const all = byGroup.get(rubric.code) ?? [];
    const count = countByRubric.get(rubric.code) ?? 0;
    return { code: rubric.code, label: rubric.label, count, ...take(rubric.code, all, count) };
  });

  const unfiledDocuments = byGroup.get(UNFILED_GROUP) ?? [];
  const unfiled: RubricGroupView = {
    code: UNFILED_GROUP,
    label: 'Sans rubrique',
    count: unfiledCount,
    ...take(UNFILED_GROUP, unfiledDocuments, unfiledCount),
  };

  // §4.6 : seuls les Types réellement présents sont proposés au filtre. Lister
  // les 94 Types du référentiel obligerait à chercher dans une liste dont
  // l'immense majorité ne renverrait aucun document.
  const typeOptions: TypeOption[] = [
    ...new Map(
      documents
        .map((d) => getDocumentType(d.documentTypeCode))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .map((t) => [t.code, { code: t.code, label: t.label }]),
    ).values(),
  ].sort((a, b) => a.label.localeCompare(b.label, 'fr'));

  return {
    groups: orderGroups(rubricGroups, visibleRubrics, unfiled),
    typeOptions,
    total: [...countByRubric.values()].reduce((sum, n) => sum + n, 0),
    unfiledCount,
  };
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
    .select({ code: assetTypes.code, isRented: assets.isRented })
    .from(assets)
    .leftJoin(assetTypes, eq(assets.assetTypeId, assetTypes.id))
    .where(and(...scope));

  const families = rows
    .map((r) => r.code)
    .filter((c): c is AssetFamily => !!c && (ASSET_FAMILIES as readonly string[]).includes(c));

  return {
    families: families.length > 0 ? [...new Set(families)] : [...ASSET_FAMILIES],
    hasRentedAsset: rows.some((r) => r.isRented === true),
  };
}
