/**
 * Lot 56A — Documents → Opérations : trois issues explicites décidées par
 * l'IA (ATTACH / ARBITRATE / DISTINCT), validation serveur, réexamen des
 * questions M3 ouvertes, libellé « Oui ». Tests purs (aucune base).
 */
import { describe, expect, it } from 'vitest';
import { m3Resolution, translateOperationMatch, validateResolution, type OperationMatchVerdict } from '../operation-match';
import { T3OperationMatchOutput } from '../t3-contract';
import { applyM3Verdict, type CandidateDecision } from '@/services/business-operations/consolidation/matching';
import { m3Due } from '@/services/business-operations/consolidation/m3';
import { exclusionProposals, exclusionQuestion, matchProposals } from '@/services/to-process/operation-cards';
import { m3ProgressLabel, toM3ProgressView } from '@/services/business-operations/diagnostics/model';

const sortie = (o: Partial<T3OperationMatchOutput>): T3OperationMatchOutput => ({
  task: 'OPERATION_MATCH', decision: 'SAME_OPERATION', matchedCandidateId: 21, confidence: 'probable',
  concordantSignals: ['même prestataire', 'même numéro d’abonné'], contradictions: [], reason: 'échéance suivante', ...o,
} as T3OperationMatchOutput);

const identite = {
  candidateId: 1, candidateKey: 'op1', fileId: 1, established: true, confidence: 'certain', type: 'INTERVENTION', status: 'REALIZED', role: 'INVOICE',
  summary: 'Abonnement', provider: 'P', providerKey: 'p', assetIds: [1], targetAuthority: 'DOCUMENT', equipmentIds: [], refs: [],
  dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null },
  hints: [{ role: 'REALIZED_COST', amountMinor: 3990, currency: 'EUR', amountScope: 'INSTALLMENT', economicDate: null, periodStart: '2026-03-01', periodEnd: '2026-03-31', factRef: 'f1' }],
} as never;
const base = (plausible: number[]): CandidateDecision => ({
  outcome: 'HOLD_UNRESOLVED', operationId: null, matchMethod: null, reason: 'M3_REQUIRED',
  detail: { certain: [], plausible, contradictions: [], excluded: [] },
});
const op = (id: number) => ({ id, typeCode: 'CONTRACT', status: 'IN_PROGRESS', providerKey: 'p', assetIds: [1], refs: [], plannedDate: null, startDate: null, realizedDate: null, endDate: null }) as never;
const ctx = { operations: [op(21), op(22)], assetStatus: new Map<number, string>() };
const appliquer = (o: Partial<T3OperationMatchOutput>, plausible = [21, 22]) => {
  const { verdict } = translateOperationMatch(sortie(o), new Set(plausible));
  return { verdict, d: applyM3Verdict(identite, base(plausible), verdict, ctx) };
};

describe('L56A — issues explicites RATTACHER / ARBITRER / DISTINCT', () => {
  it('L56A-U01 — le contrat accepte `resolution` et reste compatible avec une sortie sans issue (version BO antérieure)', () => {
    expect(T3OperationMatchOutput.safeParse(sortie({ resolution: 'ATTACH' })).success).toBe(true);
    expect(T3OperationMatchOutput.safeParse(sortie({})).success).toBe(true);
    expect(T3OperationMatchOutput.safeParse({ ...sortie({}), resolution: 'MERGE' }).success).toBe(false);
  });

  it('L56A-U02 — ATTACH avec signaux positifs et sans contradiction : rattachement M3, même en confiance « probable »', () => {
    const { verdict, d } = appliquer({ resolution: 'ATTACH', confidence: 'probable' });
    expect(verdict).toMatchObject({ resolution: 'ATTACH', resolutionOrigin: 'MODEL' });
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 21, matchMethod: 'M3', reason: 'MATCH_M3' });
  });

  it('L56A-U03 — « absence de contradiction ≠ preuve » : ATTACH sans signal positif → question (motif tracé)', () => {
    const { verdict, d } = appliquer({ resolution: 'ATTACH', confidence: 'certain', concordantSignals: [] });
    expect(verdict).toMatchObject({ resolution: 'ARBITRATE', downgraded: 'ATTACH_WITHOUT_POSITIVE_SIGNAL' });
    expect(d.outcome).toBe('ARBITRATION_REQUIRED');
    expect(d.arbitration).toEqual({ basis: 'M3', operationIds: [21, 22] });
  });

  it('L56A-U04 — ATTACH incohérent (contradiction déclarée, conflictuel, sans candidat) : jamais un rattachement', () => {
    expect(validateResolution(sortie({ resolution: 'ATTACH', contradictions: ['autre numéro de contrat'] }), 21)).toEqual({ resolution: 'ARBITRATE', downgraded: 'ATTACH_WITH_CONTRADICTIONS' });
    expect(validateResolution(sortie({ resolution: 'ATTACH', confidence: 'conflictual' }), 21)).toEqual({ resolution: 'ARBITRATE', downgraded: 'ATTACH_CONFLICTUAL' });
    expect(validateResolution(sortie({ resolution: 'ATTACH', decision: 'AMBIGUOUS', matchedCandidateId: null }), null)).toEqual({ resolution: 'ARBITRATE', downgraded: 'ATTACH_WITHOUT_CANDIDATE' });
    // Candidat hors du jeu fourni (monde fermé) : AMBIGUOUS, issue ignorée.
    const { verdict, d } = appliquer({ resolution: 'ATTACH', matchedCandidateId: 99 });
    expect(verdict.resolution).toBe('ARBITRATE');
    expect(d.outcome).toBe('ARBITRATION_REQUIRED');
  });

  it('L56A-U05 — DISTINCT exige des éléments qui écartent ; sinon question', () => {
    expect(appliquer({ resolution: 'DISTINCT', decision: 'DISTINCT_OPERATION', matchedCandidateId: null, contradictions: ['autre bien'] }).d)
      .toMatchObject({ outcome: 'CREATE_NEW', reason: 'M3_DISTINCT' });
    const sansPreuve = appliquer({ resolution: 'DISTINCT', decision: 'DISTINCT_OPERATION', matchedCandidateId: null, contradictions: [] });
    expect(sansPreuve.verdict).toMatchObject({ resolution: 'ARBITRATE', downgraded: 'DISTINCT_WITHOUT_EVIDENCE' });
    expect(sansPreuve.d.outcome).toBe('ARBITRATION_REQUIRED');
  });

  it('L56A-U06 — ARBITRATE : question posée, le candidat le plus probable en premier', () => {
    const { d } = appliquer({ resolution: 'ARBITRATE', matchedCandidateId: 22 });
    expect(d).toMatchObject({ outcome: 'ARBITRATION_REQUIRED', reason: 'M3_AMBIGUOUS', arbitration: { basis: 'M3', operationIds: [22, 21] } });
  });

  it('L56A-U07 — sortie sans issue (prompt antérieur) et verdicts enregistrés avant le lot : règle historique inchangée', () => {
    expect(appliquer({ confidence: 'certain' }).d.outcome).toBe('MATCH_AND_ENRICH');
    expect(appliquer({ confidence: 'probable' }).d.outcome).toBe('ARBITRATION_REQUIRED');
    const ancien = { decision: 'SAME_OPERATION', matchedOperationId: 21, confidence: 'probable', concordantSignals: [], contradictions: [], reason: 'x' } as OperationMatchVerdict;
    expect(m3Resolution(ancien)).toBe('ARBITRATE');
    expect(m3Resolution({ ...ancien, confidence: 'certain' })).toBe('ATTACH');
    expect(m3Resolution({ ...ancien, decision: 'DISTINCT_OPERATION', matchedOperationId: null, confidence: 'certain' })).toBe('DISTINCT');
  });

  it('L56A-U08 — ATTACH vers un candidat qui n’est plus plausible : jamais de rattachement', () => {
    const { verdict } = translateOperationMatch(sortie({ resolution: 'ATTACH' }), new Set([21, 22]));
    expect(applyM3Verdict(identite, base([22]), verdict, ctx).outcome).toBe('ARBITRATION_REQUIRED');
  });
});

