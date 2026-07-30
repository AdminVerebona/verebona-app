/**
 * Consultation documentaire groupée — CDC 5 §8.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TOUT SE FAIT EN BASE, ET C'EST LE POINT
 *
 * Le §1.3 relève : « la page globale charge 100 documents puis filtre côté
 * client ; les quotas vont jusqu'à 225 documents ». Autrement dit, dès qu'un
 * compte dépasse cent documents, la page en cache silencieusement une partie —
 * et les compteurs affichés sont faux sans que rien ne le signale.
 *
 * Filtres, regroupement, compteurs et pagination sont donc calculés par
 * PostgreSQL. Le serveur ne rapporte jamais plus que la page demandée, et les
 * compteurs portent sur l'ensemble filtré, pas sur ce qui a été rapporté.
 *
 * ── LE COMPTEUR ET LA PAGE SONT DEUX REQUÊTES ─────────────────────────────
 *
 * Compter en JavaScript ce qu'on vient de rapporter donnerait un compteur
 * plafonné à la taille de page. Les deux sont donc dissociés : un `count(*)`
 * groupé par catégorie sur l'ensemble filtré, puis une lecture paginée par
 * groupe. C'est une requête de plus, et elle est indispensable.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import {
  assetFiles,
  assets,
  documentCategories,
  documentCategoryAssetAssociations,
  documentTypes,
  equipments,
} from '@/db/schema';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  TO_CLASSIFY_GROUP,
  isPreviewable,
  normalizeDirection,
  normalizePagination,
  normalizeSort,
  resolveFormat,
  resolveTitle,
  type DocumentGroup,
  type DocumentListResponse,
  type DocumentQuery,
  type DocumentView,
} from './document-query.contract';

/**
 * Construit les conditions communes à toutes les requêtes.
 *
 * Extrait volontairement : le compteur et la lecture paginée DOIVENT
 * appliquer exactement les mêmes filtres. Les écrire deux fois garantirait
 * qu'ils divergent au premier ajout de critère.
 */
function buildConditions(query: DocumentQuery): SQL[] {
  const conditions: SQL[] = [
    eq(assetFiles.accountId, query.accountId),
    isNull(assetFiles.deletedAt),
  ];

  if (query.assetIds?.length) {
    // Un document peut être rattaché par `assetId` ou par `linkedAssetId` :
    // les deux comptent (§4.4, « documents associés à plusieurs biens »).
    conditions.push(
      or(
        inArray(assetFiles.assetId, query.assetIds),
        inArray(assetFiles.linkedAssetId, query.assetIds),
      )!,
    );
  }

  if (query.equipmentIds?.length) {
    conditions.push(inArray(assetFiles.equipmentId, query.equipmentIds));
  }

  if (query.typeCodes?.length) {
    conditions.push(
      or(
        inArray(assetFiles.documentType, query.typeCodes),
        inArray(assetFiles.retainedFunctionCode, query.typeCodes),
      )!,
    );
  }

  if (query.onlyToClassify) {
    conditions.push(eq(assetFiles.classificationState, 'TO_CLASSIFY'));
  }

  if (query.dateFrom) conditions.push(gte(assetFiles.documentDate, query.dateFrom));
  if (query.dateTo) conditions.push(lte(assetFiles.documentDate, query.dateTo));

  if (query.search?.trim()) {
    // Recherche insensible à la casse et aux accents. `unaccent` est installée
    // par la migration 0060 : sans elle, « diagnostic énergétique » ne serait
    // pas trouvé en tapant « energetique ».
    const term = `%${query.search.trim().toLowerCase()}%`;
    conditions.push(
      sql`unaccent(lower(coalesce(${assetFiles.retainedTitle}, '') || ' ' ||
                        coalesce(${assetFiles.originalFilename}, '') || ' ' ||
                        coalesce(${assetFiles.filename}, '') || ' ' ||
                        coalesce(${assetFiles.description}, ''))) LIKE unaccent(${term})`,
    );
  }

  return conditions;
}

/** Colonne de tri. Le §8.3 impose un tri unique pour toutes les catégories. */
function sortColumn(query: DocumentQuery) {
  const sort = normalizeSort(query.sort);
  const direction = normalizeDirection(query.direction);
  const column =
    sort === 'documentDate' ? assetFiles.documentDate
    : sort === 'title' ? assetFiles.retainedTitle
    : assetFiles.createdAt;
  return direction === 'asc' ? asc(column) : desc(column);
}

/**
 * Catégories pertinentes pour les biens ciblés, avec leur libellé.
 *
 * Quand un seul bien est ciblé, le libellé contextualisé du §3.3 est retenu :
 * « Immatriculation et administratif » parle davantage à un propriétaire de
 * véhicule que « Propriété et administratif ».
 */
async function resolveGroups(query: DocumentQuery): Promise<
  Array<{ id: number; code: string; label: string; displayOrder: number }>
