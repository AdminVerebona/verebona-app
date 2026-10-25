/**
 * Lot 87B — ticket P1 « Code — compléter l'orchestration T3/T4 et la
 * réévaluation sémantique », sur PostgreSQL 16 réel.
 *
 * Chaîne de PRODUCTION : candidats T1 (persistance réelle), T3
 * (`consolidateAccountOperations`, M3 SIMULÉ), T4 par `persistAgendaDecisions`,
 * projection Opérations → Agenda, exécutant de la FILE DURABLE de projection
 * (`runAgendaProjectionJob`), orchestration des réévaluations sémantiques,
 * contrôle de cohérence (orchestrateur unique, campagnes à blanc puis
 * corrective), reprise BO du stock. Décideur T4 multi-événements SIMULÉ
 * (fournisseur de test : le contrat IA n'est pas livré) ; aucun réseau. Date
 * de référence injectée (jour > 12). Assertions bornées aux comptes créés ici.
 *
 *   L87B-E2E-01  cas 1 — une Opération, deux étapes : sans T4, constat (aucune fusion) ; T4 → deux éléments rattachés ; rejoué : aucun appel
 *   L87B-E2E-02  cas 2 — deux descriptions, une occurrence : T4 → un élément, toutes les preuves conservées ; réanalyse : rien de recréé
 *   L87B-E2E-03  cas 3 — deux interventions proches mais distinctes : deux Opérations, deux événements, aucune fusion, aucun appel T4
 *   L87B-E2E-04  cas 4 — doublon Agenda historique : contrôle (à blanc : constat) → T4 → consolidation, preuves conservées ; second contrôle sans mutation
 *   L87B-E2E-05  cas 5 — étapes historiques fusionnées à tort (ancienne règle) : contrôle → T4 → occurrence restaurée, même Opération
 *   L87B-E2E-06  cas 6 — mauvaise identité d'Opération : contrôle → T3 (verdict historique écarté) → fusion → projection → T4
 *   L87B-E2E-07  cas 7 — correction de l'utilisateur (document détaché) : jamais rétablie (contrôle, projection, T4)
 *   L87B-E2E-08  cas 8 — réponse IA invalide / état changé à l'application : décision refusée et tracée, aucune mutation partielle
 *   L87B-E2E-09  reprise BO du stock : simulation sans écriture, application, rejouée sans appel, restauration (CODE-07)
 *   L87B-E2E-10  coût borné : plafond par passage / 24 h → report tracé, aucun appel au-delà
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import type { AccountRow, AssetRow } from '../factories';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';
import { cand, cible, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';
import type { RepresentationInput } from '@/services/business-operations/semantic/contract';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
/** Date de référence injectée (jamais la date du jour ; jour > 12). */
const AUJ = '2026-10-24';

// ── Décideur T4 multi-événements SIMULÉ (port `RepresentationDecider`) ──────
const t4 = {
  calls: 0,
  inputs: [] as RepresentationInput[],
  answer: null as null | ((input: RepresentationInput) => unknown | Promise<unknown>),
};
const decideurSimule = {
  async capability() { return { available: true, version: 'simule-v1', reason: 'AVAILABLE' as const }; },
  async decide(call: { input: RepresentationInput }) {
    t4.calls++;
    t4.inputs.push(call.input);
    if (!t4.answer) throw new Error('aucune réponse simulée');
    return { output: await t4.answer(call.input), traceId: `sim-${t4.calls}` };
  },
};
/** Référence opaque (A…) d'un élément du contexte par son intitulé. */
const refDe = (input: RepresentationInput, titre: string) => {
  const i = input.agendaItems.find((x) => x.title === titre && x.inScope);
  if (!i) throw new Error(`élément « ${titre} » absent du contexte : ${input.agendaItems.map((x) => x.title).join(', ')}`);
  return i.ref;
};
/** Élément principal à décider (rôle porté par le contexte), à défaut le premier élément à décider. */
const principalRef = (input: RepresentationInput) => (input.agendaItems.find((i) => i.inScope && i.role === 'PRINCIPAL') ?? input.agendaItems.find((i) => i.inScope)!).ref;
const aDecider = (input: RepresentationInput) => input.agendaItems.filter((i) => i.inScope).map((i) => i.ref);
const occ = (items: string[], keep: string, role: 'PRINCIPAL' | 'STEP' | 'INDEPENDENT') => ({ items, keep, role, confidence: 'certain', evidence: [], reason: 'décision simulée' });
const decision = (occurrences: unknown[], extra: Record<string, unknown> = {}) => ({ task: 'AGENDA_REPRESENTATION', outcome: 'DECIDED', occurrences, restorations: [], reason: 'décision simulée', ...extra });

