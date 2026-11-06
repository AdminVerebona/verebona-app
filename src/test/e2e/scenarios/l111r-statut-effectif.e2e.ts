/**
 * Lot 111R — statut effectif COMMUN Agenda / Timeline — PostgreSQL 16 réel.
 *
 * Cas d'origine (05/11/2026) : « Achat — Draisienne » du 04/04/2026, ticket
 * de caisse Decathlon associé : « Réalisé » dans le tiroir Agenda, « statut à
 * confirmer » sur la Timeline du bien.
 *
 * Chaînes de PRODUCTION : routes `/api/agenda/:id` (tiroir), `/api/agenda`
 * (liste), `/api/agenda/:id/statut` (statut manuel), `/api/assets/:id/overview`
 * (Timeline, modes Regroupée / Détaillée), `/api/assets/:id/followup` (suivi),
 * `/api/agenda/homepage` (accueil), `/api/documents/:id/agenda-liens`
 * (dissociation) ; contrôle COH-AGENDA-HISTORICAL-STATUS (pose de la preuve,
 * lot 103D) ; service de regroupement (groupe) ; lecture complète de l'export
 * de recette (`readAssetTimelineAll`) ; assistant (`getCanonicalAgendaItem`).
 * Seule la session est simulée. Aucun appel IA.
 *
 *   L111R-E01  recette 1 : achat prouvé sans statut manuel → « Réalisé » dans Agenda (tiroir, liste) ET Timeline (2 modes), suivi, export, T2
 *   L111R-E02  recette 2 : fait passé sans preuve → « Statut à confirmer » partout
 *   L111R-E03  recette 3 : échéance passée non faite → « Date échue » ; future → « À venir » (partout) ; accueil
 *   L111R-E04  recette 4 : statut manuel prioritaire (réalisé / annulé) ; annulé absent de la Timeline
 *   L111R-E05  recette 5 : preuve supprimée, puis preuve déliée → recalcul immédiat, sans état obsolète
 *   L111R-E06  recette 6 : groupe (tête prouvée) et membres, modes Regroupée / Détaillée
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
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

type Json = Record<string, any>;
type Compte = AccountRow & { owner: { id: number } };
const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const jour = (decalage: number) => { const d = new Date(); d.setDate(d.getDate() + decalage); return d.toISOString().slice(0, 10); };
const FUTUR = jour(400);
const ECHU = jour(-60);
const ACHAT = '2026-04-04';

scenario('L111R', 'Statut effectif commun Agenda / Timeline (preuve de réalisation)', ({ sql, make }) => {
  const as = (c: Compte) => { session.userId = c.owner.id; session.currentAccountId = c.id; };

  // ── Routes réelles ────────────────────────────────────────────────────────
  async function tiroir(id: number): Promise<Json> {
    const { GET } = await import('@/app/api/agenda/[id]/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda/${id}`), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(200);
    return (await res.json() as Json).item as Json;
  }
  async function liste(assetId: number): Promise<Map<number, Json>> {
    const { GET } = await import('@/app/api/agenda/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda?assetIds=${assetId}&includeCancelled=true`));
    expect(res.status).toBe(200);
    const items = (await res.json() as Json).items as Json[];
    return new Map(items.map((i) => [Number(i.id), i]));
  }
  async function statut(id: number, manualStatus: string | null) {
    const { PATCH } = await import('@/app/api/agenda/[id]/statut/route');
    const res = await PATCH(new NextRequest(`http://localhost/api/agenda/${id}/statut`, { method: 'PATCH', ...json({ manualStatus }) }), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(200);
  }
  async function timeline(assetId: number, mode: 'grouped' | 'detailed'): Promise<Json[]> {
    const route = await import('@/app/api/assets/[id]/overview/route');
    const res = await route.GET(new NextRequest(`http://localhost/api/assets/${assetId}/overview?section=timeline&mode=${mode}&limit=100`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(res.status).toBe(200);
    return (await res.json() as Json).timeline as Json[];
  }
  /** Statut de chaque élément de la Timeline (têtes ET membres), par identifiant. */
  const statutsTimeline = (entries: Json[]) => {
    const m = new Map<number, string>();
    for (const e of entries) {
      m.set(Number(e.id), e.effectiveStatus);
      for (const x of e.members ?? []) m.set(Number(x.id), x.effectiveStatus);
    }
    return m;
  };
  async function suivi(assetId: number): Promise<Map<number, Json>> {
    const route = await import('@/app/api/assets/[id]/followup/route');
    const res = await route.GET(new NextRequest(`http://localhost/api/assets/${assetId}/followup?includeDone=true&limit=100`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(res.status).toBe(200);
    return new Map(((await res.json() as Json).items as Json[]).map((i) => [Number(i.id), i]));
  }
  async function accueil(): Promise<number[]> {
    const { GET } = await import('@/app/api/agenda/homepage/route');
    const res = await GET(new NextRequest('http://localhost/api/agenda/homepage'));
    return ((await res.json() as Json).items as Json[]).map((i) => Number(i.id));
  }
  async function exportRecette(c: Compte, assetId: number) {
    const { readAssetTimelineAll } = await import('@/services/agenda/timeline/read');
    const today = new Date().toISOString().slice(0, 10);
    return {
      regroupee: statutsTimeline(await readAssetTimelineAll({ accountId: c.id, assetId, mode: 'grouped', today }) as never),
      detaillee: statutsTimeline(await readAssetTimelineAll({ accountId: c.id, assetId, mode: 'detailed', today }) as never),
    };
  }
  async function dissocier(fileId: number, itemId: number) {
    const { DELETE } = await import('@/app/api/documents/[id]/agenda-liens/route');
    const res = await DELETE(new NextRequest(`http://localhost/api/documents/${fileId}/agenda-liens?itemId=${itemId}`, { method: 'DELETE' }), { params: Promise.resolve({ id: String(fileId) }) });
    expect(res.status).toBe(200);
  }

  // ── Jeu de données ────────────────────────────────────────────────────────
  const ctxCoherence = () => ({ sql, now: new Date(), today: new Date().toISOString().slice(0, 10), mode: 'CORRECTIVE', correlationId: 'coherence:e2e:l111r' });

  async function element(c: Compte, bien: AssetRow, o: { title: string; date: string | null; nature: 'HISTORICAL' | 'DEADLINE'; type: string; manual?: string | null }) {
    const [i] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, event_nature, business_type, origin_type, manual_status)
      VALUES (${c.id}, ${o.title}, ${o.date}, true, ${o.nature}, ${o.type}, 'qualified_document', ${o.manual ?? null}) RETURNING id`;
    await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${i.id}, ${bien.id})`;
    return i.id;
  }
  async function ticket(c: Compte, bien: AssetRow, itemId: number, date: string) {
    const f = await make.assetFile(c, { assetId: bien.id });
    await sql`UPDATE asset_files SET document_type_code = 'TICKET_CAISSE', document_date = ${date}, retained_title = 'Ticket de caisse Decathlon' WHERE id = ${f.id}`;
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${itemId}, ${f.id}, ARRAY['AI_DIRECT']::text[])`;
    return f.id;
  }
  /** Preuve posée par le chemin de production (contrôle COH-AGENDA-HISTORICAL-STATUS, lot 103D). */
  async function prouver(c: Compte, itemIds: number[]) {
    const { agendaHistoricalStatusCheck: chk } = await import('@/services/coherence/registry/checks/agenda-historical-status');
    const ids = (await chk.listObjects!(ctxCoherence() as never, c.id, 0, 500)).filter((x: number) => itemIds.includes(x));
    const insp = await chk.inspect!(ctxCoherence() as never, c.id, ids);
    const aReparer = ids.filter((x: number) => insp.get(x)?.verdict === 'REPAIRABLE').map((x: number) => ({ id: x, inspection: insp.get(x)! }));
    expect(aReparer.map((x: { id: number }) => x.id).sort()).toEqual([...itemIds].sort());
    await chk.repair!(ctxCoherence() as never, c.id, aReparer);
  }

  async function draisienne() {
    const compte = await make.account({ plan: 'premium' }) as Compte;
    as(compte);
    const bien = await make.asset(compte, { name: 'Draisienne B’TWIN RUNRIDE 500' });
    const achat = await element(compte, bien, { title: 'Achat — Draisienne', date: ACHAT, nature: 'HISTORICAL', type: 'purchase' });
    const fichier = await ticket(compte, bien, achat, ACHAT);
    await prouver(compte, [achat]);
    return { compte, bien, achat, fichier };
  }

  /** Statut d'un élément vu par TOUS les lecteurs. */
  async function partout(c: Compte, bien: AssetRow, id: number) {
    const [t, l, g, d, s, e] = [await tiroir(id), await liste(bien.id), statutsTimeline(await timeline(bien.id, 'grouped')),
      statutsTimeline(await timeline(bien.id, 'detailed')), await suivi(bien.id), await exportRecette(c, bien.id)];
    return {
      tiroir: t.effectiveStatus, liste: l.get(id)?.effectiveStatus, regroupee: g.get(id) ?? 'absent', detaillee: d.get(id) ?? 'absent',
      suivi: s.get(id)?.effectiveStatus, exportRegroupee: e.regroupee.get(id) ?? 'absent', exportDetaillee: e.detaillee.get(id) ?? 'absent',
    };
  }
  const tous = (s: string) => ({ tiroir: s, liste: s, regroupee: s, detaillee: s, suivi: s, exportRegroupee: s, exportDetaillee: s });

  it('L111R-E01 — recette 1 : achat prouvé, sans statut manuel → « Réalisé » dans l’Agenda ET la Timeline (deux modes), suivi, export, T2', async () => {
    const d = await draisienne();
    const [brut] = await sql<{ manual_status: string | null; proof: number | null }[]>`SELECT manual_status, completion_proof_file_id AS proof FROM agenda_items WHERE id = ${d.achat}`;
    expect(brut).toEqual({ manual_status: null, proof: d.fichier });
    expect(await partout(d.compte, d.bien, d.achat)).toEqual(tous('realise'));
    const tl = (await timeline(d.bien.id, 'grouped')).find((e) => Number(e.id) === d.achat)!;
    expect(tl).toMatchObject({ isDone: true, toConfirm: false, isOverdue: false });
    const { getCanonicalAgendaItem } = await import('@/services/verebona-assistant/canonical/agenda');
    expect((await getCanonicalAgendaItem(d.compte.id, d.achat))?.status).toBe('completed');
  });

  it('L111R-E02 — recette 2 : fait passé sans preuve → « Statut à confirmer » partout', async () => {
    const d = await draisienne();
    const sansPreuve = await element(d.compte, d.bien, { title: 'Achat — Casque', date: ACHAT, nature: 'HISTORICAL', type: 'purchase' });
    expect(await partout(d.compte, d.bien, sansPreuve)).toEqual(tous('a_confirmer'));
    const tl = (await timeline(d.bien.id, 'detailed')).find((e) => Number(e.id) === sansPreuve)!;
    expect(tl).toMatchObject({ isDone: false, toConfirm: true, isOverdue: false });
  });

  it('L111R-E03 — recette 3 : échéance passée non faite → « Date échue » ; future → « À venir » ; accueil cohérent', async () => {
    const d = await draisienne();
    const echue = await element(d.compte, d.bien, { title: 'Révision freins', date: ECHU, nature: 'DEADLINE', type: 'maintenance' });
    const future = await element(d.compte, d.bien, { title: 'Révision annuelle', date: FUTUR, nature: 'DEADLINE', type: 'maintenance' });
    expect(await partout(d.compte, d.bien, echue)).toEqual(tous('en_retard'));
    expect(await partout(d.compte, d.bien, future)).toEqual(tous('a_venir'));
    const home = await accueil();
    expect(home).toContain(echue);
    expect(home).toContain(future);
    // Un fait historique (même prouvé) n'est jamais une échéance de l'accueil.
    expect(home).not.toContain(d.achat);
  });

  it('L111R-E04 — recette 4 : statut manuel prioritaire ; annulé absent de la Timeline', async () => {
    const d = await draisienne();
    const echue = await element(d.compte, d.bien, { title: 'Contrôle', date: ECHU, nature: 'DEADLINE', type: 'inspection' });
    await statut(echue, 'realise');
    expect(await partout(d.compte, d.bien, echue)).toEqual(tous('realise'));
    // Annulé malgré une preuve valide : le statut manuel prime ; absent de la Timeline (et de l'export).
    await statut(d.achat, 'annule');
    const p = await partout(d.compte, d.bien, d.achat);
    expect(p).toMatchObject({ tiroir: 'annule', liste: 'annule', regroupee: 'absent', detaillee: 'absent', exportRegroupee: 'absent', exportDetaillee: 'absent' });
    // Retour au calcul automatique (« Selon la date ») : la preuve redonne « Réalisé » partout.
    await statut(d.achat, null);
    expect(await partout(d.compte, d.bien, d.achat)).toEqual(tous('realise'));
  });

  it('L111R-E05 — recette 5 : preuve supprimée, puis preuve déliée → recalcul, sans état obsolète', async () => {
    const d = await draisienne();
    expect((await partout(d.compte, d.bien, d.achat)).regroupee).toBe('realise');
    // Document supprimé (suppression logique) : la preuve tombe à la lecture suivante.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${d.fichier}`;
    expect(await partout(d.compte, d.bien, d.achat)).toEqual(tous('a_confirmer'));
    // Autre achat prouvé, puis le document est DÉLIÉ de l'élément (route de production) : même recalcul.
    const autre = await element(d.compte, d.bien, { title: 'Achat — Selle', date: ACHAT, nature: 'HISTORICAL', type: 'purchase' });
    const f2 = await ticket(d.compte, d.bien, autre, ACHAT);
    await prouver(d.compte, [autre]);
    expect(await partout(d.compte, d.bien, autre)).toEqual(tous('realise'));
    await dissocier(f2, autre);
    expect((await sql`SELECT 1 FROM agenda_file_links WHERE agenda_item_id = ${autre} AND asset_file_id = ${f2}`).length).toBe(0);
    expect(await partout(d.compte, d.bien, autre)).toEqual(tous('a_confirmer'));
  });

  it('L111R-E06 — recette 6 : groupe dont la tête est prouvée, membres — modes Regroupée et Détaillée', async () => {
    const d = await draisienne();
    const accessoire = await element(d.compte, d.bien, { title: 'Achat — Béquille', date: ACHAT, nature: 'HISTORICAL', type: 'purchase' });
    const f = await ticket(d.compte, d.bien, accessoire, ACHAT);
    await prouver(d.compte, [accessoire]);
    const casque = await element(d.compte, d.bien, { title: 'Achat — Casque', date: ACHAT, nature: 'HISTORICAL', type: 'purchase' });
    const revision = await element(d.compte, d.bien, { title: 'Révision', date: ECHU, nature: 'DEADLINE', type: 'maintenance' });
    const [op] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${d.compte.id}, 'REALIZED') RETURNING id::int`;
    const g = await import('@/services/business-operations/grouping/service');
    await g.withGroupingWrite(d.compte.id, (ctx) => g.designatePrincipal(ctx, { operationId: op.id, itemId: d.achat, origin: 'T4', reasonCode: 'L111R_E2E' }));
    for (const id of [accessoire, casque, revision]) {
      await g.withGroupingWrite(d.compte.id, (ctx) => g.attachAgendaItem(ctx, { operationId: op.id, itemId: id, role: 'RELATED', origin: 'T4', reasonCode: 'L111R_E2E' }));
    }
    const regroupee = await timeline(d.bien.id, 'grouped');
    const groupe = regroupee.find((e) => e.kind === 'group')!;
    expect(groupe).toMatchObject({ id: String(d.achat), effectiveStatus: 'realise', isDone: true, toConfirm: false });
    expect(Object.fromEntries((groupe.members as Json[]).map((m) => [Number(m.id), m.effectiveStatus]))).toEqual({
      [accessoire]: 'realise', [casque]: 'a_confirmer', [revision]: 'en_retard',
    });
    const detaillee = statutsTimeline(await timeline(d.bien.id, 'detailed'));
    for (const [id, s] of [[d.achat, 'realise'], [accessoire, 'realise'], [casque, 'a_confirmer'], [revision, 'en_retard']] as const) {
      expect(detaillee.get(id), String(id)).toBe(s);
      expect((await tiroir(id)).effectiveStatus, String(id)).toBe(s);
    }
    // Preuve d'un MEMBRE supprimée : le membre est recalculé dans le groupe.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f}`;
    const apres = (await timeline(d.bien.id, 'grouped')).find((e) => e.kind === 'group')!;
    expect((apres.members as Json[]).find((m) => Number(m.id) === accessoire)?.effectiveStatus).toBe('a_confirmer');
  });
});
