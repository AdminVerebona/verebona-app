/**
 * Lot 111F — ticket P1 « TCO — coût de possession, financement et valorisation » — PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats (`replaceOperationCandidates`), consolidation T3
 * réelle (`consolidateAccountOperations`) : Opérations FINANCING existantes + `business_operation_financing_details`,
 * service TCO (`readAssetTco`), routes HTTP de la fiche (`/api/assets/[id]/tco`) et des valorisations
 * (`/api/assets/[id]/valuations`), réponse T2 (`ownershipCostAnswer`). Aucun appel IA. Recette §7 :
 *
 *   L111F-E2E-01  maison 400 000 / 50 000 (dont chaudière) / 20 000 de crédit à date / 5 ans : total 470 000 €,
 *                 annuel ≈ 14 000 €/an, capital jamais compté, prévisionnel séparé ; net « – » sans estimation
 *   L111F-E2E-02  valorisation : date obligatoire, jamais future ; dernière PAR DATE (pas par ordre d'ajout) ;
 *                 estimation 430 000 € → net 40 000 € ; antérieure à l'achat ignorée ; historique trié, retenue visible
 *   L111F-E2E-03  plusieurs prêts consolidés sans doublon ; avenant : échéancier remplacé à sa date d'effet
 *   L111F-E2E-04  maison ~497 k€ / ~5,5 ans : plus de « ~90 k€/an » ; frais d'acquisition séparés comptés une fois
 *   L111F-E2E-05  aucun prêt, aucune estimation : seuls les indicateurs dépendants « – », aucune alerte ;
 *                 véhicule : prix d'achat jamais une valeur actuelle
 *   L111F-E2E-06  bien vendu : prix réalisé, frais réels une fois ; T2 cohérent (coût total, annuel, net, crédit)
 *   L111F-E2E-07  Standard verrouillé (aucun montant), isolation des comptes (fiche et valorisations)
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));

type Json = Record<string, any>;
const AUJ = '2026-11-05';
const ACHAT = '2021-11-05';
const PRIX = 40_000_000;
const CAPITAL = 30_000_000;
const annualiser = (cents: number, d: { fullYears: number; remainderDays: number; yearDays: number }) => Math.round((cents * d.yearDays) / (d.fullYears * d.yearDays + d.remainderDays));

/** Échéances mensuelles à partir d'une date (jour 5), `n` occurrences. */
function echeances(debut: string, n: number): string[] {
  const [y, m] = debut.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const mm = m - 1 + i;
    return `${y + Math.floor(mm / 12)}-${String((mm % 12) + 1).padStart(2, '0')}-05`;
  });
}

