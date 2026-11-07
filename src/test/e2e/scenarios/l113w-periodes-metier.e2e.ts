/**
 * Lot 113W (Trello #724) — périodes métier transversales (Documents, événements de référence,
 * contrats, dépenses), sur PostgreSQL 16 réel. Persistance T1 réelle des candidats, consolidation
 * T3 réelle (sans IA : `operationMatch: false`), projection Agenda réelle, TCO réel, contrôle de
 * cohérence (orchestrateur unique), routes réelles (session simulée). Date de référence injectée.
 *
 *   L113W-E2E-01  assurance, attestations 2023/2024, 2024/2025, 2025/2026 → UN événement de référence,
 *                 3 couvertures chronologiques, chacune liée à sa preuve (document, route Agenda) ;
 *   L113W-E2E-02  factures mensuelles d'une assurance annuelle → une relation, périodes de dépense distinctes,
 *                 aucune seconde liste de facturation sur l'événement ;
 *   L113W-E2E-03  achat ponctuel : aucun champ période ; pièce contractuelle sans date : « non renseignée » ;
 *   L113W-E2E-04  faits T1 : début seul, fin seule, mois seul, périodes discontinues (« Plusieurs périodes concernées ») ;
 *   L113W-E2E-05  reconduction tacite sans nouveau justificatif : aucune couverture future, aucune « Fin de contrat » ;
 *   L113W-E2E-06  devis du 03/11/2026 sans réalisation attestée : aucune réalisation ni période déduite ;
 *   L113W-E2E-07  correction depuis le Document puis depuis l'événement : même couverture, factures intactes,
 *                 conservée après réanalyse ; compte en lecture seule refusé ;
 *   L113W-E2E-08  fin de facture : aucune fausse fin contractuelle ni échéance Agenda ;
 *   L113W-E2E-09  quittances / factures : périodes requalifiées et corrigées sans aucune variation du TCO ;
 *   L113W-E2E-10  reprise de l'historique (contrôle de cohérence) : à blanc sans écriture, puis exécutée deux fois
 *                 et après interruption → résultat stable ;
 *   L113W-E2E-11  schéma : bornes désordonnées / mal formées refusées, une seule période active par segment.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, fh, operationsKit, ref, RECETTE_TODAY, type OperationsKit } from '../datasets/operations-v1';
import { runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const CHECK = 'COH-DOC-BUSINESS-PERIODS';
type Json = Record<string, any>;

/** Attestation d'assurance : pièce contractuelle datée (dates d'effet et de fin de la période couverte). */
const attestation = (assetId: number, start: string | null, end: string | null, o: { police?: string; provider?: string } = {}): AnchoredOperationCandidate =>
  cand({
    typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'CONTRACT_DOCUMENT', provider: o.provider ?? 'Assureur Habitation',
    summary: 'Attestation d’assurance habitation', targetHints: [cible(assetId)],
    businessReferences: [ref('POLICY', o.police ?? 'POL-778812')] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) }, financialHints: [],
  });
/** Avis d'échéance / quittance mensuelle de la même police. */
const echeance = (assetId: number, start: string, end: string, montant = 3500, o: { police?: string; provider?: string } = {}): AnchoredOperationCandidate =>
  cand({
    typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: o.provider ?? 'Assureur Habitation',
    summary: `Échéance mensuelle ${start.slice(0, 7)}`, targetHints: [cible(assetId)],
    businessReferences: [ref('POLICY', o.police ?? 'POL-778812'), ref('INVOICE', `ECH-${start}`)] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { startDate: start, endDate: end },
    financialHints: [fh('REALIZED_COST', montant, { amountScope: 'INSTALLMENT', economicDate: start, periodStart: start, periodEnd: end })],
  });

