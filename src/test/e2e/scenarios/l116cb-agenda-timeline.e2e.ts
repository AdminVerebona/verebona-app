/**
 * Lot 116C, seconde partie (carte Trello #806 §6 « Agenda général ≠ Timeline du
 * bien » ; CDC « Opérations / Agenda V2.0 » §12, §13 ; AC22 à AC31, AC35, AC38)
 * — sur PostgreSQL 16 réel, par les chemins de PRODUCTION : façade d'écriture
 * du graphe, vraies routes `GET /api/agenda`, `GET /api/assets/:id/overview`,
 * `GET /api/agenda/:id/liens`, `GET /api/evenements-reference/:id` (seule la
 * session est simulée). Aucune IA. Dates fixes : aucun test ne dépend du jour,
 * sauf les périodes « passé / à venir », bornées par des années lointaines.
 *
 *   L116CB-T01  ORDRE RÉEL : les faits de plusieurs opérations sont entrelacés à leurs dates (jamais regroupés par
 *               opération puis triés) — Timeline détaillée (dates des événements) et regroupée (date de présentation de
 *               chaque opération) ; sans date en dernier ; pagination sans omission ni répétition, quelle que soit la page
 *   L116CB-T02  FAIT LIÉ À PLUSIEURS OPÉRATIONS : dans la LISTE de l'Agenda, l'événement apparaît UNE fois et porte TOUTES
 *               ses opérations (jamais une seule) ; mêmes opérations, mêmes libellés que le tiroir, la Timeline détaillée
 *               et les fiches (une seule source : le graphe) ; opération retirée → retirée partout ; isolation ; lecture
 *               sans écriture
 *   L116CB-T03  COMPTEURS : des faits distincts — l'événement partagé est compté une fois dans l'Agenda et sur le bien,
 *               une fois par opération dans le compteur de chacune ; « restant » = entrées réellement servies
 *   L116CB-T04  SANS DATE : jamais dans le passé quand il est « à prévoir », jamais à venir quand il « a eu lieu » ; jamais
 *               daté ; hors du flux daté de la Timeline (en dernier, sans repère inventé) ; exclu des vues par année
 *   L116CB-T05  FILTRES : bien, équipement, pièce, document, période, année — chaque résultat est un sous-ensemble de
 *               l'Agenda, sans doublon, avec les opérations de chaque événement ; filtres combinés = intersection
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
interface Entry {
  kind: 'item' | 'group'; itemType: string; id: string; title: string; effectiveDate: string | null;
  operationId?: number; dateBasis?: string | null; members?: Entry[]; counters?: Json; operations?: Array<{ operationId: number; label: string }>;
}
interface Page { timeline: Entry[]; timelinePage: { mode: string; nextCursor: string | null; remaining: number } }

const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L116CB-T', 'Carte #806 §6 — Agenda général et Timeline du bien : ordre réel, opérations multiples, compteurs, sans date, filtres', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const S = (n: number) => String(n);
  const G = (op: number) => `op-${op}`;
  const ids = (l: Array<{ id: string }>) => l.map((x) => x.id);

  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; label?: string } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: 'REALIZED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l116cb-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' }, reasonCode: 'L116CB_E2E',
    })).id);
  }
  const element = async (compte: AccountRow, title: string, date: string | null, assetIds: number[] = [], situation: 'A_PREVOIR' | 'A_EU_LIEU' | null = null): Promise<number> => {
    const { id } = await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}), assetIds });
    if (situation) await sql`UPDATE agenda_items SET situation = ${situation}, situation_source = 'USER' WHERE id = ${id}`;
    return id;
  };
  async function lier(compte: AccountRow, operationId: number, agendaItemId: number): Promise<void> {
    const r = await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId });
    expect(r, `lien ${operationId} ↔ ${agendaItemId}`).toMatchObject({ status: 'APPLIED' });
  }
  async function overview(assetId: number, qs = ''): Promise<{ status: number; body: Page & Json }> {
    const route = await import('@/app/api/assets/[id]/overview/route');
    const r = await route.GET(new NextRequest(`http://x/api/assets/${assetId}/overview${qs}`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: r.status, body: await r.json() };
  }
  const timeline = async (assetId: number, mode: 'grouped' | 'detailed'): Promise<Entry[]> => {
    const r = await overview(assetId, `?section=timeline&mode=${mode}&limit=100`);
    expect(r.status).toBe(200);
    expect(r.body.timelinePage.nextCursor).toBeNull();
    return r.body.timeline;
  };
  async function toutesLesPages(assetId: number, mode: 'grouped' | 'detailed', limit: number): Promise<{ pages: Page[]; entries: Entry[] }> {
    const pages: Page[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 200; n++) {
      const r = await overview(assetId, `?section=timeline&mode=${mode}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      pages.push(r.body);
      cursor = r.body.timelinePage.nextCursor;
      if (!cursor) break;
    }
    return { pages, entries: pages.flatMap((p) => p.timeline) };
  }
  async function agenda(qs = ''): Promise<Json[]> {
    const route = await import('@/app/api/agenda/route');
    const r = await route.GET(new NextRequest(`http://x/api/agenda${qs}`));
    expect(r.status).toBe(200);
    return (await r.json()).items as Json[];
  }
  async function tiroir(itemId: number): Promise<Json> {
    const route = await import('@/app/api/agenda/[id]/liens/route');
    const r = await route.GET(new NextRequest(`http://x/api/agenda/${itemId}/liens`), { params: Promise.resolve({ id: String(itemId) }) });
    expect(r.status).toBe(200);
    return (await r.json()).view as Json;
  }
  async function fiche(operationId: number): Promise<Json> {
    const route = await import('@/app/api/evenements-reference/[id]/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${operationId}`), { params: Promise.resolve({ id: String(operationId) }) });
    expect(r.status).toBe(200);
    return (await r.json()).reference as Json;
  }
  /** Ce qu'une LECTURE ne doit jamais toucher. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_agenda_links t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM to_process_actions t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }
  const refs = (i: Json): number[] => ((i.referenceEvents ?? []) as Array<{ id: number }>).map((r) => r.id);

  /** Deux opérations dont les faits s'entrelacent dans le temps, un événement autonome, des faits sans date. */
  async function entrelace() {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    // L'opération A est créée AVANT B (identifiant plus petit) mais ses faits sont plus anciens ET plus récents que ceux de B.
    const A = await operation(compte, 'INTERVENTION', { realized: '2022-05-10', label: 'Toiture' });
    const B = await operation(compte, 'INTERVENTION', { realized: '2024-01-15', label: 'Chaudière' });
    const C = await operation(compte, 'INTERVENTION', { label: 'Façade' });
    for (const op of [A, B, C]) await lierBien(compte, op, bien.id);
    const a1 = await element(compte, 'Toiture — devis', '2021-03-01', [bien.id]);
    const b1 = await element(compte, 'Chaudière — visite', '2022-07-07', [bien.id]);
    const seul = await element(compte, 'Contrôle technique', '2023-01-01', [bien.id]);
    const a2 = await element(compte, 'Toiture — réception', '2023-09-09', [bien.id]);
    const b2 = await element(compte, 'Chaudière — entretien', '2025-02-02', [bien.id]);
    const sansDate = await element(compte, 'Ramonage à prévoir', null, [bien.id], 'A_PREVOIR');
    for (const [op, i] of [[A, a1], [A, a2], [B, b1], [B, b2]] as const) await lier(compte, op, i);
    return { compte, bien, A, B, C, a1, a2, b1, b2, seul, sansDate };
  }
  /** Opération reliée à un bien (lien actif, même forme que celui posé par la consolidation). */
  const lierBien = async (compte: AccountRow, operationId: number, assetId: number): Promise<void> => {
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, authority, active)
              VALUES (${compte.id}, ${operationId}, ${assetId}, 'USER', true)`;
  };

  it('L116CB-T01 — ordre réel : les faits de plusieurs opérations sont entrelacés à leurs dates ; sans date en dernier ; pagination stable', async () => {
    const d = await entrelace();
    asUser(d.compte);

    // Détaillée : chaque événement à SA date, toutes opérations confondues (jamais « A puis B »).
    const detail = await timeline(d.bien.id, 'detailed');
    expect(ids(detail)).toEqual([S(d.b2), S(d.a2), S(d.seul), S(d.b1), S(d.a1), S(d.sansDate)]);
    expect(detail.map((e) => e.effectiveDate)).toEqual(['2025-02-02', '2023-09-09', '2023-01-01', '2022-07-07', '2021-03-01', null]);
    // Un tri « par opération puis par date » aurait rendu a2, a1, b2, b1 : ce n'est pas l'ordre servi.
    expect(ids(detail).slice(0, 5)).not.toEqual([S(d.a2), S(d.a1), S(d.b2), S(d.b1), S(d.seul)]);

    // Regroupée : chaque opération à SA date de présentation, entrelacée avec l'événement autonome ; sans date en dernier
    // (opération sans date, puis événement sans date) — aucun repère inventé.
    const groupe = await timeline(d.bien.id, 'grouped');
    expect(ids(groupe)).toEqual([G(d.B), S(d.seul), G(d.A), G(d.C), S(d.sansDate)]);
    expect(groupe.map((e) => e.effectiveDate)).toEqual(['2024-01-15', '2023-01-01', '2022-05-10', null, null]);
    expect(groupe.map((e) => e.dateBasis ?? null)).toEqual(['REALIZED', null, 'REALIZED', null, null]);
    // Les événements d'une opération, dans son dépliage, sont à LEUR date et dans l'ordre de la Timeline.
    expect(ids(groupe[0].members!)).toEqual([S(d.b2), S(d.b1)]);
    expect(ids(groupe[2].members!)).toEqual([S(d.a2), S(d.a1)]);
    expect(groupe[3].members).toEqual([]);

    // Pagination : quelle que soit la taille de page, la suite des pages EST l'ordre complet (ni omission, ni répétition).
    for (const mode of ['detailed', 'grouped'] as const) {
      const complet = ids(mode === 'detailed' ? detail : groupe);
      for (const limite of [1, 2, 3, 4]) {
        const { pages, entries } = await toutesLesPages(d.bien.id, mode, limite);
        expect(ids(entries), `${mode} / page de ${limite}`).toEqual(complet);
        expect(new Set(ids(entries)).size).toBe(complet.length);
        expect(pages[0].timelinePage.remaining).toBe(complet.length);
        expect(pages.every((p) => p.timeline.length <= limite)).toBe(true);
      }
    }

    // L'Agenda général garde chaque événement à sa date réelle (aucune ligne d'opération, aucun regroupement imposé).
    const liste = await agenda(`?assetIds=${d.bien.id}`);
    expect(liste.map((i) => i.id).sort((x, y) => x - y)).toEqual([d.a1, d.b1, d.seul, d.a2, d.b2, d.sansDate].sort((x, y) => x - y));
    expect(Object.fromEntries(liste.map((i) => [i.id, i.startDate]))).toEqual({
      [d.a1]: '2021-03-01', [d.b1]: '2022-07-07', [d.seul]: '2023-01-01', [d.a2]: '2023-09-09', [d.b2]: '2025-02-02', [d.sansDate]: null,
    });
  });

  it('L116CB-T02 — un événement lié à plusieurs opérations les porte TOUTES dans la liste de l’Agenda ; même source que le tiroir, la Timeline et les fiches', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const diagnostic = await operation(compte, 'INTERVENTION', { realized: '2020-06-10', label: 'DPE' });
    const vente = await operation(compte, 'DISPOSAL', { label: 'Vente de la maison' });
    const partage = await element(compte, 'Fin de validité du DPE', '2030-06-09', [bien.id]);
    const propre = await element(compte, 'Diagnostic de performance énergétique', '2020-06-10', [bien.id]);
    const seul = await element(compte, 'Contrôle technique', '2025-02-01', [bien.id]);
    await lier(compte, diagnostic, partage);
    await lier(compte, vente, partage);
    await lier(compte, diagnostic, propre);
    asUser(compte);
    const avant = await empreinte(compte);

    const liste = await agenda();
    // Une seule occurrence de l'événement partagé, à sa date ; ses DEUX opérations, jamais une seule.
    expect(liste.filter((i) => i.id === partage)).toHaveLength(1);
    const ligne = liste.find((i) => i.id === partage)!;
    expect(ligne.startDate).toBe('2030-06-09');
    expect(refs(ligne)).toEqual([diagnostic, vente].sort((x, y) => x - y));
    expect(refs(liste.find((i) => i.id === propre)!)).toEqual([diagnostic]);
    // Événement autonome : liste vide (ce n'est pas une anomalie), jamais une opération d'office.
    expect(liste.find((i) => i.id === seul)!.referenceEvents).toEqual([]);

    // MÊME SOURCE DE VÉRITÉ : tiroir de l'événement, Timeline détaillée et liste de l'Agenda nomment les mêmes opérations.
    const vue = await tiroir(partage);
    expect(vue.referenceEvents).toEqual(ligne.referenceEvents);
    const detail = await timeline(bien.id, 'detailed');
    expect(detail.find((e) => e.id === S(partage))!.operations).toEqual(
      (ligne.referenceEvents as Array<{ id: number; label: string }>).map((r) => ({ operationId: r.id, label: r.label })));
    expect(detail.filter((e) => e.id === S(partage))).toHaveLength(1);
    // … et la fiche de CHACUNE des deux opérations liste l'événement, à sa date.
    for (const op of [diagnostic, vente]) {
      const f = await fiche(op);
      const evenements = (f.agendaItems ?? f.items ?? f.events ?? []) as Array<{ id: number; startDate?: string | null }>;
      expect(evenements.map((e) => Number(e.id)), `fiche ${op}`).toContain(partage);
    }
    // Lecture seule : rien n'a été écrit (ni élément, ni rappel, ni carte, ni lien, ni opération).
    expect(await empreinte(compte)).toBe(avant);

    // Opération retirée (invalidée) : elle disparaît de la liste comme du tiroir ; l'événement reste, à sa date.
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'L116CB_E2E' WHERE id = ${vente} AND account_id = ${compte.id}`;
    const apres = (await agenda()).find((i) => i.id === partage)!;
    expect(refs(apres)).toEqual([diagnostic]);
    expect(apres.startDate).toBe('2030-06-09');
    expect(((await tiroir(partage)).referenceEvents as Array<{ id: number }>).map((r) => r.id)).toEqual([diagnostic]);

    // Isolation : un autre compte ne lit ni l'événement ni ses opérations, même en donnant les identifiants.
    const autre = await make.account({ plan: 'premium' });
    asUser(autre);
    expect(await agenda()).toEqual([]);
    const { attachReferenceEvents } = await import('@/services/agenda/agenda-reference-events');
    const forges = await attachReferenceEvents(autre.id, [ligne as never]);
    expect(forges[0].referenceEvents).toEqual([]);
  });

  it('L116CB-T03 — compteurs : des faits distincts, même quand la présentation est condensée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const A = await operation(compte, 'INTERVENTION', { realized: '2022-05-10', label: 'Toiture' });
    const B = await operation(compte, 'CLAIM', { realized: '2022-06-01', label: 'Dégât des eaux' });
    const partage = await element(compte, 'Passage de l’expert', '2022-06-15', [bien.id]);
    const a1 = await element(compte, 'Devis', '2022-04-01', [bien.id]);
    const seul = await element(compte, 'Contrôle', '2021-01-01', [bien.id]);
    for (const [op, i] of [[A, partage], [B, partage], [A, a1]] as const) await lier(compte, op, i);
    asUser(compte);

    // Agenda : trois faits distincts (l'événement partagé une fois), quel que soit le nombre de ses opérations.
    const liste = await agenda();
    expect(liste).toHaveLength(3);
    expect(new Set(liste.map((i) => i.id)).size).toBe(3);

    // Bien : compteur d'événements = faits distincts du bien ; la vue regroupée condense (2 opérations + 1 événement
    // autonome = 3 entrées) sans changer ce compte.
    const vue = await overview(bien.id);
    expect(vue.status).toBe(200);
    expect(vue.body.counters.agenda).toBe(3);
    expect(vue.body.timelinePage.remaining).toBe(3);
    const groupes = vue.body.timeline.filter((e) => e.kind === 'group');
    expect(groupes).toHaveLength(2);
    // Compteur de chaque opération : SES événements réels, distincts (l'événement partagé compte une fois dans chacune).
    expect(Object.fromEntries(groupes.map((g) => [g.operationId, g.counters!.events]))).toEqual({ [A]: 2, [B]: 1 });
    for (const g of groupes) expect(new Set(ids(g.members!)).size).toBe(g.members!.length);
    // Détaillée : les mêmes trois faits, une fois chacun.
    const detail = await timeline(bien.id, 'detailed');
    expect(ids(detail).sort()).toEqual([S(partage), S(a1), S(seul)].sort());
    expect((await overview(bien.id, '?section=timeline&mode=detailed')).body.timelinePage.remaining).toBe(3);
  });

  it('L116CB-T04 — sans date : jamais compté comme passé quand il est à prévoir, jamais daté, hors du flux daté', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const ancien = await element(compte, 'Ravalement', '2001-04-04', [bien.id]);
    const futur = await element(compte, 'Fin de garantie', '2099-01-01', [bien.id]);
    const aPrevoir = await element(compte, 'Ramonage à prévoir', null, [bien.id], 'A_PREVOIR');
    const aEuLieu = await element(compte, 'Ancienne vidange', null, [bien.id], 'A_EU_LIEU');
    const nonQualifie = await element(compte, 'Élément hérité', null, [bien.id]);
    asUser(compte);
    const idsDe = async (qs: string) => (await agenda(qs)).map((i) => i.id as number).sort((x, y) => x - y);
    const tri = (...l: number[]) => [...l].sort((x, y) => x - y);

    // Période « passé » : l'événement « à prévoir » sans date n'y figure JAMAIS.
    const passe = await idsDe('?period=past');
    expect(passe).not.toContain(aPrevoir);
    expect(passe).toEqual(tri(ancien, aEuLieu, nonQualifie));
    // Période « à venir » : l'événement qui « a eu lieu » sans date n'y figure JAMAIS.
    const aVenir = await idsDe('?period=upcoming');
    expect(aVenir).not.toContain(aEuLieu);
    expect(aVenir).toEqual(tri(futur, aPrevoir, nonQualifie));
    // Sans les « sans date » : seuls les faits datés, donc un vrai décompte des passés et des à-venir.
    expect(await idsDe('?period=past&includeUndated=false')).toEqual([ancien]);
    expect(await idsDe('?period=upcoming&includeUndated=false')).toEqual([futur]);
    // Par année : un fait sans date n'appartient à aucune année.
    expect(await idsDe('?year=2001')).toEqual([ancien]);
    // Jamais daté : aucune date n'est fabriquée pour un événement sans date, dans aucune période.
    for (const qs of ['', '?period=past', '?period=upcoming']) {
      for (const i of await agenda(qs)) if ([aPrevoir, aEuLieu, nonQualifie].includes(i.id)) expect(i.startDate, `${qs} ${i.id}`).toBeNull();
    }

    // Timeline : les sans-date sont hors du flux daté, en dernier, sans repère.
    const detail = await timeline(bien.id, 'detailed');
    expect(ids(detail).slice(0, 2)).toEqual([S(futur), S(ancien)]);
    expect(ids(detail).slice(2).sort()).toEqual([S(aPrevoir), S(aEuLieu), S(nonQualifie)].sort());
    expect(detail.slice(2).every((e) => e.effectiveDate === null)).toBe(true);
    // Une opération sans fait daté reste « sans date » même si elle porte des événements datés (aucun repli sur leur date).
    const op = await operation(compte, 'INTERVENTION', { label: 'Sans date propre' });
    await lier(compte, op, ancien);
    const groupe = await timeline(bien.id, 'grouped');
    const tete = groupe.find((e) => e.id === G(op))!;
    expect(tete.effectiveDate).toBeNull();
    expect(tete.dateBasis ?? null).toBeNull();
    expect(ids(groupe)[0]).toBe(S(futur));
    expect(groupe.findIndex((e) => e.id === G(op))).toBeGreaterThan(groupe.findIndex((e) => e.id === S(futur)));
    expect(ids(tete.members!)).toEqual([S(ancien)]);
    expect(tete.members![0].effectiveDate).toBe('2001-04-04');
  });

  it('L116CB-T05 — filtres : bien, équipement, pièce, document, période, année — sous-ensembles cohérents, sans doublon, opérations jointes', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Voiture' });
    const [chaudiere] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Chaudière') RETURNING id`;
    const [cuisine] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${maison.id}, 'Cuisine') RETURNING id`;
    const facture = await make.assetFile(compte, { assetId: maison.id });
    const op = await operation(compte, 'INTERVENTION', { realized: '2010-03-03', label: 'Entretien chaudière' });
    const autreOp = await operation(compte, 'CLAIM', { realized: '2010-03-01', label: 'Sinistre' });

    const eEquip = await element(compte, 'Entretien annuel', '2010-03-03', [maison.id]);
    await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${eEquip}, ${chaudiere.id})`;
    const ePiece = await element(compte, 'Peinture', '2011-05-05', [maison.id]);
    await sql`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${ePiece}, ${cuisine.id})`;
    const eDoc = await element(compte, 'Paiement', '2010-04-01', [maison.id]);
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${eDoc}, ${facture.id}, ARRAY['MANUAL_DIRECT'])`;
    const eVoiture = await element(compte, 'Contrôle technique', '2099-06-06', [voiture.id]);
    const eSansBien = await element(compte, 'Rendez-vous', '2010-07-07');
    for (const [o, i] of [[op, eEquip], [autreOp, eEquip], [op, eDoc]] as const) await lier(compte, o, i);
    asUser(compte);

    const tout = await agenda();
    const tousIds = new Set(tout.map((i) => i.id as number));
    expect(tousIds).toEqual(new Set([eEquip, ePiece, eDoc, eVoiture, eSansBien]));
    const attendu: Record<string, number[]> = {
      [`?assetIds=${maison.id}`]: [eEquip, ePiece, eDoc],
      [`?assetIds=${voiture.id}`]: [eVoiture],
      [`?assetIds=${maison.id},${voiture.id}`]: [eEquip, ePiece, eDoc, eVoiture],
      [`?assetIds=${maison.id}&equipment=${chaudiere.id}`]: [eEquip],
      [`?assetIds=${maison.id}&piece=${cuisine.id}`]: [ePiece],
      [`?fileId=${facture.id}`]: [eDoc],
      ['?year=2010']: [eEquip, eDoc, eSansBien],
      ['?period=upcoming']: [eVoiture],
      [`?assetIds=${maison.id}&year=2010`]: [eEquip, eDoc],
      // Intersection : la chaudière (maison) n'a aucun événement à venir.
      [`?assetIds=${maison.id}&equipment=${chaudiere.id}&period=upcoming`]: [],
      [`?assetIds=${maison.id}&equipment=${chaudiere.id}&period=past`]: [eEquip],
    };
    const parId = new Map(tout.map((i) => [i.id as number, i]));
    for (const [qs, voulus] of Object.entries(attendu)) {
      const r = await agenda(qs);
      const trouves = r.map((i) => i.id as number);
      expect([...trouves].sort((x, y) => x - y), qs).toEqual([...voulus].sort((x, y) => x - y));
      // Jamais de doublon (l'événement partagé par deux opérations reste UNE ligne), toujours un sous-ensemble.
      expect(new Set(trouves).size, qs).toBe(trouves.length);
      expect(trouves.every((id) => tousIds.has(id)), qs).toBe(true);
      // Un filtre ne change ni la date ni les opérations d'un événement : mêmes valeurs que dans l'Agenda complet.
      for (const i of r) {
        expect(i.startDate, qs).toBe(parId.get(i.id)!.startDate);
        expect(i.referenceEvents, qs).toEqual(parId.get(i.id)!.referenceEvents);
      }
    }
    expect(refs(parId.get(eEquip)!)).toEqual([op, autreOp].sort((x, y) => x - y));
    expect(refs(parId.get(eDoc)!)).toEqual([op]);
    expect(parId.get(eSansBien)!.referenceEvents).toEqual([]);
    // La facette Équipement (« Mon agenda ») porte les mêmes éléments, avec leurs opérations.
    const route = await import('@/app/api/agenda/route');
    const f = await (await route.GET(new NextRequest(`http://x/api/agenda?assetIds=${maison.id}&equipmentFacet=1`))).json() as Json;
    expect((f.items as Json[]).map((i) => i.id).sort((x: number, y: number) => x - y)).toEqual([eEquip, ePiece, eDoc].sort((x, y) => x - y));
    expect(refs((f.items as Json[]).find((i) => i.id === eEquip)!)).toEqual([op, autreOp].sort((x, y) => x - y));
    // Une opération sans bien n'est attribuée à aucun bien : la Timeline de la voiture ne la montre pas.
    expect((await timeline(voiture.id, 'grouped')).some((e) => e.kind === 'group')).toBe(false);
  });
});
