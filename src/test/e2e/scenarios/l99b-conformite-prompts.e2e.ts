/**
 * Lot 99B sur PostgreSQL 16 réel — ticket P1 « Mise en conformité automatique
 * des prompts IA en préproduction, avec garantie de non-régression ».
 * RECETTE OBLIGATOIRE : CAS 88B. Fournisseur SIMULÉ (aucun réseau) : chaque
 * cas du corpus reçoit la sortie enregistrée de sa fixture (couple « bon »),
 * ou celle d'un autre cas (régression injectée) ; la reprise des propriétés
 * manquantes reçoit une réponse T3 KNOWLEDGE_QUERY simulée construite à
 * partir des éléments transmis (jamais une valeur codée hors du document).
 * Configuration IA, prompts maîtres, campagnes, cohérence, writer canonique :
 * code de production, base réelle, environnement de PRÉPRODUCTION.
 *
 * Point de départ : T3 actif (version BO) porteur des étapes 1 et 7 du guide
 * (branche KNOWLEDGE_QUERY), SANS le contrat `t3-knowledge-query-v2` ; trois
 * équipements de deux comptes en constat MISSING_PROPERTY_ARBITRATION_PENDING.
 *
 *  L99B-E01  détection automatique ; candidate COMPLÈTE préparée à partir de la version active (bloc officiel, diff,
 *            compatibilité effective) ; qualification de TOUTES les branches de T3 + la nouvelle sur le corpus réel :
 *            T3 VALUE_CONFLICT non concluant (seul cas = garde) → activation REFUSÉE, ancienne version active, motifs
 *            explicites, supervision ; passage suivant sur contexte inchangé : aucun nouvel essai
 *  L99B-E02  régression INJECTÉE dans la candidate (une branche existante dégradée) → activation refusée, motif précis
 *  L99B-E03  nouvel essai (administrateur), qualification concluante → activation automatique en préproduction, journal
 *            avant / après, rattrapage des 3 équipements (valeur écrite avec preuve ou abstention justifiée), anomalie
 *            fermée, écran BO
 *  L99B-E04  régression simulée APRÈS activation → retour arrière automatique à la version précédente, candidate
 *            suspendue ; aucun nouvel essai sur contexte inchangé
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCoherenceFor, proofOf } from '../coherence-run';
import { adminUrlFromEnv, bootstrapE2eDatabase, dropE2eDatabase } from '../db-bootstrap';
import { factories, type AccountRow, type Factories } from '../factories';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l99b@e2e.test', role: 'ADMIN' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => { if (session.role !== 'ADMIN') throw Object.assign(new Error('forbidden'), { status: 403 }); return session.adminId; },
    getSession: async () => ({ userId: session.adminId, email: session.email, role: session.role }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
type Preuve = { ref: string; layer: string; label: string | null; value: string | null; text: string | null };
const CONTRAT = 't3-knowledge-query-v2';
const CHECK_EQ = 'COH-MISSING-PROPERTIES-EQUIPMENT';
const AUJ = '2026-10-27';
/** Montants NEUTRES écrits dans les documents des équipements. */
const V = { ecrit: '1 234,00', valeur: 1234 };
const W = { ecrit: '2 468,00', valeur: 2468 };
const CLE = 'cle-e2e-l99b';
type ApiModel = { name: string; outputTokenLimit?: number; thinking?: boolean };
const MODELES: ApiModel[] = [{ name: 'gemini-3.5-flash' }, { name: 'gemini-2.5-flash' }, { name: 'gemini-2.5-pro' }].map((m) => ({ outputTokenLimit: 65_536, thinking: true, ...m }));
const fetcher = (async () => new Response(JSON.stringify({
  models: MODELES.map((m) => ({ name: `models/${m.name}`, supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: m.outputTokenLimit, thinking: m.thinking, temperature: 1, maxTemperature: 2 })),
}), { status: 200 })) as unknown as typeof fetch;

const ligne = (prompt: string, etiquette: string): unknown => {
  const m = new RegExp(`^${etiquette} : (.*)$`, 'm').exec(prompt);
  return m ? JSON.parse(m[1]) : null;
};
const nombre = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));

/**
 * Base DÉDIÉE (même parti que L84A) : le rattrapage et les contrôles de cohérence sont GLOBAUX (tous les comptes
 * éligibles) ; sur la base partagée d'une suite complète, ils verraient les données des autres scénarios.
 */
