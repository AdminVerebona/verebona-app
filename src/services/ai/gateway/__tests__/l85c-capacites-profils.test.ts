/**
 * Lot 85C — CDC Pilotage IA V2, phase P4 « capacités et profils par
 * opération » : tests PURS (constructeur, profils, couverture) et tests de la
 * PASSERELLE réelle avec fournisseur simulé.
 *
 *   L85C-U01  construction de requête par MODÈLE (fiche niveaux / budget /
 *             sans raisonnement / inconnue) et par PROFIL (plafond par rang,
 *             plancher, plafond d'appelant, adaptation à la limite du modèle)
 *   L85C-U02  combinaison incompatible REFUSÉE AVANT APPEL (catégorie
 *             explicite, aucun appel, le repli prend le relais ; chaîne
 *             entièrement refusée sans faire avancer le disjoncteur)
 *   L85C-U03  plus AUCUNE déduction par le nom du modèle (fiches croisées,
 *             nom trompeur, garde statique sur les sources)
 *   L85C-U04  profils par opération : forme canonique, contrôles, héritage,
 *             décalage des emplacements, validation de configuration
 *   L85C-U05  R33 — couverture générée du registre (14 opérations métier,
 *             evaluate_prompt technique — décision 03 —, nouvelle opération
 *             non couverte → échec)
 *   L85C-U06  R35 / R03 — profils distincts GROUP_UPLOAD / ANALYZE_DOCUMENT ;
 *             chaque rang reçoit son profil (passerelle)
 *   L85C-U07  fiche de capacités : priorités API / référence / sonde,
 *             empreinte indépendante des dates, changements nommés
 *   L85C-U08  qualification : épreuves par le constructeur unique, paramètre
 *             refusé = incompatibilité de réglage (R45), profil alternatif ;
 *             Preview jamais qualifié (décision 02)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const h = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>>, outcomes: [] as Array<Record<string, unknown>> }));
vi.mock('../diagnostics/diagnostic.repository', async (orig) => ({
  ...(await orig<typeof import('../diagnostics/diagnostic.repository')>()),
  recordCallDiagnostic: vi.fn(async () => undefined),
}));
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: vi.fn(async (t: Record<string, unknown>) => { h.traces.push(t); return h.traces.length; }),
}));
vi.mock('../../queue/circuit-breaker.repository', async (orig) => ({
  ...(await orig<typeof import('../../queue/circuit-breaker.repository')>()),
  noteGatewayOutcome: vi.fn((o: Record<string, unknown>) => { h.outcomes.push(o); }),
}));

const { AiGateway } = await import('../ai-gateway');
const { FakeProvider, setAiProvider } = await import('../providers');
const { buildModelRequest } = await import('../request-builder');
const { buildGenerationConfig } = await import('../providers/gemini-generation-config');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');
const { __setModelCapabilityLoaderForTests } = await import('../../provider/model-capabilities.repository');
const C = await import('../../provider/model-capabilities');
const P = await import('../../config/operation-profiles');
const { operationRequestPlan, treatmentRequestPlan } = await import('../../config/profile-check');
const { validateTreatment } = await import('../../config/config-validation.service');
const { AI_OPERATIONS, listLlmOperations } = await import('../../registry/operations');
const { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } = await import('./t1-master-request');

type Caps = import('../../provider/model-capabilities').ModelCapabilities;
const fiche = (model: string, over: Partial<Caps> = {}): Caps => ({ ...C.effectiveCapabilities(model, null), ...over });
const NIVEAUX = { mode: 'level' as const, levels: ['minimal', 'low', 'medium', 'high'], map: { minimal: 'minimal', 'étendu': 'high' } };
const BUDGET = { mode: 'budget' as const, min: 512, max: 8192, map: { minimal: 512, 'étendu': 8192 } };

// ── Passerelle : configuration et fournisseur simulés ───────────────────────
const Schema = t1Schema({ ok: z.boolean() });
let fake: InstanceType<typeof FakeProvider>;
type Trace = Record<string, unknown> & { status: string; errorCode?: string; model: string; failure?: { subtype: string | null; parameter?: string }; capture?: { callKind: string; params: Record<string, any> } };
const traces = () => h.traces as Trace[];
const req = (over: Record<string, unknown> = {}) => ({
  useCaseCode: 'SOURCE_ANALYSIS' as const, operationCode: T1_TEST_OPERATION, accountId: 7, userId: 3,
  sourceIds: [42], promptVariables: t1TestVariables('facture'), outputSchema: Schema, idempotencyKey: `l85c-${Math.random()}`,
  ...over,
});
function t1(over: Partial<import('../../config/config-types').TreatmentConfig>) {
  return { ...emptyTreatmentConfig('T1'), primaryModel: 'gemini-2.5-flash', fallback1: null, fallback2: null, reasoningPrimary: 'standard' as const, maxOutputTokens: 4000, ...over };
}
/** Données « catalogue » (API Models) injectées dans le registre des capacités. */
function catalogue(entries: Array<[string, import('../../provider/model-capabilities').StoredCapabilityInputs['api']]>) {
  __setModelCapabilityLoaderForTests(async () => new Map(entries.map(([model, api]) => [model, { model, api }])));
}

