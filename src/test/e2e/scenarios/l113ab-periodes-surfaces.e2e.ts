/**
 * Lot 113AB (Trello #725, §2 D et §3) — périodes métier sur les SURFACES, PostgreSQL 16 réel :
 * persistance T1 réelle des candidats, consolidation T3 réelle (sans IA), qualification des périodes
 * (service 113W), routes réelles (session simulée), moteur TCO réel, récupération T2 réelle, source
 * des dossiers V12 réelle. Date de référence injectée ; assertions bornées aux comptes créés ici.
 *
 *   L113AB-E2E-01  accès aux périodes depuis l'événement de référence SANS élément d'agenda : fiche
 *                  (3 couvertures chronologiques sourcées, justificatifs), lien depuis le document,
 *                  parité avec la lecture du lot 113W, agenda relié signalé, autre compte 404, lecture seule consulte ;
 *   L113AB-E2E-02  R15 — correction depuis le document, puis l'événement de référence, puis la dépense :
 *                  le MÊME fait à chaque fois, synchronisé partout ; couverture, durée contractuelle et TCO
 *                  intacts ; auteur et état antérieur tracés ; lecture seule 403 ; autre compte : rien ;
 *   L113AB-E2E-03  R18 — facture annuelle + paiements + relevé récapitulatif : un seul coût (moteur TCO réel),
 *                  (03b : relevé qui rappelle la cotisation comme coût, même référence : toujours un seul coût)
 *                  identique après correction de la période facturée ;
 *   L113AB-E2E-04  R20 — T2 : contrat (couvertures établies, corrections, sources consultables, aucune prolongation
 *                  ni fin déduite d'une reconduction), extrait documentaire = libellé de la fiche ;
 *   L113AB-E2E-05  export métier après correction : la pièce du dossier porte la période corrigée ; jamais
 *                  Notes / Description (113Z) ; pièce sans période : rien.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, fh, operationsKit, ref, RECETTE_TODAY, type OperationsKit } from '../datasets/operations-v1';

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

type Json = Record<string, any>;

const attestation = (assetId: number, start: string | null, end: string | null, o: { police?: string; provider?: string } = {}): AnchoredOperationCandidate =>
  cand({
    typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'CONTRACT_DOCUMENT', provider: o.provider ?? 'Assureur Habitation',
    summary: 'Attestation d’assurance habitation', targetHints: [cible(assetId)],
    businessReferences: [ref('POLICY', o.police ?? 'POL-113AB')] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) }, financialHints: [],
  });
const facture = (assetId: number, start: string, end: string, montant: number, o: { police?: string; scope?: string } = {}): AnchoredOperationCandidate =>
  cand({
    typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Assureur Habitation',
    summary: `Cotisation ${start.slice(0, 7)}`, targetHints: [cible(assetId)],
    businessReferences: [ref('POLICY', o.police ?? 'POL-113AB'), ref('INVOICE', `F-${start}`)] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { startDate: start, endDate: end },
    financialHints: [fh('REALIZED_COST', montant, { amountScope: (o.scope ?? 'INSTALLMENT') as never, economicDate: start, periodStart: start, periodEnd: end })],
  });

scenario('L113AB', 'Périodes métier — surfaces (événement de référence, dépense, T2, exports)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(() => { k = operationsKit(sql, make); });
  afterAll(() => { session.currentAccountId = null; });
  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const surf = () => import('@/services/documents/business-period-surfaces');
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
  const rafraichir = async (c: AccountRow, ids: number[]) => { for (const id of ids) await (await svc()).refreshDocumentBusinessPeriods(c.id, id); };
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

  const ficheEvenement = async (c: AccountRow, op: number) => {
    as(c);
    const { GET } = await import('@/app/api/evenements-reference/[id]/route');
    const r = await GET(new NextRequest(`http://x/api/evenements-reference/${op}`), ctx(op));
    return { status: r.status, body: await r.json() as Json };
  };
  const evenementsDuDocument = async (c: AccountRow, fileId: number) => {
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/evenements-reference/route');
    const r = await GET(new NextRequest(`http://x/api/documents/${fileId}/evenements-reference`), ctx(fileId));
    return { status: r.status, body: await r.json() as Json };
  };
  const periodesDepenses = async (c: AccountRow, ids: number[]) => {
    as(c);
    const { GET } = await import('@/app/api/documents/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/periodes?ids=${ids.join(',')}`));
    expect(r.status).toBe(200);
    return (await r.json() as { periods: Json }).periods;
  };
  const lireDoc = async (c: AccountRow, id: number) => {
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), ctx(id));
    expect(r.status).toBe(200);
    return (await r.json() as { periods: Json }).periods;
  };
  const corriger = async (c: AccountRow, fileId: number, body: Json) => {
    as(c);
    const { PUT } = await import('@/app/api/documents/[id]/periodes/route');
    return PUT(new NextRequest(`http://x/api/documents/${fileId}/periodes`, { method: 'PUT', body: JSON.stringify(body) }), ctx(fileId));
  };
  const contrat = async (c: AccountRow) => {
    const ops = (await k.actives(c)).filter((o) => o.type_code === 'CONTRACT');
    expect(ops).toHaveLength(1);
    return ops[0].id;
  };
  const tcoDe = async (c: AccountRow, assetId: number) => (await import('@/services/business-operations/tco/service')).readAssetTco(c.id, assetId, { today: RECETTE_TODAY });
  /** Empreinte financière complète (montants, statuts, dates économiques, années, totaux annuels). */
  const empreinteTco = (t: Awaited<ReturnType<typeof tcoDe>>) => JSON.stringify({
    summary: t.summary, annual: (t as Json).annual ?? null,
    lines: t.lines.map((l) => [l.id, l.status, l.reason, l.includedCents, l.eurCents, l.date, l.annualYear ?? null, l.fileId, l.operationId]),
  });
  const composantes = (op: number) => sql<{ id: number; kind: string; amount_minor: number; period_start: string | null; period_end: string | null; economic_date: string | null }[]>`
    SELECT id::int AS id, kind, amount_minor::int AS amount_minor, period_start::text AS period_start, period_end::text AS period_end, economic_date::text AS economic_date
      FROM business_operation_financial_components WHERE operation_id = ${op} AND active ORDER BY id`;
  const contratDates = async (op: number) => (await sql<{ f: string | null; t: string | null }[]>`
    SELECT effective_from::text AS f, effective_to::text AS t FROM business_operation_contract_details WHERE operation_id = ${op}`)[0] ?? null;

  // ══ E2E-01 / 02 ══════════════════════════════════════════════════════════
  describe('assurance : trois attestations et des cotisations, sans élément d’agenda', () => {
    let c: AccountRow; let m: { id: number }; let op: number; let att: number[]; let fact: number[];
    it('L113AB-E2E-01 — fiche de l’événement de référence sans agenda : couvertures chronologiques, sourcées, consultables', async () => {
      c = await make.account({ plan: 'premium' });
      m = await maison(c);
      const a3 = await k.document(c, m.id, [attestation(m.id, '2025-04-01', '2026-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2025-2026', date: '2025-03-20' });
      const a1 = await k.document(c, m.id, [attestation(m.id, '2023-04-01', '2024-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2023-2024', date: '2023-03-20' });
      const a2 = await k.document(c, m.id, [attestation(m.id, '2024-04-01', '2025-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2024-2025', date: '2024-03-20' });
      att = [a1, a2, a3];
      fact = [];
      for (const [s, e] of [['2025-04-01', '2025-04-30'], ['2025-05-01', '2025-05-31']] as const) {
        fact.push(await k.document(c, m.id, [facture(m.id, s, e, 3500)], { type: 'INVOICE', title: `Cotisation ${s.slice(0, 7)}`, amountCents: 3500, date: s }));
      }
      await k.passer(c);
      await k.passer(c);
      op = await contrat(c);
      await rafraichir(c, [...att, ...fact]);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id} AND business_operation_id = ${op}`;
      expect(n).toBe(0);

      const f = await ficheEvenement(c, op);
      expect(f.status).toBe(200);
      const v = f.body.reference;
      expect(v.coverages.map((x: Json) => [x.fileId, x.line, x.documentTitle])).toEqual([
        [a1, 'Période couverte : du 01/04/2023 au 31/03/2024', 'Attestation 2023-2024'],
        [a2, 'Période couverte : du 01/04/2024 au 31/03/2025', 'Attestation 2024-2025'],
        [a3, 'Période couverte : du 01/04/2025 au 31/03/2026', 'Attestation 2025-2026'],
      ]);
      // Aucune seconde liste de facturation : les cotisations sont des justificatifs, pas des couvertures.
      expect(v.coverages.every((x: Json) => x.kind === 'COVERAGE')).toBe(true);
      expect(v.documents.map((d: Json) => d.fileId).sort()).toEqual([...att, ...fact].sort());
      expect(v).toMatchObject({ agendaItemId: null, typeCode: 'CONTRACT' });
      expect(v.label).toMatch(/^Contrat/);
      expect(JSON.stringify(v)).not.toMatch(/Opération|expir|en cours|dernière période connue/i);
      // Parité stricte avec la lecture du lot 113W (tiroir Agenda / document) et la lecture groupée T2.
      const h = (await (await svc()).readOperationCoverageHistory(c.id, op))!;
      expect(v.coverages).toEqual(JSON.parse(JSON.stringify(h.coverages)));
      expect((await (await surf()).readOperationsCoverage(c.id, [op])).get(op)).toEqual(h.coverages);

      // Depuis le document : l'événement sans agenda est proposé (lien de la fiche).
      const d = await evenementsDuDocument(c, fact[0]);
      expect(d.status).toBe(200);
      expect(d.body.references).toEqual([expect.objectContaining({ id: op, hasAgenda: false, coverageCount: 3 })]);
      // Un élément d'agenda relié : signalé (le tiroir du document ne double pas le lien) ; la fiche reste lisible.
      const item = await make.agendaItem(c, { title: 'Assurance habitation', assetIds: [m.id] });
      await sql`UPDATE agenda_items SET business_operation_id = ${op} WHERE id = ${item.id}`;
      expect((await evenementsDuDocument(c, fact[0])).body.references[0]).toMatchObject({ hasAgenda: true });
      expect((await ficheEvenement(c, op)).body.reference.agendaItemId).toBe(item.id);
      await sql`UPDATE agenda_items SET business_operation_id = NULL WHERE id = ${item.id}`;

      // Isolation : autre compte → 404 (fiche et document) ; identifiant invalide → 400.
      const autre = await make.account({ plan: 'premium' });
      expect((await ficheEvenement(autre, op)).status).toBe(404);
      expect((await evenementsDuDocument(autre, fact[0])).status).toBe(404);
      expect(await periodesDepenses(autre, fact)).toEqual({});
      as(c);
      const { GET } = await import('@/app/api/evenements-reference/[id]/route');
      expect((await GET(new NextRequest('http://x/api/evenements-reference/abc'), { params: Promise.resolve({ id: 'abc' }) })).status).toBe(400);
    });

    it('L113AB-E2E-02 — R15 : correction depuis le document, l’événement de référence puis la dépense — même fait, synchronisé, TCO intact', async () => {
      const tcoAvant = empreinteTco(await tcoDe(c, m.id));
      const compsAvant = await composantes(op);
      const datesAvant = await contratDates(op);

      // 1. Depuis le DOCUMENT (attestation 2024-2025).
      const p2 = (await lireDoc(c, att[1])).principal.segments[0];
      expect((await corriger(c, att[1], { periodId: p2.id, start: '2024-04-15', end: '2025-04-14' })).status).toBe(200);
      // 2. Depuis l'ÉVÉNEMENT DE RÉFÉRENCE (identifiant lu dans sa fiche) : attestation 2023-2024.
      const fiche = (await ficheEvenement(c, op)).body.reference;
      expect(fiche.coverages[1]).toMatchObject({ fileId: att[1], line: 'Période couverte : du 15/04/2024 au 14/04/2025', userCorrected: true });
      expect((await corriger(c, fiche.coverages[0].fileId, { periodId: fiche.coverages[0].id, start: '2023-04', end: '2024-03' })).status).toBe(200);
      expect((await lireDoc(c, att[0])).principal.line).toBe('Période couverte : de avril 2023 à mars 2024');

      // 3. Depuis la DÉPENSE : la ligne TCO de la cotisation d'avril → son justificatif → sa période facturée.
      const t = await tcoDe(c, m.id);
      const ligne = t.lines.find((l) => l.fileId === fact[0] || (l.sourceFileIds ?? []).includes(fact[0]));
      expect(ligne).toBeTruthy();
      const lu = await periodesDepenses(c, t.lines.map((l) => l.fileId).filter((x): x is number => x != null));
      const billing = lu[String(fact[0])].billing;
      expect(billing).toEqual([expect.objectContaining({ kind: 'BILLING', line: 'Période facturée : du 01/04/2025 au 30/04/2025', userCorrected: false })]);
      // Les attestations n'ont aucune période facturée à montrer sur une dépense.
      expect(lu[String(att[2])]?.billing ?? []).toEqual([]);
      const r = await corriger(c, fact[0], { periodId: billing[0].id, start: '2025-04-02', end: '2025-05-01' });
      expect(r.status).toBe(200);

      // Synchronisé partout : la fiche du document, la dépense (relue), le même identifiant de fait.
      const doc = await lireDoc(c, fact[0]);
      expect(doc.principal).toMatchObject({ kind: 'BILLING', line: 'Période facturée : du 02/04/2025 au 01/05/2025' });
      const relu = (await periodesDepenses(c, [fact[0]]))[String(fact[0])].billing;
      expect(relu).toEqual([expect.objectContaining({ id: doc.principal.segments[0].id, line: 'Période facturée : du 02/04/2025 au 01/05/2025', userCorrected: true })]);
      // Auteur, date et état antérieur tracés ; l'ancien fait est conservé (SUPERSEDED).
      const [trace] = await sql<{ by: number | null; at: string | null; before: Json; origin: string }[]>`
        SELECT corrected_by_user_id AS by, corrected_at::text AS at, before_correction AS before, origin FROM document_business_periods WHERE id = ${relu[0].id}`;
      expect(trace).toMatchObject({ by: c.ownerUserId, origin: 'USER', before: expect.objectContaining({ start: '2025-04-01', end: '2025-04-30' }) });
      expect(trace.at).toBeTruthy();
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_business_periods WHERE file_id = ${fact[0]} AND status = 'SUPERSEDED'`;
      expect(n).toBe(1);

      // Rien d'autre ne bouge : autre cotisation, couvertures, durée contractuelle, composantes et TCO.
      expect((await lireDoc(c, fact[1])).principal.line).toBe('Période facturée : du 01/05/2025 au 31/05/2025');
      expect((await ficheEvenement(c, op)).body.reference.coverages.map((x: Json) => x.line)).toEqual([
        'Période couverte : de avril 2023 à mars 2024', 'Période couverte : du 15/04/2024 au 14/04/2025', 'Période couverte : du 01/04/2025 au 31/03/2026']);
      expect(await contratDates(op)).toEqual(datesAvant);
      expect(await composantes(op)).toEqual(compsAvant);
      expect(empreinteTco(await tcoDe(c, m.id))).toBe(tcoAvant);
      // Réanalyse puis requalification : la correction faite depuis la dépense est conservée.
      await k.t1(c, fact[0], [facture(m.id, '2025-04-01', '2025-04-30', 3500)], true);
      expect(await (await svc()).refreshDocumentBusinessPeriods(c.id, fact[0])).toMatchObject({ protectedKinds: ['BILLING'] });
      expect((await periodesDepenses(c, [fact[0]]))[String(fact[0])].billing[0].line).toBe('Période facturée : du 02/04/2025 au 01/05/2025');

      // Lecture seule : consultation permise, correction refusée (403), rien d'écrit.
      const lecture = await make.account({ plan: null });
      const ml = await maison(lecture);
      const fl = await k.document(lecture, ml.id, [facture(ml.id, '2025-01-01', '2025-01-31', 2000, { police: 'POL-L' })], { type: 'INVOICE', title: 'Cotisation janvier' });
      await rafraichir(lecture, [fl]);
      const pl = (await periodesDepenses(lecture, [fl]))[String(fl)].billing[0];
      expect((await corriger(lecture, fl, { periodId: pl.id, start: '2025-01-05', end: null })).status).toBe(403);
      expect((await periodesDepenses(lecture, [fl]))[String(fl)].billing[0]).toMatchObject({ id: pl.id, userCorrected: false });
      // Un autre compte (en écriture) ne corrige pas la période de ce compte : introuvable, rien d'écrit.
      const autre = await make.account({ plan: 'premium' });
      const idF1 = (await lireDoc(c, fact[1])).principal.segments[0].id;
      expect((await corriger(autre, fact[1], { periodId: idF1, start: null, end: null })).status).toBe(404);
      expect((await lireDoc(c, fact[1])).principal.segments[0]).toMatchObject({ id: idF1, userCorrected: false });
    });

    it('L113AB-E2E-04 — R20 : T2 cite les couvertures établies (corrections comprises), sources consultables, aucune prolongation', async () => {
      const { readContracts } = await import('@/services/verebona-assistant/canonical/operations');
      const { contractsAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
      const contrats = await readContracts(c.id, [m.id], { assetName: 'Maison' });
      const ct = contrats.find((x) => x.operationId === op)!;
      // Mêmes libellés que la fiche (correction de l'utilisateur comprise), même ordre, mêmes justificatifs.
      const fiche = (await ficheEvenement(c, op)).body.reference.coverages as Json[];
      expect(ct.coverages!.map((x) => x.line)).toEqual(fiche.map((x) => x.line));
      expect(ct.coverages!.map((x) => x.userCorrected)).toEqual([true, true, false]);
      expect(ct.coverageSources!.map((s) => s.id)).toEqual(att.map((id) => `doc_${id}`));
      // 113W2 : la fin d'une attestation n'est pas une fin de contrat — aucune fin annoncée.
      expect(ct.to).toBeNull();
      const r = contractsAnswer(contrats.filter((x) => x.operationId === op), { assets: [], ambiguous: false, unresolved: false, label: 'Maison' });
      // Lot 113AC (fusion D11 → T2) : la correction de l'étape E2E-02 (15/04/2024 → 14/04/2025) chevauche de 14 jours
      // l'attestation 2025-2026 (non qualifiée v2) : D11 les signale comme divergentes ; T2 le dit, sans en choisir une.
      expect(r.answer).toContain('Périodes de couverture établies par les justificatifs : de avril 2023 à mars 2024 (justificatif : Attestation 2023-2024), corrigée par l’utilisateur');
      expect(r.answer).toContain('Périodes différentes selon les justificatifs : du 15/04/2024 au 14/04/2025 (justificatif : Attestation 2024-2025), corrigée par l’utilisateur ; du 01/04/2025 au 31/03/2026 (justificatif : Attestation 2025-2026) — aucune n’est retenue tant que ce point n’est pas tranché');
      expect(r.answer).toContain('aucune prolongation n’est déduite');
      expect(r.answer).not.toMatch(/jusqu|expir|en cours|Opération/i);
      expect(r.sources.map((s) => s.id)).toEqual(expect.arrayContaining(att.map((id) => `doc_${id}`)));
      // Source métier (étape sémantique T2) : mêmes faits dans l'extrait.
      const { operationBusinessSource } = await import('@/services/verebona-assistant/canonical/business-sources');
      const { operationReader } = await import('@/services/verebona-assistant/canonical/operations');
      const [lu] = await operationReader().listForAssistant(c.id, { ids: [op], limit: 1 });
      const src = operationBusinessSource(lu, m.id, 'Maison', ct.coverages);
      expect(src.source!.content).toContain('du 15/04/2024 au 14/04/2025 (justificatif : Attestation 2024-2025), corrigée par l’utilisateur');
      expect(src.endDate).toBeNull();

      // Extrait documentaire T2 : la période telle que sur la fiche (corrigée), sans réanalyse.
      const { ADAPTATEURS } = await import('@/services/verebona-assistant/registries/retrieval-adapters');
      const { analyserRequeteCanonique } = await import('@/services/verebona-assistant/core/retrieval.service');
      const a = analyserRequeteCanonique('cotisation');
      const res = await ADAPTATEURS.find((x) => x.name === 'documents')!.search({
        accountId: c.id, normalizedQuery: a.terms.map((t) => t.stem).join(' '), terms: a.terms, intent: 'UNKNOWN', entityFilters: {}, limit: 20,
        period: a.period, documentTypes: a.documentTypes, documentFilters: a.documentFilters, documentTypeFilter: a.documentTypes,
      });
      const s0 = res.find((s) => s.meta?.documentId === fact[0]);
      expect(s0?.content).toContain('Période facturée : du 02/04/2025 au 01/05/2025 (corrigée par l’utilisateur)');
      expect(res.find((s) => s.meta?.documentId === fact[1])?.content).toContain('Période facturée : du 01/05/2025 au 31/05/2025');
      expect(s0?.id).toBe(`doc_${fact[0]}`);
    });

    it('L113AB-E2E-05 — export métier après correction : la pièce porte la période corrigée, jamais Notes / Description', async () => {
      await sql`UPDATE asset_files SET notes = 'Note privée 113AB', description = 'Description interne 113AB', upload_status = 'COMPLETED' WHERE id = ANY(${[...att, ...fact]})`;
      const { loadExportSource } = await import('@/services/exports/v12/data/source');
      const { mapDossierComplet } = await import('@/services/exports/v12/data/mappers/dossier-complet');
      for (const exportType of ['DOSSIER_COMPLET', 'ASSURANCE_SOUSCRIPTION', 'VENTE'] as const) {
        const s = await loadExportSource({ assetId: m.id, accountId: c.id, userId: c.ownerUserId, exportType });
        const par = new Map(s.documents.map((d) => [d.id, d.periodLine ?? null]));
        expect(par.get(att[0])).toBe('Période couverte : de avril 2023 à mars 2024');
        expect(par.get(fact[0])).toBe('Période facturée : du 02/04/2025 au 01/05/2025');
        expect(JSON.stringify(s)).not.toMatch(/Note privée 113AB|Description interne 113AB/);
        if (exportType === 'DOSSIER_COMPLET') {
          const plan = { documents: s.documents.map((doc) => ({ doc, mode: 'PDF' })), photos: [], events: new Set<string>(), sections: {}, excluded: [] };
          const data = mapDossierComplet({ source: s, plan, resolved: null, meta: { preparedBy: 'x', label: 'Dossier' }, today: RECETTE_TODAY } as never);
          const pieces = new Map(data.documents!.map((d) => [d.id, d.detail ?? null]));
          expect([...pieces.values()]).toContain('Période facturée : du 02/04/2025 au 01/05/2025');
          expect(JSON.stringify(data)).not.toMatch(/Note privée 113AB|Description interne 113AB/);
        }
      }
      // Pièce sans période (achat ponctuel) : aucune ligne de période.
      const achat = await k.document(c, m.id, [cand({ typeHint: 'ACQUISITION', sourceRoleHint: 'INVOICE', targetHints: [cible(m.id)], temporalHints: { realizedDate: '2025-03-06' },
        financialHints: [fh('REALIZED_COST', 20230, { economicDate: '2025-03-06' })] })], { type: 'INVOICE', title: 'Facture aspirateur' });
      await sql`UPDATE asset_files SET upload_status = 'COMPLETED' WHERE id = ${achat}`;
      await rafraichir(c, [achat]);
      const s = await loadExportSource({ assetId: m.id, accountId: c.id, userId: c.ownerUserId, exportType: 'DOSSIER_COMPLET' });
      const d = s.documents.find((x) => x.id === achat);
      expect(d).toBeTruthy();
      expect(d!.periodLine ?? null).toBeNull();
    });
  });

  // ══ E2E-03 ═══════════════════════════════════════════════════════════════
  it('L113AB-E2E-03 — R18 : facture annuelle + paiements + relevé récapitulatif → un seul coût, inchangé après correction', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const police = 'POL-ANNUEL';
    const refs = (extra: Array<[string, string]> = []) => [ref('POLICY', police), ...extra.map(([a, b]) => ref(a, b))] as AnchoredOperationCandidate['businessReferences'];
    const annuelle = await k.document(c, m.id, [cand({
      typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Assureur Habitation', summary: 'Cotisation annuelle 2025',
      targetHints: [cible(m.id)], businessReferences: refs([['INVOICE', 'AN-2025']]), temporalHints: { startDate: '2025-01-01', endDate: '2025-12-31' },
      financialHints: [fh('REALIZED_COST', 42000, { amountScope: 'TOTAL', economicDate: '2025-01-01', periodStart: '2025-01-01', periodEnd: '2025-12-31' })],
    })], { type: 'INVOICE', title: 'Facture annuelle 2025', amountCents: 42000, date: '2025-01-01' });
    const paiements: number[] = [];
    for (const [i, d] of ['2025-01-05', '2025-05-05', '2025-09-05'].entries()) {
      paiements.push(await k.document(c, m.id, [cand({
        typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'PAYMENT_PROOF', provider: 'Assureur Habitation', summary: `Prélèvement ${i + 1}/3`,
        targetHints: [cible(m.id)], businessReferences: refs([['INVOICE', 'AN-2025']]), temporalHints: { realizedDate: d },
        financialHints: [fh('PAYMENT', 14000, { economicDate: d })],
      })], { type: 'WORKS_PAYMENT_PROOF', title: `Prélèvement ${i + 1}/3`, amountCents: 14000, date: d }));
    }
    // Relevé récapitulatif : rappelle la cotisation de l'année et les règlements (aucune nouvelle dépense).
    const releve = await k.document(c, m.id, [cand({
      typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'OTHER_EVIDENCE', provider: 'Assureur Habitation', summary: 'Relevé annuel 2025',
      targetHints: [cible(m.id)], businessReferences: refs([['INVOICE', 'AN-2025']]), temporalHints: { startDate: '2025-01-01', endDate: '2025-12-31' },
      financialHints: [fh('PAYMENT', 42000, { economicDate: '2025-12-31' })],
    })], { type: null, title: 'Relevé récapitulatif 2025', amountCents: 42000, date: '2025-12-31' });
    await k.passer(c);
    await k.passer(c);
    await rafraichir(c, [annuelle, ...paiements, releve]);

    const t = await tcoDe(c, m.id);
    const retenues = t.lines.filter((l) => l.includedCents > 0);
    // Un seul coût : la cotisation annuelle ; ni les paiements ni le relevé n'ajoutent de dépense.
    expect(retenues.reduce((s, l) => s + l.includedCents, 0)).toBe(42000);
    expect(t.summary.cumulativeCostCents - (t.summary.acquisitionCents ?? 0)).toBe(42000);
    for (const id of [...paiements, releve]) {
      expect(t.lines.filter((l) => l.fileId === id && l.includedCents > 0)).toEqual([]);
    }
    // La période facturée de la facture se corrige depuis la dépense sans aucune variation financière.
    const avant = empreinteTco(t);
    const b = (await periodesDepenses(c, [annuelle]))[String(annuelle)].billing[0];
    expect(b.line).toBe('Période facturée : du 01/01/2025 au 31/12/2025');
    expect((await corriger(c, annuelle, { periodId: b.id, start: '2025-02-01', end: '2026-01-31' })).status).toBe(200);
    expect(empreinteTco(await tcoDe(c, m.id))).toBe(avant);
  });

  it('L113AB-E2E-03b — R18 : relevé récapitulatif qui RAPPELLE la cotisation (même montant, même référence) → toujours un seul coût', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const refs = [ref('POLICY', 'POL-RECAP'), ref('INVOICE', 'AN-2025')] as AnchoredOperationCandidate['businessReferences'];
    const base = { typeHint: 'CONTRACT' as const, statusHint: 'REALIZED' as const, provider: 'Assureur Habitation', targetHints: [cible(m.id)], businessReferences: refs,
      temporalHints: { startDate: '2025-01-01', endDate: '2025-12-31' } };
    await k.document(c, m.id, [cand({ ...base, sourceRoleHint: 'INVOICE', summary: 'Cotisation annuelle 2025',
      financialHints: [fh('REALIZED_COST', 42000, { amountScope: 'TOTAL', economicDate: '2025-01-01', periodStart: '2025-01-01', periodEnd: '2025-12-31' })] })],
    { type: 'INVOICE', title: 'Facture annuelle 2025', amountCents: 42000, date: '2025-01-01' });
    await k.document(c, m.id, [cand({ ...base, sourceRoleHint: 'OTHER_EVIDENCE', summary: 'Relevé annuel 2025',
      financialHints: [fh('REALIZED_COST', 42000, { amountScope: 'TOTAL', economicDate: '2025-12-31', periodStart: '2025-01-01', periodEnd: '2025-12-31' }), fh('PAYMENT', 42000, { economicDate: '2025-12-31' })] })],
    { type: null, title: 'Relevé récapitulatif 2025', amountCents: 42000, date: '2025-12-31' });
    await k.passer(c);
    await k.passer(c);
    const t = await tcoDe(c, m.id);
    expect(t.lines.filter((l) => l.includedCents > 0).reduce((s, l) => s + l.includedCents, 0)).toBe(42000);
  });
});
