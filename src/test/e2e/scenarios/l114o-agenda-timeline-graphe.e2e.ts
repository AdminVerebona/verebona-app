/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 ») — travaux C de la
 * carte « Agenda général et Timeline du bien » (CDC §12, §13, §17 ; AC23 à
 * AC31, AC35, AC38, AC40) — sur PostgreSQL 16 réel, par les chemins de
 * PRODUCTION : façade `operation-write.facade.ts` (lot B), vraies routes
 * `GET /api/agenda`, `GET /api/assets/:id/overview`, `GET /api/agenda/:id/liens`
 * et `GET /api/evenements-reference/:id` (seule la session est simulée).
 * Aucune IA. Dates fixes : aucun test ne dépend du jour.
 *
 *   L114OC-E01  SC-12, SC-13, AC24, AC25, AC31 : élément partagé par deux événements de référence — UNE occurrence dans
 *               l'Agenda et dans la Timeline détaillée, à SA date (2030), ses deux liens visibles ; dépliage de chacun des
 *               deux groupes en mode regroupé (même identité) ; aucun rappel, aucun élément créé par la lecture
 *   L114OC-E02  AC26, AC35 : événement de référence SANS élément d'agenda et SANS date — présent en mode regroupé, hors du
 *               flux daté, aucune date inventée, aucun élément fictif ; absent du mode détaillé et de l'Agenda
 *   L114OC-E03  AC30 : événement de référence multi-biens — une seule identité, éléments filtrés selon le bien affiché
 *   L114OC-E04  AC38 : pagination d'identités typées sur les MÊMES dates — ni omission, ni répétition, ni groupe coupé
 *   L114OC-E05  AC22 (partiel), AC23 : depuis le tiroir d'un élément d'Agenda, CHAQUE événement de référence est désigné et
 *               ouvrable ; sa fiche liste tous ses éléments réels à leur date ; fiche consultable sans élément d'agenda
 *   L114OC-E06  AC40 (Timeline) : le rôle « principal » ne change plus rien à la Timeline ; événement de référence invalidé →
 *               ses éléments redeviennent des lignes individuelles ; isolation des comptes
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
const grouping = () => import('@/services/business-operations/grouping/service');

