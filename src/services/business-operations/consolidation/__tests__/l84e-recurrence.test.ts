/**
 * Lot 84E — CDC v5 O-6 : identité de série (règles pures), contrôle 78A
 * (base SERIES), décision T3, liens directs (M04 étendu, garde
 * anti-cartésienne), registre de cohérence. Tests L84E-U-xx.
 * Les scénarios PostgreSQL : src/test/e2e/scenarios/l84e-recurrence-reconsolidation.e2e.ts.
 */
import { describe, expect, it } from 'vitest';
import { decideCandidate, type ExistingOperation, type MatchContext } from '../matching';
import type { CandidateIdentity, PersistedFinancialHint } from '../model';
import { assessSeries, candidatePeriods, isSeriesWhy, periodsOverlap, serviceNatureTokens } from '../recurrence';
import { assessEconomicIdentity, footprintOfIdentity, type EconomicFootprint } from '../economic-identity';
import { equipmentFactsOfTargets } from '../direct-links';
import { matchDocumentToEquipments, type DocumentProfile, type EquipmentProfile } from '@/services/equipment/document-equipment-matching';
import { restrictMatch } from '@/services/equipment/document-equipment-link.service';
import { guardDocumentEquipmentLinks } from '../../grouping/model';

const norm = (v: string) => v.replace(/[^A-Z0-9]/gi, '').toUpperCase();
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: norm(value) });
const pad = (m: number) => String(m).padStart(2, '0');
const echeance = (m: number, over: Partial<PersistedFinancialHint> = {}): PersistedFinancialHint => ({
  role: 'REALIZED_COST', amountMinor: 3990, currency: 'EUR', amountScope: 'INSTALLMENT', economicDate: `2026-${pad(m)}-05`,
  periodStart: `2026-${pad(m)}-01`, periodEnd: `2026-${pad(m)}-28`, ...over,
});
function facture(m: number, over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: m, candidateKey: 'op1', fileId: 100 + m, established: true, confidence: 'certain', type: 'INTERVENTION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Abonnement télésurveillance', provider: 'Homiris', providerKey: 'homiris',
    assetIds: [1], targetAuthority: 'DOCUMENT', equipmentIds: [], refs: [ref('INVOICE', `FH-${m}`), ref('CUSTOMER', 'CL-7781')],
    dates: { plannedDate: null, startDate: `2026-${pad(m)}-01`, realizedDate: null, endDate: `2026-${pad(m)}-28` }, hints: [echeance(m)],
    ...over,
  };
}
function serie(over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id: 500, typeCode: 'INTERVENTION', status: 'REALIZED', providerKey: 'homiris', assetIds: [1],
    refs: [{ kind: 'INVOICE', normalized: 'FH1' }, { kind: 'CUSTOMER', normalized: 'CL7781' }],
    plannedDate: null, startDate: '2026-01-01', realizedDate: null, endDate: '2026-01-28', periodic: true,
    periods: ['2026-01-01/2026-01-28'], label: 'Abonnement télésurveillance',
    amounts: [{ kind: 'REALIZED_COST', amountMinor: 3990, currency: 'EUR' }], ...over,
  };
}
const ctx = (operations: ExistingOperation[], over: Partial<MatchContext> = {}): MatchContext => ({
  operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map(), ...over,
});

