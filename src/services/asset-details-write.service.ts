/**
 * Écriture des caractéristiques d'un bien (sections de la fiche).
 *
 * Extrait de PATCH /api/assets/[id]/details/[section] pour que l'assistant
 * (commande UPDATE_ASSET_FIELD) passe par EXACTEMENT les mêmes règles que
 * l'interface : bien du compte, non archivé ni verrouillé, section
 * applicable à la famille, nom obligatoire, famille non modifiable, dates
 * valides, prochain contrôle technique non passé, colonnes atomiques,
 * alertes de cohérence levées, historique de valorisation, recontrôle T3.
 *
 * CDC 15 (lot 11, T3-01, T3-02, T3-05, T2-38) — FAÇADE de
 * `writeCanonicalAssetField` : les champs canoniques passent par la primitive
 * (origine USER ou ADMIN, `__updatedAt`, colonnes miroirs, journal), dans la
 * même transaction et sous le même verrou que le reste de la section (nom,
 * statut, catégorie, alertes, historique de valorisation). Lot 16b-3 :
 * commutateur `CANONICAL_WRITE_MODE` et chemins historique / observation
 * supprimés (comportement de l'ancien `enabled`).
 */
import { ASSET_STATUSES } from '@/lib/asset-status';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { normalizeAssetCategory } from '@/lib/asset-taxonomy';
import { validateDetailChanges, type DetailFieldError } from '@/lib/asset-detail-rules';
import { assetModificationDecision } from '@/lib/asset-quota-guard';
import { writeOrigin } from '@/services/ai/reconciliation/field-origin';
import { isExcludedKey, toAssetFamily, type AssetFamily } from '@/services/canonical/registry';
import {
  resolveDefForFamily, writeCanonicalAssetFields,
  type CanonicalFieldWrite, type CanonicalWriteSource,
} from '@/services/canonical/asset-state';

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

// Lot 32 (PO-Q11) : statuts officiels saisissables depuis la fiche (ARCHIVED
// relève du parcours d'archivage).
const VALID_STATUSES: readonly string[] = ASSET_STATUSES.filter((s) => s !== 'ARCHIVED');

export type AssetDetailsErrorCode =
  | 'NOT_FOUND' | 'ASSET_UNAVAILABLE' | 'SECTION_NOT_APPLICABLE' | 'VALIDATION_ERROR' | 'WRITE_BLOCKED'
  /** Mode enabled : la valeur en place n'est plus celle attendue (`expectedCurrent`). */
  | 'CONFLICT';

export class AssetDetailsError extends Error {
  constructor(
    public code: AssetDetailsErrorCode,
    message: string,
    public details: {
      reason?: 'ARCHIVED' | 'LOCKED_BY_PLAN';
      fields?: DetailFieldError[];
      /** Refus des droits (quota dépassé, compte restreint) — GAP-11. */
      writeBlocked?: { code: string; limit?: number };
    } = {},
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
  // Au-dessus du quota (changement d'offre) : consultation et export
  // conservés, modification suspendue — règle unique `lib/asset-quota-guard`.
  const decision = await assetModificationDecision(accountId);
  if (!decision.allowed) {
    throw new AssetDetailsError('WRITE_BLOCKED', decision.message ?? 'Modification non autorisée', {
      writeBlocked: { code: decision.reason ?? 'ASSET_QUOTA_EXCEEDED', limit: decision.limit },
    });
  }
  return assetRow;
}

/** Origine d'une écriture de la fiche : toujours humaine (T3-02). */
export type AssetDetailsOrigin = 'USER' | 'ADMIN';

export interface UpdateAssetDetailsInput {
  assetId: number;
  accountId: number;
  section: string;
  fields: Record<string, unknown>;
  /** USER par défaut ; ADMIN pour une correction du back-office. */
  origin?: AssetDetailsOrigin;
  actorUserId?: number | null;
  /** Provenance journalisée (défaut : `asset_details` / section). */
  source?: CanonicalWriteSource;
  traceId?: string | null;
  /**
   * Mode enabled : valeur attendue en place par champ, vérifiée SOUS VERROU
   * (`FOR UPDATE`) — écart → AssetDetailsError('CONFLICT'), rien n'est écrit.
   */
  expectedCurrent?: Record<string, unknown>;
  /**
   * Mode enabled : publier ASSET_UPDATED depuis la primitive. Faux par
   * défaut — la route PATCH publie déjà l'événement.
   */
  emitEvent?: boolean;
}

/** Champs portés par des colonnes d'identité, jamais par la fiche. */
const IDENTITY_KEYS = new Set(['name', 'subCategory', 'status']);

/** Clés de la section qui sont des champs canoniques applicables à la famille. */
export function canonicalWritesOf(fields: Record<string, unknown>, family: AssetFamily): CanonicalFieldWrite[] {
  const out: CanonicalFieldWrite[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (IDENTITY_KEYS.has(key) || isExcludedKey(key)) continue;
    const def = resolveDefForFamily(key, family);
    if (def && def.families.includes(family)) out.push({ key, value });
  }
  return out;
}

/**
 * Effets d'une modification manuelle sur la fiche : alertes de cohérence
 * levées pour les champs modifiés, historique de valorisation.
 */
function applyEditSideEffects(kc: Record<string, unknown>, fields: Record<string, unknown>, source: string): void {
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
      source,
      addedAt: new Date().toISOString(),
    });
    kc['valuationHistory'] = history;
  }
}

