/**
 * Lot 76H — [P1] Opérations → Agenda : doublons d'interventions (« Réparation
 * — Maison » / « Entretien réalisé — Prestation » du 07/07/2021 issus d'un
 * même document) — base PostgreSQL 16 réelle.
 *
 * Chaîne de PRODUCTION : candidats T1 par la persistance T1 réelle, T3 par
 * `consolidateAccountOperations`, T4 par `persistAgendaDecisions` (décisions
 * T4 telles que le moteur les produit pour ce document : réparation datée du
 * document, entretien lu dans `lastRevision`), Agenda par
 * `projectAccountOperations`, rattrapage par son service, diagnostic par le
 * dossier BO « Données du compte ». Aucun appel IA (M3 coupé). Assertions
 * limitées aux comptes créés ici.
 *
 * Lot 87B (ticket « orchestration T3/T4 ») — tests CORRIGÉS : ils attendaient
 * une absorption décidée par la projection (provenance T3 + type + date). La
 * décision « même occurrence » appartient désormais à T4 (réévaluation
 * sémantique multi-événements) : sans contrat T4 livré, la projection
 * s'abstient (deux éléments, carte D14, constat) ; avec le décideur T4
 * SIMULÉ, la consolidation est appliquée par le même moteur 76H (preuves,
 * liens, journal 0591 restaurable).
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';
import { cand, cible, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const JOUR = '2021-07-07';
type Json = Record<string, any>;

const bus = () => import('@/services/business-operations/events');
const projection = () => import('@/services/business-operations/agenda-projection/service');
const persistence = () => import('@/services/agenda/agenda-persistence');
const reprise = () => import('@/services/business-operations/agenda-projection/duplicates-reprise');

/** Lot 87B : décideur T4 multi-événements SIMULÉ — les représentations à décider sont la même occurrence ; le principal est conservé. */
const t4Simule = {
  calls: 0,
  async capability() { return { available: true, version: 'simule-76h', reason: 'AVAILABLE' as const }; },
  async decide(call: { input: import('@/services/business-operations/semantic/contract').RepresentationInput }) {
    t4Simule.calls++;
    const items = call.input.agendaItems.filter((i) => i.inScope);
    const keep = (items.find((i) => i.role === 'PRINCIPAL') ?? items.find((i) => i.origin !== 'PROJECTION') ?? items[0]).ref;
    return { output: { task: 'AGENDA_REPRESENTATION', outcome: 'DECIDED', reason: 'même occurrence',
      occurrences: [{ items: items.map((i) => i.ref), keep, role: 'PRINCIPAL', confidence: 'certain', evidence: [], reason: 'même intervention' }], restorations: [] }, traceId: null };
  },
};
const decideur = () => import('@/services/business-operations/semantic/decider');

