/**
 * Lot 113AC (Trello #725) — finalisation des périodes métier, PostgreSQL 16 réel. Sorties T1 SIMULÉES
 * (candidats et faits `period.*` persistés comme le fait le pipeline ; aucun appel Gemini), consolidation T3
 * réelle (sans IA), résolution D11 réelle (113AA), routes réelles (session simulée), récupération T2 réelle,
 * source des dossiers V12 réelle, file IA réelle (aucun exécutant : les travaux restent en attente).
 *
 * Jeu : une assurance habitation (une police) — attestations 2023 et 2024 qualifiées v2, avenant 2024
 * DÉCLARÉ (T1) qui actualise 2024, attestation 2025 A qualifiée et attestation 2025 B NON qualifiée qui la
 * chevauche (divergence signalée, sans question) ; une facture d'achat ponctuel sans période.
 *
 *   L113AC-E2E-01  fusion D11 → surfaces : lecture groupée = lecture par événement (113AA) ; surfaces
 *                  (`readOperationsCoverage`) = fiche ; fiche et tiroirs : statut, note, document
 *                  remplaçant, jamais `basis` ; autre compte : rien ;
 *   L113AC-E2E-02  T2 : période retenue = avenant, l'ancienne citée comme historique ; conflit A / B dit
 *                  « périodes différentes selon les justificatifs », aucune choisie ; extraits documentaires ;
 *   L113AC-E2E-03  dossiers V12 : aucune période remplacée ou en conflit présentée comme établie ;
 *   L113AC-E2E-04  liste des documents et recherche : UNE période principale par une lecture groupée,
 *                  indépendante du titre, rien si non pertinente ; autre compte isolé ;
 *   L113AC-E2E-05  requalification T1 du stock (BO) : contrat absent → simulation seule, application refusée,
 *                  aucun travail ; contrat actif → un lot mis en file (technique, non facturé), rapport
 *                  avant / après ; rejoué : jamais redemandé ; requalifié / demandé sans sortie v2 recensés ;
 *                  filtre compte ; compte non éligible écarté.
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
type Fait = [string, string, (string | null)?, (string | null)?];

const piece = (assetId: number, start: string, end: string): AnchoredOperationCandidate =>
  cand({
    typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'CONTRACT_DOCUMENT', provider: 'Assureur Habitation',
    summary: 'Assurance habitation', targetHints: [cible(assetId)],
    businessReferences: [ref('POLICY', 'POL-113AC')] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { startDate: start, endDate: end }, financialHints: [],
  });

scenario('L113AC', 'Périodes métier — finalisation (D11 sur les surfaces, listes, recherche, requalification)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(() => { k = operationsKit(sql, make); });
  afterAll(() => { session.currentAccountId = null; });
  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const surf = () => import('@/services/documents/business-period-surfaces');
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
  const faits = async (c: AccountRow, fileId: number, liste: Fait[]) => {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    for (const [key, value, attribute, rawValue] of liste) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value, raw_value, confidence, excerpt, status)
                VALUES (${c.id}, ${fileId}, ${x.id}, ${key}, ${key}, ${attribute ?? null}, ${value}, ${rawValue ?? null}, 'certain', ${`extrait ${value}`}, 'active')`;
    }
  };
  const v2 = (val: string, ...extra: Fait[]): Fait[] => [['period.relevance', 'coverage=known;contract=undetermined'], ['period.coverage', val, 'principal'], ...extra];

  let c: AccountRow; let m: { id: number }; let op: number; const d: Record<string, number> = {};
  let achat: number;

  describe('assurance : avenant déclaré et divergence non qualifiée', () => {
    beforeAll(async () => {
      c = await make.account({ plan: 'premium' });
      m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
      const deposer = async (nom: string, s: string, e: string, f: Fait[] | null) => {
        d[nom] = await k.document(c, m.id, [piece(m.id, s, e)], { type: 'INSURANCE_CERTIFICATE', title: nom });
        if (f) await faits(c, d[nom], f);
      };
      await deposer('Attestation 2023', '2023-04-01', '2024-03-31', v2('2023-04-01/2024-03-31'));
      await deposer('Attestation 2024', '2024-04-01', '2025-03-31', v2('2024-04-01/2025-03-31'));
      await deposer('Avenant 2024', '2024-06-01', '2025-03-31', v2('2024-06-01/2025-03-31', ['period.relation', 'amendment', null, 'Avenant n° 1']));
      await deposer('Attestation 2025 A', '2025-04-01', '2026-03-31', v2('2025-04-01/2026-03-31'));
      // Analysée sans le bloc 28 : couverture lue sans IA (113W), aucune qualification v2.
      await deposer('Attestation 2025 B', '2025-07-01', '2026-06-30', null);
      achat = await k.document(c, m.id, [cand({ typeHint: 'ACQUISITION', sourceRoleHint: 'INVOICE', targetHints: [cible(m.id)], temporalHints: { realizedDate: '2026-02-03' },
        financialHints: [fh('REALIZED_COST', 45900, { economicDate: '2026-02-03' })] })], { type: 'INVOICE', title: 'Facture aspirateur 2025' });
      await faits(c, achat, [['period.relevance', 'billing=not_relevant;coverage=not_relevant']]);
      await k.passer(c);
      await k.passer(c);
      op = (await k.actives(c)).filter((o) => o.type_code === 'CONTRACT').map((o) => o.id)[0];
      for (const f of [...Object.values(d), achat]) await (await svc()).refreshDocumentBusinessPeriods(c.id, f);
      await k.passer(c);
    });

    it('L113AC-E2E-01 — fusion D11 → surfaces : lecture groupée = lecture par événement ; fiche sans `basis`', async () => {
      const h = (await (await svc()).readOperationCoverageHistory(c.id, op))!;
      const statut = new Map(h.coverages.map((x) => [x.fileId, x.resolution?.status ?? 'ESTABLISHED']));
      expect(Object.fromEntries(Object.entries(d).map(([n, id]) => [n, statut.get(id)]))).toEqual({
        'Attestation 2023': 'ESTABLISHED', 'Attestation 2024': 'REPLACED', 'Avenant 2024': 'ESTABLISHED',
        'Attestation 2025 A': 'CONFLICT', 'Attestation 2025 B': 'CONFLICT',
      });
      // Lecture groupée (113AA, rendue groupée par 113AC) : MÊME résultat que la lecture par événement.
      const autre = await make.account({ plan: 'premium' });
      const groupe = await (await svc()).readOperationsCoverageHistories(c.id, [op, op, 2_000_000_000, -1]);
      expect([...groupe.keys()]).toEqual([op]);
      expect(groupe.get(op)).toEqual({ operationId: op, coverages: h.coverages });
      expect((await (await svc()).readOperationsCoverageHistories(autre.id, [op])).size).toBe(0);
      // Surfaces : plus de requête parallèle — la même résolution que la fiche.
      expect((await (await surf()).readOperationsCoverage(c.id, [op])).get(op)).toEqual(h.coverages);
      // Fiche de l'événement de référence (route) : statut, note, document remplaçant ; jamais `basis`.
      as(c);
      const { GET } = await import('@/app/api/evenements-reference/[id]/route');
      const r = await GET(new NextRequest(`http://x/api/evenements-reference/${op}`), ctx(op));
      expect(r.status).toBe(200);
      const fiche = (await r.json() as Json).reference.coverages as Json[];
      expect(fiche.find((x) => x.fileId === d['Attestation 2024'])!.resolution).toEqual({ status: 'REPLACED', byFileId: d['Avenant 2024'], note: 'Actualisée par l’avenant « Avenant 2024 »' });
      expect(fiche.find((x) => x.fileId === d['Attestation 2025 B'])!.resolution).toEqual({ status: 'CONFLICT', note: 'Les justificatifs indiquent des périodes différentes.' });
      expect(JSON.stringify(fiche)).not.toMatch(/"basis"/);
      // Tiroir du document (113W) : mêmes informations, sans `basis`.
      const { GET: periodes } = await import('@/app/api/documents/[id]/periodes/route');
      const rp = await periodes(new NextRequest(`http://x/api/documents/${d['Attestation 2024']}/periodes`), ctx(d['Attestation 2024']));
      const vue = (await rp.json() as Json).periods;
      expect(vue.coverageHistories[0].coverages.find((x: Json) => x.fileId === d['Attestation 2024']).resolution.note).toBe('Actualisée par l’avenant « Avenant 2024 »');
      expect(JSON.stringify(vue)).not.toMatch(/"basis"/);
    });

    it('L113AC-E2E-02 — T2 : avenant retenu, ancienne période en historique, conflit dit sans choisir', async () => {
      const { readContracts } = await import('@/services/verebona-assistant/canonical/operations');
      const { contractsAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
      const contrats = await readContracts(c.id, [m.id], { assetName: 'Maison' });
      const ct = contrats.find((x) => x.operationId === op)!;
      const r = contractsAnswer([ct], { assets: [], ambiguous: false, unresolved: false, label: 'Maison' });
      const etablies = r.answer.slice(r.answer.indexOf('Périodes de couverture établies'), r.answer.indexOf('Périodes différentes'));
      expect(etablies).toContain('du 01/04/2023 au 31/03/2024 (justificatif : Attestation 2023)');
      expect(etablies).toContain('du 01/06/2024 au 31/03/2025 (justificatif : Avenant 2024)');
      // Jamais une période en conflit ni une période remplacée présentée comme établie.
      expect(etablies).not.toMatch(/2025 A|2025 B|Attestation 2024\)/);
      expect(r.answer).toContain('Périodes différentes selon les justificatifs : du 01/04/2025 au 31/03/2026 (justificatif : Attestation 2025 A) ; du 01/07/2025 au 30/06/2026 (justificatif : Attestation 2025 B) — aucune n’est retenue tant que ce point n’est pas tranché');
      expect(r.answer).toContain('Historique (périodes remplacées) : du 01/04/2024 au 31/03/2025 (justificatif : Attestation 2024) — Actualisée par l’avenant « Avenant 2024 »');
      expect(r.answer).toContain('aucune prolongation n’est déduite');
      expect(r.answer).not.toMatch(/Opération|expir|en cours/i);
      expect(ct.coverageSources!.map((s) => s.id).sort()).toEqual(Object.values(d).map((id) => `doc_${id}`).sort());
      // Extraits documentaires T2 : la réserve suit la période.
      const textes = await (await surf()).documentPeriodTexts(c.id, [d['Attestation 2023'], d['Attestation 2024'], d['Attestation 2025 B'], achat]);
      expect(textes.get(d['Attestation 2023'])).toBe('Période couverte : du 01/04/2023 au 31/03/2024');
      expect(textes.get(d['Attestation 2024'])).toBe('Période couverte : du 01/04/2024 au 31/03/2025 (période remplacée : Actualisée par l’avenant « Avenant 2024 »)');
      expect(textes.get(d['Attestation 2025 B'])).toBe('Période couverte : du 01/07/2025 au 30/06/2026 (périodes différentes selon les justificatifs)');
      expect(textes.has(achat)).toBe(false);
    });

    it('L113AC-E2E-03 — dossiers V12 : aucune période remplacée ou en conflit présentée comme établie', async () => {
      await sql`UPDATE asset_files SET upload_status = 'COMPLETED' WHERE id = ANY(${[...Object.values(d), achat]})`;
      const { loadExportSource } = await import('@/services/exports/v12/data/source');
      const s = await loadExportSource({ assetId: m.id, accountId: c.id, userId: c.ownerUserId, exportType: 'DOSSIER_COMPLET' });
      const par = new Map(s.documents.map((x) => [x.id, x.periodLine ?? null]));
      expect(par.get(d['Attestation 2023'])).toBe('Période couverte : du 01/04/2023 au 31/03/2024');
      expect(par.get(d['Avenant 2024'])).toBe('Période couverte : du 01/06/2024 au 31/03/2025');
      for (const n of ['Attestation 2024', 'Attestation 2025 A', 'Attestation 2025 B']) expect(par.get(d[n])).toBeNull();
      expect(par.get(achat)).toBeNull();
    });

    it('L113AC-E2E-04 — liste des documents et recherche : une période principale, lecture groupée, isolée', async () => {
      as(c);
      const { GET } = await import('@/app/api/v2/documents/route');
      const r = await GET(new NextRequest('http://x/api/v2/documents?limit=50'));
      expect(r.status).toBe(200);
      const docs = (await r.json() as Json).documents as Json[];
      const lignes = await (await svc()).readPrincipalPeriodLines(c.id, docs.map((x) => x.id));
      for (const x of docs) expect(x.periodLine ?? null).toBe(lignes.get(x.id)?.line ?? null);
      // Indépendante du titre : « Facture aspirateur 2025 » (titre daté) n'a aucune période.
      expect(docs.find((x) => x.id === achat)).not.toHaveProperty('periodLine');
      expect(docs.find((x) => x.id === d['Avenant 2024'])!.periodLine).toBe('Période couverte : du 01/06/2024 au 31/03/2025');
      // Recherche (barre et suggestions) : même ligne pour les documents trouvés.
      const { globalSearch } = await import('@/services/search/global-search.service');
      const out = await globalSearch(c.id, 'Attestation');
      const trouves = out.results.filter((x) => x.category === 'Document');
      expect(trouves.length).toBeGreaterThan(0);
      for (const x of trouves) expect(x.periodLine ?? null).toBe(lignes.get(x.docId!)?.line ?? null);
      const { toLiveResults } = await import('@/lib/verebona/live-search');
      const live = toLiveResults('Attestation', out.results as never);
      expect(live.some((x) => x.kind === 'document' && (x.sub ?? '').includes('Période couverte : du '))).toBe(true);
      // Autre compte : aucune ligne, aucun document.
      const autre = await make.account({ plan: 'premium' });
      expect((await (await svc()).readPrincipalPeriodLines(autre.id, docs.map((x) => x.id))).size).toBe(0);
      expect((await globalSearch(autre.id, 'Attestation')).results).toEqual([]);
    });
  });

  it('L113AC-E2E-05 — requalification T1 du stock : inactive sans contrat ; par lots ; idempotente ; rapport avant / après', async () => {
    const q = await make.account({ plan: 'premium' });
    const mq = await make.asset(q, { category: 'IMMOBILIER', name: 'Maison' });
    const ancien = [] as number[];
    for (const [i, s, e] of [[1, '2022-01-01', '2022-12-31'], [2, '2023-01-01', '2023-12-31'], [3, '2024-01-01', '2024-12-31']] as const) {
      ancien.push(await k.document(q, mq.id, [piece(mq.id, s, e)], { type: 'INSURANCE_CERTIFICATE', title: `Ancienne attestation ${i}` }));
    }
    const deja = await k.document(q, mq.id, [piece(mq.id, '2025-01-01', '2025-12-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation déjà v2' });
    await faits(q, deja, v2('2025-01-01/2025-12-31'));
    const jobs = () => sql<{ target_id: string; status: string; payload: Json }[]>`
      SELECT target_id, status, payload FROM ai_job_queue WHERE account_id = ${q.id} AND treatment = 'T1' AND trigger_code = 'business-periods-v2-requalification' ORDER BY id`;
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const req = (action: 'simulate' | 'apply') => ({ script: 'business-periods-v2-requalification' as const, action, step: null, runId: null, accountId: q.id, reason: 'recette 113AC' });
    const hooks = { log: () => {}, progress: () => {} };

    // Contrat absent du prompt T1 livré (bloc 28 non collé) : simulation possible, application REFUSÉE, aucun travail.
    const sim = (await executeBackfill(sql, req('simulate'), hooks)).result as Json;
    expect(sim.availability).toMatchObject({ available: false, contractState: 'ABSENT' });
    expect(sim.before).toMatchObject({ toRequalify: 3, qualifiedOtherwise: 1, requestedPending: 0 });
    expect([...sim.batch].sort()).toEqual([...ancien].sort());
    expect(summarizeBackfill('business-periods-v2-requalification', 'simulate', null, { result: sim }).headline).toMatch(/^Simulation : 3 document\(s\) à requalifier/);
    const refus = (await executeBackfill(sql, req('apply'), hooks)).result as Json;
    expect(refus).toMatchObject({ refused: 'CONTRACT_NOT_ACTIVE', queued: [] });
    expect(await jobs()).toEqual([]);

    // Contrat actif (état simulé) : UN lot (taille 2 ici) mis en file T1, technique, non facturé.
    const { runBusinessPeriodsRequalification, defaultRequalificationDeps, availabilityFrom } = await import('@/services/documents/business-periods/requalification');
    const actif = { ...defaultRequalificationDeps(), availability: async () => availabilityFrom('SATISFIED', null) };
    const lot1 = await runBusinessPeriodsRequalification({ apply: true, accountId: q.id, sql, batchSize: 2 }, actif);
    expect(lot1.queued).toEqual(ancien.slice(0, 2));
    expect(lot1.before.toRequalify).toBe(3);
    expect(lot1.after).toMatchObject({ toRequalify: 1, requestedPending: 2 });
    const j = await jobs();
    expect(j.map((x) => Number(x.target_id))).toEqual(ancien.slice(0, 2));
    expect(j[0].payload).toMatchObject({ origin: 'business-periods-v2-requalification', billable: false, processingVisibility: 'TECHNICAL' });

    // Reprise : le lot suivant ; rejoué : jamais redemandé.
    const lot2 = await runBusinessPeriodsRequalification({ apply: true, accountId: q.id, sql, batchSize: 2 }, actif);
    expect(lot2.queued).toEqual([ancien[2]]);
    const lot3 = await runBusinessPeriodsRequalification({ apply: true, accountId: q.id, sql, batchSize: 2 }, actif);
    expect(lot3.queued).toEqual([]);
    expect((await jobs()).length).toBe(3);

    // Analyses terminées : l'une rend la sortie v2 (requalifiée), l'autre non (jamais redemandée, recensée à part).
    await faits(q, ancien[0], v2('2022-01-01/2022-12-31'));
    await sql`UPDATE ai_job_queue SET status = 'DONE' WHERE account_id = ${q.id} AND trigger_code = 'business-periods-v2-requalification' AND target_id = ANY(${[String(ancien[0]), String(ancien[1])]})`;
    const fin = await runBusinessPeriodsRequalification({ apply: false, accountId: q.id, sql }, actif);
    expect(fin.before).toEqual({ toRequalify: 0, requestedPending: 1, requestedQualified: 1, requestedWithoutV2: 1, qualifiedOtherwise: 1 });
    expect(fin.batch).toEqual([]);

    // Filtre compte : un autre compte n'est jamais touché ; compte non éligible : écarté du lot, compté.
    const r = await make.account({ plan: 'premium' });
    const mr = await make.asset(r, { category: 'IMMOBILIER', name: 'Maison' });
    const autreDoc = await k.document(r, mr.id, [piece(mr.id, '2024-01-01', '2024-12-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation autre compte' });
    const seul = await runBusinessPeriodsRequalification({ apply: false, accountId: q.id, sql }, actif);
    expect(seul.batch).not.toContain(autreDoc);
    const inelig = await runBusinessPeriodsRequalification({ apply: true, accountId: r.id, sql }, { ...actif, eligible: async () => false });
    expect(inelig).toMatchObject({ batch: [], queued: [], ineligibleAccounts: [r.id] });
    expect((await sql`SELECT 1 FROM ai_job_queue WHERE account_id = ${r.id} AND trigger_code = 'business-periods-v2-requalification'`).length).toBe(0);
    void RECETTE_TODAY;
  });
});
