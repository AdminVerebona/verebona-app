/**
 * Lot 34D — ticket « T4 : découpler le contrat d'exécution du texte du
 * prompt maître ». Tests T4C-xx (tests unitaires minimum 1 à 6 du ticket,
 * tests par TASK, non-régression facture mensuelle, critères d'acceptation).
 *
 *  · T4C-01 prompt sans emplacement : appel possible, contexte injecté ;
 *  · T4C-02 champ obligatoire manquant : échec avant appel, 0 appel, champ identifié ;
 *  · T4C-03 champ optionnel absent : appel accepté ;
 *  · T4C-04 TASK invalide / non autorisée : rejet avant appel ;
 *  · T4C-05 prompt réorganisé : aucun impact sur l'injection ;
 *  · T4C-06 sortie invalide : validation en échec, erreur explicite, aucune persistance ;
 *  · T4C-07 type non conforme : T4_INPUT_CONTRACT_INVALID_TYPE ;
 *  · T4C-08 par TASK : CLASSIFY_EVENT, VERIFY_COMPLETION, TEMPORAL_AMBIGUITY ;
 *  · T4C-09 aucune donnée injectée deux fois ;
 *  · T4C-10 mode EXPLICITE (jamais déduit des {{…}}), legacy conservé ;
 *  · T4C-11 aucun repli silencieux vers les emplacements ;
 *  · T4C-12 validateur d'activation : technique seulement en mode structuré ;
 *  · T4C-13 versions prompt / input / output tracées séparément ;
 *  · T4C-14 éditeur BO : contexte disponible, informatif ;
 *  · T4C-15 aperçu / test : chaque étape inspectable ;
 *  · T4C-16 T1, T2, T3, T5, T6 inchangés ;
 *  · T4C-NR facture internet 08/08/2026 → 07/09/2026 : FACT_ONLY / IGNORE, jamais CONTRACT_END.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const capture = vi.hoisted(() => ({ diags: [] as Array<Record<string, unknown>>, traces: [] as Array<Record<string, unknown>> }));
vi.mock('../../../gateway/diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../../../gateway/diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async (r: Record<string, unknown>) => { capture.diags.push(r); }),
}));
vi.mock('../../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { capture.traces.push(t); return capture.traces.length; }),
}));

const { AiGateway } = await import('../../../gateway/ai-gateway');
const { FakeProvider, setAiProvider } = await import('../../../gateway/providers');
const { __setConfigForTests } = await import('../../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../../config/config-types');
const { __setActiveMasterPromptsForTests } = await import('../../../master-prompts/master-prompt-runtime');
const sc = await import('../../../master-prompts/structured-context');
const { T4_EXECUTION_SPEC } = await import('../t4-execution-contract');
const { T4ClassifyEventOutput, T4VerifyCompletionOutput, T4TemporalAmbiguityOutput } = await import('../t4-contract');
const { classifyEventVariables, classifyEventMaster } = await import('../classify-event');
const { verifyCompletionVariables } = await import('../verify-completion');
const { temporalAmbiguityVariables } = await import('../temporal-ambiguity');
const { decideCompletion } = await import('../../status-reconciler');
const { classifyAgendaEvent } = await import('../../agenda-intelligence.service');
const { prudentCategory } = await import('../../rules/prudent-category');
const { checkMasterPromptContent } = await import('../../../master-prompts/master-prompt-checks');
const { checkMasterProposal } = await import('../../../config/prompt-architecture');

const FICHIER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/agenda/t4_master_v1.txt'), 'utf8');
const LEGACY = readFileSync(join(process.cwd(), 'src/services/ai/agenda/master/reference/t4_master_v1.legacy-template.txt'), 'utf8');
const fixture = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', f), 'utf8'));
const P6 = fixture('p-t4-06-facture-internet-periode.json');

const STRUCTURE = sc.executionConfigFor({ masterPromptCode: 't4_master_v1', source: 'file' });
let fake: InstanceType<typeof FakeProvider>;

/** Configuration T4 « master » ; `bo` : version active du BO (texte + configuration d'exécution). */
function t4(bo?: { content: string; execution: import('../../../master-prompts/structured-context').MasterExecutionConfig | null; versionNumber?: number }) {
  __setConfigForTests({ versionId: 41, entries: [{ ...emptyTreatmentConfig('T4'), primaryModel: 'm-a', fallback1: 'm-b', promptArchitecture: 'master' }] });
  __setActiveMasterPromptsForTests(bo ? [{ id: 900, treatment: 'T4', versionNumber: bo.versionNumber ?? 12, content: bo.content, execution: bo.execution }] : null);
}

