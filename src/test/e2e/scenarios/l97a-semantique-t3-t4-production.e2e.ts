/**
 * Lot 97A — réévaluations sémantiques T3 / T4 sur la chaîne de PRODUCTION
 * (PostgreSQL 16 réel) : opérations du registre `t3_operation_identity` et
 * `t4_agenda_representation`, passerelle IA réelle (fournisseur SIMULÉ par
 * le harnais de rejeu, aucun réseau), activation par marqueur dans la
 * version ACTIVE du prompt maître (texte du guide du PO collé tel quel),
 * traces d'exécution et journal 0752.
 *
 *   L97A-E2E-01  T4 : prompt actif sans le bloc 6 → « contrat en attente » (MARKER_MISSING), aucun appel ;
 *                bloc 6 sans la TASK cochée → toujours en attente (TASK_NOT_ALLOWED) ;
 *                bloc 6 + t4_input_v3 / t4_output_v4 → appel par la passerelle (contexte structuré validé),
 *                décision appliquée (un seul événement, preuves conservées), trace et journal ; rejoué : aucun appel
 *   L97A-E2E-02  T3 : prompt actif sans le bloc 5 → constat MULTI_SOURCE_IDENTITY (BRANCH_MISSING), aucune écriture ;
 *                bloc 5 → demande en attente, traitée par le passage T3 (file) : appel, validation, décision de
 *                rattachement AI_IDENTITY, document séparé par la consolidation existante ; rejoué : aucun appel
 *   L97A-E2E-03  T3 : réponse qui déplacerait un document rattaché par l'utilisateur → refusée en bloc, aucune écriture
 *   L97A-E2E-04  migration 0836 rejouable ; origine AI_IDENTITY jamais comptée comme décision de l'utilisateur
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import type { AccountRow, AssetRow } from '../factories';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';
import { cand, cible, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJ = '2026-10-24';
const RACINE = process.cwd();
const GUIDE = readFileSync(join(RACINE, 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'), 'utf-8');
const LIVRE = {
  t3: readFileSync(join(RACINE, 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf-8'),
  t4: readFileSync(join(RACINE, 'src/services/ai/prompts/agenda/t4_master_v1.txt'), 'utf-8'),
};
function avecBloc(texte: string, id: string): string {
  const m = new RegExp(`<!-- l89c:bloc ([^>]*?id="${id}"[^>]*?) -->\\s*\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``).exec(GUIDE);
  if (!m) throw new Error(`bloc ${id} absent`);
  const anchor = /anchor="([^"]*)"/.exec(m[1])![1];
  return texte.replace(anchor, `${m[2]}\n\n${anchor}`);
}
const V3V4 = { mode: 'STRUCTURED_CONTEXT' as const, inputContractVersion: 't4_input_v3', outputContractVersion: 't4_output_v4', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY', 'AGENDA_REPRESENTATION'] };
const V2V3 = { ...V3V4, inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] };

const appels = { t4: [] as Json[], t3: [] as string[] };
/** T4 simulé : lit le contexte structuré RÉEL injecté par la passerelle et regroupe tous les éléments à décider. */
function t4Representation(input: ProviderCallInput): unknown {
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { agenda_representation: { agendaItems: Array<{ ref: string; inScope: boolean; role: string | null }> } };
  appels.t4.push(ctx);
  const items = ctx.agenda_representation.agendaItems.filter((x) => x.inScope);
  const keep = (items.find((x) => x.role === 'PRINCIPAL') ?? items[0]).ref;
  return {
    task: 'AGENDA_REPRESENTATION', outcome: 'DECIDED', restorations: [], identityConcern: null, reason: 'Une seule réparation (e2e).',
    occurrences: [{ items: items.map((x) => x.ref), keep, role: 'PRINCIPAL', confidence: 'certain', evidence: [], reason: 'Même réparation décrite deux fois.' }],
  };
}
const t3 = { decision: 'SEPARATE' as 'SEPARATE' | 'KEEP' };
function t3Identite(input: ProviderCallInput): unknown {
  appels.t3.push(input.prompt);
  return {
    task: 'OPERATION_IDENTITY', outcome: t3.decision === 'KEEP' ? 'CONFIRMED' : 'REVISED', reason: 'Décision simulée (e2e).',
    sources: [
      { source: 'S1', decision: 'KEEP', targetOperation: null, confidence: 'certain', evidence: [], reason: 'Source fondatrice.' },
      { source: 'S2', decision: t3.decision, targetOperation: null, confidence: 'certain', evidence: [], reason: 'Autre réalité (e2e).' },
    ],
  };
}

