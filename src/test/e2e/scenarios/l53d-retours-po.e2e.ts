/**
 * Lot 53D sur base réelle — retours PO D2, Q16, D9, D12 (12/10/2026).
 *
 * Candidats T1 persistés par le chemin de production (`replaceOperationCandidates`),
 * consolidation T3 réelle, carte « À traiter » réelle (`resolveArbitration`),
 * lecture T2 réelle (`sumQualifiedExpenses`, `readAcquisition`). Aucun appel IA.
 *
 *   · PO-D2-11 : montant de devise non établie (« XXX ») → hors total EUR,
 *     carte OPERATION-CURRENCY ; « en euros » → compté ; passage suivant stable ;
 *   · PO-D2-12 : repli documentaire — document dont la devise lue n'est pas
 *     l'euro jamais additionné ; montant saisi à la main (€) compté ;
 *   · PO-Q16-04 : contre-valeur EUR documentaire → `amount_eur_cents`, total EUR ;
 *   · PO-Q16-05 : capital emprunté → détail du financement, aucune dépense ;
 *   · PO-D9-04 : prix saisi ≠ facture, frais annexes → saisie comptée, écart et
 *     frais conservés hors total, réponse T2 ; second passage sans écriture ;
 *   · PO-D12-05 : portée d'un total incomplet (bien / autre bien / compte).
 */
import { afterEach, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref, RECETTE_TODAY } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

