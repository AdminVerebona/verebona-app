/**
 * Lot 63 — décision PO du 16/10 (point 2) : seuils de la pertinence
 * « À traiter » réglables dans BO › Configuration IA › Réglages (ex-constantes
 * du lot 61 : horizon 120 j, historique 5 ans, reports 30 / 90 / 180 j).
 * Tests L63-SEUIL-xx (parties pures + réglages en mémoire). Le chemin réel
 * (balayage, mémoire de décision, `document_rule_evaluations`) est prouvé sur
 * PostgreSQL 16 par `src/test/e2e/scenarios/l63-seuils-a-traiter.e2e.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const ev = await import('../document-field-evidence');
const th = await import('../relevance-thresholds');
const rec = await import('../relevance-recette');
const settings = await import('@/services/verebona-assistant/config/assistant-settings');
const { getRule } = await import('../rules-catalog');
const { translateEventDecision } = await import('@/services/ai/agenda/master/classify-event');

const CONTRACT = getRule('DATA-CONTRACT-END')!;
const TODAY = '2026-10-16';
const base = { accountId: 1, fileId: 2, documentType: 'SERVICE_CONTRACT', today: TODAY, rule: CONTRACT };
const plus = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const V3 = { ref: 'repo:t4_output_v3', interventionCapable: true };
const V2 = { ref: 'bo:v7:t4_output_v2', interventionCapable: false };
const avec = (c: { ref: string; interventionCapable: boolean }, t: Partial<import('../relevance-thresholds').ToProcessThresholds>) =>
  ev.withThresholds(c, { ...th.DEFAULT_TO_PROCESS_THRESHOLDS, ...t });

type Decide = NonNullable<Parameters<typeof ev.assessDeadlinePertinence>[0]['decide']>;
/** T4 simulé (v2 : catégorie seule, sans évaluation structurée). */
const t4 = (category: 'action' | 'information' = 'action') => {
  const calls: unknown[] = [];
  const decide: Decide = async (input) => {
    calls.push(input);
    const out = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: category,
      businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
    return { ...translateEventDecision(out as never, false), traceId: 'trace-63' };
  };
  return { decide, calls };
};

/** Stockage des réglages en mémoire (BO simulé). */
function memoire(valeurs: Record<string, unknown>): import('@/services/verebona-assistant/config/assistant-settings').AssistantSettingsStore {
  let v = 1;
  const rows = new Map(Object.entries(valeurs));
  return {
    version: async () => v,
    readAll: async () => [...rows].map(([key, value]) => ({ key, value, updatedBy: 1, updatedAt: '2026-10-16T08:00:00.000Z' })),
    write: async (key, value) => { const before = rows.get(key) ?? null; rows.set(key, value); v += 1; return { before }; },
    createRequest: async () => { throw new Error('non utilisé'); },
    getRequest: async () => null,
    decideRequest: async () => false,
    listRequests: async () => [],
  };
}

afterEach(() => { settings.setAssistantSettingsStoreForTests(null); });

