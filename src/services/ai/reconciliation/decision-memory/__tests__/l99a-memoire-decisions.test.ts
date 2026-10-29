/**
 * Lot 99A (ticket P1 « T3 — Supprimer les appels IA redondants », point A) —
 * mémoire durable des décisions T3 consultée AVANT tout appel IA. Sans base :
 * dépendances injectées (mémoire en tableau, résolveur simulé).
 *
 *   L99A-M01  deux passages identiques : un seul appel, la décision (abstention) est réutilisée
 *   L99A-M02  réutilisation sans appel même si le cache temporaire a expiré (le cache n'est plus lu)
 *   L99A-M03  nouvelle preuve / valeur / résolution utilisateur / règle / configuration IA → réévaluation, motif tracé
 *   L99A-M04  relance forcée tracée : appel hors cache, entrée remplacée, compteur DECISION_FORCED
 *   L99A-M05  échec IA après contact fournisseur : mémorisé, pas de rappel avant l'heure de nouvelle tentative
 *   L99A-M06  refus AVANT contact (arrêt d'urgence, plafond) : rien de mémorisé
 *   L99A-M07  mémoire indisponible ou illisible : comportement antérieur (appel), jamais bloquant
 *   L99A-M08  empreinte : stable, composantes séparées, aucune valeur en clair
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));

const { reviewAmbiguousField, isReusable, memoryOutcomeOf } = await import('../index');
const { decisionFingerprint, reevaluationReasons, canonicalJson } = await import('../fingerprint');
type Deps = import('../index').DecisionMemoryDeps;
type Entry = import('../store').MemoryEntry;
type ValueConflictOutcome = import('../../master/value-conflict').ValueConflictOutcome;
import type { EvidenceCandidate, ReconciliationDecision } from '../../types';

const preuve = (id: number, value: unknown, over: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  evidenceId: id, value, normalized: String(value), confidence: 'probable', authorityScore: 50, documentType: 'DIAGNOSTIC',
  documentDate: new Date('2024-03-04T00:00:00Z'), sourceId: 900 + id, excerpt: `Année de construction : ${String(value)}`, ...over,
});
const demande = (ids: number[], proposed: unknown): ReconciliationDecision => ({
  fieldKey: 'constructionYear', currentValue: null, proposedValue: proposed, action: 'request_ai_review',
  reasonCode: 'AMBIGUOUS_EVIDENCE', confidence: 'probable', evidenceIds: ids, deterministic: true,
});

/** Mémoire en tableau + résolveur simulé (compte les appels « fournisseur »). */
function banc(opts: { reponse?: (n: number) => ValueConflictOutcome; ready?: boolean | 'throw' } = {}) {
  const lignes: Array<Entry & { status: 'ACTIVE' | 'SUPERSEDED'; supersedeReason?: string; forced: boolean }> = [];
  const compteurs: string[] = [];
  const cles: Array<string | undefined> = [];
  let appels = 0;
  let maintenant = new Date('2026-10-27T07:41:00Z');
  let user: string | null = null;
  let sig = 't3_master_v1@file#aaaa';
  const deps: Deps = {
    ready: async () => { if (opts.ready === 'throw') throw new Error('base'); return opts.ready ?? true; },
    findActive: async (k) => lignes.find((l) => l.status === 'ACTIVE' && l.fingerprint !== '' && k.fieldKey === l.decision.fieldKey) ?? null,
    noteReused: async (id) => { const l = lignes.find((x) => x.id === id)!; l.reuseCount++; },
    record: async (_k, d) => {
      for (const l of lignes) if (l.status === 'ACTIVE') { l.status = 'SUPERSEDED'; l.supersedeReason = d.supersedeReason; }
      const id = lignes.length + 1;
      lignes.push({
        id, fingerprint: d.fingerprint, parts: d.parts, outcome: d.outcome, decision: d.decision, aiSource: d.aiSource,
        aiTraceId: d.aiTraceId, retryAfter: d.retryAfter, reuseCount: 0, createdAt: maintenant, status: 'ACTIVE', forced: d.forced,
      });
      return id;
    },
    userResolution: async () => user,
    aiConfigSignature: async () => sig,
    resolve: async (input, o) => {
      appels++;
      cles.push(o.idempotencyKey);
      return opts.reponse?.(appels) ?? {
        decision: { ...input.decision, action: 'create_conflict', deterministic: false }, aiSource: 'PROVIDER', traceId: `tr-${appels}`,
        errorCode: null, providerContacted: true, abstained: true,
      };
    },
    count: async (e) => { compteurs.push(e.kind); },
    now: () => maintenant,
  };
  return {
    deps, lignes, compteurs, cles,
    get appels() { return appels; },
    avancer: (ms: number) => { maintenant = new Date(maintenant.getTime() + ms); },
    setUser: (u: string | null) => { user = u; },
    setSig: (s: string) => { sig = s; },
  };
}

