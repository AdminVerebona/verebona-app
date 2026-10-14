/**
 * Lot 41 (O3a) — machine de décision C5 et rapprochement déterministe C6 / C7
 * (règles pures). Un test par règle : C5-xx, C7-xx ; cas F-xxx du CDC cités.
 */
import { describe, expect, it } from 'vitest';
import { decideCandidate, hardNegatives, sameOwnershipCycle, type ExistingOperation, type MatchContext } from '../matching';
import type { CandidateIdentity } from '../model';

function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Réparation', provider: 'Garage', providerKey: 'garage',
    assetIds: [1], targetAuthority: 'DOCUMENT', equipmentIds: [], refs: [],
    dates: { plannedDate: null, startDate: null, realizedDate: '2026-06-02', endDate: null }, hints: [],
    ...over,
  };
}
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: value.replace(/[^A-Z0-9]/gi, '').toUpperCase() });

function op(over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id: 100, typeCode: 'INTERVENTION', status: 'REALIZED', providerKey: 'garage', assetIds: [1], refs: [],
    plannedDate: null, startDate: null, realizedDate: '2026-06-01', endDate: null, ...over,
  };
}
const ctx = (operations: ExistingOperation[], over: Partial<MatchContext> = {}): MatchContext => ({
  operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map(), ...over,
});

