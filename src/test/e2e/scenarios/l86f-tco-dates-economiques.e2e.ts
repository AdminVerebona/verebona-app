/**
 * Lot 86F — ticket P1 « TCO / Opérations : dates économiques injustifiées et
 * leur autoréparation » (complément du ticket #559) sur PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : écriture des Opérations par le dépôt
 * (`withBusinessOperationWrite`), persistance T1 réelle des candidats
 * (règlements), lecteur des Opérations (`listAllForAssistant` : date
 * économique résolue), service TCO réel (`readAssetTco`), lignes de coût T2
 * (`operationCostLines`), décision « Retirer du TCO » réelle
 * (`decideTcoLine`), campagne de cohérence réelle (orchestrateur, contrôle
 * COH-TCO-ECONOMIC-DATES, réparation par `applyOperationEconomicDates`).
 * Aucun appel IA. Date de référence injectée (24/10/2026). Assertions
 * limitées aux comptes créés ici.
 *
 * Scénario de non-régression (sans règle propre au fournisseur) : un
 * abonnement de télésurveillance daté du 05/11/2025 regroupe la prestation de
 * novembre 2025 et trois prestations 2026 de 40,50 € facturées en 2026 —
 * l'ancien moteur les affectait toutes à 2025 (date de l'Opération).
 */
import { beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { cand, fh, operationsKit } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const AUJ = '2026-10-24';
const CHECK = 'COH-TCO-ECONOMIC-DATES';
type Json = Record<string, any>;

scenario('L86F', 'TCO — dates économiques justifiées par leurs preuves, stock réparé par le contrôle de cohérence', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const write = () => import('@/services/business-operations/write');
  const tco = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: AUJ });
  const annee = (t: Awaited<ReturnType<typeof tco>>, y: number) => t.annual.years.find((a) => a.year === y)?.costsCents ?? 0;
  const coherent = (t: Awaited<ReturnType<typeof tco>>) => {
    const a = t.annual;
    expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(t.summary.cumulativeCostCents);
    expect(a.reconciled).toBe(true);
  };

  beforeAll(async () => {
    // Bus des Opérations : aucun abonné de production n'est requis ici (contrôles exécutés par campagne explicite).
    await write();
  });

  /** Justificatif du compte, daté (date du document), rattaché au bien. */
  const fichier = async (compte: AccountRow, asset: AssetRow, titre: string, date: string | null, type = 'SUBSCRIPTION_INVOICE') => {
    const f = await make.assetFile(compte, { assetId: asset.id });
    await sql`UPDATE asset_files SET document_type_code = ${type}, retained_title = ${titre}, document_date = ${date}, amount_cents = 4050, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  };

  /**
   * Stock tel qu'en préproduction : UNE Opération d'abonnement datée du
   * 05/11/2025 (réalisée), ses factures successives comme sources, une
   * composante de 40,50 € par période facturée, SANS date propre (indice T1
   * sans date économique).
   */
  async function abonnement(compte: AccountRow, opts: { sansDate?: boolean } = {}) {
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { acquisitionDate: '2020-06-01' } });
    const nov = await fichier(compte, maison, 'Facture abonnement novembre 2025', '2025-11-05');
    const f = [
      await fichier(compte, maison, 'Facture abonnement juillet 2026', '2026-07-05'),
      await fichier(compte, maison, 'Facture abonnement août 2026', '2026-08-05'),
      await fichier(compte, maison, 'Facture abonnement septembre 2026', opts.sansDate ? null : '2026-09-05'),
    ];
    const periodes: Array<[string, string]> = [['2026-07-05', '2026-08-04'], ['2026-08-05', '2026-09-04'], ['2026-09-05', '2026-10-04']];
    const { withBusinessOperationWrite } = await write();
    const ids = await withBusinessOperationWrite(compte.id, async (repo) => {
      const op = await repo.create({
        type: { code: 'CONTRACT' }, status: 'REALIZED', realizedDate: '2025-11-05', startDate: '2025-11-05',
        source: { kind: 'DOCUMENT', entityKey: nov, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L86F',
      });
      const cNov = await repo.addFinancialComponent(op.id, {
        kind: 'REALIZED_COST', amountMinor: 4050, currency: 'EUR', periodStart: '2025-11-05', periodEnd: '2025-12-04',
        sources: [{ sourceId: op.sourceId }], fingerprint: `e2e-l86f-${nov}`,
      } as never, 'E2E_L86F');
      const comps: number[] = [];
      for (const [i, fileId] of f.entries()) {
        const s = await repo.addSource(op.id, { kind: 'DOCUMENT', entityKey: fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' }, 'E2E_L86F');
        comps.push(await repo.addFinancialComponent(op.id, {
          kind: 'REALIZED_COST', amountMinor: 4050, currency: 'EUR', periodStart: periodes[i][0], periodEnd: periodes[i][1],
          sources: [{ sourceId: s }], fingerprint: `e2e-l86f-${fileId}`,
        } as never, 'E2E_L86F'));
      }
      return { op: op.id, cNov, comps };
    });
    return { maison, nov, fichiers: f, ...ids };
  }

  /** Preuve de règlement (document source de l'Opération) portant un indice PAYMENT T1 persisté. */
  async function reglement(compte: AccountRow, maison: AssetRow, op: number, date: string, periode: [string, string]) {
    const f = await make.assetFile(compte, { assetId: maison.id });
    await sql`UPDATE asset_files SET document_type_code = 'BANK_STATEMENT', retained_title = 'Avis de prélèvement', document_date = ${date}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    await k.t1(compte, f.id, [cand({
      typeHint: 'CONTRACT', sourceRoleHint: 'PAYMENT_PROOF', confidence: 'probable', summary: 'Prélèvement abonnement',
      financialHints: [fh('PAYMENT', 4050, { economicDate: date, periodStart: periode[0], periodEnd: periode[1] })],
    })]);
    const { withBusinessOperationWrite } = await write();
    await withBusinessOperationWrite(compte.id, (repo) => repo.addSource(op, { kind: 'DOCUMENT', entityKey: f.id, role: 'PAYMENT_PROOF', authority: 'DOCUMENT', confidence: 'probable' }, 'E2E_L86F'));
    return f.id;
  }

  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode, scopeAccountIds: scope });
    for (let i = 0; i < 30; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: AUJ });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const preuve = async (accountId: number, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${CHECK} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number) => sql<Json[]>`
    SELECT object_id::int AS object_id, service, outcome, recheck_verdict, ai_calls FROM coherence_repairs WHERE account_id = ${accountId} AND check_id = ${CHECK} ORDER BY id`;
  const traces = (op: number) => sql<Json[]>`
    SELECT id::int AS id, economic_date::text AS economic_date, economic_date_basis, resolved_economic_date::text AS resolved, economic_date_trace AS trace
      FROM business_operation_financial_components WHERE operation_id = ${op} AND active ORDER BY id`;
  const journal = (op: number) => sql<Json[]>`
    SELECT before_json, after_json, correlation_id FROM business_operation_history WHERE operation_id = ${op} AND reason_code = 'ECONOMIC_DATE_RESOLVED' ORDER BY id`;
  const historique = async (compte: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id}`)[0].n;
  /** T2 : coûts consolidés d'une année (lecteur des Opérations + lignes de coût T2, mêmes dates que le TCO). */
  const t2Annee = async (compte: AccountRow, assetId: number, year: number) => {
    const { BusinessOperationReadService } = await import('@/services/business-operations/read-service');
    const { operationCostLines, summarizeOperationCosts } = await import('@/services/verebona-assistant/canonical/operations');
    const { operations } = await new BusinessOperationReadService().listAllForAssistant(compte.id, { assetIds: [assetId] });
    return summarizeOperationCosts(operationCostLines(operations, { assetIds: [assetId], year }), null).part;
  };

  it('L86F-E2E-01 — prestations 2026 (Homiris, non-régression) : 2026 par leur facture, jamais 2025 par la date de l’Opération ; trois indicateurs et T2 cohérents', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, cNov, comps, fichiers, nov } = await abonnement(compte);
    const t = await tco(compte, maison.id);
    expect(t.summary.cumulativeCostCents).toBe(4 * 4050);
    expect(annee(t, 2025)).toBe(4050);
    expect(annee(t, 2026)).toBe(3 * 4050);
    for (const [i, c] of comps.entries()) {
      expect(t.lines.find((l) => l.id === `c:${c}`)).toMatchObject({
        annualYear: 2026, dateLabel: 'Date du justificatif', economicDate: { basis: 'DOCUMENT', provenance: { type: 'DOCUMENT', fileId: fichiers[i] } },
      });
      // La date de l'Opération est tracée et REJETÉE (contrat : échéances distinctes dans le temps).
      expect(t.lines.find((l) => l.id === `c:${c}`)!.economicDate!.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'OPERATION_REALIZED', date: '2025-11-05', retained: false, rejected: 'SUPERSEDED' }),
      ]));
    }
    expect(t.lines.find((l) => l.id === `c:${cNov}`)).toMatchObject({ annualYear: 2025, economicDate: { provenance: { fileId: nov } } });
    coherent(t);
    expect(t.annual.average.totalCents).toBe(t.summary.cumulativeCostCents);
    // T2 lit la MÊME date économique (lecteur des Opérations) : mêmes montants par année que le TCO.
    expect((await t2Annee(compte, maison.id, 2025)).sumCents).toBe(4050);
    expect((await t2Annee(compte, maison.id, 2026)).sumCents).toBe(3 * 4050);
    // Fiche : libellé du fondement, sans la résolution complète (réservée au diagnostic BO).
    const { toTcoDto } = await import('@/services/business-operations/tco/dto');
    const dto = toTcoDto(t);
    const ligneDto = dto.lines.find((l) => l.id === `c:${comps[0]}`)!;
    expect(ligneDto.dateLabel).toBe('Date du justificatif');
    expect((ligneDto as Json).economicDate).toBeUndefined();
  });

  it('L86F-E2E-02 — paiement anticipé PROUVÉ (règlement de décembre 2025 pour la période de juillet 2026) : date de paiement retenue ; autres échéances indépendantes', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, op, comps } = await abonnement(compte);
    const reg = await reglement(compte, maison, op, '2025-12-20', ['2026-07-05', '2026-08-04']);
    const t = await tco(compte, maison.id);
    expect(t.lines.find((l) => l.id === `c:${comps[0]}`)).toMatchObject({
      date: '2025-12-20', annualYear: 2025, dateLabel: 'Date de paiement', economicDate: { basis: 'PAYMENT', provenance: { type: 'PAYMENT', fileId: reg } },
    });
    // Les deux autres échéances gardent LEUR date (le règlement de juillet n'est jamais attribué à août ni à septembre).
    expect(t.lines.find((l) => l.id === `c:${comps[1]}`)).toMatchObject({ date: '2026-08-05', annualYear: 2026 });
    expect(t.lines.find((l) => l.id === `c:${comps[2]}`)).toMatchObject({ date: '2026-09-05', annualYear: 2026 });
    expect([annee(t, 2025), annee(t, 2026)]).toEqual([2 * 4050, 2 * 4050]);
    coherent(t);
    expect((await t2Annee(compte, maison.id, 2025)).sumCents).toBe(2 * 4050);
  });

  it('L86F-E2E-03 — aucune preuve de date : montant conservé dans le TCO cumulatif, aucune année (ni 2025, ni début de période) ; correction de la preuve → recalcul', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, comps, fichiers } = await abonnement(compte, { sansDate: true });
    const t = await tco(compte, maison.id);
    expect(t.summary.cumulativeCostCents).toBe(4 * 4050);
    expect(t.lines.find((l) => l.id === `c:${comps[2]}`)).toMatchObject({
      date: null, annualYear: null, includedCents: 4050, dateLabel: 'Date non établie', economicDate: { status: 'UNDETERMINED', reason: 'PERIOD_ONLY' },
    });
    expect(t.lines.find((l) => l.id === `c:${comps[2]}`)!.note).toMatch(/rattachée à aucune année/);
    expect(t.annual.undated).toMatchObject({ count: 1, costsCents: 4050 });
    expect(t.annual.years.find((y) => y.year === 2026)?.possiblyIncomplete).toBe(true);
    expect(t.reliability.warnings).toContain('ECONOMIC_DATE_UNDETERMINED');
    expect([annee(t, 2025), annee(t, 2026)]).toEqual([4050, 2 * 4050]);
    coherent(t);
    // T2 : même incomplétude (non daté pour l'année demandée, jamais l'année de l'Opération).
    const p = await t2Annee(compte, maison.id, 2025);
    expect(p.sumCents).toBe(4050);
    expect(p.undated.sumCents).toBe(4050);
    // Correction documentaire (date de la facture renseignée) : l'affectation est réévaluée à la lecture.
    await sql`UPDATE asset_files SET document_date = '2026-09-06' WHERE id = ${fichiers[2]}`;
    const u = await tco(compte, maison.id);
    expect(u.lines.find((l) => l.id === `c:${comps[2]}`)).toMatchObject({ date: '2026-09-06', annualYear: 2026 });
    expect(u.annual.undated.count).toBe(0);
    expect(u.reliability.warnings).not.toContain('ECONOMIC_DATE_UNDETERMINED');
    coherent(u);
  });

  it('L86F-E2E-04 — dépense ponctuelle unique : datée par sa réalisation ; même Opération avec deux faits : aucune date reprise par défaut', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo', keyCharacteristics: { acquisitionDate: '2024-03-01' } });
    const f = await make.assetFile(compte, { assetId: velo.id });
    await sql`UPDATE asset_files SET document_type_code = 'REPAIR_INVOICE', retained_title = 'Réparation', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const { withBusinessOperationWrite } = await write();
    const { op, c1 } = await withBusinessOperationWrite(compte.id, async (repo) => {
      const o = await repo.create({
        type: { code: 'INTERVENTION' }, status: 'REALIZED', realizedDate: '2025-06-10',
        source: { kind: 'DOCUMENT', entityKey: f.id, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: velo.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L86F',
      });
      const c = await repo.addFinancialComponent(o.id, { kind: 'REALIZED_COST', amountMinor: 12_000, currency: 'EUR', sources: [{ sourceId: o.sourceId }], fingerprint: 'e2e-l86f-rep1' } as never, 'E2E_L86F');
      return { op: o.id, c1: c, src: o.sourceId };
    });
    const t = await tco(compte, velo.id);
    expect(t.lines.find((l) => l.id === `c:${c1}`)).toMatchObject({ date: '2025-06-10', annualYear: 2025, economicDate: { basis: 'OPERATION_SINGLE_FACT' } });
    // Second fait sur la même Opération (acompte sans date) : la date de réalisation n'est plus celle de CHAQUE fait.
    await withBusinessOperationWrite(compte.id, async (repo) => {
      const [s] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_sources WHERE operation_id = ${op} ORDER BY id LIMIT 1`;
      await repo.addFinancialComponent(op, { kind: 'REALIZED_COST', amountMinor: 3_000, currency: 'EUR', sources: [{ sourceId: s.id }], fingerprint: 'e2e-l86f-rep2' } as never, 'E2E_L86F');
    });
    const u = await tco(compte, velo.id);
    expect(u.summary.cumulativeCostCents).toBe(t.summary.cumulativeCostCents + 3_000);
    const faits = u.lines.filter((x) => x.operationId === op && x.source === 'OPERATION');
    expect(faits).toHaveLength(2);
    for (const l of faits) expect(l).toMatchObject({ date: null, annualYear: null, economicDate: { status: 'UNDETERMINED' } });
    coherent(u);
  });

  it('L86F-E2E-05 — reprise du stock : COH-TCO-ECONOMIC-DATES détecte (à blanc, sans écriture), consigne date et provenance (avant / après journalisés), recontrôle ; second passage idempotent', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, op, comps, cNov, fichiers } = await abonnement(compte);
    const h = await historique(compte);
    await campagne([compte.id], 'DRY_RUN');
    expect(await preuve(compte.id, op)).toMatchObject({ last_result: 'WOULD_REPAIR' });
    expect((await preuve(compte.id, op)).finding).toMatchObject({ anomaly: 'UNJUSTIFIED_ECONOMIC_DATE' });
    expect(await historique(compte)).toBe(h);
    expect((await traces(op)).every((c) => c.economic_date_basis === null)).toBe(true);

    await campagne([compte.id], 'CORRECTIVE');
    expect(await preuve(compte.id, op)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await reparations(compte.id)).toEqual([expect.objectContaining({ object_id: op, service: 'applyOperationEconomicDates', ai_calls: 0 })]);
    const apres = await traces(op);
    expect(apres.find((c) => c.id === comps[0])).toMatchObject({ economic_date: null, economic_date_basis: 'DOCUMENT', resolved: '2026-07-05' });
    expect(apres.find((c) => c.id === comps[0])!.trace).toMatchObject({ provenance: { type: 'DOCUMENT', fileId: fichiers[0] }, anomaly: 'UNJUSTIFIED_ECONOMIC_DATE', legacyDate: '2025-11-05' });
    expect(apres.find((c) => c.id === cNov)).toMatchObject({ economic_date_basis: 'DOCUMENT', resolved: '2025-11-05' });
    // Journal : ancienne affectation (date de l'Opération) → date justifiée.
    const j = await journal(op);
    expect(j).toHaveLength(4);
    expect(j.find((x) => x.after_json.component_id === comps[0])).toMatchObject({
      before_json: { economic_date_basis: 'LEGACY_OPERATION_FALLBACK', resolved_economic_date: '2025-11-05' },
      after_json: { economic_date_basis: 'DOCUMENT', resolved_economic_date: '2026-07-05' },
    });
    expect(j[0].correlation_id).toMatch(/^coherence:/);
    // Le TCO (calculé à la lecture) est celui que la trace consigne.
    const t = await tco(compte, maison.id);
    expect([annee(t, 2025), annee(t, 2026)]).toEqual([4050, 3 * 4050]);

    // Second passage : rien à faire, aucune écriture.
    const h2 = await historique(compte);
    await campagne([compte.id], 'CORRECTIVE');
    expect(await reparations(compte.id)).toHaveLength(1);
    expect(await historique(compte)).toBe(h2);
    expect(await preuve(compte.id, op)).toMatchObject({ last_result: 'CONSISTENT' });

    // Nouvelle preuve (règlement anticipé prouvé) : la trace devient obsolète, réparée, puis stable.
    await reglement(compte, maison, op, '2025-12-20', ['2026-07-05', '2026-08-04']);
    await campagne([compte.id], 'CORRECTIVE');
    expect((await reparations(compte.id)).length).toBe(2);
    expect((await traces(op)).find((c) => c.id === comps[0])).toMatchObject({ economic_date_basis: 'PAYMENT', resolved: '2025-12-20' });
    const h3 = await historique(compte);
    await campagne([compte.id], 'CORRECTIVE');
    expect(await historique(compte)).toBe(h3);
  });

  it('L86F-E2E-06 — incertitude conservée et décisions « Retirer du TCO » respectées par la réparation', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, op, comps } = await abonnement(compte, { sansDate: true });
    const { decideTcoLine } = await import('@/services/business-operations/tco/user-decisions.service');
    await decideTcoLine(compte.id, maison.id, compte.ownerUserId, { lineId: `c:${comps[1]}`, action: 'EXCLUDE' }, { today: AUJ });
    const avant = await tco(compte, maison.id);
    expect(avant.lines.find((l) => l.id === `c:${comps[1]}`)).toMatchObject({ includedCents: 0, reason: 'USER_EXCLUDED' });
    await campagne([compte.id], 'CORRECTIVE');
    expect(await preuve(compte.id, op)).toMatchObject({ last_result: 'REPAIRED' });
    // Sans preuve : l'incertitude est consignée (UNDETERMINED), aucune année inventée.
    expect((await traces(op)).find((c) => c.id === comps[2])).toMatchObject({ economic_date_basis: 'UNDETERMINED', resolved: null });
    const apres = await tco(compte, maison.id);
    expect(apres.lines.find((l) => l.id === `c:${comps[1]}`)).toMatchObject({ includedCents: 0, reason: 'USER_EXCLUDED' });
    expect(apres.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents);
    expect(apres.annual.years.map((y) => [y.year, y.costsCents])).toEqual(avant.annual.years.map((y) => [y.year, y.costsCents]));
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_cost_line_decisions WHERE account_id = ${compte.id}`)[0].n).toBe(1);
    coherent(apres);
  });
});
