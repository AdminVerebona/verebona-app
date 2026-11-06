/**
 * Lot 111S — acquisition prouvée par un justificatif : règles PURES.
 *
 *   L111S-U-CORROBORATION  corroboration canonique d'un candidat (identité T3) : probable → certain,
 *                          sans type (seul établi) → ACQUISITION ; jamais pour un devis, une commande,
 *                          un acompte, un paiement, un autre type, une autre cible, un autre document.
 *   L111S-U-DECISION       décision T3 : sans preuve canonique → HOLD PROBABLE_WITHOUT_MATCH (rupture
 *                          constatée avant correctif) ; corroboré → CREATE_NEW, trace dans la décision.
 *   L111S-U-VERDICT        verdict du contrôle COH-OPS-ACQUISITION-DOCUMENT (toutes les branches).
 *   L111S-U-REGISTRE       contrôle déclaré en fin de registre, couverture, interdits.
 */
import { describe, expect, it } from 'vitest';
import { buildCandidateIdentity, type CandidateRecord } from '@/services/business-operations/consolidation/model';
import { decideCandidate } from '@/services/business-operations/consolidation/matching';
import {
  ACQUISITION_CORROBORATION, acquisitionEvidenceIndex, acquisitionEvidenceSql, corroborateAcquisition,
} from '@/services/business-operations/consolidation/acquisition-corroboration';
import {
  acquisitionDocumentVerdict, operationsAcquisitionDocumentCheck, type AcquisitionCandidateFacts, type AcquisitionDocumentFacts,
} from '@/services/coherence/registry/checks/operations-acquisition-document';
import { COHERENCE_REGISTRY } from '@/services/coherence/registry';
import { COVERAGE_INVENTORY } from '@/services/coherence/registry/coverage';

const BIEN = 10;
const FICHIER = 500;