describe('L84E-U-SERIES — identité de série (contrat T1 actuel, lecture déterministe)', () => {
  it('L84E-U01 / AC45 — même prestataire + compte client commun + échéances : série ÉTABLIE (clé CUSTOMER)', () => {
    const a = assessSeries(facture(2), serie());
    expect(a).toEqual({ level: 'ESTABLISHED', keys: ['CUSTOMER:CL7781'], reasons: [] });
  });

  it('L84E-U02 — clés de service : contrat / police, équipement certain ; un prestataire seul ne suffit jamais (§9.1)', () => {
    expect(assessSeries(facture(2, { refs: [ref('CONTRACT', 'ALR 55')] }), serie({ refs: [{ kind: 'CONTRACT', normalized: 'ALR55' }] })).keys).toEqual(['CONTRACT:ALR55']);
    expect(assessSeries(facture(2, { refs: [], equipmentIds: [9] }), serie({ refs: [], equipmentIds: [9] })).keys).toEqual(['EQUIPMENT:9']);
    expect(assessSeries(facture(2, { refs: [] }), serie({ refs: [] }))).toEqual({ level: 'NONE', keys: [], reasons: ['NO_SERVICE_KEY'] });
  });

  it('L84E-U03 — deux contrats distincts du même prestataire : DISTINCT (références de contrat différentes, équipements disjoints)', () => {
    expect(assessSeries(facture(2, { refs: [ref('CONTRACT', 'A-1'), ref('CUSTOMER', 'CL-7781')] }), serie({ refs: [{ kind: 'CONTRACT', normalized: 'A2' }, { kind: 'CUSTOMER', normalized: 'CL7781' }] })))
      .toMatchObject({ level: 'DISTINCT', reasons: ['REFERENCE_DIFFERENT_CONTRACT_POLICY'] });
    expect(assessSeries(facture(2, { equipmentIds: [3] }), serie({ equipmentIds: [4] }))).toMatchObject({ level: 'DISTINCT', reasons: ['EQUIPMENT_DISJOINT'] });
  });

  it('L84E-U04 — prudence : période déjà facturée (deux services parallèles), natures différentes, n° client différent, prestataire inconnu → NONE (le faisceau / M3 décide)', () => {
    expect(assessSeries(facture(1), serie()).reasons).toEqual(['PERIOD_ALREADY_BILLED']);
    expect(assessSeries(facture(2, { summary: 'Abonnement électricité' }), serie({ label: 'Abonnement gaz naturel' })).reasons).toEqual(['SERVICE_NATURE_DIFFERENT']);
    expect(assessSeries(facture(2, { refs: [ref('CUSTOMER', 'CL-1')] }), serie()).reasons).toEqual(['CUSTOMER_DIFFERENT']);
    expect(assessSeries(facture(2, { providerKey: null }), serie()).reasons).toEqual(['PROVIDER_UNKNOWN']);
    expect(assessSeries(facture(2, { providerKey: 'verisure' }), serie()).reasons).toEqual(['PROVIDER_DIFFERENT']);
    expect(assessSeries(facture(2, { hints: [], type: 'INTERVENTION' }), serie()).level).toBe('NONE');
    expect(assessSeries(facture(2), serie({ typeCode: 'ACQUISITION' })).level).toBe('NONE');
  });

  it('L84E-U05 — outils purs : périodes, chevauchement, mots de nature (calendrier et facturation récurrente neutres)', () => {
    expect(candidatePeriods(facture(3))).toEqual(['2026-03-01/2026-03-28']);
    expect(periodsOverlap('2026-01-01/2026-01-31', '2026-01-15/2026-02-14')).toBe(true);
    expect(periodsOverlap('2026-01-01/2026-01-31', '2026-02-01/2026-02-28')).toBe(false);
    expect([...serviceNatureTokens('Facture mensuelle abonnement télésurveillance — mars 2026')]).toEqual(['telesurveillance']);
  });
});

describe('L84E-U-78A — contrôle d’identité économique, base SERIES', () => {
  const fp = (montant: number, over: Partial<EconomicFootprint> = {}): EconomicFootprint => ({
    ...footprintOfIdentity(facture(2, { hints: [echeance(2, { amountMinor: montant })] })), ...over,
  });
  it('L84E-U06 / AC46 — montants d’échéance différents : jamais une contradiction ; × 10 : contradiction FORTE', () => {
    expect(assessEconomicIdentity(fp(3990), fp(4590), 'SERIES').verdict).toBe('CONFIRMED');
    const x = assessEconomicIdentity(fp(3990), fp(39900), 'SERIES');
    expect(x).toMatchObject({ verdict: 'CONTRADICTED', strong: ['AMOUNT_INCOMPATIBLE'] });
    // Base historique inchangée : des échéances ne se comparent pas (55B).
    expect(assessEconomicIdentity(fp(3990), fp(39900), 'REFERENCE').verdict).toBe('CONFIRMED');
  });
  it('L84E-U07 — un abonnement dure : l’écart de dates n’est pas une contradiction en base SERIES (il l’est ailleurs)', () => {
    const a = fp(3990, { date: '2022-01-01', type: 'INTERVENTION' });
    const b = fp(3990, { date: '2026-01-01', type: 'INTERVENTION' });
    expect(assessEconomicIdentity(a, b, 'SERIES').weak).not.toContain('DATE_APART');
    expect(assessEconomicIdentity(a, b, 'SAME_SOURCE').weak).toContain('DATE_APART');
  });
});