const classifyVars = (over: Record<string, unknown> = {}) => ({
  ...classifyEventVariables({ title: 'Échéance véhicule', originType: 'document', description: null } as never, { accountId: 1, excerpt: 'Prochain contrôle technique avant le 12/05/2027.', date: '2027-05-12' }),
  ...over,
});
const classifyOut = JSON.stringify({ task: 'CLASSIFY_EVENT', businessType: 'inspection', homeCategory: 'action', confidence: 'certain', reason: 'contrôle à effectuer' });
const execClassify = (vars = classifyVars()) => AiGateway.execute({
  useCaseCode: 'AGENDA_INTELLIGENCE', operationCode: 't4_classify_event', accountId: 1,
  promptVariables: vars, outputSchema: T4ClassifyEventOutput, idempotencyKey: `t4c-${Math.random()}`,
});
/** Bloc EXECUTION_CONTEXT d'un prompt envoyé. */
const contexteDe = (prompt: string) => {
  const i = prompt.indexOf('\nEXECUTION_CONTEXT\n');
  expect(i).toBeGreaterThan(0);
  return JSON.parse(prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as Record<string, unknown>;
};

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  capture.diags.length = 0;
  capture.traces.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { __setConfigForTests(null); __setActiveMasterPromptsForTests(null); vi.restoreAllMocks(); });

describe('T4C-01 — prompt sans emplacement : appel possible', () => {
  it('le prompt maître livré ne contient aucun {{…}} ; le contexte est injecté une fois (EXECUTION_CONTEXT)', async () => {
    expect(FICHIER).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(STRUCTURE).toEqual({ mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] });
    t4();
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    const res = await execClassify();
    expect(res.data).toMatchObject({ homeCategory: 'action' });
    const p = fake.calls[0].prompt;
    expect(p.startsWith(FICHIER.replace(/\s+$/, ''))).toBe(true);
    expect(p.split('EXECUTION_CONTEXT\n{').length).toBe(2);
    expect(contexteDe(p)).toMatchObject({ task: 'CLASSIFY_EVENT', event_context: { title: 'Échéance véhicule' } });
    // Contrat de sortie hors prompt : schéma fournisseur dérivé du contrat, consigne de priorité.
    expect(fake.calls[0].responseSchema).toBeDefined();
    expect(p).toContain('LE CONTRAT RUNTIME EST PRIORITAIRE.');
  });
});