describe('C5 — machine de décision de création', () => {
  it('C5-01 / F-003 existence non établie → NO_OPERATION, aucune recherche ne crée', () => {
    expect(decideCandidate(cand({ established: false }), ctx([])).outcome).toBe('NO_OPERATION');
  });

  it('C5-02 / F-026 candidat conflictual → HOLD_UNRESOLVED (aucune création ni rattachement automatique)', () => {
    const d = decideCandidate(cand({ confidence: 'conflictual', refs: [ref('INVOICE', 'F1')] }), ctx([op({ refs: [ref('INVOICE', 'F1')] })]));
    expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'CONFLICTUAL', operationId: null });
  });

  it('C5-03 / F-001 / INV-007 certain + établi, recherche préalable sans résultat → CREATE_NEW', () => {
    expect(decideCandidate(cand(), ctx([op({ providerKey: 'autre' })]))).toMatchObject({ outcome: 'CREATE_NEW', reason: 'NO_MATCH_ESTABLISHED' });
  });

  it('C5-04 / F-024 / INV-FINAL-003 candidat probable sans Opération → HOLD (pas de création)', () => {
    expect(decideCandidate(cand({ confidence: 'probable' }), ctx([]))).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'PROBABLE_WITHOUT_MATCH' });
  });

  it('C5-05 / F-025 candidat probable avec rapprochement M1 exact → MATCH autorisé', () => {
    const d = decideCandidate(cand({ confidence: 'probable', role: 'PAYMENT_PROOF', refs: [ref('INVOICE', 'SO-233')] }), ctx([op({ refs: [ref('INVOICE', 'SO-233')] })]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 100, matchMethod: 'M1' });
  });

  it('C5-06 / F-048 / INV-008 deux Opérations certaines incompatibles → ARBITRATION_REQUIRED (carte, lot 42), jamais une troisième', () => {
    // Lot 42 : deux Opérations COMPATIBLES citées par une même source sont
    // fusionnées (F-049, o3b-*) ; ici deux prestataires différents.
    const d = decideCandidate(cand({ refs: [ref('QUOTE', 'D1'), ref('WORK_ORDER', 'OT9')] }), ctx([
      op({ id: 1, refs: [ref('QUOTE', 'D1')] }), op({ id: 2, providerKey: 'autre', refs: [ref('WORK_ORDER', 'OT9')] }),
    ]));
    expect(d).toMatchObject({ outcome: 'ARBITRATION_REQUIRED', reason: 'ARBITRATION_REQUIRED', operationId: null });
    // Lot 53 (PO-D5) : la référence de l'autre prestataire est « fragile » — proposée, jamais certaine.
    expect(d.arbitration?.operationIds).toEqual([1, 2]);
    expect(d.detail.certain.map((c) => c.operationId)).toEqual([1]);
    expect(d.detail.fragile).toEqual([2]);
  });

  it('C5-07 / EXH-004 / F-058 Opération seulement plausible (M3 requis, hors lot) → HOLD, pas de doublon', () => {
    const d = decideCandidate(cand({ refs: [] }), ctx([op({ refs: [] })]));
    expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
    expect(d.detail.plausible).toEqual([100]);
  });

  it('C5-08 / F-057 référence commune contredite par la cible → HOLD (CONTRADICTORY_REFERENCE)', () => {
    const d = decideCandidate(cand({ assetIds: [2], refs: [ref('INVOICE', 'F1')] }), ctx([op({ assetIds: [1], refs: [ref('INVOICE', 'F1')] })]));
    expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'CONTRADICTORY_REFERENCE' });
  });

  it('C5-09 / F-047 / F-046 décision utilisateur : CONFIRMED = M0 prioritaire ; REJECTED jamais rematché', () => {
    const ops = [op({ id: 1, refs: [ref('INVOICE', 'F1')] }), op({ id: 2, providerKey: 'x' })];
    expect(decideCandidate(cand({ refs: [ref('INVOICE', 'F1')] }), ctx(ops, { confirmed: new Set([2]) }))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 2, matchMethod: 'M0' });
    const r = decideCandidate(cand({ refs: [ref('INVOICE', 'F1')] }), ctx(ops, { rejected: new Set([1]) }));
    expect(r.operationId).toBeNull();
    expect(r.detail.excluded).toEqual([{ operationId: 1, why: 'USER_REJECTED' }]);
  });

  it('C5-10 périmètre : bien VENDU/TRANSMIS → seule une CESSION est créée ; ARCHIVÉ → aucune ; enrichissement permis', () => {
    const vendu = new Map([[1, 'VENDU']]);
    expect(decideCandidate(cand(), ctx([], { assetStatus: vendu }))).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'TARGET_OUT_OF_PORTFOLIO' });
    expect(decideCandidate(cand({ type: 'DISPOSAL', role: 'SALE_DOCUMENT' }), ctx([], { assetStatus: vendu })).outcome).toBe('CREATE_NEW');
    expect(decideCandidate(cand({ type: 'DISPOSAL' }), ctx([], { assetStatus: new Map([[1, 'ARCHIVED']]) })).outcome).toBe('HOLD_UNRESOLVED');
    expect(decideCandidate(cand({ refs: [ref('INVOICE', 'F1')] }), ctx([op({ refs: [ref('INVOICE', 'F1')] })], { assetStatus: vendu })).outcome).toBe('MATCH_AND_ENRICH');
  });

  it('C5-11 / F-061 / C9 même source documentaire déjà liée → M2 ; requalification de type connu → la source quitte l\'Opération', () => {
    expect(decideCandidate(cand(), ctx([op({ sameSource: true, providerKey: 'autre' })]))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', matchMethod: 'M2' });
    const d = decideCandidate(cand({ type: 'CONTRACT' }), ctx([op({ sameSource: true })]));
    expect(d.outcome).toBe('CREATE_NEW');
    expect(d.detail.excluded[0].why).toBe('SAME_SOURCE_TYPE_CHANGED');
  });

  it('C5-12 / F-054 type nul de l\'Opération : un candidat qualifié la rapproche (même id)', () => {
    expect(decideCandidate(cand({ refs: [ref('INVOICE', 'F1')] }), ctx([op({ typeCode: null, refs: [ref('INVOICE', 'F1')] })])).operationId).toBe(100);
  });
});

