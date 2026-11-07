/**
 * Lot 113S (Trello #716, post-MEP) — « À traiter » : arbitrages métier
 * formulés par T3 / T4 dans leur sortie structurée, contrôlés par le code.
 * Tests PURS (aucune base) : contrôle de la question, choix et provenance,
 * contrats T3 / T4 (sections facultatives, rétrocompatibles), décisions de
 * revue et de rapprochement, affichage sans réécriture, catalogue des règles.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_QUESTION_MAX_LENGTH, chooseCardQuestion, isAiQuestion, promptCarriesQuestionContract, readQuestionSource,
  T3_USER_QUESTION_CONTRACT, T4_USER_QUESTION_CONTRACT, validateAiUserQuestion, type AiQuestionInput,
} from '../ai-user-question';
import { presentCardLabels } from '../card-labels';
import { checkRulesCatalog, PROCESSING_RULES } from '../rules-catalog';
import { T3LinkAmbiguityOutput, T3OperationMatchOutput } from '@/services/ai/reconciliation/master/t3-contract';
import { T4AgendaRepresentationOutput } from '@/services/business-operations/semantic/contract';
import { translateOperationMatch } from '@/services/ai/reconciliation/master/operation-match';
import { decideAttachmentReview } from '@/services/ai/reconciliation/document-asset/attachment-review/model';
import { decideFromAiOutput } from '@/services/ai/reconciliation/document-asset/decision';

const ctx = { allowedLabels: ['Vélo cargo', 'Maison', 'Attestation d’assurance'], foreignLabels: ['Studio Lyon 6', 'Clio 4'] };
const Q = 'Cette attestation assure-t-elle « Vélo cargo » ou concerne-t-elle « Maison », dont l’adresse figure comme destinataire ?';

describe('L113S — contrôle d’une question proposée par l’IA (pure)', () => {
  it('Q-01 — question valide : rendue telle quelle (espaces normalisés seulement)', () => {
    expect(validateAiUserQuestion(Q, ctx)).toEqual({ ok: true, question: Q });
    expect(validateAiUserQuestion(`  ${Q.replace(' ou ', '   ou\n')}  `, ctx)).toEqual({ ok: true, question: Q });
  });

  it('Q-02 — absente, vide, pas un texte : refusée (ABSENT / NOT_TEXT)', () => {
    expect(validateAiUserQuestion(undefined, ctx)).toEqual({ ok: false, code: 'ABSENT' });
    expect(validateAiUserQuestion(null, ctx)).toEqual({ ok: false, code: 'ABSENT' });
    expect(validateAiUserQuestion('   ', ctx)).toEqual({ ok: false, code: 'ABSENT' });
    expect(validateAiUserQuestion(42, ctx)).toEqual({ ok: false, code: 'NOT_TEXT' });
    expect(validateAiUserQuestion('Quel bien\u0007 garder ?', ctx)).toEqual({ ok: false, code: 'NOT_TEXT' });
  });

  it('Q-03 — longueur, forme interrogative', () => {
    expect(validateAiUserQuestion('Lequel ?', ctx)).toEqual({ ok: false, code: 'TOO_SHORT' });
    const long = `Ce document concerne-t-il ${'vraiment '.repeat(40)}le bien « Maison » ?`;
    expect(long.length).toBeGreaterThan(AI_QUESTION_MAX_LENGTH);
    expect(validateAiUserQuestion(long, ctx)).toEqual({ ok: false, code: 'TOO_LONG' });
    expect(validateAiUserQuestion('Ce document concerne le bien « Maison ».', ctx)).toEqual({ ok: false, code: 'NOT_A_QUESTION' });
  });

  it('Q-04 — langue : une question anglaise est refusée', () => {
    expect(validateAiUserQuestion('Does this document belong to the same asset as « Maison » ?', ctx)).toEqual({ ok: false, code: 'NOT_FRENCH' });
  });

  it('Q-05 — vocabulaire : « Opération », nom de traitement, code, date ISO, jargon refusés', () => {
    expect(validateAiUserQuestion('Ce document concerne-t-il la même opération que « Maison » ?', ctx).ok).toBe(false);
    expect(validateAiUserQuestion('Ce document concerne-t-il la même opération que « Maison » ?', ctx)).toEqual({ ok: false, code: 'FORBIDDEN_TERM' });
    expect(validateAiUserQuestion('Selon T3, ce document concerne-t-il le bien « Maison » ?', ctx)).toEqual({ ok: false, code: 'TECHNICAL_WORDING' });
    expect(validateAiUserQuestion('Ce document (LINK-ASSET) concerne-t-il « Maison » ?', ctx)).toEqual({ ok: false, code: 'TECHNICAL_WORDING' });
    expect(validateAiUserQuestion('Ce document du 2026-03-12 concerne-t-il « Maison » ?', ctx)).toEqual({ ok: false, code: 'TECHNICAL_WORDING' });
    expect(validateAiUserQuestion('Le score du candidat « Maison » est-il suffisant pour ce document ?', ctx)).toEqual({ ok: false, code: 'TECHNICAL_WORDING' });
    expect(validateAiUserQuestion('L’IA hésite : ce document concerne-t-il « Maison » ?', ctx)).toEqual({ ok: false, code: 'FORBIDDEN_TERM' });
    // Un libellé CITÉ peut contenir ce qu'un texte système ne contient pas (« Appartement T3 »).
    expect(validateAiUserQuestion('Ce bail concerne-t-il « Appartement T3 » ou « Maison » ?', { allowedLabels: ['Appartement T3', 'Maison'] }).ok).toBe(true);
  });

  it('Q-06 — données sensibles : e-mail, téléphone, IBAN, lien, longue suite de chiffres, valeur masquée', () => {
    for (const s of [
      'Le courrier envoyé à jean.fourche@example.com concerne-t-il « Maison » ?',
      'Le titulaire joignable au 06 12 34 56 78 est-il celui de « Maison » ?',
      'Le prélèvement sur FR76 3000 6000 0112 3456 7890 189 concerne-t-il « Maison » ?',
      'Le document de https://exemple.fr concerne-t-il « Maison » ?',
      'Le contrat 123456789012 concerne-t-il le bien « Maison » ?',
      'Le document cite [adresse identique à celle du bien candidat 14] : concerne-t-il « Maison » ?',
    ]) expect(validateAiUserQuestion(s, ctx), s).toEqual({ ok: false, code: 'SENSITIVE_DATA' });
    // Dates et montants usuels restent permis.
    expect(validateAiUserQuestion('La facture du 12/03/2026 de 1 250,00 € concerne-t-elle « Maison » ?', ctx).ok).toBe(true);
  });

  it('Q-07 — monde fermé : un libellé cité hors du contexte (hors options) est refusé', () => {
    expect(validateAiUserQuestion('Ce document concerne-t-il plutôt « Garage Dupont » que « Maison » ?', ctx)).toEqual({ ok: false, code: 'UNKNOWN_REFERENCE' });
    // Casse, accents, apostrophes, troncature « … » tolérés.
    expect(validateAiUserQuestion('Ce document concerne-t-il « velo CARGO » ?', ctx).ok).toBe(true);
    expect(validateAiUserQuestion('Cette « Attestation d’ass… » concerne-t-elle « Maison » ?', ctx).ok).toBe(true);
  });

  it('Q-08 — donnée d’un autre objet du compte (hors contexte de la carte) : refusée, même sans guillemets', () => {
    expect(validateAiUserQuestion('Ce document concerne-t-il le bien Studio Lyon 6 plutôt que « Maison » ?', ctx)).toEqual({ ok: false, code: 'FOREIGN_LABEL' });
    // Nom commun d'un seul mot : jamais recherché hors citation (« cette maison »).
    expect(validateAiUserQuestion('Cette attestation concerne-t-elle bien cette maison ?', { allowedLabels: [], foreignLabels: ['Maison'] }).ok).toBe(true);
  });
});

const entree = (o: Partial<AiQuestionInput> = {}): AiQuestionInput => ({
  rule: 'LINK-ASSET-CONFLICT', treatment: 'T3', operation: 't3_link_ambiguity', contract: T3_USER_QUESTION_CONTRACT,
  raw: Q, aiCalled: true, contractActive: true, promptVersion: 'v42', traceId: 'tr-1', check: ctx, fallbackQuestion: 'Repli honnête ?',
  now: new Date('2026-11-06T10:00:00Z'), ...o,
});

describe('L113S — choix de la question et provenance (pure)', () => {
  it('C-01 — question valide : origine AI, version de prompt et trace conservées, aucune anomalie', () => {
    const c = chooseCardQuestion(entree());
    expect(c).toEqual({
      question: Q, anomaly: null,
      source: {
        origin: 'AI', rule: 'LINK-ASSET-CONFLICT', treatment: 'T3', operation: 't3_link_ambiguity', contract: T3_USER_QUESTION_CONTRACT,
        contractActive: true, promptVersion: 'v42', traceId: 'tr-1', fallback: null, rejection: null, at: '2026-11-06T10:00:00.000Z',
      },
    });
  });

  it('C-02 — question absente, contrat inactif (avant le collage du bloc) : repli tracé, aucune anomalie', () => {
    const c = chooseCardQuestion(entree({ raw: undefined, contractActive: false }));
    expect(c.question).toBe('Repli honnête ?');
    expect(c.source).toMatchObject({ origin: 'CODE', fallback: 'AI_QUESTION_ABSENT', rejection: null, contractActive: false });
    expect(c.anomaly).toBeNull();
  });

  it('C-03 — question absente ou refusée, contrat ACTIF : repli tracé ET anomalie Supervision', () => {
    expect(chooseCardQuestion(entree({ raw: null })).anomaly).toBe('ABSENT');
    const c = chooseCardQuestion(entree({ raw: 'Does this belong to the same asset ?' }));
    expect(c).toMatchObject({ question: 'Repli honnête ?', anomaly: 'NOT_FRENCH', source: { origin: 'CODE', fallback: 'AI_QUESTION_REJECTED', rejection: 'NOT_FRENCH' } });
  });

  it('C-04 — IA non appelée (décision sans modèle) : repli AI_NOT_CALLED, jamais une anomalie ; sans repli fourni : question du catalogue', () => {
    const c = chooseCardQuestion(entree({ raw: undefined, aiCalled: false, fallbackQuestion: undefined }));
    expect(c).toMatchObject({ question: undefined, anomaly: null, source: { origin: 'CODE', fallback: 'AI_NOT_CALLED' } });
  });

  it('C-05 — lecture de la provenance tolérante (ligne antérieure au lot 113S)', () => {
    expect(readQuestionSource(null)).toBeNull();
    expect(readQuestionSource({ foo: 1 })).toBeNull();
    expect(isAiQuestion(chooseCardQuestion(entree()).source)).toBe(true);
    expect(isAiQuestion(JSON.stringify(chooseCardQuestion(entree()).source))).toBe(true);
    expect(isAiQuestion(chooseCardQuestion(entree({ raw: null })).source)).toBe(false);
  });

  it('C-06 — marqueurs des contrats (lus dans le prompt, jamais écrits par le code)', () => {
    expect(promptCarriesQuestionContract(`… ${T3_USER_QUESTION_CONTRACT} …`, T3_USER_QUESTION_CONTRACT)).toBe(true);
    expect(promptCarriesQuestionContract('texte livré', T3_USER_QUESTION_CONTRACT)).toBe(false);
    expect(T4_USER_QUESTION_CONTRACT).toBe('t4-user-question-v1');
  });
});

describe('L113S — affichage : la question validée est celle affichée', () => {
  const vue = (question: string) => ({
    targetType: 'DOCUMENT', fieldKey: null, relationKey: 'assetConflict', ruleCode: 'LINK-ASSET-CONFLICT', question, proposals: [],
    target: { label: 'Attestation' },
  });
  it('A-01 — question IA : jamais remplacée par la phrase du catalogue', () => {
    expect(presentCardLabels(vue(Q), 'Question du catalogue ?', { aiQuestion: true }).question).toBe(Q);
  });
  it('A-02 — question historique technique : la politique 77B reste appliquée', () => {
    expect(presentCardLabels(vue('Carte #12 pour LINK-ASSET ?'), 'Question du catalogue ?').question).toBe('Question du catalogue ?');
    expect(presentCardLabels(vue('Le 2026-05-12, quel bien ?'), 'Question du catalogue ?').question).toBe('Le 12/05/2026, quel bien ?');
  });
});

describe('L113S — contrats T3 / T4 : sections facultatives, rétrocompatibles', () => {
  it('K-01 — T3 LINK_AMBIGUITY : ancien format accepté ; userQuestion lue à la racine et dans attachmentReview', () => {
    expect(T3LinkAmbiguityOutput.safeParse({ task: 'LINK_AMBIGUITY', matches: [] }).success).toBe(true);
    const out = T3LinkAmbiguityOutput.parse({
      task: 'LINK_AMBIGUITY', matches: [], userQuestion: 'Q ?',
      attachmentReview: { decision: 'ARBITRATE', reason: 'r', userQuestion: 'x'.repeat(2000) },
    });
    expect(out.userQuestion).toBe('Q ?');
    // Une question trop longue n'invalide jamais la décision : contrôlée ensuite par le serveur.
    expect(out.attachmentReview?.userQuestion).toHaveLength(2000);
  });

  it('K-02 — T3 OPERATION_MATCH : userQuestion et questionCandidateId facultatifs ; monde fermé du sujet', () => {
    const base = { task: 'OPERATION_MATCH', decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', concordantSignals: [], contradictions: [], reason: 'r', resolution: 'ARBITRATE' } as const;
    expect(T3OperationMatchOutput.safeParse(base).success).toBe(true);
    const ok = translateOperationMatch(T3OperationMatchOutput.parse({ ...base, userQuestion: 'Q ?', questionCandidateId: 12 }), new Set([12, 13]));
    expect(ok.verdict).toMatchObject({ resolution: 'ARBITRATE', userQuestion: 'Q ?', questionCandidateId: 12 });
    const hors = translateOperationMatch(T3OperationMatchOutput.parse({ ...base, userQuestion: 'Q ?', questionCandidateId: 99 }), new Set([12, 13]));
    expect(hors.verdict.questionCandidateId).toBeNull();
    const sans = translateOperationMatch(T3OperationMatchOutput.parse(base), new Set([12]));
    expect(sans.verdict.userQuestion).toBeUndefined();
    // Sortie hors monde fermé : aucune question reprise.
    const viol = translateOperationMatch(T3OperationMatchOutput.parse({ ...base, decision: 'SAME_OPERATION', matchedCandidateId: 77, userQuestion: 'Q ?' }), new Set([12]));
    expect(viol.verdict.userQuestion).toBeUndefined();
  });

  it('K-03 — T4 AGENDA_REPRESENTATION : userQuestion facultative, ancien format accepté', () => {
    const abst = { task: 'AGENDA_REPRESENTATION', outcome: 'ABSTAIN', reason: 'Contexte insuffisant.' } as const;
    expect(T4AgendaRepresentationOutput.safeParse(abst).success).toBe(true);
    expect(T4AgendaRepresentationOutput.parse({ ...abst, userQuestion: 'Q ?' }).userQuestion).toBe('Q ?');
  });

  it('K-04 — revue du rattachement : la question accompagne l’ARBITRATE, jamais les autres décisions', () => {
    const p = { currentAssetIds: [18], candidateIds: [14, 18], indexIds: [1], unitIds: ['u1'], contract: true };
    const arb = decideAttachmentReview(T3LinkAmbiguityOutput.parse({
      task: 'LINK_AMBIGUITY', matches: [{ candidateId: 14, score: 0.9, confidence: 'certain', reason: 'r' }],
      attachmentReview: { decision: 'ARBITRATE', concernedAssetIds: [14], citedUnitIds: ['u1'], reason: 'objet assuré', userQuestion: Q },
    }), p);
    expect(arb).toMatchObject({ kind: 'ARBITRATE', suggestedAssetId: 14, userQuestion: Q });
    const keep = decideAttachmentReview(T3LinkAmbiguityOutput.parse({
      task: 'LINK_AMBIGUITY', matches: [], attachmentReview: { decision: 'KEEP_CURRENT', concernedAssetIds: [18], reason: 'r', userQuestion: Q },
    }), p);
    expect(keep).toMatchObject({ kind: 'CONFIRMED' });
    expect(keep).not.toHaveProperty('userQuestion');
  });

  it('K-05 — T3 DOCUMENT_ASSET : abstention valide → question gardée ; violation du monde fermé → aucune', () => {
    const cand = (assetId: number) => ({ assetId, serverSignals: [], currentRole: null, t1: null, sources: ['EXACT_NAME'] }) as never;
    const abst = decideFromAiOutput(T3LinkAmbiguityOutput.parse({ task: 'LINK_AMBIGUITY', matches: [], userQuestion: Q }), [cand(1), cand(2)]);
    expect(abst).toMatchObject({ kind: 'ABSTAIN', userQuestion: Q });
    const viol = decideFromAiOutput(T3LinkAmbiguityOutput.parse({ task: 'LINK_AMBIGUITY', matches: [{ candidateId: 9, score: 0.9, confidence: 'certain', reason: 'r' }], userQuestion: Q }), [cand(1)]);
    expect(viol).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'CLOSED_WORLD_VIOLATION' });
    expect(viol).not.toHaveProperty('userQuestion');
  });
});

describe('L113S — catalogue : les 27 règles actives classées (formulation)', () => {
  it('R-01 — chaque règle dit qui formule sa question ; catalogue sain', () => {
    expect(checkRulesCatalog()).toEqual([]);
    expect(PROCESSING_RULES).toHaveLength(27);
    for (const r of PROCESSING_RULES) expect(['AI_CONTEXTUAL', 'DETERMINISTIC'], r.code).toContain(r.formulation.kind);
  });

  it('R-02 — arbitrages contextuels confiés au traitement IA qui les décide ; données simples déterministes', () => {
    const ia = PROCESSING_RULES.filter((r) => r.formulation.kind === 'AI_CONTEXTUAL').map((r) => r.code).sort();
    expect(ia).toEqual(['AGENDA-PROJECTION-MATCH', 'LINK-ASSET', 'LINK-ASSET-CONFLICT', 'LINK-ELT', 'OPERATION-MATCH']);
    const parCode = new Map(PROCESSING_RULES.map((r) => [r.code, r.formulation]));
    expect(parCode.get('DATA-CONTRACT-END')).toEqual({ kind: 'DETERMINISTIC', why: 'DATA_ENTRY' });
    expect(parCode.get('DOC-RUB')).toEqual({ kind: 'DETERMINISTIC', why: 'DATA_ENTRY' });
    expect(parCode.get('DOC-INTERVENTION')).toEqual({ kind: 'DETERMINISTIC', why: 'AI_ACTION_LABEL' });
    expect(parCode.get('AGENDA-PROJECTION-MATCH')).toMatchObject({ treatment: 'T4', operation: 't4_agenda_representation' });
    expect(parCode.get('OPERATION-MATCH')).toMatchObject({ treatment: 'T3', operation: 't3_operation_match' });
    // 113P : plus aucune carte de statut d'événement.
    expect(parCode.has('AGENDA-DONE')).toBe(false);
    expect(parCode.has('AGENDA-NOT-DONE')).toBe(false);
  });

  it('R-03 — aucune question du catalogue ne contient « Opération » ni de jargon', () => {
    for (const r of PROCESSING_RULES) expect(r.question, r.code).not.toMatch(/\bop[ée]ration/i);
  });
});