scenario('L113W', 'Périodes métier transversales (Documents, événements de référence, contrats, dépenses)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(() => { k = operationsKit(sql, make); });
  afterAll(() => { session.currentAccountId = null; });
  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
  const rafraichir = async (c: AccountRow, ids: number[]) => { for (const id of ids) await (await svc()).refreshDocumentBusinessPeriods(c.id, id); };
  const lireDoc = async (c: AccountRow, id: number) => {
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), { params: Promise.resolve({ id: String(id) }) });
    expect(r.status).toBe(200);
    return (await r.json() as { periods: Json }).periods;
  };
  const corriger = async (c: AccountRow, fileId: number, body: Json) => {
    as(c);
    const { PUT } = await import('@/app/api/documents/[id]/periodes/route');
    return PUT(new NextRequest(`http://x/api/documents/${fileId}/periodes`, { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(fileId) }) });
  };
  const lireAgenda = async (c: AccountRow, itemId: number) => {
    as(c);
    const { GET } = await import('@/app/api/agenda/[id]/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/agenda/${itemId}/periodes`), { params: Promise.resolve({ id: String(itemId) }) });
    return { status: r.status, body: await r.json() as Json };
  };
  const contrat = async (c: AccountRow) => {
    const ops = (await k.actives(c)).filter((o) => o.type_code === 'CONTRACT');
    expect(ops).toHaveLength(1);
    return ops[0].id;
  };
  const periodes = (fileId: number) => sql<{ id: number; period_kind: string; segment_index: number; start_on: string | null; end_on: string | null; origin: string; user_locked: boolean; status: string }[]>`
    SELECT id::int AS id, period_kind, segment_index, start_on, end_on, origin, user_locked, status FROM document_business_periods WHERE file_id = ${fileId} ORDER BY id`;
  const actives = async (fileId: number) => (await periodes(fileId)).filter((p) => p.status === 'ACTIVE');

  // ══ E2E-01 ═══════════════════════════════════════════════════════════════
  describe('assurance à trois attestations', () => {
    let c: AccountRow; let docs: number[]; let op: number;
    it('L113W-E2E-01 — trois couvertures sur UN événement de référence, chronologiques, chacune liée à sa preuve', async () => {
      c = await make.account({ plan: 'premium' });
      const m = await maison(c);
      // Ordre d'import quelconque (la plus récente d'abord).
      const a2526 = await k.document(c, m.id, [attestation(m.id, '2025-04-01', '2026-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2025-2026' });
      const a2324 = await k.document(c, m.id, [attestation(m.id, '2023-04-01', '2024-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2023-2024' });
      const a2425 = await k.document(c, m.id, [attestation(m.id, '2024-04-01', '2025-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2024-2025' });
      docs = [a2324, a2425, a2526];
      await k.passer(c);
      await k.passer(c);
      op = await contrat(c);
      await rafraichir(c, docs);

      const h = await (await svc()).readOperationCoverageHistory(c.id, op);
      expect(h!.coverages.map((x) => [x.fileId, x.start, x.end])).toEqual([
        [a2324, '2023-04-01', '2024-03-31'], [a2425, '2024-04-01', '2025-03-31'], [a2526, '2025-04-01', '2026-03-31']]);
      expect(h!.coverages.map((x) => x.line)).toEqual([
        'Période couverte : du 01/04/2023 au 31/03/2024', 'Période couverte : du 01/04/2024 au 31/03/2025', 'Période couverte : du 01/04/2025 au 31/03/2026']);
      expect(h!.coverages.map((x) => x.documentTitle)).toEqual(['Attestation 2023-2024', 'Attestation 2024-2025', 'Attestation 2025-2026']);

      // Tiroir du document : une seule période principale (passée : affichée telle quelle) + historique de l'événement.
      const v = await lireDoc(c, a2425);
      expect(v.principal).toMatchObject({ kind: 'COVERAGE', line: 'Période couverte : du 01/04/2024 au 31/03/2025' });
      expect(v.coverageHistories).toHaveLength(1);
      expect(v.coverageHistories[0].coverages.map((x: Json) => x.fileId)).toEqual(docs);
      expect(JSON.stringify(v)).not.toMatch(/expir|dernière période connue/i);

      // Tiroir d'un élément d'agenda relié à l'événement de référence : même historique.
      const item = await make.agendaItem(c, { title: 'Assurance habitation', assetIds: [m.id] });
      await sql`UPDATE agenda_items SET business_operation_id = ${op} WHERE id = ${item.id}`;
      const ag = await lireAgenda(c, item.id);
      expect(ag.status).toBe(200);
      expect(ag.body.history.coverages.map((x: Json) => x.fileId)).toEqual(docs);
      expect(JSON.stringify(ag.body)).not.toMatch(/Opération|operationId/);
      // Élément sans événement de référence : aucun historique ; autre compte : introuvable.
      const seul = await make.agendaItem(c, { title: 'Rendez-vous' });
      expect((await lireAgenda(c, seul.id)).body.history).toBeNull();
      const autre = await make.account({ plan: 'premium' });
      expect((await lireAgenda(autre, item.id)).status).toBe(404);
      as(autre);
      const { GET } = await import('@/app/api/documents/[id]/periodes/route');
      expect((await GET(new NextRequest(`http://x/api/documents/${a2425}/periodes`), { params: Promise.resolve({ id: String(a2425) }) })).status).toBe(404);
    });

    it('L113W-E2E-07 — correction depuis le Document puis depuis l’événement : même fait, conservée après réanalyse', async () => {
      const [a2324, a2425] = docs;
      const avant = (await actives(a2425))[0];
      // Depuis le Document.
      const r1 = await corriger(c, a2425, { periodId: avant.id, start: '2024-04-15', end: '2025-04-14' });
      expect(r1.status).toBe(200);
      const apres = await actives(a2425);
      expect(apres).toEqual([expect.objectContaining({ period_kind: 'COVERAGE', start_on: '2024-04-15', end_on: '2025-04-14', origin: 'USER', user_locked: true })]);
      const [{ before }] = await sql<{ before: Json }[]>`SELECT before_correction AS before FROM document_business_periods WHERE id = ${apres[0].id}`;
      expect(before).toMatchObject({ start: '2024-04-01', end: '2025-03-31' });
      // L'événement de référence lit le MÊME fait (synchronisé, aucune copie).
      const h = (await (await svc()).readOperationCoverageHistory(c.id, op))!;
      expect(h.coverages.find((x) => x.fileId === a2425)).toMatchObject({ id: apres[0].id, start: '2024-04-15', userCorrected: true });
      // Depuis l'événement de référence (identifiant lu dans son historique) : seule cette couverture change.
      const e2324 = h.coverages.find((x) => x.fileId === a2324)!;
      expect((await corriger(c, a2324, { periodId: e2324.id, start: '2023-04', end: '2024-03' })).status).toBe(200);
      expect((await lireDoc(c, a2324)).principal.line).toBe('Période couverte : de avril 2023 à mars 2024');
      expect((await actives(docs[2]))[0]).toMatchObject({ origin: 'T1', start_on: '2025-04-01' });
      // Réanalyse T1 (autres dates) puis requalification : la correction est conservée.
      await k.t1(c, a2425, [attestation((await sql<{ asset_id: number }[]>`SELECT asset_id FROM asset_files WHERE id = ${a2425}`)[0].asset_id, '2024-01-01', '2024-12-31')], true);
      const r = await (await svc()).refreshDocumentBusinessPeriods(c.id, a2425);
      expect(r).toMatchObject({ outcome: 'UNCHANGED', protectedKinds: ['COVERAGE'] });
      expect(await actives(a2425)).toEqual([expect.objectContaining({ start_on: '2024-04-15', end_on: '2025-04-14', user_locked: true })]);
      // Saisie invalide, période d'un autre document, compte en lecture seule : refusées.
      expect((await corriger(c, a2425, { periodId: apres[0].id, start: '2025-05-01', end: '2025-04-01' })).status).toBe(400);
      expect((await corriger(c, a2425, { periodId: e2324.id, start: null, end: null })).status).toBe(404);
      const lecture = await make.account({ plan: null });
      const ml = await maison(lecture);
      const fl = await k.document(lecture, ml.id, [attestation(ml.id, '2025-01-01', '2025-12-31')]);
      await rafraichir(lecture, [fl]);
      const [pl] = await actives(fl);
      expect((await corriger(lecture, fl, { periodId: pl.id, start: '2025-02-01', end: null })).status).toBe(403);
      expect((await actives(fl))[0]).toMatchObject({ origin: 'T1', start_on: '2025-01-01' });
    });
  });

  // ══ E2E-02 / 08 / 09 ═════════════════════════════════════════════════════
  it('L113W-E2E-02 / 08 / 09 — factures mensuelles d’une assurance annuelle : une relation, dépenses distinctes, aucune fausse fin, TCO inchangé', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const att = await k.document(c, m.id, [attestation(m.id, '2025-04-01', '2026-03-31', { police: 'POL-9911' })], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2025-2026' });
    const mois = [['2025-04-01', '2025-04-30'], ['2025-05-01', '2025-05-31'], ['2025-06-01', '2025-06-30']] as const;
    const factures: number[] = [];
    for (const [s, e] of mois) factures.push(await k.document(c, m.id, [echeance(m.id, s, e, 3500, { police: 'POL-9911' })], { type: 'INVOICE', title: `Avis d’échéance ${s.slice(0, 7)}`, amountCents: 3500 }));
    await k.passer(c);
    await k.passer(c);
    const op = await contrat(c);
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const tcoAvant = (await readAssetTco(c.id, m.id, { today: RECETTE_TODAY })).summary;

    await rafraichir(c, [att, ...factures]);
    // L'événement de référence : la seule couverture de l'attestation — aucune liste de facturation.
    const h = (await (await svc()).readOperationCoverageHistory(c.id, op))!;
    expect(h.coverages.map((x) => [x.fileId, x.kind])).toEqual([[att, 'COVERAGE']]);
    // Chaque facture garde SA période (dépense), affichée comme période facturée.
    for (const [i, f] of factures.entries()) {
      const v = await lireDoc(c, f);
      expect(v.principal).toMatchObject({ kind: 'BILLING', segments: [expect.objectContaining({ start: mois[i][0], end: mois[i][1] })] });
      expect(v.principal.line).toBe(`Période facturée : du ${mois[i][0].split('-').reverse().join('/')} au ${mois[i][1].split('-').reverse().join('/')}`);
    }
    const comps = await sql<{ period_start: string; period_end: string; n: number }[]>`
      SELECT period_start::text AS period_start, period_end::text AS period_end, count(*)::int AS n FROM business_operation_financial_components
       WHERE operation_id = ${op} AND active AND kind = 'REALIZED_COST' GROUP BY 1, 2 ORDER BY 1`;
    expect(comps.map((x) => [x.period_start, x.period_end, x.n])).toEqual(mois.map(([s, e]) => [s, e, 1]));

    // E2E-08 : la fin d'une facture n'est jamais une fin de contrat ni une échéance Agenda.
    const [cd] = await sql<{ effective_to: string | null }[]>`SELECT effective_to::text AS effective_to FROM business_operation_contract_details WHERE operation_id = ${op}`;
    expect(cd?.effective_to ?? null).not.toBe('2025-06-30');
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await projectAccountOperations(c.id, { all: true, today: RECETTE_TODAY });
    const fins = await sql<{ start_date: string | null }[]>`SELECT start_date::text AS start_date FROM agenda_items WHERE account_id = ${c.id} AND business_type = 'contract'`;
    expect(fins.map((x) => x.start_date)).not.toContain('2025-06-30');

    // E2E-09 : une correction de période (facture) et la requalification ne changent aucun montant TCO.
    const pf = (await actives(factures[1]))[0];
    expect((await corriger(c, factures[1], { periodId: pf.id, start: '2025-05', end: '2025-05' })).status).toBe(200);
    await rafraichir(c, [att, ...factures]);
    const tcoApres = (await readAssetTco(c.id, m.id, { today: RECETTE_TODAY })).summary;
    expect(tcoApres.cumulativeCostCents).toBe(tcoAvant.cumulativeCostCents);
    expect(JSON.stringify(tcoApres)).toBe(JSON.stringify(tcoAvant));
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_financial_components WHERE operation_id = ${op} AND active`;
    expect(n).toBe(3);
  });

  // ══ E2E-03 ═══════════════════════════════════════════════════════════════
  it('L113W-E2E-03 — achat ponctuel sans champ période ; pièce contractuelle sans date : « non renseignée »', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const achat = await k.document(c, m.id, [cand({ typeHint: 'ACQUISITION', sourceRoleHint: 'INVOICE', targetHints: [cible(m.id)], temporalHints: { realizedDate: '2025-03-06' },
      financialHints: [fh('REALIZED_COST', 202300, { economicDate: '2025-03-06' })] })], { type: 'INVOICE', title: 'Facture vélo' });
    const sansDate = await k.document(c, m.id, [attestation(m.id, null, null, { police: 'POL-0001' })], { type: 'INSURANCE_CERTIFICATE' });
    await rafraichir(c, [achat, sansDate]);
    expect(await actives(achat)).toEqual([]);
    const v = await lireDoc(c, achat);
    expect(v).toMatchObject({ principal: null, secondary: [], coverageHistories: [] });
    expect((await lireDoc(c, sansDate)).principal.line).toBe('Période couverte : non renseignée');
    // « Non renseignée » corrigeable : la même ligne reçoit les dates de l'utilisateur.
    const [p] = await actives(sansDate);
    expect((await corriger(c, sansDate, { periodId: p.id, start: '2026-01-01', end: '2026-12-31' })).status).toBe(200);
    expect((await lireDoc(c, sansDate)).principal.line).toBe('Période couverte : du 01/01/2026 au 31/12/2026');
  });

  // ══ E2E-04 ═══════════════════════════════════════════════════════════════
  it('L113W-E2E-04 — faits T1 : début seul, fin seule, mois seul, périodes discontinues', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const faits = async (fileId: number, liste: Array<[string, string, string | null]>) => {
      const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
      for (const [key, value, attribute] of liste) {
        await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value, confidence, excerpt, status)
                  VALUES (${c.id}, ${fileId}, ${x.id}, ${key}, ${key}, ${attribute}, ${value}, 'certain', ${`extrait ${value}`}, 'active')`;
      }
    };
    const debut = await k.document(c, m.id, [], { title: 'Contrat entretien' });
    await faits(debut, [['period.coverage', '2025-01-15/', null]]);
    const fin = await k.document(c, m.id, [], { title: 'Garantie' });
    await faits(fin, [['period.warranty', '/2028-06-30', null]]);
    const moisSeul = await k.document(c, m.id, [], { title: 'Facture mars' });
    await faits(moisSeul, [['period.billing', '2026-03', null]]);
    const disc = await k.document(c, m.id, [attestation(m.id, '2024-01-01', '2024-12-31')], { title: 'Avenant saisonnier' });
    await faits(disc, [['period.coverage', '2024-07-01/2024-09-30', null], ['period.coverage', '2024-01-01/2024-03-31', null], ['period.validity', '2025', 'principal']]);
    await rafraichir(c, [debut, fin, moisSeul, disc]);
    expect((await lireDoc(c, debut)).principal.line).toBe('Début de couverture : 15/01/2025');
    expect((await lireDoc(c, fin)).principal.line).toBe('Fin de garantie : 30/06/2028');
    expect((await lireDoc(c, moisSeul)).principal.line).toBe('Période facturée : mars 2026');
    const d = await lireDoc(c, disc);
    // T1 désigne la validité comme principale ; la couverture discontinue reste détaillée, sans période globale.
    expect(d.principal).toMatchObject({ kind: 'VALIDITY', line: 'Période de validité : 2025' });
    expect(d.secondary.map((x: Json) => x.line)).toEqual(['Période couverte : du 01/01/2024 au 31/03/2024', 'Période couverte : du 01/07/2024 au 30/09/2024']);
    expect(await actives(disc)).not.toContainEqual(expect.objectContaining({ start_on: '2024-01-01', end_on: '2024-12-31' }));
    // Sans désignation T1 : « Plusieurs périodes concernées ».
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${disc} AND raw_key = 'period.validity'`;
    await rafraichir(c, [disc]);
    const d2 = await lireDoc(c, disc);
    expect(d2.principal).toMatchObject({ kind: 'COVERAGE', line: 'Plusieurs périodes concernées' });
    expect(d2.principal.segments.map((x: Json) => x.line)).toEqual(['Période couverte : du 01/01/2024 au 31/03/2024', 'Période couverte : du 01/07/2024 au 30/09/2024']);
  });

  // ══ E2E-05 / 06 ══════════════════════════════════════════════════════════
  it('L113W-E2E-05 / 06 — reconduction tacite : aucune couverture future ni fin ; devis sans réalisation : rien de déduit', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    // Contrat d'abonnement « reconduit tacitement » : seule la date d'effet est écrite.
    const ct = await k.document(c, m.id, [attestation(m.id, '2024-07-05', null, { police: 'ABO-55', provider: 'Télésurveillance' })], { type: 'CONTRACT', title: 'Contrat télésurveillance' });
    await k.passer(c);
    await rafraichir(c, [ct]);
    const v = await lireDoc(c, ct);
    expect(v.principal.line).toBe('Début de couverture : 05/07/2024');
    expect(await actives(ct)).toEqual([expect.objectContaining({ start_on: '2024-07-05', end_on: null })]);
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await projectAccountOperations(c.id, { all: true, today: RECETTE_TODAY });
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id} AND business_type = 'contract'`;
    expect(n).toBe(0);
    // Devis de travaux daté du 03/11/2026, sans réalisation attestée.
    const devis = await k.document(c, m.id, [cand({ typeHint: 'INTERVENTION', statusHint: 'ENVISAGED', confidence: 'probable', sourceRoleHint: 'QUOTE', targetHints: [cible(m.id)],
      temporalHints: { plannedDate: '2026-11-03' }, financialHints: [fh('FORECAST_COST', 450000)] })], { type: 'QUOTE', title: 'Devis toiture', date: '2026-11-03' });
    await k.passer(c);
    await rafraichir(c, [devis]);
    expect(await actives(devis)).toEqual([]);
    const ops = await sql<{ status: string; realized_date: string | null }[]>`
      SELECT o.status, o.realized_date::text AS realized_date FROM business_operations o
        JOIN business_operation_sources s ON s.operation_id = o.id AND s.active AND s.source_entity_key = ${String(devis)}
       WHERE o.account_id = ${c.id}`;
    for (const o of ops) expect(o).toMatchObject({ realized_date: null });
    expect(ops.every((o) => o.status !== 'REALIZED')).toBe(true);
  });

  // ══ E2E-10 ═══════════════════════════════════════════════════════════════
  it('L113W-E2E-10 — reprise de l’historique : à blanc sans écriture, exécutée deux fois, interrompue → stable', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    // Stock analysé AVANT le lot : connaissance T1 persistée, aucune période enregistrée.
    const stock: number[] = [];
    for (const [s, e] of [['2022-01-01', '2022-12-31'], ['2023-01-01', '2023-12-31'], ['2024-01-01', '2024-12-31']] as const) {
      stock.push(await k.document(c, m.id, [attestation(m.id, s, e, { police: 'POL-STOCK' })], { type: 'INSURANCE_CERTIFICATE' }));
    }
    const achat = await k.document(c, m.id, [cand({ typeHint: 'ACQUISITION', targetHints: [cible(m.id)], financialHints: [fh('REALIZED_COST', 9900)] })]);
    const total = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_business_periods WHERE account_id = ${c.id}`)[0].n;

    const blanc = await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN', today: RECETTE_TODAY });
    expect(blanc.results[CHECK]).toMatchObject({ WOULD_REPAIR: 3, CONSISTENT: 1 });
    expect(await total()).toBe(0);

    // Interruption : un seul document requalifié avant l'arrêt.
    await rafraichir(c, [stock[0]]);
    const r1 = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r1.results[CHECK]).toMatchObject({ REPAIRED: 2, CONSISTENT: 2 });
    expect(await total()).toBe(3);
    const journal = await sql<{ service: string; ai_calls: number }[]>`
      SELECT service, ai_calls FROM coherence_repairs WHERE account_id = ${c.id} AND check_id = ${CHECK}`;
    expect(journal).toHaveLength(2);
    for (const j of journal) expect(j).toMatchObject({ service: 'refreshDocumentBusinessPeriods', ai_calls: 0 });

    // Seconde exécution : aucune écriture, mêmes lignes.
    const ids = (await sql<{ id: number }[]>`SELECT id::int AS id FROM document_business_periods WHERE account_id = ${c.id} ORDER BY id`).map((x) => x.id);
    const r2 = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r2.results[CHECK]?.REPAIRED ?? 0).toBe(0);
    expect((await sql<{ id: number }[]>`SELECT id::int AS id FROM document_business_periods WHERE account_id = ${c.id} ORDER BY id`).map((x) => x.id)).toEqual(ids);
    for (const f of stock) expect(await actives(f)).toHaveLength(1);
    expect(await actives(achat)).toEqual([]);
    // Rafraîchissement direct rejoué : inchangé.
    expect(await (await svc()).refreshDocumentBusinessPeriods(c.id, stock[1])).toMatchObject({ outcome: 'UNCHANGED', kept: 1 });
  });

  // ══ E2E-11 ═══════════════════════════════════════════════════════════════
  it('L113W-E2E-11 — schéma : bornes désordonnées ou mal formées refusées, une période active par segment', async () => {
    const c = await make.account({ plan: 'premium' });
    const f = await make.assetFile(c, {});
    const ins = (start: string | null, end: string | null, seg = 0) => sql`
      INSERT INTO document_business_periods (account_id, file_id, period_kind, segment_index, start_on, end_on, origin, basis)
      VALUES (${c.id}, ${f.id}, 'COVERAGE', ${seg}, ${start}, ${end}, 'T1', 'T1_PERIOD_FACT')`;
    await expect(ins('2026-05-01', '2026-04-30')).rejects.toThrow(/order_chk/);
    await expect(ins('2026-13', null)).rejects.toThrow(/start_chk/);
    await expect(ins('2026-04', '2026-04-15')).resolves.toBeDefined();
    await expect(ins('2026-05', null)).rejects.toThrow(/active_uidx/);
    await expect(sql`INSERT INTO document_business_periods (account_id, file_id, period_kind, origin, basis, user_locked)
      VALUES (${c.id}, ${f.id}, 'BILLING', 'T1', 'x', true)`).rejects.toThrow(/user_chk/);
  });
});