describe('C7 — règles fermées par type', () => {
  it('C7-01 / F-044 / F-045 ACQUISITION : même bien, même cycle de possession → même Opération ; après une CESSION réalisée → nouvelle', () => {
    const acq = op({ id: 1, typeCode: 'ACQUISITION', realizedDate: '2020-01-10', refs: [] });
    const c = cand({ type: 'ACQUISITION', dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null } });
    expect(decideCandidate(c, ctx([acq]))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 1, matchMethod: 'M2' });
    const ces = op({ id: 2, typeCode: 'DISPOSAL', realizedDate: '2023-05-01' });
    const rachat = decideCandidate(c, ctx([acq, ces]));
    expect(rachat.outcome).toBe('CREATE_NEW');
    expect(rachat.detail.excluded).toContainEqual({ operationId: 1, why: 'OTHER_OWNERSHIP_CYCLE' });
    // Document tardif de l'achat initial (daté avant la cession) : même cycle que lui.
    expect(decideCandidate(cand({ type: 'ACQUISITION', dates: { plannedDate: null, startDate: null, realizedDate: '2020-01-10', endDate: null } }), ctx([acq, ces])).operationId).toBe(1);
  });

  it('C7-01b ACQUISITION : référence de commande différente → hard negative, nouvelle Opération', () => {
    const d = decideCandidate(cand({ type: 'ACQUISITION', refs: [ref('ORDER', 'C2')] }), ctx([op({ typeCode: 'ACQUISITION', refs: [ref('ORDER', 'C1')] })]));
    expect(d.outcome).toBe('CREATE_NEW');
  });

  it('C7-02 / F-031 INTERVENTION : la facture cite le devis de l\'Opération → M1', () => {
    const d = decideCandidate(cand({ refs: [ref('INVOICE', 'FA1'), ref('QUOTE', 'DV-8841')] }), ctx([op({ status: 'ENVISAGED', refs: [ref('QUOTE', 'DV-8841')] })]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', matchMethod: 'M1' });
  });

  it('C7-02b / F-033 / PO-D6-01 INTERVENTION : même garage, factures de numéros différents → plus jamais deux Opérations d\'office (M3, puis l\'utilisateur)', () => {
    // Lot 53 (retour PO D6) : les numéros différents sont un indice contraire, plus une exclusion.
    const d = decideCandidate(cand({ refs: [ref('INVOICE', 'FA2')] }), ctx([op({ refs: [ref('INVOICE', 'FA1')] })]));
    expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
    expect(hardNegatives(cand({ refs: [ref('INVOICE', 'FA2')] }), op({ refs: [ref('INVOICE', 'FA1')] }))).toEqual([]);
  });

  it('C7-02c / F-034 INTERVENTION : même garage, même montant, aucune autre preuve → jamais un rapprochement (HOLD)', () => {
    const d = decideCandidate(cand({ refs: [] }), ctx([op()]));
    expect(d.outcome).toBe('HOLD_UNRESOLVED');
    expect(d.operationId).toBeNull();
  });

  it('C7-02d / F-060 INTERVENTION : cible explicitement incompatible → hard negative', () => {
    expect(hardNegatives(cand({ assetIds: [2] }), op({ assetIds: [1] }))).toContain('TARGET_INCOMPATIBLE');
    expect(decideCandidate(cand({ assetIds: [2] }), ctx([op({ assetIds: [1] })])).outcome).toBe('CREATE_NEW');
  });

  it('C7-02e / PO-D5-03 INTERVENTION : la fenêtre de 120 j est un indice — même prestataire et même bien hors fenêtre → plausible (M3) ; très loin (> 360 j) → rien de plausible', () => {
    expect(decideCandidate(cand({ dates: { plannedDate: null, startDate: null, realizedDate: '2026-12-01', endDate: null } }), ctx([op({ realizedDate: '2026-01-02' })])).reason).toBe('M3_REQUIRED');
    expect(decideCandidate(cand({ dates: { plannedDate: null, startDate: null, realizedDate: '2027-06-01', endDate: null } }), ctx([op({ realizedDate: '2026-01-02' })])).outcome).toBe('CREATE_NEW');
  });

  it('C7-03 / F-035 / F-036 / F-037 CONTRACT : même police → même contrat ; nouvelle police sans continuité → nouveau ; renouvellement citant l\'ancienne → même', () => {
    const contrat = op({ typeCode: 'CONTRACT', providerKey: 'assurhabitat', refs: [ref('POLICY', 'HAB-559201')] });
    const c = (refs: CandidateIdentity['refs']) => cand({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', providerKey: 'assurhabitat', refs });
    expect(decideCandidate(c([ref('POLICY', 'HAB-559201')]), ctx([contrat])).operationId).toBe(100);
    expect(decideCandidate(c([ref('POLICY', 'HAB-999')]), ctx([contrat])).outcome).toBe('CREATE_NEW');
    expect(decideCandidate(c([ref('POLICY', 'HAB-999'), ref('POLICY', 'HAB-559201')]), ctx([contrat])).operationId).toBe(100);
  });

  it('C7-03b CONTRACT : un numéro de contrat cité par une facture d\'intervention n\'identifie pas une autre intervention', () => {
    const d = decideCandidate(cand({ refs: [ref('CONTRACT', 'MAINT-1')], providerKey: 'x' }), ctx([op({ refs: [ref('CONTRACT', 'MAINT-1')], providerKey: 'y' })]));
    expect(d.outcome).toBe('CREATE_NEW');
  });

  it('C7-04 / F-038 / F-039 FINANCING : même référence de prêt → même ; deux prêts distincts → deux', () => {
    const pret = op({ typeCode: 'FINANCING', providerKey: 'banque', refs: [ref('LOAN', 'P1')] });
    expect(decideCandidate(cand({ type: 'FINANCING', providerKey: 'banque', refs: [ref('LOAN', 'P1')] }), ctx([pret])).operationId).toBe(100);
    expect(decideCandidate(cand({ type: 'FINANCING', providerKey: 'banque', refs: [ref('LOAN', 'P2')] }), ctx([pret])).outcome).toBe('CREATE_NEW');
  });

  it('C7-05 / F-040 / F-041 CLAIM : même référence assureur → même ; références distinctes le même jour → deux ; même jour sans référence → M3 (HOLD)', () => {
    const sinistre = op({ typeCode: 'CLAIM', realizedDate: '2026-03-03', refs: [ref('CLAIM', 'S1')] });
    const c = (refs: CandidateIdentity['refs']) => cand({ type: 'CLAIM', role: 'CLAIM_DOCUMENT', dates: { plannedDate: null, startDate: null, realizedDate: '2026-03-03', endDate: null }, refs });
    expect(decideCandidate(c([ref('CLAIM', 'S1')]), ctx([sinistre])).operationId).toBe(100);
    expect(decideCandidate(c([ref('CLAIM', 'S2')]), ctx([sinistre])).outcome).toBe('CREATE_NEW');
    expect(decideCandidate(c([]), ctx([op({ ...sinistre, refs: [] })]))).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
  });

  it('C7-06 / F-042 / F-043 DISPOSAL : même bien, cycle courant → enrichir ; après une nouvelle ACQUISITION → nouvelle cession', () => {
    const ces = op({ id: 1, typeCode: 'DISPOSAL', realizedDate: '2024-02-01' });
    const c = cand({ type: 'DISPOSAL', role: 'SALE_DOCUMENT', dates: { plannedDate: null, startDate: null, realizedDate: '2024-02-01', endDate: null } });
    expect(decideCandidate(c, ctx([ces]))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 1 });
    const acq = op({ id: 2, typeCode: 'ACQUISITION', realizedDate: '2025-01-01' });
    const revente = cand({ type: 'DISPOSAL', role: 'SALE_DOCUMENT', dates: { plannedDate: null, startDate: null, realizedDate: '2026-09-01', endDate: null } });
    expect(sameOwnershipCycle(revente, ces, [acq])).toBe(false);
    expect(decideCandidate(revente, ctx([ces, acq])).outcome).toBe('CREATE_NEW');
  });

  it('C7-07 / F-030 / INV-FINAL-008 type nul : rapprochement seulement M0/M1, faisceau → HOLD ; référence « autre » seulement entre types qualifiés égaux', () => {
    expect(decideCandidate(cand({ type: null }), ctx([op()])).outcome).toBe('HOLD_UNRESOLVED');
    expect(decideCandidate(cand({ type: null, refs: [ref('INVOICE', 'F1')] }), ctx([op({ refs: [ref('INVOICE', 'F1')] })])).operationId).toBe(100);
    expect(decideCandidate(cand({ type: null, providerKey: 'x', refs: [ref('OTHER', 'Z9')] }), ctx([op({ providerKey: 'y', refs: [ref('OTHER', 'Z9')] })])).outcome).toBe('CREATE_NEW');
    expect(decideCandidate(cand({ type: 'OTHER', providerKey: 'x', refs: [ref('OTHER', 'Z9')] }), ctx([op({ typeCode: 'OTHER', providerKey: 'y', refs: [ref('OTHER', 'Z9')] })])).operationId).toBe(100);
  });

  it('C7-08 hard negative de type : un CLAIM ne se rapproche jamais d\'une INTERVENTION même avec une référence commune de facture', () => {
    const d = decideCandidate(cand({ type: 'CLAIM', refs: [ref('INVOICE', 'F1')] }), ctx([op({ refs: [ref('INVOICE', 'F1')] })]));
    expect(d.outcome).toBe('HOLD_UNRESOLVED');
    expect(d.reason).toBe('CONTRADICTORY_REFERENCE');
  });
});
