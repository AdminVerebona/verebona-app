/**
 * Lot 41 — O3a, consolidation T3 DÉTERMINISTE des candidats T1 en Opérations
 * (CDC Opérations V1 ch. 8, B4, B5, C4, C5, C6, C7, C8, C9, C9.1, C10, C11,
 * C12, C24, INV-FINAL-xxx) — base PostgreSQL réelle.
 *
 * Les candidats sont écrits par la persistance RÉELLE de T1
 * (`replaceOperationCandidates`, supersession et marqueur T3 du lot 40), ou
 * par la chaîne T1 complète rejouée (F-001) ; la consolidation est celle de
 * production (`consolidateAccountOperations`, travail de file
 * `business_operations`). Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { loadT1Fixture } from '@/services/ai/source-analysis/__fixtures__/t1/load';
import type { AnalysisContext, SourceInput } from '@/services/ai/source-analysis/types';

const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');
const AUJOURDHUI = '2026-10-12';

type Op = { id: number; type_code: string | null; status: string; provider: string | null; planned_date: string | null; start_date: string | null; realized_date: string | null; end_date: string | null; invalidated_at: string | null; invalidation_reason: string | null };
type Comp = { id: number; kind: string; amount_minor: number; currency: string; amount_eur_cents: number | null; period_start: string | null; period_end: string | null; target_asset_id: number | null; sources: number };

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Remplacement du kit d\'embrayage', sourceRoleHint: 'INVOICE', provider: 'Garage Exemple',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number, over: Partial<AnchoredOperationCandidate['financialHints'][number]> = {}) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1', ...over }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number, confidence: 'certain' | 'probable' = 'certain') => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence });

scenario('L41-O3a', 'Consolidation T3 déterministe : candidats T1 → Opérations, finances, cycle de vie des sources', ({ sql, make, useRecordings }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  /** Persistance T1 réelle : supersession des candidats actifs du fichier puis nouveaux candidats. */
  async function t1(compte: AccountRow, fileId: number, candidats: AnchoredOperationCandidate[], reanalysis = false) {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    const extractionId = x?.id ?? (await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${fileId}) RETURNING id`)[0].id;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, {
        accountId: compte.id, fileId, extractionId, analysisRunId: null, reanalysis, candidates: candidats, facts: new Map(),
      });
    });
  }
  async function document(compte: AccountRow, assetId: number | null, candidats: AnchoredOperationCandidate[]) {
    const f = await make.assetFile(compte, { assetId });
    await t1(compte, f.id, candidats);
    return f.id;
  }
  const passer = async (compte: AccountRow, opts: { today?: string; fileIds?: number[]; reevaluateHolds?: boolean; operationMatch?: false } = {}) =>
    (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, ...opts });
  const operations = (compte: AccountRow) => sql<Op[]>`
    SELECT id::int AS id, type_code, status, provider, planned_date::text AS planned_date, start_date::text AS start_date,
           realized_date::text AS realized_date, end_date::text AS end_date, invalidated_at::text AS invalidated_at, invalidation_reason
      FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;
  const composantes = (opId: number, actives = true) => sql<Comp[]>`
    SELECT c.id::int AS id, c.kind, c.amount_minor::int AS amount_minor, c.currency, c.amount_eur_cents::int AS amount_eur_cents,
           c.period_start::text AS period_start, c.period_end::text AS period_end, c.target_asset_id,
           (SELECT count(*)::int FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id
             WHERE cs.component_id = c.id AND s.active) AS sources
      FROM business_operation_financial_components c WHERE c.operation_id = ${opId} AND c.active = ${actives} ORDER BY c.id`;
  const coutNet = async (opId: number) => (await composantes(opId)).reduce((t, c) =>
    t + (c.kind === 'FORECAST_COST' ? 0 : c.kind === 'REALIZED_COST' ? c.amount_minor : -c.amount_minor), 0);
  const sources = (opId: number) => sql<{ source_entity_key: string; source_role: string | null; active: boolean; match_method: string | null; source_version: string | null }[]>`
    SELECT source_entity_key, source_role, active, match_method, source_version FROM business_operation_sources WHERE operation_id = ${opId} ORDER BY id`;
  const historique = async (compte: AccountRow) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id}`)[0].n;
  const candidats = (fileId: number) => sql<{ status: string; t3_pending: boolean; t3_outcome: string | null; t3_reason: string | null; t3_operation_id: number | null }[]>`
    SELECT status, t3_pending, t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id FROM document_operation_candidates WHERE file_id = ${fileId} ORDER BY id`;
  const liens = (opId: number) => sql<{ asset_id: number; link_role: string; authority: string; active: boolean }[]>`
    SELECT asset_id, link_role, authority, active FROM business_operation_asset_links WHERE operation_id = ${opId} ORDER BY asset_id`;
  /** Invariants de livraison (INV-FINAL-006, C26.2 anomalies dures) sur le compte. */
  async function invariants(compte: AccountRow) {
    const sansSource = await sql`SELECT o.id FROM business_operations o WHERE o.account_id = ${compte.id} AND o.invalidated_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active)`;
    const compSansSource = await sql`SELECT c.id FROM business_operation_financial_components c WHERE c.account_id = ${compte.id} AND c.active
      AND NOT EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id
                       WHERE cs.component_id = c.id AND s.active)`;
    expect(sansSource).toHaveLength(0);
    expect(compSansSource).toHaveLength(0);
  }

  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  // ══ Création ═════════════════════════════════════════════════════════════

  it('F-001 — chaîne T1 rejouée → T3 : facture de réparation seule = INTERVENTION REALIZED, coût, bien, référence, trace CREATE_NEW, événement après commit', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const f = loadT1Fixture('t1-40-01-facture-reparation.json');
    const output = JSON.parse(JSON.stringify(f.recording.output).replace(/("entityId":)12\b/g, `$1${clio.id}`)) as Record<string, unknown>;
    await useRecordings([{ operationCode: f.recording.operationCode, task: f.recording.task, output }]);
    const { analyseGroupWithMaster } = await import('@/services/ai/source-analysis/master/analyse-group-master');
    const { buildKnowledgeFromSourceAnalysis } = await import('@/services/ai/knowledge/document-knowledge');
    const { persistDocumentKnowledge } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { emptyTrace } = await import('@/services/ai/source-analysis/trace');
    const input: SourceInput = { sourceType: 'file', sourceIds: [fichier.id], accountId: compte.id, userId: compte.ownerUserId, mimeTypes: ['application/pdf'], displayNames: ['facture.pdf'], linkedAssetId: clio.id };
    const ctx: AnalysisContext = { accountId: compte.id, userId: compte.ownerUserId, linkedAssetId: clio.id, existingTitles: [], assets: [{ id: clio.id, name: 'Clio', category: 'VEHICULE', subtype: null }], rooms: [], equipments: [] };
    const m = await analyseGroupWithMaster(input, [0], ctx, emptyTrace());
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis(m.result, {
      accountId: compte.id, fileId: fichier.id, analysisRunId: null, assetIdAtAnalysis: clio.id, sourceType: 'asset_file',
      multiAsset: m.projection.multiAsset, promptVersion: m.promptVersion, sourceLayer: m.sourceLayer, operationCandidates: m.operationCandidates,
    }));

    const recus: string[] = [];
    (await bus()).subscribeBusinessOperationEvents('e2e', (e) => { recus.push(`${e.type}:${e.reasonCode}`); });
    const r = await passer(compte);
    expect(r.outcomes).toEqual({ CREATE_NEW: 1 });

    const [op, ...autres] = await operations(compte);
    expect(autres).toEqual([]);
    expect(op).toMatchObject({ type_code: 'INTERVENTION', status: 'REALIZED', provider: 'Garage Exemple', realized_date: '2026-06-02', invalidated_at: null });
    expect(await composantes(op.id)).toEqual([expect.objectContaining({ kind: 'REALIZED_COST', amount_minor: 74900, currency: 'EUR', amount_eur_cents: null, sources: 1 })]);
    expect(await liens(op.id)).toEqual([{ asset_id: clio.id, link_role: 'PRIMARY', authority: 'DOCUMENT', active: true }]);
    expect(await sources(op.id)).toEqual([expect.objectContaining({ source_entity_key: String(fichier.id), source_role: 'INVOICE', active: true })]);
    expect((await sql`SELECT reference_kind, reference_value FROM business_operation_references WHERE operation_id = ${op.id} AND active`))
      .toEqual([{ reference_kind: 'INVOICE', reference_value: 'FA-2026-0612' }]);
    expect(await candidats(fichier.id)).toEqual([{ status: 'ACTIVE', t3_pending: false, t3_outcome: 'CREATE_NEW', t3_reason: 'NO_MATCH_ESTABLISHED', t3_operation_id: op.id }]);
    expect(recus).toEqual(['BUSINESS_OPERATION_CREATED:T3_CREATE_NEW']);
    await invariants(compte);
  });

  it('F-003 / F-004 / ACC-001 — candidat non établi, document non métier (notice) : aucune Opération', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const a = await document(compte, bien.id, [cand({ established: false, exclusionReason: 'UNQUALIFIED_AMOUNT' })]);
    const notice = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET document_type_code = 'USER_MANUAL' WHERE id = ${notice.id}`;
    await t1(compte, notice.id, [cand({ financialHints: [fh('REALIZED_COST', 250000)] })]);
    await passer(compte);
    expect(await operations(compte)).toEqual([]);
    expect((await candidats(notice.id))[0]).toMatchObject({ t3_outcome: 'NO_OPERATION', t3_reason: 'DOCUMENT_NOT_BUSINESS', t3_pending: false });
    expect(await candidats(a)).toEqual([expect.objectContaining({ t3_pending: false })]);
  });

  // ══ Rapprochement et finances ════════════════════════════════════════════

  it('F-031 / F-091 / F-069 / C12-01 — devis puis facture citant le devis : même INTERVENTION, ENVISAGED → REALIZED, prévu 4 800 conservé + réalisé 5 100', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const devis = await document(compte, maison.id, [cand({
      statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', provider: 'Thermo Services', targetHints: [cible(maison.id)],
      businessReferences: [{ kind: 'QUOTE', value: 'DV-8841' }], temporalHints: { plannedDate: '2026-11-20' },
      financialHints: [fh('FORECAST_COST', 480000, { amountScope: 'TOTAL' })],
    })]);
    await passer(compte);
    const [op] = await operations(compte);
    expect(op).toMatchObject({ status: 'ENVISAGED', planned_date: '2026-11-20', realized_date: null });

    const facture = await document(compte, maison.id, [cand({
      provider: 'Thermo Services', targetHints: [cible(maison.id)],
      businessReferences: [{ kind: 'INVOICE', value: 'FT-1001' }, { kind: 'QUOTE', value: 'DV-8841' }],
      temporalHints: { realizedDate: '2026-11-22' }, financialHints: [fh('REALIZED_COST', 510000, { amountScope: 'TOTAL' })],
    })]);
    await passer(compte);
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: op.id, status: 'REALIZED', planned_date: '2026-11-20', realized_date: '2026-11-22' });
    expect((await composantes(op.id)).map((c) => [c.kind, c.amount_minor])).toEqual([['FORECAST_COST', 480000], ['REALIZED_COST', 510000]]);
    expect(await coutNet(op.id)).toBe(510000);
    expect((await candidats(facture))[0]).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M1', t3_operation_id: op.id });
    expect((await sources(op.id)).map((s) => [s.source_entity_key, s.source_role, s.match_method])).toEqual([[String(devis), 'QUOTE', null], [String(facture), 'INVOICE', 'M1']]);
    expect(await sql`SELECT 1 FROM business_operation_history WHERE operation_id = ${op.id} AND event_type = 'STATUS_CHANGED'`).toHaveLength(1);
    await invariants(compte);
  });

  it('F-092 / F-093 / C12-03 — acompte puis facture de solde citant l\'acompte : une Opération, coût 12 000 (jamais 15 000)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const base = { provider: 'Toitures du Rhône', targetHints: [cible(maison.id)] };
    await document(compte, maison.id, [cand({ ...base, statusHint: 'ENVISAGED', sourceRoleHint: 'DEPOSIT_INVOICE', businessReferences: [{ kind: 'INVOICE', value: 'AC-102' }], financialHints: [fh('REALIZED_COST', 300000, { amountScope: 'DEPOSIT' })] })]);
    await passer(compte);
    const [op] = await operations(compte);
    expect(op.status).toBe('ENVISAGED');
    expect(await coutNet(op.id)).toBe(300000);
    await document(compte, maison.id, [cand({
      ...base, businessReferences: [{ kind: 'INVOICE', value: 'SO-233' }, { kind: 'INVOICE', value: 'AC-102' }], temporalHints: { realizedDate: '2026-06-30' },
      financialHints: [fh('REALIZED_COST', 1200000, { amountScope: 'TOTAL' }), fh('REALIZED_COST', 300000, { amountScope: 'DEPOSIT' }), fh('REALIZED_COST', 900000, { amountScope: 'BALANCE' })],
    })]);
    await passer(compte);
    expect(await operations(compte)).toHaveLength(1);
    expect((await operations(compte))[0]).toMatchObject({ status: 'REALIZED', realized_date: '2026-06-30' });
    expect((await composantes(op.id)).map((c) => [c.kind, c.amount_minor])).toEqual([['REALIZED_COST', 1200000]]);
    expect(await coutNet(op.id)).toBe(1200000);
    // L'acompte compté seul auparavant est une preuve de règlement (composante inactive, historisée).
    expect((await composantes(op.id, false)).map((c) => c.amount_minor)).toEqual([300000]);
    await invariants(compte);
  });

  it('F-093 — acompte 300 + solde 900 explicitement distincts, sans facture totale : 1 200', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const base = { provider: 'Toitures du Rhône', targetHints: [cible(maison.id)] };
    await document(compte, maison.id, [cand({ ...base, statusHint: 'ENVISAGED', sourceRoleHint: 'DEPOSIT_INVOICE', businessReferences: [{ kind: 'INVOICE', value: 'AC-7' }], financialHints: [fh('REALIZED_COST', 30000, { amountScope: 'DEPOSIT' })] })]);
    await document(compte, maison.id, [cand({ ...base, businessReferences: [{ kind: 'INVOICE', value: 'SO-7' }, { kind: 'INVOICE', value: 'AC-7' }], financialHints: [fh('REALIZED_COST', 90000, { amountScope: 'BALANCE' })] })]);
    await passer(compte);
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    expect(await coutNet(ops[0].id)).toBe(120000);
  });

  it('F-095 / C12-05 — avoir citant la facture : REDUCTION 100 € sur la même Opération, coût net 649 €', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-2026-0612' }], financialHints: [fh('REALIZED_COST', 74900, { amountScope: 'TOTAL' })] })]);
    await document(compte, clio.id, [cand({ sourceRoleHint: 'CREDIT_NOTE', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-2026-0612' }], financialHints: [fh('REDUCTION', 10000)] })]);
    await passer(compte);
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    expect((await composantes(ops[0].id)).map((c) => [c.kind, c.amount_minor])).toEqual([['REALIZED_COST', 74900], ['REDUCTION', 10000]]);
    expect(await coutNet(ops[0].id)).toBe(64900);
  });

  it('F-097 / F-024 / INV-FINAL-015 — preuve de paiement seule : HOLD (aucune Opération) ; la facture arrive → Opération créée, preuve rattachée sans coût', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const paiement = await document(compte, maison.id, [cand({
      confidence: 'probable', sourceRoleHint: 'PAYMENT_PROOF', provider: 'Toitures du Rhône', targetHints: [cible(maison.id, 'probable')],
      businessReferences: [{ kind: 'INVOICE', value: 'SO-233' }], financialHints: [fh('PAYMENT', 900000, { economicDate: '2026-07-10' })],
    })]);
    await passer(compte);
    expect(await operations(compte)).toEqual([]);
    expect((await candidats(paiement))[0]).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'PROBABLE_WITHOUT_MATCH', t3_pending: false });
    // Balayage suivant sans changement : le HOLD n'est pas recalculé (aucun compte sale).
    expect(await (await consolidator()).listAccountsToConsolidate(compte.id - 1, 1)).not.toContain(compte.id);

    await document(compte, maison.id, [cand({ provider: 'Toitures du Rhône', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'INVOICE', value: 'SO-233' }], financialHints: [fh('REALIZED_COST', 900000, { amountScope: 'TOTAL' })] })]);
    const r = await passer(compte);
    expect(r.holdsReevaluated).toBe(1);
    const [op, ...autres] = await operations(compte);
    expect(autres).toEqual([]);
    expect((await candidats(paiement))[0]).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op.id });
    expect((await sources(op.id)).map((s) => s.source_role)).toEqual(['INVOICE', 'PAYMENT_PROOF']);
    expect(await coutNet(op.id)).toBe(900000);
  });

  it('F-033 / C7-02b / PO-D6-05 — deux factures distinctes du même prestataire : deux Opérations si les travaux diffèrent ; mêmes travaux → plus jamais deux d\'office (M3)', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-1' }], temporalHints: { realizedDate: '2026-06-02' }, financialHints: [fh('REALIZED_COST', 10000)] })]);
    // Lot 53 (retour PO D6) : autres travaux, autre numéro → deux interventions (aucun doute).
    await document(compte, clio.id, [cand({ summary: 'Remplacement des pneus avant', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-2' }], temporalHints: { realizedDate: '2026-06-02' }, financialHints: [fh('REALIZED_COST', 32000)] })]);
    await passer(compte, { operationMatch: false });
    expect(await operations(compte)).toHaveLength(2);
    // Mêmes travaux, autre numéro : deux factures peuvent porter sur une même intervention → examen M3, aucune création d'office.
    const meme = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-3' }], temporalHints: { realizedDate: '2026-06-04' }, financialHints: [fh('REALIZED_COST', 4000)] })]);
    await passer(compte, { operationMatch: false });
    expect(await operations(compte)).toHaveLength(2);
    expect((await candidats(meme))[0]).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
  });

  it('F-048 / F-034 / C5-06 / C5-07 — ambiguïtés : deux Opérations certaines, ou faisceau sans clé (M3) → HOLD tracé, aucune troisième Opération', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    await document(compte, clio.id, [cand({ provider: 'Garage A', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }], temporalHints: { realizedDate: '2026-06-02' } })]);
    await document(compte, clio.id, [cand({ provider: 'Garage B', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'WORK_ORDER', value: 'OT9' }], temporalHints: { realizedDate: '2026-06-03' } })]);
    await passer(compte);
    expect(await operations(compte)).toHaveLength(2);
    // Prestataire non lu (lot 53, PO-D5 : un même numéro chez un AUTRE prestataire ne serait qu'un indice).
    const deux = await document(compte, clio.id, [cand({ provider: null, targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }, { kind: 'WORK_ORDER', value: 'OT9' }] })]);
    // Même garage, même bien, quelques jours plus tard, sans référence : seul un rapprochement sémantique (M3) trancherait.
    const faisceau = await document(compte, clio.id, [cand({ provider: 'Garage A', targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2026-06-05' }, financialHints: [fh('REALIZED_COST', 5000)] })]);
    await passer(compte);
    expect(await operations(compte)).toHaveLength(2);
    // Lot 42 : deux Opérations incompatibles (prestataires différents) → ambiguïté soumise à l'utilisateur (carte À traiter).
    expect((await candidats(deux))[0]).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_reason: 'ARBITRATION_REQUIRED', t3_operation_id: null });
    expect((await candidats(faisceau))[0]).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    const [detail] = await sql<{ t3_detail: { certain: Array<{ operationId: number; method: string }> } }[]>`SELECT t3_detail FROM document_operation_candidates WHERE file_id = ${deux}`;
    expect(detail.t3_detail.certain.map((c) => c.method)).toEqual(['M1', 'M1']);
  });

  it('F-010 / F-035 / F-111 / Q13 — contrat d\'assurance puis renouvellement citant la police : un CONTRACT, détails, coût prévu puis cotisation de période', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const base = { typeHint: 'CONTRACT' as const, provider: 'Assur\'Habitat', targetHints: [cible(maison.id)] };
    await document(compte, maison.id, [cand({
      ...base, sourceRoleHint: 'CONTRACT_DOCUMENT', businessReferences: [{ kind: 'POLICY', value: 'HAB-559201' }],
      temporalHints: { startDate: '2026-01-01', endDate: '2026-12-31' },
      financialHints: [fh('REALIZED_COST', 48000, { amountScope: 'INSTALLMENT', periodStart: '2026-01-01', periodEnd: '2026-12-31' })],
    })]);
    await passer(compte);
    const [op] = await operations(compte);
    expect(op).toMatchObject({ type_code: 'CONTRACT', status: 'REALIZED', start_date: '2026-01-01', end_date: '2026-12-31', realized_date: null });
    expect((await composantes(op.id)).map((c) => c.kind)).toEqual(['FORECAST_COST']);
    // Renouvellement 2027 (signé, à effet futur) + avis d'échéance facturé.
    await document(compte, maison.id, [cand({
      ...base, sourceRoleHint: 'INVOICE', businessReferences: [{ kind: 'POLICY', value: 'HAB-559201' }, { kind: 'INVOICE', value: 'ECH-2027' }],
      temporalHints: { startDate: '2026-01-01', endDate: '2027-12-31' },
      financialHints: [fh('REALIZED_COST', 51000, { amountScope: 'INSTALLMENT', periodStart: '2027-01-01', periodEnd: '2027-12-31' })],
    })]);
    await passer(compte);
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    // Lot 86C (assertion corrigée) : l'avis d'échéance (facture) porte une période FACTURÉE — il ne prolonge pas
    // la fin du contrat fixée par la police (2026-12-31) ; la cotisation 2027 reste une composante datée.
    expect(ops[0]).toMatchObject({ status: 'REALIZED', end_date: '2026-12-31' });
    expect((await composantes(op.id)).map((c) => [c.kind, c.amount_minor, c.period_start])).toEqual([['FORECAST_COST', 48000, '2026-01-01'], ['REALIZED_COST', 51000, '2027-01-01']]);
    expect(await sql`SELECT contract_reference, effective_from::text AS f, effective_to::text AS t FROM business_operation_contract_details WHERE operation_id = ${op.id}`)
      .toEqual([{ contract_reference: 'HAB-559201', f: '2026-01-01', t: '2026-12-31' }]);
  });

  it('Q13 / C11.1 — contrat signé à effet futur : ENVISAGED ; arrivé à sa date d\'effet, le passage le rend REALIZED', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    await document(compte, maison.id, [cand({ typeHint: 'CONTRACT', sourceRoleHint: 'CONTRACT_DOCUMENT', provider: 'Assur', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'POLICY', value: 'FUT-1' }], temporalHints: { startDate: '2099-01-01' } })]);
    await passer(compte);
    const [op] = await operations(compte);
    expect(op.status).toBe('ENVISAGED');
    await sql`UPDATE business_operations SET start_date = current_date - 1 WHERE id = ${op.id}`;
    await sql`UPDATE document_operation_candidates SET payload = jsonb_set(payload, '{temporalHints,startDate}', to_jsonb((current_date - 1)::text)) WHERE t3_operation_id = ${op.id}`;
    expect(await (await consolidator()).listAccountsToConsolidate(compte.id - 1, 1)).toEqual([compte.id]);
    const r = await passer(compte, { today: new Date().toISOString().slice(0, 10) });
    expect(r.contractsActivated).toBe(1);
    expect((await operations(compte))[0].status).toBe('REALIZED');
  });

  it('F-162 / F-105 / C12-09 — achat (ticket CHF) : ACQUISITION, montant et devise d\'origine, aucune conversion EUR', async () => {
    const compte = await make.account();
    const velo = await make.asset(compte, { category: 'VEHICULE' });
    await document(compte, velo.id, [cand({ typeHint: 'ACQUISITION', provider: 'Velo Zürich AG', targetHints: [cible(velo.id)], temporalHints: { realizedDate: '2026-08-14' }, financialHints: [fh('REALIZED_COST', 449000, { currency: 'CHF', amountScope: 'TOTAL', economicDate: '2026-08-14' })] })]);
    await passer(compte);
    const [op] = await operations(compte);
    expect(op).toMatchObject({ type_code: 'ACQUISITION', status: 'REALIZED', realized_date: '2026-08-14' });
    expect(await composantes(op.id)).toEqual([expect.objectContaining({ kind: 'REALIZED_COST', amount_minor: 449000, currency: 'CHF', amount_eur_cents: null })]);
  });

  it('F-017 / F-101 / point 7 — acte de vente sur bien VENDU : DISPOSAL + PROCEED ; une facture d\'entretien nouvelle sur ce bien reste HOLD (hors périmètre)', async () => {
    const compte = await make.account();
    const auto = await make.asset(compte);
    await sql`UPDATE assets SET status = 'VENDU' WHERE id = ${auto.id}`;
    await document(compte, auto.id, [cand({ typeHint: 'DISPOSAL', sourceRoleHint: 'SALE_DOCUMENT', provider: 'M. Acheteur', targetHints: [cible(auto.id)], temporalHints: { realizedDate: '2026-09-01' }, financialHints: [fh('PROCEED', 1000000, { economicDate: '2026-09-01' })] })]);
    const entretien = await document(compte, auto.id, [cand({ targetHints: [cible(auto.id)], financialHints: [fh('REALIZED_COST', 20000)] })]);
    await passer(compte);
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type_code: 'DISPOSAL', status: 'REALIZED', realized_date: '2026-09-01' });
    expect((await composantes(ops[0].id)).map((c) => [c.kind, c.amount_minor])).toEqual([['PROCEED', 1000000]]);
    expect((await candidats(entretien))[0]).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'TARGET_OUT_OF_PORTFOLIO' });
    // La réconciliation des CHAMPS reste exclue pour ce bien (aucun run T3 bien créé).
    expect(await sql`SELECT 1 FROM reconciliation_runs WHERE asset_id = ${auto.id}`).toHaveLength(0);
  });

  it('F-029 / F-114 / C10-02 — facture multi-biens : une Opération, deux biens CONCERNED, composante globale sans ventilation', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const tesla = await make.asset(compte);
    await document(compte, clio.id, [cand({ provider: 'Pneus Express', targetHints: [cible(clio.id), cible(tesla.id), cible(999999, 'probable')], financialHints: [fh('REALIZED_COST', 116000, { amountScope: 'TOTAL' })] })]);
    await passer(compte);
    const [op, ...autres] = await operations(compte);
    expect(autres).toEqual([]);
    expect((await liens(op.id)).map((l) => [l.asset_id, l.link_role])).toEqual([[clio.id, 'CONCERNED'], [tesla.id, 'CONCERNED']]);
    expect(await composantes(op.id)).toEqual([expect.objectContaining({ amount_minor: 116000, target_asset_id: null })]);
  });

  it('F-078 / P08 — existence certaine, aucune cible : Opération sans bien (aucun lien)', async () => {
    const compte = await make.account();
    await document(compte, null, [cand({ financialHints: [fh('REALIZED_COST', 1000)] })]);
    await passer(compte);
    const [op] = await operations(compte);
    expect(op.invalidated_at).toBeNull();
    expect(await liens(op.id)).toEqual([]);
  });

  // ══ Cycle de vie des sources (C9, C9.1) ══════════════════════════════════

  it('F-061 / INV-039 — réanalyse identique : aucun historique, aucun événement, même Opération ; seule la version technique de la source suit', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const c = cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-9' }], financialHints: [fh('REALIZED_COST', 74900)] });
    const fichier = await document(compte, clio.id, [c]);
    await passer(compte);
    const [op] = await operations(compte);
    const avantH = await historique(compte);
    const [{ source_version: v1 }] = await sources(op.id);
    await t1(compte, fichier, [c], true);
    const recus: string[] = [];
    (await bus()).subscribeBusinessOperationEvents('e2e', (e) => { recus.push(e.type); });
    const r = await passer(compte);
    expect(r.changes).toBe(0);
    expect(await historique(compte)).toBe(avantH);
    expect(recus).toEqual([]);
    expect(await operations(compte)).toHaveLength(1);
    const [s] = await sources(op.id);
    expect(s.active).toBe(true);
    expect(s.source_version).not.toBe(v1);
    expect((await candidats(fichier)).map((x) => [x.status, x.t3_pending, x.t3_outcome])).toEqual([['SUPERSEDED', false, 'CREATE_NEW'], ['ACTIVE', false, 'MATCH_AND_ENRICH']]);
  });

  it('F-062 / F-109 — réanalyse qui corrige le montant (1 000 → 1 200) : une composante courante, jamais +1 200', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const c = (amount: number) => cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-10' }], financialHints: [fh('REALIZED_COST', amount)] });
    const fichier = await document(compte, clio.id, [c(100000)]);
    await passer(compte);
    await t1(compte, fichier, [c(120000)], true);
    await passer(compte);
    const [op] = await operations(compte);
    expect((await composantes(op.id)).map((x) => x.amount_minor)).toEqual([120000]);
    expect((await composantes(op.id, false)).map((x) => x.amount_minor)).toEqual([100000]);
  });

  it('F-063 — réanalyse qui ne produit plus de candidat : source désactivée, Opération invalidée (aucune autre source)', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const fichier = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], financialHints: [fh('REALIZED_COST', 5000)] })]);
    await passer(compte);
    await t1(compte, fichier, [], true);
    await passer(compte);
    const [op] = await operations(compte);
    expect(op).toMatchObject({ invalidation_reason: 'T3_NO_ACTIVE_SOURCE' });
    expect(op.invalidated_at).not.toBeNull();
    expect((await sources(op.id)).map((s) => s.active)).toEqual([false]);
  });

  it('F-064 / F-065 / F-107 / INV-FINAL-019 — document supprimé : contributions retirées ; seule source → Opération invalidée, composantes inactives ; 1 source sur 2 → Opération active', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const seul = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'S-1' }], financialHints: [fh('REALIZED_COST', 5000)] })]);
    const copieA = await document(compte, clio.id, [cand({ provider: 'Autre', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'D-1' }], financialHints: [fh('REALIZED_COST', 7000)] })]);
    const copieB = await document(compte, clio.id, [cand({ provider: 'Autre', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'D-1' }], financialHints: [fh('REALIZED_COST', 7000)] })]);
    await passer(compte);
    const [opSeul, opDouble] = await operations(compte);
    expect((await composantes(opDouble.id))[0].sources).toBe(2); // F-108 : deux copies, une composante

    // Suppression (route) : le cycle de vie des preuves demande la consolidation ; l'état fait foi.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id IN (${seul}, ${copieA})`;
    const { onDocumentsDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    const demandes: unknown[] = [];
    await onDocumentsDeleted({ accountId: compte.id, userId: compte.ownerUserId, fileIds: [seul, copieA] }, {
      withdraw: async () => ({ evidenceIds: [], assetIds: [], dryRun: false }) as never, enqueue: async () => undefined,
      operations: (a, e) => { demandes.push([a, e]); },
    });
    expect(demandes).toEqual([[compte.id, { trigger: 'document_deleted' }]]);
    expect(await (await consolidator()).listDirtyDocuments(compte.id, 10)).toEqual([seul, copieA].sort((a, b) => a - b));
    await passer(compte);

    const [s, d] = await operations(compte);
    expect(s.invalidated_at).not.toBeNull();
    expect(await composantes(opSeul.id)).toEqual([]);
    expect((await composantes(opSeul.id, false)).map((c) => c.amount_minor)).toEqual([5000]);
    expect(d.invalidated_at).toBeNull();
    expect((await composantes(opDouble.id)).map((c) => [c.amount_minor, c.sources])).toEqual([[7000, 1]]);
    expect((await sources(opDouble.id)).filter((x) => x.active).map((x) => x.source_entity_key)).toEqual([String(copieB)]);
    expect(await sql`SELECT 1 FROM business_operation_history WHERE operation_id = ${opSeul.id} AND event_type = 'INVALIDATED'`).toHaveLength(1);
    await invariants(compte);
  });

  it('F-066 — document restauré : la même Opération est réactivée (M2, même source)', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const fichier = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], financialHints: [fh('REALIZED_COST', 5000)] })]);
    await passer(compte);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${fichier}`;
    await passer(compte);
    const [op] = await operations(compte);
    expect(op.invalidated_at).not.toBeNull();
    await sql`UPDATE asset_files SET deleted_at = NULL WHERE id = ${fichier}`;
    await passer(compte, { fileIds: [fichier] });
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: op.id, invalidated_at: null });
    expect(await coutNet(op.id)).toBe(5000);
    expect(await sql`SELECT 1 FROM business_operation_history WHERE operation_id = ${op.id} AND event_type = 'REACTIVATED'`).toHaveLength(1);
  });

  it('TRG-006 / F-056 — document déplacé : la cible déduite du rattachement suit ; une cible prouvée par T1 est conservée', async () => {
    const compte = await make.account();
    const a = await make.asset(compte);
    const b = await make.asset(compte);
    const deduit = await document(compte, a.id, [cand({ provider: 'P1', financialHints: [fh('REALIZED_COST', 100)] })]);
    const prouve = await document(compte, a.id, [cand({ provider: 'P2', targetHints: [cible(a.id)], financialHints: [fh('REALIZED_COST', 200)] })]);
    await passer(compte);
    const [opD, opP] = await operations(compte);
    expect((await liens(opD.id))[0]).toMatchObject({ asset_id: a.id, authority: 'INFERENCE' });
    await sql`UPDATE asset_files SET asset_id = ${b.id} WHERE id IN (${deduit}, ${prouve})`;
    await passer(compte);
    expect((await liens(opD.id)).filter((l) => l.active).map((l) => l.asset_id)).toEqual([b.id]);
    expect((await liens(opP.id)).filter((l) => l.active).map((l) => l.asset_id)).toEqual([a.id]);
  });

  it('TRG-007 — document reclassé en type non métier (photo) : ses contributions sont retirées', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const fichier = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], financialHints: [fh('REALIZED_COST', 100)] })]);
    await passer(compte);
    await sql`UPDATE asset_files SET document_type_code = 'PHOTO' WHERE id = ${fichier}`;
    await passer(compte);
    const [op] = await operations(compte);
    expect(op.invalidated_at).not.toBeNull();
    expect((await candidats(fichier))[0]).toMatchObject({ t3_outcome: 'NO_OPERATION', t3_reason: 'DOCUMENT_NOT_BUSINESS' });
  });

  // ══ Technique : concurrence, idempotence, file, balayage ═════════════════

  it('F-166 / NFR-OP-001 — deux passages concurrents sur le même compte : une seule Opération, une seule source', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'C-1' }], financialHints: [fh('REALIZED_COST', 100)] })]);
    const [r1, r2] = await Promise.all([passer(compte), passer(compte)]);
    expect((r1.outcomes.CREATE_NEW ?? 0) + (r2.outcomes.CREATE_NEW ?? 0)).toBe(1);
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    expect(await sources(ops[0].id)).toHaveLength(1);
    expect(await composantes(ops[0].id)).toHaveLength(1);
  });

  it('NFR-OP-004 / NFR-OP-005 / INV-040 / F-090 / F-184 — idempotence : passage rejoué = même état ; balayage sans changement = compte non mis en file, 0 historique', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const fichier = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], financialHints: [fh('REALIZED_COST', 100)] })]);
    await passer(compte);
    const h = await historique(compte);
    const r = await passer(compte, { fileIds: [fichier], reevaluateHolds: true });
    expect(r.changes).toBe(0);
    expect(await historique(compte)).toBe(h);
    expect(await (await consolidator()).listDirtyDocuments(compte.id, 10)).toEqual([]);
    const ids = await (await consolidator()).listAccountsToConsolidate(compte.id - 1, 50);
    expect(ids).not.toContain(compte.id);
  });

  it('C4 / file durable — demande dédoublonnée par compte, travail `business_operations` exécuté par l\'exécutant T3 de production ; page de balayage : seuls les comptes sales', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const fichier = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], financialHints: [fh('REALIZED_COST', 100)] })]);
    const repo = await import('@/services/ai/queue/job-queue.repository');
    const triggers = await import('@/services/ai/queue/triggers');
    triggers.__setTriggerConfigLoader(async () => null);
    const admin = await make.user();
    await repo.setEmergencyStop(false, admin.id);
    await repo.setTreatmentState('T3', 'ENABLED', admin.id);
    const { registerJobHandler, runOne } = await import('@/services/ai/queue/queue-worker');
    const { t3JobHandler } = await import('@/services/ai/reconciliation/t3-queue');
    registerJobHandler('T3', t3JobHandler);
    const q = await import('@/services/business-operations/consolidation/queue');
    try {
      const j1 = await q.onDocumentAnalyzedForOperations(compte.id, fichier);
      const j2 = await q.requestOperationsConsolidation(compte.id, { trigger: 'document_moved', fileId: fichier });
      expect(j1).not.toBeNull();
      expect(j2).toBe(j1);
      const [job] = await sql<{ id: number; target_type: string; target_id: string; trigger_code: string; payload: { kind: string; events: Array<{ trigger: string }> } }[]>`
        SELECT id, target_type, target_id, trigger_code, payload FROM ai_job_queue WHERE id = ${j1!}`;
      expect(job).toMatchObject({ target_type: 'business_operations', target_id: String(compte.id), trigger_code: 'source_analyzed' });
      expect(job.payload.events.map((e) => e.trigger)).toEqual(['source_analyzed', 'document_moved']);
      // Seul ce travail est prélevable (base partagée).
      await sql`UPDATE ai_job_queue SET available_at = now() + interval '1 day' WHERE treatment = 'T3' AND status = 'PENDING' AND id <> ${j1!}`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${j1!}`;
      expect(await runOne('T3')).toBe(true);
      const [fini] = await sql<{ status: string; business_result: unknown }[]>`SELECT status, business_result FROM ai_job_queue WHERE id = ${j1!}`;
      expect(fini.status).toBe('DONE');
      expect(JSON.stringify(fini.business_result)).toContain('APPLIED');
      expect(await operations(compte)).toHaveLength(1);

      // Balayage : un compte sale (candidat en attente) est mis en file, un compte propre jamais.
      const sale = await make.account();
      const bien = await make.asset(sale);
      await document(sale, bien.id, [cand({ targetHints: [cible(bien.id)] })]);
      await q.runOperationsSweepPage(
        { id: 0, triggerCode: 'schedule_hourly' } as never,
        { kind: 'business_operations_sweep', cycleId: `e2e-${sale.id}`, page: 0, afterAccountId: compte.id - 1, requestedAt: null },
        { assertActive: async () => {} } as never,
      );
      const enfile = await sql<{ account_id: number }[]>`SELECT account_id FROM ai_job_queue WHERE target_type = 'business_operations' AND status = 'PENDING' AND account_id IN (${compte.id}, ${sale.id})`;
      expect(enfile.map((x) => x.account_id)).toEqual([sale.id]);
    } finally {
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE treatment = 'T3' AND status = 'PENDING' AND target_type IN ('business_operations', 'business_operations_sweep')`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE treatment = 'T3' AND status = 'PENDING'`;
      triggers.__setTriggerConfigLoader(null);
    }
  });

  it('C16.2 anti-boucle — une écriture Opération ne déclenche aucun travail T3', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)] })]);
    await passer(compte);
    expect(await sql`SELECT 1 FROM ai_job_queue WHERE account_id = ${compte.id} AND treatment = 'T3'`).toHaveLength(0);
  });
});