const passage = (b: ReturnType<typeof banc>, over: { candidates?: EvidenceCandidate[]; current?: unknown; origin?: string; force?: string } = {}) => {
  const candidates = over.candidates ?? [preuve(1238, 1948)];
  return reviewAmbiguousField({
    accountId: 13, assetId: 14, canonicalKey: 'constructionYear',
    decision: { ...demande(candidates.map((c) => c.evidenceId), candidates[0].value), currentValue: over.current ?? null },
    candidates, currentValue: over.current ?? null, currentOrigin: over.origin ?? 'USER',
    force: over.force ? { reason: over.force } : null,
  }, b.deps);
};

describe('L99A-M01/M02 — contexte identique : aucune nouvelle invocation', () => {
  it('L99A-M01 : deux passages horaires identiques → 1 appel, abstention mémorisée puis réutilisée telle quelle', async () => {
    const b = banc();
    const p1 = await passage(b);
    expect(b.appels).toBe(1);
    expect(p1).toMatchObject({ source: 'PROVIDER', providerCalls: 1, reused: false, reevaluation: ['FIRST_EVALUATION'] });
    expect(b.lignes).toHaveLength(1);
    expect(b.lignes[0]).toMatchObject({ outcome: 'ABSTAIN', aiSource: 'PROVIDER', aiTraceId: 'tr-1' });
    expect(b.lignes[0].decision).not.toHaveProperty('aiSource');

    b.avancer(3600_000);
    const p2 = await passage(b);
    expect(b.appels).toBe(1);
    expect(p2).toMatchObject({ source: 'MEMORY', providerCalls: 0, reused: true, reevaluation: null, memoryId: 1 });
    expect(p2.decision).toMatchObject({ action: 'create_conflict', fieldKey: 'constructionYear', aiSource: 'MEMORY' });
    expect(b.lignes).toHaveLength(1); // arbitrage existant conservé, jamais réécrit
    expect(b.lignes[0].reuseCount).toBe(1);
    expect(b.compteurs).toEqual(['DECISION_REUSED']);
  });

  it('L99A-M02 : 24 passages horaires (cache d’une heure expiré à chaque fois) → toujours 1 seul appel réel', async () => {
    const b = banc();
    for (let h = 0; h < 24; h++) { await passage(b); b.avancer(3600_000 + 1); }
    expect(b.appels).toBe(1);
    expect(b.lignes[0].reuseCount).toBe(23);
    expect(b.compteurs.filter((k) => k === 'DECISION_REUSED')).toHaveLength(23);
  });
});

