/**
 * Modification du classement d'un document — CDC 5 §8.4, §5.1, §5.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TOUT EN UNE SEULE TRANSACTION
 *
 * Le §8.4 l'énonce en deux points : « recalculer classificationState de
 * manière transactionnelle » et « écrire l'historique et les logs dans la même
 * opération fonctionnelle ».
 *
 * La raison n'est pas la performance. Un état de classification écrit sans son
 * historique produit un document dont personne ne peut expliquer la valeur —
 * et le §5.3 exige précisément que l'historique indique « la date, l'ancienne
 * valeur, la nouvelle valeur et l'origine ». Les séparer, c'est accepter que
 * les deux divergent au premier incident.
 *
 * ── LES RÈGLES NE SONT PAS ICI ────────────────────────────────────────────
 *
 * Toute la logique de compatibilité, d'attribution automatique et de
 * verrouillage vit dans `classification-rules.ts`, sans base. Ce service ne
 * fait que trois choses : lire l'état, appeler la règle, écrire le résultat.
 * C'est ce qui permet de tester les sept situations du §4.3 sans PostgreSQL.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import {
  assetFiles,
  assets,
  documentCategories,
  documentCategoryAssetAssociations,
  documentCategoryTypeAssociations,
  documentClassificationFeedback,
  documentTypes,
} from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import {
  applyClassification,
  buildCompatibilityIndex,
  type ClassificationSource,
} from './classification-rules';

export class ClassificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ClassificationError';
  }
}

export interface UpdateClassificationInput {
  fileId: number;
  accountId: number;
  /** `undefined` = inchangé ; `null` = retiré (§8.4, modification partielle). */
  categoryCode?: string | null;
  documentTypeCode?: string | null;
  source: ClassificationSource;
  /** Renseignés par l'IA uniquement. Jamais exposés au front (§8.2). */
  categoryConfidence?: number | null;
  typeConfidence?: number | null;
  pipelineVersion?: string;
  actorUserId?: number | null;
}

export interface UpdateClassificationResult {
  fileId: number;
  categoryCode: string | null;
  categoryLabel: string | null;
  documentTypeCode: string | null;
  classificationState: 'CLASSIFIED' | 'TO_CLASSIFY';
  /** Libellés des changements, pour l'historique du §5.3. */
  changes: string[];
  /** Modifications refusées par un verrouillage (§5.2). */
  rejected: string[];
  /**
   * Variations de compteurs par groupe, pour actualiser le front sans
   * recharger (§8.4). Clé = code de catégorie ou `__TO_CLASSIFY__`.
   */
  counterDeltas: Record<string, number>;
}

const TO_CLASSIFY_GROUP = '__TO_CLASSIFY__';

/**
 * Construit l'index de compatibilité applicable à un document.
 *
 * Les catégories retenues sont celles compatibles avec TOUS les biens
 * rattachés (§4.4) : proposer une catégorie valable pour l'un et pas pour
 * l'autre produirait un classement impossible à afficher dans les deux
 * onglets.
 */
async function buildIndexForFile(assetIds: number[]) {
  const [associations, categories] = await Promise.all([
    db
      .select({
        typeCode: documentTypes.code,
        categoryCode: documentCategories.code,
      })
      .from(documentCategoryTypeAssociations)
      .innerJoin(documentTypes, eq(documentCategoryTypeAssociations.documentTypeId, documentTypes.id))
      .innerJoin(documentCategories, eq(documentCategoryTypeAssociations.categoryId, documentCategories.id))
      .where(and(
        eq(documentCategoryTypeAssociations.isActive, true),
        eq(documentCategories.isActive, true),
      )),
    db
      .select({
        id: documentCategories.id,
        code: documentCategories.code,
        label: documentCategories.genericLabel,
      })
      .from(documentCategories)
      .where(eq(documentCategories.isActive, true)),
  ]);

  let applicable = categories.map((c) => c.code);

  if (assetIds.length > 0) {
    const assetTypeRows = await db
      .select({ assetTypeId: assets.assetTypeId })
      .from(assets)
      .where(inArray(assets.id, assetIds));

    const assetTypeIds = [...new Set(assetTypeRows.map((a) => a.assetTypeId).filter(Boolean))] as number[];

    if (assetTypeIds.length > 0) {
      const scopes = await db
        .select({
          categoryId: documentCategoryAssetAssociations.categoryId,
          assetTypeId: documentCategoryAssetAssociations.assetTypeId,
        })
        .from(documentCategoryAssetAssociations);

      applicable = categories
        .filter((category) => {
          const forCategory = scopes.filter((s) => s.categoryId === category.id);
          // Une règle sans famille vaut pour toutes (§3.2).
          if (forCategory.some((s) => s.assetTypeId === null)) return true;
          // Sinon, la catégorie doit convenir à CHAQUE famille rattachée.
          return assetTypeIds.every((id) => forCategory.some((s) => s.assetTypeId === id));
        })
        .map((c) => c.code);
    }
  }

  return {
    index: buildCompatibilityIndex(associations, applicable),
    categoryByCode: new Map(categories.map((c) => [c.code, c])),
  };
}

