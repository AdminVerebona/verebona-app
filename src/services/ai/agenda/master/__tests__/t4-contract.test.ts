/**
 * CDC 15 §26 — contrat T4 : trois branches discriminées, `unknown` ⇔
 * `ambiguous` (C5), quatre états de preuve (`insufficient` distinct),
 * choose/abstain, monde fermé (U1, U6).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  T4MasterOutput, T4ClassifyEventOutput, T4VerifyCompletionOutput, T4TemporalAmbiguityOutput,
  closedWorldBusinessType, closedWorldTemporal,
} from '../t4-contract';
import { translateTemporalAmbiguity, temporalAmbiguityVariables } from '../temporal-ambiguity';

describe('CLASSIFY_EVENT', () => {
  const c = (o: Record<string, unknown>) => T4ClassifyEventOutput.safeParse({ task: 'CLASSIFY_EVENT', reason: 'r', ...o }).success;
  it('trois catégories ; unknown exige ambiguous', () => {
    expect(c({ homeCategory: 'action', confidence: 'certain', businessType: 'inspection' })).toBe(true);
    expect(c({ homeCategory: 'unknown', confidence: 'ambiguous' })).toBe(true);
    expect(c({ homeCategory: 'unknown', confidence: 'probable' })).toBe(false);
    expect(c({ homeCategory: 'peut-être', confidence: 'certain' })).toBe(false);
  });
  it('U6 : type métier hors catalogue ignoré', () => {
    const out = { task: 'CLASSIFY_EVENT' as const, businessType: 'vidange', homeCategory: 'action' as const, confidence: 'certain' as const, reason: 'r' };
    expect(closedWorldBusinessType(out, new Set(['maintenance']))).toEqual({ output: { ...out, businessType: null }, warning: 'UNKNOWN_BUSINESS_TYPE:vidange' });
  });
});

describe('VERIFY_COMPLETION', () => {
  it('quatre états, plus de booléen completed', () => {
    for (const evidenceStatus of ['proves_completed', 'proves_not_completed', 'insufficient', 'conflictual']) {
      expect(T4VerifyCompletionOutput.safeParse({ task: 'VERIFY_COMPLETION', evidenceStatus, occurrenceMatch: 'none', confidence: 'probable', reason: 'r' }).success).toBe(true);
    }
    expect(T4VerifyCompletionOutput.safeParse({ task: 'VERIFY_COMPLETION', completed: false, confidence: 'probable', reason: 'r' }).success).toBe(false);
  });
});

describe('TEMPORAL_AMBIGUITY', () => {
  const t = (o: Record<string, unknown>) => T4TemporalAmbiguityOutput.safeParse({ task: 'TEMPORAL_AMBIGUITY', confidence: 'probable', reason: 'r', ...o }).success;
  it('choose exige un candidat, abstain l’interdit', () => {
    expect(t({ decision: 'choose', candidateId: 2 })).toBe(true);
    expect(t({ decision: 'choose' })).toBe(false);
    expect(t({ decision: 'abstain', candidateId: null })).toBe(true);
    expect(t({ decision: 'abstain', candidateId: 2 })).toBe(false);
  });
  it('U1 : candidat hors liste → abstention ; confiance ambiguë → aucun choix', () => {
    const cands = [{ candidateId: 2, date: '2026-03-01', interpretation: 'réalisation' }];
    expect(closedWorldTemporal({ task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 9, confidence: 'probable', reason: 'r' }, new Set([2])).warning)
      .toBe('UNKNOWN_CANDIDATE_ID:9');
    expect(translateTemporalAmbiguity({ task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 2, confidence: 'probable', reason: 'r' }, cands).chosen?.candidateId).toBe(2);
    expect(translateTemporalAmbiguity({ task: 'TEMPORAL_AMBIGUITY', decision: 'choose', candidateId: 2, confidence: 'ambiguous', reason: 'r' }, cands).chosen).toBeNull();
    expect((temporalAmbiguityVariables({}, [{ candidateId: 5, date: 'x', interpretation: 'a' }, ...cands]).TEMPORAL_CANDIDATES as Array<{ candidateId: number }>).map((c) => c.candidateId)).toEqual([2, 5]);
  });
});

describe('union et texte du master', () => {
  it('dispatch par task', () => {
    expect(T4MasterOutput.safeParse({ task: 'CLASSIFY_EVENT', homeCategory: 'unknown', confidence: 'probable', reason: 'r' }).success).toBe(false);
    expect(T4MasterOutput.parse({ task: 'TEMPORAL_AMBIGUITY', decision: 'abstain', confidence: 'ambiguous', reason: 'r' }).task).toBe('TEMPORAL_AMBIGUITY');
  });
  it('T4-11 / C4 : aucune règle par type de contrat dans le master', () => {
    const texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/agenda/t4_master_v1.txt'), 'utf8');
    expect(texte).not.toMatch(/reconduction tacite|gardiennage/i);
    expect(texte).toMatch(/C4 — N’applique pas de règle générale par type de contrat/);
    for (const b of ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY']) expect(texte).toContain(`BRANCHE TASK = ${b}`);
  });
});
