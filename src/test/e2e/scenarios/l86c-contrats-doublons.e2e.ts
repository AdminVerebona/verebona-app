/**
 * Lot 86C — ticket P1 « T3 / Opérations / Agenda : doublons de contrats,
 * fausses dates de fin et autoréparation », sur PostgreSQL 16 réel.
 * Persistance T1 réelle des candidats, consolidation T3 réelle (M0 → M3,
 * examen rétroactif, fusion existante), référentiel fournisseurs, projection
 * Agenda réelle, contrôle de cohérence (orchestrateur unique, campagnes à
 * blanc puis corrective), lecture de l'assistant. Modèle IA SIMULÉ (aucun
 * réseau). Date de référence injectée (jamais la date du jour).
 *
 * Cas réel reproduit sans aucun nom codé dans l'application : un même
 * abonnement de télésurveillance facturé sous deux désignations
 * (« Télésurveillance Nord » puis « TSN Services »), une période facturée
 * (05/07 → 04/08) enregistrée comme période contractuelle, une « Fin de
 * contrat » projetée à la fin de la dernière période facturée.
 *
 *   L86C-E2E-01  factures mensuelles d'un abonnement → UNE Opération, plusieurs coûts, aucune date de contrat, aucune « Fin de contrat » ;
 *   L86C-E2E-02  deux Opérations historiques d'un même contrat (désignations équivalentes par le référentiel fournisseurs, compte client commun)
 *                → à blanc : constat sans écriture ; correctif : fusion automatique, coûts et historique conservés, sans IA ;
 *   L86C-E2E-03  désignation différente sans équivalence prouvée (désignation citée) → réexamen T3, M3 tranche, fusion ;
 *                M3 « distinct » → aucune fusion, résultat stable ;
 *   L86C-E2E-04  deux contrats réellement distincts chez un prestataire → aucune fusion, aucune réparation ;
 *   L86C-E2E-05  installation ponctuelle et abonnement → deux réalités ;
 *   L86C-E2E-06  stock : dates de contrat issues d'une période facturée + « Fin de contrat » projetée → retirées par le contrôle
 *                (historique réversible, trace de retrait), Agenda / assistant corrigés ; élément touché par l'utilisateur conservé ;
 *   L86C-E2E-07  fin contractuelle explicitement prouvée → échéance correcte, sourcée, conservée par le contrôle ;
 *   L86C-E2E-08  réconciliations et campagnes répétées → aucune duplication, aucune perte, résultat stable ;
 *   L86C-E2E-09  extraction T1 réparée (référence de service ajoutée) → nouvelle réconciliation et propagation ;
 *   L86C-E2E-10  décision de l'utilisateur (document retiré) → jamais défaite par le contrôle ;
 *   L86C-E2E-11  cas réel complet (compte et bien de recette) : rapprochement, fusion, factures et coûts conservés, fausse fin supprimée,
 *                aucune réapparition après T3 et contrôle récurrent.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import type { AccountRow } from '../factories';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, fh, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
/** Date de référence injectée (jour > 12 : jamais ambiguë jour / mois). */
const AUJ = '2026-10-24';
const NORD = 'Télésurveillance Nord';
const TSN = 'TSN Services';
const pad = (m: number) => String(m).padStart(2, '0');
/** Période facturée « du 05 au 04 » (cas réel #86 : 05/07 → 04/08/2026). */
const periode = (an: number, m: number) => ({ start: `${an}-${pad(m)}-05`, end: m === 12 ? `${an + 1}-01-04` : `${an}-${pad(m + 1)}-04` });