/**
 * Applique une modification de classement.
 *
 * @throws ClassificationError si le document est introuvable, hors du compte
 *   appelant, ou si un code fourni n'existe pas.
 */
export async function updateClassification(
  input: UpdateClassificationInput,
): Promise<UpdateClassificationResult> {
  const [file] = await db
    .select({
      id: assetFiles.id,
      accountId: assetFiles.accountId,
      assetId: assetFiles.assetId,
      linkedAssetId: assetFiles.linkedAssetId,
      categoryId: assetFiles.documentCategoryId,
      documentType: assetFiles.documentType,
      retainedFunctionCode: assetFiles.retainedFunctionCode,
      classificationState: assetFiles.classificationState,
      categoryUserLocked: assetFiles.categoryUserLocked,
      typeUserLocked: assetFiles.typeUserLocked,
    })
    .from(assetFiles)
    .where(eq(assetFiles.id, input.fileId))
    .limit(1);

  if (!file) throw new ClassificationError('NOT_FOUND', `Document ${input.fileId} introuvable.`);
  if (file.accountId !== input.accountId) {
    // Message identique à « introuvable » : distinguer les deux renseignerait
    // un appelant sur l'existence d'un document qui n'est pas le sien.
    throw new ClassificationError('NOT_FOUND', `Document ${input.fileId} introuvable.`);
  }

  const assetIds = [...new Set([file.assetId, file.linkedAssetId].filter(Boolean))] as number[];
  const { index, categoryByCode } = await buildIndexForFile(assetIds);

  // Validation des codes fournis, avant toute écriture.
  if (input.categoryCode) {
    const category = categoryByCode.get(input.categoryCode);
    if (!category) {
      throw new ClassificationError('UNKNOWN_CATEGORY', `Catégorie inconnue : ${input.categoryCode}.`);
    }
    if (!index.categoriesForAssets().includes(input.categoryCode)) {
      throw new ClassificationError(
        'CATEGORY_NOT_APPLICABLE',
        `La catégorie ${input.categoryCode} ne s'applique pas aux biens rattachés à ce document.`,
      );
    }
  }

  if (input.documentTypeCode) {
    const [type] = await db
      .select({ code: documentTypes.code })
      .from(documentTypes)
      .where(and(eq(documentTypes.code, input.documentTypeCode), eq(documentTypes.isActive, true)))
      .limit(1);
    if (!type) {
      throw new ClassificationError('UNKNOWN_TYPE', `Type inconnu : ${input.documentTypeCode}.`);
    }
  }

  const currentCategoryCode = file.categoryId
    ? [...categoryByCode.values()].find((c) => c.id === file.categoryId)?.code ?? null
    : null;
  const currentTypeCode = file.retainedFunctionCode ?? file.documentType;

  const outcome = applyClassification(
    {
      currentCategory: currentCategoryCode,
      currentType: currentTypeCode,
      nextCategory: input.categoryCode,
      nextType: input.documentTypeCode,
      categoryUserLocked: file.categoryUserLocked,
      typeUserLocked: file.typeUserLocked,
      source: input.source,
    },
    index,
  );

  const nextCategory = outcome.category ? categoryByCode.get(outcome.category) ?? null : null;
  const now = new Date();

  // ── Écriture transactionnelle (§8.4) ────────────────────────────────────
  await db.transaction(async (tx) => {
    await tx
      .update(assetFiles)
      .set({
        documentCategoryId: nextCategory?.id ?? null,
        documentType: outcome.type,
        classificationState: outcome.state,
        categoryUserLocked: outcome.categoryUserLocked,
        typeUserLocked: outcome.typeUserLocked,
        categorySource: outcome.category ? input.source : null,
        typeSource: outcome.type ? input.source : null,
        categoryConfidence: input.categoryConfidence?.toString() ?? null,
        typeConfidence: input.typeConfidence?.toString() ?? null,
        classificationUpdatedAt: now,
      })
      .where(eq(assetFiles.id, input.fileId));

    // §5.2 : « le reclassement manuel constitue un signal d'échec de
    // classification de l'IA ». Sans cette trace, on saurait que la valeur a
    // changé, jamais ce que l'IA avait proposé.
    if (input.source === 'USER' && outcome.changes.length > 0) {
      await tx.insert(documentClassificationFeedback).values({
        fileId: input.fileId,
        proposedCategoryId: file.categoryId,
        proposedTypeCode: currentTypeCode,
        correctedCategoryId: nextCategory?.id ?? null,
        correctedTypeCode: outcome.type,
        pipelineVersion: input.pipelineVersion ?? null,
        createdAt: now,
      });
    }
  });

  // ── Variations de compteurs (§8.4) ──────────────────────────────────────
  const before = file.classificationState === 'TO_CLASSIFY'
    ? TO_CLASSIFY_GROUP
    : currentCategoryCode;
  const after = outcome.state === 'TO_CLASSIFY' ? TO_CLASSIFY_GROUP : outcome.category;

  const counterDeltas: Record<string, number> = {};
  if (before !== after) {
    if (before) counterDeltas[before] = -1;
    if (after) counterDeltas[after] = (counterDeltas[after] ?? 0) + 1;
  }

  return {
    fileId: input.fileId,
    categoryCode: outcome.category,
    categoryLabel: nextCategory?.label ?? null,
    documentTypeCode: outcome.type,
    classificationState: outcome.state,
    changes: outcome.changes,
    rejected: outcome.rejected,
    counterDeltas,
  };
}

