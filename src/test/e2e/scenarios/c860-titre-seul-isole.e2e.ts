/**
 * Carte #860 — T4 : mode « titre seulement » (titleOnly) ISOLÉ — cartes « À traiter » préservées, titre extrait
 * des SYNC mixtes — PostgreSQL 16 réel. Fournisseur d'IA SIMULÉ (sorties du modèle écrites ici), aucun réseau.
 *
 * Chemins de PRODUCTION : persistance T1, titre du document, consolidation T3 (`consolidateAccountOperations`,
 * `reconsolidateOperations`), correction de l'utilisateur (`correctOperation`, `updateAgendaItem`), projection T4
 * (`projectAccountOperations` ordinaire, simulée, `titleOnly`, `all`, paginée), cartes de rapprochement
 * (`syncAgendaProjectionCards`), écrivains `retitleAgendaItem` / `writeProjectionTitleOnly`, restauration du
 * journal 0591, reprise des titres d'achat (`reprisePurchaseTitles`).
 *
 *   C860-E2E-01  AC01 / AC02 / AC04 / AC09 : SYNC mixte {titre, date} d'une projection intacte — titre seul écrit
 *                sur le même ID, date et métadonnées de projection intactes ; carte de rapprochement ouverte d'une
 *                autre Opération du lot INCHANGÉE (aucun PROJECTION_RESOLVED) ; simulation et second passage sans
 *                écriture ; photo DB avant / après (seules différences : titre et traces) ; compte Duo
 *   C860-E2E-02  AC03 / AC09 / AC10 : plan à CREATE et orpheline — `all` + titleOnly paginé : ni création, ni
 *                nettoyage ; la projection ordinaire garde ses capacités (création, nettoyage, date, clôture de carte)
 *   C860-E2E-03  AC05 / AC06 / AC08 : RETITLE d'une projection modifiée (journal, même ID) ; édition concurrente du
 *                titre et invalidation de l'Opération entre plan et écriture : REFUSED, rien d'écrasé ; titre USER :
 *                aucune écriture ; autre compte, compte inéligible : aucune écriture ; restauration ciblée
 *   C860-E2E-04  AC07 / AC08 : reprise — SYNC mixte annoncée à blanc puis réellement écrite, compteurs du résultat
 *                réel, correction de date toujours en attente ; second passage nul
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';
import { gateOperationCandidates } from '@/services/ai/source-analysis/operation-candidates/prepare';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()),
  emitBusinessEvent: async () => undefined,
  emitBusinessEvents: async () => undefined,
}));

type Json = Record<string, any>;
const AUJ = '2026-11-20';
const NOM = 'Achat de carburant';

scenario('C860', 'T4 : mode « titre seulement » isolé — cartes À traiter préservées, titre extrait des SYNC mixtes (carte #860)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const projection = () => import('@/services/business-operations/agenda-projection/service');

  // ── Outils (mêmes chemins que C859 / L116I) ──────────────────────────────
  type Compte = AccountRow & { owner: { id: number } };
  async function compte(plan: 'premium' | 'premium_duo' = 'premium_duo'): Promise<{ compte: Compte; cupra: AssetRow; velo: AssetRow }> {
    const c = await make.account({ plan });
    return { compte: c, cupra: await make.asset(c, { category: 'VEHICULE', name: 'Cupra' }), velo: await make.asset(c, { category: 'OBJET', name: 'Vélo' }) };
  }
  /** Ticket de carburant analysé (modèle simulé) : l'opération naît « Achat » (aucune désignation encore). */
  async function ticket(c: AccountRow, assetId: number, o: { station: string; date: string; cents: number }): Promise<number> {
    const candidats = gateOperationCandidates([cand({
      typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', summary: 'Achat', provider: o.station,
      targetHints: [cible(assetId)], businessReferences: [ref('INVOICE', `TK-${o.station}-${o.date}`)] as never,
      temporalHints: { realizedDate: o.date }, financialHints: [fh('REALIZED_COST', o.cents, { economicDate: o.date })],
    })], {
      hasExploitableContent: true, documentTypeCode: 'ACQUISITION_INVOICE',
      verifiedIds: { ASSET: new Set([assetId]), EQUIPMENT: new Set(), ROOM: new Set() },
      capabilities: { rooms: false, equipments: false }, keptFactRefs: new Set(['f1']),
    }).candidates;
    const id = await k.document(c, assetId, candidats, { type: 'ACQUISITION_INVOICE', amountCents: o.cents, date: o.date });
    await sql`UPDATE asset_files SET supplier = ${o.station}, title_source = 'SYSTEM', last_analysis_at = now(), original_filename = ${`IMG_${6000 + id}.jpg`} WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = ${`Ticket de carburant ${o.station}`}, supplier_name = ${o.station}, document_date = ${o.date} WHERE file_id = ${id}`;
    const raw = { task: 'ANALYZE_DOCUMENT', document: {
      title: { value: `Ticket de carburant ${o.station}`, confidence: 'certain' }, type: { value: 'ACQUISITION_INVOICE', confidence: 'certain' },
      supplier: { value: { name: o.station }, confidence: 'certain' }, date: { value: o.date, confidence: 'certain' },
    } };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${id}, ${`h${id}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${c.id}, ${JSON.stringify(raw)})`;
    return id;
  }
  /** Le justificatif établit le nom fiable, puis la consolidation T3 ordinaire améliore l'intitulé (SYSTEM). */
  async function nommer(c: AccountRow, fileId: number, opId: number) {
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    await ensureBusinessTitle({ fileId, accountId: c.id, origin: 'T1', mode: 'refresh' });
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(c.id, [opId], { today: AUJ });
  }
  type Opts = Parameters<Awaited<ReturnType<typeof projection>>['projectAccountOperations']>[1];
  const projeter = async (c: AccountRow, o: Opts = {}) =>
    (await projection()).projectAccountOperations(c.id, { all: true, today: AUJ, correlationId: 'e2e-860', ...o });
  const opDe = async (c: AccountRow, fileId: number) => Number((await sql<Json[]>`
    SELECT operation_id::int AS op FROM business_operation_sources WHERE account_id = ${c.id} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(fileId)} AND active`)[0].op);
  const evenement = async (id: number) => (await sql<Json[]>`
    SELECT id::int AS id, title, start_date::text AS date, business_operation_id::int AS op, is_automatic_modified AS modifie, projection_origin AS origine,
           projection_correlation_id AS correlation, functional_key AS cle, business_type AS type, event_nature AS nature, home_category AS categorie,
           to_jsonb(i) -> 'title_provenance' AS prov
      FROM agenda_items i WHERE id = ${id}`)[0];
  const evtsDe = async (opId: number) => (await sql<Json[]>`SELECT id::int AS id FROM agenda_items WHERE business_operation_id = ${opId} ORDER BY id`).map((x) => Number(x.id));
  /** Carte « À traiter » : TOUTE la ligne (identifiant, état, résolution, contenu, cause) et son historique. */
  const cartes = async (c: AccountRow) => JSON.stringify({
    cartes: await sql`SELECT to_jsonb(a) AS a FROM to_process_actions a WHERE account_id = ${c.id} ORDER BY id`,
    historique: await sql`SELECT to_jsonb(e) AS e FROM to_process_action_events e WHERE account_id = ${c.id} ORDER BY id`,
  });
  /**
   * PHOTO de tout ce qu'un passage « titre seulement » ne doit PAS changer (AC09) : événements (toutes colonnes sauf
   * le titre, sa provenance et l'horodatage technique — métadonnées de projection, clé, type, nature COMPRISES),
   * liens, opérations, sources, montants, cartes et leur historique, retraits, rappels, notifications, traces
   * d'occurrence autres que celle du titre.
   */
  const photo = async (c: AccountRow) => JSON.stringify({
    evts: await sql`SELECT (to_jsonb(i) - 'title' - 'title_provenance' - 'updated_at') AS e FROM agenda_items i WHERE account_id = ${c.id} ORDER BY id`,
    ops: await sql`SELECT to_jsonb(o) AS o FROM business_operations o WHERE account_id = ${c.id} ORDER BY id`,
    liensOp: await sql`SELECT to_jsonb(l) AS l FROM business_operation_agenda_links l WHERE account_id = ${c.id} ORDER BY id`,
    biens: await sql`SELECT agenda_item_id, asset_id FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${c.id} ORDER BY 1, 2`,
    docs: await sql`SELECT agenda_item_id, asset_file_id, provenances FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${c.id} ORDER BY 1, 2`,
    sources: await sql`SELECT to_jsonb(s) AS s FROM business_operation_sources s WHERE account_id = ${c.id} ORDER BY id`,
    montants: await sql`SELECT to_jsonb(x) AS x FROM business_operation_financial_components x JOIN business_operations o ON o.id = x.operation_id WHERE o.account_id = ${c.id} ORDER BY x.id`,
    cartes: await cartes(c),
    retraits: await sql`SELECT count(*)::int AS n FROM agenda_item_removals WHERE account_id = ${c.id}`,
    occurrences: await sql`SELECT agenda_item_id, event_type FROM agenda_occurrence_events WHERE account_id = ${c.id} AND event_type <> 'TITLE_FROM_OPERATION' ORDER BY id`,
    rappels: await sql`SELECT count(*)::int AS n FROM agenda_deadline_reminders`,
    notifications: await sql`SELECT (SELECT count(*)::int FROM notification_events) AS e, (SELECT count(*)::int FROM notification_outbox) AS o`,
  });
  /** Événement candidat d'un rapprochement INCERTAIN (même bien, type compatible, même date, autre provenance). */
  async function candidatIncertain(c: AccountRow, assetId: number, date: string) {
    const [i] = await sql<Json[]>`INSERT INTO agenda_items (account_id, title, start_date, is_automatic, business_type, event_nature)
                                  VALUES (${c.id}, 'Achat au garage', ${date}, false, 'purchase', 'HISTORICAL') RETURNING id::int AS id`;
    await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${i.id}, ${assetId})`;
    return Number(i.id);
  }
  /**
   * Compte de base : A (Cupra) projeté « Achat » puis nommé et redaté → SYNC mixte {titre, date} ; B (vélo) dont la
   * représentation est incertaine (candidat signalé) → ABSTAIN légitime et carte de rapprochement OUVERTE.
   */
  async function base(plan: 'premium' | 'premium_duo' = 'premium_duo') {
    const { compte: c, cupra, velo } = await compte(plan);
    const fA = await ticket(c, cupra.id, { station: 'TotalEnergies', date: AUJ, cents: 6230 });
    await k.passer(c, { today: AUJ });
    await projeter(c);
    const opA = await opDe(c, fA);
    const [evtA] = await evtsDe(opA);
    const fB = await ticket(c, velo.id, { station: 'Decathlon', date: '2026-11-10', cents: 3990 });
    await k.passer(c, { today: AUJ });
    const opB = await opDe(c, fB);
    const candidat = await candidatIncertain(c, velo.id, '2026-11-10');
    await projeter(c); // projection ORDINAIRE : ABSTAIN + carte de rapprochement de B
    expect(await evtsDe(opB)).toEqual([]);
    const [carte] = await sql<Json[]>`SELECT id::int AS id, resolved_at FROM to_process_actions WHERE account_id = ${c.id} AND rule_code = 'AGENDA-PROJECTION-MATCH'`;
    expect(carte).toMatchObject({ resolved_at: null });
    // Projection INTACTE dont la date a divergé (état d'une version antérieure, aucun geste de l'utilisateur).
    await sql`UPDATE agenda_items SET start_date = '2026-11-18' WHERE id = ${evtA}`;
    await nommer(c, fA, opA);
    expect(await evenement(evtA)).toMatchObject({ title: 'Achat', date: '2026-11-18', origine: 'OPERATION', modifie: false });
    return { c, cupra, velo, fA, opA, evtA, fB, opB, candidat, carte: carte.id as number };
  }

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('C860-E2E-01 — SYNC mixte : titre seul écrit (même ID), date et métadonnées intactes ; carte d’arbitrage d’une autre Opération du lot inchangée ; simulation et second passage nuls', async () => {
    const { c, opA, evtA, opB, carte } = await base();
    // Le plan ORDINAIRE simulé : SYNC MIXTE {titre, date} sur la projection de A ; ABSTAIN (carte) pour B.
    const ordinaire = await projeter(c, { dryRun: true });
    expect(ordinaire.plans?.find((p) => p.operationId === opA)?.actions).toEqual([{ kind: 'SYNC', itemId: evtA, changes: { title: NOM, date: AUJ } }]);
    expect(ordinaire.plans?.find((p) => p.operationId === opB)?.actions.map((a) => a.kind)).toEqual(['ABSTAIN', 'REPRESENTATION_REQUIRED']);
    const avantEvt = await evenement(evtA);
    const avant = await photo(c);
    const avantCartes = await cartes(c);

    // AC02 : SIMULATION « titre seulement » — titre prévu, AUCUNE écriture (ni élément, ni carte).
    const simu = await projeter(c, { operationIds: [opA, opB], all: false, titleOnly: true, dryRun: true });
    expect(simu.titleOnly).toEqual([{ operationId: opA, itemId: evtA, source: 'SYNC', plannedFrom: 'Achat', plannedTitle: NOM, before: 'Achat', after: NOM, status: 'PLANNED', reason: null }]);
    expect(simu.changes).toBe(0);
    expect(await evenement(evtA)).toEqual(avantEvt);
    expect(await photo(c)).toBe(avant);

    // AC01 / AC04 : passage RÉEL ciblé sur le LOT {A, B}.
    const r = await projeter(c, { operationIds: [opA, opB], all: false, titleOnly: true, correlationId: 'e2e-860-titre' });
    expect(r.titleOnly).toEqual([{ operationId: opA, itemId: evtA, source: 'SYNC', plannedFrom: 'Achat', plannedTitle: NOM, before: 'Achat', after: NOM, status: 'RENAMED', reason: null }]);
    expect(r).toMatchObject({ operations: 2, retitled: 1, changes: 1, created: 0, updated: 0, linked: 0, removed: 0, detached: 0, abstained: 0, suppressed: 0 });
    expect(r.matchCards ?? 0).toBe(0);
    expect(r.dateCards ?? 0).toBe(0);
    expect(r.representationRequired).toBeUndefined();
    // Titre seul, MÊME ID ; date actuelle conservée ; métadonnées de projection, clé, type, nature, catégorie INTACTES
    // (la SYNC ordinaire aurait réécrit `projection_correlation_id`).
    expect(await evenement(evtA)).toEqual({ ...avantEvt, title: NOM, prov: expect.objectContaining({ origin: 'SYSTEM', value: NOM, previous: 'Achat', reason: 'T4_PROJECTION_TITLE_ONLY' }) });
    // Carte de rapprochement de B : ligne entière et historique identiques — aucun PROJECTION_RESOLVED.
    expect(await cartes(c)).toBe(avantCartes);
    expect(await sql`SELECT 1 FROM to_process_action_events WHERE action_id = ${carte} AND details ->> 'reason' = 'PROJECTION_RESOLVED'`).toEqual([]);
    expect((await sql<Json[]>`SELECT resolved_at FROM to_process_actions WHERE id = ${carte}`)[0].resolved_at).toBeNull();
    // AC09 : seules différences — titre et traces nécessaires (journal 0591 restaurable, trace d'occurrence).
    expect(await photo(c)).toBe(avant);
    expect(await sql`SELECT kind, reason, detail ->> 'from' AS de, detail ->> 'to' AS vers, detail ->> 'source' AS source FROM agenda_intervention_consolidations WHERE principal_item_id = ${evtA}`)
      .toEqual([{ kind: 'RETITLE', reason: 'OPERATION_TITLE_ONLY', de: 'Achat', vers: NOM, source: 'SYNC' }]);
    // La correction de DATE reste EN ATTENTE pour la projection ordinaire.
    const apres = await projeter(c, { dryRun: true });
    expect(apres.plans?.find((p) => p.operationId === opA)?.actions).toEqual([{ kind: 'SYNC', itemId: evtA, changes: { date: AUJ } }]);

    // AC08 : second passage — zéro modification, cartes intactes, simulation identique.
    const encore = await projeter(c, { operationIds: [opA, opB], all: false, titleOnly: true });
    expect(encore).toMatchObject({ changes: 0, titleOnly: [] });
    expect(await photo(c)).toBe(avant);
    // AC02 : lot sans aucun titre (B seul : ABSTAIN) — aucune carte touchée, aucune réévaluation, même en simulation.
    for (const dryRun of [true, false]) expect(await projeter(c, { operationIds: [opB], all: false, titleOnly: true, dryRun })).toMatchObject({ changes: 0, titleOnly: [] });
    expect(await cartes(c)).toBe(avantCartes);

    // AC08 : restauration ciblée du titre journalisé — jamais par-dessus une édition USER ultérieure.
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(evtA, { title: 'Plein de la Cupra' }, c.id, c.owner.id);
    const [j] = await sql<Json[]>`SELECT id::int AS id FROM agenda_intervention_consolidations WHERE principal_item_id = ${evtA} AND kind = 'RETITLE'`;
    const { restoreAgendaConsolidations } = await import('@/services/business-operations/agenda-projection/consolidation');
    const { pgClient } = await import('@/db');
    await restoreAgendaConsolidations(pgClient, { journalIds: [j.id], restoreRunId: '00000000-0000-4000-8000-000000000864' });
    expect(await evenement(evtA)).toMatchObject({ title: 'Plein de la Cupra', prov: { origin: 'USER' } });
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('C860-E2E-02 — `all` + titleOnly paginé : ni création, ni nettoyage d’orpheline, ni carte ; la projection ordinaire garde ses capacités', async () => {
    const { c, cupra, evtA, opB, candidat, carte } = await base('premium');
    // C : un achat dont l'événement a disparu (CREATE au plan ordinaire) ; une projection ORPHELINE (Opération disparue).
    const fC = await ticket(c, cupra.id, { station: 'Esso', date: '2026-10-02', cents: 5510 });
    await k.passer(c, { today: AUJ });
    const opC = await opDe(c, fC);
    const [orph] = await sql<Json[]>`INSERT INTO agenda_items (account_id, title, start_date, is_automatic, projection_origin, functional_key)
                                     VALUES (${c.id}, 'Achat orphelin', '2026-09-01', true, 'OPERATION', 'op:999999:ACQUISITION') RETURNING id::int AS id`;
    const plans = await projeter(c, { dryRun: true });
    expect(plans.plans?.find((p) => p.operationId === opC)?.actions.map((a) => a.kind)).toEqual(['CREATE']);
    const avant = await photo(c);

    // `all` + titleOnly, PAGINÉ (une Opération par page) : seul le titre de A est écrit.
    const r = await projeter(c, { titleOnly: true, pageSize: 1 });
    expect(r.pages).toBeGreaterThanOrEqual(3);
    expect(r).toMatchObject({ retitled: 1, changes: 1, created: 0, removed: 0, detached: 0, linked: 0 });
    expect(r.titleOnly?.map((t) => [t.itemId, t.status])).toEqual([[evtA, 'RENAMED']]);
    expect(await photo(c)).toBe(avant); // aucune création, l'orpheline est toujours là, cartes identiques
    expect(await sql`SELECT id::int AS id FROM agenda_items WHERE id = ${orph.id}`).toEqual([{ id: orph.id }]);
    expect(await evtsDe(opC)).toEqual([]);
    // Simulation `all` + titleOnly : aucune écriture non plus.
    expect(await projeter(c, { titleOnly: true, dryRun: true })).toMatchObject({ changes: 0 });
    expect(await photo(c)).toBe(avant);

    // AC10 : projection ORDINAIRE — création, date, nettoyage d'orpheline, carte encore légitime conservée…
    const o = await projeter(c);
    expect(o.created).toBe(1);
    expect(o.removed).toBeGreaterThanOrEqual(1);
    expect(await evtsDe(opC)).toHaveLength(1);
    expect(await sql`SELECT 1 FROM agenda_items WHERE id = ${orph.id}`).toEqual([]);
    expect(await evenement(evtA)).toMatchObject({ title: NOM, date: AUJ });
    expect((await sql<Json[]>`SELECT resolved_at FROM to_process_actions WHERE id = ${carte}`)[0].resolved_at).toBeNull();
    // … puis RÉSOLUTION légitime de la carte quand l'hésitation disparaît (le candidat ne ressemble plus à l'achat).
    await sql`UPDATE agenda_items SET start_date = '2026-03-01' WHERE id = ${candidat}`;
    await projeter(c);
    expect(await evtsDe(opB)).toHaveLength(1);
    expect((await sql<Json[]>`SELECT resolution_reason FROM to_process_actions WHERE id = ${carte}`)[0].resolution_reason).toBe('OBSOLETE');
    expect(await sql`SELECT details ->> 'reason' AS motif FROM to_process_action_events WHERE action_id = ${carte} AND event = 'OBSOLETE'`).toEqual([{ motif: 'PROJECTION_RESOLVED' }]);
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('C860-E2E-03 — RETITLE (projection modifiée) ; concurrence et légitimité revérifiées à l’écriture ; USER, autre compte, compte inéligible : aucune écriture ; restauration', async () => {
    const { compte: c } = await compte('premium');
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const fichiers: number[] = [];
    // Quatre achats distincts (un véhicule chacun : aucune consolidation T3 entre eux).
    for (const [station, date] of [['Total', '2026-11-01'], ['Esso', '2026-11-02'], ['Shell', '2026-11-03'], ['BP', '2026-11-04']] as const) {
      const v = await make.asset(c, { category: 'VEHICULE', name: `Véhicule ${station}` });
      fichiers.push(await ticket(c, v.id, { station, date, cents: 5000 }));
    }
    await k.passer(c, { today: AUJ });
    await projeter(c);
    const ops = await Promise.all(fichiers.map((f) => opDe(c, f)));
    const evts = await Promise.all(ops.map(async (o) => (await evtsDe(o))[0]));
    // Projections MODIFIÉES par l'utilisateur sur la DATE seulement (titre renvoyé inchangé : titre SYSTEM, #859).
    for (const e of evts) await updateAgendaItem(e, { title: 'Achat', startDate: '2026-11-15' }, c.id, c.owner.id);
    // [3] : titre CHOISI par l'utilisateur (USER) — jamais réécrit.
    await updateAgendaItem(evts[3], { title: 'Mon plein du mois' }, c.id, c.owner.id);
    for (let n = 0; n < fichiers.length; n++) await nommer(c, fichiers[n], ops[n]);
    const simu = await projeter(c, { operationIds: ops, all: false, titleOnly: true, dryRun: true });
    expect(simu.titleOnly?.map((t) => [t.itemId, t.source, t.status])).toEqual([[evts[0], 'RETITLE', 'PLANNED'], [evts[1], 'RETITLE', 'PLANNED'], [evts[2], 'RETITLE', 'PLANNED']]);

    // AUTRE COMPTE : les identifiants de ce compte ne désignent rien ailleurs ; COMPTE INÉLIGIBLE : rien.
    const autre = await make.account({ plan: 'premium' });
    expect(await projeter(autre, { operationIds: ops, all: false, titleOnly: true })).toMatchObject({ operations: 0, changes: 0 });
    await sql`UPDATE account_subscriptions SET status = 'canceled' WHERE account_id = ${c.id}`;
    const avantIneligible = await photo(c);
    expect(await projeter(c, { operationIds: ops, all: false, titleOnly: true })).toMatchObject({ skipped: 'ACCOUNT_INELIGIBLE', changes: 0 });
    expect(await photo(c)).toBe(avantIneligible);
    await sql`UPDATE account_subscriptions SET status = 'active' WHERE account_id = ${c.id}`;

    // CONCURRENCE entre le plan et l'écriture (garde du travail de file, appelée juste avant chaque écriture) :
    // [1] titre édité par l'utilisateur ; [2] Opération invalidée (légitimité perdue).
    let n = 0;
    const r = await projeter(c, {
      operationIds: ops, all: false, titleOnly: true, runId: '00000000-0000-4000-8000-000000000860',
      beforeWrite: async () => {
        n++;
        if (n === 2) await updateAgendaItem(evts[1], { title: 'Plein vacances' }, c.id, c.owner.id);
        if (n === 3) await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'E2E_C860' WHERE id = ${ops[2]}`;
      },
    });
    expect(r.titleOnly?.map((t) => [t.itemId, t.status, t.reason, t.after])).toEqual([
      [evts[0], 'RENAMED', null, NOM],
      [evts[1], 'REFUSED', 'GUARD_REFUSED', 'Plein vacances'],
      [evts[2], 'REFUSED', 'GUARD_REFUSED', 'Achat'],
    ]);
    expect(r).toMatchObject({ retitled: 1, changes: 1 });
    expect(await evenement(evts[0])).toMatchObject({ id: evts[0], title: NOM, date: '2026-11-15', modifie: true, prov: { origin: 'SYSTEM', reason: 'OPERATION_PRECISE_TITLE', channel: 'REPRISE' } });
    expect(await evenement(evts[1])).toMatchObject({ title: 'Plein vacances', prov: { origin: 'USER' } });
    expect(await evenement(evts[2])).toMatchObject({ title: 'Achat' });
    expect(await evenement(evts[3])).toMatchObject({ title: 'Mon plein du mois', prov: { origin: 'USER' } });
    const journal = await sql<Json[]>`SELECT id::int AS id, principal_item_id::int AS item FROM agenda_intervention_consolidations WHERE run_id = '00000000-0000-4000-8000-000000000860'`;
    expect(journal.map((j) => j.item)).toEqual([evts[0]]);

    // RESTAURATION ciblée du titre journalisé, puis jamais par-dessus une édition USER ultérieure.
    const { restoreAgendaConsolidations } = await import('@/services/business-operations/agenda-projection/consolidation');
    const { pgClient } = await import('@/db');
    expect((await restoreAgendaConsolidations(pgClient, { journalIds: [journal[0].id], restoreRunId: '00000000-0000-4000-8000-000000000861' })).restored).toBe(1);
    expect(await evenement(evts[0])).toMatchObject({ title: 'Achat', prov: { origin: 'SYSTEM', reason: 'RETITLE_RESTORED' } });
    // Un titre restauré est un choix d'exploitation : jamais renommé à nouveau automatiquement (garde #859 / 76H).
    const r2 = await projeter(c, { operationIds: [ops[0]], all: false, titleOnly: true });
    expect(r2).toMatchObject({ changes: 0, titleOnly: [] });
    expect(await evenement(evts[0])).toMatchObject({ title: 'Achat' });
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('C860-E2E-04 — reprise : la SYNC mixte annoncée à blanc est réellement écrite ; compteurs du résultat réel ; date toujours en attente ; second passage nul', async () => {
    const { c, opA, evtA, opB, carte } = await base();
    const avantCartes = await cartes(c);
    const { reprisePurchaseTitles } = await import('@/services/business-operations/agenda-projection/purchase-title-reprise');
    const blanc = await reprisePurchaseTitles(c.id, { today: AUJ });
    expect(blanc.operations.find((o) => o.operationId === opA)).toMatchObject({
      events: [{ itemId: evtA, before: 'Achat', after: NOM, action: 'RENAME', origin: 'OPERATION_PROJECTION' }],
      otherPendingActions: ['SYNC'],
    });
    expect(blanc).toMatchObject({ eventsToRename: 1, eventsRenamed: 0, applied: false });
    expect(blanc.titleWrites).toBeUndefined();
    expect(await evenement(evtA)).toMatchObject({ title: 'Achat' });

    const reel = await reprisePurchaseTitles(c.id, { apply: true, today: AUJ });
    expect(reel).toMatchObject({ applied: true, eventsToRename: 1, eventsRenamed: 1 });
    expect(reel.titleWrites).toEqual([{ operationId: opA, itemId: evtA, source: 'SYNC', plannedFrom: 'Achat', plannedTitle: NOM, before: 'Achat', after: NOM, status: 'RENAMED', reason: null }]);
    expect(await evenement(evtA)).toMatchObject({ id: evtA, title: NOM, date: '2026-11-18', prov: { origin: 'SYSTEM', channel: 'REPRISE' } });
    // Carte de B intacte ; correction de date de A toujours en attente.
    expect(await cartes(c)).toBe(avantCartes);
    expect((await sql<Json[]>`SELECT resolved_at FROM to_process_actions WHERE id = ${carte}`)[0].resolved_at).toBeNull();
    expect((await projeter(c, { dryRun: true })).plans?.find((p) => p.operationId === opA)?.actions).toEqual([{ kind: 'SYNC', itemId: evtA, changes: { date: AUJ } }]);
    expect(await evtsDe(opB)).toEqual([]);
    // Second passage : rien à renommer, rien d'écrit.
    expect(await reprisePurchaseTitles(c.id, { apply: true, today: AUJ })).toMatchObject({ eventsToRename: 0, eventsRenamed: 0 });
  });
});
