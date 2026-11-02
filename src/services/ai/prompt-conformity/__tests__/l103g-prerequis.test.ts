/**
 * Lot 103G — mise en conformité des prompts : blocage de PRÉREQUIS (compte
 * technique) distinct d'un refus de non-régression, reprise automatique
 * bornée sans boucle (R4, R6, R7), synthèse et santé fonctionnelle d'un
 * passage (R8 : « 12 incompatibilités / 0 tentative » ≠ sain ; occurrences de
 * détection ≠ essais ; AI_PROMPT_CONFORMITY_MAX_PER_PASS=0 signalé).
 */
import { describe, expect, it } from 'vitest';
import {
  currentPrerequisite, EMPTY_PASS_SUMMARY, isTechnicalAccountReason, legacyPrerequisiteBlock, passHealth, passNote, resumeDecision,
} from '../prerequisite';

/** Cas réel de préproduction du 31/10/2026 (T2, contrat t2-property-continuity-v1). */
const T2_REEL = {
  status: 'BLOCKED',
  prerequisite: {},
  qualification: {
    decision: 'INCONCLUSIVE',
    operations: [
      { operationCode: 't2_understand', regressions: [], defects: [], inconclusive: ['corpus:P-T2-06 : cause non établie (ACCOUNT_INELIGIBLE : Appel IA refusé : compte 8 non éligible aux traitements (compte introuvable) — décision PO C-Q10.)'] },
      { operationCode: 't2_answer', regressions: [], defects: [], inconclusive: [
        'corpus:P-T2-03 : cause non établie (ACCOUNT_INELIGIBLE : Appel IA refusé : compte 8 non éligible aux traitements (compte introuvable) — décision PO C-Q10.)',
        'corpus:P-T2-08 : cause non établie (ACCOUNT_INELIGIBLE : …)', 'corpus:P-T2-09 : cause non établie (ACCOUNT_INELIGIBLE : …)',
      ] },
    ],
  },
};
const OK = { ok: true, code: 'CORPUS_ACCOUNT_OK', stateFingerprint: 'f1' };
const KO = { ok: false, code: 'CORPUS_ACCOUNT_MISSING', stateFingerprint: 'f0' };

describe('L103G-U10 — blocage de prérequis ≠ refus de non-régression', () => {
  it('historique T2 réel (ACCOUNT_INELIGIBLE sur les cas du corpus) reconnu comme blocage de prérequis', () => {
    expect(legacyPrerequisiteBlock(T2_REEL)).toBe(true);
    expect(currentPrerequisite(T2_REEL)).toMatchObject({ code: 'CORPUS_ACCOUNT_LEGACY', stage: 'LEGACY' });
  });

  it('R6 : vraie régression, défaut, décision REFUSED, cas non concluant pour une autre raison ou verrou A1 → JAMAIS requalifié', () => {
    const avec = (o: Record<string, unknown>) => ({ ...T2_REEL, qualification: { ...T2_REEL.qualification, ...o } });
    expect(legacyPrerequisiteBlock(avec({ decision: 'REFUSED' }))).toBe(false);
    expect(legacyPrerequisiteBlock(avec({ operations: [{ regressions: ['corpus:P-T2-03'], defects: [], inconclusive: T2_REEL.qualification.operations[0].inconclusive }] }))).toBe(false);
    expect(legacyPrerequisiteBlock(avec({ operations: [{ regressions: [], defects: ['corpus:x : faux'], inconclusive: T2_REEL.qualification.operations[0].inconclusive }] }))).toBe(false);
    expect(legacyPrerequisiteBlock(avec({ operations: [{ regressions: [], defects: [], inconclusive: ['corpus:P-T2-06 : résultat non vérifiable : aucun attendu'] }] }))).toBe(false);
    expect(legacyPrerequisiteBlock(avec({ operations: [{ regressions: [], defects: [], inconclusive: [] }], a1: { allowed: false } }))).toBe(false);
    // Un rejeu (compte client) non éligible n'est pas le compte technique.
    expect(legacyPrerequisiteBlock(avec({ operations: [{ regressions: [], defects: [], inconclusive: ['replay:4 : cause non établie (ACCOUNT_INELIGIBLE : …)'] }] }))).toBe(false);
    expect(legacyPrerequisiteBlock({ ...T2_REEL, status: 'FAILED' })).toBe(false);
    expect(isTechnicalAccountReason('erreur fournisseur transitoire, nouvel essai épuisé')).toBe(false);
  });

  it('R4 / R7 : reprise une fois par état réparé, bornée ; attente tant que le compte est inutilisable ; aucune boucle', () => {
    expect(resumeDecision(T2_REEL, KO, 3)).toMatchObject({ kind: 'WAIT' });
    expect(resumeDecision(T2_REEL, null, 3)).toMatchObject({ kind: 'WAIT' });
    expect(resumeDecision(T2_REEL, OK, 3)).toMatchObject({ kind: 'RESUME' });
    // Reprise déjà faite sur CE même état du compte (ex. passerelle refusant encore) : pas de nouvel essai.
    const repris = { ...T2_REEL, prerequisite: { code: 'CORPUS_ACCOUNT_INVALID', resumes: 1, lastResumeStateFingerprint: 'f1' } };
    expect(resumeDecision(repris, OK, 3)).toEqual({ kind: 'NONE' });
    // Nouvel état réparé : nouvelle reprise, jusqu'à la borne.
    expect(resumeDecision(repris, { ...OK, stateFingerprint: 'f2' }, 3)).toMatchObject({ kind: 'RESUME' });
    expect(resumeDecision({ ...repris, prerequisite: { ...repris.prerequisite, resumes: 3 } }, { ...OK, stateFingerprint: 'f9' }, 3)).toMatchObject({ kind: 'EXHAUSTED' });
    // Incompatibilité sans blocage de prérequis (vrai refus) : jamais reprise par ce mécanisme.
    expect(resumeDecision({ status: 'FAILED', prerequisite: {}, qualification: { decision: 'REFUSED' } }, OK, 3)).toEqual({ kind: 'NONE' });
  });
});

