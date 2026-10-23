/**
 * Lot 54D — ticket P1 « Opérations V1 : écarts E01–E09, TCO, calculs
 * financiers unifiés » sur PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats, consolidation
 * T3 réelle (`consolidateAccountOperations`, `runOperationsJob`), service
 * Sinistre (Opération CLAIM + rattachement de document, lot 83D), projection T4 réelle, lecture T2 réelle
 * (`sumQualifiedExpenses`), service TCO et routes HTTP réelles (seule la
 * lecture de la session est simulée). Les volumes (E02, E07, E08, H) sont
 * insérés en SQL ensembliste (harnais) puis traités par le code de production.
 * Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref, RECETTE_TODAY } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = { userId: 0, currentAccountId: 0 };

scenario('L54D', 'Opérations V1 — écarts E01 à E09, TCO, concordance T2 / TCO / Sinistres', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });
  afterEach(async () => {
    (await import('@/services/business-operations/consolidation/consolidator')).setT3FaultHookForTests(null);
    (await import('@/services/business-operations/events')).resetBusinessOperationEventBusForTests();
  });

  const can = () => import('@/services/verebona-assistant/canonical/expenses');
  const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
  const tcoDe = async (compte: AccountRow, assetId: number) => (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: RECETTE_TODAY });
  const job = (compte: AccountRow, id: number) => ({ id, accountId: compte.id, treatment: 'T3', targetType: 'business_operations', targetId: String(compte.id), triggerCode: null }) as never;
  const guard = { assertActive: async () => {} } as never;

  /**
   * Sinistre puis facture de réparation DANS l'Opération CLAIM (lot 83D, CDC v5
   * §18.4, AC39 : plus d'action « facture » d'un formulaire, plus
   * d'intervention enfant). Chemin de production : la facture est qualifiée
   * par T1 comme pièce du sinistre (typeHint CLAIM, référence du dossier) et
   * T3 la rattache au sinistre saisi (MATCH, F-040) avec son coût.
   */
  async function sinistreAvecReparation(
    compte: AccountRow & { owner: { id: number } }, asset: AssetRow, claim: Record<string, unknown> & { insurerClaimRef: string },
    facture: { summary: string; ref: string; date: string; cents: number; currency?: string },
  ): Promise<number> {
    const id = await k.sinistre(compte, compte.owner, asset, claim);
    const f = await k.document(compte, asset.id, [cand({
      typeHint: 'CLAIM', sourceRoleHint: 'INVOICE', summary: facture.summary, targetHints: [cible(asset.id)],
      businessReferences: [ref('CLAIM', claim.insurerClaimRef), ref('INVOICE', facture.ref)], temporalHints: { realizedDate: facture.date },
      financialHints: [fh('REALIZED_COST', facture.cents, facture.currency ? { currency: facture.currency } : {})],
    })], { type: 'REPAIR_INVOICE', title: `Facture ${facture.ref}` });
    await k.passer(compte);
    expect((await k.candidat(f))[0]).toMatchObject({ t3_operation_id: id });
    return id;
  }

  /** Opérations en masse (harnais) : INTERVENTION réalisées liées à un bien, une composante EUR chacune. */
  async function opsEnMasse(compte: AccountRow, assetId: number, n: number, o: { montant?: (i: number) => number; espacementJours?: number } = {}): Promise<number[]> {
    const ids = (await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, realized_date, technical_label)
      SELECT ${compte.id}, 'INTERVENTION', 'REALIZED', DATE '2000-01-01' + (g * ${o.espacementJours ?? 0})::int, 'Entretien ' || g
        FROM generate_series(1, ${n}) g ORDER BY g RETURNING id::int AS id`).map((x) => x.id);
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority)
              SELECT ${compte.id}, id, 'MIGRATION', 'e2e:' || id, 'STRUCTURED' FROM unnest(${ids}::bigint[]) id`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority)
              SELECT ${compte.id}, id, ${assetId}, 'PRIMARY', 'STRUCTURED' FROM unnest(${ids}::bigint[]) id`;
    const montants = ids.map((_, i) => o.montant?.(i) ?? 1_000 + (i % 97));
    await sql`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency)
              SELECT ${compte.id}, x.id, 'REALIZED_COST', x.m, 'EUR' FROM unnest(${ids}::bigint[], ${montants}::bigint[]) AS x(id, m)`;
    return ids;
  }

  // ══ E01 — erreurs T3 : distinctes, tracées, reprises automatiquement ════

  it('OPS-E01 — échec T3 simulé : job FAILED (jamais APPLIED / NO_CHANGE), cause / candidat / compte / job conservés, reprise automatique puis consolidation sans nouvel upload ni doublon', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { name: 'Clio' });
    const f = await k.document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [ref('INVOICE', 'E01-1')], temporalHints: { realizedDate: '2026-04-02' }, financialHints: [fh('REALIZED_COST', 74900)] })],
      { type: 'MAINTENANCE_INVOICE', title: 'Vidange' });
    const { setT3FaultHookForTests } = await consolidator();
    const { BusinessOperationIntegrityError } = await import('@/services/business-operations/errors');
    setT3FaultHookForTests((stage) => { if (stage === 'document') throw new BusinessOperationIntegrityError('INVALID_DETAILS', 'panne simulée'); });
    const { runOperationsJob } = await import('@/services/business-operations/consolidation/queue');
    const r = await runOperationsJob(job(compte, 990_001), { kind: 'business_operations', accountId: compte.id, events: [{ trigger: 'source_analyzed', fileId: f }], requestedAt: null } as never, guard);
    expect(r.result).toBe('FAILED');
    expect(r.detail).toMatchObject({ failure: 'T3_TECHNICAL_ERRORS', technicalErrors: [{ fileId: f, code: 'INVALID_DETAILS' }] });
    const [c] = await sql<{ t3_outcome: string; t3_reason: string; t3_error_attempts: number; t3_retry_at: string | null; t3_last_error: Record<string, unknown> }[]>`
      SELECT t3_outcome, t3_reason, t3_error_attempts, t3_retry_at::text AS t3_retry_at, t3_last_error FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
    expect(c).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'TECHNICAL_ERROR:INVALID_DETAILS', t3_error_attempts: 1 });
    expect(c.t3_retry_at).not.toBeNull();
    expect(c.t3_last_error).toMatchObject({ code: 'INVALID_DETAILS', jobId: 990001, attempt: 1 });
    expect(await k.actives(compte)).toHaveLength(0);
    // BO : erreur et reprise exposées.
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const holds = await new OperationDiagnosticsService().holds({ accountId: compte.id, outcome: null, reason: 'TECHNICAL_ERROR', page: 1, pageSize: 10 });
    expect(holds.items[0].technicalError).toMatchObject({ attempts: 1, exhausted: false, code: 'INVALID_DETAILS', jobId: 990001 });
    // Pas encore échue : le balayage ne la reprend pas ; échue : le compte est repris, sans intervention.
    const { listAccountsToConsolidate } = await consolidator();
    expect(await listAccountsToConsolidate(compte.id - 1, 1)).not.toContain(compte.id);
    setT3FaultHookForTests(null);
    await sql`UPDATE document_operation_candidates SET t3_retry_at = now() - interval '1 second' WHERE file_id = ${f}`;
    expect(await listAccountsToConsolidate(compte.id - 1, 1)).toEqual([compte.id]);
    const r2 = await runOperationsJob(job(compte, 990_002), { kind: 'business_operations', accountId: compte.id, events: [{ trigger: 'schedule_hourly' }], requestedAt: null } as never, guard);
    expect(r2.result).toBe('APPLIED');
    const ops = await k.actives(compte);
    expect(ops).toHaveLength(1);
    const [apres] = await sql<{ t3_outcome: string; t3_error_attempts: number; t3_retry_at: string | null; resolved: boolean }[]>`
      SELECT t3_outcome, t3_error_attempts, t3_retry_at::text AS t3_retry_at, (t3_last_error ? 'resolvedAt') AS resolved FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
    expect(apres).toEqual({ t3_outcome: 'CREATE_NEW', t3_error_attempts: 0, t3_retry_at: null, resolved: true });
    // Rejoué : aucun doublon, aucune écriture.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${f}`;
    await k.passer(compte);
    expect(await k.actives(compte)).toHaveLength(1);
  });

  it('OPS-E01b — reprises bornées : au-delà de 6 tentatives, plus de reprise programmée ; anomalie BO « reprises épuisées »', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { name: 'Clio' });
    const f = await k.document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [ref('INVOICE', 'E01-2')], financialHints: [fh('REALIZED_COST', 1000)] })]);
    await sql`UPDATE document_operation_candidates SET t3_error_attempts = 5 WHERE file_id = ${f}`;
    const { setT3FaultHookForTests, t3RetryDelayMinutes } = await consolidator();
    expect([1, 2, 3, 6, 7].map(t3RetryDelayMinutes)).toEqual([5, 10, 20, 160, null]);
    const { BusinessOperationIntegrityError } = await import('@/services/business-operations/errors');
    setT3FaultHookForTests((stage) => { if (stage === 'document') throw new BusinessOperationIntegrityError('INVALID_DETAILS', 'panne'); });
    await k.passer(compte);
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${f}`;
    await k.passer(compte);
    const [c] = await sql<{ n: number; retry: string | null }[]>`SELECT t3_error_attempts AS n, t3_retry_at::text AS retry FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
    expect(c).toEqual({ n: 7, retry: null });
    expect(await k.anomaliesDures(compte.id)).toEqual({ T3_TECHNICAL_ERROR_EXHAUSTED: 1 });
  });

  // ══ E02 — agrégats T2 exhaustifs ═══════════════════════════════════════

  it('OPS-E02 — T2 : 501 puis 1 001 Opérations et plus de 5 000 documents : total = agrégat SQL, lecture COMPLÈTE, dédoublonnage strict', async () => {
    for (const n of [501, 1_001]) {
      const compte = await make.account({ plan: 'premium' });
      const bien = await make.asset(compte, { category: 'IMMOBILIER', name: `Maison ${n}` });
      await opsEnMasse(compte, bien.id, n);
      const docs = n === 1_001 ? 5_001 : 10;
      await sql`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, amount_cents, document_type_code, document_date, analysis_state)
                SELECT ${compte.ownerUserId}, ${compte.id}, ${bien.id}, 'e2e/' || ${compte.id} || '/' || g || '.pdf', 'application/pdf', 100 + (g % 13),
                       'MAINTENANCE_INVOICE', DATE '2025-01-01', 'ANALYZED' FROM generate_series(1, ${docs}) g`;
      // Un document représenté par une Opération : jamais recompté.
      const [rep] = await sql<{ id: number }[]>`SELECT id::int AS id FROM asset_files WHERE account_id = ${compte.id} ORDER BY id LIMIT 1`;
      const [o1] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operations WHERE account_id = ${compte.id} ORDER BY id LIMIT 1`;
      await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority, source_role)
                VALUES (${compte.id}, ${o1.id}, 'DOCUMENT', ${String(rep.id)}, 'DOCUMENT', 'INVOICE')`;
      const [{ ops }] = await sql<{ ops: number }[]>`SELECT sum(amount_minor)::int AS ops FROM business_operation_financial_components WHERE account_id = ${compte.id} AND active`;
      const [{ d }] = await sql<{ d: number }[]>`SELECT sum(amount_cents)::int AS d FROM asset_files WHERE account_id = ${compte.id} AND id <> ${rep.id}`;
      const q = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [bien.id] });
      expect(q.readStatus).toBe('COMPLETE');
      expect(q.operations?.count).toBe(n);
      expect(q.documents?.count).toBe(docs - 1);
      expect(q.documents?.represented.count).toBe(1);
      expect(q.qualifiedSumCents).toBe(ops + d);
      expect(q.complete).toBe(true);
    }
  });

  it('OPS-E02b — lecture des coûts consolidés en échec : repli documentaire signalé DÉGRADÉ, jamais un total complet', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { name: 'Vélo' });
    await sql`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, amount_cents, document_type_code, document_date)
              VALUES (${compte.ownerUserId}, ${compte.id}, ${bien.id}, 'e2e/x.pdf', 'application/pdf', 5000, 'REPAIR_INVOICE', '2025-01-01')`;
    const c = await can();
    const { BusinessOperationReadService } = await import('@/services/business-operations/read-service');
    const panne = new BusinessOperationReadService();
    panne.listAllForAssistant = async () => { throw new Error('lecture impossible'); };
    (await import('@/services/verebona-assistant/canonical/operations')).setOperationReaderForTests(panne);
    try {
      const q = await c.sumQualifiedExpenses(compte.id, { assetIds: [bien.id] });
      expect(q.qualifiedSumCents).toBe(5000);
      expect(q.readStatus).toBe('DEGRADED');
      expect(q.complete).toBe(false);
      const { mixedExpenseNotes } = await import('@/services/verebona-assistant/canonical/expenses');
      expect(mixedExpenseNotes(q, { scopeLabel: 'Vélo' })[0]).toMatch(/n’ont pas pu être lus/);
    } finally {
      (await import('@/services/verebona-assistant/canonical/operations')).setOperationReaderForTests(null);
    }
  });

  // ══ E03 / E09 — contre-valeur EUR, zéro ≠ inconnu ════════════════════════

  it('OPS-E03 — F-105 / F-106 : contre-valeur explicite propagée jusqu’aux composantes ; absente ou contradictoire → aucune, devise d’origine conservée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJECT', name: 'Vélo' });
    const dates: Record<string, string> = { 'CH-EXPL': '2026-01-10', 'CH-ABS': '2026-03-20', 'CH-CONTRA': '2026-06-05' };
    const facture = (r: string, eur?: number) => cand({ provider: `Atelier ${r}`, targetHints: [cible(velo.id)], businessReferences: [ref('INVOICE', r)], temporalHints: { realizedDate: dates[r] },
      financialHints: [fh('REALIZED_COST', 60_000, { currency: 'CHF', ...(eur !== undefined ? { amountEurMinor: eur } : {}) })] });
    await k.document(compte, velo.id, [facture('CH-EXPL', 62_500)], { type: 'REPAIR_INVOICE' });
    await k.document(compte, velo.id, [facture('CH-ABS')], { type: 'REPAIR_INVOICE' });
    await k.document(compte, velo.id, [facture('CH-CONTRA', 62_500)], { type: 'REPAIR_INVOICE' });
    await k.document(compte, velo.id, [facture('CH-CONTRA', 61_900)], { type: 'REPAIR_INVOICE' });
    await k.passer(compte);
    const comps = await sql<{ amount_minor: number; currency: string; eur: number | null; ref: string }[]>`
      SELECT c.amount_minor::int AS amount_minor, trim(c.currency) AS currency, c.amount_eur_cents::int AS eur,
             (SELECT r.reference_value FROM business_operation_references r WHERE r.operation_id = c.operation_id AND r.active LIMIT 1) AS ref
        FROM business_operation_financial_components c WHERE c.account_id = ${compte.id} AND c.active ORDER BY ref`;
    expect(comps.map((x) => [x.ref, x.amount_minor, x.currency, x.eur])).toEqual([
      ['CH-ABS', 60_000, 'CHF', null], ['CH-CONTRA', 60_000, 'CHF', null], ['CH-EXPL', 60_000, 'CHF', 62_500],
    ]);
    const q = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [velo.id] });
    expect(q.qualifiedSumCents).toBe(62_500);
    expect(q.operations?.foreign).toEqual([{ currency: 'CHF', amountMinor: 120_000 }]);
    const t = await tcoDe(compte, velo.id);
    expect(t.summary.cumulativeCostCents).toBe(62_500);
    expect(t.reliability.unconverted).toEqual([{ currency: 'CHF', amountMinor: 120_000, kind: 'REALIZED_COST' }]);
  });

  it('OPS-E09 — frais CHF non convertibles et indemnité EUR : Sinistre, T2 et TCO sans total trompeur (jamais 0 €), couverture signalée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const chalet = await make.asset(compte, { category: 'IMMOBILIER', name: 'Chalet' });
    const claimId = await sinistreAvecReparation(compte, chalet, { claimType: 'EVENEMENT_CLIMATIQUE', occurredOn: '2026-03-01', compensationCents: 50_000, insurerClaimRef: 'SIN-E09' },
      { summary: 'Réparation toiture', ref: 'CH-RP-1', date: '2026-03-03', cents: 120_000, currency: 'CHF' });
    const { loadClaimRecords } = await import('@/services/business-operations/claims/read');
    const { db } = await import('@/db');
    const [rec] = await loadClaimRecords(db, compte.id, { ids: [claimId] });
    expect(rec.costs).toMatchObject({ grossCents: 0, indemnityCents: 50_000, complete: false, unconverted: [{ kind: 'REALIZED_COST', amountMinor: 120_000, currency: 'CHF' }] });
    expect(rec.indemnityCents).toBe(50_000);
    const q = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [chalet.id] });
    expect(q.qualifiedSumCents).toBe(0);
    expect(q.complete).toBe(false);
    expect(q.operations?.foreign).toEqual([{ currency: 'CHF', amountMinor: 120_000 }]);
    const t = await tcoDe(compte, chalet.id);
    expect(t.summary.cumulativeCostCents).toBe(-50_000);
    expect(t.status).toBe('INCOMPLETE');
    expect(t.reliability.unconverted).toEqual([{ currency: 'CHF', amountMinor: 120_000, kind: 'REALIZED_COST' }]);
  });

  // ══ E04 — capital des financements ══════════════════════════════════════

  it('OPS-E04 — prêt 20 000 € + intérêts 500 € : principal au détail du financement, seul le coût de financement établi alimente le TCO ; idempotent après réanalyse', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const offre = [cand({ typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Prêt', provider: 'Banque', targetHints: [cible(maison.id)], businessReferences: [ref('LOAN', 'PR-54')],
      temporalHints: { startDate: '2025-01-15' }, financialHints: [fh('LOAN_PRINCIPAL', 2_000_000)] })];
    const fo = await k.document(compte, maison.id, offre, { type: 'LEASING_FINANCING_CONTRACT', title: 'Offre de prêt' });
    await k.document(compte, maison.id, [cand({ typeHint: 'FINANCING', sourceRoleHint: 'INVOICE', summary: 'Intérêts 2025', provider: 'Banque', targetHints: [cible(maison.id)],
      businessReferences: [ref('LOAN', 'PR-54')], temporalHints: { realizedDate: '2025-12-31' }, financialHints: [fh('REALIZED_COST', 50_000)] })], { title: 'Relevé d’intérêts' });
    await k.document(compte, maison.id, [cand({ typeHint: 'ACQUISITION', summary: 'Achat', targetHints: [cible(maison.id)], businessReferences: [ref('INVOICE', 'ACTE-1')],
      temporalHints: { realizedDate: '2025-01-15' }, financialHints: [fh('REALIZED_COST', 2_000_000)] })], { type: 'ACQUISITION_INVOICE' });
    await k.passer(compte);
    const lire = async () => {
      const fin = (await k.actives(compte)).filter((o) => o.type_code === 'FINANCING');
      expect(fin).toHaveLength(1);
      const [d] = await sql<{ p: number }[]>`SELECT principal_amount_minor::int AS p FROM business_operation_financing_details WHERE operation_id = ${fin[0].id}`;
      return { principal: d.p, composantes: (await k.composantes(fin[0].id)).map((c) => [c.kind, c.amount_minor]), tco: (await tcoDe(compte, maison.id)).summary.cumulativeCostCents };
    };
    expect(await lire()).toEqual({ principal: 2_000_000, composantes: [['REALIZED_COST', 50_000]], tco: 2_050_000 });
    const h = await k.historique(compte);
    await k.t1(compte, fo, offre, true);
    await k.passer(compte);
    expect(await lire()).toEqual({ principal: 2_000_000, composantes: [['REALIZED_COST', 50_000]], tco: 2_050_000 });
    expect(await k.historique(compte)).toBe(h);
    expect(await k.anomaliesDures(compte.id)).toEqual({});
  });

  // ══ E05 — cartes « À traiter » reprises ════════════════════════════════

  it('OPS-E05 — service de cartes indisponible puis rétabli : carte recréée automatiquement, sans doublon ; décision utilisateur respectée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { name: 'Clio' });
    const f = await k.document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [ref('INVOICE', 'E05-1')], temporalHints: { realizedDate: '2026-04-02' },
      financialHints: [fh('REALIZED_COST', 74_900, { currency: 'XXX', currencyCandidates: ['EUR'], currencyBasis: 'PRESUMED' })] })], { type: 'MAINTENANCE_INVOICE' });
    const cartes = () => sql<{ public_id: string; resolved_at: string | null }[]>`
      SELECT public_id, resolved_at::text AS resolved_at FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-CURRENCY' ORDER BY id`;
    const { setT3FaultHookForTests, listAccountsToConsolidate } = await consolidator();
    setT3FaultHookForTests((stage) => { if (stage === 'cards') throw new Error('service de cartes indisponible'); });
    await k.passer(compte);
    expect(await cartes()).toEqual([]);
    expect((await sql`SELECT 1 FROM document_operation_candidates WHERE file_id = ${f} AND t3_cards_pending`)).toHaveLength(1);
    expect(await listAccountsToConsolidate(compte.id - 1, 1)).toEqual([compte.id]);
    setT3FaultHookForTests(null);
    await k.passer(compte); // balayage suivant, sans geste utilisateur
    expect((await cartes()).filter((c) => !c.resolved_at)).toHaveLength(1);
    expect((await sql`SELECT 1 FROM document_operation_candidates WHERE file_id = ${f} AND t3_cards_pending`)).toHaveLength(0);
    await k.passer(compte, { reevaluateHolds: true });
    expect(await cartes()).toHaveLength(1);
    // Décision utilisateur : jamais rouverte, même après une nouvelle panne et une reprise.
    const [c] = await cartes();
    expect(await (await import('@/services/to-process/resolve-action.service')).resolveArbitration(compte.id, c.public_id, 'CURRENCY:EUR', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    setT3FaultHookForTests((stage) => { if (stage === 'cards') throw new Error('panne'); });
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${f}`;
    await k.passer(compte);
    setT3FaultHookForTests(null);
    await k.passer(compte);
    expect((await cartes()).filter((x) => !x.resolved_at)).toEqual([]);
    expect(await cartes()).toHaveLength(1);
  });

  // ══ E06 / E07 — reprise et pagination de la projection Agenda ═════════

  it('OPS-E06 — projection manquante depuis plus de 48 h restaurée automatiquement ; suppression utilisateur (tombstone) et carte ouverte respectées, sans boucle', async () => {
    const compte = await make.account({ plan: 'premium' });
    const polo = await make.asset(compte, { name: 'Polo' });
    const [id] = await opsEnMasse(compte, polo.id, 1, { espacementJours: 9_000 });
    await sql`UPDATE business_operations SET updated_at = now() - interval '30 days', created_at = now() - interval '30 days' WHERE id = ${id}`;
    const svc = await import('@/services/business-operations/agenda-projection/service');
    // Lot 83E (C-Q9) : le balayage horaire de convergence est retiré — l'écart est constaté (et réparé) par le
    // contrôle de cohérence COH-AGENDA-OPERATION-PROJECTION (plan simulé du même moteur).
    const { getCheck } = await import('@/services/coherence/registry');
    const controle = getCheck('COH-AGENDA-OPERATION-PROJECTION')!;
    const ctx = { sql, now: new Date(), today: RECETTE_TODAY, mode: 'DRY_RUN' as const, correlationId: 'e2e-ops-e06' };
    const verdict = async () => (await controle.inspect!(ctx, compte.id, [id])).get(id)!;
    expect(await verdict()).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'MISSING_CALCULABLE_EVENT' });
    await svc.projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY });
    const items = () => sql<{ id: number }[]>`SELECT id::int AS id FROM agenda_items WHERE business_operation_id = ${id}`;
    expect(await items()).toHaveLength(1);
    expect(await verdict()).toMatchObject({ verdict: 'CONSISTENT' });
    // Projection perdue (élément disparu sans geste utilisateur) : restaurée.
    await sql`DELETE FROM agenda_items WHERE business_operation_id = ${id}`;
    expect(await verdict()).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'MISSING_CALCULABLE_EVENT' });
    await svc.projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY });
    const [item] = await items();
    expect(item).toBeDefined();
    // Suppression UTILISATEUR : tombstone → ni écart constaté, ni recréation.
    const { db } = await import('@/db');
    await svc.recordAgendaProjectionSuppression(db, { accountId: compte.id, itemId: item.id, userId: compte.ownerUserId });
    await sql`DELETE FROM agenda_items WHERE id = ${item.id}`;
    expect(await verdict()).toMatchObject({ verdict: 'CONSISTENT' });
    expect((await svc.projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY })).changes).toBe(0);
    expect(await items()).toHaveLength(0);
  });

  it('OPS-E07 — plus de 1 000 Opérations éligibles projetées sans omission (curseur stable, pages comptées) ; rejouée = aucune écriture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const ids = await opsEnMasse(compte, maison.id, 1_001, { espacementJours: 7 });
    const svc = await import('@/services/business-operations/agenda-projection/service');
    const r = await svc.projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY, pageSize: 250 });
    expect(r.operations).toBe(1_001);
    expect(r.pages).toBe(5);
    expect(r.lastOperationId).toBe(ids[ids.length - 1]);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(DISTINCT business_operation_id)::int AS n FROM agenda_items WHERE account_id = ${compte.id} AND business_operation_id IS NOT NULL`;
    expect(n).toBe(1_001);
    expect((await svc.projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY, pageSize: 250 })).changes).toBe(0);
  }, 600_000);

  // ══ E08 — reconsolidation administrative complète ══════════════════════

  it('OPS-E08 — compte de 501 biens et 2 001 Opérations : reconsolidation COMPLÈTE (biens, candidats, Opérations, projection), statut et compteurs', async () => {
    const compte = await make.account({ plan: 'premium' });
    await sql`INSERT INTO assets (user_id, account_id, category, name)
              SELECT ${compte.ownerUserId}, ${compte.id}, 'OBJET', 'Objet ' || g FROM generate_series(1, 500) g`;
    const bien = await make.asset(compte, { name: 'Dernier' });
    await opsEnMasse(compte, bien.id, 2_001);
    await k.document(compte, bien.id, [cand({ targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'E08-1')], financialHints: [fh('REALIZED_COST', 1_000)] })]);
    await k.passer(compte);
    const { runOperationsJob } = await import('@/services/business-operations/consolidation/queue');
    const r = await runOperationsJob(job(compte, 990_008), { kind: 'business_operations', accountId: compte.id, events: [{ trigger: 'admin_reconsolidation', correlationId: 'e2e-e08' }], requestedAt: null } as never, guard);
    expect(r.result).not.toBe('FAILED');
    const rec = (r.detail as { reconsolidation: Record<string, unknown> }).reconsolidation;
    expect(rec).toMatchObject({ status: 'COMPLET', assets: 501, candidatesRequeued: 1, operationBatchesFailed: 0, documentsRemaining: false, technicalErrors: 0 });
    // Toutes les Opérations actives au moment du passage (≥ 2 001 : aucun plafond).
    expect(rec.operations as number).toBeGreaterThanOrEqual(2_001);
    expect(await sql`SELECT id FROM ai_job_queue WHERE account_id = ${compte.id} AND target_type = 'business_operations_agenda' AND status = 'PENDING'`).toHaveLength(1);
  }, 900_000);

  // ══ TCO de bout en bout, droits, concordance ═══════════════════════════

  /** Scénario B par les chemins de production : achat, entretien + avoir, intérêts, sinistre indemnisé, valorisation. */
  async function possession(compte: AccountRow & { owner: { id: number } }): Promise<AssetRow> {
    const auto = await make.asset(compte, { name: 'Auto', keyCharacteristics: { valuationHistory: [{ id: 'v1', value: 18_000, date: '2026-09-01', mode: 'AVIS_VALEUR', source: 'USER', addedAt: '2026-09-01T00:00:00Z' }] } });
    const doc = (c: Parameters<typeof cand>[0], o: Parameters<typeof k.document>[3] = {}) => k.document(compte, auto.id, [cand({ targetHints: [cible(auto.id)], ...c })], o);
    await doc({ typeHint: 'ACQUISITION', summary: 'Achat', businessReferences: [ref('INVOICE', 'VO-1')], temporalHints: { realizedDate: '2022-03-01' }, financialHints: [fh('REALIZED_COST', 2_000_000)] }, { type: 'ACQUISITION_INVOICE' });
    await doc({ businessReferences: [ref('INVOICE', 'FA-1')], temporalHints: { realizedDate: '2023-05-02' }, financialHints: [fh('REALIZED_COST', 120_000)] }, { type: 'MAINTENANCE_INVOICE' });
    await doc({ sourceRoleHint: 'CREDIT_NOTE', businessReferences: [ref('INVOICE', 'FA-1')], financialHints: [fh('REDUCTION', 10_000)] });
    await doc({ typeHint: 'FINANCING', summary: 'Intérêts', businessReferences: [ref('LOAN', 'PR-B')], temporalHints: { realizedDate: '2023-12-31' }, financialHints: [fh('REALIZED_COST', 50_000)] });
    await k.passer(compte);
    await k.sinistre(compte, compte.owner, auto, { claimType: 'BRIS_DE_GLACE', occurredOn: '2024-02-01', compensationCents: 30_000 });
    return auto;
  }

  const getTco = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  it('FIN-A — sinistre : réparation 2 000 €, indemnité 1 500 € — Sinistre brut 2 000 / net 500, T2 brut 2 000 / reste à charge 500, TCO 500', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const claimId = await sinistreAvecReparation(compte, maison, { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-02-01', compensationCents: 150_000, insurerClaimRef: 'SIN-FINA' },
      { summary: 'Réparation plafond', ref: 'REP-A', date: '2026-02-10', cents: 200_000 });
    const { loadClaimRecords } = await import('@/services/business-operations/claims/read');
    const { db } = await import('@/db');
    const [rec] = await loadClaimRecords(db, compte.id, { ids: [claimId] });
    expect(rec.costs).toMatchObject({ grossCents: 200_000, indemnityCents: 150_000, netCents: 50_000, complete: true });
    const q = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [maison.id] });
    expect(q.qualifiedSumCents).toBe(200_000);
    expect(q.qualifiedSumCents - (q.operations?.indemnity.sumCents ?? 0)).toBe(50_000);
    const t = await tcoDe(compte, maison.id);
    expect(t.summary.cumulativeCostCents).toBe(50_000);
    expect(t.breakdown.find((b) => b.category === 'CLAIMS')?.costsCents).toBe(200_000);
  });

  it('FIN-B / FIN-C / TCO-11 / ACC-011 — possession puis cession par les chemins réels (composantes consolidées + valuationHistory, aucun montant documentaire générique) ; recalcul après modification ; route Premium', async () => {
    const compte = await make.account({ plan: 'premium' });
    const auto = await possession(compte);
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    const avant = await getTco(auto.id);
    expect(avant.status).toBe(200);
    expect(avant.body.tco.summary).toMatchObject({ cumulativeCostCents: 2_130_000, netEstimatedCents: 330_000, currentValue: { cents: 1_800_000, date: '2026-09-01' } });
    expect(avant.body.tco.entries).toBeUndefined();
    // Cession : vente 17 000 €, frais 400 € — recalcul à la lecture suivante.
    await k.document(compte, auto.id, [cand({ typeHint: 'DISPOSAL', sourceRoleHint: 'SALE_DOCUMENT', summary: 'Vente', targetHints: [cible(auto.id)], businessReferences: [ref('OTHER', 'VENTE-1')],
      temporalHints: { realizedDate: '2026-06-30' }, financialHints: [fh('PROCEED', 1_700_000, { economicDate: '2026-06-30' }), fh('REALIZED_COST', 40_000)] })], { title: 'Certificat de cession' });
    await k.passer(compte);
    const apres = await getTco(auto.id);
    expect(apres.body.tco.summary).toMatchObject({ cumulativeCostCents: 2_170_000, netFinalCents: 470_000, netEstimatedCents: null });
    expect(apres.body.tco.disposal).toMatchObject({ realizedPriceCents: 1_700_000, feesCents: 40_000, resultKind: 'FINAL' });
  });

  it('TCO-12 — droits : Standard verrouillé sans aucune donnée financière ; Premium Duo partagé entre utilisateurs autorisés ; aucune suppression au downgrade', async () => {
    const duo = await make.account({ plan: 'premium_duo' });
    const auto = await possession(duo);
    const membre = await make.user();
    session.currentAccountId = duo.id; session.userId = membre.id;
    const vu = await getTco(auto.id);
    expect(vu.status).toBe(200);
    expect(vu.body.tco.summary.cumulativeCostCents).toBe(2_130_000);
    // Forfait d'usage (route réelle), puis passage en Standard.
    const { POST } = await import('@/app/api/assets/[id]/usage-budgets/route');
    const cree = await POST(new NextRequest(`http://x/api/assets/${auto.id}/usage-budgets`, { method: 'POST', body: JSON.stringify({ category: 'FUEL', amountMinor: 12_000, currency: 'EUR', periodicity: 'MONTHLY' }) }),
      { params: Promise.resolve({ id: String(auto.id) }) });
    expect(cree.status).toBe(201);
    expect((await getTco(auto.id)).body.tco.usage.annualEstimateCents).toBe(144_000);
    expect((await getTco(auto.id)).body.tco.summary.cumulativeCostCents).toBe(2_130_000);
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${duo.id}`;
    const bloque = await getTco(auto.id);
    expect(bloque.status).toBe(403);
    expect(bloque.body).toEqual({ error: 'PREMIUM_REQUIRED', code: 'PREMIUM_REQUIRED', message: expect.any(String), locked: true });
    expect(JSON.stringify(bloque.body)).not.toMatch(/2130000|cumulative/);
    const refuse = await POST(new NextRequest(`http://x/api/assets/${auto.id}/usage-budgets`, { method: 'POST', body: JSON.stringify({ category: 'TOLLS', amountMinor: 1, currency: 'EUR', periodicity: 'YEARLY' }) }),
      { params: Promise.resolve({ id: String(auto.id) }) });
    expect(refuse.status).toBe(403);
    expect(await sql`SELECT id FROM asset_usage_budgets WHERE asset_id = ${auto.id}`).toHaveLength(1);
    await sql`UPDATE account_subscriptions SET plan_code = 'premium_duo' WHERE account_id = ${duo.id}`;
    expect((await getTco(auto.id)).body.tco.usage.items).toHaveLength(1);
    // Autre compte : aucun accès.
    const autre = await make.account({ plan: 'premium' });
    session.currentAccountId = autre.id; session.userId = autre.ownerUserId;
    expect((await getTco(auto.id)).status).toBe(404);
  });

  it('FIN-H / TCO-13 — volumétrie : 1 001 Opérations, fusion et invalidation → TCO = agrégat SQL des composantes actives, aucune omission ni montant périmé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const ids = await opsEnMasse(compte, maison.id, 1_001);
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'E2E_INVALIDATION' WHERE id = ${ids[0]}`;
    await sql`UPDATE business_operations SET merged_into_operation_id = ${ids[2]}, invalidated_at = now(), invalidation_reason = 'MERGED' WHERE id = ${ids[1]}`;
    await sql`UPDATE business_operation_financial_components SET active = false, superseded_at = now() WHERE operation_id = ${ids[3]}`;
    await sql`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency) VALUES (${compte.id}, ${ids[3]}, 'REALIZED_COST', 4242, 'EUR')`;
    const [{ s }] = await sql<{ s: number }[]>`
      SELECT sum(c.amount_minor)::int AS s FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id
       WHERE c.account_id = ${compte.id} AND c.active AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`;
    const t = await tcoDe(compte, maison.id);
    expect(t.summary.cumulativeCostCents).toBe(s);
    expect(t.reliability.operationsCounted).toBe(999);
    expect(t.status).not.toBe('PARTIAL');
    const q = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [maison.id] });
    expect(q.qualifiedSumCents).toBe(s);
  }, 300_000);

  it('TCO-14 — T2 « coût de possession » : lit le service TCO (aucun calcul parallèle), montants concordants et source vérifiable', async () => {
    const compte = await make.account({ plan: 'premium' });
    const auto = await possession(compte);
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const t = await tcoDe(compte, auto.id);
    const r = ownershipCostAnswer({ id: auto.id, name: 'Auto' } as never, t);
    expect(r && 'strategy' in r && r.strategy).toBe('structured.ownership_cost');
    expect(r && 'answer' in r && r.answer).toMatch(/21\s300,00\s€.*3\s300,00\s€/);
    const { TCO_Q } = await import('@/services/verebona-assistant/canonical/structured-answers');
    expect(TCO_Q.test('quel est le cout de possession de ma voiture')).toBe(true);
    expect(TCO_Q.test('combien ai-je depense en entretien')).toBe(false);
    // Non-régression T2-24 : un total thématique ou annuel reste une somme de dépenses.
    const { isOwnershipCostQuestion } = await import('@/services/verebona-assistant/canonical/structured-answers');
    expect(isOwnershipCostQuestion('Quel est le coût total de possession de la Polo ?')).toBe(true);
    expect(isOwnershipCostQuestion('Quel est le coût total des réparations de la maison ?')).toBe(false);
    expect(isOwnershipCostQuestion('Quel est le coût total de la Polo en 2025 ?')).toBe(false);
  });
});
