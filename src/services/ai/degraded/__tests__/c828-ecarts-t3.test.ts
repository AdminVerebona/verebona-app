/**
 * Carte #828 — écarts résiduels du #811 (tests unitaires, sans base).
 *
 *   C828-U01  écart A : borne COMMUNE puis borne de l'instance ; borne commune injoignable (table absente, lecture
 *             seule, base lente) → la borne de l'instance décide, et c'est compté ; jamais de boucle silencieuse
 *   C828-U02  écart A : borne levée (`off`) = contournement d'urgence tracé et alerté aussitôt ; refus → alerte aussitôt
 *   C828-U03  écart A : T4 déclenché pendant un travail T3 soumis à la borne ; annonce amont soldée à l'envoi
 *   C828-U04  écart A : coupure du cache — `true` (urgence : tracée, comptée, bornée), `test` (jeux de test seulement)
 *   C828-U05  écart A : diagnostic — jamais « actives » sous contournement ; portée réelle de la borne dite au BO
 *   C828-U06  écart B : perte de persistance comptée à part ; lecture certifiée MEASURED / DECLARED / UNKNOWN
 *   C828-U07  écart B : export ZIP — `providerCalls` = requêtes réseau, lignes dites à part, inconnu ≠ zéro
 *   C828-U08  écart B : textes du BO et de l'export administrateur — demandes déclarées et historique jamais « appels »
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));
(globalThis as unknown as { React: typeof React }).React = React;

const dm = await import('../degraded-mode');
const idem = await import('../../idempotency/idempotency.service');
const act = await import('../../measure/ai-activity');
const { evaluateT3Protections, emergencyBypassesOf } = await import('../../reconciliation/t3-protections');
const { degradedCapText, bypassText, jobAiText, ProtectionsBlock } = await import('@/app/admin/ai-queue/_components/T3Supervision');
const { t3ProtectionSettings } = await import('../../reconciliation/t3-protections');
const { aiUsageOfJobs, networkRequestsOfUsageRows, AI_USAGE_PROVIDER_CALLS_SEMANTICS } = await import('../../business-execution/export');
const { usageSummaryLines } = await import('@/services/admin/diagnostics-export/collect');
const { runInJobContext } = await import('../../queue/job-context');
type Facts = import('../../reconciliation/t3-protections').T3ProtectionFacts;
type Scope = import('../degraded-mode').DegradedScope;

const traces: import('../degraded-mode').DegradedEvent[] = [];
const alertes: Array<{ component: string; reason: string; count: number; title: string }> = [];
const T3: Scope = { treatment: 'T3', operationCode: 't3_value_conflict', accountId: 13 };
const ENV = ['AI_DEGRADED_CALLS_PER_HOUR', 'AI_DEGRADED_CAP_TREATMENTS', 'AI_DEGRADED_ALERT_COUNT', 'AI_DEGRADED_ALERT_MINUTES', 'AI_DEGRADED_BUDGET_TIMEOUT_MS', 'AI_IDEMPOTENCY_DISABLED'] as const;
const avant: Record<string, string | undefined> = {};

/** Borne commune simulée : un compteur partagé par « toutes les instances ». */
const communes = new Map<string, number>();
const commune = async (s: Scope, limite: number): Promise<'ADMITTED' | 'REFUSED'> => {
  const k = `${s.treatment}|${s.operationCode}|${s.accountId}`;
  const n = communes.get(k) ?? 0;
  if (n >= limite) return 'REFUSED';
  communes.set(k, n + 1);
  return 'ADMITTED';
};
const remettre = (sharedBudget: import('../degraded-mode').DegradedSharedBudget = commune) => {
  dm.__resetDegradedModeForTests({
    persist: async (e) => { traces.push(e); },
    alert: async (a) => { alertes.push({ component: a.component, reason: a.reason, count: a.count, title: dm.degradedAlertTitle(a.component, a.reason) }); },
    sharedBudget,
  });
};

beforeEach(() => {
  for (const k of ENV) avant[k] = process.env[k];
  traces.length = 0; alertes.length = 0; communes.clear();
  remettre();
  for (const k of ENV) if (k !== 'AI_IDEMPOTENCY_DISABLED') delete process.env[k];
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV) { if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k]; }
  dm.__resetDegradedModeForTests({ persist: null, alert: null, sharedBudget: null });
});

