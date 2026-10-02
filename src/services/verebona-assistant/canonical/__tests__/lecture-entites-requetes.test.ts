/**
 * Lecture des équipements / pièces sans N+1 (relecture lot 18) : pour un bien,
 * une requête pour les fiches, une pour les preuves, quel que soit le nombre
 * de champs lus dans la demande ; même règle pour les exports.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string) => {
    db.calls.push(sql);
    if (sql.includes('FROM equipments x') && sql.includes('UNION ALL')) {
      return [
        { type: 'EQUIPMENT', id: 4, assetId: 3, accountId: 7, name: 'Chaudière', hasSpecs: true,
          kc: { warrantyEndDate: '2031-03-01', warrantyEndDate__origin: 'RECONCILIATION' },
          cols: { 'equipment_cil_specs.serial_number': 'SN-77', 'equipments.purchase_price_cents': 189900 } },
        { type: 'EQUIPMENT', id: 5, assetId: 3, accountId: 7, name: 'Ballon', hasSpecs: false, kc: {}, cols: { 'equipment_cil_specs.serial_number': 'B-1' } },
        { type: 'ROOM', id: 9, assetId: 3, accountId: 7, name: 'Salon', hasSpecs: false, kc: {}, cols: { 'substructures.area': '18.5' } },
      ];
    }
    if (sql.includes('FROM field_evidence e')) {
      return [{
        id: 31, accountId: 7, assetId: 1 /* bien porteur d'origine : équipement déplacé */, fieldKey: 'warrantyEndDate',
        valueJson: '2031-03-01', sourceType: 'document', sourceId: 40, evidenceExcerpt: 'Garantie : 01/03/2031',
        evidenceOrigin: 'TEXT_EXTRACTION', documentDate: '2024-05-02', confidence: 'certain', authorityScore: 80,
        status: 'active', extractedAt: '2024-05-02', targetType: 'EQUIPMENT', targetEntityId: 4, documentTitle: 'Facture',
      }];
    }
    return [];
  });
  return { db: {}, pgClient: { unsafe } };
});

const { readCanonicalField, EntityReadCache } = await import('../field-reader');
const es = await import('@/services/canonical/entity-state');
const { __resetCanonicalColumnsForTests } = await import('@/services/ai/evidence/canonical-columns');
const { canonicalEquipments } = await import('@/services/exports/v12/data/canonical-source');

const etatBien = { assetId: 3, accountId: 7, family: 'IMMOBILIER' as const, category: 'IMMOBILIER', fields: {}, assetUpdatedAt: null };
const entites = () => db.calls.filter((q) => q.includes('FROM equipments x')).length;
const preuves = () => db.calls.filter((q) => q.includes('FROM field_evidence e')).length;

beforeEach(() => {
  db.calls = [];
  es.__resetEntityColumnsForTests(true);
  __resetCanonicalColumnsForTests(true);
});

describe('assistant : cache par demande', () => {
  it('trois champs lus : une requête de fiches, une de preuves ; preuve lue par cible (bien porteur ignoré)', async () => {
    const entityCache = new EntityReadCache();
    const lus = [];
    for (const k of ['serialNumber', 'warrantyEndDate', 'acquisitionPrice']) {
      lus.push(await readCanonicalField(7, 3, k, { state: etatBien, assetName: 'Maison', entityCache }));
    }
    expect(entites()).toBe(1);
    expect(preuves()).toBe(1);
    expect(lus[0]?.entities?.map((e) => [e.entityName, e.value])).toEqual([['Chaudière', 'SN-77'], ['Ballon', 'B-1']]);
    expect(lus[1]?.entities?.[0]).toMatchObject({ value: '2031-03-01', evidence: { evidenceId: 31, fileId: 40, documentTitle: 'Facture' } });
    expect(lus[2]?.entities?.[0]).toMatchObject({ value: 1899, origin: 'USER', from: 'column' });
  });

  it('sans cache fourni : un cache local par lecture (deux requêtes par lecture)', async () => {
    await readCanonicalField(7, 3, 'serialNumber', { state: etatBien, assetName: 'Maison' });
    await readCanonicalField(7, 3, 'roomArea', { state: etatBien, assetName: 'Maison' });
    expect([entites(), preuves()]).toEqual([2, 2]);
  });
});

describe('exports : deux requêtes pour tout le dossier, aucun extrait', () => {
  it('fiches et preuves groupées ; référence de preuve sans extrait', async () => {
    const liste = [4, 5].map((id) => ({ id, name: `E${id}`, type: null, category: null, brand: null, model: null, energyType: null }));
    const out = await canonicalEquipments(7, 3, liste);
    expect(entites()).toBe(1);
    expect(preuves()).toBe(1);
    const garantie = out[0].fields!.find((f) => f.key === 'warrantyEndDate')!;
    expect(garantie).toEqual({
      key: 'warrantyEndDate', label: 'Fin de garantie', value: '2031-03-01', origin: 'RECONCILIATION',
      evidence: { evidenceId: 31, fileId: 40, documentDate: '2024-05-02' },
    });
    expect(JSON.stringify(out)).not.toContain('Garantie : 01/03/2031');
  });
});
