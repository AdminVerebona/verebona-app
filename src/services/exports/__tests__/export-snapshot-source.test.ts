/**
 * X-02 (arbitrage lot 16) — export brut, transmission et aperçu admin :
 * snapshot canonique (champs, sections détaillées, pièces) et branchement des
 * trois chemins. Lot 16b-3 : `EXPORTS_CANONICAL_SOURCE`, le mode observation
 * et le calcul d'écarts supprimés — source canonique seule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { canonicalAssetSnapshot } from '../export-snapshot-source';
import { buildCanonicalAssetState, type AssetRowJson } from '@/services/canonical/asset-state';
import type { AssetSnapshot, DocumentRef } from '@/services/export-snapshot.service';

const docRef = (id: number): DocumentRef => ({
  id, s3Key: null, s3Bucket: null, originalFilename: null, documentType: 'AUTRE', documentDate: null, description: null,
  retainedTitle: null, retainedFunctionCode: null, cilRubricCodes: null, mimeType: null, size: null, isWebLink: false,
  webLinkUrl: null, webLinkTitle: null, substructureId: null, equipmentId: null,
});

const legacy = (): AssetSnapshot => ({
  id: 5, name: 'Maison', category: 'IMMOBILIER', subtype: null, status: 'ACTIVE', purchaseDate: '2019-01-01', purchasePriceCents: 1_000_000,
  estimatedValueCents: null, generalCondition: null, notes: null, warrantyEndDate: null, mileageOrHours: null, lastMaintenanceDate: null,
  registrationNumber: null, address: '1 rue Colonne', city: 'Lyon', postalCode: '69001', thumbnailUrl: null, description: null,
  keyCharacteristics: { adresse: '2 rue Fiche', acquisitionDate: '2021-05-25', 'acquisitionDate__origin': 'USER' },
  detailSections: { family: 'IMMOBILIER' }, equipmentList: [], documents: [docRef(1), docRef(2)], photos: [], substructures: [],
  equipments: [], events: [], snapshotAt: '2026-09-30T00:00:00Z',
});

const row = (): AssetRowJson => ({
  id: 5, account_id: 9, category: 'IMMOBILIER', address: '1 rue Colonne', city: 'Lyon', postal_code: '69001',
  purchase_date: '2019-01-01', purchase_price_cents: 1_000_000,
  key_characteristics: JSON.stringify(legacy().keyCharacteristics),
} as AssetRowJson);

describe('snapshot canonique des autres chemins d’export', () => {
  it('champs lus dans la fiche canonique ; sections détaillées recalculées ; pièces fournies', () => {
    const r = row();
    const c = canonicalAssetSnapshot(legacy(), r, buildCanonicalAssetState(r), [docRef(1), docRef(3)]);
    expect(c.purchaseDate).toBe('2021-05-25');
    expect(c.address).toBe('2 rue Fiche');
    expect(c.keyCharacteristics).toMatchObject({ address1: '2 rue Fiche', acquisitionDate: '2021-05-25' });
    expect(c.keyCharacteristics).not.toHaveProperty('adresse');
    expect(c.detailSections.location_identification?.address1).toBe('2 rue Fiche');
    expect(c.detailSections.common?.acquisitionDate).toBe('2021-05-25');
    expect(c.documents.map((d) => d.id)).toEqual([1, 3]);
  });
});

describe('les trois chemins lisent la source canonique (lot 16b-3)', () => {
  const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it.each([
    ['src/app/api/assets/[id]/exports/route.ts', 'EXPORT_BRUT'],
    ['src/app/api/assets/[id]/transmission/route.ts', 'TRANSMISSION'],
    ['src/services/admin/export-preview.service.ts', 'ADMIN_PREVIEW'],
  ])('%s → buildExportAssetSnapshot(…, %s), plus d’appel direct à buildAssetSnapshot', (fichier, contexte) => {
    const src = lire(fichier);
    expect(src).toContain(`'${contexte}')`);
    expect(src).toMatch(/buildExportAssetSnapshot\(/);
    expect(src).not.toMatch(/\bbuildAssetSnapshot\(/);
  });
});
