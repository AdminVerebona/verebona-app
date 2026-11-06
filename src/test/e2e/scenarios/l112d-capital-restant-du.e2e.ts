/**
 * Lot 112D — TCO / financement : capital restant dû ÉTABLI ou « non établi » — PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats, consolidation T3 réelle (Opération FINANCING +
 * `business_operation_financing_details`), faits et tableaux T1 en base (`document_facts`, `document_tables`),
 * service TCO (`readAssetTco`), routes HTTP (`GET /api/assets/[id]/tco`, `PUT /api/assets/[id]/tco/financing/[operationId]`),
 * réponse T2 (`ownershipCostAnswer`), export diagnostic (`loadTcoContext` + `tcoSummary` = `tracabilite/tco.json`).
 * Aucun appel IA.
 *
 *   L112D-E2E-01  conditions lues (taux, durée, 1re échéance, mensualité hors assurance, assurance) : calcul exact ;
 *                 capital jamais un coût (totaux identiques à ceux du même bien sans conditions)
 *   L112D-E2E-02  tableau d'amortissement avec colonne « Capital restant dû » : valeur LUE à la dernière échéance échue
 *   L112D-E2E-03  rien d'établi : « Capital restant dû non établi » + ce qui manque ; saisie USER (route) → calculé ;
 *                 la saisie prime sur un document contradictoire ; journal ; effacement → retour au « non établi »
 *   L112D-E2E-04  droits : Standard 403 (lecture et saisie), autre compte 404, membre Duo autorisé
 *   L112D-E2E-05  T2 et export diagnostic alignés sur la fiche
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
const AUJ = '2026-11-06';
const ACHAT = '2021-11-05';
const CAPITAL = 20_000_000;

scenario('L112D', 'TCO — capital restant dû d’un financement, établi ou non établi', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;
  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });
  const connecter = (c: AccountRow, userId = c.ownerUserId) => { session.currentAccountId = c.id; session.userId = userId; };
  const tco = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: AUJ });
  const fiche = async (compte: AccountRow, assetId: number) => {
    connecter(compte);
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const saisir = async (compte: AccountRow, assetId: number, opId: number, body: Json, userId?: number) => {
    connecter(compte, userId);
    const { PUT } = await import('@/app/api/assets/[id]/tco/financing/[operationId]/route');
    const res = await PUT(new NextRequest(`http://x/api/assets/${assetId}/tco/financing/${opId}`, { method: 'PUT', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: String(assetId), operationId: String(opId) }) });
    return { status: res.status, body: (await res.json()) as Json };
  };

  const maison = async (plan: 'premium' | 'standard' | 'premium_duo' = 'premium') => {
    const compte = await make.account({ plan });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: 40_000_000, keyCharacteristics: { acquisitionDate: ACHAT } });
    return { compte, bien };
  };
  /** Offre / tableau d'amortissement : capital (jamais un coût) + quelques échéances d'intérêts datées. */
  const pret = async (compte: AccountRow, bien: AssetRow, reference: string, titre = `Tableau d’amortissement ${reference}`) => {
    const fileId = await k.document(compte, bien.id, [cand({
      typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: `Prêt ${reference}`, provider: 'Banque', targetHints: [cible(bien.id)],
      businessReferences: [ref('LOAN', reference)], temporalHints: { startDate: ACHAT },
      financialHints: [fh('LOAN_PRINCIPAL', CAPITAL), fh('FORECAST_COST', 45_000, { amountScope: 'INSTALLMENT', economicDate: '2026-10-05' })],
    })], { type: 'LEASING_FINANCING_CONTRACT', title: titre, date: '2021-11-20' });
    return fileId;
  };
  const extraction = async (fileId: number) => (await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`)[0].id;
  const faits = async (compte: AccountRow, fileId: number, l: Array<[string, string, string?]>) => {
    const ex = await extraction(fileId);
    for (const [label, valeur, confiance] of l) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt)
                VALUES (${compte.id}, ${fileId}, ${ex}, ${'pret.' + label.slice(0, 20)}, ${label}, ${valeur}, ${confiance ?? 'certain'}, ${`${label} : ${valeur}`})`;
    }
  };
  const tableau = async (compte: AccountRow, fileId: number, entetes: string[], lignes: string[][]) => {
    const ex = await extraction(fileId);
    const [t] = await sql<{ id: number }[]>`
      INSERT INTO document_tables (account_id, file_id, extraction_id, table_index, column_count, row_count, columns)
      VALUES (${compte.id}, ${fileId}, ${ex}, 0, ${entetes.length}, ${lignes.length}, ${JSON.stringify(entetes.map((header) => ({ header, path: [] })))}::jsonb) RETURNING id::int AS id`;
    for (const [r, l] of lignes.entries()) {
      for (const [c, v] of l.entries()) {
        await sql`INSERT INTO document_table_cells (table_id, account_id, file_id, row_index, column_index, column_header, value_text, is_empty)
                  VALUES (${t.id}, ${compte.id}, ${fileId}, ${r}, ${c}, ${entetes[c]}, ${v}, false)`;
      }
    }
  };
  const pretConsolide = async (compte: AccountRow) => {
    await k.passer(compte, { today: AUJ });
    const fin = (await k.actives(compte)).filter((o) => o.type_code === 'FINANCING');
    expect(fin).toHaveLength(1);
    return fin[0].id;
  };
  const CONDITIONS: Array<[string, string]> = [
    ['Taux nominal annuel fixe', '3,00 %'], ['Durée du prêt', '240 mois'], ['Date de la première échéance', '05/12/2021'],
    ['Mensualité hors assurance', '1 109,20 €'], ['Cotisation assurance mensuelle', '50,00 €'],
  ];

  it('L112D-E2E-01 — conditions lues : capital restant dû calculé exactement, assurance distincte ; aucun total TCO modifié', async () => {
    const témoin = await maison();
    await pret(témoin.compte, témoin.bien, 'PRET-T');
    await pretConsolide(témoin.compte);
    const sans = await tco(témoin.compte, témoin.bien.id);
    expect(sans.indicators.financing.outstanding).toMatchObject({ status: 'NOT_ESTABLISHED', cents: null });

    const { compte, bien } = await maison();
    const fileId = await pret(compte, bien, 'PRET-1');
    await faits(compte, fileId, CONDITIONS);
    await pretConsolide(compte);
    const t = await tco(compte, bien.id);
    const { computeAmortization } = await import('@/services/business-operations/tco/loan-amortization');
    const attendu = computeAmortization({ principalCents: CAPITAL, ratePct: '3', periodicity: 'MONTHLY', durationMonths: 240, firstInstallmentDate: '2021-12-05', installmentCents: 110_920, deferral: null }, [], AUJ);
    expect(attendu.ok).toBe(true);
    const o = t.indicators.financing.loans[0].outstanding!;
    expect(o).toMatchObject({ status: 'ESTABLISHED', method: 'COMPUTED', asOf: '2026-11-05', installment: { cents: 110_920, source: 'READ', insuranceCents: 5_000 } });
    expect(o.cents).toBe((attendu as { cents: number }).cents);
    // Référence flottante indépendante (formule fermée, 60 échéances) : ≈ 160 612 €, à 2 € près (échéance lue arrondie au centime).
    const i = 0.03 / 12;
    const ref = (CAPITAL * (Math.pow(1 + i, 240) - Math.pow(1 + i, 60))) / (Math.pow(1 + i, 240) - 1);
    expect(Math.abs(o.cents! - ref)).toBeLessThan(200);
    expect(t.indicators.financing.outstanding).toMatchObject({ status: 'ESTABLISHED', cents: o.cents });
    // Jamais un coût : mêmes totaux que le témoin sans conditions, aucune ligne au montant du capital restant dû.
    expect(t.summary.cumulativeCostCents).toBe(sans.summary.cumulativeCostCents);
    expect(t.indicators.financing.costToDateCents).toBe(sans.indicators.financing.costToDateCents);
    expect(t.indicators.total.cents).toBe(sans.indicators.total.cents);
    expect(t.lines.some((l) => l.eurCents === o.cents)).toBe(false);
    // Fiche (route) : transmis tel quel.
    const r = await fiche(compte, bien.id);
    expect(r.status).toBe(200);
    expect(r.body.tco.indicators.financing.loans[0].outstanding.status).toBe('ESTABLISHED');
  });

  it('L112D-E2E-02 — tableau d’amortissement (colonne « Capital restant dû ») : valeur LUE à la dernière échéance échue, avec sa source', async () => {
    const { compte, bien } = await maison();
    const fileId = await pret(compte, bien, 'PRET-2', 'Tableau d’amortissement PRET-2');
    await tableau(compte, fileId, ['Date d’échéance', 'Échéance', 'Capital restant dû'], [
      ['05/09/2026', '1 109,20', '165 942,10'], ['05/10/2026', '1 109,20', '165 247,75'], ['05/11/2026', '1 109,20', '164 551,66'], ['05/12/2026', '1 109,20', '163 853,83'],
    ]);
    await pretConsolide(compte);
    const o = (await tco(compte, bien.id)).indicators.financing.loans[0].outstanding!;
    expect(o).toMatchObject({ status: 'ESTABLISHED', method: 'DOCUMENT', cents: 16_455_166, asOf: '2026-11-05', sourceFileId: fileId });
    expect(o.label).toBe('Lu sur « Tableau d’amortissement PRET-2 » au 05/11/2026.');
  });

  it('L112D-E2E-03 — non établi + ce qui manque ; saisie USER → calculé ; la saisie prime ; journal ; effacement', async () => {
    const { compte, bien } = await maison();
    const fileId = await pret(compte, bien, 'PRET-3');
    await faits(compte, fileId, [['Taux nominal', '3,40 %'], ['Taux nominal annuel fixe', '3,00 %', 'probable']]);
    const opId = await pretConsolide(compte);
    const avant = (await tco(compte, bien.id)).indicators.financing.loans[0].outstanding!;
    expect(avant).toMatchObject({ status: 'NOT_ESTABLISHED', cents: null });
    expect(avant.missing).toEqual(['la périodicité des échéances', 'la durée du prêt', 'la date de la première échéance']);
    expect(avant.label).toMatch(/^Capital restant dû non établi : il manque la périodicité des échéances, la durée du prêt et la date de la première échéance\./);

    const s = await saisir(compte, bien.id, opId, { terms: { ratePct: '3', periodicity: 'MONTHLY', durationMonths: 240, firstInstallmentDate: '2021-12-05', deferral: { months: 0, kind: 'NONE' } } });
    expect(s.status).toBe(200);
    expect(s.body.changed).toEqual(['ratePct', 'periodicity', 'durationMonths', 'firstInstallmentDate', 'deferral']);
    const apres = (await tco(compte, bien.id)).indicators.financing.loans[0].outstanding!;
    expect(apres).toMatchObject({ status: 'ESTABLISHED', method: 'COMPUTED', installment: { source: 'THEORETICAL', cents: 110_920 } });
    expect(apres.terms.ratePct).toEqual({ value: '3', origin: 'USER' }); // le document dit 3,40 % : la saisie prime
    const [h] = await sql<{ reason_code: string; actor_user_id: number; after_json: Json }[]>`
      SELECT reason_code, actor_user_id, after_json FROM business_operation_history WHERE operation_id = ${opId} AND reason_code = 'LOAN_TERMS_USER'`;
    expect(h).toMatchObject({ reason_code: 'LOAN_TERMS_USER', actor_user_id: compte.ownerUserId });
    expect(h.after_json.ratePct).toBe('3');
    const [d] = await sql<{ o: Json }[]>`SELECT loan_terms_origin AS o FROM business_operation_financing_details WHERE operation_id = ${opId}`;
    expect(d.o.ratePct).toMatchObject({ origin: 'USER', userId: compte.ownerUserId });
    // Re-consolidation : la saisie n'est jamais écrasée.
    await k.passer(compte, { today: AUJ });
    expect((await tco(compte, bien.id)).indicators.financing.loans[0].outstanding!.terms.ratePct).toEqual({ value: '3', origin: 'USER' });
    // Rejeu identique : rien ne change.
    expect((await saisir(compte, bien.id, opId, { terms: { ratePct: '3,00' } })).body.changed).toEqual([]);
    // Remboursement anticipé saisi sans mode : calcul arrêté, motif explicite (jamais d'estimation).
    const ra = await saisir(compte, bien.id, opId, { events: [{ kind: 'EARLY_REPAYMENT', date: '2025-06-15', amountCents: 2_000_000 }] });
    expect(ra.status).toBe(200);
    const ko = (await tco(compte, bien.id)).indicators.financing.loans[0].outstanding!;
    expect(ko).toMatchObject({ status: 'NOT_ESTABLISHED', computeIssue: 'EARLY_REPAYMENT_MODE_UNKNOWN' });
    // Avec durée réduite : de nouveau établi, plus bas.
    await saisir(compte, bien.id, opId, { events: [{ kind: 'EARLY_REPAYMENT', date: '2025-06-15', amountCents: 2_000_000, mode: 'REDUCED_DURATION' }] });
    const reduit = (await tco(compte, bien.id)).indicators.financing.loans[0].outstanding!;
    expect(reduit.status).toBe('ESTABLISHED');
    expect(reduit.cents!).toBeLessThan(apres.cents! - 1_900_000);
    // Effacement : retour aux seules lectures documentaires.
    await saisir(compte, bien.id, opId, { terms: { ratePct: null, periodicity: null, durationMonths: null, firstInstallmentDate: null, deferral: null }, events: [] });
    expect((await tco(compte, bien.id)).indicators.financing.loans[0].outstanding!.status).toBe('NOT_ESTABLISHED');
    // Validation.
    expect((await saisir(compte, bien.id, opId, { terms: { ratePct: '150' } })).status).toBe(422);
  });

  it('L112D-E2E-04 — droits : Standard 403, autre compte 404, membre Duo autorisé', async () => {
    const std = await maison('standard');
    await pret(std.compte, std.bien, 'PRET-S');
    const opStd = await pretConsolide(std.compte);
    expect((await fiche(std.compte, std.bien.id)).status).toBe(403);
    const ps = await saisir(std.compte, std.bien.id, opStd, { terms: { ratePct: '3' } });
    expect(ps.status).toBe(403);
    expect(JSON.stringify(ps.body)).not.toMatch(/outstanding|Capital/);

    const a = await maison();
    await pret(a.compte, a.bien, 'PRET-A');
    const opA = await pretConsolide(a.compte);
    const b = await maison();
    expect((await saisir(b.compte, a.bien.id, opA, { terms: { ratePct: '3' } })).status).toBe(404);
    expect((await saisir(b.compte, b.bien.id, opA, { terms: { ratePct: '3' } })).status).toBe(404);

    const duo = await maison('premium_duo');
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.compte.id}, ${membre.id}, 'member', 'active')`;
    await pret(duo.compte, duo.bien, 'PRET-D');
    const opD = await pretConsolide(duo.compte);
    const r = await saisir(duo.compte, duo.bien.id, opD, { terms: { ratePct: '3' } }, membre.id);
    expect(r.status).toBe(200);
    const [d] = await sql<{ o: Json }[]>`SELECT loan_terms_origin AS o FROM business_operation_financing_details WHERE operation_id = ${opD}`;
    expect(d.o.ratePct).toMatchObject({ origin: 'USER', userId: membre.id });
  });

  it('L112D-E2E-05 — T2 et export diagnostic alignés sur la fiche', async () => {
    const { compte, bien } = await maison();
    const fileId = await pret(compte, bien, 'PRET-5');
    await faits(compte, fileId, CONDITIONS);
    await pretConsolide(compte);
    const t = await tco(compte, bien.id);
    const o = t.indicators.financing.loans[0].outstanding!;
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const a = ownershipCostAnswer({ id: bien.id, name: 'Maison' } as never, t) as { answer: string };
    const { formatEur } = await import('@/services/verebona-assistant/canonical/operations');
    expect(a.answer).toMatch(/Capital restant dû au 05\/11\/2026 : /);
    expect(a.answer).toMatch(/ce n’est pas un coût/);
    expect(a.answer).toContain(formatEur(o.cents!));
    const { loadTcoContext, tcoSummary } = await import('@/services/admin/diagnostics-export/trace');
    const ctx = await loadTcoContext(compte.id, bien.id, AUJ);
    const resume = tcoSummary(ctx) as Json;
    expect(resume.indicators.financing.loans[0].outstanding).toMatchObject({ status: 'ESTABLISHED', cents: o.cents, method: 'COMPUTED' });
    expect(resume.indicators.financing.loans[0].outstanding.terms.ratePct).toEqual({ value: '3', origin: 'DOCUMENT' });
  });
});