describe('L56A — réexamen des questions M3 ouvertes', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  const detail = (promptVersion: string, fp = 'fp1') => ({ m3Fingerprint: fp, m3: { status: 'DONE', fingerprint: 'fp1', promptVersion, at: now.toISOString() } });
  it('L56A-U09 — question ouverte évaluée par une autre version du prompt : due une fois ; même version : non due (idempotence)', () => {
    expect(m3Due(detail('v1'), now, 'v2', true)).toBe(true);
    expect(m3Due(detail('v2'), now, 'v2', true)).toBe(false);
    expect(m3Due(detail('v1'), now, null, true)).toBe(false);
    // Contexte changé : due (avec ou sans question).
    expect(m3Due(detail('v2', 'fp2'), now, 'v2', true)).toBe(true);
    // Attente M3 sans question : la version du prompt seule ne rappelle pas le modèle (règle antérieure).
    expect(m3Due(detail('v1'), now, 'v2', false)).toBe(false);
  });
});

describe('L56A — libellés neutres des cartes OPERATION-*', () => {
  it('L56A-U10 — « Oui » (et non « Oui, la même ») pour un contrat comme pour une intervention ; desktop et mobile lisent les mêmes propositions', () => {
    for (const type of ['CONTRACT', 'INTERVENTION', 'CLAIM', 'DISPOSAL', null]) {
      const p = matchProposals(type, 'M3', [{ id: 12, label: 'Facture du 05/02/2026' }]);
      expect(p[0]).toMatchObject({ value: 'SAME:12', label: 'Oui' });
      expect(p.map((x) => x.label).join(' ')).not.toMatch(/la même|le même/);
    }
    expect(matchProposals('CONTRACT', 'M3', [{ id: 12, label: 'A' }])[1].label).toBe('Non, c’est un autre contrat');
  });

  it('L56A-U11 — carte « bien retiré du sinistre » : aucune formulation accordée au genre du nom du bien', () => {
    expect(exclusionProposals('Villa')[1].label).toBe('Non, pas de nouveau rattachement au sinistre');
    expect(exclusionQuestion('Villa', 'Dégât des eaux')).not.toMatch(/que vous avez retiré/);
  });
});

describe('L56A — décisions IA explicables au BO', () => {
  it('L56A-U12 — BO › Opérations : l’issue décidée par l’IA, son déclassement serveur et sa raison sont lisibles', () => {
    const v = toM3ProgressView({ status: 'DONE', at: '2026-10-15T10:00:00Z', verdict: { decision: 'SAME_OPERATION', confidence: 'certain', resolution: 'ARBITRATE', downgraded: 'ATTACH_WITHOUT_POSITIVE_SIGNAL', reason: 'rien ne s’oppose' } }, [21], null, [21]);
    expect(m3ProgressLabel(v)).toContain('IA : question à l’utilisateur (déclassée par le serveur : ATTACH_WITHOUT_POSITIVE_SIGNAL) — rien ne s’oppose');
    // Verdict antérieur au lot (sans issue) : règle historique.
    expect(toM3ProgressView({ status: 'DONE', verdict: { decision: 'SAME_OPERATION', confidence: 'probable', reason: 'x' } }, [21], null, [21])?.resolution).toBe('ARBITRATE');
  });
});