/**
 * Options proposées dans le drawer (§5.1).
 *
 * « La liste des types est limitée aux types pertinents pour tous les biens
 * associés. Le choix de catégorie limite les types compatibles ; le choix
 * d'un type détermine ou limite les catégories possibles. »
 */
export async function getClassificationOptions(fileId: number, accountId: number) {
  const [file] = await db
    .select({
      accountId: assetFiles.accountId,
      assetId: assetFiles.assetId,
      linkedAssetId: assetFiles.linkedAssetId,
    })
    .from(assetFiles)
    .where(eq(assetFiles.id, fileId))
    .limit(1);

  if (!file || file.accountId !== accountId) {
    throw new ClassificationError('NOT_FOUND', `Document ${fileId} introuvable.`);
  }

  const assetIds = [...new Set([file.assetId, file.linkedAssetId].filter(Boolean))] as number[];
  const { index, categoryByCode } = await buildIndexForFile(assetIds);

  const applicable = index.categoriesForAssets();

  const associations = await db
    .select({ typeCode: documentTypes.code, typeLabel: documentTypes.label,
              categoryCode: documentCategories.code })
    .from(documentCategoryTypeAssociations)
    .innerJoin(documentTypes, eq(documentCategoryTypeAssociations.documentTypeId, documentTypes.id))
    .innerJoin(documentCategories, eq(documentCategoryTypeAssociations.categoryId, documentCategories.id))
    .where(and(
      eq(documentCategoryTypeAssociations.isActive, true),
      eq(documentTypes.isActive, true),
    ));

  const typesByCategory = new Map<string, Array<{ code: string; label: string }>>();
  for (const code of applicable) typesByCategory.set(code, []);

  for (const row of associations) {
    if (!typesByCategory.has(row.categoryCode)) continue;
    typesByCategory.get(row.categoryCode)!.push({ code: row.typeCode, label: row.typeLabel });
  }

  // §6.2 : `AUTRE` est disponible dans toutes les catégories. Il est ajouté
  // ici plutôt qu'inscrit dans chaque association — sans quoi il faudrait
  // penser à le réinscrire à chaque catégorie créée.
  const [generic] = await db
    .select({ code: documentTypes.code, label: documentTypes.label })
    .from(documentTypes)
    .where(eq(documentTypes.code, 'AUTRE'))
    .limit(1);

  if (generic) {
    for (const list of typesByCategory.values()) {
      if (!list.some((t) => t.code === generic.code)) list.push(generic);
    }
  }

  return {
    categories: applicable.map((code) => ({
      code,
      label: categoryByCode.get(code)?.label ?? code,
      types: (typesByCategory.get(code) ?? []).sort((a, b) => a.label.localeCompare(b.label, 'fr')),
    })),
  };
}
