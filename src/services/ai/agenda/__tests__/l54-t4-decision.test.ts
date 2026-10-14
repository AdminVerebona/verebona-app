/**
 * Lot 54 — ticket « T4 : rendre l'IA décisionnaire de l'existence et de la
 * récurrence d'un événement Agenda ». Tests unitaires T4-V2-01 à T4-V2-09
 * (modèle simulé, aucun appel réseau). Les e2e PG16 correspondants sont dans
 * `src/test/e2e/scenarios/l54-t4-decision.e2e.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { T4EventDecision, ClassifyEventContext } from '../master/classify-event';

vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async () => null,
}));
vi.mock('../master/t4-decision-trace', async (orig) => ({
  ...(await orig<typeof import('../master/t4-decision-trace')>()),
  attachT4DecisionToTrace: vi.fn(async () => {}),
}));

const { processAgendaCandidates } = await import('../agenda-intelligence.service');
const { decideAgendaEvent, translateEventDecision, checkDecisionCoherence } = await import('../master/classify-event');
const { T4ClassifyEventV2Output, T4ClassifyEventOutput } = await import('../master/t4-contract');
const { parseRecurrenceFr } = await import('../rules/recurrence');
const { planSourceSync } = await import('@/services/agenda/agenda-functional-key');
const sc = await import('../../master-prompts/structured-context');
const { T4_EXECUTION_SPEC } = await import('../master/t4-execution-contract');
const { checkMasterPromptContent } = await import('../../master-prompts/master-prompt-checks');
const { contractVersionsOf } = await import('../../gateway/output-resolution/runtime-contract');
const { AiGateway } = await import('../../gateway/ai-gateway');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setActiveMasterPromptsForTests } = await import('../../master-prompts/master-prompt-runtime');

const FICHIER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/agenda/t4_master_v1.txt'), 'utf8');
const LEGACY = readFileSync(join(process.cwd(), 'src/services/ai/agenda/master/reference/t4_master_v1.legacy-template.txt'), 'utf8');
const TODAY = '2026-10-14';

type Dec = Pick<T4EventDecision, 'agendaDecision' | 'recurrenceDecision'> & { category?: 'action' | 'information' | 'unknown' };
/** T4 simulé : décision fixée ; enregistre le contexte reçu. */
function t4(d: Dec) {
  const recus: ClassifyEventContext[] = [];
  const decide = vi.fn(async (_i: unknown, ctx: ClassifyEventContext): Promise<T4EventDecision> => {
    recus.push(ctx);
    const out = {
      task: 'CLASSIFY_EVENT' as const, agendaDecision: d.agendaDecision, recurrenceDecision: d.recurrenceDecision,
      homeCategory: d.agendaDecision === 'accept' ? (d.category ?? 'action') : 'unknown',
      businessType: null, confidence: d.agendaDecision === 'abstain' ? 'ambiguous' as const : 'certain' as const,
      reason: 'décision simulée', recurrenceReason: ctx.recurrenceCandidate ? 'motif simulé' : null,
    };
    return translateEventDecision(T4ClassifyEventV2Output.parse(out), Boolean(ctx.recurrenceCandidate));
  });
  return { decide, recus };
}

const run = (candidates: unknown[], decide: unknown, existing: unknown[] = []) => processAgendaCandidates({
  accountId: 1, assetId: 3, sourceFileId: 40, today: TODAY, existing: existing as never, candidates: candidates as never, decide: decide as never,
});

const HOMIRIS = {
  title: 'Abonnement Homiris', date: '2026-10-31', confidence: 'certain', documentType: 'FACTURE', mayCreateAgenda: true,
  excerpt: 'Facture Homiris — abonnement mensuel — période du 01/10/2026 au 31/10/2026',
  recurrence: { mode: 'EXPLICIT_SOURCE', frequency: 'monthly', interval: 1, excerpt: 'abonnement mensuel' },
};

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); __setConfigForTests(null); __setActiveMasterPromptsForTests(null); });

