/**
 * Amorçage du référentiel de catégories documentaires — CDC 5 §3.
 *
 * IDEMPOTENT : relancé, il ne défait rien. Une catégorie renommée depuis le
 * back-office, un ordre d'affichage ajusté, une association désactivée : rien
 * de tout cela n'est écrasé. Le §1.3 fait du back-office la source de vérité ;
 * un seed qui réécrit tout à chaque déploiement la lui retirerait.
 *
 *   npm run db:seed:doc-categories
 */
// ⚠️ EN PREMIER : `@/db` lit DATABASE_URL au chargement du module.
import '@/lib/load-env';
import { db, ensureMigrations, getMigrationFailures } from '@/db';
import {
  assetTypes,
  documentCategories,
  documentCategoryAssetAssociations,
  documentCategoryTypeAssociations,
  documentTypes,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  CATEGORY_SEED,
  TYPE_CATEGORY_SEED,
  NEW_TYPE_SEED,
} from './category-referential';

export interface SeedReport {
  categoriesCreated: number;
  categoriesSkipped: number;
  typesCreated: number;
  typesSkipped: number;
  assetAssociations: number;
  typeAssociations: number;
  warnings: string[];
}

export async function seedDocumentCategories(): Promise<SeedReport> {
  await ensureMigrations();

  const failures = getMigrationFailures();
  if (failures.length > 0) {
    throw new Error(
      `Migrations en échec, schéma incomplet : ${failures.map((f) => f.filename).join(', ')}.`,
    );
  }

  const report: SeedReport = {
    categoriesCreated: 0, categoriesSkipped: 0,
    typesCreated: 0, typesSkipped: 0,
    assetAssociations: 0, typeAssociations: 0,
    warnings: [],
  };

  const now = new Date();

  // ── Familles de biens ─────────────────────────────────────────────────
  const assetTypeRows = await db
    .select({ id: assetTypes.id, code: assetTypes.code })
    .from(assetTypes);
  const assetTypeByCode = new Map(assetTypeRows.map((a) => [a.code, a.id]));

  // ── 1. Catégories ─────────────────────────────────────────────────────
  const categoryIdByCode = new Map<string, number>();

  for (const seed of CATEGORY_SEED) {
    const [existing] = await db
      .select({ id: documentCategories.id })
      .from(documentCategories)
      .where(eq(documentCategories.code, seed.code))
      .limit(1);

    if (existing) {
      categoryIdByCode.set(seed.code, existing.id);
      report.categoriesSkipped += 1;
      continue;
    }

    const [created] = await db
      .insert(documentCategories)
      .values({
        code: seed.code,
        genericLabel: seed.genericLabel,
        description: seed.description,
        displayOrder: seed.displayOrder,
        isSystemRequired: seed.isSystemRequired ?? false,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documentCategories.id });

    categoryIdByCode.set(seed.code, created.id);
    report.categoriesCreated += 1;
  }

  // ── 2. Applicabilité et libellés contextualisés ───────────────────────
  for (const seed of CATEGORY_SEED) {
    const categoryId = categoryIdByCode.get(seed.code)!;

    // `null` = toutes les familles : une seule ligne sans `asset_type_id`.
    const targets: Array<{ assetTypeId: number | null; code: string | null }> =
      seed.assetTypeCodes === null
        ? [{ assetTypeId: null, code: null }]
        : seed.assetTypeCodes.map((code) => {
            const id = assetTypeByCode.get(code);
            if (!id) report.warnings.push(`Famille de bien inconnue : ${code} (catégorie ${seed.code}).`);
            return { assetTypeId: id ?? null, code };
          }).filter((t) => t.assetTypeId !== null);

    for (const target of targets) {
      const inserted = await db
        .insert(documentCategoryAssetAssociations)
        .values({
          categoryId,
          assetTypeId: target.assetTypeId,
          contextualLabel: target.code ? seed.contextualLabels?.[target.code] ?? null : null,
          displayOrder: seed.displayOrder,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: documentCategoryAssetAssociations.id });
      report.assetAssociations += inserted.length;
    }

    // Une catégorie « toutes familles » porte tout de même des libellés
    // contextualisés (§3.3) : ils sont posés par famille, en plus de la règle
    // générale d'applicabilité.
    if (seed.assetTypeCodes === null && seed.contextualLabels) {
      for (const [code, label] of Object.entries(seed.contextualLabels)) {
        const assetTypeId = assetTypeByCode.get(code);
        if (!assetTypeId) {
          report.warnings.push(`Famille de bien inconnue : ${code} (libellé de ${seed.code}).`);
          continue;
        }
        const inserted = await db
          .insert(documentCategoryAssetAssociations)
          .values({
            categoryId, assetTypeId, contextualLabel: label,
            displayOrder: seed.displayOrder, createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: documentCategoryAssetAssociations.id });
        report.assetAssociations += inserted.length;
      }
    }
  }

  // ── 3. Types complémentaires (§3.5) ───────────────────────────────────
  for (const seed of NEW_TYPE_SEED) {
    const [existing] = await db
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(eq(documentTypes.code, seed.code))
      .limit(1);

    if (existing) { report.typesSkipped += 1; continue; }

    await db.insert(documentTypes).values({
      code: seed.code, label: seed.label, isActive: true,
      displayOrder: 500, createdAt: now, updatedAt: now,
    });
    report.typesCreated += 1;
  }

  // ── 4. Compatibilité type ↔ catégorie ─────────────────────────────────
  const typeRows = await db
    .select({ id: documentTypes.id, code: documentTypes.code })
    .from(documentTypes);
  const typeIdByCode = new Map(typeRows.map((t) => [t.code, t.id]));

  const allAssociations: Record<string, string[]> = { ...TYPE_CATEGORY_SEED };
  for (const seed of NEW_TYPE_SEED) allAssociations[seed.code] = seed.categories;

  for (const [typeCode, categories] of Object.entries(allAssociations)) {
    const documentTypeId = typeIdByCode.get(typeCode);
    if (!documentTypeId) {
      // Un type absent n'est pas une erreur bloquante : le référentiel des
      // types vit sa propre vie en back-office.
      report.warnings.push(`Type documentaire inconnu, associations ignorées : ${typeCode}.`);
      continue;
    }

    for (const categoryCode of categories) {
      const categoryId = categoryIdByCode.get(categoryCode);
      if (!categoryId) {
        report.warnings.push(`Catégorie inconnue : ${categoryCode} (type ${typeCode}).`);
        continue;
      }
      const inserted = await db
        .insert(documentCategoryTypeAssociations)
        .values({ categoryId, documentTypeId, isActive: true, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: documentCategoryTypeAssociations.id });
      report.typeAssociations += inserted.length;
    }
  }

  return report;
}

if (process.argv[1]?.includes('seed-document-categories')) {
  seedDocumentCategories()
    .then((r) => {
      console.log(
        `[doc-categories] catégories : ${r.categoriesCreated} créée(s), ${r.categoriesSkipped} déjà présente(s).`,
      );
      console.log(
        `[doc-categories] types : ${r.typesCreated} créé(s), ${r.typesSkipped} déjà présent(s).`,
      );
      console.log(
        `[doc-categories] associations : ${r.assetAssociations} bien(s), ${r.typeAssociations} type(s).`,
      );
      for (const w of r.warnings) console.warn(`[doc-categories] ⚠ ${w}`);
      process.exit(0);
    })
    .catch((e) => {
      const cause = (e as { cause?: { message?: string; code?: string } }).cause;
      console.error('[doc-categories] échec :', e.message);
      if (cause?.message) console.error(`[doc-categories] cause : ${cause.message}`);
      process.exit(1);
    });
}