describe('L84E-U-T3 — décision T3 (AC11–AC13, décisions utilisateur, fragments)', () => {
  it('L84E-U08 / AC11 / AC46 — série établie : rattachement CERTAIN automatique (M1 SERIES), montant et période différents', () => {
    const d = decideCandidate(facture(2, { hints: [echeance(2, { amountMinor: 4290 })] }), ctx([serie()]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 500, matchMethod: 'M1' });
    expect(d.detail.certain.map((x) => x.why)).toEqual(['SERIES CUSTOMER:CL7781']);
  });
  it('L84E-U09 / AC12 / AC13 — sans clé de service : plausible (M3 puis « À traiter ») ; autre prestataire sans clé : rien de plausible', () => {
    expect(decideCandidate(facture(2, { refs: [ref('INVOICE', 'FH-2')] }), ctx([serie({ refs: [] })])).reason).toBe('M3_REQUIRED');
    expect(decideCandidate(facture(2, { refs: [], providerKey: 'verisure', provider: 'Verisure' }), ctx([serie({ refs: [] })])).outcome).toBe('CREATE_NEW');
  });
  it('L84E-U10 — deux contrats distincts (n° de contrat différents) : exclus d’office, aucun appel IA (aucune plausibilité)', () => {
    const d = decideCandidate(facture(2, { refs: [ref('CONTRACT', 'A-1')] }), ctx([serie({ refs: [{ kind: 'CONTRACT', normalized: 'A2' }] })]));
    expect(d.outcome).toBe('CREATE_NEW');
    expect(d.detail.plausible).toEqual([]);
    expect(d.detail.excluded[0].why).toMatch(/^SERIES_DISTINCT REFERENCE_DIFFERENT_CONTRACT_POLICY/);
  });
  it('L84E-U11 — montants contradictoires (× 10) : refusé par 78A, jamais regroupé, trace REFUSED', () => {
    const d = decideCandidate(facture(2, { hints: [echeance(2, { amountMinor: 399000 })] }), ctx([serie()]));
    expect(d.outcome).toBe('CREATE_NEW');
    expect(d.detail.excluded).toEqual([{ operationId: 500, why: 'SERIES_IDENTITY_CONTRADICTED' }]);
    expect(d.detail.identity?.[0]).toMatchObject({ basis: 'SERIES', outcome: 'REFUSED' });
  });
  it('L84E-U12 / §10 — décision utilisateur : un rejet n’est jamais défait par la série ; une confirmation prime', () => {
    expect(decideCandidate(facture(2), ctx([serie()], { rejected: new Set([500]) })).operationId).toBeNull();
    const d = decideCandidate(facture(2), ctx([serie(), serie({ id: 600 })], { confirmed: new Set([600]) }));
    expect(d).toMatchObject({ operationId: 600, matchMethod: 'M0' });
  });
  it('L84E-U13 — deux fragments d’une même série : fusion « sémantique » (n° de facture distincts tolérés), sans carte', () => {
    const a = serie({ id: 500 });
    const b = serie({ id: 501, refs: [{ kind: 'INVOICE', normalized: 'FH3' }, { kind: 'CUSTOMER', normalized: 'CL7781' }], periods: ['2026-03-01/2026-03-28'] });
    const d = decideCandidate(facture(2), ctx([a, b]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 500, mergeIds: [501] });
  });
  it('L84E-U14 — la propre Opération du document n’est réunie que si elle est un fragment de série (jamais une intervention ponctuelle entraînée)', () => {
    const propre = (periodic: boolean) => serie({
      id: 400, sameSource: true, sameSourceSolo: false, periods: [],
      members: [{ sourceId: 1, anchor: true, footprint: { ...footprintOfIdentity(facture(9, { hints: [] })), periodic, type: 'INTERVENTION' } }],
    });
    const fragment = decideCandidate(facture(2), ctx([propre(true), serie()]));
    expect(fragment).toMatchObject({ outcome: 'MATCH_AND_ENRICH', mergeIds: [500] });
    const mixte = decideCandidate(facture(2), ctx([propre(false), serie()]));
    expect(mixte).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 400, matchMethod: 'M2' });
    expect(mixte.detail.excluded).toContainEqual({ operationId: 500, why: 'SERIES_OWN_OPERATION_NOT_A_FRAGMENT' });
    expect(isSeriesWhy('SERIES CUSTOMER:X')).toBe(true);
  });
});

