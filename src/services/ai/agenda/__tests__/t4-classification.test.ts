/**
 * CDC 15 T4-02, T4-10, T4-11, P-T4-01 — classification action / information :
 * registre avant tout, règles métier stables en un seul exemplaire, master à
 * trois valeurs, classification prudente. Lot 16b-2 : master T4 seul (le
 * moteur de règles historique, `classify_event` et `AgendaClassificationService`
 * sont retirés) — le chemin manuel passe par `classifyAgendaCategory`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { classifyByRules, classifyByRulesDetailed } = await import('../rules/deterministic-classification');
const { applyBusinessRules } = await import('../rules/business-rules');
const { prudentCategory } = await import('../rules/prudent-category');
const { classifyAgendaEvent, classifyAgendaCategory } = await import('../agenda-intelligence.service');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');

const P1 = JSON.parse(readFileSync(join(__dirname, '..', 'master', '__fixtures__', 'p-t4-01-controle-technique-futur.json'), 'utf8'));
let fake: InstanceType<typeof FakeProvider>;
const T4 = (arch: 'steps' | 'master') => __setConfigForTests({
  versionId: 41, entries: [{ ...emptyTreatmentConfig('T4'), primaryModel: 'm-a', promptArchitecture: arch }],
});
const ctx = { accountId: 1 };

beforeEach(() => { traces.length = 0; fake = new FakeProvider(); setAiProvider(fake); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { __setConfigForTests(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('T4-02 : plus de « champ de bien ⇒ information »', () => {
  it('échéances futures issues d’un champ : action ; faits passés : information (registre)', () => {
    const f = (originFieldKey: string, title = 'Échéance') => classifyByRulesDetailed({ title, originType: 'asset_field', originFieldKey });
    expect(f('nextInspection')).toMatchObject({ category: 'action', source: 'registry' });
    expect(f('maintenanceDueDate')).toMatchObject({ category: 'action', source: 'registry' });
    expect(f('lastRevision')).toMatchObject({ category: 'information', source: 'registry' });
    expect(f('acquisitionDate')).toMatchObject({ category: 'information', source: 'registry' });
    expect(f('warrantyEndDate')).toMatchObject({ category: 'information', source: 'registry' });
  });

  it('`selon_evenement` (assurance) : l’événement concret décide, sinon ambigu', () => {
    expect(classifyByRules({ title: "Échéance d'assurance", originType: 'asset_field', originFieldKey: 'insuranceExpiry' })).toBeNull();
    expect(classifyByRules({ title: 'Entretien chaudière', originType: 'asset_field', originFieldKey: 'champInconnu' })).toBe('action');
  });

  it('type métier et nature fournis sans champ', () => {
    expect(classifyByRules({ title: 'X', originType: 'document', businessType: 'purchase', nature: 'HISTORICAL' })).toBe('information');
    expect(classifyByRules({ title: 'X', originType: 'document', businessType: 'inspection', nature: 'DEADLINE' })).toBe('action');
  });
});

describe('T4-11 : règles métier stables, un seul exemplaire', () => {
  it('reconduction tacite = information, sauf démarche explicite', () => {
    expect(applyBusinessRules('Échéance assurance habitation — reconduction tacite')).toEqual({ category: 'information', ruleCode: 'TACIT_RENEWAL_INFORMATION' });
    expect(applyBusinessRules('Échéance assurance — reconduction tacite, à résilier avant le 1er mars')).toBeNull();
    expect(classifyByRules({ title: "Échéance d'assurance", description: 'Contrat reconduit tacitement ; pour résilier, envoyez le formulaire avant le 1/03', originType: 'asset_field', originFieldKey: 'insuranceExpiry' })).toBeNull();
  });

  it('gardiennage / stockage / reprise : action', () => {
    expect(classifyByRules({ title: 'Fin de contrat de gardiennage', originType: 'document' })).toBe('action');
    expect(classifyByRules({ title: 'Pneus hiver en dépôt', originType: 'document' })).toBe('action');
  });

  it('plus de règle « assurance = information » par type de contrat', () => {
    expect(classifyByRules({ title: 'Fin assurance auto', originType: 'document' })).toBeNull();
  });

  it('chemin manuel (`classifyAgendaCategory`) : même source, aucun appel modèle sur un cas tranché', async () => {
    fake.onAny(() => { throw new Error('ne doit pas être appelé'); });
    await expect(classifyAgendaCategory({ title: "Échéance d'assurance", description: 'reconduction tacite', originType: 'asset_field', originFieldKey: 'insuranceExpiry' }, ctx)).resolves.toBe('information');
    await expect(classifyAgendaCategory({ title: 'Contrôle technique', originType: 'asset_field', originFieldKey: 'nextInspection' }, ctx)).resolves.toBe('action');
    expect(fake.calls).toHaveLength(0);
    // Le classifieur historique et sa copie des règles n'existent plus.
    expect(existsSync(join(process.cwd(), 'src/services/agenda/AgendaClassificationService.ts'))).toBe(false);
    const write = readFileSync(join(process.cwd(), 'src/services/agenda/AgendaWriteService.ts'), 'utf8');
    expect(write).toMatch(/classifyAgendaCategory\(/);
    expect(write).not.toMatch(/AI_AGENDA_ENGINE'\)|isEnabled\(/);
  });
});

describe('T4-10 : unknown et classification prudente', () => {
  it('unknown futur → action à qualifier ; passé → information à qualifier', () => {
    const u = { category: 'unknown' as const, confidence: 'ambiguous' as const, source: 'model' as const };
    expect(prudentCategory(u, { date: '2027-01-01', today: '2026-09-29' })).toEqual({ category: 'action', requiresQualification: true });
    expect(prudentCategory(u, { date: '2025-01-01', today: '2026-09-29' })).toEqual({ category: 'information', requiresQualification: true });
    expect(prudentCategory({ category: 'information', confidence: 'certain', source: 'registry' }, { today: '2026-09-29' }))
      .toEqual({ category: 'information', requiresQualification: false });
  });
});

describe('P-T4-01 et master T4 seul', () => {
  it('champ nextInspection : action par le registre, sans appel', async () => {
    T4('master');
    const c = await classifyAgendaEvent({ title: P1.context.field.title, originType: 'asset_field', originFieldKey: P1.context.field.originFieldKey }, ctx);
    expect(c).toMatchObject({ category: P1.expected.category, source: 'registry' });
    expect(fake.calls).toHaveLength(0);
  });

  it('master : cas ambigu → t4_classify_event, catalogue en données, action', async () => {
    T4('master');
    fake.onAny(() => ({ rawText: JSON.stringify(P1.recording.output), inputTokens: 1, outputTokens: 1 }));
    const cand = P1.context.candidate;
    const c = await classifyAgendaEvent({ title: cand.title, originType: 'document', description: null }, { ...ctx, excerpt: cand.excerpt, date: cand.date });
    expect(c).toMatchObject({ category: 'action', confidence: 'certain', source: 'model', businessType: 'inspection' });
    expect(fake.calls[0].prompt).toContain('TASK = CLASSIFY_EVENT');
    expect(fake.calls[0].prompt).toContain('"businessType":"inspection"');
    expect(traces[0]).toMatchObject({ operationCode: 't4_classify_event', task: 'CLASSIFY_EVENT', masterPromptCode: 't4_master_v1' });
  });

  it('master : unknown → catégorie prudente sur le chemin manuel', async () => {
    T4('master');
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'CLASSIFY_EVENT', homeCategory: 'unknown', confidence: 'ambiguous', reason: 'r' }), inputTokens: 1, outputTokens: 1 }));
    await expect(classifyAgendaCategory({ title: 'Truc', originType: 'manual' }, { ...ctx, date: '2020-01-01' })).resolves.toBe('information');
  });

  it('version ancienne en `steps` : le master T4 s’applique quand même (lot 16b-2)', async () => {
    T4('steps');
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'CLASSIFY_EVENT', homeCategory: 'information', confidence: 'probable', reason: 'r' }), inputTokens: 1, outputTokens: 1 }));
    const c = await classifyAgendaEvent({ title: 'Truc', originType: 'manual' }, ctx);
    expect(c).toMatchObject({ category: 'information', source: 'model' });
    expect(traces[0]).toMatchObject({ operationCode: 't4_classify_event', task: 'CLASSIFY_EVENT' });
  });

  it('sans version : master T4 aussi', async () => {
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'CLASSIFY_EVENT', homeCategory: 'action', confidence: 'probable', reason: 'r' }), inputTokens: 1, outputTokens: 1 }));
    await classifyAgendaEvent({ title: 'Truc', originType: 'manual' }, ctx);
    expect(traces[0]).toMatchObject({ operationCode: 't4_classify_event' });
  });

  it('échec du modèle : repli historique « action », ambigu', async () => {
    T4('master');
    fake.onAny(() => { throw new Error('503'); });
    expect(await classifyAgendaEvent({ title: 'Truc', originType: 'manual' }, ctx)).toMatchObject({ category: 'action', source: 'fallback', confidence: 'ambiguous' });
  });
});

describe('règles v2 seules (lot 16b-2 : moteur historique retiré)', () => {
  it('un champ de bien n’est plus « information » par principe (T4-02)', async () => {
    fake.onAny(() => { throw new Error('ne doit pas être appelé'); });
    const champ = { title: 'Contrôle technique', originType: 'asset_field', originFieldKey: 'nextInspection' };
    expect(classifyByRules(champ)).toBe('action');
    expect((await classifyAgendaEvent(champ, ctx)).category).toBe('action');
    // Variable retirée encore posée : sans effet.
    vi.stubEnv('AI_T4_EFFECTS', 'legacy');
    expect((await classifyAgendaEvent(champ, ctx)).category).toBe('action');
  });
});