// ── M3 simulé (rapprochement sémantique T3) ─────────────────────────────────
const m3 = { verdict: 'DISTINCT' as 'SAME' | 'DISTINCT', calls: 0 };
const lire = (prompt: string, label: string): any => {
  const i = prompt.indexOf(`${label} : `);
  return i < 0 ? null : JSON.parse(prompt.slice(i + label.length + 3).split('\n')[0]);
};
function modeleM3(input: ProviderCallInput): unknown {
  m3.calls++;
  const candidats = (lire(input.prompt, 'Candidats') ?? []) as Array<{ candidateId: number }>;
  const base = { task: 'OPERATION_MATCH', concordantSignals: ['même bien', 'même prestataire', 'même date'], contradictions: [] as string[] };
  if (m3.verdict === 'DISTINCT' || !candidats.length) {
    return { ...base, decision: 'DISTINCT_OPERATION', matchedCandidateId: null, confidence: 'certain', reason: 'autres travaux', contradictions: ['autres travaux'] };
  }
  return { ...base, decision: 'SAME_OPERATION', matchedCandidateId: candidats[0].candidateId, confidence: 'certain', reason: 'même réparation' };
}

const persistence = () => import('@/services/agenda/agenda-persistence');
const projection = () => import('@/services/business-operations/agenda-projection/service');
const semantique = () => import('@/services/business-operations/semantic/orchestrator');

