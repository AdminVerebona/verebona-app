/**
 * Lot 112G — rappels de la mascotte (T6) et cartes « À traiter » liées à
 * l'Agenda sur le STATUT EFFECTIF COMMUN (111R) — PostgreSQL 16 réel.
 *
 * Chaînes de PRODUCTION : lecture de la mascotte (`collectMascotData` :
 * lecture principale, lecture complémentaire T6, échéances dépassées),
 * revalidation au clic et « C'est fait » (`checkTarget`,
 * `acknowledgeOccurrence`), bloc « Rappels sur l'accueil »
 * (`getT6ReminderState`), cartes de statut (`proposeAgendaStatus`, page
 * « À traiter » `getToProcessPage` = page, pastille, récapitulatif e-mail),
 * rappel J-7 (`runDeadlineReminders`), accueil (`buildHomeSummary`),
 * dissociation (`/api/documents/:id/agenda-liens`). Seuls la session et
 * l'envoi de notification sont simulés. Aucun appel IA.
 *
 * La preuve de réalisation (103D, 0945) est posée sur une ÉCHÉANCE comme le
 * fait le report de preuve entre occurrences équivalentes (`carryProofInTx`)
 * — c'est le cas où la mascotte et les cartes divergeaient de l'Agenda.
 *
 *   L112G-E01  échéance dépassée, réalisée ET prouvée → Agenda « Réalisé » ; ni rappel, ni « dépassée », ni carte, ni « Rappel actif »
 *   L112G-E02  document supprimé → la preuve tombe : rappel, carte et « Date échue » reviennent
 *   L112G-E03  document dissocié (route de production) → même recalcul
 *   L112G-E04  jamais « réalisé » sans preuve valide ni statut manuel (preuve mémorisée mais document non lié)
 *   L112G-E05  statut manuel : comportement inchangé (réalisé / annulé = clos)
 *   L112G-E06  rappel J-7 : statut effectif (réalisée exclue, ouverte incluse) ; accueil : échéance prouvée absente
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
const emis = vi.hoisted(() => [] as Array<{ accountId: number; payload: { agendaItemIds: number[] } }>);
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/lib/notifications', async (o) => ({
  ...(await o<object>()), emit: async (e: { accountId: number; payload: { agendaItemIds: number[] } }) => { emis.push(e); },
}));

type Compte = AccountRow & { owner: { id: number } };
const jour = (decalage: number) => { const d = new Date(); d.setDate(d.getDate() + decalage); return d.toISOString().slice(0, 10); };
const ECHU = jour(-20);

scenario('L112G', 'Rappels T6 et cartes « À traiter » sur le statut effectif commun', ({ sql, make }) => {
  const as = (c: Compte) => { session.userId = c.owner.id; session.currentAccountId = c.id; };

  async function element(c: Compte, bien: AssetRow, o: { title: string; date: string; manual?: string | null }) {
    const [i] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, event_nature, business_type, origin_type, home_category, manual_status)
      VALUES (${c.id}, ${o.title}, ${o.date}, false, 'DEADLINE', 'maintenance', 'manual', 'action', ${o.manual ?? null}) RETURNING id`;
    await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${i.id}, ${bien.id})`;
    return i.id;
  }
  /** Facture liée à l'échéance, mémorisée comme preuve de réalisation (0945). */
  async function prouver(c: Compte, bien: AssetRow, itemId: number, o: { lier?: boolean } = {}) {
    const f = await make.assetFile(c, { assetId: bien.id });
    await sql`UPDATE asset_files SET document_type_code = 'FACTURE', document_date = ${ECHU}, retained_title = 'Facture révision' WHERE id = ${f.id}`;
    if (o.lier !== false) await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${itemId}, ${f.id}, ARRAY['AI_DIRECT']::text[])`;
    await sql`UPDATE agenda_items SET completion_proof_file_id = ${f.id}, completion_proven_at = now() WHERE id = ${itemId}`;
    return f.id;
  }

  async function tiroir(id: number): Promise<string> {
    const { GET } = await import('@/app/api/agenda/[id]/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda/${id}`), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { item: { effectiveStatus: string } }).item.effectiveStatus;
  }
  async function dissocier(fileId: number, itemId: number) {
    const { DELETE } = await import('@/app/api/documents/[id]/agenda-liens/route');
    const res = await DELETE(new NextRequest(`http://localhost/api/documents/${fileId}/agenda-liens?itemId=${itemId}`, { method: 'DELETE' }), { params: Promise.resolve({ id: String(fileId) }) });
    expect(res.status).toBe(200);
  }

  /** Ce que voient la mascotte, la revalidation au clic, le bloc de rappel et « À traiter ». */
  async function vu(c: Compte, id: number) {
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { checkTarget } = await import('@/services/home/mascot/actions.service');
    const { getT6ReminderState } = await import('@/services/home/mascot/t6-reminders.service');
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const raw = await collectMascotData(c.id);
    const etat = await getT6ReminderState({ accountId: c.id, userId: c.owner.id, agendaItemId: id });
    const page = await getToProcessPage(c.id, { orderMode: 'BY_PRIORITY' });
    return {
      mascotte: (raw.agenda ?? []).some((r) => r.id === id),
      depassee: (raw.overdueAgenda ?? []).some((r) => r.id === id),
      clic: await checkTarget(c.id, { kind: 'drawer', drawer: 'echeance', id } as never),
      rappel: 'relevance' in etat ? etat.relevance?.reason ?? 'ABSENT' : 'ERREUR',
      carte: page.actions.some((a) => a.targetType === 'AGENDA_ITEM' && a.targetId === id && a.ruleCode === 'AGENDA-DONE'),
    };
  }
  const ouvert = { mascotte: true, depassee: true, clic: 'ok', carte: true };
  const clos = { mascotte: false, depassee: false, clic: 'resolved', rappel: 'SUBJECT_CLOSED', carte: false };

  async function preparer() {
    const compte = await make.account({ plan: 'premium' }) as Compte;
    as(compte);
    const bien = await make.asset(compte, { name: 'Chaudière gaz' });
    const revision = await element(compte, bien, { title: 'Révision chaudière', date: ECHU });
    // Préférence de rappel (report) : le bloc « Rappels sur l'accueil » existe tant que le sujet est ouvert.
    await sql`INSERT INTO t6_reminder_preferences (account_id, user_id, subject_key, scope, decision, remind_at, agenda_item_id)
              VALUES (${compte.id}, ${compte.owner.id}, ${'agenda:' + revision}, 'OCCURRENCE', 'SNOOZED', ${jour(10)}, ${revision})`;
    const { proposeAgendaStatus } = await import('@/services/to-process/agenda-status-cards');
    expect((await proposeAgendaStatus({ accountId: compte.id, itemId: revision, kind: 'propose_done', sourceFileId: null })).status).toBe('CREATED');
    return { compte, bien, revision };
  }

  it('L112G-E01 — réalisée ET prouvée : Agenda « Réalisé » ; ni rappel, ni « dépassée », ni carte, ni « Rappel actif »', async () => {
    const d = await preparer();
    expect(await tiroir(d.revision)).toBe('en_retard');
    expect(await vu(d.compte, d.revision)).toMatchObject({ ...ouvert, rappel: 'USER_PREFERENCE' });
    await prouver(d.compte, d.bien, d.revision);
    expect(await tiroir(d.revision)).toBe('realise');
    expect(await vu(d.compte, d.revision)).toEqual(clos);
    // Plus aucune carte ne peut être créée ; « C'est fait » n'a plus d'objet.
    const { proposeAgendaStatus } = await import('@/services/to-process/agenda-status-cards');
    expect((await proposeAgendaStatus({ accountId: d.compte.id, itemId: d.revision, kind: 'propose_not_done', sourceFileId: null })).status).toBe('SKIPPED');
    const { acknowledgeOccurrence } = await import('@/services/home/mascot/actions.service');
    const ack = await acknowledgeOccurrence({ accountId: d.compte.id, userId: d.compte.owner.id, occurrenceKey: `MASC-EXT-ACTION:agenda:${d.revision}`, cycleKey: ECHU });
    expect(ack.ok).toBe(false);
    // Rien n'est écrit sur l'élément : statut manuel toujours vide.
    const [brut] = await sql<{ manual_status: string | null }[]>`SELECT manual_status FROM agenda_items WHERE id = ${d.revision}`;
    expect(brut.manual_status).toBeNull();
  });

  it('L112G-E02 — document supprimé : la preuve tombe, rappel / carte / « Date échue » reviennent', async () => {
    const d = await preparer();
    const f = await prouver(d.compte, d.bien, d.revision);
    expect(await vu(d.compte, d.revision)).toEqual(clos);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f}`;
    expect(await tiroir(d.revision)).toBe('en_retard');
    expect(await vu(d.compte, d.revision)).toMatchObject({ ...ouvert, rappel: 'USER_PREFERENCE' });
  });

  it('L112G-E03 — document dissocié (route de production) : même recalcul', async () => {
    const d = await preparer();
    const f = await prouver(d.compte, d.bien, d.revision);
    expect(await vu(d.compte, d.revision)).toEqual(clos);
    await dissocier(f, d.revision);
    expect(await tiroir(d.revision)).toBe('en_retard');
    expect(await vu(d.compte, d.revision)).toMatchObject({ ...ouvert, rappel: 'USER_PREFERENCE' });
  });

  it('L112G-E04 — jamais « réalisé » sans preuve valide : preuve mémorisée mais document non lié', async () => {
    const d = await preparer();
    await prouver(d.compte, d.bien, d.revision, { lier: false });
    expect(await tiroir(d.revision)).toBe('en_retard');
    expect(await vu(d.compte, d.revision)).toMatchObject({ ...ouvert, rappel: 'USER_PREFERENCE' });
  });

  it('L112G-E05 — statut manuel : réalisé ou annulé = clos (inchangé)', async () => {
    const d = await preparer();
    const autre = await element(d.compte, d.bien, { title: 'Ramonage', date: ECHU, manual: 'annule' });
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { checkTarget } = await import('@/services/home/mascot/actions.service');
    expect((await collectMascotData(d.compte.id)).overdueAgenda?.some((r) => r.id === autre)).toBe(false);
    expect(await checkTarget(d.compte.id, { kind: 'drawer', drawer: 'echeance', id: autre } as never)).toBe('resolved');
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${d.revision}`;
    expect((await vu(d.compte, d.revision))).toMatchObject({ mascotte: false, depassee: false, clic: 'resolved', rappel: 'SUBJECT_CLOSED', carte: false });
  });

  it('L112G-E06 — rappel J-7 sur le statut effectif ; accueil sans l’échéance prouvée', async () => {
    const d = await preparer();
    const { todayParisDateStr, addDaysToDateStr } = await import('@/lib/notifications/time-paris');
    const j7 = addDaysToDateStr(todayParisDateStr(new Date()), 7);
    const vide = await element(d.compte, d.bien, { title: 'Contrôle J-7', date: j7 });
    const fait = await element(d.compte, d.bien, { title: 'Contrôle J-7 réalisé', date: j7, manual: 'realise' });
    emis.length = 0;
    const { runDeadlineReminders } = await import('@/lib/notifications/scheduled/deadlines');
    await runDeadlineReminders(new Date());
    const ids = emis.filter((e) => e.accountId === d.compte.id).flatMap((e) => e.payload.agendaItemIds);
    expect(ids).toContain(vide);
    expect(ids).not.toContain(fait);
    // Accueil : l'échéance dépassée apparaît (« en retard ») tant qu'elle n'est pas prouvée.
    const { buildHomeSummary } = await import('@/services/home/HomeSummaryService');
    expect((await buildHomeSummary(d.compte.id)).blocks.upcoming.items.map((i) => i.id)).toContain(d.revision);
    await prouver(d.compte, d.bien, d.revision);
    expect((await buildHomeSummary(d.compte.id)).blocks.upcoming.items.map((i) => i.id)).not.toContain(d.revision);
  });
});
