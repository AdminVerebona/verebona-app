/**
 * Lot 103G sur PostgreSQL 16 réel — ticket P1 « compte technique de
 * qualification » (préproduction). Fournisseur SIMULÉ (aucun réseau) ; passerelle,
 * configuration IA, campagnes 86A, mise en conformité 99B, Supervision : code de
 * production.
 *
 *  L103G-E01 (R1)       CORPUS_ACCOUNT_ID=999999 inexistant, aucun compte technique : test par couple et campagne
 *                       automatique REFUSÉS au précontrôle (CORPUS_ACCOUNT_MISSING) — aucun point de restauration,
 *                       aucun appel, aucune candidate ; UNE anomalie de Supervision regroupée
 *  L103G-E02 (R1/R8)    mise en conformité T2 (t2-property-continuity-v1) : « en attente de prérequis », AUCUNE
 *                       candidate ni campagne, santé fonctionnelle BLOQUÉE ≠ succès technique de la tâche, détections
 *                       ≠ essais, un seul événement par état ; balayage de Supervision : une anomalie, pas une par contrat
 *  L103G-E03 (R3)       CORPUS_ACCOUNT_ID pointant vers un compte client actif / suspendu / expiré : refus, anomalie de
 *                       sécurité, aucune exemption (C-Q10, plafond de coût)
 *  L103G-E04 (R2)       BO : provisionnement idempotent audité, route CRON_SECRET, compte existant non marqué (copie
 *                       prod → préprod) marqué sans doublon, variable obsolète résolue par le marqueur
 *  L103G-E05 (R4/R5/R7) passage suivant SANS clic : reprise automatique de la seule incompatibilité bloquée par le
 *                       prérequis ; cas du corpus T2 RÉELLEMENT appelés via la passerelle (compte technique éligible
 *                       dans le contexte de campagne) ; sans preuve (fournisseur indisponible) → non concluant, version
 *                       active conservée ; passage suivant : aucune nouvelle campagne (anti-boucle)
 *  L103G-E06 (B)        exemption seulement dans le contexte serveur : hors campagne, le compte technique est non
 *                       éligible ; balayages SQL jamais exemptés
 *  L103G-E07 (R10)      production : aucune campagne, aucun auto-provisionnement, aucune activation
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l103g@e2e.test', role: 'ADMIN' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => { if (session.role !== 'ADMIN') throw Object.assign(new Error('forbidden'), { status: 403 }); return session.adminId; },
    getSession: async () => ({ userId: session.adminId, email: session.email, role: session.role }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

type Json = Record<string, any>;
const CONTRAT = 't2-property-continuity-v1';
const CLE = 'cle-e2e-l103g';
const FP = 'ai:qualification:corpus-account';
const FP_SECU = 'ai:qualification:corpus-account:security';
type ApiModel = { name: string; outputTokenLimit?: number; thinking?: boolean };
const MODELES: ApiModel[] = [{ name: 'gemini-3.5-flash' }, { name: 'gemini-2.5-flash' }, { name: 'gemini-2.5-pro' }].map((m) => ({ outputTokenLimit: 65_536, thinking: true, ...m }));
const fetcher = (async () => new Response(JSON.stringify({
  models: MODELES.map((m) => ({ name: `models/${m.name}`, supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: m.outputTokenLimit, thinking: m.thinking, temperature: 1, maxTemperature: 2 })),
}), { status: 200 })) as unknown as typeof fetch;

scenario('L103G', 'Compte technique de qualification : précontrôle, sécurité, reprise automatique, observabilité', ({ sql, make }) => {
  const envAvant: Record<string, string | undefined> = {};
  const VARS = ['NEXT_PUBLIC_APP_ENV', 'AI_PROMPT_CONFORMITY', 'AI_PROMPT_CONFORMITY_CONTRACTS', 'CORPUS_ACCOUNT_ID', 'AI_CORPUS_ACCOUNT_AUTO_PROVISION', 'CRON_SECRET', 'AI_PROMPT_CONFORMITY_MAX_PER_PASS'];
  let adminId = 0;
  const restorePoints: string[] = [];
  const appels: Array<{ model: string; prompt: string }> = [];
  let provider: import('@/services/ai/gateway/providers').FakeProvider;
  let avantProvider: import('@/services/ai/gateway/providers/provider.port').AiProvider;
  const takeRestorePoint = async (label: string) => { restorePoints.push(label); return { backupId: `rp-${restorePoints.length}`, finishedAt: new Date().toISOString() }; };
  // Lot 113I (CDC V2 BUD-03/04) : le fournisseur est SIMULÉ (aucun appel payant) — aucune réservation du budget
  // d'amélioration ici (`budgetPort: null`) ; la réservation réelle est recettée par le scénario L113I.
  const campaignDeps = () => ({ takeRestorePoint, accounts: async () => [] as number[], budgetPort: null });
  const passage = async () => (await import('@/services/ai/prompt-conformity/service')).runPromptConformityPass({ trigger: 'e2e' }, { skipLease: true, campaign: campaignDeps() });
  const issue = async () => (await sql<Json[]>`SELECT * FROM ai_prompt_conformity_issues WHERE environment = 'preprod' AND contract_id = ${CONTRAT}`)[0];
  const evenements = async (id: number) => sql<Json[]>`SELECT kind, message, payload FROM ai_prompt_conformity_events WHERE issue_id = ${id} ORDER BY id`;
  const n = async (q: string) => Number((await sql.unsafe(q))[0].n);
  const anomalie = async (fp: string) => (await sql<Json[]>`SELECT id, status, occurrence_count, title, technical_detail FROM admin_anomalies WHERE fingerprint = ${fp} ORDER BY id DESC LIMIT 1`)[0];
  const route = async (method: 'GET' | 'POST', mod: Promise<Json>, body?: unknown, headers: Record<string, string> = {}) => {
    const { NextRequest } = await import('next/server');
    const res = await (await mod)[method](new NextRequest('http://app.test/x', { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }) as never);
    return { status: res.status as number, body: await res.json().catch(() => ({})) as Json };
  };
  const adminRoute = () => import('@/app/api/admin/ai/corpus-account/route') as Promise<Json>;
  const cronRoute = () => import('@/app/api/cron/ai/corpus-account/route') as Promise<Json>;
  const reset = async () => {
    (await import('@/services/account/processing-eligibility')).invalidateProcessingEligibility();
  };

  beforeAll(async () => {
    for (const k of VARS) envAvant[k] = process.env[k];
    process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
    process.env.AI_PROMPT_CONFORMITY = 'auto';
    process.env.AI_PROMPT_CONFORMITY_CONTRACTS = CONTRAT;
    process.env.CORPUS_ACCOUNT_ID = '999999';
    process.env.AI_CORPUS_ACCOUNT_AUTO_PROVISION = 'off';
    process.env.CRON_SECRET = 'secret-e2e-l103g';
    delete process.env.AI_PROMPT_CONFORMITY_MAX_PER_PASS;
    const admin = await make.user({ role: 'ADMIN' });
    adminId = admin.id;
    session.adminId = admin.id;
    // Base modèle : aucun compte technique (vérifié — le précontrôle doit le constater lui-même).
    expect(await n(`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'corpus@verebona.local'`)).toBe(0);
    const { setProviderSecretResolver } = await import('@/services/ai/provider/provider-secret');
    setProviderSecretResolver(async () => CLE);
    for (const t of ['ai_model_capability_changes', 'ai_model_catalog', 'ai_model_qualification', 'ai_model_operational_status']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_model_catalog_refresh`;
    const { __setConfigVersionCounterStoreForTests, dbConfigVersionCounterStore } = await import('@/services/ai/config/config-cache-version');
    __setConfigVersionCounterStoreForTests(dbConfigVersionCounterStore);
    const { syncAiCatalog } = await import('@/services/ai/provider/ai-catalog-sync.service');
    const qualif = async (i: { responseSchema?: unknown; attachments: unknown[] }) => ({ rawText: i.responseSchema ? '{"ok":true,"mot":"verebona"}' : i.attachments.length ? 'Rouge' : 'OK', inputTokens: 4, outputTokens: 2 });
    expect((await syncAiCatalog({ trigger: 'schedule' }, {
      fetcher, qualificationCall: qualif as never, probeCall: async () => ({ rawText: 'OK' }), maxQualifications: 50,
      pricing: { fetchPage: async () => { throw new Error('hors ligne'); }, billing: null }, raiseAlert: async () => false,
    })).ok).toBe(true);
    // Configuration de préproduction : T2 sur gemini-3.5-flash (repli gemini-2.5-flash). Prompt T2 : texte livré (sans
    // le contrat de l'étape 11) — même situation que la préproduction du 31/10.
    const svc = await import('@/services/ai/config/config-version.service');
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = 'preprod' AND status = 'ACTIVE'`;
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l103g référence' });
    const entries = v.entries.filter((e) => e.treatment === 'T2').map((e) => ({
      ...e, primaryModel: 'gemini-3.5-flash', reasoningPrimary: null, fallback1: 'gemini-2.5-flash', reasoningFallback1: null, fallback2: null, reasoningFallback2: null, operationProfiles: {},
    }));
    await svc.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, entries }, adminId);
    await svc.activate(v.id, adminId);
    // Verrou A1 levé pour cette scène (recetté par l100b) : il ne doit de toute façon rien activer ici.
    const promo = await import('@/services/ai/governance/master-corpus/certification/promotion');
    promo.__setPromotionLockForTests(promo.OPEN_LOCK_FOR_TESTS);
    const { FakeProvider, setAiProvider, getAiProvider } = await import('@/services/ai/gateway/providers');
    avantProvider = getAiProvider();
    provider = new FakeProvider();
    // Fournisseur INDISPONIBLE : chaque appel réellement émis est compté ; aucune preuve ne peut être obtenue.
    provider.onAny((async (input: { model: string; prompt: string }) => {
      appels.push({ model: input.model, prompt: input.prompt });
      throw Object.assign(new Error('503 UNAVAILABLE : service momentanément indisponible'), { status: 503 });
    }) as never);
    setAiProvider(provider);
  }, 300_000);

  afterAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    if (avantProvider) setAiProvider(avantProvider);
    (await import('@/services/ai/provider/provider-secret')).setProviderSecretResolver(null);
    (await import('@/services/ai/governance/master-corpus/certification/promotion')).__setPromotionLockForTests(null);
    (await import('@/services/ai/config/config-cache-version')).__setConfigVersionCounterStoreForTests(null);
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    for (const [k, v] of Object.entries(envAvant)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('L103G-E01 (R1) — compte déclaré 999999 inexistant : campagnes refusées AVANT tout appel, motif précis, une anomalie regroupée', async () => {
    const { requestManualCoupleTest, requestAutomaticCampaign } = await import('@/services/ai/qualification/campaign');
    const candidatesAvant = await n(`SELECT count(*)::int AS n FROM ai_config_versions WHERE origin = 'auto'`);
    const { campaignId } = await requestManualCoupleTest({ adminUserId: adminId, couple: { treatment: 'T2', operationCode: 't2_answer', rank: 0 } }, { ...campaignDeps(), await: true });
    const [c] = await sql<Json[]>`SELECT status, refusal, summary, restore_point_id FROM ai_qualification_campaigns WHERE id = ${campaignId}`;
    expect(c.status).toBe('REFUSED');
    expect(c.refusal).toMatch(/^CORPUS_ACCOUNT_MISSING : compte technique de qualification absent — CORPUS_ACCOUNT_ID=999999 : aucun compte technique correspondant \(compte introuvable\)/);
    expect(c.refusal).toMatch(/Aucun appel effectué, aucune candidate créée/);
    expect(c.summary.prerequisite).toMatchObject({ code: 'CORPUS_ACCOUNT_MISSING', stage: 'PRECHECK', security: false });
    expect(c.restore_point_id).toBeNull();
    // Campagne automatique : refus amont, aucune candidate créée.
    const auto = await requestAutomaticCampaign({ trigger: 'e2e' }, campaignDeps());
    expect(auto.note).toMatch(/^BLOQUÉE PAR UN PRÉREQUIS \(CORPUS_ACCOUNT_MISSING\)/);
    expect(await n(`SELECT count(*)::int AS n FROM ai_config_versions WHERE origin = 'auto'`)).toBe(candidatesAvant);
    expect(restorePoints).toEqual([]);
    expect(appels).toHaveLength(0);
    expect(await n(`SELECT count(*)::int AS n FROM ai_qualification_evidence`)).toBe(0);
    // UNE anomalie, consolidée (deux refus → une carte, deux occurrences au moins).
    const a = await anomalie(FP);
    expect(a).toMatchObject({ status: 'open' });
    expect(a.occurrence_count).toBeGreaterThanOrEqual(2);
    expect(await n(`SELECT count(*)::int AS n FROM admin_anomalies WHERE fingerprint = '${FP}'`)).toBe(1);
    expect(JSON.stringify(a.technical_detail)).not.toMatch(/@/);
  });

  it('L103G-E02 (R1/R8) — conformité T2 : en attente de prérequis, aucune candidate ni campagne, santé BLOQUÉE, détections ≠ essais', async () => {
    const campagnesAvant = await n(`SELECT count(*)::int AS n FROM ai_qualification_campaigns`);
    const r = await passage();
    expect(r.mode).toBe('auto');
    const i = await issue();
    expect(i).toBeTruthy();
    expect(i.status).toBe('DETECTED');
    expect(i.prerequisite).toMatchObject({ code: 'CORPUS_ACCOUNT_MISSING', stage: 'PRECHECK' });
    expect(i.decision).toMatch(/^En attente du prérequis : compte technique de qualification absent \(CORPUS_ACCOUNT_MISSING\)/);
    expect(i.candidate_config_version_id).toBeNull();
    expect(i.candidate_prompt_version_id).toBeNull();
    expect(await n(`SELECT count(*)::int AS n FROM ai_master_prompt_versions WHERE origin = 'auto_conformity'`)).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM ai_qualification_campaigns`)).toBe(campagnesAvant);
    // Synthèse : compteurs distincts, santé fonctionnelle ≠ succès technique.
    expect(r.summary).toMatchObject({ detected: 1, eligible: 1, waitingPrerequisite: 1, attempted: 0, qualified: 0, refused: 0, activated: 0 });
    expect(r.health).toMatchObject({ code: 'BLOCKED_PREREQUISITE', healthy: false });
    expect(r.taskNote).toMatch(/^Santé : BLOQUÉE \(PRÉREQUIS\) — bloquée par un prérequis \(CORPUS_ACCOUNT_MISSING\)/);
    expect(r.taskNote).toMatch(/1 en attente de prérequis · 0 essayée\(s\)/);
    // Tâche planifiée : exécutée sans erreur technique, mais la note dit la santé fonctionnelle.
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog') as unknown as { SCHEDULED_TASKS: Array<{ code: string; run: (c: unknown) => Promise<Json> }> };
    const tache = (SCHEDULED_TASKS ?? []).find((t) => t.code === 'ai-prompt-conformity');
    if (tache) {
      const res = await tache.run({ trigger: 'manual', deadline: Date.now() + 60_000 });
      expect(res.error).toBeUndefined();
      expect(String(res.note)).toMatch(/^Santé : BLOQUÉE \(PRÉREQUIS\)/);
    }
    // Passages suivants : un seul événement « en attente » par état du compte (pas un par passage).
    await passage();
    const j = await issue();
    expect(j.occurrences).toBeGreaterThan(i.occurrences);
    const kinds = (await evenements(j.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'PREREQUISITE_WAITING')).toHaveLength(1);
    expect(kinds).not.toContain('CORRECTION_STARTED');
    // BO : occurrences de détection jamais présentées comme des essais.
    const ov = await (await import('@/services/ai/prompt-conformity/service')).conformityOverview('preprod');
    const vue = ov.issues.find((x) => x.contractId === CONTRAT)!;
    expect(vue).toMatchObject({ attempts: 0, prerequisiteBlock: expect.objectContaining({ code: 'CORPUS_ACCOUNT_MISSING' }) });
    expect(vue.detections).toBe(j.occurrences);
    expect(ov.functional).toMatchObject({ state: 'BLOCKED_PREREQUISITE' });
    // Supervision : le balayage garde UNE anomalie (compte technique), aucune par contrat pour ce seul prérequis.
    const { collectAiConditions } = await import('@/services/admin/supervision-sweep.service');
    const conds = await collectAiConditions();
    expect(conds.filter((x) => x.fingerprint === FP)).toHaveLength(1);
    expect(conds.filter((x) => x.fingerprint === `ai:prompt-conformity:${CONTRAT}`)).toHaveLength(0);
  });

  it('L103G-E03 (R3) — CORPUS_ACCOUNT_ID sur un compte client actif / suspendu / expiré : refus, anomalie de sécurité, aucune exemption', async () => {
    const actif = await make.account({ plan: 'premium' });
    const suspendu = await make.account({ plan: 'premium' });
    await sql`UPDATE accounts SET is_active = false WHERE id = ${suspendu.id}`;
    const expire = await make.account({ plan: null });
    await sql`UPDATE accounts SET subscription_status = 'EXPIRED' WHERE id = ${expire.id}`;
    const { requestManualCoupleTest } = await import('@/services/ai/qualification/campaign');
    const { getAccountProcessingEligibility } = await import('@/services/account/processing-eligibility');
    const { isCostCapped } = await import('@/services/ai/gateway/account-cost-cap');
    for (const c of [actif, suspendu, expire]) {
      process.env.CORPUS_ACCOUNT_ID = String(c.id);
      await reset();
      const { campaignId } = await requestManualCoupleTest({ adminUserId: adminId, couple: { treatment: 'T2', operationCode: 't2_answer', rank: 0 } }, { ...campaignDeps(), await: true });
      const [camp] = await sql<Json[]>`SELECT status, refusal, summary FROM ai_qualification_campaigns WHERE id = ${campaignId}`;
      expect(camp.status).toBe('REFUSED');
      expect(camp.refusal).toMatch(/^CORPUS_ACCOUNT_MISMATCH/);
      expect(camp.summary.prerequisite).toMatchObject({ code: 'CORPUS_ACCOUNT_MISMATCH', security: true });
      // C-Q10 et plafond inchangés pour ce client (désigné par la variable).
      expect(isCostCapped({ accountId: c.id, useCaseCode: 'SOURCE_ANALYSIS' })).toBe(true);
    }
    expect((await getAccountProcessingEligibility(suspendu.id)).eligible).toBe(false);
    expect((await getAccountProcessingEligibility(expire.id)).eligible).toBe(false);
    const secu = await anomalie(FP_SECU);
    expect(secu).toMatchObject({ status: 'open' });
    expect(secu.title).toMatch(/^Sécurité : CORPUS_ACCOUNT_ID désigne un compte client/);
    expect(appels).toHaveLength(0);
    expect(restorePoints).toEqual([]);
    process.env.CORPUS_ACCOUNT_ID = '999999';
  });

  let techId = 0;

  it('L103G-E04 (R2) — BO : provisionnement idempotent et audité ; route CRON_SECRET ; compte non marqué (copie) marqué sans doublon ; variable obsolète', async () => {
    // Diagnostic BO (lecture seule) : motif et prochain geste, aucune adresse.
    const g = await route('GET', adminRoute());
    expect(g.status).toBe(200);
    expect(g.body.status).toMatchObject({ ok: false, code: 'CORPUS_ACCOUNT_MISSING' });
    expect(g.body.conformity).toEqual([expect.objectContaining({ contractId: CONTRAT, code: 'CORPUS_ACCOUNT_MISSING' })]);
    expect(g.body.campaigns.length).toBeGreaterThan(0);
    // Action BO : création.
    const p1 = await route('POST', adminRoute(), { action: 'provision' });
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ result: 'created', status: { ok: true, code: 'CORPUS_ACCOUNT_OK', resolvedBy: 'marker' } });
    techId = p1.body.accountId;
    expect(p1.body.status.warnings.join()).toMatch(/CORPUS_ACCOUNT_ID=999999 est obsolète/);
    // Idempotence (BO puis route CRON_SECRET) : jamais de doublon.
    expect((await route('POST', adminRoute(), { action: 'provision' })).body.result).toBe('already_present');
    expect((await route('POST', cronRoute(), undefined)).status).toBe(401);
    const cron = await route('POST', cronRoute(), undefined, { authorization: 'Bearer secret-e2e-l103g' });
    expect(cron.body).toMatchObject({ statut: 'deja_present', compte: techId });
    expect(await n(`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'corpus@verebona.local'`)).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM accounts WHERE technical_kind = 'AI_QUALIFICATION_CORPUS'`)).toBe(1);
    const [u] = await sql<Json[]>`SELECT u.is_active, u.password_hash LIKE '!%' AS verrou, a.subscription_status FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id = ${techId}`;
    expect(u).toMatchObject({ is_active: false, verrou: true, subscription_status: 'NONE' });
    // Audit du geste BO.
    expect(await n(`SELECT count(*)::int AS n FROM ai_admin_audit_log WHERE action_type = 'ai_corpus_account_provision'`)).toBe(2);
    // Copie prod → préprod / compte d'avant 0960 : identité dédiée sans marqueur → précontrôle (auto-provisionnement
    // de préproduction) le MARQUE, même identifiant, aucun doublon.
    await sql`UPDATE accounts SET technical_kind = NULL WHERE id = ${techId}`;
    process.env.AI_CORPUS_ACCOUNT_AUTO_PROVISION = 'on';
    const { precheckCorpusAccount } = await import('@/services/ai/qualification/campaign');
    const st = await precheckCorpusAccount({}, { source: 'e2e' });
    expect(st).toMatchObject({ ok: true, accountId: techId });
    expect(await n(`SELECT count(*)::int AS n FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE lower(u.email) = 'corpus@verebona.local'`)).toBe(1);
    process.env.AI_CORPUS_ACCOUNT_AUTO_PROVISION = 'off';
    // Anomalie résolue automatiquement au contrôle réussi.
    expect((await anomalie(FP)).status).toBe('resolved');
  });

  it('L103G-E05 (R4/R5/R7) — reprise AUTOMATIQUE sans clic : cas T2 réellement appelés, non concluant sans preuve, version active conservée, aucune boucle', async () => {
    const promptAvant = await sql<Json[]>`SELECT id FROM ai_master_prompt_versions WHERE environment = 'preprod' AND treatment = 'T2' AND status = 'ACTIVE'`;
    const cfgAvant = Number((await sql`SELECT id FROM ai_config_versions WHERE environment = 'preprod' AND status = 'ACTIVE'`)[0].id);
    const r = await passage();
    expect(r.summary).toMatchObject({ attempted: 1, resumed: 1, waitingPrerequisite: 0 });
    const i = await issue();
    const ev = await evenements(i.id);
    expect(ev.map((e) => e.kind)).toEqual(expect.arrayContaining(['PREREQUISITE_RESUMED', 'CORRECTION_STARTED', 'CANDIDATE_CREATED', 'QUALIFICATION_STARTED']));
    expect(i.prerequisite).toMatchObject({ code: null, resumes: 1 });
    // Campagne CONFORMITY exécutée : point de restauration, cas du corpus T2 réellement soumis au fournisseur via la
    // passerelle de production avec le compte technique (aucun refus ACCOUNT_INELIGIBLE).
    expect(i.campaign_id).toBeTruthy();
    expect(restorePoints.length).toBeGreaterThan(0);
    expect(appels.length).toBeGreaterThan(0);
    const cas = await sql<Json[]>`SELECT q.case_id, q.outcome, q.inconclusive_reason, q.account_id FROM ai_qualification_cases q JOIN ai_qualification_evidence e ON e.id = q.evidence_id WHERE e.campaign_id = ${i.campaign_id}`;
    const corpus = cas.filter((x) => String(x.case_id).startsWith('corpus:'));
    expect(corpus.length).toBeGreaterThan(0);
    expect(corpus.map((x) => String(x.case_id))).toEqual(expect.arrayContaining(['corpus:P-T2-06']));
    expect(corpus.every((x) => !/ACCOUNT_INELIGIBLE|prérequis/.test(String(x.inconclusive_reason ?? '')))).toBe(true);
    expect(corpus.every((x) => x.outcome === 'INCONCLUSIVE' && /fournisseur/.test(String(x.inconclusive_reason)))).toBe(true);
    // Sans preuve : non concluant (jamais qualifié à tort), ancienne version active, BLOQUÉE pour une raison MÉTIER.
    expect(i.status).toBe('BLOCKED');
    expect(i.qualification.decision).not.toBe('QUALIFIED');
    expect(i.decision).toMatch(/non-régression non démontrée|non concluante/);
    const promptApres = await sql<Json[]>`SELECT id FROM ai_master_prompt_versions WHERE environment = 'preprod' AND treatment = 'T2' AND status = 'ACTIVE'`;
    expect(promptApres.map((x) => x.id)).toEqual(promptAvant.length ? promptAvant.map((x) => x.id) : promptApres.map((x) => x.id));
    expect(Number((await sql`SELECT id FROM ai_config_versions WHERE environment = 'preprod' AND status = 'ACTIVE'`)[0].id)).toBe(cfgAvant);
    // Anti-boucle : passage suivant, contexte inchangé → aucune nouvelle campagne ni reprise.
    const nCamp = await n(`SELECT count(*)::int AS n FROM ai_qualification_campaigns WHERE kind = 'CONFORMITY'`);
    const appelsAvant = appels.length;
    const r2 = await passage();
    expect(r2.summary).toMatchObject({ attempted: 0, alreadyBlocked: 1, resumed: 0 });
    expect(r2.health.healthy).toBe(false);
    expect(await n(`SELECT count(*)::int AS n FROM ai_qualification_campaigns WHERE kind = 'CONFORMITY'`)).toBe(nCamp);
    expect(appels.length).toBe(appelsAvant);
    const ov = await (await import('@/services/ai/prompt-conformity/service')).conformityOverview('preprod');
    expect(ov.issues.find((x) => x.contractId === CONTRAT)).toMatchObject({ attempts: 1, prerequisiteBlock: null });
  }, 600_000);

  it('L103G-E06 (B) — exemption seulement dans le contexte serveur ; balayages jamais exemptés', async () => {
    await reset();
    const { getAccountProcessingEligibility, filterEligibleAccountIds } = await import('@/services/account/processing-eligibility');
    const { runWithTechnicalAccount } = await import('@/services/ai/qualification/technical-context');
    process.env.CORPUS_ACCOUNT_ID = String(techId);
    expect(await getAccountProcessingEligibility(techId)).toEqual({ eligible: false, reason: 'NO_SUBSCRIPTION' });
    await runWithTechnicalAccount({ ok: true, accountId: techId }, 'e2e', async () => {
      expect(await getAccountProcessingEligibility(techId)).toEqual({ eligible: true, reason: null });
      expect((await filterEligibleAccountIds([techId])).has(techId)).toBe(false);
    });
    // Un compte client « ouvert » par erreur dans le contexte n'est jamais exempté (pas de marqueur).
    const client = await make.account({ plan: null });
    await runWithTechnicalAccount({ ok: true, accountId: client.id }, 'e2e', async () => {
      expect((await getAccountProcessingEligibility(client.id)).eligible).toBe(false);
    });
  });

  it('L103G-E07 (R10) — production : aucune campagne, aucun auto-provisionnement, aucune activation', async () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    process.env.AI_CORPUS_ACCOUNT_AUTO_PROVISION = 'on';
    const { requestAutomaticCampaign } = await import('@/services/ai/qualification/campaign');
    const { autoProvisionAllowed } = await import('@/services/ai/qualification/technical-account');
    const avant = await n(`SELECT count(*)::int AS n FROM ai_qualification_campaigns`);
    const r = await requestAutomaticCampaign({ trigger: 'e2e' }, { ...campaignDeps(), environment: 'production' });
    expect(r.campaignId).toBeNull();
    expect(await n(`SELECT count(*)::int AS n FROM ai_qualification_campaigns`)).toBe(avant);
    expect(autoProvisionAllowed('production')).toBe(false);
    const { conformityMode } = await import('@/services/ai/prompt-conformity/service');
    expect(conformityMode('production', { AI_PROMPT_CONFORMITY: 'auto' })).toMatchObject({ mode: 'candidate', activationAllowed: false });
    process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
    process.env.AI_CORPUS_ACCOUNT_AUTO_PROVISION = 'off';
  });
});
