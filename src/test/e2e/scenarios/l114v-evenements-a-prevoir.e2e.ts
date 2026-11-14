/**
 * Lot 114V — Trello #742 « Événements — “A eu lieu | À prévoir”, sans date,
 * Accueil / Agenda / À traiter », sur PostgreSQL réel (migration 1730 :
 * colonnes `situation`, `situation_source`, `situation_decided_at`).
 *
 * Appelle les VRAIES routes `POST /api/agenda`, `PUT /api/agenda/[id]`,
 * `GET /api/agenda` (session simulée seulement), le VRAI producteur « À
 * traiter » (`produceAgendaActions`, balayage et campagne), la vraie file
 * (`getToProcessPage`), le vrai résumé d'accueil (`buildHomeSummary`), les
 * vrais rappels d'échéance (#732, `runDeadlineReminders`), l'export
 * calendrier (ICS) et le fichier de la migration 1730 (rejoué deux fois).
 * La classification d'accueil (modèle) est neutralisée. Horloge simulée
 * (`Date` seulement) : aucun test ne dépend de la date du jour ; la reprise,
 * qui lit CURRENT_DATE de la base, n'utilise que des dates très éloignées.
 *
 * Correspondance avec la section 10 de la carte : voir
 * `docs/exploitation/recette-114v-evenements-a-prevoir.md`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
// Classification de l'accueil : catégorie inconnue (aucun appel modèle).
vi.mock('@/services/ai/agenda/agenda-intelligence.service', async (o) => ({
  ...(await o<object>()), classifyAgendaCategory: async () => null,
}));

type Compte = { id: number; ownerUserId: number };
type Item = { id: number; situation?: string | null; startDate: string | null; noDeadline?: boolean };

/** Instant simulé (Europe/Paris, hiver) et dates relatives. */
const JOUR = '2026-11-14';
const MAINTENANT = new Date(`${JOUR}T10:00:00+01:00`);
const plus = (n: number) => { const t = new Date(`${JOUR}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

scenario('L114V', 'Agenda : situation « A eu lieu | À prévoir », sans date — Accueil, Agenda, « À traiter », rappels, reprise', ({ sql, make }) => {
  let moi: Compte = { id: 0, ownerUserId: 0 };
  let autre: Compte = { id: 0, ownerUserId: 0 };
  let maison = 0;
  const as = (c: Compte, userId = c.ownerUserId) => { session.userId = userId; session.currentAccountId = c.id; };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MAINTENANT); });
  afterEach(() => { vi.useRealTimers(); });

  const creer = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/agenda/route');
    const res = await POST(new NextRequest('http://localhost/api/agenda', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
    return { status: res.status, body: await res.json() as { item?: Item; error?: string } };
  };
  const modifier = async (id: number, body: Record<string, unknown>) => {
    const { PUT } = await import('@/app/api/agenda/[id]/route');
    const res = await PUT(new NextRequest(`http://localhost/api/agenda/${id}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: String(id) }) });
    return { status: res.status, body: await res.json() as { item?: Item; error?: string } };
  };
  const lister = async (query: string) => {
    const { GET } = await import('@/app/api/agenda/route');
    return (await (await GET(new NextRequest(`http://localhost/api/agenda?${query}`))).json() as { items: Item[] }).items;
  };
  const ligne = async (id: number) => (await sql<Array<{ situation: string | null; source: string | null; decided: boolean; start_date: string | null; no_deadline: boolean; modified: boolean }>>`
    SELECT situation, situation_source AS source, situation_decided_at IS NOT NULL AS decided, to_char(start_date, 'YYYY-MM-DD') AS start_date,
           no_deadline, is_automatic_modified AS modified FROM agenda_items WHERE id = ${id}`)[0];
  const cartes = async (id: number) => sql<Array<{ id: number; open: boolean; reason: string | null; question: string; kind: string }>>`
    SELECT id, resolved_at IS NULL AS open, resolution_reason AS reason, question, action_kind AS kind FROM to_process_actions
     WHERE target_type = 'AGENDA_ITEM' AND target_id = ${id} AND COALESCE(field_key, relation_key) = 'date' ORDER BY id`;
  const dernierMotif = async (actionId: number) => (await sql<Array<{ event: string; reason: string | null }>>`
    SELECT event, details->>'reason' AS reason FROM to_process_action_events WHERE action_id = ${actionId} ORDER BY id DESC LIMIT 1`)[0];
  const decision = async (accountId: number, id: number) => (await sql<Array<{ outcome: string; reason_code: string | null }>>`
    SELECT outcome, reason_code FROM to_process_decisions WHERE account_id = ${accountId} AND target_type = 'AGENDA_ITEM' AND target_id = ${id} ORDER BY id DESC LIMIT 1`)[0];
  const traces = async (id: number) => sql<Array<{ event_type: string; actor_user_id: number | null; detail: Record<string, unknown> }>>`
    SELECT event_type, actor_user_id, detail_json AS detail FROM agenda_occurrence_events WHERE agenda_item_id = ${id} ORDER BY id`;
  const liens = async (id: number) => (await sql<Array<{ asset_id: number }>>`SELECT asset_id FROM agenda_asset_links WHERE agenda_item_id = ${id} ORDER BY asset_id`).map((l) => l.asset_id);
  const balayage = async (c: Compte, trigger: 'SWEEP' | 'BACKFILL' = 'SWEEP') =>
    (await import('@/services/to-process/producers.service')).produceAgendaActions(c.id, { trigger });
  const accueil = async (c: Compte) => (await (await import('@/services/home/HomeSummaryService')).buildHomeSummary(c.id)).blocks.upcoming;
  const couverture = async (id: number) => sql<Array<{ due: string; state: string; outcome: string | null }>>`
    SELECT to_char(due_date, 'YYYY-MM-DD') AS due, state, outcome FROM agenda_deadline_reminders WHERE agenda_item_id = ${id} ORDER BY id`;
  const rattrapage = async () => (await import('@/lib/notifications/scheduled/deadlines')).runDeadlineReminders(MAINTENANT);
  /** Saisie par le service de l'Agenda, catégorie « action » (échéance éligible aux rappels #732). */
  const saisirAction = async (c: Compte, p: Record<string, unknown>) => {
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    return (await createAgendaItem({ homeCategory: 'action', ...p } as never, c.id, c.ownerUserId)).id;
  };
  const nombre = async (c: Compte) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id}`)[0].n;

  it('prépare deux comptes et un bien', async () => {
    moi = await make.account({ plan: 'premium' });
    autre = await make.account({ plan: 'premium' });
    maison = (await make.asset(moi, { category: 'IMMOBILIER', name: 'Maison' })).id;
  });

  it('L114V-E01 — « Entretien pompe à chaleur » / Maison créé SANS date et SANS toucher au sélecteur : « À prévoir » enregistré (défaut serveur), accueil « À prévoir », Agenda sans date, AUCUNE carte de date, aucun rappel, aucune entrée ICS', async () => {
    as(moi);
    const r = await creer({ title: 'Entretien pompe à chaleur', assetIds: [maison] });
    expect(r.status).toBe(201);
    const id = r.body.item!.id;
    expect(r.body.item).toMatchObject({ situation: 'A_PREVOIR', startDate: null });
    expect(await ligne(id)).toMatchObject({ situation: 'A_PREVOIR', source: 'DEFAULT', decided: true, start_date: null });
    expect(await liens(id)).toEqual([maison]);

    // « À traiter » : jamais « À quelle date … a-t-il (eu) lieu ? » — balayage, campagne, réévaluation.
    await balayage(moi);
    await balayage(moi, 'BACKFILL');
    expect(await cartes(id)).toEqual([]);
    expect(await decision(moi.id, id)).toMatchObject({ outcome: 'NO_ACTION', reason_code: 'SITUATION_QUALIFIED' });

    // Accueil : groupe « À prévoir » de « Prochaines échéances », avec le bien, sans date ; jamais dans les échéances datées.
    const bloc = await accueil(moi);
    expect(bloc.toPlan.items).toEqual([{ id, title: 'Entretien pompe à chaleur', assetName: 'Maison' }]);
    expect(bloc.toPlan.total).toBe(1);
    expect(bloc.items.map((i) => i.id)).not.toContain(id);

    // Agenda : hors calendrier daté — présent dans « tout » et « à venir », jamais dans « passé » ni « aujourd'hui » daté.
    expect((await lister('period=all&includeUndated=true')).find((i) => i.id === id)).toMatchObject({ situation: 'A_PREVOIR', startDate: null });
    expect((await lister('period=upcoming')).map((i) => i.id)).toContain(id);
    expect((await lister('period=past')).map((i) => i.id)).not.toContain(id);

    // Rappels (#732) et calendrier externe : rien sans date.
    await rattrapage();
    expect(await couverture(id)).toEqual([]);
    const { getAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    const { computeICSContent } = await import('@/services/agenda/AgendaCalendarExportService');
    const ics = computeICSContent(await getAgendaItems({ accountId: moi.id, includeUndated: true }), 'Verebona');
    expect(ics).not.toContain('Entretien pompe');
    expect(ics).toMatch(/^BEGIN:VCALENDAR[\s\S]*END:VCALENDAR\s*$/);
  });

  it('L114V-E02 — « A eu lieu » SANS date : réalisé, date inconnue — consultable dans l’Agenda, ni groupe « À prévoir », ni à-venir, ni carte de complétion', async () => {
    as(moi);
    const r = await creer({ title: 'Ramonage', situation: 'A_EU_LIEU', assetIds: [maison] });
    expect(r.status).toBe(201);
    const id = r.body.item!.id;
    expect(await ligne(id)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER', start_date: null });
    await balayage(moi);
    expect(await cartes(id)).toEqual([]);
    expect(await decision(moi.id, id)).toMatchObject({ outcome: 'NO_ACTION', reason_code: 'SITUATION_QUALIFIED' });
    const bloc = await accueil(moi);
    expect(bloc.toPlan.items.map((i) => i.id)).not.toContain(id);
    expect(bloc.items.map((i) => i.id)).not.toContain(id);
    expect((await lister('period=all')).find((i) => i.id === id)).toMatchObject({ situation: 'A_EU_LIEU', startDate: null });
    expect((await lister('period=past')).map((i) => i.id)).toContain(id);
    expect((await lister('period=upcoming')).map((i) => i.id)).not.toContain(id);
    const { getHomepageAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    expect((await getHomepageAgendaItems(moi.id)).map((i) => i.id)).not.toContain(id);
  });

  it('L114V-E03 — « A eu lieu » avec une date PASSÉE ou du JOUR : historique daté ; aucun rappel à venir, jamais dans les échéances à venir', async () => {
    as(moi);
    const passe = await saisirAction(moi, { title: 'Contrôle chaudière', startDate: plus(-40), situation: 'A_EU_LIEU' });
    const jour = await saisirAction(moi, { title: 'Visite du chauffagiste', startDate: JOUR, situation: 'A_EU_LIEU' });
    expect(await ligne(passe)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER', start_date: plus(-40) });
    await rattrapage();
    expect(await couverture(passe)).toEqual([]);
    expect(await couverture(jour)).toEqual([]);
    const bloc = await accueil(moi);
    expect(bloc.items.map((i) => i.id)).not.toContain(jour);
    expect(bloc.items.map((i) => i.id)).not.toContain(passe);
    expect((await lister('period=past')).map((i) => i.id)).toContain(passe);
  });

  it('L114V-E04 — « À prévoir » avec une date FUTURE : échéance datée normale (accueil daté, rappel #732), jamais dans le groupe sans date, aucun doublon', async () => {
    as(moi);
    const avant = await nombre(moi);
    const id = await saisirAction(moi, { title: 'Révision de la toiture', startDate: plus(3), assetIds: [maison] });
    expect(await nombre(moi)).toBe(avant + 1);
    expect(await ligne(id)).toMatchObject({ situation: 'A_PREVOIR', source: 'DEFAULT', start_date: plus(3) });
    const bloc = await accueil(moi);
    expect(bloc.items.find((i) => i.id === id)).toMatchObject({ date: plus(3), rel: 'Dans 3 jours' });
    expect(bloc.toPlan.items.map((i) => i.id)).not.toContain(id);
    // Rappel d'échéance : couvert une fois (écriture), le rattrapage ne le double pas.
    await rattrapage();
    await rattrapage();
    expect(await couverture(id)).toEqual([{ due: plus(3), state: 'pending', outcome: null }]);
    expect(await cartes(id)).toEqual([]);
  });

  it('L114V-E05 — « À prévoir » avec une date PASSÉE : l’intention est conservée (jamais auto-confirmé « A eu lieu »), ni « en retard », ni rappel, ni carte', async () => {
    as(moi);
    const r = await creer({ title: 'Détartrage du ballon', startDate: plus(-20), situation: 'A_PREVOIR' });
    expect(r.status).toBe(201);
    const id = r.body.item!.id;
    await balayage(moi);
    await rattrapage();
    expect(await ligne(id)).toMatchObject({ situation: 'A_PREVOIR', source: 'USER', start_date: plus(-20) });
    expect(await cartes(id)).toEqual([]);
    expect(await couverture(id)).toEqual([]);
    const bloc = await accueil(moi);
    expect(bloc.items.map((i) => i.id)).not.toContain(id);
    expect(bloc.toPlan.items.map((i) => i.id)).not.toContain(id);
    expect(JSON.stringify(bloc)).not.toMatch(/En retard/);
  });

  it('L114V-E06 — contradiction « A eu lieu » + date FUTURE : refus explicite (400), rien n’est créé ni corrigé en silence ; valeur inconnue : 400', async () => {
    as(moi);
    const avant = await nombre(moi);
    const r = await creer({ title: 'Incohérent', situation: 'A_EU_LIEU', startDate: plus(10) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/« A eu lieu » ne peut pas avoir une date future/);
    expect((await creer({ title: 'Incohérent', situation: 'realise' })).status).toBe(400);
    expect((await creer({ title: 'Incohérent', situation: 'A_EU_LIEU', noDeadline: true })).status).toBe(400);
    expect(await nombre(moi)).toBe(avant);

    // Modification : poser une date future sur « A eu lieu », ou « A eu lieu » sur une date future — refus, état inchangé.
    const eu = (await creer({ title: 'Vidange de la fosse', situation: 'A_EU_LIEU', startDate: plus(-5) })).body.item!.id;
    expect((await modifier(eu, { startDate: plus(30) })).status).toBe(400);
    expect(await ligne(eu)).toMatchObject({ situation: 'A_EU_LIEU', start_date: plus(-5) });
    const prevu = (await creer({ title: 'Élagage', startDate: plus(30) })).body.item!.id;
    const refus = await modifier(prevu, { situation: 'A_EU_LIEU' });
    expect(refus.status).toBe(400);
    expect(refus.body.error).toMatch(/date future/);
    expect(await ligne(prevu)).toMatchObject({ situation: 'A_PREVOIR', start_date: plus(30) });
    expect(await traces(prevu)).toEqual([]);
    // Le couple cohérent est accepté dans la même demande (date du jour + « A eu lieu »).
    expect((await modifier(prevu, { situation: 'A_EU_LIEU', startDate: JOUR })).status).toBe(200);
    expect(await ligne(prevu)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER', start_date: JOUR });
  });

  it('L114V-E07 — aller-retour date absente → définie → retirée : MÊME identifiant, mêmes liens, accueil et rappels cohérents, rattrapage idempotent', async () => {
    as(moi);
    const id = await saisirAction(moi, { title: 'Entretien de la VMC', assetIds: [maison] });
    expect(await ligne(id)).toMatchObject({ situation: 'A_PREVOIR', start_date: null });
    expect((await accueil(moi)).toPlan.items.map((i) => i.id)).toContain(id);
    await rattrapage();
    expect(await couverture(id)).toEqual([]);
    const avant = await nombre(moi);

    // « Planifier » : une date est posée sur le même événement.
    const date = await modifier(id, { startDate: plus(5) });
    expect(date.status).toBe(200);
    expect(date.body.item).toMatchObject({ id, situation: 'A_PREVOIR', startDate: plus(5) });
    let bloc = await accueil(moi);
    expect(bloc.toPlan.items.map((i) => i.id)).not.toContain(id);
    expect(bloc.items.find((i) => i.id === id)).toMatchObject({ date: plus(5) });
    await rattrapage();
    await rattrapage();
    expect(await couverture(id)).toEqual([{ due: plus(5), state: 'pending', outcome: null }]);

    // Date retirée volontairement : retour dans « À prévoir » sans date ; le rappel en file est annulé.
    const retiree = await modifier(id, { startDate: null });
    expect(retiree.status).toBe(200);
    expect(await ligne(id)).toMatchObject({ situation: 'A_PREVOIR', start_date: null });
    await rattrapage();
    expect(await couverture(id)).toEqual([{ due: plus(5), state: 'cancelled', outcome: 'stale' }]);
    bloc = await accueil(moi);
    expect(bloc.toPlan.items.map((i) => i.id)).toContain(id);
    expect(bloc.items.map((i) => i.id)).not.toContain(id);
    expect(await liens(id)).toEqual([maison]);
    expect(await nombre(moi)).toBe(avant);
    expect(await cartes(id)).toEqual([]);
  });

  it('L114V-E08 — « À prévoir » ↔ « A eu lieu » sur un événement sans date puis daté : décision tracée (auteur), rappel arrêté après « A eu lieu », date retirée d’un réalisé → reste « A eu lieu »', async () => {
    as(moi);
    const id = await saisirAction(moi, { title: 'Purge des radiateurs', assetIds: [maison] });
    // Sans date : « À prévoir » → « A eu lieu » (date inconnue), même événement.
    expect((await modifier(id, { situation: 'A_EU_LIEU' })).status).toBe(200);
    expect(await ligne(id)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER', start_date: null });
    expect((await accueil(moi)).toPlan.items.map((i) => i.id)).not.toContain(id);
    // Retour à « À prévoir », puis date future : rappel normal.
    expect((await modifier(id, { situation: 'A_PREVOIR', startDate: plus(2) })).status).toBe(200);
    await rattrapage();
    expect(await couverture(id)).toEqual([{ due: plus(2), state: 'pending', outcome: null }]);
    // L'événement a finalement eu lieu aujourd'hui : rappel en file annulé, plus rien à venir.
    expect((await modifier(id, { situation: 'A_EU_LIEU', startDate: JOUR })).status).toBe(200);
    await rattrapage();
    expect((await couverture(id)).filter((c) => c.state !== 'cancelled')).toEqual([]);
    expect((await accueil(moi)).items.map((i) => i.id)).not.toContain(id);
    // Date retirée d'un événement réalisé : il reste « A eu lieu » (jamais reclassé « À prévoir »).
    expect((await modifier(id, { startDate: null })).status).toBe(200);
    expect(await ligne(id)).toMatchObject({ situation: 'A_EU_LIEU', start_date: null });
    expect((await accueil(moi)).toPlan.items.map((i) => i.id)).not.toContain(id);
    // Trace de chaque requalification (avant / après, auteur) ; liens intacts.
    const requalifs = (await traces(id)).filter((t) => t.event_type === 'SITUATION_SET');
    expect(requalifs.map((t) => [(t.detail.before as { situation: string }).situation, (t.detail.after as { situation: string }).situation, t.actor_user_id])).toEqual([
      ['A_PREVOIR', 'A_EU_LIEU', moi.ownerUserId], ['A_EU_LIEU', 'A_PREVOIR', moi.ownerUserId], ['A_PREVOIR', 'A_EU_LIEU', moi.ownerUserId],
    ]);
    expect(await liens(id)).toEqual([maison]);
  });

  it('L114V-E09 — « À traiter », élément HÉRITÉ ambigu : UNE carte de qualification neutre (sans date présupposée), choix persistant, carte fermée et jamais régénérée', async () => {
    as(moi);
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, origin_type, created_by_user_id)
      VALUES (${moi.id}, 'Vérification du détecteur de fumée', NULL, 'manual', ${moi.ownerUserId}) RETURNING id`;
    expect(await ligne(id)).toMatchObject({ situation: null, source: null });
    await balayage(moi);
    await balayage(moi);
    let c = await cartes(id);
    expect(c).toEqual([expect.objectContaining({ open: true, kind: 'COMPLETE', question: 'Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?' })]);

    // Carte ouverte AVANT le lot (ancienne question) : reformulée au balayage suivant, même carte.
    await sql`UPDATE to_process_actions SET question = 'À quelle date « Vérification du détecteur de fumée » a-t-il lieu ?' WHERE id = ${c[0].id}`;
    await balayage(moi);
    c = await cartes(id);
    expect(c).toHaveLength(1);
    expect(c[0].question).toBe('Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?');

    // La file affichée porte la question neutre, sans proposition présélectionnée.
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const vue = (await getToProcessPage(moi.id, { orderMode: 'BY_PRIORITY' })).actions.find((a) => a.targetType === 'AGENDA_ITEM' && a.targetId === id)!;
    expect(vue).toMatchObject({ ruleCode: 'DATA-AGENDA-DATE', actionKind: 'COMPLETE', question: 'Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?', proposals: [] });

    // Choix explicite depuis la carte (même route que le tiroir), avec une date facultative NON saisie.
    expect((await modifier(id, { situation: 'A_PREVOIR' })).status).toBe(200);
    expect(await ligne(id)).toMatchObject({ situation: 'A_PREVOIR', source: 'USER', start_date: null });
    c = await cartes(id);
    expect(c).toEqual([expect.objectContaining({ open: false, reason: 'OBSOLETE' })]);
    expect(await dernierMotif(c[0].id)).toEqual({ event: 'OBSOLETE', reason: 'SITUATION_QUALIFIED' });
    // Quotidien, campagne, réévaluation : jamais régénérée.
    await balayage(moi);
    await balayage(moi, 'BACKFILL');
    expect(await cartes(id)).toHaveLength(1);
    expect((await getToProcessPage(moi.id, { orderMode: 'BY_PRIORITY' })).actions.filter((a) => a.targetType === 'AGENDA_ITEM' && a.targetId === id)).toEqual([]);
    expect((await accueil(moi)).toPlan.items.map((i) => i.id)).toContain(id);
  });

  it('L114V-E10 — événement issu d’un traitement (T4) : jamais qualifié d’office ; la décision de l’utilisateur le protège des réécritures et ferme sa carte', async () => {
    as(moi);
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, home_category)
      VALUES (${moi.id}, 'Entretien annuel lu dans un contrat', NULL, true, 'qualified_document', 'action') RETURNING id`;
    await balayage(moi);
    expect(await ligne(id)).toMatchObject({ situation: null, modified: false });
    const [carte] = await cartes(id);
    expect(carte).toMatchObject({ open: true, question: 'Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?' });

    // Une écriture AUTOMATIQUE (primitive commune, canal T4) ne pose jamais la situation.
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    await upsertAgendaItem({ itemId: id, accountId: moi.id, assetId: null, origin: 'AUTOMATIC', title: 'Entretien annuel lu dans un contrat', details: { situation: 'A_EU_LIEU' } }, { validate: false });
    expect((await ligne(id)).situation).toBeNull();

    // L'utilisateur qualifie : décision persistée, élément protégé, carte fermée.
    expect((await modifier(id, { situation: 'A_EU_LIEU' })).status).toBe(200);
    expect(await ligne(id)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER', modified: true, start_date: null });
    expect((await cartes(id))[0]).toMatchObject({ open: false, reason: 'OBSOLETE' });
    // Une réécriture automatique ultérieure (mise à jour GARDÉE, comme la synchronisation T4) ne l'efface pas
    // et ne pose aucune date sur l'élément protégé.
    const reecriture = await upsertAgendaItem({ itemId: id, accountId: moi.id, assetId: null, origin: 'AUTOMATIC', title: 'Entretien annuel (réanalyse)', date: plus(90) }, { validate: false, onlyIfUntouched: true });
    expect(reecriture.protected).toBe(true);
    await balayage(moi);
    expect(await ligne(id)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER', start_date: null });
    expect((await cartes(id)).filter((x) => x.open)).toEqual([]);
  });

  it('L114V-E11 — création hors saisie de l’utilisateur (donnée à qualifier) : non qualifiée ; ancien client sans situation en modification : rien n’est reclassé', async () => {
    as(moi);
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const aQualifier = await createAgendaItem({ title: 'Nouvelle donnée à qualifier', requiresQualification: true, originType: 'manual' }, moi.id, null);
    expect(await ligne(aQualifier.id)).toMatchObject({ situation: null, source: null });
    // Élément hérité modifié par un ancien client (titre seulement) : toujours non qualifié.
    const [{ id }] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, start_date, origin_type) VALUES (${moi.id}, 'Ancien événement', '2020-05-01', 'manual') RETURNING id`;
    expect((await modifier(id, { title: 'Ancien événement renommé' })).status).toBe(200);
    expect(await ligne(id)).toMatchObject({ situation: null, source: null, start_date: '2020-05-01' });
    // La provenance n'est jamais lue du client.
    expect((await modifier(id, { situation: 'A_EU_LIEU', situationSource: 'MIGRATION' })).status).toBe(200);
    expect(await ligne(id)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER' });
  });

  it('L114V-E12 — accueil : groupe « À prévoir » BORNÉ (3 lignes, les plus récentes), total exact, échéances datées inchangées, aucun double compte', async () => {
    as(moi);
    for (const t of ['Nettoyage des gouttières', 'Contrôle du portail', 'Entretien de l’adoucisseur']) expect((await creer({ title: t })).status).toBe(201);
    const bloc = await accueil(moi);
    const total = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${moi.id} AND start_date IS NULL AND situation = 'A_PREVOIR'`)[0].n;
    expect(total).toBeGreaterThan(3);
    expect(bloc.toPlan.total).toBe(total);
    expect(bloc.toPlan.items).toHaveLength(3);
    expect(bloc.toPlan.items[0].title).toBe('Entretien de l’adoucisseur');
    const datees = new Set(bloc.items.map((i) => i.id));
    expect(bloc.toPlan.items.filter((i) => datees.has(i.id))).toEqual([]);
    // Agenda (liste complète) : chaque élément sans date une seule fois, avec sa situation.
    const tous = (await lister('period=all&includeUndated=true')).filter((i) => !i.startDate);
    expect(new Set(tous.map((i) => i.id)).size).toBe(tous.length);
    expect(tous.filter((i) => i.situation === 'A_PREVOIR')).toHaveLength(total);
  });

  it('L114V-E13 — comptes séparés et Duo : un autre compte ne lit ni ne modifie rien ; un second membre du compte lit et qualifie (auteur tracé)', async () => {
    as(moi);
    const id = (await creer({ title: 'Événement privé' })).body.item!.id;
    as(autre);
    expect((await modifier(id, { situation: 'A_EU_LIEU' })).status).toBe(404);
    expect((await lister('period=all&includeUndated=true')).map((i) => i.id)).not.toContain(id);
    expect((await accueil(autre)).toPlan).toEqual({ items: [], total: 0 });
    await balayage(autre);
    expect(await ligne(id)).toMatchObject({ situation: 'A_PREVOIR', source: 'DEFAULT' });
    // Duo : second membre actif du même compte.
    const second = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${moi.id}, ${second.id}, 'member', 'active')`;
    as(moi, second.id);
    expect((await lister('period=all&includeUndated=true')).find((i) => i.id === id)).toMatchObject({ situation: 'A_PREVOIR' });
    expect((await modifier(id, { situation: 'A_EU_LIEU' })).status).toBe(200);
    expect((await traces(id)).at(-1)).toMatchObject({ event_type: 'SITUATION_SET', actor_user_id: second.id });
  });

  it('L114V-E14 — reprise (migration 1730) REJOUÉE deux fois : réalisé connu / ouvert connu / indéterminé — aucune requalification silencieuse, aucune date touchée, aucun lien perdu', async () => {
    const c = await make.account({ plan: 'premium' });
    const bien = (await make.asset(c, { category: 'IMMOBILIER', name: 'Studio' })).id;
    const inserer = async (title: string, over: { date?: string | null; noDeadline?: boolean; situation?: string | null; source?: string | null } = {}) => {
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO agenda_items (account_id, title, start_date, no_deadline, situation, situation_source, origin_type)
        VALUES (${c.id}, ${title}, ${over.date ?? null}, ${over.noDeadline ?? false}, ${over.situation ?? null}, ${over.source ?? null}, 'manual') RETURNING id`;
      await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${id}, ${bien})`;
      return id;
    };
    const archive = async (id: number, statut: string, geste: boolean) => sql`
      INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json)
      VALUES (${id}, ${c.id}, 'LEGACY_STATUS_ARCHIVED', ${JSON.stringify({ manualStatus: statut, userGesture: geste, migration: '1526' })}::jsonb)`;

    const realiseUtilisateur = await inserer('Réalisé par l’utilisateur', { date: '2000-03-01' });
    await archive(realiseUtilisateur, 'realise', true);
    const realiseSansDate = await inserer('Réalisé par l’utilisateur, sans date');
    await archive(realiseSansDate, 'realise', true);
    const realiseSysteme = await inserer('Réalisé posé par le système', { date: '2000-03-01' });
    await archive(realiseSysteme, 'realise', false);
    const annule = await inserer('Ancien annulé', { date: '2000-03-01' });
    await archive(annule, 'annule', true);
    const sansEcheance = await inserer('Tâche sans échéance', { noDeadline: true });
    const futur = await inserer('Échéance future', { date: '2099-01-01' });
    const indetermine = await inserer('Sans date, intention inconnue');
    const passe = await inserer('Date passée, sans statut', { date: '2000-03-01' });
    const dejaQualifie = await inserer('Déjà qualifié par l’utilisateur', { situation: 'A_EU_LIEU', source: 'USER' });
    const ids = [realiseUtilisateur, realiseSansDate, realiseSysteme, annule, sansEcheance, futur, indetermine, passe, dejaQualifie];

    const etat = async () => sql<Array<{ id: number; situation: string | null; source: string | null; d: string | null; nd: boolean; liens: number }>>`
      SELECT i.id, i.situation, i.situation_source AS source, to_char(i.start_date, 'YYYY-MM-DD') AS d, i.no_deadline AS nd,
             (SELECT count(*)::int FROM agenda_asset_links l WHERE l.agenda_item_id = i.id) AS liens
        FROM agenda_items i WHERE i.id = ANY(${ids}) ORDER BY i.id`;
    const avant = await etat();
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/1730_l114v_agenda_situation.sql'), 'utf8');
    const rejouer = () => sql.begin(async (tx) => { await tx.unsafe(migration); });

    await rejouer();
    const apres = await etat();
    const par = new Map(apres.map((r) => [r.id, r]));
    expect(par.get(realiseUtilisateur)).toMatchObject({ situation: 'A_EU_LIEU', source: 'MIGRATION' });
    expect(par.get(realiseSansDate)).toMatchObject({ situation: 'A_EU_LIEU', source: 'MIGRATION', d: null });
    expect(par.get(sansEcheance)).toMatchObject({ situation: 'A_PREVOIR', source: 'MIGRATION' });
    expect(par.get(futur)).toMatchObject({ situation: 'A_PREVOIR', source: 'MIGRATION' });
    // Indéterminés : jamais reclassés arbitrairement (ni « tout sans-date → à prévoir », ni date passée → « a eu lieu »).
    for (const id of [realiseSysteme, annule, indetermine, passe]) expect(par.get(id)).toMatchObject({ situation: null, source: null });
    // Une décision de l'utilisateur n'est jamais réécrite par la reprise.
    expect(par.get(dejaQualifie)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER' });
    // Aucune date inventée ni modifiée, aucune option « Sans échéance » touchée, aucun lien perdu.
    expect(apres.map((r) => [r.id, r.d, r.nd, r.liens])).toEqual(avant.map((r) => [r.id, r.d, r.nd, r.liens]));

    // Rejouable : un second passage ne change rien ; une qualification posée entre-temps est conservée.
    await sql`UPDATE agenda_items SET situation = 'A_EU_LIEU', situation_source = 'USER' WHERE id = ${futur}`;
    await rejouer();
    const encore = await etat();
    expect(encore.find((r) => r.id === futur)).toMatchObject({ situation: 'A_EU_LIEU', source: 'USER' });
    expect(encore.filter((r) => r.id !== futur)).toEqual(apres.filter((r) => r.id !== futur));

    // L'indéterminé sans date relève de la carte de qualification ; les autres n'ouvrent rien.
    await balayage(c);
    expect((await cartes(indetermine)).map((x) => [x.open, x.question])).toEqual([[true, 'Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?']]);
    for (const id of [realiseSansDate, sansEcheance]) expect(await cartes(id)).toEqual([]);
  });
});