describe('C828-U01 — écart A : borne commune à toutes les instances, puis borne de l’instance', () => {
  it('deux instances ne peuvent pas admettre ensemble plus que le budget (la borne de l’instance seule en admettrait le double)', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '3';
    // « Instance A » : 2 admissions, puis on remet à zéro l'état de l'instance (= une AUTRE instance), compteur commun gardé.
    expect(await dm.admitDegradedCallShared(T3)).toBe(true);
    expect(await dm.admitDegradedCallShared(T3)).toBe(true);
    remettre();
    const b = [];
    for (let i = 0; i < 4; i++) b.push(await dm.admitDegradedCallShared(T3));
    expect(b).toEqual([true, false, false, false]);
    expect(communes.get('T3|t3_value_conflict|13')).toBe(3);
    // Deux refus viennent de la borne commune ; le troisième de la borne de l'instance elle-même (une place refusée
    // par la borne commune reste consommée sur l'instance : prudent, jamais plus d'appels que le budget).
    expect(dm.degradedInstanceState()).toMatchObject({ sharedAdmitted: 1, sharedRefused: 2, sharedUnavailable: 0, callsRefused: 3 });
    // Une autre portée (autre compte) garde son propre budget ; un traitement hors borne n'est jamais retenu.
    expect(await dm.admitDegradedCallShared({ ...T3, accountId: 14 })).toBe(true);
    expect(await dm.admitDegradedCallShared({ treatment: 'T2', operationCode: 't2_chat', accountId: 13 })).toBe(true);
  });

  it.each([
    ['table 1940 absente', '42P01'],
    ['base en lecture seule', '25006'],
    ['requête annulée par la base (base lente, verrou)', '57014'],
    ['connexion perdue', 'ECONNRESET'],
  ])('borne commune injoignable (%s) : la borne de l’instance décide SEULE, et c’est compté — jamais « commune »', async (_cas, code) => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '2';
    remettre(async () => { throw Object.assign(new Error('injoignable'), { code }); });
    const r = [];
    for (let i = 0; i < 5; i++) r.push(await dm.admitDegradedCallShared(T3));
    // Aucune boucle : la borne de l'instance tient (2 admis, 3 refusés), sans la base.
    expect(r).toEqual([true, true, false, false, false]);
    expect(dm.degradedInstanceState()).toMatchObject({ sharedAdmitted: 0, sharedUnavailable: 2, sharedUnavailableCode: code, callsAllowed: 2, callsRefused: 3 });
  });

  it('base LENTE (aucune réponse) : au-delà du délai, la borne de l’instance décide ; l’appelant n’attend pas indéfiniment', async () => {
    vi.useFakeTimers();
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '1';
    process.env.AI_DEGRADED_BUDGET_TIMEOUT_MS = '200';
    remettre(() => new Promise<'ADMITTED' | 'REFUSED'>(() => undefined));
    const p1 = dm.admitDegradedCallShared(T3);
    await vi.advanceTimersByTimeAsync(800);
    expect(await p1).toBe(true);
    // Budget de l'instance épuisé : refus immédiat, sans même interroger la base lente.
    expect(await dm.admitDegradedCallShared(T3)).toBe(false);
    expect(dm.degradedInstanceState()).toMatchObject({ sharedUnavailable: 1, sharedUnavailableCode: 'BUDGET_TIMEOUT', callsAllowed: 1, callsRefused: 1 });
  });
});

