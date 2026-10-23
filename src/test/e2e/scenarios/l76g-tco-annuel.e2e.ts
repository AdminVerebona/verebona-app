/**
 * Lot 76G — ticket P2 « TCO : ajouter les indicateurs annuels » sur
 * PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats, consolidation
 * T3 réelle (`consolidateAccountOperations`), service TCO réel
 * (`readAssetTco` → `computeTco` → `computeTcoAnnual`), route HTTP réelle de
 * la fiche. Seule la session est simulée. Aucun appel IA. Assertions limitées
 * aux comptes créés ici.
 *
 * Lot 81D (ticket P2 « TCO : écarts de calcul annuel », 22/10/2026 — prime
 * sur 76G/80A) : dépenses non réalisées exclues des trois indicateurs, plus de
 * seuil de 30 jours, date d'acquisition canonique (repli `assets.purchase_date`),
 * dates strictes, statuts prévus / annulés, détail de l'année = indicateur
 * (route `?linesYear=`), 31/12 → 01/01 (date de référence injectée).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, cibleEquipement, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
const TODAY = '2026-10-21';

scenario('L76G', 'TCO — indicateurs annuels (moyenne annuelle, dépenses de l’année)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const tco = async (compte: AccountRow, assetId: number, today = TODAY) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today });
  const getTco = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const as = (compte: AccountRow) => { session.currentAccountId = compte.id; session.userId = compte.ownerUserId; };
  const velo = (compte: AccountRow, acquisitionDate: string | null = '2024-03-01'): Promise<AssetRow> =>
    make.asset(compte, { category: 'OBJET', name: 'Vélo', purchasePriceCents: 30_000, keyCharacteristics: acquisitionDate ? { acquisitionDate } : {} });
  const facture = (compte: AccountRow, asset: AssetRow, titre: string, cents: number, date: string, o: { equipement?: number; ref?: string } = {}) =>
    k.document(compte, asset.id, [cand({
      typeHint: 'INTERVENTION', summary: titre, provider: 'Atelier', targetHints: [o.equipement ? cibleEquipement(o.equipement) : cible(asset.id)],
      businessReferences: [ref('INVOICE', o.ref ?? `L76G-${titre}`)], temporalHints: { realizedDate: date }, financialHints: [fh('REALIZED_COST', cents)],
    })], { type: 'REPAIR_INVOICE', title: titre, amountCents: cents, date });
  const annee = (t: Awaited<ReturnType<typeof tco>>, y: number) => t.annual.years.find((a) => a.year === y);
  const coherent = (t: Awaited<ReturnType<typeof tco>>) => {
    const a = t.annual;
    expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents) // 81D : plus de « futures » retenues
      .toBe(t.summary.cumulativeCostCents);
  };

  /** Vélo 300 € (01/03/2024) + révision 50 € (2025) + révision 80 € (2026) + GPS 200 € (2025) réparé 40 € (2026). */
  const jeu = async (compte: AccountRow) => {
    const v = await velo(compte);
    const [{ id: gps }] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, key_characteristics, purchase_price_cents)
      VALUES (${v.id}, 'GPS', '{"acquisitionDate":"2025-09-01"}'::jsonb, 20000) RETURNING id`;
    const r1 = await facture(compte, v, 'Révision 2025', 5_000, '2025-05-01');
    const r2 = await facture(compte, v, 'Révision 2026', 8_000, '2026-02-01');
    const rg = await facture(compte, v, 'Réparation GPS', 4_000, '2026-06-01', { equipement: gps });
    await sql`UPDATE asset_files SET equipment_id = ${gps} WHERE id = ${rg}`;
    return { v, gps, r1, r2, rg };
  };

  it('L76G-E01 — trois indicateurs cohérents (service et route) ; équipements comptés à leur date, sans doublon, avant et après T3', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { v } = await jeu(compte);
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 5_000 + 8_000 + 20_000 + 4_000);
    expect([annee(t, 2024)?.costsCents, annee(t, 2025)?.costsCents, annee(t, 2026)?.costsCents]).toEqual([30_000, 25_000, 12_000]);
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', start: '2024-03-01', days: 965 });
    expect(t.annual.average.cents).toBe(Math.round((67_000 * 365.25) / 965));
    coherent(t);
    // Consolidation T3 réelle : les justificatifs repris par les dépenses consolidées ne sont jamais comptés deux fois.
    await k.passer(compte, { today: TODAY });
    const u = await tco(compte, v.id);
    expect(u.summary.cumulativeCostCents).toBe(67_000);
    expect(u.annual.years.map((y) => [y.year, y.costsCents])).toEqual(t.annual.years.map((y) => [y.year, y.costsCents]));
    coherent(u);
    // Route de la fiche : indicateurs transmis tels que calculés (années précédentes consultables).
    as(compte);
    const r = await getTco(v.id);
    expect(r.status).toBe(200);
    // La route calcule au jour réel : on compare au service calculé à la même date (le test ne dépend plus du jour d'exécution).
    const jourRoute = r.body.tco.annual.average.end as string;
    const uRoute = await tco(compte, v.id, jourRoute);
    expect(r.body.tco.annual).toEqual(JSON.parse(JSON.stringify(uRoute.annual)));
    expect(r.body.tco.annual.years.map((y: any) => y.year)).toEqual([2024, 2025, 2026]);
  });

  it('L76G-E02 — modification d’une dépense (montant puis date) : total, moyenne et années concernées actualisés à la relecture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { v, r1, r2 } = await jeu(compte);
    const avant = await tco(compte, v.id);
    // Montant corrigé par l'utilisateur (80 → 100 €).
    await sql`UPDATE asset_files SET amount_cents = 10000, user_edited_fields = '{"amountCents":true}'::jsonb WHERE id = ${r2}`;
    const montant = await tco(compte, v.id);
    expect(montant.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents + 2_000);
    expect(annee(montant, 2026)?.costsCents).toBe(annee(avant, 2026)!.costsCents + 2_000);
    expect(annee(montant, 2025)?.costsCents).toBe(annee(avant, 2025)?.costsCents);
    expect(montant.annual.average.cents).toBeGreaterThan(avant.annual.average.cents!);
    coherent(montant);
    // Date corrigée (révision 2025 → 05/01/2026) : la dépense change d'année, le total ne bouge pas.
    await sql`UPDATE asset_files SET document_date = '2026-01-05', user_edited_fields = '{"amountCents":true}'::jsonb WHERE id = ${r1}`;
    const date = await tco(compte, v.id);
    expect(date.summary.cumulativeCostCents).toBe(montant.summary.cumulativeCostCents);
    expect(annee(date, 2025)?.costsCents).toBe(20_000);
    expect(annee(date, 2026)?.costsCents).toBe(annee(montant, 2026)!.costsCents + 5_000);
    coherent(date);
  });

  // Lot 81D (prime sur 76G) : plus de seuil de 30 jours ; dépense future exclue du total (plus seulement des années).
  it('L76G-E03 — achat récent (moyenne extrapolée, sans seuil), date inconnue, année sans dépense, dépense future exclue : aucune valeur trompeuse', async () => {
    const compte = await make.account({ plan: 'premium' });
    const recent = await velo(compte, '2026-10-12');
    const r = await tco(compte, recent.id);
    expect(r.annual.average).toMatchObject({ status: 'COMPUTED', days: 10, extrapolated: true, extrapolationLabel: 'Valeur extrapolée sur une durée de possession inférieure à un an' });
    expect(r.annual.average.cents).toBe(Math.round((30_000 * 365.25) / 10));
    const sansDate = await velo(compte, null);
    const s = await tco(compte, sansDate.id);
    expect(s.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_MISSING', cents: null });
    expect(s.annual.undated.costsCents).toBe(30_000);
    coherent(s);
    const ancien = await velo(compte, '2022-06-01');
    await facture(compte, ancien, 'Révision future', 6_000, '2026-12-15');
    const a = await tco(compte, ancien.id);
    expect(a.annual.years.map((y) => y.year)).toEqual([2022, 2023, 2024, 2025, 2026]);
    expect(annee(a, 2024)).toMatchObject({ costsCents: 0, count: 0 });
    expect(a.annual.notRealized).toMatchObject({ count: 1, costsCents: 6_000 });
    expect(a.summary.cumulativeCostCents).toBe(30_000);
    expect(annee(a, 2026)?.costsCents).toBe(0);
    coherent(a);
  });

  it('L76G-E04 — Standard : 403 avant toute lecture, aucun indicateur annuel transmis', async () => {
    const compte = await make.account({ plan: 'standard' });
    const v = await velo(compte);
    as(compte);
    const r = await getTco(v.id);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('annual');
  });

  // ── Lot 81D ───────────────────────────────────────────────────────────────

  /** Opération consolidée (SQL direct : état T3 persisté), justifiée par un document du bien, liée au bien. */
  const operation = async (compte: AccountRow, asset: AssetRow, o: { status: string; cents: number; date: string | null; realized?: string | null; planned?: string | null; justifie?: boolean }) => {
    const [op] = await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date, planned_date)
      VALUES (${compte.id}, 'INTERVENTION', ${o.status}, 'Entretien L81D', 'Atelier', ${o.realized ?? null}, ${o.planned ?? null}) RETURNING id`;
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, active, economic_date)
      VALUES (${compte.id}, ${op.id}, 'REALIZED_COST', ${o.cents}, 'EUR', true, ${o.date}) RETURNING id`;
    if (o.justifie !== false) {
      const f = await make.assetFile(compte, { assetId: asset.id });
      const [src] = await sql<{ id: number }[]>`
        INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority, confidence, active)
        VALUES (${compte.id}, ${op.id}, 'DOCUMENT', ${String(f.id)}, 'INVOICE', 'DOCUMENT', 'certain', true) RETURNING id`;
      await sql`INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, is_primary) VALUES (${c.id}, ${src.id}, true)`;
    }
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, active) VALUES (${compte.id}, ${op.id}, ${asset.id}, 'PRIMARY', 'DOCUMENT', true)`;
    return { op: op.id, component: c.id };
  };
  const reconcilie = (t: Awaited<ReturnType<typeof tco>>) => {
    coherent(t);
    expect(t.annual.reconciled).toBe(true);
    for (const y of t.annual.years) {
      expect(t.lines.filter((l) => l.annualYear === y.year && l.kind === 'REALIZED_COST').reduce((n, l) => n + l.includedCents, 0)).toBe(y.costsCents);
    }
  };

  it('L81D-E01 — date d’acquisition uniquement dans l’ancienne colonne `assets.purchase_date` : bien acheté en 2020, ajouté en 2026, annualisé depuis 2020', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await make.asset(compte, { category: 'OBJET', name: 'Vélo 2020', purchasePriceCents: 30_000, purchaseDate: '2020-03-15', keyCharacteristics: {} });
    const t = await tco(compte, v.id);
    expect(t.period).toMatchObject({ start: '2020-03-15', startSource: 'ASSET_DATA' });
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', start: '2020-03-15', extrapolated: false });
    expect(t.annual.average.days).toBe(Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse('2020-03-15T00:00:00Z')) / 86_400_000) + 1);
    expect(t.annual.years[0].year).toBe(2020);
    expect(annee(t, 2020)?.costsCents).toBe(30_000);
    reconcilie(t);
    // La clé de la fiche (source de vérité) prime sur la colonne historique ; l'équipement garde SA date.
    await sql`UPDATE assets SET key_characteristics = '{"acquisitionDate":"2019-06-01"}'::jsonb WHERE id = ${v.id}`;
    await sql`INSERT INTO equipments (asset_id, name, key_characteristics, purchase_price_cents) VALUES (${v.id}, 'Compteur', '{"acquisitionDate":"2025-09-01"}'::jsonb, 5000)`;
    const u = await tco(compte, v.id);
    expect(u.annual.average.start).toBe('2019-06-01');
    expect(annee(u, 2025)?.costsCents).toBe(5_000);
    expect(annee(u, 2019)?.costsCents).toBe(30_000);
    reconcilie(u);
    // Date impossible saisie dans la fiche : jamais normalisée (29/02/2025 ≠ 01/03/2025), moyenne non calculée.
    await sql`UPDATE assets SET key_characteristics = '{"acquisitionDate":"2025-02-29"}'::jsonb WHERE id = ${v.id}`;
    const w = await tco(compte, v.id);
    expect(w.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'INVALID_DATE', cents: null });
    expect(w.period.start).toBeNull();
    reconcilie(w);
  });

  it('L81D-E02 — dépense de 300 € prévue en décembre : exclue des trois indicateurs ; réalisée et corrigée : recalculée ; annulée : jamais', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte, '2024-03-01');
    const base = await tco(compte, v.id);
    const { op, component } = await operation(compte, v, { status: 'ENVISAGED', cents: 30_000, date: '2026-12-01', planned: '2026-12-01' });
    const prevue = await tco(compte, v.id);
    expect(prevue.summary.cumulativeCostCents).toBe(base.summary.cumulativeCostCents);
    expect(prevue.annual.average.cents).toBe(base.annual.average.cents);
    expect(annee(prevue, 2026)?.costsCents).toBe(annee(base, 2026)?.costsCents);
    expect(prevue.lines.find((l) => l.id === `c:${component}`)).toMatchObject({ reason: 'NOT_REALIZED', includedCents: 0, notRealized: true });
    expect(prevue.annual.notRealized).toEqual({ count: 1, costsCents: 30_000 });
    reconcilie(prevue);
    // Planifiée incohérente : statut prévu, aucune date de paiement (seulement la date planifiée) → non comptée.
    await sql`UPDATE business_operation_financial_components SET economic_date = NULL WHERE id = ${component}`;
    await sql`UPDATE business_operations SET planned_date = '2026-05-01' WHERE id = ${op}`;
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(base.summary.cumulativeCostCents);
    // Réalisée (statut et date effective établis) : comptée à sa date réelle — total, moyenne et année recalculés.
    await sql`UPDATE business_operations SET status = 'REALIZED', realized_date = '2026-10-15' WHERE id = ${op}`;
    await sql`UPDATE business_operation_financial_components SET economic_date = '2026-10-15' WHERE id = ${component}`;
    const realisee = await tco(compte, v.id);
    expect(realisee.summary.cumulativeCostCents).toBe(base.summary.cumulativeCostCents + 30_000);
    expect(annee(realisee, 2026)?.costsCents).toBe(annee(base, 2026)!.costsCents + 30_000);
    expect(realisee.annual.average.cents).toBeGreaterThan(base.annual.average.cents!);
    reconcilie(realisee);
    // Annulée : aucune dépense réalisée.
    await sql`UPDATE business_operations SET status = 'CANCELLED' WHERE id = ${op}`;
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(base.summary.cumulativeCostCents);
  });

  it('L81D-E03 — dépense réellement payée pour une période future : retenue à sa date de paiement ; dépense sans date : aucune année, année « potentiellement incomplète »', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte, '2024-03-01');
    const { component } = await operation(compte, v, { status: 'REALIZED', cents: 12_000, date: '2026-09-30', realized: '2026-09-30' });
    await sql`UPDATE business_operation_financial_components SET period_start = '2027-01-01', period_end = '2027-12-31' WHERE id = ${component}`;
    await operation(compte, v, { status: 'REALIZED', cents: 4_000, date: null, realized: null, planned: '2025-06-01' });
    const t = await tco(compte, v.id);
    expect(t.lines.find((l) => l.id === `c:${component}`)).toMatchObject({ includedCents: 12_000, annualYear: 2026 });
    expect(t.annual.years.some((y) => y.year === 2027)).toBe(false);
    expect(t.annual.undated).toMatchObject({ count: 1, costsCents: 4_000 });
    expect(annee(t, 2025)).toMatchObject({ costsCents: 0, possiblyIncomplete: true });
    reconcilie(t);
  });

  it('L81D-E04 — route : détail de l’année (`?linesYear=`) = indicateur ; la pagination ne change aucun total (Standard : L76G-E04)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { v } = await jeu(compte);
    await operation(compte, v, { status: 'REALIZED', cents: 100_000, date: '2025-03-01', realized: '2025-03-01' });
    as(compte);
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const lire = async (q: string) => (await (await GET(new NextRequest(`http://x/api/assets/${v.id}/tco${q}`), { params: Promise.resolve({ id: String(v.id) }) })).json()) as Record<string, any>;
    const complet = (await lire('')).tco;
    const annee2025 = (await lire('?linesYear=2025&linesLimit=1000')).tco;
    const y = complet.annual.years.find((a: any) => a.year === 2025);
    expect(annee2025.lines.every((l: any) => l.annualYear === 2025)).toBe(true);
    expect(annee2025.lines.filter((l: any) => l.kind === 'REALIZED_COST').reduce((n: number, l: any) => n + l.includedCents, 0)).toBe(y.costsCents);
    expect(annee2025.lines.filter((l: any) => l.kind === 'REALIZED_COST')).toHaveLength(y.count);
    const page = (await lire('?linesYear=2025&linesLimit=1')).tco;
    expect(page.lines).toHaveLength(1);
    expect(page.summary).toEqual(complet.summary);
    expect(page.annual).toEqual(complet.annual);
    // Date de référence de la route = date civile à Paris (même jour pour les trois indicateurs).
    const { civilDateParis } = await import('@/services/business-operations/finance/engine');
    expect([civilDateParis(new Date(Date.now() - 120_000)), civilDateParis()]).toContain(complet.annual.referenceDate);
    expect(complet.annual.average.end).toBe(complet.annual.referenceDate);
  });

  it('L81D-E05 — passage du 31/12 au 01/01 (date de référence injectée) : année civile et non-réalisation correctement déterminées', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte, '2024-03-01');
    await facture(compte, v, 'Révision du 31/12', 1_000, '2026-12-31');
    await facture(compte, v, 'Révision du 01/01', 2_000, '2027-01-01');
    const veille = await tco(compte, v.id, '2026-12-31');
    expect(veille.annual).toMatchObject({ defaultYear: 2026, referenceDate: '2026-12-31' });
    expect(annee(veille, 2026)?.costsCents).toBe(1_000);
    expect(veille.annual.notRealized).toMatchObject({ count: 1, costsCents: 2_000 });
    expect(veille.summary.cumulativeCostCents).toBe(31_000);
    reconcilie(veille);
    const lendemain = await tco(compte, v.id, '2027-01-01');
    expect(lendemain.annual).toMatchObject({ defaultYear: 2027, referenceDate: '2027-01-01' });
    expect(annee(lendemain, 2027)).toMatchObject({ costsCents: 2_000, periodStart: '2027-01-01', periodEnd: '2027-01-01' });
    expect(lendemain.summary.cumulativeCostCents).toBe(33_000);
    expect(lendemain.annual.average.end).toBe('2027-01-01');
    reconcilie(lendemain);
  });

  it('L81D-E06 (TCO-R-14) — T2 aligné : dépenses non réalisées (prévue sans paiement, datée après aujourd’hui) exclues de T2 comme du TCO — bien et compte entier', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte, '2024-03-01');
    await operation(compte, v, { status: 'REALIZED', cents: 5_000, date: '2025-05-01', realized: '2025-05-01' });
    // Réalisée mais datée après la date réelle du jour (+ 2 ans) ; prévue en décembre, sans paiement établi.
    const futur = `${Number(new Date().toISOString().slice(0, 4)) + 2}-06-01`;
    await operation(compte, v, { status: 'REALIZED', cents: 20_000, date: futur, realized: futur });
    await operation(compte, v, { status: 'ENVISAGED', cents: 30_000, date: null, planned: futur });
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const t = await readAssetTco(compte.id, v.id); // date du jour réelle, comme T2
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 5_000);
    const { sumQualifiedExpenses } = await import('@/services/verebona-assistant/canonical/expenses');
    const bien = await sumQualifiedExpenses(compte.id, { assetIds: [v.id] });
    // T2 ne compte pas le prix de la fiche (donnée du bien, pas une dépense consolidée) : comparaison sur les dépenses consolidées.
    const consolideesTco = t.lines.filter((l) => l.source === 'OPERATION').reduce((n, l) => n + l.includedCents, 0);
    expect(consolideesTco).toBe(5_000);
    expect(bien.qualifiedSumCents + bien.unqualified.sumCents).toBe(consolideesTco); // avant 81D : 55 000 (rouge)
    // Compte entier : règle sans bien (non-réalisation) appliquée de même — la révision réalisée seule compte.
    const tout = await sumQualifiedExpenses(compte.id, {});
    expect(tout.operations?.sumCents ?? 0).toBe(5_000);
  });
});
