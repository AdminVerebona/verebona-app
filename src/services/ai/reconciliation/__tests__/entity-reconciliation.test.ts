/**
 * Réconciliation T3 ciblée équipement / pièce — CDC 15 T1-04, T3-04 (lot 18, R3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: {}, db: {} }));

const { reconcileEntity, entityModes } = await import('../entity-reconciliation');
import type { EntityReconcileDeps } from '../entity-reconciliation';
import type { CanonicalEntityState } from '@/services/canonical/entity-state';
import type { FieldEvidence } from '../../evidence/evidence.types';

const env = { ...process.env };
afterEach(() => {
  for (const k of ['CANONICAL_WRITE_MODE', 'T3_NEGATIVE_RECONCILIATION']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

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
    mode: i.mode ?? 'enabled', target: i.target, assetId: 3, dryRun: i.mode !== 'enabled', skipped: false, notFound: false,
    fields: i.writes.map((w) => ({ key: w.key, requestedKey: w.key, outcome: 'written' as const, previousValue: null, previousOrigin: null, nextValue: w.value, origin: i.origin, mirrors: {} })),
  }));
  const d: EntityReconcileDeps = {
    loadState: vi.fn(async () => state),
    evidenceKeys: vi.fn(async () => ['serialNumber', 'warrantyEndDate', 'roomArea', 'inconnu']),
    activeEvidence: vi.fn(async (_a, k) => (k === 'serialNumber' ? [preuve(1, 'SN-77')]
      : k === 'warrantyEndDate' ? [preuve(2, '2031-03-01', { fieldKey: 'warrantyEndDate' })] : [])),
    retiredValues: vi.fn(async () => []),
    write: write as never,
    engineShadow: () => false,
    syncCards: vi.fn(async () => ({})),
    ...over,
  };
  return { d, write };
}

describe('modes', () => {
  it('moteur en observation → au plus shadow ; legacy reste legacy', () => {
    expect(entityModes('enabled', 'enabled', true)).toEqual({ apply: 'shadow', retract: 'shadow' });
    expect(entityModes('legacy', 'enabled', false)).toEqual({ apply: 'legacy', retract: 'enabled' });
  });

  it('legacy des deux côtés : aucune dépendance appelée (aucune requête)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'legacy';
    process.env.T3_NEGATIVE_RECONCILIATION = 'legacy';
    const { d } = deps();
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(r.skipped).toBe(true);
    expect(d.loadState).not.toHaveBeenCalled();
  });
});

describe('application', () => {
  it('enabled : preuves de la cible appliquées à SA fiche (RECONCILIATION, contrôle optimiste, autorité)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const { d, write } = deps();
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed', sourceFileId: 40 }, d);
    expect(r.written.sort()).toEqual(['serialNumber', 'warrantyEndDate']);
    // Champ d'une autre cible (roomArea) et clé hors registre : jamais appliqués.
    expect(d.activeEvidence).toHaveBeenCalledTimes(2);
    expect(d.activeEvidence).toHaveBeenCalledWith(7, 'serialNumber', TARGET);
    const arg = write.mock.calls[0][0];
    expect(arg).toMatchObject({ target: TARGET, origin: 'RECONCILIATION', mode: 'enabled', source: { type: 'document', id: 40 } });
    expect(arg.writes[0]).toMatchObject({ key: 'serialNumber', value: 'SN-77', expectedCurrent: null, trace: { evidenceId: 1 } });
    // Négatif legacy : aucune lecture des preuves retirées.
    expect(d.retiredValues).not.toHaveBeenCalled();
  });

  it('shadow : écritures demandées en mode shadow (journal seulement)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'shadow';
    const { d, write } = deps();
    await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(write.mock.calls.every((c) => c[0].mode === 'shadow')).toBe(true);
  });

  it('valeur USER contredite : aucune écriture (MANUAL_VALUE_CONTRADICTED)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const { d, write } = deps({ evidenceKeys: vi.fn(async () => ['serialNumber']) }, etat({
      serialNumber: { key: 'serialNumber', value: 'MANUEL', origin: 'USER', from: 'key', updatedAt: null },
    }));
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(write).not.toHaveBeenCalled();
    expect(r.decisions[0].action).not.toMatch(/apply|update/);
  });

  it('équipement archivé ou introuvable : rien', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
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

  it('enabled : dernière preuve retirée → valeur automatique retirée (null, contrôle optimiste)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'legacy';
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    const { d, write } = deps({
      evidenceKeys: vi.fn(async () => []),
      retiredValues: vi.fn(async () => [{ fieldKey: 'serialNumber', value: 'SN-77' }]),
    }, auto);
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_linked' }, d);
    expect(r.retracted).toEqual(['serialNumber']);
    expect(write.mock.calls[0][0]).toMatchObject({ mode: 'enabled', writes: [{ key: 'serialNumber', value: null, expectedCurrent: 'SN-77' }] });
    expect(r.decisions.at(-1)).toMatchObject({ reasonCode: 'NO_REMAINING_EVIDENCE', action: 'update' });
  });

  it('shadow : retrait seulement journalisé ; valeur USER jamais retirée', async () => {
    process.env.T3_NEGATIVE_RECONCILIATION = 'shadow';
    const { d, write } = deps({
      evidenceKeys: vi.fn(async () => []),
      retiredValues: vi.fn(async () => [{ fieldKey: 'serialNumber', value: 'SN-77' }, { fieldKey: 'brand', value: 'X' }]),
    }, etat({}, { serialNumber: 'SN-77', serialNumber__origin: 'RECONCILIATION', brand: 'X', brand__origin: 'USER' }));
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_linked' }, d);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ mode: 'shadow', writes: [{ key: 'serialNumber' }] });
    expect(r.decisions.at(-1)).toMatchObject({ reasonCode: 'SHADOW_WOULD_RETRACT', action: 'keep' });
  });
});

describe('cartes « À traiter » (ENTITY-FIELD)', () => {
  it('enabled : décisions transmises au pont des cartes (avec le nom de l’entité)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const { d } = deps();
    await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(d.syncCards).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 7, target: TARGET, entityName: 'Chaudière',
      decisions: expect.arrayContaining([expect.objectContaining({ fieldKey: 'serialNumber' })]),
    }));
  });

  it('shadow (écriture ou moteur) : aucune carte', async () => {
    process.env.CANONICAL_WRITE_MODE = 'shadow';
    const { d } = deps();
    await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const { d: d2 } = deps({ engineShadow: () => true });
    await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d2);
    expect(d.syncCards).not.toHaveBeenCalled();
    expect(d2.syncCards).not.toHaveBeenCalled();
  });
});
