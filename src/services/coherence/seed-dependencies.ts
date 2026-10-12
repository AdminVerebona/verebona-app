/**
 * seed-field-dependencies.ts
 * ───────────────────────────
 * Seed la table `field_dependencies` avec les règles de propagation
 * définies dans le CDC V2 (§A.3 — Graphe de dépendances).
 *
 * Exécution :
 *   npx tsx src/services/coherence/seed-dependencies.ts
 *
 * Idempotent : upsert par (sourceField, targetField, category).
 */

import { db } from '@/db';
import { fieldDependencies } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

interface DependencySeed {
  sourceField: string;
  targetField: string;
  category: string | null;
  impactType: 'propagation' | 'agenda_creation' | 'recalculation' | 'index_update';
  transformRule: string | null;
  confidence: 'certain' | 'probable' | 'conflictual';
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 38 — O0 (CDC Opérations V1 §19, §24, B18, B24, B32 étape 2, C18, C23)
 *
 * Règles RETIRÉES : propagations GÉNÉRIQUES d'une date ou d'un montant de
 * document vers l'acquisition ou la valorisation, et création d'un événement
 * d'agenda générique. « Aucun montant documentaire générique ne doit
 * contaminer valorisation ou acquisition » (C18) ; l'agenda relève de T4.
 * L'acquisition est désormais portée par la règle CONTEXTUALISÉE de la
 * projection T1 (justificatif d'achat du bien, `projection/rules.ts`) ; la
 * valorisation par une preuve de valorisation explicite (`valuationHistory`).
 *
 * Elles ne sont plus insérées, et le seed les DÉSACTIVE si une exécution
 * antérieure les avait créées (même effet que la migration 0315, qui les
 * neutralise automatiquement en exploitation).
 * ══════════════════════════════════════════════════════════════════════════
 */
export const RETIRED_DEPENDENCIES: ReadonlyArray<Pick<DependencySeed, 'sourceField' | 'targetField' | 'category'>> = [
  { sourceField: 'documentDate', targetField: 'acquisitionDate', category: null },
  { sourceField: 'documentDate', targetField: 'estimatedValueDate', category: null },
  { sourceField: 'documentDate', targetField: 'documentDate_agenda', category: null },
  { sourceField: 'supplier', targetField: 'acquisitionLocation', category: null },
  { sourceField: 'amountCents', targetField: 'acquisitionPrice', category: null },
  { sourceField: 'amountCents', targetField: 'estimatedValue', category: null },
  // Création d'agenda générique : le moteur de propagation n'en crée plus (T4).
  { sourceField: 'equipmentId', targetField: 'equipment_maintenance_agenda', category: null },
  { sourceField: 'firstRegistrationDate', targetField: 'mileage_agenda', category: 'VEHICULE' },
];

export const DEPENDENCIES: DependencySeed[] = [
  // ── Type de document → catégorisation ──
  { sourceField: 'retainedFunctionCode', targetField: 'category',      category: null, impactType: 'propagation',    transformRule: 'doc_type_to_category', confidence: 'probable' },

  // ── Diagnostics CIL → recalendarisation ──
  { sourceField: 'cilRubricCodes',    targetField: 'dpeClass',         category: 'IMMOBILIER', impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },
  { sourceField: 'cilRubricCodes',    targetField: 'dpeDate',          category: 'IMMOBILIER', impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },
  { sourceField: 'cilRubricCodes',    targetField: 'gesClass',         category: 'IMMOBILIER', impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },

  // ── Adresse → géolocalisation ──
  { sourceField: 'address1',          targetField: 'city',             category: 'IMMOBILIER', impactType: 'propagation',    transformRule: 'extract_city_from_address', confidence: 'certain' },
  { sourceField: 'postalCode',        targetField: 'city',             category: 'IMMOBILIER', impactType: 'propagation',    transformRule: 'postal_code_to_city',      confidence: 'probable' },

  // ── Surface → index ──
  { sourceField: 'livingArea',        targetField: '_search_index',    category: 'IMMOBILIER', impactType: 'index_update',   transformRule: null,               confidence: 'certain' },
  { sourceField: 'landArea',          targetField: '_search_index',    category: 'IMMOBILIER', impactType: 'index_update',   transformRule: null,               confidence: 'certain' },

  // ── Véhicule → recalendarisation ──
  { sourceField: 'mileage',           targetField: '_search_index',    category: 'VEHICULE',   impactType: 'index_update',   transformRule: null,               confidence: 'certain' },
  { sourceField: 'registrationNumber', targetField: '_search_index',   category: 'VEHICULE',   impactType: 'index_update',   transformRule: null,               confidence: 'certain' },

  // ── Valeur estimée → export stale ──
  { sourceField: 'estimatedValue',    targetField: '_export_stale',    category: null, impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },
  { sourceField: 'estimatedValueDate', targetField: '_export_stale',   category: null, impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },
];

/**
 * Catégorie de la règle. `NULL` se compare par `IS NULL` : l'ancien
 * `eq(category, null)` produisait `category = NULL`, toujours faux — chaque
 * exécution réinsérait les règles génériques (seed non idempotent).
 */
export function categoryClause(category: string | null) {
  return category ? eq(fieldDependencies.category, category) : isNull(fieldDependencies.category);
}

async function main() {
  console.log(`[seed-dependencies] Seeding ${DEPENDENCIES.length} dependency rules...`);

  let inserted = 0;
  let skipped = 0;

  for (const dep of DEPENDENCIES) {
    // Check if rule already exists
    const [existing] = await db
      .select({ id: fieldDependencies.id })
      .from(fieldDependencies)
      .where(
        and(
          eq(fieldDependencies.sourceField, dep.sourceField),
          eq(fieldDependencies.targetField, dep.targetField),
          categoryClause(dep.category),
        ),
      )
      .limit(1);

    if (existing) {
      // Update existing rule
      await db
        .update(fieldDependencies)
        .set({
          impactType: dep.impactType,
          transformRule: dep.transformRule,
          confidence: dep.confidence,
          isActive: true,
        } as any)
        .where(eq(fieldDependencies.id, existing.id));
      skipped++;
    } else {
      await db
        .insert(fieldDependencies)
        .values({
          sourceField: dep.sourceField,
          targetField: dep.targetField,
          category: dep.category,
          impactType: dep.impactType,
          transformRule: dep.transformRule,
          confidence: dep.confidence,
          isActive: true,
        } as any);
      inserted++;
    }
  }

  // O0 (lot 38) : règles génériques retirées — désactivées si présentes.
  let retired = 0;
  for (const dep of RETIRED_DEPENDENCIES) {
    const rows = await db
      .update(fieldDependencies)
      .set({ isActive: false, updatedAt: new Date() } as any)
      .where(and(
        eq(fieldDependencies.sourceField, dep.sourceField),
        eq(fieldDependencies.targetField, dep.targetField),
        categoryClause(dep.category),
        eq(fieldDependencies.isActive, true),
      ))
      .returning({ id: fieldDependencies.id });
    retired += rows.length;
  }

  console.log(`[seed-dependencies] Done — ${inserted} inserted, ${skipped} updated, ${retired} retired.`);
}

// Exécution directe seulement (`npx tsx …/seed-dependencies.ts`) : l'import
// par un test ne lance rien.
if (process.argv[1]?.includes('seed-dependencies')) {
  main().catch(err => {
    console.error('[seed-dependencies] Failed:', err);
    process.exit(1);
  });
}