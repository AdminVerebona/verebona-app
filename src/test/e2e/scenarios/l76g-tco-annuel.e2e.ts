/**
 * Lot 76G — ticket P2 « TCO : ajouter les indicateurs annuels » sur
 * PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats, consolidation
 * T3 réelle (`consolidateAccountOperations`), service TCO réel
 * (`readAssetTco` → `computeTco` → `computeTcoAnnual`), route HTTP réelle de
 * la fiche. Seule la session est simulée. Aucun appel IA. Assertions limitées
 * aux comptes créés ici.
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
    expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents + a.future.costsCents - a.future.creditsCents)
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
    expect(r.body.tco.annual).toEqual(JSON.parse(JSON.stringify(u.annual)));
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

  it('L76G-E03 — achat récent, date inconnue, année sans dépense, dépense future : aucune valeur trompeuse', async () => {
    const compte = await make.account({ plan: 'premium' });
    const recent = await velo(compte, '2026-10-12');
    const r = await tco(compte, recent.id);
    expect(r.annual.average).toMatchObject({ status: 'TOO_RECENT', cents: null, days: 10 });
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
    expect(a.annual.future).toMatchObject({ count: 1, costsCents: 6_000 });
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
});
