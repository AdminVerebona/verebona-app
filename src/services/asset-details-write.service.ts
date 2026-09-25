/**
 * Écriture des caractéristiques d'un bien (sections de la fiche).
 *
 * Extrait de PATCH /api/assets/[id]/details/[section] pour que l'assistant
 * (commande UPDATE_ASSET_FIELD) passe par EXACTEMENT les mêmes règles que
 * l'interface : bien du compte, non archivé ni verrouillé, section
 * applicable à la famille, nom obligatoire, famille non modifiable, dates
 * valides, prochain contrôle technique non passé, colonnes atomiques,
 * alertes de cohérence levées, historique de valorisation, recontrôle T3.
 */
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { normalizeAssetCategory } from '@/lib/asset-taxonomy';
import { validateDetailChanges, type DetailFieldError } from '@/lib/asset-detail-rules';

export const ALL_DETAIL_SECTIONS = [
  'common',
  'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical',
  'valuation',
  'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance',
  'object_identification', 'object_condition', 'object_provenance', 'object_usage',
  'insurance',
];

const IMMOBILIER_SECTIONS = ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation', 'insurance'];
const VEHICULE_SECTIONS = ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'];
const OBJET_SECTIONS = ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation', 'insurance'];

export function familySections(category: string): string[] {
  if (category === 'IMMOBILIER') return IMMOBILIER_SECTIONS;
  if (category === 'VEHICULE') return VEHICULE_SECTIONS;
  return OBJET_SECTIONS;
}

// Atomic fields that must be written to both column and JSON
const ATOMIC_FIELDS: Record<string, string> = {
  address1: 'address',
  city: 'city',
  postalCode: 'postalCode',
  registrationNumber: 'registrationNumber',
};

const VALID_STATUSES = ['EN_SERVICE', 'EN_PANNE', 'EN_REPARATION', 'VENDU', 'DETRUIT', 'INACTIF', 'TRANSMIS'];

export type AssetDetailsErrorCode =
  | 'NOT_FOUND' | 'ASSET_UNAVAILABLE' | 'SECTION_NOT_APPLICABLE' | 'VALIDATION_ERROR';

export class AssetDetailsError extends Error {
  constructor(
    public code: AssetDetailsErrorCode,
    message: string,
    public details: { reason?: 'ARCHIVED' | 'LOCKED_BY_PLAN'; fields?: DetailFieldError[] } = {},
  ) {
    super(message);
    this.name = 'AssetDetailsError';
  }
}

export interface AssetDetailsRow {
  id: number;
  name: string;
  category: string;
  status: string | null;
  lockState: string | null;
  keyCharacteristics: string | null;
}

export function parseKeyCharacteristics(raw: string | null | undefined): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

/** Bien du compte, modifiable — sinon AssetDetailsError. */
export async function loadWritableAsset(assetId: number, accountId: number) {
  const [assetRow] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)))
    .limit(1);
  if (!assetRow) throw new AssetDetailsError('NOT_FOUND', 'Asset not found');
  if (assetRow.status === 'ARCHIVED' || (assetRow.lockState && assetRow.lockState !== 'NONE')) {
    const reason = assetRow.status === 'ARCHIVED' ? 'ARCHIVED' : 'LOCKED_BY_PLAN';
    throw new AssetDetailsError('ASSET_UNAVAILABLE', reason === 'ARCHIVED'
      ? 'Ce bien est archivé.'
      : 'Ce bien est verrouillé par votre offre actuelle.', { reason });
  }
  return assetRow;
}

