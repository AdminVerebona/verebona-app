/**
 * FieldValidator — Canonical field registry & validation pour les écritures
 * dans keyCharacteristics.
 *
 * Centralise la définition des champs autorisés par catégorie de bien afin
 * d'éviter les contaminations croisées (ex: un champ OBJET écrit sur un VEHICULE).
 *
 * Tous les points d'écriture (enrichissement IA, impact propagation, PATCH API)
 * DOIVENT passer par validateField avant d'écrire dans keyCharacteristics.
 */

// ─── Sections autorisées par famille ──────────────────────────────────────────

const FAMILY_SECTIONS: Record<string, string[]> = {
  IMMOBILIER: ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation', 'insurance'],
  VEHICULE:   ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'],
  OBJET:      ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation', 'insurance'],
};

// ─── Champs par section (canonique — combine apply-ai-suggestions + enrich-coherence) ──

const SECTION_FIELDS: Record<string, string[]> = {
  common:                   ['name', 'description', 'acquisitionDate', 'acquisitionPrice', 'acquisitionCurrency', 'acquisitionLocation', 'estimatedValueCurrency', 'notes'],
  location_identification:  ['address1', 'address2', 'postalCode', 'city', 'country', 'cadastralRef', 'lotNumber', 'floor', 'gpsCoords'],
  physical_characteristics: ['livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'generalCondition'],
  occupancy_usage:          ['occupancyUsage', 'occupancyStatus', 'monthlyRent', 'charges', 'occupancyNotes'],
  performance_technical:    ['heatingType', 'mainEnergy', 'dpeClass', 'dpeDate', 'gesClass', 'networks'],
  valuation:                ['estimatedValue', 'estimatedValueDate', 'estimatedValueMode', 'valuationSource', 'valuationDate'],
  vehicle_identification:   ['make', 'model', 'registrationNumber', 'vin', 'year'],
  vehicle_technical:        ['engine', 'fuelType', 'fiscalHp', 'powerKw', 'ptac', 'seats', 'firstRegistrationDate'],
  vehicle_usage:            ['vehicleOwnershipStatus', 'mileage', 'mileageUnit', 'mileageDate', 'primaryUse'],
  vehicle_insurance:        ['isInsured', 'insurer', 'insuranceExpiry', 'insuranceContractNumber', 'insuranceClientNumber', 'insurancePremium', 'nextInspection'],
  object_identification:    ['objectCategory', 'brand', 'modelName', 'serialNumber'],
  object_condition:         ['condition', 'dimensions', 'weight', 'accessories'],
  object_provenance:        ['acquisitionMode', 'provenance', 'authenticityProof'],
  object_usage:             ['primaryUse', 'storageLocation', 'lastRevision', 'isInsured'],
  insurance:                ['isInsured', 'insurer', 'insuranceContractNumber', 'insuranceClientNumber', 'insuranceExpiry', 'insurancePremium'],
};

// Champs atomiques écrits dans les colonnes dédiées de la table assets
const ATOMIC_FIELDS = new Set(['address1', 'address2', 'city', 'postalCode', 'registrationNumber']);

// Champs méta stockés dans keyCharacteristics mais jamais issus d'un bien distinct
const META_FIELDS = new Set(['coherenceAlerts', 'dismissedCoherenceAlerts', 'valuationHistory']);

// ─── Cache lru des allowedFieldSets par catégorie ─────────────────────────────

const allowedFieldSetCache = new Map<string, Set<string>>();

function getAllowedFieldSet(category: string): Set<string> {
  const cached = allowedFieldSetCache.get(category);
  if (cached) return cached;

  const family = category === 'IMMOBILIER' ? 'IMMOBILIER'
    : category === 'VEHICULE' ? 'VEHICULE'
    : 'OBJET';

  const sections = FAMILY_SECTIONS[family] ?? [];
  const set = new Set<string>();
  for (const sk of sections) {
    const fields = SECTION_FIELDS[sk] ?? [];
    for (const fk of fields) {
      set.add(fk);
    }
  }
  // Les champs atomiques sont toujours autorisés (écrits aussi en colonne)
  for (const af of ATOMIC_FIELDS) set.add(af);
  // Les champs méta sont toujours autorisés
  for (const mf of META_FIELDS) set.add(mf);

  allowedFieldSetCache.set(category, set);
  return set;
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Vérifie si un champ est autorisé pour une catégorie d'actif donnée.
 * `name` est toujours autorisé (colonne racine de la table assets).
 */
export function isFieldAllowedForCategory(fieldKey: string, category: string | null | undefined): boolean {
  if (!category) return true; // pas de catégorie → pas de validation possible
  if (fieldKey === 'name') return true;
  if (META_FIELDS.has(fieldKey)) return true;
  if (ATOMIC_FIELDS.has(fieldKey)) return true;
  return getAllowedFieldSet(category).has(fieldKey);
}

/**
 * Filtre un dictionnaire de champs pour ne garder que ceux autorisés
 * pour la catégorie donnée. Retourne les champs invalides dans un second tableau.
 */
export function filterAllowedFields(
  fields: Record<string, unknown>,
  category: string | null | undefined,
): { valid: Record<string, unknown>; rejected: string[] } {
  const valid: Record<string, unknown> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (isFieldAllowedForCategory(key, category)) {
      valid[key] = value;
    } else {
      rejected.push(key);
    }
  }

  return { valid, rejected };
}

/**
 * Récupère les sections applicables pour une catégorie donnée.
 */
export function getApplicableSections(category: string | null | undefined): string[] {
  if (!category) return [];
  const family = category === 'IMMOBILIER' ? 'IMMOBILIER'
    : category === 'VEHICULE' ? 'VEHICULE'
    : 'OBJET';
  return FAMILY_SECTIONS[family] ?? [];
}

/**
 * Récupère les champs autorisés pour une catégorie (sous forme de Set).
 */
export function getAllowedFieldsSet(category: string | null | undefined): Set<string> {
  if (!category) return new Set();
  return getAllowedFieldSet(category);
}