describe('C828-U02 — écart A : contournement d’urgence explicite, alerte cohérente avec la limite', () => {
  it('AI_DEGRADED_CALLS_PER_HOUR=off : chaque appel est admis MAIS tracé (borne levée) et l’alerte part aussitôt', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = 'off';
    for (let i = 0; i < 4; i++) expect(await dm.admitDegradedCallShared(T3)).toBe(true);
    await Promise.resolve();
    expect(traces.filter((t) => t.component === 'DEGRADED_CAP')).toHaveLength(4);
    expect(traces[0]).toMatchObject({ component: 'DEGRADED_CAP', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_WITHOUT_PROTECTION', treatment: 'T3', accountId: 13 });
    expect(alertes).toHaveLength(1);
    expect(alertes[0].title).toContain('LEVÉE par configuration');
    expect(dm.degradedInstanceState()).toMatchObject({ unbounded: 4, callsPerHour: null });
    // Le compteur commun n'a rien admis : rien n'est présenté comme borné.
    expect(communes.size).toBe(0);
  });

  it('un refus par la borne alerte SANS attendre le seuil d’occurrences (limite et alerte cohérentes)', async () => {
    process.env.AI_DEGRADED_ALERT_COUNT = '500';
    dm.noteDegraded({ ...T3, component: 'RESPONSE_CACHE', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_WITHOUT_PROTECTION' });
    await Promise.resolve();
    expect(alertes).toHaveLength(0);
    dm.noteDegraded({ ...T3, component: 'RESPONSE_CACHE', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_REFUSED' });
    await Promise.resolve();
    expect(alertes).toEqual([expect.objectContaining({ component: 'RESPONSE_CACHE', reason: 'DISABLED_BY_CONFIG', count: 2 })]);
    // Une seule alerte par épisode et par heure : pas une alerte par appel refusé.
    dm.noteDegraded({ ...T3, component: 'RESPONSE_CACHE', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_REFUSED' });
    await Promise.resolve();
    expect(alertes).toHaveLength(1);
  });

  it('un événement d’usage perdu alerte aussitôt, sous un titre qui ne parle pas de « protection »', async () => {
    dm.noteDegraded({ ...T3, component: 'USAGE_JOURNAL', reason: 'WRITE_FAILED', impact: 'USAGE_EVENT_LOST', technicalCode: '23514' });
    await Promise.resolve();
    expect(alertes).toHaveLength(1);
    expect(alertes[0].title).toBe('IA — journal des événements d’usage : écriture en échec (compteurs durables incomplets)');
    expect(traces[0]).toMatchObject({ component: 'USAGE_JOURNAL', impact: 'USAGE_EVENT_LOST', technicalCode: '23514' });
  });
});

describe('C828-U03 — écart A : T4 déclenché pendant T3, annonce amont soldée à l’envoi', () => {
  it('une opération d’un autre traitement est bornée quand le TRAVAIL qui l’héberge est soumis à la borne', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '1';
    const t4: Scope = { treatment: 'T4', operationCode: 't4_semantic', accountId: 13 };
    // Hors d'un travail T3 : T4 n'est pas soumis à la borne (défaut : T3 seul).
    expect(dm.degradedScopeCapped(t4)).toBe(false);
    expect(await dm.admitDegradedCallShared(t4)).toBe(true);
    expect(await dm.admitDegradedCallShared(t4)).toBe(true);
    // Pendant un travail T3 : borné, sur la portée de l'opération T4.
    const hote: Scope = { ...t4, hostTreatment: 'T3' };
    expect(dm.degradedScopeCapped(hote)).toBe(true);
    expect(await dm.admitDegradedCallShared(hote)).toBe(true);
    expect(await dm.admitDegradedCallShared(hote)).toBe(false);
    expect(communes.get('T4|t4_semantic|13')).toBe(1);
  });

  it('le cache coupé en urgence borne aussi T4 pendant un travail T3 (contexte du travail lu par le cache)', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '1';
    process.env.AI_IDEMPOTENCY_DISABLED = 'true';
    const meta = { accountId: 13, treatment: 'T4', operationCode: 't4_semantic' };
    let appels = 0;
    const fn = async () => { appels++; return { ok: true }; };
    const ctx = { jobId: 1, treatment: 'T3', configVersionId: null } as never;
    await runInJobContext(ctx, async () => {
      await idem.withIdempotency('c828:u03:1', fn, 60, meta);
      await expect(idem.withIdempotency('c828:u03:2', fn, 60, meta)).rejects.toMatchObject({ code: 'DEGRADED_CALL_REFUSED' });
    });
    expect(appels).toBe(1);
    // Hors de tout travail T3 : jamais bloqué (traitement interactif ou autre file).
    await idem.withIdempotency('c828:u03:3', fn, 60, meta);
    await idem.withIdempotency('c828:u03:4', fn, 60, meta);
    expect(appels).toBe(3);
  });

  it('annonce amont (signature non résolue du rattachement) : tracée, puis retirée une seule fois, bornée dans le temps', () => {
    const t0 = 1_800_000_000_000;
    dm.announceUnprotectedCall({ ...T3, operationCode: 't3_link_ambiguity', component: 'CONFIG_SIGNATURE', reason: 'SIGNATURE_UNRESOLVED' }, t0);
    dm.announceUnprotectedCall({ ...T3, operationCode: 't3_link_ambiguity', component: 'CONFIG_SIGNATURE', reason: 'SIGNATURE_UNRESOLVED' }, t0 + 1);
    const lien: Scope = { ...T3, operationCode: 't3_link_ambiguity' };
    expect(dm.takeAnnouncedUnprotectedCall(T3, t0 + 2)).toBeNull();
    expect(dm.takeAnnouncedUnprotectedCall(lien, t0 + 2)).toEqual({ component: 'CONFIG_SIGNATURE', reason: 'SIGNATURE_UNRESOLVED' });
    // Annonce périmée (plus de 10 minutes) : elle ne charge plus un appel ultérieur.
    expect(dm.takeAnnouncedUnprotectedCall(lien, t0 + 11 * 60_000)).toBeNull();
  });
});

describe('C828-U04 — écart A : coupure du cache des réponses', () => {
  it('états de la variable : `true` = urgence ; `test` honoré seulement quand NODE_ENV=test, IGNORÉ ailleurs', () => {
    expect(idem.idempotencyCacheSwitch({})).toBe('ACTIVE');
    expect(idem.idempotencyCacheSwitch({ AI_IDEMPOTENCY_DISABLED: 'false' })).toBe('ACTIVE');
    expect(idem.idempotencyCacheSwitch({ AI_IDEMPOTENCY_DISABLED: 'true', NODE_ENV: 'production' })).toBe('EMERGENCY_BYPASS');
    expect(idem.idempotencyCacheSwitch({ AI_IDEMPOTENCY_DISABLED: 'TRUE', NODE_ENV: 'test' })).toBe('EMERGENCY_BYPASS');
    expect(idem.idempotencyCacheSwitch({ AI_IDEMPOTENCY_DISABLED: 'test', NODE_ENV: 'test' })).toBe('TEST_ESCAPE');
    expect(idem.idempotencyCacheSwitch({ AI_IDEMPOTENCY_DISABLED: 'test', NODE_ENV: 'production' })).toBe('TEST_VALUE_IGNORED');
  });

  it('`true` : plusieurs appels séquentiels T3 — tracés, comptés, BORNÉS, refus avant tout contact ; interactif jamais bloqué', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '2';
    process.env.AI_IDEMPOTENCY_DISABLED = 'true';
    const meta = { accountId: 13, treatment: 'T3', operationCode: 't3_value_conflict' };
    let appels = 0;
    const issues: string[] = [];
    for (let i = 0; i < 6; i++) {
      try { await idem.withIdempotency(`c828:u04:${i}`, async () => { appels++; return { i }; }, 60, meta); issues.push('émis'); }
      catch (e) { issues.push((e as { code?: string }).code ?? 'erreur'); }
    }
    // Avant la carte #828 : 6 appels facturés, aucune trace. Maintenant : 2, puis repli sans IA.
    expect(appels).toBe(2);
    expect(issues).toEqual(['émis', 'émis', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED']);
    await Promise.resolve();
    const par = (impact: string) => traces.filter((t) => t.component === 'RESPONSE_CACHE' && t.reason === 'DISABLED_BY_CONFIG' && t.impact === impact).length;
    expect([par('CALL_WITHOUT_PROTECTION'), par('CALL_REFUSED')]).toEqual([2, 4]);
    expect(alertes.map((a) => [a.component, a.reason])).toEqual([['RESPONSE_CACHE', 'DISABLED_BY_CONFIG']]);
    // Traitement interactif (hors borne) : tracé lui aussi, jamais refusé.
    let t2 = 0;
    for (let i = 0; i < 5; i++) await idem.withIdempotency(`c828:u04:t2:${i}`, async () => { t2++; return {}; }, 60, { accountId: 13, treatment: 'T2', operationCode: 't2_chat' });
    expect(t2).toBe(5);
  });

  it('`test` (jeux de test) : aucun effet de bord — ni trace, ni borne, ni base', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '0';
    process.env.AI_IDEMPOTENCY_DISABLED = 'test';
    let appels = 0;
    for (let i = 0; i < 3; i++) await idem.withIdempotency(`c828:u04:test:${i}`, async () => { appels++; return {}; }, 60, { accountId: 13, treatment: 'T3', operationCode: 't3_value_conflict' });
    expect(appels).toBe(3);
    expect(traces).toHaveLength(0);
    expect(communes.size).toBe(0);
  });

  it('issue de l’écriture du cache lue sur la réponse : absente quand la réponse est conservée', () => {
    expect(idem.cacheWriteOutcomeOf({ v: 1 })).toBeNull();
    expect(idem.cacheWriteOutcomeOf({ v: 1, cacheWrite: 'STORED' })).toBeNull();
    expect(idem.cacheWriteOutcomeOf({ v: 1, cacheWrite: 'LEASE_LOST' })).toBe('LEASE_LOST');
    expect(idem.cacheWriteOutcomeOf({ v: 1, cacheWrite: 'ALREADY_READY' })).toBe('ALREADY_READY');
    expect(idem.cacheWriteOutcomeOf(null)).toBeNull();
  });
});

describe('C828-U05 — écart A : diagnostic et textes du BO', () => {
  const instance = (over: Partial<Facts['instance']> = {}): Facts['instance'] => ({
    episodes: [], callsAllowed: 0, callsRefused: 0, callsPerHour: 20, cappedTreatments: ['T3'], sharedAdmitted: 0, sharedRefused: 0,
    sharedUnavailable: 0, sharedUnavailableCode: null, unbounded: 0, ...over,
  });
  const sain = (over: Partial<Facts> = {}): Facts => ({
    memoryTable: true, memoryEnabled: true, memoryReadable: true, cacheTable: true, cacheColumns0857: true, cacheDisabledByEnv: false,
    reservationUsable: true, reuseCounters0858: true, runCounters0858: true, sweepIndex0859: true, measuredCounters1860: true,
    degradedTrace1861: true, prefilterEnabled: true, configSignature: 'sig', degradedLast24h: [], instance: instance(), probeError: null,
    cacheSwitch: 'ACTIVE', sharedBudget1940: true, sharedBudget24h: { admitted: 0, refused: 0 }, bypassWindows: [], ...over,
  });
  const constat = (f: Facts, code: string) => evaluateT3Protections(f).findings.find((x) => x.code === code);

  it('base saine : actives, borne dite « commune à toutes les instances »', () => {
    const r = evaluateT3Protections(sain());
    expect(r.status).toBe('ACTIVE');
    expect(constat(sain(), 'DEGRADED_CAP')).toMatchObject({ level: 'ok', message: expect.stringContaining('commune à toutes les instances') });
    expect(constat(sain(), 'MIGRATION_1940')).toMatchObject({ level: 'ok' });
  });

  it('cache coupé en urgence : NON effectives ; portée, risque et durée observée sont dits', () => {
    const f = sain({
      cacheSwitch: 'EMERGENCY_BYPASS', cacheDisabledByEnv: true,
      bypassWindows: [{ component: 'RESPONSE_CACHE', firstAt: '2026-11-24T08:00:00.000Z', lastAt: '2026-11-24T10:30:00.000Z', count: 42 }],
    });
    expect(evaluateT3Protections(f).status).toBe('INACTIVE');
    expect(constat(f, 'CACHE_ENABLED')).toMatchObject({ level: 'error' });
    expect(constat(f, 'CACHE_ENABLED')!.message).toContain('contournement d’urgence');
    expect(constat(f, 'CACHE_ENABLED')!.message).toContain('42 appel(s) émis sous ce contournement sur 30 jours, du 2026-11-24 08:00 UTC au 2026-11-24 10:30 UTC');
    expect(emergencyBypassesOf(f)).toEqual([expect.objectContaining({ variable: 'AI_IDEMPOTENCY_DISABLED', value: 'true', callsObserved: 42, firstObservedAt: '2026-11-24T08:00:00.000Z' })]);
    expect(bypassText(emergencyBypassesOf(f)[0], (v) => String(v))).toMatch(/^Contournement d’urgence actif — AI_IDEMPOTENCY_DISABLED=true\. Portée : .+ Risque : .+ Durée observée : 42 appel\(s\)/);
  });

  it('valeur `test` hors des tests : IGNORÉE et signalée (le cache reste en service) ; aucune fausse coupure', () => {
    const f = sain({ cacheSwitch: 'TEST_VALUE_IGNORED' });
    expect(constat(f, 'CACHE_ENABLED')).toMatchObject({ level: 'warn', message: expect.stringContaining('IGNORÉE') });
    expect(evaluateT3Protections(f).status).toBe('DEGRADED');
    expect(emergencyBypassesOf(f)).toEqual([]);
  });

  it('borne levée (`off`) : NON effectives ; aucun traitement soumis : NON effectives', () => {
    const off = sain({ instance: instance({ callsPerHour: null }) });
    expect(evaluateT3Protections(off).status).toBe('INACTIVE');
    expect(constat(off, 'DEGRADED_CAP')).toMatchObject({ level: 'error', message: expect.stringContaining('LEVÉE par configuration') });
    expect(emergencyBypassesOf(off)[0]).toMatchObject({ variable: 'AI_DEGRADED_CALLS_PER_HOUR', value: 'off', callsObserved: 0, firstObservedAt: null });
    const personne = sain({ instance: instance({ cappedTreatments: [] }) });
    expect(constat(personne, 'DEGRADED_CAP')).toMatchObject({ level: 'error' });
  });

  it('migration 1940 absente ou borne commune injoignable : jamais dite « commune » — avertissement', () => {
    const absente = sain({ sharedBudget1940: false, sharedBudget24h: null });
    expect(constat(absente, 'MIGRATION_1940')).toMatchObject({ level: 'warn', message: expect.stringContaining('PAR INSTANCE') });
    expect(constat(absente, 'DEGRADED_CAP')!.message).not.toContain('commune');
    expect(evaluateT3Protections(absente).status).toBe('DEGRADED');
    const injoignable = sain({ instance: instance({ sharedUnavailable: 7, sharedUnavailableCode: '57014' }) });
    expect(constat(injoignable, 'DEGRADED_CAP')).toMatchObject({ level: 'warn', message: expect.stringContaining('7 fois') });
  });

  it('migration 0857 absente : visible, jamais « protégé »', () => {
    const f = sain({ cacheColumns0857: false });
    expect(evaluateT3Protections(f).status).toBe('INACTIVE');
    expect(constat(f, 'MIGRATION_0857')).toMatchObject({ level: 'error', message: expect.stringContaining('deux instances peuvent appeler') });
  });

  it('BO › Supervision T3 (rendu) : contournement d’urgence affiché en clair, borne dite avec sa portée réelle, aucune couleur brute', () => {
    const f = sain({
      cacheSwitch: 'EMERGENCY_BYPASS', cacheDisabledByEnv: true, sharedBudget24h: { admitted: 12, refused: 4 },
      bypassWindows: [{ component: 'RESPONSE_CACHE', firstAt: '2026-11-24T08:00:00.000Z', lastAt: '2026-11-24T10:30:00.000Z', count: 12 }],
    });
    const r = evaluateT3Protections(f);
    const base = { generatedAt: '', workers: {}, executor: {}, queue: {}, schedule: {}, lastManual: null, lastAutomatic: null, lastSweep: null };
    const html = renderToStaticMarkup(h(ProtectionsBlock, { data: { ...base, protections: {
      checkedAt: '2026-11-24T11:00:00Z', status: r.status, statusLabel: 'Protections anti-redondance NON effectives : une dépendance manque', findings: r.findings,
      settings: t3ProtectionSettings(), degraded: { durableAvailable: true, last24h: [], instance: f.instance, sharedBudget: f.sharedBudget24h }, bypasses: emergencyBypassesOf(f),
    } } as never }));
    expect(html).toContain('data-status="INACTIVE"');
    expect(html).toContain('data-testid="t3-contournements-urgence"');
    expect(html).toContain('Contournement d’urgence actif — AI_IDEMPOTENCY_DISABLED=true');
    expect(html).toContain('12 appel(s) émis sous ce contournement sur 30 jours');
    expect(html).toContain('toutes instances confondues (T3) · 24 h, toutes instances : 12 admis, 4 refusé(s)');
    expect(html).not.toContain('Protections anti-redondance actives');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
    // Vocabulaire (carte #806) : jamais « événement de référence ».
    expect(html.toLowerCase()).not.toContain('événement de référence');
    // Sans contournement : le bloc dédié n'apparaît pas.
    const sainR = evaluateT3Protections(sain());
    const calme = renderToStaticMarkup(h(ProtectionsBlock, { data: { ...base, protections: {
      checkedAt: '2026-11-24T11:00:00Z', status: sainR.status, statusLabel: 'Protections anti-redondance actives', findings: sainR.findings,
      settings: t3ProtectionSettings(), degraded: { durableAvailable: true, last24h: [], instance: sain().instance, sharedBudget: { admitted: 0, refused: 0 } }, bypasses: [],
    } } as never }));
    expect(calme).not.toContain('t3-contournements-urgence');
    expect(calme).toContain('toutes instances confondues (T3)');
  });

  it('texte du BO : portée réelle de la borne (commune, par instance seulement, levée)', () => {
    const vue = (over: Record<string, unknown>, sharedBudget: { admitted: number; refused: number } | null) => ({
      degraded: { durableAvailable: true, last24h: [], instance: { ...instance(), ...over } as never, sharedBudget },
    });
    expect(degradedCapText(vue({ callsAllowed: 2, callsRefused: 1 }, { admitted: 5, refused: 3 })))
      .toBe('Borne des appels sans protection : 20 par heure, par traitement / opération / compte, toutes instances confondues (T3) · 24 h, toutes instances : 5 admis, 3 refusé(s) · instance qui répond : 2 admis, 1 refusé(s).');
    expect(degradedCapText(vue({}, null))).toContain('par instance seulement (borne commune absente : migration 1940)');
    expect(degradedCapText(vue({ sharedUnavailable: 4 }, { admitted: 0, refused: 0 }))).toContain('4 admission(s) bornée(s) par la seule instance (borne commune injoignable)');
    expect(degradedCapText(vue({ callsPerHour: null, unbounded: 9 }, null))).toBe('Borne des appels sans protection : LEVÉE par configuration (contournement d’urgence, T3) · 9 appel(s) admis sans borne par l’instance qui répond.');
  });
});

describe('C828-U06 — écart B : requêtes physiques, événements constatés, lignes durables — trois nombres séparés', () => {
  const fait = (over: Partial<import('../../measure/ai-activity').AiUsageEventFact> = {}): import('../../measure/ai-activity').AiUsageEventFact => ({
    traceId: 'tr-1', operationCode: 't3_value_conflict', treatment: 'T3', model: 'm', rank: 'primary', callKind: 'analysis', status: 'success',
    networkRequests: 1, inputTokens: 100, outputTokens: 10, costMicros: 50, costNature: 'OBSERVED', ...over,
  });

  it('INSERT refusé : la requête émise reste comptée ; la perte est dite À PART ; le total durable attendu se déduit', async () => {
    const { activity } = await act.measureAiActivity(async () => {
      act.noteAiUsageEvent(fait());
      act.noteAiUsageEvent(fait({ traceId: 'tr-2', networkRequests: 2 }));
      act.noteAiUsageEventNotPersisted(fait({ traceId: 'tr-2', networkRequests: 2 }));
    });
    expect(activity.total).toMatchObject({ networkRequests: 3, usageEvents: 2, usageEventsNotPersisted: 1, networkRequestsNotPersisted: 2, costObservedMicros: 100 });
    expect(activity.unpersistedTraceIds).toEqual(['tr-2']);
    expect(activity.byOperation.t3_value_conflict).toMatchObject({ usageEventsNotPersisted: 1, networkRequestsNotPersisted: 2 });
    // Publié : la mesure physique (3), jamais ramenée aux seules lignes écrites (1).
    expect(act.publishedAiCounters(activity, 1, 'T3')).toMatchObject({ semantics: 'MEASURED_V1', providerCalls: 3, providerCallsCertified: 3 });
    const compact = act.compactAiActivity(activity) as { total: Record<string, number>; unpersistedTraceIds?: string[] };
    expect(compact.total.networkRequestsNotPersisted).toBe(2);
    expect(compact.unpersistedTraceIds).toEqual(['tr-2']);
  });

  it('sans perte : compteurs à zéro, aucune clé parasite dans le relevé compact', async () => {
    const { activity } = await act.measureAiActivity(async () => { act.noteAiUsageEvent(fait()); });
    expect(activity.total).toMatchObject({ usageEventsNotPersisted: 0, networkRequestsNotPersisted: 0 });
    expect(activity.unpersistedTraceIds).toBeUndefined();
    expect((act.compactAiActivity(activity) as { byOperation: Record<string, Record<string, unknown>> }).byOperation.t3_value_conflict).not.toHaveProperty('usageEventsNotPersisted');
  });

  it('DECLARED : la valeur déclarative n’est JAMAIS certifiée ; lecture unique MEASURED / DECLARED / UNKNOWN', () => {
    // Règle remplacée (carte #828) : `providerCalls` reste lisible avec son étiquette DECLARED (compatibilité des
    // résultats en mémoire) mais la valeur CERTIFIÉE — la seule écrite dans `provider_calls` et exposée — est nulle.
    expect(act.publishedAiCounters(null, 3, 'T3')).toMatchObject({ semantics: 'DECLARED', declaredRequests: 3, providerCallsCertified: null });
    expect(act.certifiedProviderCalls('MEASURED_V1', 0)).toEqual({ nature: 'MEASURED', providerCalls: 0, declaredRequests: null, legacyValue: null });
    expect(act.certifiedProviderCalls('MEASURED_V1', '4', 1)).toMatchObject({ nature: 'MEASURED', providerCalls: 4, declaredRequests: 1 });
    expect(act.certifiedProviderCalls('DECLARED', 3)).toEqual({ nature: 'DECLARED', providerCalls: null, declaredRequests: 3, legacyValue: null });
    expect(act.certifiedProviderCalls('DECLARED', null, 3)).toMatchObject({ nature: 'DECLARED', providerCalls: null, declaredRequests: 3 });
    // Historique : un 0 d'origine n'est pas un « zéro appel prouvé ».
    expect(act.certifiedProviderCalls(null, 0)).toEqual({ nature: 'UNKNOWN', providerCalls: null, declaredRequests: null, legacyValue: 0 });
    expect(act.certifiedProviderCalls(undefined, 7)).toMatchObject({ nature: 'UNKNOWN', providerCalls: null, legacyValue: 7 });
    expect(act.certifiedProviderCalls(null, null)).toMatchObject({ nature: 'UNKNOWN', providerCalls: null, legacyValue: null });
    expect([act.certifiedWithoutAiCall('MEASURED_V1', 0), act.certifiedWithoutAiCall('MEASURED_V1', 2), act.certifiedWithoutAiCall('DECLARED', 0), act.certifiedWithoutAiCall(null, 0)])
      .toEqual([true, false, null, null]);
  });
});

describe('C828-U07 — écart B : export ZIP (carte #802) — `diagnostics.aiUsage.providerCalls`', () => {
  const ligne = (over: Record<string, unknown>) => ({ id: 1, status: 'success', entree_jetons: 100, sortie_jetons: 10, network_requests: 1, ...over });

  it('requêtes réseau, plus un nombre de lignes : une tentative à 2 requêtes et un rang non sollicité', () => {
    const rows = [ligne({ network_requests: 2 }), ligne({ id: 2, status: 'error', network_requests: 0, entree_jetons: 0, sortie_jetons: 0 }), ligne({ id: 3 })];
    expect(networkRequestsOfUsageRows(rows)).toEqual({ providerCalls: 3, usageEventLines: 3, usageEventsWithoutSend: 1, providerCallsUndetermined: 0 });
    const u = aiUsageOfJobs(rows, [{ business_result_detail: { aiCacheResponses: 2, aiDecisionsReused: 5 } }]);
    // Contrat conservé : mêmes quatre clés qu'avant, plus la sémantique et les lignes dites sous leur vrai nom.
    expect(u).toEqual({
      providerCalls: 3, cacheResponses: 2, decisionsReused: 5, withoutAiCall: false,
      providerCallsSemantics: AI_USAGE_PROVIDER_CALLS_SEMANTICS, usageEventLines: 3, usageEventsWithoutSend: 1, providerCallsUndetermined: 0,
    });
  });

  it('trois lignes sans aucune requête : 0 requête (avant : « 3 appels ») ; aucune ligne : sans appel', () => {
    const sansEnvoi = [1, 2, 3].map((id) => ligne({ id, status: 'error', network_requests: 0, entree_jetons: 0, sortie_jetons: 0 }));
    expect(aiUsageOfJobs(sansEnvoi, [])).toMatchObject({ providerCalls: 0, usageEventLines: 3, usageEventsWithoutSend: 3, withoutAiCall: true });
    expect(aiUsageOfJobs([], [])).toMatchObject({ providerCalls: 0, usageEventLines: 0, withoutAiCall: true });
  });

  it('lignes ANTÉRIEURES à la mesure : comptées si prouvées, sinon indéterminées — et « sans appel » devient inconnu', () => {
    const anciennes = [
      ligne({ id: 1, network_requests: null }),
      ligne({ id: 2, network_requests: null, status: 'error', entree_jetons: 0, sortie_jetons: 0 }),
    ];
    expect(aiUsageOfJobs(anciennes, [])).toMatchObject({ providerCalls: 1, providerCallsUndetermined: 1, withoutAiCall: false });
    expect(aiUsageOfJobs([anciennes[1]], [])).toMatchObject({ providerCalls: 0, providerCallsUndetermined: 1, withoutAiCall: null });
  });

  it('appelant historique (un nombre de lignes) : étiqueté comme tel, jamais « requêtes »', () => {
    expect(aiUsageOfJobs(4, [])).toMatchObject({ providerCalls: 4, providerCallsSemantics: 'USAGE_EVENT_LINES', usageEventLines: 4, withoutAiCall: null });
  });
});

describe('C828-U08 — écart B : textes du BO et de l’export administrateur', () => {
  it('File IA : mesuré, déclaré et historique ont trois textes distincts ; seul le mesuré dit « requête(s) »', () => {
    const base = { aiLogicalRequests: 1, aiProviderAttempts: 2, aiCallsOtherTreatments: 0 };
    expect(jobAiText({ ...base, aiCalls: 2, aiCountersSemantics: 'MEASURED_V1' })).toContain('2 requête(s) réellement émise(s)');
    const declare = jobAiText({ ...base, aiCalls: 2, aiCountersSemantics: 'DECLARED' });
    expect(declare).toBe(' · 2 demande(s) IA déclarée(s) par les phases (appels réels non mesurés : ce n’est pas un nombre d’appels)');
    expect(jobAiText({ ...base, aiCalls: 0, aiCountersSemantics: 'DECLARED' })).toBe(' · aucune demande IA déclarée par les phases (appels réels non mesurés)');
    const ancien = jobAiText({ ...base, aiCalls: 2, aiCountersSemantics: null });
    expect(ancien).toContain('ancienne sémantique');
    for (const t of [declare, ancien]) expect(t).not.toMatch(/requête|appel\(s\) réel/);
  });

  it('export administrateur : « sans appel » ne compte que les passages MESURÉS ; déclarés et historiques dits à part', () => {
    const lignes = usageSummaryLines({
      providerCalls: { total: 5, byOperation: {} }, usageEvents: { total: 9, withoutSend: 2, legacyUndetermined: 1 },
      reuse: { available: true, byKind: {}, cacheResponses: 0, decisionsReused: 0 },
      t3Runs: { total: 10, withoutAiCall: 3, withAiCall: 2, unmeasured: 1, legacySemantics: 3, measured: 5, declared: 1 },
      t3DecisionMemory: { available: false, active: 0, superseded: 0, reused: 0 },
    });
    const t3 = lignes.find(([k]) => k.startsWith('Passages T3 sans appel IA'))!;
    expect(t3[0]).toBe('Passages T3 sans appel IA (mesure certifiée)');
    expect(t3[1]).toBe('3 / 5 mesuré(s), sur 10 passage(s) ; 1 passage(s) à demandes déclarées (appels réels inconnus) ; 3 passage(s) historique(s) en ancienne sémantique (valeur d’origine conservée, appels réels inconnus) ; 1 passage(s) non mesuré(s)');
  });
});