beforeEach(() => {
  h.traces.length = 0;
  h.outcomes.length = 0;
  fake = new FakeProvider();
  setAiProvider(fake);
});
afterEach(() => {
  __setConfigForTests(null);
  __setModelCapabilityLoaderForTests(async () => new Map());
});

describe('L85C-U01 — construction de requête par modèle et par profil', () => {
  it('fiche « niveaux » : niveau administré projeté sur le niveau documenté ; standard = défaut', () => {
    const cap = fiche('modele-a', { thinking: NIVEAUX });
    const r = buildModelRequest({ model: 'modele-a', capabilities: cap, reasoning: 'minimal' });
    expect(r.ok && r.params.thinking).toEqual({ thinkingLevel: 'minimal' });
    const s = buildModelRequest({ model: 'modele-a', capabilities: cap, reasoning: 'standard' });
    expect(s.ok && s.params.thinking).toBeNull();
  });
  it('fiche « budget » : budget documenté du modèle', () => {
    const r = buildModelRequest({ model: 'modele-b', capabilities: fiche('modele-b', { thinking: BUDGET }), reasoning: 'étendu' });
    expect(r.ok && r.params.thinking).toEqual({ thinkingBudget: 8192 });
  });
  it('modèle qui ne raisonne pas : « minimal » sans effet (adaptation tracée)', () => {
    const r = buildModelRequest({ model: 'modele-c', capabilities: fiche('modele-c', { thinking: { mode: 'none' } }), reasoning: 'minimal' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.params.thinking).toBeNull();
    expect(r.trace.adaptations).toContainEqual(expect.objectContaining({ parameter: 'reasoning', reason: 'MODEL_DOES_NOT_THINK' }));
  });
  it('capacité inconnue : rien n’est inventé, adaptation CAPABILITY_UNKNOWN tracée', () => {
    const r = buildModelRequest({ model: 'modele-inconnu', reasoning: 'étendu', maxOutputTokens: 900 });
    expect(r.ok && r.params).toEqual({ temperature: null, maxOutputTokens: 900, thinking: null });
    expect(r.trace.adaptations.map((a) => `${a.parameter}:${a.reason}`)).toEqual(['reasoning:CAPABILITY_UNKNOWN', 'temperature:CAPABILITY_UNKNOWN']);
  });
  it('plafond : plancher de l’opération, plafond d’appelant, puis ADAPTÉ à la limite du modèle (décision 08), tracé', () => {
    const cap = fiche('modele-d', { outputTokenLimit: 8000 });
    const r = buildModelRequest({ model: 'modele-d', capabilities: cap, maxOutputTokens: 12_000, maxOutputTokensOrigin: 'treatment' });
    expect(r.ok && r.params.maxOutputTokens).toBe(8000);
    expect(r.trace.maxOutputTokens).toMatchObject({ requested: 12_000, origin: 'treatment', modelLimit: 8000, adapted: 8000, sent: 8000 });
    expect(r.trace.adaptations).toContainEqual(expect.objectContaining({ parameter: 'maxOutputTokens', reason: 'MODEL_OUTPUT_LIMIT', requested: 12_000, sent: 8000 }));
    const plancher = buildModelRequest({ model: 'modele-d', capabilities: cap, maxOutputTokens: 1000, minOutputTokens: 4000, callerCap: 3000 });
    expect(plancher.ok && plancher.params.maxOutputTokens).toBe(3000);
  });
  it('température : profil de la famille documentée (0), plage de l’API sinon, refus de sonde respecté', () => {
    expect(buildModelRequest({ model: 'gemini-3.6-flash' }).ok && (buildModelRequest({ model: 'gemini-3.6-flash' }) as any).params.temperature).toBe(0);
    const api = C.effectiveCapabilities('modele-api', { model: 'modele-api', api: { maxTemperature: 2, temperature: 1 } });
    expect((buildModelRequest({ model: 'modele-api', capabilities: api }) as any).params.temperature).toBe(0);
    const refusee = C.effectiveCapabilities('gemini-3.6-flash', { model: 'gemini-3.6-flash', probe: { rejected: ['generationConfig.temperature=0'] } });
    const r = buildModelRequest({ model: 'gemini-3.6-flash', capabilities: refusee });
    expect(r.ok && r.params.temperature).toBeNull();
    expect(r.trace.adaptations).toContainEqual(expect.objectContaining({ reason: 'TEMPERATURE_REJECTED_BY_PROBE' }));
  });
});

describe('L85C-U02 — combinaison incompatible refusée AVANT appel', () => {
  it('constructeur : niveau absent / refusé par sonde, budget hors bornes, « étendu » sans raisonnement, limite < plancher, image refusée', () => {
    const refus = (cap: Caps, i: Partial<Parameters<typeof buildModelRequest>[0]>) => {
      const r = buildModelRequest({ model: cap.model, capabilities: cap, ...i });
      return r.ok ? null : r.refusal;
    };
    expect(refus(fiche('a', { thinking: { mode: 'level', levels: ['high'], map: { minimal: 'low', 'étendu': 'high' } } }), { reasoning: 'minimal' }))
      .toMatchObject({ code: 'MODEL_PARAMETERS_INCOMPATIBLE', parameter: 'generationConfig.thinkingConfig.thinkingLevel', requested: 'low' });
    expect(refus(fiche('b', { thinking: NIVEAUX, rejected: ['generationConfig.thinkingConfig.thinkingLevel=high'] }), { reasoning: 'étendu' }))
      .toMatchObject({ parameter: 'generationConfig.thinkingConfig.thinkingLevel' });
    expect(refus(fiche('c', { thinking: { mode: 'budget', min: 128, max: 1024, map: { minimal: 0, 'étendu': 1024 } } }), { reasoning: 'minimal' }))
      .toMatchObject({ parameter: 'generationConfig.thinkingConfig.thinkingBudget' });
    expect(refus(fiche('d', { thinking: { mode: 'none' } }), { reasoning: 'étendu' })).toMatchObject({ parameter: 'generationConfig.thinkingConfig' });
    expect(refus(fiche('e', { outputTokenLimit: 8192 }), { minOutputTokens: 32_768 })).toMatchObject({ parameter: 'generationConfig.maxOutputTokens' });
    expect(refus(fiche('f', { modalities: { imageInput: false, structuredOutput: true } }), { needsImageInput: true })).toMatchObject({ parameter: 'contents.inlineData' });
  });

  it('adaptateur : refus = erreur MODEL_PARAMETERS_INCOMPATIBLE récupérable, étape request_build, aucun generationConfig', () => {
    catalogue([]);
    let err: any;
    try { buildGenerationConfig({ model: 'gemini-2.5-pro', reasoning: 'étendu', generation: undefined }); } catch (e) { err = e; }
    expect(err).toBeUndefined();
    C.setStoredCapabilityInputs(new Map([['m-sans', { model: 'm-sans', api: { supportsThinking: false } }]]));
    try { buildGenerationConfig({ model: 'm-sans', reasoning: 'étendu' }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'MODEL_PARAMETERS_INCOMPATIBLE', recoverable: true, aiStage: 'request_build', rejectedParameter: 'generationConfig.thinkingConfig' });
    C.setStoredCapabilityInputs(new Map());
  });

  it('passerelle : principal refusé avant appel (catégorie explicite, journal), repli appelé avec SON profil', async () => {
    catalogue([['modele-sans-raisonnement', { supportsThinking: false, maxTemperature: 2 }]]);
    __setConfigForTests({ versionId: 1, entries: [t1({ primaryModel: 'modele-sans-raisonnement', reasoningPrimary: 'étendu', fallback1: 'gemini-2.5-flash', reasoningFallback1: 'minimal' })] });
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 3, outputTokens: 2 }));
    const r = await AiGateway.execute(req());
    expect(r.model).toBe('gemini-2.5-flash');
    // Aucun appel au modèle refusé.
    expect(fake.calls.map((c) => c.model)).toEqual(['gemini-2.5-flash']);
    expect(fake.calls[0].generation).toEqual({ temperature: 0, maxOutputTokens: 4000, thinking: { thinkingBudget: 0 } });
    const [refus, ok] = traces();
    expect(refus).toMatchObject({ model: 'modele-sans-raisonnement', status: 'error', errorCode: 'MODEL_PARAMETERS_INCOMPATIBLE', inputTokens: 0, costMicros: 0, billable: false });
    expect(refus.failure).toMatchObject({ family: 'INPUT_ERROR', subtype: 'PARAMETER_INCOMPATIBLE', parameter: 'generationConfig.thinkingConfig' });
    expect(refus.capture).toMatchObject({ callKind: 'pre_call_refusal', sent: [] });
    expect(ok).toMatchObject({ status: 'success', model: 'gemini-2.5-flash' });
  });

  it('passerelle : chaîne entièrement refusée → ALL_MODELS_FAILED (dernier code explicite), 0 appel, disjoncteur non avancé', async () => {
    catalogue([['m1', { supportsThinking: false }], ['m2', { supportsThinking: false }]]);
    __setConfigForTests({ versionId: 1, entries: [t1({ primaryModel: 'm1', reasoningPrimary: 'étendu', fallback1: 'm2', reasoningFallback1: 'étendu' })] });
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    await expect(AiGateway.execute(req())).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED', lastFailureCode: 'MODEL_PARAMETERS_INCOMPATIBLE' });
    expect(fake.calls).toHaveLength(0);
    expect(traces().map((t) => t.errorCode)).toEqual(['MODEL_PARAMETERS_INCOMPATIBLE', 'MODEL_PARAMETERS_INCOMPATIBLE']);
    expect(h.outcomes.at(-1)).toMatchObject({ attempts: [], chainSucceeded: null });
  });
});

