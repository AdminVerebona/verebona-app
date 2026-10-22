/**
 * Lot 61 — ticket « [P2] T6 — Implémenter le nouveau contrat de décision IA
 * et fiabiliser la composition de la bulle d'accueil » : tests UNITAIRES (IA
 * simulée, aucun réseau, base simulée). Les mêmes critères sont prouvés sur
 * PostgreSQL 16 réel par `src/test/e2e/scenarios/l61e-t6-evaluate.e2e.ts`.
 *
 * Contrats (§9)
 *  T6-EV-01  EVALUATE accepte une sortie valide, rejette toute sortie structurellement incohérente
 *  T6-EV-02  FORMULATE conserve intégralement t6-output-v2
 *  T6-EV-03  identifiants, références et ordre des sujets préservés
 *  T6-EV-04  une décision invalide ne provoque aucune interpellation non justifiée
 *  T6-EV-05  validations historiques T6 sans régression (corpus P-T6, P-T6-EV)
 * Décision et affichage
 *  T6-EV-06  deux assurances au 1er janvier 2027, évaluées le 15 octobre 2026 sans action : aucune interpellation
 *  T6-EV-07  échéance lointaine avec démarche immédiate établie : éligible
 *  T6-EV-08  échéance passée sans action identifiée : aucune vérification générique
 *  T6-EV-09  « À traiter » réellement prioritaire : toujours signalé
 *  T6-EV-10  document en analyse : correctement présenté
 *  T6-EV-11  échec IA : ni échéance artificielle, ni « Tout est à jour »
 *  T6-EV-12  aucun sujet écarté ne réapparaît (cache des évaluations, secours, suggestions)
 * Bulle et UX
 *  T6-EV-13  résumé, cartes, actions et pose cohérents (état de présentation explicite)
 *  T6-EV-14  aucun titre d'échéance concaténé
 *  T6-EV-15  deux événements indépendants : actions distinctes
 *  T6-EV-16  questions T2 construites sur la sélection retenue
 *  T6-EV-17  « Voir », « À traiter », onboarding et Duo préservés
 *  T6-EV-18  préférences de rappel respectées ; réévaluation ≠ rappel utilisateur
 * Exécution et supervision
 *  T6-EV-19  reporting EVALUATE / FORMULATE : décisions, rejets motivés, écarts, sans donnée personnelle
 *  T6-EV-20  pas deux appels IA systématiques : évaluations réutilisées, dédoublonnées, échec différé
 *  T6-EV-21  version active plus ancienne du prompt : dégradation prudente, activation BO non bloquée
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
let configText: string | null = null;
let t6Ouvert = true;
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: configText, configVersionId: 3 }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => t6Ouvert }));

const C = await import('../t6-contract');
const I = await import('../t6-interpellation');
const R = await import('../t6-runner');
const S = await import('../t6-interpellation.service');
const { buildCandidates } = await import('../signals');
const { selectSubjects, buildSecondaries } = await import('../selector');
const { buildPresentation } = await import('../presentation');
const B = await import('../bubble');
const { buildT6SuggestionContext } = await import('../t6-suggestions');
const { renderMasterPrompt, isOptionalMasterTask } = await import('@/services/ai/prompts/prompt-loader');
const { getOperation } = await import('@/services/ai/registry/operations');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;
type Decided = import('../signals').MascotDecidedAgenda;
type Presentation = import('../types').MascotPresentation;

const TODAY = '2026-10-15';
const SEUIL = 60;
const MASTER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf-8');

// ── Fabriques ────────────────────────────────────────────────────────────────

const candidat = (o: Partial<import('../t6-contract').T6EvaluationCandidate> = {}): import('../t6-contract').T6EvaluationCandidate => {
  const id = o.subjectId ?? 'C1';
  return {
    subjectId: id, title: 'Échéance assurance habitation', description: null, assetName: 'Maison', assetCategory: 'LOGEMENT',
    dueDate: '2027-01-01', dateLabel: '1er janvier 2027', daysUntilDue: 78, dateNature: 'confirmée', dateRole: 'DEADLINE',
    overdue: false, requiresQualification: false, recurring: false, documents: [], recentlyShownDays: 0,
    evidence: [{ ref: `${id}.title`, kind: 'TITLE' }, { ref: `${id}.dueDate`, kind: 'DUE_DATE' }],
    ...o,
  };
};
const entree = (cands: import('../t6-contract').T6EvaluationCandidate[]): import('../t6-contract').T6EvaluationInput =>
  ({ schemaVersion: 't6-evaluation-input-v1', today: TODAY, thresholdDays: SEUIL, candidates: cands });
type Dec = import('../t6-contract').T6EvaluateOutput['decisions'][number];
const aucune = (subjectId = 'C1', o: Partial<Dec> = {}): Dec => ({
  subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED',
  reason: 'Échéance connue et suivie, aucune démarche à engager.', expectedAction: null, actionDeadline: null,
  suggestedReviewAt: null, priorityHint: null, evidenceRefs: [`${subjectId}.title`], uncertainties: [], ...o,
});
const agir = (subjectId = 'C1', o: Partial<Dec> = {}): Dec => ({
  subjectId, decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON',
  reason: 'Une démarche est à engager avant la date limite.', expectedAction: 'Prendre rendez-vous', actionDeadline: null,
  suggestedReviewAt: null, priorityHint: 'MEDIUM', evidenceRefs: [`${subjectId}.dueDate`], uncertainties: [], ...o,
});
const sortie = (decisions: Dec[]) => ({ schemaVersion: 't6-evaluation-v1', decisions });

const row = (id: number, date: string, o: Partial<Row> = {}): Row => ({
  id, title: `Échéance assurance ${id}`, date, forecast: false, requiresQualification: false,
  assetId: id, assetName: `Bien ${id}`, assetCategory: 'IMMOBILIER', assetSubtype: 'Maison', dateRole: 'DEADLINE', seriesKey: null, ...o,
});
const raw = (agenda: Row[], over: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: TODAY,
  processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda, acknowledgments: [], overdueAgenda: [], ...over,
} as Raw);

/** Évaluation conservée (cache), issue d'une décision VALIDÉE du nouveau contrat. */
const stocke = (d: Dec, fingerprint: string): import('../t6-interpellation').T6StoredAssessment => ({
  ...I.assessmentFromDecision({ ...d, expectedAction: d.expectedAction ?? null }),
  fingerprint, assessedOn: TODAY, contractVersion: 't6-evaluation-v1',
});
const cand = (o: Partial<import('../t6-interpellation').T6Candidate> = {}): import('../t6-interpellation').T6Candidate => ({
  subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'agenda:1@2027-01-01', seriesKey: null, accountId: 7, assetId: 1,
  dueDate: '2027-01-01', state: 'ACTIVE', fingerprint: 'fp1', ...o,
});
const decide = (o: Partial<Parameters<typeof I.decideT6Interpellation>[0]> = {}) => I.decideT6Interpellation({
  candidate: cand(), today: TODAY, thresholdDays: SEUIL, aiCapable: true, assessment: null, preferences: [], ...o,
});