function record(over: Partial<CandidateRecord> & { role?: string | null; targets?: Array<{ type: 'ASSET' | 'EQUIPMENT'; entityId: number }> } = {}): CandidateRecord {
  const { role = 'INVOICE', targets = [{ type: 'ASSET', entityId: BIEN }], ...rest } = over;
  return {
    id: 1, accountId: 1, fileId: FICHIER, candidateKey: 'op1', established: true, confidence: 'probable', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
    summary: 'Achat du vélo',
    payload: {
      sourceRoleHint: role, provider: 'Magasin Exemple', targetHints: targets.map((t) => ({ ...t, confidence: 'certain' })), businessReferences: [],
      temporalHints: {}, financialHints: [{ role: 'REALIZED_COST', amountMinor: 120000, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2024-05-02' }],
    },
    ...rest,
  };
}
const preuves = (...rows: Array<[string, number, number]>) => acquisitionEvidenceIndex(rows.map(([t, id, f]) => ({ target_type: t, target_id: id, file_id: f })));
const ctx = (evidence = preuves(['ASSET', BIEN, FICHIER]), extra: Record<string, unknown> = {}) => ({
  fileAssetId: BIEN, liveAssetIds: new Set([BIEN]), equipmentAssets: new Map([[77, BIEN]]), acquisitionEvidence: evidence, ...extra,
});

describe('L111S-U-CORROBORATION — preuve canonique de CE document sur SA cible', () => {
  it('candidat probable d’une facture d’achat du bien, preuve canonique du même document → certain, trace', () => {
    const id = buildCandidateIdentity(record(), ctx());
    expect(id.confidence).toBe('certain');
    expect(id.type).toBe('ACQUISITION');
    expect(id.corroboration).toEqual({ code: ACQUISITION_CORROBORATION, confidence: 'certain', target: `ASSET:${BIEN}` });
  });

  it('candidat sans type, seul établi du document → ACQUISITION ; deux candidats établis → jamais', () => {
    const seul = record({ typeHint: null, confidence: 'certain' });
    expect(buildCandidateIdentity(seul, ctx(undefined, { documentCandidates: [seul] }))).toMatchObject({ type: 'ACQUISITION', corroboration: { type: 'ACQUISITION' } });
    const autre = record({ id: 2, candidateKey: 'op2', typeHint: 'INTERVENTION', confidence: 'certain' });
    expect(buildCandidateIdentity(seul, ctx(undefined, { documentCandidates: [seul, autre] })).type).toBeNull();
  });

  it.each([
    ['devis', { role: 'QUOTE' }], ['commande', { role: 'ORDER' }], ['facture d’acompte', { role: 'DEPOSIT_INVOICE' }],
    ['preuve de paiement', { role: 'PAYMENT_PROOF' }], ['avoir', { role: 'CREDIT_NOTE' }],
    ['type connu ≠ acquisition (travaux)', { typeHint: 'INTERVENTION' }], ['non établi', { established: false }],
    ['statut envisagé', { statusHint: 'ENVISAGED' }],
  ] as const)('jamais corroboré : %s', (_l, over) => {
    const id = buildCandidateIdentity(record(over as never), ctx());
    expect(id.corroboration).toBeUndefined();
    expect(id.confidence).toBe((over as { established?: boolean }).established === false ? 'probable' : 'probable');
  });

  it('preuve d’un AUTRE document, ou sur une autre cible → aucune corroboration', () => {
    expect(buildCandidateIdentity(record(), ctx(preuves(['ASSET', BIEN, 999]))).corroboration).toBeUndefined();
    expect(buildCandidateIdentity(record(), ctx(preuves(['ASSET', 11, FICHIER]))).corroboration).toBeUndefined();
    expect(buildCandidateIdentity(record(), ctx(undefined)).confidence).toBe('certain');
    expect(buildCandidateIdentity(record(), { ...ctx(), acquisitionEvidence: undefined }).corroboration).toBeUndefined();
  });

  it('équipement : la preuve du BIEN parent ne corrobore jamais l’achat de l’équipement, celle de l’équipement oui', () => {
    const eq = record({ targets: [{ type: 'EQUIPMENT', entityId: 77 }] });
    expect(buildCandidateIdentity(eq, ctx(preuves(['ASSET', BIEN, FICHIER]))).corroboration).toBeUndefined();
    expect(buildCandidateIdentity(eq, ctx(preuves(['EQUIPMENT', 77, FICHIER]))).corroboration).toMatchObject({ target: 'EQUIPMENT:77' });
  });

  it('plusieurs biens visés (facture multibiens) → aucune corroboration', () => {
    const multi = record({ targets: [{ type: 'ASSET', entityId: BIEN }, { type: 'ASSET', entityId: 11 }] });
    expect(buildCandidateIdentity(multi, ctx(preuves(['ASSET', BIEN, FICHIER], ['ASSET', 11, FICHIER]), { liveAssetIds: new Set([BIEN, 11]) })).corroboration).toBeUndefined();
  });

  it('fonction pure : candidat déjà certain et typé → rien à corroborer ; requête des preuves sans valeur injectable', () => {
    expect(corroborateAcquisition({ fileId: 1, established: true, confidence: 'certain', type: 'ACQUISITION', status: 'REALIZED', role: 'INVOICE', assetIds: [1], equipmentIds: [], documentEstablished: 1 },
      preuves(['ASSET', 1, 1]))).toBeNull();
    const q = acquisitionEvidenceSql(3, [1, 2, Number.NaN], []);
    expect(q).toContain("'{1,2}'");
    expect(q).toContain("'{}'");
    expect(q).toMatch(/ACQUISITION_PRICE_BASKET_TOTAL/);
    expect(() => acquisitionEvidenceSql(Number.NaN, [], [])).toThrow();
  });
});

describe('L111S-U-DECISION — décision T3 (avant / après correctif)', () => {
  const m = { operations: [], rejected: new Set<number>(), confirmed: new Set<number>(), assetStatus: new Map<number, string>() };
  it('sans preuve canonique : abstention HOLD_UNRESOLVED / PROBABLE_WITHOUT_MATCH (rupture constatée)', () => {
    const id = buildCandidateIdentity(record(), { ...ctx(), acquisitionEvidence: undefined });
    expect(decideCandidate(id, m as never)).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'PROBABLE_WITHOUT_MATCH' });
  });
  it('corroboré : CREATE_NEW (aucune correspondance), corroboration tracée dans la décision', () => {
    const d = decideCandidate(buildCandidateIdentity(record(), ctx()), m as never);
    expect(d).toMatchObject({ outcome: 'CREATE_NEW', reason: 'NO_MATCH_ESTABLISHED' });
    expect(d.detail.corroboration).toMatchObject({ code: ACQUISITION_CORROBORATION, target: `ASSET:${BIEN}` });
  });
});

