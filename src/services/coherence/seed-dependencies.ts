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
import { and, eq } from 'drizzle-orm';

interface DependencySeed {
  sourceField: string;
  targetField: string;
  category: string | null;
  impactType: 'propagation' | 'agenda_creation' | 'recalculation' | 'index_update';
  transformRule: string | null;
  confidence: 'certain' | 'probable' | 'conflictual';
}

const DEPENDENCIES: DependencySeed[] = [
  // ── Date du document → propagation ──
  { sourceField: 'documentDate',      targetField: 'acquisitionDate',  category: null, impactType: 'propagation',    transformRule: 'copy_date',           confidence: 'probable' },
  { sourceField: 'documentDate',      targetField: 'estimatedValueDate', category: null, impactType: 'propagation', transformRule: 'copy_date',           confidence: 'probable' },
  { sourceField: 'documentDate',      targetField: 'documentDate_agenda', category: null, impactType: 'agenda_creation', transformRule: null,               confidence: 'certain' },

  // ── Fournisseur → enrichissement ──
  { sourceField: 'supplier',          targetField: 'acquisitionLocation', category: null, impactType: 'propagation',    transformRule: 'extract_city',       confidence: 'probable' },

  // ── Montant → propagation ──
  { sourceField: 'amountCents',       targetField: 'acquisitionPrice', category: null, impactType: 'propagation',    transformRule: 'cents_to_euros',      confidence: 'certain' },
  { sourceField: 'amountCents',       targetField: 'estimatedValue',   category: null, impactType: 'propagation',    transformRule: 'cents_to_euros',      confidence: 'probable' },

  // ── Type de document → catégorisation ──
  { sourceField: 'retainedFunctionCode', targetField: 'category',      category: null, impactType: 'propagation',    transformRule: 'doc_type_to_category', confidence: 'probable' },

  // ── Diagnostics CIL → recalendarisation ──
  { sourceField: 'cilRubricCodes',    targetField: 'dpeClass',         category: 'IMMOBILIER', impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },
  { sourceField: 'cilRubricCodes',    targetField: 'dpeDate',          category: 'IMMOBILIER', impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },
  { sourceField: 'cilRubricCodes',    targetField: 'gesClass',         category: 'IMMOBILIER', impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },

  // ── Adresse → géolocalisation ──
  { sourceField: 'address1',          targetField: 'city',             category: 'IMMOBILIER', impactType: 'propagation',    transformRule: 'extract_city_from_address', confidence: 'certain' },
  { sourceField: 'postalCode',        targetField: 'city',             category: 'IMMOBILIER', impactType: 'propagation',    transformRule: 'postal_code_to_city',      confidence: 'probable' },

  // ── Équipements → agenda ──
  { sourceField: 'equipmentId',       targetField: 'equipment_maintenance_agenda', category: null, impactType: 'agenda_creation', transformRule: null,               confidence: 'certain' },

  // ── Surface → index ──
  { sourceField: 'livingArea',        targetField: '_search_index',    category: 'IMMOBILIER', impactType: 'index_update',   transformRule: null,               confidence: 'certain' },
  { sourceField: 'landArea',          targetField: '_search_index',    category: 'IMMOBILIER', impactType: 'index_update',   transformRule: null,               confidence: 'certain' },

  // ── Véhicule → recalendarisation ──
  { sourceField: 'mileage',           targetField: '_search_index',    category: 'VEHICULE',   impactType: 'index_update',   transformRule: null,               confidence: 'certain' },
  { sourceField: 'registrationNumber', targetField: '_search_index',   category: 'VEHICULE',   impactType: 'index_update',   transformRule: null,               confidence: 'certain' },
  { sourceField: 'firstRegistrationDate', targetField: 'mileage_agenda', category: 'VEHICULE', impactType: 'agenda_creation', transformRule: null,            confidence: 'probable' },

  // ── Valeur estimée → export stale ──
  { sourceField: 'estimatedValue',    targetField: '_export_stale',    category: null, impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },
  { sourceField: 'estimatedValueDate', targetField: '_export_stale',   category: null, impactType: 'recalculation',  transformRule: null,               confidence: 'certain' },
];

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
          dep.category ? eq(fieldDependencies.category, dep.category) : eq(fieldDependencies.category as any, null),
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

  console.log(`[seed-dependencies] Done — ${inserted} inserted, ${skipped} updated.`);
}

main().catch(err => {
  console.error('[seed-dependencies] Failed:', err);
  process.exit(1);
});