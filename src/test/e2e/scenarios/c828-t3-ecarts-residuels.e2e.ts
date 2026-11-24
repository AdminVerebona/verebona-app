/**
 * Carte #828 — écarts résiduels du #811, sur PostgreSQL réel (passerelle réelle, fournisseur SIMULÉ, aucun réseau).
 *
 * ÉCART A — appels sans protection : tracés, comptés, bornés pour TOUTES les instances
 *   C828-A01  cache coupé en urgence (`AI_IDEMPOTENCY_DISABLED=true`) : appels séquentiels tracés, comptés, bornés ;
 *             refus avant tout contact ; alerte ; diagnostic « NON effectives » avec portée et durée ; repli sûr sans IA
 *   C828-A02  DEUX instances (connexions réelles distinctes) : ensemble, jamais plus que le budget
 *   C828-A03  migration 0857 absente (erreur 42703) : chemin « sans réservation » tracé « sans protection », borné,
 *             jamais « protégé » ; le cache par processus sert encore les réponses valides
 *   C828-A04  borne commune injoignable — table 1940 absente, base LENTE (verrou tenu par une autre connexion),
 *             base en LECTURE SEULE : la borne de l'instance tient, et le diagnostic le dit
 *   C828-A05  borne levée (`off`) : contournement d'urgence tracé à chaque appel, alerté, « NON effectives »
 *   C828-A06  signature de configuration non résolue (rattachement) : appel annoncé, admis à l'envoi puis refusé
 *             avant contact, réservation rendue ; un appel non annoncé n'est pas compté
 * ÉCART B — compteurs réconciliables
 *   C828-B01  INSERT de l'événement d'usage REFUSÉ : requêtes physiques conservées, perte comptée à part, alerte ;
 *             la requête de réconciliation retombe à zéro
 *   C828-B02  passage du compte avec repli : fournisseur = passage = événements = file IA = rapport = export ;
 *             un total falsifié fait DIVERGER la réconciliation
 *   C828-B03  historique : passages sans sémantique et à demandes déclarées jamais comptés « zéro appel » ; aucune
 *             ligne historique réécrite ; `DECLARED` n'écrit plus de valeur déclarative dans `provider_calls`
 * ÉCART C — écriture du cache
 *   C828-C01  bail expiré puis repris, écriture TARDIVE du premier travailleur pendant l'appel du repreneur :
 *             « bail perdu », rien d'écrasé, réponse du repreneur servie ensuite
 *   C828-C02  écriture refusée par la base : « non conservée » dite à l'appelant ; l'appel suivant est borné
 * REQUÊTES DE LA FICHE 117C : toutes exécutées sur le schéma réel (syntaxe et colonnes).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';
import type { RecordedOutput } from '../replay-gateway';
import type { AiActivitySnapshot } from '@/services/ai/measure/ai-activity';

const OP = 't3_value_conflict';
const sortie = { task: 'VALUE_CONFLICT', decision: 'abstain', chosenEvidenceId: null, confidence: 'conflictual', reason: 'Abstention (jeu de recette).' };
const reussite = (over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: OP, task: 'VALUE_CONFLICT', output: sortie, inputTokens: 1200, outputTokens: 40, ...over });
const variables = (n: string) => ({
  FIELD: 'constructionYear', CURRENT_STATE: { value: null, origin: 'USER', protected: false }, EVIDENCES: [{ evidenceId: 1, value: 1948, cas: n }],
  SUBJECT_CONTEXT: null, CANDIDATES: null, RELATION_TYPE: null,
});
const trace = { traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'] };
const annee = (assetId: number, value: number): ProjectedFact => ({
  canonicalKey: 'constructionYear', rawKey: 'Année de construction', label: null, subject: null, attribute: null,
  rawValue: String(value), value, valueType: 'number', canonicalUnit: null,
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'probable', evidence: { excerpt: `Construit vers ${value}`, page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
});
const ENV = ['AI_IDEMPOTENCY_DISABLED', 'AI_DEGRADED_CALLS_PER_HOUR', 'AI_DEGRADED_ALERT_COUNT', 'AI_DEGRADED_BUDGET_TIMEOUT_MS', 'AI_IDEMPOTENCY_LEASE_SECONDS', 'T3_DECISION_MEMORY_ENABLED'] as const;

scenario('C828-E2E', 'T3 — écarts résiduels du #811 : appels sans protection bornés pour toutes les instances, compteurs réconciliables, écriture du cache sincère', ({ sql, make, useRecordings }) => {
  const avant: Record<string, string | undefined> = {};
  let dm: typeof import('@/services/ai/degraded/degraded-mode');
  let idem: typeof import('@/services/ai/idempotency/idempotency.service');
  let mesurer: typeof import('@/services/ai/measure/ai-activity').measureAiActivity;
  let executer: (accountId: number, cas: string) => Promise<{ traceId: string; fromCache: boolean }>;
  beforeAll(() => { for (const k of ENV) avant[k] = process.env[k]; });
  /**
   * Modules de l'« instance » du test. Rechargés avant CHAQUE test : les tests à deux instances remettent le
   * registre de modules à zéro, et le service, sa borne et le diagnostic doivent venir du même registre.
   */
  const charger = async () => {
    dm = await import('@/services/ai/degraded/degraded-mode');
    idem = await import('@/services/ai/idempotency/idempotency.service');
    ({ measureAiActivity: mesurer } = await import('@/services/ai/measure/ai-activity'));
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const { T3ValueConflictOutput } = await import('@/services/ai/reconciliation/master/t3-contract');
    executer = async (accountId, cas) => AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION', operationCode: OP, accountId, promptVariables: variables(cas),
      outputSchema: T3ValueConflictOutput, idempotencyKey: `c828:a${accountId}:${cas}`,
    }) as Promise<{ traceId: string; fromCache: boolean }>;
  };
  beforeEach(async () => {
    await charger();
    // État de l'instance remis à zéro ; écriture durable et alerte RÉELLES ; borne commune RÉELLE (table 1940).
    dm.__resetDegradedModeForTests({ persist: null, alert: null, sharedBudget: null });
    idem.__resetIdempotencyModeForTests();
    for (const k of ENV) if (k !== 'AI_IDEMPOTENCY_DISABLED') delete process.env[k];
    process.env.AI_IDEMPOTENCY_DISABLED = 'false';
  });
  afterAll(() => { for (const k of ENV) { if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k]; } });

  /** Attend un état de la base écrit « au mieux » (trace durable, alerte) : relecture bornée, jamais un délai fixe. */
  const jusqua = async <T>(lire: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> => {
    const fin = Date.now() + ms;
    let v = await lire();
    while (!ok(v) && Date.now() < fin) { await new Promise((r) => setTimeout(r, 40)); v = await lire(); }
    return v;
  };
  const degrades = (accountId: number) => sql<Array<{ component: string; reason: string; impact: string; n: number; code: string | null }>>`
    SELECT component, reason, impact, sum(count)::int AS n, max(technical_code) AS code
      FROM ai_degraded_events WHERE account_id = ${accountId} GROUP BY component, reason, impact ORDER BY component, reason, impact`;
  const totalDegrades = (x: Array<{ n: number }>) => x.reduce((n, y) => n + y.n, 0);
  const budget = (accountId: number) => sql<Array<{ treatment: string; operation_code: string; admitted: number; refused: number }>>`
    SELECT treatment, operation_code, sum(admitted)::int AS admitted, sum(refused)::int AS refused
      FROM ai_degraded_call_budget WHERE account_id = ${accountId} GROUP BY 1, 2 ORDER BY 1, 2`;
  const anomalies = (component: string) => sql<Array<{ title: string; status: string; technical_detail: Record<string, unknown> }>>`
    SELECT title, status, technical_detail FROM admin_anomalies
     WHERE domain = 'ai' AND technical_detail->>'code' = 'AI_PROTECTION_DEGRADED' AND technical_detail->>'component' = ${component}`;
  const tenter = async (fn: () => Promise<unknown>): Promise<string> => fn().then(() => 'ÉMIS', (e: { code?: string }) => String(e.code));
  const q = (text: string, params: unknown[] = []) => sql.unsafe(text, params as never[]) as unknown as Promise<Array<Record<string, unknown>>>;

  // ══ ÉCART A ═══════════════════════════════════════════════════════════════════════════════════════════════

  it('C828-A01 : cache coupé en urgence — appels séquentiels tracés, comptés, bornés ; refus avant contact ; alerte ; diagnostic explicite ; repli sûr sans IA', async () => {
    const c = await make.account();
    const r = await useRecordings([reussite({ repeat: true })]);
    process.env.AI_IDEMPOTENCY_DISABLED = 'true';
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '2';
    const issues: string[] = [];
    const m = await mesurer(async () => { for (let i = 0; i < 5; i++) issues.push(await tenter(() => executer(c.id, `a01-${i}`))); });
    // Avant la carte #828 : 5 requêtes facturées, aucune trace, aucune borne. Maintenant : 2, puis refus AVANT contact.
    expect(issues).toEqual(['ÉMIS', 'ÉMIS', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED']);
    expect(r.calls).toHaveLength(2);
    expect(m.activity.total).toMatchObject({ logicalRequests: 5, networkRequests: 2, requestsWithoutContact: 3, usageEvents: 2, usageEventsNotPersisted: 0 });
    // Raison et volume RÉELS tracés (durable, toutes instances) ; budget commun consommé.
    const d = await jusqua(() => degrades(c.id), (x) => totalDegrades(x) >= 5);
    expect(d).toEqual([
      { component: 'RESPONSE_CACHE', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_REFUSED', n: 3, code: null },
      { component: 'RESPONSE_CACHE', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_WITHOUT_PROTECTION', n: 2, code: null },
    ]);
    // Les refus décidés par la borne de l'instance montent eux aussi au budget commun (écriture au mieux).
    expect(await jusqua(() => budget(c.id), (x) => (x[0]?.refused ?? 0) >= 3)).toEqual([{ treatment: 'T3', operation_code: OP, admitted: 2, refused: 3 }]);
    // Aucune réponse n'a été mise en cache (le cache est coupé) : rien ne laisse croire à une protection.
    expect(await sql`SELECT 1 FROM ai_operation_idempotency WHERE key_hash LIKE ${`c828:a${c.id}:%`}`).toHaveLength(0);
    // Alerte dès le premier refus (sans attendre le seuil d'occurrences).
    const alerte = await jusqua(() => anomalies('RESPONSE_CACHE'), (x) => x.length >= 1);
    expect(alerte[0]).toMatchObject({ status: 'open', technical_detail: { reason: 'DISABLED_BY_CONFIG', impact: 'CALL_REFUSED', operationCode: OP } });
    // Diagnostic : jamais « actives » ; contournement explicite (variable, portée, risque, durée observée).
    const { getT3Protections } = await import('@/services/ai/reconciliation/t3-protections');
    const p = await getT3Protections();
    expect(p.status).toBe('INACTIVE');
    expect(p.findings.find((f) => f.code === 'CACHE_ENABLED')).toMatchObject({ level: 'error', message: expect.stringContaining('contournement d’urgence') });
    const b = p.bypasses!.find((x) => x.variable === 'AI_IDEMPOTENCY_DISABLED')!;
    expect(b).toMatchObject({ value: 'true', callsObserved: 2 });
    expect(b.firstObservedAt).not.toBeNull();
    expect(b.scope.length).toBeGreaterThan(10);
    expect(b.risk).toContain('facturée');
    expect(p.degraded.sharedBudget!.admitted).toBeGreaterThanOrEqual(2);
    expect(p.degraded.sharedBudget!.refused).toBeGreaterThanOrEqual(3);
    expect(p.findings.find((f) => f.code === 'MIGRATION_1940')).toMatchObject({ level: 'ok' });

    // Continuité métier SÛRE quand la borne est atteinte : le passage rend un conflit prudent, sans IA, sans erreur.
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    const f = await make.assetFile(c as never, { assetId: bien.id });
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    await persistProjectedFacts({
      input: { sourceType: 'file', sourceIds: [f.id], accountId: c.id, userId: c.ownerUserId, mimeTypes: [], displayNames: [] },
      leadSourceId: f.id, trace, analysisRunId: 98281, documentType: 'DIAGNOSTIC', facts: [annee(bien.id, 1948)],
    });
    const { reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine');
    const passage = await reconcileAsset({ accountId: c.id, userId: c.ownerUserId, assetId: bien.id, triggeredBy: 'scheduled' });
    expect(r.calls).toHaveLength(2);
    expect(passage).toMatchObject({ providerCalls: 0, aiCountersSemantics: 'MEASURED_V1' });
    expect(passage.decisions.find((x) => x.fieldKey === 'constructionYear')).toMatchObject({ action: 'create_conflict' });
    expect(await sql`SELECT 1 FROM inconsistency_registry WHERE asset_id = ${bien.id} AND field_key = 'constructionYear' AND status = 'open'`).toHaveLength(1);
    // Rien n'est mémorisé d'un refus avant contact : au retour à la normale, la question sera posée une fois.
    expect(await sql`SELECT 1 FROM t3_decision_memory WHERE asset_id = ${bien.id}`).toHaveLength(0);

    // Traitement interactif : jamais refusé par la borne (tracé seulement).
    let t2 = 0;
    for (let i = 0; i < 4; i++) await idem.withIdempotency(`c828:a01:t2:${c.id}:${i}`, async () => { t2++; return {}; }, 60, { accountId: c.id, treatment: 'T2', operationCode: 't2_answer' });
    expect(t2).toBe(4);
  });

  it('C828-A02 : deux instances (connexions réelles distinctes) — ensemble, jamais plus que le budget', async () => {
    const c = await make.account();
    process.env.AI_IDEMPOTENCY_DISABLED = 'true';
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '3';
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_document_naming' };
    vi.resetModules();
    const instanceA = await import('@/services/ai/idempotency/idempotency.service');
    const dbA = (await import('@/db')).pgClient;
    vi.resetModules();
    const instanceB = await import('@/services/ai/idempotency/idempotency.service');
    const dbB = (await import('@/db')).pgClient;
    expect(dbA).not.toBe(dbB);
    let appels = 0;
    const fournisseur = async () => { appels++; return { ok: true }; };
    try {
      // Les deux instances partent EN MÊME TEMPS, quatre demandes chacune (chaque instance seule en admettrait 3).
      const issues = await Promise.all([0, 1, 2, 3].flatMap((i) => [
        tenter(() => instanceA.withIdempotency(`c828:a02:A:${c.id}:${i}`, fournisseur, 60, meta)),
        tenter(() => instanceB.withIdempotency(`c828:a02:B:${c.id}:${i}`, fournisseur, 60, meta)),
      ]));
      // Borne par instance (carte #811) : jusqu'à 6 appels. Borne commune : 3, quel que soit l'entrelacement.
      expect(appels).toBe(3);
      expect(issues.filter((x) => x === 'ÉMIS')).toHaveLength(3);
      expect(issues.filter((x) => x === 'DEGRADED_CALL_REFUSED')).toHaveLength(5);
      // Budget commun : 3 admis, et les 5 refus (borne commune ou borne de l'instance) y sont tous comptés.
      const [b] = await jusqua(() => budget(c.id), (x) => (x[0]?.refused ?? 0) >= 5);
      expect(b).toMatchObject({ admitted: 3, refused: 5 });
      const d = await jusqua(() => degrades(c.id), (x) => totalDegrades(x) >= 8);
      expect(d.map((x) => [x.impact, x.n])).toEqual([['CALL_REFUSED', 5], ['CALL_WITHOUT_PROTECTION', 3]]);
    } finally {
      await dbA.end({ timeout: 2 }).catch(() => undefined);
      await dbB.end({ timeout: 2 }).catch(() => undefined);
      vi.resetModules();
    }
  });

  it('C828-A03 : migration 0857 absente (42703) — chemin sans réservation tracé « sans protection », borné, jamais « protégé »', async () => {
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_document_naming' };
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '2';
    let appels = 0;
    const fournisseur = async () => { appels++; return { v: appels, fromCache: false }; };
    await sql`ALTER TABLE ai_operation_idempotency RENAME COLUMN owner_token TO owner_token_c828`;
    try {
      const issues: string[] = [];
      for (let i = 0; i < 4; i++) issues.push(await tenter(() => idem.withIdempotency(`c828:a03:${c.id}:${i}`, fournisseur, 3600, meta)));
      expect(issues).toEqual(['ÉMIS', 'ÉMIS', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED']);
      expect(appels).toBe(2);
      // Le cache par processus fonctionne encore : une réponse valide est servie sans appel ni budget.
      expect(await idem.withIdempotency(`c828:a03:${c.id}:0`, fournisseur, 3600, meta)).toMatchObject({ v: 1, fromCache: true });
      expect(appels).toBe(2);
      const d = await jusqua(() => degrades(c.id), (x) => totalDegrades(x) >= 4);
      // Avant la carte #828 : « NO_EXTRA_CALL » (aucun appel supplémentaire) — affirmation non prouvable sans réservation.
      expect(d).toEqual([
        { component: 'CACHE_RESERVATION', reason: 'MIGRATION_MISSING', impact: 'CALL_REFUSED', n: 2, code: '42703' },
        { component: 'CACHE_RESERVATION', reason: 'MIGRATION_MISSING', impact: 'CALL_WITHOUT_PROTECTION', n: 2, code: '42703' },
      ]);
      expect(await jusqua(() => budget(c.id), (x) => (x[0]?.refused ?? 0) >= 2)).toEqual([{ treatment: 'T3', operation_code: 't3_document_naming', admitted: 2, refused: 2 }]);
      // L'absence de la migration est VISIBLE : jamais « actives ».
      const { getT3Protections } = await import('@/services/ai/reconciliation/t3-protections');
      const p = await getT3Protections();
      expect(p.status).toBe('INACTIVE');
      expect(p.findings.find((f) => f.code === 'MIGRATION_0857')).toMatchObject({ level: 'error', message: expect.stringContaining('ABSENTE') });
    } finally {
      await sql`ALTER TABLE ai_operation_idempotency RENAME COLUMN owner_token_c828 TO owner_token`;
      idem.__resetIdempotencyModeForTests();
    }
    // Migration revenue : réservation normale, plus aucun budget consommé.
    const avantRetour = appels;
    await idem.withIdempotency(`c828:a03:retour:${c.id}`, fournisseur, 3600, meta);
    expect(appels).toBe(avantRetour + 1);
    expect((await budget(c.id))[0]).toMatchObject({ admitted: 2 });
  });

  it('C828-A04 : borne commune injoignable — table absente, base LENTE (verrou d’une autre connexion), lecture seule : la borne de l’instance tient, et c’est dit', async () => {
    process.env.AI_IDEMPOTENCY_DISABLED = 'true';
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '2';
    const { getT3Protections } = await import('@/services/ai/reconciliation/t3-protections');
    const { degradedCapText } = await import('@/app/admin/ai-queue/_components/T3Supervision');
    const serie = async (cas: string) => {
      const c = await make.account();
      let appels = 0;
      const issues: string[] = [];
      for (let i = 0; i < 4; i++) {
        issues.push(await tenter(() => idem.withIdempotency(`c828:a04:${cas}:${c.id}:${i}`, async () => { appels++; return {}; }, 60, { accountId: c.id, treatment: 'T3', operationCode: 't3_document_naming' })));
      }
      return { c, appels, issues };
    };
    const borneLocaleSeule = (x: { appels: number; issues: string[] }) => {
      // Aucune boucle silencieuse : sans la borne commune, l'instance s'arrête quand même à son budget.
      expect(x.appels).toBe(2);
      expect(x.issues).toEqual(['ÉMIS', 'ÉMIS', 'DEGRADED_CALL_REFUSED', 'DEGRADED_CALL_REFUSED']);
    };

    // (1) Migration 1940 absente.
    await sql`ALTER TABLE ai_degraded_call_budget RENAME TO ai_degraded_call_budget_c828`;
    try {
      borneLocaleSeule(await serie('absente'));
      expect(dm.degradedInstanceState()).toMatchObject({ sharedAdmitted: 0, sharedUnavailableCode: '42P01' });
      const p = await getT3Protections();
      expect(p.findings.find((f) => f.code === 'MIGRATION_1940')).toMatchObject({ level: 'warn', message: expect.stringContaining('PAR INSTANCE') });
      expect(p.degraded.sharedBudget).toBeNull();
      expect(degradedCapText(p as never)).toContain('par instance seulement (borne commune absente : migration 1940)');
    } finally { await sql`ALTER TABLE ai_degraded_call_budget_c828 RENAME TO ai_degraded_call_budget`; }

    // (2) Base LENTE : une AUTRE connexion tient un verrou exclusif sur la table du budget pendant toute la série.
    //     Déterministe : le verrou n'est rendu qu'après la série ; la base abandonne elle-même chaque tentative.
    dm.__resetDegradedModeForTests({ persist: null, alert: null, sharedBudget: null });
    process.env.AI_DEGRADED_BUDGET_TIMEOUT_MS = '150';
    const debut = Date.now();
    const lente = await sql.begin(async (tx) => {
      await tx`LOCK TABLE ai_degraded_call_budget IN ACCESS EXCLUSIVE MODE`;
      return serie('lente');
    }) as Awaited<ReturnType<typeof serie>>;
    borneLocaleSeule(lente);
    // L'appelant n'a jamais attendu indéfiniment : deux admissions au délai (150 ms + garde), deux refus immédiats.
    expect(Date.now() - debut).toBeLessThan(8000);
    const etat = dm.degradedInstanceState();
    expect(etat).toMatchObject({ sharedAdmitted: 0, sharedUnavailable: 2 });
    expect(['57014', '55P03', 'BUDGET_TIMEOUT']).toContain(etat.sharedUnavailableCode);
    // Aucune ADMISSION n'a été écrite dans le budget commun pour ce compte (transactions abandonnées par la base) :
    // ces deux appels n'ont été bornés que par l'instance, et le BO le dit.
    expect((await budget(lente.c.id)).reduce((n, x) => n + x.admitted, 0)).toBe(0);
    const p2 = await getT3Protections();
    expect(p2.findings.find((f) => f.code === 'DEGRADED_CAP')).toMatchObject({ level: 'warn', message: expect.stringContaining('injoignable') });
    expect(degradedCapText(p2 as never)).toContain('2 admission(s) bornée(s) par la seule instance (borne commune injoignable)');
    delete process.env.AI_DEGRADED_BUDGET_TIMEOUT_MS;

    // (3) Base en LECTURE SEULE pour cette écriture (code PostgreSQL 25006 levé par la base elle-même).
    dm.__resetDegradedModeForTests({ persist: null, alert: null, sharedBudget: null });
    await sql.unsafe(`CREATE OR REPLACE FUNCTION c828_lecture_seule() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'cannot execute INSERT in a read-only transaction' USING ERRCODE = '25006'; END $$ LANGUAGE plpgsql`);
    await sql.unsafe(`CREATE TRIGGER c828_lecture_seule BEFORE INSERT OR UPDATE ON ai_degraded_call_budget FOR EACH ROW EXECUTE FUNCTION c828_lecture_seule()`);
    try {
      borneLocaleSeule(await serie('lecture-seule'));
      expect(dm.degradedInstanceState()).toMatchObject({ sharedAdmitted: 0, sharedUnavailable: 2, sharedUnavailableCode: '25006' });
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS c828_lecture_seule ON ai_degraded_call_budget`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS c828_lecture_seule()`);
    }

    // Retour à la normale : la borne commune reprend (nouvelle instance, nouveau compte).
    dm.__resetDegradedModeForTests({ persist: null, alert: null, sharedBudget: null });
    const normale = await serie('normale');
    borneLocaleSeule(normale);
    expect(await jusqua(() => budget(normale.c.id), (x) => (x[0]?.refused ?? 0) >= 2)).toEqual([{ treatment: 'T3', operation_code: 't3_document_naming', admitted: 2, refused: 2 }]);
    expect(dm.degradedInstanceState()).toMatchObject({ sharedAdmitted: 2, sharedUnavailable: 0 });
  });

  it('C828-A05 : borne levée (`off`) — contournement d’urgence tracé à chaque appel, alerté aussitôt, « NON effectives »', async () => {
    const c = await make.account();
    process.env.AI_IDEMPOTENCY_DISABLED = 'true';
    process.env.AI_DEGRADED_CALLS_PER_HOUR = 'off';
    let appels = 0;
    for (let i = 0; i < 5; i++) await idem.withIdempotency(`c828:a05:${c.id}:${i}`, async () => { appels++; return {}; }, 60, { accountId: c.id, treatment: 'T3', operationCode: 't3_document_naming' });
    // Aucun blocage (c'est le but d'un contournement d'urgence)…
    expect(appels).toBe(5);
    // … mais plus jamais silencieux : volume réel tracé, alerte, diagnostic.
    const d = await jusqua(() => degrades(c.id), (x) => totalDegrades(x) >= 10);
    expect(d).toEqual([
      { component: 'DEGRADED_CAP', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_WITHOUT_PROTECTION', n: 5, code: null },
      { component: 'RESPONSE_CACHE', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_WITHOUT_PROTECTION', n: 5, code: null },
    ]);
    expect(await budget(c.id)).toEqual([]);
    const alerte = await jusqua(() => anomalies('DEGRADED_CAP'), (x) => x.length >= 1);
    expect(alerte[0].title).toBe('IA — borne des appels sans protection LEVÉE par configuration (contournement d’urgence)');
    const { getT3Protections } = await import('@/services/ai/reconciliation/t3-protections');
    const p = await getT3Protections();
    expect(p.status).toBe('INACTIVE');
    expect(p.findings.find((f) => f.code === 'DEGRADED_CAP')).toMatchObject({ level: 'error', message: expect.stringContaining('LEVÉE par configuration') });
    expect(p.bypasses!.map((b) => b.variable).sort()).toEqual(['AI_DEGRADED_CALLS_PER_HOUR', 'AI_IDEMPOTENCY_DISABLED']);
    expect(p.bypasses!.find((b) => b.variable === 'AI_DEGRADED_CALLS_PER_HOUR')!.callsObserved).toBeGreaterThanOrEqual(5);
  });

  it('C828-A06 : signature de configuration non résolue (rattachement) — appel annoncé admis à l’envoi, puis refusé avant contact ; réservation rendue', async () => {
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_link_ambiguity' };
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '1';
    let appels = 0;
    const fournisseur = async () => { appels++; return { v: appels, fromCache: false }; };
    const annoncer = () => dm.announceUnprotectedCall({ ...meta, component: 'CONFIG_SIGNATURE', reason: 'SIGNATURE_UNRESOLVED' });
    annoncer();
    expect(await tenter(() => idem.withIdempotency(`c828:a06:${c.id}:1`, fournisseur, 3600, meta))).toBe('ÉMIS');
    // Une réponse du cache ne consomme rien, annonce ou non (aucune requête ne part).
    annoncer();
    expect(await idem.withIdempotency(`c828:a06:${c.id}:1`, fournisseur, 3600, meta)).toMatchObject({ fromCache: true });
    // L'annonce restée en attente est soldée par le prochain appel RÉEL de la portée : budget épuisé → refus avant contact.
    expect(await tenter(() => idem.withIdempotency(`c828:a06:${c.id}:2`, fournisseur, 3600, meta))).toBe('DEGRADED_CALL_REFUSED');
    expect(appels).toBe(1);
    // La réservation du refus est RENDUE (aucune ligne PENDING laissée : une demande suivante pourra réessayer).
    expect(await sql`SELECT state FROM ai_operation_idempotency WHERE key_hash = ${`c828:a06:${c.id}:2`}`).toHaveLength(0);
    // Sans annonce (signature résolue) : appel normal, protégé par le cache, hors budget dégradé.
    expect(await tenter(() => idem.withIdempotency(`c828:a06:${c.id}:3`, fournisseur, 3600, meta))).toBe('ÉMIS');
    expect(appels).toBe(2);
    expect(await jusqua(() => budget(c.id), (x) => (x[0]?.refused ?? 0) >= 1)).toEqual([{ treatment: 'T3', operation_code: 't3_link_ambiguity', admitted: 1, refused: 1 }]);
    const d = await jusqua(() => degrades(c.id), (x) => totalDegrades(x) >= 3);
    expect(d).toEqual([
      { component: 'CONFIG_SIGNATURE', reason: 'SIGNATURE_UNRESOLVED', impact: 'CALL_REFUSED', n: 1, code: null },
      { component: 'CONFIG_SIGNATURE', reason: 'SIGNATURE_UNRESOLVED', impact: 'CALL_WITHOUT_PROTECTION', n: 2, code: null },
    ]);
  });

  // ══ ÉCART B ═══════════════════════════════════════════════════════════════════════════════════════════════

  const bienAvecPreuve = async (run: number) => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    const f = await make.assetFile(c as never, { assetId: bien.id });
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    await persistProjectedFacts({
      input: { sourceType: 'file', sourceIds: [f.id], accountId: c.id, userId: c.ownerUserId, mimeTypes: [], displayNames: [] },
      leadSourceId: f.id, trace, analysisRunId: run, documentType: 'DIAGNOSTIC', facts: [annee(bien.id, 1948)],
    });
    return { c, bien };
  };

  it('C828-B01 : INSERT de l’événement d’usage refusé — requêtes physiques conservées, perte comptée à part et alertée ; la réconciliation retombe à zéro', async () => {
    const { c, bien } = await bienAvecPreuve(98282);
    // Le modèle principal échoue (503), le repli répond : UNE demande, DEUX requêtes, DEUX événements d'usage.
    const r = await useRecordings([reussite({ output: '', error: { message: '503 Service Unavailable', status: 503 } }), reussite({ repeat: true })]);
    // La base REFUSE la ligne du rang principal de ce compte (contrainte simulée par la base elle-même).
    await sql.unsafe(`CREATE OR REPLACE FUNCTION c828_refus_usage() RETURNS trigger AS $$
      BEGIN IF NEW.account_id = ${Number(c.id)} AND NEW.model_rank = 'primary' THEN RAISE EXCEPTION 'refus c828' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql.unsafe(`CREATE TRIGGER c828_refus_usage BEFORE INSERT ON ai_usage_event FOR EACH ROW EXECUTE FUNCTION c828_refus_usage()`);
    const { reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine');
    let passage: Awaited<ReturnType<typeof reconcileAsset>>;
    try {
      passage = await reconcileAsset({ accountId: c.id, userId: c.ownerUserId, assetId: bien.id, triggeredBy: 'scheduled' });
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS c828_refus_usage ON ai_usage_event`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS c828_refus_usage()`);
    }
    // La demande n'a pas échoué (la télémétrie ne casse jamais le métier) et la décision est rendue.
    expect(passage.decisions.find((x) => x.fieldKey === 'constructionYear')).toMatchObject({ action: 'create_conflict' });
    expect(r.calls).toHaveLength(2);
    // (1) Requêtes réseau : 2 — jamais ramenées à 1 (les lignes écrites), jamais à zéro.
    expect(passage).toMatchObject({ providerCalls: 2, aiCountersSemantics: 'MEASURED_V1' });
    const [run] = await sql<Array<{ provider_calls: number; ai_counters_semantics: string; ai_activity: AiActivitySnapshot }>>`
      SELECT provider_calls, ai_counters_semantics, ai_activity FROM reconciliation_runs WHERE id = ${passage.runId}`;
    expect(run).toMatchObject({ provider_calls: 2, ai_counters_semantics: 'MEASURED_V1' });
    // (2) Événements constatés : 2, dont 1 NON enregistré, portant 1 requête.
    expect(run.ai_activity.total).toMatchObject({ networkRequests: 2, usageEvents: 2, usageEventsNotPersisted: 1, networkRequestsNotPersisted: 1 });
    expect(run.ai_activity.unpersistedTraceIds).toHaveLength(1);
    // (3) Lignes durables : 1 seule (le repli).
    const lignes = await sql<Array<{ model_rank: string; n: number }>>`
      SELECT model_rank, (metadata->>'networkRequests')::int AS n FROM ai_usage_event WHERE account_id = ${c.id} ORDER BY id`;
    expect(lignes.map((l) => [l.model_rank, l.n])).toEqual([['fallback_1', 1]]);
    // La perte est tracée durablement et alertée, sous un titre qui ne parle pas d'une « protection ».
    const d = await jusqua(() => degrades(c.id), (x) => x.some((y) => y.component === 'USAGE_JOURNAL'));
    expect(d.find((x) => x.component === 'USAGE_JOURNAL')).toEqual({ component: 'USAGE_JOURNAL', reason: 'WRITE_FAILED', impact: 'USAGE_EVENT_LOST', n: 1, code: '23514' });
    const alerte = await jusqua(() => anomalies('USAGE_JOURNAL'), (x) => x.length >= 1);
    expect(alerte[0].title).toBe('IA — journal des événements d’usage : écriture en échec (compteurs durables incomplets)');
    // Réconciliation (requête de la fiche) : passage − perte = somme des événements, à l'unité.
    const { reconcileRunCounters, USAGE_EVENT_LOSSES_SQL } = await import('@/services/ai/measure/ai-counters-reconciliation');
    const rec = await reconcileRunCounters(q, 'reconciliation_runs', c.id);
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]).toMatchObject({
      requetes_du_passage: 2, evenements_constates: 2, evenements_non_enregistres: 1, requetes_non_enregistrees: 1,
      evenements_enregistres: 1, requetes_des_evenements: 1, ecart_requetes: 0, ecart_evenements: 0,
    });
    expect(rec.diverging).toEqual([]);
    const pertes = await q(USAGE_EVENT_LOSSES_SQL, [1]);
    expect(pertes.find((x) => Number(x.account_id) === c.id)).toMatchObject({ evenements_perdus: 1, operation_code: OP, code_technique: '23514' });
  });

  it('C828-B02 : passage du compte avec repli — fournisseur = passage = événements = file IA = rapport = export ; un total falsifié fait DIVERGER la réconciliation', async () => {
    const { c, bien } = await bienAvecPreuve(98283);
    const r = await useRecordings([reussite({ output: '', error: { message: '503 Service Unavailable', status: 503 } }), reussite({ repeat: true })]);
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const { reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine');
    const { runT3Job } = await import('@/services/ai/reconciliation/t3-queue');
    const job = (id: number) => ({ id, accountId: c.id, targetType: null, targetId: null, treatment: 'T3', origin: 'manual', triggerCode: 'manual', payload: { payloadVersion: 1, kind: 'account', scope: 'full' }, createdAt: new Date(0), startedAt: new Date(), executionId: null });
    const deps = { reconcileAsset, reconcileAccount, enqueue: (async () => ({ jobId: null })) as never, listSweepAccounts: async () => [] };
    const garde = { assertActive: async () => {} } as never;
    const res = await runT3Job(job(982801) as never, garde, deps);
    const detail = res.detail as Record<string, unknown>;
    // SOURCE DE VÉRITÉ : ce que le fournisseur simulé a réellement reçu.
    const fournisseur = r.calls.length;
    expect(fournisseur).toBeGreaterThanOrEqual(2);

    // (a) Journal du passage (SQL).
    const [run] = await sql<Array<{ id: number; provider_calls: number; provider_attempts: number; ai_logical_requests: number; ai_requests_declared: number; ai_counters_semantics: string; ai_activity: AiActivitySnapshot }>>`
      SELECT id, provider_calls, provider_attempts, ai_logical_requests, ai_requests_declared, ai_counters_semantics, ai_activity
        FROM account_reconciliation_runs WHERE id = ${Number(detail.runId)}`;
    expect(run).toMatchObject({ provider_calls: fournisseur, ai_counters_semantics: 'MEASURED_V1' });
    expect(run.ai_activity.total).toMatchObject({ networkRequests: fournisseur, usageEventsNotPersisted: 0, networkRequestsNotPersisted: 0 });
    // Demande logique, tentative, requête, demande déclarée : quatre nombres distincts, jamais assimilés.
    expect(run.ai_logical_requests).toBeLessThan(run.provider_calls);
    expect(run.ai_requests_declared).toBeLessThan(run.provider_calls);
    // (b) Événements d'usage durables (SQL) et (c) réconciliation de la fiche : écart nul.
    const { reconcileRunCounters } = await import('@/services/ai/measure/ai-counters-reconciliation');
    const compte = await reconcileRunCounters(q, 'account_reconciliation_runs', c.id);
    expect(compte.rows).toHaveLength(1);
    expect(compte.rows[0]).toMatchObject({ run_id: run.id, requetes_du_passage: fournisseur, requetes_des_evenements: fournisseur, ecart_requetes: 0, ecart_evenements: 0, traces_tronquees: false });
    expect(compte.diverging).toEqual([]);
    const local = await reconcileRunCounters(q, 'reconciliation_runs', c.id);
    expect(local.diverging).toEqual([]);
    expect(local.rows.reduce((n, x) => n + Number(x.requetes_du_passage), 0)).toBe(2);
    // (d) File IA (JSON du travail) et texte du BO.
    expect(detail).toMatchObject({ aiCountersSemantics: 'MEASURED_V1', aiCalls: fournisseur, withoutAiCall: false });
    const { jobAiText } = await import('@/app/admin/ai-queue/_components/T3Supervision');
    expect(jobAiText({
      aiCalls: Number(detail.aiCalls), aiCountersSemantics: String(detail.aiCountersSemantics), aiLogicalRequests: Number(detail.aiLogicalRequests),
      aiProviderAttempts: Number(detail.aiProviderAttempts), aiCallsOtherTreatments: Number(detail.aiCallsOtherTreatments),
    })).toContain(`${fournisseur} requête(s) réellement émise(s) vers le modèle`);
    // (e) Diagnostic « À traiter » du BO (lecture de la ligne du passage).
    const { runAiCounters } = await import('@/services/ai/queue/t3-open-actions-diagnostic');
    const [ligne] = await q(`SELECT to_jsonb(r) AS j FROM account_reconciliation_runs r WHERE id = $1`, [run.id]);
    expect(runAiCounters(ligne.j as Record<string, unknown>)).toMatchObject({ semantics: 'MEASURED_V1', providerCalls: fournisseur });
    // (f) Rapport d'exécution T3 du bien.
    const [rapport] = await sql<Array<{ counters: Record<string, number>; sources: { aiUsage: Record<string, unknown> } }>>`
      SELECT counters, sources FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T3' ORDER BY id LIMIT 1`;
    expect(rapport.counters).toMatchObject({ aiProviderCalls: 2 });
    expect(rapport.sources.aiUsage).toMatchObject({ providerCalls: 2, providerCallsNature: 'MEASURED', withoutAiCall: false });
    // (g) Export ZIP (#802) : même calcul que `diagnostics.aiUsage`, sur les colonnes de l'export.
    const { aiUsageOfJobs, AI_USAGE_PROVIDER_CALLS_SEMANTICS } = await import('@/services/ai/business-execution/export');
    const { USAGE_COLS } = await import('@/services/admin/diagnostics-export/trace');
    const appels = await q(`SELECT ${USAGE_COLS}, CASE WHEN jsonb_typeof(metadata->'networkRequests') = 'number' THEN (metadata->>'networkRequests')::int END AS network_requests
                              FROM ai_usage_event WHERE metadata->>'traceId' = ANY($1::text[]) ORDER BY id`, [run.ai_activity.traceIds]);
    const exportZip = aiUsageOfJobs(appels, []);
    expect(exportZip).toMatchObject({ providerCalls: fournisseur, providerCallsSemantics: AI_USAGE_PROVIDER_CALLS_SEMANTICS, usageEventLines: appels.length, providerCallsUndetermined: 0, withoutAiCall: false });
    // (h) Export de diagnostic administrateur : requêtes du compte, passages mesurés seulement.
    const { readAiUsageDistinct } = await import('@/services/admin/diagnostics-export/collect');
    const admin = await readAiUsageDistinct(q as never, [c.id]);
    expect(admin.providerCalls.total).toBe(fournisseur);
    expect(admin.t3Runs).toMatchObject({ total: 1, measured: 1, withAiCall: 1, withoutAiCall: 0, declared: 0, legacySemantics: 0, unmeasured: 0 });

    // TEST CROISÉ : un total qui diverge est DÉTECTÉ (compteur du passage falsifié, puis rétabli).
    await sql`UPDATE account_reconciliation_runs SET provider_calls = provider_calls + 1 WHERE id = ${run.id}`;
    try {
      const faux = await reconcileRunCounters(q, 'account_reconciliation_runs', c.id);
      expect(faux.diverging.map((x) => [Number(x.run_id), Number(x.ecart_requetes)])).toEqual([[Number(run.id), 1]]);
    } finally { await sql`UPDATE account_reconciliation_runs SET provider_calls = provider_calls - 1 WHERE id = ${run.id}`; }
    // … et une ligne d'événement en trop (double compte) l'est aussi.
    const [copie] = await sql<Array<{ id: number }>>`
      INSERT INTO ai_usage_event (account_id, operation_type, provider, model, status, use_case_code, operation_code, metadata)
      SELECT account_id, operation_type, provider, model, status, use_case_code, operation_code, metadata FROM ai_usage_event
       WHERE metadata->>'traceId' = ANY(${run.ai_activity.traceIds}) ORDER BY id LIMIT 1 RETURNING id`;
    try {
      const double = await reconcileRunCounters(q, 'account_reconciliation_runs', c.id);
      expect(double.diverging).toHaveLength(1);
      expect(Number(double.diverging[0].ecart_evenements)).toBe(-1);
    } finally { await sql`DELETE FROM ai_usage_event WHERE id = ${copie.id}`; }
    expect((await reconcileRunCounters(q, 'account_reconciliation_runs', c.id)).diverging).toEqual([]);

    // Passage suivant, rien n'a changé : zéro requête PROUVÉ (mesure), décision de la mémoire.
    const avant2 = r.calls.length;
    const res2 = await runT3Job(job(982802) as never, garde, deps);
    expect(r.calls.length).toBe(avant2);
    expect(res2.detail as Record<string, unknown>).toMatchObject({ aiCountersSemantics: 'MEASURED_V1', aiCalls: 0, withoutAiCall: true });
    expect((await readAiUsageDistinct(q as never, [c.id])).t3Runs).toMatchObject({ total: 2, measured: 2, withAiCall: 1, withoutAiCall: 1 });
    expect((await reconcileRunCounters(q, 'account_reconciliation_runs', c.id)).diverging).toEqual([]);
    void bien;
  });

  it('C828-B03 : historique — sans sémantique ou à demandes déclarées : jamais « zéro appel » ; aucune ligne réécrite ; DECLARED n’écrit plus de valeur déclarative', async () => {
    const c = await make.account();
    const inserer = async (providerCalls: number | null, semantics: string | null, declared: number | null) => (await sql<Array<{ id: number }>>`
      INSERT INTO account_reconciliation_runs (account_id, trigger_type, correlation_id, scope, status, started_at, finished_at, ai_calls, provider_calls, ai_counters_semantics, ai_requests_declared)
      VALUES (${c.id}, 'scheduled', gen_random_uuid(), 'incremental', 'completed', now() - interval '3 days', now() - interval '3 days', 0, ${providerCalls}, ${semantics}, ${declared}) RETURNING id`)[0].id;
    const ancienZero = await inserer(0, null, null);      // historique : « 0 » d'origine, non prouvable
    const ancienSept = await inserer(7, null, null);      // historique : somme de demandes déclarées
    const nonMesure = await inserer(null, null, null);    // antérieur au lot 99A
    const declare = await inserer(null, 'DECLARED', 3);   // demandes déclarées, passerelle non observée
    const mesureZero = await inserer(0, 'MEASURED_V1', 0);
    const mesureDeux = await inserer(2, 'MEASURED_V1', 1);
    const avantLecture = await sql`SELECT id, provider_calls, ai_counters_semantics, ai_requests_declared, ai_activity FROM account_reconciliation_runs WHERE account_id = ${c.id} ORDER BY id`;

    // Export de diagnostic administrateur : « sans appel » = 1 (le seul zéro MESURÉ), jamais 2.
    const { readAiUsageDistinct, usageSummaryLines } = await import('@/services/admin/diagnostics-export/collect');
    const admin = await readAiUsageDistinct(q as never, [c.id]);
    expect(admin.t3Runs).toEqual({ total: 6, withoutAiCall: 1, withAiCall: 1, unmeasured: 1, legacySemantics: 2, measured: 2, declared: 1 });
    const texte = String(usageSummaryLines(admin).find(([k]) => k.startsWith('Passages T3 sans appel IA'))![1]);
    expect(texte).toContain('1 / 2 mesuré(s), sur 6 passage(s)');
    expect(texte).toContain('2 passage(s) historique(s) en ancienne sémantique');
    // Requête de la fiche : même partition.
    const { RUNS_BY_COUNTER_NATURE_SQL } = await import('@/services/ai/measure/ai-counters-reconciliation');
    const natures = await q(RUNS_BY_COUNTER_NATURE_SQL, [c.id]);
    expect(natures.map((n) => [n.nature, n.passages, n.sans_appel_prouve, n.avec_appel_prouve, n.valeur_d_origine_conservee, n.demandes_declarees])).toEqual([
      ['DECLARED', 1, 0, 0, 0, 3], ['MEASURED', 2, 1, 1, 0, 0], ['UNKNOWN', 3, 0, 0, 2, 0],
    ]);
    // Lecture unique (BO, champs calculés) : inconnu ≠ zéro.
    const { certifiedProviderCalls, certifiedWithoutAiCall } = await import('@/services/ai/measure/ai-activity');
    const lire = async (id: number) => (await sql<Array<{ provider_calls: number | null; ai_counters_semantics: string | null; ai_requests_declared: number | null }>>`
      SELECT provider_calls, ai_counters_semantics, ai_requests_declared FROM account_reconciliation_runs WHERE id = ${id}`)[0];
    const nature = async (id: number) => { const l = await lire(id); return { ...certifiedProviderCalls(l.ai_counters_semantics, l.provider_calls, l.ai_requests_declared), sansAppel: certifiedWithoutAiCall(l.ai_counters_semantics, l.provider_calls) }; };
    expect(await nature(ancienZero)).toMatchObject({ nature: 'UNKNOWN', providerCalls: null, legacyValue: 0, sansAppel: null });
    expect(await nature(ancienSept)).toMatchObject({ nature: 'UNKNOWN', providerCalls: null, legacyValue: 7, sansAppel: null });
    expect(await nature(nonMesure)).toMatchObject({ nature: 'UNKNOWN', providerCalls: null, legacyValue: null, sansAppel: null });
    expect(await nature(declare)).toMatchObject({ nature: 'DECLARED', providerCalls: null, declaredRequests: 3, sansAppel: null });
    expect(await nature(mesureZero)).toMatchObject({ nature: 'MEASURED', providerCalls: 0, sansAppel: true });
    expect(await nature(mesureDeux)).toMatchObject({ nature: 'MEASURED', providerCalls: 2, sansAppel: false });
    // BO › réconciliation d'un compte (même projection SQL que la route d'administration).
    const route = await q(`SELECT id,
        CASE WHEN to_jsonb(r) ->> 'ai_counters_semantics' = 'MEASURED_V1' THEN (to_jsonb(r) ->> 'provider_calls')::int END AS provider_calls,
        CASE WHEN to_jsonb(r) ->> 'ai_counters_semantics' = 'MEASURED_V1' THEN 'MEASURED' WHEN to_jsonb(r) ->> 'ai_counters_semantics' = 'DECLARED' THEN 'DECLARED' ELSE 'UNKNOWN' END AS provider_calls_nature,
        CASE WHEN to_jsonb(r) ->> 'ai_counters_semantics' IS NULL THEN (to_jsonb(r) ->> 'provider_calls')::int END AS provider_calls_legacy
      FROM account_reconciliation_runs r WHERE account_id = $1 ORDER BY id`, [c.id]);
    expect(route.map((x) => [x.provider_calls, x.provider_calls_nature, x.provider_calls_legacy])).toEqual([
      [null, 'UNKNOWN', 0], [null, 'UNKNOWN', 7], [null, 'UNKNOWN', null], [null, 'DECLARED', null], [0, 'MEASURED', null], [2, 'MEASURED', null],
    ]);
    // Les passages non mesurés ne sont pas « réconciliés » de force : la requête ne les rend pas.
    const { reconcileRunCounters } = await import('@/services/ai/measure/ai-counters-reconciliation');
    expect((await reconcileRunCounters(q, 'account_reconciliation_runs', c.id)).rows.map((x) => Number(x.run_id)).sort()).toEqual([Number(mesureZero), Number(mesureDeux)].sort());
    // AUCUNE réécriture de l'historique par ces lectures.
    expect(await sql`SELECT id, provider_calls, ai_counters_semantics, ai_requests_declared, ai_activity FROM account_reconciliation_runs WHERE account_id = ${c.id} ORDER BY id`).toEqual(avantLecture);

    // Écriture : un run clos en sémantique DECLARED n'écrit PAS la valeur déclarative dans `provider_calls`.
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    const { openRun, closeRun } = await import('@/services/ai/reconciliation/reconciliation-run.repository');
    const runId = await openRun({ accountId: c.id, assetId: bien.id, triggeredBy: 'scheduled', shadow: false, traceId: randomUUID() });
    await closeRun(runId, {
      runId, accountId: c.id, assetId: bien.id, triggeredBy: 'scheduled', decisions: [], appliedCount: 0, conflictCount: 0, aiReviewCount: 3,
      providerCalls: 3, aiCountersSemantics: 'DECLARED', aiDeclaredRequests: 3, aiCacheHits: 0, decisionsReused: 0,
    } as never);
    const [clos] = await sql<Array<{ provider_calls: number | null; ai_counters_semantics: string; ai_requests_declared: number }>>`
      SELECT provider_calls, ai_counters_semantics, ai_requests_declared FROM reconciliation_runs WHERE id = ${runId}`;
    // Avant la carte #828 : provider_calls = 3 (une valeur déclarative dans un champ d'appels réels).
    expect(clos).toEqual({ provider_calls: null, ai_counters_semantics: 'DECLARED', ai_requests_declared: 3 });
  });

  // ══ ÉCART C ═══════════════════════════════════════════════════════════════════════════════════════════════

  it('C828-C01 : bail expiré puis repris, écriture TARDIVE du premier travailleur pendant l’appel du repreneur — « bail perdu », rien d’écrasé, réponse du repreneur servie ensuite', async () => {
    process.env.AI_IDEMPOTENCY_LEASE_SECONDS = '2';
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: OP };
    const key = `c828:c01:${c.id}`;
    vi.resetModules();
    const instanceA = await import('@/services/ai/idempotency/idempotency.service');
    const dbA = (await import('@/db')).pgClient;
    vi.resetModules();
    const instanceB = await import('@/services/ai/idempotency/idempotency.service');
    const dbB = (await import('@/db')).pgClient;
    try {
      let appels = 0;
      let rendreA: (v: { v: string }) => void = () => undefined;
      let rendreB: (v: { v: string }) => void = () => undefined;
      let aParti: () => void = () => undefined;
      let bParti: () => void = () => undefined;
      const departA = new Promise<void>((res) => { aParti = res; });
      const departB = new Promise<void>((res) => { bParti = res; });
      const pa = instanceA.withIdempotency(key, () => { appels++; aParti(); return new Promise<{ v: string }>((res) => { rendreA = res; }); }, 3600, meta);
      await departA;
      // Arrêt des renouvellements de A (instance figée) : son bail s'éteint ; B attend la fin du bail puis REPREND la clé.
      expect(instanceA.__stopLeaseRenewalsForTests()).toBe(1);
      const pb = instanceB.withIdempotency(key, () => { appels++; bParti(); return new Promise<{ v: string }>((res) => { rendreB = res; }); }, 3600, meta);
      await departB;
      expect(appels).toBe(2);
      const pendant = await sql<Array<{ state: string; owner_token: string | null }>>`SELECT state, owner_token FROM ai_operation_idempotency WHERE key_hash = ${key}`;
      expect(pendant).toHaveLength(1);
      expect(pendant[0].state).toBe('PENDING');
      // A répond ENFIN, alors que B appelle encore : son écriture ne touche AUCUNE ligne (l'instruction SQL est valide).
      rendreA({ v: 'tardive' });
      const ra = await pa;
      // Avant la carte #828 : « écrit » (vrai) — l'appelant croyait sa réponse en cache. Maintenant : bail perdu, dit.
      expect(ra).toEqual({ v: 'tardive', cacheWrite: 'LEASE_LOST' });
      expect(instanceA.cacheWriteOutcomeOf(ra)).toBe('LEASE_LOST');
      // Rien d'écrasé : la réservation du repreneur est intacte (même propriétaire, toujours PENDING).
      expect(await sql`SELECT state, owner_token FROM ai_operation_idempotency WHERE key_hash = ${key}`).toEqual(pendant);
      // Le repreneur termine : SA réponse est en cache, sans marque (écriture réussie).
      rendreB({ v: 'reprise' });
      const rb = await pb;
      expect(rb).toEqual({ v: 'reprise' });
      expect(instanceB.cacheWriteOutcomeOf(rb)).toBeNull();
      const [fin] = await sql<Array<{ state: string; result_json: unknown; owner_token: string | null }>>`SELECT state, result_json, owner_token FROM ai_operation_idempotency WHERE key_hash = ${key}`;
      expect(fin).toEqual({ state: 'READY', result_json: { v: 'reprise' }, owner_token: null });
      // Appel ultérieur (l'une ou l'autre instance) : servi du cache, aucune requête.
      expect(await instanceA.withIdempotency(key, async () => { appels++; return { v: 'inutile' }; }, 3600, meta)).toEqual({ v: 'reprise', fromCache: true, cacheOutcome: 'CACHE_HIT' });
      expect(appels).toBe(2);
      // Perte LÉGITIME du bail tracée comme telle (pas un échec technique d'écriture).
      const d = await jusqua(() => degrades(c.id), (x) => x.some((y) => y.reason === 'LEASE_LOST'));
      expect(d.filter((x) => x.reason === 'LEASE_LOST')).toEqual([{ component: 'CACHE_RESERVATION', reason: 'LEASE_LOST', impact: 'RESULT_NOT_STORED', n: 1, code: null }]);
      expect(d.some((x) => x.reason === 'WRITE_FAILED')).toBe(false);
    } finally {
      await dbA.end({ timeout: 2 }).catch(() => undefined);
      await dbB.end({ timeout: 2 }).catch(() => undefined);
      vi.resetModules();
    }
  });

  it('C828-C02 : écriture du cache refusée par la base — « non conservée » dite à l’appelant ; réussie : aucune marque ; l’appel suivant est borné', async () => {
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_document_naming' };
    process.env.AI_DEGRADED_CALLS_PER_HOUR = '1';
    let appels = 0;
    const fournisseur = async () => { appels++; return { v: appels }; };
    // Écriture réussie : la réponse est rendue telle quelle, et elle EST en cache.
    const ok = await idem.withIdempotency(`c828:c02:ok:${c.id}`, fournisseur, 3600, meta);
    expect(ok).toEqual({ v: 1 });
    expect(await sql`SELECT state FROM ai_operation_idempotency WHERE key_hash = ${`c828:c02:ok:${c.id}`}`).toEqual([{ state: 'READY' }]);

    await sql.unsafe(`CREATE OR REPLACE FUNCTION c828_refus_cache() RETURNS trigger AS $$
      BEGIN IF NEW.state = 'READY' AND NEW.key_hash LIKE 'c828:c02:ko:%' THEN RAISE EXCEPTION 'refus c828' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql.unsafe(`CREATE TRIGGER c828_refus_cache BEFORE INSERT OR UPDATE ON ai_operation_idempotency FOR EACH ROW EXECUTE FUNCTION c828_refus_cache()`);
    try {
      const k = `c828:c02:ko:${c.id}`;
      const r1 = await idem.withIdempotency(k, fournisseur, 3600, meta);
      // Le résultat métier est préservé ; l'appelant SAIT qu'il n'est pas en cache.
      expect(r1).toEqual({ v: 2, cacheWrite: 'FAILED' });
      expect(await sql`SELECT 1 FROM ai_operation_idempotency WHERE key_hash = ${k} AND state = 'READY'`).toHaveLength(0);
      // Appel ultérieur : aucune réponse en cache → nouvel appel, admis par la borne (1), non conservé lui non plus.
      expect(await idem.withIdempotency(k, fournisseur, 3600, meta)).toEqual({ v: 3, cacheWrite: 'FAILED' });
      // Puis refus avant contact : jamais une boucle de rappels facturés.
      expect(await tenter(() => idem.withIdempotency(k, fournisseur, 3600, meta))).toBe('DEGRADED_CALL_REFUSED');
      expect(appels).toBe(3);
      const d = await jusqua(() => degrades(c.id), (x) => totalDegrades(x) >= 3);
      expect(d).toEqual([
        { component: 'RESPONSE_CACHE', reason: 'WRITE_FAILED', impact: 'CALL_REFUSED', n: 1, code: null },
        { component: 'RESPONSE_CACHE', reason: 'WRITE_FAILED', impact: 'RESULT_NOT_STORED', n: 2, code: '23514' },
      ]);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS c828_refus_cache ON ai_operation_idempotency`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS c828_refus_cache()`);
    }
  });

  // ══ REQUÊTES DE LA FICHE 117C ═════════════════════════════════════════════════════════════════════════════

  it('C828-SQL : toutes les requêtes en lecture seule de la fiche 117C s’exécutent sur le schéma réel', async () => {
    const c = await make.account();
    const R = await import('@/services/ai/measure/ai-counters-reconciliation');
    await expect(q(R.runCountersReconciliationSql('account_reconciliation_runs'), [c.id, 20])).resolves.toEqual([]);
    await expect(q(R.runCountersReconciliationSql('reconciliation_runs'), [c.id, 20])).resolves.toEqual([]);
    await expect(q(R.RUNS_BY_COUNTER_NATURE_SQL, [c.id])).resolves.toEqual([]);
    await expect(q(R.USAGE_EVENT_LOSSES_SQL, [7])).resolves.toBeInstanceOf(Array);
    await expect(q(R.ORPHAN_CAPTURES_SQL, [c.id, 7])).resolves.toEqual([]);
    await expect(q(R.DEGRADED_BUDGET_SQL, [24])).resolves.toBeInstanceOf(Array);
    await expect(q(R.DEGRADED_EVENTS_SQL, [7])).resolves.toBeInstanceOf(Array);
    await expect(q(R.RESPONSE_CACHE_STATE_SQL)).resolves.toBeInstanceOf(Array);
    const migrations = await q(R.REQUIRED_MIGRATIONS_SQL);
    // 0856 (deux fichiers), 0857, 0858, 0859, 1860, 1861 et 1940 : huit fichiers attendus avant la mise en production.
    expect(migrations.map((m) => String(m.filename).slice(0, 4))).toEqual(['0856', '0856', '0857', '0858', '0859', '1860', '1861', '1940']);
    // Écart D — requêtes de la recette de préproduction (R12, R13) : syntaxe et colonnes vérifiées ici ; leur
    // RÉSULTAT sur les données réelles (compte 13, 16–17/11) reste à lire par le PO en préproduction.
    await expect(q(R.R13_USAGE_EVENTS_SQL, ['2026-11-16 00:00+01', '2026-11-18 00:00+01'])).resolves.toEqual([]);
    await expect(q(R.R13_REUSE_SQL, ['2026-11-16', '2026-11-17'])).resolves.toEqual([]);
    await expect(q(R.R12_CASE_DATA_SQL, [13, 14, 1238, [4806, 4813]])).resolves.toBeInstanceOf(Array);
    await expect(q(R.R12_DECISION_MEMORY_SQL, [13, 14, '%constructionYear%'])).resolves.toBeInstanceOf(Array);
    await expect(q(R.R12_ARBITRATION_SQL, [13, 14, '%constructionYear%'])).resolves.toBeInstanceOf(Array);
    await expect(q(R.R12_CALLS_BY_DAY_SQL, [13])).resolves.toBeInstanceOf(Array);
    // Aucune de ces requêtes n'écrit : elles s'exécutent toutes dans une transaction en lecture seule.
    await sql.begin('READ ONLY', async (tx) => {
      for (const texte of [R.RUNS_BY_COUNTER_NATURE_SQL, R.runCountersReconciliationSql('account_reconciliation_runs')]) {
        await tx.unsafe(texte, (texte.includes('$2') ? [c.id, 5] : [c.id]) as never[]);
      }
      for (const [texte, p] of [[R.USAGE_EVENT_LOSSES_SQL, [7]], [R.ORPHAN_CAPTURES_SQL, [c.id, 7]], [R.DEGRADED_BUDGET_SQL, [24]], [R.DEGRADED_EVENTS_SQL, [7]], [R.RESPONSE_CACHE_STATE_SQL, []], [R.REQUIRED_MIGRATIONS_SQL, []],
        [R.R13_USAGE_EVENTS_SQL, ['2026-11-16 00:00+01', '2026-11-18 00:00+01']], [R.R13_REUSE_SQL, ['2026-11-16', '2026-11-17']],
        [R.R12_CASE_DATA_SQL, [13, 14, 1238, [4806, 4813]]], [R.R12_DECISION_MEMORY_SQL, [13, 14, '%constructionYear%']],
        [R.R12_ARBITRATION_SQL, [13, 14, '%constructionYear%']], [R.R12_CALLS_BY_DAY_SQL, [13]]] as Array<[string, unknown[]]>) {
        await tx.unsafe(texte, p as never[]);
      }
    });
  });
});
