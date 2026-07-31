/**
 * Reprise mécanique du classement — CDC 5 §4.3 règle 1, §7.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN APPEL MODÈLE. QUE DE LA DÉDUCTION.
 *
 * Le §7.2 prévoit un traitement de cohérence qui reclasse les documents
 * existants. Il s'appuiera sur l'IA — c'est le lot C1d, qui attend la bascule.
 *
 * Mais une part du travail n'en a pas besoin. La règle 1 du §4.3 dit :
 *
 *   « Type compatible avec une seule catégorie : la catégorie est attribuée
 *     automatiquement lorsque le type est choisi. »
 *
 * Un document déjà typé `GARANTIE` n'appartient qu'à « Garanties et notices ».
 * Aucune inférence n'est nécessaire : le référentiel ne laisse qu'une
 * possibilité. La même logique vaut pour `DPE`, `CONTROLE_TECHNIQUE`,
 * `TAXE_FONCIERE` et une vingtaine d'autres.
 *
 * Cette reprise sort donc mécaniquement de « À classer » tous les documents
 * dont le type ne souffre pas d'ambiguïté, sans attendre la bascule et sans
 * dépenser un appel.
 *
 * ── CE QU'ELLE NE FAIT JAMAIS ─────────────────────────────────────────────
 *
 * · deviner : un type admettant deux catégories reste « à classer » ;
 * · toucher un document déjà classé ;
 * · écraser une valeur posée par un utilisateur — le §5.2 l'interdit, et le
 *   verrouillage est respecté ;
 * · inventer un type : elle n'agit que sur les documents QUI EN ONT DÉJÀ UN.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import {
  assetFiles,
  assets,
  documentCategories,
  documentCategoryAssetAssociations,
  documentCategoryTypeAssociations,
  documentTypes,
} from '@/db/schema';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { buildCompatibilityIndex, GENERIC_TYPE_CODE, type CompatibilityIndex } from './classification-rules';

/** Issue d'un document, avant écriture. */
export type ReclassifyVerdict =
  | { decision: 'classify'; categoryCode: string }
  | { decision: 'ambiguous'; reason: string }
  | { decision: 'skip'; reason: 'no_type' | 'not_applicable' };

/**
 * Décide du sort d'un document.
 *
 * Pure et exportée : c'est toute la règle, et elle doit être vérifiable sans
 * base. Une reprise qui classerait à tort est difficile à défaire — elle
 * touche des milliers de lignes d'un coup.
 */
export function decideCategory(
  typeCode: string | null,
  index: CompatibilityIndex,
  /** Catégories du référentiel entier, pour distinguer inconnu d'inapplicable. */
  toutesCategories: CompatibilityIndex,
): ReclassifyVerdict {
  if (!typeCode) return { decision: 'skip', reason: 'no_type' };

  // `AUTRE` est compatible avec toutes les catégories : il ne permet jamais
  // de trancher, par construction (§6.2).
  if (typeCode === GENERIC_TYPE_CODE) {
    return { decision: 'ambiguous', reason: 'type générique' };
  }

  const candidates = index.categoriesForType(typeCode);

  if (candidates.length === 1) {
    return { decision: 'classify', categoryCode: candidates[0] };
  }
  if (candidates.length > 1) {
    return { decision: 'ambiguous', reason: `${candidates.length} catégories possibles` };
  }

  // Aucune candidate : soit le type est inconnu du référentiel, soit sa seule
  // catégorie ne s'applique pas aux biens rattachés (§4.4). La distinction
  // compte — le second cas relève d'un rattachement à revoir, pas d'un
  // référentiel incomplet.
  return toutesCategories.categoriesForType(typeCode).length > 0
    ? { decision: 'skip', reason: 'not_applicable' }
    : { decision: 'skip', reason: 'no_type' };
}

export interface ReclassifyOptions {
  accountId?: number;
  /** N'écrit rien, rapporte seulement. */
  dryRun?: boolean;
  /** Plafond de documents traités par exécution. */
  limit?: number;
}

