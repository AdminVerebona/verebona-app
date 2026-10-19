/**
 * Lot 71E — ticket « BUG P1 — T4 v2/v3 : fiabiliser les décisions Agenda,
 * sécuriser les réanalyses et corriger les écarts résiduels ». Tests
 * unitaires (modèle simulé, aucune base) ; les scénarios PG16 du tableau §3
 * sont dans `src/test/e2e/scenarios/l71-t4-fiabilisation.e2e.ts`
 * (`npm run test:e2e:t4`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { T4EventDecision, ClassifyEventContext } from '../master/classify-event';

vi.mock('../master/t4-decision-trace', async (orig) => ({
  ...(await orig<typeof import('../master/t4-decision-trace')>()),
  attachT4DecisionToTrace: vi.fn(async () => true),
}));

const { processAgendaCandidates, appliedBusinessType, storableT4Decision } = await import('../agenda-intelligence.service');
const { translateEventDecision, translateClassifyEvent, failedEventDecision } = await import('../master/classify-event');
const { T4ClassifyEventV2Output, T4ClassifyEventOutput } = await import('../master/t4-contract');
const { planSourceSync, computeAgendaFunctionalKey } = await import('@/services/agenda/agenda-functional-key');
const { runT4Job, T4IncompleteJobError, t4JobCounters } = await import('../index');
const { NO_GUARD } = await import('../../queue/execution-control');
const { t4OutcomeOf } = await import('@/services/agenda/agenda-persistence');
const { t4ContractLimitationNotice } = await import('@/app/admin/ai-executions/_components/RuntimeContractPanel');
const { t4AutomaticDecisionLimitation } = await import('@/app/admin/ai-config/_components/MasterPromptExecutionPanel');

const TODAY = '2026-10-19';
type Dec = { agenda: 'accept' | 'reject' | 'abstain'; category?: 'action' | 'information'; businessType?: string | null; recurrence?: 'accept' | 'reject' | 'abstain' };

/** T4 simulé (sortie v2 réelle passée par la traduction de production). */
function t4(d: Dec | ((title: string) => Dec | 'fail')) {
  const decide = vi.fn(async (i: { title: string }, ctx: ClassifyEventContext): Promise<T4EventDecision> => {
    const x = typeof d === 'function' ? d(i.title) : d;
    if (x === 'fail') return failedEventDecision(Boolean(ctx.recurrenceCandidate), { code: 'ALL_MODELS_FAILED', message: 'panne' }, 'trace-panne');
    const out = T4ClassifyEventV2Output.parse({
      task: 'CLASSIFY_EVENT', agendaDecision: x.agenda,
      recurrenceDecision: ctx.recurrenceCandidate ? x.recurrence ?? 'abstain' : 'not_applicable',
      homeCategory: x.agenda === 'accept' ? x.category ?? 'action' : 'unknown',
      businessType: x.agenda === 'accept' ? x.businessType ?? null : null,
      confidence: x.agenda === 'abstain' ? 'ambiguous' : 'certain', reason: 'simulé',
      recurrenceReason: ctx.recurrenceCandidate ? 'simulé' : null,
    });
    return { ...translateEventDecision(out, Boolean(ctx.recurrenceCandidate)), traceId: `trace-${i.title}` };
  });
  return decide;
}
const run = (candidates: unknown[], decide: unknown, existing: unknown[] = [], extra: Record<string, unknown> = {}) => processAgendaCandidates({
  accountId: 1, assetId: 3, sourceFileId: 40, today: TODAY, existing: existing as never, candidates: candidates as never, decide: decide as never, ...extra,
});
const cand = (title: string, date: string, extra: Record<string, unknown> = {}) => ({
  title, date, confidence: 'certain', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true, excerpt: `${title} ${date}`, ...extra,
});

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('§A — reject / abstain / technical_failure distincts jusqu’à la persistance', () => {
  it('T4-FIX-01/02/03 — motifs distincts, issue T4 lue par la persistance', async () => {
    const d = await run([cand('Alpha', '2027-03-01'), cand('Beta', '2027-04-01'), cand('Gamma', '2027-05-01')],
      t4((t) => (t === 'Alpha' ? { agenda: 'reject' } : t === 'Beta' ? { agenda: 'abstain' } : 'fail')));
    expect(d.map((x) => [x.action, x.reasonCode, x.t4?.verdict])).toEqual([
      ['ignore', 'MODEL_REJECTED_NOT_AGENDA', 'EVENT_REJECTED'],
      ['ignore', 'MODEL_ABSTAINED', 'ABSTAINED'],
      ['ignore', 'T4_TECHNICAL_FAILURE', 'TECHNICAL_FAILURE'],
    ]);
    expect(d.map((x) => t4OutcomeOf(x))).toEqual(['reject', 'abstain', 'technical_failure']);
    // Échec technique : la trace de l'exécution en échec est conservée (rattachement BO).
    expect(d[2].t4).toMatchObject({ traceId: 'trace-panne', errorCode: 'ALL_MODELS_FAILED', contractVersion: null });
    // Motif inconnu d'un `ignore` : indéterminé, jamais un retrait.
    expect(t4OutcomeOf({ action: 'ignore', reasonCode: 'AUTRE' })).toBe('abstain');
    expect(t4OutcomeOf({ action: 'create', reasonCode: 'X' })).toBeNull();
  });

  const item = (o: Partial<import('@/services/agenda/agenda-functional-key').SourceItem>) => ({
    id: 1, functionalKey: null, title: 'Alpha', startDate: '2027-03-01', originFieldKey: null,
    isAutomatic: true, isAutomaticModified: false, manualStatus: null, ...o,
  });
  const cle = (title: string, date: string, businessType: string | null = null) => computeAgendaFunctionalKey({
    sourceFileId: 40, target: { type: 'ASSET', id: 3 }, businessType, originFieldKey: null, occurrence: date,
  });

  it('T4-FIX-02/04 — abstention ou échec : élément rapproché conservé, indécision comptée (aucun retrait global) ; candidat accepté mis à jour', () => {
    const plan = planSourceSync({
      sourceFileId: 40, assetId: 3,
      items: [item({ id: 1, functionalKey: cle('Alpha', '2027-03-01') }), item({ id: 2, title: 'Beta', startDate: '2027-04-01', functionalKey: cle('Beta', '2027-04-01') }), item({ id: 9, title: 'Ancien', startDate: '2027-09-01', functionalKey: 'zzz' })],
      decisions: [
        { index: 0, action: 'create', title: 'Alpha', date: '2027-03-01', sourceFileId: 40 },
        { index: 1, action: 'ignore', title: 'Beta', date: '2027-04-01', sourceFileId: 40, t4Outcome: 'abstain' },
      ],
    });
    expect(plan.steps).toMatchObject([{ kind: 'update', itemId: 1 }]);
    expect(plan.keep).toEqual(expect.arrayContaining([1, 2]));
    expect(plan.undetermined).toBe(1);
    expect(plan.targetedRemove).toEqual([]);
    // L'élément 9 (plus produit) ne serait retiré que par un retrait GLOBAL — bloqué par la persistance (indécision).
    expect(plan.remove).toEqual([9]);
  });

  it('T4-FIX-03 — rejet explicite : retrait CIBLÉ seulement avec rapprochement fiable, jamais un élément touché', () => {
    const plan = planSourceSync({
      sourceFileId: 40, assetId: 3,
      items: [
        item({ id: 1, functionalKey: cle('Alpha', '2027-03-01') }),
        item({ id: 2, title: 'Beta', startDate: '2027-04-01', functionalKey: cle('Beta', '2027-04-01'), isAutomaticModified: true }),
        item({ id: 3, title: 'Sans rapport', startDate: '2027-05-01', functionalKey: 'autre' }),
      ],
      decisions: [
        { index: 0, action: 'ignore', title: 'Alpha', date: '2027-03-01', sourceFileId: 40, t4Outcome: 'reject' },
        { index: 1, action: 'ignore', title: 'Beta', date: '2027-04-01', sourceFileId: 40, t4Outcome: 'reject' },
        { index: 2, action: 'ignore', title: 'Inconnu', date: '2027-06-01', sourceFileId: 40, t4Outcome: 'reject' },
      ],
    });
    expect(plan.targetedRemove).toEqual([1]);
    expect(plan.undetermined).toBe(0);
  });
});

