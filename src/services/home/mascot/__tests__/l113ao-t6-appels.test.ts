/**
 * Lot 113AO — Trello #748 « [P1][Pré-MEP] T6 — Supprimer les appels Gemini
 * inutiles et fiabiliser l'attribution, l'idempotence et les erreurs » :
 * tests UNITAIRES (aucune base, fournisseur simulé). Les mêmes critères sont
 * prouvés sur PostgreSQL 16 réel par `src/test/e2e/scenarios/l113ao-t6-appels.e2e.ts`.
 *
 *  A  besoin rédactionnel qualifié par le serveur (transversal), recomposition
 *     des sujets mixtes dans l'ordre, interrupteur d'exploitation ;
 *  B  attribution : un appel T6 n'appartient jamais à l'exécution T1 dont il
 *     hérite le contexte ; déclencheur conservé comme lien de causalité ;
 *  D  cause primaire des échecs (troncature, 403, indisponibilité, contrat,
 *     transport) ; fractionnement d'une sortie EVALUATE tronquée sans
 *     supprimer de candidat ; relance seulement quand elle a un sens.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: null, configVersionId: 3 }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));

const W = await import('../t6-wording-need');
const F = await import('../t6-failure');
const R = await import('../t6-runner');
const X = await import('@/services/ai/business-execution/context');
const J = await import('@/services/ai/queue/job-context');
const { inT6Execution } = await import('../t6-execution-scope');
const { AiGatewayError, AiCostCapReachedError } = await import('@/services/ai/gateway/errors');
type Subject = import('../types').MascotSubject;

// ── Fabriques ────────────────────────────────────────────────────────────────

const sujet = (o: Partial<Subject> = {}): Subject => ({
  subjectId: 'PROC-DOC-ANALYSIS:386', sourceFamily: 'PROCESSING', sourceCode: 'PROC-DOC-ANALYSIS', accountId: 7,
  priority: null, requiresAttention: false, intent: 'inform',
  facts: { documentTitle: 'Facture chaudière', documentCount: 1, state: 'analyse' },
  actions: [], fallbackText: 'Le document « Facture chaudière » est en cours d’analyse.', allowedHighlight: 'Facture chaudière',
  occurrenceKey: 'PROC-DOC-ANALYSIS:386', dedupeKeys: ['document:386'], secondaryLabel: 'Facture chaudière', ...o,
});
const echeance = (o: Partial<Subject> = {}): Subject => sujet({
  subjectId: 'DATE-NEXT:12', sourceFamily: 'DATE', sourceCode: 'DATE-NEXT', intent: 'deadline', requiresAttention: true,
  facts: { title: 'Contrôle technique', date: '2026-12-01', dateLabel: '1er décembre 2026', dateNature: 'confirmée', assetName: 'Clio', dateRole: 'DEADLINE', interpellation: 'à traiter maintenant' },
  fallbackText: 'Le contrôle technique de Clio est à prévoir pour le 1er décembre 2026.', allowedHighlight: '1er décembre 2026',
  occurrenceKey: 'DATE-NEXT:12', dedupeKeys: ['agenda:12'], secondaryLabel: 'Contrôle technique', ...o,
});

// ── A : besoin rédactionnel ──────────────────────────────────────────────────

describe('A — appels FORMULATE sans valeur évités en amont de la passerelle', () => {
  it('AC01/AC02 — document(s) en cours d’analyse : texte fiable entièrement calculé → DÉTERMINISTE (aucun appel)', () => {
    expect(W.t6WordingNeed(sujet(), 'info', {})).toEqual({ need: 'DETERMINISTIC', reason: 'state_information' });
    const plusieurs = sujet({ facts: { documentTitle: 'Facture chaudière', documentCount: 3, state: 'analyse' }, fallbackText: '3 documents sont en cours d’analyse, dont « Facture chaudière ».' });
    expect(W.t6WordingNeed(plusieurs, 'info', {}).need).toBe('DETERMINISTIC');
  });

  it('AC03 — échéance à texte déterministe vérifié (rappel informatif, sans attention) → DÉTERMINISTE ; date et ancrage conservés', () => {
    const info = echeance({ requiresAttention: false, intent: 'inform', facts: { ...echeance().facts, interpellation: 'rappel informatif' }, fallbackText: 'Pour information, le contrôle technique de Clio est prévu le 1er décembre 2026.' });
    expect(W.t6WordingNeed(info, 'info', {}).need).toBe('DETERMINISTIC');
    expect(W.deterministicMessage(info)).toEqual({ subjectId: 'DATE-NEXT:12', text: info.fallbackText, highlight: '1er décembre 2026' });
  });

  it('AC04 — sujet nécessitant une reformulation contextualisée : CONTEXTUEL (attention, action, accompagnement, démarche attendue)', () => {
    expect(W.t6WordingNeed(echeance(), 'action', {})).toEqual({ need: 'CONTEXTUAL', reason: 'attention_required' });
    expect(W.t6WordingNeed(sujet({ intent: 'act' }), 'action', {}).reason).toBe('guidance_intent');
    expect(W.t6WordingNeed(sujet({ intent: 'onboard' }), 'info', {}).reason).toBe('guidance_intent');
    expect(W.t6WordingNeed(sujet({ facts: { ...sujet().facts, expectedAction: 'Prendre rendez-vous' } }), 'info', {}).reason).toBe('expected_action');
  });

  it('A2 — critère transversal : un texte déterministe NON fiable (date relative, comptage, longueur) reste confié à T6 ; aucun code ni phrase codés en dur', () => {
    expect(W.t6WordingNeed(sujet({ fallbackText: 'Le document « Facture chaudière » sera analysé demain.' }), 'info', {}).reason).toBe('unreliable_fallback');
    expect(W.t6WordingNeed(sujet({ fallbackText: 'Court.' }), 'info', {}).reason).toBe('unreliable_fallback');
    // Même nature, autre code de signal (export en préparation) : même qualification.
    const exp = sujet({ subjectId: 'PROC-EXPORT:4', sourceCode: 'PROC-EXPORT', facts: { exportLabel: 'Dossier vente', assetName: 'Maison' }, fallbackText: 'L’export « Dossier vente » de Maison est en cours de préparation.', allowedHighlight: null });
    expect(W.t6WordingNeed(exp, 'info', {}).need).toBe('DETERMINISTIC');
    // Le module ne contient aucune liste de codes de signal.
    const src = readFileSync(join(process.cwd(), 'src/services/home/mascot/t6-wording-need.ts'), 'utf8');
    expect(src).not.toMatch(/PROC-DOC|DATE-NEXT|ONB-|ATP-|MASC-/);
  });

  it('A — interrupteur MASCOT_T6_DETERMINISTIC_BYPASS=off : retour au comportement antérieur (tout sujet confié à T6)', () => {
    expect(W.t6WordingNeed(sujet(), 'info', { MASCOT_T6_DETERMINISTIC_BYPASS: 'off' })).toEqual({ need: 'CONTEXTUAL', reason: 'bypass_disabled' });
    expect(W.t6DeterministicBypassEnabled({})).toBe(true);
  });

  it('AC05 — 2 sujets dont un déterministe : seul le sujet contextuel part à FORMULATE ; bulle recomposée à 2 sujets, ordre et ancrages stables', () => {
    const subjects = [sujet(), echeance()];
    const plan = W.planT6Formulation(subjects, ['info', 'action'], {});
    expect(plan).toMatchObject({ formulate: [1], deterministic: [0] });
    const t6 = [{ subjectId: 'DATE-NEXT:12', text: 'Pensez au contrôle technique de Clio, prévu pour le 1er décembre 2026.', highlight: '1er décembre 2026' }];
    const m = W.recomposeT6Messages(subjects, plan, t6)!;
    expect(m.map((x) => x.subjectId)).toEqual(['PROC-DOC-ANALYSIS:386', 'DATE-NEXT:12']);
    expect(m[0]).toEqual({ subjectId: 'PROC-DOC-ANALYSIS:386', text: subjects[0].fallbackText, highlight: 'Facture chaudière' });
    expect(m[1]).toEqual(t6[0]);
    // T6 n'a rien rendu : secours complet (comportement antérieur), jamais une bulle partielle.
    expect(W.recomposeT6Messages(subjects, plan, null)).toBeNull();
    // Sortie désaccordée (identifiant) : le sujet garde son texte déterministe, aucune perte.
    expect(W.recomposeT6Messages(subjects, plan, [{ subjectId: 'AUTRE', text: 'x', highlight: null }])![1].text).toBe(subjects[1].fallbackText);
    // R8 entre sujets : un texte T6 qui répète le texte déterministe reprend son secours.
    const repete = [{ subjectId: 'DATE-NEXT:12', text: subjects[0].fallbackText, highlight: null }];
    expect(W.recomposeT6Messages(subjects, plan, repete)![1].text).toBe(subjects[1].fallbackText);
  });

  it('A — clé de mesure déterministe distincte des clés du cache T6, stable pour un même contexte', () => {
    const k = W.deterministicKeyOf(7, [sujet()]);
    expect(k).toMatch(/^det:[0-9a-f]{64}$/);
    expect(W.deterministicKeyOf(7, [sujet()])).toBe(k);
    expect(W.deterministicKeyOf(8, [sujet()])).not.toBe(k);
  });
});

// ── AC15 : jeu représentatif (composition de l'export 54dc3fd1…, sans contenu) ──

describe('AC15 — jeu représentatif avant / après (12 formulations de l’export du 12/11)', () => {
  it('9 bulles « document en analyse » seules, 1 bulle mixte, 2 échéances à traiter : 12 appels avant → 3 après, 9 évités', () => {
    const doc = (n: number, i: number) => sujet({
      subjectId: `PROC-DOC-ANALYSIS:${380 + i}`, facts: { documentTitle: `Document ${i}`, documentCount: n, state: 'analyse' },
      fallbackText: n === 1 ? `Le document « Document ${i} » est en cours d’analyse.` : `${n} documents sont en cours d’analyse, dont « Document ${i} ».`,
      allowedHighlight: `Document ${i}`,
    });
    const bulles: Array<{ subjects: Subject[]; kinds: Array<'info' | 'action'> }> = [
      ...[1, 1, 2, 2, 3, 2, 1, 1, 1].map((n, i) => ({ subjects: [doc(n, i)], kinds: ['info' as const] })),
      { subjects: [doc(1, 9), echeance()], kinds: ['info', 'action'] },
      { subjects: [echeance({ subjectId: 'DATE-NEXT:20' })], kinds: ['action'] },
      { subjects: [echeance({ subjectId: 'DATE-NEXT:21' })], kinds: ['action'] },
    ];
    const avant = bulles.length;
    const plans = bulles.map((b) => W.planT6Formulation(b.subjects, b.kinds, {}));
    const apres = plans.filter((p) => p.formulate.length > 0).length;
    const sujetsEnvoyes = plans.reduce((a, p) => a + p.formulate.length, 0);
    expect({ avant, apres, evites: avant - apres, sujetsEnvoyes }).toEqual({ avant: 12, apres: 3, evites: 9, sujetsEnvoyes: 3 });
    // Chaque bulle garde tous ses sujets (aucune perte), dans l'ordre.
    bulles.forEach((b, i) => {
      const m = W.recomposeT6Messages(b.subjects, plans[i], plans[i].formulate.map((j) => W.deterministicMessage(b.subjects[j])));
      expect(m!.map((x) => x.subjectId)).toEqual(b.subjects.map((x) => x.subjectId));
    });
  });
});

// ── B : attribution ──────────────────────────────────────────────────────────

describe('B — un appel T6 appartient à une exécution T6, jamais à l’exécution T1 qui l’a provoqué', () => {
  it('AC06 — contexte hérité d’un travail T1 : t6_formulate → T6F:<trace>, T1 conservé comme déclencheur ; un appel T1 reste T1', async () => {
    await J.runInJobContext({ jobId: 3575, treatment: 'T1', configVersionId: null, businessExecutionId: 'T1:job:3575' }, async () => {
      expect(X.businessExecutionOfCall({ operationCode: 't6_formulate', traceId: '7084ff42' })).toEqual({ id: 'T6F:7084ff42', ids: [], causedBy: 'T1:job:3575' });
      expect(X.businessExecutionOfCall({ operationCode: 't6_evaluate', traceId: 'x' })).toEqual({ id: null, ids: [], causedBy: 'T1:job:3575' });
      expect(X.businessExecutionOfCall({ operationCode: 't1_analyze_document', traceId: 'x' })).toEqual({ id: 'T1:job:3575', ids: [] });
    });
  });

  it('AC06 — portée T6 : hors du job (ni job, ni tentative, ni configuration héritée), déclencheur mémorisé ; EVALUATE garde ses T6E', async () => {
    await J.runInJobContext({ jobId: 3575, treatment: 'T1', configVersionId: 9, businessExecutionId: 'T1:job:3575', triggerCode: 'UPLOAD' }, async () => {
      await inT6Execution(async () => {
        expect(J.currentJobContext()).toBeNull();
        expect(X.currentBusinessExecutionIds()).toEqual([]);
        expect(X.currentCausalExecutionId()).toBe('T1:job:3575');
        await X.runInBusinessExecution(['T6E:1:5', 'T6E:2:5'], async () => {
          expect(X.businessExecutionOfCall({ operationCode: 't6_evaluate', traceId: 'x' })).toEqual({ id: null, ids: ['T6E:1:5', 'T6E:2:5'], causedBy: 'T1:job:3575' });
        });
        await X.runInBusinessExecution('T6E:1:5', async () => {
          expect(X.businessExecutionOfCall({ operationCode: 't6_evaluate', traceId: 'x' })).toMatchObject({ id: 'T6E:1:5' });
        });
      });
    });
    // Sans déclencheur : aucun lien inventé.
    await inT6Execution(async () => {
      expect(X.businessExecutionOfCall({ operationCode: 't6_formulate', traceId: 't' })).toEqual({ id: 'T6F:t', ids: [] });
    });
  });

  it('AC06 — formulateWithT6 appelé DANS un travail T1 : la passerelle ne voit ni le job T1 ni son exécution', async () => {
    let vu: { job: unknown; ids: string[]; cause: string | null } | null = null;
    const input = { schemaVersion: 't6-input-v1' as const, language: 'fr' as const, subjects: [{ subjectId: 'S', sourceCode: 'X', intent: 'act' as const, facts: { title: 'CT' }, fallbackText: 'Le CT de Clio est à organiser bientôt.', allowedHighlight: null }] };
    await J.runInJobContext({ jobId: 3575, treatment: 'T1', configVersionId: null, businessExecutionId: 'T1:job:3575' }, async () => {
      await R.formulateWithT6({ accountId: 7, input, contextHash: 'h', mode: 'pregen' }, {
        treatmentAvailable: async () => true, promptVersion: async () => 'v1', previousBubbles: async () => [], reservations: null,
        execute: (async () => {
          vu = { job: J.currentJobContext(), ids: X.currentBusinessExecutionIds(), cause: X.currentCausalExecutionId() };
          return { data: { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'S', text: 'Le CT de Clio est à organiser bientôt.' }] }, model: 'm', usedFallback: false, fromCache: false, costMicros: 0, traceId: 'tr' };
        }) as never,
      });
    });
    expect(vu).toEqual({ job: null, ids: [], cause: 'T1:job:3575' });
  });
});

// ── D : causes primaires ─────────────────────────────────────────────────────

const avecCause = (e: Error, cause: string | null, stats?: object) => {
  Object.defineProperty(e, 'failureCause', { value: cause });
  if (stats) Object.defineProperty(e, 'callStats', { value: stats });
  return e;
};

describe('D — EVALUATE / FORMULATE : cause primaire des échecs, jamais un faux MODEL_UNAVAILABLE', () => {
  it('AC10/AC11 — troncature, refus 403, indisponibilité, sortie invalide, contrat, transport, plafond : familles distinctes', () => {
    const tous = (m: string, cause: string | null, last?: string) => avecCause(new AiGatewayError('ALL_MODELS_FAILED', 't6_evaluate', m, { lastFailureCode: last as never }), cause, { modelsCalled: 2, networkRequests: 2 });
    expect(F.classifyT6Failure(tous('Tous les modèles ont échoué. m : Sortie tronquée (limite de génération)', 'OUTPUT_TRUNCATED', 'INVALID_OUTPUT'))).toMatchObject({ kind: 'output_truncated', retryable: false, modelsCalled: 2 });
    // Historique : détail « Sortie tronquée » sans cause figée → troncature (jamais MODEL_UNAVAILABLE).
    expect(F.classifyT6Failure(tous('Tous les modèles ont échoué. m : Sortie tronquée (limite de génération)', null, 'INVALID_OUTPUT')).kind).toBe('output_truncated');
    expect(F.classifyT6Failure(tous('Tous les modèles ont échoué. m : [403 Forbidden] PERMISSION_DENIED', 'UNKNOWN', 'PROVIDER_UNAVAILABLE')).kind).toBe('provider_refused');
    expect(F.classifyT6Failure(tous('quota', 'QUOTA')).kind).toBe('model_unavailable');
    expect(F.classifyT6Failure(tous('m : sortie invalide (schéma)', 'INVALID_OUTPUT', 'INVALID_OUTPUT')).kind).toBe('invalid_output');
    expect(F.classifyT6Failure(new AiGatewayError('MASTER_PROMPT_INVALID', 't6_evaluate', 'emplacement sans valeur')).kind).toBe('contract_invalid');
    expect(F.classifyT6Failure(new TypeError('fetch failed')).kind).toBe('transport');
    expect(F.classifyT6Failure(new AiCostCapReachedError('t6_evaluate', 7, 10, 11, new Date())).kind).toBe('cost_cap');
    expect(F.classifyT6Failure(new Error('quelque chose')).kind).toBe('unknown_error');
    expect(F.t6FailureSummary(F.classifyT6Failure(tous('x', 'OUTPUT_TRUNCATED')))).toMatch(/^OUTPUT_TRUNCATED — sortie tronquée/);
  });

  const refs = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`C${i + 1}`, { subjectKey: `agenda:${i + 1}`, agendaItemId: i + 1, fingerprint: `fp${i + 1}`, daysUntilDue: 20 }] as const));
  const echec = (kind: import('../t6-failure').T6FailureKind) => ({
    status: 'error' as const, promptVersion: 'v', accepted: [], rejected: [], persisted: 0, error: 'x',
    failure: { kind, code: null, cause: null, lastFailureCode: null, modelsCalled: 1, networkRequests: 1, message: 'x', retryable: kind !== 'output_truncated' }, failureSummary: `${kind.toUpperCase()} — …`,
  });

  it('AC10 — troncature d’un seul candidat : échec LOYAL (FAILED, output_truncated) ; plusieurs : reprise ciblée (RETRY)', () => {
    expect(R.t6RunResultsOf(echec('output_truncated'), refs(1))).toEqual([expect.objectContaining({ outcome: 'FAILED', errorKind: 'output_truncated' })]);
    expect(R.t6RunResultsOf(echec('output_truncated'), refs(2)).map((x) => x.outcome)).toEqual(['RETRY', 'RETRY']);
    expect(R.t6RunResultsOf(echec('output_truncated'), refs(2))[0].errorKind).toBe('output_truncated');
  });

  it('AC11 — refus 403 : RETRY borné (délais existants), cause provider_refused, jamais assimilé à une troncature ; plafond IA : UNAVAILABLE', () => {
    expect(R.t6RunResultsOf(echec('provider_refused'), refs(1))).toEqual([expect.objectContaining({ outcome: 'RETRY', errorKind: 'provider_refused' })]);
    expect(R.t6RunResultsOf(echec('model_unavailable'), refs(1))[0]).toMatchObject({ outcome: 'RETRY', errorKind: 'model_unavailable', detail: 'modèle indisponible' });
    expect(R.t6RunResultsOf(echec('contract_invalid'), refs(1))[0]).toMatchObject({ outcome: 'FAILED', errorKind: 'contract_invalid' });
    expect(R.t6RunResultsOf(echec('cost_cap'), refs(1))[0]).toMatchObject({ outcome: 'UNAVAILABLE', errorKind: 'cost_cap' });
  });

  it('AC10 — sortie tronquée sur 4 candidats : fractionnée (2 + 2) sans supprimer de candidat, décisions toutes enregistrées, diagnostic tracé', async () => {
    const C4 = Array.from({ length: 4 }, (_, i) => ({
      subjectId: `C${i + 1}`, title: `Échéance ${i + 1}`, description: null, assetName: 'Maison', assetCategory: 'LOGEMENT',
      dueDate: '2027-01-01', dateLabel: '1er janvier 2027', daysUntilDue: 78, dateNature: 'confirmée', dateRole: 'DEADLINE',
      overdue: false, requiresQualification: false, recurring: false, documents: [], recentlyShownDays: 0,
      evidence: [{ ref: `C${i + 1}.title`, kind: 'TITLE' }, { ref: `C${i + 1}.dueDate`, kind: 'DUE_DATE' }],
    }));
    const tailles: number[] = [];
    const persist = vi.fn(async (l: Array<{ subjectId: string }>) => ({ persisted: l.length, persistedSubjectIds: l.map((x) => x.subjectId) }));
    const bundle = { context: { schemaVersion: 't6-evaluation-input-v1' as const, today: '2026-10-15', thresholdDays: 60, candidates: C4 }, refs: refs(4), persist };
    R.resetT6EvaluationState();
    const o = await R.evaluateWithT6({ accountId: 7, bundle: bundle as never, mode: 'pregen' }, {
      available: async () => true, promptVersion: async () => 'v',
      generationSummary: async () => ({ models: ['gemini-x'], maxOutputTokens: 1024 }),
      execute: (async (req: { promptVariables: { INTERPELLATION_CONTEXT: string } }) => {
        const ctx = JSON.parse(req.promptVariables.INTERPELLATION_CONTEXT) as { candidates: Array<{ subjectId: string }> };
        tailles.push(ctx.candidates.length);
        if (ctx.candidates.length > 2) throw avecCause(new AiGatewayError('ALL_MODELS_FAILED', 't6_evaluate', 'Sortie tronquée (limite de génération)', { lastFailureCode: 'INVALID_OUTPUT' }), 'OUTPUT_TRUNCATED');
        return {
          data: { schemaVersion: 't6-evaluation-v1', decisions: ctx.candidates.map((c) => ({
            subjectId: c.subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie, aucune démarche à engager.',
            expectedAction: null, actionDeadline: null, suggestedReviewAt: null, priorityHint: null, evidenceRefs: [`${c.subjectId}.title`], uncertainties: [] })) },
          model: 'gemini-x', usedFallback: false, fromCache: false, costMicros: 1, traceId: `t${tailles.length}`,
        };
      }) as never,
    });
    expect(tailles).toEqual([4, 2, 2]);
    expect(o).toMatchObject({ status: 'generated', persisted: 4 });
    expect(o.accepted.map((d) => d.subjectId)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(o.lots).toMatchObject({ calls: 3, splits: [4], initialCandidates: 4, output: { maxOutputTokens: 1024 } });
  });

  it('AC10 — troncature persistante jusqu’à un candidat : appels bornés (T6_EVALUATE_MAX_CALLS), échec loyal, aucune boucle', async () => {
    let appels = 0;
    const C2 = ['C1', 'C2'].map((id) => ({ subjectId: id }));
    R.resetT6EvaluationState();
    const o = await R.evaluateWithT6({ accountId: 8, bundle: { context: { schemaVersion: 't6-evaluation-input-v1', today: '2026-10-15', thresholdDays: 60, candidates: C2 }, refs: refs(2), persist: async () => 0 } as never, mode: 'pregen' }, {
      available: async () => true, promptVersion: async () => 'v2', generationSummary: async () => null,
      execute: (async () => { appels += 1; throw avecCause(new AiGatewayError('ALL_MODELS_FAILED', 't6_evaluate', 'Sortie tronquée'), 'OUTPUT_TRUNCATED'); }) as never,
    });
    expect(appels).toBe(3);
    expect(appels).toBeLessThanOrEqual(R.T6_EVALUATE_MAX_CALLS);
    expect(o.status).toBe('error');
    expect(o.failure?.kind).toBe('output_truncated');
    expect(R.t6RunResultsOf(o, refs(2)).map((x) => [x.outcome, x.errorKind])).toEqual([['FAILED', 'output_truncated'], ['FAILED', 'output_truncated']]);
  });
});