/** Accueil composé comme `getMascotPresentation` (décisions → sujets → bulle). */
function accueil(r: Raw, shown: Decided[], o: Partial<Parameters<typeof buildPresentation>[0]> = {}): Presentation {
  const c = buildCandidates(r, { interpellation: { shown } });
  const s = selectSubjects(c.candidates);
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: TODAY, tiles: { unprovenOverdueIsQuestion: true }, ...o });
}
const montre = (id: number, o: Partial<Decided['interpellation']> = {}, action: string | null = 'Prendre rendez-vous'): Decided => ({
  agendaItemId: id, interpellation: { mode: 'ACT_NOW', priority: 'MEDIUM', code: 'AI_ACT_NOW', reasonCode: 'ACTION_REQUIRED_SOON', category: 'ACTION_NOW', ...o },
  action, reminder: { agendaItemId: id, suggestedDate: '2026-10-22', hasSeries: false },
});
const parler = (p: Presentation | null) => B.composeSpeech({ presentation: p, empty: false }).text;
const INTERDITS = /Tout est à jour|Aucune échéance dépassée|aucun document en attente|échéances dépassées sont à vérifier/i;

beforeEach(() => { unsafe.mockReset(); unsafe.mockResolvedValue([]); configText = null; t6Ouvert = true; R.resetT6EvaluationState(); });

// ── Contrats ─────────────────────────────────────────────────────────────────

