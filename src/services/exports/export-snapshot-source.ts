/**
 * Snapshot de bien des AUTRES chemins d'export — export brut (EXPORT_BRUT,
 * `api/assets/[id]/exports`), transmission (`api/assets/[id]/transmission`)
 * et aperçu admin (`services/admin/export-preview.service`) — sous le
 * commutateur `EXPORTS_CANONICAL_SOURCE` (CDC 15 X-02, arbitrage lot 16).
 *
 * Même règle que les dossiers V12 (`v12/data/source.ts`) :
 *   · legacy  : `buildAssetSnapshot` historique, strictement inchangé ;
 *   · shadow  : snapshot historique UTILISÉ ; version canonique calculée en
 *               plus (3 à 4 requêtes, aucun rendu), rapport d'écarts SANS
 *               VALEUR journalisé (`[exports:canonical-shadow]`) ; un échec
 *               du calcul canonique n'affecte jamais l'export ;
 *   · enabled : champs du bien lus dans `CanonicalAssetView` (colonnes,
 *               `keyCharacteristics`, sections détaillées recalculées), pièces
 *               par la relation N-N avec repli colonnes (`loadCanonicalDocuments`,
 *               MENTIONED exclus, PROPOSED exclus). Relecture lot 16 : ces
 *               trois chemins n'ont pas d'étape de choix — les pièces au
 *               rattachement NON CONFIRMÉ (lien SECONDARY AI,
 *               `linked_asset_id` / `linked_room_id`, voir
 *               `isConfirmedAttachment`) en sont EXCLUES.
 * Photos, pièces de la maison, équipements et historique (`events`) :
 * identiques dans les deux sources. `dataSource` trace la source utilisée.
 */
import { pgClient } from '@/db';
import { buildAssetSnapshot, buildDetailSections, type AssetSnapshot } from '@/services/export-snapshot.service';
import { isEmptyValue } from '@/services/canonical/asset-state';
import {
  buildCanonicalAssetState, canonicalAssetScalars, canonicalCharacteristics, exportsSourceMode, loadAssetRow,
  loadCanonicalDocuments, sameExportValue, traceOf, type CanonicalAssetScalars, type CanonicalAssetState, type DocumentPath,
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

const SCALARS = [
  'purchaseDate', 'purchasePriceCents', 'estimatedValueCents', 'warrantyEndDate', 'mileageOrHours', 'lastMaintenanceDate',
  'registrationNumber', 'address', 'postalCode', 'city', 'generalCondition', 'notes', 'description',
] as const;

/** Écarts entre snapshots (pure, testée) — noms et identifiants seulement. */
export function diffAssetSnapshots(legacy: AssetSnapshot, canonical: AssetSnapshot, paths: Record<number, DocumentPath[]> = {}, unconfirmed: number[] = []) {
  const fields: string[] = SCALARS.filter((k) => !sameExportValue(legacy[k], canonical[k])).map((k) => `asset.${k}`);
  const cles = new Set([...Object.keys(legacy.keyCharacteristics), ...Object.keys(canonical.keyCharacteristics)]);
  for (const k of [...cles].sort()) {
    if (k.includes('__') || /_origin$/.test(k)) continue;
    if (!sameExportValue(legacy.keyCharacteristics[k], canonical.keyCharacteristics[k])) fields.push(`keyCharacteristics.${k}`);
  }
  const idsL = new Set(legacy.documents.map((d) => d.id));
  const idsC = new Set(canonical.documents.map((d) => d.id));
  const onlyLegacy = [...idsL].filter((id) => !idsC.has(id)).sort((a, b) => a - b);
  const onlyCanonical = [...idsC].filter((id) => !idsL.has(id)).sort((a, b) => a - b)
    .map((id) => ({ id, paths: paths[id] ?? [], confirmed: !unconfirmed.includes(id) }));
  // « Ajoutés en canonique », comptés explicitement : les non confirmés ne
  // partiraient PAS en enabled (exclus faute d'étape de choix).
  const addedInCanonical = {
    confirmed: onlyCanonical.filter((d) => d.confirmed).length,
    unconfirmed: onlyCanonical.filter((d) => !d.confirmed).length,
  };
  return { fields, documents: { onlyLegacy, onlyCanonical, addedInCanonical }, total: fields.length + onlyLegacy.length + onlyCanonical.length };
}

export type ExportSnapshotContext = 'EXPORT_BRUT' | 'TRANSMISSION' | 'ADMIN_PREVIEW';

/**
 * Snapshot d'un bien pour un export hors dossiers V12, selon le commutateur.
 * Mêmes paramètres que `buildAssetSnapshot` (le contrôle d'accès reste le
 * sien : compte ou propriétaire), plus le chemin appelant (journal).
 */
export async function buildExportAssetSnapshot(
  assetId: number,
  userId: number,
  scope: { accountId: number } | undefined,
  context: ExportSnapshotContext,
): Promise<AssetSnapshot> {
  const mode = exportsSourceMode();
  const legacy = await buildAssetSnapshot(assetId, userId, scope);
  // legacy : le snapshot historique tel quel, sans aucun ajout (absence de `dataSource` = historique).
  if (mode === 'legacy') return legacy;

  const canonique = async () => {
    // Compte du bien : `buildAssetSnapshot` a déjà vérifié l'accès (compte ou propriétaire).
    const accountId = scope?.accountId ?? Number(((await pgClient.unsafe(
      'SELECT account_id FROM assets WHERE id = $1', [assetId] as never[],
    )) as unknown as Array<{ account_id: number }>)[0]?.account_id);
    const row = await loadAssetRow(pgClient as never, assetId, accountId);
    if (!row) throw new Error(`Bien ${assetId} introuvable pour le compte ${accountId}`);
    const docs = await loadCanonicalDocuments(accountId, assetId);
    return { snapshot: canonicalAssetSnapshot(legacy, row, buildCanonicalAssetState(row), docs.documents), paths: docs.paths, unconfirmed: docs.unconfirmed, accountId };
  };

  if (mode === 'enabled') {
    const c = await canonique();
    // Sans étape de choix : rattachements non confirmés exclus.
    const envoyes = c.snapshot.documents.filter((d) => !c.unconfirmed.includes(d.id));
    return { ...c.snapshot, documents: envoyes, dataSource: traceOf(mode, 'canonical', { documentPaths: c.paths, unconfirmedDocuments: c.unconfirmed }) };
  }
  try {
    const c = await canonique();
    const diff = diffAssetSnapshots(legacy, c.snapshot, c.paths, c.unconfirmed);
    console.info('[exports:canonical-shadow]', JSON.stringify({ context, assetId, accountId: c.accountId, ...diff }));
    return {
      ...legacy,
      dataSource: traceOf(mode, 'legacy', {
        shadowDiff: {
          fields: diff.fields.length, documentsOnlyLegacy: diff.documents.onlyLegacy.length, documentsOnlyCanonical: diff.documents.onlyCanonical.length, events: 0,
          addedConfirmed: diff.documents.addedInCanonical.confirmed, addedUnconfirmed: diff.documents.addedInCanonical.unconfirmed,
        },
      }),
    };
  } catch (err) {
    console.warn('[exports:canonical-shadow] calcul canonique en échec', { context, assetId, error: err instanceof Error ? err.message : String(err) });
    return { ...legacy, dataSource: traceOf(mode, 'legacy', { shadowDiff: { fields: 0, documentsOnlyLegacy: 0, documentsOnlyCanonical: 0, events: 0, failed: true } }) };
  }
}