describe('L99A-M03 — changement pertinent → réévaluation tracée', () => {
  it('nouvelle preuve : réévaluation (EVIDENCE_CHANGED), l’ancienne décision est remplacée avec son motif', async () => {
    const b = banc({
      reponse: (n) => n === 1
        ? { decision: { ...demande([1238], 1948), action: 'create_conflict', deterministic: false }, aiSource: 'PROVIDER', traceId: 'tr-1', errorCode: null, providerContacted: true, abstained: true }
        : { decision: { ...demande([1238, 1500], 1948), action: 'apply', proposedValue: 1948, evidenceIds: [1500], deterministic: false }, aiSource: 'PROVIDER', traceId: 'tr-2', errorCode: null, providerContacted: true },
    });
    await passage(b);
    const p = await passage(b, { candidates: [preuve(1238, 1948), preuve(1500, 1948, { documentType: 'ACTE_NOTARIE', authorityScore: 90 })] });
    expect(b.appels).toBe(2);
    expect(p.reevaluation).toEqual(['EVIDENCE_CHANGED', 'RULES_CHANGED']);
    expect(p.decision).toMatchObject({ action: 'apply', proposedValue: 1948, aiSource: 'PROVIDER' });
    expect(b.lignes.map((l) => [l.status, l.outcome])).toEqual([['SUPERSEDED', 'ABSTAIN'], ['ACTIVE', 'APPLY']]);
    expect(b.lignes[0].supersedeReason).toBe('EVIDENCE_CHANGED,RULES_CHANGED');
    expect(b.compteurs).toEqual(['DECISION_REEVALUATED']);
  });

  it('valeur en place, résolution utilisateur, configuration IA : chacune son motif', async () => {
    const b = banc();
    await passage(b);
    b.setUser('2026-10-27T08:00:00.000Z#1');
    expect((await passage(b)).reevaluation).toEqual(['USER_RESOLUTION']);
    b.setSig('t3_master_v1@pv12:bbbb#cccc');
    expect((await passage(b)).reevaluation).toEqual(['AI_CONFIG_CHANGED']);
    expect((await passage(b, { current: 1950, origin: 'RECONCILIATION' })).reevaluation).toEqual(['VALUE_CHANGED']);
    expect(b.appels).toBe(4);
    // Puis stable : plus aucun appel.
    await passage(b, { current: 1950, origin: 'RECONCILIATION' });
    expect(b.appels).toBe(4);
  });

  it('une nouvelle exécution horaire n’est jamais, à elle seule, un motif (aucune composante temporelle)', async () => {
    const b = banc();
    await passage(b);
    b.avancer(30 * 24 * 3600_000);
    expect((await passage(b)).reused).toBe(true);
    expect(b.appels).toBe(1);
  });
});

describe('L99A-M04 — relance forcée explicitement tracée', () => {
  it('appel hors cache (clé « forced »), entrée remplacée (forced), compteur DECISION_FORCED', async () => {
    const b = banc();
    await passage(b);
    const p = await passage(b, { force: 'relance forcée par l’administrateur #1 (job #4813)' });
    expect(b.appels).toBe(2);
    expect(p.reevaluation).toEqual(['FORCED']);
    expect(b.cles[0]).toMatch(/^t3vc:a13:[0-9a-f]{64}$/);
    expect(b.cles[1]).toMatch(/^t3vc:a13:[0-9a-f]{64}:forced:/);
    expect(b.lignes.map((l) => [l.status, l.forced])).toEqual([['SUPERSEDED', false], ['ACTIVE', true]]);
    expect(b.compteurs).toEqual(['DECISION_FORCED']);
    // Le passage suivant (non forcé) réutilise la décision forcée.
    expect((await passage(b)).reused).toBe(true);
    expect(b.appels).toBe(2);
  });
});

describe('L99A-M05/M06 — échecs IA', () => {
  const echec = (code: string, contacte: boolean): ValueConflictOutcome => ({
    decision: { ...demande([1238], 1948), action: 'create_conflict', deterministic: true }, aiSource: 'FAILED', traceId: 'tr-x', errorCode: code, providerContacted: contacte,
  });

  it('L99A-M05 : sortie invalide (fournisseur contacté) → mémorisée AI_FAILED, réutilisée jusqu’à l’heure de nouvelle tentative', async () => {
    const b = banc({ reponse: () => echec('INVALID_OUTPUT', true) });
    const p1 = await passage(b);
    expect(p1).toMatchObject({ source: 'FAILED', providerCalls: 1 });
    expect(b.lignes[0]).toMatchObject({ outcome: 'AI_FAILED', aiSource: 'UNAVAILABLE' });
    expect(b.lignes[0].retryAfter!.getTime()).toBe(new Date('2026-10-27T07:41:00Z').getTime() + 360 * 60_000);
    b.avancer(3600_000);
    expect((await passage(b)).reused).toBe(true);
    expect(b.appels).toBe(1);
    b.avancer(6 * 3600_000);
    const p3 = await passage(b);
    expect(b.appels).toBe(2);
    expect(p3.reevaluation).toEqual(['RETRY_AFTER_FAILURE']);
  });

  it('L99A-M06 : refus avant contact (arrêt d’urgence) → rien de mémorisé, 0 appel réel compté', async () => {
    const b = banc({ reponse: () => echec('AI_BLOCKED', false) });
    const p = await passage(b);
    expect(p).toMatchObject({ source: 'FAILED', providerCalls: 0, memoryId: null });
    expect(b.lignes).toHaveLength(0);
  });

  it('réponse servie par le cache temporaire : 0 appel réel, comptée « cache »', async () => {
    const b = banc({ reponse: () => ({ decision: { ...demande([1238], 1948), action: 'create_conflict', deterministic: false }, aiSource: 'CACHE', traceId: 'tr-0', errorCode: null, providerContacted: false, abstained: true }) });
    const p = await passage(b);
    expect(p).toMatchObject({ source: 'CACHE', providerCalls: 0, cacheHit: true });
    expect(b.lignes[0]).toMatchObject({ aiSource: 'CACHE', outcome: 'ABSTAIN' });
  });
});