describe('Contrats', () => {
  it('T6-EV-01 — EVALUATE accepte une sortie valide et rejette toute sortie structurellement incohérente', () => {
    const e = entree([candidat(), candidat({ subjectId: 'C2', dueDate: '2026-11-04', daysUntilDue: 20 })]);
    const ok = C.validateT6Evaluation(e, sortie([aucune('C1'), agir('C2')]));
    expect(ok).toMatchObject({ ok: true, rejected: [] });
    expect(ok.ok && ok.accepted.map((d) => [d.subjectId, d.decision])).toEqual([['C1', 'SUPPRESS'], ['C2', 'SHOW_NOW']]);
    const ko = (o: unknown) => C.validateT6Evaluation(e, o);
    expect(ko({ ...sortie([aucune('C1'), agir('C2')]), schemaVersion: 't6-output-v2' })).toMatchObject({ ok: false, reason: expect.stringMatching(/^schema/) });
    expect(ko(sortie([aucune('C1')]))).toEqual({ ok: false, reason: 'count' });
    expect(ko(sortie([aucune('C1'), { ...agir('C2'), decision: 'MAYBE' } as never]))).toMatchObject({ ok: false, reason: expect.stringMatching(/^schema:decisions\.1\.decision/) });
    expect(ko(sortie([aucune('C1'), { ...agir('C2'), reasonCode: 'BECAUSE' } as never]))).toMatchObject({ ok: false });
    expect(ko(sortie([aucune('C1'), agir('C2', { actionDeadline: '2026-02-30' })]))).toMatchObject({ ok: false, reason: expect.stringMatching(/actionDeadline/) });
    expect(ko(sortie([aucune('C1'), agir('C2', { suggestedReviewAt: '1er novembre' })]))).toMatchObject({ ok: false });
    expect(ko(sortie([aucune('C1'), { ...agir('C2'), priorityHint: 'URGENT' } as never]))).toMatchObject({ ok: false });
    expect(ko('pas du JSON')).toMatchObject({ ok: false });
    expect(C.isIsoDay('2026-02-29')).toBe(false);
    expect(C.isIsoDay('2028-02-29')).toBe(true);
  });

  it('T6-EV-02 — FORMULATE conserve intégralement t6-output-v2 (messages, suggestions, highlight) et coexiste avec EVALUATE', () => {
    expect(getOperation('t6_formulate')).toMatchObject({ task: 'FORMULATE', outputSchema: 'T6FormulateOutput', taskField: 'none' });
    expect(getOperation('t6_evaluate')).toMatchObject({ task: 'EVALUATE', outputSchema: 'T6EvaluateOutput', taskField: 'none', masterPromptCode: 't6_master_v1' });
    for (const k of ['operationCode', 'task', 'outputSchema', 'timeoutMs', 'promptVariables'] as const) {
      expect(getOperation('t6_evaluate')[k]).toEqual(C.T6_EVALUATE_OPERATION_SPEC[k]);
      expect(getOperation('t6_formulate')[k]).toEqual(C.T6_MASTER_OPERATION_SPEC[k]);
    }
    const input = { schemaVersion: 't6-input-v1' as const, language: 'fr' as const, subjects: [{ subjectId: 'S1', sourceCode: 'PROC-DOC-ANALYSIS', intent: 'inform' as const, facts: { documentTitle: 'Facture' }, fallbackText: 'Le document « Facture » est en cours d’analyse.', allowedHighlight: 'Facture' }] };
    const v = C.validateT6MasterOutput(input, { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'S1', text: 'Le document Facture est en cours d’analyse.', highlight: 'Facture' }], suggestions: [{ question: 'Où est ma facture ?', assetRef: null }] });
    expect(v).toMatchObject({ ok: true, messages: [{ subjectId: 'S1', highlight: 'Facture' }] });
    // Le contrat de décision n'est pas accepté en FORMULATE, ni l'inverse.
    expect(C.validateT6MasterOutput(input, sortie([aucune()]))).toMatchObject({ ok: false });
    expect(C.validateT6Evaluation(entree([candidat()]), { schemaVersion: 't6-output-v2', messages: [] })).toMatchObject({ ok: false });
    // `assessments` (R13 du lot 60) n'existe plus dans t6-output-v2 : retiré, jamais lu.
    expect('assessments' in C.T6FormulateOutput.parse({ schemaVersion: 't6-output-v2', messages: [], assessments: [1] })).toBe(false);
  });

  it('T6-EV-03 — identifiants, références et ordre préservés ; aucune décision ni référence inventée', () => {
    const e = entree([candidat(), candidat({ subjectId: 'C2' })]);
    expect(C.validateT6Evaluation(e, sortie([aucune('C2'), aucune('C1')]))).toEqual({ ok: false, reason: 'order:0' });
    expect(C.validateT6Evaluation(e, sortie([aucune('C1'), aucune('C9')]))).toEqual({ ok: false, reason: 'order:1' });
    expect(C.validateT6Evaluation(e, sortie([aucune('C1'), aucune('C2'), aucune('C3')]))).toEqual({ ok: false, reason: 'count' });
    const r = C.validateT6Evaluation(e, sortie([aucune('C1', { evidenceRefs: ['C1.contrat'] }), aucune('C2', { evidenceRefs: ['C1.title'] })]));
    expect(r).toEqual({ ok: true, accepted: [], rejected: [{ subjectId: 'C1', index: 0, reason: 'unknown_evidence' }, { subjectId: 'C2', index: 1, reason: 'unknown_evidence' }] });
  });

  it('T6-EV-04 — une décision invalide est rejetée (motif) et ne provoque aucune interpellation', async () => {
    const e = entree([candidat({ dueDate: '2026-11-04', daysUntilDue: 20 }), candidat({ subjectId: 'C2' }), candidat({ subjectId: 'C3' }), candidat({ subjectId: 'C4', dueDate: '2026-11-04' })]);
    const v = C.validateT6Evaluation(e, sortie([
      agir('C1', { expectedAction: null }),
      agir('C2', { category: 'INFORMATION' }),
      agir('C3', { reasonCode: 'NO_ACTION_REQUIRED' }),
      agir('C4', { actionDeadline: '2026-12-01' }),
    ]));
    expect(v.ok && v.rejected.map((x) => x.reason)).toEqual(['show_now_without_action', 'show_now_information', 'reason_code_mismatch', 'action_deadline_after_due']);
    expect(C.evaluationDecisionViolation(agir('C1', { evidenceRefs: [] }), candidat(), TODAY)).toBe('show_now_without_evidence');
    expect(C.evaluationDecisionViolation(aucune('C1', { reason: 'ok' }), candidat(), TODAY)).toBe('reason_missing');
    expect(C.evaluationDecisionViolation(aucune('C1', { suggestedReviewAt: TODAY }), candidat(), TODAY)).toBe('review_not_future');
    expect(C.evaluationDecisionViolation(agir('C1', { actionDeadline: '2026-10-01' }), candidat(), TODAY)).toBe('action_deadline_past');
    expect(C.evaluationDecisionViolation(agir('C1', { expectedAction: 'Appelle ton assureur' }), candidat(), TODAY)).toBe('action_wording');
    // Bout en bout : rien n'est conservé, la décision du serveur reste « en attente » → jamais affiché.
    const persist = vi.fn(async (l: unknown[]) => l.length);
    const bundle = { context: entree([candidat({ dueDate: '2026-11-04', daysUntilDue: 20 })]), refs: new Map([['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'fp1', daysUntilDue: 20 }]]), persist };
    const o = await R.evaluateWithT6({ accountId: 7, bundle, mode: 'pregen' }, {
      available: async () => true, promptVersion: async () => 'v',
      execute: (async () => ({ data: sortie([agir('C1', { expectedAction: null })]), model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't' })) as never,
    });
    expect(o).toMatchObject({ status: 'generated', accepted: [], rejected: [{ reason: 'show_now_without_action' }], persisted: 0 });
    expect(persist).not.toHaveBeenCalled();
    expect(decide({ candidate: cand({ dueDate: '2026-11-04' }) })).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING' });
  });

  it('T6-EV-05 — validations historiques T6 sans régression : corpus P-T6 (FORMULATE) et P-T6-EV (EVALUATE) conformes', () => {
    const dir = join(process.cwd(), 'src/services/home/mascot/__fixtures__');
    const cas = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    const formulate = cas.filter((c) => c.recording.operationCode === 't6_formulate');
    const evaluate = cas.filter((c) => c.recording.operationCode === 't6_evaluate');
    expect(formulate.length).toBeGreaterThanOrEqual(5);
    // Lot 68 : P-T6-EV-04 (rappel informatif) s'ajoute aux cas du lot 61.
    expect(evaluate.map((c) => c.case)).toEqual(['P-T6-EV-01', 'P-T6-EV-02', 'P-T6-EV-03', 'P-T6-EV-04']);
    for (const c of formulate) expect(C.evaluateT6CorpusCase(c.context, c.recording.output, c.expected ?? null)).toEqual([]);
    for (const c of evaluate) expect(C.evaluateT6EvaluationCorpusCase(c.context, c.recording.output, c.expected ?? null)).toEqual([]);
    // Contrôles historiques de FORMULATE : tutoiement, date relative, nombre inventé.
    const input = { schemaVersion: 't6-input-v1' as const, language: 'fr' as const, subjects: [{ subjectId: 'S', sourceCode: 'DATE-NEXT', intent: 'deadline' as const, facts: { title: 'CT', dateLabel: '4 novembre 2026', dateNature: 'confirmée' }, fallbackText: 'Le CT est à prévoir pour le 4 novembre 2026.', allowedHighlight: null }] };
    for (const text of ['Ton CT est à prévoir pour le 4 novembre 2026.', 'Le CT est à prévoir demain, le 4 novembre 2026.', 'Le CT coûte 80 euros le 4 novembre 2026.']) {
      expect(C.validateT6MasterOutput(input, { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'S', text }] }).ok).toBe(false);
    }
  });
});

