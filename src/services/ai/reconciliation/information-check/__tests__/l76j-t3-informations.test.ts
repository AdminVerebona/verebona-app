/**
 * Lot 76J — T3 : contrôle exhaustif de l'onglet « Informations » — règles
 * PURES (inventaire, texte libre, confrontation agenda / Opérations,
 * provenance, prix ancré d'un candidat Opération). Les comportements en base
 * sont couverts par `src/test/e2e/scenarios/l76j-t3-informations.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { listFields } from '@/services/canonical/registry';
import {
  crossCheckAcquisitionDate, crossSignature, guardFreeText, informationInventory, mirrorDivergences,
  type AcquisitionObservation,
} from '../inventory';
import { selectAcquisitionPrice, type OperationCandidateRow } from '../operation-price';
import { runOutcome, type RunPhases } from '../../account-reconciliation.service';
import type { CurrentValue, ReconciliationDecision } from '../../types';

const cur = (value: unknown, origin: CurrentValue['origin'] = 'RECONCILIATION'): CurrentValue =>
  ({ value, normalized: value == null ? null : String(value), origin, updatedAt: null });
const agenda = (o: Partial<Extract<AcquisitionObservation, { source: 'AGENDA' }>> & { id: number; date: string }): AcquisitionObservation =>
  ({ source: 'AGENDA', automatic: true, confirmed: false, derivedFromField: false, sourceFileIds: [], ...o });
const decision = (action: ReconciliationDecision['action']): ReconciliationDecision =>
  ({ fieldKey: 'acquisitionDate', currentValue: null, proposedValue: null, action, reasonCode: 'X', confidence: 'certain', evidenceIds: [1], deterministic: true });

describe('T3-COH-01 — date d’achat confrontée à l’agenda : la date de l’agenda n’est jamais retenue sans confirmation', () => {
  it('fiche 17/02/2005, événement automatique non confirmé 06/05/2021 : divergence tracée, aucune décision', () => {
    const r = crossCheckAcquisitionDate({
      current: cur('2005-02-17'), evidenceSourceIds: [10], observations: [agenda({ id: 5, date: '2021-05-06', sourceFileIds: [20] })],
      engineDecision: decision('keep'), arbitratedSignature: null,
    });
    expect(r.decision).toBeNull();
    expect(r.records).toEqual([expect.objectContaining({
      verdict: 'AGENDA_UNCONFIRMED_NOT_RETAINED', value: '2021-05-06', contradiction: true, independent: true, confirmed: false,
    })]);
  });

  it('fiche vide + seul un événement automatique non confirmé : rien n’est inventé', () => {
    const r = crossCheckAcquisitionDate({
      current: null, evidenceSourceIds: [], observations: [agenda({ id: 5, date: '2021-05-06' })], engineDecision: null, arbitratedSignature: null,
    });
    expect(r.decision).toBeNull();
    expect(r.records[0]).toMatchObject({ verdict: 'AGENDA_UNCONFIRMED_NOT_RETAINED', contradiction: false });
  });

  it('achat confirmé : complète un champ vide ; jamais quand le moteur décide déjà sur preuves', () => {
    const obs = [agenda({ id: 5, date: '2021-05-06', confirmed: true })];
    const r = crossCheckAcquisitionDate({ current: null, evidenceSourceIds: [], observations: obs, engineDecision: null, arbitratedSignature: null });
    expect(r.decision).toMatchObject({ action: 'apply', proposedValue: '2021-05-06', reasonCode: 'EMPTY_FIELD_CONFIRMED_AGENDA', evidenceIds: [] });
    const m = crossCheckAcquisitionDate({ current: null, evidenceSourceIds: [], observations: obs, engineDecision: decision('apply'), arbitratedSignature: null });
    expect(m.decision).toBeNull();
  });

  it('achat confirmé contredit par la fiche : un arbitrage, jamais reproposé une fois tranché (même signature)', () => {
    const obs = [agenda({ id: 5, date: '2021-05-06', confirmed: true })];
    const r = crossCheckAcquisitionDate({ current: cur('2005-02-17'), evidenceSourceIds: [], observations: obs, engineDecision: null, arbitratedSignature: null });
    expect(r.decision).toMatchObject({ action: 'create_conflict', reasonCode: 'CONFIRMED_AGENDA_CONTRADICTION', proposedValue: '2021-05-06', currentValue: '2005-02-17' });
    expect(r.signature).toBe(crossSignature('acquisitionDate', '2005-02-17', '2021-05-06', [5]));
    const t = crossCheckAcquisitionDate({ current: cur('2005-02-17'), evidenceSourceIds: [], observations: obs, engineDecision: null, arbitratedSignature: r.signature });
    expect(t.decision).toBeNull();
    expect(t.records[0].verdict).toBe('ALREADY_ARBITRATED');
  });

  it('plusieurs achats confirmés de dates différentes : abstention', () => {
    const r = crossCheckAcquisitionDate({
      current: null, evidenceSourceIds: [], engineDecision: null, arbitratedSignature: null,
      observations: [agenda({ id: 5, date: '2021-05-06', confirmed: true }), agenda({ id: 6, date: '2020-01-01', confirmed: true })],
    });
    expect(r.decision).toBeNull();
    expect(r.records.every((x) => x.verdict === 'CONFIRMED_AMBIGUOUS')).toBe(true);
  });
});

describe('T3-COH-10 — provenance : deux données du même document ne sont pas deux preuves', () => {
  it('événement issu du document de la preuve : non indépendant ; projection de la fiche : jamais une preuve', () => {
    const r = crossCheckAcquisitionDate({
      current: cur('2005-02-17'), evidenceSourceIds: [20, 30], engineDecision: decision('update'), arbitratedSignature: null,
      observations: [
        agenda({ id: 5, date: '2021-05-06', sourceFileIds: [20] }),
        agenda({ id: 6, date: '2005-02-17', derivedFromField: true }),
        { source: 'OPERATION', id: 9, date: '2021-05-06', amountEur: null, derivedFromField: false, sourceFileIds: [30] },
      ],
    });
    expect(r.records.map((x) => [x.source, x.verdict, x.independent, x.sharedSourceFileIds])).toEqual([
      ['AGENDA', 'AGENDA_UNCONFIRMED_NOT_RETAINED', false, [20]],
      ['AGENDA', 'DERIVED_FROM_FIELD', false, []],
      ['OPERATION', 'OPERATION_NOT_RETAINED', false, [30]],
    ]);
    expect(r.decision).toBeNull();
  });
});

describe('T3-COH-02 / 03 / 06 — prix d’achat ancré dans un candidat Opération', () => {
  const c = (o: Partial<OperationCandidateRow> & { payload?: Record<string, unknown> } = {}): OperationCandidateRow => ({
    id: 1, fileId: 2, analysisRunId: null, typeHint: 'ACQUISITION', statusHint: 'REALIZED', established: true, confidence: 'certain',
    documentType: 'ACTE_AUTHENTIQUE',
    payload: {
      targetHints: [{ type: 'ASSET', entityId: 7, confidence: 'certain' }],
      financialHints: [{ role: 'REALIZED_COST', amountMinor: 25_000_000, currency: 'EUR', amountScope: 'TOTAL', evidence: { factId: 99 } }],
    },
    ...o,
  });
  const ctx = { assetId: 7, category: 'IMMOBILIER', equipmentIds: [40] };

  it('T3-COH-02 — acte, cible le bien, montant total ancré : retenu', () => {
    expect(selectAcquisitionPrice(c(), ctx)).toEqual({ ok: true, target: { type: 'ASSET', id: 7 }, amountMinor: 25_000_000, factId: 99 });
  });

  it('T3-COH-03 — intervention, facture d’une maison, montants multiples, non ancré, non établi : jamais un prix d’achat', () => {
    expect(selectAcquisitionPrice(c({ typeHint: 'INTERVENTION' }), ctx)).toMatchObject({ ok: false, reason: 'NOT_ACQUISITION' });
    expect(selectAcquisitionPrice(c({ documentType: 'FACTURE' }), ctx)).toMatchObject({ ok: false, reason: 'REAL_ESTATE_NEEDS_AUTHORITATIVE_DOCUMENT' });
    expect(selectAcquisitionPrice(c({ documentType: 'RAPPORT_ENTRETIEN' }), { ...ctx, category: 'OBJECT' })).toMatchObject({ ok: false, reason: 'DOCUMENT_NOT_PURCHASE' });
    expect(selectAcquisitionPrice(c({ established: false }), ctx)).toMatchObject({ ok: false });
    const deux = c({ payload: { targetHints: [{ type: 'ASSET', entityId: 7, confidence: 'certain' }], financialHints: [
      { role: 'REALIZED_COST', amountMinor: 100, currency: 'EUR', amountScope: 'DEPOSIT', evidence: { factId: 1 } },
      { role: 'REALIZED_COST', amountMinor: 900, currency: 'EUR', amountScope: 'BALANCE', evidence: { factId: 2 } },
    ] } });
    expect(selectAcquisitionPrice(deux, ctx)).toMatchObject({ ok: false, reason: 'AMOUNT_NOT_UNIQUE_EUR_TOTAL' });
    const nonAncre = c({ payload: { targetHints: [{ type: 'ASSET', entityId: 7, confidence: 'certain' }], financialHints: [
      { role: 'REALIZED_COST', amountMinor: 100, currency: 'EUR', amountScope: 'TOTAL', evidence: { factId: null } },
    ] } });
    expect(selectAcquisitionPrice(nonAncre, ctx)).toMatchObject({ ok: false, reason: 'AMOUNT_NOT_ANCHORED' });
    // Facture d'un OBJET : autorisée.
    expect(selectAcquisitionPrice(c({ documentType: 'FACTURE' }), { ...ctx, category: 'OBJECT' })).toMatchObject({ ok: true });
  });

  it('T3-COH-06 — un équipement visé : prix de l’équipement seul, jamais du bien ; équipement étranger ou ambigu : rien', () => {
    const eq = (hints: unknown[]) => c({ documentType: 'FACTURE', payload: { ...c().payload, targetHints: hints } });
    expect(selectAcquisitionPrice(eq([{ type: 'ASSET', entityId: 7, confidence: 'certain' }, { type: 'EQUIPMENT', entityId: 40, confidence: 'certain' }]), ctx))
      .toMatchObject({ ok: true, target: { type: 'EQUIPMENT', id: 40 } });
    expect(selectAcquisitionPrice(eq([{ type: 'EQUIPMENT', entityId: 41, confidence: 'certain' }]), ctx)).toMatchObject({ ok: false, reason: 'EQUIPMENT_NOT_OF_ASSET' });
    expect(selectAcquisitionPrice(eq([{ type: 'EQUIPMENT', entityId: null, confidence: 'certain' }]), ctx)).toMatchObject({ ok: false, reason: 'EQUIPMENT_TARGET_AMBIGUOUS' });
  });
});

describe('T3-COH-07 / 08 — inventaire exhaustif (registre canonique)', () => {
  it('tous les champs de la famille sont inventoriés, vides compris ; saisie seule et décidés distingués', () => {
    const inv = informationInventory({
      target: 'ASSET', category: 'IMMOBILIER', subtype: 'Maison', decided: new Set(['acquisitionDate']),
      current: (k) => (k === 'livingArea' ? cur(120, 'USER') : null), identity: { name: 'Maison', category: 'IMMOBILIER', status: null },
    });
    expect(inv.lines.map((l) => l.key)).toEqual(listFields('IMMOBILIER').map((d) => d.key));
    const st = (k: string) => inv.lines.find((l) => l.key === k)?.status;
    expect(st('acquisitionDate')).toBe('EVIDENCE');
    expect(st('acquisitionPrice')).toBe('NO_EVIDENCE_EMPTY');
    expect(st('livingArea')).toBe('NO_EVIDENCE_FILLED');
    expect(st('saleDate')).toBe('INPUT_ONLY');
    expect(inv.identity.map((i) => i.key)).toEqual(['name', 'category', 'status']);
    expect(inv.otherFamilyCount).toBeGreaterThan(0);
    expect(inv.lines.find((l) => l.key === 'notes')?.freeText).toBe(true);
  });

  it('vélo : immatriculation non applicable ; équipement : champs de la cible équipement', () => {
    const velo = informationInventory({ target: 'ASSET', category: 'VEHICULE', subtype: 'Vélo', decided: new Set(), current: () => null });
    expect(velo.lines.find((l) => l.key === 'registrationNumber')?.status).toBe('NOT_APPLICABLE');
    const eq = informationInventory({ target: 'EQUIPMENT', decided: new Set(), current: () => null });
    expect(eq.lines.map((l) => l.key)).toEqual(listFields(undefined, { targetType: 'EQUIPMENT' }).map((d) => d.key));
  });

  it('texte libre : une valeur en place n’est jamais remplacée ; un champ vide peut être complété', () => {
    const d = { ...decision('update'), fieldKey: 'notes', currentValue: 'Mes notes', proposedValue: 'Autre' };
    expect(guardFreeText(d)).toMatchObject({ action: 'keep', reasonCode: 'FREE_TEXT_PROTECTED', proposedValue: 'Mes notes' });
    expect(guardFreeText({ ...d, action: 'apply', currentValue: null })).toMatchObject({ action: 'apply' });
    expect(guardFreeText({ ...d, fieldKey: 'acquisitionDate' })).toMatchObject({ action: 'update' });
  });

  it('colonne historique différente de la fiche : signalée, jamais corrigée', () => {
    const defs = listFields('IMMOBILIER').filter((d) => d.key === 'acquisitionDate');
    const r = mirrorDivergences({
      defs, kc: { acquisitionDate: '2021-05-06' }, row: { purchase_date: '2005-02-17' },
      fromColumn: (_d, c) => (c === 'purchase_date' ? '2005-02-17' : null), same: (_k, a, b) => a === b,
    });
    expect(r).toEqual([expect.objectContaining({ verdict: 'MIRROR_DIVERGENCE', fieldKey: 'acquisitionDate', value: '2005-02-17', refId: 'purchase_date' })]);
  });
});

describe('T3-COH-09 — rattrapage : phase facultative, jamais un échec du passage', () => {
  it('INFORMATION_BACKFILL reportée (reste à faire) : l’issue du passage n’est pas dégradée', () => {
    const phases: RunPhases = {
      ASSETS: { status: 'DONE', error: null }, OPEN_KNOWLEDGE: { status: 'DONE', error: null },
      OPEN_ACTIONS: { status: 'DONE', error: null }, JOURNAL: { status: 'DONE', error: null },
      INFORMATION_BACKFILL: { status: 'DEFERRED', error: '3 bien(s) restant(s)' },
    };
    expect(runOutcome(phases, { changes: 1, keptOpen: 0 })).toBe('SUCCESS');
  });
});