describe('§B — businessType décidé par T4 propagé', () => {
  it('T4-FIX-07 — valeur T4 de référence ; null explicite : candidat conservé et SIGNALÉ ; hors catalogue : ignoré', () => {
    const accept = (bt: string | null) => ({ agendaDecision: 'accept' as const, outcome: 'model_v2' as const, classification: { category: 'action' as const, confidence: 'certain' as const, source: 'model' as const, businessType: bt } });
    expect(appliedBusinessType({ businessType: 'contract' }, accept('insurance'))).toMatchObject({ value: 'insurance', applied: 'insurance', source: 'T4', warnings: [] });
    expect(appliedBusinessType({ businessType: 'contract' }, accept(null))).toMatchObject({ value: 'contract', source: 'CANDIDATE', warnings: ['T4_BUSINESS_TYPE_NULL'] });
    expect(appliedBusinessType({ businessType: null, originFieldKey: 'warrantyEndDate' }, accept(null))).toMatchObject({ value: null, applied: 'warranty', source: 'CANDIDATE' });
    expect(appliedBusinessType({ businessType: null }, accept(null))).toMatchObject({ value: null, applied: null, source: 'NONE' });
    expect(appliedBusinessType({ businessType: 'licorne' }, accept(null)).warnings).toEqual(['CANDIDATE_BUSINESS_TYPE_OUT_OF_CATALOG:licorne', 'T4_BUSINESS_TYPE_NULL']);
    // Valeur hors catalogue rendue par le modèle : ramenée à null par le monde fermé, jamais appliquée.
    const out = T4ClassifyEventV2Output.parse({ task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'action', businessType: 'licorne', confidence: 'certain', reason: 'r' });
    expect(translateEventDecision(out, false).classification.businessType).toBeNull();
  });

  it('T4-FIX-07 — décision, occurrences récurrentes et trace portent le type T4', async () => {
    const { parseRecurrenceFr } = await import('../rules/recurrence');
    const excerpt = 'Entretien chaudière à réaliser tous les 12 mois';
    const d = await run([{ ...cand('Entretien chaudière', '2026-11-15', { businessType: 'repair' }), excerpt, documentType: 'RAPPORT_ENTRETIEN', recurrence: parseRecurrenceFr(excerpt) }],
      t4({ agenda: 'accept', businessType: 'maintenance', recurrence: 'accept' }));
    expect(d.filter((x) => x.action === 'create').map((x) => x.businessType)).toEqual(['maintenance', 'maintenance']);
    expect(d[0].t4).toMatchObject({ businessType: 'maintenance', businessTypeSource: 'T4' });
  });

  it('T4-FIX-07 — reclassement : élément dont la clé n’est plus produite ADOPTÉ (même identifiant), pas recréé ni retiré', () => {
    const ancienne = computeAgendaFunctionalKey({ sourceFileId: 40, target: { type: 'ASSET', id: 3 }, businessType: 'insurance', originFieldKey: null, occurrence: '2027-03-01' });
    const plan = planSourceSync({
      sourceFileId: 40, assetId: 3,
      items: [{ id: 7, functionalKey: ancienne, title: 'Échéance Alpha', startDate: '2027-03-01', originFieldKey: null, isAutomatic: true, isAutomaticModified: false, manualStatus: null }],
      decisions: [{ index: 0, action: 'create', title: 'Echeance alpha', date: '2027-03-01', sourceFileId: 40, businessType: 'warranty' }],
    });
    expect(plan.steps).toMatchObject([{ kind: 'update', itemId: 7, adopted: true }]);
    expect(plan.remove).toEqual([]);
    // Intitulé différent sans champ d'origine : pas de rapprochement fiable → création, l'ancien n'est pas adopté.
    const autre = planSourceSync({
      sourceFileId: 40, assetId: 3,
      items: [{ id: 7, functionalKey: ancienne, title: 'Échéance Alpha', startDate: '2027-03-01', originFieldKey: null, isAutomatic: true, isAutomaticModified: false, manualStatus: null }],
      decisions: [{ index: 0, action: 'create', title: 'Autre chose', date: '2027-03-01', sourceFileId: 40, businessType: 'warranty' }],
    });
    expect(autre.steps).toMatchObject([{ kind: 'create' }]);
  });
});

