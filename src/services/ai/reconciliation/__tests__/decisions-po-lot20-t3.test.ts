/**
 * Décisions PO du 01/10/2026 (lot 20) côté T3 :
 *   · D-M — une date tranchée par T4 devient une preuve RÉVISÉE ; T3 corrige
 *     la valeur AUTOMATIQUE qu'elle remplace (jamais une valeur USER/ADMIN) ;
 *   · D-P — un équipement archivé n'est jamais réconcilié ;
 *   · D-D — un champ de saisie seule n'est jamais appliqué par T3.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune requête attendue'); }) }, db: {} }));

const { reconcileEntity } = await import('../entity-reconciliation');
const { isT4DateRevision, T4_REVISION_RULE, T4_REVISION_REASON } = await import('../negative-reconciliation');
const { toEvidenceCandidates } = await import('../evidence-collector');
const { decide } = await import('../decision/decision-matrix');
const { resolveAuthority } = await import('../decision/authority-matrix');
const { applyDecision } = await import('../apply-decision');
const { REASON_CODES } = await import('../decision/reason-codes');
import type { EntityReconcileDeps } from '../entity-reconciliation';
import type { CanonicalEntityState } from '@/services/canonical/entity-state';
import type { FieldEvidence } from '../../evidence/evidence.types';
import type { DecisionInput } from '../types';

afterEach(() => { vi.restoreAllMocks(); });

const TARGET = { type: 'EQUIPMENT' as const, id: 11 };
const DOC_DATE = new Date('2026-03-04');
const AUTORITE = resolveAuthority({ fieldKey: 'warrantyEndDate', documentType: 'FACTURE', isWebLink: false }).score;

const preuve = (id: number, value: string, over: Partial<FieldEvidence> = {}): FieldEvidence => ({
  id, accountId: 7, assetId: 3, fieldKey: 'warrantyEndDate', value, sourceType: 'document', sourceId: 40, location: {},
  excerpt: 'Garantie jusqu’au 03/01/2031', evidenceOrigin: 'TEXT_EXTRACTION', documentType: 'FACTURE', documentDate: DOC_DATE,
  confidence: 'certain', authorityScore: AUTORITE, status: 'active', extractedAt: new Date(), ...over,
} as FieldEvidence);

/** Équipement dont la fin de garantie a été écrite par T3 depuis la lecture mm/jj (2031-01-03). */
function etat(origin: 'RECONCILIATION' | 'USER' = 'RECONCILIATION', archived = false): CanonicalEntityState {
  return {
    target: TARGET, assetId: 3, accountId: 7, name: 'Pompe à chaleur', archived,
    fields: { warrantyEndDate: { key: 'warrantyEndDate', value: '2031-01-03', origin, from: 'key', updatedAt: null } },
    kc: {
      warrantyEndDate: '2031-01-03', warrantyEndDate__origin: origin,
      ...(origin === 'RECONCILIATION' ? { warrantyEndDate__authority: AUTORITE, warrantyEndDate__sourceDate: DOC_DATE.toISOString() } : {}),
    },
  };
}

function deps(state: CanonicalEntityState, evidences: FieldEvidence[], over: Partial<EntityReconcileDeps> = {}) {
  const write = vi.fn(async (i: Parameters<EntityReconcileDeps['write']>[0]) => ({
    target: i.target, assetId: 3, skipped: false, notFound: false,
    fields: i.writes.map((w) => ({ key: w.key, requestedKey: w.key, outcome: 'written' as const, previousValue: null, previousOrigin: null, nextValue: w.value, origin: i.origin, mirrors: {} })),
  }));
  const d: EntityReconcileDeps = {
    loadState: vi.fn(async () => state),
    evidenceKeys: vi.fn(async () => ['warrantyEndDate', 'listingPrice']),
    activeEvidence: vi.fn(async (_a, k) => (k === 'warrantyEndDate' ? evidences : [preuve(9, '259000', { fieldKey: 'listingPrice' })])),
    retiredValues: vi.fn(async () => [{ fieldKey: 'warrantyEndDate', value: '2031-01-03' }]),
    write: write as never,
    syncCards: vi.fn(async () => ({})),
    ...over,
  };
  return { d, write };
}

const revisee = preuve(71, '2031-03-01', { projectionRule: T4_REVISION_RULE });

