/**
 * Lot 61 — ticket P1 « TCO — intégration de toutes les dépenses,
 * consolidation anti-double comptage et tiroir dédié » sur PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats
 * (`replaceOperationCandidates`), consolidation T3 réelle
 * (`consolidateAccountOperations`), service TCO réel (`readAssetTco`),
 * routes HTTP réelles (tiroir, BO), lecture T2 réelle (`sumQualifiedExpenses`,
 * `ownershipCostAnswer`). Seule la lecture de la session (et le rôle admin
 * pour la route BO) est simulée. Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref, RECETTE_TODAY } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, adminId: 0 }));
vi.mock('@/lib/auth-guards', async (o) => ({ ...(await o<object>()), requireAdmin: async () => session.adminId }));

scenario('L61', 'TCO — toutes les dépenses, anti-double comptage, tiroir dédié', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });
  afterEach(async () => {
    (await import('@/services/business-operations/consolidation/consolidator')).setT3FaultHookForTests(null);
  });

  const tco = async (compte: AccountRow, assetId: number) => (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: RECETTE_TODAY });
  const getTco = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const as = (compte: AccountRow, userId = compte.ownerUserId) => { session.currentAccountId = compte.id; session.userId = userId; };

  /** Vélo acheté 300 € (prix saisi sur la fiche : origine USER, colonne miroir), sans Opération. */
  const velo = async (compte: AccountRow): Promise<AssetRow> => make.asset(compte, { category: 'OBJET', name: 'Vélo', purchasePriceCents: 30_000 });
  /** Facture d'accessoire qualifiée par T1 (aucune Opération). */
  const accessoire = (compte: AccountRow, asset: AssetRow, titre: string, cents: number, refFacture: string) =>
    k.document(compte, asset.id, [cand({ typeHint: 'ACQUISITION', summary: titre, provider: 'Cycles Martin', targetHints: [cible(asset.id)],
      businessReferences: [ref('INVOICE', refFacture)], temporalHints: { realizedDate: '2026-06-01' }, financialHints: [fh('REALIZED_COST', cents)] })],
    { type: 'ACQUISITION_INVOICE', title: titre, amountCents: cents, date: '2026-06-01' });

  it('TCO-01 / TCO-02 / TCO-03 — vélo 300 € (fiche, sans opération) → 300 ; + béquille 25 € → 325 ; + antivol 35 € → 360 (service, route, aucune opération créée)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(30_000);
    const bequille = await accessoire(compte, v, 'Béquille', 2_500, 'CM-1');
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(32_500);
    await accessoire(compte, v, 'Antivol', 3_500, 'CM-2');
    const t = await tco(compte, v.id);
    expect(t.summary).toMatchObject({ cumulativeCostCents: 36_000, acquisitionCents: 30_000, additionalCostsCents: 6_000 });
    expect(t.lines.find((l) => l.fileId === bequille && l.source === 'DOCUMENT')).toMatchObject({ status: 'RETAINED_DIRECT', provenance: 'T1', category: 'ACCESSORIES' });
    // Aucune Opération ni carte « À traiter » créée pour rendre la facture visible.
    expect(await k.operations(compte)).toHaveLength(0);
    expect((await sql`SELECT id FROM to_process_actions WHERE account_id = ${compte.id}`)).toHaveLength(0);
    as(compte);
    const r = await getTco(v.id);
    expect(r.status).toBe(200);
    expect(r.body.tco.summary.cumulativeCostCents).toBe(36_000);
    expect(r.body.tco.lines.filter((l: any) => l.status === 'RETAINED_DIRECT')).toHaveLength(3);
    expect(r.body.tco).not.toHaveProperty('entries');
  });

  it('TCO-01b — prix de la fiche : toutes familles (immobilier, véhicule, objet) ; véhicule en LLD : aucune acquisition (règle de l’achat structuré)', async () => {
    const compte = await make.account({ plan: 'premium' });
    for (const category of ['IMMOBILIER', 'VEHICULE', 'OBJET']) {
      const a = await make.asset(compte, { category, name: `Bien ${category}`, purchasePriceCents: 12_300 });
      expect((await tco(compte, a.id)).summary.acquisitionCents).toBe(12_300);
    }
    const lld = await make.asset(compte, { category: 'VEHICULE', name: 'Location', purchasePriceCents: 12_300, keyCharacteristics: { vehicleOwnershipStatus: 'LLD' } });
    expect((await tco(compte, lld.id)).summary.cumulativeCostCents).toBe(0);
  });

  it('TCO-05 — facture comptée directement puis reprise par T3 : total inchangé, une seule fois (via la composante)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const f = await accessoire(compte, v, 'Béquille', 2_500, 'CM-5');
    const avant = await tco(compte, v.id);
    await k.passer(compte);
    const apres = await tco(compte, v.id);
    expect(apres.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents);
    expect(apres.summary.cumulativeCostCents).toBe(32_500);
    const doc = apres.lines.find((l) => l.fileId === f && l.source === 'DOCUMENT');
    // Reprise : le justificatif est représenté par la consolidation (jamais additionné).
    expect(['CONSOLIDATED_ELSEWHERE']).toContain(doc?.status);
    expect(apres.lines.filter((l) => l.status === 'RETAINED_CONSOLIDATED' || l.status === 'RETAINED_DIRECT').reduce((n, l) => n + l.includedCents, 0)).toBe(32_500);
    // Reconsolidation idempotente : rien ne bouge.
    await k.passer(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(32_500);
  });

  it('TCO-05b — prix de la fiche consolidé par T3 (achat ASSET_DATA) puis accessoires consolidés : 300 € jamais doublé ni masqué, total stable à chaque étape', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    await accessoire(compte, v, 'Béquille', 2_500, 'CM-5b');
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(32_500);
    await (await import('@/services/business-operations/consolidation/asset-data-consolidator')).consolidateAssetData(compte.id, v.id, { today: RECETTE_TODAY });
    const t1 = await tco(compte, v.id);
    expect(t1.summary.cumulativeCostCents).toBe(32_500);
    expect(t1.lines.find((l) => l.source === 'ASSET_DATA')).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE', reason: 'ASSET_PRICE_CONSOLIDATED' });
    await k.passer(compte);
    const t2 = await tco(compte, v.id);
    expect(t2.summary).toMatchObject({ cumulativeCostCents: 32_500, acquisitionCents: 30_000, additionalCostsCents: 2_500 });
    // Lot 78A : la béquille (25 €) n'est plus rattachée à l'achat du vélo (300 €) par le seul cycle de possession
    // (ordres de grandeur différents) — elle est sa propre Opération : dépense distincte comptée une fois.
    expect(t2.lines.find((l) => l.source === 'DOCUMENT')).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE' });
    expect(t2.lines.filter((l) => l.source !== 'DOCUMENT' && l.status === 'RETAINED_CONSOLIDATED').map((l) => l.includedCents).sort((a, b) => a - b)).toEqual([2_500, 30_000]);
    // T2 : même lecture (300 consolidés + 25 du justificatif).
    const q = await (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, { assetIds: [v.id] });
    expect(q.qualifiedSumCents).toBe(32_500);
    // Facture d'achat du vélo (preuve T1 du prix) rattachée au même achat, montant différent : même fait, jamais additionnée.
    const vraie = await accessoire(compte, v, 'Facture vélo', 31_000, 'CM-VELO');
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt)
              VALUES (${compte.id}, ${v.id}, 'acquisitionPrice', '310'::jsonb, 'document', ${vraie}, 'certain', ${`e2e-l61-${vraie}`}, 'Total 310 €')`;
    await k.passer(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(32_500);
    expect((await (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, { assetIds: [v.id] })).qualifiedSumCents).toBe(32_500);
  });

  it('TCO-04 / TCO-06 — devis 150 € puis facture 180 € → +180 ; facture rattachée à une opération sans coût consolidé → non perdue', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    await k.document(compte, v.id, [cand({ statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', summary: 'Réparation frein', targetHints: [cible(v.id)], financialHints: [fh('FORECAST_COST', 15_000)] })],
      { type: 'REPAIR_QUOTE', title: 'Devis frein', amountCents: 15_000, date: '2026-05-01' });
    const facture = await k.document(compte, v.id, [cand({ summary: 'Réparation frein', targetHints: [cible(v.id)], businessReferences: [ref('INVOICE', 'R-180')], financialHints: [fh('REALIZED_COST', 18_000)] })],
      { type: 'REPAIR_INVOICE', title: 'Facture frein', amountCents: 18_000, date: '2026-05-20' });
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(48_000);
    await k.passer(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(48_000);

    // Facture rattachée à une intervention active SANS composante financière (ex. créée depuis l'agenda
    // ou un sinistre sans montant) — harnais : Opération et source DOCUMENT insérées en SQL.
    const sansMontant = await k.document(compte, v.id, [], { type: 'MAINTENANCE_INVOICE', title: 'Facture révision', amountCents: 6_000, date: '2026-07-01' });
    const [{ id: op }] = await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, realized_date, technical_label)
      VALUES (${compte.id}, 'INTERVENTION', 'REALIZED', DATE '2026-07-01', 'Révision') RETURNING id::int AS id`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${compte.id}, ${op}, ${v.id}, 'PRIMARY', 'STRUCTURED')`;
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority)
              VALUES (${compte.id}, ${op}, 'DOCUMENT', ${String(sansMontant)}, 'INVOICE', 'DOCUMENT')`;
    expect(await k.composantes(op)).toEqual([]);
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(54_000);
    expect(t.lines.find((l) => l.fileId === sansMontant && l.source === 'DOCUMENT')).toMatchObject({ status: 'RETAINED_DIRECT', operationId: op });
    // La facture 180 € est comptée UNE fois (directement si T3 l'a mise en attente, sinon via sa composante) ; le devis jamais.
    const retenues180 = t.lines.filter((l) => (l.status === 'RETAINED_DIRECT' || l.status === 'RETAINED_CONSOLIDATED') && l.includedCents === 18_000);
    expect(retenues180).toHaveLength(1);
    expect(retenues180[0].fileId).toBe(facture);
    expect(t.lines.filter((l) => l.includedCents === 15_000)).toEqual([]);
    // T2 : même règle (la facture fait foi), plus d'« élément sans montant ».
    const q = await (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, { assetIds: [v.id] });
    expect(q.operations?.withoutAmount.operationIds ?? []).not.toContain(op);
    expect(q.qualifiedSumCents).toBe(18_000 + 6_000);
  });

  it('TCO-07 / TCO-08 / TCO-09 — doublon, acompte + solde dans la facture totale, avoir : un coût par fait', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await make.asset(compte, { category: 'OBJET', name: 'Vélo cargo' });
    const p = { provider: 'Atelier Cargo', targetHints: [cible(v.id)] };
    // Doublon : même fichier déposé deux fois (même empreinte).
    const a = await k.document(compte, v.id, [cand({ ...p, financialHints: [fh('REALIZED_COST', 4_000)] })], { type: 'REPAIR_INVOICE', title: 'Facture pneu', amountCents: 4_000 });
    const b = await k.document(compte, v.id, [cand({ ...p, financialHints: [fh('REALIZED_COST', 4_000)] })], { type: 'REPAIR_INVOICE', title: 'Facture pneu', amountCents: 4_000 });
    await sql`UPDATE asset_files SET sha256_hash = 'meme-empreinte' WHERE id IN (${a}, ${b})`;
    // Facture totale 200 + acompte 50 + solde 150.
    await k.document(compte, v.id, [cand({ ...p, businessReferences: [ref('ORDER', 'CMD-9')], financialHints: [fh('REALIZED_COST', 20_000)] })], { type: 'WORKS_INVOICE', title: 'Facture caisse', amountCents: 20_000 });
    await k.document(compte, v.id, [cand({ ...p, sourceRoleHint: 'DEPOSIT_INVOICE', financialHints: [fh('REALIZED_COST', 5_000, { amountScope: 'DEPOSIT' })] })], { type: 'WORKS_INVOICE', title: 'Facture d’acompte caisse', amountCents: 5_000 });
    await k.document(compte, v.id, [cand({ ...p, financialHints: [fh('REALIZED_COST', 15_000, { amountScope: 'BALANCE' })] })], { type: 'WORKS_INVOICE', title: 'Facture de solde caisse', amountCents: 15_000 });
    // Facture 100 + avoir 20.
    await k.document(compte, v.id, [cand({ ...p, financialHints: [fh('REALIZED_COST', 10_000)] })], { type: 'REPAIR_INVOICE', title: 'Facture éclairage', amountCents: 10_000 });
    await k.document(compte, v.id, [cand({ ...p, sourceRoleHint: 'CREDIT_NOTE', financialHints: [fh('REDUCTION', 2_000)] })], { type: 'REPAIR_INVOICE', title: 'Avoir éclairage', amountCents: 2_000 });
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(4_000 + 20_000 + 8_000);
    expect(t.lines.find((l) => l.fileId === b)).toMatchObject({ status: 'DUPLICATE', reason: 'DUPLICATE_COPY' });
    expect(t.lines.filter((l) => l.status === 'INCLUDED_IN_TOTAL')).toHaveLength(2);
    // Après T3 : mêmes montants (aucune variation artificielle).
    await k.passer(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(32_000);
  });

  it('TCO-10 / TCO-11 / TCO-14 — échéances futures non cumulées ; facture de deux biens non imputée ; devise non convertible exclue avec motif', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await make.asset(compte, { category: 'VEHICULE', name: 'Scooter' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    const echeances = ['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05'].map((d) => fh('REALIZED_COST', 3_000, { amountScope: 'INSTALLMENT', economicDate: d }));
    await k.document(compte, v.id, [cand({ typeHint: 'CONTRACT', targetHints: [cible(v.id)], financialHints: echeances })], { type: 'INSURANCE_DUE_NOTICE', title: 'Échéancier assurance' });
    const commune = await k.document(compte, v.id, [cand({ targetHints: [], financialHints: [fh('REALIZED_COST', 12_000)] })], { type: 'REPAIR_INVOICE', title: 'Facture commune', amountCents: 12_000 });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${compte.id}, ${commune}, ${garage.id}, 'SECONDARY', 'USER', 'ACTIVE')`;
    const chf = await k.document(compte, v.id, [cand({ targetHints: [cible(v.id)], financialHints: [fh('REALIZED_COST', 10_000, { currency: 'CHF' })] })], { type: 'REPAIR_INVOICE', title: 'Facture Genève', amountCents: 10_000 });
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(6_000); // 2 échéances échues sur 4 (au 12/10/2026)
    expect(t.lines.filter((l) => l.reason === 'FUTURE_INSTALLMENT')).toHaveLength(2);
    expect(t.lines.find((l) => l.fileId === commune)).toMatchObject({ status: 'UNALLOCATED', includedCents: 0 });
    expect(t.lines.find((l) => l.fileId === chf)).toMatchObject({ status: 'UNCONVERTED', reason: 'UNCONVERTED_CURRENCY' });
    expect(t.status).toBe('INCOMPLETE');
    // Le garage ne reçoit pas non plus la facture commune en entier.
    expect((await tco(compte, garage.id)).summary.cumulativeCostCents).toBe(0);
  });

  it('TCO-12 — facture déplacée vers un autre bien, puis supprimée : recalcul correct des deux biens', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const autre = await make.asset(compte, { category: 'OBJET', name: 'Trottinette' });
    const f = await k.document(compte, v.id, [cand({ typeHint: 'INTERVENTION', financialHints: [fh('REALIZED_COST', 2_500)] })], { type: 'REPAIR_INVOICE', title: 'Facture réparation', amountCents: 2_500 });
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(32_500);
    await sql`UPDATE asset_files SET asset_id = ${autre.id} WHERE id = ${f}`;
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(30_000);
    expect((await tco(compte, autre.id)).summary.cumulativeCostCents).toBe(2_500);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f}`;
    expect((await tco(compte, autre.id)).summary.cumulativeCostCents).toBe(0);
    await sql`UPDATE asset_files SET deleted_at = NULL WHERE id = ${f}`; // restauration
    expect((await tco(compte, autre.id)).summary.cumulativeCostCents).toBe(2_500);
  });

  it('TCO-13 — T3 en erreur : dépenses documentaires qualifiées conservées, puis reprise sans rupture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    await accessoire(compte, v, 'Panier', 4_000, 'CM-13');
    const { setT3FaultHookForTests } = await import('@/services/business-operations/consolidation/consolidator');
    const { BusinessOperationIntegrityError } = await import('@/services/business-operations/errors');
    setT3FaultHookForTests((stage) => { if (stage === 'document') throw new BusinessOperationIntegrityError('PARENT_CYCLE', 'panne simulée'); });
    await k.passer(compte).catch(() => undefined);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(34_000);
    setT3FaultHookForTests(null);
    await k.passer(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(34_000);
  });

  it('TCO-15 — relecture du TCO et réponses T2 sur les mêmes dépenses : montants cohérents', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    await accessoire(compte, v, 'Béquille', 2_500, 'CM-15a');
    await accessoire(compte, v, 'Antivol', 3_500, 'CM-15b');
    const t = await tco(compte, v.id);
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const r = ownershipCostAnswer({ id: v.id, name: 'Vélo' } as never, t) as { answer: string };
    expect(r.answer).toMatch(/360,00\s€/);
    // Dépenses documentaires de T2 (hors prix de la fiche) = dépenses complémentaires du TCO.
    const q = await (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, { assetIds: [v.id] });
    expect(q.qualifiedSumCents).toBe(t.summary.additionalCostsCents);
    await k.passer(compte);
    const t2 = await tco(compte, v.id);
    const q2 = await (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, { assetIds: [v.id] });
    expect(t2.summary.cumulativeCostCents).toBe(36_000);
    // Après T3 (accessoires consolidés) : mêmes montants des deux côtés.
    expect(q2.qualifiedSumCents).toBe(t2.summary.additionalCostsCents);
    expect(q2.qualifiedSumCents).toBe(6_000);
  });

  it('TCO-17 — Standard verrouillé sans montant ; Premium Duo : membre autorisé, mêmes montants ; autre compte : 404', async () => {
    const std = await make.account({ plan: 'standard' });
    const vs = await velo(std);
    await accessoire(std, vs, 'Béquille', 2_500, 'CM-17');
    as(std);
    const bloque = await getTco(vs.id);
    expect(bloque.status).toBe(403);
    expect(bloque.body).toEqual({ error: 'PREMIUM_REQUIRED', code: 'PREMIUM_REQUIRED', message: expect.any(String), locked: true });
    expect(JSON.stringify(bloque.body)).not.toMatch(/32500|30000|2500|cumulative|lines/);
    const duo = await make.account({ plan: 'premium_duo' });
    const vd = await velo(duo);
    await accessoire(duo, vd, 'Béquille', 2_500, 'CM-17d');
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.id}, ${membre.id}, 'member', 'active')`.catch(() => undefined);
    as(duo, membre.id);
    const vu = await getTco(vd.id);
    expect(vu.status).toBe(200);
    expect(vu.body.tco.summary.cumulativeCostCents).toBe(32_500);
    as(std);
    expect((await getTco(vd.id)).status).toBe(404);
  });

  it('TCO-DIAG — diagnostic BO : chaque ligne retenue ou écartée, avec motif, sans SQL ni opération créée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    await accessoire(compte, v, 'Béquille', 2_500, 'CM-D');
    await k.document(compte, v.id, [cand({ sourceRoleHint: 'PAYMENT_PROOF', targetHints: [cible(v.id)], financialHints: [fh('PAYMENT', 2_500)] })], { type: 'WORKS_PAYMENT_PROOF', title: 'Virement béquille', amountCents: 2_500 });
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { GET } = await import('@/app/api/admin/operations/tco/route');
    const res = await GET(new NextRequest(`http://x/api/admin/operations/tco?accountId=${compte.id}&assetId=${v.id}`));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.tco.summary.cumulativeCostCents).toBe(32_500);
    const lignes = body.tco.lines as Array<Record<string, any>>;
    expect(lignes.map((l) => l.status).sort()).toEqual(['PAYMENT', 'RETAINED_DIRECT', 'RETAINED_DIRECT']);
    for (const l of lignes) expect(l).toEqual(expect.objectContaining({ id: expect.any(String), source: expect.any(String), provenance: expect.any(String), amountMinor: expect.any(Number), currency: expect.any(String) }));
    expect(body.labels.reason.PAYMENT_PROOF).toMatch(/règlement/);
    expect(await k.operations(compte)).toHaveLength(0);
    expect((await GET(new NextRequest(`http://x/api/admin/operations/tco?accountId=${compte.id}&assetId=999999999`))).status).toBe(404);
    expect((await GET(new NextRequest('http://x/api/admin/operations/tco?accountId=abc'))).status).toBe(400);
  });
});
