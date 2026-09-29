/**
 * CDC 15 §25, §22.2 — contrat T3 : union discriminée, règles
 * choose/abstain, plage de score, monde fermé (U1) contrôlé par le serveur.
 */
import { describe, it, expect } from 'vitest';
import {
  T3MasterOutput, T3ValueConflictOutput, T3LinkAmbiguityOutput,
  closedWorldValueConflict, closedWorldLinkAmbiguity,
} from '../t3-contract';

describe('VALUE_CONFLICT', () => {
  const ok = (v: Record<string, unknown>) => T3ValueConflictOutput.safeParse({ task: 'VALUE_CONFLICT', confidence: 'probable', reason: 'r', ...v }).success;

  it('chosenEvidenceId obligatoire si choose, interdit si abstain', () => {
    expect(ok({ decision: 'choose', chosenEvidenceId: 4213 })).toBe(true);
    expect(ok({ decision: 'choose' })).toBe(false);
    expect(ok({ decision: 'choose', chosenEvidenceId: null })).toBe(false);
    expect(ok({ decision: 'abstain' })).toBe(true);
    expect(ok({ decision: 'abstain', chosenEvidenceId: null })).toBe(true);
    expect(ok({ decision: 'abstain', chosenEvidenceId: 4213 })).toBe(false);
  });

  it('confidence et reason requis ; décision fermée', () => {
    expect(T3ValueConflictOutput.safeParse({ task: 'VALUE_CONFLICT', decision: 'choose', chosenEvidenceId: 1, confidence: 'sûr', reason: 'r' }).success).toBe(false);
    expect(ok({ decision: 'maybe' })).toBe(false);
    expect(T3ValueConflictOutput.safeParse({ task: 'VALUE_CONFLICT', decision: 'abstain', confidence: 'conflictual' }).success).toBe(false);
  });
});

describe('LINK_AMBIGUITY', () => {
  const m = (score: number) => ({ candidateId: 7, score, confidence: 'probable', reason: 'numéro de série identique' });

  it('score dans [0, 1], liste vide admise (L3)', () => {
    expect(T3LinkAmbiguityOutput.safeParse({ task: 'LINK_AMBIGUITY', matches: [] }).success).toBe(true);
    expect(T3LinkAmbiguityOutput.safeParse({ task: 'LINK_AMBIGUITY', matches: [m(0.82)] }).success).toBe(true);
    expect(T3LinkAmbiguityOutput.safeParse({ task: 'LINK_AMBIGUITY', matches: [m(1.2)] }).success).toBe(false);
    expect(T3LinkAmbiguityOutput.safeParse({ task: 'LINK_AMBIGUITY', matches: [m(-0.1)] }).success).toBe(false);
  });
});

describe('union discriminée', () => {
  it('dispatch par task', () => {
    expect(T3MasterOutput.parse({ task: 'LINK_AMBIGUITY', matches: [] }).task).toBe('LINK_AMBIGUITY');
    expect(T3MasterOutput.safeParse({ task: 'OTHER' }).success).toBe(false);
    // La règle choose/abstain s'applique aussi à travers l'union.
    expect(T3MasterOutput.safeParse({ task: 'VALUE_CONFLICT', decision: 'choose', confidence: 'certain', reason: 'r' }).success).toBe(false);
  });
});

describe('monde fermé U1', () => {
  it('preuve hors liste → abstention avec avertissement ; preuve fournie conservée', () => {
    const choose = { task: 'VALUE_CONFLICT' as const, decision: 'choose' as const, chosenEvidenceId: 99, confidence: 'certain' as const, reason: 'r' };
    const r = closedWorldValueConflict(choose, new Set([1, 2]));
    expect(r.output).toMatchObject({ decision: 'abstain', chosenEvidenceId: null, confidence: 'conflictual' });
    expect(r.warnings).toEqual([{ code: 'UNKNOWN_EVIDENCE_ID', id: 99 }]);
    expect(closedWorldValueConflict({ ...choose, chosenEvidenceId: 2 }, new Set([1, 2])).warnings).toEqual([]);
  });

  it('candidat hors liste ou doublon → liste vide avec avertissement', () => {
    const out = (ids: number[]) => ({
      task: 'LINK_AMBIGUITY' as const,
      matches: ids.map((candidateId) => ({ candidateId, score: 0.9, confidence: 'probable' as const, reason: 'r' })),
    });
    expect(closedWorldLinkAmbiguity(out([7, 42]), new Set([7, 8]))).toEqual({
      output: { task: 'LINK_AMBIGUITY', matches: [] }, warnings: [{ code: 'UNKNOWN_CANDIDATE_ID', id: 42 }],
    });
    expect(closedWorldLinkAmbiguity(out([7, 7]), new Set([7])).warnings).toEqual([{ code: 'DUPLICATE_CANDIDATE_ID', id: 7 }]);
    expect(closedWorldLinkAmbiguity(out([7, 8]), new Set([7, 8])).output.matches).toHaveLength(2);
  });
});
