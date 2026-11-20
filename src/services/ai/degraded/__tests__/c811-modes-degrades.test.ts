/**
 * Carte #811 (P1-C) — modes dégradés des protections anti-redondance : tracés
 * (sans donnée sensible), bornés (jamais une boucle d'appels), signalés quand
 * ils persistent ; diagnostic jamais « actif » si une dépendance manque.
 * Sans base : écriture durable et alerte remplacées, mémoire en tableau.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));
// Les composants du BO sont compilés avec l'ancien runtime JSX : React doit être global (comme dans les tests d'interface).
(globalThis as unknown as { React: typeof React }).React = React;

const dm = await import('../degraded-mode');
const { reviewAmbiguousField, __resetDecisionMemoryDegradedForTests } = await import('../../reconciliation/decision-memory/index');
const { evaluateT3Protections, degradedRowLabel, t3ProtectionSettings } = await import('../../reconciliation/t3-protections');
const { ProtectionsBlock } = await import('@/app/admin/ai-queue/_components/T3Supervision');
type Deps = import('../../reconciliation/decision-memory/index').DecisionMemoryDeps;
type Entry = import('../../reconciliation/decision-memory/store').MemoryEntry;
type Facts = import('../../reconciliation/t3-protections').T3ProtectionFacts;
import type { EvidenceCandidate, ReconciliationDecision } from '../../reconciliation/types';

const traces: import('../degraded-mode').DegradedEvent[] = [];
const alertes: Array<{ component: string; reason: string; count: number }> = [];
const T3 = { treatment: 'T3', operationCode: 't3_value_conflict', accountId: 13 };

beforeEach(() => {
  traces.length = 0; alertes.length = 0;
  dm.__resetDegradedModeForTests({ persist: async (e) => { traces.push(e); }, alert: async (a) => { alertes.push({ component: a.component, reason: a.reason, count: a.count }); } });
  __resetDecisionMemoryDegradedForTests();
  delete process.env.AI_DEGRADED_CALLS_PER_HOUR; delete process.env.AI_DEGRADED_CAP_TREATMENTS;
  delete process.env.AI_DEGRADED_ALERT_COUNT; delete process.env.AI_DEGRADED_ALERT_MINUTES;
});

describe('C811-D01 — trace et borne', () => {
  it('borne par (traitement, opération, compte) et par heure ; fenêtre glissante ; autre portée indépendante', () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '3';
    const t0 = 1_800_000_000_000;
    expect([0, 1, 2, 3, 4].map((i) => dm.admitDegradedCall(T3, t0 + i))).toEqual([true, true, true, false, false]);
    expect(dm.admitDegradedCall({ ...T3, accountId: 14 }, t0)).toBe(true);
    expect(dm.admitDegradedCall({ ...T3, operationCode: 't3_link_ambiguity' }, t0)).toBe(true);
    expect(dm.admitDegradedCall(T3, t0 + 3_600_001)).toBe(true);
    expect(dm.degradedInstanceState(t0 + 3_600_001)).toMatchObject({ callsRefused: 2, callsPerHour: 3, cappedTreatments: ['T3'] });
  });
  it('traitement hors borne (interactif) jamais refusé ; « off » : sans borne ; 0 : aucun appel sans protection', () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '0';
    expect(dm.admitDegradedCall(T3)).toBe(false);
    expect(dm.admitDegradedCall({ ...T3, treatment: 'T2' })).toBe(true);
    expect(dm.admitDegradedCall({ ...T3, treatment: null })).toBe(true);
    process.env.AI_DEGRADED_CALLS_PER_HOUR = 'off';
    expect(dm.admitDegradedCall(T3)).toBe(true);
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '0';
    process.env.AI_DEGRADED_CAP_TREATMENTS = 'T3,T4';
    expect(dm.admitDegradedCall({ ...T3, treatment: 'T4' })).toBe(false);
  });
  it('trace : composant, raison, opération, compte, effet — code technique borné, jamais un message ni une donnée', async () => {
    const e = Object.assign(new Error('relation "t3_decision_memory" does not exist — valeur 1948 du compte Dupont'), { code: '42P01' });
    dm.noteDegraded({ ...T3, component: 'DECISION_MEMORY', reason: 'MIGRATION_MISSING', impact: 'CALL_WITHOUT_PROTECTION', technicalCode: dm.technicalCodeOf(e) });
    await Promise.resolve();
    expect(traces).toEqual([{ ...T3, component: 'DECISION_MEMORY', reason: 'MIGRATION_MISSING', impact: 'CALL_WITHOUT_PROTECTION', technicalCode: '42P01' }]);
    expect(JSON.stringify(dm.degradedInstanceState())).not.toMatch(/1948|Dupont|does not exist/);
    expect(dm.technicalCodeOf(Object.assign(new Error('x'), { code: 'ECONN RESET; DROP TABLE' }))).toBe('ECONNRESETDROPTABLE');
    expect(dm.technicalCodeOf(null)).toBeNull();
    expect(dm.degradedRecently(T3)).toBe(true);
    expect(dm.degradedRecently({ ...T3, accountId: 99 })).toBe(false);
  });
  it('alerte seulement quand la dégradation PERSISTE (nombre ou durée), une fois par heure et par épisode', async () => {
    process.env.AI_DEGRADED_ALERT_COUNT = '3';
    const t0 = 1_800_000_000_000;
    const ev = { ...T3, component: 'RESPONSE_CACHE' as const, reason: 'WRITE_FAILED' as const, impact: 'RESULT_NOT_STORED' as const };
    dm.noteDegraded(ev, t0); dm.noteDegraded(ev, t0 + 1);
    await Promise.resolve();
    expect(alertes).toHaveLength(0);
    dm.noteDegraded(ev, t0 + 2); dm.noteDegraded(ev, t0 + 3);
    await Promise.resolve();
    expect(alertes).toEqual([{ component: 'RESPONSE_CACHE', reason: 'WRITE_FAILED', count: 3 }]);
    // Durée : une autre dégradation, vue deux fois à 31 minutes d'écart (défaut 30 min).
    process.env.AI_DEGRADED_ALERT_COUNT = '1000';
    const autre = { ...T3, component: 'DECISION_MEMORY' as const, reason: 'READ_FAILED' as const, impact: 'CALL_WITHOUT_PROTECTION' as const };
    dm.noteDegraded(autre, t0); dm.noteDegraded(autre, t0 + 31 * 60_000);
    await Promise.resolve();
    expect(alertes.map((a) => a.component)).toEqual(['RESPONSE_CACHE', 'DECISION_MEMORY']);
  });
});

// ── Mémoire des décisions en mode dégradé ───────────────────────────────────────────────────────────────────────
const preuve = (id: number, value: unknown): EvidenceCandidate => ({
  evidenceId: id, value, normalized: String(value), confidence: 'probable', authorityScore: 50, documentType: 'DIAGNOSTIC',
  documentDate: new Date('2024-03-04T00:00:00Z'), sourceId: 900 + id, excerpt: `Année de construction : ${String(value)}`,
});
const demande = (ids: number[], proposed: unknown): ReconciliationDecision => ({
  fieldKey: 'constructionYear', currentValue: null, proposedValue: proposed, action: 'request_ai_review',
  reasonCode: 'AMBIGUOUS_EVIDENCE', confidence: 'probable', evidenceIds: ids, deterministic: true,
});
function banc(o: { ready?: boolean; reason?: 'DISABLED_BY_CONFIG' | 'MIGRATION_MISSING' | 'READ_FAILED'; findFails?: boolean; recordFails?: () => boolean } = {}) {
  const lignes: Array<Entry & { status: 'ACTIVE' | 'SUPERSEDED' }> = [];
  const etat = { appels: 0, sig: 't3_master_v1@file#aaaa', ecritures: 0 };
  const deps: Deps = {
    ready: async () => o.ready ?? true,
    unavailableReason: async () => (o.ready === false ? o.reason ?? 'MIGRATION_MISSING' : null),
    findActive: async () => { if (o.findFails) throw Object.assign(new Error('connexion perdue'), { code: 'ECONNRESET' }); return lignes.find((l) => l.status === 'ACTIVE') ?? null; },
    noteReused: async (id) => { lignes.find((x) => x.id === id)!.reuseCount++; },
    record: async (_k, d) => {
      etat.ecritures++;
      if (o.recordFails?.()) throw Object.assign(new Error('écriture refusée'), { code: '57014' });
      for (const l of lignes) if (l.status === 'ACTIVE') l.status = 'SUPERSEDED';
      lignes.push({ id: lignes.length + 1, fingerprint: d.fingerprint, parts: d.parts, outcome: d.outcome, decision: d.decision, aiSource: d.aiSource, aiTraceId: d.aiTraceId, retryAfter: d.retryAfter, reuseCount: 0, createdAt: new Date(), status: 'ACTIVE' });
      return lignes.length;
    },
    userResolution: async () => null,
    aiConfigSignature: async () => etat.sig,
    resolve: async (input) => {
      etat.appels++;
      return { decision: { ...input.decision, action: 'create_conflict', deterministic: false }, aiSource: 'PROVIDER', traceId: `tr-${etat.appels}`, errorCode: null, providerContacted: true, abstained: true };
    },
    count: async () => undefined,
    now: () => new Date('2026-11-20T08:00:00Z'),
  };
  const passage = (accountId = 13, valeur = 1948) => reviewAmbiguousField({
    accountId, assetId: 14, canonicalKey: 'constructionYear', decision: demande([1238], valeur), candidates: [preuve(1238, valeur)],
    currentValue: null, currentOrigin: 'USER', force: null,
  }, deps);
  return { deps, lignes, etat, passage };
}
const effets = () => traces.map((t) => `${t.component}/${t.reason}/${t.impact}`);

describe('C811-D02 — mémoire indisponible : résultat sûr, dégradation visible, appels bornés', () => {
  it.each([['DISABLED_BY_CONFIG'], ['MIGRATION_MISSING'], ['READ_FAILED']] as const)('mémoire %s : appel permis et tracé, puis refusé une fois la borne atteinte (conflit prudent, rien de mémorisé)', async (reason) => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '2';
    const b = banc({ ready: false, reason });
    const r = [await b.passage(), await b.passage(), await b.passage(), await b.passage()];
    expect(b.etat.appels).toBe(2);
    expect(r.map((x) => x.degraded)).toEqual(['CALL_WITHOUT_PROTECTION', 'CALL_WITHOUT_PROTECTION', 'CALL_REFUSED', 'CALL_REFUSED']);
    // Repli sûr : conflit laissé à l'utilisateur, aucune valeur écrite, aucun appel compté.
    expect(r[3]).toMatchObject({ source: 'FAILED', providerCalls: 0, reused: false, memoryId: null, decision: { action: 'create_conflict', deterministic: true } });
    expect(b.lignes).toHaveLength(0);
    await Promise.resolve();
    expect(effets()).toEqual([
      `DECISION_MEMORY/${reason}/CALL_WITHOUT_PROTECTION`, `DECISION_MEMORY/${reason}/CALL_WITHOUT_PROTECTION`,
      `DECISION_MEMORY/${reason}/CALL_REFUSED`, `DECISION_MEMORY/${reason}/CALL_REFUSED`,
    ]);
    expect(traces.every((t) => t.accountId === 13 && t.operationCode === 't3_value_conflict' && t.treatment === 'T3')).toBe(true);
  });
  it('lecture de la mémoire en échec (connexion perdue) : même règle, code technique tracé', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '1';
    const b = banc({ findFails: true });
    const r = [await b.passage(), await b.passage()];
    expect(b.etat.appels).toBe(1);
    expect(r.map((x) => x.degraded)).toEqual(['CALL_WITHOUT_PROTECTION', 'CALL_REFUSED']);
    await Promise.resolve();
    expect(traces[0]).toMatchObject({ component: 'DECISION_MEMORY', reason: 'READ_FAILED', technicalCode: 'ECONNRESET' });
  });
  it('mémoire saine : aucune trace, aucune consommation de la borne', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '0';
    const b = banc();
    const r1 = await b.passage();
    const r2 = await b.passage();
    expect(b.etat.appels).toBe(1);
    expect(r1.degraded).toBeUndefined();
    expect(r2).toMatchObject({ source: 'MEMORY', reused: true });
    expect(traces).toHaveLength(0);
  });
});

describe('C811-D03 — signature de configuration non résolue : ni réutilisation obsolète, ni rappel invisible', () => {
  it('non résolue : décision mémorisée NON réutilisée, appel tracé et borné, rien d’enregistré, entrée active intacte ; résolue de nouveau : réutilisée', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '1';
    const b = banc();
    await b.passage();
    expect(b.etat.appels).toBe(1);
    const active = b.lignes[0];
    b.etat.sig = 'unresolved';
    const r1 = await b.passage();
    expect(r1).toMatchObject({ reused: false, memoryId: null, degraded: 'CALL_WITHOUT_PROTECTION', reevaluation: ['AI_CONFIG_UNRESOLVED'] });
    expect(b.etat.appels).toBe(2);
    const r2 = await b.passage();
    expect(r2).toMatchObject({ degraded: 'CALL_REFUSED', source: 'FAILED', providerCalls: 0 });
    expect(b.etat.appels).toBe(2);
    expect(b.lignes).toHaveLength(1);
    expect(b.lignes[0]).toBe(active);
    expect(active.status).toBe('ACTIVE');
    await Promise.resolve();
    expect(effets()).toEqual(['CONFIG_SIGNATURE/SIGNATURE_UNRESOLVED/CALL_WITHOUT_PROTECTION', 'CONFIG_SIGNATURE/SIGNATURE_UNRESOLVED/CALL_REFUSED']);
    b.etat.sig = 't3_master_v1@file#aaaa';
    expect(await b.passage()).toMatchObject({ source: 'MEMORY', reused: true });
    expect(b.etat.appels).toBe(2);
  });
  it('une entrée enregistrée AUTREFOIS sous « unresolved » n’est jamais réutilisée tant que la signature reste non résolue', async () => {
    const b = banc();
    b.etat.sig = 'unresolved';
    // État d'avant la carte : une entrée active dont la composante « ai » vaut « unresolved ».
    const { decisionFingerprint } = await import('../../reconciliation/decision-memory/fingerprint');
    const r0 = await b.passage();
    expect(r0.memoryId).toBeNull();
    expect(decisionFingerprint).toBeTypeOf('function');
    expect(b.lignes).toHaveLength(0);
  });
});

describe('C811-D04 — décision non mémorisée (écriture en échec) : tracée, le rappel est borné', () => {
  it('une seconde tentative immédiate suffit pour un incident passager (aucune trace)', async () => {
    let n = 0;
    const b = banc({ recordFails: () => ++n === 1 });
    const r = await b.passage();
    expect(b.etat.ecritures).toBe(2);
    expect(r.memoryId).toBe(1);
    expect(r.degraded).toBeUndefined();
    expect(traces).toHaveLength(0);
  });
  it('échec durable : décision rendue mais tracée « non conservée » ; les rappels suivants consomment la borne puis sont refusés', async () => {
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '1';
    const b = banc({ recordFails: () => true });
    const r1 = await b.passage();
    expect(r1).toMatchObject({ source: 'PROVIDER', memoryId: null, degraded: 'RESULT_NOT_STORED' });
    const r2 = await b.passage();
    expect(r2.degraded).toBe('RESULT_NOT_STORED');
    const r3 = await b.passage();
    expect(r3).toMatchObject({ degraded: 'CALL_REFUSED', providerCalls: 0, decision: { action: 'create_conflict' } });
    expect(b.etat.appels).toBe(2);
    await Promise.resolve();
    expect(effets()).toEqual(['DECISION_MEMORY/WRITE_FAILED/RESULT_NOT_STORED', 'DECISION_MEMORY/WRITE_FAILED/RESULT_NOT_STORED', 'DECISION_MEMORY/WRITE_FAILED/CALL_REFUSED']);
    expect(traces[0].technicalCode).toBe('57014');
  });
});

describe('C811-D05 — diagnostic : jamais « actif » si une dépendance manque', () => {
  const sain: Facts = {
    memoryTable: true, memoryEnabled: true, memoryReadable: true, cacheTable: true, cacheColumns0857: true, cacheDisabledByEnv: false,
    reservationUsable: true, reuseCounters0858: true, runCounters0858: true, sweepIndex0859: true, measuredCounters1860: true,
    degradedTrace1861: true, prefilterEnabled: true, configSignature: 't3_master_v1@file#abcd', degradedLast24h: [],
    instance: { episodes: [], callsAllowed: 0, callsRefused: 0, callsPerHour: 20, cappedTreatments: ['T3'] }, probeError: null,
  };
  const statut = (over: Partial<Facts>) => evaluateT3Protections({ ...sain, ...over });
  it('tout en place → ACTIVE, aucun avertissement', () => {
    const r = statut({});
    expect(r.status).toBe('ACTIVE');
    expect(r.findings.every((f) => f.level === 'ok')).toBe(true);
  });
  it.each([
    ['migration 0856 absente', { memoryTable: false }, 'MIGRATION_0856'],
    ['mémoire désactivée', { memoryEnabled: false }, 'MEMORY_ENABLED'],
    ['mémoire illisible', { memoryReadable: false }, 'MEMORY_USABLE'],
    ['migration 0857 absente', { cacheColumns0857: false }, 'MIGRATION_0857'],
    ['table du cache absente', { cacheTable: false }, 'MIGRATION_0857'],
    ['cache désactivé', { cacheDisabledByEnv: true }, 'CACHE_ENABLED'],
    ['réservation inutilisable', { reservationUsable: false }, 'RESERVATION_USABLE'],
    ['signature non résolue', { configSignature: 'unresolved' }, 'CONFIG_SIGNATURE'],
    ['base illisible', { memoryTable: null, cacheTable: null, cacheColumns0857: null }, 'MIGRATION_0856'],
  ] as Array<[string, Partial<Facts>, string]>)('%s → INACTIVE', (_n, over, code) => {
    const r = statut(over);
    expect(r.status).toBe('INACTIVE');
    expect(r.findings.find((f) => f.code === code)?.level).toBe('error');
  });
  it.each([
    ['préfiltre désactivé', { prefilterEnabled: false }, 'SWEEP_PREFILTER'],
    ['migration 0858 absente', { reuseCounters0858: false }, 'MIGRATION_0858'],
    ['index 0859 absent', { sweepIndex0859: false }, 'MIGRATION_0859'],
    ['migration 1860 absente', { measuredCounters1860: false }, 'MIGRATION_1860'],
    ['migration 1861 absente', { degradedTrace1861: false }, 'MIGRATION_1861'],
    ['dégradation récente', { degradedLast24h: [{ component: 'RESPONSE_CACHE', reason: 'WRITE_FAILED', impact: 'CALL_REFUSED', treatment: 'T3', operationCode: 't3_value_conflict', accounts: 1, count: 4, firstAt: null, lastAt: null, technicalCode: '57014' }] }, 'DEGRADED_24H'],
  ] as Array<[string, Partial<Facts>, string]>)('%s → DEGRADED (jamais ACTIVE)', (_n, over, code) => {
    const r = statut(over);
    expect(r.status).toBe('DEGRADED');
    expect(r.findings.find((f) => f.code === code)?.level).toBe('warn');
  });
  it('libellés et réglages : français simple, noms de variables seulement', () => {
    expect(degradedRowLabel({ component: 'DECISION_MEMORY', reason: 'WRITE_FAILED', impact: 'CALL_REFUSED', treatment: 'T3', operationCode: 't3_value_conflict', accounts: 2, count: 5, technicalCode: '57014' }))
      .toBe('Mémoire durable des décisions T3 — écriture en échec : appel refusé (budget dégradé épuisé), repli sans IA · 5 fois · T3 / t3_value_conflict · 2 compte(s) · code 57014');
    const noms = t3ProtectionSettings().map((s) => s.name);
    expect(noms).toEqual(expect.arrayContaining(['T3_DECISION_MEMORY_ENABLED', 'T3_SWEEP_PREFILTER', 'T3_SWEEP_COVERAGE_HOURS', 'AI_IDEMPOTENCY_LEASE_SECONDS', 'AI_DEGRADED_CALLS_PER_HOUR']));
  });
  it('BO : état affiché ; diagnostic illisible → « État inconnu », jamais « actives » ; serveur antérieur → rien', () => {
    const base = { generatedAt: '', workers: {}, executor: {}, queue: {}, schedule: {}, lastManual: null, lastAutomatic: null, lastSweep: null } as never as import('@/app/admin/ai-queue/_components/T3Supervision').T3SupervisionData;
    const rendu = (protections: unknown) => renderToStaticMarkup(h(ProtectionsBlock, { data: { ...base, protections } as never }));
    const r = statut({ memoryTable: false });
    const html = rendu({ checkedAt: '2026-11-20T08:00:00Z', status: r.status, statusLabel: 'Protections anti-redondance NON effectives : une dépendance manque', findings: r.findings, settings: t3ProtectionSettings(), degraded: { durableAvailable: true, last24h: [], instance: sain.instance } });
    expect(html).toContain('data-status="INACTIVE"');
    expect(html).toContain('NON effectives');
    expect(html).toContain('Migration 0856 ABSENTE');
    expect(html).not.toContain('Protections anti-redondance actives');
    const inconnu = rendu(null);
    expect(inconnu).toContain('data-status="UNKNOWN"');
    expect(inconnu).toContain('État inconnu');
    expect(inconnu).not.toContain('actives</span>');
    expect(rendu(undefined)).toBe('');
    // Aucune couleur brute (charte Sérénité) : jetons seulement.
    expect(html).not.toMatch(/style=|\[#[0-9a-fA-F]{3,6}\]|rgb\(/);
  });
});
