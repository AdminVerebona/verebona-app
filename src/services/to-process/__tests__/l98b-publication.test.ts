/**
 * Lot 98B — ticket P0 « À traiter — ne publier une carte que si son utilité
 * est démontrée » (P0-C, P0-D, P0-E, P1). Tests SANS base (le scénario e2e
 * `l98b-a-traiter-publiable.e2e.ts` couvre l'exécution réelle).
 *
 *  L98B-U-PUB   définition unique « publiable » (pure + SQL) et ses lecteurs
 *  L98B-U-COH   COH-TODO-DOCUMENT-FIELDS / COH-TODO-RELEVANCE-CARDS v2 : un maintien technique n'est jamais CONSISTENT
 *  L98B-U-GAPS  réponse T3 valide mais incomplète (besoin déclaré ↔ constituants rendus), demande ciblée
 *  L98B-U-MODE  mode des campagnes : AUTO (C-Q5 puis C-Q2), coupure d'urgence
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cardStanding, heldCardSql, isPublishable, publishableCardSql, HOLD_CAUSE_LABELS, TECHNICAL_HOLD_REASONS,
} from '../publishability';
import { incompleteAnswerGaps, isKnowledgeAnswerIncompleteForCard, knowledgeGaps, renderedRoles, withFollowUp, DECISION_GAP_PREFIX } from '../document-semantic-knowledge';
import type { SemanticResolution } from '@/services/ai/reconciliation/knowledge-query/service';
import { declaredDecisionGaps } from '@/services/coherence/registry/checks/t1-knowledge-consumption';
import { coherenceModeSetting, resolveCoherenceMode } from '@/services/coherence/orchestrator';
import { getCheck } from '@/services/coherence/registry';

const ROOT = join(__dirname, '../../../..');
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const finding = (target: string, rawValue: string, normalized: string | null = null) => ({
  target, rawValue, normalized, evidenceRefs: ['U-1'], excerpt: rawValue, modelConfidence: 'certain' as const, evidenceConfidence: 'certain' as const, meaning: 'test', fileIds: [1],
});
const reponse = (outcome: string, findings: ReturnType<typeof finding>[]): SemanticResolution => ({
  status: 'ANSWERED', outcome: outcome as never, findings, rejected: [], contradictions: [], aiCalled: true, calls: 1, cached: false, traceIds: ['t1'],
  promptVersion: 'v', questionFingerprint: 'q', contextFingerprint: 'c', summary: null, queryId: 10,
});
const ROLES = ['start', 'duration', 'firstInstalment', 'lastInstalment', 'count', 'periodicity', 'disbursement', 'repayment'];

describe('L98B-U-PUB — « carte ouverte » ≠ « carte publiable » (P0-E)', () => {
  it('L98B-U-PUB-01 — maintien technique (T4 incompatible, interprétation en attente / incomplète, panne, erreur) : jamais publiable', () => {
    for (const r of ['KEPT_T4_INCOMPATIBLE', 'KEPT_INTERPRETATION_PENDING', 'KEPT_INTERPRETATION_INCOMPLETE', 'KEPT_ON_TECHNICAL_FAILURE']) {
      const s = cardStanding({ outcome: 'KEEP', reasonCode: r });
      expect(s.kind, r).toBe('TECHNICAL_HOLD');
      expect(isPublishable(s)).toBe(false);
    }
    expect(cardStanding({ outcome: 'ERROR', reasonCode: 'RULE_EVALUATION_FAILED' })).toMatchObject({ kind: 'TECHNICAL_HOLD', cause: 'EVALUATION_ERROR' });
    expect(cardStanding({ outcome: 'KEEP', reasonCode: 'KEPT_T4_INCOMPATIBLE' })).toMatchObject({ cause: 'T4_INCOMPATIBLE' });
    for (const c of Object.values(TECHNICAL_HOLD_REASONS)) expect(HOLD_CAUSE_LABELS[c].length).toBeGreaterThan(10);
  });

  it('L98B-U-PUB-02 — décision démontrée (question utile, intervention, arbitrage) ou aucune décision documentaire : publiable', () => {
    expect(cardStanding({ outcome: 'CREATE_ACTION', reasonCode: 'MISSING_DATA' })).toMatchObject({ kind: 'JUSTIFIED', ambiguity: false });
    expect(cardStanding({ outcome: 'KEEP', reasonCode: 'STILL_OPEN' }).kind).toBe('JUSTIFIED');
    expect(cardStanding({ outcome: 'CREATE_ACTION', reasonCode: 'AMBIGUOUS' })).toMatchObject({ kind: 'JUSTIFIED', ambiguity: true });
    expect(cardStanding(null).kind).toBe('NO_DECISION');
    expect(isPublishable(cardStanding(null))).toBe(true);
  });

  it('L98B-U-PUB-03 — même table de correspondance en SQL : dernière décision de la MÊME règle sur le MÊME document', () => {
    const h = heldCardSql('t');
    for (const r of Object.keys(TECHNICAL_HOLD_REASONS)) expect(h).toContain(`'${r}'`);
    expect(h).toContain("h.outcome = 'ERROR'");
    expect(h).toContain('d.rule_code = t.rule_code');
    expect(h).toContain('ORDER BY d.id DESC LIMIT 1');
    expect(h).toContain("t.target_type = 'DOCUMENT'");
    expect(publishableCardSql('t')).toBe(`NOT ${h}`);
  });

  it('L98B-U-PUB-04 — page, compteur, pastille, accueil / mascotte, notifications, assistant : une seule définition, aucun appel T3 / T4 à la lecture', () => {
    expect(lire('src/services/to-process/to-process-query.service.ts').match(/publishableCardCondition\(\)/g)?.length).toBe(2);
    expect(lire('src/services/to-process/to-process-action.service.ts')).toMatch(/countActiveActions[\s\S]*publishableCardCondition\(\)/);
    expect(lire('src/lib/notifications/scheduled/to-process-scan.ts')).toContain('publishableCardCondition()');
    expect(lire('src/lib/notifications/scheduled/to-process-digest.ts')).toContain("publishableCardSql('a')");
    expect(lire('src/services/verebona-assistant/core/account-state.ts')).toContain("publishableCardSql('t')");
    expect(lire('src/services/verebona-assistant/canonical/actionables.ts')).toContain("publishableCardSql('t')");
    expect(lire('src/services/verebona-assistant/registries/retrieval-adapters.ts')).toContain('publishableCardCondition()');
    // Accueil et mascotte lisent la page (même requête).
    expect(lire('src/services/home/HomeSummaryService.ts')).toContain('getToProcessPage(');
    expect(lire('src/services/home/mascot/collector.ts')).toContain('getToProcessPage(');
    const pub = lire('src/services/to-process/publishability.ts');
    expect(pub).not.toMatch(/AiGateway|interpretT1Knowledge|assessDeadlinePertinence/);
  });
});

describe('L98B-U-COH — une décision À JOUR n’est pas une carte justifiée (P0-C)', () => {
  it('L98B-U-COH-01 — versions incrémentées (réexamen du stock par la campagne)', () => {
    expect(getCheck('COH-TODO-DOCUMENT-FIELDS')?.version).toBe(2);
    expect(getCheck('COH-TODO-RELEVANCE-CARDS')?.version).toBe(2);
    expect(getCheck('COH-T1-KNOWLEDGE-CONSUMPTION')?.version).toBe(2);
    expect(getCheck('COH-TODO-DOCUMENT-FIELDS')?.anomalies).toContain('DECISION_NOT_DEMONSTRATED');
  });

  it('L98B-U-COH-02 — DECISION_CURRENT n’est plus CONSISTENT par défaut : le motif est jugé par `cardStanding`', () => {
    const src = lire('src/services/coherence/registry/checks/to-process.ts');
    expect(src).toMatch(/case 'DECISION_CURRENT':[\s\S]*cardStanding\(/);
    expect(src).not.toMatch(/\/\/ DECISION_CURRENT, USER_PROTECTED/);
    // Cause levée → réparable (une tentative par jour) ; sinon constat, jamais CONSISTENT.
    expect(src).toMatch(/levee\.lifted\s*\?\s*\{ verdict: 'REPAIRABLE'[\s\S]*jour: ctx\.today[\s\S]*: \{ verdict: 'FINDING'/);
  });
});

describe('L98B-U-GAPS — réponse T3 valide mais incomplète (P0-D)', () => {
  const pasDeRemboursement = { repaymentSchedule: false, endActions: [] as string[] };

  it('L98B-U-GAPS-01 — la décision déclare son besoin : remboursement, seulement si aucune valeur lue ni démarche de fin', () => {
    expect(knowledgeGaps({ endDateNeed: pasDeRemboursement, readValue: false })).toEqual(['repayment']);
    expect(knowledgeGaps({ endDateNeed: pasDeRemboursement, readValue: true })).toEqual([]);
    expect(knowledgeGaps({ endDateNeed: { repaymentSchedule: true, endActions: [] }, readValue: false })).toEqual([]);
    expect(knowledgeGaps({ endDateNeed: { repaymentSchedule: false, endActions: ['préavis de trois mois'] }, readValue: false })).toEqual([]);
    expect(knowledgeGaps({ endDateNeed: null, readValue: false })).toEqual([]);
  });

  it('L98B-U-GAPS-02 — T3 ne rend que la durée : INCOMPLET détecté (remboursement à redemander) ; durée + remboursement : complet', () => {
    const seule = reponse('CONSTITUENTS', [finding('duration', '22 ans')]);
    expect(incompleteAnswerGaps(seule, ['repayment'], ROLES)).toEqual(['repayment']);
    expect(isKnowledgeAnswerIncompleteForCard({ answer: seule, needs: ['repayment'], offered: ROLES })).toEqual({ incomplete: true, missing: ['repayment'] });
    const complete = reponse('CONSTITUENTS', [finding('duration', '22 ans'), finding('repayment', 'La durée est égale à 22 ans')]);
    expect(incompleteAnswerGaps(complete, ['repayment'], ROLES)).toEqual([]);
    // Abstention, rien trouvé, contexte tronqué : pas une réponse « incomplète » (autres motifs, autres contrôles).
    expect(incompleteAnswerGaps(reponse('NOT_FOUND', []), ['repayment'], ROLES)).toEqual([]);
    expect(incompleteAnswerGaps(reponse('AMBIGUOUS', []), ['repayment'], ROLES)).toEqual([]);
    // Rôle non offert à T3 : jamais redemandé.
    expect(incompleteAnswerGaps(seule, ['repayment'], ['start', 'duration'])).toEqual([]);
  });

  it('L98B-U-GAPS-03 — demande complémentaire fusionnée (constats, appels, traces) ; refus ou attente : rien inventé', () => {
    const main = reponse('CONSTITUENTS', [finding('duration', '22 ans', '264')]);
    const suite = { ...reponse('CONSTITUENTS', [finding('repayment', 'La durée est égale à 22 ans')]), queryId: 11 };
    const m = withFollowUp(main, ['repayment'], suite);
    expect(renderedRoles(m)).toEqual(['duration', 'repayment']);
    expect(m).toMatchObject({ calls: 2, queryId: 10, followUp: { focus: ['repayment'], status: 'ANSWERED', queryId: 11 } });
    const attente = withFollowUp(main, ['repayment'], { ...main, status: 'PENDING', pendingReason: 'BUDGET_EXHAUSTED', findings: [], calls: 0, queryId: null });
    expect(renderedRoles(attente)).toEqual(['duration']);
    expect(attente.followUp).toMatchObject({ status: 'PENDING', pendingReason: 'BUDGET_EXHAUSTED' });
  });

  it('L98B-U-GAPS-04 — besoin lu dans la trace (nouvelle décision) ou recalculé par la MÊME règle (décision antérieure)', () => {
    expect(declaredDecisionGaps({ missing_sources: [`${DECISION_GAP_PREFIX}repayment`], derivation: null, proposals: [] }, knowledgeGaps, DECISION_GAP_PREFIX)).toEqual(['repayment']);
    expect(declaredDecisionGaps({ missing_sources: [], derivation: { endDateNeed: pasDeRemboursement }, proposals: [] }, knowledgeGaps, DECISION_GAP_PREFIX)).toEqual(['repayment']);
    expect(declaredDecisionGaps({ missing_sources: [], derivation: { endDateNeed: pasDeRemboursement }, proposals: [{ value: '2030-01-01' }] }, knowledgeGaps, DECISION_GAP_PREFIX)).toEqual([]);
    expect(declaredDecisionGaps(null, knowledgeGaps, DECISION_GAP_PREFIX)).toEqual([]);
  });

  it('L98B-U-GAPS-05 — demande ciblée : seuls les constituants manquants sont offerts (autre empreinte, même contrat)', async () => {
    const { buildKnowledgeQuestion } = await import('@/services/ai/reconciliation/knowledge-query/service');
    const { questionFingerprint } = await import('@/services/ai/reconciliation/knowledge-query/context');
    const rule = { code: 'DATA-CONTRACT-END', question: 'Quelle est la date de fin de ce contrat ?' };
    const q = await buildKnowledgeQuestion(rule, 'contractEndDate');
    const f = await buildKnowledgeQuestion(rule, 'contractEndDate', ['repayment']);
    expect(q.constituents.map((c) => c.role)).toContain('repayment');
    expect(f.constituents.map((c) => c.role)).toEqual(['repayment']);
    expect(questionFingerprint(f, 'v1')).not.toBe(questionFingerprint(q, 'v1'));
  });

  it('L98B-U-GAPS-06 — aucune règle BNP / crédit / formulation dans le code du lot', () => {
    for (const p of ['src/services/to-process/publishability.ts', 'src/services/to-process/document-semantic-knowledge.ts', 'src/services/coherence/registry/checks/t1-knowledge-consumption.ts']) {
      expect(lire(p)).not.toMatch(/\bBNP\b|cr[ée]dit immobilier|22 ans|490000/i);
    }
  });
});

describe('L98B-U-MODE — campagnes correctives (P1, C-Q2 / C-Q5)', () => {
  const faux = (complete: boolean) => ({ unsafe: async () => [{ ok: complete }] }) as never;

  it('L98B-U-MODE-01 — réglage : corrective, coupure d’urgence (dry_run), AUTO si vide, prudence sur une faute de frappe', () => {
    expect(coherenceModeSetting({})).toBe('AUTO');
    expect(coherenceModeSetting({ COHERENCE_CAMPAIGN_MODE: '  ' })).toBe('AUTO');
    expect(coherenceModeSetting({ COHERENCE_CAMPAIGN_MODE: 'corrective' })).toBe('CORRECTIVE');
    expect(coherenceModeSetting({ COHERENCE_CAMPAIGN_MODE: 'dry_run' })).toBe('DRY_RUN');
    expect(coherenceModeSetting({ COHERENCE_CAMPAIGN_MODE: 'corectif' })).toBe('DRY_RUN');
  });

  it('L98B-U-MODE-02 — AUTO : à blanc tant qu’aucune campagne quotidienne à blanc n’a abouti, correctif ensuite ; lecture impossible : à blanc', async () => {
    expect(await resolveCoherenceMode(faux(false), {})).toBe('DRY_RUN');
    expect(await resolveCoherenceMode(faux(true), {})).toBe('CORRECTIVE');
    expect(await resolveCoherenceMode(faux(true), { COHERENCE_CAMPAIGN_MODE: 'dry_run' })).toBe('DRY_RUN');
    expect(await resolveCoherenceMode({ unsafe: async () => { throw new Error('panne'); } } as never, {})).toBe('DRY_RUN');
  });
});
