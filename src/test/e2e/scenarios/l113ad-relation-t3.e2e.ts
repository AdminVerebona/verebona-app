/**
 * Lot 113AD (Trello #725, D11 de #724, R13 / R14) — réexamen T3 par l'IA d'une divergence de périodes que les
 * documents ne déclarent pas, sur PostgreSQL 16 réel. Sorties T1 SIMULÉES (faits `period.*` persistés comme le pipeline)
 * et sorties T3 SIMULÉES (décideur injecté : jamais d'appel Gemini) ; consolidation T3 réelle (sans M3), contrôle de
 * cohérence réel (orchestrateur unique), cartes « À traiter » réelles (résolution par la même fonction que l'interface).
 *
 *   L113AD-E2E-SANS-BLOC  branche absente du prompt T3 : aucune demande, aucun appel, question comme au lot 113AA ;
 *   L113AD-E2E-STOCK      branche active : le contrôle COH-OPS-PERIOD-RESOLUTION (v2) DEMANDE le réexamen du stock sans IA,
 *                         la question est différée ; le balayage du passage T3 retient le compte ; la phase (hors lecture)
 *                         appelle T3 une fois : AVENANT certain → seule la période concernée est remplacée, historique et
 *                         preuve citée, aucune question ; mémoire : jamais renvoyée (passage, contrôle, consultation) ;
 *   L113AD-E2E-CONTRA     CONTRADICTION → question PERIOD-CONFLICT ; décision de l'utilisateur durable et prioritaire ;
 *                         sortie INVALIDE (extrait inventé) → abstention : question ; SUCCESSION d'un document non qualifié →
 *                         plus de constat ; budget épuisé → demande en attente, aucun appel ;
 *   L113AD-E2E-RETRAIT    branche retirée pendant une attente : demandes closes « indisponibles », la question revient ;
 *                         décision de l'utilisateur antérieure : jamais soumise à l'IA ; isolation des comptes.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, operationsKit, ref, RECETTE_TODAY, type OperationsKit } from '../datasets/operations-v1';
import { proofOf, runCoherenceFor } from '../coherence-run';

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
type Input = import('@/services/documents/business-periods/relation-contract').RelationInput;

const piece = (assetId: number, start: string, end: string): AnchoredOperationCandidate =>
  cand({
    typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: 'CONTRACT_DOCUMENT' as never, provider: 'Assureur Habitation',
    summary: 'Assurance habitation', targetHints: [cible(assetId)],
    businessReferences: [ref('POLICY', 'POL-AD')] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { startDate: start, endDate: end }, financialHints: [],
  });

/** Décideur T3 SIMULÉ : capacité réglable, sortie construite à partir de l'entrée reçue (monde fermé). */
function simule() {
  const etat = { available: false, calls: [] as Input[], answer: (_i: Input): unknown => null };
  const decider = {
    capability: async () => (etat.available
      ? { available: true, version: 'simu-v29', reason: 'AVAILABLE' as const }
      : { available: false, version: null, reason: 'CONTRACT_PENDING' as const, contractState: 'BRANCH_MISSING' as const }),
    decide: async (c: { input: Input }) => { etat.calls.push(c.input); return { output: etat.answer(c.input), traceId: `trace-${etat.calls.length}` }; },
  };
  return { etat, decider };
}

