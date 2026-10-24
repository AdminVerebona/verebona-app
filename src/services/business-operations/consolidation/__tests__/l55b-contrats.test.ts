/**
 * Lot 55B — factures d'un même contrat (règles pures). Tests nommés L55B-xx
 * (ticket P1 « rattacher automatiquement toutes les factures d'un même
 * contrat » : A qualification, B rapprochement, C rétroactif, D finances,
 * E diagnostics). Les scénarios bout en bout : l55b-contrats.e2e.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  decideCandidate, hardNegatives, isPlausible, operationsMergeable, plausibilityEvidence, recurringCrossType,
  type ExistingOperation, type MatchContext,
} from '../matching';
import {
  componentsFromIdentity, consolidateComponentsDetailed, consolidateOperationState, hasRecurringPeriod, recurringContractEvidence,
  type CandidateIdentity, type PersistedFinancialHint, type SourceContribution,
} from '../model';
import { retroActive } from '../retro';
import { aiRunLabel, explainReason, reconciliationView } from '../../diagnostics/model';

const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: value.replace(/[^A-Z0-9]/gi, '').toUpperCase() });
const echeance = (m: number, over: Partial<PersistedFinancialHint> = {}): PersistedFinancialHint => ({
  role: 'REALIZED_COST', amountMinor: 3990, currency: 'EUR', amountScope: 'INSTALLMENT', economicDate: `2026-0${m}-05`,
  periodStart: `2026-0${m}-01`, periodEnd: `2026-0${m}-28`, ...over,
});
function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Abonnement télésurveillance alarme', provider: 'Alpha', providerKey: 'alpha',
    assetIds: [1], targetAuthority: 'DOCUMENT', equipmentIds: [], refs: [ref('INVOICE', 'FA-02')],
    dates: { plannedDate: null, startDate: '2026-02-01', realizedDate: null, endDate: '2026-02-28' }, hints: [echeance(2)],
    ...over,
  };
}
function op(over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id: 100, typeCode: 'CONTRACT', status: 'REALIZED', providerKey: 'alpha', assetIds: [1], refs: [ref('INVOICE', 'FA-01')],
    plannedDate: null, startDate: '2026-01-01', realizedDate: null, endDate: '2026-01-31', ...over,
  };
}
const ctx = (operations: ExistingOperation[], over: Partial<MatchContext> = {}): MatchContext => ({
  operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map(), ...over,
});
const src = (sourceId: number, over: Partial<CandidateIdentity> = {}): SourceContribution => ({ sourceId, identity: cand({ candidateId: sourceId, fileId: sourceId, ...over }) });

describe('L55B (A) — échéance reconnue comme preuve d’un contrat', () => {
  it('L55B-A1 — période facturée réelle ou portée INSTALLMENT = échéance ; installation ponctuelle = non', () => {
    expect(hasRecurringPeriod(cand())).toBe(true);
    expect(hasRecurringPeriod(cand({ hints: [echeance(2, { amountScope: null })] }))).toBe(true);
    expect(hasRecurringPeriod(cand({ hints: [echeance(2, { amountScope: 'TOTAL', periodStart: null, periodEnd: null })] }))).toBe(false);
    expect(hasRecurringPeriod(cand({ hints: [echeance(2, { amountScope: null, periodEnd: '2026-02-01', periodStart: '2026-02-01' })] }))).toBe(false);
  });

  it('L55B-A2 / L55B-04 — échéances réunies (≥ 2 périodes, ou une source CONTRACT) → CONTRACT ; une installation parmi elles → type conservé', () => {
    const deux = [src(1, { hints: [echeance(1)] }), src(2, { hints: [echeance(2)] })];
    expect(recurringContractEvidence(deux)).toBe(true);
    expect(consolidateOperationState('INTERVENTION', deux, '2026-10-14').type).toBe('CONTRACT');
    expect(consolidateOperationState('INTERVENTION', deux, '2026-10-14', undefined, { recurringRequalification: false }).type).toBe('INTERVENTION');
    // Même période deux fois (copies) : aucune preuve de récurrence.
    expect(recurringContractEvidence([src(1, { hints: [echeance(1)] }), src(2, { hints: [echeance(1)] })])).toBe(false);
    expect(recurringContractEvidence([src(1, { type: 'CONTRACT', hints: [] }), src(2, { type: null })])).toBe(true);
    // Documents contractuels seuls sur une intervention : aucune échéance, type conservé (F-055).
    expect(recurringContractEvidence([src(1, { type: 'CONTRACT', hints: [] })])).toBe(false);
    const installation = src(3, { hints: [echeance(1, { amountScope: 'TOTAL', periodStart: null, periodEnd: null })], summary: 'Installation alarme' });
    expect(recurringContractEvidence([...deux, installation])).toBe(false);
    expect(consolidateOperationState('INTERVENTION', [...deux, installation], '2026-10-14').type).toBe('INTERVENTION');
  });

  // Lot 86C (test corrigé, ticket P1 « fausses dates de fin ») : l'ancienne assertion prenait la première et la
  // DERNIÈRE PÉRIODE FACTURÉE pour les dates d'effet du contrat. Une période facturée ne date jamais un contrat :
  // aucune date d'effet / de fin sans pièce contractuelle ; les périodes restent portées par les composantes.
  it('L55B-A3 / L86C-U-DATES-02 — requalification : les périodes facturées ne deviennent PAS les dates du contrat', () => {
    const s = consolidateOperationState(null, [src(1, { hints: [echeance(1)], dates: { plannedDate: null, startDate: '2026-01-01', realizedDate: null, endDate: '2026-01-31' } }),
      src(2, { hints: [echeance(3)], dates: { plannedDate: null, startDate: '2026-03-01', realizedDate: null, endDate: '2026-03-31' } })], '2026-10-14');
    expect(s).toMatchObject({ type: 'CONTRACT', startDate: null, endDate: null, realizedDate: null });
    expect(s.contract).toMatchObject({ effectiveFrom: null, effectiveTo: null });
    expect(s.components.map((c) => [c.periodStart, c.periodEnd])).toEqual([[echeance(1).periodStart, echeance(1).periodEnd], [echeance(3).periodStart, echeance(3).periodEnd]]);
  });
});

describe('L55B (B) — rapprochement : ne pas exclure prématurément, jamais rattacher sur un indice faible', () => {
  it('L55B-B1 — échéance qualifiée INTERVENTION face à un CONTRACT : plus TYPE_INCOMPATIBLE, plausible (M3 requis), jamais rattachée d’office', () => {
    const c = cand();
    expect(recurringCrossType(c, op())).toBe(true);
    expect(hardNegatives(c, op())).toEqual([]);
    expect(isPlausible(c, op())).toBe(true);
    expect(decideCandidate(c, ctx([op()]))).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED', operationId: null });
  });

  it('L55B-B2 / L55B-08 / F-033 — intervention ponctuelle (sans période) face à un CONTRACT : incompatibilité conservée', () => {
    const c = cand({ hints: [echeance(1, { amountScope: 'TOTAL', periodStart: null, periodEnd: null })] });
    expect(recurringCrossType(c, op())).toBe(false);
    expect(hardNegatives(c, op())).toContain('TYPE_INCOMPATIBLE');
  });

  it('L55B-B3 / L55B-07 — numéros de contrat différents : autre réalité, même si les qualifications diffèrent', () => {
    const c = cand({ refs: [ref('INVOICE', 'FA-02'), ref('CONTRACT', 'ALR-200')] });
    expect(hardNegatives(c, op({ refs: [ref('CONTRACT', 'ALR-100')] }))).toContain('REFERENCE_DIFFERENT_CONTRACT_POLICY');
    expect(decideCandidate(c, ctx([op({ refs: [ref('CONTRACT', 'ALR-100')] })])).outcome).toBe('CREATE_NEW');
  });

  it('L55B-B4 — jamais sur le seul prestataire : autre prestataire ou cible disjointe → non plausible', () => {
    expect(isPlausible(cand(), op({ providerKey: 'beta' }))).toBe(false);
    expect(isPlausible(cand(), op({ assetIds: [2] }))).toBe(false);
    // Même référence de contrat, prestataire non lu : plausible (M3 décide).
    expect(isPlausible(cand({ providerKey: null, refs: [ref('CONTRACT', 'ALR-1')] }), op({ providerKey: null, refs: [ref('CONTRACT', 'ALR-1')] }))).toBe(true);
  });

  it('L55B-B5 — CONTRACT face à une intervention d’échéances (périodique) : plausible ; face à une intervention ponctuelle : exclue', () => {
    const contrat = cand({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', hints: [] });
    expect(hardNegatives(contrat, op({ typeCode: 'INTERVENTION', periodic: true }))).toEqual([]);
    expect(isPlausible(contrat, op({ typeCode: 'INTERVENTION', periodic: true }))).toBe(true);
    expect(hardNegatives(contrat, op({ typeCode: 'INTERVENTION' }))).toContain('TYPE_INCOMPATIBLE');
  });

  it('L55B-B6 — entre échéances : écart de dates et numéros de facture distincts ne sont plus des indices contraires', () => {
    const loin = cand({ dates: { plannedDate: null, startDate: '2027-06-01', realizedDate: null, endDate: '2027-06-30' }, hints: [echeance(6, { periodStart: '2027-06-01', periodEnd: '2027-06-30' })] });
    const inter = op({ typeCode: 'INTERVENTION', periodic: true, label: 'Abonnement télésurveillance alarme' });
    const e = plausibilityEvidence(loin, inter);
    expect(e.signals).not.toContain('DATE_FAR');
    expect(e.signals).not.toContain('INVOICE_NUMBERS_DIFFERENT');
    expect(e.plausible).toBe(true);
    // Sans période des deux côtés (lot 53 inchangé) : indices contraires conservés.
    const e2 = plausibilityEvidence({ ...loin, hints: [] }, { ...inter, periodic: false });
    expect(e2.signals).toContain('DATE_FAR');
  });

  it('L55B-B7 — décisions utilisateur respectées : REJECTED exclut, CONFIRMED rattache (M0)', () => {
    expect(decideCandidate(cand(), ctx([op()], { rejected: new Set([100]) })).outcome).toBe('CREATE_NEW');
    expect(decideCandidate(cand(), ctx([op()], { confirmed: new Set([100]) }))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', matchMethod: 'M0', operationId: 100 });
  });
});

describe('L55B (C) — fusion de doublons : seulement sur identité établie', () => {
  const contrat = op({ id: 1 });
  const echeanceInter = op({ id: 2, typeCode: 'INTERVENTION', periodic: true, refs: [ref('INVOICE', 'FA-02')] });
  it('L55B-C1 — identité SÉMANTIQUE (M3 / utilisateur) : contrat + échéance « intervention » fusionnables ; numéros de facture distincts tolérés', () => {
    expect(operationsMergeable(contrat, echeanceInter)).toBe(false);
    expect(operationsMergeable(contrat, echeanceInter, undefined, { semantic: true })).toBe(true);
    const i1 = op({ id: 3, typeCode: 'INTERVENTION', refs: [ref('INVOICE', 'A')] });
    const i2 = op({ id: 4, typeCode: 'INTERVENTION', refs: [ref('INVOICE', 'B')] });
    expect(operationsMergeable(i1, i2)).toBe(false); // fusion par référence citée (F-033) inchangée
    expect(operationsMergeable(i1, i2, undefined, { semantic: true })).toBe(true); // D6
  });

  it('L55B-C2 — jamais : décision utilisateur qui sépare, autre prestataire, autre bien, contrats différents, intervention ponctuelle', () => {
    expect(operationsMergeable(contrat, echeanceInter, new Set(['1:2']), { semantic: true })).toBe(false);
    expect(operationsMergeable(contrat, { ...echeanceInter, providerKey: 'beta' }, undefined, { semantic: true })).toBe(false);
    expect(operationsMergeable(contrat, { ...echeanceInter, assetIds: [9] }, undefined, { semantic: true })).toBe(false);
    expect(operationsMergeable(op({ id: 1, refs: [ref('CONTRACT', 'X')] }), op({ id: 5, refs: [ref('CONTRACT', 'Y')] }), undefined, { semantic: true })).toBe(false);
    expect(operationsMergeable(contrat, { ...echeanceInter, periodic: false }, undefined, { semantic: true })).toBe(false);
    expect(operationsMergeable(op({ id: 6, typeCode: 'ACQUISITION' }), op({ id: 7, typeCode: 'CONTRACT' }), undefined, { semantic: true })).toBe(false);
  });

  it('L55B-C3 — reprise : examen rétroactif actif tant que marqué ou en attente, terminé sinon', () => {
    expect(retroActive({ retroRequested: { by: '0398' } })).toBe(true);
    expect(retroActive({ retro: { status: 'PENDING', operationId: 1 } })).toBe(true);
    expect(retroActive({ retro: { status: 'DONE', operationId: 1, result: 'NO_MATCH' } })).toBe(false);
    expect(retroActive(null)).toBe(false);
  });
});

describe('L55B (D) — composants financiers : source ≠ fait économique', () => {
  const comps = (...xs: Array<[number, Partial<CandidateIdentity>]>) =>
    consolidateComponentsDetailed(xs.map(([id, o]) => ({ sourceId: id, components: componentsFromIdentity(cand(o)) })));

  it('L55B-D1 / L55B-01 / F-111 — deux mensualités distinctes (même montant) → deux coûts', () => {
    const r = comps([1, { refs: [ref('INVOICE', 'FA-01')], hints: [echeance(1)] }], [2, { refs: [ref('INVOICE', 'FA-02')], hints: [echeance(2)] }]);
    expect(r.components.map((c) => c.amountMinor)).toEqual([3990, 3990]);
    // Sans numéro mais avec dates / périodes distinctes : toujours deux coûts (L55B-02).
    const s = comps([1, { refs: [], hints: [echeance(1)] }], [2, { refs: [], hints: [echeance(2)] }]);
    expect(s.components).toHaveLength(2);
    expect(s.uncertain).toEqual([]);
  });

  it('L55B-D2 / L55B-03 / F-032 — deux copies (même numéro) → un coût, deux preuves ; copie sans numéro lu, même date → même fait', () => {
    const r = comps([1, { hints: [echeance(1)] }], [2, { hints: [echeance(1)] }], [3, { refs: [], hints: [echeance(1)] }]);
    expect(r.components).toHaveLength(1);
    expect(r.components[0].sourceIds).toEqual([1, 2, 3]);
  });

  it('L55B-D3 / L55B-02 — ni référence, ni date, ni période : compté une fois, l’excédent tenu hors total (jamais additionné ni perdu)', () => {
    const nu = { refs: [], hints: [echeance(1, { economicDate: null, periodStart: null, periodEnd: null })] };
    const r = comps([1, nu], [2, nu]);
    expect(r.components).toHaveLength(1);
    expect(r.uncertain).toEqual([{ fingerprint: r.components[0].fingerprint, absorbedFingerprint: r.components[0].fingerprint, sourceIds: [2] }]);
    const etat = consolidateOperationState('CONTRACT', [src(1, nu), src(2, nu)], '2026-10-14');
    expect(etat.components).toHaveLength(1);
    expect(etat.sideAmounts.map((x) => [x.nature, x.amountMinor, x.sourceIds])).toEqual([['UNCERTAIN_DUPLICATE', 3990, [2]]]);
  });

  it('L55B-D4 — paiement : aucun coût ; avoir : réduction ; acompte + facture totale : pas de double compte ; montants contradictoires : signalés, jamais additionnés', () => {
    expect(componentsFromIdentity(cand({ role: 'PAYMENT_PROOF' }))).toEqual([]);
    expect(componentsFromIdentity(cand({ hints: [echeance(1, { role: 'PAYMENT' })] }))).toEqual([]);
    expect(componentsFromIdentity(cand({ role: 'CREDIT_NOTE', refs: [ref('INVOICE', 'AV-1')], hints: [echeance(1)] }))[0].kind).toBe('REDUCTION');
    const r = comps(
      [1, { role: 'DEPOSIT_INVOICE', refs: [ref('INVOICE', 'AC-1')], hints: [echeance(1, { amountScope: 'DEPOSIT', amountMinor: 1000, periodStart: null, periodEnd: null })] }],
      [2, { refs: [ref('INVOICE', 'F-1')], hints: [echeance(1, { amountScope: 'TOTAL', amountMinor: 3990, periodStart: null, periodEnd: null })] }],
    );
    expect(r.components.map((c) => c.amountMinor)).toEqual([3990]);
    const k = comps([1, { hints: [echeance(1)] }], [2, { hints: [echeance(1, { amountMinor: 4990 })] }]);
    expect(k.components).toHaveLength(1);
    expect(k.conflicts).toHaveLength(1);
  });
});

describe('L55B (E) — diagnostics BO', () => {
  it('L55B-E1 / L55B-11 — jamais « à jour » si un traitement reste bloqué ou en attente', () => {
    expect(reconciliationView({ pending: 0, blocked: 1, lastReconciledAt: '2026-10-14T10:00:00Z', active: true }).state).toBe('BLOQUEE');
    expect(reconciliationView({ pending: 2, blocked: 0, lastReconciledAt: '2026-10-14T10:00:00Z', active: true }).state).toBe('EN_ATTENTE');
    expect(reconciliationView({ pending: 0, blocked: 0, lastReconciledAt: null, active: true }).state).toBe('JAMAIS');
    expect(reconciliationView({ pending: 0, blocked: 0, lastReconciledAt: '2026-10-14T10:00:00Z', active: true }).state).toBe('A_JOUR');
  });

  it('L55B-E2 — exécution IA lisible : réalisée, différée, échouée, indisponible, attendue, sans objet', () => {
    expect(aiRunLabel({ m3: { status: 'DONE' } }, 'MATCH_AND_ENRICH', 'MATCH_M3')).toBe('IA exécutée');
    expect(aiRunLabel({ m3: { status: 'DEFERRED', detail: 'DAILY_CAP' } }, 'HOLD_UNRESOLVED', 'M3_REQUIRED')).toContain('différée');
    expect(aiRunLabel({ m3: { status: 'ERROR' } }, 'HOLD_UNRESOLVED', 'M3_REQUIRED')).toContain('échec');
    expect(aiRunLabel({ m3: { status: 'PROMPT_UNAVAILABLE' } }, 'HOLD_UNRESOLVED', 'M3_REQUIRED')).toContain('indisponible');
    expect(aiRunLabel({}, 'HOLD_UNRESOLVED', 'M3_REQUIRED')).toContain('attendue');
    expect(aiRunLabel({}, 'CREATE_NEW', 'NO_MATCH_ESTABLISHED')).toContain('sans appel IA');
    expect(explainReason('RETRO_MERGE')).toContain('rétroactif');
    expect(explainReason('T3_TYPE_RECURRING_CONTRACT')).toContain('contrat');
  });
});
