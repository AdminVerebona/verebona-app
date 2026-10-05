/**
 * Snapshot de bien des AUTRES chemins d'export — export brut (EXPORT_BRUT,
 * `api/assets/[id]/exports`), transmission (`api/assets/[id]/transmission`)
 * et aperçu admin (`services/admin/export-preview.service`) — source
 * canonique (CDC 15 X-02, arbitrage lot 16), comme les dossiers V12
 * (`v12/data/source.ts`). Lot 16b-3 : commutateur `EXPORTS_CANONICAL_SOURCE`
 * et mode d'observation (rapport d'écarts) supprimés.
 *
 * Champs du bien lus dans `CanonicalAssetView` (colonnes,
 * `keyCharacteristics`, sections détaillées recalculées), pièces par la
 * relation N-N avec repli colonnes (`loadCanonicalDocuments`, MENTIONED
 * exclus, PROPOSED exclus). Relecture lot 16 : ces trois chemins n'ont pas
 * d'étape de choix — les pièces au rattachement NON CONFIRMÉ (lien SECONDARY
 * AI, `linked_asset_id` / `linked_room_id`, voir `isConfirmedAttachment`) en
 * sont EXCLUES. Photos, pièces de la maison, équipements et historique
 * (`events`) : ceux du snapshot de base. `dataSource` trace la source.
 */
import { pgClient } from '@/db';
import { buildAssetSnapshot, buildDetailSections, type AssetSnapshot } from '@/services/export-snapshot.service';
import { isEmptyValue } from '@/services/canonical/asset-state';
import {
  buildCanonicalAssetState, canonicalAssetScalars, canonicalCharacteristics, loadAssetRow,
  loadCanonicalDocuments, traceOf, type CanonicalAssetScalars, type CanonicalAssetState,
} from './v12/data/canonical-source';

const eurCents = (v: unknown): number | null => {
  if (isEmptyValue(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Snapshot canonique construit SUR le snapshot historique (pure pour les
 * champs, testée) : scalaires, caractéristiques et sections détaillées lus
 * dans la vue canonique ; pièces fournies par l'appelant.
 */
export function canonicalAssetSnapshot(
  legacy: AssetSnapshot,
  row: Parameters<typeof canonicalCharacteristics>[0],
  state: CanonicalAssetState,
  documents: AssetSnapshot['documents'],
): AssetSnapshot {
  const base: CanonicalAssetScalars = {
    purchaseDate: legacy.purchaseDate, purchasePriceCents: legacy.purchasePriceCents, warrantyEndDate: legacy.warrantyEndDate,
    mileageOrHours: legacy.mileageOrHours, registrationNumber: legacy.registrationNumber, dimensions: null, engineInfo: null,
    purchaseLocation: null, address: legacy.address, postalCode: legacy.postalCode, city: legacy.city,
    generalCondition: legacy.generalCondition, objectCategory: null, description: legacy.description,
  };
  const s = canonicalAssetScalars(state, base);
  const kc = canonicalCharacteristics(row, state);
  const f = state.fields;
  const notes = isEmptyValue(f.notes?.value) ? null : String(f.notes!.value);
  const lastMaintenanceDate = isEmptyValue(f.lastRevision?.value) ? legacy.lastMaintenanceDate : String(f.lastRevision!.value).slice(0, 10);
  const estimatedValueCents = f.estimatedValue ? eurCents(f.estimatedValue.value) : null;
  return {
    ...legacy,
    purchaseDate: s.purchaseDate, purchasePriceCents: s.purchasePriceCents, warrantyEndDate: s.warrantyEndDate,
    mileageOrHours: s.mileageOrHours, registrationNumber: s.registrationNumber, address: s.address, postalCode: s.postalCode,
    city: s.city, generalCondition: s.generalCondition, description: s.description,
    notes, lastMaintenanceDate, estimatedValueCents,
    keyCharacteristics: kc,
    detailSections: buildDetailSections(kc, {
      category: legacy.category, name: legacy.name, address: s.address, postalCode: s.postalCode, city: s.city,
      registrationNumber: s.registrationNumber, generalCondition: s.generalCondition, mileageOrHours: s.mileageOrHours, notes,
    }),
    documents,
  };
}

export type ExportSnapshotContext = 'EXPORT_BRUT' | 'TRANSMISSION' | 'ADMIN_PREVIEW';

/**
 * Snapshot d'un bien pour un export hors dossiers V12 (source canonique).
 * Mêmes paramètres que `buildAssetSnapshot` (le contrôle d'accès reste le
 * sien : compte ou propriétaire), plus le chemin appelant.
 */
export async function buildExportAssetSnapshot(
  assetId: number,
  userId: number,
  scope: { accountId: number } | undefined,
  context: ExportSnapshotContext,
): Promise<AssetSnapshot> {
  const legacy = await buildAssetSnapshot(assetId, userId, scope);
  // Compte du bien : `buildAssetSnapshot` a déjà vérifié l'accès (compte ou propriétaire).
  const accountId = scope?.accountId ?? Number(((await pgClient.unsafe(
    'SELECT account_id FROM assets WHERE id = $1', [assetId] as never[],
  )) as unknown as Array<{ account_id: number }>)[0]?.account_id);
  const row = await loadAssetRow(pgClient as never, assetId, accountId);
  if (!row) throw new Error(`Bien ${assetId} introuvable pour le compte ${accountId} (export ${context})`);
  const docs = await loadCanonicalDocuments(accountId, assetId);
  const snapshot = canonicalAssetSnapshot(legacy, row, buildCanonicalAssetState(row), docs.documents);
  // Sans étape de choix : rattachements non confirmés exclus.
  const envoyes = snapshot.documents.filter((d) => !docs.unconfirmed.includes(d.id));
  return { ...snapshot, documents: envoyes, dataSource: traceOf('canonical', { documentPaths: docs.paths, unconfirmedDocuments: docs.unconfirmed }) };
}