/** Facture d'abonnement : T1 recopie la période facturée dans `temporalHints` (comportement constaté). */
function abonnement(assetId: number, an: number, m: number, o: {
  provider?: string; summary?: string; client?: string | null; contrat?: string; montant?: number; typeHint?: AnchoredOperationCandidate['typeHint']; prefixe?: string;
} = {}): AnchoredOperationCandidate {
  const p = periode(an, m);
  return cand({
    typeHint: o.typeHint === undefined ? 'CONTRACT' : o.typeHint, sourceRoleHint: 'INVOICE', provider: o.provider ?? NORD,
    summary: o.summary ?? `Abonnement mensuel ${NORD} — ${pad(m)}/${an}`, targetHints: [cible(assetId)],
    businessReferences: [ref('INVOICE', `${o.prefixe ?? 'FT'}-${an}-${pad(m)}`), ...(o.client === null ? [] : [ref('CUSTOMER', o.client ?? 'CL 778 812')]),
      ...(o.contrat ? [ref('CONTRACT', o.contrat)] : [])] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { startDate: p.start, endDate: p.end },
    financialHints: [fh('REALIZED_COST', o.montant ?? 4050, { amountScope: 'INSTALLMENT', economicDate: p.start, periodStart: p.start, periodEnd: p.end })],
  });
}

// ── Modèle simulé (OPERATION_MATCH) : même bien + échéances des deux côtés → même abonnement ──
const m3 = { calls: 0, verdict: 'SAME' as 'SAME' | 'DISTINCT' };
const lire = (prompt: string, label: string): any => {
  const i = prompt.indexOf(`${label} : `);
  return i < 0 ? null : JSON.parse(prompt.slice(i + label.length + 3).split('\n')[0]);
};
function modele(input: ProviderCallInput): unknown {
  m3.calls++;
  const base = { task: 'OPERATION_MATCH', concordantSignals: ['même bien', 'mêmes échéances', 'désignation citée'], contradictions: [] as string[] };
  const candidats = (lire(input.prompt, 'Candidats') ?? []) as Array<{ candidateId: number }>;
  if (m3.verdict === 'DISTINCT' || !candidats.length) {
    return { ...base, decision: 'DISTINCT_OPERATION', matchedCandidateId: null, confidence: 'certain', reason: 'autre prestation', contradictions: ['autre service'] };
  }
  return { ...base, decision: 'SAME_OPERATION', matchedCandidateId: candidats[0].candidateId, confidence: 'certain', reason: 'échéance du même abonnement' };
}

