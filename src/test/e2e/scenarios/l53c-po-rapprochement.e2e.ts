/**
 * Lot 53C — retour PO D5, D6, D7 : rapprochement factures ↔ interventions —
 * base PostgreSQL réelle, sorties IA ENREGISTRÉES (passerelle réelle,
 * fournisseur de rejeu : aucun appel réseau).
 *
 *   PO-D5 : faisceau (bien, nature, montants, prestataire, dates = indices) ;
 *           ambiguïté → carte « À traiter » avec les candidats ;
 *   PO-D6 : deux factures finales de numéros différents → plus jamais deux
 *           interventions d'office ; M3 / utilisateur tranchent ;
 *   PO-D7 : au-delà de 5 candidats, examen progressif par lots, trace des
 *           examinés / restants, report (plafond) et reprise aux cycles
 *           suivants, sans famine ; reprise des traces du lot 42 (0348).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import type { RecordedOutput } from '../replay-gateway';

const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');
const AUJOURDHUI = '2026-10-12';

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Remplacement des plaquettes de frein', sourceRoleHint: 'INVOICE', provider: 'Garage Martin',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1' }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });
const m3 = (decision: 'SAME_OPERATION' | 'DISTINCT_OPERATION' | 'AMBIGUOUS', matchedCandidateId: number | null, confidence = 'certain'): RecordedOutput => ({
  operationCode: 't3_operation_match', task: 'OPERATION_MATCH',
  output: { task: 'OPERATION_MATCH', decision, matchedCandidateId, confidence, concordantSignals: ['même bien'], contradictions: [], reason: 'enregistré' },
});

scenario('L53C-D5-D7', 'Rapprochement factures ↔ interventions : faisceau, D6, examen M3 progressif', ({ sql, make, useRecordings }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  async function document(compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[], titre?: string) {
    const f = await make.assetFile(compte, { assetId });
    if (titre) await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, { accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map() });
    });
    return f.id;
  }
  type PasserOpts = Parameters<Awaited<ReturnType<typeof consolidator>>['consolidateAccountOperations']>[1];
  const passer = async (compte: AccountRow, opts: PasserOpts = {}) =>
    (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, ...opts });
  const actives = (compte: AccountRow) => sql<{ id: number }[]>`
    SELECT id::int AS id FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`;
  const candidat = async (fileId: number) => (await sql<{ t3_outcome: string; t3_reason: string; t3_operation_id: number | null; t3_detail: Record<string, any>; t3_pending: boolean }[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id, t3_detail, t3_pending FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];
  const ouvertes = (compte: AccountRow, rule: string) => sql<{ public_id: string; target_id: number; question: string; proposals_json: Array<{ value: string }>; trigger_context: Record<string, any> }[]>`
    SELECT public_id, target_id, question, proposals_json, trigger_context FROM to_process_actions
     WHERE account_id = ${compte.id} AND rule_code = ${rule} AND resolved_at IS NULL ORDER BY id`;

  /** Intervention existante « semée » par l'API d'écriture (source documentaire non gérée par T3 : stable). */
  async function intervention(compte: AccountRow, assetId: number, date: string, label = 'Remplacement des plaquettes de frein'): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const r = await withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: 'INTERVENTION' }, status: 'REALIZED', realizedDate: date, technicalLabel: label, provider: 'Garage Martin',
      source: { kind: 'DOCUMENT', entityKey: f.id, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { e2e: 'seed' } },
      assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }));
    return r.id;
  }

  // ══ D6 ═════════════════════════════════════════════════════════════════════

  it('PO-D6-06 / F-033 — deux factures finales, numéros différents, mêmes travaux : M3 « même intervention » certain → UNE intervention portant les deux factures', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-1' }], temporalHints: { realizedDate: '2026-06-02' }, financialHints: [fh('REALIZED_COST', 18000)] })], 'Facture plaquettes');
    await passer(compte, { operationMatch: false });
    const [op] = await actives(compte);
    const f2 = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-2' }], temporalHints: { realizedDate: '2026-06-03' }, financialHints: [fh('REALIZED_COST', 6000)] })], 'Facture main d’œuvre');
    await passer(compte, { operationMatch: false });
    // Plus jamais deux interventions d'office (D6) : attente du rapprochement sémantique.
    expect(await actives(compte)).toHaveLength(1);
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    expect((await candidat(f2)).t3_detail.plausible).toEqual([op.id]);
    await useRecordings([m3('SAME_OPERATION', op.id)]);
    await passer(compte);
    expect(await actives(compte)).toEqual([op]);
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M3', t3_operation_id: op.id });
    expect((await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${op.id} AND active AND source_kind = 'DOCUMENT'`).length).toBe(2);
  });

  it('PO-D6-07 / PO-D5-09 — doute (M3 incertain) : carte « À traiter » présentant le candidat, choix « autre intervention » → deux interventions ; jamais de fusion sur le seul prestataire', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-1' }], temporalHints: { realizedDate: '2026-06-02' } })], 'Facture plaquettes');
    await passer(compte, { operationMatch: false });
    const [op] = await actives(compte);
    const f2 = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FA-9' }], temporalHints: { realizedDate: '2026-08-20' }, financialHints: [fh('REALIZED_COST', 6000)] })], 'Facture août');
    await useRecordings([m3('SAME_OPERATION', op.id, 'probable')]);
    await passer(compte);
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_reason: 'M3_AMBIGUOUS' });
    const [carte, ...autres] = await ouvertes(compte, 'OPERATION-MATCH');
    expect(autres).toEqual([]);
    expect(carte.target_id).toBe(f2);
    expect(carte.proposals_json.map((p) => p.value)).toEqual([`SAME:${op.id}`, 'DISTINCT']);
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(compte.id, carte.public_id, 'DISTINCT', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    expect(await actives(compte)).toHaveLength(2);
    expect((await sql`SELECT 1 FROM business_operation_history WHERE account_id = ${compte.id} AND event_type = 'MERGED'`)).toHaveLength(0);
  });

  it('PO-D5-10 — prestataire non lu, même bien, même nature de travaux : plus de doublon créé d\'office (M3) ; autre nature : création', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await document(compte, maison.id, [cand({ summary: 'Entretien annuel chaudière', provider: 'Chauffage Dupuis', targetHints: [cible(maison.id)], temporalHints: { realizedDate: '2026-02-10' } })]);
    await passer(compte, { operationMatch: false });
    const sansTiers = await document(compte, maison.id, [cand({ summary: 'Chaudière : entretien et ramonage', provider: null, targetHints: [cible(maison.id)], temporalHints: { realizedDate: '2026-02-12' } })]);
    const autre = await document(compte, maison.id, [cand({ summary: 'Pose de volets roulants', provider: null, targetHints: [cible(maison.id)], temporalHints: { realizedDate: '2026-02-12' } })]);
    await passer(compte, { operationMatch: false });
    expect(await candidat(sansTiers)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    expect(await candidat(autre)).toMatchObject({ t3_outcome: 'CREATE_NEW' });
    expect(await actives(compte)).toHaveLength(2);
  });

  // ══ D7 ═════════════════════════════════════════════════════════════════════

  it('PO-D7-05 — 7 interventions plausibles : lot 1 (5) examiné, DISTINCT → lot 2 au cycle suivant (sweep), SAME → rattachement ; traces examinées / restantes visibles au BO', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await intervention(compte, clio.id, `2026-0${1 + Math.floor(i / 2)}-1${i}`));
    const facture = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2026-04-20' } })], 'Facture sans référence');
    await passer(compte, { operationMatch: false });
    const c1 = await candidat(facture);
    expect(c1).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    expect(c1.t3_detail.plausible).toHaveLength(7);
    // Plus d'abandon : empreinte posée, lot courant de 5, aucune trace TOO_MANY_CANDIDATES.
    expect(c1.t3_detail.m3Fingerprint).toEqual(expect.any(String));
    expect(c1.t3_detail.m3Batch).toHaveLength(5);
    expect(c1.t3_detail.m3Progress).toMatchObject({ distinct: [], rounds: 0, total: 7, remaining: 2 });
    const lot1: number[] = c1.t3_detail.m3Batch;
    const lot2 = ids.filter((id) => !lot1.includes(id));

    // Cycle 1 : lot 1 jugé distinct avec certitude → aucune création, lot 2 préparé.
    const replay = await useRecordings([m3('DISTINCT_OPERATION', null), m3('SAME_OPERATION', lot2[0])]);
    const r1 = await passer(compte);
    expect(r1.m3).toMatchObject({ calls: 1 });
    expect(replay.calls).toHaveLength(1);
    const c2 = await candidat(facture);
    expect(c2).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    expect(c2.t3_detail.m3Progress).toMatchObject({ distinct: [...lot1].sort((a, b) => a - b), rounds: 1, total: 7, remaining: 0 });
    expect([...c2.t3_detail.m3Batch].sort()).toEqual([...lot2].sort());
    expect(await actives(compte)).toHaveLength(7);
    // BO › Opérations › En attente T3 : état, examinées, restantes.
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const holds = await new OperationDiagnosticsService().holds({ accountId: compte.id, outcome: null, reason: null, page: 1, pageSize: 25 } as never);
    expect(holds.items[0].m3).toMatchObject({ examined: 5, batch: expect.arrayContaining(lot2), total: 7 });
    // Reprise par le balayage horaire (aucun abandon) : le compte est remis en file.
    const { listAccountsToConsolidate } = await consolidator();
    expect(await listAccountsToConsolidate(compte.id - 1, 50, null)).toContain(compte.id);

    // Cycle 2 : lot 2 → « même intervention » certain → rattachement.
    const r2 = await passer(compte);
    expect(r2.m3).toMatchObject({ calls: 1 });
    expect(replay.calls).toHaveLength(2);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M3', t3_operation_id: lot2[0] });
    // Le modèle n'a jamais reçu plus de 5 Opérations (lot 1 : 5, lot 2 : 2).
    expect((await candidat(facture)).t3_detail.m3.operationIds).toHaveLength(2);
  });

  it('PO-D7-06 — tous les lots distincts : création (aucun doublon tant qu\'un lot reste à examiner) ; plafond par passage : report tracé (motif, reprise) puis servi au cycle suivant, sans famine', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    for (let i = 0; i < 6; i++) await intervention(compte, clio.id, `2026-0${1 + Math.floor(i / 2)}-1${i}`);
    const facture = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2026-04-20' } })], 'Facture A');
    const autre = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2026-04-22' } })], 'Facture B');
    await passer(compte, { operationMatch: false });
    await useRecordings([m3('DISTINCT_OPERATION', null), m3('DISTINCT_OPERATION', null), m3('DISTINCT_OPERATION', null), m3('DISTINCT_OPERATION', null)]);
    // Un appel par passage : le second candidat est REPORTÉ (motif, date de reprise), jamais oublié.
    const r1 = await passer(compte, { operationMatch: { maxCallsPerPass: 1 } });
    expect(r1.m3).toMatchObject({ calls: 1, deferred: 1, deferredReasons: { PASS_CAP: 1 } });
    expect((await candidat(facture)).t3_detail.m3).toMatchObject({ status: 'DONE' });
    expect((await candidat(autre)).t3_detail.m3).toMatchObject({ status: 'DEFERRED', detail: 'PASS_CAP', retryAfter: expect.any(String), deferredAt: expect.any(String), at: '' });
    // Passage suivant : le reporté est servi EN PREMIER (jamais tenté → en tête), l'autre attend à son tour.
    const r2 = await passer(compte, { operationMatch: { maxCallsPerPass: 1 } });
    expect(r2.m3).toMatchObject({ calls: 1, deferred: 1 });
    expect((await candidat(autre)).t3_detail.m3).toMatchObject({ status: 'DONE' });
    expect((await candidat(facture)).t3_detail.m3).toMatchObject({ status: 'DEFERRED', detail: 'PASS_CAP' });
    await passer(compte, { operationMatch: { maxCallsPerPass: 1 } });
    await passer(compte, { operationMatch: { maxCallsPerPass: 1 } });
    // Les deux factures ont vu leurs deux lots examinés (5 + 1) : toutes distinctes → création.
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'CREATE_NEW', t3_reason: 'M3_DISTINCT' });
    expect(await candidat(autre)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
  });

  it('PO-D7-07 — reprise des traces du lot 42 (« trop de candidats », sans empreinte) par la migration 0348 : remises en consolidation, puis examinées', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    for (let i = 0; i < 6; i++) await intervention(compte, clio.id, `2026-0${1 + Math.floor(i / 2)}-1${i}`);
    const facture = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2026-04-20' } })]);
    await passer(compte, { operationMatch: false });
    // État laissé par le lot 42 : ni empreinte ni lot, trace « TOO_MANY_CANDIDATES ».
    await sql`UPDATE document_operation_candidates SET t3_detail = (t3_detail - 'm3Fingerprint' - 'm3Batch' - 'm3Progress')
                || jsonb_build_object('m3', jsonb_build_object('status', 'TOO_MANY_CANDIDATES', 'fingerprint', 'x', 'at', '2026-10-01T00:00:00Z'))
               WHERE file_id = ${facture}`;
    const { listAccountsToConsolidate } = await consolidator();
    expect(await listAccountsToConsolidate(compte.id - 1, 50, null)).not.toContain(compte.id);
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0348_operations_m3_progressive_requeue.sql'), 'utf8');
    await sql.unsafe(migration.replace(/^SET LOCAL.*$/m, ''));
    expect((await candidat(facture)).t3_pending).toBe(true);
    expect(await listAccountsToConsolidate(compte.id - 1, 50, null)).toContain(compte.id);
    await sql.unsafe(migration.replace(/^SET LOCAL.*$/m, ''));
    await useRecordings([m3('DISTINCT_OPERATION', null)]);
    const r = await passer(compte);
    expect(r.m3).toMatchObject({ calls: 1 });
    expect((await candidat(facture)).t3_detail.m3Progress).toMatchObject({ rounds: 1, total: 6 });
  });
});
