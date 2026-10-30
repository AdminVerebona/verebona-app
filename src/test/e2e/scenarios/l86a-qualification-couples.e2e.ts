/**
 * Lot 86A sur PostgreSQL 16 réel — CDC Pilotage IA V2, phase P5
 * « qualification par couple et candidates automatiques (préproduction) »
 * (QUAL-01..09, OPT-01/02, DEC-01/02, ACT-01/02, VER-01, MIG-02, R04-R07,
 * R12, R13, R32, R44, R47-R50 ; décisions PO 06, 13, 14). Migrations 0724,
 * 0725, 0726. Fournisseur SIMULÉ (aucun réseau) : chaque cas du corpus
 * reçoit la sortie enregistrée de sa fixture (couple « bon »), une autre
 * sortie (couple « mauvais ») ou une panne transitoire.
 *
 *   L86A-E01  test manuel d'un couple depuis le BO : point de restauration pris
 *             AVANT tout appel ; passerelle de production, révision épinglée,
 *             rang forcé ; preuve ADMISSIBLE historisée (modèle servi, profil,
 *             empreintes, environnement, date) ; état « admissible » au BO ;
 *             appels techniques, aucun effet externe (notification, e-mail,
 *             travail de file, exécution métier)
 *   L86A-E02  couple REFUSÉ (erreur métier confirmée) ; mesuré contre la
 *             référence sur les mêmes cas ; un secours ne qualifie jamais
 *   L86A-E03  couple NON CONCLUANT : erreur fournisseur transitoire, un nouvel
 *             essai puis non concluant (jamais réussite ni faute métier)
 *   L86A-E04  invalidation par signature : capacités du modèle changées →
 *             preuve OBSOLÈTE (BO et `listQualificationEvidence`) ; profil
 *             d'opération changé → obsolète ; choix manuel « non testé »
 *   L86A-E05  point de restauration impossible → campagne REFUSÉE, aucun appel
 *   L86A-E06  production : aucune campagne, candidate JAMAIS activée
 *             automatiquement (même qualifiée) ; active inchangée
 *   L86A-E07  campagne automatique : candidate refusée (active intacte, preuves
 *             conservées), puis candidate qualifiée avec gain établi, NON
 *             ACTIVE pendant ses tests, activée en préproduction ; passage
 *             suivant sans événement : rien n'est lancé (R46)
 *   L86A-E08  rejeu des données existantes (capture 82C) : verrou par compte,
 *             compte occupé écarté, comparaison à l'historique ; campagne
 *             interrompue → INTERROMPUE, verrous libérés (R13) ; concurrence
 *             mesurée (2 par traitement en file, 3 pour T2 / T6)
 *   L86A-E09  tables classées (export de recette, conservées à la restauration) ;
 *             migrations rejouables (idempotence) ; routes BO réservées aux
 *             administrateurs
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l86a@e2e.test', role: 'ADMIN' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => { if (session.role !== 'ADMIN') throw Object.assign(new Error('forbidden'), { status: 403 }); return session.adminId; },
    getSession: async () => ({ userId: session.adminId, email: session.email, role: session.role }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const CLE = 'cle-e2e-l86a';
type ApiModel = { name: string; outputTokenLimit?: number; thinking?: boolean };
const MODELES: ApiModel[] = [
  { name: 'gemini-3.5-flash' }, { name: 'gemini-2.5-flash' }, { name: 'gemini-2.5-pro' }, { name: 'gemini-3.1-flash-lite' }, { name: 'gemini-3.6-flash' },
].map((m) => ({ outputTokenLimit: 65_536, thinking: true, ...m }));
const listing = (models: ApiModel[]) => ({
  models: models.map((m) => ({
    name: `models/${m.name}`, supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576,
    outputTokenLimit: m.outputTokenLimit, thinking: m.thinking, temperature: 1, maxTemperature: 2,
  })),
});
const fetcherDe = (models: ApiModel[]) => (async () => new Response(JSON.stringify(listing(models)), { status: 200 })) as unknown as typeof fetch;

scenario('L86A', 'Qualification par couple et candidates automatiques (Pilotage IA V2 P5)', ({ sql, make }) => {
  let adminId = 0;
  let env = 'local';
  let activeAvant: number[] = [];
  let techAccount = 0;
  let baseVersionId = 0;
  const restorePoints: string[] = [];
  const takeRestorePoint = async (label: string) => { restorePoints.push(label); return { backupId: `rp-${restorePoints.length}`, finishedAt: new Date().toISOString() }; };
  /** Cas du corpus et leur jeton distinctif, par opération. */
  const casDe = new Map<string, Array<{ key: string; output: unknown; id: string }>>();
  /**
   * Le fournisseur simulé reconnaît le cas par le contexte d'exécution de
   * l'appel (plomberie de TEST : la passerelle de production s'exécute
   * telle quelle, seul le fournisseur est simulé).
   */
  const casCourant = new AsyncLocalStorage<{ op: string; key: string }>();
  /** Comportement du fournisseur simulé, par modèle. */
  const comportement = new Map<string, { mode: 'GOOD' | 'BAD' | 'TRANSIENT'; delayMs: number }>();
  const appels: Array<{ model: string; prompt: string }> = [];
  const pendantCandidate: number[] = [];
  let provider: import('@/services/ai/gateway/providers').FakeProvider;
  let avantProvider: import('@/services/ai/gateway/providers/provider.port').AiProvider;

  /**
   * Corpus de la scène : les cas réels du dépôt, avec le RÔLE que l'équipe IA
   * déclarera (`qualification.role`) — réponses de référence pour T3
   * LINK_AMBIGUITY, P-T6-01 et P-T6-EV-01 ; tests de garde pour les autres
   * cas T6 (sortie enregistrée délibérément fautive). Même corpus pour la
   * campagne et pour la lecture BO.
   */
  const REPONSES = new Set(['P-T6-01', 'P-T6-EV-01']);
  async function preparerCorpus() {
    const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { liveVariablesFor } = await import('@/services/ai/governance/master-corpus/live');
    const { canonicalJson } = await import('@/services/ai/qualification/signature');
    const corpus = loadMasterCorpusCases(readMasterFileFromRepo).map((c) => ({
      ...c,
      qualificationRole: c.operationCode === 't3_link_ambiguity' || REPONSES.has(c.id) ? 'answer' as const : c.operationCode.startsWith('t6_') ? 'guard' as const : null,
    }));
    (await import('@/services/ai/qualification/cases')).__setQualificationCorpusForTests(corpus);
    (await import('@/services/ai/qualification/context')).__resetQualificationContextForTests();
    for (const op of ['t3_link_ambiguity', 't6_formulate', 't6_evaluate']) {
      const l: Array<{ key: string; output: unknown; id: string }> = [];
      for (const c of corpus.filter((x) => x.operationCode === op && x.qualificationRole === 'answer')) {
        const v = await liveVariablesFor(c);
        if (v) l.push({ key: canonicalJson(v), output: c.output, id: c.id });
      }
      casDe.set(op, l);
    }
  }
  const repondre = async (input: { model: string; prompt: string }) => {
    appels.push({ model: input.model, prompt: input.prompt });
    const b = comportement.get(input.model) ?? { mode: 'GOOD', delayMs: 20 };
    if (input.model === 'gemini-3.1-flash-lite') {
      pendantCandidate.push(...(await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id)));
    }
    await new Promise((r) => setTimeout(r, b.delayMs));
    if (b.mode === 'TRANSIENT') throw Object.assign(new Error('503 UNAVAILABLE : service momentanément indisponible'), { status: 503 });
    const cur = casCourant.getStore();
    const liste = cur ? casDe.get(cur.op) ?? [] : [];
    const i = liste.findIndex((c) => c.key === cur?.key);
    if (i < 0) throw Object.assign(new Error('400 INVALID_ARGUMENT : cas inconnu du fournisseur simulé'), { status: 400 });
    // Couple « mauvais » : la sortie d'un AUTRE cas de la même opération (format valide, contenu faux).
    // Seul cas de son opération : la sortie d'un cas d'une AUTRE opération (non conforme au contrat).
    const autre = [...casDe.entries()].find(([op]) => op !== cur?.op)?.[1][0];
    const sortie = b.mode !== 'BAD' ? liste[i].output : liste.length > 1 ? liste[(i + 1) % liste.length].output : autre?.output;
    return { rawText: JSON.stringify(sortie), inputTokens: 10, outputTokens: 5 };
  };

  async function get(path: string, mod: Promise<{ GET: (r: never, x?: never) => Promise<Response> }>, params?: Record<string, string>) {
    const { NextRequest } = await import('next/server');
    const res = await (await mod).GET(new NextRequest(`http://app.test${path}`) as never, (params ? { params: Promise.resolve(params) } : undefined) as never);
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
  }
  const overview = (q = '') => get(`/api/admin/ai/qualification${q}`, import('@/app/api/admin/ai/qualification/route') as never);
  /** Passerelle de PRODUCTION ; le cas courant est porté par le contexte asynchrone pour le seul fournisseur simulé. */
  const call = async (req: { operationCode: string; promptVariables: Record<string, unknown> }, ctx: unknown) => {
    const { productionGatewayCall } = await import('@/services/ai/qualification/runner');
    const { canonicalJson } = await import('@/services/ai/qualification/signature');
    return casCourant.run({ op: req.operationCode, key: canonicalJson(req.promptVariables) }, () => productionGatewayCall(req as never, ctx as never));
  };
  const deps = (o: Record<string, unknown> = {}) => ({ takeRestorePoint, technicalAccountId: techAccount, await: true, accounts: async () => [] as number[], call, ...o });
  const couple = (body: Record<string, any>, op: string, rank: number) => (body.couples as any[]).find((c) => c.operationCode === op && c.rank === rank);

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN' });
    adminId = admin.id;
    session.adminId = admin.id;
    const tech = await make.account();
    techAccount = tech.id;
    process.env.CORPUS_ACCOUNT_ID = String(techAccount);
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_capability_changes', 'ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    env = (await import('@/services/ai/config/environment')).getAiEnvironment();
    activeAvant = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`).map((r) => Number(r.id));
    // Catalogue (API Models simulée) et qualification technique : modèles utilisables.
    const { syncAiCatalog } = await import('@/services/ai/provider/ai-catalog-sync.service');
    const qualif = async (i: { responseSchema?: unknown; attachments: unknown[] }) => ({ rawText: i.responseSchema ? '{"ok":true,"mot":"verebona"}' : i.attachments.length ? 'Rouge' : 'OK', inputTokens: 4, outputTokens: 2 });
    const r = await syncAiCatalog({ trigger: 'schedule' }, {
      fetcher: fetcherDe(MODELES), qualificationCall: qualif as never, probeCall: async () => ({ rawText: 'OK' }), maxQualifications: 50,
      pricing: { fetchPage: async () => { throw new Error('hors ligne'); }, billing: null }, raiseAlert: async () => false,
    });
    expect(r.ok).toBe(true);
    // Configuration de référence : T3 et T6 sur gemini-3.5-flash (repli gemini-2.5-flash).
    const svc = await import('@/services/ai/config/config-version.service');
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l86a référence' });
    const entries = v.entries.filter((e) => e.treatment === 'T3' || e.treatment === 'T6').map((e) => ({
      ...e, primaryModel: 'gemini-3.5-flash', reasoningPrimary: null, fallback1: 'gemini-2.5-flash', reasoningFallback1: null, fallback2: null, reasoningFallback2: null, operationProfiles: {},
    }));
    await svc.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, entries }, adminId);
    await svc.activate(v.id, adminId);
    baseVersionId = v.id;
    await preparerCorpus();
    // Lot 100B : le verrou A1 (couverture du corpus #601) est recetté par l100b-corpus-certification ; ici, verrou levé.
    (await import('@/services/ai/governance/master-corpus/certification/promotion')).__setPromotionLockForTests((await import('@/services/ai/governance/master-corpus/certification/promotion')).OPEN_LOCK_FOR_TESTS);
    const { FakeProvider, setAiProvider, getAiProvider } = await import('@/services/ai/gateway/providers');
    avantProvider = getAiProvider();
    provider = new FakeProvider();
    provider.onAny(repondre as never);
    setAiProvider(provider);
  });

  afterAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    if (avantProvider) setAiProvider(avantProvider);
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(null);
    delete process.env.CORPUS_ACCOUNT_ID;
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = ${env} AND status = 'ACTIVE'`;
    if (activeAvant.length) await sql`UPDATE ai_config_versions SET status = 'ACTIVE', deleted_at = NULL WHERE id = ANY(${activeAvant})`;
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    const { __setConfigVersionCounterStoreForTests } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(null);
    for (const t of ['ai_model_capability_changes', 'ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    (await import('@/services/ai/provider/model-capabilities.repository')).invalidateModelCapabilities();
    (await import('@/services/ai/qualification/cases')).__setQualificationCorpusForTests(null);
    (await import('@/services/ai/qualification/context')).__resetQualificationContextForTests();
    (await import('@/services/ai/governance/master-corpus/certification/promotion')).__setPromotionLockForTests(null);
  });

  let evidenceE01 = 0;

  it('L86A-E01 — test manuel d’un couple : point de restauration, passerelle de production, preuve ADMISSIBLE, aucun effet externe', async () => {
    const avant = {
      notif: Number((await sql`SELECT count(*)::int AS n FROM notifications`)[0].n),
      outbox: Number((await sql`SELECT count(*)::int AS n FROM notification_outbox`)[0].n),
      mails: Number((await sql`SELECT count(*)::int AS n FROM email_logs`)[0].n),
      jobs: Number((await sql`SELECT count(*)::int AS n FROM ai_job_queue`)[0].n),
    };
    // Avant tout test : choix manuel « non testé » (MIG-02, aucune qualification fictive).
    const o0 = await overview();
    expect(o0.status).toBe(200);
    expect(couple(o0.body, 't3_link_ambiguity', 0)).toMatchObject({ model: 'gemini-3.5-flash', state: 'NEVER_TESTED', choiceLabel: 'Choix manuel · non testé' });
    expect(o0.body.thresholds).toMatchObject({ version: 'qualif-seuils-v1', source: 'code', latency: { maxDegradationPercent: 20 } });

    const { requestManualCoupleTest } = await import('@/services/ai/qualification/campaign');
    appels.length = 0;
    const { campaignId } = await requestManualCoupleTest({ adminUserId: adminId, reason: 'e2e', couple: { treatment: 'T3', operationCode: 't3_link_ambiguity', rank: 0 } }, deps());
    const [c] = await sql<any[]>`SELECT * FROM ai_qualification_campaigns WHERE id = ${campaignId}`;
    expect(c).toMatchObject({ kind: 'MANUAL', status: 'COMPLETED', restore_point_id: expect.stringMatching(/^rp-/) });
    expect(restorePoints.at(-1)).toMatch(new RegExp(`campagne ${campaignId}`));
    const ev = await sql<any[]>`SELECT * FROM ai_qualification_evidence WHERE campaign_id = ${campaignId}`;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      operation_code: 't3_link_ambiguity', model: 'gemini-3.5-flash', served_model: 'gemini-3.5-flash', rank: 0, role: 'REFERENCE', verdict: 'ADMISSIBLE',
      environment: env, thresholds_version: 'qualif-seuils-v1', config_version_id: baseVersionId,
    });
    for (const k of ['signature', 'prompt_fingerprint', 'contract_fingerprint', 'corpus_fingerprint', 'evaluator_fingerprint', 'capabilities_sha256']) expect(ev[0][k], k).toMatch(/^[0-9a-f]{64}$/);
    expect(ev[0].profile).toMatchObject({ timeoutMs: 30_000, params: { temperature: 0 } });
    expect(ev[0].metrics.concurrency).toMatchObject({ mode: 'QUEUED', lost: 0, misattributed: 0 });
    expect(ev[0].metrics.concurrency.maxObserved).toBe(2);
    evidenceE01 = Number(ev[0].id);
    const cas = await sql<any[]>`SELECT * FROM ai_qualification_cases WHERE evidence_id = ${evidenceE01}`;
    expect(cas.length).toBe(casDe.get('t3_link_ambiguity')!.length);
    expect(cas.every((x) => x.outcome === 'PASSED' && x.source === 'CORPUS_FIXTURE' && x.expected_source === 'REFERENCE' && x.matches_historical === true)).toBe(true);
    // Un seul rang appelé (aucun secours), révision épinglée, appels TECHNIQUES.
    expect(new Set(appels.map((a) => a.model))).toEqual(new Set(['gemini-3.5-flash']));
    const traces = await sql<any[]>`SELECT metadata, business_execution_id, account_id FROM ai_usage_event WHERE metadata->>'traceId' = ANY(${cas.map((x) => x.trace_id)})`;
    expect(traces).toHaveLength(cas.length);
    expect(traces.every((t) => t.metadata.trigger === 'qualification' && t.business_execution_id === null && Number(t.account_id) === techAccount)).toBe(true);
    // Aucun effet externe ni travail de file.
    expect(Number((await sql`SELECT count(*)::int AS n FROM notifications`)[0].n)).toBe(avant.notif);
    expect(Number((await sql`SELECT count(*)::int AS n FROM notification_outbox`)[0].n)).toBe(avant.outbox);
    expect(Number((await sql`SELECT count(*)::int AS n FROM email_logs`)[0].n)).toBe(avant.mails);
    expect(Number((await sql`SELECT count(*)::int AS n FROM ai_job_queue`)[0].n)).toBe(avant.jobs);
    // BO : état « admissible », choix manuel qualifié ; détail de campagne.
    const o1 = await overview();
    expect(couple(o1.body, 't3_link_ambiguity', 0)).toMatchObject({ state: 'ADMISSIBLE', evidenceId: evidenceE01, choiceLabel: 'Choix manuel · qualifié' });
    const d = await get(`/api/admin/ai/qualification/campaigns/${campaignId}`, import('@/app/api/admin/ai/qualification/campaigns/[id]/route') as never, { id: String(campaignId) });
    expect(d.status).toBe(200);
    expect(d.body.evidence[0].cases[0]).toMatchObject({ outcome: 'PASSED', source: 'CORPUS_FIXTURE' });
    expect(JSON.stringify(d.body)).not.toMatch(/"output"|response_raw|prompt_text/);
  });

  it('L86A-E02 — couple REFUSÉ (erreur métier confirmée) mesuré contre la référence ; un secours ne qualifie jamais', async () => {
    comportement.set('gemini-2.5-flash', { mode: 'BAD', delayMs: 20 });
    const { requestManualCoupleTest } = await import('@/services/ai/qualification/campaign');
    const { campaignId } = await requestManualCoupleTest({ adminUserId: adminId, couple: { treatment: 'T3', operationCode: 't3_link_ambiguity', rank: 1 } }, deps());
    const ev = await sql<any[]>`SELECT * FROM ai_qualification_evidence WHERE campaign_id = ${campaignId} ORDER BY id`;
    const ref = ev.find((e) => e.role === 'REFERENCE')!;
    const cand = ev.find((e) => e.role === 'CANDIDATE')!;
    expect(ref).toMatchObject({ model: 'gemini-3.5-flash', rank: 0, verdict: 'ADMISSIBLE' });
    expect(cand).toMatchObject({ model: 'gemini-2.5-flash', rank: 1, verdict: 'REFUSED', reference_evidence_id: ref.id });
    expect((cand.reasons as any[]).find((r) => r.outcome === 'BLOCKING')).toMatchObject({ step: 'QUALITY', code: 'BUSINESS_DEFECTS' });
    const defauts = await sql<any[]>`SELECT defects FROM ai_qualification_cases WHERE evidence_id = ${cand.id} AND outcome = 'FAILED'`;
    expect(defauts.length).toBeGreaterThan(0);
    // Aucun appel du principal à la place du repli testé (maxModelAttempts 1, rang forcé) : chaque cas candidat servi par 2.5.
    const casCand = await sql<any[]>`SELECT served_model FROM ai_qualification_cases WHERE evidence_id = ${cand.id}`;
    expect(casCand.every((x) => x.served_model === 'gemini-2.5-flash' || x.served_model === null)).toBe(true);
    comportement.delete('gemini-2.5-flash');
  });

  it('L86A-E03 — couple NON CONCLUANT : erreur fournisseur transitoire, un nouvel essai puis non concluant', async () => {
    comportement.set('gemini-2.5-flash', { mode: 'TRANSIENT', delayMs: 5 });
    appels.length = 0;
    const { requestManualCoupleTest } = await import('@/services/ai/qualification/campaign');
    const { campaignId } = await requestManualCoupleTest({ adminUserId: adminId, couple: { treatment: 'T6', operationCode: 't6_formulate', rank: 1 } }, deps());
    const [cand] = await sql<any[]>`SELECT * FROM ai_qualification_evidence WHERE campaign_id = ${campaignId} AND role = 'CANDIDATE'`;
    expect(cand.verdict).toBe('INCONCLUSIVE');
    expect((cand.reasons as any[]).some((r) => r.outcome === 'BLOCKING')).toBe(false);
    const cas = await sql<any[]>`SELECT outcome, inconclusive_reason FROM ai_qualification_cases WHERE evidence_id = ${cand.id}`;
    expect(cas.every((x) => x.outcome === 'INCONCLUSIVE' && /transitoire/.test(x.inconclusive_reason))).toBe(true);
    // Un essai + UN nouvel essai par cas (aucune boucle) ; la passerelle peut réessayer en interne : au moins 2 appels par cas.
    expect(appels.filter((a) => a.model === 'gemini-2.5-flash').length).toBeGreaterThanOrEqual(2 * cas.length);
    // T6 synchrone : 3 appels simultanés initiaux pour la référence.
    const [ref] = await sql<any[]>`SELECT metrics FROM ai_qualification_evidence WHERE campaign_id = ${campaignId} AND role = 'REFERENCE'`;
    expect(ref.metrics.concurrency).toMatchObject({ mode: 'SYNCHRONOUS', target: 3, maxObserved: 3, lost: 0 });
    comportement.delete('gemini-2.5-flash');
  });

  it('L86A-E04 — invalidation par signature : capacités changées, profil changé → obsolète ; jamais réutilisée', async () => {
    const { refreshModelCatalog } = await import('@/services/ai/provider/model-catalog.service');
    const { recordCapabilitySnapshot, ensureModelCapabilitiesLoaded, invalidateModelCapabilities } = await import('@/services/ai/provider/model-capabilities.repository');
    expect((await refreshModelCatalog(null, fetcherDe(MODELES.map((m) => (m.name === 'gemini-3.5-flash' ? { ...m, outputTokenLimit: 60_000 } : m))))).ok).toBe(true);
    const r = await recordCapabilitySnapshot({ trigger: 'schedule', markRequalification: true });
    expect(r.changed).toContain('gemini-3.5-flash');
    invalidateModelCapabilities();
    await ensureModelCapabilitiesLoaded();
    const o = await overview();
    const c = couple(o.body, 't3_link_ambiguity', 0);
    expect(c).toMatchObject({ state: 'OBSOLETE', evidenceId: expect.any(Number), choiceLabel: 'Choix manuel · non testé (obsolète)' });
    expect(c.changed).toContain('capacités du modèle');
    // Les autres opérations / modèles ne sont pas touchés (R12) : le repli garde son état.
    expect(couple(o.body, 't3_link_ambiguity', 1).state).toBe('REFUSED');
    const { listQualificationEvidence } = await import('@/services/ai/qualification/service');
    const l = await listQualificationEvidence({ operationCode: 't3_link_ambiguity' });
    expect(l.find((e) => e.id === evidenceE01)).toMatchObject({ verdict: 'ADMISSIBLE', currentState: 'OBSOLETE' });
    // Profil d'opération modifié manuellement → obsolète « profil effectif » (QUAL-07) ; activation manuelle toujours possible (QUAL-08).
    const svc = await import('@/services/ai/config/config-version.service');
    const repo = await import('@/services/ai/config/config-version.repository');
    const v = (await repo.getVersion(baseVersionId))!;
    const t3 = v.entries.find((e) => e.treatment === 'T3')!;
    await svc.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, entries: [{ ...t3, operationProfiles: { t3_link_ambiguity: { timeoutMs: 20_000 } } }] }, adminId);
    const o2 = await overview();
    expect(couple(o2.body, 't3_link_ambiguity', 1)).toMatchObject({ state: 'OBSOLETE' });
    expect(couple(o2.body, 't3_link_ambiguity', 1).changed).toContain('profil effectif');
    const ap = await get('/api/admin/ai/qualification/evidence?operationCode=t3_link_ambiguity&latest=1', import('@/app/api/admin/ai/qualification/evidence/route') as never);
    expect(ap.status).toBe(200);
    expect((ap.body.items as any[]).every((e) => e.currentState === 'OBSOLETE')).toBe(true);
  });

  it('L86A-E05 — point de restauration impossible : campagne REFUSÉE, aucun appel, aucune preuve', async () => {
    appels.length = 0;
    const { requestManualCoupleTest } = await import('@/services/ai/qualification/campaign');
    const { campaignId } = await requestManualCoupleTest({ adminUserId: adminId, couple: { treatment: 'T3', operationCode: 't3_link_ambiguity', rank: 0 } },
      deps({ takeRestorePoint: async () => { throw new Error('stockage objet non configuré'); } }));
    const [c] = await sql<any[]>`SELECT status, refusal, restore_point_id FROM ai_qualification_campaigns WHERE id = ${campaignId}`;
    expect(c).toMatchObject({ status: 'REFUSED', restore_point_id: null });
    expect(c.refusal).toMatch(/Point de restauration impossible.*aucun appel/);
    expect(appels).toHaveLength(0);
    expect(await sql`SELECT 1 FROM ai_qualification_evidence WHERE campaign_id = ${campaignId}`).toHaveLength(0);
  });

  it('L86A-E06 — production : aucune campagne ; candidate jamais activée automatiquement hors préproduction', async () => {
    const campaign = await import('@/services/ai/qualification/campaign');
    await expect(campaign.requestManualCoupleTest({ adminUserId: adminId, couple: { treatment: 'T3', operationCode: 't3_link_ambiguity', rank: 0 } }, deps({ environment: 'production' })))
      .rejects.toMatchObject({ code: 'PRODUCTION_REFUSED' });
    const auto = await campaign.requestAutomaticCampaign({ trigger: 'e2e' }, deps({ environment: 'production' }));
    expect(auto).toMatchObject({ campaignId: null, note: expect.stringMatching(/préproduction/) });
    // Candidate QUALIFIÉE, environnement PRODUCTION : refus, active inchangée.
    const svc = await import('@/services/ai/config/config-version.service');
    const cand = await svc.createAutomaticCandidate({ treatment: 'T6', primaryModel: 'gemini-3.6-flash', key: `e2e-prod-${Date.now()}`, reason: 'e2e production', campaignId: null });
    expect(cand).toMatchObject({ active: false, origin: 'auto', candidateState: 'CREATED' });
    await sql`UPDATE ai_config_versions SET candidate_state = 'QUALIFIED' WHERE id = ${cand.id}`;
    const active = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].id;
    const avant = process.env.NEXT_PUBLIC_APP_ENV;
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    try {
      await expect(svc.activateQualifiedCandidate(cand.id)).rejects.toMatchObject({ code: 'CANDIDATE_ACTIVATION_PREPROD_ONLY' });
    } finally {
      if (avant === undefined) delete process.env.NEXT_PUBLIC_APP_ENV; else process.env.NEXT_PUBLIC_APP_ENV = avant;
    }
    expect((await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].id).toBe(active);
    // Une version MANUELLE ne s'active jamais par ce chemin ; une candidate non qualifiée non plus.
    await expect(svc.activateQualifiedCandidate(baseVersionId)).rejects.toMatchObject({ code: 'CANDIDATE_NOT_QUALIFIED' });
    await sql`UPDATE ai_config_versions SET candidate_state = 'REFUSED' WHERE id = ${cand.id}`;
    await expect(svc.activateQualifiedCandidate(cand.id)).rejects.toMatchObject({ code: 'CANDIDATE_NOT_QUALIFIED' });
    expect((await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].id).toBe(active);
  });

  it('L86A-E07 — campagne automatique : candidate refusée (active intacte), puis qualifiée avec gain établi, non active pendant ses tests, activée ; rien de plus sans événement', async () => {
    const { requestAutomaticCampaign } = await import('@/services/ai/qualification/campaign');
    const { QUALIFICATION_THRESHOLDS } = await import('@/services/ai/qualification/thresholds');
    const th = { ...QUALIFICATION_THRESHOLDS, campaign: { ...QUALIFICATION_THRESHOLDS.campaign, maxCouplesPerCampaign: 0 } };
    const activeAvantE07 = (await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].id;
    // a) Candidate « mauvaise » (gemini-2.5-pro) : refusée, active intacte, preuves des échecs disponibles (R04, R47).
    comportement.set('gemini-2.5-pro', { mode: 'BAD', delayMs: 5 });
    const a = await requestAutomaticCampaign({ trigger: 'e2e' }, deps({ thresholds: th, proposeModels: async (t: string) => (t === 'T6' ? ['gemini-2.5-pro'] : []) }));
    expect(a.campaignId).not.toBeNull();
    const [ca] = await sql<any[]>`SELECT status, summary, candidate_version_id FROM ai_qualification_campaigns WHERE id = ${a.campaignId}`;
    expect(ca.status).toBe('COMPLETED');
    expect(ca.summary.activatedVersionId).toBeNull();
    const [va] = await sql<any[]>`SELECT status, origin, candidate_state FROM ai_config_versions WHERE id = ${ca.candidate_version_id}`;
    expect(va).toMatchObject({ status: 'INACTIVE', origin: 'auto', candidate_state: 'REFUSED' });
    expect((await sql<{ id: number }[]>`SELECT id FROM ai_config_versions WHERE environment = ${env} AND status = 'ACTIVE'`)[0].id).toBe(activeAvantE07);
    expect((await sql<any[]>`SELECT verdict FROM ai_qualification_evidence WHERE campaign_id = ${a.campaignId} AND role = 'CANDIDATE'`).map((e) => e.verdict)).toContain('REFUSED');

    // b) Candidate rapide et juste (gemini-3.1-flash-lite) : admissible sur T6 FORMULATE et EVALUATE, gain établi sur le délai (interactif).
    comportement.set('gemini-3.5-flash', { mode: 'GOOD', delayMs: 400 });
    comportement.set('gemini-3.1-flash-lite', { mode: 'GOOD', delayMs: 5 });
    pendantCandidate.length = 0;
    const b = await requestAutomaticCampaign({ trigger: 'e2e' }, deps({ thresholds: th, proposeModels: async (t: string) => (t === 'T6' ? ['gemini-3.1-flash-lite'] : []) }));
    const [cb] = await sql<any[]>`SELECT status, summary, candidate_version_id, restore_point_id FROM ai_qualification_campaigns WHERE id = ${b.campaignId}`;
    expect(cb).toMatchObject({ status: 'COMPLETED', restore_point_id: expect.stringMatching(/^rp-/) });
    // Pendant ses tests, la candidate n'était JAMAIS l'active (VER-01).
    expect(pendantCandidate.length).toBeGreaterThan(0);
    expect(new Set(pendantCandidate)).toEqual(new Set([activeAvantE07]));
    const evs = await sql<any[]>`SELECT id, operation_code, verdict, role, reasons FROM ai_qualification_evidence WHERE campaign_id = ${b.campaignId} ORDER BY id`;
    expect(evs.filter((e) => e.role === 'CANDIDATE').map((e) => [e.operation_code, e.verdict]).sort()).toEqual([['t6_evaluate', 'ADMISSIBLE'], ['t6_formulate', 'ADMISSIBLE']]);
    expect(cb.summary.activatedVersionId).toBe(Number(cb.candidate_version_id));
    const [vb] = await sql<any[]>`SELECT status, origin, candidate_state, activated_by FROM ai_config_versions WHERE id = ${cb.candidate_version_id}`;
    expect(vb).toMatchObject({ status: 'ACTIVE', origin: 'auto', candidate_state: 'ACTIVATED', activated_by: null });
    expect((await sql<any[]>`SELECT status FROM ai_config_versions WHERE id = ${activeAvantE07}`)[0].status).toBe('INACTIVE');
    const g = (cb.summary.candidates as any[])[0];
    expect(g.gains.find((x: any) => x.operationCode === 't6_formulate').outcome).toBe('GAIN');

    // c) Passage suivant sans événement ni nouvelle proposition : rien n'est lancé (R46, QUAL-06).
    appels.length = 0;
    const c = await requestAutomaticCampaign({ trigger: 'e2e' }, deps({ thresholds: th, proposeModels: async (t: string) => (t === 'T6' ? ['gemini-3.1-flash-lite'] : []) }));
    const [cc] = await sql<any[]>`SELECT status, summary, restore_point_id FROM ai_qualification_campaigns WHERE id = ${c.campaignId}`;
    expect(cc.status).toBe('COMPLETED');
    expect(cc.summary.note).toMatch(/rien à qualifier/);
    expect(appels).toHaveLength(0);
    comportement.clear();
  });

  it('L86A-E08 — rejeu des données existantes : verrou par compte, comparaison à l’historique ; interruption → verrous libérés', async () => {
    const compte = await make.account();
    const occupe = await make.account();
    const t6 = casDe.get('t6_formulate')![0];
    const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { liveVariablesFor } = await import('@/services/ai/governance/master-corpus/live');
    const fx = loadMasterCorpusCases(readMasterFileFromRepo).find((x) => x.id === t6.id)!;
    const vars = await liveVariablesFor(fx);
    for (const a of [compte.id, occupe.id]) {
      await sql`INSERT INTO ai_call_captures (trace_id, call_kind, origin, account_id, operation_code, capture_status, prompt_status, prompt_text, variables, attachments, response_status, parsed_output)
        VALUES (${`hist-${a}`}, 'analysis', 'gateway', ${a}, 't6_formulate', 'CAPTURED', 'CAPTURED', 'prompt historique', ${JSON.stringify(vars)}::jsonb, '[]'::jsonb, 'CAPTURED', ${JSON.stringify({ ancien: true })}::jsonb)`;
    }
    // Une campagne ouverte tient déjà le compte « occupé ».
    const repo = await import('@/services/ai/qualification/repository');
    const autre = await repo.createCampaign({ kind: 'MANUAL', environment: env, trigger: 'e2e', reason: null, adminUserId: adminId, configVersionId: null, thresholdsVersion: 'qualif-seuils-v1', request: {} });
    await sql`UPDATE ai_qualification_campaigns SET status = 'RUNNING', heartbeat_at = now() WHERE id = ${autre}`;
    expect((await repo.lockAccounts(autre, [occupe.id])).locked).toEqual([occupe.id]);

    const { requestManualCoupleTest } = await import('@/services/ai/qualification/campaign');
    const { campaignId } = await requestManualCoupleTest({ adminUserId: adminId, couple: { treatment: 'T6', operationCode: 't6_formulate', rank: 0 } },
      deps({ accounts: async () => [compte.id, occupe.id] }));
    const [ev] = await sql<any[]>`SELECT id, metrics FROM ai_qualification_evidence WHERE campaign_id = ${campaignId} AND role = 'REFERENCE'`;
    const rejeux = await sql<any[]>`SELECT * FROM ai_qualification_cases WHERE evidence_id = ${ev.id} AND source = 'PREPROD_REPLAY'`;
    expect(rejeux.length).toBeGreaterThan(0);
    expect(rejeux.every((r) => Number(r.account_id) === compte.id && r.mandatory === false && r.matches_historical === false)).toBe(true);
    expect(ev.metrics.skipped.reasons).toContain('compte verrouillé par une autre campagne (QUAL-04)');
    // Verrous de la campagne libérés ; celui de l'autre campagne intact.
    expect(await repo.openLocks(campaignId)).toEqual([]);
    expect(await repo.openLocks(autre)).toEqual([occupe.id]);
    // Les appels de rejeu sont imputés au compte des données, en technique.
    const t = await sql<any[]>`SELECT metadata FROM ai_usage_event WHERE account_id = ${compte.id}`;
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => x.metadata.trigger === 'qualification')).toBe(true);
    // Une campagne sans signe de vie est INTERROMPUE, ses verrous libérés (R13).
    await sql`UPDATE ai_qualification_campaigns SET heartbeat_at = now() - interval '2 hours' WHERE id = ${autre}`;
    const interrompues = await repo.interruptStaleCampaigns(30 * 60_000);
    expect(interrompues).toContain(autre);
    expect((await sql<any[]>`SELECT status, error FROM ai_qualification_campaigns WHERE id = ${autre}`)[0]).toMatchObject({ status: 'INTERRUPTED', error: expect.stringMatching(/interrompue/) });
    expect(await repo.openLocks(autre)).toEqual([]);
    // Index unique : deux verrous ouverts sur le même compte sont impossibles.
    const x = await repo.createCampaign({ kind: 'MANUAL', environment: env, trigger: 'e2e', reason: null, adminUserId: null, configVersionId: null, thresholdsVersion: 'v', request: {} });
    const y = await repo.createCampaign({ kind: 'MANUAL', environment: env, trigger: 'e2e', reason: null, adminUserId: null, configVersionId: null, thresholdsVersion: 'v', request: {} });
    expect((await repo.lockAccounts(x, [compte.id])).locked).toEqual([compte.id]);
    expect((await repo.lockAccounts(y, [compte.id])).busy).toEqual([compte.id]);
    await repo.releaseAccounts(x);
  });

  it('L86A-E09 — tables classées, conservées à la restauration ; migrations rejouables ; routes réservées aux administrateurs', async () => {
    const { RECETTE_EXCLUDED: RECETTE_EXCLUDED_TABLES, RECETTE_RETIRABLE_TABLES } = await import('@/services/admin/diagnostics-export/recette-catalog');
    expect(RECETTE_RETIRABLE_TABLES.has('ai_corpus_baseline')).toBe(true);
    const { RESTORE_KEEP_CURRENT_TABLES, checkRestoreCompatibility, readSchemaSignature } = await import('@/services/backup/schema-signature');
    const tables = ['ai_qualification_campaigns', 'ai_qualification_campaign_accounts', 'ai_qualification_evidence', 'ai_qualification_cases'];
    for (const t of tables) {
      expect(RECETTE_EXCLUDED_TABLES[t], t).toMatch(/qualification IA/);
      expect(RESTORE_KEEP_CURRENT_TABLES).toContain(t);
    }
    const sig = await readSchemaSignature(async (q, p = []) => (await sql.unsafe(q, p as never[])) as unknown as Array<Record<string, unknown>>);
    const point = { version: 2, tables: Object.entries(sig).filter(([t]) => !tables.includes(t)).map(([name, columns]) => ({ name, columns })) };
    const c = checkRestoreCompatibility(point, sig);
    expect(c.restorable).toBe(true);
    for (const t of tables) expect(c.keptTables).toContain(t);
    for (const f of ['0724_l86a_qualification_campagnes.sql', '0725_l86a_qualification_preuves.sql', '0726_l86a_versions_candidates.sql']) {
      await sql.begin(async (tx) => { await tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations', f), 'utf8')); });
    }
    // Versions existantes : origine manuelle par défaut (MIG-02).
    expect((await sql<any[]>`SELECT origin FROM ai_config_versions WHERE id = ${baseVersionId}`)[0].origin).toBe('manual');
    session.role = 'USER';
    try {
      expect((await overview()).status).toBe(401);
    } finally {
      session.role = 'ADMIN';
    }
  });
});