describe('contrat t4_output_v2 (ticket §2)', () => {
  const ok = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'action', businessType: null, confidence: 'certain', reason: 'r' };
  it('invariants : accept ⇒ action|information ; reject/abstain ⇒ unknown + businessType null ; abstain ⇒ ambiguous', () => {
    expect(T4ClassifyEventV2Output.safeParse(ok).success).toBe(true);
    expect(T4ClassifyEventV2Output.safeParse({ ...ok, homeCategory: 'unknown' }).success).toBe(false);
    expect(T4ClassifyEventV2Output.safeParse({ ...ok, agendaDecision: 'reject' }).success).toBe(false);
    expect(T4ClassifyEventV2Output.safeParse({ ...ok, agendaDecision: 'reject', homeCategory: 'unknown', businessType: 'contract' }).success).toBe(false);
    expect(T4ClassifyEventV2Output.safeParse({ ...ok, agendaDecision: 'reject', homeCategory: 'unknown' }).success).toBe(true);
    expect(T4ClassifyEventV2Output.safeParse({ ...ok, agendaDecision: 'abstain', homeCategory: 'unknown' }).success).toBe(false);
    expect(T4ClassifyEventV2Output.safeParse({ ...ok, agendaDecision: 'abstain', homeCategory: 'unknown', confidence: 'ambiguous' }).success).toBe(true);
    // v1 inchangé : aucune décision d'existence.
    expect(T4ClassifyEventOutput.safeParse({ task: 'CLASSIFY_EVENT', homeCategory: 'action', confidence: 'certain', reason: 'r' }).success).toBe(true);
  });

  it('cohérence avec l’entrée réelle : sans candidat → not_applicable ; candidat non décidé → abstain ; refus → jamais de série', () => {
    const v = (o: Record<string, unknown>) => T4ClassifyEventV2Output.parse({ ...ok, ...o });
    expect(checkDecisionCoherence(v({ recurrenceDecision: 'accept' }), false)).toMatchObject({ recurrenceDecision: 'not_applicable', warnings: ['RECURRENCE_DECISION_WITHOUT_CANDIDATE:accept'] });
    expect(checkDecisionCoherence(v({}), true)).toMatchObject({ recurrenceDecision: 'abstain' });
    expect(checkDecisionCoherence(v({ agendaDecision: 'reject', homeCategory: 'unknown', recurrenceDecision: 'accept' }), true).recurrenceDecision).toBe('abstain');
  });
});

describe('T4-V2-01 — Homiris mensuel', () => {
  it('reject / reject : 0 événement, 0 prévision mensuelle, aucune proposition', async () => {
    const { decide, recus } = t4({ agendaDecision: 'reject', recurrenceDecision: 'reject' });
    const d = await run([HOMIRIS], decide);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ action: 'ignore', reasonCode: 'MODEL_REJECTED_NOT_AGENDA', t4: { verdict: 'EVENT_REJECTED', recurrenceDecision: 'reject' } });
    expect(d.filter((x) => x.action === 'create' || x.action === 'propose')).toHaveLength(0);
    // Le candidat de récurrence EXPLICITE a été soumis à T4, sans décision du code.
    expect(recus[0].recurrenceCandidate).toMatchObject({ mode: 'EXPLICIT_SOURCE', frequency: 'monthly', interval: 1 });
    expect(recus[0].documentType).toBe('FACTURE');
  });
});

describe('T4-V2-02 — contrat avec début', () => {
  it('« Prise d’effet le 05/11/2026 » : accept, information, not_applicable', async () => {
    const { decide, recus } = t4({ agendaDecision: 'accept', recurrenceDecision: 'not_applicable', category: 'information' });
    const d = await run([{ title: 'Prise d’effet du contrat', date: '2026-11-05', confidence: 'certain', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true, excerpt: 'Prise d’effet le 05/11/2026' }], decide);
    expect(recus[0].recurrenceCandidate).toBeNull();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ action: 'create', category: 'information', t4: { agendaDecision: 'accept', recurrenceDecision: 'not_applicable', verdict: 'ACCEPTED' } });
  });
});

