/**
 * Pont documentaire générique « À traiter » (lot 28, ticket P0) — décision
 * PURE par règle du catalogue (`planDocumentRule`, `proposalsFromAnalysis`).
 *
 * Les mêmes cas TEST-ATP-01 à 12 sont rejoués sur PostgreSQL réel par
 * `src/test/e2e/scenarios/l28-a-traiter-alimentation.e2e.ts` (création, mise à
 * jour, résolution, réapparition, balayage).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { planDocumentRule, proposalsFromAnalysis } = await import('../document-rule-bridge');
const { documentSlotFor } = await import('../document-slots');
const { getRule, isRuleRelevantForDocument } = await import('../rules-catalog');

const LINK_ASSET = getRule('LINK-ASSET')!;
const CONTRACT = getRule('DATA-CONTRACT-END')!;
const WARRANTY = getRule('DATA-WARRANTY-END')!;
const SUPPLIER = getRule('DATA-SUPPLIER')!;
const LINK_ELT = getRule('LINK-ELT')!;

const vide = { value: null, values: [] as number[], userValidated: false };
const obs = (p: Partial<Parameters<typeof proposalsFromAnalysis>[2]> = {}) => ({
  facts: [], assetCandidates: [], documentAssetId: null, ...p,
});
const candidat = (id: number, confidence = 'certain', score = 0.97) => ({ entityId: id, verified: true, score, confidence });
const propsLien = (o: ReturnType<typeof obs>) =>
  proposalsFromAnalysis('assetIds', documentSlotFor('assetIds'), o, new Map([[10, 'Maison'], [11, 'Clio']]));

describe('LINK-ASSET — rattachement d’un nouveau document', () => {
  it('TEST-ATP-01 — document sans bien et sans candidat : COMPLETE', () => {
    const plan = planDocumentRule({ rule: LINK_ASSET, state: vide, proposals: propsLien(obs()), relevant: true, mode: 'analysis' });
    expect(plan).toMatchObject({ kind: 'UPSERT', actionKind: 'COMPLETE', proposals: [] });
  });

  it('TEST-ATP-02 — deux biens plausibles : ARBITRATE avec propositions exploitables, jamais écrit', () => {
    const proposals = propsLien(obs({ assetCandidates: [candidat(10), candidat(11)] }));
    expect(proposals.map((p) => p.value)).toEqual([10, 11]);
    expect(proposals.every((p) => p.confidence < 0.9)).toBe(true);
    const plan = planDocumentRule({ rule: LINK_ASSET, state: vide, proposals, relevant: true, mode: 'analysis' });
    expect(plan).toMatchObject({ kind: 'UPSERT', actionKind: 'ARBITRATE' });
    expect(plan.kind === 'UPSERT' && plan.proposals.map((p) => p.label)).toEqual(['Maison', 'Clio']);
  });

  it('TEST-ATP-02 bis — un seul candidat PROBABLE : ARBITRATE (confiance insuffisante)', () => {
    const proposals = propsLien(obs({ assetCandidates: [candidat(10, 'probable', 0.6)] }));
    const plan = planDocumentRule({ rule: LINK_ASSET, state: vide, proposals, relevant: true, mode: 'analysis' });
    expect(plan).toMatchObject({ kind: 'UPSERT', actionKind: 'ARBITRATE' });
  });

  it('TEST-ATP-03 — bien identifié par l’analyse : rattachement automatique, aucune action', () => {
    const proposals = propsLien(obs({ documentAssetId: 10, assetCandidates: [candidat(10)] }));
    const plan = planDocumentRule({ rule: LINK_ASSET, state: vide, proposals, relevant: true, mode: 'analysis' });
    expect(plan).toMatchObject({ kind: 'WRITE', value: 10 });
  });

  it('document déjà rattaché (dépôt, tiroir) : la question est close, quels que soient les candidats', () => {
    const plan = planDocumentRule({
      rule: LINK_ASSET, state: { value: 11, values: [11], userValidated: false },
      proposals: propsLien(obs({ assetCandidates: [candidat(10)] })), relevant: true, mode: 'analysis',
    });
    expect(plan).toEqual({ kind: 'RESOLVE', reason: 'ALREADY_SATISFIED' });
  });

  it('rattachement RETIRÉ par l’utilisateur : jamais réécrit automatiquement, proposé', () => {
    const proposals = propsLien(obs({ documentAssetId: 10, assetCandidates: [candidat(10)] }));
    const plan = planDocumentRule({ rule: LINK_ASSET, state: { ...vide, userValidated: true }, proposals, relevant: true, mode: 'analysis' });
    expect(plan).toMatchObject({ kind: 'UPSERT', actionKind: 'ARBITRATE', reason: 'USER_CLEARED_VALUE' });
  });

  it('TEST-ATP-04 — rattaché ailleurs (tiroir) : réévaluation d’état → fermeture', () => {
    const plan = planDocumentRule({
      rule: LINK_ASSET, state: { value: 10, values: [10], userValidated: true }, proposals: [],
      relevant: true, mode: 'state', active: { actionKind: 'COMPLETE', snapshot: '' },
    });
    expect(plan.kind).toBe('RESOLVE');
  });

  it('TEST-ATP-05 — réanalyse identique : même décision (l’unicité est assurée par upsertAction)', () => {
    const proposals = propsLien(obs({ assetCandidates: [candidat(10), candidat(11)] }));
    const a = planDocumentRule({ rule: LINK_ASSET, state: vide, proposals, relevant: true, mode: 'analysis' });
    const b = planDocumentRule({ rule: LINK_ASSET, state: vide, proposals: propsLien(obs({ assetCandidates: [candidat(11), candidat(10)] })), relevant: true, mode: 'analysis' });
    expect(b).toEqual(a);
  });
});

describe('Données documentaires (DATA-CONTRACT-END, DATA-WARRANTY-END, DATA-SUPPLIER)', () => {
  const fait = (canonicalKey: string, value: string, confidence = 'certain') => ({ canonicalKey, value, confidence, excerpt: `${canonicalKey} ${value}` });
  const propsChamp = (key: string, o: ReturnType<typeof obs>) => proposalsFromAnalysis(key, documentSlotFor(key), o);

  it('TEST-ATP-06 — preuve fiable sur une donnée attendue : écrite, l’action se ferme', () => {
    const proposals = propsChamp('contractEndDate', obs({ facts: [fait('contractEndDate', '2027-06-30')] }));
    expect(proposals).toEqual([expect.objectContaining({ value: '2027-06-30', label: '30/06/2027', confidence: 1 })]);
    expect(planDocumentRule({ rule: CONTRACT, state: vide, proposals, relevant: true, mode: 'analysis' }))
      .toMatchObject({ kind: 'WRITE', value: '2027-06-30' });
    // Une complétion ouverte se ferme dès que la donnée est là (réévaluation d'état).
    expect(planDocumentRule({
      rule: CONTRACT, state: { value: '2027-06-30', values: [], userValidated: true }, proposals: [],
      relevant: true, mode: 'state', active: { actionKind: 'COMPLETE', snapshot: '' },
    })).toMatchObject({ kind: 'RESOLVE', reason: 'COMPLETED_ELSEWHERE' });
  });

  it('TEST-ATP-07 — valeur utilisateur contredite : jamais écrasée, ARBITRATE avec la valeur actuelle', () => {
    const proposals = propsChamp('warrantyEndDate', obs({ facts: [fait('warrantyEndDate', '2028-01-31')] }));
    const plan = planDocumentRule({
      rule: WARRANTY, state: { value: '2027-12-31', values: [], userValidated: true }, proposals,
      relevant: true, mode: 'analysis',
    });
    expect(plan.kind).toBe('UPSERT');
    if (plan.kind !== 'UPSERT') return;
    expect(plan.actionKind).toBe('ARBITRATE');
    expect(plan.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '2028-01-31' }),
      expect.objectContaining({ value: '2027-12-31', isCurrentValue: true }),
    ]));
    // Même proposition à 100 % sur une valeur protégée : aucune écriture.
    expect(plan).not.toHaveProperty('value');
  });

  it('TEST-ATP-07 bis — l’arbitrage se ferme quand la donnée est modifiée ailleurs', () => {
    const active = { actionKind: 'ARBITRATE' as const, snapshot: '2027-12-31' };
    const base = { rule: WARRANTY, proposals: [], relevant: true, mode: 'state' as const, active };
    expect(planDocumentRule({ ...base, state: { value: '2027-12-31', values: [], userValidated: true } }).kind).toBe('NONE');
    expect(planDocumentRule({ ...base, state: { value: '2028-01-31', values: [], userValidated: true } }).kind).toBe('RESOLVE');
  });

  it('TEST-ATP-08 — champ optionnel absent : aucune action', () => {
    // Fournisseur absent, sans proposition (completePriority = null).
    expect(planDocumentRule({ rule: SUPPLIER, state: vide, proposals: [], relevant: true, mode: 'analysis' }).kind).toBe('RESOLVE');
    // Date de garantie absente d'une FACTURE : donnée non pertinente pour ce Type.
    expect(isRuleRelevantForDocument(WARRANTY, 'MAINTENANCE_INVOICE')).toBe(false);
    expect(planDocumentRule({ rule: WARRANTY, state: vide, proposals: [], relevant: false, mode: 'analysis' }).kind).toBe('RESOLVE');
    // Ni en réévaluation d'état.
    expect(planDocumentRule({ rule: WARRANTY, state: vide, proposals: [], relevant: false, mode: 'state' }).kind).toBe('NONE');
  });

  it('TEST-ATP-08 bis — hors pertinence, une valeur fiable est écrite en silence, une hésitation ignorée', () => {
    const sure = propsChamp('warrantyEndDate', obs({ facts: [fait('warrantyEndDate', '2028-01-31')] }));
    expect(planDocumentRule({ rule: WARRANTY, state: vide, proposals: sure, relevant: false, mode: 'analysis' }).kind).toBe('WRITE');
    const hesitante = propsChamp('warrantyEndDate', obs({ facts: [fait('warrantyEndDate', '2028-01-31', 'probable')] }));
    expect(planDocumentRule({ rule: WARRANTY, state: vide, proposals: hesitante, relevant: false, mode: 'analysis' }).kind).toBe('RESOLVE');
  });

  it('TEST-ATP-09 — completePriority = null : aucune complétion sans proposition', () => {
    for (const rule of [LINK_ELT, SUPPLIER]) {
      expect(rule.completePriority).toBeNull();
      const plan = planDocumentRule({ rule, state: vide, proposals: [], relevant: true, mode: 'analysis' });
      expect(plan.kind === 'UPSERT' && plan.actionKind === 'COMPLETE').toBe(false);
      expect(planDocumentRule({ rule, state: vide, proposals: [], relevant: true, mode: 'state' }).kind).toBe('NONE');
    }
  });

  it('TEST-ATP-10 — contrat avec deux dates de fin plausibles : ARBITRATE / DATA-CONTRACT-END', () => {
    expect(isRuleRelevantForDocument(CONTRACT, 'MAINTENANCE_CONTRACT')).toBe(true);
    const proposals = propsChamp('contractEndDate', obs({ facts: [fait('contractEndDate', '2027-06-30'), fait('contractEndDate', '2028-06-30')] }));
    expect(proposals).toHaveLength(2);
    const plan = planDocumentRule({ rule: CONTRACT, state: vide, proposals, relevant: true, mode: 'analysis' });
    expect(plan).toMatchObject({ kind: 'UPSERT', actionKind: 'ARBITRATE', reason: 'CONTRADICTORY_SOURCES' });
    expect(CONTRACT.code).toBe('DATA-CONTRACT-END');
  });

  it('TEST-ATP-11 — garantie sans date exploitable : COMPLETE / DATA-WARRANTY-END, seulement si attendue', () => {
    expect(isRuleRelevantForDocument(WARRANTY, 'WARRANTY_CERTIFICATE')).toBe(true);
    const proposals = propsChamp('warrantyEndDate', obs({ facts: [fait('warrantyEndDate', 'pas une date')] }));
    expect(proposals).toEqual([]);
    expect(planDocumentRule({ rule: WARRANTY, state: vide, proposals, relevant: true, mode: 'analysis' }))
      .toMatchObject({ kind: 'UPSERT', actionKind: 'COMPLETE' });
    expect(planDocumentRule({ rule: WARRANTY, state: vide, proposals, relevant: isRuleRelevantForDocument(WARRANTY, 'PURCHASE_INVOICE'), mode: 'analysis' }).kind)
      .toBe('RESOLVE');
  });

  it('DATA-SUPPLIER — fournisseur contradictoire proposé (arbitrage), fournisseur sûr écrit', () => {
    const conflictuel = proposalsFromAnalysis('supplier', documentSlotFor('supplier'),
      obs({ metadata: { supplier: { value: 'Garage Martin', confidence: 'conflictual' } } }));
    expect(planDocumentRule({ rule: SUPPLIER, state: vide, proposals: conflictuel, relevant: true, mode: 'analysis' }))
      .toMatchObject({ kind: 'UPSERT', actionKind: 'ARBITRATE' });
    const sur = proposalsFromAnalysis('supplier', documentSlotFor('supplier'),
      obs({ metadata: { supplier: { value: 'Garage Martin', confidence: 'certain' } } }));
    expect(planDocumentRule({ rule: SUPPLIER, state: vide, proposals: sur, relevant: true, mode: 'analysis' }))
      .toMatchObject({ kind: 'WRITE', value: 'Garage Martin' });
  });

  it('« Non applicable » antérieur ou document non éligible : le balayage ne crée rien', () => {
    expect(planDocumentRule({ rule: CONTRACT, state: vide, proposals: [], relevant: true, mode: 'state', mayCreate: false }).kind).toBe('NONE');
    expect(planDocumentRule({ rule: CONTRACT, state: vide, proposals: [], relevant: true, mode: 'state', mayCreate: true }))
      .toMatchObject({ kind: 'UPSERT', actionKind: 'COMPLETE' });
  });
});
