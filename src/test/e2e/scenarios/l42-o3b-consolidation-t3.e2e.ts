/**
 * Lot 42 — O3b, suite de la consolidation T3 (CDC Opérations V1 ch. 8.4,
 * 8.6, 20, B8, B19, C6.1 M3, C6.2, C6.3, C8, C19 ; NFR-OP-003/005) — base
 * PostgreSQL réelle, sorties IA ENREGISTRÉES (passerelle réelle, fournisseur
 * de rejeu : aucun appel réseau).
 *
 * Couvre : M3 SAME / DISTINCT / AMBIGUOUS, empreinte (pas de rappel), plafond
 * de coût, prompt T3 sans la branche (attente sans erreur), décisions
 * REJECTED / CONFIRMED durables, fusion sans double compte + redirection +
 * rollback, réactivation par M1, cartes « À traiter » (a) (b) (c) créées,
 * résolues, fermées automatiquement, dédoublonnées.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import type { RecordedOutput } from '../replay-gateway';

const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');
const AUJOURDHUI = '2026-10-12';

type Op = { id: number; type_code: string | null; status: string; invalidated_at: string | null; merged_into_operation_id: number | null; parent_operation_id: number | null };

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Remplacement des plaquettes de frein', sourceRoleHint: 'INVOICE', provider: 'Garage Martin',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number, over: Partial<AnchoredOperationCandidate['financialHints'][number]> = {}) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1', ...over }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });
const m3 = (decision: 'SAME_OPERATION' | 'DISTINCT_OPERATION' | 'AMBIGUOUS', matchedCandidateId: number | null, confidence = 'certain', repeat = false): RecordedOutput => ({
  operationCode: 't3_operation_match', task: 'OPERATION_MATCH', repeat,
  output: { task: 'OPERATION_MATCH', decision, matchedCandidateId, confidence, concordantSignals: ['même bien', 'même objet'], contradictions: [], reason: 'enregistré' },
});

scenario('L42-O3b', 'Consolidation T3 : M3, décisions durables, fusion, réactivation, cartes « À traiter »', ({ sql, make, useRecordings }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests(null);
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  async function t1(compte: AccountRow, fileId: number, candidats: AnchoredOperationCandidate[], reanalysis = false) {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    const extractionId = x?.id ?? (await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${fileId}) RETURNING id`)[0].id;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, { accountId: compte.id, fileId, extractionId, analysisRunId: null, reanalysis, candidates: candidats, facts: new Map() });
    });
  }
  async function document(compte: AccountRow, assetId: number | null, candidats: AnchoredOperationCandidate[], titre?: string) {
    const f = await make.assetFile(compte, { assetId });
    if (titre) await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    await t1(compte, f.id, candidats);
    return f.id;
  }
  type PasserOpts = Parameters<Awaited<ReturnType<typeof consolidator>>['consolidateAccountOperations']>[1];
  const passer = async (compte: AccountRow, opts: PasserOpts = {}) =>
    (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, ...opts });
  const operations = (compte: AccountRow) => sql<Op[]>`
    SELECT id::int AS id, type_code, status, invalidated_at::text AS invalidated_at, merged_into_operation_id::int AS merged_into_operation_id,
           parent_operation_id::int AS parent_operation_id
      FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;
  const actives = async (compte: AccountRow) => (await operations(compte)).filter((o) => o.invalidated_at === null);
  const coutNet = async (opId: number) => (await sql<{ kind: string; amount_minor: number }[]>`
    SELECT kind, amount_minor::int AS amount_minor FROM business_operation_financial_components WHERE operation_id = ${opId} AND active`)
    .reduce((t, c) => t + (c.kind === 'FORECAST_COST' ? 0 : c.kind === 'REALIZED_COST' ? c.amount_minor : -c.amount_minor), 0);
  const candidat = async (fileId: number) => (await sql<{ t3_outcome: string; t3_reason: string; t3_operation_id: number | null; t3_detail: Record<string, any> }[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id, t3_detail FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];
  const cartes = (compte: AccountRow, rule?: string) => sql<{ id: number; public_id: string; rule_code: string; target_id: number; relation_key: string; question: string; proposals_json: Array<{ value: string; label: string; isCurrentValue?: boolean }>; resolved_at: string | null; resolution_reason: string | null; priority: string }[]>`
    SELECT id, public_id, rule_code, target_id, relation_key, question, proposals_json, resolved_at::text AS resolved_at, resolution_reason, priority
      FROM to_process_actions WHERE account_id = ${compte.id} AND (${rule ?? null}::text IS NULL OR rule_code = ${rule ?? null}) ORDER BY id`;
  const ouvertes = async (compte: AccountRow, rule?: string) => (await cartes(compte, rule)).filter((c) => c.resolved_at === null);
  const historique = async (compte: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id}`)[0].n;
  const decisions = (compte: AccountRow) => sql<{ candidate_operation_id: number; decision: string; reason_code: string; active: boolean; origin: string }[]>`
    SELECT candidate_operation_id::int AS candidate_operation_id, decision, reason_code, active, origin FROM business_operation_match_decisions
     WHERE account_id = ${compte.id} ORDER BY id`;
  const traces = async (compte: AccountRow) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ai_usage_event WHERE account_id = ${compte.id} AND operation_code = 't3_operation_match'`)[0].n;
  const resoudre = async (compte: AccountRow, publicId: string, value: string) => {
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    return resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });
  };

  /** Devis (ENVISAGED) d'un garage sur un bien, puis facture sans référence quelques jours plus tard : M3 requis. */
  async function devisPuisFacture(compte: AccountRow, bienId: number, factureOver: Partial<AnchoredOperationCandidate> = {}) {
    const devis = await document(compte, bienId, [cand({ sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(bienId)], temporalHints: { plannedDate: '2026-06-03' }, businessReferences: [{ kind: 'QUOTE', value: 'DV-77' }], financialHints: [fh('FORECAST_COST', 25500)] })], 'Devis freinage');
    await passer(compte, { operationMatch: false });
    const [op] = await actives(compte);
    const facture = await document(compte, bienId, [cand({ targetHints: [cible(bienId)], temporalHints: { realizedDate: '2026-06-05' }, financialHints: [fh('REALIZED_COST', 24900, { amountScope: 'TOTAL' })], ...factureOver })], 'Facture freinage');
    return { devis, facture, op };
  }

  // ══ M3 : rapprochement par l'IA ══════════════════════════════════════════

  it('C6-20 / F-059 / C6-21 / NFR-OP-005 — M3 SAME certain : rattachement M3 (trace « Exécutions IA ») ; passage suivant : aucun rappel, aucune écriture', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const { facture, op } = await devisPuisFacture(compte, clio.id);
    const replay = await useRecordings([m3('SAME_OPERATION', op.id)]);
    const r = await passer(compte);
    expect(r.m3).toMatchObject({ calls: 1, deferred: 0, unavailable: 0 });
    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0].prompt).toContain('BRANCHE TASK = OPERATION_MATCH');
    expect(await actives(compte)).toHaveLength(1);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M3', t3_operation_id: op.id });
    expect((await candidat(facture)).t3_detail.m3).toMatchObject({ status: 'DONE', verdict: { decision: 'SAME_OPERATION', matchedOperationId: op.id } });
    const [src] = await sql`SELECT match_method FROM business_operation_sources WHERE operation_id = ${op.id} AND source_entity_key = ${String(facture)} AND active`;
    expect(src.match_method).toBe('M3');
    expect((await operations(compte))[0].status).toBe('REALIZED');
    expect(await traces(compte)).toBe(1);

    // NFR-OP-005 : réexamen forcé sans changement — aucun appel modèle, aucun historique.
    const h = await historique(compte);
    const r2 = await passer(compte, { reevaluateHolds: true });
    expect(r2.changes).toBe(0);
    expect(r2.m3).toMatchObject({ calls: 0 });
    expect(replay.calls).toHaveLength(1);
    expect(await historique(compte)).toBe(h);
    const { listAccountsToConsolidate } = await consolidator();
    expect(await listAccountsToConsolidate(compte.id - 1, 50, 't3_master_v1@file')).not.toContain(compte.id);
  });

  it('C6-22 — M3 DISTINCT certain : nouvelle intervention (la source peut créer seule)', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const { facture, op } = await devisPuisFacture(compte, clio.id, { summary: 'Remplacement de deux pneus' });
    await useRecordings([m3('DISTINCT_OPERATION', null)]);
    await passer(compte);
    const ops = await actives(compte);
    expect(ops).toHaveLength(2);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'CREATE_NEW', t3_reason: 'M3_DISTINCT' });
    expect((await candidat(facture)).t3_operation_id).not.toBe(op.id);
  });

  it('C6-23 / F-048 / C19-20 — M3 AMBIGUOUS avec impact : carte (a) « Ce document concerne-t-il la même intervention que … ? » ; « Non » → REJECTED durable, création, jamais reproposé ni rejoué par l’IA', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const { facture, op } = await devisPuisFacture(compte, clio.id);
    const replay = await useRecordings([m3('AMBIGUOUS', null, 'conflictual')]);
    await passer(compte);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_reason: 'M3_AMBIGUOUS' });
    const [carte, ...autres] = await ouvertes(compte, 'OPERATION-MATCH');
    expect(autres).toEqual([]);
    expect(carte).toMatchObject({ target_id: facture, relation_key: 'operationMatch:op1', priority: 'DO_NEXT' });
    expect(carte.question).toBe('Ce document concerne-t-il la même intervention que « Devis freinage du 03/06/2026 » ?');
    expect(carte.proposals_json.map((p) => p.value)).toEqual([`SAME:${op.id}`, 'DISTINCT']);
    expect([carte.question, ...carte.proposals_json.map((p) => p.label)].join(' ')).not.toMatch(/op[ée]ration/i);

    // Dédoublonnage : un second passage (même contexte) met à jour la même carte, pas de seconde carte ni d'appel.
    await passer(compte, { reevaluateHolds: true });
    expect(await ouvertes(compte, 'OPERATION-MATCH')).toHaveLength(1);
    expect(replay.calls).toHaveLength(1);
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    expect((await getToProcessPage(compte.id)).total).toBe(1);

    expect(await resoudre(compte, carte.public_id, 'DISTINCT')).toMatchObject({ ok: true });
    expect(await decisions(compte)).toEqual([{ candidate_operation_id: op.id, decision: 'REJECTED', reason_code: 'USER_DISTINCT_OPERATION', active: true, origin: 'USER_ARBITRATION' }]);
    expect(await actives(compte)).toHaveLength(2);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'CREATE_NEW' });
    expect((await cartes(compte, 'OPERATION-MATCH'))[0]).toMatchObject({ resolution_reason: 'USER_ARBITRATED' });

    // F-046 : balayage horaire — aucun rematch vers l'Opération rejetée, aucun rappel IA, aucune nouvelle carte.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${facture}`;
    await passer(compte, { reevaluateHolds: true });
    expect(replay.calls).toHaveLength(1);
    expect(await ouvertes(compte)).toEqual([]);
    expect((await candidat(facture)).t3_operation_id).not.toBe(op.id);
  });

  it('C6-24 / F-047 / C19-21 — carte (a) « Oui » : CONFIRMED (ancre M0 stable) ; annulation : décision retirée, rattachement défait, même carte rouverte', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const { facture, op } = await devisPuisFacture(compte, clio.id);
    await useRecordings([m3('AMBIGUOUS', null, 'probable')]);
    await passer(compte);
    const [carte] = await ouvertes(compte, 'OPERATION-MATCH');
    const r = await resoudre(compte, carte.public_id, `SAME:${op.id}`);
    expect(r.ok).toBe(true);
    expect(await decisions(compte)).toEqual([expect.objectContaining({ candidate_operation_id: op.id, decision: 'CONFIRMED', active: true })]);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M0', t3_operation_id: op.id });
    expect(await actives(compte)).toHaveLength(1);
    expect(await coutNet(op.id)).toBe(24900);
    // Stable au passage suivant.
    await passer(compte, { reevaluateHolds: true });
    expect(await candidat(facture)).toMatchObject({ t3_operation_id: op.id });

    const { undoArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await undoArbitration(compte.id, carte.public_id, r.previousValue)).toMatchObject({ ok: true });
    expect((await decisions(compte)).every((d) => !d.active)).toBe(true);
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${op.id} AND source_entity_key = ${String(facture)} AND active`).toHaveLength(0);
    const rouverte = await ouvertes(compte, 'OPERATION-MATCH');
    expect(rouverte.map((c) => c.id)).toEqual([carte.id]);
  });

  it('C6-25 — coût borné : plafond par passage (reprise au passage suivant) et plafond journalier par compte', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const { op } = await devisPuisFacture(compte, clio.id);
    // Deux autres factures du même garage, sans référence : trois cas M3.
    for (const d of ['2026-06-06', '2026-06-07']) {
      await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], temporalHints: { realizedDate: d }, financialHints: [fh('REALIZED_COST', 1000)] })]);
    }
    const replay = await useRecordings([m3('AMBIGUOUS', null, 'conflictual', true)]);
    const r1 = await passer(compte, { operationMatch: { maxCallsPerPass: 1 } });
    expect(r1.m3).toMatchObject({ calls: 1, deferred: 2 });
    expect(replay.calls).toHaveLength(1);
    const reportes = await sql<{ d: Record<string, any> }[]>`SELECT t3_detail->'m3' AS d FROM document_operation_candidates WHERE account_id = ${compte.id} AND t3_detail->'m3'->>'status' = 'DEFERRED'`;
    expect(reportes.map((x) => x.d.detail)).toEqual(['PASS_CAP', 'PASS_CAP']);
    // Le balayage reprend le compte (report échu) ; plafond journalier atteint : tout est reporté au lendemain.
    const { listAccountsToConsolidate } = await consolidator();
    expect(await listAccountsToConsolidate(compte.id - 1, 50, 't3_master_v1@file')).toContain(compte.id);
    const r2 = await passer(compte, { operationMatch: { maxCallsPerPass: 5, maxCallsPerDay: 1 } });
    expect(r2.m3).toMatchObject({ calls: 0, deferred: 2 });
    const jour = await sql<{ d: Record<string, any> }[]>`SELECT t3_detail->'m3' AS d FROM document_operation_candidates WHERE account_id = ${compte.id} AND t3_detail->'m3'->>'status' = 'DEFERRED'`;
    expect(jour.map((x) => x.d.detail)).toEqual(['DAILY_CAP', 'DAILY_CAP']);
    expect(await listAccountsToConsolidate(compte.id - 1, 50, 't3_master_v1@file')).not.toContain(compte.id);
    const r3 = await passer(compte, { operationMatch: { maxCallsPerPass: 5 } });
    expect(r3.m3?.calls ?? 0).toBe(0);
    expect(op.id).toBeGreaterThan(0);
  });

  it('C6-26 — prompt T3 actif SANS la branche OPERATION_MATCH (version BO antérieure) : aucun appel, aucune erreur, cas en attente ; repris dès qu’une version complète est active', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const { facture, op } = await devisPuisFacture(compte, clio.id);
    const { readFileSync } = await import('node:fs');
    const fichier = readFileSync('src/services/ai/prompts/reconciliation/t3_master_v1.txt', 'utf8');
    const ancien = fichier.slice(0, fichier.indexOf('BRANCHE TASK = OPERATION_MATCH')).replace(' | OPERATION_MATCH', '') + 'Réponds uniquement par le JSON correspondant au TASK demandé.';
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: 9001, treatment: 'T3', versionNumber: 3, content: ancien }]);
    const { operationMatchPromptStatus } = await import('@/services/business-operations/consolidation/m3');
    expect(await operationMatchPromptStatus()).toMatchObject({ available: false, version: expect.stringMatching(/^t3_master_v1@pv9001:/) });
    // Les autres branches T3 restent servies par cette version.
    const { renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');
    expect(() => renderMasterPrompt(ancien, { masterPromptCode: 't3_master_v1', task: 'VALUE_CONFLICT', allowedTasks: ['VALUE_CONFLICT', 'LINK_AMBIGUITY', 'OPERATION_MATCH'], variables: { FIELD: null, CURRENT_STATE: null, EVIDENCES: null, SUBJECT_CONTEXT: null, CANDIDATES: null, RELATION_TYPE: null } })).not.toThrow();

    const replay = await useRecordings([m3('SAME_OPERATION', op.id)]);
    const r = await passer(compte);
    expect(r.errors).toBe(0);
    expect(r.m3).toMatchObject({ calls: 0, unavailable: 1 });
    expect(replay.calls).toHaveLength(0);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    expect((await candidat(facture)).t3_detail.m3).toMatchObject({ status: 'PROMPT_UNAVAILABLE' });
    // Même version : le balayage ne reprend pas le compte, un passage ne rappelle rien.
    const { listAccountsToConsolidate } = await consolidator();
    const v = (await operationMatchPromptStatus()).version;
    expect(await listAccountsToConsolidate(compte.id - 1, 50, v)).not.toContain(compte.id);
    expect((await passer(compte)).m3).toMatchObject({ calls: 0, examined: 0 });

    // Le BO active le texte livré (« Repartir du texte livré » puis « Activer ») : repris.
    __setActiveMasterPromptsForTests([{ id: 9002, treatment: 'T3', versionNumber: 4, content: fichier }]);
    const v2 = (await operationMatchPromptStatus()).version;
    expect(await listAccountsToConsolidate(compte.id - 1, 50, v2)).toContain(compte.id);
    const r2 = await passer(compte);
    expect(r2.m3).toMatchObject({ calls: 1 });
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op.id });
  });

  // ══ Fusion V1 (B8) ═══════════════════════════════════════════════════════

  it('B8-10 / F-049 / F-050 / F-051 / NFR-OP-003 — référence commune découverte : fusion transactionnelle, sources rapatriées sans double compte, redirection, historique, événement après commit', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const devis = await document(compte, clio.id, [cand({ sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }], financialHints: [fh('FORECAST_COST', 30000)] })]);
    // Ordre de travail sans prestataire lu : rien ne le rapproche du devis (deux Opérations).
    // Lot 53 (PO-D5) : nature de travaux différente du devis (sinon même bien + même nature = plausible).
    const ot = await document(compte, clio.id, [cand({ provider: null, summary: 'Ordre de travail géométrie', sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'WORK_ORDER', value: 'OT9' }], temporalHints: { plannedDate: '2026-01-10' } })]);
    await passer(compte, { operationMatch: false });
    const [a, b] = await actives(compte);
    expect([a, b].every(Boolean)).toBe(true);
    // Décision antérieure sur B, remappée à la fusion (F-051).
    const rejet = await make.assetFile(compte, { assetId: clio.id });
    await sql`INSERT INTO business_operation_match_decisions (account_id, source_kind, source_entity_key, source_version, candidate_operation_id, decision, origin, reason_code)
              VALUES (${compte.id}, 'DOCUMENT', ${String(rejet.id)}, 'op1', ${b.id}, 'REJECTED', 'USER_ARBITRATION', 'USER_OTHER_CHOSEN')`;

    const recus: string[] = [];
    (await bus()).subscribeBusinessOperationEvents('e2e', (e) => { recus.push(`${e.type}:${e.operationId}:${e.canonicalOperationId ?? ''}`); });
    const facture = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }, { kind: 'WORK_ORDER', value: 'OT9' }, { kind: 'INVOICE', value: 'F-100' }], temporalHints: { realizedDate: '2026-01-15' }, financialHints: [fh('REALIZED_COST', 31000, { amountScope: 'TOTAL' })] })]);
    await passer(compte, { operationMatch: false });

    const ops = await operations(compte);
    const canon = ops.find((o) => o.id === a.id)!;
    const absorbee = ops.find((o) => o.id === b.id)!;
    expect(canon).toMatchObject({ invalidated_at: null, merged_into_operation_id: null, status: 'REALIZED' });
    expect(absorbee).toMatchObject({ merged_into_operation_id: a.id });
    expect(absorbee.invalidated_at).not.toBeNull();
    expect(await actives(compte)).toHaveLength(1);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_MERGE', t3_operation_id: a.id });
    // Toutes les sources sur la canonique, aucune perdue ; coût réalisé compté une fois (le devis reste prévu).
    const srcs = await sql<{ k: string }[]>`SELECT source_entity_key AS k FROM business_operation_sources WHERE operation_id = ${a.id} AND active ORDER BY id`;
    expect(srcs.map((s) => Number(s.k)).sort((x, y) => x - y)).toEqual([devis, ot, facture].sort((x, y) => x - y));
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${b.id} AND active`).toHaveLength(0);
    expect(await coutNet(a.id)).toBe(31000);
    expect((await sql`SELECT reference_kind FROM business_operation_references WHERE operation_id = ${a.id} AND active ORDER BY reference_kind`).map((r) => r.reference_kind))
      .toEqual(['INVOICE', 'QUOTE', 'WORK_ORDER']);
    expect(await decisions(compte)).toEqual([expect.objectContaining({ candidate_operation_id: a.id, decision: 'REJECTED', active: true })]);
    // Historique MERGED des deux côtés, redirection en lecture, événement après commit.
    expect((await sql`SELECT operation_id::int AS o FROM business_operation_history WHERE event_type = 'MERGED' AND account_id = ${compte.id} ORDER BY operation_id`).map((x) => x.o))
      .toEqual([a.id, b.id].sort((x, y) => x - y));
    const { BusinessOperationReadService } = await import('@/services/business-operations/read-service');
    expect(await new BusinessOperationReadService().getOperation(compte.id, b.id)).toMatchObject({ operation: { id: a.id }, redirectedFrom: b.id });
    expect(recus).toContain(`BUSINESS_OPERATION_MERGED:${b.id}:${a.id}`);
    // Ancienne source supprimée après fusion (MAT-006) : recalcul sans perte des autres.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${ot}`;
    await passer(compte, { operationMatch: false });
    expect((await actives(compte)).map((o) => o.id)).toEqual([a.id]);
    expect(await coutNet(a.id)).toBe(31000);
  });

  it('F-168 / OPS-003 — échec au milieu d’une fusion : rollback complet, aucune Opération à moitié absorbée', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    await document(compte, clio.id, [cand({ sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }], financialHints: [fh('FORECAST_COST', 30000)] })]);
    await document(compte, clio.id, [cand({ provider: null, summary: 'Ordre de travail géométrie', sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'WORK_ORDER', value: 'OT9' }] })]);
    await passer(compte, { operationMatch: false });
    const avant = await operations(compte);
    expect(avant).toHaveLength(2);
    const h = await historique(compte);
    const facture = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }, { kind: 'WORK_ORDER', value: 'OT9' }], financialHints: [fh('REALIZED_COST', 31000)] })]);
    const { BusinessOperationIntegrityError } = await import('@/services/business-operations/errors');
    const r = await passer(compte, { operationMatch: false, onMergeStep: (s) => { if (s === 'links') throw new BusinessOperationIntegrityError('INVALID_SOURCE', 'injection'); } });
    expect(r.errors).toBe(1);
    expect(await operations(compte)).toEqual(avant);
    expect(await historique(compte)).toBe(h);
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE source_entity_key = ${String(facture)}`).toHaveLength(0);
    // Le passage suivant (sans injection) fusionne normalement.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${facture}`;
    await passer(compte, { operationMatch: false });
    expect(await actives(compte)).toHaveLength(1);
  });

  // ══ Invalidation / réactivation (C8, ch. 8.6) ═════════════════════════════

  it('F-052 / F-053 — Opération invalidée puis nouvelle preuve de même référence : réactivée sous le même identifiant (M1) ; preuve d’un autre événement : nouvelle Opération', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const ancien = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'WORK_ORDER', value: 'OT-55' }], financialHints: [fh('REALIZED_COST', 40000)] })]);
    await passer(compte, { operationMatch: false });
    const [op] = await operations(compte);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${ancien}`;
    await passer(compte, { operationMatch: false });
    expect((await operations(compte))[0].invalidated_at).not.toBeNull();

    // Autre document (pas une restauration) citant le même ordre de travail.
    const nouveau = await document(compte, clio.id, [cand({ provider: 'Garage Martin', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'WORK_ORDER', value: 'OT-55' }], financialHints: [fh('REALIZED_COST', 40000)] })]);
    await passer(compte, { operationMatch: false });
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: op.id, invalidated_at: null });
    expect(await candidat(nouveau)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op.id });
    expect(await sql`SELECT 1 FROM business_operation_history WHERE operation_id = ${op.id} AND event_type = 'REACTIVATED'`).toHaveLength(1);
    expect(await coutNet(op.id)).toBe(40000);

    // F-053 : invalidée de nouveau, puis un événement DISTINCT (autre ordre de travail) : nouvelle Opération.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${nouveau}`;
    await passer(compte, { operationMatch: false });
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'WORK_ORDER', value: 'OT-99' }], temporalHints: { realizedDate: '2025-01-01' }, financialHints: [fh('REALIZED_COST', 1000)] })]);
    await passer(compte, { operationMatch: false });
    const fin = await operations(compte);
    expect(fin).toHaveLength(2);
    expect(fin[0].invalidated_at).not.toBeNull();
  });

  // ══ Cartes « À traiter » (b) et (c), fermeture automatique (a) ═══════════

  it('C19-22 / F-075 — parent Sinistre : référence unique → parent posé ; deux dossiers cités → carte (b) ; choix durable, jamais reproposé', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const sinistre = (ref: string, date: string) => cand({ typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', provider: 'Assur', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'CLAIM', value: ref }], temporalHints: { realizedDate: date } });
    await document(compte, maison.id, [sinistre('S-1', '2026-02-02')], 'Déclaration dégât des eaux');
    await document(compte, maison.id, [sinistre('S-2', '2026-02-20')], 'Déclaration tempête');
    await passer(compte, { operationMatch: false });
    const [s1, s2] = await actives(compte);

    // Référence unique : parent posé automatiquement.
    await document(compte, maison.id, [cand({ provider: 'Plombier', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'CLAIM', value: 'S-1' }, { kind: 'INVOICE', value: 'P-1' }], financialHints: [fh('REALIZED_COST', 50000)] })]);
    await passer(compte, { operationMatch: false });
    const reparation = (await actives(compte)).find((o) => o.type_code === 'INTERVENTION')!;
    expect(reparation.parent_operation_id).toBe(s1.id);

    // Facture citant les deux dossiers : ambiguïté → carte (b).
    const doc = await document(compte, maison.id, [cand({ provider: 'Couvreur', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'CLAIM', value: 'S-1' }, { kind: 'CLAIM', value: 'S-2' }, { kind: 'INVOICE', value: 'C-1' }], financialHints: [fh('REALIZED_COST', 90000)] })], 'Facture couverture');
    await passer(compte, { operationMatch: false });
    const toiture = (await actives(compte)).find((o) => o.type_code === 'INTERVENTION' && o.id !== reparation.id)!;
    expect(toiture.parent_operation_id).toBeNull();
    const [carte, ...autres] = await ouvertes(compte, 'OPERATION-CLAIM-PARENT');
    expect(autres).toEqual([]);
    expect(carte).toMatchObject({ target_id: doc, relation_key: `operationParent:${toiture.id}` });
    expect(carte.question).toMatch(/^Cette intervention fait-elle suite au sinistre « Déclaration (tempête|dégât des eaux) du \d\d\/02\/2026 » ou au sinistre/);
    expect(carte.proposals_json.map((p) => p.value).sort()).toEqual(['NONE', `PARENT:${s1.id}`, `PARENT:${s2.id}`].sort());

    expect(await resoudre(compte, carte.public_id, `PARENT:${s2.id}`)).toMatchObject({ ok: true });
    expect((await operations(compte)).find((o) => o.id === toiture.id)!.parent_operation_id).toBe(s2.id);
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${toiture.id} AND source_kind = 'USER_ARBITRATION' AND active AND locator->>'decision' = 'CLAIM_PARENT'`).toHaveLength(1);
    // La décision ne justifie pas l'existence : supprimer la facture invalide l'intervention.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${doc}`;
    await passer(compte, { operationMatch: false, reevaluateHolds: true });
    expect(await ouvertes(compte)).toEqual([]);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${doc}`;
    await passer(compte, { operationMatch: false });
    expect((await operations(compte)).find((o) => o.id === toiture.id)!.invalidated_at).not.toBeNull();
  });

  it('C19-25 — carte (b) fermée d’elle-même : un des deux dossiers disparaît, le parent devient certain et est posé', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const sinistre = (ref: string, date: string) => cand({ typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', provider: 'Assur', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'CLAIM', value: ref }], temporalHints: { realizedDate: date } });
    await document(compte, maison.id, [sinistre('S-1', '2026-02-02')]);
    const d2 = await document(compte, maison.id, [sinistre('S-2', '2026-02-20')]);
    await passer(compte, { operationMatch: false });
    const [s1] = await actives(compte);
    const doc = await document(compte, maison.id, [cand({ provider: 'Couvreur', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'CLAIM', value: 'S-1' }, { kind: 'CLAIM', value: 'S-2' }], financialHints: [fh('REALIZED_COST', 90000)] })]);
    await passer(compte, { operationMatch: false });
    expect(await ouvertes(compte, 'OPERATION-CLAIM-PARENT')).toHaveLength(1);
    // Suppression du document d'un des sinistres : le passage revérifie les questions ouvertes.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${d2}`;
    await passer(compte, { operationMatch: false });
    expect(doc).toBeGreaterThan(0);
    expect(await ouvertes(compte)).toEqual([]);
    expect((await cartes(compte, 'OPERATION-CLAIM-PARENT'))[0]).toMatchObject({ resolution_reason: 'OBSOLETE' });
    const toiture = (await actives(compte)).find((o) => o.type_code === 'INTERVENTION')!;
    expect(toiture.parent_operation_id).toBe(s1.id);
  });

  it('C19-23 / B19 — montant contradictoire de même rôle : carte (c), valeur la plus ancienne retenue d’ici là ; choix appliqué sans double compte ; fermeture automatique si une preuve disparaît', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const facture = (montant: number) => [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-1' }], financialHints: [fh('REALIZED_COST', montant, { amountScope: 'TOTAL' })] })];
    const d1 = await document(compte, clio.id, facture(100000), 'Facture garage');
    const d2 = await document(compte, clio.id, facture(120000), 'Facture garage (copie)');
    await passer(compte, { operationMatch: false });
    const [op, ...autres] = await actives(compte);
    expect(autres).toEqual([]);
    expect(await coutNet(op.id)).toBe(100000);
    const [carte] = await ouvertes(compte, 'OPERATION-AMOUNT');
    expect(carte).toMatchObject({ target_id: d2 });
    expect(carte.question).toBe('Ces documents indiquent des montants différents pour la même dépense : lequel est le bon ?');
    expect(carte.proposals_json.map((p) => [p.value, !!p.isCurrentValue])).toEqual([['AMOUNT:120000:EUR', false], ['AMOUNT:100000:EUR', true]]);
    expect(await resoudre(compte, carte.public_id, 'AMOUNT:120000:EUR')).toMatchObject({ ok: true });
    expect(await coutNet(op.id)).toBe(120000);
    // Stable : un passage suivant ne rouvre rien et ne double pas le coût.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id IN (${d1}, ${d2})`;
    await passer(compte, { operationMatch: false });
    expect(await coutNet(op.id)).toBe(120000);
    expect(await ouvertes(compte)).toEqual([]);

    // Fermeture automatique : nouvelle contradiction, puis la preuve divergente disparaît.
    const d3 = await document(compte, clio.id, facture(130000), 'Facture garage (troisième)');
    await passer(compte, { operationMatch: false });
    expect(await ouvertes(compte, 'OPERATION-AMOUNT')).toHaveLength(1);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${d3}`;
    await passer(compte, { operationMatch: false });
    expect(await ouvertes(compte)).toEqual([]);
    expect((await cartes(compte, 'OPERATION-AMOUNT')).at(-1)).toMatchObject({ resolution_reason: 'OBSOLETE' });
    expect(await coutNet(op.id)).toBe(120000);
  });

  it('C19-24 — carte (a) sur deux rapprochements exacts incompatibles : fermée d’elle-même quand la situation se résout seule', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    await document(compte, clio.id, [cand({ provider: 'Garage A', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }] })], 'Devis A');
    const b = await document(compte, clio.id, [cand({ provider: 'Garage B', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'WORK_ORDER', value: 'OT9' }] })], 'Ordre B');
    await passer(compte, { operationMatch: false });
    // Prestataire non lu (lot 53, PO-D5 : un même numéro chez un AUTRE prestataire ne serait qu'un indice).
    const deux = await document(compte, clio.id, [cand({ provider: null, targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }, { kind: 'WORK_ORDER', value: 'OT9' }], financialHints: [fh('REALIZED_COST', 1000)] })]);
    await passer(compte, { operationMatch: false });
    const [carte] = await ouvertes(compte, 'OPERATION-MATCH');
    expect(carte).toMatchObject({ target_id: deux });
    expect(carte.question).toMatch(/^Ce document concerne-t-il la même intervention que « .+ » ou que « .+ » \?$/);
    expect(carte.proposals_json).toHaveLength(2);
    // Le document de B est supprimé : B n'est plus justifiée, le document ne désigne plus qu'une réalité.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${b}`;
    await passer(compte, { operationMatch: false });
    expect(await ouvertes(compte)).toEqual([]);
    expect((await cartes(compte, 'OPERATION-MATCH'))[0]).toMatchObject({ resolution_reason: 'OBSOLETE' });
    expect(await candidat(deux)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH' });
  });
});