scenario('L86C', 'Contrats : doublons, fausses dates de fin et autoréparation', ({ sql, make, replay }) => {
  let k: OperationsKit;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', modele);
  });
  afterAll(() => { setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', null); });

  // ── Outils ───────────────────────────────────────────────────────────────
  const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
  const passer = async (c: AccountRow) => (await consolidator()).consolidateAccountOperations(c.id, { today: AUJ });
  /** Passages T3 successifs (balayage) jusqu'à stabilité. */
  async function stabiliser(c: AccountRow, max = 8) {
    for (let i = 0; i < max; i++) {
      const r = await passer(c);
      const [p] = await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${c.id} AND t3_pending LIMIT 1`;
      if (r.changes === 0 && !(r.m3?.calls) && !p) break;
    }
  }
  const projeter = async (c: AccountRow) => (await import('@/services/business-operations/agenda-projection/service')).projectAccountOperations(c.id, { all: true, today: AUJ });
  const sourcesDe = async (opId: number) => (await sql<{ f: number }[]>`
    SELECT source_entity_key::int AS f FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'DOCUMENT' ORDER BY 1`).map((x) => x.f);
  const couts = async (opId: number) => (await sql<{ amount_minor: number; period_start: string | null; period_end: string | null }[]>`
    SELECT amount_minor::int AS amount_minor, period_start::text AS period_start, period_end::text AS period_end
      FROM business_operation_financial_components WHERE operation_id = ${opId} AND active AND kind = 'REALIZED_COST' ORDER BY period_start, id`);
  const details = async (opId: number) => (await sql<Json[]>`
    SELECT effective_from::text AS effective_from, effective_to::text AS effective_to FROM business_operation_contract_details WHERE operation_id = ${opId}`)[0] ?? null;
  const finsDeContrat = (c: AccountRow) => sql<{ id: number; start_date: string | null; projection_origin: string | null; op: number | null }[]>`
    SELECT id, start_date::text AS start_date, projection_origin, business_operation_id::int AS op FROM agenda_items
     WHERE account_id = ${c.id} AND business_type = 'contract' ORDER BY id`;
  const fusions = (c: AccountRow) => sql<{ id: number; into: number }[]>`
    SELECT id::int AS id, merged_into_operation_id::int AS into FROM business_operations WHERE account_id = ${c.id} AND merged_into_operation_id IS NOT NULL ORDER BY id`;
  const appelsIA = () => replay.calls.filter((x) => x.operationCode === 't3_operation_match').length;
  const cartes = (c: AccountRow) => sql`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND resolved_at IS NULL`;

  /** Fiche fournisseur et lien document → fournisseur (référentiel lot 22 : rapprochement certain). */
  async function fournisseur(c: AccountRow, nom: string): Promise<number> {
    const [s] = await sql<{ id: number }[]>`
      INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, source, status)
      VALUES (${c.id}, ${c.ownerUserId}, ${nom}, ${nom.toLowerCase()}, 'document_extraction', 'active') RETURNING id`;
    return s.id;
  }
  const lier = (fileId: number, supplierId: number) =>
    sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed, confidence_score) VALUES (${fileId}, ${supplierId}, true, 1) ON CONFLICT DO NOTHING`;

  /** Stock historique : une Opération CONTRACT par lot de documents, créée comme avant le lot 86C (candidats déjà traités). */
  async function stock(c: AccountRow, assetId: number, cands: AnchoredOperationCandidate[]): Promise<{ files: number[]; op: number }> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const files: number[] = [];
    let op = 0;
    for (const x of cands) {
      const f = await k.document(c, assetId, [x], { title: x.summary });
      files.push(f);
      const [row] = await sql<{ id: number; version: string }[]>`
        SELECT c.id, ('c' || c.id || '|a' || COALESCE(f.asset_id, f.linked_asset_id, 0) || '|t' || COALESCE(f.document_type_code, '')) AS version
          FROM document_operation_candidates c JOIN asset_files f ON f.id = c.file_id WHERE c.file_id = ${f} AND c.status = 'ACTIVE'`;
      const source = { kind: 'DOCUMENT' as const, entityKey: f, version: row.version, role: 'INVOICE' as const, authority: 'DOCUMENT' as const, confidence: 'certain' as const, locator: { candidateKey: 'op1' } };
      if (!op) {
        op = (await withBusinessOperationWrite(c.id, (repo) => repo.create({
          type: { code: 'CONTRACT' }, status: 'REALIZED', provider: x.provider ?? null, technicalLabel: x.summary,
          source: { ...source, matchMethod: null, matchReason: 'NO_MATCH_ESTABLISHED' },
          assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'T3_CREATE_NEW',
        }))).id;
      } else {
        await withBusinessOperationWrite(c.id, (repo) => repo.addSource(op, { ...source, matchMethod: 'M1', matchReason: 'MATCH_M1' }, 'T3_MATCH_AND_ENRICH'));
      }
      await sql`UPDATE document_operation_candidates SET t3_pending = false, t3_outcome = ${files.length === 1 ? 'CREATE_NEW' : 'MATCH_AND_ENRICH'},
                t3_reason = 'NO_MATCH_ESTABLISHED', t3_operation_id = ${op}, t3_detail = '{}'::jsonb WHERE id = ${row.id}`;
    }
    await (await consolidator()).reconsolidateOperations(c.id, [op], { today: AUJ });
    return { files, op };
  }
  /** État laissé par l'ancienne règle : période facturée enregistrée comme période contractuelle. */
  async function fausseFin(opId: number, from: string, to: string) {
    await sql`INSERT INTO business_operation_contract_details (operation_id, effective_from, effective_to) VALUES (${opId}, ${from}, ${to})
              ON CONFLICT (operation_id) DO UPDATE SET effective_from = EXCLUDED.effective_from, effective_to = EXCLUDED.effective_to`;
    await sql`UPDATE business_operations SET start_date = ${from}, end_date = ${to} WHERE id = ${opId}`;
  }

  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e-l86c', mode, scopeAccountIds: scope });
    for (let i = 0; i < 40; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: AUJ });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const preuve = async (accountId: number, check: string, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding, rules_version FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${check} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number, check: string) => sql<Json[]>`
    SELECT object_id::int AS object_id, service, outcome, ai_calls FROM coherence_repairs WHERE account_id = ${accountId} AND check_id = ${check} ORDER BY id`;

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-01 — factures mensuelles d’un abonnement : UNE Opération contractuelle, un coût par période, aucune date de contrat ni « Fin de contrat »', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const f: number[] = [];
    for (const mo of [7, 8, 9]) f.push(await k.document(c, m.id, [abonnement(m.id, 2026, mo)], { title: `Facture ${pad(mo)}/2026` }));
    await stabiliser(c);
    const ops = await k.actives(c);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type_code: 'CONTRACT', start_date: null, end_date: null });
    expect(await sourcesDe(ops[0].id)).toEqual(f);
    expect(await couts(ops[0].id)).toEqual([
      { amount_minor: 4050, period_start: '2026-07-05', period_end: '2026-08-04' },
      { amount_minor: 4050, period_start: '2026-08-05', period_end: '2026-09-04' },
      { amount_minor: 4050, period_start: '2026-09-05', period_end: '2026-10-04' },
    ]);
    expect((await details(ops[0].id))?.effective_to ?? null).toBeNull();
    expect((await details(ops[0].id))?.effective_from ?? null).toBeNull();
    await projeter(c);
    expect(await finsDeContrat(c)).toEqual([]);
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-02 — deux Opérations historiques d’un même contrat (désignations équivalentes, compte client commun) : constat à blanc, fusion automatique en correctif, sans IA', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const s = await fournisseur(c, 'TSN Services SAS');
    const a = await stock(c, m.id, [abonnement(m.id, 2025, 11), abonnement(m.id, 2025, 12)]);
    const b = await stock(c, m.id, [abonnement(m.id, 2026, 7, { provider: TSN, summary: 'Abonnement mensuel juillet-août 2026' })]);
    for (const f of [...a.files, ...b.files]) await lier(f, s);
    expect(await k.actives(c)).toHaveLength(2);
    const appels = appelsIA();
    const h0 = (await k.historique(c));
    // À blanc : constat, AUCUNE écriture métier.
    await campagne([c.id], 'DRY_RUN');
    expect(await preuve(c.id, 'COH-OPS-IDENTITY', b.op)).toMatchObject({ last_result: 'WOULD_REPAIR', rules_version: 2 });
    expect(await k.actives(c)).toHaveLength(2);
    expect((await k.historique(c))).toBe(h0);
    // Correctif : réexamen T3 ciblé → fusion existante (la plus ancienne reste), sans IA.
    await campagne([c.id], 'CORRECTIVE');
    const ops = await k.actives(c);
    expect(ops.map((o) => o.id)).toEqual([a.op]);
    expect(await sourcesDe(a.op)).toEqual([...a.files, ...b.files].sort((x, y) => x - y));
    expect((await couts(a.op)).map((x) => x.period_start)).toEqual(['2025-11-05', '2025-12-05', '2026-07-05']);
    expect(await fusions(c)).toEqual([{ id: b.op, into: a.op }]);
    expect(await sql`SELECT 1 FROM business_operation_history WHERE operation_id = ${b.op} AND event_type = 'MERGED'`).not.toHaveLength(0);
    expect(appelsIA()).toBe(appels);
    expect((await reparations(c.id, 'COH-OPS-IDENTITY')).map((r) => r.service)).toContain('reconsolidateRecurringDocuments');
    expect(await cartes(c)).toHaveLength(0);
    // Trace de la décision : équivalence de désignations établie par le référentiel fournisseurs.
