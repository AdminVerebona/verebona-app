/**
 * Lot 80A — tiroir TCO : « Ajouter au TCO » / « Retirer du TCO » sur
 * PostgreSQL 16 réel (migration 0623 réelle).
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats, consolidation
 * T3 réelle (`consolidateAccountOperations`), service TCO réel, route HTTP
 * réelle de la décision et de la fiche, T2 réel (`sumQualifiedExpenses`),
 * diagnostic BO réel (77C, `tracabilite/montants.json`). Seules les sessions
 * sont simulées. Aucun appel IA. Assertions limitées aux comptes créés ici.
 *
 *   L80A-E01 Retirer puis annuler (route) : totaux à jour, ligne persistée par
 *            compte et par bien, journal (qui, quand, geste) ;
 *   L80A-E02 Ajouter un achat non incorporé : survit aux reconsolidations T3 ;
 *            T2 (périmètre du bien) = TCO ; compte entier inchangé ;
 *   L80A-E03 doublon présumé : refus sans confirmation (message explicite),
 *            accepté avec confirmation et journalisé avec l'avertissement ;
 *   L80A-E04 droits : Standard 403 sans écriture, autre compte 404, membre
 *            Premium Duo autorisé ; données conservées au changement d'offre ;
 *   L80A-E05 diagnostic BO : la décision figure à l'étape CALCUL ;
 *   L80A-E06 migration 0623 rejouable sans effet.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, role: 'USER', email: '' }));
type Json = Record<string, any>;

scenario('L80A', 'TCO — décisions utilisateur « Ajouter / Retirer du TCO »', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role, email: session.email }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const as = (compte: AccountRow, userId = compte.ownerUserId) => { session.currentAccountId = compte.id; session.userId = userId; session.role = 'USER'; };
  const getTco = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  };
  const decide = async (assetId: number, body: Json) => {
    const { POST } = await import('@/app/api/assets/[id]/tco/decisions/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${assetId}/tco/decisions`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  };
  const coherent = (tco: Json) => {
    const a = tco.annual;
    expect(a.years.reduce((n: number, y: Json) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents + a.future.costsCents - a.future.creditsCents)
      .toBe(tco.summary.cumulativeCostCents);
    expect(a.average.totalCents).toBe(tco.summary.cumulativeCostCents);
  };

  const PRIX = 49_000_000;
  const CHAISES = 27_735;
  const TAXE = 123_400;
  const INTERNET = 2_999;

  /** Maison (prix fiche + acte preuve T1), attestation de même prix, commande de chaises, taxe foncière, facture internet. */
  async function jeu(compte: AccountRow) {
    const maison: AssetRow = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: PRIX, keyCharacteristics: { acquisitionDate: '2007-05-14' } });
    const vente = (summary: string, date: string) => [cand({
      typeHint: 'ACQUISITION', summary, provider: 'Étude notariale', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      temporalHints: { realizedDate: '2007-05-14' }, financialHints: [fh('REALIZED_COST', PRIX, { economicDate: date })],
    })];
    const acte = await k.document(compte, maison.id, vente('Vente de la maison', '2007-05-14'), { type: 'PROPERTY_TITLE', title: 'Acte de vente', amountCents: PRIX, date: '2007-05-14' });
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt)
              VALUES (${compte.id}, ${maison.id}, 'acquisitionPrice', ${String(PRIX / 100)}::jsonb, 'document', ${acte}, 'certain', ${`e2e-l80a-${acte}`}, 'Prix')`;
    const attestation = await k.document(compte, maison.id, vente('Attestation de propriété', '2021-02-01'), { type: 'PROPERTY_TITLE', title: 'Attestation de propriété', amountCents: PRIX, date: '2021-02-01' });
    const commande = await k.document(compte, maison.id, [cand({
      typeHint: 'ACQUISITION', summary: 'Quatre chaises de jardin', provider: 'Vendeur de mobilier', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      businessReferences: [ref('ORDER', 'CMD-80A'), ref('INVOICE', 'FA-80A')], temporalHints: { realizedDate: '2021-06-03' },
      financialHints: [fh('REALIZED_COST', CHAISES, { economicDate: '2021-06-03' })],
    })], { type: 'ACQUISITION_INVOICE', title: 'Commande de chaises de jardin', amountCents: CHAISES, date: '2021-06-03' });
    const taxe = await k.document(compte, maison.id, [cand({
      typeHint: 'OTHER', summary: 'Taxe foncière 2025', provider: 'Finances publiques', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      businessReferences: [ref('OTHER', 'AVIS-2025')], temporalHints: { realizedDate: '2025-10-15' },
      financialHints: [fh('REALIZED_COST', TAXE, { economicDate: '2025-10-15', periodStart: '2025-01-01', periodEnd: '2025-12-31' })],
    })], { type: 'PROPERTY_TAX_NOTICE', title: 'Taxe foncière 2025', amountCents: TAXE, date: '2025-10-15' });
    const internet = await k.document(compte, maison.id, [cand({
      typeHint: 'CONTRACT', summary: 'Facture internet', provider: 'Opérateur', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      businessReferences: [ref('INVOICE', 'FI-2026-10')], temporalHints: { realizedDate: '2026-10-09' },
      financialHints: [fh('REALIZED_COST', INTERNET, { economicDate: '2026-10-09' })],
    })], { type: 'TELECOM_INVOICE', title: 'Facture internet octobre', amountCents: INTERNET, date: '2026-10-09' });
    return { maison, acte, attestation, commande, taxe, internet };
  }
  const ligneDe = (tco: Json, pred: (l: Json) => boolean) => (tco.lines as Json[]).find(pred);

  it('L80A-E01 — Retirer puis annuler par la route : totaux immédiats, décision persistée (compte, bien, clé stable), journal qui / quand', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    as(compte);
    const avant = await getTco(j.maison.id);
    expect(avant.status).toBe(200);
    const total = avant.body.tco.summary.cumulativeCostCents;
    const internet = ligneDe(avant.body.tco, (l) => l.amountMinor === INTERNET && l.includedCents > 0)!;
    expect(internet.actions).toMatchObject({ removable: true });
    expect(internet.decisionKey).toBe(`f:${j.internet}:REALIZED_COST:${INTERNET}:EUR`);

    const r = await decide(j.maison.id, { lineId: internet.id, lineKey: internet.decisionKey, action: 'EXCLUDE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toBe('SET');
    // Réponse = TCO recalculé : total, dépenses de l'année et moyenne à jour sans second appel.
    expect(r.body.tco.summary.cumulativeCostCents).toBe(total - INTERNET);
    const an = (t: Json, y: number) => (t.annual.years as Json[]).find((x) => x.year === y)!;
    expect(an(r.body.tco, 2026).costsCents).toBe(an(avant.body.tco, 2026).costsCents - INTERNET);
    coherent(r.body.tco);
    const retiree = ligneDe(r.body.tco, (l) => l.decisionKey === internet.decisionKey)!;
    expect(retiree).toMatchObject({ status: 'EXCLUDED', reason: 'USER_EXCLUDED', includedCents: 0, actions: { addable: true, duplicateWarning: null } });
    expect(r.body.tco.lineReasonLabels.USER_EXCLUDED).toBe('Retirée du coût de possession par vous');
    const [row] = await sql`SELECT account_id, asset_id, line_key, decision, decided_by, file_id FROM asset_cost_line_decisions WHERE asset_id = ${j.maison.id}`;
    expect(row).toMatchObject({ account_id: compte.id, asset_id: j.maison.id, line_key: internet.decisionKey, decision: 'EXCLUDE', decided_by: compte.ownerUserId, file_id: j.internet });
    // Lecture suivante (GET) : même résultat.
    expect((await getTco(j.maison.id)).body.tco.summary.cumulativeCostCents).toBe(total - INTERNET);

    // Annulation : « Ajouter au TCO » sur la ligne retirée → retour au traitement automatique (décision supprimée, journalisée).
    const back = await decide(j.maison.id, { lineId: retiree.id, action: 'INCLUDE' });
    expect(back.status).toBe(200);
    expect(back.body.outcome).toBe('REVERTED');
    expect(back.body.tco.summary.cumulativeCostCents).toBe(total);
    expect(await sql`SELECT 1 FROM asset_cost_line_decisions WHERE asset_id = ${j.maison.id}`).toHaveLength(0);
    const journal = await sql`SELECT action, previous_decision, user_id, line_key, automatic_status, created_at FROM asset_cost_line_decision_events WHERE asset_id = ${j.maison.id} ORDER BY id`;
    expect(journal.map((e) => [e.action, e.previous_decision, e.user_id])).toEqual([['EXCLUDE', null, compte.ownerUserId], ['REVERT', 'EXCLUDE', compte.ownerUserId]]);
    expect(journal[0].automatic_status).toBe(internet.status);
    expect(journal.every((e) => !Number.isNaN(new Date(e.created_at as string).getTime()))).toBe(true);
    // Geste sans objet (déjà retenue) : inchangé, rien écrit.
    expect((await decide(j.maison.id, { lineId: retiree.id, action: 'INCLUDE' })).body.outcome).toBe('UNCHANGED');
    expect(await sql`SELECT 1 FROM asset_cost_line_decision_events WHERE asset_id = ${j.maison.id}`).toHaveLength(2);
  });

  it('L80A-E02 — Ajouter l’achat non incorporé : décision prioritaire, stable aux reconsolidations T3 ; T2 du bien = TCO', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    await k.passer(compte);
    as(compte);
    const avant = (await getTco(j.maison.id)).body.tco;
    const chaises = ligneDe(avant, (l) => l.amountMinor === CHAISES && l.reason === 'NOT_OWNERSHIP_COST')!;
    expect(chaises).toBeTruthy();
    expect(chaises.actions).toMatchObject({ addable: true });
    const r = await decide(j.maison.id, { lineId: chaises.id, lineKey: chaises.decisionKey, action: 'INCLUDE', confirmDuplicate: !!chaises.actions.duplicateWarning });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tco.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents + CHAISES);
    coherent(r.body.tco);
    // Reconsolidations répétées (composantes éventuellement supersédées) : la décision tient (clé du justificatif).
    await k.passer(compte);
    await k.passer(compte);
    const tco = await (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, j.maison.id);
    expect(tco.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents + CHAISES);
    expect(tco.lines.filter((l) => l.amountMinor === CHAISES && l.includedCents > 0)).toHaveLength(1);
    expect(tco.userDecisions.orphans).toEqual([]);
    // T2 (périmètre du bien) : même total que le TCO (TCO-R-14) ; compte entier : les chaises une seule fois.
    const { sumQualifiedExpenses } = await import('@/services/verebona-assistant/canonical/expenses');
    const t2 = await sumQualifiedExpenses(compte.id, { assetIds: [j.maison.id] });
    expect(t2.qualifiedSumCents + t2.unqualified.sumCents).toBe(tco.summary.cumulativeCostCents);
    const tout = await sumQualifiedExpenses(compte.id, {});
    expect(tout.qualifiedSumCents + tout.unqualified.sumCents).toBe(tco.summary.cumulativeCostCents);
  });

  it('L80A-E03 — doublon présumé : refusé sans confirmation (avertissement explicite), accepté avec confirmation et journalisé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    as(compte);
    const avant = (await getTco(j.maison.id)).body.tco;
    const dup = ligneDe(avant, (l) => l.amountMinor === PRIX && l.includedCents === 0 && l.actions?.addable && l.actions?.duplicateWarning)!;
    expect(dup, JSON.stringify(avant.lines.map((l: Json) => [l.id, l.status, l.reason, l.actions]))).toBeTruthy();
    const refus = await decide(j.maison.id, { lineId: dup.id, action: 'INCLUDE' });
    expect(refus.status).toBe(409);
    expect(refus.body).toMatchObject({ code: 'DUPLICATE_CONFIRMATION_REQUIRED', message: expect.stringMatching(/^Doublon présumé/) });
    expect(await sql`SELECT 1 FROM asset_cost_line_decisions WHERE asset_id = ${j.maison.id}`).toHaveLength(0);
    const ok = await decide(j.maison.id, { lineId: dup.id, action: 'INCLUDE', confirmDuplicate: true });
    expect(ok.status).toBe(200);
    expect(ok.body.tco.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents + PRIX);
    expect(ok.body.tco.reliability.warnings).toContain('USER_INCLUDED_DUPLICATES');
    expect(ok.body.tco.warningLabels.join(' ')).toMatch(/même paiement/);
    const [ev] = await sql`SELECT action, duplicate_warning FROM asset_cost_line_decision_events WHERE asset_id = ${j.maison.id}`;
    expect(ev).toMatchObject({ action: 'INCLUDE', duplicate_warning: expect.stringMatching(/^Doublon présumé/) });
    // Non ajoutable (ligne d'un autre type) : refus explicite, rien écrit.
    const nonAjoutable = (ok.body.tco.lines as Json[]).find((l) => l.includedCents === 0 && l.actions && !l.actions.addable && l.actions.addBlockedReason);
    if (nonAjoutable) {
      const n = await decide(j.maison.id, { lineId: nonAjoutable.id, action: 'INCLUDE', confirmDuplicate: true });
      expect(n.status).toBe(422);
    }
    // Ligne inconnue (liste périmée) : 409, l'interface recharge.
    expect((await decide(j.maison.id, { lineId: 'c:999999999', action: 'EXCLUDE' })).body.code).toBe('LINE_NOT_FOUND');
  });

  it('L80A-E04 — droits : Standard 403 sans écriture, autre compte 404, membre Premium Duo autorisé, décisions conservées au changement d’offre', async () => {
    const duo = await make.account({ plan: 'premium_duo' });
    const j = await jeu(duo);
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.id}, ${membre.id}, 'member', 'active') ON CONFLICT DO NOTHING`;
    as(duo, membre.id);
    const tco = (await getTco(j.maison.id)).body.tco;
    const taxe = ligneDe(tco, (l) => l.amountMinor === TAXE && l.includedCents > 0)!;
    const r = await decide(j.maison.id, { lineId: taxe.id, action: 'EXCLUDE' });
    expect(r.status).toBe(200);
    expect((await sql`SELECT decided_by FROM asset_cost_line_decisions WHERE asset_id = ${j.maison.id}`)[0].decided_by).toBe(membre.id);
    // Le titulaire voit la même décision (données du compte).
    as(duo);
    expect((await getTco(j.maison.id)).body.tco.summary.cumulativeCostCents).toBe(tco.summary.cumulativeCostCents - TAXE);
    // Standard : 403 avant toute lecture, aucune écriture ; décision conservée.
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${duo.id}`;
    const bloque = await decide(j.maison.id, { lineId: taxe.id, action: 'INCLUDE' });
    expect(bloque.status).toBe(403);
    expect(JSON.stringify(bloque.body)).not.toMatch(/cumulative|lines/);
    expect(await sql`SELECT 1 FROM asset_cost_line_decision_events WHERE asset_id = ${j.maison.id}`).toHaveLength(1);
    await sql`UPDATE account_subscriptions SET plan_code = 'premium_duo' WHERE account_id = ${duo.id}`;
    expect((await getTco(j.maison.id)).body.tco.summary.cumulativeCostCents).toBe(tco.summary.cumulativeCostCents - TAXE);
    // Autre compte : 404, aucune écriture.
    const autre = await make.account({ plan: 'premium' });
    as(autre);
    expect((await decide(j.maison.id, { lineId: taxe.id, action: 'INCLUDE' })).status).toBe(404);
    expect(await sql`SELECT 1 FROM asset_cost_line_decisions WHERE account_id = ${autre.id}`).toHaveLength(0);
  });

  it('L80A-E05 — diagnostic BO (77C) : la décision utilisateur figure à l’étape CALCUL de montants.json', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    as(compte);
    const tco = (await getTco(j.maison.id)).body.tco;
    const internet = ligneDe(tco, (l) => l.amountMinor === INTERNET && l.includedCents > 0)!;
    expect((await decide(j.maison.id, { lineId: internet.id, action: 'EXCLUDE' })).status).toBe(200);
    const admin = await make.user({ role: 'ADMIN' });
    session.userId = admin.id; session.role = 'ADMIN'; session.email = admin.email;
    const { GET } = await import('@/app/api/admin/diagnostics/route');
    const res = await (GET as (r: InstanceType<typeof NextRequest>) => Promise<Response>)(new NextRequest(`http://app.test/api/admin/diagnostics?scope=asset&id=${j.maison.id}&format=zip`));
    expect(res.status).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const traces = JSON.parse(await z.file('tracabilite/montants.json')!.async('string')) as Json[];
    const t = traces.find((x) => x.ligne.decisionKey === internet.decisionKey || x.ligne.id === internet.id)!;
    expect(t).toBeTruthy();
    const calc = (t.chaine as Json[]).find((s) => s.etape === 'CALCUL')!;
    expect(calc.donnees).toMatchObject({
      statut: 'EXCLUDED', motif: 'USER_EXCLUDED', retenuCents: 0, cleStable: internet.decisionKey,
      decisionUtilisateur: { decision: 'EXCLUDE', applied: true, decidedByUserId: compte.ownerUserId, automaticStatus: internet.status },
    });
  });

  it('L80A-E06 — migration 0623 rejouable sans effet (idempotente)', async () => {
    const m = readFileSync(join(process.cwd(), 'src/db/migrations/0623_l80a_tco_decisions_utilisateur.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(m); });
    await sql.begin(async (tx) => { await tx.unsafe(m); });
    const [n] = await sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('asset_cost_line_decisions_isolation_guard', 'asset_cost_line_decision_events_isolation_guard')`;
    expect(n.n).toBe(2);
  });
});