describe('§C — doublon exact : correction de classification', () => {
  const existant = (o: Record<string, unknown> = {}) => ({ id: 12, title: 'Alpha', date: '2027-03-01', category: 'action', status: null, manual: false, originFieldKey: null, ...o });
  it('T4-FIX-08 — décision fiable sur un automatique intact : correction portée par skip_duplicate (même identifiant)', async () => {
    const [d] = await run([cand('Alpha', '2027-03-01')], t4({ agenda: 'accept', category: 'information', businessType: 'contract' }), [existant()]);
    expect(d).toMatchObject({ action: 'skip_duplicate', existingItemId: 12, category: 'action', classificationCorrection: { category: 'information', businessType: 'contract' } });
  });
  it('T4-FIX-09 — événement manuel ou modifié : aucune correction', async () => {
    const [d] = await run([cand('Alpha', '2027-03-01')], t4({ agenda: 'accept', category: 'information' }), [existant({ manual: true })]);
    expect(d.action).toBe('skip_duplicate');
    expect(d.classificationCorrection).toBeUndefined();
  });
  it('décision non fiable (abstention) : aucune correction ni décision créatrice', async () => {
    const [d] = await run([cand('Alpha', '2027-03-01')], t4({ agenda: 'abstain' }), [existant()]);
    expect(d.action).toBe('ignore');
    expect(d.classificationCorrection).toBeUndefined();
  });
});