scenario('L113AD', 'Périodes métier — réexamen T3 d’une divergence non déclarée (#725)', ({ sql, make }) => {
  let k: OperationsKit;
  const sim = simule();
  beforeAll(async () => {
    k = operationsKit(sql, make);
    (await import('@/services/documents/business-periods/relation-decider')).__setRelationDeciderForTests(sim.decider);
  });
  afterEach(() => { sim.etat.available = false; sim.etat.answer = () => null; });
  afterAll(async () => {
    session.currentAccountId = null;
    (await import('@/services/documents/business-periods/relation-decider')).__setRelationDeciderForTests(null);
  });
  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const phase = async (c: AccountRow, o: { dailyMax?: number } = {}) =>
    (await import('@/services/documents/business-periods/relation-review')).runPeriodRelationPhase(c.id, { ...o });
  const rafraichir = async (c: AccountRow, ids: number[]) => { for (const id of ids) await (await svc()).refreshDocumentBusinessPeriods(c.id, id); };
  const faits = async (c: AccountRow, fileId: number, liste: Array<[string, string, (string | null)?]>) => {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    for (const [key, value, attribute] of liste) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value, confidence, excerpt, status)
                VALUES (${c.id}, ${fileId}, ${x.id}, ${key}, ${key}, ${attribute ?? null}, ${value}, 'certain', ${`Période de garantie ${value}`}, 'active')`;
    }
  };
  const v2 = (val: string): Array<[string, string, (string | null)?]> => [['period.relevance', 'coverage=known;contract=undetermined'], ['period.coverage', val, 'principal']];
  const cartes = (c: AccountRow) => sql<{ id: number; public_id: string; resolved_at: string | null; resolution_reason: string | null; trigger_context: Json }[]>`
    SELECT id, public_id, resolved_at::text AS resolved_at, resolution_reason, trigger_context FROM to_process_actions
     WHERE account_id = ${c.id} AND rule_code = 'PERIOD-CONFLICT' ORDER BY id`;
  const ouvertes = async (c: AccountRow) => (await cartes(c)).filter((x) => !x.resolved_at);
  const examens = (c: AccountRow) => sql<Json[]>`
    SELECT status, relation, replacing_file_id, confidence, evidence, ai_calls, attempts, decider_version, ai_trace_id, validation, file_ids, contract_version
      FROM business_period_relation_reviews WHERE account_id = ${c.id} ORDER BY id`;
  const historique = async (c: AccountRow, op: number) => (await (await svc()).readOperationCoverageHistory(c.id, op))!;
  const lireDoc = async (c: AccountRow, id: number) => {
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), { params: Promise.resolve({ id: String(id) }) });
    expect(r.status).toBe(200);
    return (await r.json() as { periods: Json }).periods;
  };
  /** Compte avec deux justificatifs qualifiés dont les périodes de couverture divergent (aucune relation déclarée). */
  const divergence = async (o: { secondQualifie?: boolean; titreB?: string } = {}) => {
    const c = await make.account({ plan: 'premium' });
    const m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const a = await k.document(c, m.id, [piece(m.id, '2025-04-01', '2026-03-31')], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation habitation 2025' });
    await faits(c, a, v2('2025-04-01/2026-03-31'));
    const b = await k.document(c, m.id, [piece(m.id, '2025-07-01', '2026-06-30')], { type: 'INSURANCE_CERTIFICATE', title: o.titreB ?? 'Courrier : la période de garantie est modifiée à compter du 01/07/2025' });
    if (o.secondQualifie !== false) await faits(c, b, v2('2025-07-01/2026-06-30'));
    await k.passer(c);
    await k.passer(c);
    await rafraichir(c, [a, b]);
    await k.passer(c);
    const op = (await k.actives(c)).filter((x) => x.type_code === 'CONTRACT').map((x) => x.id)[0];
    return { c, a, b, op };
  };
  /** Sortie T3 simulée, extraits recopiés de l'entrée reçue (titre de D2). */
  const repondre = (relation: string, o: { replacing?: 'P1' | 'P2' | null; excerpt?: (i: Input) => string; confidence?: string } = {}) => (i: Input) => ({
    task: 'PERIOD_RELATION', relation, replacingPeriod: o.replacing ?? null, confidence: o.confidence ?? 'certain',
    evidence: relation === 'ABSTAIN' ? [] : [{ document: 'D2', excerpt: o.excerpt ? o.excerpt(i) : i.documents[1].title! }],
    reason: 'Réponse simulée.',
  });

  // ══ Sans bloc ═════════════════════════════════════════════════════════════
  it('L113AD-E2E-SANS-BLOC — branche absente : aucune demande, aucun appel, question comme au lot 113AA', async () => {
    const { c, op } = await divergence();
    expect(await ouvertes(c)).toHaveLength(1);
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(await phase(c)).toMatchObject({ processed: 0, aiCalls: 0 });
    expect(await examens(c)).toEqual([]);
    expect(sim.etat.calls).toHaveLength(0);
    expect((await historique(c, op)).coverages.map((x) => x.resolution)).toEqual([
      expect.objectContaining({ status: 'CONFLICT', pendingQuestion: true }), expect.objectContaining({ status: 'CONFLICT', pendingQuestion: true }),
    ]);
  });

  // ══ Stock : demande sans IA, phase hors lecture, avenant reconnu, mémoire ══
  it('L113AD-E2E-STOCK — demande par le contrôle, question différée, avenant certain : seule la période concernée est remplacée ; jamais renvoyée', async () => {
    const { c, a, b, op } = await divergence();
    const carteAvant = (await ouvertes(c))[0];
    expect(carteAvant).toBeTruthy();
    sim.etat.available = true;
    // Contrôle de cohérence (v2) : demande posée SANS appel IA, carte fermée (question différée).
    const r = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r.results['COH-OPS-PERIOD-RESOLUTION']).toMatchObject({ REPAIRED: 1 });
    expect(sim.etat.calls).toHaveLength(0);
    expect(await examens(c)).toEqual([expect.objectContaining({ status: 'PENDING', ai_calls: 0, contract_version: 't3-period-relation-v1', file_ids: [a, b].sort((x, y) => x - y) })]);
    expect(await ouvertes(c)).toEqual([]);
    expect((await cartes(c))[0]).toMatchObject({ id: carteAvant.id, resolution_reason: 'OBSOLETE' });
    const h0 = await historique(c, op);
    expect(h0.coverages.every((x) => x.resolution?.status === 'CONFLICT' && !x.resolution?.pendingQuestion)).toBe(true);
    // Rejoué : rien de plus (la demande n'est posée qu'une fois ; constat absent pendant l'attente).
    const r2 = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r2.results['COH-OPS-PERIOD-RESOLUTION']?.REPAIRED ?? 0).toBe(0);
    expect(r2.results['COH-OPS-PERIOD-RESOLUTION']?.FINDING ?? 0).toBe(0);
    // Le balayage du passage T3 retient le compte (requête réelle).
    const { listAccountsToConsolidate } = await import('@/services/business-operations/consolidation/consolidator');
    expect(await listAccountsToConsolidate(c.id - 1, 50)).toContain(c.id);
    // Consultation (fiche, liste) : aucun appel.
    await lireDoc(c, a);
    await (await svc()).readOperationsCoverageHistories(c.id, [op]);
    expect(sim.etat.calls).toHaveLength(0);

    // Phase du passage T3 (hors lecture) : un appel, sortie AVENANT certaine (preuve recopiée du titre de D2).
    sim.etat.answer = repondre('AMENDMENT', { replacing: 'P2' });
    const p = await phase(c);
    expect(p).toMatchObject({ processed: 1, aiCalls: 1, operations: [op], outcomes: { DECIDED_AMENDMENT: 1 } });
    expect(sim.etat.calls).toHaveLength(1);
    const entree = sim.etat.calls[0];
    expect(entree).toMatchObject({ contractVersion: 't3-period-relation-v1', task: 'PERIOD_RELATION', periodKind: 'COVERAGE' });
    expect(entree.periods.map((x) => [x.ref, x.document, x.start, x.end])).toEqual([['P1', 'D1', '2025-04-01', '2026-03-31'], ['P2', 'D2', '2025-07-01', '2026-06-30']]);
    expect(JSON.stringify(entree)).not.toContain(`"${a}"`);
    const [ex] = await examens(c);
    expect(ex).toMatchObject({ status: 'DECIDED', relation: 'AMENDMENT', replacing_file_id: b, confidence: 'certain', ai_calls: 1, decider_version: 'simu-v29', ai_trace_id: 'trace-1' });
    expect(ex.evidence[0]).toMatchObject({ document: 'D2', fileId: b });
    // Seule la période concernée est remplacée ; historique conservé ; preuve citée ; aucune question.
    const h = await historique(c, op);
    const parDoc = new Map(h.coverages.map((x) => [x.fileId, x]));
    expect(parDoc.get(a)!.resolution).toMatchObject({
      status: 'REPLACED', byFileId: b,
      note: 'Actualisée par « Courrier : la période de garantie est modifiée à compter du 01/07/2025 » (avenant reconnu : « Courrier : la période de garantie est modifiée à compter du 01/07/2025 »)',
    });
    expect(parDoc.get(b)!.resolution).toBeUndefined();
    expect(JSON.stringify((await lireDoc(c, a)).coverageHistories)).not.toContain('"basis"');
    expect(await ouvertes(c)).toEqual([]);
    // Aucune période de document modifiée.
    expect(await sql`SELECT start_on::text, end_on::text FROM document_business_periods WHERE account_id = ${c.id} AND status = 'ACTIVE' ORDER BY file_id`)
      .toEqual([{ start_on: '2025-04-01', end_on: '2026-03-31' }, { start_on: '2025-07-01', end_on: '2026-06-30' }]);
    // Mémoire : jamais renvoyée (phase, passage T3, contrôle, requalification).
    await phase(c);
    await k.passer(c);
    await rafraichir(c, [a, b]);
    const r3 = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r3.results['COH-OPS-PERIOD-RESOLUTION']?.REPAIRED ?? 0).toBe(0);
    expect(sim.etat.calls).toHaveLength(1);
    expect(await examens(c)).toHaveLength(1);
    const { RELATION_REVIEW_PENDING_SQL } = await import('@/services/documents/business-periods/relation-review');
    expect(await sql.unsafe(`SELECT 1 FROM business_period_relation_reviews r WHERE r.account_id = ${c.id} AND ${RELATION_REVIEW_PENDING_SQL('r')}`)).toHaveLength(0);
  });

  // ══ Contradiction, utilisateur prioritaire, sortie invalide, non qualifié, budget ══
  describe('contradiction et garde-fous', () => {
    it('L113AD-E2E-CONTRA — contradiction → question ; décision de l’utilisateur prioritaire et durable ; sortie invalide → abstention', async () => {
      sim.etat.available = true;
      const n0 = sim.etat.calls.length;
      const { c, a, b, op } = await divergence({ titreB: 'Attestation habitation 2025 bis' });
      // Passage T3 (syncCards) : demande posée, question différée.
      expect(await ouvertes(c)).toEqual([]);
      expect(await examens(c)).toEqual([expect.objectContaining({ status: 'PENDING' })]);
      sim.etat.answer = repondre('CONTRADICTION');
      expect((await phase(c)).outcomes).toEqual({ DECIDED_CONTRADICTION: 1 });
      const [q] = await ouvertes(c);
      expect(q.trigger_context).toMatchObject({ kind: 'period_conflict', operationId: op, fileIds: [a, b] });
      // L'utilisateur tranche : durable, prioritaire ; jamais renvoyée à l'IA.
      const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
      expect(await resolveArbitration(c.id, q.public_id, `KEEP:${a}`, { userId: c.ownerUserId })).toMatchObject({ ok: true });
      const h = await historique(c, op);
      expect(h.coverages.find((x) => x.fileId === b)!.resolution).toMatchObject({ status: 'REPLACED', note: 'Remplacée par « Attestation habitation 2025 » (votre choix)' });
      await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
      await phase(c);
      expect(sim.etat.calls.length - n0).toBe(1);
      expect(await ouvertes(c)).toEqual([]);

      // Sortie INVALIDE (extrait inventé) : refusée en bloc, vaut abstention → question.
      const d = await divergence({ titreB: 'Attestation habitation B' });
      sim.etat.answer = repondre('RECTIFICATION', { replacing: 'P2', excerpt: () => 'Cette attestation annule et remplace la précédente' });
      expect((await phase(d.c)).outcomes).toEqual({ REJECTED: 1 });
      expect((await examens(d.c))[0]).toMatchObject({ status: 'REJECTED', validation: { valid: false, problems: [{ issue: 'EXCERPT_NOT_FOUND' }] } });
      expect(await ouvertes(d.c)).toHaveLength(1);
      expect((await historique(d.c, d.op)).coverages.every((x) => x.resolution?.status === 'CONFLICT')).toBe(true);
      // Jamais renvoyée, même avec une autre réponse possible.
      sim.etat.answer = repondre('SUCCESSION');
      await runCoherenceFor(sql, [d.c.id], { today: RECETTE_TODAY });
      expect((await phase(d.c)).aiCalls).toBe(0);
    });

    it('L113AD-E2E-CONTRA — document non qualifié : SUCCESSION certaine → plus de constat ; budget épuisé → aucun appel', async () => {
      sim.etat.available = true;
      const { c, op } = await divergence({ secondQualifie: false, titreB: 'Attestation 2025-2026 (échéance du 30/06/2026)' });
      // Budget du compte épuisé : la demande reste en attente, aucun appel.
      sim.etat.answer = repondre('SUCCESSION');
      expect((await phase(c, { dailyMax: 0 })).outcomes).toEqual({ DEFERRED_BUDGET: 1 });
      expect(await examens(c)).toEqual([expect.objectContaining({ status: 'PENDING', ai_calls: 0 })]);
      const avant = sim.etat.calls.length;
      expect((await phase(c)).outcomes).toEqual({ DECIDED_SUCCESSION: 1 });
      expect(sim.etat.calls.length).toBe(avant + 1);
      const h = await historique(c, op);
      expect(h.coverages.map((x) => x.resolution)).toEqual([undefined, undefined]);
      const r = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
      expect(r.results['COH-OPS-PERIOD-RESOLUTION']?.FINDING ?? 0).toBe(0);
      expect(await proofOf(sql, c.id, 'COH-OPS-PERIOD-RESOLUTION', op)).toMatchObject({ last_result: 'CONSISTENT' });
      expect(await ouvertes(c)).toEqual([]);
    });
  });

  // ══ Retrait de la branche, décision antérieure, isolation ══════════════════
  it('L113AD-E2E-RETRAIT — branche retirée : demandes « indisponibles », question revenue ; décision antérieure jamais soumise ; comptes isolés', async () => {
    sim.etat.available = true;
    const { c, op } = await divergence({ titreB: 'Attestation C' });
    expect(await examens(c)).toEqual([expect.objectContaining({ status: 'PENDING' })]);
    sim.etat.available = false;
    const p = await phase(c);
    expect(p).toMatchObject({ aiCalls: 0, outcomes: { UNAVAILABLE: 1 }, unavailable: 'BRANCH_MISSING' });
    expect(await ouvertes(c)).toHaveLength(1);
    expect((await historique(c, op)).coverages[0].resolution).toMatchObject({ status: 'CONFLICT', pendingQuestion: true });

    // Décision de l'utilisateur prise AVANT l'activation : la paire n'est jamais soumise à l'IA.
    const [q] = await ouvertes(c);
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(c.id, q.public_id, 'BOTH', { userId: c.ownerUserId })).toMatchObject({ ok: true });
    sim.etat.available = true;
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(await examens(c)).toEqual([expect.objectContaining({ status: 'UNAVAILABLE' })]);
    const appels = sim.etat.calls.length;
    expect((await phase(c)).aiCalls).toBe(0);
    expect(sim.etat.calls.length).toBe(appels);

    // Isolation : un autre compte ne lit ni la mémoire ni l'historique, et sa phase ne traite rien.
    const autre = await make.account({ plan: 'premium' });
    const { loadRelationStates } = await import('@/services/documents/business-periods/relation-review');
    const ids = (await examens(c))[0].file_ids as number[];
    const { pgClient } = await import('@/db');
    expect(await loadRelationStates(pgClient, autre.id, ids)).toEqual([]);
    expect(await phase(autre)).toMatchObject({ processed: 0, aiCalls: 0 });
    expect(await (await svc()).readOperationCoverageHistory(autre.id, op)).toBeNull();
  });
});