describe('L111S-U-VERDICT — COH-OPS-ACQUISITION-DOCUMENT', () => {
  const op = (over: Partial<NonNullable<AcquisitionCandidateFacts['operation']>> = {}) => ({
    id: 7, active: true, typeCode: 'ACQUISITION', status: 'REALIZED', documentSource: true, assetLinked: true, projection: 'OK' as const, events: 1, ...over,
  });
  const cand = (over: Partial<AcquisitionCandidateFacts> = {}): AcquisitionCandidateFacts => ({
    id: 1, confidence: 'certain', pending: false, pendingStale: false, outcome: 'CREATE_NEW', reason: 'NO_MATCH_ESTABLISHED', corroborated: false,
    targetsLiveAsset: true, operation: op(), ...over,
  });
  const doc = (over: Partial<AcquisitionDocumentFacts> = {}): AcquisitionDocumentFacts => ({
    fileId: FICHIER, analyzing: false, candidatesEver: 1, otherCandidates: [], evidenceTargets: [`ASSET:${BIEN}`], targetHasAcquisition: true,
    t1Relaunched: false, acquisitions: [cand()], ...over,
  });
  const v = (d: AcquisitionDocumentFacts, budget = 5) => acquisitionDocumentVerdict(d, budget);

  it('chaîne complète → CONSISTENT ; analyse en cours → CONSISTENT (attente)', () => {
    expect(v(doc()).verdict).toBe('CONSISTENT');
    expect(v(doc({ analyzing: true, acquisitions: [] }))).toMatchObject({ verdict: 'CONSISTENT', detail: { waiting: 'ANALYSIS_IN_PROGRESS' } });
  });
  it.each([
    ['candidat à consolider (délai dépassé)', cand({ pending: true, pendingStale: true, outcome: null }), 'ACQUISITION_CANDIDATE_NOT_CONSOLIDATED', 'T3'],
    ['probable corroboré resté en attente', cand({ outcome: 'HOLD_UNRESOLVED', reason: 'PROBABLE_WITHOUT_MATCH', corroborated: true, operation: null }), 'ACQUISITION_CORROBORATED_NOT_CONSOLIDATED', 'T3'],
    ['Opération invalidée', cand({ operation: op({ active: false }) }), 'ACQUISITION_OPERATION_INACTIVE', 'T3'],
    ['Opération absente', cand({ operation: null }), 'ACQUISITION_OPERATION_INACTIVE', 'T3'],
    ['source du document inactive', cand({ operation: op({ documentSource: false }) }), 'ACQUISITION_SOURCE_MISSING', 'T3'],
    ['Opération sans lien au bien', cand({ operation: op({ assetLinked: false }) }), 'ACQUISITION_OPERATION_UNLINKED', 'T3'],
    ['historique absent', cand({ operation: op({ projection: 'MISSING', events: 0 }) }), 'ACQUISITION_EVENT_MISSING', 'T4'],
    ['historique désynchronisé', cand({ operation: op({ projection: 'OUT_OF_SYNC' }) }), 'ACQUISITION_EVENT_OUT_OF_SYNC', 'T4'],
    ['jamais décidé', cand({ outcome: null, reason: null, operation: null }), 'ACQUISITION_CANDIDATE_NOT_CONSOLIDATED', 'T3'],
  ])('%s → REPAIRABLE', (_l, c, anomaly, repair) => {
    const i = v(doc({ acquisitions: [c] }));
    expect(i).toMatchObject({ verdict: 'REPAIRABLE', anomaly, detail: { repair } });
    expect(i.inputHash).toMatch(/^[0-9a-f]{24}$/);
  });
  it('candidat récent encore en file T3 → CONSISTENT (aucune réparation concurrente)', () => {
    expect(v(doc({ acquisitions: [cand({ pending: true, outcome: null })] }))).toMatchObject({ verdict: 'CONSISTENT', detail: { waiting: 'T3_QUEUE' } });
  });
  it.each([
    ['probable sans preuve canonique', cand({ outcome: 'HOLD_UNRESOLVED', reason: 'PROBABLE_WITHOUT_MATCH', confidence: 'probable', operation: null }), 'ACQUISITION_NOT_PROVEN'],
    ['examen M3 / contradiction', cand({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED', operation: null }), 'ACQUISITION_UNRESOLVED'],
    ['arbitrage « À traiter »', cand({ outcome: 'ARBITRATION_REQUIRED', reason: 'ARBITRATION_REQUIRED', operation: null }), 'ACQUISITION_ARBITRATION_PENDING'],
    ['Opération d’un autre type', cand({ operation: op({ typeCode: 'INTERVENTION' }) }), 'ACQUISITION_OPERATION_REQUALIFIED'],
  ])('%s → AMBIGUOUS (aucune écriture)', (_l, c, anomaly) => {
    expect(v(doc({ acquisitions: [c] }))).toMatchObject({ verdict: 'AMBIGUOUS', anomaly });
  });
  it('le constat le plus actionnable l’emporte entre deux candidats', () => {
    expect(v(doc({ acquisitions: [cand({ outcome: 'ARBITRATION_REQUIRED', operation: null }), cand({ id: 2, operation: op({ projection: 'MISSING' }) })] })).anomaly).toBe('ACQUISITION_EVENT_MISSING');
  });
  it('candidat absent : relance T1 budgétée une seule fois ; budget épuisé → constat ; relancé ou candidats non retenus → FINDING', () => {
    const absent = doc({ acquisitions: [], candidatesEver: 0, targetHasAcquisition: false });
    expect(v(absent)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'ACQUISITION_CANDIDATE_ABSENT', faultyLink: 'T1', detail: { repair: 'T1' } });
    expect(v(absent, 0)).toMatchObject({ verdict: 'FINDING', anomaly: 'ACQUISITION_CANDIDATE_ABSENT', detail: { relaunchBudgetReached: true } });
    expect(v({ ...absent, t1Relaunched: true })).toMatchObject({ verdict: 'FINDING', anomaly: 'ACQUISITION_CANDIDATE_NOT_PRODUCED' });
    const exclus = { ...absent, candidatesEver: 2, otherCandidates: [{ type: 'ACQUISITION', established: false, exclusion: 'NO_EVIDENCE' }] };
    expect(v(exclus)).toMatchObject({ verdict: 'FINDING', anomaly: 'ACQUISITION_CANDIDATE_NOT_PRODUCED', observed: { candidates: exclus.otherCandidates } });
    // Acquisition déjà matérialisée par une autre source (fiche saisie, autre document) : rien à faire.
    expect(v({ ...absent, targetHasAcquisition: true }).verdict).toBe('CONSISTENT');
  });
  it('empreinte stable à entrées égales (anti-boucle du moteur)', () => {
    const d = doc({ acquisitions: [cand({ operation: op({ projection: 'MISSING', events: 0 }) })] });
    expect(v(d).inputHash).toBe(v(structuredClone(d)).inputHash);
  });
});

describe('L111S-U-REGISTRE — déclaration', () => {
  it('en fin de registre (avant le contrôle CIL 111U), ACTIF, couvert par le domaine « operations », interdits explicites', () => {
    // Intégration lot 111 : 111U ajoute COH-CIL-DOCUMENT-PROJECTION APRÈS ce contrôle.
    const ids = COHERENCE_REGISTRY.map((x) => x.id);
    expect(ids.slice(-2)).toEqual(['COH-OPS-ACQUISITION-DOCUMENT', 'COH-CIL-DOCUMENT-PROJECTION']);
    const c = operationsAcquisitionDocumentCheck;
    expect(c).toMatchObject({ status: 'ACTIVE', version: 1, objectType: 'document', criticality: 'HIGH' });
    expect(c.triggers).toEqual(expect.arrayContaining(['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'ASSET_CREATED', 'ASSET_UPDATED', 'BUSINESS_OPERATION_CHANGED']));
    expect(c.forbiddenRepairs.join(' ')).toMatch(/accessoire/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/supprimé par l’utilisateur/);
    expect(COVERAGE_INVENTORY.find((d) => d.domain === 'operations')!.checks).toContain('COH-OPS-ACQUISITION-DOCUMENT');
  });
});