scenario('L97A', 'Réévaluations sémantiques T3 / T4 branchées sur le registre IA (activation par marqueur)', ({ sql, make }) => {
  let k: OperationsKit;
  const runtime = () => import('@/services/ai/master-prompts/master-prompt-runtime');
  async function activer(prompts: Array<{ treatment: 'T3' | 'T4'; content: string; execution?: Json | null }>) {
    (await runtime()).__setActiveMasterPromptsForTests(prompts.map((p, i) => ({ id: 97_000 + i, versionNumber: 70 + i, ...p })) as never);
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
    (await import('@/services/business-operations/semantic/decider')).__resetRepresentationCapabilityCacheForTests();
    (await import('@/services/business-operations/semantic/identity-decider')).__resetIdentityCapabilityCacheForTests();
  }
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
    setDefaultResponder('t4_agenda_representation', 'AGENDA_REPRESENTATION', t4Representation);
    setDefaultResponder('t3_operation_identity', 'OPERATION_IDENTITY', t3Identite);
    // Rapprochement M3 éventuel du document séparé : « autre réalité » (aucune fusion).
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', () => ({
      task: 'OPERATION_MATCH', decision: 'DISTINCT_OPERATION', matchedCandidateId: null, confidence: 'certain', concordantSignals: [], contradictions: ['autre réalité'], reason: 'e2e',
    }));
  });
  afterEach(async () => {
    appels.t4 = []; appels.t3 = []; t3.decision = 'SEPARATE';
    (await import('@/services/business-operations/events')).resetBusinessOperationEventBusForTests();
  });
  afterAll(async () => {
    setDefaultResponder('t4_agenda_representation', 'AGENDA_REPRESENTATION', null);
    setDefaultResponder('t3_operation_identity', 'OPERATION_IDENTITY', null);
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', null);
    (await runtime()).__setActiveMasterPromptsForTests(null);
    (await import('@/services/ai/config/config-resolver')).invalidateConfigCache();
  });

  async function contexte(): Promise<{ compte: AccountRow; maison: AssetRow }> {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    return { compte, maison };
  }
  /** Deux documents d'une même Opération (référence de facture commune) : facture puis rapport d'intervention. */
  async function deuxDocuments(c: { compte: AccountRow; maison: AssetRow }) {
    const doc = (summary: string, type: string) => k.document(c.compte, c.maison.id, [cand({
      summary, provider: 'Plomberie Durand', targetHints: [cible(c.maison.id)], businessReferences: [ref('INVOICE', 'F-97-01')], temporalHints: { realizedDate: '2026-03-20' },
    })], { type, title: summary, date: '2026-03-20' });
    const f1 = await doc('Réparation fuite cuisine', 'WORKS_INVOICE');
    const f2 = await doc('Rapport d’intervention fuite', 'INTERVENTION_REPORT');
    await k.passer(c.compte, { today: AUJ });
    const ops = await k.actives(c.compte);
    expect(ops).toHaveLength(1);
    return { f1, f2, op: ops[0].id };
  }
  const reevaluations = (compte: AccountRow, scope: 'T3' | 'T4') => sql<Json[]>`
    SELECT id, status, reason, contract_version, decider_version, ai_calls, ai_trace_id, context_summary, mutations_applied, mutations_refused, validation, ai_output
      FROM operation_semantic_reevaluations WHERE account_id = ${compte.id} AND scope = ${scope} ORDER BY id`;
  const traces = (compte: AccountRow, op: string) => sql<Json[]>`
    SELECT operation_code, status FROM ai_usage_event WHERE account_id = ${compte.id} AND operation_code = ${op} ORDER BY id`;

  it('L97A-E2E-01 — T4 : en attente sans marqueur ni TASK cochée ; avec le bloc 6 et v3 / v4, décision par la passerelle, appliquée et tracée', async () => {
    const c = await contexte();
    const { f1, f2, op } = await deuxDocuments(c);
    const evt = (fileId: number, title: string) => ({
      action: 'create', title, date: '2026-03-20', category: 'information', confidence: 'certain', reasonCode: 'NEW_EVENT', deterministic: true,
      sourceFileId: fileId, nature: 'HISTORICAL', businessType: 'repair', occurrenceIndex: '2026-03-20', target: { type: 'ASSET', id: c.maison.id }, sources: [{ fileId, role: 'SOURCE' }],
    });
    const persistence = await import('@/services/agenda/agenda-persistence');
    await persistence.persistAgendaDecisions([evt(f1, 'Réparation — Maison')] as never[], c.compte.id, c.maison.id, { sourceFileId: f1, analysisComplete: true });
    await persistence.persistAgendaDecisions([evt(f2, 'Intervention plombier')] as never[], c.compte.id, c.maison.id, { sourceFileId: f2, analysisComplete: true });
    const sem = await import('@/services/business-operations/semantic/orchestrator');
    const reevaluer = () => sem.reevaluateRepresentation({ accountId: c.compte.id, operationId: op, trigger: 'MANUAL', today: AUJ, extraItemIds: [] });

    // a) Prompt T4 actif = texte livré (v2 / v3) : contrat en attente, aucun appel.
    await activer([{ treatment: 'T4', content: LIVRE.t4, execution: V2V3 }]);
    expect(await reevaluer()).toMatchObject({ status: 'UNAVAILABLE', reason: 'CONTRACT_PENDING', aiCalls: 0 });
    expect((await reevaluations(c.compte, 'T4')).at(-1)!.context_summary).toMatchObject({ contractState: 'MARKER_MISSING' });
    // b) Bloc 6 collé mais TASK non cochée (contrats v2 / v3) : toujours en attente.
    await activer([{ treatment: 'T4', content: avecBloc(LIVRE.t4, 't4-agenda-representation-v1'), execution: V2V3 }]);
    expect(await reevaluer()).toMatchObject({ status: 'UNAVAILABLE', aiCalls: 0 });
    // Même constat d'attente pour le même contexte : pas de seconde ligne au journal ; le détail est celui de la capacité.
    expect(await (await import('@/services/business-operations/semantic/decider')).productionRepresentationDecider.capability())
      .toMatchObject({ available: false, reason: 'CONTRACT_PENDING', contractState: 'TASK_NOT_ALLOWED' });
    expect(await reevaluations(c.compte, 'T4')).toHaveLength(1);
    expect(appels.t4).toHaveLength(0);

    // c) Bloc 6 + t4_input_v3 / t4_output_v4 + TASK cochée : appel RÉEL par la passerelle, décision appliquée.
    await activer([{ treatment: 'T4', content: avecBloc(LIVRE.t4, 't4-agenda-representation-v1'), execution: V3V4 }]);
    const r = await reevaluer();
    expect(r).toMatchObject({ status: 'APPLIED', aiCalls: 1 });
    expect(appels.t4).toHaveLength(1);
    expect(appels.t4[0]).toMatchObject({ task: 'AGENDA_REPRESENTATION', agenda_representation: { contractVersion: 't4-agenda-representation-v1', task: 'AGENDA_REPRESENTATION' } });
    const evts = await sql<Json[]>`SELECT id, business_operation_id::int AS op, operation_role FROM agenda_items WHERE account_id = ${c.compte.id} ORDER BY id`;
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ op, operation_role: 'PRINCIPAL' });
    const j = (await reevaluations(c.compte, 'T4')).at(-1)!;
    expect(j).toMatchObject({ status: 'APPLIED', ai_calls: 1, contract_version: 't4-agenda-representation-v1' });
    expect(j.decider_version).toMatch(/^t4_master_v1@pv/);
    expect(j.ai_trace_id).toBeTruthy();
    expect((await traces(c.compte, 't4_agenda_representation')).length).toBeGreaterThanOrEqual(1);
    // d) Rejoué : mémoire (état produit par la décision) — aucun nouvel appel.
    await reevaluer();
    expect(appels.t4).toHaveLength(1);
  });

  it('L97A-E2E-02 — T3 : constat sans le bloc 5 ; avec lui, demande traitée par le passage T3, décision AI_IDENTITY, document séparé par la consolidation existante', async () => {
    const c = await contexte();
    const { f1, f2, op } = await deuxDocuments(c);
    const sem = await import('@/services/business-operations/semantic/orchestrator');
    const demander = () => sem.requestIdentityReevaluation({ accountId: c.compte.id, operationIds: [op], trigger: 'MANUAL', reason: 'e2e : identité à vérifier', enqueue: false });

    // a) Prompt T3 actif = texte livré : constat d'avant (MULTI_SOURCE_IDENTITY), aucune écriture métier.
    await activer([{ treatment: 'T3', content: LIVRE.t3 }]);
    expect(await demander()).toMatchObject({ requested: [], unsupported: [expect.objectContaining({ reason: 'MULTI_SOURCE_IDENTITY', aiContract: '87B-t3-identite-multi-operations' })] });
    expect((await reevaluations(c.compte, 'T3')).at(-1)).toMatchObject({ status: 'UNAVAILABLE', context_summary: expect.objectContaining({ contractState: 'BRANCH_MISSING' }) });

    // b) Bloc 5 actif : demande en attente (aucun appel IA dans la demande — jamais depuis le contrôle).
    await activer([{ treatment: 'T3', content: avecBloc(LIVRE.t3, 't3-operation-identity-v1') }]);
    const d = await demander();
    expect(d.requested).toEqual([op]);
    expect(appels.t3).toHaveLength(0);
    expect((await reevaluations(c.compte, 'T3')).at(-1)).toMatchObject({ status: 'PENDING', contract_version: 't3-operation-identity-v1' });

    // c) Passage T3 du compte (file durable) : phase « identité », appel, application, consolidation.
    await k.passer(c.compte, { today: AUJ, operationMatch: {} });
    expect(appels.t3).toHaveLength(1);
    expect(appels.t3[0]).toContain('BRANCHE TASK = OPERATION_IDENTITY');
    expect(appels.t3[0]).toContain('"contractVersion":"t3-operation-identity-v1"');
    const j = (await reevaluations(c.compte, 'T3')).at(-1)!;
    expect(j).toMatchObject({ status: 'APPLIED', ai_calls: 1 });
    expect(j.mutations_applied).toEqual([expect.objectContaining({ kind: 'REJECT', fileId: f2, operationId: op })]);
    expect(await sql<Json[]>`SELECT decision, origin, reason_code FROM business_operation_match_decisions WHERE account_id = ${c.compte.id} AND active ORDER BY id`)
      .toEqual([{ decision: 'REJECTED', origin: 'AI_IDENTITY', reason_code: 'T3_SEMANTIC_IDENTITY_SEPARATED' }]);
    const actives = (await k.sources(op)).filter((s) => s.active).map((s) => Number(s.source_entity_key));
    expect(actives).toEqual([f1]);
    const ailleurs = await sql<Json[]>`
      SELECT s.operation_id::int AS op FROM business_operation_sources s WHERE s.account_id = ${c.compte.id} AND s.active AND s.source_entity_key = ${String(f2)}`;
    expect(ailleurs.every((x) => x.op !== op)).toBe(true);
    expect((await traces(c.compte, 't3_operation_identity')).length).toBeGreaterThanOrEqual(1);

    // d) Rejoué : plus aucune demande en attente, aucun nouvel appel.
    const { runIdentityPhase } = await import('@/services/business-operations/semantic/identity-phase');
    expect(await runIdentityPhase(c.compte.id)).toMatchObject({ processed: 0, aiCalls: 0 });
    expect(appels.t3).toHaveLength(1);
    expect((await reevaluations(c.compte, 'T3')).map((x) => x.status)).not.toContain('PENDING');
  });

  it('L97A-E2E-03 — T3 : un document rattaché par l’utilisateur n’est jamais séparé (refus en bloc, aucune écriture)', async () => {
    const c = await contexte();
    const { f2, op } = await deuxDocuments(c);
    const [cand2] = await sql<Json[]>`SELECT candidate_key FROM document_operation_candidates WHERE file_id = ${f2} AND status = 'ACTIVE' LIMIT 1`;
    await sql`INSERT INTO business_operation_match_decisions (account_id, source_kind, source_entity_key, source_version, candidate_operation_id, decision, origin, reason_code)
              VALUES (${c.compte.id}, 'DOCUMENT', ${String(f2)}, ${cand2.candidate_key}, ${op}, 'CONFIRMED', 'USER_ARBITRATION', 'E2E_USER_CONFIRMED')`;
    await activer([{ treatment: 'T3', content: avecBloc(LIVRE.t3, 't3-operation-identity-v1') }]);
    const sem = await import('@/services/business-operations/semantic/orchestrator');
    await sem.requestIdentityReevaluation({ accountId: c.compte.id, operationIds: [op], trigger: 'MANUAL', reason: 'e2e', enqueue: false });
    const { runIdentityPhase } = await import('@/services/business-operations/semantic/identity-phase');
    const r = await runIdentityPhase(c.compte.id);
    expect(r).toMatchObject({ aiCalls: 1, files: [] });
    const j = (await reevaluations(c.compte, 'T3')).at(-1)!;
    expect(j).toMatchObject({ status: 'REJECTED', reason: 'INVALID_DECISION:PROTECTED_OBJECT' });
    expect(await sql<Json[]>`SELECT origin FROM business_operation_match_decisions WHERE account_id = ${c.compte.id} AND origin = 'AI_IDENTITY'`).toEqual([]);
    expect((await k.sources(op)).filter((s) => s.active)).toHaveLength(2);
  });

  it('L97A-E2E-04 — migration 0836 rejouable ; origine AI_IDENTITY admise, jamais comptée comme décision de l’utilisateur', async () => {
    const m = readFileSync(join(RACINE, 'src/db/migrations/0836_l97a_decision_identite_ia.sql'), 'utf-8');
    await sql.begin(async (tx) => { await tx.unsafe(m); });
    await sql.begin(async (tx) => { await tx.unsafe(m); });
    const [def] = await sql<Json[]>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'business_operation_match_decisions_origin_chk'`;
    expect(def.d).toMatch(/AI_IDENTITY/);
    expect(def.d).toMatch(/USER_ARBITRATION/);
    const purge = readFileSync(join(RACINE, 'src/services/business-operations/rebuild/purge.ts'), 'utf-8');
    expect(purge).toMatch(/origin IN \('USER_ARBITRATION', 'ADMIN_REVIEW'\)/);
  });
});
