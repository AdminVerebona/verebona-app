/**
 * Carte Trello #806 §5 — DATES : synchronisation bidirectionnelle du MÊME fait
 * daté entre l'opération et l'événement de l'Agenda qui le porte (AC34). Sur
 * PostgreSQL 16 réel, par les chemins de PRODUCTION : façade d'écriture
 * (`correctOperation`), écriture utilisateur de l'Agenda (`updateAgendaItem`),
 * consolidation T3 réelle pour la protection. Aucune IA. Dates fixes.
 *
 *   L116C-D01  OPÉRATION → AGENDA : la date de réalisation corrigée depuis la fiche est reportée sur l'événement
 *              qui PORTE le fait ; le devis relié (autre fait) garde sa date ; journal, version ; aucun événement ni
 *              rappel créé ; rejoué : rien
 *   L116C-D02  AGENDA → OPÉRATION : la date corrigée sur l'événement porteur est reportée sur l'opération (version,
 *              source de protection, journal) ; puis l'autre sens de nouveau : aucune boucle, un report = une ligne ;
 *              une consolidation T3 ne réécrit pas la correction
 *   L116C-D03  JAMAIS ENTRE FAITS DIFFÉRENTS : événement relié sans fait porté (devis ≠ réalisation) ; dates de début
 *              et de fin de l'opération (signature / prise d'effet ≠ réalisation) ; échéance « fin de contrat »
 *              (≠ dates de l'opération) ; intervention ENVISAGÉE : seule la date prévue suit, jamais la réalisation
 *   L116C-D04  deux affichages DÉJÀ divergents : rien n'est écrasé, dans aucun sens ; abstention tracée une fois ;
 *              retirer la date de l'événement ne retire pas celle de l'opération
 *   L116C-D05  événement PARTAGÉ porteur du fait de deux opérations : les deux suivent ; un seul événement, un seul
 *              rappel en file ; isolation : une opération d'un autre compte n'est jamais touchée
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const facade = () => import('@/services/business-operations/operation-write.facade');
const grouping = () => import('@/services/business-operations/grouping/service');
const bus = () => import('@/services/business-operations/events');

scenario('L116C-D', 'Opérations / Agenda #806 §5 — la date d’un même fait se synchronise dans les deux sens, jamais entre faits différents (AC34)', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });

  async function operation(compte: AccountRow, type: 'INTERVENTION' | 'CLAIM' | 'CONTRACT' | 'ACQUISITION', assetId: number, over: { status?: 'REALIZED' | 'ENVISAGED'; realized?: string; planned?: string; start?: string; end?: string; label?: string } = {}): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type }, status: over.status ?? 'REALIZED', technicalLabel: over.label ?? 'Remplacement de la chaudière',
      ...(over.realized ? { realizedDate: over.realized } : {}), ...(over.planned ? { plannedDate: over.planned } : {}),
      ...(over.start ? { startDate: over.start } : {}), ...(over.end ? { endDate: over.end } : {}),
      source: { kind: 'DOCUMENT', entityKey: f.id, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { e2e: 'l116c-d' } },
      assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'L116C_D_E2E',
    })).id);
  }
  /** Événement de l'Agenda relié à l'opération ; `porteur` : il PORTE le fait de l'opération (désigné par l'utilisateur). */
  async function evenement(compte: AccountRow, operationId: number, assetId: number, titre: string, date: string | null, porteur: boolean, fait?: string): Promise<number> {
    const e = await make.agendaItem(compte, { title: titre, ...(date ? { startDate: date } : {}), assetIds: [assetId] });
    const { withGroupingWrite, attachAgendaItem, designatePrincipal } = await grouping();
    await withGroupingWrite(compte.id, async (g) => {
      const dejaLie = (await g.runner.q(`SELECT 1 FROM agenda_items WHERE id = $1 AND business_operation_id IS NOT NULL`, [e.id])).length > 0;
      if (!dejaLie) await attachAgendaItem(g, { operationId, itemId: e.id, origin: 'USER', reasonCode: 'L116C_D' });
      if (porteur) await designatePrincipal(g, { operationId, itemId: e.id, origin: 'USER', reasonCode: 'L116C_D', ...(fait ? { fact: fait } : {}) });
    }, { actorUserId: compte.ownerUserId });
    return e.id;
  }
  const dateEvenement = async (id: number) => (await sql<Json[]>`SELECT start_date::text AS d FROM agenda_items WHERE id = ${id}`)[0].d as string | null;
  const op = async (id: number) => (await sql<Json[]>`
    SELECT realized_date::text AS realise, planned_date::text AS prevu, start_date::text AS debut, end_date::text AS fin, version FROM business_operations WHERE id = ${id}`)[0];
  const reports = (compte: AccountRow) => sql<Json[]>`
    SELECT operation_id::int AS op, agenda_item_id::int AS el, action, origin, channel, actor_user_id, before_json AS avant, after_json AS apres
      FROM business_operation_graph_history WHERE account_id = ${compte.id} AND reason_code = 'FACT_DATE_SYNC' ORDER BY id`;
  const abstentions = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT count(*)::int AS n FROM business_operation_graph_history WHERE account_id = ${compte.id} AND reason_code = 'ABSTAIN_FACT_DATE_DIVERGENT'`)[0].n;
  const volumes = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT (SELECT count(*)::int FROM agenda_items WHERE account_id = ${compte.id}) AS evenements,
           (SELECT count(*)::int FROM notification_outbox WHERE account_id = ${compte.id} AND status IN ('pending', 'processing')) AS rappels,
           (SELECT count(*)::int FROM business_operations WHERE account_id = ${compte.id}) AS operations`)[0];
  const modifier = async (compte: AccountRow, itemId: number, startDate: string | null) => {
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    return updateAgendaItem(itemId, { startDate } as never, compte.id, compte.ownerUserId);
  };
  const corriger = async (compte: AccountRow, operationId: number, attributes: Record<string, string>) =>
    (await facade()).correctOperation(user(compte), { operationId, attributes });

  it('L116C-D01 — opération → Agenda : la date de réalisation corrigée est reportée sur l’événement porteur ; le devis garde sa date ; journal ; rien de créé ; idempotent', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const o = await operation(compte, 'INTERVENTION', maison.id, { realized: '2026-01-20' });
    const devis = await evenement(compte, o, maison.id, 'Devis du chauffagiste', '2026-01-05', false);
    const pose = await evenement(compte, o, maison.id, 'Pose de la chaudière', '2026-01-20', true);
    const avant = await volumes(compte);
    const versionAvant = Number((await op(o)).version);

    expect(await corriger(compte, o, { realizedDate: '2026-01-22' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect((await op(o)).realise).toBe('2026-01-22');
    expect(await dateEvenement(pose)).toBe('2026-01-22');
    expect(await dateEvenement(devis)).toBe('2026-01-05');
    expect(Number((await op(o)).version)).toBeGreaterThan(versionAvant);
    // Aucun événement, aucune opération, aucun rappel créé.
    expect(await volumes(compte)).toEqual(avant);
    // Journal : identité du fait, sens, avant / après, auteur.
    const lignes = await reports(compte);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({
      op: o, el: pose, action: 'UPDATED', origin: 'USER', channel: 'OPERATION', actor_user_id: compte.ownerUserId,
      avant: { factKey: 'INTERVENTION', field: 'realizedDate', direction: 'OPERATION_TO_AGENDA', operationDate: '2026-01-20', agendaDate: '2026-01-20' },
      apres: { factKey: 'INTERVENTION', field: 'realizedDate', operationDate: '2026-01-22', agendaDate: '2026-01-22' },
    });
    // Même correction rejouée : rien ne change, aucune ligne de plus.
    expect(await corriger(compte, o, { realizedDate: '2026-01-22' })).toMatchObject({ status: 'APPLIED', changed: false });
    expect(await reports(compte)).toHaveLength(1);
    expect(await dateEvenement(pose)).toBe('2026-01-22');
  });

  it('L116C-D02 — Agenda → opération, puis l’autre sens : report, version, protection, journal ; aucune boucle ; T3 ne réécrit pas la correction', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const o = await operation(compte, 'INTERVENTION', maison.id, { realized: '2026-01-20' });
    const pose = await evenement(compte, o, maison.id, 'Pose de la chaudière', '2026-01-20', true);
    const versionAvant = Number((await op(o)).version);
    const avant = await volumes(compte);

    await modifier(compte, pose, '2026-01-25');
    expect(await dateEvenement(pose)).toBe('2026-01-25');
    expect((await op(o)).realise).toBe('2026-01-25');
    expect(Number((await op(o)).version)).toBeGreaterThan(versionAvant);
    expect(await volumes(compte)).toEqual(avant);
    const lignes = await reports(compte);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({
      op: o, el: pose, origin: 'USER', channel: 'AGENDA', actor_user_id: compte.ownerUserId,
      avant: { factKey: 'INTERVENTION', direction: 'AGENDA_TO_OPERATION', operationDate: '2026-01-20', agendaDate: '2026-01-20' },
      apres: { operationDate: '2026-01-25', agendaDate: '2026-01-25' },
    });
    // La correction est protégée : source de l'utilisateur posée sur l'opération.
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${o} AND active AND source_kind = 'USER_DECLARATION'`).toHaveLength(1);
    // Même date enregistrée de nouveau : aucun report, aucune ligne (pas de boucle).
    await modifier(compte, pose, '2026-01-25');
    expect(await reports(compte)).toHaveLength(1);

    // L'autre sens ensuite : la fiche corrige, l'Agenda suit — une ligne de plus, pas davantage.
    expect(await corriger(compte, o, { realizedDate: '2026-01-27' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await dateEvenement(pose)).toBe('2026-01-27');
    expect(await reports(compte)).toHaveLength(2);
    expect(await volumes(compte)).toEqual(avant);

    // Une consolidation T3 du compte ne réécrit ni l'opération ni l'événement ; aucun nouveau report.
    const { consolidateAccountOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await consolidateAccountOperations(compte.id, { today: '2026-10-12', operationMatch: false });
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await projectAccountOperations(compte.id, { operationIds: [o], correlationId: 'l116c-d02', today: '2026-10-12' });
    expect((await op(o)).realise).toBe('2026-01-27');
    expect(await dateEvenement(pose)).toBe('2026-01-27');
    expect(await reports(compte)).toHaveLength(2);
    expect((await volumes(compte)).evenements).toBe(avant.evenements);
  });

  it('L116C-D03 — jamais entre faits différents : devis ≠ réalisation ; début et fin de l’opération ≠ réalisation ; échéance de fin de contrat ; intervention envisagée : la date prévue seule', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const o = await operation(compte, 'INTERVENTION', maison.id, { realized: '2026-01-20', start: '2026-01-20', end: '2026-01-20' });
    // Le devis est relié mais ne porte aucun fait ; il est daté du MÊME jour que la réalisation.
    const devis = await evenement(compte, o, maison.id, 'Devis du chauffagiste', '2026-01-20', false);
    await modifier(compte, devis, '2026-01-10');
    expect((await op(o)).realise).toBe('2026-01-20');
    // Début / fin de l'opération corrigés : aucun événement ne bouge (aucun fait porté ne leur correspond).
    const pose = await evenement(compte, o, maison.id, 'Pose de la chaudière', '2026-01-20', true);
    expect(await corriger(compte, o, { startDate: '2026-01-18', endDate: '2026-01-19' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect([await dateEvenement(pose), await dateEvenement(devis)]).toEqual(['2026-01-20', '2026-01-10']);

    // Contrat : l'échéance « fin de contrat » porte le fait CONTRACT:END — ni le début ni la fin de l'opération ne la suivent, et inversement.
    const contrat = await operation(compte, 'CONTRACT', maison.id, { label: 'Contrat d’entretien', start: '2026-01-01', end: '2026-12-31' });
    const echeance = await evenement(compte, contrat, maison.id, 'Fin de contrat', '2026-12-31', true, 'CONTRACT:END');
    await modifier(compte, echeance, '2027-01-15');
    expect(await op(contrat)).toMatchObject({ debut: '2026-01-01', fin: '2026-12-31', realise: null });
    expect(await corriger(compte, contrat, { endDate: '2026-11-30', startDate: '2026-02-01' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await dateEvenement(echeance)).toBe('2027-01-15');

    // Intervention ENVISAGÉE : l'événement porteur suit la date PRÉVUE ; la réalisation n'est jamais écrite.
    const prevue = await operation(compte, 'INTERVENTION', maison.id, { status: 'ENVISAGED', planned: '2027-03-01', label: 'Ramonage' });
    const rdv = await evenement(compte, prevue, maison.id, 'Ramonage', '2027-03-01', true);
    await modifier(compte, rdv, '2027-03-08');
    expect(await op(prevue)).toMatchObject({ prevu: '2027-03-08', realise: null });
    expect(await corriger(compte, prevue, { plannedDate: '2027-03-15' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await dateEvenement(rdv)).toBe('2027-03-15');
    // Seuls les deux reports de l'intervention envisagée sont tracés.
    expect((await reports(compte)).map((l) => [l.op, l.avant.field, l.avant.direction])).toEqual([[prevue, 'plannedDate', 'AGENDA_TO_OPERATION'], [prevue, 'plannedDate', 'OPERATION_TO_AGENDA']]);
  });

  it('L116C-D04 — affichages déjà divergents : rien n’est écrasé, dans aucun sens ; abstention tracée une fois ; retirer la date de l’événement ne retire pas celle de l’opération', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const o = await operation(compte, 'INTERVENTION', maison.id, { realized: '2026-01-20' });
    // L'événement porteur montrait DÉJÀ une autre date que l'opération.
    const pose = await evenement(compte, o, maison.id, 'Pose de la chaudière', '2026-01-18', true);
    await modifier(compte, pose, '2026-01-19');
    expect((await op(o)).realise).toBe('2026-01-20');
    expect(await corriger(compte, o, { realizedDate: '2026-01-21' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await dateEvenement(pose)).toBe('2026-01-19');
    expect(await reports(compte)).toEqual([]);
    expect(await abstentions(compte)).toBe(2);
    // Deux situations nouvelles (l'opération est maintenant au 21) : deux lignes ; les MÊMES situations rejouées : aucune de plus.
    await modifier(compte, pose, '2026-01-18');
    await modifier(compte, pose, '2026-01-19');
    expect(await abstentions(compte)).toBe(4);
    await modifier(compte, pose, '2026-01-18');
    await modifier(compte, pose, '2026-01-19');
    expect(await abstentions(compte)).toBe(4);
    expect([(await op(o)).realise, await dateEvenement(pose)]).toEqual(['2026-01-21', '2026-01-19']);

    // Les deux affichages réalignés par l'utilisateur redeviennent le même fait, puis : retirer la date de l'événement n'efface rien.
    await modifier(compte, pose, '2026-01-21');
    expect(await corriger(compte, o, { realizedDate: '2026-01-23' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await dateEvenement(pose)).toBe('2026-01-23');
    await modifier(compte, pose, null);
    expect(await dateEvenement(pose)).toBeNull();
    expect((await op(o)).realise).toBe('2026-01-23');
    // Événement sans date : une correction de l'opération ne lui en donne pas d'office.
    expect(await corriger(compte, o, { realizedDate: '2026-01-24' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await dateEvenement(pose)).toBeNull();
  });

  it('L116C-D05 — événement partagé, porteur du fait de deux opérations : les deux suivent ; un seul événement, un seul rappel ; un autre compte n’est jamais touché', async () => {
    const compte = await make.account({ plan: 'premium' });
    const voisin = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const maisonVoisine = await make.asset(voisin, { category: 'IMMOBILIER', name: 'Maison' });
    const a = await operation(compte, 'INTERVENTION', maison.id, { status: 'ENVISAGED', planned: '2027-04-10', label: 'Révision de la chaudière' });
    const b = await operation(compte, 'INTERVENTION', maison.id, { status: 'ENVISAGED', planned: '2027-04-10', label: 'Ramonage' });
    const etrangere = await operation(voisin, 'INTERVENTION', maisonVoisine.id, { status: 'ENVISAGED', planned: '2027-04-10' });
    const visite = await evenement(compte, a, maison.id, 'Passage du chauffagiste', '2027-04-10', true);
    // Le même événement est PARTAGÉ avec b (lien N↔N) et en porte aussi le fait.
    const f = await facade();
    expect(await f.linkAgendaItem(user(compte), { operationId: b, agendaItemId: visite })).toMatchObject({ status: 'APPLIED' });
    const { stampAgendaLinkFact } = await import('@/services/business-operations/graph/store');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    await stampAgendaLinkFact(postgresRunner(sql as never), compte.id, { operationId: b, itemId: visite, factKey: 'INTERVENTION', origin: 'USER', reasonCode: 'L116C_D05' });

    await modifier(compte, visite, '2027-04-17');
    expect([(await op(a)).prevu, (await op(b)).prevu]).toEqual(['2027-04-17', '2027-04-17']);
    expect((await op(etrangere)).prevu).toBe('2027-04-10');
    expect((await reports(compte)).map((l) => l.op).sort((x, y) => x - y)).toEqual([a, b]);
    expect(await reports(voisin)).toEqual([]);
    // Un seul événement, et au plus UN rappel en file pour lui.
    expect((await volumes(compte)).evenements).toBe(1);
    const rappels = async () => (await sql<Json[]>`
      SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id} AND entity_id = ${visite} AND status IN ('pending', 'processing')`)[0].n;
    const apresAgenda = await rappels();
    expect(apresAgenda).toBeLessThanOrEqual(1);
    // L'opération a corrige à son tour : l'événement suit, b reste à sa date (a et b ne sont pas le même fait entre elles).
    expect(await corriger(compte, a, { plannedDate: '2027-04-24' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await dateEvenement(visite)).toBe('2027-04-24');
    expect((await op(b)).prevu).toBe('2027-04-17');
    expect(await rappels()).toBeLessThanOrEqual(1);
    expect((await volumes(compte)).evenements).toBe(1);
  });
});
