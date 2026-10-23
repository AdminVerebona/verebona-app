/**
 * Lot 83A — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-7
 * (T4 / projection Agenda) — PostgreSQL 16 réel.
 *
 * Chaînes de PRODUCTION : écriture Opération (`withBusinessOperationWrite`),
 * service unique de regroupement, agenda manuel (`AgendaWriteService`),
 * projection T4 (`projectAccountOperations`), producteur « À traiter »
 * DATA-AGENDA-DATE (`produceAgendaActions`), résolution d'une carte
 * (`resolveArbitration`), invariants du regroupement. Aucun appel IA. La
 * sortie T3 « dates contradictoires » (provenance 78A) est injectée telle que
 * T3 l'écrit. Assertions limitées aux comptes créés ici.
 *
 *   L83A-E01  AC15 / AC34 — élément global existant → principal ; étape rattachée jamais promue ni absorbée
 *   L83A-E02  AC16 / AC17 / AC18 — événement global sans date : créé SANS date (ni date inventée, ni « sans échéance »), carte de date existante
 *   L83A-E03  AC19 — date découverte : posée par la projection, carte résolue d'elle-même ; rejouée : aucune écriture
 *   L83A-E04  AC20 — dates contradictoires : date vide, arbitrage par la carte de date existante ; choix de l'utilisateur jamais écrasé
 *   L83A-E05  multi-éléments — un regroupement d'éléments liés par l'utilisateur n'est jamais défait par la projection
 *   L83A-E06  AC52 — relation durable : aucun principal, ni créé ni déduit (invariant O7, réparation par le service)
 *   L83A-E07  76H restreint (V-Q4) — vrai doublon fusionné, devient principal ; étape distincte conservée
 *   L83A-E08  idempotence — passage complet rejoué : aucune écriture (éléments, liens, cartes)
 *   L83A-E09  C-Q10 — compte non éligible : aucune projection
 *   L83A-E10  saisie utilisateur — date d'un principal saisie par l'utilisateur jamais écrasée par la projection
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const ecriture = () => import('@/services/business-operations/write');
const projection = () => import('@/services/business-operations/agenda-projection/service');
const grouping = () => import('@/services/business-operations/grouping/service');
const invariants = () => import('@/services/business-operations/grouping/invariants');
const runner = () => import('@/services/business-operations/grouping/runner');
const bus = () => import('@/services/business-operations/events');
const AUJ = '2026-10-23';

scenario('L83A', 'Opérations v5 — O-7 : projection Agenda multi-éléments, principal facultatif, sans date, dates contradictoires', ({ sql, make }) => {
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  async function contexte(plan: 'premium' | null = 'premium'): Promise<{ compte: AccountRow & { owner: { id: number } }; maison: AssetRow }> {
    const compte = await make.account({ plan });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    return { compte, maison };
  }
  async function operation(compte: AccountRow, p: { assetId: number; fileId: number; type?: string; realized?: string | null; label?: string; status?: string }): Promise<number> {
    const { withBusinessOperationWrite } = await ecriture();
    return (await withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: (p.type ?? 'CLAIM') as 'CLAIM' }, status: (p.status ?? 'REALIZED') as 'REALIZED', realizedDate: p.realized ?? null,
      technicalLabel: p.label ?? 'Dégât des eaux',
      source: { kind: 'DOCUMENT', entityKey: p.fileId, authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: p.assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }))).id;
  }
  const projeter = async (compte: AccountRow, ids?: number[]) => (await projection()).projectAccountOperations(compte.id,
    ids ? { operationIds: ids, correlationId: 'l83a', today: AUJ } : { all: true, correlationId: 'l83a', today: AUJ });
  const g = async <T>(compte: AccountRow, fn: (ctx: import('@/services/business-operations/grouping/service').GroupingContext) => Promise<T>, actorUserId: number | null = null) =>
    (await grouping()).withGroupingWrite(compte.id, fn, { actorUserId });
  const elements = (compte: AccountRow) => sql<Json[]>`
    SELECT id, title, start_date::text AS date, no_deadline, projection_origin AS proj, business_operation_id::int AS op,
           operation_role AS role, operation_role_origin AS origin, event_nature AS nature, is_automatic_modified AS modified
      FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`;
  const element = async (id: number) => (await sql<Json[]>`
    SELECT id, title, start_date::text AS date, no_deadline, projection_origin AS proj, business_operation_id::int AS op,
           operation_role AS role, operation_role_origin AS origin, is_automatic_modified AS modified FROM agenda_items WHERE id = ${id}`)[0];
  const cartesDate = (itemId: number) => sql<Json[]>`
    SELECT id, public_id, rule_code, action_kind, resolved_at IS NOT NULL AS resolu, resolution_reason, proposals_json AS proposals
      FROM to_process_actions WHERE target_type = 'AGENDA_ITEM' AND target_id = ${itemId} AND field_key = 'date' ORDER BY id`;
  const liensDe = (itemId: number) => sql<{ file: number; prov: string[] }[]>`
    SELECT asset_file_id AS file, provenances AS prov FROM agenda_file_links WHERE agenda_item_id = ${itemId} ORDER BY asset_file_id`;
  const etatComplet = async (compte: AccountRow) => ({
    items: await sql`SELECT id, title, start_date, updated_at, business_operation_id, operation_role, operation_role_origin, manual_status
                       FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`,
    liens: await sql`SELECT l.agenda_item_id, l.asset_file_id, l.provenances FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id
                      WHERE i.account_id = ${compte.id} ORDER BY 1, 2`,
    cartes: await sql`SELECT id, rule_code, action_kind, resolved_at, updated_at FROM to_process_actions WHERE account_id = ${compte.id} ORDER BY id`,
  });

  // ══ AC15 / AC34 ═══════════════════════════════════════════════════════════

  it('L83A-E01 — AC15 / AC34 : élément global existant reconnu comme principal ; une étape rattachée reste une étape (ni promue, ni absorbée) ; documents propagés au principal', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const rapport = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id, realized: '2026-03-12' });
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(c.compte.id, (repo) => repo.addSource(op, { kind: 'DOCUMENT', entityKey: rapport.id, authority: 'DOCUMENT' }));
    // Étape rattachée par l'utilisateur AVANT la projection (visite de l'expert, autre date).
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21', assetIds: [c.maison.id] });
    const { attachAgendaItem } = await grouping();
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: visite.id, origin: 'USER', reasonCode: 'E2E' }), c.compte.owner.id);
    // Événement global saisi par l'utilisateur (même bien, même date) : il DEVIENT le principal (AC15).
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux cuisine', startDate: '2026-03-12', assetIds: [c.maison.id] });
    const r = await projeter(c.compte, [op]);
    expect(r).toMatchObject({ created: 0, linked: 1 });
    expect(await element(degat.id)).toMatchObject({ op, role: 'PRINCIPAL', origin: 'T4', proj: null, date: '2026-03-12' });
    // AC34 : la visite n'est ni promue principal ni absorbée (même Opération ≠ doublon).
    expect(await element(visite.id)).toMatchObject({ op, role: 'RELATED', origin: 'USER', date: '2026-03-21' });
    expect((await elements(c.compte)).map((i) => i.id)).toEqual([visite.id, degat.id]);
    // §7.1 : documents de l'Opération liés au principal (OPERATION_PRINCIPAL), jamais à l'étape.
    expect((await liensDe(degat.id)).map((l) => [l.file, l.prov])).toEqual([[constat.id, ['OPERATION_PRINCIPAL']], [rapport.id, ['OPERATION_PRINCIPAL']]]);
    expect(await liensDe(visite.id)).toEqual([]);
    // Rejouée : aucune écriture.
    expect((await projeter(c.compte, [op])).changes).toBe(0);
  });

  it('L83A-E01b — AC34 : sans élément global existant, la projection CRÉE le principal ; l’étape rattachée (T3 ou utilisateur) n’est jamais promue', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id, realized: '2026-03-12' });
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21', assetIds: [c.maison.id] });
    const reparation = await make.agendaItem(c.compte, { title: 'Réparation plafond', startDate: '2026-04-18', assetIds: [c.maison.id] });
    const { attachAgendaItem } = await grouping();
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: visite.id, origin: 'USER', reasonCode: 'E2E' }), c.compte.owner.id);
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: reparation.id, origin: 'T3', reasonCode: 'E2E' }));
    const r = await projeter(c.compte, [op]);
    expect(r).toMatchObject({ created: 1 });
    const tous = await elements(c.compte);
    const principal = tous.find((i) => i.role === 'PRINCIPAL')!;
    expect(principal).toMatchObject({ op, title: 'Dégât des eaux', date: '2026-03-12', proj: 'OPERATION', origin: 'T4', nature: 'HISTORICAL' });
    expect(await element(visite.id)).toMatchObject({ op, role: 'RELATED', origin: 'USER' });
    expect(await element(reparation.id)).toMatchObject({ op, role: 'RELATED', origin: 'T3' });
    expect(tous).toHaveLength(3);
    expect((await projeter(c.compte, [op])).changes).toBe(0);
  });

  // ══ AC16 – AC19 ═══════════════════════════════════════════════════════════

  it('L83A-E02 / E03 — AC16 / AC17 / AC18 / AC19 : événement global établi sans date → principal SANS date et carte de date ; date découverte → posée, carte résolue ; rejouée sans écriture', async () => {
    const c = await contexte();
    const courrier = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: courrier.id, realized: null });
    // Filet de convergence (contrôle COH-AGENDA-OPERATION-PROJECTION, 83E — simulation de la
    // même projection) : l'événement réalisé sans date est attendu, puis plus rien à faire.
    const { projectAccountOperations } = await projection();
    const creations = async () => ((await projectAccountOperations(c.compte.id, { operationIds: [op], dryRun: true, today: AUJ })).plans ?? [])
      .flatMap((p) => p.actions).filter((x) => x.kind === 'CREATE').length;
    expect(await creations()).toBe(1);
    const r = await projeter(c.compte, [op]);
    expect(r).toMatchObject({ created: 1 });
    expect(await creations()).toBe(0);
    const [p] = await elements(c.compte);
    // AC17 / AC18 / §11.5 : créé sans date, aucune date inventée, « Sans échéance » NON posée.
    expect(p).toMatchObject({ op, role: 'PRINCIPAL', origin: 'T4', proj: 'OPERATION', date: null, no_deadline: false, title: 'Dégât des eaux' });
    // Carte « À traiter » EXISTANTE (DATA-AGENDA-DATE) : la date du principal est nécessaire (Timeline, dossier).
    expect(await cartesDate(p.id)).toEqual([expect.objectContaining({ rule_code: 'DATA-AGENDA-DATE', action_kind: 'COMPLETE', resolu: false })]);
    // Rejouée : aucune écriture, aucune seconde carte.
    const avant = await etatComplet(c.compte);
    expect((await projeter(c.compte, [op])).changes).toBe(0);
    expect(await etatComplet(c.compte)).toEqual(avant);
    // AC19 : un nouveau document établit la date (sortie T3) → date posée par la projection, carte résolue d'elle-même.
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(c.compte.id, (repo) => repo.updateAttributes(op, { realizedDate: '2026-03-12' }, 'E2E_T3_DATE'));
    const r2 = await projeter(c.compte, [op]);
    expect(r2).toMatchObject({ updated: 1 });
    expect(await element(p.id)).toMatchObject({ date: '2026-03-12', role: 'PRINCIPAL', modified: false });
    expect(await cartesDate(p.id)).toEqual([expect.objectContaining({ resolu: true, resolution_reason: 'OBSOLETE' })]);
    expect((await projeter(c.compte, [op])).changes).toBe(0);
  });

  // ══ AC20 ══════════════════════════════════════════════════════════════════

  it('L83A-E04 — AC20 : dates contradictoires (T3) → principal sans date et ARBITRAGE par la carte de date ; le choix de l’utilisateur n’est jamais écrasé', async () => {
    const c = await contexte();
    const f1 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: f1.id, realized: '2026-03-12' });
    // Sortie T3 (78A) : la date de survenue diffère entre deux sources au-delà de la fenêtre ; la date fondatrice est conservée, la contradiction tracée.
    await sql`UPDATE business_operations SET attribute_provenance = ${JSON.stringify({
      version: 1, fields: { realizedDate: { sourceId: 1, value: '2026-03-12' } },
      conflicts: [{ field: 'realizedDate', values: [{ value: '2026-03-12', sourceIds: [1] }, { value: '2025-09-02', sourceIds: [2] }], retained: '2026-03-12' }],
    })}::jsonb WHERE id = ${op}`;
    await projeter(c.compte, [op]);
    const [p] = await elements(c.compte);
    expect(p).toMatchObject({ role: 'PRINCIPAL', date: null, no_deadline: false });
    const [carte] = await cartesDate(p.id);
    expect(carte).toMatchObject({ rule_code: 'DATA-AGENDA-DATE', action_kind: 'ARBITRATE', resolu: false });
    expect((carte.proposals as Json[]).map((x) => x.value).sort()).toEqual(['2025-09-02', '2026-03-12']);
    // Rejouée : ni écriture, ni carte de plus.
    const avant = await etatComplet(c.compte);
    expect((await projeter(c.compte, [op])).changes).toBe(0);
    expect(await etatComplet(c.compte)).toEqual(avant);
    // L'utilisateur tranche : date posée par l'écrivain de la carte, origine utilisateur.
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    const res = await resolveArbitration(c.compte.id, String(carte.public_id), '2025-09-02', { userId: c.compte.owner.id });
    expect(res).toMatchObject({ ok: true, previousValue: null });
    expect(await element(p.id)).toMatchObject({ date: '2025-09-02', modified: true });
    // La contradiction disparaît côté T3 (autre date retenue) : la saisie de l'utilisateur n'est JAMAIS écrasée.
    await sql`UPDATE business_operations SET attribute_provenance = NULL WHERE id = ${op}`;
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(c.compte.id, (repo) => repo.updateAttributes(op, { realizedDate: '2026-03-14' }, 'E2E_T3_DATE'));
    expect((await projeter(c.compte, [op])).changes).toBe(0);
    expect(await element(p.id)).toMatchObject({ date: '2025-09-02', role: 'PRINCIPAL' });
  });

  // ══ Multi-éléments ════════════════════════════════════════════════════════

  it('L83A-E05 — multi-éléments : un regroupement d’éléments liés par l’utilisateur (non qualifié par T3) n’est jamais défait par la projection ; aucun faux principal', async () => {
    const c = await contexte();
    const a = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12', assetIds: [c.maison.id] });
    const b = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21', assetIds: [c.maison.id] });
    const { linkAgendaItems } = await grouping();
    const { operationId } = await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: a.id, itemB: b.id }), c.compte.owner.id);
    await projeter(c.compte, [operationId]);
    await projeter(c.compte);
    expect(await element(a.id)).toMatchObject({ op: operationId, role: 'RELATED', origin: 'USER' });
    expect(await element(b.id)).toMatchObject({ op: operationId, role: 'RELATED', origin: 'USER' });
    expect((await elements(c.compte)).filter((i) => i.role === 'PRINCIPAL')).toEqual([]);
  });

  // ══ AC52 ══════════════════════════════════════════════════════════════════

  it('L83A-E06 — AC52 : relation durable (abonnement) — aucun principal créé ni déduit ; un principal déduit est rétrogradé (projection et invariant O7, réparation par le service)', async () => {
    const c = await contexte();
    const facture = await make.assetFile(c.compte, { assetId: c.maison.id });
    const contrat = await operation(c.compte, { assetId: c.maison.id, fileId: facture.id, type: 'CONTRACT', realized: null, label: 'Télésurveillance' });
    await projeter(c.compte, [contrat]);
    expect(await elements(c.compte)).toEqual([]);
    // Élément rattaché puis désigné principal par une inférence (état antérieur) : faux principal.
    const lie = await make.agendaItem(c.compte, { title: 'Facture télésurveillance', startDate: '2026-09-30', assetIds: [c.maison.id] });
    const { designatePrincipal } = await grouping();
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: contrat, itemId: lie.id, origin: 'T4', reasonCode: 'E2E' }));
    const { postgresRunner } = await runner();
    const { OPERATIONS_GROUPING_INVARIANTS, repairGroupingFinding } = await invariants();
    const inv = OPERATIONS_GROUPING_INVARIANTS.find((i) => i.id === 'O7-NO-INFERRED-PRINCIPAL')!;
    const constats = await inv.detect(postgresRunner(sql), c.compte.id);
    expect(constats).toEqual([expect.objectContaining({ objectKey: `operation:${contrat}`, nature: 'INFERRED_PRINCIPAL_ON_DURABLE_RELATION', repairable: true })]);
    expect(await g(c.compte, (ctx) => repairGroupingFinding(ctx, constats[0]))).toMatchObject({ repaired: true, changed: true });
    expect(await element(lie.id)).toMatchObject({ op: contrat, role: 'RELATED' });
    expect(await inv.detect(postgresRunner(sql), c.compte.id)).toEqual([]);
    // La projection elle-même rétrograde un principal déduit (jamais celui de l'utilisateur) et garde l'élément lié.
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: contrat, itemId: lie.id, origin: 'T4', reasonCode: 'E2E' }));
    await projeter(c.compte, [contrat]);
    expect(await element(lie.id)).toMatchObject({ op: contrat, role: 'RELATED' });
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: contrat, itemId: lie.id, origin: 'USER', reasonCode: 'E2E' }), c.compte.owner.id);
    await projeter(c.compte, [contrat]);
    expect(await element(lie.id)).toMatchObject({ op: contrat, role: 'PRINCIPAL', origin: 'USER' });
    expect(await inv.detect(postgresRunner(sql), c.compte.id)).toEqual([]);
  });

  // ══ 76H restreint ═════════════════════════════════════════════════════════

  it('L83A-E07 — 76H (V-Q4) : deux représentations T4 de la MÊME intervention (identité T3) → une seule, principale ; une étape distincte rattachée reste', async () => {
    const c = await contexte();
    const facture = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: facture.id, type: 'INTERVENTION', realized: '2026-03-12', label: 'Remplacement du ballon d’eau chaude' });
    const t4 = async (titre: string, type: string, date = '2026-03-12') => (await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, event_nature, business_type)
      VALUES (${c.compte.id}, ${titre}, ${date}, true, 'qualified_document', 'asset_file', ${facture.id}, 'HISTORICAL', ${type}) RETURNING id`)[0].id;
    const reparation = await t4('Réparation — Maison', 'repair');
    const entretien = await t4('Entretien réalisé — Prestation', 'maintenance');
    for (const id of [reparation, entretien]) await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${id}, ${c.maison.id})`;
    // Étape distincte rattachée par l'utilisateur (même document, même jour) : jamais absorbée.
    const controle = await make.agendaItem(c.compte, { title: 'Contrôle après travaux', startDate: '2026-03-12', assetIds: [c.maison.id] });
    const { attachAgendaItem } = await grouping();
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: controle.id, origin: 'USER', reasonCode: 'E2E' }), c.compte.owner.id);
    const r = await projeter(c.compte, [op]);
    expect(r.consolidated).toBe(1);
    const restants = await elements(c.compte);
    expect(restants.map((i) => i.id).sort((x, y) => x - y)).toEqual([reparation, controle.id].sort((x, y) => x - y));
    expect(await element(reparation)).toMatchObject({ op, role: 'PRINCIPAL' });
    expect(await element(controle.id)).toMatchObject({ op, role: 'RELATED', origin: 'USER' });
    expect((await projeter(c.compte, [op])).changes).toBe(0);
  });

  // ══ Idempotence, éligibilité, saisie utilisateur ═════════════════════════

  it('L83A-E08 — idempotence : passage complet du compte rejoué → aucune écriture (éléments, liens, cartes)', async () => {
    const c = await contexte();
    const f1 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const f2 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const f3 = await make.assetFile(c.compte, { assetId: c.maison.id });
    await operation(c.compte, { assetId: c.maison.id, fileId: f1.id, realized: null });
    await operation(c.compte, { assetId: c.maison.id, fileId: f2.id, type: 'INTERVENTION', realized: '2026-02-01', label: 'Ramonage' });
    await operation(c.compte, { assetId: c.maison.id, fileId: f3.id, type: 'ACQUISITION', realized: null, label: 'Achat' });
    expect((await projeter(c.compte)).changes).toBeGreaterThan(0);
    const avant = await etatComplet(c.compte);
    const r = await projeter(c.compte);
    expect(r.changes).toBe(0);
    expect(await etatComplet(c.compte)).toEqual(avant);
  });

  it('L83A-E09 — C-Q10 : compte non éligible (sans abonnement) → aucune projection, aucune carte', async () => {
    const c = await contexte(null);
    const f = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: f.id, realized: null });
    const r = await projeter(c.compte, [op]);
    expect(r).toMatchObject({ changes: 0, skipped: 'ACCOUNT_INELIGIBLE' });
    expect((await projeter(c.compte)).skipped).toBe('ACCOUNT_INELIGIBLE');
    // (Filet de convergence : le registre de cohérence n'examine pas un compte non éligible — L83E-E2E-08.)
    expect(await elements(c.compte)).toEqual([]);
    expect(await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${c.compte.id}`).toEqual([]);
  });

  it('L83A-E10 — saisie utilisateur : la date posée par l’utilisateur sur le principal sans date n’est jamais écrasée par une date découverte ensuite', async () => {
    const c = await contexte();
    const f = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: f.id, realized: null });
    await projeter(c.compte, [op]);
    const [p] = await elements(c.compte);
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(p.id, { startDate: '2026-03-10' } as never, c.compte.id, c.compte.owner.id);
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(c.compte.id, (repo) => repo.updateAttributes(op, { realizedDate: '2026-03-12' }, 'E2E_T3_DATE'));
    expect((await projeter(c.compte, [op])).changes).toBe(0);
    expect(await element(p.id)).toMatchObject({ date: '2026-03-10', role: 'PRINCIPAL', modified: true });
  });
});