describe('L103G-U11 — synthèse et santé fonctionnelle (R8)', () => {
  const corpusKo = { ok: false, code: 'CORPUS_ACCOUNT_MISSING', label: 'compte technique de qualification absent', nextAction: 'BO › Configuration IA › Compte technique de qualification › « Provisionner / réparer ».' };

  it('12 incompatibilités, 0 tentative : jamais « sain » ; prérequis absent → BLOQUÉE (PRÉREQUIS) avec le geste', () => {
    const s = { ...EMPTY_PASS_SUMMARY, detected: 12, eligible: 3, alreadyBlocked: 9, waitingPrerequisite: 3 };
    const h = passHealth({ summary: s, mode: 'auto', maxPerPass: 1, corpus: corpusKo });
    expect(h).toMatchObject({ code: 'BLOCKED_PREREQUISITE', healthy: false });
    const note = passNote(h, s);
    expect(note).toMatch(/^Santé : BLOQUÉE \(PRÉREQUIS\)/);
    expect(note).toMatch(/12 détectée\(s\) · 3 éligible\(s\) · 9 déjà bloquée\(s\) · 3 en attente de prérequis · 0 essayée\(s\) · 0 qualifiée\(s\) · 0 refusée\(s\) · 0 activée\(s\)/);
    expect(note).toMatch(/Provisionner \/ réparer/);
    expect(note).not.toMatch(/occurrence/);
    expect(note.length).toBeLessThanOrEqual(500);
    const sansPrerequis = passHealth({ summary: { ...s, waitingPrerequisite: 0 }, mode: 'auto', maxPerPass: 1, corpus: null });
    expect(sansPrerequis).toMatchObject({ code: 'NO_PROGRESS', healthy: false });
  });

  it('AI_PROMPT_CONFORMITY_MAX_PER_PASS=0 signalé explicitement, jamais « automatique et sain »', () => {
    const h = passHealth({ summary: { ...EMPTY_PASS_SUMMARY, detected: 2, eligible: 2, deferredByBudget: 2 }, mode: 'auto', maxPerPass: 0, corpus: { ...corpusKo, ok: true, code: 'CORPUS_ACCOUNT_OK' } });
    expect(h).toMatchObject({ code: 'NO_CAPACITY', healthy: false });
    expect(h.label).toMatch(/AI_PROMPT_CONFORMITY_MAX_PER_PASS=0/);
  });

  it('progrès réel, aucun travail, coupure, diagnostic seul', () => {
    expect(passHealth({ summary: { ...EMPTY_PASS_SUMMARY, detected: 4, attempted: 1 }, mode: 'auto', maxPerPass: 1 })).toMatchObject({ code: 'PROGRESS', healthy: true });
    expect(passHealth({ summary: EMPTY_PASS_SUMMARY, mode: 'auto', maxPerPass: 1 })).toMatchObject({ code: 'HEALTHY', healthy: true });
    expect(passHealth({ summary: EMPTY_PASS_SUMMARY, mode: 'off', maxPerPass: 1 })).toMatchObject({ code: 'DISABLED', healthy: false });
    expect(passHealth({ summary: { ...EMPTY_PASS_SUMMARY, detected: 1 }, mode: 'detect', maxPerPass: 1 })).toMatchObject({ code: 'DETECTION_ONLY', healthy: false });
  });
});