export async function updateAssetDetails(p: {
  assetId: number;
  accountId: number;
  section: string;
  fields: Record<string, unknown>;
}): Promise<{ updated: true; section: string }> {
  const { assetId, accountId, section, fields } = p;
  if (!ALL_DETAIL_SECTIONS.includes(section)) {
    throw new AssetDetailsError('NOT_FOUND', `Section unknown: ${section}`);
  }

  const assetRow = await loadWritableAsset(assetId, accountId);

  if (!familySections(assetRow.category).includes(section)) {
    throw new AssetDetailsError('SECTION_NOT_APPLICABLE', 'Cette section ne s’applique pas à ce bien.');
  }

  // Validate: name cannot be null
  if ('name' in fields && (fields.name === null || fields.name === '')) {
    throw new AssetDetailsError('VALIDATION_ERROR', 'Name is required', {
      fields: [{ field: 'name', message: 'Name is required' }],
    });
  }

  // category is not modifiable via PATCH /details; subtype is allowed via subCategory alias
  if ('category' in fields || 'subtype' in fields) {
    throw new AssetDetailsError('VALIDATION_ERROR', 'Cannot change family/subtype via this endpoint', {
      fields: [{ field: 'category/subtype', message: 'Cannot change family/subtype via this endpoint' }],
    });
  }

  // Parse existing keyCharacteristics
  const kc = parseKeyCharacteristics(assetRow.keyCharacteristics);

  // Mêmes règles que l'écran (dates valides, contrôle technique à venir),
  // sur les seules valeurs modifiées.
  const invalid = validateDetailChanges(fields, kc);
  if (invalid.length) {
    throw new AssetDetailsError('VALIDATION_ERROR', invalid.map((e) => e.message).join(' '), { fields: invalid });
  }

  // Deep merge fields into kc
  const atomicUpdates: Record<string, unknown> = {};
  let nameUpdate: string | undefined;
  let statusUpdate: string | undefined;
  let subCategoryUpdate: string | null | undefined;

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'name') {
      nameUpdate = String(value).trim();
    } else if (key === 'subCategory') {
      subCategoryUpdate = value === '' || value === null ? null : normalizeAssetCategory(String(value));
    } else if (key === 'status') {
      if (typeof value === 'string' && VALID_STATUSES.includes(value)) {
        statusUpdate = value;
      }
    } else if (key in ATOMIC_FIELDS) {
      const colKey = ATOMIC_FIELDS[key];
      atomicUpdates[colKey] = value;
      kc[key] = value; // also keep in JSON for redundancy
    } else {
      kc[key] = value;
    }
  }

  // If any field was manually edited, clear its dismissedCoherenceAlerts entry
  // and remove the corresponding coherence alert
  const editedFields = Object.keys(fields);
  const dismissedFields: string[] = Array.isArray(kc.dismissedCoherenceAlerts)
    ? kc.dismissedCoherenceAlerts as string[]
    : [];
  const remainingDismissed = dismissedFields.filter(f => !editedFields.includes(f));
  if (remainingDismissed.length !== dismissedFields.length) {
    kc.dismissedCoherenceAlerts = remainingDismissed;
  }
  // Also remove coherence alerts for the edited fields
  const alerts = Array.isArray(kc.coherenceAlerts)
    ? (kc.coherenceAlerts as Array<{ field: string }>).filter(a => !editedFields.includes(a.field))
    : [];
  if (alerts.length !== (Array.isArray(kc.coherenceAlerts) ? kc.coherenceAlerts.length : 0)) {
    kc.coherenceAlerts = alerts;
  }

  // If any valuation fields changed, push a new entry to valuationHistory
  const VALUATION_FIELDS = ['estimatedValue', 'estimatedValueDate', 'estimatedValueMode'] as const;
  const valuationChanged = VALUATION_FIELDS.some(f => f in fields);
  if (valuationChanged && (kc['estimatedValue'] != null || kc['estimatedValueDate'] != null)) {
    const history: unknown[] = Array.isArray(kc['valuationHistory']) ? kc['valuationHistory'] as unknown[] : [];
    history.push({
      id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      value: kc['estimatedValue'] ?? null,
      date: kc['estimatedValueDate'] ?? null,
      mode: kc['estimatedValueMode'] ?? null,
      source: 'USER',
      addedAt: new Date().toISOString(),
    });
    kc['valuationHistory'] = history;
  }

  const updatePayload: Record<string, unknown> = {
    keyCharacteristics: JSON.stringify(kc),
    updatedAt: new Date(),
  };
  if (nameUpdate !== undefined) updatePayload.name = nameUpdate;
  if (statusUpdate !== undefined) updatePayload.status = statusUpdate;
  if (atomicUpdates.address !== undefined) updatePayload.address = atomicUpdates.address;
  if (atomicUpdates.city !== undefined) updatePayload.city = atomicUpdates.city;
  if (atomicUpdates.postalCode !== undefined) updatePayload.postalCode = atomicUpdates.postalCode;
  if (atomicUpdates.registrationNumber !== undefined) updatePayload.registrationNumber = atomicUpdates.registrationNumber;
  if (subCategoryUpdate !== undefined) updatePayload.subtype = subCategoryUpdate;

  await db.update(assets)
    .set(updatePayload as never)
    .where(eq(assets.id, assetId));

  // Modification d'un bien : la cohérence globale du compte est recontrôlée
  // (T3), en différé et fusionnée avec les autres événements rapprochés.
  const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
  notifyCoherenceEvent(accountId, { event: 'asset_updated', objectType: 'asset', objectId: assetId });

  return { updated: true, section };
}