describe('T4-V2-03 — fin de contrat', () => {
  it('« Fin d’engagement 04/11/2027 » : accept, occurrence unique', async () => {
    const { decide } = t4({ agendaDecision: 'accept', recurrenceDecision: 'not_applicable', category: 'information' });
    const d = await run([{ title: 'Fin d’engagement', date: '2027-11-04', confidence: 'certain', documentType: 'CONTRAT_ASSURANCE', mayCreateAgenda: true, excerpt: 'Fin d’engagement le 04/11/2027' }], decide);
    expect(d.map((x) => [x.action, x.date])).toEqual([['create', '2027-11-04']]);
  });
});

describe('T4-V2-04 — entretien annuel', () => {
  it('« tous les 12 mois » : accept / accept → série calculée par le code', async () => {
    const excerpt = 'Entretien à réaliser tous les 12 mois';
    const { decide, recus } = t4({ agendaDecision: 'accept', recurrenceDecision: 'accept' });
    const d = await run([{ title: 'Entretien chaudière', date: '2026-11-15', confidence: 'certain', excerpt, originFieldKey: 'maintenanceDueDate', documentType: 'RAPPORT_ENTRETIEN', recurrence: parseRecurrenceFr(excerpt) }], decide);
    expect(recus[0].recurrenceCandidate).toMatchObject({ mode: 'EXPLICIT_SOURCE', frequency: 'yearly' });
    expect(d[0]).toMatchObject({ action: 'create', t4: { recurrenceDecision: 'accept', verdict: 'ACCEPTED' } });
    const prev = d.filter((x) => x.occurrence?.nature === 'FORECAST');
    expect(prev.length).toBeGreaterThan(0);
    expect(prev[0]).toMatchObject({ action: 'create', reasonCode: 'RECURRENCE_EXPLICIT' });
  });
});

describe('T4-V2-05 — événement valide mais fausse récurrence', () => {
  it('accept / reject : uniquement l’événement ponctuel', async () => {
    const { decide } = t4({ agendaDecision: 'accept', recurrenceDecision: 'reject', category: 'information' });
    const d = await run([{ ...HOMIRIS, title: 'Fin d’engagement', date: '2027-11-04', documentType: 'CONTRAT_ASSURANCE' }], decide);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ action: 'create', date: '2027-11-04', t4: { verdict: 'RECURRENCE_REJECTED', recurrenceDecision: 'reject' } });
    expect(d[0].occurrence).toBeUndefined();
  });
});

describe('T4-V2-06 — historique régulier', () => {
  const existing = ['2023-11-10', '2024-11-12', '2025-11-11'].map((date, i) => ({
    id: 100 + i, title: 'Ramonage', date, category: 'action', status: 'fait', manual: false, originFieldKey: null, nature: 'CONFIRMED',
  }));
  const cand = { title: 'Ramonage', date: '2026-11-10', confidence: 'certain', documentType: 'FACTURE', mayCreateAgenda: true, excerpt: 'Ramonage du 10/11/2026' };

  it('HISTORICAL_PATTERN envoyé à T4 ; abstention → aucune série', async () => {
    const { decide, recus } = t4({ agendaDecision: 'accept', recurrenceDecision: 'abstain', category: 'information' });
    const d = await run([cand], decide, existing);
    expect(recus[0].recurrenceCandidate).toMatchObject({ mode: 'HISTORICAL_PATTERN', frequency: 'yearly', history: ['2023-11-10', '2024-11-12', '2025-11-11', '2026-11-10'] });
    expect(d.filter((x) => x.occurrence?.nature === 'FORECAST')).toHaveLength(0);
    expect(d[0].t4).toMatchObject({ verdict: 'RECURRENCE_REJECTED', recurrenceDecision: 'abstain' });
  });

  it('acceptation explicite de T4 → série (RECURRENCE_HISTORICAL)', async () => {
    const { decide } = t4({ agendaDecision: 'accept', recurrenceDecision: 'accept', category: 'action' });
    const d = await run([cand], decide, existing);
    expect(d.some((x) => x.reasonCode === 'RECURRENCE_HISTORICAL' && x.action === 'create')).toBe(true);
  });
});