describe('§D — t4_output_v1 : plus d’acceptation implicite', () => {
  it('T4-FIX-10 — flux automatique : abstention conservatrice, catégorie tracée ; parcours manuel inchangé', async () => {
    const v1 = T4ClassifyEventOutput.parse({ task: 'CLASSIFY_EVENT', homeCategory: 'action', confidence: 'certain', reason: 'v1' });
    expect(translateEventDecision(v1, true)).toMatchObject({
      agendaDecision: 'abstain', recurrenceDecision: 'abstain', outcome: 'model_v1', contractVersion: 1,
      warnings: ['T4_OUTPUT_V1_NO_AGENDA_DECISION', 'T4_OUTPUT_V1_NO_RECURRENCE_DECISION'], classification: { category: 'action' },
    });
    // Parcours manuel : la catégorie v1 reste lue (classifyEventMaster).
    expect(translateClassifyEvent(v1).classification.category).toBe('action');
    // Moteur : aucune création, verdict ABSTAINED.
    const decide = vi.fn(async () => ({ ...translateEventDecision(v1, false), traceId: 't' }));
    const [d] = await run([cand('Alpha', '2027-03-01')], decide);
    expect(d).toMatchObject({ action: 'ignore', reasonCode: 'MODEL_ABSTAINED', t4: { verdict: 'ABSTAINED', outcome: 'model_v1' } });
  });
  it('BO — indication explicite quand le contrat actif ne permet pas les décisions automatiques', () => {
    expect(t4ContractLimitationNotice({ outputContractVersion: 't4_output_v1' })).toMatch(/t4_output_v1/);
    expect(t4ContractLimitationNotice({ outcome: 'model_v1' })).toMatch(/abstention conservatrice/);
    expect(t4ContractLimitationNotice({ outputContractVersion: 't4_output_v3', outcome: 'model_v2' })).toBeNull();
    const base = { inputContractVersion: 't4_input_v2', allowedTasks: null };
    expect(t4AutomaticDecisionLimitation('T4', { mode: 'STRUCTURED_CONTEXT', outputContractVersion: 't4_output_v1', ...base })).toMatch(/t4_output_v1/);
    expect(t4AutomaticDecisionLimitation('T4', { mode: 'LEGACY_TEMPLATE', outputContractVersion: null, ...base })).toMatch(/s’abstient/);
    expect(t4AutomaticDecisionLimitation('T4', { mode: 'STRUCTURED_CONTEXT', outputContractVersion: 't4_output_v3', ...base })).toBeNull();
    expect(t4AutomaticDecisionLimitation('T1', { mode: 'LEGACY_TEMPLATE', outputContractVersion: null, ...base })).toBeNull();
  });
});