// Fusion par la chaîne T3 existante (réexamen rétroactif / série), tracée dans l'historique des deux Opérations.
    expect(await sql`SELECT 1 FROM business_operation_history WHERE account_id = ${c.id} AND event_type = 'MERGED' AND reason_code IN ('T3_RETRO_MERGE', 'T3_SERIES_MERGE')`).not.toHaveLength(0);
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-03 — désignation différente sans équivalence prouvée (désignation citée) : M3 sollicité par le réexamen, fusion ; M3 « distinct » : aucune fusion, stable', async () => {
    for (const verdict of ['SAME', 'DISTINCT'] as const) {
      m3.verdict = verdict;
      const c = await make.account({ plan: 'premium' });
      const m = await maison(c);
      const a = await stock(c, m.id, [abonnement(m.id, 2025, 11, { client: null })]);
      const b = await stock(c, m.id, [abonnement(m.id, 2026, 7, { provider: TSN, client: null, summary: `Abonnement mensuel ${NORD} — juillet 2026` })]);
      await campagne([c.id], 'CORRECTIVE');
      expect(await preuve(c.id, 'COH-OPS-IDENTITY', b.op)).toMatchObject({ last_result: 'REPAIR_PENDING' });
      const appels = appelsIA();
      await stabiliser(c);
      expect(appelsIA()).toBeGreaterThan(appels);
      if (verdict === 'SAME') {
        expect((await k.actives(c)).map((o) => o.id)).toEqual([a.op]);
        expect((await couts(a.op)).map((x) => x.period_start)).toEqual(['2025-11-05', '2026-07-05']);
      } else {
        expect((await k.actives(c)).map((o) => o.id)).toEqual([a.op, b.op]);
      }
      // Contrôle récurrent : rien à relancer (verdict rendu), aucune carte inutile.
      const avant = appelsIA();
      await campagne([c.id], 'CORRECTIVE');
      await stabiliser(c);
      expect(appelsIA()).toBe(avant);
      expect(await cartes(c)).toHaveLength(0);
    }
    m3.verdict = 'SAME';
  });

  // ══ 04 / 05 ══════════════════════════════════════════════════════════════

  it('L86C-E2E-04 / L86C-E2E-05 — deux contrats réellement distincts chez un prestataire, installation ponctuelle + abonnement : aucune fusion, aucune réparation', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const a = await stock(c, m.id, [abonnement(m.id, 2026, 1, { contrat: 'ABO-1' }), abonnement(m.id, 2026, 2, { contrat: 'ABO-1' })]);
    const b = await stock(c, m.id, [abonnement(m.id, 2026, 1, { contrat: 'ABO-2', montant: 1290, summary: `Abonnement ${NORD} garage`, prefixe: 'FG' })]);
    const installation = await k.document(c, m.id, [cand({
      typeHint: 'INTERVENTION', provider: TSN, summary: `Installation du système ${NORD}`, targetHints: [cible(m.id)],
      businessReferences: [ref('INVOICE', 'INST-1')] as AnchoredOperationCandidate['businessReferences'], temporalHints: { realizedDate: '2025-10-15' },
      financialHints: [fh('REALIZED_COST', 45000, { economicDate: '2025-10-15' })],
    })], { title: 'Installation alarme' });
    await stabiliser(c);
    await campagne([c.id], 'CORRECTIVE');
    await stabiliser(c);
    const ops = await k.actives(c);
    expect(ops).toHaveLength(3);
    expect(ops.map((o) => o.id)).toEqual(expect.arrayContaining([a.op, b.op]));
    expect(ops.find((o) => o.type_code === 'INTERVENTION')).toBeTruthy();
    expect((await k.candidat(installation))[0].t3_operation_id).not.toBe(a.op);
    expect(await fusions(c)).toEqual([]);
    expect(await reparations(c.id, 'COH-OPS-IDENTITY')).toEqual([]);
  });

  // ══ 06 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-06 — stock : période facturée prise pour la période du contrat + « Fin de contrat » projetée → retirées par le contrôle, Agenda et assistant corrigés', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const a = await stock(c, m.id, [abonnement(m.id, 2026, 10)]);
    await fausseFin(a.op, '2026-10-05', '2026-11-04');
    await projeter(c);
    const [fin] = await finsDeContrat(c);
    expect(fin).toMatchObject({ start_date: '2026-11-04', projection_origin: 'OPERATION', op: a.op });
    // Second contrat : « Fin de contrat » MODIFIÉE par l'utilisateur — jamais retirée.
    const b = await stock(c, m.id, [abonnement(m.id, 2026, 10, { provider: 'Assur Habitat', client: 'POL-9', summary: 'Assurance habitation', prefixe: 'AH' })]);
    await fausseFin(b.op, '2026-10-05', '2026-11-04');
    await projeter(c);
    const finB = (await finsDeContrat(c)).find((x) => x.op === b.op)!;
    await sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${finB.id}`;

    await campagne([c.id], 'DRY_RUN');
    expect(await preuve(c.id, 'COH-OPS-CONTRACT-DATES', a.op)).toMatchObject({ last_result: 'WOULD_REPAIR' });
    expect(await details(a.op)).toMatchObject({ effective_to: '2026-11-04' });

    await campagne([c.id], 'CORRECTIVE');
    expect(await details(a.op)).toMatchObject({ effective_from: null, effective_to: null });
    expect((await k.actives(c)).find((o) => o.id === a.op)).toMatchObject({ start_date: null, end_date: null });
    // Historique : motif propre, valeurs avant / après (réversible).
    const [h] = await sql<Json[]>`SELECT before_json, after_json FROM business_operation_history WHERE operation_id = ${a.op} AND reason_code = 'T3_CONTRACT_DATES_UNPROVEN'`;
    expect(h).toMatchObject({ before_json: { effective_to: '2026-11-04' }, after_json: { effective_to: null } });
    // Agenda : la projection intacte est retirée (trace restaurable) ; l'élément touché reste.
    const fins = await finsDeContrat(c);
    expect(fins.map((x) => x.id)).toEqual([finB.id]);
    expect(await sql`SELECT 1 FROM agenda_item_removals WHERE account_id = ${c.id} AND agenda_item_id = ${fin.id}`).toHaveLength(1);
    // Assistant : aucune fin annoncée pour le contrat corrigé.
    const { listUpcomingAgenda } = await import('@/services/verebona-assistant/canonical/agenda');
    const prochaines = await listUpcomingAgenda(c.id, { from: AUJ, windowDays: 365, limit: 50 });
    expect(prochaines.map((x) => x.id)).not.toContain(fin.id);
    const { readContracts } = await import('@/services/verebona-assistant/canonical/operations');
    expect((await readContracts(c.id, [m.id])).find((x) => x.operationId === a.op)).toMatchObject({ to: null });
    expect(await preuve(c.id, 'COH-OPS-CONTRACT-DATES', a.op)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await cartes(c)).toHaveLength(0);
  });

  // ══ 07 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-07 — fin contractuelle explicitement prouvée (contrat) : échéance correcte, sourcée, exploitable, conservée par le contrôle', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const contrat = await k.document(c, m.id, [cand({
      typeHint: 'CONTRACT', sourceRoleHint: 'CONTRACT_DOCUMENT', provider: NORD, summary: 'Contrat de télésurveillance', targetHints: [cible(m.id)],
      businessReferences: [ref('CONTRACT', 'ABO-77'), ref('CUSTOMER', 'CL 778 812')] as AnchoredOperationCandidate['businessReferences'],
      temporalHints: { startDate: '2025-11-05', endDate: '2027-11-04' },
    })], { title: 'Contrat télésurveillance' });
    await k.document(c, m.id, [abonnement(m.id, 2026, 7)]);
    await stabiliser(c);
    const [op] = await k.actives(c);
    expect(await details(op.id)).toMatchObject({ effective_from: '2025-11-05', effective_to: '2027-11-04' });
    const [prov] = await sql<Json[]>`SELECT attribute_provenance FROM business_operations WHERE id = ${op.id}`;
    const [srcContrat] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_sources WHERE operation_id = ${op.id} AND source_entity_key = ${String(contrat)} AND active`;
    expect(prov.attribute_provenance.fields.endDate).toMatchObject({ sourceId: srcContrat.id, value: '2027-11-04' });
    await projeter(c);
    expect(await finsDeContrat(c)).toEqual([expect.objectContaining({ start_date: '2027-11-04', projection_origin: 'OPERATION', op: op.id })]);
    await campagne([c.id], 'CORRECTIVE');
    expect(await details(op.id)).toMatchObject({ effective_to: '2027-11-04' });
    expect(await finsDeContrat(c)).toHaveLength(1);
    expect(await reparations(c.id, 'COH-OPS-CONTRACT-DATES')).toEqual([]);
  });

  // ══ 08 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-08 — réconciliations et contrôles répétés : aucune duplication, aucune perte, résultat stable', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const s = await fournisseur(c, 'TSN Services');
    const a = await stock(c, m.id, [abonnement(m.id, 2025, 11)]);
    const b = await stock(c, m.id, [abonnement(m.id, 2026, 7, { provider: TSN })]);
    for (const f of [...a.files, ...b.files]) await lier(f, s);
    await fausseFin(b.op, '2026-07-05', '2026-08-04');
    await campagne([c.id], 'CORRECTIVE');
    await stabiliser(c);
    const forme = async () => ({
      ops: (await k.actives(c)).map((o) => [o.id, o.type_code, o.start_date, o.end_date]),
      couts: await couts(a.op), fins: await finsDeContrat(c), fusions: await fusions(c),
    });
    const f1 = await forme();
    expect(f1.ops).toEqual([[a.op, 'CONTRACT', null, null]]);
    expect(f1.couts).toHaveLength(2);
    const h1 = (await k.historique(c));
    for (let i = 0; i < 2; i++) {
      await campagne([c.id], 'CORRECTIVE');
      const r = await passer(c);
      expect(r.changes).toBe(0);
    }
    expect(await forme()).toEqual(f1);
    expect((await k.historique(c))).toBe(h1);
  });

  // ══ 09 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-09 — extraction T1 réparée (référence de service désormais lue) : nouvelle réconciliation, fusion et propagation', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const a = await stock(c, m.id, [abonnement(m.id, 2025, 11)]);
    // Première extraction incomplète : autre désignation, ni compte client, ni désignation citée → deux Opérations.
    const fB = await k.document(c, m.id, [abonnement(m.id, 2026, 7, { provider: TSN, client: null, summary: 'Abonnement mensuel' })]);
    await stabiliser(c);
    expect(await k.actives(c)).toHaveLength(2);
    // Extraction réparée (réanalyse) : le compte client est lu → indice documentaire → réexamen par le contrôle, M3 tranche.
    await k.t1(c, fB, [abonnement(m.id, 2026, 7, { provider: TSN, summary: 'Abonnement mensuel' })], true);
    await stabiliser(c);
    await campagne([c.id], 'CORRECTIVE');
    await stabiliser(c);
    const ops = await k.actives(c);
    expect(ops.map((o) => o.id)).toEqual([a.op]);
    expect(await sourcesDe(a.op)).toEqual([...a.files, fB].sort((x, y) => x - y));
    expect((await details(a.op))?.effective_to ?? null).toBeNull();
  });

  // ══ 10 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-10 — décision de l’utilisateur (document retiré d’une Opération) : jamais défaite par le contrôle ni par T3', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const s = await fournisseur(c, 'TSN Services');
    const a = await stock(c, m.id, [abonnement(m.id, 2025, 11)]);
    const b = await stock(c, m.id, [abonnement(m.id, 2026, 7, { provider: TSN })]);
    for (const f of [...a.files, ...b.files]) await lier(f, s);
    await sql`INSERT INTO business_operation_match_decisions (account_id, source_kind, source_entity_key, candidate_operation_id, decision, origin, reason_code)
              VALUES (${c.id}, 'DOCUMENT', ${String(b.files[0])}, ${a.op}, 'REJECTED', 'USER_ARBITRATION', 'USER_DISSOCIATED')`;
    await campagne([c.id], 'CORRECTIVE');
    await stabiliser(c);
    expect((await k.actives(c)).map((o) => o.id)).toEqual([a.op, b.op]);
    expect(await fusions(c)).toEqual([]);
  });

  // ══ 11 ═══════════════════════════════════════════════════════════════════

  it('L86C-E2E-11 — cas réel (compte et bien « Maison » de recette) : #5 et #86 réunis, factures et coûts conservés, fausse fin supprimée, aucune réapparition', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const s = await fournisseur(c, 'TSN Services');
    // #5 : facture d'abonnement de novembre 2025 (désignation commerciale).
    const op5 = await stock(c, m.id, [abonnement(m.id, 2025, 11, { summary: `Facture d’abonnement ${NORD}, novembre 2025` })]);
    // #86 : document #336, prestataire « TSN Services », 40,50 €, période 05/07 → 04/08/2026 enregistrée comme période contractuelle.
    const op86 = await stock(c, m.id, [abonnement(m.id, 2026, 7, { provider: TSN, summary: `Abonnement mensuel ${NORD}, juillet-août 2026` })]);
    for (const f of [...op5.files, ...op86.files]) await lier(f, s);
    await fausseFin(op86.op, '2026-07-05', '2026-08-04');
    // Dernière facture (octobre) rattachée à #5 avec l'ancienne règle : fin annoncée au 04/11/2026.
    const f10 = await k.document(c, m.id, [abonnement(m.id, 2026, 10)]);
    await stabiliser(c);
    await fausseFin(op5.op, '2025-11-05', '2026-11-04');
    await projeter(c);
    expect((await finsDeContrat(c)).map((x) => x.start_date)).toEqual(['2026-11-04']);
    const totalAvant = (await sql<{ t: number }[]>`
      SELECT COALESCE(sum(amount_minor), 0)::int AS t FROM business_operation_financial_components WHERE account_id = ${c.id} AND active AND kind = 'REALIZED_COST'`)[0].t;

    await campagne([c.id], 'CORRECTIVE');
    await stabiliser(c);
    await campagne([c.id], 'CORRECTIVE');

    const ops = await k.actives(c);
    expect(ops.map((o) => o.id)).toEqual([op5.op]);
    expect(ops[0]).toMatchObject({ type_code: 'CONTRACT', start_date: null, end_date: null });
    expect(await sourcesDe(op5.op)).toEqual([...op5.files, ...op86.files, f10].sort((x, y) => x - y));
    expect((await couts(op5.op)).map((x) => [x.amount_minor, x.period_start])).toEqual([[4050, '2025-11-05'], [4050, '2026-07-05'], [4050, '2026-10-05']]);
    const totalApres = (await sql<{ t: number }[]>`
      SELECT COALESCE(sum(amount_minor), 0)::int AS t FROM business_operation_financial_components WHERE account_id = ${c.id} AND active AND kind = 'REALIZED_COST'`)[0].t;
    expect(totalApres).toBe(totalAvant);
    expect(await details(op5.op)).toMatchObject({ effective_from: null, effective_to: null });
    expect(await finsDeContrat(c)).toEqual([]);
    // Aucune réapparition après T3, projection et contrôle récurrent.
    await stabiliser(c);
    await projeter(c);
    await campagne([c.id], 'CORRECTIVE');
    expect(await finsDeContrat(c)).toEqual([]);
    expect(await k.actives(c)).toHaveLength(1);
    expect(await cartes(c)).toHaveLength(0);
  });
});