scenario('L87B', 'Orchestration T3 → T4 et réévaluation sémantique (contexte, file durable, contrôle, reprise, protections, validation)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', modeleM3);
  });
  afterAll(async () => {
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', null);
    (await import('@/services/business-operations/semantic/decider')).__setRepresentationDeciderForTests(null);
  });
  // Compteurs PROPRES à chaque test (jamais un compteur partagé entre tests).
  beforeEach(() => { t4.calls = 0; t4.inputs = []; m3.calls = 0; });
  afterEach(async () => {
    (await import('@/services/business-operations/events')).resetBusinessOperationEventBusForTests();
    (await import('@/services/business-operations/semantic/decider')).__setRepresentationDeciderForTests(null);
    t4.answer = null;
    m3.verdict = 'DISTINCT';
  });
  const simuler = async () => (await import('@/services/business-operations/semantic/decider')).__setRepresentationDeciderForTests(decideurSimule);

  // ── Outils ───────────────────────────────────────────────────────────────
  async function contexte(): Promise<{ compte: AccountRow; maison: AssetRow }> {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    return { compte, maison };
  }
  async function facture(c: { compte: AccountRow; maison: AssetRow }, o: { summary: string; provider?: string; facture: string; date: string; type?: string; titre?: string }): Promise<number> {
    return k.document(c.compte, c.maison.id, [cand({
      summary: o.summary, provider: o.provider ?? 'Plomberie Durand', targetHints: [cible(c.maison.id)],
      businessReferences: [ref('INVOICE', o.facture)], temporalHints: { realizedDate: o.date },
    })], { type: o.type ?? 'WORKS_INVOICE', title: o.titre ?? o.summary, date: o.date });
  }
  /** Décisions T4 d'un document (même forme que le moteur T4). */
  const evenementT4 = (fileId: number, assetId: number, e: { title: string; date: string; businessType: string; originFieldKey?: string }) => ({
    action: 'create', title: e.title, date: e.date, category: 'information', confidence: 'certain', reasonCode: 'NEW_EVENT', deterministic: true,
    sourceFileId: fileId, nature: 'HISTORICAL', businessType: e.businessType, occurrenceIndex: e.date, target: { type: 'ASSET', id: assetId },
    sources: [{ fileId, role: 'SOURCE' }], ...(e.originFieldKey ? { originFieldKey: e.originFieldKey } : {}),
  });
  const persisterT4 = async (c: { compte: AccountRow; maison: AssetRow }, fileId: number, evts: Array<{ title: string; date: string; businessType: string; originFieldKey?: string }>) =>
    (await persistence()).persistAgendaDecisions(evts.map((e) => evenementT4(fileId, c.maison.id, e)) as never[], c.compte.id, c.maison.id, { sourceFileId: fileId, analysisComplete: true });
  const projeter = async (compte: AccountRow) => (await projection()).projectAccountOperations(compte.id, { all: true, correlationId: 'l87b', today: AUJ });
  /** Exécutant RÉEL de la file durable de projection (CODE-02) : projection puis décisions T4 demandées. */
  async function travailProjection(compte: AccountRow, operationIds: number[]) {
    const { runAgendaProjectionJob } = await import('@/services/business-operations/agenda-projection/queue');
    return runAgendaProjectionJob({ id: 9_000_000 + compte.id } as never, {
      kind: 'business_operations_agenda' as never, accountId: compte.id, events: [{ operationIds, correlationId: `l87b-job:${compte.id}` }], requestedAt: null,
    }, { assertActive: async () => undefined } as never);
  }
  const evenements = (compte: AccountRow) => sql<Json[]>`
    SELECT i.id, i.title, i.start_date::text AS date, i.business_type, i.business_operation_id::int AS op, i.operation_role AS role,
           i.operation_role_origin AS role_origin, i.projection_origin,
           COALESCE((SELECT array_agg(l.asset_file_id ORDER BY l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = i.id), '{}') AS files,
           (SELECT count(*)::int FROM agenda_item_sources s WHERE s.agenda_item_id = i.id) AS sources
      FROM agenda_items i WHERE i.account_id = ${compte.id} ORDER BY i.id`;
  const journal0591 = (compte: AccountRow) => sql<Json[]>`
    SELECT kind, reason, principal_item_id, absorbed_item_id, restored_at FROM agenda_intervention_consolidations WHERE account_id = ${compte.id} ORDER BY id`;
  const reevaluations = (compte: AccountRow) => sql<Json[]>`
    SELECT id, scope, operation_id::int AS operation_id, trigger_kind, status, reason, ai_calls, decided_items, mutations_applied, mutations_refused, validation, ai_output,
           context_fingerprint, resulting_fingerprint, before_state, after_state
      FROM operation_semantic_reevaluations WHERE account_id = ${compte.id} ORDER BY id`;
  const cartesOuvertes = (compte: AccountRow) => sql<Json[]>`
    SELECT id FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'AGENDA-PROJECTION-MATCH' AND resolved_at IS NULL`;
  const sourcesDocs = async (fileIds: number[]) => (await sql<Json[]>`
    SELECT count(*)::int AS n FROM agenda_item_sources WHERE asset_file_id = ANY(${fileIds}::int[])`)[0].n as number;
  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e-l87b', mode, scopeAccountIds: scope });
    for (let i = 0; i < 40; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: AUJ });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const reparations = (accountId: number, check: string) => sql<Json[]>`
    SELECT object_id::int AS object_id, service, outcome, reevaluation_kind, anomaly, ai_calls FROM coherence_repairs
     WHERE account_id = ${accountId} AND check_id = ${check} ORDER BY id`;
  const preuve = async (accountId: number, check: string, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${check} AND object_id = ${objectId}`)[0];
  async function lier(compte: AccountRow, operationId: number, itemId: number, role: 'PRINCIPAL' | 'RELATED') {
    const { withGroupingWrite, attachAgendaItem } = await import('@/services/business-operations/grouping/service');
    await withGroupingWrite(compte.id, (ctx) => attachAgendaItem(ctx, { operationId, itemId, role, origin: 'T4', reasonCode: 'E2E_STOCK' }));
  }
  /** Stock : deux représentations T4 d'une même réparation (deux documents d'une même Opération par référence commune). */
  async function deuxDescriptions(c: { compte: AccountRow; maison: AssetRow }) {
    const f1 = await facture(c, { summary: 'Réparation fuite cuisine', facture: 'F-26-20', date: '2026-03-20' });
    const f2 = await facture(c, { summary: 'Rapport d’intervention fuite', facture: 'F-26-20', date: '2026-03-20', type: 'INTERVENTION_REPORT' });
    await k.passer(c.compte, { today: AUJ });
    const ops = await k.actives(c.compte);
    expect(ops).toHaveLength(1);
    await persisterT4(c, f1, [{ title: 'Réparation — Maison', date: '2026-03-20', businessType: 'repair' }]);
    await persisterT4(c, f2, [{ title: 'Intervention plombier', date: '2026-03-20', businessType: 'repair' }]);
    return { f1, f2, op: ops[0].id };
  }

  // ══ Cas 1 ═════════════════════════════════════════════════════════════════

  it('L87B-E2E-01 / cas 1 — une Opération, deux étapes (visite préparatoire puis réparation) : aucune fusion par le code ; T4 → deux éléments rattachés ; rejoué sans appel', async () => {
    const c = await contexte();
    const f = await facture(c, { summary: 'Réparation fuite cuisine', facture: 'F-26-18', date: '2026-03-18' });
    await k.passer(c.compte, { today: AUJ });
    const [op, ...reste] = await k.actives(c.compte);
    expect(reste).toEqual([]);
    await persisterT4(c, f, [
      { title: 'Visite préparatoire', date: '2026-03-16', businessType: 'maintenance' },
      { title: 'Réparation — Maison', date: '2026-03-18', businessType: 'repair' },
    ]);
    // a) Contrat T4 multi-événements NON livré (production) : constat — deux éléments, aucune fusion, carte D14, journal.
    const r0 = await travailProjection(c.compte, [op.id]);
    expect((r0.detail as Json).semantic).toMatchObject({ requested: 1, outcomes: { UNAVAILABLE: 1 }, aiCalls: 0 });
    let evts = await evenements(c.compte);
    expect(evts).toHaveLength(2);
    expect(evts.every((e) => e.op === null)).toBe(true);
    expect(await journal0591(c.compte)).toEqual([]);
    expect(await cartesOuvertes(c.compte)).toHaveLength(1);
    expect(await reevaluations(c.compte)).toEqual([expect.objectContaining({ scope: 'T4', status: 'UNAVAILABLE', reason: 'CONTRACT_PENDING', trigger_kind: 'T3_DECISION', ai_calls: 0 })]);
    // Rejoué : le même constat n'est pas journalisé deux fois.
    await travailProjection(c.compte, [op.id]);
    expect(await reevaluations(c.compte)).toHaveLength(1);

    // b) T4 disponible (fournisseur simulé) : la visite est une ÉTAPE, la réparation l'événement principal.
    await simuler();
    t4.answer = (input) => decision([occ([refDe(input, 'Visite préparatoire')], refDe(input, 'Visite préparatoire'), 'STEP'),
      occ([refDe(input, 'Réparation — Maison')], refDe(input, 'Réparation — Maison'), 'PRINCIPAL')]);
    const r1 = await travailProjection(c.compte, [op.id]);
    expect((r1.detail as Json).semantic).toMatchObject({ outcomes: { APPLIED: 1 }, aiCalls: 1 });
    expect(t4.inputs[0].agendaItems.filter((i) => i.inScope).map((i) => i.title).sort()).toEqual(['Réparation — Maison', 'Visite préparatoire']);
    expect(t4.inputs[0].documents.map((d) => d.ref)).toEqual(['D1']);
    evts = await evenements(c.compte);
    expect(evts).toHaveLength(2);
    expect(evts.find((e) => e.title === 'Visite préparatoire')).toMatchObject({ op: op.id, role: 'RELATED' });
    expect(evts.find((e) => e.title !== 'Visite préparatoire')).toMatchObject({ op: op.id, role: 'PRINCIPAL' });
    expect(await journal0591(c.compte)).toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: 'ABSORB' })]));
    // Convergence : la carte D14 devenue sans objet est close ; décision mémorisée (rôles), état produit tracé.
    expect(await cartesOuvertes(c.compte)).toEqual([]);
    const jr = (await reevaluations(c.compte)).at(-1)!;
    expect(jr).toMatchObject({ status: 'APPLIED', ai_calls: 1 });
    expect(Object.values(jr.decided_items).sort()).toEqual(['PRINCIPAL', 'STEP']);
    expect(jr.ai_output).toMatchObject({ task: 'AGENDA_REPRESENTATION' });
    expect(jr.before_state).toBeTruthy();
    expect(jr.after_state).toBeTruthy();
    // c) Rejoué (file, projection, contrôle) : aucun nouvel appel, aucune écriture.
    const avant = await evenements(c.compte);
    await travailProjection(c.compte, [op.id]);
    expect((await projeter(c.compte)).changes).toBe(0);
    expect(t4.calls).toBe(1);
    expect(await evenements(c.compte)).toEqual(avant);
  });

  // ══ Cas 2 ═════════════════════════════════════════════════════════════════

  it('L87B-E2E-02 / cas 2 — deux documents décrivent la même réparation : T4 → un élément, toutes les preuves et liens conservés ; réanalyse : rien de recréé', async () => {
    const c = await contexte();
    const { f1, f2, op } = await deuxDescriptions(c);
    const preuvesAvant = await sourcesDocs([f1, f2]);
    await simuler();
    t4.answer = (input) => decision([occ([refDe(input, 'Réparation — Maison'), refDe(input, 'Intervention plombier')], refDe(input, 'Réparation — Maison'), 'PRINCIPAL')]);
    const r = await travailProjection(c.compte, [op]);
    expect((r.detail as Json).semantic).toMatchObject({ outcomes: { APPLIED: 1 } });
    const [evt, ...autres] = await evenements(c.compte);
    expect(autres).toEqual([]);
    expect(evt).toMatchObject({ op, role: 'PRINCIPAL' });
    expect([...evt.files].sort()).toEqual([f1, f2].sort());
    expect(await sourcesDocs([f1, f2])).toBe(preuvesAvant);
    expect((await journal0591(c.compte)).filter((j) => j.kind === 'ABSORB')).toEqual([expect.objectContaining({ reason: 'T4_SEMANTIC_SAME_OCCURRENCE', restored_at: null })]);
    expect((await reevaluations(c.compte)).at(-1)!.mutations_applied).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'CONSOLIDATE' })]));
    // CODE-09 : décision et mutations visibles dans les diagnostics BO (dossier de l'Opération, « Données du compte »).
    const { buildEntityDossier } = await import('@/services/admin/account-data/dossier');
    const dossier = await buildEntityDossier(c.compte.id, 'operation', op);
    const sec = dossier.sections.find((x) => x.id === 'semantic-reevaluations');
    expect(sec?.error).toBeUndefined();
    expect(sec).toBeDefined();
    // Réanalyse T4 du second document : l'occurrence absorbée (même clé) n'est pas recréée ; aucun nouvel appel.
    await persisterT4(c, f2, [{ title: 'Intervention plombier', date: '2026-03-20', businessType: 'repair' }]);
    await travailProjection(c.compte, [op]);
    expect(await evenements(c.compte)).toHaveLength(1);
    expect(t4.calls).toBe(1);
  });

  // ══ Cas 3 ═════════════════════════════════════════════════════════════════

  it('L87B-E2E-03 / cas 3 — même bien, même prestataire, dates proches, travaux différents : deux Opérations, deux événements, aucune fusion déterministe', async () => {
    const c = await contexte();
    await simuler();
    t4.answer = () => { throw new Error('T4 ne doit pas être sollicité'); };
    const a = await facture(c, { summary: 'Réparation fuite cuisine', facture: 'A-1', date: '2026-03-16' });
    const b = await facture(c, { summary: 'Entretien chaudière', facture: 'B-2', date: '2026-03-18' });
    m3.verdict = 'DISTINCT';
    for (let i = 0; i < 6; i++) {
      const r = await k.passer(c.compte, { today: AUJ, operationMatch: {} });
      const [p] = await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${c.compte.id} AND t3_pending LIMIT 1`;
      if (r.changes === 0 && !(r.m3?.calls) && !p) break;
    }
    const ops = await k.actives(c.compte);
    expect(ops).toHaveLength(2);
    await persisterT4(c, a, [{ title: 'Réparation — Maison', date: '2026-03-16', businessType: 'repair' }]);
    await persisterT4(c, b, [{ title: 'Entretien réalisé — Prestation', date: '2026-03-18', businessType: 'maintenance' }]);
    await travailProjection(c.compte, ops.map((o) => o.id));
    const evts = await evenements(c.compte);
    expect(evts).toHaveLength(2);
    expect(new Set(evts.map((e) => e.op))).toEqual(new Set(ops.map((o) => o.id)));
    expect(evts.every((e) => e.role === 'PRINCIPAL')).toBe(true);
    expect(await journal0591(c.compte)).toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: 'ABSORB' })]));
    expect((await k.operations(c.compte)).filter((o) => o.merged_into_operation_id !== null)).toEqual([]);
    expect(t4.calls).toBe(0);
  });

  // ══ Cas 4 ═════════════════════════════════════════════════════════════════

  it('L87B-E2E-04 / cas 4 — doublon Agenda historique : contrôle à blanc (constat, aucune écriture) → correctif : T4, consolidation, preuves conservées ; second contrôle sans mutation', async () => {
    const c = await contexte();
    const { f1, f2, op } = await deuxDescriptions(c);
    // Stock historique : les deux représentations rattachées (principal + élément lié), comme l'ancien code pouvait le laisser.
    const [e1, e2] = await evenements(c.compte);
    await lier(c.compte, op, e1.id, 'PRINCIPAL');
    await lier(c.compte, op, e2.id, 'RELATED');
    const preuvesAvant = await sourcesDocs([f1, f2]);
    await simuler();
    t4.answer = (input) => decision([occ(aDecider(input), principalRef(input), 'PRINCIPAL')]);

    const blanc = await campagne([c.compte.id], 'DRY_RUN');
    expect(blanc).toBeTruthy();
    expect(await preuve(c.compte.id, 'COH-AGENDA-OCCURRENCES', op)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'REPRESENTATION_DECISION_REQUIRED' }) });
    expect(await evenements(c.compte)).toHaveLength(2);
    expect(t4.calls).toBe(0);

    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await reparations(c.compte.id, 'COH-AGENDA-OCCURRENCES')).toEqual([
      expect.objectContaining({ object_id: op, service: 'reevaluateRepresentation', reevaluation_kind: 'SEMANTIC_REEVALUATION_T4', outcome: 'REPAIRED', ai_calls: 1 }),
    ]);
    const evts = await evenements(c.compte);
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ id: e1.id, op, role: 'PRINCIPAL' });
    expect(await sourcesDocs([f1, f2])).toBe(preuvesAvant);
    expect((await reevaluations(c.compte)).at(-1)).toMatchObject({ trigger_kind: 'COHERENCE', status: 'APPLIED' });

    const appels = t4.calls;
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await reparations(c.compte.id, 'COH-AGENDA-OCCURRENCES')).toHaveLength(1);
    expect(t4.calls).toBe(appels);
    expect(await evenements(c.compte)).toEqual(evts);
  });

  // ══ Cas 5 ═════════════════════════════════════════════════════════════════

  it('L87B-E2E-05 / cas 5 — étapes fusionnées à tort par l’ancienne règle : contrôle → T4 → occurrence restaurée (même identifiant, même Opération) ; plus redemandé', async () => {
    const c = await contexte();
    const f = await facture(c, { summary: 'Réparation fuite cuisine', facture: 'F-26-19', date: '2026-03-19' });
    await k.passer(c.compte, { today: AUJ });
    const [op] = await k.actives(c.compte);
    await persisterT4(c, f, [
      { title: 'Visite préparatoire', date: '2026-03-17', businessType: 'maintenance' },
      { title: 'Réparation — Maison', date: '2026-03-19', businessType: 'repair' },
    ]);
    const evts = await evenements(c.compte);
    const visite = evts.find((e) => e.title === 'Visite préparatoire')!;
    const rep = evts.find((e) => e.title === 'Réparation — Maison')!;
    // État laissé par l'ancienne règle 76H (provenance + type + date → absorption), avant le lot 87B.
    await lier(c.compte, op.id, rep.id, 'PRINCIPAL');
    const { consolidateInTx } = await import('@/services/business-operations/agenda-projection/consolidation');
    await sql.begin((tx) => consolidateInTx(tx, {
      accountId: c.compte.id, operationId: op.id, principalId: rep.id, absorbedIds: [visite.id], linkPrincipal: false, reason: 'EQUIVALENT_BY_OPERATION', origin: 'PROJECTION',
    }));
    expect(await evenements(c.compte)).toHaveLength(1);

    await simuler();
    t4.answer = (input) => {
      expect(input.restorable).toEqual([expect.objectContaining({ ref: 'R1', title: 'Visite préparatoire' })]);
      const principal = input.agendaItems.find((i) => i.inScope)!.ref;
      return decision([occ([principal], principal, 'PRINCIPAL')], { restorations: [{ restore: 'R1', role: 'STEP', confidence: 'certain', evidence: [], reason: 'visite distincte de la réparation' }] });
    };
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await reparations(c.compte.id, 'COH-AGENDA-OCCURRENCES')).toEqual([
      expect.objectContaining({ anomaly: 'HISTORICAL_CONSOLIDATION_UNVALIDATED', reevaluation_kind: 'SEMANTIC_REEVALUATION_T4', outcome: 'REPAIRED' }),
    ]);
    const apres = await evenements(c.compte);
    expect(apres.map((e) => ({ id: e.id, op: e.op, role: e.role })).sort((a, b) => a.id - b.id)).toEqual([
      { id: visite.id, op: op.id, role: 'RELATED' }, { id: rep.id, op: op.id, role: 'PRINCIPAL' },
    ].sort((a, b) => a.id - b.id));
    expect((await journal0591(c.compte)).find((j) => j.kind === 'ABSORB')!.restored_at).not.toBeNull();
    const appels = t4.calls;
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(t4.calls).toBe(appels);
    expect(await reparations(c.compte.id, 'COH-AGENDA-OCCURRENCES')).toHaveLength(1);
  });

  // ══ Cas 6 ═════════════════════════════════════════════════════════════════

  it('L87B-E2E-06 / cas 6 — mauvaise identité d’Opération : contrôle → T3 (verdict historique écarté) → fusion → projection (file durable) → T4', async () => {
    const c = await contexte();
    const a = await facture(c, { summary: 'Réparation fuite sous évier', facture: 'A-26-21', date: '2026-03-21' });
    const b = await facture(c, { summary: 'Réparation fuite évier cuisine', facture: 'B-26-21', date: '2026-03-21', titre: 'Facture bis' });
    m3.verdict = 'DISTINCT';
    const stabiliser = async () => {
      for (let i = 0; i < 8; i++) {
        const r = await k.passer(c.compte, { today: AUJ, operationMatch: {} });
        const [p] = await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${c.compte.id} AND t3_pending LIMIT 1`;
        if (r.changes === 0 && !(r.m3?.calls) && !p) break;
      }
    };
    await stabiliser();
    const ops = await k.actives(c.compte);
    expect(ops).toHaveLength(2);
    // Décision historique : verdict « distinct » rendu par une ANCIENNE version du prompt T3 (suspecte).
    const [cb] = await sql<Json[]>`SELECT id, t3_detail FROM document_operation_candidates WHERE file_id = ANY(${[a, b]}::int[]) AND t3_detail -> 'm3' ->> 'status' = 'DONE' ORDER BY id DESC LIMIT 1`;
    expect(cb).toBeDefined();
    await sql`UPDATE document_operation_candidates SET t3_detail = jsonb_set(t3_detail, '{m3,promptVersion}', '"t3_master_v1@ancienne"') WHERE id = ${cb.id}`;
    await persisterT4(c, a, [{ title: 'Réparation — Maison', date: '2026-03-21', businessType: 'repair' }]);
    await persisterT4(c, b, [{ title: 'Réparation fuite', date: '2026-03-21', businessType: 'repair' }]);
    await travailProjection(c.compte, ops.map((o) => o.id));
    expect(await evenements(c.compte)).toHaveLength(2);

    // Contrôle : décision d'identité suspecte → nouvelle décision T3 demandée (jamais la même règle rejouée).
    await campagne([c.compte.id], 'CORRECTIVE');
    const t3 = (await reparations(c.compte.id, 'COH-OPS-IDENTITY')).filter((x) => x.reevaluation_kind === 'SEMANTIC_REEVALUATION_T3');
    expect(t3).toEqual([expect.objectContaining({ anomaly: 'IDENTITY_DECISION_OUTDATED', service: 'requestIdentityReevaluation' })]);
    expect((await reevaluations(c.compte)).filter((r) => r.scope === 'T3')).toEqual([expect.objectContaining({ status: 'PENDING', trigger_kind: 'COHERENCE' })]);

    // T3 (file durable : passages de consolidation) — le modèle reconnaît maintenant la même réparation.
    m3.verdict = 'SAME';
    await stabiliser();
    const actives = await k.actives(c.compte);
    expect(actives).toHaveLength(1);
    expect((await reevaluations(c.compte)).filter((r) => r.scope === 'T3')).toEqual([expect.objectContaining({ status: 'APPLIED', reason: 'T3_RETRO_MERGE' })]);

    // T3 → T4 : la fusion rejoue la projection (file durable) ; deux représentations → décision T4.
    await simuler();
    t4.answer = (input) => decision([occ(aDecider(input), principalRef(input), 'PRINCIPAL')]);
    const r = await travailProjection(c.compte, [actives[0].id]);
    expect((r.detail as Json).semantic).toMatchObject({ outcomes: { APPLIED: 1 } });
    const evts = await evenements(c.compte);
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ op: actives[0].id, role: 'PRINCIPAL' });
    expect([...evts[0].files].sort()).toEqual([a, b].sort());
    // Convergence : un nouveau contrôle ne redemande ni T3 ni T4.
    const appels = t4.calls;
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(t4.calls).toBe(appels);
    expect((await reevaluations(c.compte)).filter((x) => x.scope === 'T3')).toHaveLength(1);
  });

  // ══ Cas 7 ═════════════════════════════════════════════════════════════════

  it('L87B-E2E-07 / cas 7 — l’utilisateur détache un document d’un événement : ni le contrôle, ni la projection, ni T4 ne rétablissent le lien', async () => {
    const c = await contexte();
    const { f2, op } = await deuxDescriptions(c);
    const [e1, e2] = await evenements(c.compte);
    await lier(c.compte, op, e1.id, 'PRINCIPAL');
    await lier(c.compte, op, e2.id, 'RELATED');
    // Le principal reçoit les documents de l'ensemble (propagation) ; l'utilisateur détache le second document.
    const { withGroupingWrite, detachDocumentFromAgendaItem } = await import('@/services/business-operations/grouping/service');
    await withGroupingWrite(c.compte.id, (ctx) => detachDocumentFromAgendaItem(ctx, { itemId: e1.id, fileId: f2 }));
    const lien = () => sql`SELECT 1 FROM agenda_file_links WHERE agenda_item_id = ${e1.id} AND asset_file_id = ${f2}`;
    expect(await lien()).toHaveLength(0);
    // T4 juge les deux éléments comme la même occurrence : absorber e2 reporterait le document détaché sur e1 → refus en bloc.
    await simuler();
    t4.answer = (input) => decision([occ(aDecider(input), principalRef(input), 'PRINCIPAL')]);
    await campagne([c.compte.id], 'CORRECTIVE');
    await projeter(c.compte);
    await travailProjection(c.compte, [op]);
    expect(await lien()).toHaveLength(0);
    expect(await evenements(c.compte)).toHaveLength(2);
    // Chaque décision T4 obtenue (une par contexte distinct) est refusée en bloc : objet protégé.
    const t4Decisions = (await reevaluations(c.compte)).filter((r) => r.scope === 'T4' && r.ai_calls > 0);
    expect(t4Decisions.length).toBeGreaterThan(0);
    expect(t4Decisions.every((r) => r.status === 'REJECTED' && r.reason === 'PROTECTED_OBJECT:USER_DETACHED_LINK' && r.mutations_applied.length === 0)).toBe(true);
    expect(t4.inputs[0].userDecisions).toContainEqual(expect.objectContaining({ kind: 'LINK_DETACHED' }));
    // La décision de l'utilisateur reste active ; une campagne de plus ne change rien et ne redemande rien.
    expect((await sql`SELECT 1 FROM business_operation_match_decisions WHERE account_id = ${c.compte.id} AND source_kind = 'AGENDA_FILE_LINK' AND decision = 'REJECTED' AND active`).length).toBe(1);
    const appels = t4.calls;
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await lien()).toHaveLength(0);
    expect(t4.calls).toBe(appels);
  });

  // ══ Cas 8 ═════════════════════════════════════════════════════════════════

  it('L87B-E2E-08 / cas 8 — réponse IA invalide, puis état changé pendant l’application : décision refusée et tracée, AUCUNE mutation partielle, état cohérent conservé', async () => {
    const c = await contexte();
    const { op } = await deuxDescriptions(c);
    const avant = await evenements(c.compte);
    await simuler();
    // a) Référence inexistante : refus en bloc (aucun repli heuristique).
    t4.answer = (input) => decision([occ([refDe(input, 'Réparation — Maison'), 'A9'], refDe(input, 'Réparation — Maison'), 'PRINCIPAL')]);
    const r1 = await travailProjection(c.compte, [op]);
    expect((r1.detail as Json).semantic).toMatchObject({ outcomes: { REJECTED: 1 } });
    expect(await evenements(c.compte)).toEqual(avant);
    const j1 = (await reevaluations(c.compte)).at(-1)!;
    expect(j1).toMatchObject({ status: 'REJECTED', reason: 'INVALID_DECISION:UNKNOWN_REFERENCE', ai_calls: 1, mutations_applied: [] });
    expect(j1.validation).toMatchObject({ valid: false, problems: expect.arrayContaining([expect.objectContaining({ issue: 'UNKNOWN_REFERENCE' })]) });
    // Même contexte : la décision refusée n'est pas redemandée.
    await travailProjection(c.compte, [op]);
    expect(t4.calls).toBe(1);

    // b) Nouveau contexte (nouvelle preuve) ; l'élément à absorber disparaît PENDANT la décision : garde à
    //    l'application → transaction annulée en entier (le rattachement déjà fait est défait), refus tracé.
    const f3 = await facture(c, { summary: 'Photo de la réparation', facture: 'F-26-20', date: '2026-03-20', type: 'PHOTO_REPORT' });
    await k.passer(c.compte, { today: AUJ });
    await persisterT4(c, f3, [{ title: 'Constat réparation', date: '2026-03-20', businessType: 'repair' }]);
    const etat = await evenements(c.compte);
    const absorbe = etat.find((e) => e.title === 'Intervention plombier')!;
    t4.answer = async (input) => {
      await sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${absorbe.id}`;
      return decision([occ(aDecider(input), principalRef(input), 'PRINCIPAL')]);
    };
    const r2 = await travailProjection(c.compte, [op]);
    expect((r2.detail as Json).semantic).toMatchObject({ outcomes: { REJECTED: 1 } });
    const apres = await evenements(c.compte);
    expect(apres.map((e) => ({ id: e.id, op: e.op, role: e.role }))).toEqual(etat.map((e) => ({ id: e.id, op: e.op, role: e.role })));
    expect(await journal0591(c.compte)).toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: 'ABSORB' })]));
    expect((await reevaluations(c.compte)).at(-1)).toMatchObject({ status: 'REJECTED', reason: 'STATE_CHANGED', mutations_applied: [] });
  });

  // ══ Reprise du stock (CODE-07) ═══════════════════════════════════════════

  it('L87B-E2E-09 — reprise BO du stock : simulation sans écriture, application ciblée (compte), rejouée sans appel ni effet, restauration ; isolation des comptes', async () => {
    const a = await contexte();
    const sa = await deuxDescriptions(a);
    const b = await contexte();
    await deuxDescriptions(b);
    const avantA = await evenements(a.compte);
    const avantB = await evenements(b.compte);
    await simuler();
    t4.answer = (input) => decision([occ(aDecider(input), principalRef(input), 'PRINCIPAL')]);
    const { runAgendaDuplicatesReprise, restoreAgendaDuplicatesReprise } = await import('@/services/business-operations/agenda-projection/duplicates-reprise');

    const sim = await runAgendaDuplicatesReprise({ mode: 'SIMULATE', origin: 'BO', accountId: a.compte.id });
    expect(sim.counters).toMatchObject({ t4Required: 1, t4Applied: 0, aiCalls: 0 });
    expect(sim.report).toContainEqual(expect.objectContaining({ category: 'T4_DECISION', operationId: sa.op, detail: expect.objectContaining({ status: 'WOULD_REQUEST' }) }));
    expect(await evenements(a.compte)).toEqual(avantA);
    expect(t4.calls).toBe(0);

    const app = await runAgendaDuplicatesReprise({ mode: 'APPLY', origin: 'BO', accountId: a.compte.id, reason: 'e2e' });
    expect(app.counters).toMatchObject({ t4Applied: 1, aiCalls: 1 });
    expect(await evenements(a.compte)).toHaveLength(1);
    expect(await evenements(b.compte)).toEqual(avantB);
    expect((await reevaluations(a.compte)).at(-1)).toMatchObject({ trigger_kind: 'REPRISE', status: 'APPLIED' });

    const bis = await runAgendaDuplicatesReprise({ mode: 'APPLY', origin: 'BO', accountId: a.compte.id, reason: 'e2e bis' });
    expect(bis.counters).toMatchObject({ t4Applied: 0, aiCalls: 0 });
    expect(t4.calls).toBe(1);

    const rest = await restoreAgendaDuplicatesReprise(sql as never, app.runId);
    expect(rest.conflicts).toEqual([]);
    expect((await evenements(a.compte)).map((e) => e.id).sort()).toEqual(avantA.map((e) => e.id).sort());
  });

  // ══ Coût borné ════════════════════════════════════════════════════════════

  it('L87B-E2E-10 — coût IA borné : plafond par passage et sur 24 h (plafonds existants) → report tracé, aucun appel au-delà', async () => {
    const c = await contexte();
    const { op } = await deuxDescriptions(c);
    await simuler();
    t4.answer = (input) => decision([occ(aDecider(input), principalRef(input), 'PRINCIPAL')]);
    const { reevaluateRepresentation } = await semantique();
    const parPassage = await reevaluateRepresentation({ accountId: c.compte.id, operationId: op, trigger: 'MANUAL', today: AUJ, passCalls: { n: 5 }, deps: { passMax: 5 } });
    expect(parPassage).toMatchObject({ status: 'DEFERRED', reason: 'PASS_CAP', aiCalls: 0 });
    const parJour = await reevaluateRepresentation({ accountId: c.compte.id, operationId: op, trigger: 'MANUAL', today: AUJ, deps: { dailyMax: 0 } });
    expect(parJour).toMatchObject({ status: 'DEFERRED', reason: 'DAILY_CAP', aiCalls: 0 });
    expect(t4.calls).toBe(0);
    expect((await reevaluations(c.compte)).map((r) => [r.status, r.reason])).toEqual([['DEFERRED', 'DAILY_CAP']]);
    expect(await evenements(c.compte)).toHaveLength(2);
  });
});