describe('T4C-02 — champ obligatoire manquant : échec AVANT appel', () => {
  it('event_catalog absent pour CLASSIFY_EVENT : 0 appel fournisseur, T4_INPUT_CONTRACT_MISSING_FIELD, champ identifié', async () => {
    t4();
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await expect(execClassify(classifyVars({ EVENT_CATALOG: null }))).rejects.toMatchObject({
      code: 'T4_INPUT_CONTRACT_MISSING_FIELD', recoverable: false,
      contractDetail: { task: 'CLASSIFY_EVENT', field: 'event_catalog', contract: 't4_input_v1', step: 'required_fields' },
    });
    expect(fake.calls).toHaveLength(0);
    // Rapport BO : TASK, champ, contrat, étape.
    expect(capture.traces[0]).toMatchObject({ status: 'error', errorCode: 'T4_INPUT_CONTRACT_MISSING_FIELD', billable: false });
    expect(capture.diags[0].diagnostic).toMatchObject({ family: 'INTERNAL_ERROR', stage: 'request_build', contractRefusal: { field: 'event_catalog', step: 'required_fields' } });
  });

  it('chemin métier : la classification retombe sur son repli explicite, sans écrire de décision du modèle', async () => {
    t4();
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    // `classifyEventMaster` construit lui-même ses variables : un catalogue vide viole le contrat (liste ≥ 1).
    const { EVENT_CATALOG } = await import('@/services/canonical/registry');
    const sauvegarde = [...EVENT_CATALOG];
    (EVENT_CATALOG as unknown as unknown[]).length = 0;
    try {
      const c = await classifyEventMaster({ title: 'X', originType: 'document' } as never, { accountId: 1 });
      expect(c).toMatchObject({ source: 'fallback' });
      expect(fake.calls).toHaveLength(0);
    } finally {
      (EVENT_CATALOG as unknown as unknown[]).push(...sauvegarde);
    }
  });
});

describe('T4C-03 — champ optionnel absent : appel accepté', () => {
  it('evidence absente pour CLASSIFY_EVENT : contexte sans evidence, appel effectué', async () => {
    t4();
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await execClassify(classifyVars({ EVIDENCE: null }));
    expect(fake.calls).toHaveLength(1);
    const ctx = contexteDe(fake.calls[0].prompt);
    expect(ctx).not.toHaveProperty('evidence');
    expect(Object.keys(ctx).sort()).toEqual(['event_catalog', 'event_context', 'task']);
  });
});