// ── Décision et affichage ────────────────────────────────────────────────────

describe('Décision et affichage', () => {
  it('T6-EV-06 — deux assurances au 1er janvier 2027, évaluées le 15 octobre 2026 sans action immédiate : aucune interpellation', () => {
    expect(I.daysBetween(TODAY, '2027-01-01')).toBe(78);
    for (const id of [1, 2]) {
      const c = cand({ agendaItemId: id, subjectKey: `agenda:${id}`, fingerprint: `fp${id}` });
      expect(decide({ candidate: c, assessment: stocke(aucune(), `fp${id}`) })).toMatchObject({ decision: 'SUPPRESS', code: 'AI_NO_INTERPELLATION', aiDecision: 'SUPPRESS' });
      expect(decide({ candidate: c, assessment: stocke(aucune('C1', { decision: 'DEFER', reasonCode: 'TOO_EARLY', suggestedReviewAt: '2026-11-15' }), `fp${id}`) }))
        .toMatchObject({ decision: 'DEFER', code: 'AI_LATER', nextReevaluationAt: '2026-11-15' });
      // L'IA qui « interpelle » sans démarche fondée sur la description ou un document : le seuil s'applique.
      expect(decide({ candidate: c, assessment: stocke(agir(), `fp${id}`) })).toMatchObject({ decision: 'SUPPRESS', code: 'BEYOND_THRESHOLD', aiDecision: 'SHOW_NOW' });
    }
    const p = accueil(raw([row(1, '2027-01-01'), row(2, '2027-01-01')]), []);
    expect(p.status).toBe('clear');
    expect(p.state).toMatchObject({ kind: 'NOTHING_TO_REPORT', actions: 0, information: 0, evaluation: 'OK' });
    expect(parler(p)).toBe('Rien de particulier à vous signaler pour le moment.');
    expect(B.homeItems(p, false)).toEqual([]);
    expect(B.homePose(p, false)).toBe('success-check');
  });

  it('T6-EV-07 — échéance lointaine avec démarche immédiate établie (description, date d’action dans le seuil) : éligible', () => {
    const d = agir('C1', { reasonCode: 'NOTICE_PERIOD_RUNNING', evidenceRefs: ['C1.description'], actionDeadline: '2026-11-01', reason: 'La description indique un préavis de deux mois avant l’échéance.' });
    expect(C.evaluationDecisionViolation(d, candidat({ description: 'Préavis de deux mois.', evidence: [{ ref: 'C1.description', kind: 'DESCRIPTION' }] }), TODAY)).toBeNull();
    expect(decide({ assessment: stocke(d, 'fp1') })).toMatchObject({ decision: 'SHOW_NOW', code: 'THRESHOLD_EXCEPTION', thresholdException: true });
    const p = accueil(raw([row(1, '2027-01-01')]), [montre(1, { code: 'THRESHOLD_EXCEPTION', reasonCode: 'NOTICE_PERIOD_RUNNING' }, 'Envoyer la lettre de résiliation')]);
    // Lot 68 : sujet dit directement, un bloc (plus d'introduction ni de carte qui répète).
    expect(parler(p)).not.toMatch(/mérite votre attention/);
    expect(B.subjectBlocks(p)).toHaveLength(1);
    expect(B.homeItems(p, false)).toEqual([]);
  });

  it('T6-EV-08 — échéance passée sans action identifiée : aucune vérification générique (IA, sans IA, compteur)', () => {
    const passee = cand({ dueDate: '2026-10-01' });
    expect(decide({ candidate: passee, assessment: stocke(aucune('C1', { reasonCode: 'OVERDUE_NO_ACTION_IDENTIFIED' }), 'fp1') })).toMatchObject({ decision: 'SUPPRESS' });
    // Sans IA : plus de rappel historique « à confirmer » — seule l'échéance « à préciser » (T4) reste.
    expect(decide({ candidate: passee, aiCapable: false })).toMatchObject({ decision: 'DEFER', code: 'EVALUATION_UNAVAILABLE' });
    expect(decide({ candidate: { ...passee, requiresQualification: true }, aiCapable: false })).toMatchObject({ decision: 'SHOW_NOW', code: 'NO_AI_QUALIFICATION_REQUIRED', mode: 'LEGACY' });
    // Compteur des échéances dépassées : supervision seulement.
    const p = accueil(raw([], { overdueAgenda: [{ id: 9, date: '2026-05-01' }, { id: 10, date: '2026-10-01' }] }), [], { overdueDeadlines: 2 });
    expect(p.overdueDeadlines).toBe(2);
    expect(parler(p)).not.toMatch(INTERDITS);
    expect(parler(p)).toBe(B.NOTHING_TO_REPORT_SPEECH);
    expect(B.homePose(p, false)).toBe('success-check');
  });

  it('T6-EV-09 — un « À traiter » réellement prioritaire continue d’être signalé ; non prioritaire : « aucun sujet en priorité »', () => {
    const item = { todoId: 't1', actionKind: 'COMPLETE', priority: 'DO_FIRST', title: 'Numéro à compléter', subtitle: 'Maison', cta: 'Compléter', entityType: 'ASSET', actionType: 'OPEN_TODO_CARD', todoType: 'DATA', card: { question: 'Numéro ?' } } as never;
    const p = accueil(raw([]), [], { todo: { total: 3, items: [item] } });
    // Lot 71F : la carte est présentée directement — aucune introduction de
    // comptage, jamais « aucun sujet en priorité » ni « rien à signaler ».
    expect(parler(p)).toBe('');
    expect(p.state).toMatchObject({ kind: 'ACTIONS', actions: 1, openNotPriority: true });
    expect(B.homePose(p, false)).toBe('reminder-bell');
    expect(B.homeItems(p, false).map((x) => x.kind)).toEqual(['todo']);
    const np = accueil(raw([]), [], { todo: { total: 2, items: [] } });
    expect(parler(np)).toBe('Aucun sujet à traiter en priorité pour le moment.');
    expect(np.state?.kind).toBe('OPEN_NOT_PRIORITY');
    expect(B.homePose(np, false)).toBe('neutral');
  });

  it('T6-EV-10 — document en analyse : présenté tel quel, sans « Tout est à jour » préalable, pose neutre', () => {
    const p = accueil(raw([], { processing: { uploads: [], analyses: [{ id: 5, title: 'Facture garage', at: '2026-10-15T08:00:00Z' }], exports: [] } }), []);
    expect(parler(p)).toBe('Le document « Facture garage » est en cours d’analyse.');
    expect(p.state).toMatchObject({ kind: 'INFORMATION', information: 1, actions: 0 });
    // Lot 78C : documents en cours d'analyse — pose « au travail », jamais la réussite.
    expect(B.homePose(p, false)).toBe('document-analysis-pdf');
    // Lot 68 : bloc du document (texte + « Voir »), plus de carte qui le répète.
    expect(B.subjectBlocks(p)[0]).toMatchObject({ informative: true, badge: null });
    expect(B.subjectBlocks(p)[0].actions.map((a) => a.label)).toEqual(['Voir']);
    // Avec des éléments non prioritaires ouverts.
    const q = accueil(raw([], { processing: { uploads: [], analyses: [{ id: 5, title: 'Facture garage', at: '2026-10-15T08:00:00Z' }], exports: [] } }), [], { todo: { total: 1, items: [] } });
    expect(parler(q)).toBe('Aucun sujet à traiter en priorité pour le moment. Le document « Facture garage » est en cours d’analyse.');
  });

  it('T6-EV-11 — échec IA : ni échéance artificielle, ni « Tout est à jour » ; état dégradé explicite', async () => {
    // Évaluation en échec (fournisseur) : échec mémorisé pour le compte → état UNAVAILABLE.
    const bundle = { context: entree([candidat({ dueDate: '2026-11-04', daysUntilDue: 20 })]), refs: new Map([['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'fp1', daysUntilDue: 20 }]]), persist: async () => 0 };
    const o = await R.evaluateWithT6({ accountId: 7, bundle, mode: 'display' }, {
      available: async () => true, promptVersion: async () => 'v', execute: (async () => { throw new Error('fournisseur indisponible'); }) as never,
    });
    expect(o).toMatchObject({ status: 'error', persisted: 0 });
    expect(R.t6EvaluationRecentlyFailed(7)).toBe(true);
    expect(R.t6EvaluationRecentlyFailed(8)).toBe(false);
    const pending = decide({ candidate: cand({ dueDate: '2026-11-04' }) });
    expect(S.evaluationStateOf([pending], { recentFailure: true })).toBe('UNAVAILABLE');
    expect(S.evaluationStateOf([pending])).toBe('PENDING');
    // Au-delà du seuil, l'attente ne dégrade pas l'accueil (rien n'y serait dit par défaut).
    expect(S.evaluationStateOf([decide()])).toBe('OK');
    // T6 coupé / version sans EVALUATE : EVALUATION_UNAVAILABLE.
    expect(S.evaluationStateOf([decide({ candidate: cand({ dueDate: '2026-11-04' }), aiCapable: false })])).toBe('UNAVAILABLE');
    const r = raw([row(1, '2026-11-04')]);
    for (const [ev, attendu] of [['UNAVAILABLE', B.EVALUATION_UNAVAILABLE_SPEECH], ['PENDING', B.EVALUATION_PENDING_SPEECH]] as const) {
      const p = accueil(r, [], { evaluation: ev });
      expect(p.status).toBe('ok');
      expect(p.state).toMatchObject({ kind: 'DEGRADED', evaluation: ev });
      expect(parler(p)).toBe(attendu);
      expect(parler(p)).not.toMatch(INTERDITS);
      expect(parler(p)).not.toMatch(/assurance|4 novembre/);
      expect(B.homeItems(p, false)).toEqual([]);
      expect(B.homePose(p, false)).toBe('neutral');
    }
    // Source en panne : jamais une réussite.
    const panne = accueil(raw([], { toProcess: null }), []);
    expect(parler(panne)).toMatch(/n’ont pas pu être actualisées/);
    expect(B.homePose(panne, false)).toBe('neutral');
    expect(B.homePose(null, false)).toBe('neutral');
  });

  it('T6-EV-12 — aucun sujet écarté ne réapparaît : cache des évaluations obsolètes, textes de secours, suggestions', () => {
    // Évaluation d'un autre contexte ou d'un autre contrat : jamais servie.
    expect(I.assessmentStatus(stocke(agir(), 'fp-ancien'), cand(), TODAY, SEUIL)).toBe('CONTEXT_CHANGED');
    expect(I.assessmentStatus({ ...stocke(agir(), 'fp1'), contractVersion: null }, cand(), TODAY, SEUIL)).toBe('CONTRACT_CHANGED');
    // Texte de secours, cartes et résumé : seulement les sujets retenus.
    const r = raw([row(1, '2026-11-04', { title: 'Révision chaudière' }), row(2, '2027-01-01'), row(3, '2026-10-01', { title: 'Ramonage' })]);
    const p = accueil(r, [montre(1)]);
    expect(p.paragraphs.map((x) => x.subjectId)).toEqual(['DATE-NEXT:1']);
    expect(parler(p)).not.toMatch(/assurance|Ramonage|janvier 2027/i);
    expect(B.actionTiles(p).map((x) => x.label)).toEqual(['Révision chaudière']);
    // Questions : contexte construit sur la sélection retenue (échéances écartées retirées).
    const retenues = r.agenda!.filter((x) => x.id === 1);
    const q = buildT6SuggestionContext({
      speech: parler(p), attentionToday: true, state: null, operations: 0, assets: [],
      agenda: retenues.filter((x) => x.date! > TODAY), labelOf: (x) => x.title, formatDate: (d) => d,
    });
    expect(q.context.nextDeadlines.map((x) => x.label)).toEqual(['Révision chaudière']);
    expect(q.context.bubble.speech).toBe(parler(p));
  });
});

// ── Bulle et UX ──────────────────────────────────────────────────────────────

describe('Bulle et UX', () => {
  it('T6-EV-13 — résumé, cartes, actions et pose cohérents ; même sujet jamais compté deux fois', () => {
    const r = raw([row(1, '2026-11-04', { title: 'Révision chaudière' }), row(2, '2026-10-01', { title: 'Ramonage' })]);
    const p = accueil(r, [montre(1), montre(2, { reasonCode: 'VERIFICATION_REQUIRED' }, 'Vérifier la date du dernier passage')]);
    const cartes = B.subjectBlocks(p);
    expect(p.state).toMatchObject({ kind: 'ACTIONS', actions: 2, information: 0 });
    expect(cartes).toHaveLength(p.state!.actions);
    // Lot 68 : plus d'introduction de comptage ; la nature de l'action reste dite (badge), sans la date répétée.
    expect(parler(p)).not.toMatch(/méritent votre attention/);
    expect(cartes.map((x) => x.badge)).toEqual(['Action à prévoir', 'À vérifier']);
    expect(B.actionTiles(p).map((x) => x.sub)).toEqual([expect.stringMatching(/^Bien 1 · Action à prévoir · 4 novembre 2026$/), expect.stringMatching(/À vérifier · 1er octobre 2026$/)]);
    expect(p.paragraphs.map((x) => x.tile?.kind)).toEqual(['action', 'verify']);
    expect(B.homePose(p, false)).toBe('questioning');
    expect(parler(p)).not.toMatch(INTERDITS);
    // Une action retenue n'est jamais précédée d'un message rassurant.
    expect(parler(accueil(r, [montre(1)], { todo: { total: 4, items: [] } }))).not.toContain(B.NOTHING_PRIORITY);
    // Le client retire aussitôt un sujet reporté : l'état suit (rien de prioritaire → plus d'annonce).
    const sansRappel = { ...p, paragraphs: [] };
    expect(B.presentationState(sansRappel)).toMatchObject({ actions: 0 });
    expect(parler(sansRappel)).toBe(B.NOTHING_TO_REPORT_SPEECH);
  });

  it('T6-EV-14 — aucun titre d’échéance concaténé (« Assurance et assurance »)', () => {
    const r = raw([row(1, '2026-11-20', { title: 'Échéance de l’assurance Assurance' }), row(2, '2026-11-20', { title: 'Échéance de l’assurance' })]);
    for (const sujets of [buildCandidates(r).candidates, buildCandidates(r, { interpellation: { shown: [montre(1), montre(2)] } }).candidates]) {
      expect(sujets.map((s) => s.sourceCode)).toEqual(['DATE-NEXT', 'DATE-NEXT']);
    }
    const p = accueil(r, [montre(1), montre(2)]);
    for (const it of B.actionTiles(p)) expect(it.label).not.toMatch(/ et /);
    expect(JSON.stringify(p)).not.toMatch(/DATE-NEXT-2/);
  });

  it('T6-EV-15 — deux événements indépendants : identifiants, dates, actions et rappels distincts', () => {
    const r = raw([row(1, '2027-01-01'), row(2, '2027-01-01', { assetName: 'Clio', assetId: 2 })]);
    const p = accueil(r, [montre(1), montre(2)]);
    const cartes = B.subjectBlocks(p);
    expect(cartes.map((x) => x.reminder?.agendaItemId)).toEqual([1, 2]);
    expect(cartes.map((x) => x.actions.map((a) => (a.action.target.kind === 'drawer' ? a.action.target.id : null)))).toEqual([[1], [2]]);
    expect(cartes.map((x) => x.actions[0].label)).toEqual(['Voir', 'Voir']);
  });

  it('T6-EV-16 — questions T2 : règle du prompt (aucune sollicitation artificielle), consultation libre conservée', () => {
    expect(MASTER).toContain('Elles ne transforment pas une simple information en sollicitation');
    expect(MASTER).toContain('jamais une question qui contredit ce message');
    // La validation des questions (contrat inchangé) reste celle du lot 55A.
    expect(MASTER).toContain('R12 — Questions suggérées.');
  });

  it('T6-EV-17 — « Voir », « À traiter », onboarding et Duo préservés', () => {
    const duo = { href: '/compte?panneau=duo', title: 'Inviter quelqu’un', subtitle: 'Premium Duo', cta: 'Inviter' };
    const item = { todoId: 't1', actionKind: 'ARBITRATE', priority: 'DO_FIRST', title: 'Date à vérifier', subtitle: null, cta: 'Vérifier', entityType: 'AGENDA_ITEM', actionType: 'OPEN_TODO_CARD', todoType: 'DATA', card: { question: 'Date ?' } } as never;
    const p = accueil(raw([row(1, '2026-11-04')], { onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 0 } }), [montre(1)], { duoInvite: duo, todo: { total: 1, items: [item] } });
    // Duo d'abord, puis « À traiter », puis les sujets retenus (onboarding : étape d'accueil, échéance décidée).
    // Lot 68 : Duo et « À traiter » en cartes ; les sujets retenus en blocs.
    expect(B.homeItems(p, false).map((x) => x.kind)).toEqual(['duo-invite', 'todo']);
    expect(B.homeItems(p, false).map((x) => x.title)).toEqual(['Inviter quelqu’un', 'Date à vérifier']);
    // Lot 71F : l'étape d'accueil directement, sans introduction de comptage.
    expect(parler(p)).toMatch(/^Ajoutez votre premier document pour Maison : une facture, un contrat ou une garantie\./);
    expect(parler(p)).not.toMatch(/votre attention/);
    expect(B.homePose(p, false)).toBe('questioning');
    const [onb, voir] = B.subjectBlocks(p);
    expect(onb.actions[0].action.target).toMatchObject({ kind: 'upload_document' });
    expect(voir.actions[0].action.target).toMatchObject({ kind: 'drawer', drawer: 'echeance', id: 1 });
    expect(voir.actions[0].label).toBe('Voir');
    // Compte vide : accueil d'amorce inchangé.
    expect(B.composeSpeech({ presentation: null, empty: true }).text).toBe(B.EMPTY_ACCOUNT_SPEECH);
    expect(B.homePose(null, true)).toBe('welcome-wave');
  });

  it('T6-EV-18 — préférences de rappel respectées, même face à une décision IA SHOW_NOW ; réévaluation ≠ rappel', async () => {
    const report = { scope: 'OCCURRENCE' as const, decision: 'SNOOZED' as const, remindAt: '2026-10-25', contextFingerprint: 'fp1', agendaItemId: 1, seriesKey: null };
    const refus = { scope: 'OCCURRENCE' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: 'fp1', agendaItemId: 1, seriesKey: null };
    const proche = cand({ dueDate: '2026-11-04' });
    expect(decide({ candidate: proche, assessment: stocke(agir(), 'fp1'), preferences: [report] })).toMatchObject({ decision: 'DEFER', code: 'USER_SNOOZED', aiDecision: 'SHOW_NOW' });
    expect(decide({ candidate: proche, assessment: stocke(agir(), 'fp1'), preferences: [refus] })).toMatchObject({ decision: 'SUPPRESS', code: 'USER_DISMISSED_OCCURRENCE' });
    // `suggestedReviewAt` devient une réévaluation système, jamais une préférence utilisateur.
    const a = I.assessmentFromDecision({ ...aucune('C1', { decision: 'DEFER', reasonCode: 'TOO_EARLY', suggestedReviewAt: '2026-11-15' }) });
    expect(a).toMatchObject({ reevaluateOn: '2026-11-15', interpellation: 'LATER' });
    unsafe.mockResolvedValue([{ id: 1 }]);
    const refs = new Map([['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'fp1', daysUntilDue: 20 }]]);
    const v = C.validateT6Evaluation(entree([candidat({ dueDate: '2026-11-04' })]), sortie([aucune('C1', { decision: 'DEFER', reasonCode: 'TOO_EARLY', suggestedReviewAt: '2026-11-15' })]));
    expect(v.ok).toBe(true);
    await S.persistT6Assessments(7, TODAY, refs, v.ok ? v.accepted : [], { promptVersion: 'v', traceId: null });
    const sqls = unsafe.mock.calls.map((c) => c[0]);
    expect(sqls.every((q) => !/t6_reminder_preferences/.test(q))).toBe(true);
    // Lot 68 : une sonde de la colonne `contract_revision` (0474) peut précéder l'insertion.
    const k = sqls.findIndex((q) => /INSERT INTO t6_interpellation_assessments/.test(q));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(sqls[k]).toMatch(/FROM agenda_items i WHERE i\.id = \$2 AND i\.account_id = \$1/);
    expect(unsafe.mock.calls[k][1]).toEqual(expect.arrayContaining(['t6-evaluation-v1', 'DEFER', 'INFORMATION', 'TOO_EARLY']));
  });
});

// ── Exécution et supervision ─────────────────────────────────────────────────

describe('Exécution et supervision', () => {
  it('T6-EV-19 — reporting : EVALUATE (décisions, rejets motivés), FORMULATE (transmis, affichés, secours), écarts IA / serveur ; aucune donnée personnelle', () => {
    const refs = new Map([
      ['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'fp1', daysUntilDue: 78 }],
      ['C2', { subjectKey: 'agenda:2', agendaItemId: 2, fingerprint: 'fp2', daysUntilDue: 20 }],
    ]);
    const ev = S.t6EvaluationEntries({
      status: 'generated', promptVersion: 'v', inputContract: 't6-evaluation-input-v1', outputContract: 't6-evaluation-v1', traceId: 't', error: null, persisted: 1,
      accepted: [{ subjectId: 'C1', decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', priorityHint: null, evidenceRefs: ['C1.title'] }],
      rejected: [{ subjectId: 'C2', reason: 'show_now_without_action' }],
    }, refs);
    expect(ev.map((e) => [e.section, e.entityId, e.recordStatus, e.reasonCode, e.writeResult])).toEqual([
      ['EVALUATE', 1, 'SUPPRESS', 'NO_ACTION_REQUIRED', 'WRITTEN'],
      ['EVALUATE', 2, 'REJECTED', 'VALIDATION:show_now_without_action', 'NOT_PERSISTED'],
    ]);
    const fo = S.t6FormulateEntries({ promptVersion: 'v', contract: 't6-output-v2', transmitted: ['DATE-NEXT:1'], displayed: ['DATE-NEXT:1'], source: 'fallback', status: 'fallback', presentation: 'ACTIONS' });
    expect(fo[0]).toMatchObject({ section: 'FORMULATE', value: { mode: 'FORMULATE', transmitted: ['DATE-NEXT:1'], displayed: ['DATE-NEXT:1'], fallbackUsed: true } });
    const ecart = { ...decide({ assessment: stocke(agir(), 'fp1') }), agendaItemId: 1, dueDate: '2027-01-01', seriesKey: null, assessment: stocke(agir(), 'fp1'), displayedDays: 0 };
    const [ligne] = S.t6ReportEntries([ecart], SEUIL).filter((e) => e.section === 'INTERPELLATION');
    expect(ligne.value).toMatchObject({ decision: 'SUPPRESS', aiDecision: 'SHOW_NOW', divergence: true, assessment: { contract: 't6-evaluation-v1', reasonCode: 'ACTION_REQUIRED_SOON' } });
    expect(JSON.stringify([...ev, ...fo, ligne])).not.toMatch(/assurance|Maison|Prendre rendez-vous/i);
  });

  it('T6-EV-20 — pas deux appels IA systématiques : une évaluation par entrée à la fois, échec différé, cache des décisions valides', async () => {
    let appels = 0;
    let liberer!: () => void;
    const attente = new Promise<void>((r) => { liberer = r; });
    const execute = (async () => { appels += 1; await attente; return { data: sortie([aucune()]), model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't' }; }) as never;
    const persist = vi.fn(async (l: unknown[]) => l.length);
    const bundle = { context: entree([candidat()]), refs: new Map([['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'fp1', daysUntilDue: 78 }]]), persist };
    const deps = { available: async () => true, promptVersion: async () => 'v', execute };
    const a = R.evaluateWithT6({ accountId: 7, bundle, mode: 'display' }, deps);
    const b = R.evaluateWithT6({ accountId: 7, bundle, mode: 'display' }, deps);
    await new Promise((r) => setTimeout(r, 5));
    liberer();
    const [oa, ob] = await Promise.all([a, b]);
    expect(appels).toBe(1);
    expect(oa).toBe(ob);
    expect(persist).toHaveBeenCalledTimes(1);
    // Décision valide conservée : l'affichage suivant la réutilise, sans nouvelle évaluation.
    expect(decide({ assessment: stocke(aucune(), 'fp1') })).toMatchObject({ needsAssessment: false, assessmentFresh: true });
    // Échec : la même entrée n'est pas réessayée avant le délai (plafond de coût).
    const ko = { ...deps, execute: (async () => { appels += 1; throw new Error('panne'); }) as never };
    const autre = { ...bundle, context: entree([candidat({ title: 'Autre' })]) };
    expect((await R.evaluateWithT6({ accountId: 7, bundle: autre, mode: 'display' }, ko)).status).toBe('error');
    expect((await R.evaluateWithT6({ accountId: 7, bundle: autre, mode: 'display' }, ko)).status).toBe('skipped');
    expect(appels).toBe(2);
    // FORMULATE n'envoie plus jamais de candidats : un seul contrat par appel.
    const execF = vi.fn(async (_r: unknown) => ({ data: { schemaVersion: 't6-output-v2', messages: [] }, model: 'm', usedFallback: false, fromCache: false, costMicros: 0, traceId: null }));
    await R.formulateWithT6({ accountId: 7, input: { schemaVersion: 't6-input-v1', language: 'fr', subjects: [] }, contextHash: 'h', mode: 'pregen' }, {
      treatmentAvailable: async () => true, promptVersion: async () => 'v', previousBubbles: async () => [], execute: execF as never, displayWaitMs: () => 6_000,
    });
    expect((execF.mock.calls[0][0] as { promptVariables: Record<string, unknown>; operationCode: string })).toMatchObject({ operationCode: 't6_formulate', promptVariables: { INTERPELLATION_CONTEXT: null } });
  });

  it('T6-EV-21 — version active plus ancienne (sans EVALUATE) : dégradation prudente, activation BO non bloquée ; texte livré complet', async () => {
    // Texte livré : deux branches, référentiel fermé recopié, contrat de sortie.
    expect(MASTER).toContain('BRANCHE MODE = EVALUATE');
    expect(MASTER).toContain('BRANCHE MODE = FORMULATE');
    for (const code of C.T6_REASON_CODE_LIST) expect(MASTER).toContain(`"${code}"`);
    expect(MASTER).toContain('"schemaVersion":"t6-evaluation-v1"');
    expect(MASTER).toContain('"schemaVersion":"t6-output-v2"');
    expect(MASTER).not.toMatch(/assurance|garantie|entretien/i);
    const vars = { INPUT_JSON: null, SUGGESTION_CONTEXT: null, INTERPELLATION_CONTEXT: '{"x":1}' };
    expect(renderMasterPrompt(MASTER, { masterPromptCode: 't6_master_v1', task: 'EVALUATE', allowedTasks: ['FORMULATE', 'EVALUATE'], variables: vars })).toMatch(/^MODE = EVALUATE$/m);
    // Version BO du lot 60 : FORMULATE seul (R13) — EVALUATE refusé avant tout appel, FORMULATE intact.
    const ancien = 'Tu es T6.\n\nMODE = {{MODE}}\n\nValeurs autorisées : FORMULATE\n\nEntrée structurée : {{INPUT_JSON}}\n\nContexte des questions suggérées : {{SUGGESTION_CONTEXT}}\n\nCandidats d’interpellation à évaluer : {{INTERPELLATION_CONTEXT}}\n\nR1 — Un message par sujet.\n';
    expect(() => renderMasterPrompt(ancien, { masterPromptCode: 't6_master_v1', task: 'EVALUATE', allowedTasks: ['FORMULATE', 'EVALUATE'], variables: vars })).toThrow(/EVALUATE/);
    expect(renderMasterPrompt(ancien, { masterPromptCode: 't6_master_v1', task: 'FORMULATE', allowedTasks: ['FORMULATE', 'EVALUATE'], variables: { ...vars, INTERPELLATION_CONTEXT: null } })).toContain('MODE = FORMULATE');
    expect(isOptionalMasterTask('t6_master_v1', 'EVALUATE')).toBe(true);
    const bo = checkMasterPromptContent('T6', ancien);
    expect(bo.ok).toBe(true);
    expect(bo.warnings.map((w) => w.code)).toContain('OPTIONAL_BRANCH_MISSING');
    expect(checkMasterPromptContent('T6', MASTER)).toMatchObject({ ok: true, warnings: [] });
    // Détection à l'exécution : version antérieure → pas d'évaluation ; fichier du dépôt → évaluation.
    configText = ancien;
    expect(await R.t6InterpellationAvailable()).toBe(false);
    configText = MASTER;
    expect(await R.t6InterpellationAvailable()).toBe(true);
    configText = null;
    expect(await R.t6InterpellationAvailable()).toBe(true);
    // Sans évaluation possible : aucune échéance proche présentée d'office, état explicite.
    expect(decide({ candidate: cand({ dueDate: '2026-11-04' }), aiCapable: false })).toMatchObject({ decision: 'DEFER', code: 'EVALUATION_UNAVAILABLE' });
  });
});
