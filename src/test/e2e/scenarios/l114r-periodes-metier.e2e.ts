/**
 * Carte Trello #766 (lot 114R) — périodes métier : fiabiliser faits, corrections, exports (suite de #724 / #725).
 * PostgreSQL réel ; sorties T1 et T3 SIMULÉES (aucun appel à un modèle).
 *
 *   L114R-E2E-E01   couverture et facturation de mêmes bornes : deux faits en base, une principale, la dépense
 *                   et l'Assistant retrouvent la période facturée ; reprise rejouée stable ;
 *   L114R-E2E-E04   durée indéterminée : identique sur fiche, dépense, liste / recherche, Assistant, dossier (E03) ;
 *                   corriger le début seul la conserve ; modification explicite tracée (avant / après) ; fin et
 *                   durée indéterminée incompatibles ; conservée après requalification ; E10 : fin inconnue et
 *                   durée indéterminée du même document conservées toutes les deux ;
 *   L114R-E2E-E05   deux segments, un corrigé : T1 enrichit l'autre sans toucher le premier, deux reprises ;
 *   L114R-E2E-E08   fait partagé : la correction atteint l'autre justificatif du même fait, jamais une autre
 *                   période, une facturation, un autre événement ni un autre compte ; duplicata tardif
 *                   rattaché à la correction sans question ; dossier ;
 *   L114R-E2E-E12   création d'une nature par requête forgée : refusée sans pertinence, permise si indéterminée ;
 *   L114R-E2E-E09   facture récapitulative : période propre de chaque ligne lue par la route, bornée au compte ;
 *   L114R-E2E-E06   borne manquante : ni succession, ni divergence, ni question ; réexamen T3 demandé hors lecture ;
 *   L114R-E2E-E07   429 / délai / panne / 24 h dépassées / prompt illisible : aucune question ; reprises bornées,
 *                   réarmement, contrôle de cohérence ; question seulement après une contradiction certaine ;
 *   L114R-E2E-E02   résolution en échec : la pièce reste au dossier, sans période de couverture ; conflit réel
 *                   non résolu : jamais « établi ».
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
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

type Json = Record<string, any>;
type Fait = [string, string, (string | null)?];
type Input = import('@/services/documents/business-periods/relation-contract').RelationInput;

const piece = (assetId: number, start: string | null, end: string | null, police = 'POL-114R'): AnchoredOperationCandidate =>
  cand({
    typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'CONTRACT_DOCUMENT' as never, provider: 'Assureur Habitation',
    summary: 'Assurance habitation', targetHints: [cible(assetId)],
    businessReferences: [ref('POLICY', police)] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) }, financialHints: [],
  });

/** Décideur T3 SIMULÉ : capacité à trois états, réponse (ou panne) réglable. */
function simule() {
  const etat = { mode: 'ABSENT' as 'AVAILABLE' | 'ABSENT' | 'UNREADABLE', calls: 0, answer: (_i: Input): unknown => null };
  const decider = {
    capability: async () => (etat.mode === 'AVAILABLE'
      ? { available: true, version: 'simu-v29', reason: 'AVAILABLE' as const }
      : { available: false, version: null, reason: 'CONTRACT_PENDING' as const, contractState: etat.mode === 'UNREADABLE' ? 'UNREADABLE' as const : 'BRANCH_MISSING' as const }),
    decide: async (c: { input: Input }) => { etat.calls++; return { output: etat.answer(c.input), traceId: `trace-${etat.calls}` }; },
  };
  return { etat, decider };
}

