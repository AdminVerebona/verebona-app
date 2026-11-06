/**
 * Lot 105B sur PostgreSQL 16 réel — ticket P1 « IA auto-amélioration :
 * promotion sur preuves, reprise, surveillance ». Migration 0985. Fournisseur
 * SIMULÉ (aucun réseau) ; passerelle, configuration IA, campagnes 86A, verrou
 * A1 (journal, empreintes), revalidation d'activation, surveillance : code de
 * production. Le verrou A1 est COMMANDÉ par la scène (fermé « structurel »,
 * fermé « résultats », levé) : sa logique propre est recettée par l100b et
 * l105b-promotion.test.ts ; ici on recette le CYCLE de promotion.
 *
 *  L105B-E01        migration 0985 rejouable ; table classée (diagnostic global, recette, restauration)
 *  L105B-E02 (R3)   candidate qualifiée MÉTIER, verrou A1 fermé → BLOCKED_A1 (ni QUALIFIED activable, ni
 *                   REFUSED) ; qualification, décision A1 et preuves conservées séparément ; active intacte
 *  L105B-E03 (R3)   cause inchangée : aucune relance, aucun appel, aucune version créée
 *  L105B-E04 (R3)   certification changée mais manques STRUCTURELS restants : « en attente », aucun appel,
 *                   idempotent
 *  L105B-E05 (R3)   certification complétée : relance AUTOMATIQUE de la MÊME candidate (même modèle),
 *                   revalidation depuis la base, activation en préproduction, surveillance ouverte
 *  L105B-E06 (R8)   surveillance : sans preuve → aucun retour arrière ; cas certifiés rejoués (POST_CHECK) en
 *                   régression imputable → retour arrière ATOMIQUE, candidate suspendue, journal, Supervision
 *  L105B-E07 (R5)   frontière d'activation : allowed:true forgé, autre campagne, autre candidate, approbation
 *                   révoquée, preuve obsolète, décision A1 expirée, verrou refusé, gel, changement CONCURRENT
 *                   entre revalidation et transaction → refus journalisés avec version de référence ; réclamation
 *                   valide → activation
 *  L105B-E08 (§5)   BO / diagnostic : état réel (a)…(e), jamais « automatique » sans progrès, P2 différé ;
 *                   production : aucune campagne, aucune activation, surveillance sans objet (R9)
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l105b@e2e.test', role: 'ADMIN' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => { if (session.role !== 'ADMIN') throw Object.assign(new Error('forbidden'), { status: 403 }); return session.adminId; },
    getSession: async () => ({ userId: session.adminId, email: session.email, role: session.role }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

type Json = Record<string, any>;
const CLE = 'cle-e2e-l105b';
type ApiModel = { name: string; outputTokenLimit?: number; thinking?: boolean };
const MODELES: ApiModel[] = [
  { name: 'gemini-3.5-flash' }, { name: 'gemini-2.5-flash' }, { name: 'gemini-2.5-pro' }, { name: 'gemini-3.1-flash-lite' }, { name: 'gemini-3.6-flash' },
].map((m) => ({ outputTokenLimit: 65_536, thinking: true, ...m }));
const fetcher = (async () => new Response(JSON.stringify({
  models: MODELES.map((m) => ({ name: `models/${m.name}`, supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: m.outputTokenLimit, thinking: m.thinking, temperature: 1, maxTemperature: 2 })),
}), { status: 200 })) as unknown as typeof fetch;
const CAS_T6 = 'H-P-T6-01-FORMULATION-FIDELE';

scenario('L105B', 'Promotion automatique IA sur preuves : BLOCKED_A1, relance, revalidation, surveillance', ({ sql, make }) => {
  let adminId = 0;
  let env = 'local';
  let techAccount = 0;
  let baseVersionId = 0;
  let activeAvant: number[] = [];
  let candidate = 0;
  const restorePoints: string[] = [];
  const takeRestorePoint = async (label: string) => { restorePoints.push(label); return { backupId: `rp-${restorePoints.length}`, finishedAt: new Date().toISOString() }; };
  const casDe = new Map<string, Array<{ key: string; output: unknown; id: string }>>();
  const casCourant = new AsyncLocalStorage<{ op: string; key: string }>();
  const comportement = new Map<string, { mode: 'GOOD' | 'BAD'; delayMs: number }>();
  const appels: Array<{ model: string }> = [];
  let provider: import('@/services/ai/gateway/providers').FakeProvider;
  let avantProvider: import('@/services/ai/gateway/providers/provider.port').AiProvider;
  /** Verrou A1 commandé par la scène. */
  let a1: 'STRUCTUREL' | 'RESULTATS' | 'LEVE' = 'STRUCTUREL';
  const REPONSES = new Set(['P-T6-01', 'P-T6-EV-01']);

  async function preparerCorpus() {
    const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { liveVariablesFor } = await import('@/services/ai/governance/master-corpus/live');
    const { canonicalJson } = await import('@/services/ai/qualification/signature');
    const corpus = loadMasterCorpusCases(readMasterFileFromRepo).map((c) => ({
      ...c, qualificationRole: REPONSES.has(c.id) ? 'answer' as const : c.operationCode.startsWith('t6_') ? 'guard' as const : c.qualificationRole ?? null,
    }));
    (await import('@/services/ai/qualification/cases')).__setQualificationCorpusForTests(corpus);
    (await import('@/services/ai/qualification/context')).__resetQualificationContextForTests();
    for (const op of ['t6_formulate', 't6_evaluate']) {
      const l: Array<{ key: string; output: unknown; id: string }> = [];
      for (const c of corpus.filter((x) => x.operationCode === op && x.qualificationRole === 'answer')) {
        const v = await liveVariablesFor(c);
        if (v) l.push({ key: canonicalJson(v), output: c.output, id: c.id });
      }
      casDe.set(op, l);
    }
  }
  const repondre = async (input: { model: string; prompt: string }) => {
    appels.push({ model: input.model });
    const b = comportement.get(input.model) ?? { mode: 'GOOD', delayMs: 20 };
    await new Promise((r) => setTimeout(r, b.delayMs));
    const cur = casCourant.getStore();
    const liste = cur ? casDe.get(cur.op) ?? [] : [];
    const i = liste.findIndex((c) => c.key === cur?.key);
    if (i < 0) throw Object.assign(new Error('400 INVALID_ARGUMENT : cas inconnu du fournisseur simulé'), { status: 400 });
    // « Mauvais » : la sortie de l'AUTRE opération T6 (contenu faux pour ce cas).
    const autre = [...casDe.entries()].find(([op]) => op !== cur?.op)?.[1][0];
    return { rawText: JSON.stringify(b.mode === 'BAD' ? autre?.output : liste[i].output), inputTokens: 10, outputTokens: 5 };
  };
  const call = async (req: { operationCode: string; promptVariables: Record<string, unknown> }, ctx: unknown) => {
    const { productionGatewayCall } = await import('@/services/ai/qualification/runner');
    const { canonicalJson } = await import('@/services/ai/qualification/signature');
    return casCourant.run({ op: req.operationCode, key: canonicalJson(req.promptVariables) }, () => productionGatewayCall(req as never, ctx as never));
  };
  let th: import('@/services/ai/qualification/thresholds').QualificationThresholds;
  const deps = (o: Record<string, unknown> = {}) => ({ takeRestorePoint, technicalAccountId: techAccount, accounts: async () => [] as number[], call: call as never, thresholds: th, ...o });
  const campagne = async (models: string[]) => (await import('@/services/ai/qualification/campaign')).requestAutomaticCampaign({ trigger: 'e2e-l105b' }, deps({ proposeModels: async (t: string) => (t === 'T6' ? models : []) }));
  const actif = async () => Number((await sql<Json[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].id);
  const version = async (id: number) => (await sql<Json[]>`SELECT id, status, candidate_state, candidate_reason, candidate_campaign_id, candidate_promotion FROM ai_config_versions WHERE id = ${id}`)[0];
  const evenements = async (kind: string, id: number) => sql<Json[]>`SELECT * FROM ai_promotion_events WHERE kind = ${kind} AND candidate_version_id = ${id} ORDER BY id`;
  const decision = async (status: 'REJETEE' | 'RETABLIE', caseId = CAS_T6) =>
    sql`INSERT INTO ai_corpus_case_decisions (case_id, status, reason, admin_user_id, admin_label) VALUES (${caseId}, ${status}, 'scène e2e l105b', ${adminId}, 'e2e')`;

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN', email: session.email });
    adminId = admin.id;
    session.adminId = admin.id;
    const tech = await (await import('@/services/ai/qualification/technical-account')).provisionCorpusAccount({ actor: 'e2e-l105b' });
    techAccount = tech.accountId!;
    process.env.CORPUS_ACCOUNT_ID = String(techAccount);
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_capability_changes', 'ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    await sql`DELETE FROM ai_corpus_case_decisions`;
    await sql`DELETE FROM ai_corpus_oracle_approvals`;
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    env = (await import('@/services/ai/config/environment')).getAiEnvironment();
    activeAvant = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id));
    const { syncAiCatalog } = await import('@/services/ai/provider/ai-catalog-sync.service');
    const qualif = async (i: { responseSchema?: unknown; attachments: unknown[] }) => ({ rawText: i.responseSchema ? '{"ok":true,"mot":"verebona"}' : i.attachments.length ? 'Rouge' : 'OK', inputTokens: 4, outputTokens: 2 });
    expect((await syncAiCatalog({ trigger: 'schedule' }, {
      fetcher, qualificationCall: qualif as never, probeCall: async () => ({ rawText: 'OK' }), maxQualifications: 50,
      pricing: { fetchPage: async () => { throw new Error('hors ligne'); }, billing: null }, raiseAlert: async () => false,
    })).ok).toBe(true);
    const svc = await import('@/services/ai/config/config-version.service');
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l105b référence' });
    const entries = v.entries.filter((e) => e.treatment === 'T6').map((e) => ({
      ...e, primaryModel: 'gemini-3.5-flash', reasoningPrimary: null, fallback1: 'gemini-2.5-flash', reasoningFallback1: null, fallback2: null, reasoningFallback2: null, operationProfiles: {},
    }));
    await svc.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, entries }, adminId);
    await svc.activate(v.id, adminId);
    baseVersionId = v.id;
    await preparerCorpus();
    // Lot 113I (CDC V2 C-004, MOD-03, PRO-01) : stabilité officielle des modèles candidats ATTESTÉE par un administrateur
    // (jamais déduite du nom) — sans cette preuve, la promotion autonome est refusée (MODEL_VERSION_UNVERIFIABLE).
    await sql`INSERT INTO ai_improvement_policy_revisions (environment, revision, policy, sha256, created_by, reason)
              VALUES (${env}, 1, ${JSON.stringify({ verifiedStableModels: ['gemini-3.1-flash-lite', 'gemini-3.6-flash'].map((model) => ({ model, source: 'e2e : attestation administrateur (C-004)' })) })}::jsonb, 'e2e', ${adminId}, 'e2e l105b')
              ON CONFLICT DO NOTHING`;
    const { QUALIFICATION_THRESHOLDS } = await import('@/services/ai/qualification/thresholds');
    th = { ...QUALIFICATION_THRESHOLDS, campaign: { ...QUALIFICATION_THRESHOLDS.campaign, maxCouplesPerCampaign: 0 } };
    const promo = await import('@/services/ai/governance/master-corpus/certification/promotion');
    promo.__setPromotionLockForTests((p) => (a1 === 'LEVE' ? promo.OPEN_LOCK_FOR_TESTS(p) : {
      rulesVersion: 'test', allowed: false, scope: p.treatments, measured: true, inventory: null, pairs: [],
      matrix: { rulesVersion: 'test', operations: [], cells: [], risks: [] },
      blockers: [a1 === 'STRUCTUREL'
        ? { code: 'OPERATION_NOT_COVERED', operationCode: 't6_evaluate', caseId: null, message: 'T6 · t6_evaluate : aucune référence approuvée (scène)', structural: true }
        : { code: 'CRITICAL_FAILED', operationCode: 't6_evaluate', caseId: 'X', message: 'cas critique en échec (scène)', structural: false }],
    }) as never);
    const { FakeProvider, setAiProvider, getAiProvider } = await import('@/services/ai/gateway/providers');
    avantProvider = getAiProvider();
    provider = new FakeProvider();
    provider.onAny(repondre as never);
    setAiProvider(provider);
  }, 300_000);

  afterAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    if (avantProvider) setAiProvider(avantProvider);
    (await import('@/services/ai/provider/provider-secret')).setProviderSecretResolver(null);
    delete process.env.CORPUS_ACCOUNT_ID;
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = ${env} AND status = 'ACTIVE'`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE', deleted_at = NULL WHERE id = ANY(${activeAvant})`;
    await sql`DELETE FROM ai_corpus_case_decisions WHERE reason = 'scène e2e l105b'`;
    await sql`DELETE FROM ai_corpus_oracle_approvals WHERE admin_label = 'e2e' AND case_id = ${CAS_T6}`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    (await import('@/services/ai/config/config-cache-version')).__setConfigVersionCounterStoreForTests(null);
    (await import('@/services/ai/provider/model-capabilities.repository')).invalidateModelCapabilities();
    (await import('@/services/ai/qualification/cases')).__setQualificationCorpusForTests(null);
    (await import('@/services/ai/qualification/context')).__resetQualificationContextForTests();
    (await import('@/services/ai/governance/master-corpus/certification/promotion')).__setPromotionLockForTests(null);
  });

  it('L105B-E01 — migration 0985 rejouable ; journal classé (diagnostic global, recette, restauration)', async () => {
    const cols = async (t: string) => (await sql<Json[]>`SELECT column_name FROM information_schema.columns WHERE table_name = ${t}`).map((r) => r.column_name);
    expect(await cols('ai_config_versions')).toContain('candidate_promotion');
    expect(await cols('ai_qualification_cases')).toContain('decisions');
    expect((await sql<Json[]>`SELECT to_regclass('ai_promotion_events') AS t`)[0].t).toBe('ai_promotion_events');
    await sql.begin(async (tx) => { await tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/0985_l105b_promotion_ia.sql'), 'utf8')); });
    const def = async (c: string) => (await sql<Json[]>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = ${c}`)[0].d as string;
    expect(await def('ai_config_versions_candidate_state_chk')).toMatch(/BLOCKED_A1/);
    expect(await def('ai_qualification_campaigns_kind_chk')).toMatch(/POST_CHECK/);
    const { DIAG_TABLE_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
    const { RECETTE_EXCLUDED } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const { RESTORE_KEEP_CURRENT_TABLES } = await import('@/services/backup/schema-signature');
    expect(DIAG_TABLE_COVERAGE.ai_promotion_events?.transversal).toBeTruthy();
    expect(RECETTE_EXCLUDED.ai_promotion_events).toMatch(/qualification IA/);
    expect(RESTORE_KEEP_CURRENT_TABLES).toContain('ai_promotion_events');
  });

  it('L105B-E02 (R3) — qualifiée MÉTIER, verrou A1 fermé : BLOCKED_A1, jamais QUALIFIED activable ni REFUSED ; preuves séparées', async () => {
    comportement.set('gemini-3.5-flash', { mode: 'GOOD', delayMs: 400 });
    comportement.set('gemini-3.1-flash-lite', { mode: 'GOOD', delayMs: 5 });
    a1 = 'STRUCTUREL';
    const avant = await actif();
    const r = await campagne(['gemini-3.1-flash-lite']);
    const [c] = await sql<Json[]>`SELECT status, summary, candidate_version_id FROM ai_qualification_campaigns WHERE id = ${r.campaignId}`;
    expect(c.status).toBe('COMPLETED');
    candidate = Number(c.candidate_version_id);
    const v = await version(candidate);
    expect(v).toMatchObject({ status: 'INACTIVE', candidate_state: 'BLOCKED_A1' });
    expect(v.candidate_reason).toMatch(/Qualification métier réussie.*verrou A1.*pas un refus métier/);
    expect(v.candidate_promotion.qualification).toMatchObject({ state: 'QUALIFIED', treatment: 'T6', campaignId: Number(r.campaignId) });
    expect(v.candidate_promotion.qualification.evidenceIds).toHaveLength(2);
    expect(v.candidate_promotion.a1).toMatchObject({ allowed: false, structural: 1, contextFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((c.summary.candidates as Json[])[0]).toMatchObject({ state: 'BLOCKED_A1' });
    expect(c.summary.activatedVersionId).toBeNull();
    expect(await actif()).toBe(avant);
    expect(await evenements('A1_BLOCKED', candidate)).toHaveLength(1);
    expect(await evenements('ACTIVATION_GATE', candidate)).toHaveLength(0);
    // Preuves conservées : admissibles, décisions des cas persistées.
    const ev = await sql<Json[]>`SELECT verdict FROM ai_qualification_evidence WHERE campaign_id = ${r.campaignId} AND config_version_id = ${candidate}`;
    expect(ev.map((e) => e.verdict)).toEqual(['ADMISSIBLE', 'ADMISSIBLE']);
  });

  it('L105B-E03 (R3) — cause inchangée : aucune relance, aucun appel, aucune version créée', async () => {
    const versions = Number((await sql`SELECT count(*)::int AS n FROM ai_config_versions WHERE origin = 'auto'`)[0].n);
    appels.length = 0;
    const r = await campagne(['gemini-3.1-flash-lite']);
    const [c] = await sql<Json[]>`SELECT summary FROM ai_qualification_campaigns WHERE id = ${r.campaignId}`;
    expect(c.summary.note).toMatch(/rien à qualifier/);
    expect(appels).toHaveLength(0);
    expect(Number((await sql`SELECT count(*)::int AS n FROM ai_config_versions WHERE origin = 'auto'`)[0].n)).toBe(versions);
    expect((await version(candidate)).candidate_state).toBe('BLOCKED_A1');
  });

  it('L105B-E04 (R3) — certification changée, manques structurels restants : en attente, aucun appel, idempotent', async () => {
    await decision('REJETEE');
    appels.length = 0;
    await campagne(['gemini-3.1-flash-lite']);
    expect(appels).toHaveLength(0);
    expect((await version(candidate)).candidate_state).toBe('BLOCKED_A1');
    expect((await version(candidate)).candidate_promotion.relaunch).toMatchObject({ lastCheckedFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await evenements('A1_WAITING', candidate)).toHaveLength(1);
    await campagne(['gemini-3.1-flash-lite']);
    expect(appels).toHaveLength(0);
    expect(await evenements('A1_WAITING', candidate)).toHaveLength(1);
  });

  it('L105B-E05 (R3) — certification complétée : relance automatique de la MÊME candidate, revalidée depuis la base, activée, surveillée', async () => {
    a1 = 'LEVE';
    // Rétablir le cas seul ramène EXACTEMENT le contexte du blocage : aucune relance (cause inchangée).
    await decision('RETABLIE');
    appels.length = 0;
    await campagne(['gemini-3.1-flash-lite']);
    expect(appels).toHaveLength(0);
    expect((await version(candidate)).candidate_state).toBe('BLOCKED_A1');
    // Référence APPROUVÉE (geste humain individuel sur sources, empreinte exacte de l'oracle) : contexte A1 nouveau.
    const { loadCorpusManifest } = await import('@/services/ai/governance/master-corpus/certification/manifest');
    const { oracleFingerprint } = await import('@/services/ai/governance/master-corpus/certification/oracle');
    const e = loadCorpusManifest().entries.find((x) => x.id === CAS_T6)!;
    await sql`INSERT INTO ai_corpus_oracle_approvals (case_id, manifest_version, oracle_version, oracle_fingerprint, decision, sources, admin_user_id, admin_label)
              VALUES (${CAS_T6}, 1, ${e.oracle!.version}, ${oracleFingerprint(e.oracle)!}, 'APPROVED', '["contexte du cas"]'::jsonb, ${adminId}, 'e2e')`;
    appels.length = 0;
    const avant = await actif();
    const r = await campagne(['gemini-3.1-flash-lite']);
    expect(appels.length).toBeGreaterThan(0);
    const [c] = await sql<Json[]>`SELECT summary, candidate_version_id FROM ai_qualification_campaigns WHERE id = ${r.campaignId}`;
    expect(Number(c.candidate_version_id)).toBe(candidate);
    expect(c.summary.activatedVersionId).toBe(candidate);
    const v = await version(candidate);
    expect(v).toMatchObject({ status: 'ACTIVE', candidate_state: 'ACTIVATED' });
    expect(Number(v.candidate_campaign_id)).toBe(Number(r.campaignId));
    expect(v.candidate_promotion.relaunch).toMatchObject({ count: 1, campaignId: Number(r.campaignId) });
    expect(v.candidate_promotion.watch).toMatchObject({ status: 'WATCHING', previousVersionId: avant, treatment: 'T6' });
    // Même modèle (aucune modification artificielle).
    const [cfg] = await sql<Json[]>`SELECT r.snapshot FROM ai_config_versions v JOIN ai_config_revisions r ON r.id = v.current_revision_id WHERE v.id = ${candidate}`;
    expect((cfg.snapshot.entries as Json[]).find((e) => e.treatment === 'T6')!.primaryModel).toBe('gemini-3.1-flash-lite');
    expect(await evenements('A1_RELAUNCH', candidate)).toHaveLength(1);
    const gate = await evenements('ACTIVATION_GATE', candidate);
    expect(gate.at(-1)).toMatchObject({ allowed: true, code: null });
    expect(gate.at(-1)!.reference).toMatchObject({ candidateVersionId: candidate, campaignId: Number(r.campaignId), treatment: 'T6', activeVersionId: avant });
    expect(gate.at(-1)!.reference.evidence).toHaveLength(2);
    // Lot 113I (PRO-03..05) : promotion CIBLÉE journalisée, état antérieur de T6 et surveillance persistés dans le même commit.
    expect(await evenements('TARGETED_PROMOTION', candidate)).toHaveLength(1);
    expect(v.candidate_promotion.targeted).toMatchObject({ treatment: 'T6', globalActiveBefore: { versionId: avant } });
    expect(v.candidate_promotion.targeted.previous.entry.primaryModel).toBe('gemini-3.5-flash');
  });

  it('L105B-E06 (R8) — surveillance : sans preuve aucun retour arrière ; régression certifiée imputable → retour arrière atomique et journalisé', async () => {
    const { runPromotionWatch } = await import('@/services/ai/qualification/promotion-watch');
    const w0 = (await version(candidate)).candidate_promotion.watch;
    const t0 = Date.parse(w0.activatedAt);
    // 1 h après : aucun appel attribué, rejeu pas encore dû → données insuffisantes, aucun retour arrière.
    const r1 = await runPromotionWatch({ trigger: 'e2e', skipLease: true, now: () => new Date(t0 + 3_600_000), campaign: deps() });
    expect(r1).toMatchObject({ watched: 1, rolledBack: 0, replays: 0 });
    expect(await actif()).toBe(candidate);
    expect((await version(candidate)).candidate_promotion.watch).toMatchObject({ status: 'WATCHING', lastVerdict: 'INSUFFICIENT_DATA' });
    // Lot 113I (CDC V2 MON-06) — RÈGLE DÉLIBÉRÉMENT CHANGÉE : aucun rejeu payant « parce que 12 h sont passées ». Sans
    // suspicion, 13 h après : aucun rejeu, aucun retour arrière (les 72 h ne sont qu'un jalon).
    const r13 = await runPromotionWatch({ trigger: 'e2e', skipLease: true, now: () => new Date(t0 + 13 * 3_600_000), campaign: deps() });
    expect(r13).toMatchObject({ replays: 0, rolledBack: 0 });
    // Suspicion née de l'usage : une sortie refusée par les contrôles serveur sous la candidate (sous le seuil de conclusion).
    const [tech1] = await sql<Json[]>`SELECT id FROM accounts ORDER BY id LIMIT 1`;
    await sql`INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, status, error_code, config_version_id, environment, created_at, metadata)
              VALUES (${tech1?.id ?? null}, 't6_formulate', 't6_formulate', 'gemini', 'gemini-3.1-flash-lite', 'error', 'INVALID_OUTPUT', ${candidate}, ${env}, ${new Date(t0 + 14 * 3_600_000).toISOString()}::timestamptz, '{}'::jsonb)`;
    // Rejeu des cas certifiés sur suspicion ; la candidate rend désormais des sorties fausses, l'ancienne version reste juste.
    comportement.set('gemini-3.1-flash-lite', { mode: 'BAD', delayMs: 5 });
    const r2 = await runPromotionWatch({ trigger: 'e2e', skipLease: true, now: () => new Date(t0 + 15 * 3_600_000), campaign: deps() });
    expect(r2).toMatchObject({ replays: 1, rolledBack: 1 });
    // Lot 113I (SQL-007/008) : retour arrière CIBLÉ — la configuration active reste la version globale courante, seule
    // la part T6 revient à son état antérieur (nouvelle révision « restore ») ; aucune ancienne version réactivée.
    expect(await actif()).toBe(candidate);
    const [snap] = await sql<Json[]>`SELECT r.snapshot, r.kind FROM ai_config_versions v JOIN ai_config_revisions r ON r.id = v.current_revision_id WHERE v.id = ${candidate}`;
    expect(snap.kind).toBe('restore');
    expect((snap.snapshot.entries as Json[]).find((e) => e.treatment === 'T6')!.primaryModel).toBe('gemini-3.5-flash');
    const v = await version(candidate);
    expect(v).toMatchObject({ status: 'ACTIVE', candidate_state: 'SUSPENDED' });
    expect(v.candidate_promotion.watch).toMatchObject({ status: 'ROLLED_BACK', replays: 1 });
    const [pc] = await sql<Json[]>`SELECT id, status FROM ai_qualification_campaigns WHERE kind = 'POST_CHECK' ORDER BY id DESC LIMIT 1`;
    expect(pc.status).toBe('COMPLETED');
    const post = await evenements('POST_CHECK', candidate);
    expect(post.at(-1)).toMatchObject({ code: 'DEGRADED_IMPUTABLE', allowed: false });
    expect(post.at(-1)!.message).toMatch(/régression\(s\) certifiée\(s\)/);
    expect(await evenements('TARGETED_ROLLBACK', candidate)).toHaveLength(1);
    const { collectAiConditions } = await import('@/services/admin/supervision-sweep.service');
    expect((await collectAiConditions()).some((x) => x.fingerprint === `ai:promotion:rollback:${candidate}`)).toBe(true);
    // Surveillance terminée : un nouveau passage ne refait rien.
    const r3 = await runPromotionWatch({ trigger: 'e2e', skipLease: true, now: () => new Date(t0 + 16 * 3_600_000), campaign: deps() });
    expect(r3.watched).toBe(0);
    comportement.set('gemini-3.1-flash-lite', { mode: 'GOOD', delayMs: 5 });
  });

  it('L105B-E07 (R5) — frontière d’activation : forgé, autre campagne / candidate, révoqué, obsolète, expiré, refusé, gel, concurrent → refus journalisés ; valide → activée', async () => {
    const svc = await import('@/services/ai/config/config-version.service');
    const cfg = await import('@/services/ai/config/config-version.repository');
    const gate = await import('@/services/ai/qualification/promotion-gate');
    const ivs = await import('@/services/ai/config/config-interventions.service');
    // Candidate qualifiée avec preuves réelles ; gel posé : l'activation est refusée (choix humain respecté).
    comportement.set('gemini-3.6-flash', { mode: 'GOOD', delayMs: 5 });
    a1 = 'LEVE';
    const gel = await ivs.createFreeze({ treatment: 'T6', reason: 'gel e2e l105b' }, adminId);
    const r = await campagne(['gemini-3.6-flash']);
    const [c] = await sql<Json[]>`SELECT candidate_version_id FROM ai_qualification_campaigns WHERE id = ${r.campaignId}`;
    const cand = Number(c.candidate_version_id);
    expect((await version(cand)).candidate_state).toBe('INCONCLUSIVE');
    expect((await version(cand)).candidate_reason).toMatch(/^ACTIVATION_REFUSED:.*FROZEN/);
    expect((await evenements('ACTIVATION_GATE', cand)).at(-1)).toMatchObject({ allowed: false, code: 'FROZEN' });
    await ivs.liftIntervention(gel.intervention.id, adminId);
    // État qualifié restauré pour la recette de la frontière ; réclamation authentique reconstruite du journal A1.
    await sql`UPDATE ai_config_versions SET candidate_state = 'QUALIFIED' WHERE id = ${cand}`;
    const [row] = await sql<Json[]>`SELECT * FROM ai_corpus_a1_assessments WHERE candidate_version_id = ${cand} ORDER BY id DESC LIMIT 1`;
    const token = { allowed: true, rulesVersion: row.rules_version, assessmentId: Number(row.id), at: new Date().toISOString(), campaignId: Number(r.campaignId), candidateVersionId: cand, treatments: ['T6'], context: 'AUTO_CANDIDATE', contextFingerprint: row.summary.contextFingerprint };
    const refus = async (claim: unknown) => {
      const e = await svc.activateQualifiedCandidate(cand, { a1: claim }).then(() => null, (x) => x);
      expect(e?.code).toBe('PROMOTION_REVALIDATION_REFUSED');
      return e.details.gateCode as string;
    };
    expect(await refus({ allowed: true, rulesVersion: 'a1-v2' })).toBe('CLAIM_MALFORMED');
    expect(await refus({ ...token, campaignId: token.campaignId + 999 })).toBe('CAMPAIGN_MISMATCH');
    expect(await refus({ ...token, candidateVersionId: candidate })).toBe('CANDIDATE_MISMATCH');
    expect(await refus({ ...token, treatments: ['T3'] })).toBe('TREATMENT_MISMATCH');
    expect(await refus({ ...token, contextFingerprint: '0'.repeat(64) })).toBe('A1_ASSESSMENT_MISMATCH');
    // Approbation révoquée / cas rejeté après la décision A1 : preuve A1 plus courante.
    await decision('REJETEE');
    expect(await refus(token)).toBe('A1_CONTEXT_CHANGED');
    await decision('RETABLIE');
    // Preuve obsolète (signature différente de la configuration courante).
    const [ev] = await sql<Json[]>`SELECT id, signature FROM ai_qualification_evidence WHERE campaign_id = ${r.campaignId} AND config_version_id = ${cand} ORDER BY id LIMIT 1`;
    await sql`UPDATE ai_qualification_evidence SET signature = 'obsolete' WHERE id = ${ev.id}`;
    expect(await refus(token)).toBe('EVIDENCE_STALE');
    await sql`UPDATE ai_qualification_evidence SET signature = ${ev.signature} WHERE id = ${ev.id}`;
    // Décision A1 trop ancienne.
    await sql`UPDATE ai_corpus_a1_assessments SET created_at = now() - interval '7 hours' WHERE id = ${row.id}`;
    expect(await refus(token)).toBe('A1_EXPIRED');
    await sql`UPDATE ai_corpus_a1_assessments SET created_at = now() WHERE id = ${row.id}`;
    // Verrou recalculé refusé.
    a1 = 'RESULTATS';
    expect(await refus(token)).toBe('A1_NOW_REFUSED');
    a1 = 'LEVE';
    // Changement CONCURRENT entre la revalidation et la transaction : certification, puis configuration active.
    // Lot 113I : la transaction est la PROMOTION CIBLÉE (`promoteTreatment`), jamais l'activation de l'instantané complet.
    const d1 = await gate.revalidatePromotion({ versionId: cand, claim: token });
    expect(d1.ok).toBe(true);
    await decision('REJETEE', 'H-P-T6-EV-01-DECISION-VALIDE');
    await expect(cfg.promoteTreatment(cand, { guard: gate.transactionGuard(d1.reference), watch: () => ({}) })).rejects.toMatchObject({ gateCode: 'CONCURRENT_CHANGE' });
    await decision('RETABLIE', 'H-P-T6-EV-01-DECISION-VALIDE');
    const d2 = await gate.revalidatePromotion({ versionId: cand, claim: token });
    expect(d2.ok).toBe(true);
    // Lot 113I (CDC V2 PRO-04, LIF-011, REC-064/065) — RÈGLE DÉLIBÉRÉMENT CHANGÉE : une activation concurrente ne bloque
    // que si elle CHANGE le traitement ciblé (l'humain gagne : CANDIDATE_STALE) ; un changement d'un autre traitement
    // est conservé par la fusion ciblée (scénario 113I dédié).
    const autre = await svc.createConfigVersion(adminId, { label: 'e2e-l105b activation concurrente' });
    const t6Autre = autre.entries.filter((e) => e.treatment === 'T6').map((e) => ({ ...e, primaryModel: 'gemini-3.5-flash', fallback1: null, reasoningFallback1: null, operationProfiles: {} }));
    await svc.saveConfiguration(autre.id, { expectedRevision: autre.currentRevisionNumber, entries: t6Autre }, adminId);
    await svc.activate(autre.id, adminId);
    await expect(cfg.promoteTreatment(cand, { guard: gate.transactionGuard(d2.reference), watch: () => ({}) })).rejects.toMatchObject({ code: 'CANDIDATE_STALE' });
    await svc.activate(baseVersionId, adminId);
    expect((await version(cand))).toMatchObject({ status: 'INACTIVE', candidate_state: 'QUALIFIED' });
    // Refus journalisés avec la version de référence.
    const refusJ = (await evenements('ACTIVATION_GATE', cand)).filter((e) => e.allowed === false).map((e) => e.code);
    expect(refusJ).toEqual(expect.arrayContaining(['FROZEN', 'CLAIM_MALFORMED', 'CAMPAIGN_MISMATCH', 'CANDIDATE_MISMATCH', 'A1_CONTEXT_CHANGED', 'EVIDENCE_STALE', 'A1_EXPIRED', 'A1_NOW_REFUSED']));
    const j = (await evenements('ACTIVATION_GATE', cand)).find((e) => e.code === 'A1_CONTEXT_CHANGED')!;
    expect(j.reference).toMatchObject({ environment: env, candidateVersionId: cand, campaignId: Number(r.campaignId), assessmentId: Number(row.id), rulesVersion: 'test' });
    // Réclamation valide, contexte stable : activation.
    const ok = await svc.activateQualifiedCandidate(cand, { a1: token });
    expect(ok.previousId).toBe(baseVersionId);
    expect(await version(cand)).toMatchObject({ status: 'ACTIVE', candidate_state: 'ACTIVATED' });
  });

  it('L105B-E08 (§5, R9) — BO / diagnostic : état réel (a)…(e), P2 différé ; production : rien d’automatique', async () => {
    const { NextRequest } = await import('next/server');
    const route = await import('@/app/api/admin/ai/promotion/route');
    const res = await route.GET(new NextRequest('http://app.test/api/admin/ai/promotion') as never);
    expect(res.status).toBe(200);
    const b = await res.json() as Json;
    expect(b.scheduler.map((x: Json) => x.code)).toEqual(['ai-catalog-sync', 'ai-qualification-campaign', 'ai-prompt-conformity', 'ai-promotion-watch']);
    expect(b.executions.concludedCases).toBeGreaterThan(0);
    expect(b.executions.technicalAccount).toMatchObject({ ok: true });
    expect(b.candidates).toMatchObject({ rolledBack: 1, suspended: 1 });
    expect(b.candidates.activated).toBeGreaterThanOrEqual(2);
    expect(b.coverage.map((x: Json) => x.treatment)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(b.inventory).toMatchObject({ zipReceived: false, expected: { historical: 86, toRevalidate: 20, newScenarios: 295, stress: 15, pairs: 110 } });
    expect(b.health.code).toBe('AUTOMATIC_PROGRESS');
    expect(b.deferred.length).toBe(2);
    expect(b.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(b)).not.toMatch(/password|secret|api[_-]?key|cle-e2e/i);
    session.role = 'USER';
    try { expect((await route.GET(new NextRequest('http://app.test/api/admin/ai/promotion') as never)).status).toBe(401); } finally { session.role = 'ADMIN'; }
    // Production : jamais « automatique », surveillance sans objet, aucune campagne.
    const { promotionStatus } = await import('@/services/ai/qualification/promotion-status');
    expect((await promotionStatus({ environment: 'production' })).health).toMatchObject({ code: 'PRODUCTION_MANUAL', automatic: false });
    const { runPromotionWatch } = await import('@/services/ai/qualification/promotion-watch');
    expect((await runPromotionWatch({ trigger: 'e2e', environment: 'production', skipLease: true })).skipped).toMatch(/production/);
    const { requestAutomaticCampaign } = await import('@/services/ai/qualification/campaign');
    expect((await requestAutomaticCampaign({ trigger: 'e2e' }, deps({ environment: 'production' }))).campaignId).toBeNull();
    // Tâche planifiée déclarée ; diagnostic global : même lecture.
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    expect(SCHEDULED_TASKS.some((t) => t.code === 'ai-promotion-watch')).toBe(true);
  });
});