describe('D-M — preuve révisée par T4', () => {
  it('le code de motif est déclaré au catalogue fermé', () => {
    expect(REASON_CODES[T4_REVISION_REASON as keyof typeof REASON_CODES]).toBeTruthy();
  });

  it('candidats : la règle de projection de la preuve est transmise au moteur', () => {
    expect(toEvidenceCandidates('warrantyEndDate', [revisee])[0]).toMatchObject({ evidenceId: 71, normalized: '2031-03-01', projectionRule: T4_REVISION_RULE });
    expect(toEvidenceCandidates('warrantyEndDate', [preuve(70, '2031-01-03')])[0].projectionRule).toBeUndefined();
  });

  it('isT4DateRevision : valeur automatique non prouvée + preuve révisée seulement', () => {
    const input = (cands: FieldEvidence[]): DecisionInput => ({
      fieldKey: 'warrantyEndDate', isCritical: false, candidates: toEvidenceCandidates('warrantyEndDate', cands),
      current: { value: '2031-01-03', normalized: '2031-01-03', origin: 'RECONCILIATION', authorityScore: AUTORITE, sourceDate: DOC_DATE, updatedAt: null },
    });
    expect(isT4DateRevision(true, input([revisee]))).toBe(true);
    expect(isT4DateRevision(false, input([revisee]))).toBe(false);
    expect(isT4DateRevision(true, input([preuve(72, '2031-03-01')]))).toBe(false);
    // Sans la règle, même autorité et même date de document : conflit (comportement inchangé).
    expect(decide(input([preuve(72, '2031-03-01')])).action).toBe('create_conflict');
  });

  it('la valeur automatique remplacée est corrigée (RECONCILIATION, contrôle optimiste)', async () => {
    const { d, write } = deps(etat(), [revisee]);
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed', sourceFileId: 40 }, d);
    expect(r.written).toEqual(['warrantyEndDate']);
    expect(r.decisions[0]).toMatchObject({ action: 'update', reasonCode: T4_REVISION_REASON, proposedValue: '2031-03-01' });
    expect(write.mock.calls[0][0]).toMatchObject({
      origin: 'RECONCILIATION',
      writes: [{ key: 'warrantyEndDate', value: '2031-03-01', expectedCurrent: '2031-01-03', trace: { evidenceId: 71 } }],
    });
    // D-D : le champ de saisie seule présent dans les preuves n'est jamais lu ni écrit.
    expect(d.activeEvidence).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.flatMap((c) => c[0].writes.map((w) => w.key))).not.toContain('listingPrice');
  });

  it('lot 16b-3 : un commutateur retiré encore posé (legacy, shadow) ne change rien — la correction est écrite', async () => {
    for (const v of ['legacy', 'shadow']) {
      vi.stubEnv('CANONICAL_WRITE_MODE', v);
      vi.stubEnv('T3_NEGATIVE_RECONCILIATION', v);
      const { d, write } = deps(etat(), [revisee]);
      const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
      expect(r.written, v).toEqual(['warrantyEndDate']);
      expect(write.mock.calls[0][0]).not.toHaveProperty('mode');
    }
    vi.unstubAllEnvs();
  });

  it('valeur USER : jamais remplacée par la preuve révisée (conflit)', async () => {
    const { d, write } = deps(etat('USER'), [revisee]);
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_analyzed' }, d);
    expect(write).not.toHaveBeenCalled();
    expect(r.decisions[0]).toMatchObject({ action: 'create_conflict', reasonCode: 'MANUAL_VALUE_CONTRADICTED' });
  });
});

describe('D-P — équipement archivé : jamais réconcilié', () => {
  it('preuve révisée présente : aucune lecture de preuve, aucune écriture, aucun retrait, aucune carte', async () => {
    const { d, write } = deps(etat('RECONCILIATION', true), [revisee]);
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_linked', sourceFileId: 40 }, d);
    expect(r).toMatchObject({ skipped: true, decisions: [], written: [], retracted: [] });
    expect(d.evidenceKeys).not.toHaveBeenCalled();
    expect(d.activeEvidence).not.toHaveBeenCalled();
    expect(d.retiredValues).not.toHaveBeenCalled();
    expect(d.syncCards).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('même équipement non archivé : réconcilié (témoin)', async () => {
    const { d, write } = deps(etat('RECONCILIATION', false), [revisee]);
    const r = await reconcileEntity({ accountId: 7, target: TARGET, triggeredBy: 'document_linked' }, d);
    expect(r.skipped).toBe(false);
    expect(write).toHaveBeenCalled();
  });
});

describe('D-D — saisie seule jamais appliquée par T3', () => {
  it('applyDecision : ignorée, sans aucune requête', async () => {
    const decision = {
      fieldKey: 'prixAnnonce', currentValue: null, proposedValue: 259000, action: 'apply' as const,
      reasonCode: 'EMPTY_FIELD_SINGLE_CERTAIN', confidence: 'certain' as const, evidenceIds: [9], deterministic: true,
    };
    expect(await applyDecision(decision, { accountId: 7, assetId: 3, sourceFileId: 40 })).toBe('skipped');
    expect(await applyDecision({ ...decision, fieldKey: 'listingPrice' }, { accountId: 7, assetId: 3, sourceFileId: 40 })).toBe('skipped');
  });
});
