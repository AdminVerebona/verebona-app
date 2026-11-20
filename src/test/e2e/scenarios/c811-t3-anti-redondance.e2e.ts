/**
 * Carte #811 (écart P1-B du #596) — couverture anti-redondance sur PostgreSQL
 * réel, fournisseur simulé (recette R01, R02, R03, R09, R10, R11).
 *
 *   C811-B01  R01 — 24 passages horaires du même conflit stable (abstention), cache expiré à chaque passage :
 *             UN appel initial, 23 décisions réutilisées, arbitrage et carte ni recréés ni réécrits
 *   C811-B02  R02 — cache expiré SANS mémoire durable : renouvellement correct (nouvelle réponse), jamais un faux
 *             « servi du cache » ; dans la durée de vie : servi du cache
 *   C811-B03  R03 — configuration IA effective modifiée : recalcul ciblé, motif tracé (AI_CONFIG_CHANGED)
 *   C811-B04  R09 — balayage : après un passage RÉEL (rien n'est antidaté), un compte stable n'est pas remis en
 *             file — aucune boucle auto-entretenue par les écritures de T3 (conflit, carte, mémoire) ; une preuve
 *             nouvelle le remet en file et le travail est fait
 *   C811-B05  R09 / R11 — nommage : renommages appliqués puis stable (aucun rappel, aucune remise en file par les
 *             propres écritures du nommage) ; nom saisi par l'utilisateur jamais modifié ; nouveau document :
 *             remis en file et examiné
 *
 * Aucune réduction du contexte ni du volume d'examens du nommage (carte #780) : ces scénarios constatent.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCUMENT_TITLE_RULE_VERSION } from '@/lib/documents/document-title-rules';
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
const sortieAbstention = (reason: string) => ({ task: 'VALUE_CONFLICT', decision: 'abstain', chosenEvidenceId: null, confidence: 'conflictual', reason });
const abstention: RecordedOutput = { operationCode: 't3_value_conflict', task: 'VALUE_CONFLICT', repeat: true, output: sortieAbstention('Une seule mention approximative : abstention.') };

scenario('C811-B', 'T3 — anti-redondance : aucun rappel à contexte stable, réexamens légitimes préservés, aucune boucle auto-entretenue', ({ sql, make, replay, useRecordings }) => {
  const ENV = ['AI_IDEMPOTENCY_DISABLED', 'T3_DECISION_MEMORY_ENABLED', 'AI_DEGRADED_CALLS_PER_HOUR'] as const;
  const avant: Record<string, string | undefined> = {};
  let reconcileAsset: typeof import('@/services/ai/reconciliation/reconciliation-engine').reconcileAsset;
  let reconcileAccount: typeof import('@/services/ai/reconciliation/account-reconciliation.service').reconcileAccount;
  let listSweepAccountsFromDb: typeof import('@/services/ai/reconciliation/t3-queue').listSweepAccountsFromDb;
  beforeAll(async () => {
    for (const k of ENV) avant[k] = process.env[k];
    process.env.AI_IDEMPOTENCY_DISABLED = 'false';
    ({ reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine'));
    ({ reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service'));
    ({ listSweepAccountsFromDb } = await import('@/services/ai/reconciliation/t3-queue'));
  });
  afterAll(() => { for (const k of ENV) { if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k]; } });

  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const appelsT3 = () => replay.calls.filter((c) => c.operationCode === 't3_value_conflict').length;
  const preuve = async (c: { id: number; ownerUserId: number }, assetId: number, run: number) => {
    const f = await make.assetFile(c as never, { assetId });
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    await persistProjectedFacts({
      input: { sourceType: 'file', sourceIds: [f.id], accountId: c.id, userId: c.ownerUserId, mimeTypes: [], displayNames: [] },
      leadSourceId: f.id, trace, analysisRunId: run, documentType: 'DIAGNOSTIC', facts: [annee(assetId, 1948)],
    });
    return f.id;
  };
  const passage = (c: { id: number; ownerUserId: number }, assetId: number) => reconcileAsset({ accountId: c.id, userId: c.ownerUserId, assetId, triggeredBy: 'scheduled' });
  const expirerLeCache = () => sql`UPDATE ai_operation_idempotency SET expires_at = now() - interval '1 second' WHERE key_hash NOT LIKE 'help-corpus:%' AND key_hash NOT LIKE 'resources-corpus:%'`;
  /** Le compte a-t-il du travail T3 selon le préfiltre du balayage ? (`since` dans le futur : seule la règle « besoin » joue.) */
  const besoin = async (accountId: number) => (await listSweepAccountsFromDb({ since: new Date(Date.now() + 3_600_000), afterAccountId: accountId - 1, limit: 1 })).includes(accountId);
  const etatArbitrage = async (accountId: number, assetId: number) => ({
    conflits: await sql<Array<{ id: number; status: string; updated_at: Date }>>`SELECT id, status, updated_at FROM inconsistency_registry WHERE asset_id = ${assetId} AND field_key = 'constructionYear' ORDER BY id`,
    cartes: await sql<Array<{ id: number; updated_at: Date; resolved_at: Date | null }>>`SELECT id, updated_at, resolved_at FROM to_process_actions WHERE account_id = ${accountId} ORDER BY id`,
  });

  it('C811-B01 (R01) : 24 passages horaires du même conflit stable, abstention comprise → un appel initial, 23 décisions réutilisées, rien de recréé ni réécrit', async () => {
    await useRecordings([abstention]);
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 98601);
    const r1 = await passage(c, bien.id);
    expect(r1).toMatchObject({ providerCalls: 1, aiCountersSemantics: 'MEASURED_V1' });
    const reference = await etatArbitrage(c.id, bien.id);
    expect(reference.conflits).toHaveLength(1);
    let reutilisees = 0;
    for (let heure = 2; heure <= 24; heure++) {
      await expirerLeCache(); // le cache d'une heure a expiré à chaque passage horaire
      const r = await passage(c, bien.id);
      expect(r.providerCalls, `passage ${heure}`).toBe(0);
      expect(r.aiLogicalRequests, `passage ${heure}`).toBe(0);
      expect(r.decisions.find((d) => d.fieldKey === 'constructionYear')).toMatchObject({ action: 'create_conflict', aiSource: 'MEMORY' });
      reutilisees += r.decisionsReused ?? 0;
    }
    expect(appelsT3()).toBe(1);
    expect(reutilisees).toBe(23);
    const [m] = await sql<Array<{ status: string; outcome: string; reuse_count: number }>>`SELECT status, outcome, reuse_count FROM t3_decision_memory WHERE asset_id = ${bien.id}`;
    expect(m).toEqual({ status: 'ACTIVE', outcome: 'ABSTAIN', reuse_count: 23 });
    // Ni nouveau conflit, ni réécriture : mêmes lignes, mêmes horodatages.
    const fin = await etatArbitrage(c.id, bien.id);
    expect(fin.conflits.map((x) => [x.id, x.status, new Date(x.updated_at).getTime()])).toEqual(reference.conflits.map((x) => [x.id, x.status, new Date(x.updated_at).getTime()]));
    expect(fin.cartes.map((x) => [x.id, new Date(x.updated_at).getTime(), x.resolved_at])).toEqual(reference.cartes.map((x) => [x.id, new Date(x.updated_at).getTime(), x.resolved_at]));
    // Événements d'usage : un seul sur les 24 heures.
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM ai_usage_event WHERE account_id = ${c.id} AND operation_code = 't3_value_conflict'`;
    expect(n).toBe(1);
  });

  it('C811-B02 (R02) : cache expiré sans mémoire durable → renouvellement correct, jamais un faux « servi du cache »', async () => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 98602);
    process.env.T3_DECISION_MEMORY_ENABLED = '0';
    process.env.AI_DEGRADED_CALLS_PER_HOUR = 'off';
    try {
      const r = await useRecordings([
        { operationCode: 't3_value_conflict', task: 'VALUE_CONFLICT', output: sortieAbstention('Réponse A') },
        { operationCode: 't3_value_conflict', task: 'VALUE_CONFLICT', output: sortieAbstention('Réponse B') },
      ]);
      const p1 = await passage(c, bien.id);
      expect(p1).toMatchObject({ providerCalls: 1, aiCacheHits: 0 });
      // Dans la durée de vie du cache : servi du cache, aucun appel.
      const p2 = await passage(c, bien.id);
      expect(p2).toMatchObject({ providerCalls: 0, aiCacheHits: 1 });
      expect(r.calls).toHaveLength(1);
      // Cache expiré : la demande repart au fournisseur (UNE fois) et l'entrée est renouvelée avec la NOUVELLE réponse.
      await expirerLeCache();
      const p3 = await passage(c, bien.id);
      expect(p3).toMatchObject({ providerCalls: 1, aiCacheHits: 0 });
      expect(r.calls).toHaveLength(2);
      const lignes = await sql<Array<{ state: string; renewed_count: number; reason: string | null; vivant: boolean }>>`
        SELECT state, renewed_count, result_json->'data'->>'reason' AS reason, expires_at > now() AS vivant
          FROM ai_operation_idempotency WHERE result_json->>'traceId' IS NOT NULL AND result_json->'data'->>'task' = 'VALUE_CONFLICT' AND expires_at > now()`;
      expect(lignes).toEqual([{ state: 'READY', renewed_count: 1, reason: 'Réponse B', vivant: true }]);
      const p4 = await passage(c, bien.id);
      expect(p4).toMatchObject({ providerCalls: 0, aiCacheHits: 1 });
      expect(r.calls).toHaveLength(2);
    } finally { delete process.env.T3_DECISION_MEMORY_ENABLED; delete process.env.AI_DEGRADED_CALLS_PER_HOUR; }
  });

  it('C811-B03 (R03) : configuration IA effective modifiée → recalcul ciblé, motif tracé ; puis de nouveau stable', async () => {
    await useRecordings([abstention]);
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 98603);
    await passage(c, bien.id);
    await passage(c, bien.id);
    expect(appelsT3()).toBe(1);
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const espion = vi.spyOn(AiGateway, 'effectiveConfigSignature').mockResolvedValue('t3_master_v1@pv999:nouveau#0123456789abcdef');
    try {
      const r = await passage(c, bien.id);
      expect(appelsT3()).toBe(2);
      expect(r.providerCalls).toBe(1);
      const m = await sql<Array<{ status: string; superseded_reason: string | null; ai_config_signature: string }>>`
        SELECT status, superseded_reason, ai_config_signature FROM t3_decision_memory WHERE asset_id = ${bien.id} ORDER BY id`;
      expect(m.map((x) => [x.status, x.superseded_reason])).toEqual([['SUPERSEDED', 'AI_CONFIG_CHANGED'], ['ACTIVE', null]]);
      expect(m[1].ai_config_signature).toBe('t3_master_v1@pv999:nouveau#0123456789abcdef');
      const [{ n }] = await sql<Array<{ n: string | null }>>`SELECT sum(count) AS n FROM ai_reuse_counters WHERE account_id = ${c.id} AND kind = 'DECISION_REEVALUATED'`;
      expect(Number(n)).toBe(1);
      // Même configuration au passage suivant : réutilisation.
      const r2 = await passage(c, bien.id);
      expect(r2).toMatchObject({ providerCalls: 0, decisionsReused: 1 });
      expect(appelsT3()).toBe(2);
    } finally { espion.mockRestore(); }
  });

  it('C811-B04 (R09) : balayage — après un passage réel, un compte stable n’est pas remis en file (aucune boucle auto-entretenue) ; une preuve nouvelle le remet et le travail est fait', async () => {
    await useRecordings([abstention]);
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER' });
    await preuve(c, bien.id, 98604);
    expect(await besoin(c.id)).toBe(true); // jamais rationalisé
    for (let i = 1; i <= 4; i++) {
      const p = await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
      expect(p.status).toBe('completed');
      expect(p.providerCalls, `passage ${i}`).toBe(i === 1 ? 1 : 0);
      await attendre(250); // laisse retomber les écritures non attendues du passage
      // Rien n'est antidaté : les écritures de T3 lui-même (conflit, carte « À traiter », mémoire, journal, nommage) ne
      // constituent pas un « changement » qui relancerait le compte.
      expect(await besoin(c.id), `après le passage ${i}`).toBe(false);
    }
    expect(appelsT3()).toBe(1);
    // Changement pertinent (nouvelle preuve, autre document) : remis en file, réexaminé, et le travail est fait.
    await preuve(c, bien.id, 98605);
    expect(await besoin(c.id)).toBe(true);
    const p = await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
    expect(p.objectsExamined).toBeGreaterThan(0);
    const m = await sql<Array<{ status: string; superseded_reason: string | null }>>`SELECT status, superseded_reason FROM t3_decision_memory WHERE asset_id = ${bien.id} ORDER BY id`;
    // Soit le déterministe tranche seul (deux preuves concordantes), soit la décision est réévaluée pour preuve nouvelle — jamais une abstention figée réutilisée à tort.
    const d = (await sql<Array<{ action: string }>>`SELECT action FROM reconciliation_decisions WHERE account_id = ${c.id} AND asset_id = ${bien.id} AND field_key = 'constructionYear' ORDER BY id DESC LIMIT 1`)[0];
    expect(m.length === 1 ? d.action !== 'create_conflict' || m[0].status === 'ACTIVE' : m[0].superseded_reason?.includes('EVIDENCE_CHANGED')).toBeTruthy();
    await attendre(250);
    expect(await besoin(c.id)).toBe(false);
  });

  it('C811-B05 (R09 / R11) : nommage — renommé puis stable (aucun rappel, aucune remise en file par ses propres écritures) ; nom de l’utilisateur intact ; nouveau document examiné', async () => {
    const fichier = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: 9811, treatment: 'T3', versionNumber: 11, content: fichier }]);
    const appels: Array<{ op: string; aExaminer: number[] }> = [];
    let noms: Record<number, string> = {};
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider({
      name: 'replay', isConfigured: () => true,
      async call(input: { prompt: string; operationCode?: string }) {
        if (input.operationCode !== 't3_document_naming') throw new Error(`appel inattendu : ${input.operationCode}`);
        const docs = JSON.parse(/^Candidats : (.*)$/m.exec(input.prompt)![1]) as Array<{ documentId: number; role: string; currentName: string }>;
        appels.push({ op: input.operationCode, aExaminer: docs.filter((d) => d.role === 'TO_EXAMINE').map((d) => d.documentId) });
        return {
          rawText: JSON.stringify({ task: 'DOCUMENT_NAMING', document_renames: docs.filter((d) => d.role === 'TO_EXAMINE' && noms[d.documentId]).map((d) => ({
            document_id: d.documentId, expected_current_name: d.currentName, proposed_name: noms[d.documentId],
            reference_document_ids: docs.filter((x) => x.documentId !== d.documentId).map((x) => x.documentId).slice(0, 3),
            reason: 'Convention de la famille (nature, émetteur, période)', confidence: 'certain',
          })) }),
          inputTokens: 300, outputTokens: 80,
        };
      },
    } as never);
    try {
      const c = await make.account();
      const maison = await make.asset(c, { category: 'LOGEMENT', name: 'Maison Lilas' });
      const doc = async (nom: string, date: string, source: 'SYSTEM' | 'USER' = 'SYSTEM') => {
        const [f] = await sql<Array<{ id: number }>>`
          INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, retained_title, supplier, document_type_code, document_date,
                                   analysis_state, last_analysis_at, title_source, title_rule_version, title_context_fingerprint, title_checked_at)
          VALUES (${c.ownerUserId}, ${c.id}, ${maison.id}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'application/pdf', ${nom}, 'Orange',
                  'INVOICE', ${date}, 'ANALYZED', now() - interval '1 hour', ${source}, ${DOCUMENT_TITLE_RULE_VERSION}, 'e2e', now()) RETURNING id`;
        await sql`INSERT INTO document_extractions (account_id, file_id, title, supplier_name, document_date, document_type_code, full_text, extracted_at)
                  VALUES (${c.id}, ${f.id}, ${nom}, 'Orange', ${date}, 'INVOICE', 'Facture Orange', now() - interval '1 hour')`;
        return f.id;
      };
      const nom = async (id: number) => (await sql<Array<{ t: string }>>`SELECT retained_title AS t FROM asset_files WHERE id = ${id}`)[0].t;
      const mars = await doc('Facture_Orange_03-2024.pdf', '2024-03-12');
      const avril = await doc('Orange facture avril 2024', '2024-04-12');
      const saisi = await doc('Ma facture Orange de mai (à garder)', '2024-05-12', 'USER');
      noms = { [mars]: 'Facture Orange — mars 2024', [avril]: 'Facture Orange — avril 2024', [saisi]: 'Facture Orange — mai 2024' };

      const p1 = await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
      expect(p1.phases?.DOCUMENT_NAMING?.status).toBe('DONE');
      expect(await nom(mars)).toBe('Facture Orange — mars 2024');
      expect(await nom(avril)).toBe('Facture Orange — avril 2024');
      // Nom saisi par l'utilisateur : jamais modifié, même si le modèle le propose.
      expect(await nom(saisi)).toBe('Ma facture Orange de mai (à garder)');
      const apres1 = appels.length;
      expect(apres1).toBeGreaterThanOrEqual(1);
      // Mesure du passage : la phase de nommage porte ses requêtes ; `aiCalls` de la phase reste sa demande déclarée.
      expect(p1.aiActivity?.byPhase.DOCUMENT_NAMING?.networkRequests).toBe(apres1);
      expect(p1.aiActivity?.byOperation.t3_document_naming?.networkRequests).toBe(apres1);
      expect(p1.phases?.DOCUMENT_NAMING?.counts).toMatchObject({ providerNetworkRequests: apres1, aiCalls: apres1 });

      // Les renommages écrits par T3 (asset_files.updated_at) ne remettent pas le compte en file ; passages suivants : aucun rappel.
      for (let i = 2; i <= 5; i++) {
        await attendre(250);
        expect(await besoin(c.id), `après le passage ${i - 1}`).toBe(false);
        const p = await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
        expect(p.phases?.DOCUMENT_NAMING?.status, `passage ${i}`).toBe('DONE');
        expect(p.providerCalls, `passage ${i}`).toBe(0);
      }
      expect(appels).toHaveLength(apres1);
      expect(await nom(saisi)).toBe('Ma facture Orange de mai (à garder)');

      // Lot « nouveau » : un document arrive → remis en file, examiné (les autres en référence), jamais un faux « rien à faire ».
      const juin = await doc('Facture Orange du 12/06/2024', '2024-06-12');
      noms = { ...noms, [juin]: 'Facture Orange — juin 2024' };
      expect(await besoin(c.id)).toBe(true);
      const p6 = await reconcileAccount(c.id, { type: 'scheduled' }, { triggerCode: 'schedule_hourly' });
      expect(p6.phases?.DOCUMENT_NAMING?.status).toBe('DONE');
      expect(appels.length).toBeGreaterThan(apres1);
      expect(appels.slice(apres1).flatMap((a) => a.aExaminer)).toContain(juin);
      expect(await nom(juin)).toBe('Facture Orange — juin 2024');
      expect(await nom(mars)).toBe('Facture Orange — mars 2024');
      await attendre(250);
      expect(await besoin(c.id)).toBe(false);
    } finally {
      __setActiveMasterPromptsForTests(null);
      await useRecordings([]);
    }
  });
});