scenario('L53D', 'Retours PO D2 / Q16 / D9 / D12 : devises, contre-valeur, prêts, prix d’achat, portée du total', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  afterEach(async () => {
    (await import('@/services/business-operations/events')).resetBusinessOperationEventBusForTests();
  });
  const can = async () => ({ ...(await import('@/services/verebona-assistant/canonical/expenses')), ...(await import('@/services/verebona-assistant/canonical/operations')) });
  const cartes = (compte: AccountRow, rule: string) => sql<{ public_id: string; target_id: number; question: string; proposals_json: Array<{ value: string; label: string; isCurrentValue?: boolean }>; resolved_at: string | null; resolution_reason: string | null }[]>`
    SELECT public_id, target_id, question, proposals_json, resolved_at::text AS resolved_at, resolution_reason
      FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = ${rule} ORDER BY id`;
  const resoudre = async (compte: AccountRow, publicId: string, value: string) =>
    (await import('@/services/to-process/resolve-action.service')).resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });
  const horsTotal = (opId: number) => sql<{ nature: string; kind: string; amount_minor: number; currency: string; sources: number }[]>`
    SELECT nature, kind, amount_minor::int AS amount_minor, trim(currency) AS currency, cardinality(source_ids)::int AS sources
      FROM business_operation_side_amounts WHERE operation_id = ${opId} ORDER BY nature, amount_minor`;

  it('PO-D2-11 — devise non établie : montant conservé hors total EUR, question posée ; « en euros » → compté, stable', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const f = await k.document(compte, clio.id, [cand({
      targetHints: [cible(clio.id)], businessReferences: [ref('INVOICE', 'F-749')], temporalHints: { realizedDate: '2026-04-02' },
      financialHints: [fh('REALIZED_COST', 74900, { currency: 'XXX', currencyCandidates: ['EUR'], currencyBasis: 'PRESUMED' })],
    })], { type: 'MAINTENANCE_INVOICE', title: 'Facture vidange', date: '2026-04-02' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    expect((await k.composantes(op.id)).map((c) => [c.amount_minor, c.currency.trim()])).toEqual([[74900, 'XXX']]);
    const avant = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [clio.id] });
    expect(avant.qualifiedSumCents).toBe(0);
    expect(avant.complete).toBe(false);
    const [carte] = await cartes(compte, 'OPERATION-CURRENCY');
    expect(carte).toMatchObject({ target_id: f, resolved_at: null });
    expect(carte.proposals_json.map((p) => [p.value, !!p.isCurrentValue])).toEqual([['CURRENCY:EUR', false], ['UNKNOWN', true]]);
    expect(await resoudre(compte, carte.public_id, 'CURRENCY:EUR')).toMatchObject({ ok: true });
    expect((await k.composantes(op.id)).map((c) => [c.amount_minor, c.currency.trim()])).toEqual([[74900, 'EUR']]);
    expect((await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [clio.id] })).qualifiedSumCents).toBe(74900);
    // Stable : un passage suivant ne rouvre aucune question et ne double rien.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${f}`;
    await k.passer(compte);
    expect((await cartes(compte, 'OPERATION-CURRENCY')).filter((c) => c.resolved_at === null)).toEqual([]);
    expect(await k.coutNet(op.id)).toBe(74900);
  });

  it('PO-D2-12 — repli documentaire : devise lue autre que l’euro jamais additionnée ; montant saisi à la main compté', async () => {
    const compte = await make.account();
    const velo = await make.asset(compte, { category: 'OBJECT', name: 'Vélo' });
    const doc = async (cents: number, currency: string, edited = false) => {
      const fl = await make.assetFile(compte, { assetId: velo.id });
      await sql`UPDATE asset_files SET document_type_code = 'REPAIR_INVOICE', amount_cents = ${cents}, document_date = '2026-03-02',
                analysis_state = 'ANALYZED', user_edited_fields = ${edited ? '{"amountCents":true}' : '{}'}::jsonb WHERE id = ${fl.id}`;
      await sql`INSERT INTO document_extractions (account_id, file_id, currency) VALUES (${compte.id}, ${fl.id}, ${currency})`;
      return fl.id;
    };
    await doc(8000, 'EUR');
    await doc(45000, 'CHF');
    await doc(30000, 'XXX');
    await doc(1000, 'XXX', true);
    const q = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [velo.id] });
    expect(q.qualifiedSumCents).toBe(9000);
    expect(q.complete).toBe(false);
    expect(q.documents?.foreign?.map((x) => [x.amountMinor, x.currency]).sort()).toEqual([[30000, 'XXX'], [45000, 'CHF']]);
  });

  it('PO-Q16-04 / F-106 — contre-valeur EUR lue sur le document : devise d’origine conservée, total EUR alimenté', async () => {
    const compte = await make.account();
    const velo = await make.asset(compte, { category: 'OBJECT', name: 'Vélo' });
    await k.document(compte, velo.id, [cand({
      targetHints: [cible(velo.id)], businessReferences: [ref('INVOICE', 'CH-9')], temporalHints: { realizedDate: '2026-05-01' },
      financialHints: [fh('REALIZED_COST', 60000, { currency: 'CHF', amountEurMinor: 62500 }), fh('PAYMENT', 62500)],
    })], { type: 'REPAIR_INVOICE', title: 'Moteur (CHF, débit EUR)' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    expect((await k.composantes(op.id)).map((c) => [c.kind, c.amount_minor, c.currency.trim(), c.amount_eur_cents])).toEqual([['REALIZED_COST', 60000, 'CHF', 62500]]);
    const q = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [velo.id] });
    expect(q.qualifiedSumCents).toBe(62500);
    expect(q.operations?.foreign).toEqual([]);
  });

  it('PO-Q16-05 — capital emprunté : détail du financement, jamais une composante de dépense', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await k.document(compte, maison.id, [cand({
      typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Prêt travaux', provider: 'Banque Exemple', targetHints: [cible(maison.id)],
      businessReferences: [ref('LOAN', 'PR-1')], temporalHints: { startDate: '2026-02-15', endDate: '2031-02-15' },
      financialHints: [fh('LOAN_PRINCIPAL', 1500000)],
    })], { type: 'LEASING_FINANCING_CONTRACT', title: 'Offre de prêt' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    expect(await k.composantes(op.id)).toEqual([]);
    const [d] = await sql<{ principal_amount_minor: number; principal_currency: string }[]>`
      SELECT principal_amount_minor::int AS principal_amount_minor, trim(principal_currency) AS principal_currency
        FROM business_operation_financing_details WHERE operation_id = ${op.id}`;
    expect(d).toEqual({ principal_amount_minor: 1500000, principal_currency: 'EUR' });
    expect((await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [maison.id] })).qualifiedSumCents).toBe(0);
  });

  it('PO-D9-04 — prix saisi ≠ facture, frais annexes : saisie comptée, écart et frais conservés hors total et exposés ; second passage sans écriture', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', keyCharacteristics: { acquisitionPrice: 18490.5, acquisitionPrice__origin: 'USER', acquisitionDate: '2021-03-01', acquisitionDate__origin: 'USER' } });
    await k.document(compte, polo.id, [cand({
      typeHint: 'ACQUISITION', summary: 'Achat Polo', provider: 'Concession', targetHints: [cible(polo.id)], businessReferences: [ref('INVOICE', 'VO-1')],
      temporalHints: { realizedDate: '2021-03-02' },
      financialHints: [fh('REALIZED_COST', 1900000), fh('REALIZED_COST', 45000, { amountScope: 'FEE' })],
    })], { type: 'ACQUISITION_INVOICE', title: 'Facture concession' });
    await k.passer(compte);
    await (await import('@/services/business-operations/consolidation/asset-data-consolidator')).consolidateAssetData(compte.id, polo.id, { today: RECETTE_TODAY });
    const achats = (await k.actives(compte)).filter((o) => o.type_code === 'ACQUISITION');
    expect(achats).toHaveLength(1);
    const op = achats[0];
    expect(await k.coutNet(op.id)).toBe(1849050);
    expect((await horsTotal(op.id)).map((x) => [x.nature, x.amount_minor, x.currency])).toEqual([
      ['ANCILLARY_FEE', 45000, 'EUR'], ['DOCUMENT_AMOUNT_DIFFERS', 1900000, 'EUR'],
    ]);
    const acq = await (await can()).readAcquisition(compte.id, polo.id, { assetName: 'Polo' });
    expect(acq).toMatchObject({ priceCents: 1849050, documentPrices: [{ amountMinor: 1900000, title: 'Facture concession' }], fees: [{ amountMinor: 45000 }] });
    // Idempotence : un passage sans changement n'écrit ni historique ni montant hors total.
    const h = await k.historique(compte);
    const ids = await sql`SELECT id FROM business_operation_side_amounts WHERE operation_id = ${op.id} ORDER BY id`;
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE account_id = ${compte.id}`;
    await k.passer(compte);
    expect(await k.historique(compte)).toBe(h);
    expect(await sql`SELECT id FROM business_operation_side_amounts WHERE operation_id = ${op.id} ORDER BY id`).toEqual(ids);
  });

  it('PO-D12-05 — portée de l’incomplétude : bien (dépense sans bien liée au document), autre bien (non dégradé), compte (exposé)', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    // Document lié à la Polo, dépense attribuée par T3 à la Clio seulement.
    const f1 = await k.document(compte, polo.id, [cand({ summary: 'Pneus Clio', targetHints: [cible(clio.id)], businessReferences: [ref('INVOICE', 'P-1')], temporalHints: { realizedDate: '2026-03-02' }, financialHints: [fh('REALIZED_COST', 30000)] })], { type: 'REPAIR_INVOICE', title: 'Facture pneus', amountCents: 30000, date: '2026-03-02' });
    await k.passer(compte);
    const autre = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [polo.id] });
    expect(autre.documents?.countedForOtherAssets).toEqual({ count: 1, fileIds: [f1] });
    expect(autre.complete).toBe(true);
    // Dépense sans bien confirmé (aucun bien lié par T3) dont le document est lié à la Polo : incomplet pour la Polo, identifiée.
    const f2 = await k.document(compte, polo.id, [cand({ summary: 'Carrosserie', businessReferences: [ref('INVOICE', 'C-1')], temporalHints: { realizedDate: '2026-03-05' }, financialHints: [fh('REALIZED_COST', 40000)] })], { type: 'REPAIR_INVOICE', title: 'Facture carrosserie', amountCents: 40000, date: '2026-03-05' });
    await k.passer(compte);
    // Lien du bien retiré (bien non confirmé) : la dépense reste sans bien, son document reste lié à la Polo.
    const [opSansBien] = await sql<{ id: number }[]>`SELECT s.operation_id::int AS id FROM business_operation_sources s
      WHERE s.account_id = ${compte.id} AND s.source_entity_key = ${String(f2)} AND s.source_kind = 'DOCUMENT' AND s.active LIMIT 1`;
    await sql`UPDATE business_operation_asset_links SET active = false WHERE operation_id = ${opSansBien.id}`;
    const pourPolo = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [polo.id] });
    expect(pourPolo.complete).toBe(false);
    expect(pourPolo.documents?.unconfirmedAsset).toMatchObject({ count: 1, sumCents: 40000, items: [expect.objectContaining({ fileId: f2, amountCents: 40000 })] });
    // Dépense sans bien SANS lien avec la Polo : niveau compte, la Clio n'est pas dégradée.
    const pourClio = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [clio.id] });
    expect(pourClio.complete).toBe(true);
    expect(pourClio.qualifiedSumCents).toBe(30000);
    expect(pourClio.accountUnassigned).toMatchObject({ count: 1, sumCents: 40000 });
    const { mixedExpenseNotes } = await import('@/services/verebona-assistant/canonical/expenses');
    expect(mixedExpenseNotes(pourClio, { scopeLabel: 'la Clio' }).join(' ')).toContain('Au niveau du compte, 1 dépense sans bien identifié');
  });
});