describe('L63-SEUIL — réglages BO', () => {
  it('L63-SEUIL-01 — cinq réglages « À traiter » déclarés (groupe dédié), mêmes valeurs par défaut que le lot 61, bornes de validation', () => {
    const defs = Object.values(th.TO_PROCESS_THRESHOLD_SETTINGS).map((r) => settings.assistantSettingDef(r.key)!);
    expect(defs.map((d) => [d.key, d.default, d.min, d.max, d.group, d.type])).toEqual([
      ['to_process_future_horizon_days', 120, 7, 730, 'a_traiter', 'int'],
      ['to_process_historical_years', 5, 1, 30, 'a_traiter', 'int'],
      ['to_process_defer_uncertain_days', 30, 7, 365, 'a_traiter', 'int'],
      ['to_process_defer_undated_days', 90, 7, 730, 'a_traiter', 'int'],
      ['to_process_defer_title_only_days', 180, 7, 730, 'a_traiter', 'int'],
    ]);
    expect(settings.SETTING_GROUP_LABELS.a_traiter).toMatch(/À traiter/);
    // Défauts identiques aux constantes du lot 61 (toujours exportées).
    expect([ev.FUTURE_HORIZON_DAYS, ev.HISTORICAL_YEARS, ev.DEFER_UNCERTAIN_DAYS, ev.DEFER_UNDATED_DAYS, ev.DEFER_TITLE_ONLY_DAYS]).toEqual([120, 5, 30, 90, 180]);
    const h = settings.assistantSettingDef('to_process_future_horizon_days')!;
    expect(settings.validateSettingValue(h, 3)).toMatchObject({ ok: false, message: 'Minimum : 7.' });
    expect(settings.validateSettingValue(h, 1000)).toMatchObject({ ok: false, message: 'Maximum : 730.' });
    expect(settings.validateSettingValue(h, 12.5)).toMatchObject({ ok: false });
    expect(settings.validateSettingValue(h, '150')).toEqual({ ok: true, value: 150 });
    // Écran BO (générique) : les réglages apparaissent, provenance « défaut ».
    const ecran = settings.effectiveAssistantSettings({} as NodeJS.ProcessEnv).filter((s) => s.group === 'a_traiter');
    expect(ecran.map((s) => [s.value, s.source])).toEqual([[120, 'defaut'], [5, 'defaut'], [30, 'defaut'], [90, 'defaut'], [180, 'defaut']]);
  });

  it('L63-SEUIL-02 — seuils effectifs : BO > défaut ; valeur hors bornes ignorée ; réglages illisibles → défauts (jamais d’erreur)', async () => {
    expect(await th.loadToProcessThresholds()).toEqual(th.DEFAULT_TO_PROCESS_THRESHOLDS);
    settings.setAssistantSettingsStoreForTests(memoire({ to_process_future_horizon_days: 150, to_process_historical_years: 3, to_process_defer_title_only_days: 9999 }));
    expect(await th.loadToProcessThresholds()).toEqual({ ...th.DEFAULT_TO_PROCESS_THRESHOLDS, futureHorizonDays: 150, historicalYears: 3 });
    // Modification depuis le BO (même chemin que l'écran Réglages) : prise en compte.
    await settings.updateAssistantSetting({ key: 'to_process_defer_uncertain_days', value: 45, adminId: 1 }).catch(() => undefined);
    expect((await th.loadToProcessThresholds()).deferUncertainDays).toBe(45);
    await expect(settings.updateAssistantSetting({ key: 'to_process_defer_uncertain_days', value: 2, adminId: 1 })).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    settings.setAssistantSettingsStoreForTests({ ...memoire({}), version: async () => { throw new Error('base illisible'); } });
    expect(await th.loadToProcessThresholds()).toEqual(th.DEFAULT_TO_PROCESS_THRESHOLDS);
    expect(th.sanitizeThresholds({ futureHorizonDays: 'x', historicalYears: 0, deferUndatedDays: 60 })).toEqual({ ...th.DEFAULT_TO_PROCESS_THRESHOLDS, deferUndatedDays: 60 });
  });
});