describe('L85C-U03 — aucune déduction par le nom du modèle', () => {
  it('un nom « de famille 3 » avec une fiche budget reçoit un budget ; un nom quelconque avec une fiche niveaux reçoit un niveau', () => {
    const trompeur = buildModelRequest({ model: 'gemini-3-pro', capabilities: fiche('gemini-3-pro', { thinking: BUDGET }), reasoning: 'minimal' });
    expect(trompeur.ok && trompeur.params.thinking).toEqual({ thinkingBudget: 512 });
    const quelconque = buildModelRequest({ model: 'zz-modele', capabilities: fiche('zz-modele', { thinking: NIVEAUX }), reasoning: 'étendu' });
    expect(quelconque.ok && quelconque.params.thinking).toEqual({ thinkingLevel: 'high' });
  });
  it('un nom proche d’une référence n’hérite de rien (identifiant exact seulement) ; le baseModelId de l’API fait le lien', () => {
    expect(C.effectiveCapabilities('gemini-3.6-flash-002', null)).toMatchObject({ family: null, thinking: { mode: 'unknown' } });
    expect(buildGenerationConfig({ model: 'gemini-3.9-flash', reasoning: 'étendu' })).not.toHaveProperty('thinkingConfig');
    expect(buildGenerationConfig({ model: 'gemini-2.5-pro-latest', reasoning: 'minimal' })).not.toHaveProperty('thinkingConfig');
    const lie = C.effectiveCapabilities('gemini-3.6-flash-002', { model: 'gemini-3.6-flash-002', api: { baseModelId: 'gemini-3.6-flash' } });
    expect(lie).toMatchObject({ family: 'gemini-3', thinking: { mode: 'level' } });
  });
  it('garde statique : ni motif, ni préfixe, ni expression régulière sur un nom de modèle dans la construction des requêtes', () => {
    const code = (f: string) => readFileSync(join(process.cwd(), f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of ['src/services/ai/gateway/request-builder.ts', 'src/services/ai/gateway/providers/gemini-generation-config.ts', 'src/services/ai/config/operation-profiles.ts', 'src/services/ai/config/profile-check.ts']) {
      expect(code(f), f).not.toMatch(/['"`/^]gemini-|gemini-\d|\.startsWith\(|new RegExp/i);
    }
    const capacites = code('src/services/ai/provider/model-capabilities.ts');
    // Références : recherche par identifiant EXACT (Map) — aucune lecture du nom.
    expect(capacites).not.toMatch(/\b(model|name|baseModelId|id)\??\.(startsWith|endsWith|match|includes|indexOf|toLowerCase|split)\(|new RegExp|\.test\(\s*(model|name)/);
  });
});

describe('L85C-U04 — profils par opération et par rang', () => {
  it('forme canonique : opérations connues, emplacements nettoyés, profils vides retirés', () => {
    expect(P.normalizeOperationProfiles({
      t1_analyze_document: { reasoningByRank: ['étendu', null, null], maxOutputTokensByRank: [null, 9000], timeoutMs: 60_000 },
      inconnue: { timeoutMs: 5 }, collect_evidence: { timeoutMs: 5000 }, t1_group_upload: { reasoningByRank: [null, 'bizarre'] },
    })).toEqual({ t1_analyze_document: { reasoningByRank: ['étendu'], maxOutputTokensByRank: [null, 9000], timeoutMs: 60_000 } });
  });
  it('contrôles : opération d’un autre traitement, niveau inconnu, délai hors bornes du registre', () => {
    const issues = P.validateOperationProfiles('T1', {
      t2_answer: {}, t1_group_upload: { reasoningByRank: ['fou'] }, t1_analyze_document: { timeoutMs: 999_999 },
    });
    expect(issues.map((i) => `${i.operationCode}:${i.field}`)).toEqual(['t2_answer:operation', 't1_group_upload:reasoningByRank', 't1_analyze_document:timeoutMs']);
  });
  it('héritage explicite : rang propre, puis principal de l’opération, puis traitement ; délai borné', () => {
    const op = AI_OPERATIONS.t1_analyze_document;
    const cfg = { reasoningByRank: ['standard', 'minimal'], maxOutputTokens: 40_000, configVersionId: 3, operationProfile: { maxOutputTokensByRank: [50_000, null], reasoningByRank: [null, 'étendu'] as Array<'étendu' | null>, timeoutMs: 999_999 } };
    expect(P.rankProfile(op, cfg, 0)).toMatchObject({ reasoning: 'standard', reasoningOrigin: 'treatment', maxOutputTokens: 50_000, maxOutputTokensOrigin: 'operation', timeoutMs: op.timeoutMs });
    expect(P.rankProfile(op, cfg, 1)).toMatchObject({ reasoning: 'étendu', reasoningOrigin: 'operation', maxOutputTokens: 50_000, maxOutputTokensOrigin: 'operation' });
    expect(P.rankProfile(op, { ...cfg, operationProfile: null }, 1)).toMatchObject({ maxOutputTokens: 40_000, maxOutputTokensOrigin: 'treatment', timeoutOrigin: 'registry' });
  });
  it('repli 1 absent : les emplacements suivants se décalent comme la chaîne', () => {
    expect(P.profileForChain({ maxOutputTokensByRank: [1000, 2000, 3000] }, [true, false, true])).toEqual({ maxOutputTokensByRank: [1000, 3000] });
  });
  it('validation de configuration (constructeur unique) : refus connu bloquant, adaptation signalée', () => {
    const cat = { availableModels: new Set(['gemini-2.5-flash', 'm-limite']), pricedModels: new Set(['gemini-2.5-flash', 'm-limite']), guardrailCodes: new Set<string>(), triggerCodes: new Set(['source_uploaded']) };
    const limite = (m: string) => (m === 'm-limite' ? fiche(m, { outputTokenLimit: 16_000 }) : C.capabilitiesOf(m));
    const entry = t1({ primaryModel: 'gemini-2.5-flash', fallback1: 'm-limite', reasoningFallback1: 'étendu', triggers: [{ kind: 'event', code: 'source_uploaded', active: true }] });
    const issues = validateTreatment(entry, { ...cat, capabilities: limite });
    // t1_analyze_document exige 32 768 jetons de sortie : la limite de 16 000 l'empêche (bloquant).
    expect(issues).toContainEqual(expect.objectContaining({ field: 'fallback1', blocking: true, message: expect.stringMatching(/t1_analyze_document \(repli 1, « m-limite »\).*sortie exhaustive impossible/) }));
    // Raisonnement de m-limite inconnu : signalé, non bloquant.
    expect(issues).toContainEqual(expect.objectContaining({ field: 'fallback1', blocking: false, message: expect.stringMatching(/t1_group_upload.*capacité « reasoning » inconnue/) }));
  });
});

describe('L85C-U05 — R33 : couverture générée du registre', () => {
  /** Référentiel de départ du CDC (§4.1) : jeu de RECETTE, pas un second référentiel applicatif. */
  const CDC_14 = ['t1_group_upload', 't1_analyze_document', 't2_understand', 't2_answer', 't2_revalidate', 't3_value_conflict', 't3_link_ambiguity',
    't3_operation_match', 't3_document_naming', 't4_classify_event', 't4_verify_completion', 't4_temporal_ambiguity', 't6_formulate', 't6_evaluate'];

  it('les 14 opérations métier sont couvertes ; evaluate_prompt reste technique (AI_GOVERNANCE, active — décision 03) ; rien de non couvert', () => {
    const cov = P.operationProfileCoverage();
    // Intégration lot 85 : 85F ajoute l'opération métier T3 `t3_knowledge_query` (branche KNOWLEDGE_QUERY, en attente de l'équipe IA).
    expect(cov.business.map((b) => b.operationCode).sort()).toEqual([...CDC_14, 't3_knowledge_query'].sort());
    expect(cov.technical).toEqual(['evaluate_prompt']);
    expect(AI_OPERATIONS.evaluate_prompt).toMatchObject({ useCaseCode: 'AI_GOVERNANCE', active: true });
    expect(cov.uncovered).toEqual([]);
  });

  // Une entrée de test PAR opération modèle du registre (générée, jamais recopiée).
  for (const op of listLlmOperations()) {
    it(`${op.operationCode} : profil résolu et requête construite à chaque rang de sa chaîne du code, pour chaque niveau`, () => {
      const cov = P.operationProfileCoverage();
      const metier = cov.business.find((b) => b.operationCode === op.operationCode);
      if (!metier) { expect(cov.technical).toContain(op.operationCode); return; }
      for (const niveau of ['minimal', 'standard', 'étendu'] as const) {
        const entry = { ...emptyTreatmentConfig(metier.treatment), primaryModel: op.primaryModel, fallback1: op.fallbackModels[0] ?? null, fallback2: op.fallbackModels[1] ?? null, reasoningPrimary: niveau, reasoningFallback1: niveau, reasoningFallback2: niveau, maxOutputTokens: null };
        const plan = operationRequestPlan(entry, op);
        expect(plan.length).toBe(1 + Math.min(2, op.fallbackModels.length));
        for (const p of plan) expect(p.result.ok, `${op.operationCode} ${p.model} ${niveau}`).toBe(true);
      }
    });
  }

  it('une nouvelle opération modèle rattachée à aucun traitement → non couverte (la recette échoue)', () => {
    const ops = { ...AI_OPERATIONS, t9_nouvelle: { ...AI_OPERATIONS.t2_answer, operationCode: 't9_nouvelle', useCaseCode: 'USAGE_INCONNU' as never } };
    expect(P.operationProfileCoverage(ops).uncovered).toEqual(['t9_nouvelle']);
  });
});

describe('L85C-U06 — R35 / R03 : profils distincts par opération, profil propre par rang', () => {
  it('GROUP_UPLOAD et ANALYZE_DOCUMENT peuvent recevoir des profils différents (même traitement)', () => {
    const entry = t1({ primaryModel: 'gemini-2.5-flash', reasoningPrimary: 'minimal', operationProfiles: { t1_analyze_document: { reasoningByRank: ['étendu'], maxOutputTokensByRank: [60_000] } } });
    const plan = treatmentRequestPlan(entry);
    const g = plan.find((p) => p.operationCode === 't1_group_upload')!;
    const a = plan.find((p) => p.operationCode === 't1_analyze_document')!;
    expect(g.result.ok && g.result.params).toMatchObject({ thinking: { thinkingBudget: 0 }, maxOutputTokens: 4000 });
    // 60 000 > limite documentée 65 536 ? non → envoyé tel quel ; plancher 32 768 respecté.
    expect(a.result.ok && a.result.params).toMatchObject({ thinking: { thinkingBudget: 24_576 }, maxOutputTokens: 60_000 });
  });

  it('passerelle : le repli reçoit SON plafond et SON niveau (aucun plafond hérité invalide)', async () => {
    catalogue([['gemini-2.5-flash', { outputTokenLimit: 65_536, maxTemperature: 2 }]]);
    __setConfigForTests({ versionId: 1, entries: [t1({
      primaryModel: 'gemini-2.5-pro', reasoningPrimary: 'minimal', fallback1: 'gemini-2.5-flash', reasoningFallback1: 'minimal', maxOutputTokens: 90_000,
      operationProfiles: { [T1_TEST_OPERATION]: { maxOutputTokensByRank: [null, 2000], reasoningByRank: [null, 'étendu'] } },
    })] });
    fake.on('gemini-2.5-pro', () => { throw Object.assign(new Error('503 UNAVAILABLE'), { status: 503 }); });
    fake.on('gemini-2.5-flash', () => ({ rawText: t1Out({ ok: true }), inputTokens: 1, outputTokens: 1 }));
    await AiGateway.execute(req());
    const [pro, flash] = fake.calls;
    // Principal : 90 000 demandés, ramenés à la limite documentée (65 536) — adaptation tracée.
    expect(pro.generation).toEqual({ temperature: 0, maxOutputTokens: 65_536, thinking: { thinkingBudget: 128 } });
    expect(flash.generation).toEqual({ temperature: 0, maxOutputTokens: 2000, thinking: { thinkingBudget: 24_576 } });
    const p0 = traces()[0].capture!.params;
    expect(p0.maxOutputTokens).toMatchObject({ requested: 90_000, modelLimit: 65_536, adapted: 65_536 });
    expect(p0.adaptations).toContainEqual(expect.objectContaining({ reason: 'MODEL_OUTPUT_LIMIT' }));
    expect(traces()[1].capture!.params.maxOutputTokens).toMatchObject({ requested: 2000, origin: 'operation_rank', sent: 2000 });
  });
});

describe('L85C-U07 — fiche de capacités', () => {
  it('API « thinking: false » fait foi sur la référence ; limites de l’API prioritaires ; sources nommées', () => {
    const c = C.effectiveCapabilities('gemini-2.5-flash', { model: 'gemini-2.5-flash', api: { supportsThinking: false, outputTokenLimit: 32_000, checkedAt: '2026-10-24T07:15:00Z' } });
    expect(c.thinking).toEqual({ mode: 'none' });
    expect(c.outputTokenLimit).toBe(32_000);
    expect(c.sources).toMatchObject({ thinking: { source: 'api' }, outputTokenLimit: { source: 'api', verifiedAt: '2026-10-24T07:15:00Z' }, family: { source: 'reference' } });
  });
  it('empreinte indépendante des dates de vérification (R46) ; changement réel nommé', () => {
    const a = C.effectiveCapabilities('gemini-3.6-flash', { model: 'gemini-3.6-flash', api: { outputTokenLimit: 65_536, checkedAt: '2026-10-23T07:15:00Z' } });
    const b = C.effectiveCapabilities('gemini-3.6-flash', { model: 'gemini-3.6-flash', api: { outputTokenLimit: 65_536, checkedAt: '2026-10-24T07:15:00Z' } });
    expect(C.capabilitiesSha256(a)).toBe(C.capabilitiesSha256(b));
    const c2 = C.effectiveCapabilities('gemini-3.6-flash', { model: 'gemini-3.6-flash', api: { outputTokenLimit: 32_768 } });
    expect(C.capabilitiesSha256(c2)).not.toBe(C.capabilitiesSha256(a));
    expect(C.diffCapabilities(a, c2).map((d) => d.field)).toEqual(['outputTokenLimit']);
  });
});

describe('L85C-U08 — qualification par le constructeur unique, R45, Preview', () => {
  it('paramètre refusé à l’épreuve de raisonnement : relevé, profil alternatif essayé, jamais une indisponibilité', async () => {
    const Q = await import('../../provider/model-qualification.service');
    const appels: Array<{ reasoning?: string | null; generation?: unknown }> = [];
    const call = vi.fn(async (i: any) => {
      appels.push({ reasoning: i.reasoning, generation: i.generation });
      if (i.generation?.thinking?.thinkingLevel === 'high') {
        throw Object.assign(new Error('{"error":{"code":400,"message":"Unable to process input: thinking_level high is not supported for this model","status":"INVALID_ARGUMENT"}}'), { status: 400 });
      }
      return { rawText: i.responseSchema ? '{"ok":true,"mot":"verebona"}' : i.attachments?.length ? 'Rouge' : '51' };
    });
    const r = await Q.qualifyModel('modele-x', call, { capabilities: fiche('modele-x', { thinking: { mode: 'level', levels: ['low', 'high'], map: { minimal: 'low', 'étendu': 'high' } } }) });
    expect(r).toMatchObject({ generate: true, thinking: true, rejectedParameters: ['generationConfig.thinkingConfig.thinkingLevel=high'] });
    // Chaque épreuve porte les paramètres du constructeur unique.
    expect(appels.every((a) => a.generation !== undefined)).toBe(true);
    expect(appels.filter((a) => (a.generation as any)?.thinking?.thinkingLevel === 'high')).toHaveLength(1);
  });
  it('génération : niveau refusé → même épreuve sans réglage ; le modèle reste qualifié', async () => {
    const Q = await import('../../provider/model-qualification.service');
    const call = vi.fn(async (i: any) => {
      if (i.generation?.thinking) throw Object.assign(new Error('{"error":{"code":400,"message":"thinking_budget 0 is invalid","status":"INVALID_ARGUMENT"}}'), { status: 400 });
      return { rawText: i.responseSchema ? '{"ok":true,"mot":"verebona"}' : 'OK' };
    });
    const r = await Q.qualifyModel('modele-y', call, { capabilities: fiche('modele-y', { thinking: { mode: 'budget', min: 0, max: 100, map: { minimal: 0, 'étendu': 100 } } }) });
    expect(r.generate).toBe(true);
    expect(r.rejectedParameters).toEqual(expect.arrayContaining(['generationConfig.thinkingConfig.thinkingBudget=0']));
  });
  it('Preview : jamais dans l’ordre de qualification (décision 02, R01, R69)', async () => {
    const { qualificationOrder } = await import('../../provider/ai-catalog-sync.service');
    expect(qualificationOrder([{ model: 'gemini-9-pro-preview', lifecycle: 'preview' }, { model: 'gemini-9-flash', lifecycle: 'stable' }], { active: new Set(), declared: new Set(), discovered: new Set(['gemini-9-pro-preview', 'gemini-9-flash']) }))
      .toEqual(['gemini-9-flash']);
  });
});