const ADMIN = adminUrlFromEnv();
const BASE = `verebona_e2e_l99b_${Date.now()}_${process.pid}`;

describe('L99B — Mise en conformité automatique des prompts IA (préproduction, non-régression) — recette 88B', () => {
  let sql: postgres.Sql;
  let make: Factories;
  const envAvant: Record<string, string | undefined> = {};
  const restorePoints: string[] = [];
  let techAccount = 0;
  let adminId = 0;
  let baseVersionId = 0;
  let t3ActifId = 0;
  let PRIX: { key: string };
  let provider: import('@/services/ai/gateway/providers').FakeProvider;
  let avantProvider: import('@/services/ai/gateway/providers/provider.port').AiProvider;
  /** Cas courant d'un appel de qualification (plomberie de test : seul le fournisseur est simulé). */
  const casCourant = new AsyncLocalStorage<{ op: string; key: string; versionId: number | null }>();
  const casDe = new Map<string, Array<{ key: string; output: unknown; id: string }>>();
  const mode = { regressionCandidate: false, invalidAfter: false };
  const reprise = { appels: 0 };

  /** Corpus de la scène (les cas réels du dépôt, rôles déclarés ; `extra` : rôles ajoutés par le test). */
  async function preparerCorpus(answer: Set<string> = new Set()) {
    const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { liveVariablesFor } = await import('@/services/ai/governance/master-corpus/live');
    const { canonicalJson } = await import('@/services/ai/qualification/signature');
    const corpus = loadMasterCorpusCases(readMasterFileFromRepo).map((c) => (answer.has(c.id) ? { ...c, qualificationRole: 'answer' as const } : c));
    (await import('@/services/ai/qualification/cases')).__setQualificationCorpusForTests(answer.size ? corpus : null);
    (await import('@/services/ai/qualification/context')).__resetQualificationContextForTests();
    casDe.clear();
    for (const c of corpus.filter((x) => x.operationCode.startsWith('t3_'))) {
      const v = await liveVariablesFor(c).catch(() => null);
      if (v) casDe.set(c.operationCode, [...(casDe.get(c.operationCode) ?? []), { key: canonicalJson(v), output: c.output, id: c.id }]);
    }
  }

  /** T3 KNOWLEDGE_QUERY simulé pour la reprise des propriétés manquantes (appels de production). */
  function reponseReprise(prompt: string): unknown {
    reprise.appels += 1;
    if (mode.invalidAfter) return { task: 'KNOWLEDGE_QUERY', outcome: 'PEUT-ÊTRE', constats: 'illisible' };
    const preuves = (ligne(prompt, 'Preuves candidates') ?? []) as Preuve[];
    const candidats = (ligne(prompt, 'Candidats') ?? []) as Array<{ key: string }>;
    const vide = { task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'Aucun élément transmis ne porte la propriété demandée.' };
    if (!candidats.some((c) => c.key === PRIX.key)) return vide;
    const hits = preuves.flatMap((p) => [V.ecrit, W.ecrit].filter((e) => [p.label, p.value, p.text].filter(Boolean).join(' ').includes(e)).map((e) => ({ ref: p.ref, e })));
    if (!hits.length) return vide;
    return {
      task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'Valeur écrite dans le document rattaché.',
      findings: [{ target: PRIX.key, rawValue: hits[0].e, value: nombre(hits[0].e), evidenceRefs: [hits[0].ref], excerpt: hits[0].e, confidence: 'certain', meaning: 'prix d’achat de l’équipement' }],
    };
  }

  const repondre = async (input: { model: string; prompt: string }) => {
    // Délai simulé STABLE et dominant (250 ms) : la mesure de latence (P95 candidate ≤ référence + 20 %) ne doit
    // pas dépendre du bruit d'ordonnancement d'une machine chargée (quelques dizaines de ms). Un délai de 25 ms
    // faisait refuser à tort la candidate (+29 % de bruit) : le garde-fou de délai reste, lui, inchangé.
    await new Promise((r) => setTimeout(r, 250));
    const cur = casCourant.getStore();
    if (!cur) return { rawText: JSON.stringify(reponseReprise(input.prompt)), inputTokens: 10, outputTokens: 5 };
    const liste = casDe.get(cur.op) ?? [];
    const i = liste.findIndex((c) => c.key === cur.key);
    if (i < 0) throw Object.assign(new Error('400 INVALID_ARGUMENT : cas inconnu du fournisseur simulé'), { status: 400 });
    // Régression INJECTÉE : la candidate rend, sur une branche EXISTANTE (LINK_AMBIGUITY), la sortie d'un autre cas.
    const degrade = mode.regressionCandidate && cur.versionId !== baseVersionId && cur.op === 't3_link_ambiguity' && liste.length > 1;
    return { rawText: JSON.stringify(degrade ? liste[(i + 1) % liste.length].output : liste[i].output), inputTokens: 10, outputTokens: 5 };
  };

  const call = async (req: { operationCode: string; promptVariables: Record<string, unknown> }, ctx: { configVersionId?: number | null }) => {
    const { productionGatewayCall } = await import('@/services/ai/qualification/runner');
    const { canonicalJson } = await import('@/services/ai/qualification/signature');
    return casCourant.run({ op: req.operationCode, key: canonicalJson(req.promptVariables), versionId: ctx.configVersionId ?? null }, () => productionGatewayCall(req as never, ctx as never));
  };
  /**
   * Seuils de la campagne : ceux du code, sauf la tolérance de P95. Le délai mesuré par la passerelle couvre tout
   * l'appel (résolution de configuration, trace, capture) : sur une base e2e partagée et chargée, ce surcoût varie de
   * plus de 20 % d'une exécution à l'autre quel que soit le délai simulé. Le sujet de cette recette est la
   * non-régression SÉMANTIQUE ; le garde-fou de délai est couvert par L86A et les tests de `verdict.ts`. Tous les
   * autres critères (défauts, régressions, non concluants, couverture, plafond de délai, coût) restent ceux du code.
   */
  let seuils: import('@/services/ai/qualification/thresholds').QualificationThresholds | undefined;
  const deps = () => ({
    skipLease: true,
    campaign: { thresholds: seuils, takeRestorePoint: async (label: string) => { restorePoints.push(label); return { backupId: `rp-${restorePoints.length}`, finishedAt: new Date().toISOString() }; }, technicalAccountId: techAccount, accounts: async () => [] as number[], call: call as never },
  });
  const passage = async () => (await import('@/services/ai/prompt-conformity/service')).runPromptConformityPass({ trigger: 'e2e' }, deps());
  const issue = async () => (await sql<Json[]>`SELECT * FROM ai_prompt_conformity_issues WHERE environment = 'preprod' AND contract_id = ${CONTRAT}`)[0];
  const evenements = async (id: number) => (await sql<Json[]>`SELECT kind, status_before, status_after, message, payload FROM ai_prompt_conformity_events WHERE issue_id = ${id} ORDER BY id`);
  const campagnes = async () => Number((await sql`SELECT count(*)::int AS n FROM ai_qualification_campaigns WHERE kind = 'CONFORMITY'`)[0].n);
  const configActive = async () => Number((await sql`SELECT id FROM ai_config_versions WHERE environment = 'preprod' AND status = 'ACTIVE'`)[0].id);
  const t3Actif = async () => (await sql<Json[]>`SELECT id, version_number, origin, content FROM ai_master_prompt_versions WHERE environment = 'preprod' AND treatment = 'T3' AND status = 'ACTIVE'`)[0];
  const viderCaches = async () => (await import('@/services/ai/prompt-conformity/caches')).invalidateCapabilityCaches();

  // ── Données : 3 équipements de 2 comptes, propriété vide, documents rattachés ──
  const equipements: Array<{ c: AccountRow; eq: number; attendu: number | null }> = [];
  async function equipement(c: AccountRow, texte: string, attendu: number | null) {
    const asset = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${asset.id}, 'Appareil') RETURNING id`;
    const f = await make.assetFile(c, { assetId: null });
    await sql`UPDATE asset_files SET retained_title = 'Pièce de l’appareil', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const [{ id: ext }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars) VALUES (${c.id}, ${f.id}, 'Pièce de l’appareil', NULL, '', 0) RETURNING id`;
    await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, coverage_status)
              VALUES (${c.id}, ${f.id}, ${ext}, 'u1', 'TEXT_BLOCK', 1, ${texte}, 'COVERED')`;
    await sql`INSERT INTO document_asset_links (account_id, file_id, equipment_id, link_role, origin, status) VALUES (${c.id}, ${f.id}, ${eq}, 'PRIMARY', 'USER', 'ACTIVE')`;
    equipements.push({ c, eq, attendu });
    return eq;
  }
  const valeurEq = async (c: AccountRow, eq: number) => {
    const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
    return (await getCanonicalEntityState({ type: 'EQUIPMENT', id: eq }, c.id))!.fields[PRIX.key]?.value ?? null;
  };

  beforeAll(async () => {
    const boot = await bootstrapE2eDatabase({ adminUrl: ADMIN!, database: BASE });
    // `@/db` lit DATABASE_URL à son premier import : registre de modules remis à zéro, `@/db` et les services
    // sont rechargés sur la base de CE scénario.
    envAvant.DATABASE_URL = process.env.DATABASE_URL;
    process.env.DATABASE_URL = boot.url;
    vi.resetModules();
    const { pgClient } = await import('@/db');
    sql = pgClient as unknown as postgres.Sql;
    make = factories(pgClient);
    const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    if (db !== BASE) throw new Error(`[l99b] base inattendue : ${db} (attendue ${BASE}) — @/db importé avant le changement de DATABASE_URL`);
    for (const k of ['NEXT_PUBLIC_APP_ENV', 'AI_PROMPT_CONFORMITY', 'AI_PROMPT_CONFORMITY_CONTRACTS', 'CORPUS_ACCOUNT_ID', 'COHERENCE_CAMPAIGN_MODE', 'T3_MISSING_PROPERTIES_PER_CALL']) envAvant[k] = process.env[k];
    process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
    process.env.AI_PROMPT_CONFORMITY = 'auto';
    process.env.AI_PROMPT_CONFORMITY_CONTRACTS = CONTRAT;
    process.env.COHERENCE_CAMPAIGN_MODE = 'corrective';
    process.env.T3_MISSING_PROPERTIES_PER_CALL = '40';
    const admin = await make.user({ role: 'ADMIN' });
    adminId = admin.id;
    session.adminId = admin.id;
    techAccount = (await make.account()).id;
    process.env.CORPUS_ACCOUNT_ID = String(techAccount);
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
    // Configuration de référence (préproduction) : T3 sur gemini-3.5-flash, repli gemini-2.5-flash.
    const svc = await import('@/services/ai/config/config-version.service');
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l99b référence' });
    const entries = v.entries.filter((e) => e.treatment === 'T3').map((e) => ({
      ...e, primaryModel: 'gemini-3.5-flash', reasoningPrimary: null, fallback1: 'gemini-2.5-flash', reasoningFallback1: null, fallback2: null, reasoningFallback2: null, operationProfiles: {},
    }));
    await svc.saveConfiguration(v.id, { expectedRevision: v.currentRevisionNumber, entries }, adminId);
    await svc.activate(v.id, adminId);
    baseVersionId = v.id;
    // Prompt T3 ACTIF (BO) : texte livré + étapes 1 et 7 du guide (blocs officiels), SANS le contrat v2.
    const { promptContracts } = await import('@/services/ai/prompt-conformity/contracts');
    const { applyCorrection } = await import('@/services/ai/prompt-conformity/correct');
    const { LEGACY_EXECUTION } = await import('@/services/ai/master-prompts/structured-context');
    let texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
    for (const id of ['t3-knowledge-query-v1', 'kq-constituants-complets-v1']) {
      const c = (await promptContracts()).find((x) => x.id === id)!;
      const plan = await c.plan({ text: texte, execution: LEGACY_EXECUTION, referenceText: null });
      const r = applyCorrection({ text: texte, execution: LEGACY_EXECUTION, steps: plan.ok ? plan.steps : [], protectedMarkers: [] });
      if (!r.ok) throw new Error(r.message);
      texte = r.text;
    }
    const mps = await import('@/services/ai/master-prompts/master-prompt.service');
    const d = await mps.startDraft('T3', adminId, texte);
    const act = await mps.activateDraft('T3', d.id, adminId);
    t3ActifId = act.activeVersionId;
    const { listFields } = await import('@/services/canonical/registry');
    const cat = await import('@/services/ai/reconciliation/missing-properties/catalog');
    PRIX = listFields(undefined, { targetType: 'EQUIPMENT' }).find((x) => x.valueType === 'money_eur' && !cat.exclusionOf(x, { type: 'EQUIPMENT', category: null, subtype: null }))!;
    expect(PRIX).toBeTruthy();
    const { FakeProvider, setAiProvider, getAiProvider } = await import('@/services/ai/gateway/providers');
    avantProvider = getAiProvider();
    provider = new FakeProvider();
    provider.onAny(repondre as never);
    setAiProvider(provider);
    const { QUALIFICATION_THRESHOLDS } = await import('@/services/ai/qualification/thresholds');
    seuils = { ...QUALIFICATION_THRESHOLDS, latency: { ...QUALIFICATION_THRESHOLDS.latency, maxP95Degradation: 1 } };
    await preparerCorpus();
    await viderCaches();
  }, 300_000);

  afterAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    if (avantProvider) setAiProvider(avantProvider);
    (await import('@/services/ai/provider/provider-secret')).setProviderSecretResolver(null);
    (await import('@/services/ai/qualification/cases')).__setQualificationCorpusForTests(null);
    (await import('@/services/ai/qualification/context')).__resetQualificationContextForTests();
    await sql`UPDATE ai_config_versions SET status = 'INACTIVE' WHERE environment = 'preprod' AND status = 'ACTIVE'`;
    await sql`UPDATE ai_master_prompt_versions SET status = 'PREVIOUS' WHERE environment = 'preprod' AND status = 'ACTIVE'`;
    (await import('@/services/ai/config/config-cache-version')).__setConfigVersionCounterStoreForTests(null);
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    await viderCaches();
    const { pgClient } = await import('@/db');
    await pgClient.end({ timeout: 5 }).catch(() => undefined);
    await dropE2eDatabase(ADMIN!, BASE, { force: true }).catch(() => undefined);
    for (const [k, v] of Object.entries(envAvant)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // Fichiers suivants (même processus) : `@/db` rechargé sur la base partagée.
    vi.resetModules();
  }, 120_000);

  it('L99B-E01 — détection, candidate complète, qualification de toutes les branches : T3 VALUE_CONFLICT non concluant → activation refusée', async () => {
    // Constat de départ : 3 équipements de 2 comptes en MISSING_PROPERTY_ARBITRATION_PENDING (contrat absent, aucun appel).
    const cA = await make.account({ plan: 'premium' });
    const cB = await make.account({ plan: 'premium' });
    await equipement(cA, `Facture d’achat de l’appareil. Total : ${V.ecrit} EUR`, V.valeur);
    await equipement(cA, 'Notice d’utilisation de l’appareil, sans indication de prix.', null);
    await equipement(cB, `Bon de commande. Montant : ${W.ecrit} EUR`, W.valeur);
    await runCoherenceFor(sql, [cA.id, cB.id], { mode: 'CORRECTIVE', today: AUJ });
    expect(reprise.appels).toBe(0);
    for (const e of equipements) {
      const p = (await proofOf(sql, e.c.id, CHECK_EQ, e.eq))!;
      expect(p).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'MISSING_PROPERTY_ARBITRATION_PENDING' }) });
    }

    const avantCfg = await configActive();
    const r = await passage();
    expect(r.mode).toBe('auto');
    const i = await issue();
    if (i.status !== 'BLOCKED') console.log('MOTIFS-E01', JSON.stringify(i.refusal_reasons));
    expect(i).toMatchObject({ status: 'BLOCKED', defect: 'ABSENT', fault_kind: 'PROMPT', treatment: 'T3', active_prompt_version_id: t3ActifId });
    expect(i.cause).toMatch(/88B-t3-proprietes-manquantes/);
    // Candidate : à partir de la version ACTIVE réelle, bloc officiel inséré, rien d'autre ne change.
    const [cand] = await sql<Json[]>`SELECT * FROM ai_master_prompt_versions WHERE id = ${i.candidate_prompt_version_id}`;
    expect(cand).toMatchObject({ origin: 'auto_conformity', status: 'PREVIOUS', based_on_id: t3ActifId });
    const actif = await t3Actif();
    expect(actif.id).toBe(t3ActifId);
    expect(cand.content).toContain(CONTRAT);
    expect(i.correction.diff.removed).toBe(0);
    expect(i.correction.diff.unified).toContain('+PROPRIÉTÉS MANQUANTES D’UN OBJET (contrat d’entrée t3-knowledge-query-v2)');
    expect(i.correction.verification).toEqual([]);
    const { guideBlock } = await import('@/services/ai/prompt-conformity/guide-blocks');
    expect(cand.content.replace(`${guideBlock(CONTRAT)!.text}\n\n`, '')).toBe(actif.content);
    // Qualification : TOUTES les opérations de T3, ancienne version ↔ candidate.
    expect(i.qualification.decision).toBe('INCONCLUSIVE');
    const ops = (i.qualification.operations as Json[]).map((o) => o.operationCode).sort();
    expect(ops).toEqual(['t3_document_naming', 't3_knowledge_query', 't3_link_ambiguity', 't3_operation_match', 't3_value_conflict']);
    // OPERATION_IDENTITY (étape 5 non faite) : branche absente des deux versions — hors périmètre, signalée.
    expect(i.qualification.excluded).toEqual([expect.objectContaining({ operationCode: 't3_operation_identity' })]);
    // Cas d'un contrat absent des DEUX versions (99C, étape 9 non faite) : hors périmètre — ni réussis, ni bloquants.
    const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { liveVariablesFor } = await import('@/services/ai/governance/master-corpus/live');
    const periode: string[] = [];
    for (const c of loadMasterCorpusCases(readMasterFileFromRepo).filter((x) => x.operationCode === 't3_document_naming' && x.qualificationRole === 'answer')) {
      if (JSON.stringify(await liveVariablesFor(c) ?? {}).includes('t3-naming-period-v1')) periode.push(`corpus:${c.id}`);
    }
    expect(periode.length).toBeGreaterThan(0);
    expect((i.qualification.excludedCases as Json[]).map((x) => x.caseId).sort()).toEqual([...periode].sort());
    const evid = await sql<Json[]>`SELECT q.case_id FROM ai_qualification_cases q JOIN ai_qualification_evidence e ON e.id = q.evidence_id WHERE e.campaign_id = ${i.campaign_id}`;
    expect(evid.length).toBeGreaterThan(0);
    expect(evid.map((x) => String(x.case_id)).filter((x) => periode.includes(x))).toEqual([]);
    expect((i.qualification.operations as Json[]).find((o) => o.operationCode === 't3_value_conflict')).toMatchObject({ candidateVerdict: 'INCONCLUSIVE', decision: 'INCONCLUSIVE' });
    expect(i.qualification.coverage).toMatchObject({ ok: true, passed: expect.arrayContaining(['corpus:P-T3-KQ-08', 'corpus:P-T3-KQ-09']) });
    expect((i.refusal_reasons as string[]).join(' ')).toMatch(/t3_value_conflict/);
    expect(i.decision).toMatch(/non-régression non démontrée/);
    // Rien n'est activé : ancienne version et configuration inchangées, candidate de configuration non concluante.
    expect(await configActive()).toBe(avantCfg);
    const [cv] = await sql<Json[]>`SELECT status, origin, candidate_state FROM ai_config_versions WHERE id = ${i.candidate_config_version_id}`;
    expect(cv).toMatchObject({ status: 'INACTIVE', origin: 'auto', candidate_state: 'INCONCLUSIVE' });
    expect(restorePoints.length).toBeGreaterThan(0);
    const kinds = (await evenements(i.id)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['DETECTED', 'CORRECTION_STARTED', 'CANDIDATE_CREATED', 'QUALIFICATION_STARTED', 'QUALIFICATION_RESULT']));
    // Supervision : une alerte, regroupée par contrat.
    const { collectAiConditions } = await import('@/services/admin/supervision-sweep.service');
    const alertes = (await collectAiConditions()).filter((x) => x.fingerprint === `ai:prompt-conformity:${CONTRAT}`);
    expect(alertes).toHaveLength(1);

    // Passage suivant, contexte inchangé : aucun nouvel essai (aucune campagne), occurrence regroupée.
    const n = await campagnes();
    await passage();
    expect(await campagnes()).toBe(n);
    const j = await issue();
    expect(j).toMatchObject({ status: 'BLOCKED', id: i.id });
    expect(j.occurrences).toBe(i.occurrences + 1);
    for (const e of equipements) expect((await proofOf(sql, e.c.id, CHECK_EQ, e.eq))!.last_result).toBe('FINDING');
  });

  it('L99B-E02 — régression injectée dans la candidate : activation refusée, motif précis', async () => {
    // Corpus enrichi (le test déclare une réponse de référence pour VALUE_CONFLICT) : le contexte change, nouvel essai permis.
    await preparerCorpus(new Set(['P-T3-01']));
    mode.regressionCandidate = true;
    const avant = await configActive();
    try {
      await passage();
    } finally {
      mode.regressionCandidate = false;
    }
    const i = await issue();
    expect(i.status).toBe('FAILED');
    expect(i.qualification.decision).toBe('REFUSED');
    const la = (i.qualification.operations as Json[]).find((o) => o.operationCode === 't3_link_ambiguity')!;
    expect(la.regressions.length).toBeGreaterThan(0);
    expect(la.decision).toBe('REFUSED');
    expect((i.refusal_reasons as string[]).join(' ')).toMatch(/t3_link_ambiguity/);
    expect(i.decision).toMatch(/dégrade un résultat/);
    expect(await configActive()).toBe(avant);
    expect((await t3Actif()).id).toBe(t3ActifId);
    const [cv] = await sql<Json[]>`SELECT status, candidate_state FROM ai_config_versions WHERE id = ${i.candidate_config_version_id}`;
    expect(cv).toMatchObject({ status: 'INACTIVE', candidate_state: 'REFUSED' });
    // Contexte inchangé : jamais réessayée.
    const n = await campagnes();
    await passage();
    expect(await campagnes()).toBe(n);
    expect((await issue()).status).toBe('FAILED');
  });

  it('L99B-E03 — qualification concluante : activation en préproduction, rattrapage des 3 équipements, anomalie fermée', async () => {
    const i0 = await issue();
    const { requestRetry } = await import('@/services/ai/prompt-conformity/service');
    await requestRetry(i0.id, adminId);
    const cfgAvant = await configActive();
    await passage();
    const i = await issue();
    // Diagnostic lisible en cas d'échec (motifs précis de refus).
    if (i.qualification.decision !== 'QUALIFIED') console.log('MOTIFS', JSON.stringify(i.refusal_reasons));
    expect(i.qualification.decision).toBe('QUALIFIED');
    expect(i.status).toBe('ACTIVATED');
    expect(i.previous_config_version_id).toBe(cfgAvant);
    expect(await configActive()).toBe(Number(i.candidate_config_version_id));
    const actif = await t3Actif();
    expect(actif).toMatchObject({ id: Number(i.candidate_prompt_version_id), origin: 'auto_conformity' });
    expect(actif.content).toContain(CONTRAT);
    const ev = await evenements(i.id);
    const activation = ev.find((e) => e.kind === 'ACTIVATED')!;
    expect(activation.payload).toMatchObject({ before: { promptVersionId: t3ActifId, configVersionId: cfgAvant }, after: { promptVersionId: Number(i.candidate_prompt_version_id) } });
    expect(activation.payload.caches).toEqual(expect.arrayContaining(['knowledge-query']));
    expect(ev.map((e) => e.kind)).toContain('CATCHUP');
    // Rattrapage : chaque propriété est écrite avec preuve, ou laissée vide avec une abstention justifiée.
    expect(i.catchup.summary).toMatchObject({ objectsInFinding: 3, written: 2, objectsWithWrite: 2, objectsAbstainedOnly: 1, residualFindings: 0 });
    // Les autres propriétés vides (aucune preuve) : abstentions justifiées, jamais une valeur inventée.
    expect(i.catchup.summary.abstained).toBeGreaterThan(0);
    expect((i.catchup.decisions as Json[]).filter((d) => d.decision === 'ABSTAINED').every((d) => typeof d.cause === 'string' && d.cause.length > 0)).toBe(true);
    for (const e of equipements) {
      const [d] = await sql<Json[]>`SELECT decision, cause, value_after, evidence_ids FROM property_recovery_decisions WHERE account_id = ${e.c.id} AND object_type = 'EQUIPMENT' AND object_id = ${e.eq} AND field_key = ${PRIX.key} ORDER BY id DESC LIMIT 1`;
      if (e.attendu === null) {
        expect(d).toMatchObject({ decision: 'ABSTAINED', cause: 'NOT_FOUND', value_after: null });
        expect(await valeurEq(e.c, e.eq)).toBeNull();
      } else {
        expect(d).toMatchObject({ decision: 'WRITTEN', value_after: e.attendu });
        expect((d.evidence_ids as number[]).length).toBeGreaterThan(0);
        expect(await valeurEq(e.c, e.eq)).toBe(e.attendu);
      }
      const p = (await proofOf(sql, e.c.id, CHECK_EQ, e.eq))!;
      expect(['FINDING', 'REPAIR_PENDING', 'REPAIR_SUPPRESSED', 'REPAIR_INEFFECTIVE']).not.toContain(p.last_result);
    }
    // Supervision : l'alerte de conformité disparaît (incompatibilité activée).
    const { collectAiConditions } = await import('@/services/admin/supervision-sweep.service');
    expect((await collectAiConditions()).some((x) => x.fingerprint === `ai:prompt-conformity:${CONTRAT}`)).toBe(false);
    // Écran BO (Configuration IA › Conformité des prompts).
    const { NextRequest } = await import('next/server');
    const route = await import('@/app/api/admin/ai/prompt-conformity/route');
    const res = await route.GET(new NextRequest('http://app.test/api/admin/ai/prompt-conformity') as never);
    expect(res.status).toBe(200);
    const body = await res.json() as Json;
    expect(body.issues.find((x: Json) => x.contractId === CONTRAT)).toMatchObject({ status: 'ACTIVATED', statusLabel: 'activée', faultLabel: 'défaut de prompt' });
    expect(body.registry.find((x: Json) => x.id === CONTRAT)).toMatchObject({ state: 'SATISFIED', blockIds: ['t3-knowledge-query-v2'] });
    expect(body.registry.length).toBeGreaterThanOrEqual(14);
  });

  it('L99B-E04 — régression simulée après activation : retour arrière automatique, candidate suspendue, aucun nouvel essai', async () => {
    const i0 = await issue();
    // Un nouvel équipement : sa reprise appelle T3 actif (candidate) qui rend une sortie refusée par le schéma.
    mode.invalidAfter = true;
    const cC = await make.account({ plan: 'premium' });
    const asset = await make.asset(cC, { category: 'IMMOBILIER', name: 'Maison' });
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${asset.id}, 'Appareil') RETURNING id`;
    const f = await make.assetFile(cC, { assetId: null });
    const [{ id: ext }] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars) VALUES (${cC.id}, ${f.id}, 'Pièce', NULL, '', 0) RETURNING id`;
    await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, coverage_status) VALUES (${cC.id}, ${f.id}, ${ext}, 'u1', 'TEXT_BLOCK', 1, ${`Total : ${V.ecrit} EUR`}, 'COVERED')`;
    await sql`INSERT INTO document_asset_links (account_id, file_id, equipment_id, link_role, origin, status) VALUES (${cC.id}, ${f.id}, ${eq}, 'PRIMARY', 'USER', 'ACTIVE')`;
    await runCoherenceFor(sql, [cC.id], { mode: 'CORRECTIVE', today: AUJ });
    mode.invalidAfter = false;
    const [inv] = await sql<Json[]>`SELECT count(*)::int AS n FROM ai_usage_event WHERE operation_code = 't3_knowledge_query' AND error_code = 'INVALID_OUTPUT' AND created_at >= ${i0.activated_at}`;
    expect(inv.n).toBeGreaterThan(0);
    await passage();
    const i = await issue();
    expect(i.status).toBe('ROLLED_BACK');
    expect(i.decision).toMatch(/Retour arrière automatique/);
    expect(i.post_check.after.invalid).toBeGreaterThan(0);
    expect(await configActive()).toBe(Number(i0.previous_config_version_id));
    expect((await t3Actif()).id).toBe(t3ActifId);
    const [cv] = await sql<Json[]>`SELECT status, candidate_state FROM ai_config_versions WHERE id = ${i0.candidate_config_version_id}`;
    expect(cv).toMatchObject({ status: 'INACTIVE', candidate_state: 'SUSPENDED' });
    expect((await evenements(i.id)).map((e) => e.kind)).toContain('ROLLED_BACK');
    // Diagnostics et preuves conservés ; contexte inchangé : aucun nouvel essai.
    expect(i.qualification.decision).toBe('QUALIFIED');
    const n = await campagnes();
    await passage();
    expect(await campagnes()).toBe(n);
    expect((await issue()).status).toBe('ROLLED_BACK');
    expect((await t3Actif()).id).toBe(t3ActifId);
  });
});
