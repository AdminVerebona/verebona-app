/**
 * Lot 99A — ticket P1 « T3 — Supprimer les appels IA redondants, fiabiliser
 * l'idempotence et alléger le journal du BO » : recette sur PostgreSQL réel.
 *
 * REPRODUCTION GÉNÉRIQUE DU CAS « COMPTE 13 » (valeurs neutres) : un bien
 * immobilier dont l'année de construction est vide, une seule preuve
 * « probable » (1948) — le moteur déterministe demande un arbitrage IA, le
 * modèle s'abstient (BUSINESS_ABSTENTION), un conflit reste ouvert. Avant le
 * lot 99A, chaque passage horaire rappelait le modèle (cache d'une heure non
 * renouvelable, mémoire lue après l'appel).
 *
 *   L99A-T01  deux passages identiques : 1 seul appel réel, même après expiration du cache ;
 *             abstention mémorisée ; arbitrage existant ni recréé ni réécrit ; compteurs distincts
 *   L99A-T02  nouvelle preuve pertinente : réévaluation (motif tracé) et correction appliquée
 *   L99A-T03  correction utilisateur prioritaire : aucune boucle (ni appel, ni conflit, ni réécriture)
 *   L99A-T04  passage du compte : `aiCalls` = appels RÉELS ; cache / réutilisations / sans appel distincts
 *             (journal du passage, rapport d'exécution, résumé du travail)
 *   L99A-T05  planification : un compte sans changement n'est plus remis en file ; changement,
 *             reprise, couverture exhaustive et rattrapage le remettent
 *   L99A-T06  relance forcée tracée (lancement manuel « Réévaluer avec l'IA »)
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';
import type { RecordedOutput } from '../replay-gateway';

const trace = {
  traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'],
};
const annee = (assetId: number, value: number, confidence: 'certain' | 'probable' = 'probable'): ProjectedFact => ({
  canonicalKey: 'constructionYear', rawKey: 'Année de construction', label: null, subject: null, attribute: null,
  rawValue: String(value), value, valueType: 'number', canonicalUnit: null,
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence, evidence: { excerpt: `Construit vers ${value}`, page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
});
const abstention: RecordedOutput = {
  operationCode: 't3_value_conflict', task: 'VALUE_CONFLICT', repeat: true,
  output: { task: 'VALUE_CONFLICT', decision: 'abstain', chosenEvidenceId: null, confidence: 'conflictual', reason: 'Une seule mention approximative : abstention.' },
};

scenario('L99A-T', 'T3 — appels IA redondants supprimés (cas « compte 13 » générique)', ({ sql, make, replay, useRecordings }) => {
  const avant = { idem: process.env.AI_IDEMPOTENCY_DISABLED };
  let reconcileAsset: typeof import('@/services/ai/reconciliation/reconciliation-engine').reconcileAsset;
  let persistProjectedFacts: typeof import('@/services/ai/source-analysis/steps/persist-evidence.step').persistProjectedFacts;
  beforeAll(async () => {
    // Cache des réponses ACTIF (le harnais le coupe par défaut) : c'est lui qui expirait.
    process.env.AI_IDEMPOTENCY_DISABLED = 'false';
    ({ reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine'));
    ({ persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step'));
  });
  afterAll(() => { process.env.AI_IDEMPOTENCY_DISABLED = avant.idem; });

  const appelsT3 = () => replay.calls.filter((c) => c.operationCode === 't3_value_conflict').length;
  const preuve = async (c: { id: number; ownerUserId: number }, assetId: number, value: number, run: number, confidence: 'certain' | 'probable' = 'probable', documentType = 'DIAGNOSTIC') => {
    const f = await make.assetFile(c as never, { assetId });
    await persistProjectedFacts({
      input: { sourceType: 'file', sourceIds: [f.id], accountId: c.id, userId: c.ownerUserId, mimeTypes: [], displayNames: [] },
      leadSourceId: f.id, trace, analysisRunId: run, documentType, facts: [annee(assetId, value, confidence)],
    });
    return f.id;
  };
  const passage = (accountId: number, userId: number, assetId: number) =>
    reconcileAsset({ accountId, userId, assetId, triggeredBy: 'scheduled' });
  const conflit = async (assetId: number) => (await sql<Array<{ id: number; status: string; updated_at: Date }>>`
    SELECT id, status, updated_at FROM inconsistency_registry WHERE asset_id = ${assetId} AND field_key = 'constructionYear' ORDER BY id`);
  const memoire = async (assetId: number) => sql<Array<{ id: number; status: string; outcome: string; reuse_count: number; ai_source: string; superseded_reason: string | null; forced: boolean }>>`
    SELECT id, status, outcome, reuse_count, ai_source, superseded_reason, forced FROM t3_decision_memory WHERE asset_id = ${assetId} ORDER BY id`;
  const compteur = async (accountId: number, kind: string) => Number((await sql<Array<{ n: string | null }>>`
    SELECT sum(count) AS n FROM ai_reuse_counters WHERE account_id = ${accountId} AND kind = ${kind}`)[0]?.n ?? 0);
  const valeur = async (assetId: number) => {
    const [r] = await sql<Array<{ kc: string | null }>>`SELECT key_characteristics AS kc FROM assets WHERE id = ${assetId}`;
    const kc = JSON.parse(r.kc ?? '{}') as Record<string, unknown>;
    return { value: kc.constructionYear ?? null, origin: kc.constructionYear__origin ?? null };
  };

  it('L99A-T01 : deux passages identiques → un seul appel réel, même après expiration du cache ; abstention mémorisée, arbitrage conservé', async () => {
    await useRecordings([abstention]);
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 1948, 9901);

    const r1 = await passage(c.id, c.ownerUserId, bien.id);
    expect(appelsT3()).toBe(1);
    const d1 = r1.decisions.find((d) => d.fieldKey === 'constructionYear')!;
    expect(d1).toMatchObject({ action: 'create_conflict', aiSource: 'PROVIDER', deterministic: false });
    expect(r1).toMatchObject({ providerCalls: 1, aiCacheHits: 0, decisionsReused: 0 });
    const [c1] = await conflit(bien.id);
    expect(c1.status).toBe('open');
    expect(await memoire(bien.id)).toMatchObject([{ status: 'ACTIVE', outcome: 'ABSTAIN', reuse_count: 0, ai_source: 'PROVIDER' }]);

    // Une heure plus tard : le cache temporaire a EXPIRÉ (ligne encore présente en base).
    await sql`UPDATE ai_operation_idempotency SET expires_at = now() - interval '1 second' WHERE key_hash LIKE ${`t3vc:a${c.id}:%`}`;
    const r2 = await passage(c.id, c.ownerUserId, bien.id);
    expect(appelsT3()).toBe(1); // aucun second appel réel
    expect(r2.decisions.find((d) => d.fieldKey === 'constructionYear')).toMatchObject({ action: 'create_conflict', aiSource: 'MEMORY' });
    expect(r2).toMatchObject({ providerCalls: 0, aiCacheHits: 0, decisionsReused: 1, conflictsUnchanged: 1 });
    // Arbitrage existant : même ligne, ni recréée ni réécrite.
    const lignes = await conflit(bien.id);
    expect(lignes).toHaveLength(1);
    expect(lignes[0].id).toBe(c1.id);
    expect(new Date(lignes[0].updated_at).getTime()).toBe(new Date(c1.updated_at).getTime());
    expect(await memoire(bien.id)).toMatchObject([{ status: 'ACTIVE', outcome: 'ABSTAIN', reuse_count: 1 }]);
    expect(await compteur(c.id, 'DECISION_REUSED')).toBe(1);

    // Journal du run local et rapport d'exécution : compteurs distincts.
    const [run] = await sql<Array<{ provider_calls: number; ai_cache_hits: number; decisions_reused: number; ai_review_count: number }>>`
      SELECT provider_calls, ai_cache_hits, decisions_reused, ai_review_count FROM reconciliation_runs WHERE id = ${r2.runId}`;
    expect(run).toEqual({ provider_calls: 0, ai_cache_hits: 0, decisions_reused: 1, ai_review_count: 1 });
    const [rapport] = await sql<Array<{ counters: Record<string, number>; sources: Record<string, unknown> }>>`
      SELECT counters, sources FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T3' AND reconciliation_run_id = ${r2.runId}`;
    expect(rapport.counters).toMatchObject({ aiProviderCalls: 0, aiCacheResponses: 0, aiDecisionsReused: 1 });
    expect(rapport.sources.aiUsage).toMatchObject({ providerCalls: 0, decisionsReused: 1, withoutAiCall: true, conflictsUnchanged: 1 });
  });

  it('L99A-T02 : une nouvelle preuve pertinente déclenche la réévaluation et permet la correction', async () => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 1948, 9911);
    await useRecordings([abstention]);
    await passage(c.id, c.ownerUserId, bien.id);
    await passage(c.id, c.ownerUserId, bien.id);
    expect(appelsT3()).toBe(1);

    // Nouvelle preuve (même valeur, autre document) : le contexte change → un appel, le modèle tranche.
    const nouvelle = await preuve(c, bien.id, 1948, 9912);
    const [ev] = await sql<Array<{ id: number }>>`SELECT id FROM field_evidence WHERE source_id = ${nouvelle} AND asset_id = ${bien.id}`;
    const choix = await useRecordings([{
      operationCode: 't3_value_conflict', task: 'VALUE_CONFLICT',
      output: { task: 'VALUE_CONFLICT', decision: 'choose', chosenEvidenceId: ev.id, confidence: 'certain', reason: 'Deux documents concordants.' },
    }]);
    const r = await passage(c.id, c.ownerUserId, bien.id);
    expect(choix.calls.filter((x) => x.operationCode === 't3_value_conflict')).toHaveLength(1);
    const d = r.decisions.find((x) => x.fieldKey === 'constructionYear');
    // Deux preuves concordantes : soit le déterministe tranche seul, soit le modèle — jamais une abstention figée.
    expect(['apply', 'keep']).toContain(d?.action);
    expect((await valeur(bien.id)).value).toBe(1948);
    const m = await memoire(bien.id);
    if (m.length > 1) expect(m[0]).toMatchObject({ status: 'SUPERSEDED', superseded_reason: expect.stringContaining('EVIDENCE_CHANGED') });
    expect((await conflit(bien.id)).every((x) => x.status !== 'open')).toBe(true);
  });

  it('L99A-T03 : une correction utilisateur reste prioritaire et ne provoque aucune boucle', async () => {
    await useRecordings([abstention]);
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 1948, 9921);
    await passage(c.id, c.ownerUserId, bien.id);
    expect(appelsT3()).toBe(1);

    const facade = await import('@/services/asset-details-write.service');
    await facade.updateAssetDetails({ assetId: bien.id, accountId: c.id, section: 'physical_characteristics', fields: { constructionYear: 1952 }, actorUserId: c.ownerUserId });
    expect(await valeur(bien.id)).toEqual({ value: 1952, origin: 'USER' });

    for (let i = 0; i < 3; i++) {
      const r = await passage(c.id, c.ownerUserId, bien.id);
      const d = r.decisions.find((x) => x.fieldKey === 'constructionYear');
      expect(d?.deterministic).toBe(true); // valeur USER : aucune revue IA
      expect(r.providerCalls).toBe(0);
    }
    expect(appelsT3()).toBe(1);
    expect(await valeur(bien.id)).toEqual({ value: 1952, origin: 'USER' });
    // Au plus un arbitrage ouvert, stable d'un passage à l'autre.
    const ouverts = (await conflit(bien.id)).filter((x) => x.status === 'open');
    expect(ouverts.length).toBeLessThanOrEqual(1);
  });

  it('L99A-T04 : passage du compte — appels réels, cache et réutilisations distincts (journal, résumé du travail)', async () => {
    await useRecordings([abstention]);
    const c = await make.account();
    const biens = [];
    for (let i = 0; i < 5; i++) {
      const b = await make.asset(c, { category: 'IMMOBILIER' });
      if (i === 0) await preuve(c, b.id, 1948, 9931);
      biens.push(b);
    }
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const p1 = await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
    expect(p1.aiCalls).toBe(1);
    const p2 = await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
    expect(appelsT3()).toBe(1);
    expect(p2).toMatchObject({ aiCalls: 0, decisionsReused: 1, aiCacheHits: 0 });
    const [j] = await sql<Array<{ ai_calls: number; provider_calls: number; ai_cache_hits: number; decisions_reused: number }>>`
      SELECT ai_calls, provider_calls, ai_cache_hits, decisions_reused FROM account_reconciliation_runs WHERE id = ${p2.runId}`;
    expect(j).toEqual({ ai_calls: 0, provider_calls: 0, ai_cache_hits: 0, decisions_reused: 1 });

    // Résumé du travail de file (File IA, exports) : même vérité.
    const { runT3Job } = await import('@/services/ai/reconciliation/t3-queue');
    const res = await runT3Job(
      { id: 990001, accountId: c.id, targetType: null, targetId: null, treatment: 'T3', origin: 'auto', triggerCode: 'schedule_hourly', payload: { payloadVersion: 1, kind: 'account', scope: 'incremental', scheduled: true }, createdAt: new Date(0), startedAt: new Date(), executionId: null } as never,
      { assertActive: async () => {} } as never,
      { reconcileAsset, reconcileAccount, enqueue: (async () => ({ jobId: null })) as never, listSweepAccounts: async () => [] },
    );
    expect(res.detail).toMatchObject({ aiCalls: 0, aiDecisionsReused: 1, aiCacheResponses: 0, withoutAiCall: true });
    expect(appelsT3()).toBe(1);
  });

  it('L99A-T05 : planification — sans changement, plus de remise en file ; changement, reprise et couverture la rétablissent', async () => {
    await useRecordings([abstention]);
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 1948, 9941);
    const { listSweepAccountsFromDb } = await import('@/services/ai/reconciliation/t3-queue');
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    // `since` dans le passé lointain : la règle de fraîcheur du cycle n'interfère pas.
    const dansBalayage = async () => (await listSweepAccountsFromDb({ since: new Date('2000-01-01T00:00:00Z'), afterAccountId: c.id - 1, limit: 1 })).includes(c.id);
    const fraicheur = async () => (await listSweepAccountsFromDb({ since: new Date(), afterAccountId: c.id - 1, limit: 1 })).includes(c.id);

    expect(await fraicheur()).toBe(true); // jamais rationalisé
    await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
    await sql`UPDATE account_reconciliation_runs SET finished_at = now() - interval '2 hours', started_at = now() - interval '2 hours' WHERE account_id = ${c.id}`;
    await sql`UPDATE assets SET updated_at = now() - interval '3 hours' WHERE id = ${bien.id}`;
    await sql`UPDATE field_evidence SET extracted_at = now() - interval '3 hours' WHERE account_id = ${c.id}`;
    await sql`UPDATE asset_files SET updated_at = now() - interval '3 hours' WHERE account_id = ${c.id}`;
    await sql`UPDATE document_facts SET created_at = now() - interval '3 hours' WHERE account_id = ${c.id}`;
    await sql`UPDATE inconsistency_registry SET updated_at = now() - interval '3 hours', created_at = now() - interval '3 hours' WHERE account_id = ${c.id}`;
    await sql`UPDATE to_process_actions SET updated_at = now() - interval '3 hours', created_at = now() - interval '3 hours' WHERE account_id = ${c.id}`;
    await sql`UPDATE account_knowledge_changes SET changed_at = now() - interval '3 hours' WHERE account_id = ${c.id}`;
    await sql`UPDATE document_asset_links SET updated_at = now() - interval '3 hours', created_at = now() - interval '3 hours' WHERE account_id = ${c.id}`;
    // Bien en portefeuille, contrôle « Informations » à jour, rien de changé depuis : pas remis en file.
    expect(await fraicheur()).toBe(false);

    // Changement pertinent (nouvelle preuve) → remis en file.
    await sql`UPDATE field_evidence SET extracted_at = now() WHERE account_id = ${c.id}`;
    expect(await fraicheur()).toBe(true);
    await sql`UPDATE field_evidence SET extracted_at = now() - interval '3 hours' WHERE account_id = ${c.id}`;
    // Reprise : dernier passage partiel.
    await sql`UPDATE account_reconciliation_runs SET status = 'partial' WHERE account_id = ${c.id}`;
    expect(await fraicheur()).toBe(true);
    await sql`UPDATE account_reconciliation_runs SET status = 'completed' WHERE account_id = ${c.id}`;
    // Carte « À traiter » arrivée à échéance depuis le dernier passage → remis en file.
    const [carte] = await sql<Array<{ id: number }>>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND resolved_at IS NULL LIMIT 1`;
    if (carte) {
      await sql`UPDATE to_process_actions SET due_date = now() - interval '1 minute' WHERE id = ${carte.id}`;
      expect(await fraicheur()).toBe(true);
      await sql`UPDATE to_process_actions SET due_date = NULL WHERE id = ${carte.id}`;
    }
    // Couverture exhaustive : dernier passage plus vieux que la période (24 h) → remis en file.
    await sql`UPDATE account_reconciliation_runs SET finished_at = now() - interval '25 hours' WHERE account_id = ${c.id}`;
    expect(await fraicheur()).toBe(true);
    await sql`UPDATE account_reconciliation_runs SET finished_at = now() - interval '2 hours' WHERE account_id = ${c.id}`;
    expect(await fraicheur()).toBe(false);
    // Rattrapage du contrôle « Informations » encore dû → remis en file.
    await sql`UPDATE t3_information_checks SET check_version = 'ancienne' WHERE asset_id = ${bien.id}`;
    expect(await fraicheur()).toBe(true);
    // Retour arrière : ancien périmètre (tout compte ayant un bien).
    await sql`UPDATE t3_information_checks SET check_version = ${(await import('@/services/ai/reconciliation/information-check/inventory')).INFORMATION_CHECK_VERSION} WHERE asset_id = ${bien.id}`;
    expect(await fraicheur()).toBe(false);
    process.env.T3_SWEEP_PREFILTER = '0';
    try { expect(await fraicheur()).toBe(true); } finally { delete process.env.T3_SWEEP_PREFILTER; }
    expect(await dansBalayage()).toBe(false);
  });

  it('L99A-T06 : relance forcée explicitement tracée (lancement manuel « Réévaluer avec l’IA »)', async () => {
    await useRecordings([abstention]);
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 1948, 9951);
    await passage(c.id, c.ownerUserId, bien.id);
    const r = await reconcileAsset({ accountId: c.id, userId: c.ownerUserId, assetId: bien.id, triggeredBy: 'manual', forceAiReview: { reason: 'relance forcée par l’administrateur #1 (job #1)' } });
    expect(appelsT3()).toBe(2);
    expect(r.providerCalls).toBe(1);
    const m = await memoire(bien.id);
    expect(m.map((x) => [x.status, x.forced])).toEqual([['SUPERSEDED', false], ['ACTIVE', true]]);
    expect(m[0].superseded_reason).toBe('FORCED');
    expect(await compteur(c.id, 'DECISION_FORCED')).toBe(1);
    // Le passage suivant, non forcé, réutilise.
    await passage(c.id, c.ownerUserId, bien.id);
    expect(appelsT3()).toBe(2);
    // Charge utile du lancement manuel : motif porté par le travail.
    const { enqueueT3Manual } = await import('@/services/ai/reconciliation/t3-queue');
    const jobId = await enqueueT3Manual(c.id, c.ownerUserId, 'full', undefined, { forceAiReview: true });
    const [j] = await sql<Array<{ payload: Record<string, unknown> }>>`SELECT payload FROM ai_job_queue WHERE id = ${jobId!}`;
    expect(j.payload.forceAiReview).toBe(`relance forcée par l’administrateur #${c.ownerUserId}`);
  });
});