describe('T4C-04 — TASK invalide : rejet avant appel', () => {
  it('UNKNOWN_TASK : T4_TASK_NOT_ALLOWED (construction du contexte)', () => {
    expect(() => sc.buildExecutionContext(T4_EXECUTION_SPEC, STRUCTURE, 'UNKNOWN_TASK', {}))
      .toThrow(expect.objectContaining({ code: 'T4_TASK_NOT_ALLOWED', detail: expect.objectContaining({ task: 'UNKNOWN_TASK', step: 'task' }) }));
  });
  it('TASK connue mais non autorisée par la configuration (hors prompt) : 0 appel fournisseur', async () => {
    t4({ content: FICHIER, execution: { ...STRUCTURE, allowedTasks: ['VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] } });
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await expect(execClassify()).rejects.toMatchObject({ code: 'T4_TASK_NOT_ALLOWED', contractDetail: { task: 'CLASSIFY_EVENT', step: 'task' } });
    expect(fake.calls).toHaveLength(0);
  });
  it('liste des TASK définie hors du texte du prompt (configuration)', () => {
    expect(T4_EXECUTION_SPEC.knownTasks).toEqual(['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY']);
    const sansTask = FICHIER.replace(/CLASSIFY_EVENT|VERIFY_COMPLETION|TEMPORAL_AMBIGUITY/g, 'X');
    expect(checkMasterPromptContent('T4', sansTask, STRUCTURE).ok).toBe(true);
  });
});

describe('T4C-05 — prompt réorganisé : aucun impact sur l’injection', () => {
  it('sections dans l’ordre inverse, titres reformulés : même EXECUTION_CONTEXT (même empreinte)', async () => {
    const sections = FICHIER.split(/\n(?=[A-ZÉÈÀÂ’ ]{6,}(?:\(|\n))/);
    const reorganise = [...sections].reverse().join('\n\n').replace(/CLASSER UN ÉVÉNEMENT/, 'Partie A — classement')
      .replace(/VÉRIFIER UNE RÉALISATION/, 'Partie B — réalisation');
    expect(reorganise).not.toBe(FICHIER);
    expect(checkMasterPromptContent('T4', reorganise, STRUCTURE)).toMatchObject({ ok: true, blocking: [] });
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    t4({ content: FICHIER, execution: STRUCTURE });
    await execClassify();
    t4({ content: reorganise, execution: STRUCTURE, versionNumber: 13 });
    await execClassify();
    expect(fake.calls).toHaveLength(2);
    expect(contexteDe(fake.calls[1].prompt)).toEqual(contexteDe(fake.calls[0].prompt));
    const sc0 = capture.traces[0].structuredContext as { contextHash: string; promptHash: string };
    const sc1 = capture.traces[1].structuredContext as { contextHash: string; promptHash: string };
    expect(sc1.contextHash).toBe(sc0.contextHash);
    expect(sc1.promptHash).not.toBe(sc0.promptHash);
  });
});

describe('T4C-06 — sortie invalide : erreur explicite, aucune persistance métier', () => {
  it('validation de sortie en échec sur toute la chaîne : ALL_MODELS_FAILED / INVALID_OUTPUT', async () => {
    t4();
    process.env.AI_OUTPUT_REPAIR_PASS = 'off';
    try {
      fake.onAny(() => ({ rawText: JSON.stringify({ task: 'CLASSIFY_EVENT', homeCategory: 'peut-être', confidence: 'certain', reason: 'r' }), inputTokens: 1, outputTokens: 1 }));
      await expect(execClassify()).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' });
      expect(capture.diags.every((d) => (d.diagnostic as { family: string }).family === 'INVALID_OUTPUT')).toBe(true);
      // Chemin métier : repli explicite, jamais la sortie invalide.
      const c = await classifyEventMaster({ title: 'X', originType: 'document' } as never, { accountId: 1 });
      expect(c).toMatchObject({ source: 'fallback', reason: 'modèle indisponible' });
    } finally {
      delete process.env.AI_OUTPUT_REPAIR_PASS;
    }
  });
});

describe('T4C-07 — type non conforme : T4_INPUT_CONTRACT_INVALID_TYPE', () => {
  it('candidats temporels sans identifiant : refus avant appel, champ identifié', () => {
    const vars = temporalAmbiguityVariables({ title: 'Échéance' }, [{ candidateId: 1, date: '2026-05-04', interpretation: 'jj/mm' }]);
    vars.TEMPORAL_CANDIDATES = [{ date: '04/05/2026' }];
    expect(() => sc.buildExecutionContext(T4_EXECUTION_SPEC, STRUCTURE, 'TEMPORAL_AMBIGUITY', vars))
      .toThrow(expect.objectContaining({ code: 'T4_INPUT_CONTRACT_INVALID_TYPE', detail: expect.objectContaining({ field: 'temporal_candidates', step: 'types' }) }));
  });
  it('donnée hors contrat : T4_EXECUTION_CONTEXT_BUILD_FAILED (jamais transmise en douce)', () => {
    expect(() => sc.buildExecutionContext(T4_EXECUTION_SPEC, STRUCTURE, 'CLASSIFY_EVENT', { ...classifyVars(), SECRET: 'x' }))
      .toThrow(expect.objectContaining({ code: 'T4_EXECUTION_CONTEXT_BUILD_FAILED' }));
  });
});

describe('T4C-08 — contexte fourni par TASK (appelants réels)', () => {
  it('CLASSIFY_EVENT : task, event_context, event_catalog, evidence', () => {
    const b = sc.buildExecutionContext(T4_EXECUTION_SPEC, STRUCTURE, 'CLASSIFY_EVENT', classifyVars());
    expect(b.fields).toEqual(['event_context', 'event_catalog', 'evidence']);
    expect(b.output).toEqual({ schemaName: 'T4ClassifyEventOutput', contractVersion: 1 });
    expect((b.context.event_catalog as unknown[]).length).toBeGreaterThan(0);
  });
  it('VERIFY_COMPLETION : agenda_item, document_type, evidence (datée)', () => {
    const P2 = fixture('p-t4-02-facture-ambigue.json');
    const ev = { ...P2.context.evidence, documentDate: new Date(P2.context.evidence.documentDate) };
    const vars = verifyCompletionVariables(P2.context.item, ev, decideCompletion(P2.context.item, ev));
    const b = sc.buildExecutionContext(T4_EXECUTION_SPEC, STRUCTURE, 'VERIFY_COMPLETION', vars);
    expect(b.fields).toEqual(['agenda_item', 'document_type', 'evidence']);
    expect(b.context.evidence).toMatchObject({ excerpt: expect.stringContaining('Entretien annuel'), documentDate: '2026-10-12' });
    expect(b.output.schemaName).toBe('T4VerifyCompletionOutput');
  });
  it('TEMPORAL_AMBIGUITY : temporal_context, temporal_candidates (sans dépendre d’emplacements)', () => {
    const vars = temporalAmbiguityVariables({ title: 'Échéance', excerpt: '04/05/2026' }, [
      { candidateId: 2, date: '2026-04-05', interpretation: 'mm/jj' }, { candidateId: 1, date: '2026-05-04', interpretation: 'jj/mm' }]);
    const b = sc.buildExecutionContext(T4_EXECUTION_SPEC, STRUCTURE, 'TEMPORAL_AMBIGUITY', vars);
    expect(b.fields).toEqual(['temporal_context', 'temporal_candidates']);
    expect((b.context.temporal_candidates as Array<{ candidateId: number }>).map((c) => c.candidateId)).toEqual([1, 2]);
    expect(b.output.schemaName).toBe('T4TemporalAmbiguityOutput');
  });
  it('exigences dépendant de la TASK : agenda_item requis pour VERIFY_COMPLETION, sans objet pour CLASSIFY_EVENT', () => {
    const t = T4_EXECUTION_SPEC.inputContracts.t4_input_v1.tasks;
    expect(t.VERIFY_COMPLETION.required).toContain('agenda_item');
    expect([...t.CLASSIFY_EVENT.required, ...t.CLASSIFY_EVENT.optional]).not.toContain('agenda_item');
    expect(t.CLASSIFY_EVENT.optional).toContain('evidence');
    expect(t.TEMPORAL_AMBIGUITY.required).toEqual(['temporal_context', 'temporal_candidates']);
  });
  it('appels de passerelle : les trois branches passent avec leurs schémas de sortie', async () => {
    t4();
    fake.onAny((input) => ({
      rawText: input.task === 'VERIFY_COMPLETION'
        ? JSON.stringify({ task: 'VERIFY_COMPLETION', evidenceStatus: 'insufficient', occurrenceMatch: 'probable', confidence: 'probable', evidence: {}, reason: 'r' })
        : JSON.stringify({ task: 'TEMPORAL_AMBIGUITY', decision: 'abstain', confidence: 'ambiguous', reason: 'r' }),
      inputTokens: 1, outputTokens: 1,
    }));
    const P2 = fixture('p-t4-02-facture-ambigue.json');
    const ev = { ...P2.context.evidence, documentDate: new Date(P2.context.evidence.documentDate) };
    await AiGateway.execute({ useCaseCode: 'AGENDA_INTELLIGENCE', operationCode: 't4_verify_completion', accountId: 1,
      promptVariables: verifyCompletionVariables(P2.context.item, ev, decideCompletion(P2.context.item, ev)), outputSchema: T4VerifyCompletionOutput });
    await AiGateway.execute({ useCaseCode: 'AGENDA_INTELLIGENCE', operationCode: 't4_temporal_ambiguity', accountId: 1,
      promptVariables: temporalAmbiguityVariables({ title: 'É' }, [{ candidateId: 1, date: '2026-05-04', interpretation: 'jj/mm' }]), outputSchema: T4TemporalAmbiguityOutput });
    expect(fake.calls.map((c) => contexteDe(c.prompt).task)).toEqual(['VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY']);
    expect(capture.traces.map((t) => (t.runtimeContract as { contractId: string }).contractId)).toEqual(['T4_VERIFY_COMPLETION', 'T4_TEMPORAL_AMBIGUITY']);
  });
});

describe('T4C-09 — aucune donnée injectée deux fois', () => {
  it('l’extrait de preuve n’apparaît qu’une fois dans le prompt envoyé', async () => {
    t4();
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await execClassify(classifyVars({ EVIDENCE: 'EXTRAIT-UNIQUE-42' }));
    expect(fake.calls[0].prompt.split('EXTRAIT-UNIQUE-42').length - 1).toBe(1);
  });
});

describe('T4C-10 — mode explicite, jamais déduit du texte ; legacy conservé', () => {
  it('LEGACY_TEMPLATE (version BO) : emplacements substitués comme avant, aucun EXECUTION_CONTEXT', async () => {
    t4({ content: LEGACY, execution: sc.LEGACY_EXECUTION });
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await execClassify();
    const p = fake.calls[0].prompt;
    expect(p).toContain('TASK = CLASSIFY_EVENT');
    expect(p).not.toContain('EXECUTION_CONTEXT');
    expect(capture.traces[0].structuredContext).toMatchObject({ mode: 'LEGACY_TEMPLATE', inputContractVersion: null, outputContractVersion: null });
  });
  it('STRUCTURED_CONTEXT avec un texte contenant encore {{EVIDENCE}} : non substitué (le mode n’est pas déduit), avertissement BO', async () => {
    const texte = `${FICHIER}\nPreuve : {{EVIDENCE}}`;
    expect(checkMasterPromptContent('T4', texte, STRUCTURE)).toMatchObject({ ok: true, warnings: [expect.objectContaining({ code: 'STRUCTURED_PLACEHOLDER_PRESENT' })] });
    t4({ content: texte, execution: STRUCTURE });
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await execClassify();
    expect(fake.calls[0].prompt).toContain('Preuve : {{EVIDENCE}}');
  });
  it('version BO sans configuration (antérieure à 0290) : LEGACY_TEMPLATE explicite', () => {
    expect(sc.executionConfigFor({ masterPromptCode: 't4_master_v1', source: 'version', stored: null }).mode).toBe('LEGACY_TEMPLATE');
    expect(sc.executionConfigFor({ masterPromptCode: 't4_master_v1', source: 'config' }).mode).toBe('LEGACY_TEMPLATE');
  });
});

describe('T4C-11 — aucun repli silencieux', () => {
  it('texte sans emplacements en LEGACY_TEMPLATE : échec explicite (MASTER_PROMPT_INVALID), jamais un contexte injecté', async () => {
    t4({ content: FICHIER, execution: sc.LEGACY_EXECUTION });
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await expect(execClassify()).rejects.toMatchObject({ code: 'MASTER_PROMPT_INVALID' });
    expect(fake.calls).toHaveLength(0);
  });
  it('STRUCTURED_CONTEXT, contrat d’entrée introuvable : échec explicite, aucune substitution d’emplacements', async () => {
    t4({ content: LEGACY, execution: { ...STRUCTURE, inputContractVersion: 't4_input_v9' } });
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await expect(execClassify()).rejects.toMatchObject({ code: 'T4_CONTRACT_VERSION_NOT_FOUND' });
    expect(fake.calls).toHaveLength(0);
  });
  it('contrat de sortie absent : T4_OUTPUT_CONTRACT_MISSING avant appel', async () => {
    t4({ content: FICHIER, execution: { ...STRUCTURE, outputContractVersion: null } });
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await expect(execClassify()).rejects.toMatchObject({ code: 'T4_OUTPUT_CONTRACT_MISSING' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('T4C-12 — validateur d’activation (lot 27)', () => {
  it('mode structuré : aucun contrôle d’emplacement ni de titre ; prompt vide bloquant', () => {
    expect(checkMasterPromptContent('T4', 'Tu es T4. Règles métier libres.', STRUCTURE)).toMatchObject({ ok: true, blocking: [] });
    expect(checkMasterPromptContent('T4', '  ', STRUCTURE).blocking.map((i) => i.code)).toEqual(['PROMPT_EMPTY']);
    // Proposition T5 : même règle.
    expect(checkMasterProposal('T4', 'Texte libre', { mode: 'STRUCTURED_CONTEXT' })).toEqual([]);
    expect(checkMasterProposal('T4', 'Texte libre')).not.toEqual([]);
  });
  it('bloquants techniques : contrat d’entrée inconnu, TASK inconnue ou vide, contrat de sortie absent', () => {
    const codes = (e: Partial<typeof STRUCTURE>) => checkMasterPromptContent('T4', FICHIER, { ...STRUCTURE, ...e }).blocking.map((i) => i.code);
    expect(codes({ inputContractVersion: 't4_input_v9' })).toContain('INPUT_CONTRACT_INVALID');
    expect(codes({ allowedTasks: ['CLASSIFY_EVENT', 'INVENTEE'] })).toEqual(['TASKS_INVALID']);
    expect(codes({ allowedTasks: [] })).toEqual(['TASKS_INVALID']);
    expect(codes({ outputContractVersion: null })).toEqual(['OUTPUT_CONTRACT_INVALID']);
    expect(codes({ outputContractVersion: 't4_output_v7' })).toEqual(['OUTPUT_CONTRACT_INVALID']);
  });
  it('mode legacy : contrôles historiques inchangés (emplacements exigés)', () => {
    expect(checkMasterPromptContent('T4', LEGACY, sc.LEGACY_EXECUTION).ok).toBe(true);
    expect(checkMasterPromptContent('T4', FICHIER, sc.LEGACY_EXECUTION).blocking.map((i) => i.code)).toContain('BRANCH_PLACEHOLDER_MISSING');
  });
});

describe('T4C-13 — versions prompt / input / output tracées séparément', () => {
  it('trace : TASK, version et empreinte du prompt, contrat d’entrée, contrat de sortie, modèle, configuration', async () => {
    t4({ content: FICHIER, execution: STRUCTURE, versionNumber: 12 });
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    await execClassify();
    const t = capture.traces[0];
    expect(t).toMatchObject({ model: 'm-a', configVersionId: 41, task: 'CLASSIFY_EVENT' });
    expect(t.structuredContext).toMatchObject({
      mode: 'STRUCTURED_CONTEXT', task: 'CLASSIFY_EVENT', promptHash: sc.promptHash(FICHIER),
      inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1', contextHash: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect(String((t.structuredContext as { promptVersion: string }).promptVersion)).toMatch(/t4_master_v1/);
    expect(t.runtimeContract).toMatchObject({ contractId: 'T4_CLASSIFY_EVENT', contractVersion: 1 });
  });
  it('nouvelle version du prompt sans changement de contrat : input_v1 / output_v1 conservés', async () => {
    fake.onAny(() => ({ rawText: classifyOut, inputTokens: 1, outputTokens: 1 }));
    t4({ content: `${FICHIER}\nU8 — Règle ajoutée.`, execution: STRUCTURE, versionNumber: 13 });
    await execClassify();
    expect(capture.traces[0].structuredContext).toMatchObject({ inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1' });
  });
});

describe('T4C-14 — éditeur BO : contexte disponible (informatif)', () => {
  it('liste task, document_type, agenda_item, event_catalog, event_context, evidence, temporal_candidates, temporal_context', () => {
    const champs = sc.availableContextOf(T4_EXECUTION_SPEC, 't4_input_v1');
    expect(champs.map((c) => c.field).sort()).toEqual(['agenda_item', 'document_type', 'event_catalog', 'event_context', 'evidence', 'task', 'temporal_candidates', 'temporal_context']);
    expect(champs.find((c) => c.field === 'evidence')!.tasks).toEqual([
      { task: 'CLASSIFY_EVENT', requirement: 'optionnel' }, { task: 'VERIFY_COMPLETION', requirement: 'requis' }]);
    const src = readFileSync(join(process.cwd(), 'src/app/admin/ai-config/_components/MasterPromptExecutionPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/insérez|insérer \{\{/i);
  });
});

describe('T4C-15 — aperçu / test : chaque étape inspectable', () => {
  it('prompt maître, TASK, contrat d’entrée, contexte construit, contrat de sortie, sortie brute, résultat validé', async () => {
    const { previewStructured } = await import('../../../master-prompts/master-prompt.service');
    const p = await previewStructured('T4', { versionId: 'file', task: 'CLASSIFY_EVENT', scenarioId: 'P-T4-06' });
    expect(p).toMatchObject({ mode: 'STRUCTURED_CONTEXT', task: 'CLASSIFY_EVENT', scenario: { id: 'P-T4-06' }, contextError: null });
    expect(p.inputContract.version).toBe('t4_input_v1');
    expect(p.context).toContain('07/09/2026');
    expect(p.prompt).toContain('EXECUTION_CONTEXT');
    expect(p.outputContract).toMatchObject({ version: 't4_output_v1', contractId: 'T4_CLASSIFY_EVENT', contractVersion: 1 });
    expect(p.rawOutput).toContain('information');
    expect(p.validated).toMatchObject({ ok: true, data: { homeCategory: 'information' } });
  });
});

describe('T4C-16 — périmètre strictement T4', () => {
  it.each(['t1_master_v1', 't2_master_v1', 't3_master_v1', 't5_master_v1', 't6_master_v1'])('%s : aucun contrat d’exécution, LEGACY_TEMPLATE', (code) => {
    expect(sc.structuredSpecFor(code)).toBeNull();
    expect(sc.executionConfigFor({ masterPromptCode: code, source: 'file' })).toEqual(sc.LEGACY_EXECUTION);
    expect(sc.executionConfigFor({ masterPromptCode: code, source: 'version', stored: { mode: 'STRUCTURED_CONTEXT' } })).toEqual(sc.LEGACY_EXECUTION);
  });
  it('aucune règle métier T4 dans le backend : le contrat ne connaît que des formes de données', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/ai/agenda/master/t4-execution-contract.ts'), 'utf8');
    expect(src).not.toMatch(/FACT_ONLY|DEADLINE|HISTORICAL|fin de contrat|période/i);
  });
});

describe('T4C-NR — facture internet mensuelle 08/08/2026 → 07/09/2026', () => {
  it('prompt corrigé + contexte injecté + contrat de sortie : information (FACT_ONLY), aucune action (IGNORE), jamais une fin de contrat', async () => {
    t4();
    fake.onAny(() => ({ rawText: JSON.stringify(P6.recording.output), inputTokens: 1, outputTokens: 1 }));
    const cand = P6.context.candidate;
    const c = await classifyAgendaEvent({ title: cand.title, originType: 'document', description: cand.excerpt }, { accountId: 1, excerpt: cand.excerpt, date: cand.date });
    // Les règles déterministes ne tranchent pas (« Échéance abonnement internet ») : le master T4 est appelé (une fois).
    expect(fake.calls).toHaveLength(1);
    const p = fake.calls[0].prompt;
    // Règle métier dans le PROMPT (jamais en dur dans le backend).
    expect(p).toContain('Fin de période ≠ fin de contrat');
    expect(contexteDe(p)).toMatchObject({ task: 'CLASSIFY_EVENT', evidence: expect.stringContaining('Période du 08/08/2026 au 07/09/2026') });
    // Résultat : FACT_ONLY (information, aucun type métier « fin de contrat »), IGNORE (aucune action à traiter).
    expect(c).toMatchObject({ category: 'information', source: 'model', businessType: null });
    expect(c.businessType).not.toBe('contract');
    expect(prudentCategory(c, { date: cand.date, today: '2026-10-09' })).toEqual({ category: 'information', requiresQualification: false });
  });
});