const texteDe = (v: unknown): string | null =>
  (v === null || v === undefined || v === '' ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** Colonnes SQL des champs atomiques hors registre (ex. immatriculation d'un objet). */
const ATOMIC_SQL_COLUMNS: Record<string, string> = {
  address: 'address', city: 'city', postalCode: 'postal_code', registrationNumber: 'registration_number',
};

export async function updateAssetDetails(p: UpdateAssetDetailsInput): Promise<{ updated: true; section: string }> {
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

  const family: AssetFamily = toAssetFamily(assetRow.category) ?? 'OBJECT';
  const origin: AssetDetailsOrigin = p.origin ?? 'USER';
  const source: CanonicalWriteSource = p.source ?? { type: 'asset_details', id: section };

  await writeSectionCanonical({ ...p, origin, source }, family);
  await fermerCartesSaisies(accountId, assetId, canonicalWritesOf(fields, family));
  await recontroleCoherence(accountId, assetId, fields);
  return { updated: true, section };
}

/**
 * Valeur saisie par l'utilisateur (§5.3, `USER_COMPLETED`) : les cartes
 * « À traiter » encore ouvertes sur ces champs (arbitrage, complétion) sont
 * résolues — la saisie dans le tiroir ou la fiche EST l'arbitrage. Sans
 * cela, la carte restait ouverte et l'assistant annonçait encore « à
 * arbitrer » (corpus §15 E2E-T2-23). Valeur vidée : rien n'est fermé. Ne
 * fait jamais échouer l'écriture (journalisé).
 */
async function fermerCartesSaisies(accountId: number, assetId: number, writes: CanonicalFieldWrite[]): Promise<void> {
  const saisies = writes.filter((w) => w.value !== null && w.value !== undefined && w.value !== '');
  if (saisies.length === 0) return;
  try {
    const { resolveActionsForData } = await import('@/services/to-process/to-process-action.service');
    for (const w of saisies) await resolveActionsForData(accountId, 'ASSET', assetId, w.key, 'USER_COMPLETED');
  } catch (e) {
    console.error(`[asset-details] cartes « À traiter » du bien ${assetId} :`, (e as Error).message);
  }
}

/**
 * Modification d'un bien : la cohérence globale du compte est recontrôlée
 * (T3), en différé et fusionnée avec les autres événements rapprochés —
 * SEULEMENT si un champ à impact de cohérence a changé (T3-004).
 */
async function recontroleCoherence(accountId: number, assetId: number, fields: Record<string, unknown>): Promise<void> {
  const { hasCoherenceImpact } = await import('@/services/ai/reconciliation/coherence-impact');
  if (await hasCoherenceImpact(accountId, assetId, Object.keys(fields))) {
    const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    notifyCoherenceEvent(accountId, { event: 'asset_updated', objectType: 'asset', objectId: assetId });
  }
}

/**
 * UNE transaction, ligne du bien verrouillée. Les champs
 * canoniques passent par la primitive ; le reste de la section (nom,
 * statut, catégorie, clés hors registre, alertes levées, historique de
 * valorisation) est appliqué dans le même `UPDATE` par le hook.
 */
async function writeSectionCanonical(
  p: UpdateAssetDetailsInput & { origin: AssetDetailsOrigin; source: CanonicalWriteSource },
  family: AssetFamily,
): Promise<void> {
  const { assetId, accountId, fields, origin } = p;
  const writes = canonicalWritesOf(fields, family).map((w) =>
    (p.expectedCurrent && w.key in p.expectedCurrent ? { ...w, expectedCurrent: p.expectedCurrent[w.key] } : w));
  const canoniques = new Set(writes.map((w) => w.key));
  const now = new Date().toISOString();

  const res = await writeCanonicalAssetFields({
    assetId, accountId, origin, actorUserId: p.actorUserId, source: p.source, traceId: p.traceId,
    writes, emitEvent: p.emitEvent ?? false,
  }, {
    keepRequestedKey: true,
    // Section entière : une valeur inchangée garde son origine (lot 13).
    confirmUnchanged: false,
    mutate: ({ row, kc, results }) => {
      // Relecture sous verrou : le bien a pu être archivé ou verrouillé.
      const lockState = row.lock_state as string | null | undefined;
      if (row.status === 'ARCHIVED' || (lockState && lockState !== 'NONE')) {
        const reason = row.status === 'ARCHIVED' ? 'ARCHIVED' : 'LOCKED_BY_PLAN';
        throw new AssetDetailsError('ASSET_UNAVAILABLE', reason === 'ARCHIVED'
          ? 'Ce bien est archivé.'
          : 'Ce bien est verrouillé par votre offre actuelle.', { reason });
      }
      const conflit = results.find((r) => r.outcome === 'conflict');
      if (conflit) {
        throw new AssetDetailsError('CONFLICT', `« ${conflit.requestedKey} » a été modifié entre-temps.`);
      }
      const invalid = results.filter((r) => r.outcome === 'invalid');
      if (invalid.length) {
        const errs = invalid.map((r) => ({ field: r.requestedKey, message: `Valeur invalide : ${r.reason ?? r.key}` }));
        throw new AssetDetailsError('VALIDATION_ERROR', errs.map((e) => e.message).join(' '), { fields: errs });
      }

      const columns: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (canoniques.has(key)) continue;
        if (key === 'name') {
          columns.name = String(value).trim();
        } else if (key === 'subCategory') {
          columns.subtype = value === '' || value === null ? null : normalizeAssetCategory(String(value));
        } else if (key === 'status') {
          if (typeof value === 'string' && VALID_STATUSES.includes(value)) columns.status = value;
        } else {
          // Clé hors registre : écrite telle quelle ; l'origine humaine n'est
          // posée que si la valeur change (section entière, lot 13).
          const inchangee = texteDe(kc[key]) === texteDe(value);
          kc[key] = value;
          if (!inchangee && !isExcludedKey(key) && !key.includes('__')) {
            // Remplacement complet : writeOrigin RETIRE des clés
            // (`_origin`, `__authority`, `__sourceDate`) qu'un Object.assign garderait.
            const next = writeOrigin(kc, key, origin, { updatedAt: now });
            for (const k of Object.keys(kc)) delete kc[k];
            Object.assign(kc, next);
          }
          if (key in ATOMIC_FIELDS) columns[ATOMIC_SQL_COLUMNS[ATOMIC_FIELDS[key]]] = value;
        }
      }
      applyEditSideEffects(kc, fields, origin);
      return columns;
    },
  });
  if (res.notFound) throw new AssetDetailsError('NOT_FOUND', 'Asset not found');
}