scenario('L114OC', 'Opérations / Agenda CDC V2.0 — travaux C : Agenda général et Timeline du bien lisent le graphe canonique', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const S = (n: number) => String(n);
  const G = (op: number) => `op-${op}`;
  const ids = (l: Array<{ id: string }>) => l.map((x) => x.id);

  /** Événement de référence créé par le dépôt (avec sa source). */
  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; label?: string } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: 'REALIZED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114oc-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' }, reasonCode: 'L114OC_E2E',
    })).id);
  }
  const element = async (compte: AccountRow, title: string, date: string | null, assetIds: number[] = []): Promise<number> =>
    (await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}), assetIds })).id;
  async function lier(compte: AccountRow, operationId: number, agendaItemId: number): Promise<void> {
    const r = await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId });
    expect(r, `lien ${operationId} ↔ ${agendaItemId}`).toMatchObject({ status: 'APPLIED' });
  }
  async function overview(assetId: number, qs = ''): Promise<{ status: number; body: Page & Json }> {
    const route = await import('@/app/api/assets/[id]/overview/route');
    const r = await route.GET(new NextRequest(`http://x/api/assets/${assetId}/overview${qs}`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: r.status, body: await r.json() };
  }
  const timeline = async (assetId: number, mode: 'grouped' | 'detailed', limit = 100): Promise<Entry[]> => {
    const r = await overview(assetId, `?section=timeline&mode=${mode}&limit=${limit}`);
    expect(r.status).toBe(200);
    expect(r.body.timelinePage.nextCursor).toBeNull();
    return r.body.timeline;
  };
  async function toutesLesPages(assetId: number, mode: 'grouped' | 'detailed', limit: number): Promise<{ pages: Page[]; entries: Entry[] }> {
    const pages: Page[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 500; n++) {
      const r = await overview(assetId, `?section=timeline&mode=${mode}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      pages.push(r.body);
      cursor = r.body.timelinePage.nextCursor;
      if (!cursor) break;
    }
    return { pages, entries: pages.flatMap((p) => p.timeline) };
  }
  async function agenda(qs: string): Promise<Json[]> {
    const route = await import('@/app/api/agenda/route');
    const r = await route.GET(new NextRequest(`http://x/api/agenda${qs}`));
    expect(r.status).toBe(200);
    return (await r.json()).items as Json[];
  }
  async function tiroir(itemId: number): Promise<{ status: number; view: Json | null }> {
    const route = await import('@/app/api/agenda/[id]/liens/route');
    const r = await route.GET(new NextRequest(`http://x/api/agenda/${itemId}/liens`), { params: Promise.resolve({ id: String(itemId) }) });
    return { status: r.status, view: r.status === 200 ? (await r.json()).view as Json : null };
  }
  async function fiche(operationId: number): Promise<{ status: number; reference: Json | null }> {
    const route = await import('@/app/api/evenements-reference/[id]/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${operationId}`), { params: Promise.resolve({ id: String(operationId) }) });
    return { status: r.status, reference: r.status === 200 ? (await r.json()).reference as Json : null };
  }
  /** Empreinte de ce qu'une LECTURE ne doit jamais toucher : éléments d'Agenda, rappels, cartes, liens du graphe, événements de référence. */
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

  /** Jeu du CDC (SC-12, SC-13) : DPE de 2020, fin de validité en 2030 partagée avec la vente. */
  async function dpe() {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const diagnostic = await operation(compte, 'INTERVENTION', { realized: '2020-06-10', label: 'DPE' });
    const vente = await operation(compte, 'DISPOSAL', { label: 'Vente de la maison' });
    const realisation = await element(compte, 'Diagnostic de performance énergétique', '2020-06-10', [bien.id]);
    const expiration = await element(compte, 'Fin de validité du DPE', '2030-06-09', [bien.id]);
    const seul = await element(compte, 'Contrôle technique', '2025-02-01', [bien.id]);
    await lier(compte, diagnostic, realisation);
    await lier(compte, diagnostic, expiration);
    await lier(compte, vente, expiration);
    return { compte, bien, diagnostic, vente, realisation, expiration, seul };
  }

  it('L114OC-E01 — élément partagé : une occurrence dans l’Agenda et la Timeline détaillée, à sa date ; deux groupes en mode regroupé ; aucun rappel', async () => {
    const d = await dpe();
    asUser(d.compte);
    const avant = await empreinte(d.compte);

    // Agenda général (vraie route) : UN objet, à SA date (2030) — jamais replié en 2020, jamais doublé (AC24, AC25).
    const tous = await agenda('?period=all');
    expect(tous.filter((i) => i.id === d.expiration)).toHaveLength(1);
    expect(tous.find((i) => i.id === d.expiration)).toMatchObject({ title: 'Fin de validité du DPE', startDate: '2030-06-09' });
    expect(tous.map((i) => i.id).sort()).toEqual([d.realisation, d.expiration, d.seul].sort());

    // Timeline détaillée : chaque élément UNE fois, à sa date ; l'élément partagé porte ses DEUX événements de référence (AC31).
    const det = await timeline(d.bien.id, 'detailed');
    expect(ids(det)).toEqual([S(d.expiration), S(d.seul), S(d.realisation)]);
    expect(det.every((e) => e.kind === 'item' && e.itemType === 'agenda')).toBe(true);
    expect(det[0]).toMatchObject({ effectiveDate: '2030-06-09' });
    expect(det[0].operations).toEqual([
      { operationId: d.diagnostic, label: 'Intervention — DPE' },
      { operationId: d.vente, label: 'Cession — Vente de la maison' },
    ]);
    expect(det[1].operations).toEqual([]);
    expect(det[2].operations).toEqual([{ operationId: d.diagnostic, label: 'Intervention — DPE' }]);

    // Timeline regroupée : un groupe par événement de référence (identité propre), l'élément autonome en ligne individuelle.
    const reg = await timeline(d.bien.id, 'grouped');
    // Règle remplacée (carte #744, point F) : le repère d'un groupe est la date de présentation du CDC §11. La vente n'a
    // aucun fait daté propre : elle est « sans date » (en fin de liste) — la date de son élément d'agenda (2030) n'est
    // plus empruntée ; l'élément lui-même reste à SA date dans le dépliage, la Timeline détaillée et l'Agenda.
    expect(ids(reg)).toEqual([S(d.seul), G(d.diagnostic), G(d.vente)]);
    const gVente = reg[2];
    const gDiag = reg[1];
    expect(gVente).toMatchObject({ kind: 'group', itemType: 'operation', operationId: d.vente, title: 'Cession — Vente de la maison', effectiveDate: null, dateBasis: null });
    expect(gDiag).toMatchObject({ kind: 'group', itemType: 'operation', operationId: d.diagnostic, title: 'Intervention — DPE', effectiveDate: '2020-06-10', dateBasis: 'REALIZED' });
    // Le dépliage ne porte que des éléments réels, à LEUR date ; l'élément partagé figure dans chacun, avec la MÊME identité.
    expect(gVente.members!.map((m) => [m.id, m.effectiveDate])).toEqual([[S(d.expiration), '2030-06-09']]);
    expect(gDiag.members!.map((m) => [m.id, m.effectiveDate])).toEqual([[S(d.expiration), '2030-06-09'], [S(d.realisation), '2020-06-10']]);
    expect(gDiag.counters).toMatchObject({ events: 2 });
    expect(gVente.counters).toMatchObject({ events: 1 });
    expect(reg[0]).toMatchObject({ kind: 'item', itemType: 'agenda', title: 'Contrôle technique' });
    // Aucun texte affiché ne dit « Opération ».
    expect([...reg, ...det].map((e) => `${e.title} ${(e.operations ?? []).map((o) => o.label).join(' ')}`).join(' ')).not.toMatch(/op[ée]ration/i);

    // Lire n'écrit rien : aucun élément d'Agenda créé ou modifié, aucun rappel, aucune carte, aucun lien (AC24, §17).
    expect(await empreinte(d.compte)).toBe(avant);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${d.compte.id}`).toEqual([{ n: 3 }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${d.compte.id}`).toEqual([{ n: 0 }]);
  });

  it('L114OC-E02 — événement de référence sans élément d’agenda et sans date : présent en mode regroupé, hors du flux daté, rien d’inventé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const autreBien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    const f = await facade();
    const declare = await f.createOperation(
      { accountId: compte.id, actor: { kind: 'USER', userId: compte.ownerUserId, channel: 'ASSISTANT' } },
      { declaration: 'Je vais faire remplacer la chaudière de la maison', type: { code: 'INTERVENTION' }, status: 'ENVISAGED', label: 'Remplacement de la chaudière', assetIds: [bien.id] });
    expect(declare).toMatchObject({ status: 'APPLIED' });
    const sansDate = declare.data!.operationId;
    const date = await f.createOperation(user(compte),
      { declaration: 'J’ai fait refaire la toiture en mars 2023', type: { code: 'INTERVENTION' }, status: 'REALIZED', label: 'Réfection de la toiture', attributes: { realizedDate: '2023-03-14' }, assetIds: [bien.id] });
    expect(date).toMatchObject({ status: 'APPLIED' });
    const avecDate = date.data!.operationId;
    const ramonage = await element(compte, 'Ramonage', '2024-11-02', [bien.id]);
    const aPrevoir = await element(compte, 'Entretien de la pompe à chaleur', null, [bien.id]);
    asUser(compte);
    const avant = await empreinte(compte);

    const reg = await timeline(bien.id, 'grouped');
    // Flux daté d'abord ; « sans date » en dernier, l'événement de référence avant l'élément (tri stable).
    expect(ids(reg)).toEqual([S(ramonage), G(avecDate), G(sansDate), S(aPrevoir)]);
    expect(reg[1]).toMatchObject({ kind: 'group', title: 'Intervention — Réfection de la toiture', effectiveDate: '2023-03-14', dateBasis: 'REALIZED', members: [] });
    expect(reg[1].counters).toEqual({ events: 0, documents: 0, assets: 1, rooms: 0, equipments: 0 });
    // AC35 : aucune date affichée ni stockée à la place d'une date inconnue.
    expect(reg[2]).toMatchObject({ kind: 'group', operationId: sansDate, title: 'Intervention — Remplacement de la chaudière', effectiveDate: null, dateBasis: null, members: [] });
    expect(JSON.stringify(reg[2])).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // AC26 : aucun élément d'agenda fictif — ni en mode détaillé, ni dans l'Agenda, ni en base.
    expect(ids(await timeline(bien.id, 'detailed'))).toEqual([S(ramonage), S(aPrevoir)]);
    expect((await agenda('?period=all')).map((i) => i.id).sort()).toEqual([ramonage, aPrevoir].sort());
    expect(await sql<Json[]>`SELECT planned_date, start_date, realized_date, end_date FROM business_operations WHERE id = ${sansDate}`)
      .toEqual([{ planned_date: null, start_date: null, realized_date: null, end_date: null }]);
    expect(await empreinte(compte)).toBe(avant);
    // Aucun événement de référence sans bien n'est attribué à un bien : rien sur l'autre bien.
    expect(await timeline(autreBien.id, 'grouped')).toEqual([]);
    // La fiche reste consultable sans élément d'agenda (accès direct, sans « principal »).
    const fi = await fiche(sansDate);
    expect(fi.status).toBe(200);
    expect(fi.reference).toMatchObject({ id: sansDate, label: 'Intervention — Remplacement de la chaudière', agendaItemId: null, agendaItems: [] });
  });

  it('L114OC-E03 — événement de référence multi-biens : une seule identité, éléments filtrés selon le bien affiché', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    const sinistre = await operation(compte, 'CLAIM', { realized: '2025-01-05', label: 'Dégât des eaux' });
    const expertMaison = await element(compte, 'Visite de l’expert (maison)', '2025-01-20', [maison.id]);
    const pompage = await element(compte, 'Pompage du garage', '2025-01-06', [garage.id]);
    const commun = await element(compte, 'Déclaration à l’assureur', '2025-01-07', [maison.id, garage.id]);
    for (const i of [expertMaison, pompage, commun]) await lier(compte, sinistre, i);
    asUser(compte);

    const [gm] = await timeline(maison.id, 'grouped');
    const [gg] = await timeline(garage.id, 'grouped');
    expect(gm).toMatchObject({ kind: 'group', id: G(sinistre), operationId: sinistre, title: 'Sinistre — Dégât des eaux', effectiveDate: '2025-01-05' });
    expect(gg).toMatchObject({ kind: 'group', id: G(sinistre), operationId: sinistre, title: 'Sinistre — Dégât des eaux', effectiveDate: '2025-01-05' });
    expect(ids(gm.members!)).toEqual([S(expertMaison), S(commun)]);
    expect(ids(gg.members!)).toEqual([S(commun), S(pompage)]);
    // Le compteur décrit l'événement de référence entier (3 éléments réels), le dépliage le bien affiché.
    expect(gm.counters).toMatchObject({ events: 3 });
    expect(gg.counters).toMatchObject({ events: 3 });
    // Mode détaillé : chaque bien ne montre que SES éléments, une fois chacun.
    expect(ids(await timeline(maison.id, 'detailed'))).toEqual([S(expertMaison), S(commun)]);
    expect(ids(await timeline(garage.id, 'detailed'))).toEqual([S(commun), S(pompage)]);
  });

  it('L114OC-E04 — pagination d’identités typées sur les mêmes dates : ni omission, ni répétition, ni groupe coupé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement' });
    const JOUR = '2025-05-05';
    const seuls: number[] = [];
    const groupes = new Map<number, number[]>();
    // 6 éléments autonomes et 5 événements de référence TOUS à la même date ; 3 éléments et 2 événements de référence sans date.
    for (let k = 0; k < 6; k++) seuls.push(await element(compte, `Seul ${k}`, JOUR, [bien.id]));
    for (let k = 0; k < 3; k++) seuls.push(await element(compte, `Seul sans date ${k}`, null, [bien.id]));
    for (let k = 0; k < 5; k++) {
      const op = await operation(compte, 'INTERVENTION', { realized: JOUR, label: `Travaux ${k}` });
      const membres = [await element(compte, `Étape ${k}.a`, JOUR, [bien.id]), await element(compte, `Étape ${k}.b`, '2031-01-01', [bien.id]), await element(compte, `Étape ${k}.c`, null, [bien.id])];
      for (const m of membres) await lier(compte, op, m);
      groupes.set(op, membres);
    }
    for (let k = 0; k < 2; k++) {
      const op = await operation(compte, 'CONTRACT', { label: `Contrat ${k}` });
      const m = await element(compte, `Rendez-vous ${k}`, null, [bien.id]);
      await lier(compte, op, m);
      groupes.set(op, [m]);
    }
    asUser(compte);
    const attendu = [...[...groupes.keys()].map(G), ...seuls.map(S)].sort();
    let reference: string[] | null = null;
    for (const limit of [1, 2, 3, 4, 7, 100]) {
      const reg = await toutesLesPages(bien.id, 'grouped', limit);
      // Aucune omission, aucune répétition ; même ordre quelle que soit la taille de page (tri stable).
      expect(ids(reg.entries).slice().sort(), `limite ${limit}`).toEqual(attendu);
      expect(new Set(ids(reg.entries)).size).toBe(reg.entries.length);
      reference ??= ids(reg.entries);
      expect(ids(reg.entries), `ordre, limite ${limit}`).toEqual(reference);
      expect(reg.pages[0].timelinePage.remaining).toBe(attendu.length);
      // Aucun groupe coupé : chaque groupe porte TOUS ses éléments, où qu'il tombe dans les pages.
      for (const e of reg.entries.filter((x) => x.kind === 'group')) {
        expect(ids(e.members!).sort(), `groupe ${e.id}, limite ${limit}`).toEqual(groupes.get(e.operationId!)!.map(S).sort());
      }
      // Regroupée ∪ dépliages = détaillée = tous les éléments du bien, une fois chacun.
      const det = await toutesLesPages(bien.id, 'detailed', limit);
      const vus = reg.entries.flatMap((e) => (e.kind === 'group' ? ids(e.members!) : [e.id]));
      expect(vus.slice().sort()).toEqual(ids(det.entries).slice().sort());
      expect(new Set(ids(det.entries)).size).toBe(det.entries.length);
    }
    // À date égale : événements de référence d'abord, puis éléments ; « sans date » en fin de Timeline.
    const ordre = reference!;
    const datees = ordre.slice(0, 11);
    expect(datees.slice(0, 5).every((x) => x.startsWith('op-'))).toBe(true);
    expect(datees.slice(5).every((x) => !x.startsWith('op-'))).toBe(true);
    expect(ordre.slice(11, 13).every((x) => x.startsWith('op-'))).toBe(true);
    // Un curseur d'un mode n'est jamais accepté par l'autre.
    const c = (await overview(bien.id, '?section=timeline&mode=grouped&limit=2')).body.timelinePage.nextCursor!;
    expect((await overview(bien.id, `?section=timeline&mode=detailed&cursor=${encodeURIComponent(c)}`)).status).toBe(400);
  });

  it('L114OC-E05 — tiroir d’un élément d’Agenda : chaque événement de référence désigné et ouvrable ; fiche : tous les éléments réels à leur date', async () => {
    const d = await dpe();
    const autre = await make.account({ plan: 'premium' });
    asUser(d.compte);

    // Élément partagé : ses DEUX événements de référence, sans dépendre d'un « principal » (AC23).
    const partage = await tiroir(d.expiration);
    expect(partage.status).toBe(200);
    expect(partage.view!.referenceEvents).toEqual([
      { id: d.diagnostic, label: 'Intervention — DPE' },
      { id: d.vente, label: 'Cession — Vente de la maison' },
    ]);
    expect((await tiroir(d.realisation)).view!.referenceEvents).toEqual([{ id: d.diagnostic, label: 'Intervention — DPE' }]);
    // Élément autonome : aucun événement de référence, et ce n'est pas une anomalie (aucune carte « À traiter »).
    expect((await tiroir(d.seul)).view).toMatchObject({ role: 'NONE', referenceEvents: [] });
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${d.compte.id}`).toEqual([{ n: 0 }]);

    // Fiche de chaque événement de référence : TOUS ses éléments réels, chacun à SA date (2030 reste 2030).
    const fDiag = await fiche(d.diagnostic);
    expect(fDiag.reference).toMatchObject({ id: d.diagnostic, label: 'Intervention — DPE' });
    expect(fDiag.reference!.agendaItems).toEqual([
      { id: d.realisation, title: 'Diagnostic de performance énergétique', date: '2020-06-10' },
      { id: d.expiration, title: 'Fin de validité du DPE', date: '2030-06-09' },
    ]);
    const fVente = await fiche(d.vente);
    // L'élément n'est relié à la vente QUE par le graphe (pas par la colonne historique) : la fiche le voit.
    expect(fVente.reference!.agendaItems).toEqual([{ id: d.expiration, title: 'Fin de validité du DPE', date: '2030-06-09' }]);
    expect(fVente.reference!.agendaItemId).toBe(d.expiration);
    expect(await sql<Json[]>`SELECT business_operation_id::int AS op FROM agenda_items WHERE id = ${d.expiration}`).toEqual([{ op: d.diagnostic }]);

    // Isolation : un autre compte ne lit ni le tiroir, ni la fiche, ni la Timeline.
    asUser(autre);
    expect((await tiroir(d.expiration)).status).toBe(404);
    expect((await fiche(d.diagnostic)).status).toBe(404);
    expect((await overview(d.bien.id, '?section=timeline')).status).toBe(404);
    const { readAgendaItemsReferenceEvents } = await import('@/services/business-operations/graph/read');
    expect((await readAgendaItemsReferenceEvents(autre.id, [d.expiration, d.realisation])).size).toBe(0);
    expect((await readAgendaItemsReferenceEvents(d.compte.id, [])).size).toBe(0);
  });

  it('L114OC-E06 — le rôle « principal » ne change plus la Timeline ; événement de référence invalidé : éléments de nouveau individuels', async () => {
    const d = await dpe();
    asUser(d.compte);
    const regAvant = await timeline(d.bien.id, 'grouped');
    const detAvant = await timeline(d.bien.id, 'detailed');

    // AC40 (Timeline) : désigner puis changer l'élément « principal » (chemin historique de T4) ne change RIEN à la lecture.
    const g = await grouping();
    await g.withGroupingWrite(d.compte.id, (ctx) => g.designatePrincipal(ctx, { operationId: d.diagnostic, itemId: d.expiration, origin: 'T4', reasonCode: 'L114OC_E2E' }));
    // RÈGLE REMPLACÉE (carte #744, travaux F) : la désignation ne pose plus le rôle `operation_role = 'PRINCIPAL'`
    // (la colonne historique reste tenue à RELATED par son déclencheur) mais le FAIT PORTÉ par le lien N↔N.
    expect(await sql<Json[]>`SELECT operation_role AS role FROM agenda_items WHERE id = ${d.expiration}`).toEqual([{ role: 'RELATED' }]);
    expect(await sql<Json[]>`SELECT agenda_item_id AS item FROM business_operation_agenda_links
      WHERE operation_id = ${d.diagnostic} AND state = 'ACTIVE' AND fact_key IS NOT NULL`).toEqual([{ item: d.expiration }]);
    expect(await timeline(d.bien.id, 'grouped')).toEqual(regAvant);
    expect(await timeline(d.bien.id, 'detailed')).toEqual(detAvant);
    await g.withGroupingWrite(d.compte.id, (ctx) => g.designatePrincipal(ctx, { operationId: d.diagnostic, itemId: d.realisation, origin: 'T4', reasonCode: 'L114OC_E2E' }));
    expect(await timeline(d.bien.id, 'grouped')).toEqual(regAvant);

    // Événement de référence invalidé par l'utilisateur : plus de groupe ; ses éléments restent, à leur date.
    const inv = await (await facade()).invalidateOperation(user(d.compte), { operationId: d.vente });
    expect(inv).toMatchObject({ status: 'APPLIED' });
    const reg = await timeline(d.bien.id, 'grouped');
    expect(ids(reg)).toEqual([S(d.seul), G(d.diagnostic)]);
    expect(ids(reg[1].members!)).toEqual([S(d.expiration), S(d.realisation)]);
    const det = await timeline(d.bien.id, 'detailed');
    expect(ids(det)).toEqual([S(d.expiration), S(d.seul), S(d.realisation)]);
    expect(det[0].operations).toEqual([{ operationId: d.diagnostic, label: 'Intervention — DPE' }]);
    expect((await tiroir(d.expiration)).view!.referenceEvents).toEqual([{ id: d.diagnostic, label: 'Intervention — DPE' }]);
    // L'échéance de 2030 est toujours dans l'Agenda, une fois.
    expect((await agenda('?period=all')).filter((i) => i.id === d.expiration)).toHaveLength(1);

    // Le dernier événement de référence invalidé : tous les éléments redeviennent des lignes individuelles, rien n'est perdu.
    expect(await (await facade()).invalidateOperation(user(d.compte), { operationId: d.diagnostic })).toMatchObject({ status: 'APPLIED' });
    const fin = await timeline(d.bien.id, 'grouped');
    expect(fin.every((e) => e.kind === 'item')).toBe(true);
    expect(ids(fin)).toEqual([S(d.expiration), S(d.seul), S(d.realisation)]);
    expect((await fiche(d.diagnostic)).status).toBe(404);
  });
});
