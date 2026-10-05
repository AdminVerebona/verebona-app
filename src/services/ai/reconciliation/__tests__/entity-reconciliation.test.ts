/**
 * Réconciliation T3 ciblée équipement / pièce — CDC 15 T1-04, T3-04 (lot 18, R3).
 * Lot 16b-3 : plus de commutateurs (`CANONICAL_WRITE_MODE`,
 * `T3_NEGATIVE_RECONCILIATION`) ni de drapeau moteur — écritures et retraits
 * toujours appliqués.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: {}, db: {} }));

const { reconcileEntity } = await import('../entity-reconciliation');
import type { EntityReconcileDeps } from '../entity-reconciliation';
import type { CanonicalEntityState } from '@/services/canonical/entity-state';
import type { FieldEvidence } from '../../evidence/evidence.types';

afterEach(() => { vi.unstubAllEnvs(); });

const TARGET = { type: 'EQUIPMENT' as const, id: 11 };

function etat(fields: CanonicalEntityState['fields'] = {}, kc: Record<string, unknown> = {}, archived = false): CanonicalEntityState {
  return { target: TARGET, assetId: 3, accountId: 7, name: 'Chaudière', archived, fields, kc };
}
const preuve = (id: number, value: unknown, over: Partial<FieldEvidence> = {}): FieldEvidence => ({
  id, accountId: 7, assetId: 3, fieldKey: 'serialNumber', value, sourceType: 'document', sourceId: 40, location: {},
  excerpt: `N° de série : ${value}`, evidenceOrigin: 'TEXT_EXTRACTION', documentType: 'FACTURE', documentDate: new Date('2024-05-02'),
  confidence: 'certain', authorityScore: 80, status: 'active', extractedAt: new Date(), ...over,
} as FieldEvidence);

function deps(over: Partial<EntityReconcileDeps> = {}, state: CanonicalEntityState | null = etat()) {
  const write = vi.fn(async (i: Parameters<EntityReconcileDeps['write']>[0]) => ({
    target: i.target, assetId: 3, skipped: false, notFound: false,
    fields: i.writes.map((w) => ({ key: w.key, requestedKey: w.key, outcome: 'written' as const, previousValue: null, previousOrigin: null, nextValue: w.value, origin: i.origin, mirrors: {} })),
  }));
  const d: EntityReconcileDeps = {
    loadState: vi.fn(async () => state),
    evidenceKeys: vi.fn(async () => ['serialNumber', 'warrantyEndDate', 'roomArea', 'inconnu']),
    activeEvidence: vi.fn(async (_a, k) => (k === 'serialNumber' ? [preuve(1, 'SN-77')]
      : k === 'warrantyEndDate' ? [preuve(2, '2031-03-01', { fieldKey: 'warrantyEndDate' })] : [])),
    retiredValues: vi.fn(async () => []),
    write: write as never,
    syncCards: vi.fn(async () => ({})),
    ...over,
  };
  return { d, write };
}

describe('plus de modes (lot 16b-3)', () => {
  it('commutateurs retirés encore posés (legacy) : ignorés — la réconciliation tourne', async () => {
    vi.stubEnv('CANONICAL_WRITE_MODE', 'legacy');
    vi.stubEnv('T3_NEGATIVE_RECONCILIATION', 'legacy');
    vi.stubEnv('AI_RECONCILIATION_ENGINE', 'shadow');
    const { d, write } = deps();
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(r.skipped).toBe(false);
    expect(d.loadState).toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
    expect(r).not.toHaveProperty('applyMode');
  });
});

describe('application', () => {
  it('preuves de la cible appliquées à SA fiche (RECONCILIATION, contrôle optimiste, autorité)', async () => {
    const { d, write } = deps();
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed', sourceFileId: 40 }, d);
    expect(r.written.sort()).toEqual(['serialNumber', 'warrantyEndDate']);
    // Champ d'une autre cible (roomArea) et clé hors registre : jamais appliqués.
    expect(d.activeEvidence).toHaveBeenCalledTimes(2);
    expect(d.activeEvidence).toHaveBeenCalledWith(7, 'serialNumber', TARGET);
    const arg = write.mock.calls[0][0];
    expect(arg).toMatchObject({ target: TARGET, origin: 'RECONCILIATION', source: { type: 'document', id: 40 } });
    expect(arg).not.toHaveProperty('mode');
    expect(arg.writes[0]).toMatchObject({ key: 'serialNumber', value: 'SN-77', expectedCurrent: null, trace: { evidenceId: 1 } });
    // Négatif toujours actif : preuves retirées lues (aucune ici).
    expect(d.retiredValues).toHaveBeenCalledTimes(1);
  });

  it('valeur USER contredite : aucune écriture (MANUAL_VALUE_CONTRADICTED)', async () => {
    const { d, write } = deps({ evidenceKeys: vi.fn(async () => ['serialNumber']) }, etat({
      serialNumber: { key: 'serialNumber', value: 'MANUEL', origin: 'USER', from: 'key', updatedAt: null },
    }));
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(write).not.toHaveBeenCalled();
    expect(r.decisions[0].action).not.toMatch(/apply|update/);
  });

  it('équipement archivé ou introuvable : rien', async () => {
    const { d, write } = deps({}, etat({}, {}, true));
    expect((await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d)).skipped).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('réconciliation négative (T3-04)', () => {
  const auto = etat(
    { serialNumber: { key: 'serialNumber', value: 'SN-77', origin: 'RECONCILIATION', from: 'key', updatedAt: null } },
    { serialNumber: 'SN-77', serialNumber__origin: 'RECONCILIATION', manuel: 'x' },
  );

  it('dernière preuve retirée → valeur automatique retirée (null, contrôle optimiste)', async () => {
    const { d, write } = deps({
      evidenceKeys: vi.fn(async () => []),
      retiredValues: vi.fn(async () => [{ fieldKey: 'serialNumber', value: 'SN-77' }]),
    }, auto);
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_linked' }, d);
    expect(r.retracted).toEqual(['serialNumber']);
    expect(write.mock.calls[0][0]).toMatchObject({ writes: [{ key: 'serialNumber', value: null, expectedCurrent: 'SN-77' }] });
    expect(r.decisions.at(-1)).toMatchObject({ reasonCode: 'NO_REMAINING_EVIDENCE', action: 'update' });
  });

  it('valeur USER jamais retirée ; valeur automatique retirée', async () => {
    const { d, write } = deps({
      evidenceKeys: vi.fn(async () => []),
      retiredValues: vi.fn(async () => [{ fieldKey: 'serialNumber', value: 'SN-77' }, { fieldKey: 'brand', value: 'X' }]),
    }, etat({}, { serialNumber: 'SN-77', serialNumber__origin: 'RECONCILIATION', brand: 'X', brand__origin: 'USER' }));
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_linked' }, d);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ writes: [{ key: 'serialNumber', value: null }] });
    expect(r.retracted).toEqual(['serialNumber']);
    expect(r.decisions.at(-1)).toMatchObject({ reasonCode: 'NO_REMAINING_EVIDENCE', action: 'update' });
  });
});

describe('cartes « À traiter » (ENTITY-FIELD)', () => {
  it('décisions transmises au pont des cartes (avec le nom de l’entité)', async () => {
    const { d } = deps();
    await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(d.syncCards).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 7, target: TARGET, entityName: 'Chaudière',
      decisions: expect.arrayContaining([expect.objectContaining({ fieldKey: 'serialNumber' })]),
    }));
  });

  it('aucune décision : aucune carte', async () => {
    const { d } = deps({ evidenceKeys: vi.fn(async () => []) });
    await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(d.syncCards).not.toHaveBeenCalled();
  });
});
