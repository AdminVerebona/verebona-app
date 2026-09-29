/**
 * Prompt maître T1, aiguillage et observation — CDC 15 §23, §22.2, §29,
 * T1-06, T1-07, D-04, D-18.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const analyse = vi.hoisted(() => vi.fn());
vi.mock('../analyse-group-master', () => ({ analyseGroupWithMaster: (...a: unknown[]) => analyse(...a) }));

const {
  resolveT1Route, t1ShadowSampleRate, sampledForShadow, DEFAULT_T1_SHADOW_SAMPLE_RATE,
} = await import('../analysis-mode');
const { compareT1Results, scheduleT1Shadow, settleT1Shadows } = await import('../shadow');
const { T1_PROMPT_VARIABLES } = await import('../prompt-context');
const { checkMasterTemplate, inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { rolloutSnapshot } = await import('@/services/canonical/rollout');

const MASTER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');

describe('t1_master_v1.txt — transcription du §23', () => {
  it('structure master : {{TASK}}, les deux branches, exactement les emplacements fournis par le serveur', () => {
    expect(checkMasterTemplate(MASTER, ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'])).toEqual([]);
    const info = inspectMasterTemplate(MASTER);
    expect(info.placeholders.sort()).toEqual(['TASK', ...T1_PROMPT_VARIABLES].sort());
    expect(info.branches).toEqual(['GROUP_UPLOAD', 'ANALYZE_DOCUMENT']);
  });

  it('règles universelles U1 à U18, dans l’ordre', () => {
    const positions = Array.from({ length: 18 }, (_, i) => MASTER.indexOf(`U${i + 1} — `));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('T1-06 : « Dernier entretien » illustre lastRevision, jamais maintenanceDueDate', () => {
    const u15 = MASTER.slice(MASTER.indexOf('U15 — '), MASTER.indexOf('U16 — '));
    expect(u15).toContain('« Dernier entretien : 15/11/2026 » établit une date d’entretien réalisé (`lastRevision`');
    const exemple = MASTER.slice(MASTER.indexOf('"canonicalKey": "lastRevision"'));
    expect(exemple).toContain('"excerpt": "Dernier entretien : 15/11/2026"');
    expect(MASTER).not.toMatch(/"canonicalKey": "maintenanceDueDate"[^}]*Dernier entretien/);
  });

  it('T1-07 : probable = lecture incertaine, jamais une inférence', () => {
    const u11 = MASTER.slice(MASTER.indexOf('U11 — '), MASTER.indexOf('U12 — '));
    expect(u11).toContain('JAMAIS une inférence');
    expect(u11).not.toMatch(/déductible/);
  });

  it('T1-03 : plus de « tout en centimes » ; amountCents seul en centimes', () => {
    expect(MASTER).not.toMatch(/Montants : en centimes/);
    expect(MASTER).toContain('ne multiplie jamais une valeur métier par 100');
  });

  it('les champs du JSON d’exemple sont ceux du contrat Zod', () => {
    for (const cle of ['"canonicalKey"', '"rawKey"', '"rawValue"', '"normalizedValue"', '"valueType"', '"canonicalUnit"',
      '"target"', '"provenance"', '"evidence"', '"visualEvidence"', '"semanticEvent"', '"hasExploitableContent"',
      '"classification"', '"canonicalType"', '"rubricCode"', '"documentTypeCode"', '"multiAsset"', '"evidenceSignals"']) {
      expect(MASTER).toContain(cle);
    }
    // Le contrat porte la preuve d'une métadonnée dans `evidence` (pas d'`excerpt` à plat).
    expect(MASTER).toContain('"documentDate": {"value": "2026-04-24", "confidence": "certain", "evidence": {"excerpt"');
  });
});

describe('aiguillage AI_T1_ANALYSIS_MODE', () => {
  const master = async () => 'master' as const;
  const steps = async () => 'steps' as const;

  it('legacy par défaut, et pour une valeur invalide', async () => {
    expect(await resolveT1Route({ env: {}, architecture: master })).toBe('steps');
    expect(await resolveT1Route({ env: { AI_T1_ANALYSIS_MODE: 'oui' }, architecture: master })).toBe('steps');
  });

  it('shadow : sur échantillon seulement', async () => {
    const env = { AI_T1_ANALYSIS_MODE: 'shadow', AI_T1_SHADOW_SAMPLE_RATE: '0.25' };
    expect(await resolveT1Route({ env, random: () => 0.1 })).toBe('steps+shadow');
    expect(await resolveT1Route({ env, random: () => 0.9 })).toBe('steps');
  });

  it('enabled : master seulement si la version de configuration le déclare (D-04)', async () => {
    const env = { AI_T1_ANALYSIS_MODE: 'enabled' };
    expect(await resolveT1Route({ env, architecture: master })).toBe('master');
    expect(await resolveT1Route({ env, architecture: steps })).toBe('steps');
  });

  it('taux d’échantillonnage : défaut 0,1, borné, une faute de frappe ne passe jamais à 100 %', () => {
    expect(t1ShadowSampleRate({})).toBe(DEFAULT_T1_SHADOW_SAMPLE_RATE);
    expect(t1ShadowSampleRate({ AI_T1_SHADOW_SAMPLE_RATE: '0,5' })).toBe(0.5);
    expect(t1ShadowSampleRate({ AI_T1_SHADOW_SAMPLE_RATE: '7' })).toBe(1);
    expect(t1ShadowSampleRate({ AI_T1_SHADOW_SAMPLE_RATE: 'tout' })).toBe(DEFAULT_T1_SHADOW_SAMPLE_RATE);
    expect(sampledForShadow(0, () => 0)).toBe(false);
    expect(sampledForShadow(1, () => 0.99)).toBe(true);
  });

  it('commutateur déclaré branché', () => {
    expect(rolloutSnapshot({}).find((s) => s.name === 'AI_T1_ANALYSIS_MODE')).toMatchObject({ wired: true, mode: 'legacy' });
  });
});

describe('mode observation', () => {
  const legacy = {
    sourceGroup: { sourceIds: [1], leadSourceId: 1 },
    document: { type: { value: 'FACTURE', confidence: 'certain' as const, excerpt: '', location: {} } },
    assetCandidates: [], roomCandidates: [], equipmentCandidates: [],
    extractedFields: [
      { fieldKey: 'purchaseDate', value: '2026-04-24', confidence: 'certain' as const },
      { fieldKey: 'kilometrage', value: 78000, confidence: 'certain' as const },
      { fieldKey: 'boilerPower', value: 24, confidence: 'certain' as const },
    ],
    agendaCandidates: [], warnings: [],
    operationTrace: { traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: [] },
  };
  const masterRes = {
    result: { ...legacy, document: {}, extractedFields: [] },
    facts: [
      { canonicalKey: 'acquisitionDate', value: '2026-04-24' },
      { canonicalKey: 'mileage', value: 78500 },
      { canonicalKey: 'acquisitionPrice', value: 129 },
      { canonicalKey: null, value: 'x' },
    ],
    projection: { appliedRules: ['PURCHASE_RECEIPT_ACQUISITION_PRICE'], purpose: 'ASSET_PURCHASE', multiAsset: false },
    documentAssetId: 184,
  };

  beforeEach(() => {
    analyse.mockReset();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('comparaison résumée : clés et compteurs, jamais les valeurs', () => {
    const c = compareT1Results(legacy as never, masterRes as never);
    expect(c).toMatchObject({
      agreeing: ['acquisitionDate'], valueMismatches: ['mileage'], onlyLegacy: [], onlyMaster: ['acquisitionPrice'],
      legacyUnmapped: 1, masterGeneric: 1, masterPurpose: 'ASSET_PURCHASE',
    });
    expect(JSON.stringify(c)).not.toContain('78500');
  });

  it('lancée en mode shadow, sans être attendue ; résultat journalisé', async () => {
    let fin!: (v: unknown) => void;
    analyse.mockReturnValue(new Promise((r) => { fin = r; }));
    const recu = vi.fn();
    scheduleT1Shadow({ input: {} as never, groupIndices: [0], ctx: {} as never, legacy: legacy as never, onComparison: recu });
    expect(analyse.mock.calls[0][4]).toEqual({ shadow: true });
    expect(recu).not.toHaveBeenCalled(); // le pipeline n'attend pas
    fin(masterRes);
    await settleT1Shadows();
    expect(recu).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith('[t1-shadow] comparaison', expect.any(String));
  });

  it('un échec n’est jamais propagé', async () => {
    analyse.mockRejectedValue(new Error('ALL_MODELS_FAILED'));
    expect(() => scheduleT1Shadow({ input: {} as never, groupIndices: [0], ctx: {} as never, legacy: legacy as never })).not.toThrow();
    await expect(settleT1Shadows()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
