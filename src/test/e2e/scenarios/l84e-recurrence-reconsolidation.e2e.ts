/**
 * Lot 84E — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-6 :
 * récurrence (séries de factures d'un même service) et reconsolidation
 * CIBLÉE, sur PostgreSQL 16 réel. Persistance T1 réelle des candidats
 * (`replaceOperationCandidates`), consolidation T3 réelle, files durables
 * réelles (`runOne`), service de regroupement 82D, contrôle de cohérence
 * (orchestrateur unique), TCO réel. Modèle IA SIMULÉ (aucun réseau).
 *
 *   L84E-E2E-01  AC45 / AC46 / AC11 — série d'entretien annuel (montants et
 *                périodes différents) regroupée de façon DÉTERMINISTE (aucun
 *                appel IA), une facture = un coût ;
 *   L84E-E2E-02  AC12 / AC13 — sans clé de service : M3 puis « À traiter » ;
 *                autre prestataire : aucune action ;
 *   L84E-E2E-03  deux contrats distincts du même prestataire (même n° client)
 *                NON regroupés, aucun appel IA ;
 *   L84E-E2E-04  montants contradictoires (× 10) refusés par 78A ;
 *   L84E-E2E-05  décision utilisateur (document dissocié) jamais défaite ;
 *   L84E-E2E-06  idempotence : reconsolidations rejouées sans écriture ;
 *   L84E-E2E-07  AC47 / AC48 / AC50 — Homiris : création de « Alarme » (file
 *                durable `equipment_documents`) → équipement rattaché à
 *                l'Opération, 5 factures liées, la facture qui ne le désigne
 *                pas ne l'est pas ; second équipement : aucun produit
 *                cartésien ;
 *   L84E-E2E-08  AC49 — nouvelle facture Homiris : rejoint l'Opération et
 *                l'équipement sans geste de l'utilisateur ;
 *   L84E-E2E-09  cohérence (C-Q11) : factures d'un même service non
 *                regroupées (stock fragmenté) → à blanc sans écriture,
 *                réparées par la reconsolidation ciblée, recontrôlées ;
 *                document d'équipement laissé au bien seul → réparé par O-6
 *                quand il désigne l'équipement, constat sinon ;
 *   L84E-E2E-10  C-Q10 : compte non éligible → aucune reconsolidation ;
 *   L84E-E2E-11  coût IA borné : reconsolidation ciblée sans IA ; M3 au plus
 *                le plafond par passage ; arbitrage d'ambiguïté plafonné ;
 *   L84E-E2E-12  TCO identique avant / après regroupement (78B / 80A / 81D) ;
 *   L84E-E2E-13  déclencheurs durables : bien et Pièce (file T3 Opérations),
 *                journal §27.6.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import { setDefaultResponder } from '../replay-gateway';
import type { AccountRow, AssetRow } from '../factories';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { RECETTE_TODAY, cand, cible, fh, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const pad = (m: number) => String(m).padStart(2, '0');
const finDeMois = (m: number) => (m === 2 ? '28' : [4, 6, 9, 11].includes(m) ? '30' : '31');
const HOMIRIS = 'Homiris';
const CLIENT = 'CL-778 812';
const cibleEquipementBrute = (rawLabel: string) => ({ type: 'EQUIPMENT' as const, entityId: null, rawLabel, confidence: 'certain' as const });
const cibleEquipement = (entityId: number) => ({ type: 'EQUIPMENT' as const, entityId, rawLabel: 'Alarme', confidence: 'certain' as const });

/** Échéance mensuelle d'un service (période facturée, portée INSTALLMENT). */
function mensualite(assetId: number, m: number, o: {
  montant?: number; client?: string | null; contrat?: string; provider?: string; summary?: string; cibles?: AnchoredOperationCandidate['targetHints'];
  annee?: number; typeHint?: AnchoredOperationCandidate['typeHint']; prefixe?: string;
} = {}): AnchoredOperationCandidate {
  const an = o.annee ?? 2026;
  return cand({
    typeHint: o.typeHint === undefined ? 'INTERVENTION' : o.typeHint, provider: o.provider ?? HOMIRIS,
    summary: o.summary ?? `Abonnement télésurveillance — ${pad(m)}/${an}`,
    targetHints: [cible(assetId), ...(o.cibles ?? [])],
    businessReferences: [ref('INVOICE', `${o.prefixe ?? 'FH'}-${an}-${pad(m)}`), ...(o.client === null ? [] : [ref('CUSTOMER', o.client ?? CLIENT)]),
      ...(o.contrat ? [ref('CONTRACT', o.contrat)] : [])] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { startDate: `${an}-${pad(m)}-01`, endDate: `${an}-${pad(m)}-${finDeMois(m)}` },
    financialHints: [fh('REALIZED_COST', o.montant ?? 3990, { amountScope: 'INSTALLMENT', economicDate: `${an}-${pad(m)}-05`, periodStart: `${an}-${pad(m)}-01`, periodEnd: `${an}-${pad(m)}-${finDeMois(m)}` })],
  });
}