scenario('L76H', 'Opérations → Agenda : une intervention établie = un seul événement d’agenda (T1 → T3 → T4 → Agenda, rattrapage, diagnostic BO)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
  });
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
    (await decideur()).__setRepresentationDeciderForTests(null);
  });
  const avecT4 = async () => { t4Simule.calls = 0; (await decideur()).__setRepresentationDeciderForTests(t4Simule); };
  /** Exécutant réel de la file de projection (projection, puis décisions T4 demandées). */
  async function travail(compte: AccountRow) {
    const { runAgendaProjectionJob } = await import('@/services/business-operations/agenda-projection/queue');
    return runAgendaProjectionJob({ id: 8_000_000 + compte.id } as never, {
      kind: 'business_operations_agenda' as never, accountId: compte.id, events: [{ all: true, correlationId: 'l76h-job' }], requestedAt: null,
    }, { assertActive: async () => undefined } as never);
  }

  async function contexte(): Promise<{ compte: AccountRow & { owner: { id: number } }; maison: AssetRow }> {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    return { compte, maison };
  }
  /** Facture de plomberie du 07/07/2021 : un candidat T1 d'intervention (ou ceux fournis). */
  async function facture(c: { compte: AccountRow; maison: AssetRow }, candidats?: ReturnType<typeof cand>[]): Promise<number> {
    return k.document(c.compte, c.maison.id, candidats ?? [cand({
      summary: 'Remplacement du ballon d’eau chaude', provider: 'Plomberie Durand', targetHints: [cible(c.maison.id)],
      businessReferences: [ref('INVOICE', 'F-2021-77')], temporalHints: { realizedDate: JOUR },
    })], { type: 'WORKS_INVOICE', title: 'Prestation', date: JOUR });
  }
  /** Décisions T4 du document (même forme que le moteur T4). */
  const decisions = (fileId: number, assetId: number) => [
    {
      action: 'create', title: 'Réparation — Maison', date: JOUR, category: 'information', confidence: 'certain', reasonCode: 'NEW_EVENT', deterministic: true,
      sourceFileId: fileId, nature: 'HISTORICAL', businessType: 'repair', occurrenceIndex: JOUR, target: { type: 'ASSET', id: assetId },
      sources: [{ fileId, role: 'SOURCE' }],
    },
    {
      action: 'create', title: 'Entretien réalisé — Prestation', date: JOUR, category: 'information', confidence: 'certain', reasonCode: 'NEW_EVENT', deterministic: true,
      sourceFileId: fileId, nature: 'HISTORICAL', businessType: 'maintenance', originFieldKey: 'lastRevision', occurrenceIndex: 'single',
      target: { type: 'ASSET', id: assetId }, sources: [{ fileId, role: 'SOURCE' }],
    },
  ] as never[];
  const t4 = async (c: { compte: AccountRow; maison: AssetRow }, fileId: number) =>
    (await persistence()).persistAgendaDecisions(decisions(fileId, c.maison.id), c.compte.id, c.maison.id, { sourceFileId: fileId, analysisComplete: true });
  const projeter = async (compte: AccountRow) => (await projection()).projectAccountOperations(compte.id, { all: true, correlationId: 'l76h' });
  const evenements = (compte: AccountRow) => sql<Json[]>`
    SELECT i.id, i.title, i.start_date::text AS date, i.business_type, i.business_operation_id::int AS op, i.projection_origin, i.is_automatic,
           i.is_automatic_modified,
           (SELECT array_agg(l.asset_file_id ORDER BY l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = i.id) AS files,
           (SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = i.id) AS assets,
           (SELECT count(*)::int FROM agenda_item_sources s WHERE s.agenda_item_id = i.id) AS sources
      FROM agenda_items i WHERE i.account_id = ${compte.id} ORDER BY i.id`;
  /** État final comparable quel que soit l'ordre (titre, date, Opération, liens). */
  const etat = async (compte: AccountRow) => (await evenements(compte)).map((e) => ({ title: e.title, date: e.date, op: e.op !== null, files: e.files?.length ?? 0, assets: e.assets?.length ?? 0 }));
  const journal = (compte: AccountRow) => sql<Json[]>`SELECT kind, principal_item_id, absorbed_item_id, origin, restored_at FROM agenda_intervention_consolidations WHERE account_id = ${compte.id} ORDER BY id`;
  const cartes = (compte: AccountRow) => sql<Json[]>`
    SELECT rule_code, resolved_at, resolution_reason FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'AGENDA-PROJECTION-MATCH' ORDER BY id`;

  // ══ Chaîne T1 → T3 → T4 → Agenda ══════════════════════════════════════════

  it('L76H-E01 — chaîne réelle T1 → T3 → T4 → Agenda : sans T4 multi-événements, aucune absorption (carte) ; avec T4, UN événement (lié, intitulé précis, preuves et liens conservés) ; réanalyse : aucun doublon recréé', async () => {
    const c = await contexte();
    const f = await facture(c);
    await k.passer(c.compte);
    const [op, ...autresOps] = await k.actives(c.compte);
    expect(autresOps).toEqual([]);
    await t4(c, f);
    // Avant convergence : les deux représentations T4 du constat (07/07/2021).
    expect((await evenements(c.compte)).map((e) => e.title).sort()).toEqual(['Entretien réalisé — Prestation', 'Réparation — Maison']);
    const sourcesAvant = (await evenements(c.compte)).reduce((n, e) => n + e.sources, 0);
    // Lot 87B : la projection n'absorbe plus rien — décision T4 demandée, carte D14 en attendant.
    const r = await projeter(c.compte);
    expect(r).toMatchObject({ created: 0, representationRequired: [expect.objectContaining({ operationId: op.id })] });
    expect(await evenements(c.compte)).toHaveLength(2);
    expect((await cartes(c.compte)).filter((x) => x.resolved_at === null)).toHaveLength(1);
    await avecT4();
    await travail(c.compte);
    expect(t4Simule.calls).toBe(1);
    const [evt, ...autres] = await evenements(c.compte);
    expect(autres).toEqual([]);
    expect(evt).toMatchObject({ title: 'Remplacement du ballon d’eau chaude', date: JOUR, op: op.id, projection_origin: null, files: [f], assets: [c.maison.id] });
    // Preuves conservées : déplacées vers le principal, ou (même document et
    // même rôle déjà cités par le principal) gardées et rattachables à la restauration.
    expect(evt.sources).toBeGreaterThanOrEqual(1);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_item_sources WHERE asset_file_id = ${f}`)[0].n).toBe(sourcesAvant);
    expect((await journal(c.compte)).map((j) => j.kind).sort()).toEqual(['ABSORB', 'RETITLE']);
    expect(await sql`SELECT reason FROM agenda_item_removals WHERE account_id = ${c.compte.id}`).toEqual([{ reason: 'OPERATION_CONSOLIDATION' }]);
    expect((await cartes(c.compte)).filter((x) => x.resolved_at === null)).toEqual([]);
    // Idempotence et réanalyse : aucune écriture, aucun doublon recréé, intitulé précis conservé, aucun nouvel appel T4.
    expect((await projeter(c.compte)).changes).toBe(0);
    await travail(c.compte);
    expect(t4Simule.calls).toBe(1);
    // Réanalyse complète : nouveaux candidats T1 (en attente T3), T4 AVANT T3, puis T3 et projection.
    await k.t1(c.compte, f, [cand({
      summary: 'Remplacement du ballon d’eau chaude', provider: 'Plomberie Durand', targetHints: [cible(c.maison.id)],
      businessReferences: [ref('INVOICE', 'F-2021-77')], temporalHints: { realizedDate: JOUR },
    })], true);
    await t4(c, f);
    expect(await evenements(c.compte)).toHaveLength(1);
    await k.passer(c.compte);
    await travail(c.compte);
    expect(await evenements(c.compte)).toEqual([expect.objectContaining({ id: evt.id, title: 'Remplacement du ballon d’eau chaude', op: op.id })]);
  });

  it('L76H-E02 — ordre T4 → T3 / T3 → T4 / T3 → projection → T4 : même état final (un événement de l’intervention, décidé par T4)', async () => {
    await avecT4();
    const finals: unknown[] = [];
    // a) T4 avant T3.
    {
      const c = await contexte();
      const f = await k.document(c.compte, c.maison.id, [], { type: 'WORKS_INVOICE', title: 'Prestation', date: JOUR });
      await t4(c, f);
      await k.t1(c.compte, f, [cand({ summary: 'Remplacement du ballon d’eau chaude', provider: 'Plomberie Durand', targetHints: [cible(c.maison.id)], businessReferences: [ref('INVOICE', 'F-2021-77')], temporalHints: { realizedDate: JOUR } })], true);
      await k.passer(c.compte);
      await travail(c.compte);
      finals.push(await etat(c.compte));
    }
    // b) T3 puis T4, projection ensuite.
    {
      const c = await contexte();
      const f = await facture(c);
      await k.passer(c.compte);
      await t4(c, f);
      await travail(c.compte);
      finals.push(await etat(c.compte));
    }
    // c) T3, projection (événement projeté), puis T4 : T4 réutilise la représentation existante.
    {
      const c = await contexte();
      const f = await facture(c);
      await k.passer(c.compte);
      await projeter(c.compte);
      await t4(c, f);
      await travail(c.compte);
      finals.push(await etat(c.compte));
    }
    expect(finals[0]).toEqual([{ title: 'Remplacement du ballon d’eau chaude', date: JOUR, op: true, files: 1, assets: 1 }]);
    expect(finals[1]).toEqual(finals[0]);
    expect(finals[2]).toEqual(finals[0]);
  });

  it('L76H-E03 — deux candidats T1 de la même facture (même référence) : UNE Opération (T3) puis un événement ; deux travaux sans référence commune : deux Opérations, deux événements', async () => {
    const c = await contexte();
    const base = { provider: 'Plomberie Durand', targetHints: [cible(c.maison.id)], businessReferences: [ref('INVOICE', 'F-2021-77')], temporalHints: { realizedDate: JOUR } };
    const f = await facture(c, [cand({ ...base, candidateKey: 'op1', summary: 'Remplacement du ballon d’eau chaude' }), cand({ ...base, candidateKey: 'op2', summary: 'Entretien' })]);
    await k.passer(c.compte);
    expect(await k.actives(c.compte)).toHaveLength(1);
    expect((await k.candidat(f)).map((x) => x.t3_outcome)).toEqual(['CREATE_NEW', 'MATCH_AND_ENRICH']);
    await t4(c, f);
    await avecT4();
    await travail(c.compte);
    expect(await evenements(c.compte)).toHaveLength(1);
    (await decideur()).__setRepresentationDeciderForTests(null);

    // F-027 : deux travaux indépendants sur un même document (aucune référence propre commune).
    const d = await contexte();
    const g = await facture(d, [
      cand({ candidateKey: 'op1', summary: 'Réparation fuite', provider: 'Multi Services', targetHints: [cible(d.maison.id)], temporalHints: { realizedDate: JOUR } }),
      cand({ candidateKey: 'op2', summary: 'Entretien chaudière', provider: 'Multi Services', targetHints: [cible(d.maison.id)], temporalHints: { realizedDate: JOUR } }),
    ]);
    await k.passer(d.compte);
    expect(await k.actives(d.compte)).toHaveLength(2);
    await t4(d, g);
    await projeter(d.compte);
    expect(await evenements(d.compte)).toHaveLength(2);
    expect((await journal(d.compte)).filter((j) => j.kind === 'ABSORB')).toEqual([]);
    // Identité incertaine : arbitrage existant (carte « À traiter »), aucune fusion.
    expect((await cartes(d.compte)).length).toBeGreaterThan(0);
  });

  it('L76H-E04 — événement modifié par l’utilisateur : jamais supprimé ni réécrit ; carte d’arbitrage à la place', async () => {
    const c = await contexte();
    const f = await facture(c);
    await k.passer(c.compte);
    await t4(c, f);
    const [rep] = (await evenements(c.compte)).filter((e) => e.business_type === 'repair');
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(rep.id, { title: 'Réparation (mon titre)' } as never, c.compte.id);
    expect((await sql<Json[]>`SELECT is_automatic_modified FROM agenda_items WHERE id = ${rep.id}`)[0].is_automatic_modified).toBe(true);
    await projeter(c.compte);
    const apres = await evenements(c.compte);
    expect(apres).toHaveLength(2);
    expect(apres.find((e) => e.id === rep.id)).toMatchObject({ title: 'Réparation (mon titre)' });
    expect(await journal(c.compte)).toEqual([]);
    expect((await cartes(c.compte)).filter((x) => x.resolved_at === null)).toHaveLength(1);
  });

  it('L76H-E05 — exécutions concurrentes (projections + rattrapage) : pas de doublon, journal sans double absorption', async () => {
    const c = await contexte();
    const f = await facture(c);
    await k.passer(c.compte);
    await t4(c, f);
    await avecT4();
    const { runAgendaDuplicatesReprise } = await reprise();
    const r = await Promise.allSettled([
      projeter(c.compte), projeter(c.compte), projeter(c.compte),
      runAgendaDuplicatesReprise({ mode: 'APPLY', origin: 'BO', accountId: c.compte.id, reason: 'e2e concurrence' }),
    ]);
    expect(r.filter((x) => x.status === 'rejected')).toEqual([]);
    expect(await evenements(c.compte)).toHaveLength(1);
    expect((await journal(c.compte)).filter((j) => j.kind === 'ABSORB')).toHaveLength(1);
  });

  it('L76H-E06 — rattrapage du stock : simulation sans écriture, application, rejoué sans nouvel effet, restauration complète puis jamais réabsorbé ; isolation des comptes', async () => {
    const a = await contexte();
    const fa = await facture(a);
    await k.passer(a.compte);
    await t4(a, fa);
    const b = await contexte();
    const fb = await facture(b);
    await k.passer(b.compte);
    await t4(b, fb);
    const avantA = await evenements(a.compte);
    const avantB = await evenements(b.compte);
    const { runAgendaDuplicatesReprise, restoreAgendaDuplicatesReprise } = await reprise();
    await avecT4();

    const sim = await runAgendaDuplicatesReprise({ mode: 'SIMULATE', origin: 'BO', accountId: a.compte.id });
    expect(sim).toMatchObject({ status: 'succeeded', more: false, counters: expect.objectContaining({ t4Required: 1, t4Applied: 0, aiCalls: 0 }) });
    expect(sim.report).toContainEqual(expect.objectContaining({ accountId: a.compte.id, category: 'T4_DECISION', detail: expect.objectContaining({ status: 'WOULD_REQUEST' }) }));
    expect(await evenements(a.compte)).toEqual(avantA);
    expect(await journal(a.compte)).toEqual([]);

    const app = await runAgendaDuplicatesReprise({ mode: 'APPLY', origin: 'BO', accountId: a.compte.id, reason: 'e2e' });
    expect(app.counters).toMatchObject({ t4Applied: 1, aiCalls: 1 });
    expect(await evenements(a.compte)).toHaveLength(1);
    // Isolation : le compte B (filtre) n'est pas touché.
    expect(await evenements(b.compte)).toEqual(avantB);

    // Rejoué : aucun nouvel effet.
    const etatApres = await evenements(a.compte);
    const journalApres = await journal(a.compte);
    const bis = await runAgendaDuplicatesReprise({ mode: 'APPLY', origin: 'BO', accountId: a.compte.id, reason: 'e2e bis' });
    expect(bis.counters).toMatchObject({ t4Applied: 0, aiCalls: 0, linked: 0, retitled: 0 });
    expect(await evenements(a.compte)).toEqual(etatApres);
    expect(await journal(a.compte)).toEqual(journalApres);

    // Restauration : les deux événements d'origine reviennent (titres, liens, preuves).
    const rest = await restoreAgendaDuplicatesReprise(sql as never, app.runId);
    expect(rest.conflicts).toEqual([]);
    const restaures = await evenements(a.compte);
    expect(restaures.map((e) => ({ id: e.id, title: e.title, files: e.files, assets: e.assets, sources: e.sources })))
      .toEqual(avantA.map((e) => ({ id: e.id, title: e.title, files: e.files, assets: e.assets, sources: e.sources })));
    // La projection ne les réabsorbe plus : choix utilisateur (carte).
    await projeter(a.compte);
    expect(await evenements(a.compte)).toHaveLength(2);
    expect((await journal(a.compte)).every((j) => j.restored_at !== null)).toBe(true);
  });

  it('L76H-E07 — fusion de deux Opérations : la canonique garde UNE représentation cohérente (résidu de l’absorbée consolidé)', async () => {
    const c = await contexte();
    const f1 = await facture(c);
    const f2 = await k.document(c.compte, c.maison.id, [cand({ summary: 'Remplacement du ballon d’eau chaude', provider: 'Autre Plombier', targetHints: [cible(c.maison.id)], businessReferences: [ref('INVOICE', 'B-9')], temporalHints: { realizedDate: JOUR } })], { type: 'WORKS_INVOICE', title: 'Prestation', date: JOUR });
    await k.passer(c.compte);
    const [o1, o2, ...reste] = await k.actives(c.compte);
    expect(reste).toEqual([]);
    expect(o2).toBeDefined();
    await t4(c, f1);
    await t4(c, f2);
    await avecT4();
    await travail(c.compte);
    // Une représentation par Opération avant la fusion.
    expect((await evenements(c.compte)).map((e) => e.op).sort()).toEqual([o1.id, o2.id].sort());
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(c.compte.id, (repo) => repo.mergeOperations(o2.id, o1.id, 'E2E_MERGE'));
    await travail(c.compte);
    const apres = await evenements(c.compte);
    expect(apres).toEqual([expect.objectContaining({ op: o1.id, date: JOUR })]);
    expect((await journal(c.compte)).filter((j) => j.kind === 'ABSORB')).toHaveLength(3);
  });

  it('L76H-E08 — diagnostic BO (Comptes › Données du compte › document) : cause réelle lisible sans SQL', async () => {
    const { buildEntityDossier } = await import('@/services/admin/account-data/dossier');
    // Une Opération : convergence Agenda.
    const c = await contexte();
    const f = await facture(c);
    await k.passer(c.compte);
    await t4(c, f);
    const d1 = await buildEntityDossier(c.compte.id, 'document', f);
    const s1 = d1.sections.find((s) => s.id === 'doublons-interventions');
    expect(s1?.error).toBeUndefined();
    expect(s1?.fields?.[0]).toMatchObject({ raw: 'ONE_OPERATION', label: expect.stringContaining('07/07/2021') });
    for (const id of ['doublons-evenements', 'doublons-candidats', 'doublons-operations', 'doublons-decisions-t4', 'doublons-retraits', 'doublons-cartes', 'doublons-projection-jobs', 'doublons-journal']) {
      expect(d1.sections.find((s) => s.id === id)?.error).toBeUndefined();
    }
    // Aucune Opération : T3 n'a rien établi (candidat non établi).
    const n = await contexte();
    const g = await facture(n, [cand({ established: false, exclusionReason: 'NO_EVIDENCE', targetHints: [cible(n.maison.id)] })]);
    await k.passer(n.compte);
    await t4(n, g);
    const d2 = await buildEntityDossier(n.compte.id, 'document', g);
    expect(d2.sections.find((s) => s.id === 'doublons-interventions')?.fields?.[0]).toMatchObject({ raw: 'NO_OPERATION' });
    // Le dossier de l'événement porte le même diagnostic ; un autre compte : introuvable.
    const [evt] = await evenements(c.compte);
    const d3 = await buildEntityDossier(c.compte.id, 'agenda', evt.id);
    expect(d3.sections.some((s) => s.id === 'doublons-interventions')).toBe(true);
    await expect(buildEntityDossier(n.compte.id, 'document', f)).rejects.toThrow();
  });
});