describe('L84E-U-LINKS — liens directs (M04 étendu au contrat T1 actuel, anti-cartésien)', () => {
  const eq = (id: number, name: string): EquipmentProfile => ({ id, assetId: 1, assetName: 'Maison', name, type: null, category: null, brand: null, model: null, serialNumber: null, room: null, features: [] });
  const doc = (facts: DocumentProfile['facts'], title = 'Facture Homiris'): DocumentProfile => ({
    fileId: 7, title, typeCode: 'FACTURE', description: null, supplier: 'Homiris', documentDate: null, amountCents: null, assetIds: [1], assetNames: ['Maison'], facts,
  });
  it('L84E-U15 — cibles ÉQUIPEMENT du candidat : identifiant vérifié → fait ciblé ; désignation brute → désignation ; probable ignorée en amont', () => {
    const f = equipmentFactsOfTargets([{ entityId: 12, rawLabel: 'Chaudière' }, { entityId: null, rawLabel: 'Alarme Homiris' }, { entityId: null, rawLabel: ' alarme homiris ' }, { entityId: null, rawLabel: null }]);
    expect(f.map((x) => [x.key, x.targetId, x.value])).toEqual([['operationEquipmentTarget', 12, 'Chaudière'], ['operationEquipmentDesignation', null, 'Alarme Homiris']]);
  });
  it('L84E-U16 / AC48 — désignation brute « Alarme Homiris » → lien DÉSIGNATION vers « Alarme » ; facture sans mention → aucun lien (AC50)', () => {
    const equipements = [eq(1, 'Alarme'), eq(2, 'Chaudière')];
    const avec = matchDocumentToEquipments(doc(equipmentFactsOfTargets([{ entityId: null, rawLabel: 'Alarme Homiris' }])), equipements);
    expect(avec.links.map((l) => [l.equipmentId, l.method])).toEqual([[1, 'DESIGNATION']]);
    expect(matchDocumentToEquipments(doc([], 'Frais de dossier'), equipements).links).toEqual([]);
  });
  it('L84E-U17 / P19 — l’Opération ne lève jamais une ambiguïté : groupe en concurrence dont un seul membre est dans l’Opération → aucun lien', () => {
    const m = matchDocumentToEquipments(doc(equipmentFactsOfTargets([{ entityId: null, rawLabel: 'Radiateur' }])), [eq(1, 'Radiateur'), eq(2, 'Radiateur')]);
    expect(m.groups).toEqual([[1, 2]]);
    expect(restrictMatch(m, new Set([1]))).toEqual({ links: [], groups: [], ambiguous: [], status: 'NONE' });
    expect(restrictMatch(m, new Set([1, 2])).status).toBe('AMBIGUOUS');
  });
  it('L84E-U18 / AC50 — garde 82D : preuve propre à chaque document (référence par document), aucune propagation', () => {
    const p = [5, 6].map((fileId) => ({ fileId, equipmentId: 1, evidence: { kind: 'IDENTIFIER' as const, fileId, ref: `${fileId}:DESIGNATION` } }));
    expect(guardDocumentEquipmentLinks(p, { memberFileIds: [5, 6], equipmentIds: [1] }).accepted).toHaveLength(2);
    const sans = [{ fileId: 7, equipmentId: 1, evidence: null }];
    expect(guardDocumentEquipmentLinks(sans, { memberFileIds: [7], equipmentIds: [1] }).rejected[0].reason).toBe('NO_PER_DOCUMENT_EVIDENCE');
  });
});

describe('L84E-U-REG — registre de cohérence (C-Q11)', () => {
  it('L84E-U19 — COH-OPS-RECURRING-SERIES actif, en fin de registre ; COH-DOC-LINKS v3 réparé par O-6 ; couverture « operations » mise à jour', async () => {
    const { COHERENCE_REGISTRY, getCheck, activeChecks } = await import('@/services/coherence/registry');
    // Lot 85B : d'autres contrôles sont ajoutés APRÈS (fin de liste) — la position laissée par 84E est conservée.
    const ids = COHERENCE_REGISTRY.map((x) => x.id);
    expect(ids[ids.indexOf('COH-DUO-RELATIONS') + 1]).toBe('COH-OPS-RECURRING-SERIES');
    expect(activeChecks().map((c) => c.id)).toContain('COH-OPS-RECURRING-SERIES');
    const c = getCheck('COH-OPS-RECURRING-SERIES')!;
    expect(c.services).toEqual(expect.arrayContaining(['business-operations/consolidation/targeted#reconsolidateRecurringDocuments']));
    expect(c.forbiddenRepairs).toEqual(expect.arrayContaining(['regrouper sur le seul prestataire', 'défaire une décision de l’utilisateur']));
    expect(getCheck('COH-DOC-LINKS')).toMatchObject({ version: 3 });
    expect(getCheck('COH-DOC-LINKS')!.services).toContain('business-operations/consolidation/targeted#recomputeDirectLinksForOperations');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    expect(COVERAGE_INVENTORY.find((e) => e.domain === 'operations')!.checks).toContain('COH-OPS-RECURRING-SERIES');
  });
});