scenario('L111F', 'TCO — coût annuel hors achat, financement selon l’échéancier, valorisation admissible', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;
  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });
  const connecter = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const tco = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: AUJ });
  const fiche = async (compte: AccountRow, assetId: number, attendu = 200) => {
    connecter(compte);
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    // Lot 111 (correctif 4) : la route lit l'horloge réelle ; sans date figée, le test comparait la
    // fiche du jour (06/11 : 13 992,33 €/an) au calcul figé au 05/11 (14 000,00 €/an). Seule la date
    // JS est figée (les minuteries restent réelles) le temps de l'appel.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${AUJ}T12:00:00+01:00`) });
    try {
      const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
      expect(res.status).toBe(attendu);
      return (await res.json()) as Json;
    } finally {
      vi.useRealTimers();
    }
  };
  const valoriser = async (compte: AccountRow, assetId: number, body: Json) => {
    connecter(compte);
    const { POST } = await import('@/app/api/assets/[id]/valuations/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${assetId}/valuations`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const historique = async (compte: AccountRow, assetId: number) => {
    connecter(compte);
    const { GET } = await import('@/app/api/assets/[id]/valuations/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/valuations`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const passer = (compte: AccountRow) => k.passer(compte, { today: AUJ });

  const maison = async (o: { prix?: number; achat?: string; plan?: 'premium' | 'standard' | 'premium_duo'; category?: string } = {}) => {
    const compte = await make.account({ plan: o.plan ?? 'premium' });
    const bien = await make.asset(compte, {
      category: o.category ?? 'IMMOBILIER', name: 'Maison', purchasePriceCents: o.prix ?? PRIX, keyCharacteristics: { acquisitionDate: o.achat ?? ACHAT },
    });
    return { compte, bien };
  };
  const travaux = (compte: AccountRow, bien: AssetRow, cents: number, date: string, titre: string) =>
    k.document(compte, bien.id, [cand({
      typeHint: 'INTERVENTION', sourceRoleHint: 'INVOICE', summary: titre, provider: 'Artisan', targetHints: [cible(bien.id)],
      businessReferences: [ref('INVOICE', `F-${titre}-${date}`)], temporalHints: { realizedDate: date }, financialHints: [fh('REALIZED_COST', cents, { economicDate: date })],
    })], { type: 'REPAIR_INVOICE', title: titre, amountCents: cents, date });
  /** Tableau d'amortissement : capital (jamais un coût) + échéances intérêts et assurance datées (prévisions contractuelles). */
  const pret = (compte: AccountRow, bien: AssetRow, o: { reference: string; capital: number; echeances: Array<[string, number]>; date: string; titre?: string; debut?: string }) =>
    k.document(compte, bien.id, [cand({
      typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: `Prêt ${o.reference}`, provider: 'Banque', targetHints: [cible(bien.id)],
      businessReferences: [ref('LOAN', o.reference)], temporalHints: { startDate: o.debut ?? ACHAT },
      financialHints: [fh('LOAN_PRINCIPAL', o.capital), ...o.echeances.map(([d, c]) => fh('FORECAST_COST', c, { amountScope: 'INSTALLMENT', economicDate: d }))],
    })], { type: 'LEASING_FINANCING_CONTRACT', title: o.titre ?? `Tableau d’amortissement ${o.reference}`, date: o.date });

  it('L111F-E2E-01 — maison 400 000 / 50 000 / 20 000 / 5 ans : total 470 000 €, ≈ 14 000 €/an, capital jamais compté, net « – »', async () => {
    const { compte, bien } = await maison();
    await travaux(compte, bien, 3_800_000, '2023-03-01', 'Toiture');
    await travaux(compte, bien, 1_200_000, '2025-01-15', 'Remplacement chaudière');
    // Au plus 20 montants par candidat T1 (contrat T1) : 10 échéances passées de 2 000 € + 5 futures, capital.
    const passees = echeances('2026-01-05', 10); // 05/01/2026 → 05/10/2026
    const futures = echeances('2027-01-05', 5);
    await pret(compte, bien, { reference: 'PRET-111', capital: CAPITAL, date: '2021-10-20', echeances: [...passees, ...futures].map((d) => [d, 200_000]) });
    await passer(compte);
    const fin = (await k.actives(compte)).filter((o) => o.type_code === 'FINANCING');
    expect(fin).toHaveLength(1);
    const [det] = await sql<{ p: number }[]>`SELECT principal_amount_minor::int AS p FROM business_operation_financing_details WHERE operation_id = ${fin[0].id}`;
    expect(det.p).toBe(CAPITAL);
    const comps = await k.composantes(fin[0].id);
    console.info(`[L111F-E2E-01] composantes du prêt : ${comps.length} (${JSON.stringify([...new Set(comps.map((c) => `${c.kind}:${c.amount_minor}`))])})`);

    const t = await tco(compte, bien.id);
    expect(t.summary.cumulativeCostCents).toBe(47_000_000);
    expect(t.indicators.financing).toMatchObject({ costToDateCents: 2_000_000, remainingCents: 1_000_000, contractualTotalCents: 3_000_000, basisLabel: 'Calculé selon l’échéancier du prêt' });
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', acquisitionPriceCents: PRIX, ownershipCostsCents: 7_000_000, days: 1827 });
    expect(t.annual.average.duration).toEqual({ fullYears: 5, remainderDays: 0, yearDays: 365 });
    expect(t.annual.average.cents).toBe(1_400_000); // exactement 14 000,00 €/an (années anniversaires)
    // Capital : jamais un coût (ni ligne retenue, ni total) ; mensualités jamais ajoutées au prix d'achat.
    expect(t.lines.filter((l) => (l.status === 'RETAINED_DIRECT' || l.status === 'RETAINED_CONSOLIDATED') && l.eurCents === CAPITAL)).toEqual([]);
    expect(t.annual.reconciled).toBe(true);
    expect(t.summary.netEstimatedCents).toBeNull();
    // Fiche (route, desktop et mobile) : indicateurs et motifs transmis tels quels.
    const r = await fiche(compte, bien.id);
    expect(r.tco.indicators.total.cents).toBe(47_000_000);
    expect(r.tco.indicators.annualAverage.cents).toBe(t.annual.average.cents);
    expect(r.tco.indicators.net).toMatchObject({ cents: null });
    expect(r.tco.indicators.net.unavailableReason).toMatch(/Aucune estimation de valeur postérieure à l’achat/);
    expect(r.tco.indicators.financing.loans).toHaveLength(1);
    // Aucune alerte « valorisation manquante » ni demande de justificatifs mensuels.
    expect(JSON.stringify(r.tco.diagnostics)).not.toMatch(/valoris|mensuel/i);
  });

  it('L111F-E2E-02 — valorisation : date obligatoire et non future ; dernière PAR DATE ; 430 000 € → net 40 000 € ; antérieure à l’achat ignorée', async () => {
    const { compte, bien } = await maison();
    await travaux(compte, bien, 5_000_000, '2023-03-01', 'Travaux');
    await pret(compte, bien, { reference: 'PRET-112', capital: CAPITAL, date: '2021-10-20', echeances: echeances('2026-01-05', 10).map((d) => [d, 200_000]) });
    await passer(compte);
    expect((await valoriser(compte, bien.id, { value: 430_000, mode: 'ESTIMATION_AGENCE' })).status).toBe(400); // date absente
    expect((await valoriser(compte, bien.id, { value: 430_000, date: '2026-12-01' })).status).toBe(400); // future
    expect((await valoriser(compte, bien.id, { value: 430_000, date: '2026-09-01', mode: 'ESTIMATION_AGENCE' })).status).toBeLessThan(300);
    // Saisie APRÈS, mais estimation plus ANCIENNE : ne remplace ni la valeur retenue, ni la valeur courante de la fiche.
    expect((await valoriser(compte, bien.id, { value: 410_000, date: '2024-05-01', mode: 'AVIS_VALEUR' })).status).toBeLessThan(300);
    // Antérieure à l'achat : conservée, jamais une valeur actuelle.
    expect((await valoriser(compte, bien.id, { value: 380_000, date: '2021-06-01' })).status).toBeLessThan(300);
    const [kc] = await sql<{ v: unknown }[]>`SELECT key_characteristics::jsonb->'estimatedValue' AS v FROM assets WHERE id = ${bien.id}`;
    expect(Number(kc.v)).toBe(430_000);
    const t = await tco(compte, bien.id);
    expect(t.summary.cumulativeCostCents).toBe(47_000_000);
    expect(t.summary.currentValue).toMatchObject({ cents: 43_000_000, date: '2026-09-01' });
    expect(t.summary.netEstimatedCents).toBe(4_000_000);
    expect(t.indicators.net.valuation).toMatchObject({ cents: 43_000_000, date: '2026-09-01', mode: 'ESTIMATION_AGENCE' });
    const h = await historique(compte, bien.id);
    expect(h.status).toBe(200);
    expect((h.body.history as Json[]).map((x) => [x.date, x.retained, x.rejection])).toEqual([
      ['2026-09-01', true, null], ['2024-05-01', false, null], ['2021-06-01', false, 'NOT_AFTER_ACQUISITION'],
    ]);
    expect((h.body.history as Json[]).every((x) => typeof x.addedAt === 'string' && x.addedAt.slice(0, 10) !== x.date || x.date === AUJ)).toBe(true);
  });

  it('L111F-E2E-03 — deux prêts consolidés sans doublon ; avenant : échéancier remplacé à partir de sa date d’effet', async () => {
    const { compte, bien } = await maison();
    await pret(compte, bien, { reference: 'PRET-A', capital: CAPITAL, date: '2021-10-20', echeances: echeances('2026-01-05', 12).map((d) => [d, 100_000]) });
    await pret(compte, bien, { reference: 'PTZ-B', capital: 5_000_000, date: '2021-10-21', echeances: echeances('2025-01-05', 5).map((d) => [d, 20_000]) });
    await passer(compte);
    const avant = await tco(compte, bien.id);
    const fin = (await k.actives(compte)).filter((o) => o.type_code === 'FINANCING');
    expect(fin).toHaveLength(2);
    // PRET-A : 11 échéances passées (01/2026 → 11/2026) + 1 future ; PTZ : 5 passées.
    expect(avant.indicators.financing.loans).toHaveLength(2);
    expect(avant.indicators.financing.costToDateCents).toBe(11 * 100_000 + 5 * 20_000);
    expect(avant.indicators.financing.remainingCents).toBe(100_000);
    // Avenant du PRET-A (renégociation) : nouvel échéancier à 70 000 à partir du 05/06/2026.
    await pret(compte, bien, { reference: 'PRET-A', capital: CAPITAL, date: '2026-05-20', titre: 'Avenant PRET-A', echeances: echeances('2026-06-05', 8).map((d) => [d, 70_000]) });
    await passer(compte);
    const apres = await tco(compte, bien.id);
    const finApres = (await k.actives(compte)).filter((o) => o.type_code === 'FINANCING');
    console.info(`[L111F-E2E-03] prêts après avenant : ${finApres.length} ; ${JSON.stringify(apres.indicators.financing.loans.map((l) => [l.reference, l.costToDateCents, l.remainingCents, l.supersededCount]))}`);
    expect(finApres).toHaveLength(2); // un avenant ne crée jamais un prêt fictif
    const a = apres.indicators.financing.loans.find((l) => l.reference === 'PRET-A')!;
    // Origine : 01/2026 → 05/2026 (5 passées, conservées) ; avenant : 06/2026 → 11/2026 (6 passées) + 2 futures.
    expect(a).toMatchObject({ costToDateCents: 5 * 100_000 + 6 * 70_000, remainingCents: 2 * 70_000 });
    expect(a.supersededCount).toBeGreaterThan(0);
    expect(apres.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    expect(apres.summary.cumulativeCostCents).toBe(PRIX + a.costToDateCents + 100_000);
  });

  it('L111F-E2E-04 — maison ~497 k€ / ~5,5 ans : plus de « ~90 k€/an » ; frais d’acquisition comptés une fois, au numérateur', async () => {
    const { compte, bien } = await maison({ prix: 45_000_000, achat: '2021-05-01' });
    await k.document(compte, bien.id, [cand({
      typeHint: 'ACQUISITION', sourceRoleHint: 'INVOICE', summary: 'Frais de notaire', provider: 'Notaire', targetHints: [cible(bien.id)],
      businessReferences: [ref('INVOICE', 'NOT-1')], temporalHints: { realizedDate: '2021-05-01' }, financialHints: [fh('REALIZED_COST', 3_200_000, { amountScope: 'FEE', economicDate: '2021-05-01' })],
    })], { type: 'ACQUISITION_INVOICE', title: 'Frais de notaire', amountCents: 3_200_000, date: '2021-05-01' });
    await travaux(compte, bien, 1_509_283, '2024-02-01', 'Travaux');
    await passer(compte);
    const t = await tco(compte, bien.id);
    expect(t.summary.cumulativeCostCents).toBe(49_709_283);
    expect(t.annual.average.acquisitionPriceCents).toBe(45_000_000);
    const ancienne = annualiser(49_709_283, t.annual.average.duration!);
    expect(ancienne).toBeGreaterThan(8_500_000);
    expect(t.annual.average.cents).toBe(annualiser(4_709_283, t.annual.average.duration!));
  });

  it('L111F-E2E-05 — aucun prêt, aucune estimation : indicateurs dépendants « – », aucune alerte ; véhicule ancien : prix jamais une valeur', async () => {
    const { compte, bien } = await maison({ category: 'VEHICULE', prix: 2_500_000, achat: '2015-03-01' });
    await travaux(compte, bien, 80_000, '2025-04-01', 'Révision');
    expect((await valoriser(compte, bien.id, { value: 25_000, date: '2015-03-01' })).status).toBeLessThan(300); // = date d'achat
    await passer(compte);
    const r = await fiche(compte, bien.id);
    expect(r.tco.indicators.financing.loans).toEqual([]);
    expect(r.tco.indicators.net.cents).toBeNull();
    expect(r.tco.indicators.net.unavailableReason).toMatch(/antérieure ou égale à la date d’achat/);
    expect(r.tco.indicators.annualAverage.cents).toBe(annualiser(80_000, r.tco.annual.average.duration));
    expect(r.tco.summary.currentValue).toBeNull();
    expect(r.tco.diagnostics.open.families).toBe(0);
  });

  it('L111F-E2E-06 — bien vendu : prix réalisé, frais réels une fois ; T2 cohérent avec la fiche', async () => {
    const { compte, bien } = await maison();
    await travaux(compte, bien, 2_000_000, '2023-01-01', 'Travaux');
    await k.document(compte, bien.id, [cand({
      typeHint: 'DISPOSAL', sourceRoleHint: 'SALE_DOCUMENT', summary: 'Vente', provider: 'Acquéreur', targetHints: [cible(bien.id)],
      businessReferences: [ref('CONTRACT', 'VENTE-1')], temporalHints: { realizedDate: '2026-06-01' },
      financialHints: [fh('PROCEED', 45_000_000, { economicDate: '2026-06-01' }), fh('REALIZED_COST', 1_000_000, { amountScope: 'FEE', economicDate: '2026-06-01' })],
    })], { type: 'SALE_DEED', title: 'Acte de vente', date: '2026-06-01' });
    await sql`UPDATE assets SET status = 'VENDU' WHERE id = ${bien.id}`;
    await passer(compte);
    const t = await tco(compte, bien.id);
    expect(t.disposed).toBe(true);
    expect(t.disposal.realizedPriceCents).toBe(45_000_000);
    expect(t.summary.netFinalCents).toBe(t.summary.cumulativeCostCents - 45_000_000);
    expect(t.indicators.net).toMatchObject({ kind: 'FINAL', cents: t.summary.netFinalCents });
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const a = ownershipCostAnswer({ id: bien.id, name: 'Maison' } as never, t) as { answer: string; sources: Array<{ meta?: Record<string, unknown> }> };
    expect(a.answer).toContain('coût net final');
    expect(a.answer).toMatch(/Coût annuel moyen de possession \(hors prix d’achat du bien\)/);
    expect(a.sources[0].meta).toMatchObject({ annualAverageCents: t.indicators.annualAverage.documentedCents, netFinalCents: t.summary.netFinalCents });
  });

  it('L111F-E2E-07 — Standard verrouillé (aucun montant) ; isolation des comptes (fiche et valorisations)', async () => {
    const std = await maison({ plan: 'standard' });
    const bloque = await fiche(std.compte, std.bien.id, 403);
    expect(JSON.stringify(bloque)).not.toMatch(/indicators|cumulativeCostCents/);
    const duo = await maison({ plan: 'premium_duo' });
    expect((await fiche(duo.compte, duo.bien.id)).tco.indicators).toBeTruthy();
    const autre = await make.account({ plan: 'premium' });
    connecter(autre);
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${duo.bien.id}/tco`), { params: Promise.resolve({ id: String(duo.bien.id) }) });
    expect(res.status).toBe(404);
    expect((await historique(autre, duo.bien.id)).status).toBe(404);
    expect((await valoriser(autre, duo.bien.id, { value: 1, date: '2026-01-01' })).status).toBe(404);
  });
});