describe('L63-SEUIL — la décision applique les seuils réglés', () => {
  it('L63-SEUIL-03 — horizon de report : échéance à +150 j reportée par défaut (120 j), question posée avec un horizon de 180 j', async () => {
    const cands = [{ iso: plus(150), source: 'FACTS' }];
    const d = await ev.assessDeadlinePertinence({ ...base, candidates: cands, config: avec(V3, {}) });
    expect(d).toMatchObject({ outcome: 'DEFER', pertinence: 'FUTURE_DEFERRABLE', reason: 'future_beyond_120d', reevaluateAt: `${plus(30)}T00:00:00.000Z` });
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: cands, config: avec(V3, { futureHorizonDays: 180 }) });
    expect(r).toMatchObject({ outcome: 'CREATE_ACTION', pertinence: 'FUTURE_SOON', reason: 'future_within_180d', card: 'DATA_QUESTION' });
    const c = await ev.assessDeadlinePertinence({ ...base, candidates: [{ iso: plus(100), source: 'FACTS' }], config: avec(V3, { futureHorizonDays: 60 }) });
    expect(c).toMatchObject({ outcome: 'DEFER', reason: 'future_beyond_60d', reevaluateAt: `${plus(40)}T00:00:00.000Z` });
  });

  it('L63-SEUIL-04 — document historique : dates fiables de 4 ans, non historique par défaut (5 ans), historique avec un seuil de 3 ans', async () => {
    const ctx = { candidates: [], contextDates: [{ key: 'documentDate', iso: plus(-4 * 365) }] };
    const { decide, calls } = t4('information');
    const d = await ev.assessDeadlinePertinence({ ...base, ...ctx, config: avec(V2, {}), decide });
    expect(d.pertinence).not.toBe('UNDATED_HISTORICAL');
    const r = await ev.assessDeadlinePertinence({ ...base, ...ctx, config: avec(V2, { historicalYears: 3 }), decide });
    // Lot 72 (C2) : document ancien → décision différée (l'âge n'est qu'un indice), seuil appliqué.
    expect(r).toMatchObject({ outcome: 'DEFER', pertinence: 'UNDATED_HISTORICAL', reason: 'old_document_age_is_only_a_hint_3y' });
    expect(calls).toHaveLength(0);
  });

  it('L63-SEUIL-05 — délais de réévaluation : décision incertaine, titre seul (30 / 180 j par défaut, réglés à 45 / 60 j)', async () => {
    const passee = [{ iso: plus(-20), source: 'FACTS', excerpt: 'Échéance du contrat.' }];
    const d = await ev.assessDeadlinePertinence({ ...base, candidates: passee, config: avec(V2, {}), decide: t4('action').decide });
    expect(d).toMatchObject({ outcome: 'DEFER', reevaluateAt: `${plus(30)}T00:00:00.000Z` });
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: passee, config: avec(V2, { deferUncertainDays: 45 }), decide: t4('action').decide });
    expect(r).toMatchObject({ outcome: 'DEFER', reevaluateAt: `${plus(45)}T00:00:00.000Z` });
    const titre = [{ iso: plus(-10), source: 'TITLE_ONLY' }];
    expect(await ev.assessDeadlinePertinence({ ...base, candidates: titre, config: avec(V2, {}) })).toMatchObject({ outcome: 'DEFER', reevaluateAt: `${plus(180)}T00:00:00.000Z` });
    expect(await ev.assessDeadlinePertinence({ ...base, candidates: titre, config: avec(V2, { deferTitleOnlyDays: 60 }) })).toMatchObject({ outcome: 'DEFER', reevaluateAt: `${plus(60)}T00:00:00.000Z` });
  });
});

