/**
 * Lot 112H — formulaire « Conditions du prêt » (fiche du bien › Coût total de possession › Financement) — PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : consolidation T3 réelle (Opération FINANCING), faits T1 en base, routes HTTP
 * (`GET /api/assets/[id]/tco`, `PUT /api/assets/[id]/tco/financing/[operationId]` — route 112D, seule route utilisée),
 * corps construits par le MODÈLE du formulaire (`buildLoanTermsPatch`, textes saisis au format français) à partir de
 * l'état par condition transmis à la fiche (`outstanding.fields`). Aucun appel IA.
 *
 *   L112H-E2E-01  saisie : état par condition (document + source / non renseigné) → saisie au format français →
 *                 capital restant dû recalculé dans la réponse (« non établi : il manque … » → établi)
 *   L112H-E2E-02  erreur de validation : refusée par le formulaire ; envoyée quand même → 422, message rattaché au
 *                 champ, rien n'est écrit
 *   L112H-E2E-03  droit : Standard refusé (lecture 403 verrouillée, saisie 403), rien n'est écrit
 *   L112H-E2E-04  recalcul et réversibilité : la saisie prime sur le document (valeur du document conservée et
 *                 affichable) ; « Revenir à la valeur du document » → origine document, capital recalculé
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
/** Les routes calculent à la date du jour (Europe/Paris). */
const aujourdhui = () => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