describe('T4-V2-07 — indisponibilité modèle', () => {
  it('échec complet de la cascade : abstain technique, aucune création, aucune récurrence (jamais le repli « action »)', async () => {
    const d = await decideAgendaEvent({ title: 'X', originType: 'document' }, {
      accountId: 1, recurrenceCandidate: { mode: 'EXPLICIT_SOURCE', frequency: 'monthly', interval: 1, startDate: null, endDate: null, occurrenceCount: null, excerpt: null, history: [] },
    }, { call: async () => { throw Object.assign(new Error('ALL_MODELS_FAILED : 503'), { code: 'ALL_MODELS_FAILED' }); } });
    expect(d).toMatchObject({ agendaDecision: 'abstain', recurrenceDecision: 'abstain', outcome: 'technical_failure', error: { code: 'ALL_MODELS_FAILED' } });
    const r = await run([HOMIRIS], async () => d);
    expect(r).toEqual([expect.objectContaining({ action: 'ignore', reasonCode: 'T4_TECHNICAL_FAILURE', t4: expect.objectContaining({ verdict: 'TECHNICAL_FAILURE', errorCode: 'ALL_MODELS_FAILED' }) })]);
  });

  it('passerelle réelle, modèle en échec : même abstention', async () => {
    __setConfigForTests({ versionId: 54, entries: [{ ...emptyTreatmentConfig('T4'), primaryModel: 'm-a', promptArchitecture: 'master' }] });
    const fake = new FakeProvider();
    setAiProvider(fake);
    fake.onAny(() => { throw Object.assign(new Error('503 indisponible'), { status: 503 }); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await processAgendaCandidates({ accountId: 1, assetId: 3, sourceFileId: 40, today: TODAY, existing: [], candidates: [HOMIRIS] as never });
    expect(r.map((x) => x.action)).toEqual(['ignore']);
    expect(r[0].reasonCode).toBe('T4_TECHNICAL_FAILURE');
  });
});

describe('T4-V2-08 — correction historique (ordre : T4 avant la déduplication)', () => {
  it('ancienne échéance automatique identique + reject : ignore (jamais skip_duplicate) → retirée par planSourceSync ; élément modifié/confirmé : conservé', async () => {
    const { decide } = t4({ agendaDecision: 'reject', recurrenceDecision: 'reject' });
    const existant = { id: 501, title: 'Abonnement Homiris', date: '2026-10-31', category: 'action', status: null, manual: false, originFieldKey: null };
    const d = await run([HOMIRIS], decide, [existant]);
    expect(d.map((x) => x.action)).toEqual(['ignore']);
    const items = [
      { id: 501, functionalKey: 'k1', title: 'Abonnement Homiris', startDate: '2026-10-31', originFieldKey: null, isAutomatic: true, isAutomaticModified: false, manualStatus: null },
      { id: 502, functionalKey: 'k2', title: 'Abonnement Homiris', startDate: '2026-11-30', originFieldKey: null, isAutomatic: true, isAutomaticModified: false, manualStatus: null },
      { id: 503, functionalKey: 'k3', title: 'Abonnement Homiris', startDate: '2026-12-31', originFieldKey: null, isAutomatic: true, isAutomaticModified: true, manualStatus: null },
      { id: 504, functionalKey: 'k4', title: 'Abonnement Homiris', startDate: '2027-01-31', originFieldKey: null, isAutomatic: true, isAutomaticModified: false, manualStatus: 'fait' },
    ];
    const plan = planSourceSync({
      sourceFileId: 40, assetId: 3, items,
      decisions: d.map((x, index) => ({ index, action: x.action, title: x.title, date: x.date, sourceFileId: x.sourceFileId ?? null, existingItemId: x.existingItemId ?? null })),
    });
    expect(plan.steps).toEqual([]);
    expect(plan.remove.sort()).toEqual([501, 502]);
    expect(plan.keep.sort()).toEqual([503, 504]);
  });
});

describe('T4-V2-09 — compatibilité', () => {
  const V1 = { mode: 'STRUCTURED_CONTEXT' as const, inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] };
  const V2 = { mode: 'STRUCTURED_CONTEXT' as const, inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v2', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] };
  const existe = (n: string, v: number) => contractVersionsOf(n).includes(v);

  it('texte de référence v2 : contexte structuré v2 par défaut, activable sans {{TASK}} ni emplacement, aucun contrôle Legacy', () => {
    expect(sc.executionConfigFor({ masterPromptCode: 't4_master_v1', source: 'file' })).toEqual(V2);
    expect(FICHIER).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(sc.checkExecutionConfig(T4_EXECUTION_SPEC, V2, existe)).toEqual([]);
    expect(checkMasterPromptContent('T4', FICHIER, V2)).toMatchObject({ ok: true, blocking: [] });
    // Le même texte en mode historique exige les emplacements : le mode n'est jamais déduit du texte.
    expect(checkMasterPromptContent('T4', FICHIER, sc.LEGACY_EXECUTION).ok).toBe(false);
  });

  it('versions historiques toujours réactivables : structurée v1 et Legacy (t4_output_v1)', () => {
    expect(sc.checkExecutionConfig(T4_EXECUTION_SPEC, V1, existe)).toEqual([]);
    expect(checkMasterPromptContent('T4', LEGACY, sc.LEGACY_EXECUTION)).toMatchObject({ ok: true });
  });

  it('nouvelle version : contrats du texte de référence (v2), jamais l’ancien mode hérité pour ce texte', () => {
    expect(sc.draftExecutionConfig('t4_master_v1', null)).toEqual(V2);
  });

  it('passerelle : version BO v1 → sortie v1 lue comme accept, récurrence non décidée (abstain) ; fichier v2 → sortie v2', async () => {
    __setConfigForTests({ versionId: 54, entries: [{ ...emptyTreatmentConfig('T4'), primaryModel: 'm-a', promptArchitecture: 'master' }] });
    const fake = new FakeProvider();
    setAiProvider(fake);
    const ctx = { accountId: 1, date: '2026-10-31', recurrenceCandidate: { mode: 'EXPLICIT_SOURCE' as const, frequency: 'monthly', interval: 1, startDate: null, endDate: null, occurrenceCount: null, excerpt: 'mensuel', history: [] } };

    __setActiveMasterPromptsForTests([{ id: 900, treatment: 'T4', versionNumber: 3, content: FICHIER, execution: V1 }]);
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'CLASSIFY_EVENT', homeCategory: 'action', confidence: 'certain', reason: 'r' }), inputTokens: 1, outputTokens: 1 }));
    const v1 = await decideAgendaEvent({ title: 'X', originType: 'document' }, ctx);
    expect(v1).toMatchObject({ agendaDecision: 'accept', recurrenceDecision: 'abstain', outcome: 'model_v1', warnings: ['T4_OUTPUT_V1_NO_RECURRENCE_DECISION'] });

    __setActiveMasterPromptsForTests(null);
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'CLASSIFY_EVENT', agendaDecision: 'reject', recurrenceDecision: 'reject', homeCategory: 'unknown', businessType: null, confidence: 'certain', reason: 'période facturée', recurrenceReason: 'facturation' }), inputTokens: 1, outputTokens: 1 }));
    const v2 = await decideAgendaEvent({ title: 'X', originType: 'document' }, { ...ctx, documentType: 'FACTURE' });
    expect(v2).toMatchObject({ agendaDecision: 'reject', recurrenceDecision: 'reject', outcome: 'model_v2' });
    const prompt = fake.calls.at(-1)!.prompt;
    const contexte = JSON.parse(prompt.slice(prompt.indexOf('\nEXECUTION_CONTEXT\n') + 19).split('\n')[0]);
    expect(contexte.event_context.recurrenceCandidate).toMatchObject({ mode: 'EXPLICIT_SOURCE', frequency: 'monthly' });
    expect(contexte.document_type).toEqual({ code: 'FACTURE', label: 'Facture' });

    // Schéma d'appelant sans contrat accepté : refus avant appel, comme avant.
    await expect(AiGateway.execute({
      useCaseCode: 'AGENDA_INTELLIGENCE', operationCode: 't4_classify_event', accountId: 1,
      promptVariables: {}, outputSchema: T4ClassifyEventOutput, idempotencyKey: `l54-${Math.random()}`,
    })).rejects.toBeTruthy();
  });
});
