/**
 * Lot 75D — ticket P1 « TCO — écarts résiduels de consolidation financière,
 * déduplication et complétude » (A à J) et L71A résiduels §C, sur
 * PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats
 * (`replaceOperationCandidates`), consolidation T3 réelle
 * (`consolidateAccountOperations`), service TCO réel (`readAssetTco`),
 * routes HTTP réelles (fiche, BO), lecture T2 réelle (`sumQualifiedExpenses`).
 * Harnais : session (et rôle admin du BO) simulés ; une source DOCUMENT
 * insérée en SQL représente une Opération partiellement consolidée (pièce
 * jointe en attente de reconsolidation). Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, cibleEquipement, fh, operationsKit, ref, RECETTE_TODAY } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, adminId: 0 }));
vi.mock('@/lib/auth-guards', async (o) => ({ ...(await o<object>()), requireAdmin: async () => session.adminId }));

scenario('L75D', 'TCO — écarts résiduels : identité économique, couverture au fait, complétude', ({ sql, make }) => {
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
  const t2 = async (compte: AccountRow, assetId: number) => (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, { assetIds: [assetId] });
  const getTco = async (assetId: number, qs = '') => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco${qs}`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const as = (compte: AccountRow, userId = compte.ownerUserId) => { session.currentAccountId = compte.id; session.userId = userId; };
  const ligneDoc = (t: Awaited<ReturnType<typeof tco>>, fileId: number) => t.lines.find((l) => l.fileId === fileId && l.source === 'DOCUMENT');
  /** Vélo acheté 300 € le 10/01/2026 (fiche : prix et date saisis). */
  const velo = (compte: AccountRow, kc: Record<string, unknown> = { acquisitionDate: '2026-01-10' }): Promise<AssetRow> =>
    make.asset(compte, { category: 'OBJET', name: 'Vélo', purchasePriceCents: 30_000, keyCharacteristics: kc });
  const facture = (compte: AccountRow, asset: AssetRow, titre: string, cents: number, o: { type?: string; typeHint?: string; ref?: string; date?: string; provider?: string; hints?: ReturnType<typeof fh>[]; targets?: ReturnType<typeof cible>[] } = {}) =>
    k.document(compte, asset.id, [cand({
      typeHint: (o.typeHint ?? 'INTERVENTION') as 'INTERVENTION', summary: titre, provider: o.provider ?? 'Atelier', targetHints: o.targets ?? [cible(asset.id)],
      businessReferences: o.ref ? [ref('INVOICE', o.ref)] : [], temporalHints: { realizedDate: o.date ?? '2026-06-01' },
      financialHints: o.hints ?? [fh('REALIZED_COST', cents)],
    })], { type: o.type ?? 'REPAIR_INVOICE', title: titre, amountCents: cents, date: o.date ?? '2026-06-01' });
  const preuve = async (compte: AccountRow, assetId: number, fileId: number, eur: number, lifecycle: string | null = null, target: { type: string; id: number } | null = null) => {
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt, lifecycle_status, target_type, target_entity_id)
              VALUES (${compte.id}, ${assetId}, 'acquisitionPrice', ${String(eur)}::jsonb, 'document', ${fileId}, 'certain', ${`e2e-l75d-${fileId}-${lifecycle ?? 'A'}-${target?.id ?? 0}`},
                      ${`Total ${eur} €`}, ${lifecycle}, ${target?.type ?? null}, ${target?.id ?? null})`;
  };

  it('TCO-R-E01 (A) — bien 300 € + accessoire DISTINCT 300 € → 600 € (service, route, BO) ; même date que l’achat → un seul coût', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const acc = await facture(compte, v, 'Remorque', 30_000, { typeHint: 'ACQUISITION', type: 'ACQUISITION_INVOICE', ref: 'R-1' });
    const t = await tco(compte, v.id);
    expect(t.summary).toMatchObject({ cumulativeCostCents: 60_000, acquisitionCents: 30_000, additionalCostsCents: 30_000 });
    expect(ligneDoc(t, acc)).toMatchObject({ status: 'RETAINED_DIRECT', category: 'ACCESSORIES' });
    expect(t.status).toBe('COMPLETE');
    as(compte);
    expect((await getTco(v.id)).body.tco.summary.cumulativeCostCents).toBe(60_000);
    // Après T3 (achat consolidé depuis la facture de la remorque) : toujours 600, jamais absorbé sur le montant.
    await k.passer(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(60_000);
    // Facture d'achat du vélo, même montant, MÊME date que la fiche : même fait.
    const c2 = await make.account({ plan: 'premium' });
    const v2 = await velo(c2, { acquisitionDate: '2026-06-01' });
    const achatVelo = await facture(c2, v2, 'Facture vélo', 30_000, { typeHint: 'ACQUISITION', type: 'ACQUISITION_INVOICE', ref: 'V-1' });
    const u = await tco(c2, v2.id);
    expect(u.summary.cumulativeCostCents).toBe(30_000);
    expect(ligneDoc(u, achatVelo)).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_ASSET_PRICE' });
  });

  it('TCO-R-E02 (B) — facture 180 € consolidée + facture 40 € non consolidée dans la même opération → 220 € ; reprise par T3 → 220 € ; T2 identique', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const f180 = await facture(compte, v, 'Réparation cadre', 18_000, { ref: 'A-180' });
    await k.passer(compte);
    const [o] = await k.actives(compte);
    expect(await k.coutNet(o.id)).toBe(18_000);
    // Pièce jointe à la même dépense, pas encore reconsolidée (aucune composante ne la cite).
    const f40 = await facture(compte, v, 'Pièces cadre', 4_000, { ref: 'A-40' });
    await sql`UPDATE document_operation_candidates SET t3_pending = false WHERE file_id = ${f40}`.catch(() => undefined);
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority)
              VALUES (${compte.id}, ${o.id}, 'DOCUMENT', ${String(f40)}, 'INVOICE', 'DOCUMENT')`;
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 22_000);
    expect(ligneDoc(t, f180)).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE' });
    expect(ligneDoc(t, f40)).toMatchObject({ status: 'RETAINED_DIRECT', operationId: o.id });
    // T2 : même règle de couverture (aucune seconde logique) — mêmes dépenses complémentaires.
    expect((await t2(compte, v.id)).qualifiedSumCents).toBe(t.summary.additionalCostsCents);
    // Reconsolidation réelle : la facture de 40 € est reprise (ou rattachée à sa propre dépense) — total inchangé.
    await k.passer(compte);
    const apres = await tco(compte, v.id);
    expect(apres.summary.cumulativeCostCents).toBe(52_000);
    expect((await t2(compte, v.id)).qualifiedSumCents).toBe(apres.summary.additionalCostsCents);
  });

  it('TCO-R-E03 (C) — facture 200 € + acompte 50 € + solde 150 € liés (référence de commande) → 200 € ; deux prestations du même fournisseur → deux coûts ; acompte sans lien → signalé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await make.asset(compte, { category: 'OBJET', name: 'Cargo', purchasePriceCents: 100_000, keyCharacteristics: { acquisitionDate: '2025-01-01' } });
    const p = { provider: 'Atelier Cargo', targetHints: [cible(v.id)] };
    const cmd = [ref('ORDER', 'CMD-75')];
    await k.document(compte, v.id, [cand({ ...p, businessReferences: cmd, financialHints: [fh('REALIZED_COST', 20_000)] })], { type: 'WORKS_INVOICE', title: 'Facture caisse', amountCents: 20_000 });
    const acompte = await k.document(compte, v.id, [cand({ ...p, businessReferences: cmd, sourceRoleHint: 'DEPOSIT_INVOICE', financialHints: [fh('REALIZED_COST', 5_000, { amountScope: 'DEPOSIT' })] })], { type: 'WORKS_INVOICE', title: 'Facture d’acompte', amountCents: 5_000 });
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(100_000 + 20_000);
    expect(ligneDoc(t, acompte)).toMatchObject({ status: 'INCLUDED_IN_TOTAL', reason: 'INCLUDED_IN_TOTAL_INVOICE' });
    // Deux prestations indépendantes chez le même fournisseur (sans portée acompte / solde) : deux coûts.
    await k.document(compte, v.id, [cand({ ...p, financialHints: [fh('REALIZED_COST', 7_000)] })], { type: 'REPAIR_INVOICE', title: 'Pneu', amountCents: 7_000 });
    await k.document(compte, v.id, [cand({ ...p, financialHints: [fh('REALIZED_COST', 3_000)] })], { type: 'REPAIR_INVOICE', title: 'Chambre à air', amountCents: 3_000 });
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(130_000);
    // Acompte du même fournisseur sans référence commune ni somme exacte : compté, rapprochement incertain signalé.
    const libre = await k.document(compte, v.id, [cand({ ...p, financialHints: [fh('REALIZED_COST', 1_000, { amountScope: 'DEPOSIT' })] })], { type: 'WORKS_INVOICE', title: 'Acompte divers', amountCents: 1_000 });
    const u = await tco(compte, v.id);
    expect(u.summary.cumulativeCostCents).toBe(131_000);
    expect(ligneDoc(u, libre)).toMatchObject({ status: 'RETAINED_DIRECT', uncertain: true });
    expect(u.status).toBe('INCOMPLETE');
    // Après T3 : aucune variation artificielle.
    await k.passer(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(131_000);
  });

  it('TCO-R-E04 (D) — facture financière sans montant (ni candidat T1) : lue, « montant inconnu », couverture incomplète ; route sans 0 €', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const f = await k.document(compte, v.id, [], { type: 'MAINTENANCE_INVOICE', title: 'Révision (illisible)', amountCents: null });
    const t = await tco(compte, v.id);
    expect(ligneDoc(t, f)).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'AMOUNT_UNKNOWN', amountUnknown: true, eurCents: null, includedCents: 0 });
    expect(t.reliability.warnings).toContain('AMOUNTS_UNKNOWN');
    expect(t.status).toBe('INCOMPLETE');
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    as(compte);
    const r = await getTco(v.id);
    expect(r.body.tco.lines.find((l: any) => l.fileId === f)).toMatchObject({ amountUnknown: true, eurCents: null });
    // Une photo sans montant n'est pas lue comme justificatif.
    const photo = await k.document(compte, v.id, [], { type: 'PHOTO', title: 'Photo', amountCents: null });
    expect(ligneDoc(await tco(compte, v.id), photo)).toBeUndefined();
  });

  it('TCO-R-E05 (E) — facture que T1 dit multibiens, cible unique, non ventilée : aucun montant attribué ; parts établies : chaque bien sa part', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage', purchasePriceCents: 1_000_000, keyCharacteristics: { acquisitionDate: '2020-01-01' } });
    const globale = await facture(compte, v, 'Facture entretien globale', 12_000);
    await sql`UPDATE document_extractions SET multi_asset = true WHERE file_id = ${globale}`;
    const t = await tco(compte, v.id);
    expect(ligneDoc(t, globale)).toMatchObject({ status: 'UNALLOCATED', includedCents: 0 });
    expect(t.status).toBe('INCOMPLETE');
    const ventilee = await k.document(compte, v.id, [
      cand({ candidateKey: 'op1', targetHints: [cible(v.id)], financialHints: [fh('REALIZED_COST', 4_000)] }),
      cand({ candidateKey: 'op2', targetHints: [cible(garage.id)], financialHints: [fh('REALIZED_COST', 8_000)] }),
    ], { type: 'REPAIR_INVOICE', title: 'Facture ventilée', amountCents: 12_000 });
    await sql`UPDATE document_extractions SET multi_asset = true WHERE file_id = ${ventilee}`;
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${compte.id}, ${ventilee}, ${garage.id}, 'SECONDARY', 'USER', 'ACTIVE')`;
    const tv = await tco(compte, v.id);
    const tg = await tco(compte, garage.id);
    expect(tv.lines.filter((l) => l.fileId === ventilee && l.includedCents).map((l) => l.includedCents)).toEqual([4_000]);
    expect(tg.lines.filter((l) => l.fileId === ventilee && l.includedCents).map((l) => l.includedCents)).toEqual([8_000]);
  });

  it('TCO-R-E06 (F) / L71A-C — équipement acheté 200 € puis réparé 200 € → 400 € ; facture d’achat preuve du prix → une fois ; preuve RETIRÉE → ignorée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const [{ id: gps }] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, key_characteristics, purchase_price_cents) VALUES (${v.id}, 'GPS', '{}'::jsonb, 20000) RETURNING id`;
    const rep = await k.document(compte, v.id, [cand({ typeHint: 'INTERVENTION', targetHints: [cibleEquipement(gps)], financialHints: [fh('REALIZED_COST', 20_000)] })],
      { type: 'REPAIR_INVOICE', title: 'Réparation GPS', amountCents: 20_000, date: '2026-08-01' });
    await sql`UPDATE asset_files SET equipment_id = ${gps} WHERE id = ${rep}`;
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 40_000);
    expect(t.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'RETAINED_DIRECT' });
    // Après T3 (réparation consolidée ciblant le GPS) : toujours 400 € pour le GPS.
    await k.passer(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(70_000);
    // Facture d'ACHAT du GPS, preuve de son prix : comptée une fois avec la fiche de l'équipement.
    const achat = await k.document(compte, v.id, [cand({ typeHint: 'ACQUISITION', targetHints: [cible(v.id)], financialHints: [fh('REALIZED_COST', 20_500)] })],
      { type: 'ACQUISITION_INVOICE', title: 'Achat GPS', amountCents: 20_500, date: '2026-02-01' });
    await preuve(compte, v.id, achat, 205, null, { type: 'EQUIPMENT', id: gps });
    const u = await tco(compte, v.id);
    expect(u.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_EQUIPMENT_DOCUMENT', fileId: achat });
    expect(u.summary.cumulativeCostCents).toBe(30_000 + 20_000 + 20_500);
    expect(u.summary.acquisitionCents).toBe(30_000);
    // Preuve SUPERSEDED (réanalyse) : plus une preuve — la fiche de l'équipement et la facture comptent séparément.
    await sql`UPDATE field_evidence SET lifecycle_status = 'SUPERSEDED' WHERE source_id = ${achat} AND account_id = ${compte.id}`;
    const w = await tco(compte, v.id);
    expect(w.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'RETAINED_DIRECT' });
    expect(w.summary.cumulativeCostCents).toBe(30_000 + 20_000 + 20_000 + 20_500);
  });

  it('L71A-C-E — preuve WITHDRAWN du prix du bien : ni preuve du prix (readAssetPrice), ni preuve d’acquisition (acquisitionEvidenceFiles), ni dans T2', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const f = await facture(compte, v, 'Facture vélo', 31_000, { typeHint: 'ACQUISITION', type: 'ACQUISITION_INVOICE', ref: 'W-1', date: '2026-03-03' });
    await preuve(compte, v.id, f, 310);
    const svc = await import('@/services/business-operations/tco/service');
    const { db } = await import('@/db');
    expect((await svc.readAssetPrice(db, compte.id, v.id))?.evidenceFileIds).toEqual([f]);
    expect([...(await svc.acquisitionEvidenceFiles(db, compte.id, [f]))]).toEqual([f]);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(30_000);
    await sql`UPDATE field_evidence SET lifecycle_status = 'WITHDRAWN' WHERE source_id = ${f} AND account_id = ${compte.id}`;
    expect((await svc.readAssetPrice(db, compte.id, v.id))?.evidenceFileIds).toEqual([]);
    expect([...(await svc.acquisitionEvidenceFiles(db, compte.id, [f]))]).toEqual([]);
    // Preuve retirée : la facture n'est plus « la facture d'achat » — dépense distincte (dates différentes), jamais masquée.
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(61_000);
    expect(ligneDoc(t, f)).toMatchObject({ status: 'RETAINED_DIRECT' });
  });

  it('TCO-R-E07 (G, H) — facture d’acquisition sans prix dans la fiche → acquisition identifiée ; prix attendu inconnu → INCOMPLETE ; LLD → sans objet', async () => {
    const compte = await make.account({ plan: 'premium' });
    const o = await make.asset(compte, { category: 'OBJET', name: 'Kayak', keyCharacteristics: { acquisitionDate: '2026-06-01' } });
    expect((await tco(compte, o.id)).summary.acquisitionStatus).toBe('MISSING');
    expect((await tco(compte, o.id)).status).toBe('INCOMPLETE');
    const f = await facture(compte, o, 'Facture kayak', 45_000, { typeHint: 'ACQUISITION', type: 'ACQUISITION_INVOICE', ref: 'K-1' });
    const t = await tco(compte, o.id);
    expect(t.summary).toMatchObject({ acquisitionCents: 45_000, acquisitionStatus: 'DOCUMENTED', cumulativeCostCents: 45_000 });
    expect(ligneDoc(t, f)).toMatchObject({ category: 'ACQUISITION' });
    expect(t.status).toBe('COMPLETE');
    await k.passer(compte);
    expect((await tco(compte, o.id)).summary).toMatchObject({ acquisitionCents: 45_000, cumulativeCostCents: 45_000 });
    const lld = await make.asset(compte, { category: 'VEHICULE', name: 'Location', keyCharacteristics: { vehicleOwnershipStatus: 'LLD', acquisitionDate: '2026-01-01' } });
    const l = await tco(compte, lld.id);
    expect(l.summary.acquisitionStatus).toBe('NOT_APPLICABLE');
    expect(l.reliability.warnings).not.toContain('ACQUISITION_COST_MISSING');
  });

  it('TCO-R-E08 (I) — plus de 500 équipements : tous lus (aucune exclusion silencieuse), total exact', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    await sql`INSERT INTO equipments (asset_id, name, key_characteristics, purchase_price_cents)
              SELECT ${v.id}, 'Pièce ' || g, '{}'::jsonb, 100 FROM generate_series(1, 520) g`;
    const t = await tco(compte, v.id);
    expect(t.lines.filter((l) => l.source === 'EQUIPMENT_DATA')).toHaveLength(520);
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 52_000);
    expect(t.status).toBe('COMPLETE');
  });

  it('TCO-R-E09 (J) — plus de 400 lignes financières : total exact, liste abrégée signalée, page suivante par la route', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const [{ uid }] = await sql<{ uid: number }[]>`SELECT owner_user_id AS uid FROM accounts WHERE id = ${compte.id}`.catch(async () => [{ uid: compte.ownerUserId }]);
    await sql`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, document_type_code, retained_title, amount_cents, document_date, analysis_state, sha256_hash)
              SELECT ${uid}, ${compte.id}, ${v.id}, 'e2e/l75d/' || g || '.pdf', 'application/pdf', 'REPAIR_INVOICE', 'Ticket ' || g, 100,
                     DATE '2026-02-01' + (g % 200), 'ANALYZED', 'l75d-' || g FROM generate_series(1, 420) g`;
    const t = await tco(compte, v.id);
    expect(t.summary.cumulativeCostCents).toBe(30_000 + 42_000);
    as(compte);
    const p1 = await getTco(v.id);
    expect(p1.status).toBe(200);
    expect(p1.body.tco).toMatchObject({ linesTotal: 421, linesOffset: 0, linesCount: 400, linesTruncated: true, retainedLinesTotal: 421 });
    expect(p1.body.tco.summary.cumulativeCostCents).toBe(72_000);
    const p2 = await getTco(v.id, '?linesOffset=400');
    expect(p2.body.tco).toMatchObject({ linesOffset: 400, linesCount: 21 });
    const ids = new Set([...p1.body.tco.lines, ...p2.body.tco.lines].map((l: any) => l.id));
    expect(ids.size).toBe(421);
  });

  it('TCO-R-E10 — droits : Standard 403 sans montant ; Premium Duo membre : mêmes montants ; BO : lignes incertaines et montants inconnus visibles', async () => {
    const std = await make.account({ plan: 'standard' });
    const vs = await velo(std);
    as(std);
    const bloque = await getTco(vs.id, '?linesOffset=400');
    expect(bloque.status).toBe(403);
    expect(JSON.stringify(bloque.body)).not.toMatch(/30000|cumulative|lines/);
    const duo = await make.account({ plan: 'premium_duo' });
    const vd = await velo(duo, {});
    const acc = await facture(duo, vd, 'Remorque', 30_000, { typeHint: 'ACQUISITION', type: 'ACQUISITION_INVOICE', ref: 'D-1' });
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.id}, ${membre.id}, 'member', 'active')`.catch(() => undefined);
    as(duo, membre.id);
    const vu = await getTco(vd.id);
    expect(vu.status).toBe(200);
    // Sans date d'achat : même montant que la fiche → compté, incertain, statut incomplet.
    expect(vu.body.tco.summary.cumulativeCostCents).toBe(60_000);
    expect(vu.body.tco.status).toBe('INCOMPLETE');
    expect(vu.body.tco.lines.find((l: any) => l.fileId === acc)).toMatchObject({ uncertain: true });
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { GET } = await import('@/app/api/admin/operations/tco/route');
    const res = await GET(new NextRequest(`http://x/api/admin/operations/tco?accountId=${duo.id}&assetId=${vd.id}`));
    const body = await res.json() as Record<string, any>;
    expect(body.tco.lines.find((l: any) => l.fileId === acc)).toMatchObject({ uncertain: true });
    expect(body.labels.warning.UNCERTAIN_MATCHES).toMatch(/vérifier/);
    expect(await k.operations(duo)).toHaveLength(0);
    expect((await sql`SELECT id FROM to_process_actions WHERE account_id = ${duo.id}`)).toHaveLength(0);
  });

  it('TCO-R-E11 — annulation puis invalidation d’une opération, déplacement d’un justificatif : recalcul et réévaluation', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await velo(compte);
    const autre = await make.asset(compte, { category: 'OBJET', name: 'Trottinette', purchasePriceCents: 10_000, keyCharacteristics: { acquisitionDate: '2025-01-01' } });
    const f = await facture(compte, v, 'Réparation', 5_000, { ref: 'X-1' });
    await k.passer(compte);
    const [o] = await k.actives(compte);
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(35_000);
    await sql`UPDATE business_operations SET status = 'CANCELLED' WHERE id = ${o.id}`;
    expect(ligneDoc(await tco(compte, v.id), f)).toMatchObject({ reason: 'OPERATION_CANCELLED_SOURCE' });
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'E2E' WHERE id = ${o.id}`;
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(35_000);
    await sql`UPDATE asset_files SET asset_id = ${autre.id} WHERE id = ${f}`;
    await sql`UPDATE document_operation_candidates SET payload = jsonb_set(payload, '{targetHints}', ${JSON.stringify([cible(autre.id)])}::jsonb) WHERE file_id = ${f}`;
    expect((await tco(compte, v.id)).summary.cumulativeCostCents).toBe(30_000);
    expect((await tco(compte, autre.id)).summary.cumulativeCostCents).toBe(15_000);
  });
});