describe('L99A-M07 — mémoire indisponible : jamais bloquant', () => {
  it('table absente (ou T3_DECISION_MEMORY_ENABLED=0) : appel comme avant, rien d’écrit', async () => {
    const b = banc({ ready: false });
    await passage(b);
    await passage(b);
    expect(b.appels).toBe(2);
    expect(b.lignes).toHaveLength(0);
  });
  it('lecture en échec : appel comme avant', async () => {
    const b = banc({ ready: 'throw' });
    expect((await passage(b)).source).toBe('PROVIDER');
  });
});

describe('L99A-M08 — empreinte (pure)', () => {
  const base = {
    accountId: 13, objectType: 'ASSET' as const, objectId: 14, fieldKey: 'constructionYear',
    variables: { FIELD: 'constructionYear', EVIDENCES: [{ id: 1238, value: 1948, excerpt: 'Année de construction : 1948' }] },
    currentValue: null, currentOrigin: 'USER',
    request: { reasonCode: 'AMBIGUOUS_EVIDENCE', proposedValue: 1948, evidenceIds: [1238], confidence: 'probable' },
    rules: { authorityMatrixVersion: 'v1-2026-07', equivalenceMargin: 5 }, userResolution: null, aiConfigSignature: 'sig',
  };
  it('stable (ordre des clés et des preuves citées indifférent), sensible à chaque composante', () => {
    const a = decisionFingerprint(base);
    expect(decisionFingerprint({ ...base, request: { ...base.request, evidenceIds: [1238] } }).fingerprint).toBe(a.fingerprint);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    for (const [k, v] of [
      ['accountId', 99], ['objectId', 15], ['currentValue', 1950], ['userResolution', 'x'], ['aiConfigSignature', 'autre'],
    ] as const) expect(decisionFingerprint({ ...base, [k]: v }).fingerprint).not.toBe(a.fingerprint);
    expect(reevaluationReasons(a.parts, decisionFingerprint({ ...base, currentValue: 1950 }).parts)).toEqual(['VALUE_CHANGED']);
    expect(reevaluationReasons(null, a.parts)).toEqual(['FIRST_EVALUATION']);
  });
  it('aucune valeur ni aucun extrait en clair dans les composantes', () => {
    const { parts } = decisionFingerprint(base);
    expect(JSON.stringify(parts)).not.toMatch(/1948|Année/);
  });
  it('réutilisable : même empreinte, non forcée ; échec seulement avant l’heure de nouvelle tentative', () => {
    const now = new Date('2026-10-27T10:00:00Z');
    expect(isReusable({ fingerprint: 'f', outcome: 'ABSTAIN', retryAfter: null }, 'f', now, false)).toBe(true);
    expect(isReusable({ fingerprint: 'f', outcome: 'ABSTAIN', retryAfter: null }, 'g', now, false)).toBe(false);
    expect(isReusable({ fingerprint: 'f', outcome: 'ABSTAIN', retryAfter: null }, 'f', now, true)).toBe(false);
    expect(isReusable({ fingerprint: 'f', outcome: 'AI_FAILED', retryAfter: new Date('2026-10-27T11:00:00Z') }, 'f', now, false)).toBe(true);
    expect(isReusable({ fingerprint: 'f', outcome: 'AI_FAILED', retryAfter: new Date('2026-10-27T09:00:00Z') }, 'f', now, false)).toBe(false);
    expect(memoryOutcomeOf({ decision: demande([1], 1), aiSource: 'FAILED' })).toBe('AI_FAILED');
    expect(memoryOutcomeOf({ decision: { ...demande([1], 1), action: 'create_conflict' }, aiSource: 'PROVIDER', abstained: false })).toBe('CONFLICT');
  });
});
