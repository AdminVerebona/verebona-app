/**
 * Lot 77A — option « Sans échéance » des événements d'agenda (décision PO du
 * 21/10/2026, suite lot 76C : conflit RES-14 / décision 72C), sur
 * PostgreSQL réel (migration 0600 : colonne `no_deadline` + déclencheur).
 *
 * Appelle les VRAIES routes `POST /api/agenda`, `PUT /api/agenda/[id]`,
 * `GET /api/agenda`, `GET /api/equipments/[id]/agenda` (session simulée
 * seulement) et le VRAI producteur « À traiter » (`produceAgendaActions`,
 * balayage et campagne). La classification d'accueil (modèle) est neutralisée
 * (catégorie inconnue : cas exact de la décision 72C).
 *
 * Couvre : création cochée (aucune carte), refus serveur date + option,
 * édition (cocher → carte fermée avec motif tracé, jamais supprimée ;
 * décocher → MÊME carte rouverte), date saisie → option retirée (service et
 * déclencheur pour tout autre chemin), événement automatique édité, T6 /
 * pastille (aucune relance), isolation des comptes.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

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
// Droits d'écriture (abonnement) : hors sujet ici.
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: async () => null }));
// Classification de l'accueil : catégorie inconnue (aucun appel modèle) — cas de la décision 72C.
vi.mock('@/services/ai/agenda/agenda-intelligence.service', async (o) => ({
  ...(await o<object>()), classifyAgendaCategory: async () => null,
}));

type Compte = { id: number; ownerUserId: number };

scenario('L77A-SE', 'Agenda : option « Sans échéance » et carte « À traiter » de date', ({ sql, make }) => {
  let moi: Compte = { id: 0, ownerUserId: 0 };
  let autre: Compte = { id: 0, ownerUserId: 0 };
  const as = (c: Compte) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };

  const creer = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/agenda/route');
    const res = await POST(new NextRequest('http://localhost/api/agenda', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
    return { status: res.status, body: await res.json() as { item?: { id: number; noDeadline?: boolean; startDate: string | null }; error?: string } };
  };
  const modifier = async (id: number, body: Record<string, unknown>) => {
    const { PUT } = await import('@/app/api/agenda/[id]/route');
    const res = await PUT(new NextRequest(`http://localhost/api/agenda/${id}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: String(id) }) });
    return { status: res.status, body: await res.json() as { item?: { id: number; noDeadline?: boolean; startDate: string | null; startTime: string | null }; error?: string } };
  };
  const ligne = async (id: number) => (await sql<Array<{ no_deadline: boolean; start_date: string | null; start_time: string | null; end_date: string | null; is_automatic_modified: boolean }>>`
    SELECT no_deadline, to_char(start_date, 'YYYY-MM-DD') AS start_date, start_time::text AS start_time, to_char(end_date, 'YYYY-MM-DD') AS end_date, is_automatic_modified
      FROM agenda_items WHERE id = ${id}`)[0];
  const cartes = async (id: number) => sql<Array<{ id: number; open: boolean; reason: string | null; cycle: number }>>`
    SELECT id, resolved_at IS NULL AS open, resolution_reason AS reason, cycle_number AS cycle FROM to_process_actions
     WHERE target_type = 'AGENDA_ITEM' AND target_id = ${id} AND COALESCE(field_key, relation_key) = 'date' ORDER BY id`;
  const evenements = async (actionId: number) => sql<Array<{ event: string; reason: string | null }>>`
    SELECT event, details->>'reason' AS reason FROM to_process_action_events WHERE action_id = ${actionId} ORDER BY id`;
  const decisions = async (accountId: number, id: number) => sql<Array<Record<string, any>>>`
    SELECT * FROM to_process_decisions WHERE account_id = ${accountId} AND target_type = 'AGENDA_ITEM' AND target_id = ${id} ORDER BY id`;
  const traces = async (id: number) => sql<Array<{ event_type: string; actor_user_id: number | null }>>`
    SELECT event_type, actor_user_id FROM agenda_occurrence_events WHERE agenda_item_id = ${id} ORDER BY id`;
  const balayage = async (c: Compte, trigger: 'SWEEP' | 'BACKFILL' = 'SWEEP') =>
    (await import('@/services/to-process/producers.service')).produceAgendaActions(c.id, { trigger });

  it('prépare deux comptes', async () => {
    moi = await make.account();
    autre = await make.account();
  });

  it('L77A-E1 — création cochée (route) : enregistrée sans date, AUCUNE carte de date, décision tracée ; visible dans « Sans date » avec la mention', async () => {
    as(moi);
    const r = await creer({ title: 'Ranger la cave', noDeadline: true });
    expect(r.status).toBe(201);
    const id = r.body.item!.id;
    expect(r.body.item).toMatchObject({ noDeadline: true, startDate: null });
    expect(await ligne(id)).toMatchObject({ no_deadline: true, start_date: null });
    await balayage(moi);
    expect(await cartes(id)).toEqual([]);
    expect((await decisions(moi.id, id)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', reason_code: 'NO_DEADLINE_BY_USER' });
    // Agenda : élément sans date (groupe « Sans date »), porteur de l'option.
    const { GET } = await import('@/app/api/agenda/route');
    const liste = await (await GET(new NextRequest('http://localhost/api/agenda?period=all&includeUndated=true'))).json() as { items: Array<{ id: number; noDeadline?: boolean; startDate: string | null }> };
    expect(liste.items.find((i) => i.id === id)).toMatchObject({ noDeadline: true, startDate: null });
  });

  it('L77A-E2 — validation serveur : option + date dans la même demande → 400, rien n’est créé ; valeur non booléenne → 400', async () => {
    as(moi);
    const avant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${moi.id}`)[0].n;
    const r = await creer({ title: 'Incohérent', noDeadline: true, startDate: '2027-02-01' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Sans échéance/);
    expect((await creer({ title: 'Incohérent', noDeadline: 'oui' })).status).toBe(400);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${moi.id}`)[0].n).toBe(avant);
  });

  it('L77A-E3 — édition : cocher FERME la carte existante (motif tracé, jamais supprimée) ; décocher ROUVRE la même carte (décision 72C)', async () => {
    as(moi);
    const r = await creer({ title: 'Appeler le plombier' });
    const id = r.body.item!.id;
    expect(r.body.item!.noDeadline).toBe(false);
    await balayage(moi);
    const [carte] = await cartes(id);
    expect(carte).toMatchObject({ open: true });

    // Cocher : fermeture IMMÉDIATE (sans attendre le balayage), motif tracé.
    expect((await modifier(id, { noDeadline: true })).status).toBe(200);
    expect(await cartes(id)).toEqual([expect.objectContaining({ id: carte.id, open: false, reason: 'OBSOLETE' })]);
    expect((await evenements(carte.id)).at(-1)).toEqual({ event: 'OBSOLETE', reason: 'NO_DEADLINE_BY_USER' });
    expect((await decisions(moi.id, id)).at(-1)).toMatchObject({ trigger_code: 'USER', outcome: 'NO_ACTION', reason_code: 'NO_DEADLINE_BY_USER' });
    expect(await traces(id)).toEqual([{ event_type: 'NO_DEADLINE_SET', actor_user_id: moi.ownerUserId }]);
    // Balayage et campagne suivants : la carte reste fermée, aucune nouvelle carte.
    await balayage(moi);
    await balayage(moi, 'BACKFILL');
    expect(await cartes(id)).toHaveLength(1);
    expect((await cartes(id))[0].open).toBe(false);

    // Décocher : la MÊME carte est rouverte (même cycle), réouverture tracée.
    expect((await modifier(id, { noDeadline: false })).status).toBe(200);
    expect(await cartes(id)).toEqual([expect.objectContaining({ id: carte.id, open: true, reason: null, cycle: carte.cycle })]);
    expect((await evenements(carte.id)).at(-1)).toEqual({ event: 'REOPENED', reason: 'NO_DEADLINE_CLEARED' });
    expect((await traces(id)).map((t) => t.event_type)).toEqual(['NO_DEADLINE_SET', 'NO_DEADLINE_CLEARED']);
    await balayage(moi);
    expect((await cartes(id)).filter((c) => c.open).map((c) => c.id)).toEqual([carte.id]);
  });

  it('L77A-E4 — incompatibilité : cocher neutralise la date et les heures ; saisir une date retire l’option (route, puis tout autre chemin via le déclencheur)', async () => {
    as(moi);
    const id = (await creer({ title: 'Vidange', startDate: '2027-03-01', startTime: '09:30', endDate: '2027-03-01', endTime: '10:30' })).body.item!.id;
    const coche = await modifier(id, { noDeadline: true });
    expect(coche.status).toBe(200);
    expect(await ligne(id)).toMatchObject({ no_deadline: true, start_date: null, start_time: null, end_date: null });
    // Le tiroir envoie tous les champs : une date saisie décoche.
    const date = await modifier(id, { startDate: '2027-05-01', noDeadline: false });
    expect(date.status).toBe(200);
    expect(await ligne(id)).toMatchObject({ no_deadline: false, start_date: '2027-05-01' });
    // Sans l'option dans la demande : la date seule la retire aussi.
    await modifier(id, { noDeadline: true });
    await modifier(id, { startDate: '2027-06-01' });
    expect(await ligne(id)).toMatchObject({ no_deadline: false, start_date: '2027-06-01' });
    // Tout autre chemin d'écriture (réponse à une carte, assistant, T4…) : le déclencheur retire l'option.
    await modifier(id, { noDeadline: true });
    await sql`UPDATE agenda_items SET start_date = '2027-07-01' WHERE id = ${id}`;
    expect(await ligne(id)).toMatchObject({ no_deadline: false, start_date: '2027-07-01' });
    await sql`UPDATE agenda_items SET start_date = NULL, no_deadline = true WHERE id = ${id}`;
    expect((await ligne(id)).no_deadline).toBe(true);
    await sql`UPDATE agenda_items SET no_deadline = true, start_date = '2027-08-01' WHERE id = ${id}`;
    expect((await ligne(id)).no_deadline).toBe(false);
  });

  it('L77A-E5 — événement automatique ÉDITÉ par l’utilisateur : option acceptée, élément protégé de T4 ; jamais activée automatiquement', async () => {
    as(moi);
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, home_category)
      VALUES (${moi.id}, 'Échéance lue', NULL, true, 'qualified_document', 'action') RETURNING id`;
    expect((await ligne(id)).no_deadline).toBe(false);
    await balayage(moi);
    const [carte] = await cartes(id);
    expect(carte).toMatchObject({ open: true });
    expect((await modifier(id, { noDeadline: true })).status).toBe(200);
    expect(await ligne(id)).toMatchObject({ no_deadline: true, is_automatic_modified: true });
    expect((await cartes(id))[0]).toMatchObject({ open: false, reason: 'OBSOLETE' });
  });

  it('L77A-E6 — aucune relance : ni carte active (pastille, mascotte T6), ni question de date pour la tâche « sans échéance »', async () => {
    as(moi);
    const id = (await creer({ title: 'Trier les papiers', noDeadline: true })).body.item!.id;
    await balayage(moi);
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const page = await getToProcessPage(moi.id, { orderMode: 'BY_PRIORITY' });
    expect(JSON.stringify(page.actions)).not.toContain('Trier les papiers');
    const actives = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE target_type = 'AGENDA_ITEM' AND target_id = ${id} AND resolved_at IS NULL`;
    expect(actives[0].n).toBe(0);
  });

  it('L77A-E7 — isolation des comptes : un autre compte ne lit ni ne modifie l’option ; son balayage ne touche pas aux cartes de ce compte', async () => {
    as(moi);
    const id = (await creer({ title: 'Tâche privée' })).body.item!.id;
    await balayage(moi);
    const [carte] = await cartes(id);
    as(autre);
    const r = await modifier(id, { noDeadline: true });
    expect(r.status).toBe(404);
    expect((await ligne(id)).no_deadline).toBe(false);
    await balayage(autre);
    expect((await cartes(id))[0]).toMatchObject({ id: carte.id, open: true });
    const { GET } = await import('@/app/api/agenda/route');
    const liste = await (await GET(new NextRequest('http://localhost/api/agenda?period=all&includeUndated=true'))).json() as { items: Array<{ id: number }> };
    expect(liste.items.map((i) => i.id)).not.toContain(id);
  });
});
