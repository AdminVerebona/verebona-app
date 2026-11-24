/**
 * Carte #811 (écart P1-C du #596) — modes dégradés, cache et mémoire sur
 * PostgreSQL réel (recette R05 et R06). Fournisseur simulé, aucun réseau.
 *
 *   C811-E01  diagnostic : base saine → aucune dépendance manquante ; mémoire absente / désactivée → NON effectives
 *   C811-E02  mémoire désactivée par configuration : résultat sûr, dégradation tracée (durable), appels BORNÉS ;
 *             mémoire réactivée : un appel puis réutilisation
 *   C811-E03  table de la mémoire absente ; écriture mémoire en échec : tracées, jamais bloquantes
 *   C811-E04  signature de configuration non résolue : ni réutilisation, ni enregistrement ; entrée active intacte,
 *             réutilisée dès que la signature se résout
 *   C811-E05  cache indisponible (table inaccessible = perte d'accès) : appels bornés, refus avant contact, traitement
 *             interactif jamais bloqué ; alerte de supervision quand la dégradation persiste ; retour à la normale
 *   C811-E06  DEUX INSTANCES (connexions réelles distinctes), même clé, appel PLUS LONG que le bail : un seul appel
 *             (bail renouvelé), la seconde instance reçoit la réponse partagée
 *   C811-E07  ARRÊT de l'instance qui appelle : plus de renouvellement, bail éteint, reprise par l'autre instance ;
 *             la réponse tardive de l'instance arrêtée n'écrase pas celle du repreneur ; demande suivante servie du cache
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';
import type { RecordedOutput } from '../replay-gateway';

const trace = { traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'] };
const annee = (assetId: number, value: number): ProjectedFact => ({
  canonicalKey: 'constructionYear', rawKey: 'Année de construction', label: null, subject: null, attribute: null,
  rawValue: String(value), value, valueType: 'number', canonicalUnit: null,
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'probable', evidence: { excerpt: `Construit vers ${value}`, page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
});
const abstention: RecordedOutput = {
  operationCode: 't3_value_conflict', task: 'VALUE_CONFLICT', repeat: true,
  output: { task: 'VALUE_CONFLICT', decision: 'abstain', chosenEvidenceId: null, confidence: 'conflictual', reason: 'Une seule mention approximative : abstention.' },
};
const ENV = ['AI_IDEMPOTENCY_DISABLED', 'AI_DEGRADED_CALLS_PER_HOUR', 'AI_DEGRADED_ALERT_COUNT', 'T3_DECISION_MEMORY_ENABLED', 'AI_IDEMPOTENCY_LEASE_SECONDS'] as const;

scenario('C811-E', 'T3 — modes dégradés : résultat sûr, dégradation visible, appels bornés ; bail fiable entre instances', ({ sql, make, replay, useRecordings }) => {
  const avant: Record<string, string | undefined> = {};
  let reconcileAsset: typeof import('@/services/ai/reconciliation/reconciliation-engine').reconcileAsset;
  let persistProjectedFacts: typeof import('@/services/ai/source-analysis/steps/persist-evidence.step').persistProjectedFacts;
  beforeAll(async () => {
    for (const k of ENV) avant[k] = process.env[k];
    process.env.AI_IDEMPOTENCY_DISABLED = 'false';
    ({ reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine'));
    ({ persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step'));
  });
  afterAll(() => { for (const k of ENV) { if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k]; } });

  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const jusqua = async <T>(lire: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> => {
    const fin = Date.now() + ms;
    let v = await lire();
    while (!ok(v) && Date.now() < fin) { await attendre(50); v = await lire(); }
    return v;
  };
  const appelsT3 = () => replay.calls.filter((c) => c.operationCode === 't3_value_conflict').length;
  const bienAvecPreuve = async (run: number) => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    const f = await make.assetFile(c as never, { assetId: bien.id });
    await persistProjectedFacts({
      input: { sourceType: 'file', sourceIds: [f.id], accountId: c.id, userId: c.ownerUserId, mimeTypes: [], displayNames: [] },
      leadSourceId: f.id, trace, analysisRunId: run, documentType: 'DIAGNOSTIC', facts: [annee(bien.id, 1948)],
    });
    return { c, bien };
  };
  const passage = (c: { id: number; ownerUserId: number }, assetId: number) => reconcileAsset({ accountId: c.id, userId: c.ownerUserId, assetId, triggeredBy: 'scheduled' });
  /** Une heure plus tard : le cache temporaire a expiré (les lignes restent en base). */
  const expirerLeCache = () => sql`UPDATE ai_operation_idempotency SET expires_at = now() - interval '1 second' WHERE key_hash NOT LIKE 'help-corpus:%' AND key_hash NOT LIKE 'resources-corpus:%'`;
  const degrades = async (accountId: number) => (await sql<Array<{ component: string; reason: string; impact: string; n: number; technical_code: string | null; operation_code: string; treatment: string }>>`
    SELECT component, reason, impact, sum(count)::int AS n, max(technical_code) AS technical_code, max(operation_code) AS operation_code, max(treatment) AS treatment
      FROM ai_degraded_events WHERE account_id = ${accountId} GROUP BY component, reason, impact ORDER BY component, reason, impact`);
  const conflitsOuverts = async (assetId: number) => (await sql<Array<{ id: number }>>`
    SELECT id FROM inconsistency_registry WHERE asset_id = ${assetId} AND field_key = 'constructionYear' AND status = 'open'`).length;
  const memoire = (assetId: number) => sql<Array<{ id: number; status: string; reuse_count: number; ai_config_signature: string }>>`
    SELECT id, status, reuse_count, ai_config_signature FROM t3_decision_memory WHERE asset_id = ${assetId} ORDER BY id`;
  const remettreMemoire = async () => (await import('@/services/ai/reconciliation/decision-memory/store')).__resetDecisionMemoryForTests();

  it('C811-E01 : diagnostic — base saine : aucune dépendance manquante ; mémoire absente ou désactivée : « NON effectives »', async () => {
    const { getT3Protections } = await import('@/services/ai/reconciliation/t3-protections');
    const sain = await getT3Protections();
    expect(sain.findings.filter((f) => f.level === 'error'), JSON.stringify(sain.findings.filter((f) => f.level !== 'ok'))).toEqual([]);
    for (const code of ['MIGRATION_0856', 'MEMORY_ENABLED', 'MEMORY_USABLE', 'MIGRATION_0857', 'CACHE_ENABLED', 'RESERVATION_USABLE', 'CONFIG_SIGNATURE', 'SWEEP_PREFILTER', 'MIGRATION_0858', 'MIGRATION_1860', 'MIGRATION_1861']) {
      expect(sain.findings.find((f) => f.code === code), code).toMatchObject({ level: 'ok' });
    }
    expect(sain.status).not.toBe('INACTIVE');
    // La clé de diagnostic du cache est écrite puis supprimée : rien ne reste.
    expect(await sql`SELECT 1 FROM ai_operation_idempotency WHERE key_hash LIKE 'diag:t3-protections:%'`).toHaveLength(0);

    process.env.T3_DECISION_MEMORY_ENABLED = '0';
    try {
      const d = await getT3Protections();
      expect(d.status).toBe('INACTIVE');
      expect(d.statusLabel).toContain('NON effectives');
      expect(d.findings.find((f) => f.code === 'MEMORY_ENABLED')).toMatchObject({ level: 'error' });
    } finally { delete process.env.T3_DECISION_MEMORY_ENABLED; }

    await sql`ALTER TABLE t3_decision_memory RENAME TO t3_decision_memory_c811`;
    try {
      const d = await getT3Protections();
      expect(d.status).toBe('INACTIVE');
      expect(d.findings.find((f) => f.code === 'MIGRATION_0856')).toMatchObject({ level: 'error' });
    } finally { await sql`ALTER TABLE t3_decision_memory_c811 RENAME TO t3_decision_memory`; }

    // Supervision T3 du BO : le diagnostic accompagne la réponse.
    const { getT3Supervision } = await import('@/services/ai/queue/supervision');
    expect((await getT3Supervision()).protections).toMatchObject({ status: expect.stringMatching(/ACTIVE|DEGRADED/) });
  });

  it('C811-E02 : mémoire désactivée par configuration — résultat sûr, dégradation tracée, appels bornés ; réactivée : un appel puis réutilisation', async () => {
    await useRecordings([abstention]);
    const { c, bien } = await bienAvecPreuve(98201);
    process.env.T3_DECISION_MEMORY_ENABLED = '0';
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '2';
    try {
      const r = [];
      for (let i = 0; i < 5; i++) { r.push(await passage(c, bien.id)); await expirerLeCache(); }
      // Sans la borne : 5 appels facturés (un par passage, le cache d'une heure ayant expiré). Avec : 2.
      expect(appelsT3()).toBe(2);
      expect(r.map((x) => x.providerCalls)).toEqual([1, 1, 0, 0, 0]);
      // Résultat sûr à chaque passage : conflit laissé à l'utilisateur, un seul arbitrage ouvert, aucune valeur écrite.
      for (const x of r) expect(x.decisions.find((d) => d.fieldKey === 'constructionYear')).toMatchObject({ action: 'create_conflict' });
      expect(await conflitsOuverts(bien.id)).toBe(1);
      expect(await memoire(bien.id)).toHaveLength(0);
      const d = await jusqua(() => degrades(c.id), (x) => x.reduce((n, y) => n + y.n, 0) >= 5);
      expect(d).toEqual([
        { component: 'DECISION_MEMORY', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_REFUSED', n: 3, technical_code: null, operation_code: 't3_value_conflict', treatment: 'T3' },
        { component: 'DECISION_MEMORY', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_WITHOUT_PROTECTION', n: 2, technical_code: null, operation_code: 't3_value_conflict', treatment: 'T3' },
      ]);
    } finally { delete process.env.T3_DECISION_MEMORY_ENABLED; delete process.env.AI_DEGRADED_CALLS_PER_HOUR; }

    // Mémoire réactivée : un appel (première évaluation), puis réutilisation sans appel.
    await expirerLeCache();
    const r1 = await passage(c, bien.id);
    expect(r1.providerCalls).toBe(1);
    await expirerLeCache();
    const r2 = await passage(c, bien.id);
    expect(appelsT3()).toBe(3);
    expect(r2).toMatchObject({ providerCalls: 0, decisionsReused: 1 });
    expect(await conflitsOuverts(bien.id)).toBe(1);
  });

  it('C811-E03 : table de la mémoire absente, puis écriture mémoire en échec — tracées, jamais bloquantes', async () => {
    await useRecordings([abstention]);
    const { c, bien } = await bienAvecPreuve(98301);
    await sql`ALTER TABLE t3_decision_memory RENAME TO t3_decision_memory_c811`;
    await remettreMemoire();
    try {
      const r = await passage(c, bien.id);
      expect(r.providerCalls).toBe(1);
      expect(r.decisions.find((d) => d.fieldKey === 'constructionYear')).toMatchObject({ action: 'create_conflict' });
    } finally { await sql`ALTER TABLE t3_decision_memory_c811 RENAME TO t3_decision_memory`; await remettreMemoire(); }
    expect(await jusqua(() => degrades(c.id), (x) => x.length >= 1)).toMatchObject([{ component: 'DECISION_MEMORY', reason: 'MIGRATION_MISSING', impact: 'CALL_WITHOUT_PROTECTION', n: 1 }]);

    // Écriture en échec (contrainte posée le temps du test) : la décision est rendue, non conservée, et c'est dit.
    const { c: c2, bien: b2 } = await bienAvecPreuve(98302);
    await sql`ALTER TABLE t3_decision_memory ADD CONSTRAINT c811_refus CHECK (account_id <> ${sql.unsafe(String(c2.id))}) NOT VALID`;
    try {
      const r = await passage(c2, b2.id);
      expect(r.providerCalls).toBe(1);
      expect(r.decisions.find((d) => d.fieldKey === 'constructionYear')).toMatchObject({ action: 'create_conflict', aiSource: 'PROVIDER' });
      expect(await memoire(b2.id)).toHaveLength(0);
    } finally { await sql`ALTER TABLE t3_decision_memory DROP CONSTRAINT c811_refus`; }
    const d2 = await jusqua(() => degrades(c2.id), (x) => x.length >= 1);
    expect(d2).toMatchObject([{ component: 'DECISION_MEMORY', reason: 'WRITE_FAILED', impact: 'RESULT_NOT_STORED', n: 1, technical_code: '23514' }]);
    // Aucune donnée métier dans la trace durable.
    const brut = await sql`SELECT * FROM ai_degraded_events WHERE account_id IN (${c.id}, ${c2.id})`;
    expect(JSON.stringify(brut)).not.toMatch(/1948|Construit/);
    // Incident terminé : le passage suivant mémorise (cache encore valide : aucun nouvel appel), puis réutilise.
    const avantAppels = appelsT3();
    await passage(c2, b2.id);
    expect(await memoire(b2.id)).toMatchObject([{ status: 'ACTIVE' }]);
    const r3 = await passage(c2, b2.id);
    expect(r3).toMatchObject({ providerCalls: 0, decisionsReused: 1 });
    expect(appelsT3()).toBe(avantAppels);
  });

  it('C811-E04 : signature de configuration non résolue — ni réutilisation obsolète, ni enregistrement ; entrée active intacte puis réutilisée', async () => {
    await useRecordings([abstention]);
    const { c, bien } = await bienAvecPreuve(98401);
    await passage(c, bien.id);
    expect(appelsT3()).toBe(1);
    const [sain] = await memoire(bien.id);
    expect(sain.ai_config_signature).not.toBe('unresolved');

    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const espion = vi.spyOn(AiGateway, 'effectiveConfigSignature').mockResolvedValue('unresolved');
    try {
      const r = await passage(c, bien.id);
      // La décision mémorisée n'est PAS réutilisée (on ne sait pas si la configuration est la même) : un appel, tracé.
      expect(appelsT3()).toBe(2);
      expect(r).toMatchObject({ providerCalls: 1, decisionsReused: 0 });
      expect(r.decisions.find((d) => d.fieldKey === 'constructionYear')).toMatchObject({ action: 'create_conflict' });
      // Rien n'est enregistré sous « unresolved » ; l'entrée active n'est ni remplacée ni marquée réutilisée.
      expect(await memoire(bien.id)).toEqual([sain]);
    } finally { espion.mockRestore(); }
    expect(await jusqua(() => degrades(c.id), (x) => x.length >= 1)).toMatchObject([{ component: 'CONFIG_SIGNATURE', reason: 'SIGNATURE_UNRESOLVED', impact: 'CALL_WITHOUT_PROTECTION', n: 1 }]);
    // Signature de nouveau résolue, configuration identique : réutilisation, aucun appel.
    const r2 = await passage(c, bien.id);
    expect(appelsT3()).toBe(2);
    expect(r2).toMatchObject({ providerCalls: 0, decisionsReused: 1 });
    expect(await memoire(bien.id)).toMatchObject([{ id: sain.id, status: 'ACTIVE', reuse_count: 1 }]);
    expect(await conflitsOuverts(bien.id)).toBe(1);
  });

  it('C811-E05 : cache inaccessible — appels bornés, refus avant contact, interactif jamais bloqué ; alerte si la dégradation persiste ; retour à la normale', async () => {
    const svc = await import('@/services/ai/idempotency/idempotency.service');
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_document_naming' };
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '3';
    process.env.AI_DEGRADED_ALERT_COUNT = '4';
    let appels = 0;
    const fournisseur = async () => { appels++; return { v: appels, fromCache: false }; };
    await sql`ALTER TABLE ai_operation_idempotency RENAME TO ai_operation_idempotency_c811`;
    const issues: string[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        await svc.withIdempotency(`c811:e05:${c.id}:${i}`, fournisseur, 3600, meta)
          .then(() => issues.push('APPEL'), (e: { code?: string }) => issues.push(String(e.code)));
      }
      // Traitement interactif (hors borne) : jamais refusé.
      await svc.withIdempotency(`c811:e05:t2:${c.id}`, fournisseur, 3600, { accountId: c.id, treatment: 'T2', operationCode: 't2_answer' });
    } finally { await sql`ALTER TABLE ai_operation_idempotency_c811 RENAME TO ai_operation_idempotency`; }
    expect(issues).toEqual(['APPEL', 'APPEL', 'APPEL', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED']);
    expect(appels).toBe(4);
    const d = await jusqua(() => degrades(c.id), (x) => x.reduce((n, y) => n + y.n, 0) >= 7);
    expect(d.filter((x) => x.treatment === 'T3' || x.impact === 'CALL_REFUSED').map((x) => [x.component, x.reason, x.impact, x.technical_code])).toEqual(expect.arrayContaining([
      ['RESPONSE_CACHE', 'MIGRATION_MISSING', 'CALL_REFUSED', '42P01'],
    ]));
    expect(d.reduce((n, x) => n + x.n, 0)).toBe(7);
    // Alerte de supervision (mécanisme existant) : une anomalie ouverte, sans donnée sensible.
    const alerte = await jusqua(
      () => sql<Array<{ title: string; status: string; technical_detail: Record<string, unknown> }>>`
        SELECT title, status, technical_detail FROM admin_anomalies WHERE domain = 'ai' AND technical_detail->>'code' = 'AI_PROTECTION_DEGRADED' AND technical_detail->>'component' = 'RESPONSE_CACHE'`,
      (x) => x.length >= 1);
    expect(alerte).toHaveLength(1);
    expect(alerte[0]).toMatchObject({ status: 'open', technical_detail: { reason: 'MIGRATION_MISSING', operationCode: 't3_document_naming', technicalCode: '42P01' } });
    expect(alerte[0].title).toContain('protection anti-redondance dégradée');
    // Retour à la normale : appel puis cache, sans consommation de la borne.
    delete process.env.AI_DEGRADED_CALLS_PER_HOUR;
    const k = `c811:e05:retour:${c.id}`;
    const avantRetour = appels;
    await svc.withIdempotency(k, fournisseur, 3600, meta);
    expect(await svc.withIdempotency(k, fournisseur, 3600, meta)).toMatchObject({ fromCache: true });
    expect(appels).toBe(avantRetour + 1);
  });

  it('C811-E06 : deux instances, même clé, appel PLUS LONG que le bail → un seul appel (bail renouvelé), réponse partagée', async () => {
    process.env.AI_IDEMPOTENCY_LEASE_SECONDS = '2';
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_value_conflict' };
    const key = `c811:e06:${c.id}`;
    const instanceA = await import('@/services/ai/idempotency/idempotency.service');
    vi.resetModules();
    const instanceB = await import('@/services/ai/idempotency/idempotency.service');
    const dbB = (await import('@/db')).pgClient;
    expect(instanceB).not.toBe(instanceA);
    expect(dbB).not.toBe(sql);
    let appels = 0;
    const lent = async () => { appels++; await attendre(4600); return { v: 'unique', fromCache: false }; };
    const debut = Date.now();
    const pa = instanceA.withIdempotency(key, lent, 3600, meta);
    // L'instance B arrive APRÈS la fin du bail initial (2 s) : sans renouvellement, elle reprenait la clé et appelait.
    await attendre(2700);
    const [etat] = await sql<Array<{ state: string; vivant: boolean }>>`SELECT state, expires_at > now() AS vivant FROM ai_operation_idempotency WHERE key_hash = ${key}`;
    expect(etat).toEqual({ state: 'PENDING', vivant: true });
    const [a, b] = await Promise.all([pa, instanceB.withIdempotency(key, lent, 3600, meta)]);
    expect(Date.now() - debut).toBeGreaterThanOrEqual(4500);
    expect(appels).toBe(1);
    expect(a).toEqual({ v: 'unique', fromCache: false });
    expect(b).toMatchObject({ v: 'unique', fromCache: true, cacheOutcome: 'SHARED' });
    const [fin] = await sql<Array<{ state: string; owner_token: string | null }>>`SELECT state, owner_token FROM ai_operation_idempotency WHERE key_hash = ${key}`;
    expect(fin).toEqual({ state: 'READY', owner_token: null });
    await dbB.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);

  it('C811-E07 : arrêt de l’instance qui appelle → bail éteint, reprise par l’autre instance ; réponse tardive sans effet ; demande suivante servie du cache', async () => {
    process.env.AI_IDEMPOTENCY_LEASE_SECONDS = '2';
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_value_conflict' };
    const key = `c811:e07:${c.id}`;
    vi.resetModules();
    const instanceA = await import('@/services/ai/idempotency/idempotency.service');
    const dbA = (await import('@/db')).pgClient;
    vi.resetModules();
    const instanceB = await import('@/services/ai/idempotency/idempotency.service');
    const dbB = (await import('@/db')).pgClient;
    let appels = 0;
    let rendreA: (v: { v: string; fromCache: boolean }) => void = () => undefined;
    const appelDeA = () => { appels++; return new Promise<{ v: string; fromCache: boolean }>((res) => { rendreA = res; }); };
    const pa = instanceA.withIdempotency(key, appelDeA, 3600, meta);
    await attendre(400);
    // Arrêt brutal de l'instance A : plus aucun renouvellement de son bail.
    expect(instanceA.__stopLeaseRenewalsForTests()).toBe(1);
    const debut = Date.now();
    const b = await instanceB.withIdempotency(key, async () => { appels++; return { v: 'reprise', fromCache: false }; }, 3600, meta);
    // Reprise après l'extinction du bail (≤ un bail), jamais avant : aucun double appel tant que A pouvait répondre.
    expect(Date.now() - debut).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - debut).toBeLessThan(6000);
    expect(b).toEqual({ v: 'reprise', fromCache: false });
    expect(appels).toBe(2);
    // La réponse tardive de l'instance arrêtée n'écrase pas celle du repreneur.
    rendreA({ v: 'tardive', fromCache: false });
    // Règle remplacée (carte #828, écart C) : la réponse tardive n'est PAS en cache (celle du repreneur y est déjà) —
    // c'est désormais dit à l'appelant (`cacheWrite`), au lieu d'un succès d'écriture silencieux. Le résultat métier
    // de l'appel est préservé.
    expect(await pa).toEqual({ v: 'tardive', fromCache: false, cacheWrite: 'ALREADY_READY' });
    const [ligne] = await sql<Array<{ state: string; result_json: { v: string } }>>`SELECT state, result_json FROM ai_operation_idempotency WHERE key_hash = ${key}`;
    expect(ligne).toMatchObject({ state: 'READY', result_json: { v: 'reprise' } });
    // Redémarrage : la demande suivante est servie du cache, sans appel.
    vi.resetModules();
    const instanceC = await import('@/services/ai/idempotency/idempotency.service');
    const dbC = (await import('@/db')).pgClient;
    expect(await instanceC.withIdempotency(key, async () => { appels++; return { v: 'inutile', fromCache: false }; }, 3600, meta)).toMatchObject({ v: 'reprise', fromCache: true, cacheOutcome: 'CACHE_HIT' });
    expect(appels).toBe(2);
    for (const d of [dbA, dbB, dbC]) if (d !== sql) await d.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);
});