describe('§E — traçabilité et reprise', () => {
  const job = (payload: Record<string, unknown>, id = 77) => ({
    id, treatment: 'T4', accountId: 5, targetType: 'asset_file', targetId: '40', status: 'RUNNING', origin: 'automatic',
    triggerCode: 'source_analyzed', attempts: 2, lastError: null, availableAt: new Date(), coalesceRequested: false,
    headPriority: false, createdAt: new Date(), startedAt: new Date(), finishedAt: null, payload, executionId: 'e-1',
    workerId: null, leaseExpiresAt: null, recoveredCount: 0, configVersionId: null,
  }) as never;
  const payload = { assetId: 3, userId: 1, leadSourceId: 40, analysisComplete: true, candidates: [cand('Alpha', '2027-03-01'), cand('Beta', '2027-04-01')] };

  it('T4-FIX-11 — échec technique : décisions valides écrites, contexte de reprise (décisions appliquées seulement), erreur ordinaire (temporisation, MAX_ATTEMPTS)', async () => {
    const decide = t4((t) => (t === 'Alpha' ? { agenda: 'accept' } : 'fail'));
    const persist = vi.fn(async () => ({ writeFailures: 0, undetermined: 1, removal: 'TARGETED_ONLY' as const, removed: [], corrected: 0 }));
    const savePayload = vi.fn(async () => true);
    const err = await runT4Job(job(payload), NO_GUARD, {
      loadExisting: async () => [], persist, savePayload,
      process: (i) => processAgendaCandidates({ ...i, today: TODAY, decide: decide as never }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(T4IncompleteJobError);
    expect(err.code).toBe('T4_INCOMPLETE');
    expect(err.code).not.toBe('PERMANENT_JOB_ERROR');
    expect(persist).toHaveBeenCalledTimes(1);
    const [[jobId, exec, patch]] = savePayload.mock.calls as unknown as [[number, string, { t4Resolved: { forJob: number; decisions: Record<string, unknown> }; t4Retry: Record<string, unknown> }]];
    expect([jobId, exec]).toEqual([77, 'e-1']);
    expect(patch.t4Resolved.forJob).toBe(77);
    expect(Object.values(patch.t4Resolved.decisions)).toMatchObject([{ agendaDecision: 'accept', outcome: 'model_v2' }]);
    expect(patch.t4Retry).toMatchObject({ accepted: 1, technicalFailures: 1 });
    // Aucun contenu documentaire brut dans le contexte de reprise.
    expect(JSON.stringify(patch)).not.toContain('Alpha 2027-03-01');
  });

  it('T4-FIX-11/12 — reprise : décisions appliquées réutilisées SANS appel modèle ; autre travail : jamais réutilisées', async () => {
    // Passage 1 : Alpha décidée, Beta en panne.
    const p1 = t4((t) => (t === 'Alpha' ? { agenda: 'accept' } : 'fail'));
    let conserve: Record<string, unknown> = {};
    const deps = (decide: unknown) => ({
      loadExisting: async () => [], persist: vi.fn(async () => ({ writeFailures: 0, undetermined: 0, removal: 'GLOBAL' as const, removed: [], corrected: 0 })),
      savePayload: vi.fn(async (_j: number, _e: string | null, patch: Record<string, unknown>) => { conserve = patch; return true; }),
      process: (i: Parameters<typeof processAgendaCandidates>[0]) => processAgendaCandidates({ ...i, today: TODAY, decide: decide as never }),
    });
    await runT4Job(job(payload), NO_GUARD, deps(p1)).catch(() => null);
    // Passage 2 (même travail) : seule Beta est redemandée.
    const p2 = t4({ agenda: 'accept' });
    const r = await runT4Job(job({ ...payload, ...conserve }), NO_GUARD, deps(p2));
    expect(p2.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['Beta']);
    expect(r).toMatchObject({ result: 'APPLIED', detail: { accepted: 2, reused: 1, technicalFailures: 0 } });
    // Coalescence / nouveau travail (autre identifiant) : tout est redemandé.
    const p3 = t4({ agenda: 'accept' });
    await runT4Job(job({ ...payload, ...conserve }, 78), NO_GUARD, deps(p3));
    expect(p3).toHaveBeenCalledTimes(2);
  });

  it('T4-FIX-05 — écriture en échec : travail non réussi (T4_PERSIST_PARTIAL), reprise demandée', async () => {
    const err = await runT4Job(job(payload), NO_GUARD, {
      loadExisting: async () => [], savePayload: async () => true,
      persist: async () => ({ writeFailures: 1, undetermined: 0, removal: 'BLOCKED_WRITE_FAILURE' as const, removed: [], corrected: 0 }),
      process: (i) => processAgendaCandidates({ ...i, today: TODAY, decide: t4({ agenda: 'accept' }) as never }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(T4IncompleteJobError);
    expect(err.code).toBe('T4_PERSIST_PARTIAL');
  });

  it('résultat métier : abstention → ABSTAIN, compteurs par verdict ; échec technique jamais conservé pour reprise', async () => {
    const d = await run([cand('Alpha', '2027-03-01'), cand('Beta', '2027-04-01')], t4((t) => (t === 'Alpha' ? { agenda: 'reject' } : { agenda: 'abstain' })));
    expect(t4JobCounters(d)).toMatchObject({ candidates: 2, eventRejected: 1, abstained: 1, technicalFailures: 0 });
    const r = await runT4Job(job(payload), NO_GUARD, {
      loadExisting: async () => [], persist: async () => ({ writeFailures: 0, undetermined: 1, removal: 'TARGETED_ONLY' as const, removed: [], corrected: 0 }),
      process: (i) => processAgendaCandidates({ ...i, today: TODAY, decide: t4({ agenda: 'abstain' }) as never }),
    });
    expect(r).toMatchObject({ result: 'ABSTAIN', detail: { abstained: 2, removal: 'TARGETED_ONLY' } });
    expect(storableT4Decision(failedEventDecision(false, { code: 'X', message: 'm' }))).toBeNull();
  });

  it('réanalyse répétée, mêmes décisions : empreinte de contexte stable (idempotence de la reprise)', async () => {
    const a = await run([cand('Alpha', '2027-03-01')], t4({ agenda: 'accept' }));
    const b = await run([cand('Alpha', '2027-03-01')], t4({ agenda: 'accept' }));
    expect(a[0].t4?.fingerprint).toBeTruthy();
    expect(a[0].t4?.fingerprint).toBe(b[0].t4?.fingerprint);
    const c = await run([cand('Alpha', '2027-03-02')], t4({ agenda: 'accept' }));
    expect(c[0].t4?.fingerprint).not.toBe(a[0].t4?.fingerprint);
  });
});
