/**
 * Façade `updateAssetDetails` selon CANONICAL_WRITE_MODE (CDC 15, lot 11).
 *
 * legacy (variable absente) : comportement du lot 10 à l'identique — même
 * UPDATE Drizzle, aucune requête SQL brute nouvelle, aucun événement.
 * shadow : l'observation ne retarde pas la requête (lecture bornée, non attendue).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  unsafe: vi.fn(),
  begin: vi.fn(),
  emit: vi.fn(async () => {}),
}));

vi.mock('@/db', () => {
  const chain = {
    from: () => chain, where: () => chain,
    limit: async () => (h.row ? [h.row] : []),
  };
  return {
    db: {
      select: () => chain,
      update: () => ({ set: (p: Record<string, unknown>) => ({ where: async () => { h.updates.push(p); } }) }),
    },
    pgClient: { unsafe: h.unsafe, begin: h.begin },
  };
});
vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: h.emit }));

const { updateAssetDetails, canonicalWritesOf } = await import('../asset-details-write.service');

const modeInitial = process.env.CANONICAL_WRITE_MODE;
beforeEach(() => {
  h.row = {
    id: 1, accountId: 7, name: 'Clio', category: 'VEHICULE', status: 'EN_SERVICE', lockState: 'NONE',
    keyCharacteristics: JSON.stringify({ mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION', coherenceAlerts: [{ field: 'mileage' }] }),
  };
  h.updates = [];
  h.unsafe.mockReset();
  h.begin.mockReset();
  h.emit.mockClear();
});
afterEach(() => {
  if (modeInitial === undefined) delete process.env.CANONICAL_WRITE_MODE;
  else process.env.CANONICAL_WRITE_MODE = modeInitial;
});

describe('relecture lot 13 — seules les clés MODIFIÉES deviennent USER', () => {
  it('legacy : section entière renvoyée sans modification → aucune origine changée', async () => {
    h.row = { ...h.row!, keyCharacteristics: JSON.stringify({ mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION', vin: 'VF1', vin__origin: 'RECONCILIATION' }) };
    await updateAssetDetails({ assetId: 1, accountId: 7, section: 'vehicle_identification', fields: { mileage: '1 000', vin: 'VF1' } });
    const kc = JSON.parse(h.updates[0].keyCharacteristics as string);
    expect(kc).toMatchObject({ mileage__origin: 'DOCUMENT_EXTRACTION', vin__origin: 'RECONCILIATION' });
    expect(kc).not.toHaveProperty('mileage__updatedAt');
  });

  it('legacy : une seule clé modifiée → seule elle devient USER', async () => {
    h.row = { ...h.row!, keyCharacteristics: JSON.stringify({ mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION', vin: 'VF1', vin__origin: 'RECONCILIATION' }) };
    await updateAssetDetails({ assetId: 1, accountId: 7, section: 'vehicle_identification', fields: { mileage: 1000, vin: 'VF2' } });
    const kc = JSON.parse(h.updates[0].keyCharacteristics as string);
    expect(kc).toMatchObject({ mileage__origin: 'DOCUMENT_EXTRACTION', vin: 'VF2', vin__origin: 'USER', vin__updatedAt: expect.any(String) });
  });

  it('changedFields : comparaison normalisée du registre, texte sinon', async () => {
    const { changedFields } = await import('../asset-details-write.service');
    const avant = { acquisitionPrice: 749, 'x.y': 'a', purchasePrice: 10 };
    expect(changedFields({ acquisitionPrice: '749,00 €', 'x.y': 'a' }, avant, 'VEHICULE')).toEqual({});
    expect(changedFields({ acquisitionPrice: '750', 'x.y': 'b' }, avant, 'VEHICULE')).toEqual({ acquisitionPrice: '750', 'x.y': 'b' });
  });
});

describe('updateAssetDetails — modes', () => {
  it('variable absente (legacy) : UPDATE du lot 10 + origine humaine (T3-02, lot 13), aucune requête ni événement nouveaux', async () => {
    delete process.env.CANONICAL_WRITE_MODE;
    const r = await updateAssetDetails({
      assetId: 1, accountId: 7, section: 'vehicle_identification',
      fields: { registrationNumber: 'ab-1', mileage: '2000', name: ' Clio 2 ' }, actorUserId: 3,
    });
    expect(r).toEqual({ updated: true, section: 'vehicle_identification' });
    expect(h.unsafe).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(1);
    const { keyCharacteristics, updatedAt, ...cols } = h.updates[0];
    expect(updatedAt).toBeInstanceOf(Date);
    expect(cols).toEqual({ name: 'Clio 2', registrationNumber: 'ab-1' });
    // Valeurs brutes et alerte levée comme au lot 10 ; CDC 15 T3-02 (lot 13,
    // changement de production assumé) : la correction humaine pose l'origine
    // USER et la date — l'ancienne origine DOCUMENT_EXTRACTION laissait T3
    // écraser la valeur saisie.
    expect(JSON.parse(keyCharacteristics as string)).toEqual({
      mileage: '2000', mileage__origin: 'USER', mileage__updatedAt: expect.any(String), coherenceAlerts: [],
      registrationNumber: 'ab-1', registrationNumber__origin: 'USER', registrationNumber__updatedAt: expect.any(String),
    });
  });

  it('shadow : une lecture d’observation qui ne répond pas ne bloque pas la requête', async () => {
    process.env.CANONICAL_WRITE_MODE = 'shadow';
    h.unsafe.mockImplementation(() => new Promise(() => {})); // base qui ne répond jamais
    const t0 = Date.now();
    await updateAssetDetails({ assetId: 1, accountId: 7, section: 'vehicle_usage', fields: { mileage: 3000 } });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(h.updates).toHaveLength(1);
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('canonicalWritesOf : clé canonique d’une autre famille résolue comme alias de la famille', () => {
    expect(canonicalWritesOf({ generalCondition: 'BON', name: 'x', pointure: 42 }, 'OBJECT')).toEqual([{ key: 'generalCondition', value: 'BON' }]);
    expect(canonicalWritesOf({ generalCondition: 'BON' }, 'IMMOBILIER')).toEqual([{ key: 'generalCondition', value: 'BON' }]);
    expect(canonicalWritesOf({ generalCondition: 'BON' }, 'VEHICULE')).toEqual([]);
  });
});