/** Entretien annuel (période d'un an), n° de contrat d'entretien. */
function entretienAnnuel(assetId: number, an: number, montant: number): AnchoredOperationCandidate {
  return cand({
    typeHint: 'INTERVENTION', provider: 'ChauffoPro', summary: `Entretien annuel chaudière ${an}`,
    targetHints: [cible(assetId)],
    businessReferences: [ref('INVOICE', `CP-${an}`), ref('CONTRACT', 'ENT-4512')] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { startDate: `${an}-01-01`, endDate: `${an}-12-31` },
    financialHints: [fh('REALIZED_COST', montant, { amountScope: 'INSTALLMENT', economicDate: `${an}-03-15`, periodStart: `${an}-01-01`, periodEnd: `${an}-12-31` })],
  });
}

// ── Modèle simulé (OPERATION_MATCH), compté ─────────────────────────────────
const m3 = { calls: 0, verdict: 'AMBIGUOUS' as 'AMBIGUOUS' | 'DISTINCT_OPERATION' };
function modele(input: ProviderCallInput): unknown {
  void input;
  m3.calls++;
  const base = { task: 'OPERATION_MATCH', concordantSignals: ['même prestataire'], contradictions: [] as string[] };
  return m3.verdict === 'AMBIGUOUS'
    ? { ...base, decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', reason: 'éléments insuffisants' }
    : { ...base, decision: 'DISTINCT_OPERATION', matchedCandidateId: null, confidence: 'certain', reason: 'autre prestation', contradictions: ['autre service'] };
}

scenario('L84E', 'Opérations v5 O-6 : récurrence et reconsolidation ciblée', ({ sql, make, replay }) => {
  useTargetState();
  let k: OperationsKit;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    await import('@/services/ai/reconciliation');
    k = operationsKit(sql, make);
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', modele);
  });
  afterAll(() => { setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', null); });

  // ── Outils ───────────────────────────────────────────────────────────────
  const targeted = () => import('@/services/business-operations/consolidation/targeted');
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
  const sourcesDe = async (opId: number) => (await sql<{ f: number }[]>`
    SELECT source_entity_key::int AS f FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'DOCUMENT' ORDER BY 1`).map((x) => x.f);
  const liensDirects = async (c: AccountRow) => (await sql<{ f: number; e: number; origin: string }[]>`
    SELECT file_id AS f, equipment_id AS e, origin FROM document_asset_links
     WHERE account_id = ${c.id} AND status = 'ACTIVE' AND equipment_id IS NOT NULL ORDER BY 1, 2`);
  const appelsIA = () => replay.calls.filter((x) => !String(x.operationCode ?? '').startsWith('t6_')).length;
  const historique = (c: AccountRow) => k.historique(c);
  const journal = (c: AccountRow) => sql<Json[]>`
    SELECT kind, target_id::int AS target_id, trigger, status, skipped_reason, counts, ai_calls FROM business_operation_targeted_runs WHERE account_id = ${c.id} ORDER BY id`;
  /** Fait passer les travaux temporisés du compte puis vide les files (exécutant de production). */
  const executer = async (c: AccountRow) => {
    for (let i = 0; i < 10; i++) {
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE status = 'PENDING' AND account_id = ${c.id}`;
      await drainQueues(200);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE status IN ('PENDING', 'RUNNING') AND account_id = ${c.id}`;
      if (n === 0) return;
    }
  };
  const cartes = (c: AccountRow) => sql<{ target_id: number; rule_code: string }[]>`
    SELECT target_id::int AS target_id, rule_code FROM to_process_actions WHERE account_id = ${c.id} AND resolved_at IS NULL AND rule_code = 'OPERATION-MATCH' ORDER BY 1`;

  /** Stock « fragmenté » (une Opération par facture, comme avant le lot 84E) : création directe puis composantes recalculées. */
  async function stockFragmente(c: AccountRow, assetId: number, cands: AnchoredOperationCandidate[]): Promise<{ files: number[]; ops: number[] }> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const files: number[] = [];
    const ops: number[] = [];
    for (const x of cands) {
      const f = await k.document(c, assetId, [x], { title: x.summary });
      files.push(f);
      const [row] = await sql<{ id: number; version: string }[]>`
        SELECT c.id, ('c' || c.id || '|a' || COALESCE(f.asset_id, f.linked_asset_id, 0) || '|t' || COALESCE(f.document_type_code, '')) AS version
          FROM document_operation_candidates c JOIN asset_files f ON f.id = c.file_id WHERE c.file_id = ${f} AND c.status = 'ACTIVE'`;
      const op = await withBusinessOperationWrite(c.id, (repo) => repo.create({
        type: { code: 'INTERVENTION' }, status: 'REALIZED', provider: x.provider ?? null, technicalLabel: x.summary,
        source: { kind: 'DOCUMENT', entityKey: f, version: row.version, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { candidateKey: 'op1' }, matchMethod: null, matchReason: 'NO_MATCH_ESTABLISHED' },
        assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'T3_CREATE_NEW',
      }));
      ops.push(op.id);
      await sql`UPDATE document_operation_candidates SET t3_pending = false, t3_outcome = 'CREATE_NEW', t3_reason = 'NO_MATCH_ESTABLISHED', t3_operation_id = ${op.id}, t3_detail = '{}'::jsonb WHERE id = ${row.id}`;
    }
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(c.id, ops, { today: RECETTE_TODAY });
    return { files, ops };
  }

  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode, scopeAccountIds: scope });
    for (let i = 0; i < 30; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: RECETTE_TODAY });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const preuve = async (accountId: number, check: string, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding, rules_version FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${check} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number, check: string) => sql<Json[]>`
    SELECT object_id::int AS object_id, service, outcome, recheck_verdict, ai_calls FROM coherence_repairs WHERE account_id = ${accountId} AND check_id = ${check} ORDER BY id`;

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-01 / AC45 / AC46 / AC11 — série d’entretien annuel (montants et périodes différents) : UNE Opération, une facture = un coût, aucun appel IA', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const appels = appelsIA();
    const f: number[] = [];
    for (const [an, montant] of [[2023, 12000], [2024, 12600], [2025, 13150]] as const) f.push(await k.document(c, m.id, [entretienAnnuel(m.id, an, montant)], { title: `Entretien chaudière ${an}` }));
    await k.passer(c);
    const ops = await k.actives(c);
    expect(ops).toHaveLength(1);
    expect(ops[0].type_code).toBe('CONTRACT');
    expect(await sourcesDe(ops[0].id)).toEqual(f);
    expect((await k.composantes(ops[0].id)).map((x) => x.amount_minor)).toEqual([12000, 12600, 13150]);
    for (const x of f.slice(1)) expect((await k.candidat(x))[0]).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M1', t3_operation_id: ops[0].id });
    const [d] = await sql<Json[]>`SELECT t3_detail FROM document_operation_candidates WHERE file_id = ${f[2]} AND status = 'ACTIVE'`;
    expect(d.t3_detail.certain.map((x: Json) => x.why)).toEqual(['SERIES CONTRACT:ENT4512']);
    expect(appelsIA()).toBe(appels);
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-02 / AC12 / AC13 — sans clé de service : rapprochement probable → IA (M3) puis carte « À traiter » ; autre prestataire : aucune action', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    await k.document(c, m.id, [mensualite(m.id, 1, { client: null })]);
    await k.passer(c);
    m3.verdict = 'AMBIGUOUS';
    const f2 = await k.document(c, m.id, [mensualite(m.id, 2, { client: null, montant: 4190 })]);
    const { consolidateAccountOperations } = await import('@/services/business-operations/consolidation/consolidator');
    for (let i = 0; i < 3; i++) await consolidateAccountOperations(c.id, { today: RECETTE_TODAY });
    expect((await k.candidat(f2))[0]).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_operation_id: null });
    expect(await cartes(c)).toEqual([{ target_id: f2, rule_code: 'OPERATION-MATCH' }]);
    // AC13 : autre prestataire, aucune clé → aucun rapprochement, aucune carte, aucun appel.
    const appels = appelsIA();
    const f3 = await k.document(c, m.id, [mensualite(m.id, 3, { client: null, provider: 'Verisure' })]);
    await consolidateAccountOperations(c.id, { today: RECETTE_TODAY });
    expect((await k.candidat(f3))[0]).toMatchObject({ t3_outcome: 'CREATE_NEW' });
    expect((await cartes(c)).map((x) => x.target_id)).toEqual([f2]);
    expect(appelsIA()).toBe(appels);
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-03 — deux contrats distincts du même prestataire (même n° client, n° de contrat différents) : NON regroupés, aucun appel IA', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const appels = appelsIA();
    for (const mo of [1, 2]) await k.document(c, m.id, [mensualite(m.id, mo, { contrat: 'TS-100' })]);
    for (const mo of [1, 2]) await k.document(c, m.id, [mensualite(m.id, mo, { contrat: 'TS-200', prefixe: 'FG', montant: 1290, summary: `Abonnement télésurveillance garage — ${pad(mo)}/2026` })]);
    const { consolidateAccountOperations } = await import('@/services/business-operations/consolidation/consolidator');
    for (let i = 0; i < 2; i++) await consolidateAccountOperations(c.id, { today: RECETTE_TODAY });
    const ops = await k.actives(c);
    expect(ops).toHaveLength(2);
    for (const o of ops) expect(await sourcesDe(o.id)).toHaveLength(2);
    expect(await sql`SELECT 1 FROM business_operation_history WHERE account_id = ${c.id} AND event_type = 'MERGED'`).toHaveLength(0);
    expect(appelsIA()).toBe(appels);
    // La reconsolidation ciblée du prestataire ne les réunit pas davantage.
    const r = await (await targeted()).reconsolidateRecurringDocuments(c.id, { providers: [HOMIRIS] }, { trigger: 'e2e', today: RECETTE_TODAY });
    expect(r.marked.length).toBe(4);
    expect(await k.actives(c)).toHaveLength(2);
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-04 — montants contradictoires (× 10) : refusés par l’identité économique 78A, jamais regroupés (trace REFUSED)', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    await k.document(c, m.id, [mensualite(m.id, 1)]);
    await k.document(c, m.id, [mensualite(m.id, 2)]);
    const intrus = await k.document(c, m.id, [mensualite(m.id, 3, { montant: 399000 })]);
    await k.passer(c);
    const ops = await k.actives(c);
    expect(ops).toHaveLength(2);
    const [d] = await sql<Json[]>`SELECT t3_outcome, t3_detail FROM document_operation_candidates WHERE file_id = ${intrus} AND status = 'ACTIVE'`;
    expect(d.t3_outcome).toBe('CREATE_NEW');
    expect(d.t3_detail.identity).toEqual(expect.arrayContaining([expect.objectContaining({ basis: 'SERIES', outcome: 'REFUSED' })]));
    expect(d.t3_detail.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ why: 'SERIES_IDENTITY_CONTRADICTED' })]));
  });

  // ══ 05 / 06 ══════════════════════════════════════════════════════════════

  it('L84E-E2E-05 / L84E-E2E-06 / §10 — document dissocié par l’utilisateur : jamais réuni par la reconsolidation ciblée ; rejouée : aucune écriture (idempotence)', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const f: number[] = [];
    for (const mo of [1, 2, 3]) f.push(await k.document(c, m.id, [mensualite(m.id, mo)]));
    await k.passer(c);
    const [op] = await k.actives(c);
    expect(await sourcesDe(op.id)).toEqual(f);
    const { detachDocument, withGroupingWrite } = await import('@/services/business-operations/grouping/service');
    await withGroupingWrite(c.id, (g) => detachDocument(g, { operationId: op.id, fileId: f[2], reasonCode: 'USER_DETACH' }), { actorUserId: c.owner.id });
    const t = await targeted();
    await t.reconsolidateRecurringDocuments(c.id, { providers: [HOMIRIS] }, { trigger: 'e2e', today: RECETTE_TODAY });
    expect(await sourcesDe(op.id)).toEqual(f.slice(0, 2));
    const [dec] = await sql<Json[]>`SELECT decision, active FROM business_operation_match_decisions
      WHERE account_id = ${c.id} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(f[2])} AND candidate_operation_id = ${op.id}`;
    expect(dec).toMatchObject({ decision: 'REJECTED', active: true });
    // Idempotence : même état, aucune écriture métier (historique, sources, liens).
    await k.passer(c);
    const h0 = await historique(c);
    const etat = JSON.stringify(await k.actives(c));
    const r1 = await t.reconsolidateRecurringDocuments(c.id, { providers: [HOMIRIS] }, { trigger: 'e2e', today: RECETTE_TODAY });
    const r2 = await t.reconsolidateForAsset(c.id, m.id, { trigger: 'e2e', today: RECETTE_TODAY });
    expect(r1.changes + r2.changes).toBe(0);
    expect(await historique(c)).toBe(h0);
    expect(JSON.stringify(await k.actives(c))).toBe(etat);
    expect(await sourcesDe(op.id)).toEqual(f.slice(0, 2));
  });

  // ══ 07 / 08 ══════════════════════════════════════════════════════════════

  async function homiris(c: AccountRow & { owner: { id: number } }, m: AssetRow) {
    const factures: number[] = [];
    for (const mo of [1, 2, 3, 4, 5]) factures.push(await k.document(c, m.id, [mensualite(m.id, mo, { cibles: [cibleEquipementBrute('Système d’alarme')] })], { title: `Facture Homiris ${pad(mo)}/2026` }));
    const frais = await k.document(c, m.id, [mensualite(m.id, 6, { montant: 2900, summary: 'Frais de dossier — abonnement télésurveillance' })], { title: 'Frais de dossier Homiris' });
    await k.passer(c);
    return { factures, frais };
  }

  it('L84E-E2E-07 / AC47 / AC48 / AC50 — Homiris : 5 factures + frais regroupés ; création de « Alarme » (file durable) → rattachée à l’Opération, 5 liens directs, aucun pour la facture qui ne la désigne pas ; second équipement : aucun produit cartésien', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const { factures, frais } = await homiris(c, m);
    const ops = await k.actives(c);
    expect(ops).toHaveLength(1);
    expect(await sourcesDe(ops[0].id)).toEqual([...factures, frais]);
    expect(await liensDirects(c)).toEqual([]);
    // L'utilisateur crée l'équipement « Alarme » : même travail durable que la route (création).
    const alarme = await k.equipement(m, 'Alarme', 'ALARM');
    const { requestEquipmentDocumentSync } = await import('@/services/equipment/equipment-document-queue');
    expect(await requestEquipmentDocumentSync(c.id, alarme, { reason: 'created' })).not.toBeNull();
    await executer(c);
    expect(await k.liensEquipement(ops[0].id)).toEqual([{ equipment_id: alarme, asset_id: m.id }]);
    expect((await liensDirects(c)).map((x) => [x.f, x.e, x.origin])).toEqual(factures.map((f) => [f, alarme, 'AI']));
    const [h] = await sql<Json[]>`SELECT reason_code FROM business_operation_history WHERE operation_id = ${ops[0].id} AND event_type = 'TARGET_CHANGED' AND after_json->>'equipment_id' = ${String(alarme)}`;
    expect(h?.reason_code).toBe('O6_EQUIPMENT_FROM_MEMBER_DOCUMENT');
    expect((await journal(c)).find((j) => j.kind === 'EQUIPMENT')).toMatchObject({ status: 'DONE', target_id: alarme, counts: expect.objectContaining({ equipmentAttached: 1 }) });
    // Second équipement rattaché par l'utilisateur : aucun document ne le désigne → aucun lien (AC50, P19).
    const chaudiere = await k.equipement(m, 'Chaudière', 'BOILER');
    const { attachEquipment, withGroupingWrite } = await import('@/services/business-operations/grouping/service');
    await withGroupingWrite(c.id, (g) => attachEquipment(g, { operationId: ops[0].id, equipmentId: chaudiere, origin: 'USER', reasonCode: 'E2E' }));
    const r = await (await targeted()).recomputeDirectLinksForOperations(c.id, [ops[0].id], { trigger: 'e2e' });
    expect(r.directLinks.created).toBe(0);
    expect(r.directLinks.unproven).toEqual([frais]);
    expect((await liensDirects(c)).filter((x) => x.e === chaudiere)).toEqual([]);
    const { OPERATIONS_GROUPING_INVARIANTS } = await import('@/services/business-operations/grouping/invariants');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    expect(await OPERATIONS_GROUPING_INVARIANTS.find((i) => i.id === 'O1-ANTI-CARTESIAN')!.detect(postgresRunner(sql as never), c.id)).toEqual([]);
  });

  it('L84E-E2E-08 / AC49 — nouvelle facture Homiris (après la création d’« Alarme ») : rejoint l’Opération ET l’équipement sans geste de l’utilisateur', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const { factures } = await homiris(c, m);
    const alarme = await k.equipement(m, 'Alarme', 'ALARM');
    await (await targeted()).reconsolidateForEquipment(c.id, alarme, { trigger: 'e2e', today: RECETTE_TODAY });
    const [op] = await k.actives(c);
    expect((await liensDirects(c)).map((x) => x.f)).toEqual(factures);
    const f7 = await k.document(c, m.id, [mensualite(m.id, 7, { cibles: [cibleEquipement(alarme)] })], { title: 'Facture Homiris 07/2026' });
    const f8 = await k.document(c, m.id, [mensualite(m.id, 8, { cibles: [cibleEquipementBrute('alarme')] })], { title: 'Facture Homiris 08/2026' });
    await k.passer(c);
    expect(await k.actives(c)).toHaveLength(1);
    expect(await sourcesDe(op.id)).toEqual(expect.arrayContaining([f7, f8]));
    expect((await liensDirects(c)).filter((x) => x.e === alarme).map((x) => x.f)).toEqual([...factures, f7, f8]);
    expect((await journal(c)).some((j) => j.kind === 'DIRECT_LINKS' && j.trigger === 'document_arrival' && j.counts.directLinks.created === 2)).toBe(true);
  });

  // ══ 09 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-09 / C-Q11 — cohérence : factures d’un même service non regroupées (stock) → à blanc sans écriture, réparées par O-6 et recontrôlées ; document d’équipement laissé au bien seul : réparé quand il désigne l’équipement, constat sinon', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const { files, ops } = await stockFragmente(c, m.id, [1, 2, 3].map((mo) => mensualite(m.id, mo)));
    expect(await k.actives(c)).toHaveLength(3);
    const h0 = await historique(c);
    await campagne([c.id], 'DRY_RUN');
    for (const f of files) expect(await preuve(c.id, 'COH-OPS-RECURRING-SERIES', f)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'RECURRING_SERIES_UNGROUPED' }) });
    expect(await k.actives(c)).toHaveLength(3);
    expect(await historique(c)).toBe(h0);
    await campagne([c.id], 'CORRECTIVE');
    const actives = await k.actives(c);
    expect(actives.map((o) => o.id)).toEqual([ops[0]]);
    expect(await sourcesDe(ops[0])).toEqual(files);
    expect((await k.composantes(ops[0])).map((x) => x.amount_minor)).toEqual([3990, 3990, 3990]);
    const rep = await reparations(c.id, 'COH-OPS-RECURRING-SERIES');
    expect(rep[0]).toMatchObject({ service: 'reconsolidateRecurringDocuments', outcome: 'REPAIRED', ai_calls: 0 });
    // Second passage : plus aucun écart O-6, aucune nouvelle réparation, aucune écriture O-6 (l'Opération devenue
    // contrat voit sa projection Agenda reconvergée par ses propres contrôles — C-Q11, hors périmètre O-6).
    const [{ m: h1 }] = await sql<{ m: number }[]>`SELECT COALESCE(max(id), 0)::int AS m FROM business_operation_history WHERE account_id = ${c.id}`;
    await campagne([c.id], 'CORRECTIVE');
    for (const f of files) expect(['REPAIRED', 'CONSISTENT', 'GONE']).toContain((await preuve(c.id, 'COH-OPS-RECURRING-SERIES', f))?.last_result ?? 'GONE');
    expect((await reparations(c.id, 'COH-OPS-RECURRING-SERIES')).length).toBe(rep.length);
    expect(await sql`SELECT 1 FROM business_operation_history WHERE account_id = ${c.id} AND id > ${h1} AND correlation_id LIKE '%COH-OPS-RECURRING-SERIES'`).toHaveLength(0);

    // Document d'équipement : lien direct retiré (perte), l'Opération est liée à l'équipement que la facture désigne.
    const c2 = await make.account({ plan: 'premium' });
    const m2 = await maison(c2);
    const { factures, frais } = await homiris(c2, m2);
    const alarme = await k.equipement(m2, 'Alarme', 'ALARM');
    const [op2] = await k.actives(c2);
    const { attachEquipment, withGroupingWrite } = await import('@/services/business-operations/grouping/service');
    await withGroupingWrite(c2.id, (g) => attachEquipment(g, { operationId: op2.id, equipmentId: alarme, origin: 'USER', reasonCode: 'E2E' }));
    await campagne([c2.id], 'CORRECTIVE');
    expect(await preuve(c2.id, 'COH-DOC-LINKS', factures[0])).toMatchObject({ last_result: 'REPAIRED', rules_version: 3 });
    expect((await liensDirects(c2)).map((x) => x.f)).toEqual(factures);
    expect(await preuve(c2.id, 'COH-DOC-LINKS', frais)).toMatchObject({
      last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'EQUIPMENT_ASSOCIATION_UNPROVEN', detail: expect.objectContaining({ pendingContract: '82D-t3-document-equipement' }) }),
    });
  });

  // ══ 10 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-10 / C-Q10 — compte non éligible (sans abonnement) : aucune reconsolidation, aucune marque, aucun lien ; trace SKIPPED', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const { files } = await stockFragmente(c, m.id, [1, 2].map((mo) => mensualite(m.id, mo, { cibles: [cibleEquipementBrute('alarme')] })));
    const alarme = await k.equipement(m, 'Alarme', 'ALARM');
    await sql`UPDATE account_subscriptions SET status = 'canceled' WHERE account_id = ${c.id}`;
    const { invalidateProcessingEligibility } = await import('@/services/account/processing-eligibility');
    invalidateProcessingEligibility(c.id);
    const h0 = await historique(c);
    const t = await targeted();
    const r1 = await t.reconsolidateRecurringDocuments(c.id, { fileIds: files }, { trigger: 'e2e' });
    const r2 = await t.reconsolidateForEquipment(c.id, alarme, { trigger: 'e2e' });
    const { recomputeDirectLinks } = await import('@/services/business-operations/consolidation/direct-links');
    const r3 = await recomputeDirectLinks(c.id, (await k.actives(c))[0].id);
    expect([r1.skipped, r2.skipped, r3.skipped]).toEqual(['ACCOUNT_INELIGIBLE', 'ACCOUNT_INELIGIBLE', 'ACCOUNT_INELIGIBLE']);
    expect(await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${c.id} AND t3_pending`).toHaveLength(0);
    expect(await k.actives(c)).toHaveLength(2);
    expect(await historique(c)).toBe(h0);
    expect(await liensDirects(c)).toEqual([]);
    expect((await journal(c)).map((j) => [j.kind, j.status, j.skipped_reason])).toEqual([
      ['RECURRING_DOCUMENTS', 'SKIPPED', 'ACCOUNT_INELIGIBLE'], ['EQUIPMENT', 'SKIPPED', 'ACCOUNT_INELIGIBLE'],
    ]);
  });

  // ══ 11 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-11 / risque 7 — coût IA borné : reconsolidation ciblée sans IA ; M3 ≤ plafond par passage ; arbitrage d’ambiguïté ≤ budget', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    // (a) Série sans clé de service (7 factures plausibles seulement) : la reconsolidation ciblée n'appelle jamais l'IA.
    const { files } = await stockFragmente(c, m.id, [1, 2, 3, 4, 5, 6, 7].map((mo) => mensualite(m.id, mo, { client: null })));
    const avant = appelsIA();
    const r = await (await targeted()).reconsolidateRecurringDocuments(c.id, { fileIds: files }, { trigger: 'e2e', today: RECETTE_TODAY });
    expect(r.aiCalls).toBe(0);
    expect(appelsIA()).toBe(avant);
    m3.verdict = 'DISTINCT_OPERATION';
    const { consolidateAccountOperations } = await import('@/services/business-operations/consolidation/consolidator');
    const { operationMatchCallsPerPass } = await import('@/services/business-operations/consolidation/m3');
    const passage = await consolidateAccountOperations(c.id, { today: RECETTE_TODAY });
    expect(passage.m3?.calls ?? 0).toBeLessThanOrEqual(operationMatchCallsPerPass());
    // (b) Ambiguïté résiduelle entre deux équipements de l'Opération : arbitrage existant au plus `budget` fois.
    const c2 = await make.account({ plan: 'premium' });
    const m2 = await maison(c2);
    const fs: number[] = [];
    for (const mo of [1, 2, 3, 4]) fs.push(await k.document(c2, m2.id, [mensualite(m2.id, mo, { cibles: [cibleEquipementBrute('radiateur')] })]));
    await k.passer(c2);
    const [op] = await k.actives(c2);
    const r1 = await k.equipement(m2, 'Radiateur salon', 'HEATER');
    const r2 = await k.equipement(m2, 'Radiateur chambre', 'HEATER');
    const { attachEquipment, withGroupingWrite } = await import('@/services/business-operations/grouping/service');
    for (const e of [r1, r2]) await withGroupingWrite(c2.id, (g) => attachEquipment(g, { operationId: op.id, equipmentId: e, origin: 'USER', reasonCode: 'E2E' }));
    let appelsArbitrage = 0;
    const { recomputeDirectLinks } = await import('@/services/business-operations/consolidation/direct-links');
    const d = await recomputeDirectLinks(c2.id, op.id, {
      allowAi: true, aiBudget: { remaining: 2 },
      arbitrate: async (p) => { appelsArbitrage++; return { equipmentId: p.candidateIds.includes(r1) ? r1 : null, score: 0.9, reason: 'salon' }; },
    });
    expect(appelsArbitrage).toBe(2);
    expect(d.aiCalls).toBe(2);
    expect(d.created).toBe(2);
    expect(d.ambiguous).toHaveLength(2);
    expect((await liensDirects(c2)).every((x) => x.e === r1)).toBe(true);
  });

  // ══ 12 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-12 / AC51 — TCO identique avant / après regroupement de la série (une facture = un coût ; 78B / 80A / 81D)', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    await k.document(c, m.id, [cand({ provider: 'Plombier Martin', summary: 'Réparation fuite', targetHints: [cible(m.id)],
      businessReferences: [ref('INVOICE', 'PM-1')] as AnchoredOperationCandidate['businessReferences'], temporalHints: { realizedDate: '2026-02-10' },
      financialHints: [fh('REALIZED_COST', 18000, { economicDate: '2026-02-10' })] })]);
    await k.passer(c);
    await stockFragmente(c, m.id, [1, 2, 3].map((mo) => mensualite(m.id, mo, { montant: 3990 + mo * 100 })));
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const forme = (t: Awaited<ReturnType<typeof readAssetTco>>) => ({
      cumul: t.summary.cumulativeCostCents, lignes: t.lines.map((l) => `${l.amountMinor}:${l.includedCents}`).sort(),
    });
    const avant = forme(await readAssetTco(c.id, m.id, { today: RECETTE_TODAY }));
    expect(avant.cumul).toBe(4090 + 4190 + 4290 + 18000);
    expect((await k.actives(c)).length).toBe(4);
    await (await targeted()).reconsolidateRecurringDocuments(c.id, { providers: [HOMIRIS] }, { trigger: 'e2e', today: RECETTE_TODAY });
    expect((await k.actives(c)).length).toBe(2);
    expect(forme(await readAssetTco(c.id, m.id, { today: RECETTE_TODAY }))).toEqual(avant);
  });

  // ══ 13 ═══════════════════════════════════════════════════════════════════

  it('L84E-E2E-13 — déclencheurs durables : bien modifié et Pièce créée (file T3 Opérations) → reconsolidation ciblée journalisée (§27.6)', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    await stockFragmente(c, m.id, [1, 2].map((mo) => mensualite(m.id, mo)));
    const [{ id: piece }] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name, order_index, scope, public_id) VALUES (${m.id}, 'Entrée', 0, 'personal', gen_random_uuid()) RETURNING id`;
    const { requestOperationsConsolidation } = await import('@/services/business-operations/consolidation/queue');
    const job = await requestOperationsConsolidation(c.id, { trigger: 'asset_updated', assetId: m.id, roomId: piece });
    expect(job).not.toBeNull();
    await executer(c);
    const j = await journal(c);
    expect(j.map((x) => x.kind)).toEqual(expect.arrayContaining(['ROOM', 'ASSET']));
    expect(j.find((x) => x.kind === 'ROOM')).toMatchObject({ target_id: piece, status: 'DONE' });
    expect(await k.actives(c)).toHaveLength(1);
  });
});