scenario('L114R', 'Périodes métier — fiabilisation pré-MEP (faits, corrections, exports) (#766)', ({ sql, make }) => {
  let k: OperationsKit;
  const sim = simule();
  beforeAll(async () => {
    k = operationsKit(sql, make);
    (await import('@/services/documents/business-periods/relation-decider')).__setRelationDeciderForTests(sim.decider);
  });
  afterEach(() => { sim.etat.mode = 'ABSENT'; sim.etat.calls = 0; sim.etat.answer = () => null; vi.restoreAllMocks(); });
  afterAll(async () => {
    session.currentAccountId = null;
    (await import('@/services/documents/business-periods/relation-decider')).__setRelationDeciderForTests(null);
  });
  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const surf = () => import('@/services/documents/business-period-surfaces');
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
  const maison = (c: AccountRow, name = 'Maison') => make.asset(c, { category: 'IMMOBILIER', name });
  const rafraichir = async (c: AccountRow, ids: number[]) => { const out = []; for (const id of ids) out.push(await (await svc()).refreshDocumentBusinessPeriods(c.id, id)); return out; };
  const faits = async (c: AccountRow, fileId: number, liste: Fait[]) => {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    for (const [key, value, attribute] of liste) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value, confidence, excerpt, status)
                VALUES (${c.id}, ${fileId}, ${x.id}, ${key}, ${key}, ${attribute ?? null}, ${value}, 'certain', ${`extrait ${value}`}, 'active')`;
    }
  };
  const v2 = (val: string): Fait[] => [['period.relevance', 'coverage=known;contract=undetermined'], ['period.coverage', val, 'principal']];
  const actives = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, period_kind AS kind, segment_index::int AS seg, start_on AS s, end_on AS e, end_open AS open, origin, user_locked AS locked, before_correction AS before
      FROM document_business_periods WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY period_kind, segment_index`;
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
  const periodesGroupees = async (c: AccountRow, query: string) => {
    as(c);
    const { GET } = await import('@/app/api/documents/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/periodes?${query}`));
    return { status: r.status, body: await r.json() as Json };
  };
  const cartes = (c: AccountRow) => sql<{ id: number; resolved_at: string | null }[]>`
    SELECT id, resolved_at::text AS resolved_at FROM to_process_actions WHERE account_id = ${c.id} AND rule_code = 'PERIOD-CONFLICT' ORDER BY id`;
  const ouvertes = async (c: AccountRow) => (await cartes(c)).filter((x) => !x.resolved_at);
  const examens = (c: AccountRow) => sql<Json[]>`
    SELECT status, relation, ai_calls::int AS ai_calls, attempts::int AS attempts, retry_at IS NOT NULL AS retry, error FROM business_period_relation_reviews WHERE account_id = ${c.id} ORDER BY id`;
  const synchroniser = async (c: AccountRow, op: number) =>
    (await import('@/services/documents/business-periods/conflict-cards')).syncPeriodConflictCards(c.id, { operationIds: [op] });
  const phase = async (c: AccountRow) => (await import('@/services/documents/business-periods/relation-review')).runPeriodRelationPhase(c.id, {});
  const contrat = async (c: AccountRow) => (await k.actives(c)).filter((o) => o.type_code === 'CONTRACT').map((o) => o.id);
  const historique = async (c: AccountRow, op: number) => (await (await svc()).readOperationCoverageHistory(c.id, op))!;
  const repondre = (relation: string) => (i: Input) => ({
    task: 'PERIOD_RELATION', relation, replacingPeriod: null, confidence: 'certain',
    evidence: [{ document: 'D2', excerpt: i.documents[1].title! }], reason: 'Réponse simulée.',
  });

  // ══ E01 ═══════════════════════════════════════════════════════════════════
  it('L114R-E2E-E01 — couverture et facturation de mêmes bornes : deux faits distincts, une seule principale, dépense et Assistant servis', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const appel = await k.document(c, m.id, [piece(m.id, '2025-01-01', '2025-12-31')], { type: 'INVOICE', title: 'Appel de cotisation 2025' });
    await faits(c, appel, [['period.coverage', '2025-01-01/2025-12-31'], ['period.billing', '2025-01-01/2025-12-31']]);
    expect((await rafraichir(c, [appel]))[0]).toMatchObject({ outcome: 'UPDATED', inserted: 2 });
    // Base : deux faits ACTIFS de natures distinctes, chacun avec SA preuve.
    const lignes = await sql<Json[]>`SELECT period_kind AS kind, start_on AS s, end_on AS e, evidence FROM document_business_periods WHERE file_id = ${appel} AND status = 'ACTIVE' ORDER BY period_kind`;
    expect(lignes.map((x) => [x.kind, x.s, x.e])).toEqual([['BILLING', '2025-01-01', '2025-12-31'], ['COVERAGE', '2025-01-01', '2025-12-31']]);
    expect(lignes[0].evidence.factIds).toHaveLength(1);
    expect(lignes[1].evidence.factIds).toHaveLength(1);
    expect(lignes[0].evidence.factIds).not.toEqual(lignes[1].evidence.factIds);
    // Fiche : UNE période principale ; la facturation est secondaire.
    const vue = await lireDoc(c, appel);
    expect(vue.principal).toMatchObject({ kind: 'COVERAGE', line: 'Période couverte : du 01/01/2025 au 31/12/2025' });
    expect(vue.principal.segments).toHaveLength(1);
    expect(vue.secondary.map((x: Json) => x.line)).toEqual(['Période facturée : du 01/01/2025 au 31/12/2025']);
    // Dépense : la période facturée est retrouvée ; liste / recherche : toujours la seule principale.
    const dep = (await periodesGroupees(c, `ids=${appel}`)).body.periods[String(appel)];
    expect(dep.billing.map((x: Json) => x.line)).toEqual(['Période facturée : du 01/01/2025 au 31/12/2025']);
    expect((await (await svc()).readPrincipalPeriodLines(c.id, [appel])).get(appel)).toEqual({ kind: 'COVERAGE', line: 'Période couverte : du 01/01/2025 au 31/12/2025' });
    // Assistant : les deux faits, chacun sous son nom.
    expect((await (await surf()).documentPeriodTexts(c.id, [appel])).get(appel))
      .toBe('Période couverte : du 01/01/2025 au 31/12/2025 · Période facturée : du 01/01/2025 au 31/12/2025');
    // Reprise rejouée : stable (aucun doublon).
    expect((await rafraichir(c, [appel, appel])).map((r) => r.outcome)).toEqual(['UNCHANGED', 'UNCHANGED']);
    expect(await actives(appel)).toHaveLength(2);
    // Corriger la période facturée ne touche pas la couverture.
    const idFact = dep.billing[0].id;
    expect((await corriger(c, appel, { periodId: idFact, start: '2025-01-01', end: '2025-06-30' })).status).toBe(200);
    expect((await lireDoc(c, appel)).principal.line).toBe('Période couverte : du 01/01/2025 au 31/12/2025');
  });

  // ══ E03 / E04 / E10 ═══════════════════════════════════════════════════════
  it('L114R-E2E-E04 — durée indéterminée : même libellé partout ; début seul corrigé : conservée ; modification explicite tracée', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const police = await k.document(c, m.id, [piece(m.id, '2026-01-01', null)], { type: 'INSURANCE_CERTIFICATE', title: 'Police habitation' });
    await faits(c, police, v2('2026-01-01/INDEFINITE'));
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED' WHERE id = ${police}`;
    await rafraichir(c, [police]);
    const LIGNE = 'Début de couverture : 01/01/2026 (durée indéterminée)';
    const partout = async (attendu: string) => {
      expect((await lireDoc(c, police)).principal.line).toBe(attendu);
      const groupe = (await periodesGroupees(c, `ids=${police}`)).body.periods[String(police)];
      expect(groupe.principal.line).toBe(attendu);
      expect((await (await svc()).readPrincipalPeriodLines(c.id, [police])).get(police)?.line).toBe(attendu);
      expect((await (await surf()).documentPeriodTexts(c.id, [police])).get(police)).toContain(attendu);
      expect((await (await surf()).dossierPeriodLines(c.id, [police])).get(police)).toBe(attendu);
      const { loadExportSource } = await import('@/services/exports/v12/data/source');
      const s = await loadExportSource({ assetId: m.id, accountId: c.id, userId: c.ownerUserId, exportType: 'DOSSIER_COMPLET' });
      expect(s.documents.find((x) => x.id === police)?.periodLine).toBe(attendu);
      return groupe;
    };
    const g0 = await partout(LIGNE);
    expect(g0.principal.segments[0]).toMatchObject({ openEnded: true, end: null });
    const id0 = g0.principal.segments[0].id;

    // Début seul corrigé (aucune mention de la durée) : l'indétermination est CONSERVÉE, l'avant est tracé.
    const r1 = await corriger(c, police, { periodId: id0, start: '2026-02-01', end: null });
    expect(r1.status).toBe(200);
    expect((await r1.json() as Json).period).toMatchObject({ openEnded: true, line: 'Début de couverture : 01/02/2026 (durée indéterminée)' });
    const [a1] = await actives(police);
    expect(a1).toMatchObject({ s: '2026-02-01', e: null, open: true, origin: 'USER', locked: true });
    expect(a1.before).toMatchObject({ start: '2026-01-01', end: null, openEnded: true, origin: 'T1' });
    await partout('Début de couverture : 01/02/2026 (durée indéterminée)');
    // Requalification après correction : rien n'est réécrit.
    expect((await rafraichir(c, [police]))[0]).toMatchObject({ outcome: 'UNCHANGED', protectedKinds: ['COVERAGE'] });

    // Modification EXPLICITE : fin inconnue (≠ durée indéterminée) — tracée avant / après.
    expect((await corriger(c, police, { periodId: a1.id, start: '2026-02-01', end: null, openEnded: false })).status).toBe(200);
    const [a2] = await actives(police);
    expect(a2).toMatchObject({ s: '2026-02-01', e: null, open: false, locked: true });
    expect(a2.before).toMatchObject({ start: '2026-02-01', openEnded: true, origin: 'USER' });
    await partout('Début de couverture : 01/02/2026');
    // Fin inconnue conservée telle quelle si la correction n'en dit rien (jamais transformée en durée indéterminée).
    expect((await corriger(c, police, { periodId: a2.id, start: '2026-02-02', end: null })).status).toBe(200);
    const [a3] = await actives(police);
    expect(a3).toMatchObject({ s: '2026-02-02', open: false });
    // Retour explicite à la durée indéterminée ; puis incompatibilités refusées sans écriture.
    expect((await corriger(c, police, { periodId: a3.id, start: '2026-02-02', end: null, openEnded: true })).status).toBe(200);
    const [a4] = await actives(police);
    expect(a4).toMatchObject({ open: true });
    expect((await corriger(c, police, { periodId: a4.id, start: '2026-02-02', end: '2026-12-31', openEnded: true })).status).toBe(400);
    expect((await corriger(c, police, { periodId: a4.id, start: '2026-02-02', end: null, openEnded: 'oui' })).status).toBe(400);
    expect((await actives(police))[0].id).toBe(a4.id);
    // Une date de fin saisie retire l'indétermination (jamais les deux).
    expect((await corriger(c, police, { periodId: a4.id, start: '2026-02-02', end: '2026-12-31' })).status).toBe(200);
    expect((await actives(police))[0]).toMatchObject({ e: '2026-12-31', open: false });
    await partout('Période couverte : du 02/02/2026 au 31/12/2026');

    // E10 : un document qui porte les deux interprétations les conserve toutes les deux (deux segments).
    const courrier = await k.document(c, m.id, [piece(m.id, '2027-01-01', null, 'POL-114R-B')], { type: 'INSURANCE_CERTIFICATE', title: 'Courrier ambigu' });
    await faits(c, courrier, [['period.relevance', 'coverage=known'], ['period.coverage', '2027-01-01/'], ['period.coverage', '2027-01-01/INDEFINITE']]);
    await rafraichir(c, [courrier]);
    expect((await actives(courrier)).map((x) => [x.seg, x.s, x.e, x.open])).toEqual([[0, '2027-01-01', null, false], [1, '2027-01-01', null, true]]);
    const vc = await lireDoc(c, courrier);
    expect(vc.principal.line).toBe('Plusieurs périodes concernées');
    expect(vc.principal.segments.map((x: Json) => x.line)).toEqual(['Début de couverture : 01/01/2027', 'Début de couverture : 01/01/2027 (durée indéterminée)']);
    expect((await rafraichir(c, [courrier]))[0].outcome).toBe('UNCHANGED');
  });

  // ══ E05 ═══════════════════════════════════════════════════════════════════
  it('L114R-E2E-E05 — deux segments, un corrigé : T1 enrichit l’autre sans écraser le premier, même après deux reprises', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const q = await k.document(c, m.id, [piece(m.id, null, null)], { type: 'INSURANCE_CERTIFICATE', title: 'Relevé de couvertures' });
    await faits(c, q, [['period.coverage', '2025-01-01/2025-03-31'], ['period.coverage', '2025-07-01/2025-09-30']]);
    await rafraichir(c, [q]);
    const [s0, s1] = await actives(q);
    expect([s0.seg, s1.seg]).toEqual([0, 1]);
    expect((await corriger(c, q, { periodId: s0.id, start: '2025-01-15', end: '2025-03-31' })).status).toBe(200);
    // Nouveau justificatif de T1 : un troisième segment, et le deuxième est prolongé.
    await sql`UPDATE document_facts SET normalized_value = '2025-07-01/2025-09-15' WHERE file_id = ${q} AND normalized_value = '2025-07-01/2025-09-30'`;
    await faits(c, q, [['period.coverage', '2025-10-01/2025-12-31']]);
    expect((await rafraichir(c, [q]))[0]).toMatchObject({ outcome: 'UPDATED', inserted: 2, superseded: 1, protectedKinds: ['COVERAGE'] });
    const apres = await actives(q);
    expect(apres.map((x) => [x.seg, x.s, x.e, x.origin, x.locked])).toEqual([
      [0, '2025-01-15', '2025-03-31', 'USER', true], [1, '2025-07-01', '2025-09-15', 'T1', false], [2, '2025-10-01', '2025-12-31', 'T1', false],
    ]);
    // Deux reprises de plus : rien ne bouge, aucun doublon ; le fait de T1 d'origine (01/01) n'est jamais réinséré.
    expect((await rafraichir(c, [q, q])).map((r) => r.outcome)).toEqual(['UNCHANGED', 'UNCHANGED']);
    expect((await actives(q)).map((x) => x.id)).toEqual(apres.map((x) => x.id));
    // Contrôle de cohérence du stock : aucun écart à réparer.
    const r = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r.results['COH-DOC-BUSINESS-PERIODS']?.REPAIRED ?? 0).toBe(0);
    // Un segment retiré par T1 est retiré ; la décision de l'utilisateur reste.
    await sql`DELETE FROM document_facts WHERE file_id = ${q} AND normalized_value = '2025-10-01/2025-12-31'`;
    expect((await rafraichir(c, [q]))[0]).toMatchObject({ outcome: 'UPDATED', superseded: 1, inserted: 0 });
    expect((await actives(q)).map((x) => [x.seg, x.locked])).toEqual([[0, true], [1, false]]);
    expect((await lireDoc(c, q)).principal.line).toBe('Plusieurs périodes concernées');
  });

  // ══ E08 ═══════════════════════════════════════════════════════════════════
  it('L114R-E2E-E08 — fait partagé : la correction atteint l’autre justificatif du même fait, et rien d’autre', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const appart = await maison(c, 'Appartement');
    const d1 = await k.document(c, m.id, [piece(m.id, '2024-04-01', '2025-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2024' });
    const d2 = await k.document(c, m.id, [piece(m.id, '2024-04-01', '2025-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2024 (copie)' });
    const d3 = await k.document(c, m.id, [piece(m.id, '2025-04-01', '2026-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2025' });
    // Même bornes, autre NATURE (cotisation annuelle) et autre ÉVÉNEMENT (autre police, autre bien) : jamais touchés.
    const cotisation = await k.document(c, m.id, [piece(m.id, '2024-04-01', '2025-03-31')], { type: 'INVOICE', title: 'Cotisation annuelle 2024' });
    const autre = await k.document(c, appart.id, [piece(appart.id, '2024-04-01', '2025-03-31', 'POL-APPART')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation appartement 2024' });
    for (const [f, val] of [[d1, '2024-04-01/2025-03-31'], [d2, '2024-04-01/2025-03-31'], [d3, '2025-04-01/2026-03-31'], [autre, '2024-04-01/2025-03-31']] as const) await faits(c, f, v2(val));
    await faits(c, cotisation, [['period.relevance', 'billing=known;coverage=not_relevant'], ['period.billing', '2024-04-01/2025-03-31']]);
    await k.passer(c);
    await k.passer(c);
    await rafraichir(c, [d1, d2, d3, cotisation, autre]);
    await k.passer(c);
    const ops = await contrat(c);
    expect(ops).toHaveLength(2);
    const [{ operation_id: opId }] = await sql<{ operation_id: string }[]>`SELECT operation_id FROM business_operation_documents WHERE file_id = ${d1} AND active LIMIT 1`;
    const op = Number(opId);
    const h0 = await historique(c, op);
    expect(h0.coverages.map((x) => [x.fileId, x.line, (x.otherSources ?? []).map((o) => o.fileId)])).toEqual([
      [d1, 'Période couverte : du 01/04/2024 au 31/03/2025', [d2]], [d3, 'Période couverte : du 01/04/2025 au 31/03/2026', []],
    ]);

    // Correction depuis la copie (la fiche de l'événement corrige par le justificatif de la ligne).
    const [p2] = await actives(d2);
    const [p1Avant] = await actives(d1);
    const r = await corriger(c, d2, { periodId: p2.id, start: '2024-04-02', end: '2025-03-31' });
    expect(r.status).toBe(200);
    // L'autre justificatif du MÊME fait suit, avec la trace de l'origine ; il est protégé.
    const [p1] = await actives(d1);
    expect(p1).toMatchObject({ s: '2024-04-02', e: '2025-03-31', origin: 'USER', locked: true });
    expect(p1.before).toMatchObject({ start: '2024-04-01', end: '2025-03-31', origin: 'T1', sharedFrom: { fileId: d2, periodId: p2.id } });
    expect((await sql`SELECT status FROM document_business_periods WHERE id = ${p1Avant.id}`)[0].status).toBe('SUPERSEDED');
    // Rien d'autre : autre année, facturation de mêmes bornes, autre événement de référence.
    expect((await actives(d3))[0]).toMatchObject({ s: '2025-04-01', origin: 'T1', locked: false });
    expect((await actives(cotisation))[0]).toMatchObject({ kind: 'BILLING', s: '2024-04-01', e: '2025-03-31', origin: 'T1', locked: false });
    expect((await actives(autre))[0]).toMatchObject({ s: '2024-04-01', origin: 'T1', locked: false });
    // Un seul fait dans l'historique, deux sources, aucune question.
    const h1 = await historique(c, op);
    expect(h1.coverages.map((x) => [x.line, x.userCorrected, (x.otherSources ?? []).length, x.resolution?.status ?? null])).toEqual([
      ['Période couverte : du 02/04/2024 au 31/03/2025', true, 1, null], ['Période couverte : du 01/04/2025 au 31/03/2026', false, 0, null],
    ]);
    expect(await ouvertes(c)).toEqual([]);
    for (const f of [d1, d2]) expect((await lireDoc(c, f)).principal.line).toBe('Période couverte : du 02/04/2024 au 31/03/2025');
    // Réanalyse des deux : les deux restent corrigés (protection après réanalyse).
    expect((await rafraichir(c, [d1, d2])).map((x) => x.outcome)).toEqual(['UNCHANGED', 'UNCHANGED']);
    // Nouvelle correction depuis l'AUTRE justificatif : le fait reste commun.
    expect((await corriger(c, d1, { periodId: p1.id, start: '2024-04-03', end: '2025-03-31' })).status).toBe(200);
    expect((await actives(d2))[0]).toMatchObject({ s: '2024-04-03', locked: true });

    // Duplicata reçu APRÈS la correction, encore à l'ancienne valeur : rattaché à la correction, sans question.
    const d4 = await k.document(c, m.id, [piece(m.id, '2024-04-03', '2025-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2024 (renvoi)' });
    await faits(c, d4, v2('2024-04-02/2025-03-31'));
    await k.passer(c);
    await k.passer(c);
    await rafraichir(c, [d4]);
    await k.passer(c);
    const h2 = await historique(c, op);
    const tardif = h2.coverages.find((x) => x.fileId === d4)!;
    expect(tardif.resolution).toMatchObject({ status: 'REPLACED', note: 'Remplacée par votre correction sur « Attestation 2024 »' });
    expect((await actives(d4))[0]).toMatchObject({ s: '2024-04-02', origin: 'T1', locked: false });
    expect(await ouvertes(c)).toEqual([]);
    // Dossier : la période corrigée est publiée ; la période remplacée ne l'est pas (la pièce reste).
    const rapport = await (await surf()).dossierPeriodReport(c.id, [d1, d2, d3, d4]);
    expect(rapport.lines.get(d1)).toBe('Période couverte : du 03/04/2024 au 31/03/2025');
    expect(rapport.omitted).toEqual([{ fileId: d4, cause: 'REPLACED' }]);
    expect(rapport.resolution).toEqual({ state: 'RESOLVED', cause: null });
    // Autre compte : rien n'existe pour lui.
    const etranger = await make.account({ plan: 'premium' });
    expect((await corriger(etranger, d1, { periodId: (await actives(d1))[0].id, start: null, end: null })).status).toBe(404);
    expect((await actives(d2))[0]).toMatchObject({ s: '2024-04-03' });
  });

  // ══ E12 ═══════════════════════════════════════════════════════════════════
  it('L114R-E2E-E12 — création d’une nature par requête forgée : refusée sans pertinence ; permise si T1 l’a laissée indéterminée', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const achat = (titre: string) => k.document(c, m.id, [cand({ typeHint: 'ACQUISITION', sourceRoleHint: 'INVOICE', targetHints: [cible(m.id)], temporalHints: { realizedDate: '2026-02-03' },
      financialHints: [fh('REALIZED_COST', 45900, { economicDate: '2026-02-03' })] })], { type: 'INVOICE', title: titre });
    const qualifie = await achat('Facture lave-linge');
    await faits(c, qualifie, [['period.relevance', 'billing=not_relevant;coverage=not_relevant;warranty=undetermined']]);
    const brut = await achat('Facture aspirateur');
    await rafraichir(c, [qualifie, brut]);
    expect(await actives(qualifie)).toEqual([]);
    // T1 a dit « non pertinente » : refus, rien d'écrit.
    const refus = await corriger(c, qualifie, { kind: 'BILLING', start: '2026-02-01', end: '2026-02-28' });
    expect(refus.status).toBe(422);
    expect((await refus.json() as Json).message).toBe('Cette période ne s’applique pas à ce document.');
    expect((await corriger(c, qualifie, { kind: 'COVERAGE', start: '2026-02-03', end: null, openEnded: true })).status).toBe(422);
    // Document non qualifié, achat ponctuel : aucun champ ne peut être fabriqué.
    for (const kind of ['BILLING', 'COVERAGE', 'WARRANTY', 'CONTRACT']) expect((await corriger(c, brut, { kind, start: '2026-02-03', end: null })).status).toBe(422);
    expect(await actives(brut)).toEqual([]);
    expect((await sql`SELECT 1 FROM document_business_periods WHERE file_id = ANY(${[qualifie, brut]})`).length).toBe(0);
    // Nature inconnue ou requête sans nature : 400. Autre compte : 404. Lecture seule : 403.
    expect((await corriger(c, qualifie, { kind: 'GARANTIE', start: '2026-02-03', end: null })).status).toBe(400);
    expect((await corriger(c, qualifie, { start: '2026-02-03', end: null })).status).toBe(400);
    const etranger = await make.account({ plan: 'premium' });
    expect((await corriger(etranger, qualifie, { kind: 'WARRANTY', start: '2026-02-03', end: '2028-02-02' })).status).toBe(404);
    const lecture = await make.account({ plan: null });
    const ml = await maison(lecture);
    const fl = await k.document(lecture, ml.id, [piece(ml.id, '2025-01-01', '2025-12-31', 'POL-L')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation' });
    expect((await corriger(lecture, fl, { kind: 'WARRANTY', start: '2026-01-01', end: null })).status).toBe(403);
    // T1 l'a laissée INDÉTERMINÉE : l'utilisateur peut l'établir (une fois ; ensuite c'est une correction du fait).
    const ok = await corriger(c, qualifie, { kind: 'WARRANTY', start: '2026-02-03', end: '2028-02-02' });
    expect(ok.status).toBe(200);
    expect(await actives(qualifie)).toEqual([expect.objectContaining({ kind: 'WARRANTY', s: '2026-02-03', e: '2028-02-02', origin: 'USER', locked: true, before: null })]);
    expect((await corriger(c, qualifie, { kind: 'WARRANTY', start: '2026-02-04', end: null })).status).toBe(404);
    expect((await rafraichir(c, [qualifie]))[0].outcome).toBe('UNCHANGED');
  });

  // ══ E09 ═══════════════════════════════════════════════════════════════════
  it('L114R-E2E-E09 — facture récapitulative : période propre de chaque ligne lue par la route, bornée au compte', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const mois: Array<[string, string]> = [['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31']];
    const recap = await k.document(c, m.id, [cand({
      typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Assureur Habitation', summary: 'Relevé trimestriel', targetHints: [cible(m.id)],
      businessReferences: [ref('POLICY', 'POL-114R'), ref('INVOICE', 'F-RECAP')] as AnchoredOperationCandidate['businessReferences'],
      temporalHints: { startDate: '2026-01-01', endDate: '2026-03-31' },
      financialHints: [
        ...mois.map(([s, e]) => fh('REALIZED_COST', 3500, { amountScope: 'INSTALLMENT' as never, economicDate: '2026-04-05', periodStart: s, periodEnd: e })),
        fh('REALIZED_COST', 900, { amountScope: 'INSTALLMENT' as never, economicDate: '2026-04-05' }),
      ],
    })], { type: 'INVOICE', title: 'Relevé de cotisations T1 2026' });
    await faits(c, recap, mois.map(([s, e]): Fait => ['period.billing', `${s}/${e}`]));
    await rafraichir(c, [recap]);
    const [candidat] = await sql<{ id: number }[]>`SELECT id::int AS id FROM document_operation_candidates WHERE file_id = ${recap} AND status = 'ACTIVE' ORDER BY id LIMIT 1`;
    const ligne = (i: number | string) => `doc:${recap}:${candidat.id}:${i}`;
    // Document : les trois périodes restent visibles (« Plusieurs périodes concernées »).
    const r = await periodesGroupees(c, `ids=${recap}&lignes=${[0, 1, 2, 3].map(ligne).join(',')}`);
    expect(r.status).toBe(200);
    const billing = r.body.periods[String(recap)].billing as Json[];
    expect(billing.map((x) => x.line)).toEqual(['Période facturée : du 01/01/2026 au 31/01/2026', 'Période facturée : du 01/02/2026 au 28/02/2026', 'Période facturée : du 01/03/2026 au 31/03/2026']);
    expect(r.body.periods[String(recap)].principal.line).toBe('Plusieurs périodes concernées');
    // Chaque ligne a SA période ; la ligne sans période propre n'en reçoit aucune.
    expect(r.body.linePeriods).toEqual({
      [ligne(0)]: { start: '2026-01-01', end: '2026-01-31' }, [ligne(1)]: { start: '2026-02-01', end: '2026-02-28' }, [ligne(2)]: { start: '2026-03-01', end: '2026-03-31' },
    });
    const { expenseBillingPeriods } = await import('@/lib/documents/business-periods');
    expect([0, 1, 2].map((i) => expenseBillingPeriods(billing as never[], r.body.linePeriods[ligne(i)]).periods.map((p: Json) => p.id))).toEqual(billing.map((b) => [b.id]));
    expect(expenseBillingPeriods(billing as never[], r.body.linePeriods[ligne(3)])).toEqual({ periods: [], undetermined: true });
    // Requêtes forgées : forme inconnue refusée ; ligne d'un autre compte : absente.
    expect((await periodesGroupees(c, `lignes=${ligne('net')}`)).status).toBe(400);
    expect((await periodesGroupees(c, 'lignes=c:1;DROP')).status).toBe(400);
    expect((await periodesGroupees(c, '')).status).toBe(400);
    const etranger = await make.account({ plan: 'premium' });
    expect((await periodesGroupees(etranger, `ids=${recap}&lignes=${ligne(0)}`)).body).toEqual({ periods: {}, linePeriods: {} });
    // Composantes financières consolidées : même lecture, par identifiant de composante.
    await k.passer(c);
    await k.passer(c);
    const comps = await sql<{ id: string; s: string | null; e: string | null }[]>`
      SELECT id, period_start::text AS s, period_end::text AS e FROM business_operation_financial_components WHERE account_id = ${c.id} AND active ORDER BY id`;
    const parComposante = (await periodesGroupees(c, `lignes=${comps.map((x) => `c:${x.id}`).join(',') || 'c:1'}`)).body.linePeriods as Json;
    for (const x of comps) expect(parComposante[`c:${x.id}`] ?? null).toEqual(x.s || x.e ? { start: x.s, end: x.e } : null);
    if (comps.length) expect((await periodesGroupees(etranger, `lignes=c:${comps[0].id}`)).body.linePeriods).toEqual({});
  });

  // ══ E06 ═══════════════════════════════════════════════════════════════════
  it('L114R-E2E-E06 — borne manquante : ni succession affirmée, ni divergence, ni question ; réexamen T3 demandé hors lecture', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const a = await k.document(c, m.id, [piece(m.id, '2025-04-01', '2026-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation habitation 2025' });
    const b = await k.document(c, m.id, [piece(m.id, '2025-07-01', null)], { type: 'INSURANCE_CERTIFICATE', title: 'Courrier : garantie à compter du 01/07/2025' });
    await faits(c, a, v2('2025-04-01/2026-03-31'));
    await faits(c, b, v2('2025-07-01/'));
    await k.passer(c);
    await k.passer(c);
    await rafraichir(c, [a, b]);
    await k.passer(c);
    const [op] = await contrat(c);
    // Sans le bloc 29 : les deux couvertures restent établies avec leur preuve ; aucune question, aucune demande.
    const res0 = await (await svc()).operationPeriodResolution(sql, c.id, op);
    expect(res0.coverages.map((x) => [x.fileId, x.line, x.resolution ?? null])).toEqual([
      [a, 'Période couverte : du 01/04/2025 au 31/03/2026', null], [b, 'Début de couverture : 01/07/2025', null],
    ]);
    expect(res0.conflicts).toEqual([]);
    expect(res0.uncertain).toEqual([expect.objectContaining({ fileIds: [a, b], needsUser: false, review: 'NONE' })]);
    expect(await ouvertes(c)).toEqual([]);
    expect(await examens(c)).toEqual([]);
    // Bloc 29 actif : réexamen DEMANDÉ (aucun appel à la synchronisation ni à la consultation), toujours aucune question.
    sim.etat.mode = 'AVAILABLE';
    expect(await synchroniser(c, op)).toMatchObject({ created: 0, reviewsRequested: 1 });
    await lireDoc(c, a);
    await historique(c, op);
    expect(sim.etat.calls).toBe(0);
    expect(await examens(c)).toEqual([expect.objectContaining({ status: 'PENDING', ai_calls: 0 })]);
    expect((await synchroniser(c, op)).reviewsRequested ?? 0).toBe(0);
    // T3 s'abstient : l'ordre reste non prouvé — aucune question (ce n'est pas une contradiction qualifiée).
    sim.etat.answer = (i) => ({ ...repondre('ABSTAIN')(i), evidence: [] });
    expect((await phase(c)).outcomes).toEqual({ ABSTAINED: 1 });
    expect(await ouvertes(c)).toEqual([]);
    const res1 = await (await svc()).operationPeriodResolution(sql, c.id, op);
    expect([res1.conflicts, res1.uncertain.map((x) => x.review)]).toEqual([[], ['EXAMINED']]);
    // Une paire déjà examinée n'est jamais renvoyée.
    expect((await phase(c)).aiCalls).toBe(0);
    expect(sim.etat.calls).toBe(1);
  });

  // ══ E07 ═══════════════════════════════════════════════════════════════════
  it('L114R-E2E-E07 — panne, quota, délai, 24 h dépassées, prompt illisible : aucun faux arbitrage ; question seulement après une contradiction certaine', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const a = await k.document(c, m.id, [piece(m.id, '2025-04-01', '2026-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation habitation 2025' });
    const b = await k.document(c, m.id, [piece(m.id, '2025-07-01', '2026-06-30')], { type: 'INSURANCE_CERTIFICATE', title: 'Courrier : la période de garantie est modifiée' });
    await faits(c, a, v2('2025-04-01/2026-03-31'));
    await faits(c, b, v2('2025-07-01/2026-06-30'));
    await k.passer(c);
    await k.passer(c);
    await rafraichir(c, [a, b]);
    await k.passer(c);
    const [op] = await contrat(c);
    // Bloc 29 absent (configuration) : comportement 113AA conservé — question pour deux documents qualifiés.
    expect(await ouvertes(c)).toHaveLength(1);
    // Bloc 29 actif : réexamen demandé, question retirée en attendant.
    sim.etat.mode = 'AVAILABLE';
    expect(await synchroniser(c, op)).toMatchObject({ reviewsRequested: 1, closed: 1 });
    expect(await ouvertes(c)).toEqual([]);

    // Prompt T3 ILLISIBLE (incident) : la demande reste en attente — ni clôture « indisponible », ni question.
    sim.etat.mode = 'UNREADABLE';
    expect(await phase(c)).toMatchObject({ processed: 0, aiCalls: 0, unavailable: 'UNREADABLE' });
    expect(await examens(c)).toEqual([expect.objectContaining({ status: 'PENDING' })]);
    expect(await synchroniser(c, op)).toMatchObject({ created: 0 });
    expect(await ouvertes(c)).toEqual([]);

    // Pannes successives (429, délai dépassé, 403) : essais bornés, jamais de question.
    sim.etat.mode = 'AVAILABLE';
    const pannes = ['429 Too Many Requests (quota)', 'timeout of 60000ms exceeded', '403 Forbidden'];
    for (const [i, message] of pannes.entries()) {
      sim.etat.answer = () => { throw new Error(message); };
      expect((await phase(c)).outcomes).toEqual({ AI_FAILED: 1 });
      const [x] = await examens(c);
      expect(x).toMatchObject({ status: 'AI_FAILED', attempts: i + 1, ai_calls: i + 1, retry: i < 2 });
      expect(String(x.error)).toContain(message.slice(0, 10));
      expect(await ouvertes(c)).toEqual([]);
      // Nouvel essai seulement à son échéance.
      expect((await phase(c)).aiCalls).toBe(0);
      await sql`UPDATE business_period_relation_reviews SET retry_at = now() - interval '1 minute' WHERE account_id = ${c.id} AND retry_at IS NOT NULL`;
    }
    // Essais épuisés : plus aucun appel ; 24 h (et 30 jours) dépassées : toujours aucune question.
    expect((await phase(c)).aiCalls).toBe(0);
    expect(sim.etat.calls).toBe(3);
    await sql`UPDATE business_period_relation_reviews SET requested_at = now() - interval '30 days' WHERE account_id = ${c.id}`;
    expect(await synchroniser(c, op)).toMatchObject({ created: 0 });
    expect(await ouvertes(c)).toEqual([]);
    // La divergence n'est pas masquée : visible sur la fiche, sans « question posée ».
    const h = await historique(c, op);
    expect(h.coverages.map((x) => [x.resolution?.status, x.resolution?.pendingQuestion ?? false, x.resolution?.note])).toEqual([
      ['CONFLICT', false, 'Les justificatifs indiquent des périodes différentes.'], ['CONFLICT', false, 'Les justificatifs indiquent des périodes différentes.'],
    ]);
    // Dossier : jamais « établie ».
    expect((await (await surf()).dossierPeriodReport(c.id, [a, b])).omitted).toEqual([{ fileId: a, cause: 'CONFLICT' }, { fileId: b, cause: 'CONFLICT' }]);
    // Contrôle de cohérence : aucune carte créée par le contrôle ; réarmement refusé avant le délai.
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(await ouvertes(c)).toEqual([]);
    expect(await examens(c)).toEqual([expect.objectContaining({ status: 'AI_FAILED', attempts: 3 })]);
    // Délai de réarmement passé : nouveau cycle borné (demande en attente, compteur d'essais remis, total conservé).
    await sql`UPDATE business_period_relation_reviews SET updated_at = now() - interval '25 hours' WHERE account_id = ${c.id}`;
    expect(await synchroniser(c, op)).toMatchObject({ created: 0, reviewsRearmed: 1 });
    expect(await examens(c)).toEqual([expect.objectContaining({ status: 'PENDING', attempts: 0, ai_calls: 3 })]);
    expect(await ouvertes(c)).toEqual([]);

    // Retour à la normale : T3 travaille et conclut à une contradiction CERTAINE → la question, et seulement là.
    sim.etat.answer = repondre('CONTRADICTION');
    expect((await phase(c)).outcomes).toEqual({ DECIDED_CONTRADICTION: 1 });
    expect(await ouvertes(c)).toHaveLength(1);
    expect((await historique(c, op)).coverages.every((x) => x.resolution?.pendingQuestion === true)).toBe(true);

    // Plafond total d'appels : au-delà, plus de réarmement (blocage signalé, toujours sans question).
    const d = await make.account({ plan: 'premium' });
    const md = await maison(d);
    const a2 = await k.document(d, md.id, [piece(md.id, '2025-04-01', '2026-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2025' });
    const b2 = await k.document(d, md.id, [piece(md.id, '2025-07-01', '2026-06-30')], { type: 'INSURANCE_CERTIFICATE', title: 'Courrier' });
    await faits(d, a2, v2('2025-04-01/2026-03-31'));
    await faits(d, b2, v2('2025-07-01/2026-06-30'));
    await k.passer(d);
    await k.passer(d);
    await rafraichir(d, [a2, b2]);
    await k.passer(d);
    const [op2] = await contrat(d);
    sim.etat.mode = 'AVAILABLE';
    await synchroniser(d, op2);
    const { PERIOD_RELATION_MAX_TOTAL_CALLS } = await import('@/services/documents/business-periods/relation-review');
    await sql`UPDATE business_period_relation_reviews SET status = 'AI_FAILED', attempts = 3, ai_calls = ${PERIOD_RELATION_MAX_TOTAL_CALLS}, retry_at = NULL,
                     updated_at = now() - interval '3 days', requested_at = now() - interval '9 days' WHERE account_id = ${d.id}`;
    expect((await synchroniser(d, op2)).reviewsRearmed ?? 0).toBe(0);
    expect(await ouvertes(d)).toEqual([]);
    const coh = await runCoherenceFor(sql, [d.id], { today: RECETTE_TODAY });
    expect(coh.results['COH-OPS-PERIOD-RESOLUTION']?.FINDING ?? 0).toBe(1);
    expect(await ouvertes(d)).toEqual([]);
  });

  // ══ E02 ═══════════════════════════════════════════════════════════════════
  it('L114R-E2E-E02 — résolution en échec : la pièce reste au dossier sans période de couverture ; jamais « établie » à tort', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const att = await k.document(c, m.id, [piece(m.id, '2025-04-01', '2026-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation 2025' });
    const fact = await k.document(c, m.id, [piece(m.id, '2025-04-01', '2025-04-30')], { type: 'INVOICE', title: 'Cotisation avril 2025' });
    await faits(c, att, v2('2025-04-01/2026-03-31'));
    await faits(c, fact, [['period.relevance', 'billing=known;coverage=not_relevant'], ['period.billing', '2025-04-01/2025-04-30']]);
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED' WHERE id = ANY(${[att, fact]})`;
    await k.passer(c);
    await k.passer(c);
    await rafraichir(c, [att, fact]);
    await k.passer(c);
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const { mapDossierComplet } = await import('@/services/exports/v12/data/mappers/dossier-complet');
    const dossier = async () => {
      const s = await loadExportSource({ assetId: m.id, accountId: c.id, userId: c.ownerUserId, exportType: 'DOSSIER_COMPLET' });
      const plan = { documents: s.documents.map((doc) => ({ doc, mode: 'PDF' })), photos: [], events: new Set<string>(), sections: {}, excluded: [] };
      const data = mapDossierComplet({ source: s, plan, resolved: null, meta: { preparedBy: 'x', label: 'Dossier' }, today: RECETTE_TODAY } as never);
      // `details` : ce que le gabarit du dossier affiche réellement sous chaque pièce.
      return { ids: s.documents.map((x) => x.id), lignes: new Map(s.documents.map((x) => [x.id, x.periodLine ?? null])), pieces: data.documents!.length, details: data.documents!.map((x) => x.detail ?? null) };
    };
    // Résolution lue : la couverture, sans conflit, est publiée.
    const ok = await dossier();
    expect(ok.lignes.get(att)).toBe('Période couverte : du 01/04/2025 au 31/03/2026');
    expect(ok.lignes.get(fact)).toBe('Période facturée : du 01/04/2025 au 30/04/2025');
    expect(ok.details).toEqual(expect.arrayContaining(['Période couverte : du 01/04/2025 au 31/03/2026', 'Période facturée : du 01/04/2025 au 30/04/2025']));

    // Résolution en ÉCHEC (erreur SQL / délai) : la pièce reste, la couverture n'est pas affirmée ; la facturation l'est.
    const service = await svc();
    const journal = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const panne = vi.spyOn(service, 'operationsPeriodResolution').mockRejectedValue(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    const rapport = await (await surf()).dossierPeriodReport(c.id, [att, fact]);
    expect(panne).toHaveBeenCalledTimes(2); // un nouvel essai
    expect(rapport.resolution).toEqual({ state: 'UNAVAILABLE', cause: 'READ_FAILED' });
    expect(rapport.omitted).toEqual([{ fileId: att, cause: 'RESOLUTION_UNAVAILABLE' }]);
    const ko = await dossier();
    expect(ko.ids).toEqual(ok.ids);
    expect(ko.lignes.get(att)).toBeNull();
    expect(ko.lignes.get(fact)).toBe('Période facturée : du 01/04/2025 au 30/04/2025');
    expect(ko.pieces).toBe(ok.pieces);
    expect(ko.details).toContain('Période facturée : du 01/04/2025 au 30/04/2025');
    expect(ko.details.join(' ')).not.toMatch(/Période couverte|couverture/i);
    // Assistant : même prudence.
    expect([...(await (await surf()).documentPeriodTexts(c.id, [att, fact])).entries()]).toEqual([[fact, 'Période facturée : du 01/04/2025 au 30/04/2025']]);
    expect(journal.mock.calls.some((x) => String(x[0]).includes('"event":"dossier.period_omitted"') && String(x[0]).includes('"cause":"READ_FAILED"'))).toBe(true);
    panne.mockRestore();
    journal.mockRestore();
    // Service rétabli : la période est de nouveau publiée (aucun état persistant de l'échec).
    expect((await dossier()).lignes.get(att)).toBe('Période couverte : du 01/04/2025 au 31/03/2026');
  });
});
