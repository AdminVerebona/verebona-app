/**
 * FieldDependencyService
 * ───────────────────────
 * Resolves the dependency graph between fields. Given a source field that changed,
 * determines which target fields are impacted and with what confidence.
 *
 * Dependencies are stored in the `field_dependencies` table and can be managed
 * at runtime. The service also provides a local cache for hot paths.
 */

import { db } from '@/db';
import { fieldDependencies } from '@/db/schema';
import { eq } from 'drizzle-orm';

export type ImpactType = 'propagation' | 'agenda_creation' | 'recalculation' | 'index_update';
export type Confidence  = 'certain' | 'probable' | 'conflictual';

export interface DependencyRule {
  id: number;
  sourceField: string;
  targetField: string;
  category: string | null;
  impactType: ImpactType;
  transformRule: string | null;
  confidence: Confidence;
}

// In-memory cache refreshed on first use
let cachedRules: DependencyRule[] | null = null;
let lastCacheRefresh = 0;
const CACHE_TTL_MS = 60_000;

async function getRules(): Promise<DependencyRule[]> {
  const now = Date.now();
  if (cachedRules && (now - lastCacheRefresh) < CACHE_TTL_MS) {
    return cachedRules;
  }

  const rows = await db
    .select()
    .from(fieldDependencies)
    .where(eq(fieldDependencies.isActive, true));

  cachedRules = rows.map(r => ({
    id: r.id,
    sourceField: r.sourceField,
    targetField: r.targetField,
    category: r.category,
    impactType: r.impactType as ImpactType,
    transformRule: r.transformRule,
    confidence: r.confidence as Confidence,
  }));

  lastCacheRefresh = now;
  return cachedRules!;
}

export function clearDependencyCache(): void {
  cachedRules = null;
  lastCacheRefresh = 0;
}

/**
 * Given a changed source field (or trigger type) and an optional asset category,
 * return all dependency rules that match.
 */
export async function resolveImpacts(
  sourceField: string,
  category?: string | null,
): Promise<DependencyRule[]> {
  const rules = await getRules();
  return rules.filter(r => {
    if (r.sourceField !== sourceField) return false;
    if (r.category && category && r.category !== category) return false;
    // If the rule has a category but the asset doesn't match, skip
    if (r.category && !category) return false;
    return true;
  });
}

/**
 * Get all possible target fields reachable from a source field via the dependency graph.
 */
export async function resolveImpactChain(
  sourceField: string,
  category?: string | null,
  maxDepth = 3,
): Promise<DependencyRule[]> {
  const rules = await getRules();
  const visited = new Set<string>();
  const result: DependencyRule[] = [];
  let queue = [sourceField];

  for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
    const nextQueue: string[] = [];
    for (const src of queue) {
      if (visited.has(src)) continue;
      visited.add(src);

      const matched = rules.filter(r => {
        if (r.sourceField !== src) return false;
        if (r.category && category && r.category !== category) return false;
        if (r.category && !category) return false;
        return true;
      });

      for (const rule of matched) {
        result.push(rule);
        nextQueue.push(rule.targetField);
      }
    }
    queue = nextQueue;
  }

  return result;
}

/**
 * Get the next fields that depend on a given source field (direct dependents).
 */
export async function getDependents(
  sourceField: string,
  category?: string | null,
): Promise<DependencyRule[]> {
  return resolveImpacts(sourceField, category);
}

/**
 * Get all direct sources for a given target field (reverse lookup).
 */
export async function getDependenciesFor(
  targetField: string,
  category?: string | null,
): Promise<DependencyRule[]> {
  const rules = await getRules();
  return rules.filter(r => {
    if (r.targetField !== targetField) return false;
    if (r.category && category && r.category !== category) return false;
    if (r.category && !category) return false;
    return true;
  });
}

/**
 * Add a new dependency rule at runtime.
 */
export async function addDependency(dep: {
  sourceField: string;
  targetField: string;
  category?: string;
  impactType: ImpactType;
  transformRule?: string;
  confidence: Confidence;
}): Promise<void> {
  await db.insert(fieldDependencies).values({
    sourceField: dep.sourceField,
    targetField: dep.targetField,
    category: dep.category ?? null,
    impactType: dep.impactType,
    transformRule: dep.transformRule ?? null,
    confidence: dep.confidence,
    isActive: true,
  } as any);
  clearDependencyCache();
}

/**
 * Get all supported trigger types (source fields) that can initiate propagation.
 */
export async function getAllTriggerTypes(): Promise<string[]> {
  const rules = await getRules();
  return [...new Set(rules.map(r => r.sourceField))].sort();
}

/**
 * Categorized triggers for the event system.
 */
export const TRIGGER_CATEGORIES: Record<string, string[]> = {
  document_analysis: [
    'document_extracted_name', 'document_extracted_address', 'document_extracted_city',
    'document_extracted_postal_code', 'document_extracted_surface', 'document_extracted_land_surface',
    'document_extracted_rooms', 'document_extracted_bedrooms', 'document_extracted_construction_year',
    'document_extracted_dpe', 'document_extracted_ges', 'document_extracted_vin',
    'document_extracted_registration', 'document_extracted_make', 'document_extracted_model',
    'document_extracted_year', 'document_extracted_mileage', 'document_extracted_fuel',
    'document_extracted_power', 'document_extracted_brand', 'document_extracted_serial_number',
    'document_extracted_condition',
  ],
  manual_update: [
    'name', 'address', 'city', 'postalCode', 'registrationNumber',
    'make', 'model', 'year', 'vin', 'brand', 'serialNumber',
    'livingArea', 'landArea', 'roomCount', 'bedroomCount', 'constructionYear',
    'dpeClass', 'gesClass', 'mileage', 'fuelType', 'estimatedValue',
    'acquisitionDate', 'acquisitionPrice',
  ],
  agenda_ready: [
    'acquisition_date', 'insurance_expiry', 'next_inspection',
    'warranty_end', 'last_revision',
  ],
};