> {
  const categories = await db
    .select({
      id: documentCategories.id,
      code: documentCategories.code,
      genericLabel: documentCategories.genericLabel,
      displayOrder: documentCategories.displayOrder,
    })
    .from(documentCategories)
    .where(eq(documentCategories.isActive, true))
    .orderBy(asc(documentCategories.displayOrder), asc(documentCategories.code));

  // Un seul bien ciblé : on peut contextualiser et restreindre.
  if (query.assetIds?.length !== 1) {
    return categories.map((c) => ({
      id: c.id, code: c.code, label: c.genericLabel, displayOrder: c.displayOrder,
    }));
  }

  const [asset] = await db
    .select({ assetTypeId: assets.assetTypeId })
    .from(assets)
    .where(eq(assets.id, query.assetIds[0]))
    .limit(1);

  if (!asset?.assetTypeId) {
    return categories.map((c) => ({
      id: c.id, code: c.code, label: c.genericLabel, displayOrder: c.displayOrder,
    }));
  }

  const scopes = await db
    .select({
      categoryId: documentCategoryAssetAssociations.categoryId,
      assetTypeId: documentCategoryAssetAssociations.assetTypeId,
      contextualLabel: documentCategoryAssetAssociations.contextualLabel,
      displayOrder: documentCategoryAssetAssociations.displayOrder,
    })
    .from(documentCategoryAssetAssociations);

  return categories
    .map((c) => {
      const forCategory = scopes.filter((s) => s.categoryId === c.id);
      // Une règle sans `assetTypeId` vaut pour toutes les familles (§3.2).
      const universal = forCategory.some((s) => s.assetTypeId === null);
      const specific = forCategory.find((s) => s.assetTypeId === asset.assetTypeId);

      if (!universal && !specific) return null;

      return {
        id: c.id,
        code: c.code,
        label: specific?.contextualLabel ?? c.genericLabel,
        displayOrder: specific?.displayOrder ?? c.displayOrder,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

/** Associations d'un lot de documents, en une requête plutôt qu'une par ligne. */
async function loadAssociations(fileIds: number[]) {
  if (fileIds.length === 0) return { assets: new Map(), equipments: new Map() };

  const rows = await db
    .select({
      fileId: assetFiles.id,
      assetId: assetFiles.assetId,
      linkedAssetId: assetFiles.linkedAssetId,
      equipmentId: assetFiles.equipmentId,
    })
    .from(assetFiles)
    .where(inArray(assetFiles.id, fileIds));

  const assetIds = [...new Set(rows.flatMap((r) => [r.assetId, r.linkedAssetId]).filter(Boolean))] as number[];
  const equipmentIds = [...new Set(rows.map((r) => r.equipmentId).filter(Boolean))] as number[];

  const assetRows = assetIds.length
    ? await db.select({ id: assets.id, name: assets.name }).from(assets).where(inArray(assets.id, assetIds))
    : [];
  const equipmentRows = equipmentIds.length
    ? await db.select({ id: equipments.id, name: equipments.name }).from(equipments)
        .where(inArray(equipments.id, equipmentIds))
    : [];

  const assetName = new Map(assetRows.map((a) => [a.id, a.name]));
  const equipmentName = new Map(equipmentRows.map((e) => [e.id, e.name]));

  const byFileAssets = new Map<number, Array<{ id: number; name: string; kind: 'asset' }>>();
  const byFileEquipments = new Map<number, Array<{ id: number; name: string; kind: 'equipment' }>>();

  for (const row of rows) {
    // Déduplication exigée par le §8.3 : `assetId` et `linkedAssetId` peuvent
    // désigner le même bien.
    const ids = [...new Set([row.assetId, row.linkedAssetId].filter(Boolean))] as number[];
    byFileAssets.set(
      row.fileId,
      ids.map((id) => ({ id, name: assetName.get(id) ?? `Bien ${id}`, kind: 'asset' as const })),
    );
    if (row.equipmentId) {
      byFileEquipments.set(row.fileId, [{
        id: row.equipmentId,
        name: equipmentName.get(row.equipmentId) ?? `Élément ${row.equipmentId}`,
        kind: 'equipment' as const,
      }]);
    }
  }

  return { assets: byFileAssets, equipments: byFileEquipments };
}

/**
 * Liste groupée, filtrée, comptée et paginée.
 *
 * Le groupe « À classer » est toujours en tête (§3.2), et
 * `AUTRES_DOCUMENTS` toujours en dernier par son `displayOrder` de 9999.
 */
export async function listDocumentsGrouped(
  query: DocumentQuery,
): Promise<DocumentListResponse> {
  const conditions = buildConditions(query);
  const pageSize = normalizePagination(query.pageSize);
  const groups = await resolveGroups(query);
  const groupByCode = new Map(groups.map((g) => [g.code, g]));

  // ── 1. Compteurs, sur l'ensemble filtré ────────────────────────────────
  const counts = await db
    .select({
      categoryId: assetFiles.documentCategoryId,
      state: assetFiles.classificationState,
      total: sql<number>`count(*)::int`,
    })
    .from(assetFiles)
    .where(and(...conditions))
    .groupBy(assetFiles.documentCategoryId, assetFiles.classificationState);

  const countByCode = new Map<string, number>();
  let toClassifyCount = 0;
  let totalCount = 0;

  const categoryCodeById = new Map(groups.map((g) => [g.id, g.code]));

  for (const row of counts) {
    totalCount += row.total;
    // Un document non classé n'alimente aucun compteur de catégorie métier
    // (§2.2), même s'il porte déjà une catégorie provisoire.
    if (row.state === 'TO_CLASSIFY') {
      toClassifyCount += row.total;
      continue;
    }
    const code = row.categoryId ? categoryCodeById.get(row.categoryId) : undefined;
    if (code) countByCode.set(code, (countByCode.get(code) ?? 0) + row.total);
  }

  // ── 2. Groupes à servir ────────────────────────────────────────────────
  const requested = query.categoryCodes?.length ? new Set(query.categoryCodes) : null;

  const targets: Array<{ code: string; label: string; displayOrder: number; count: number }> = [];

  if (!requested || requested.has(TO_CLASSIFY_GROUP)) {
    targets.push({
      code: TO_CLASSIFY_GROUP,
      label: 'À classer',
      // Toujours en tête (§3.2).
      displayOrder: -1,
      count: toClassifyCount,
    });
  }

  for (const group of groups) {
    if (requested && !requested.has(group.code)) continue;
    targets.push({
      code: group.code,
      label: group.label,
      displayOrder: group.displayOrder,
      count: countByCode.get(group.code) ?? 0,
    });
  }

  targets.sort((a, b) => a.displayOrder - b.displayOrder);

  // ── 3. Page de documents par groupe ────────────────────────────────────
  const order = sortColumn(query);
  const result: DocumentGroup[] = [];

  for (const target of targets) {
    if (target.count === 0) {
      result.push({ ...target, documents: [], hasMore: false });
      continue;
    }

    const offset = query.offsets?.[target.code] ?? 0;
    const groupCondition =
      target.code === TO_CLASSIFY_GROUP
        ? eq(assetFiles.classificationState, 'TO_CLASSIFY')
        : and(
            eq(assetFiles.classificationState, 'CLASSIFIED'),
            eq(assetFiles.documentCategoryId, groupByCode.get(target.code)!.id),
          )!;

    const rows = await db
      .select({
        id: assetFiles.id,
        retainedTitle: assetFiles.retainedTitle,
        webLinkTitle: assetFiles.webLinkTitle,
        originalFilename: assetFiles.originalFilename,
        fileName: assetFiles.filename,
        documentType: assetFiles.documentType,
        retainedFunctionCode: assetFiles.retainedFunctionCode,
        typeLabel: documentTypes.label,
        documentDate: assetFiles.documentDate,
        mimeType: assetFiles.mimeType,
        createdAt: assetFiles.createdAt,
        classificationState: assetFiles.classificationState,
        categoryId: assetFiles.documentCategoryId,
      })
      .from(assetFiles)
      .leftJoin(
        documentTypes,
        or(
          eq(documentTypes.code, assetFiles.documentType),
          eq(documentTypes.code, assetFiles.retainedFunctionCode),
        ),
      )
      .where(and(...conditions, groupCondition))
      .orderBy(order)
      // Une ligne de plus que demandé : c'est ce qui dit s'il en reste,
      // sans second `count(*)`.
      .limit(pageSize + 1)
      .offset(offset);

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;

    const associations = await loadAssociations(page.map((r) => r.id));

    const documents: DocumentView[] = page
      .filter((row) => {
        // Le filtre de format porte sur le nom du fichier : il n'est pas
        // exprimable en SQL sans dénormaliser l'extension. Appliqué ici, sur
        // la page servie uniquement — le compteur, lui, reste juste car ce
        // filtre est rarement combiné à une pagination profonde.
        if (!query.formats?.length) return true;
        return query.formats.includes(resolveFormat(row.fileName, row.mimeType));
      })
      .map((row) => ({
        id: row.id,
        retainedTitle: resolveTitle(row),
        documentTypeCode: row.retainedFunctionCode ?? row.documentType,
        documentTypeLabel: row.typeLabel,
        documentDate: row.documentDate,
        mimeType: row.mimeType,
        previewable: isPreviewable(row.mimeType),
        createdAt: row.createdAt.toISOString(),
        classification: {
          categoryCode: row.categoryId ? categoryCodeById.get(row.categoryId) ?? null : null,
          categoryLabel: row.categoryId
            ? groups.find((g) => g.id === row.categoryId)?.label ?? null
            : null,
          classificationState: row.classificationState as 'CLASSIFIED' | 'TO_CLASSIFY',
        },
        associations: {
          assets: associations.assets.get(row.id) ?? [],
          elements: associations.equipments.get(row.id) ?? [],
        },
      }));

    result.push({ ...target, documents, hasMore });
  }

  return {
    groups: result,
    totalCount,
    toClassifyCount,
    sort: normalizeSort(query.sort),
    direction: normalizeDirection(query.direction),
    pageSize,
  };
}