export interface ReclassifyReport {
  examined: number;
  classified: number;
  /** Type ambigu : plusieurs catégories possibles, aucune décision. */
  ambiguous: number;
  /** Type inconnu du référentiel, ou absent. */
  skippedNoType: number;
  /** Catégorie unique trouvée mais inapplicable aux biens rattachés. */
  skippedNotApplicable: number;
  byCategory: Record<string, number>;
  dryRun: boolean;
}

/**
 * Reprend les documents non classés.
 *
 * Le traitement est réalisé par lots pour rester tenable sur un compte
 * volumineux : le §1.3 signale des quotas jusqu'à 225 documents par compte, et
 * une reprise globale peut en parcourir des dizaines de milliers.
 */
export async function reclassifyUnclassifiedDocuments(
  options: ReclassifyOptions = {},
): Promise<ReclassifyReport> {
  const dryRun = options.dryRun ?? false;
  const limit = Math.min(options.limit ?? 500, 2000);

  const report: ReclassifyReport = {
    examined: 0, classified: 0, ambiguous: 0,
    skippedNoType: 0, skippedNotApplicable: 0,
    byCategory: {}, dryRun,
  };

  // ── Référentiel, chargé une seule fois ────────────────────────────────
  const [categories, associations, scopes] = await Promise.all([
    db.select({
      id: documentCategories.id,
      code: documentCategories.code,
    }).from(documentCategories).where(eq(documentCategories.isActive, true)),

    db.select({
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

    db.select({
      categoryId: documentCategoryAssetAssociations.categoryId,
      assetTypeId: documentCategoryAssetAssociations.assetTypeId,
    }).from(documentCategoryAssetAssociations),
  ]);

  const categoryIdByCode = new Map(categories.map((c) => [c.code, c.id]));
  const categoryCodeById = new Map(categories.map((c) => [c.id, c.code]));

  // ── Documents à reprendre ─────────────────────────────────────────────
  //
  // Uniquement ceux qui portent un type ET aucune catégorie. Un document sans
  // type ne peut rien déduire ; un document déjà catégorisé n'est pas touché.
  const conditions = [
    eq(assetFiles.classificationState, 'TO_CLASSIFY'),
    isNull(assetFiles.documentCategoryId),
    isNull(assetFiles.deletedAt),
    or(isNotNull(assetFiles.documentType), isNotNull(assetFiles.retainedFunctionCode))!,
    // §5.2 : une catégorie verrouillée par l'utilisateur n'est pas retouchée.
    eq(assetFiles.categoryUserLocked, false),
  ];
  if (options.accountId) conditions.push(eq(assetFiles.accountId, options.accountId));

  const candidats = await db
    .select({
      id: assetFiles.id,
      accountId: assetFiles.accountId,
      assetId: assetFiles.assetId,
      linkedAssetId: assetFiles.linkedAssetId,
      documentType: assetFiles.documentType,
      retainedFunctionCode: assetFiles.retainedFunctionCode,
      typeUserLocked: assetFiles.typeUserLocked,
    })
    .from(assetFiles)
    .where(and(...conditions))
    .limit(limit);

  report.examined = candidats.length;
  if (candidats.length === 0) return report;

  // ── Familles de biens, en une requête ─────────────────────────────────
  const assetIds = [...new Set(
    candidats.flatMap((d) => [d.assetId, d.linkedAssetId]).filter(Boolean),
  )] as number[];

  const assetTypeById = new Map<number, number | null>();
  if (assetIds.length > 0) {
    const rows = await db
      .select({ id: assets.id, assetTypeId: assets.assetTypeId })
      .from(assets)
      .where(inArray(assets.id, assetIds));
    for (const r of rows) assetTypeById.set(r.id, r.assetTypeId ?? null);
  }

  /** Catégories applicables à un jeu de biens (§4.4). */
  function applicables(ids: number[]): string[] {
    const familles = [...new Set(ids.map((id) => assetTypeById.get(id)).filter(Boolean))] as number[];
    return categories
      .filter((c) => {
        const regles = scopes.filter((s) => s.categoryId === c.id);
        // Une règle sans famille vaut pour toutes.
        if (regles.some((s) => s.assetTypeId === null)) return true;
        if (familles.length === 0) return false;
        // Sinon la catégorie doit convenir à CHAQUE famille rattachée.
        return familles.every((f) => regles.some((s) => s.assetTypeId === f));
      })
      .map((c) => c.code);
  }

  const aEcrire: Array<{ id: number; categoryId: number; code: string }> = [];

  // Index du référentiel entier, sans restriction de bien : il sert à
  // distinguer « type inconnu » de « catégorie inapplicable ».
  const toutesCategories = buildCompatibilityIndex(
    associations,
    categories.map((c) => c.code),
  );

  for (const doc of candidats) {
    const typeCode = doc.retainedFunctionCode ?? doc.documentType;

    const ids = [...new Set([doc.assetId, doc.linkedAssetId].filter(Boolean))] as number[];
    const index = buildCompatibilityIndex(associations, applicables(ids));
    const verdict = decideCategory(typeCode, index, toutesCategories);

    if (verdict.decision === 'ambiguous') { report.ambiguous += 1; continue; }
    if (verdict.decision === 'skip') {
      if (verdict.reason === 'not_applicable') report.skippedNotApplicable += 1;
      else report.skippedNoType += 1;
      continue;
    }

    const code = verdict.categoryCode;
    const categoryId = categoryIdByCode.get(code);
    if (!categoryId) { report.skippedNoType += 1; continue; }

    aEcrire.push({ id: doc.id, categoryId, code });
    report.byCategory[code] = (report.byCategory[code] ?? 0) + 1;
  }

  report.classified = aEcrire.length;
  if (dryRun || aEcrire.length === 0) return report;

  // ── Écriture ──────────────────────────────────────────────────────────
  //
  // Regroupée par catégorie : une requête par catégorie plutôt qu'une par
  // document. Sur une reprise de plusieurs milliers de lignes, la différence
  // est celle entre quelques secondes et plusieurs minutes.
  const now = new Date();
  const parCategorie = new Map<number, number[]>();
  for (const e of aEcrire) {
    if (!parCategorie.has(e.categoryId)) parCategorie.set(e.categoryId, []);
    parCategorie.get(e.categoryId)!.push(e.id);
  }

  for (const [categoryId, ids] of parCategorie) {
    await db
      .update(assetFiles)
      .set({
        documentCategoryId: categoryId,
        // Le document devient classé : il a désormais catégorie ET type
        // compatibles, ce qu'exige le §2.3.
        classificationState: 'CLASSIFIED',
        categorySource: 'RULE',
        classificationUpdatedAt: now,
      })
      .where(inArray(assetFiles.id, ids));
  }

  console.info(
    `[reclassify] ${report.classified} document(s) classé(s) par déduction, ` +
    `${report.ambiguous} laissé(s) à classer (type ambigu).`,
  );

  return report;
}

/** Compteurs d'état, pour mesurer l'effet d'une reprise. */
export async function classificationCounts(accountId?: number): Promise<{
  total: number; classified: number; toClassify: number;
}> {
  const base = [isNull(assetFiles.deletedAt)];
  if (accountId) base.push(eq(assetFiles.accountId, accountId));

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      classified: sql<number>`count(*) FILTER (WHERE ${assetFiles.classificationState} = 'CLASSIFIED')::int`,
      toClassify: sql<number>`count(*) FILTER (WHERE ${assetFiles.classificationState} = 'TO_CLASSIFY')::int`,
    })
    .from(assetFiles)
    .where(and(...base));

  return row ?? { total: 0, classified: 0, toClassify: 0 };
}