scenario('L112H', 'TCO — formulaire de saisie des conditions d’un prêt', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;
  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });
  const connecter = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const fiche = async (compte: AccountRow, assetId: number) => {
    connecter(compte);
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const enregistrer = async (compte: AccountRow, assetId: number, opId: number, body: unknown) => {
    connecter(compte);
    const { PUT } = await import('@/app/api/assets/[id]/tco/financing/[operationId]/route');
    const res = await PUT(new NextRequest(`http://x/api/assets/${assetId}/tco/financing/${opId}`, { method: 'PUT', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: String(assetId), operationId: String(opId) }) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const modele = () => import('@/components/assets/tco-loan-terms-model');

  const maison = async (plan: 'premium' | 'standard' = 'premium') => {
    const compte = await make.account({ plan });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: 40_000_000, keyCharacteristics: { acquisitionDate: ACHAT } });
    return { compte, bien };
  };
  const pret = async (compte: AccountRow, bien: AssetRow, reference: string) => k.document(compte, bien.id, [cand({
    typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: `Prêt ${reference}`, provider: 'Banque', targetHints: [cible(bien.id)],
    businessReferences: [ref('LOAN', reference)], temporalHints: { startDate: ACHAT },
    financialHints: [fh('LOAN_PRINCIPAL', CAPITAL), fh('FORECAST_COST', 45_000, { amountScope: 'INSTALLMENT', economicDate: '2026-10-05' })],
  })], { type: 'LEASING_FINANCING_CONTRACT', title: `Offre de prêt ${reference}`, date: '2021-10-20' });
  const faits = async (compte: AccountRow, fileId: number, l: Array<[string, string]>) => {
    const [ex] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    for (const [label, valeur] of l) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt)
                VALUES (${compte.id}, ${fileId}, ${ex.id}, ${'pret.' + label.slice(0, 20)}, ${label}, ${valeur}, 'certain', ${`${label} : ${valeur}`})`;
    }
  };
  const pretConsolide = async (compte: AccountRow) => {
    await k.passer(compte, { today: AUJ });
    const fin = (await k.actives(compte)).filter((o) => o.type_code === 'FINANCING');
    expect(fin).toHaveLength(1);
    return fin[0].id;
  };
  const pretDe = (body: Json) => body.tco.indicators.financing.loans[0] as Json;
  const saisies = async (opId: number) =>
    (await sql<{ o: Json | null; r: string | null }[]>`SELECT loan_terms_origin AS o, loan_nominal_rate_pct::text AS r FROM business_operation_financing_details WHERE operation_id = ${opId}`)[0];

  it('L112H-E2E-01 — saisie au format français : capital restant dû recalculé dans la réponse (non établi → établi)', async () => {
    const { compte, bien } = await maison();
    const fileId = await pret(compte, bien, 'PRET-H1');
    const opId = await pretConsolide(compte);
    const g = await fiche(compte, bien.id);
    expect(g.status).toBe(200);
    expect(g.body.canEdit).toBe(true);
    const loan = pretDe(g.body);
    expect(loan.operationId).toBe(opId);
    expect(loan.outstanding.status).toBe('NOT_ESTABLISHED');
    const champs = loan.outstanding.fields;
    // Montant emprunté : lu, avec sa source ; conditions manquantes : non renseignées.
    expect(champs.principalCents).toMatchObject({ value: CAPITAL, origin: 'DOCUMENT', document: { sources: [{ fileId, title: 'Offre de prêt PRET-H1' }] } });
    expect(champs.ratePct).toMatchObject({ value: null, origin: null, document: null });
    const m = await modele();
    expect(m.loanFieldOrigin('principalCents', champs.principalCents, null).text).toBe('Lu sur « Offre de prêt PRET-H1 ».');

    // Saisie partielle : toujours « non établi », ce qui manque est recalculé.
    const p1 = m.buildLoanTermsPatch(champs, { ratePct: '3,00', periodicity: 'MONTHLY' });
    expect(p1).toMatchObject({ ok: true, body: { terms: { ratePct: '3', periodicity: 'MONTHLY' } } });
    const r1 = await enregistrer(compte, bien.id, opId, (p1 as { body: unknown }).body);
    expect(r1.status).toBe(200);
    expect(pretDe(r1.body).outstanding).toMatchObject({ status: 'NOT_ESTABLISHED', missing: ['la durée du prêt', 'la date de la première échéance'] });
    expect(pretDe(r1.body).outstanding.label).toMatch(/il manque la durée du prêt et la date de la première échéance/);
    expect(m.outstandingSummary(pretDe(r1.body).outstanding)).toMatchObject({ established: false, title: 'Capital restant dû : non établi' });

    // Fin de saisie (durée en ÉCHÉANCES, montants « 1 109,20 ») : établi, calcul exact.
    const champs2 = pretDe(r1.body).outstanding.fields;
    expect(m.loanFieldOrigin('ratePct', champs2.ratePct, 'MONTHLY').kind).toBe('USER');
    const p2 = m.buildLoanTermsPatch(champs2, { durationMonths: '240', firstInstallmentDate: '2021-12-05', installmentCents: '1 109,20', insuranceCents: '50,00', deferralKind: 'NONE' });
    expect(p2).toMatchObject({ ok: true, body: { terms: { durationMonths: 240, firstInstallmentDate: '2021-12-05', installmentCents: 110_920, insuranceCents: 5_000, deferral: { months: 0, kind: 'NONE' } } } });
    const r2 = await enregistrer(compte, bien.id, opId, (p2 as { body: unknown }).body);
    expect(r2.status).toBe(200);
    const o = pretDe(r2.body).outstanding;
    const { computeAmortization } = await import('@/services/business-operations/tco/loan-amortization');
    const attendu = computeAmortization({ principalCents: CAPITAL, ratePct: '3', periodicity: 'MONTHLY', durationMonths: 240, firstInstallmentDate: '2021-12-05', installmentCents: 110_920, deferral: null }, [], aujourdhui());
    expect(attendu.ok).toBe(true);
    expect(o).toMatchObject({ status: 'ESTABLISHED', method: 'COMPUTED', cents: (attendu as { cents: number }).cents, installment: { cents: 110_920, insuranceCents: 5_000 } });
    expect(m.outstandingSummary(o)!.established).toBe(true);
    // La fiche relue montre la même valeur (aucun écart entre la réponse et la lecture suivante).
    expect(pretDe((await fiche(compte, bien.id)).body).outstanding.cents).toBe(o.cents);
    // Formulaire rouvert : plus rien à enregistrer.
    expect(m.buildLoanTermsPatch(o.fields, {})).toMatchObject({ ok: true, changed: [] });
  });

  it('L112H-E2E-02 — erreur de validation : refusée par le formulaire, 422 de la route rattachée au champ, rien n’est écrit', async () => {
    const { compte, bien } = await maison();
    await pret(compte, bien, 'PRET-H2');
    const opId = await pretConsolide(compte);
    const champs = pretDe((await fiche(compte, bien.id)).body).outstanding.fields;
    const m = await modele();
    const p = m.buildLoanTermsPatch(champs, { ratePct: '150', durationMonths: '240' });
    expect(p).toMatchObject({ ok: false, errors: { ratePct: expect.stringContaining('Taux nominal invalide'), durationMonths: 'Choisissez d’abord la périodicité des échéances.' } });
    // Envoyé malgré tout (client contourné) : la route reste l'autorité.
    const r = await enregistrer(compte, bien.id, opId, { terms: { ratePct: '150' } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('VALIDATION');
    expect(m.fieldOfServerMessage(r.body.message)).toBe('ratePct');
    const r2 = await enregistrer(compte, bien.id, opId, { terms: { firstInstallmentDate: '2021-02-30' } });
    expect(r2.status).toBe(422);
    expect(m.fieldOfServerMessage(r2.body.message)).toBe('firstInstallmentDate');
    expect(await saisies(opId)).toMatchObject({ r: null });
    expect(Object.keys((await saisies(opId))?.o ?? {})).toEqual([]);
    expect((await sql`SELECT 1 FROM business_operation_history WHERE operation_id = ${opId} AND reason_code = 'LOAN_TERMS_USER'`).length).toBe(0);
  });

  it('L112H-E2E-03 — Standard : section verrouillée (403 sans montant), saisie refusée, rien n’est écrit', async () => {
    const { compte, bien } = await maison('standard');
    await pret(compte, bien, 'PRET-H3');
    const opId = await pretConsolide(compte);
    const g = await fiche(compte, bien.id);
    expect(g.status).toBe(403);
    expect(g.body).toMatchObject({ code: 'PREMIUM_REQUIRED', locked: true });
    expect(JSON.stringify(g.body)).not.toMatch(/fields|outstanding|Capital/);
    const r = await enregistrer(compte, bien.id, opId, { terms: { ratePct: '3' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'PREMIUM_REQUIRED', locked: true });
    expect(JSON.stringify(r.body)).not.toMatch(/fields|outstanding|Capital/);
    expect(await saisies(opId)).toMatchObject({ r: null });
  });

  it('L112H-E2E-04 — la saisie prime, la valeur du document reste visible ; « Revenir à la valeur du document » recalcule', async () => {
    const { compte, bien } = await maison();
    const fileId = await pret(compte, bien, 'PRET-H4');
    await faits(compte, fileId, [
      ['Taux nominal annuel fixe', '3,00 %'], ['Durée du prêt', '240 mois'], ['Date de la première échéance', '05/12/2021'], ['Périodicité des échéances', 'mensuelle'],
    ]);
    const opId = await pretConsolide(compte);
    const avant = pretDe((await fiche(compte, bien.id)).body).outstanding;
    expect(avant).toMatchObject({ status: 'ESTABLISHED', method: 'COMPUTED' });
    expect(avant.fields.ratePct).toMatchObject({ value: '3', origin: 'DOCUMENT', document: { value: '3', sources: [{ fileId, title: 'Offre de prêt PRET-H4' }] } });
    const m = await modele();
    const p = m.buildLoanTermsPatch(avant.fields, { ratePct: '2,50' });
    expect(p).toMatchObject({ ok: true, body: { terms: { ratePct: '2.5' } }, changed: ['ratePct'] });
    const r = await enregistrer(compte, bien.id, opId, (p as { body: unknown }).body);
    expect(r.status).toBe(200);
    const saisi = pretDe(r.body).outstanding;
    expect(saisi).toMatchObject({ status: 'ESTABLISHED', method: 'COMPUTED' });
    expect(saisi.cents).toBeLessThan(avant.cents); // taux plus bas → capital restant dû plus bas
    expect(saisi.fields.ratePct).toMatchObject({ value: '2.5', origin: 'USER', document: { value: '3' } });
    expect(saisi.fields.ratePct.enteredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const origine = m.loanFieldOrigin('ratePct', saisi.fields.ratePct, 'MONTHLY');
    expect(origine).toMatchObject({ kind: 'USER', canRevertToDocument: true });
    expect(origine.documentText).toBe('Valeur du document : 3 % (lu sur « Offre de prêt PRET-H4 »).');
    // Re-consolidation : la saisie n'est pas écrasée.
    await k.passer(compte, { today: AUJ });
    expect(pretDe((await fiche(compte, bien.id)).body).outstanding.fields.ratePct.origin).toBe('USER');
    // « Revenir à la valeur du document » : corps envoyé par la feuille.
    const back = await enregistrer(compte, bien.id, opId, { terms: { ratePct: null } });
    expect(back.status).toBe(200);
    expect(back.body.changed).toEqual(['ratePct']);
    const apres = pretDe(back.body).outstanding;
    expect(apres.fields.ratePct).toMatchObject({ value: '3', origin: 'DOCUMENT', enteredAt: null });
    expect(apres.cents).toBe(pretDe((await fiche(compte, bien.id)).body).outstanding.cents);
    expect(apres.cents).toBeGreaterThan(saisi.cents);
    expect(m.loanFieldOrigin('ratePct', apres.fields.ratePct, 'MONTHLY')).toMatchObject({ kind: 'DOCUMENT', canRevertToDocument: false });
    const hist = await sql<{ after_json: Json }[]>`SELECT after_json FROM business_operation_history WHERE operation_id = ${opId} AND reason_code = 'LOAN_TERMS_USER' ORDER BY id`;
    expect(hist.map((x) => x.after_json.ratePct)).toEqual(['2.5', null]);
  });
});