describe('L63-SEUIL — signature de pertinence, invalidation et traçage', () => {
  it('L63-SEUIL-06 — aux valeurs par défaut : références et signatures identiques au lot 61 (aucune réévaluation au déploiement)', () => {
    const c = avec(V3, {});
    expect(c.ref).toBe('repo:t4_output_v3');
    expect(c.aiRef).toBe('repo:t4_output_v3');
    expect(ev.pertinenceConfigKey(c)).toBe('repo:t4_output_v3');
    expect(ev.pertinenceConfigKey(V3)).toBe('repo:t4_output_v3');
    expect(th.thresholdsRef(th.DEFAULT_TO_PROCESS_THRESHOLDS)).toBeNull();
    // Composition idempotente (une configuration déjà complétée n'empile pas les suffixes).
    expect(ev.withThresholds(avec(V3, { futureHorizonDays: 150 }), { ...th.DEFAULT_TO_PROCESS_THRESHOLDS, futureHorizonDays: 200 }).ref).toBe('repo:t4_output_v3|seuils:h=200');
  });

  it('L63-SEUIL-07 — un réglage modifié change la référence de configuration (config_ref) ; seuls les délais changent la signature de la décision IA', () => {
    const h = avec(V3, { futureHorizonDays: 150, historicalYears: 8 });
    expect(h.ref).toBe('repo:t4_output_v3|seuils:h=150,a=8');
    expect(ev.pertinenceConfigKey(h)).toBe('repo:t4_output_v3');
    const i = avec(V3, { deferUncertainDays: 45 });
    expect(i.ref).toBe('repo:t4_output_v3|seuils:i=45');
    expect(ev.pertinenceConfigKey(i)).toBe('repo:t4_output_v3|seuils:i=45');
    const sig = (cfg: string) => ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', [{ iso: plus(-20), source: 'FACTS' }], { situation: 'PAST_DEADLINE', evidence: 'e', config: cfg });
    expect(sig(ev.pertinenceConfigKey(h))).toBe(sig(ev.pertinenceConfigKey(V3)));
    expect(sig(ev.pertinenceConfigKey(i))).not.toBe(sig(ev.pertinenceConfigKey(V3)));
  });

  it('L63-SEUIL-08 — décision IA mémorisée : réutilisée si seul l’horizon change, réévaluée (T4 rappelé) si un délai de réévaluation change', async () => {
    const passee = [{ iso: plus(-20), source: 'FACTS', excerpt: 'Échéance du contrat.' }];
    const premier = t4('action');
    const d = await ev.assessDeadlinePertinence({ ...base, candidates: passee, evidenceFingerprint: 'e', config: avec(V2, {}), decide: premier.decide });
    expect(d.aiCalled).toBe(true);
    const memo = { signature: d.signature, outcome: d.outcome, pertinence: d.pertinence, aiStatus: d.aiStatus, card: d.card, intervention: d.intervention, reevaluateAt: d.reevaluateAt };
    const second = t4('action');
    const h = await ev.assessDeadlinePertinence({ ...base, candidates: passee, evidenceFingerprint: 'e', config: avec(V2, { futureHorizonDays: 200 }), decide: second.decide, remembered: memo as never });
    expect(h).toMatchObject({ cached: true, aiCalled: false, reason: 'remembered_decision' });
    expect(second.calls).toHaveLength(0);
    const i = await ev.assessDeadlinePertinence({ ...base, candidates: passee, evidenceFingerprint: 'e', config: avec(V2, { deferUncertainDays: 60 }), decide: second.decide, remembered: memo as never });
    expect(i).toMatchObject({ cached: false, aiCalled: true, reevaluateAt: `${plus(60)}T00:00:00.000Z` });
    expect(second.calls).toHaveLength(1);
  });

  it('L63-SEUIL-09 — traçage : les seuils utilisés sont écrits dans le contrat de décision (decision_contract) et la référence de configuration', async () => {
    const cfg = avec(V3, { futureHorizonDays: 180 });
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: [{ iso: plus(150), source: 'FACTS' }], config: cfg });
    expect(r.contract?.thresholds).toEqual({ ...th.DEFAULT_TO_PROCESS_THRESHOLDS, futureHorizonDays: 180 });
    const d = await ev.assessDeadlinePertinence({ ...base, candidates: [{ iso: plus(150), source: 'FACTS' }], config: V3 });
    expect(d.contract?.thresholds).toEqual(th.DEFAULT_TO_PROCESS_THRESHOLDS);
    expect(th.composeConfigRef('bo:v4:t4_output_v3', cfg.thresholds)).toBe('bo:v4:t4_output_v3|seuils:h=180');
  });

  it('L63-SEUIL-10 — la recette T4 (corpus calé sur les défauts) impose les seuils par défaut, quels que soient les réglages du BO', async () => {
    const c = rec.recetteConfig(avec(V3, { futureHorizonDays: 30, historicalYears: 1 }));
    expect(c).toMatchObject({ ref: 'repo:t4_output_v3', aiRef: 'repo:t4_output_v3', interventionCapable: true, thresholds: th.DEFAULT_TO_PROCESS_THRESHOLDS });
    const loin = rec.RELEVANCE_RECETTE_CASES.find((x) => x.deterministic && (x.candidates ?? []).some((k) => k.days > 120));
    expect(loin).toBeDefined();
    const r = await rec.runRecetteCase(loin!, { accountId: 1, today: TODAY, config: c });
    expect(r.ok).toBe(true);
  });
});
