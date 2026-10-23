/**
 * Lot 84C — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-4 :
 * Timeline d'un bien — PostgreSQL 16 réel, par la VRAIE route
 * `GET /api/assets/[id]/overview` (seule la session est simulée) et le
 * service unique de regroupement (82D) pour poser principaux et éléments liés.
 * Assertions limitées aux comptes créés ici ; date de référence injectée
 * (dates fixes en 2026 ; seuls les états « en retard » dépendent du jour réel
 * et ne sont pas vérifiés ici).
 *
 *   L84C-E01  AC22 : « regroupée » par défaut — principal daté = groupe, éléments liés masqués et portés par le groupe
 *   L84C-E02  AC23 : « détaillée » = toutes les lignes ; annulés exclus comme avant
 *   L84C-E03  AC24 : mode jamais mémorisé ; mode / curseur invalides refusés
 *   L84C-E04  AC25 / §13.5 : principal non daté, sans principal, principal annulé, principal hors du bien, Opération invalidée
 *   L84C-E05  AC26 : compteurs distincts (événements hors principal, documents, biens, pièces, équipements), objets du compte seulement
 *   L84C-E06  E10 : jeu > 1 page — un groupe n'est JAMAIS coupé ; regroupée ∪ éléments liés = détaillée ; ordre et curseur stables
 *   L84C-E07  isolation de compte : élément d'un autre compte lié à mon bien jamais lu ; bien d'un autre compte : 404
 *   L84C-E08  performance : jeu volumineux — requête bornée (LIMIT), indexée (aucun parcours séquentiel), plan vérifié
 *   L84C-E09  export de recette 82E : `calculs/timeline` = même fonction de lecture, vues complètes
 */
import { gunzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

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
interface Entry { kind: 'item' | 'group'; id: string; title: string; effectiveDate: string | null; members?: Entry[]; counters?: Json }
interface Page { timeline: Entry[]; timelinePage: { mode: string; nextCursor: string | null; remaining: number } }

const grouping = () => import('@/services/business-operations/grouping/service');

scenario('L84C', 'Opérations v5 — O-4 : Timeline regroupée / détaillée, regroupement avant pagination', ({ sql, make }) => {
  async function compteEtBien(nom = 'Maison'): Promise<{ compte: AccountRow & { owner: { id: number } }; bien: AssetRow }> {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: nom });
    return { compte, bien };
  }
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  async function overview(assetId: number, qs = ''): Promise<{ status: number; body: Page & Json }> {
    const route = await import('@/app/api/assets/[id]/overview/route');
    const r = await route.GET(new NextRequest(`http://x/api/assets/${assetId}/overview${qs}`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: r.status, body: await r.json() };
  }
  async function operation(compte: AccountRow): Promise<number> {
    const [o] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${compte.id}, 'REALIZED') RETURNING id::int`;
    return o.id;
  }
  async function element(compte: AccountRow, title: string, date: string | null, assetIds: number[], status: string | null = null): Promise<number> {
    const i = await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}), assetIds });
    if (status) await sql`UPDATE agenda_items SET manual_status = ${status} WHERE id = ${i.id}`;
    return i.id;
  }
  /** Rattachement par le service unique de regroupement (chemin de production). */
  async function rattacher(compte: AccountRow, operationId: number, itemId: number, principal = false): Promise<void> {
    const g = await grouping();
    await g.withGroupingWrite(compte.id, (ctx) => principal
      ? g.designatePrincipal(ctx, { operationId, itemId, origin: 'T4', reasonCode: 'L84C_E2E' })
      : g.attachAgendaItem(ctx, { operationId, itemId, role: 'RELATED', origin: 'T4', reasonCode: 'L84C_E2E' }));
  }
  async function toutesLesPages(assetId: number, mode: 'grouped' | 'detailed', limit: number): Promise<{ pages: Page[]; entries: Entry[] }> {
    const pages: Page[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 1000; n++) {
      const r = await overview(assetId, `?section=timeline&mode=${mode}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      pages.push(r.body);
      cursor = r.body.timelinePage.nextCursor;
      if (!cursor) break;
    }
    return { pages, entries: pages.flatMap((p) => p.timeline) };
  }
  const ids = (l: Array<{ id: string }>) => l.map((x) => x.id);
  /** Relation intercomptes HÉRITÉE (antérieure à la garde 0332, lot 53 D23) : écrite garde suspendue, comme L53B. */
  const heritee = (fn: (tx: typeof sql) => Promise<unknown>) => sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await fn(tx as unknown as typeof sql);
  });
  const S = (n: number) => String(n);

  /** Jeu « dégât des eaux » de l'exemple métier du CDC (§5). */
  async function degatDesEaux() {
    const { compte, bien } = await compteEtBien();
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    const controle = await element(compte, 'Contrôle chaudière', '2026-05-02', [bien.id]);
    const op = await operation(compte);
    const principal = await element(compte, 'Dégât des eaux', '2026-03-12', [bien.id]);
    const visite = await element(compte, 'Visite expert', '2026-03-21', [bien.id]);
    const reparation = await element(compte, 'Réparation plafond', '2026-04-18', [bien.id]);
    const relance = await element(compte, 'Relance assureur', null, [bien.id]);
    const annule = await element(compte, 'Rendez-vous annulé', '2026-03-25', [bien.id], 'annule');
    await rattacher(compte, op, principal, true);
    for (const i of [visite, reparation, relance, annule]) await rattacher(compte, op, i);
    return { compte, bien, garage, op, controle, principal, visite, reparation, relance, annule };
  }

  it('L84C-E01 — AC22 : « regroupée » par défaut ; principal daté = groupe dépliable ; éléments liés masqués de la liste', async () => {
    const d = await degatDesEaux();
    asUser(d.compte);
    const r = await overview(d.bien.id);
    expect(r.status).toBe(200);
    expect(r.body.timelinePage).toMatchObject({ mode: 'grouped', nextCursor: null, remaining: 2 });
    expect(ids(r.body.timeline)).toEqual([S(d.controle), S(d.principal)]);
    const g = r.body.timeline[1];
    expect(g).toMatchObject({ kind: 'group', title: 'Dégât des eaux', effectiveDate: '2026-03-12' });
    // Éléments liés présents sur la Timeline de ce bien, triés comme elle ; l'annulé n'apparaît nulle part.
    expect(ids(g.members!)).toEqual([S(d.reparation), S(d.visite), S(d.relance)]);
    expect(r.body.timeline[0]).toMatchObject({ kind: 'item', title: 'Contrôle chaudière' });
    expect(JSON.stringify(r.body.timeline)).not.toContain('Rendez-vous annulé');
    // Rien n'a été écrit pour la Timeline : aucune table propre (calcul de lecture).
    const [t] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name ILIKE '%timeline%'`;
    expect(t.n).toBe(0);
  });

  it('L84C-E02 — AC23 : « détaillée » = tous les éléments, individuellement ; annulés exclus', async () => {
    const d = await degatDesEaux();
    asUser(d.compte);
    const r = await overview(d.bien.id, '?section=timeline&mode=detailed');
    expect(r.status).toBe(200);
    expect(r.body.timelinePage).toMatchObject({ mode: 'detailed', remaining: 5 });
    expect(ids(r.body.timeline)).toEqual([S(d.controle), S(d.reparation), S(d.visite), S(d.principal), S(d.relance)]);
    expect(r.body.timeline.every((e) => e.kind === 'item')).toBe(true);
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id
       WHERE l.asset_id = ${d.bien.id} AND (i.manual_status IS NULL OR i.manual_status <> 'annule')`;
    expect(r.body.timeline).toHaveLength(n.n);
    // Champs historiques de la vue d'ensemble conservés au premier niveau.
    expect(r.body.timeline[0]).toMatchObject({ itemType: 'agenda', isDone: false, toConfirm: false });
  });

  it('L84C-E03 — AC24 : jamais mémorisé ; mode et curseur invalides refusés', async () => {
    const d = await degatDesEaux();
    asUser(d.compte);
    expect((await overview(d.bien.id, '?section=timeline&mode=detailed')).body.timelinePage.mode).toBe('detailed');
    // Nouvelle ouverture (sans mode) : de nouveau « regroupée ».
    const again = await overview(d.bien.id);
    expect(again.body.timelinePage.mode).toBe('grouped');
    expect(again.body.timeline.some((e) => e.kind === 'group')).toBe(true);
    expect((await overview(d.bien.id, '?mode=operations')).status).toBe(400);
    const det = await overview(d.bien.id, '?section=timeline&mode=detailed&limit=2');
    const c = det.body.timelinePage.nextCursor!;
    expect(c).toBeTruthy();
    expect((await overview(d.bien.id, `?section=timeline&mode=grouped&cursor=${encodeURIComponent(c)}`)).status).toBe(400);
    expect((await overview(d.bien.id, '?section=timeline&cursor=xyz')).status).toBe(400);
    // Aucune préférence écrite pour l'utilisateur ou le compte.
    // (`verebona_messages.timeline_events_json` : fil de l'assistant, sans rapport.)
    const [p] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%timeline%' AND table_name <> 'verebona_messages'`;
    expect(p.n).toBe(0);
  });

  it('L84C-E04 — AC25 / §13.5 / §13.6 : principal non daté, sans principal, principal annulé ou hors du bien, Opération invalidée → rien masqué', async () => {
    const { compte, bien } = await compteEtBien();
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    // Principal SANS date : ses éléments liés datés restent visibles à leur date ; il est placé avec les éléments sans date.
    const opVol = await operation(compte);
    const vol = await element(compte, 'Vol', null, [bien.id]);
    const plainte = await element(compte, 'Dépôt de plainte', '2026-02-01', [bien.id]);
    const serrure = await element(compte, 'Remplacement serrure', '2026-02-10', [bien.id]);
    await rattacher(compte, opVol, vol, true);
    await rattacher(compte, opVol, plainte);
    await rattacher(compte, opVol, serrure);
    // Sans principal (§13.5).
    const opSans = await operation(compte);
    const a1 = await element(compte, 'Étape A', '2026-01-10', [bien.id]);
    const a2 = await element(compte, 'Étape B', '2026-01-20', [bien.id]);
    await rattacher(compte, opSans, a1);
    await rattacher(compte, opSans, a2);
    // Principal ANNULÉ : exclu comme aujourd'hui → ses éléments liés ne sont pas masqués.
    const opAnn = await operation(compte);
    const pAnn = await element(compte, 'Panne', '2026-01-05', [bien.id]);
    const mAnn = await element(compte, 'Dépannage', '2026-01-06', [bien.id]);
    await rattacher(compte, opAnn, pAnn, true);
    await rattacher(compte, opAnn, mAnn);
    await sql`UPDATE agenda_items SET manual_status = 'annule' WHERE id = ${pAnn}`;
    // Principal lié à un AUTRE bien : sur ce bien, l'élément lié reste visible ; sur l'autre, groupe sans élément masqué.
    const opAilleurs = await operation(compte);
    const pAilleurs = await element(compte, 'Inondation garage', '2025-12-01', [garage.id]);
    const mAilleurs = await element(compte, 'Pompage', '2025-12-02', [bien.id]);
    await rattacher(compte, opAilleurs, pAilleurs, true);
    await rattacher(compte, opAilleurs, mAilleurs);
    // Opération INVALIDÉE : aucun regroupement.
    const opInv = await operation(compte);
    const pInv = await element(compte, 'Intervention', '2025-11-01', [bien.id]);
    const mInv = await element(compte, 'Suite intervention', '2025-11-02', [bien.id]);
    await rattacher(compte, opInv, pInv, true);
    await rattacher(compte, opInv, mInv);
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'L84C_E2E' WHERE id = ${opInv}`;

    asUser(compte);
    const g = await overview(bien.id);
    expect(g.body.timeline.every((e) => e.kind === 'item')).toBe(true);
    expect(ids(g.body.timeline)).toEqual([
      S(serrure), S(plainte), S(a2), S(a1), S(mAnn), S(mAilleurs), S(mInv), S(pInv), S(vol),
    ]);
    expect(g.body.timeline.at(-1)).toMatchObject({ title: 'Vol', effectiveDate: null, kind: 'item' });
    const autre = await overview(garage.id);
    expect(autre.body.timeline).toHaveLength(1);
    expect(autre.body.timeline[0]).toMatchObject({ kind: 'group', id: S(pAilleurs), members: [] });
    expect(autre.body.timeline[0].counters).toMatchObject({ events: 1 });
  });

  it('L84C-E05 — AC26 : compteurs distincts ; objets d\'un autre compte, supprimés ou annulés jamais comptés', async () => {
    const d = await degatDesEaux();
    const [cuisine] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${d.bien.id}, 'Cuisine') RETURNING id`;
    const [salon] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${d.bien.id}, 'Salon') RETURNING id`;
    const [chaudiere] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${d.bien.id}, 'Chaudière') RETURNING id`;
    const constat = await make.assetFile(d.compte, { assetId: d.bien.id, name: 'constat.pdf' });
    const rapport = await make.assetFile(d.compte, { assetId: d.bien.id, name: 'rapport.pdf' });
    const devis = await make.assetFile(d.compte, { assetId: d.bien.id, name: 'devis.pdf' });
    const supprime = await make.assetFile(d.compte, { assetId: d.bien.id, name: 'supprime.pdf' });
    const g = await grouping();
    await g.withGroupingWrite(d.compte.id, async (ctx) => {
      for (const f of [constat, rapport, supprime]) await g.attachDocument(ctx, { operationId: d.op, fileId: f.id, reasonCode: 'L84C_E2E' });
      await g.attachRoom(ctx, { operationId: d.op, substructureId: cuisine.id, origin: 'USER', reasonCode: 'L84C_E2E' });
      await g.attachEquipment(ctx, { operationId: d.op, equipmentId: chaudiere.id, origin: 'USER', reasonCode: 'L84C_E2E' });
      await g.attachAsset(ctx, { operationId: d.op, assetId: d.bien.id, origin: 'USER', reasonCode: 'L84C_E2E' });
      await g.attachAsset(ctx, { operationId: d.op, assetId: d.garage.id, origin: 'USER', reasonCode: 'L84C_E2E' });
    });
    // Liens directs du principal : un document précis, une autre Pièce, le bien (déjà compté).
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${d.principal}, ${devis.id}, ARRAY['MANUAL_DIRECT']) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${d.principal}, ${salon.id})`;
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${supprime.id}`;
    // Relation intercomptes héritée (lot 53 D23) : document d'un AUTRE compte lié au principal.
    const intrus = await compteEtBien('Intrus');
    const etranger = await make.assetFile(intrus.compte, { assetId: intrus.bien.id, name: 'etranger.pdf' });
    await heritee(async (tx) => {
      await tx`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${d.principal}, ${etranger.id}, ARRAY['MANUAL_DIRECT'])`;
      await tx`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${d.principal}, ${intrus.bien.id})`;
    });

    asUser(d.compte);
    const r = await overview(d.bien.id);
    const grp = r.body.timeline.find((e) => e.kind === 'group')!;
    // Événements liés HORS principal, annulé exclu ; documents = appartenance ∪ liens du principal (supprimé et étranger exclus).
    expect(grp.counters).toEqual({ events: 3, documents: 3, assets: 2, rooms: 2, equipments: 1 });
  });

  it('L84C-E06 — E10 : jeu > 1 page — un groupe n\'est jamais coupé ; regroupée ∪ éléments liés = détaillée', async () => {
    const { compte, bien } = await compteEtBien('Appartement');
    const tous: number[] = [];
    // 22 éléments seuls (dont 4 sans date) …
    for (let k = 0; k < 22; k++) tous.push(await element(compte, `Seul ${k}`, k < 18 ? `2026-${String(1 + (k % 12)).padStart(2, '0')}-${String(1 + k).padStart(2, '0')}` : null, [bien.id]));
    // … et 4 groupes dont les éléments liés sont dispersés dans le temps (avant / après le principal, sans date).
    const groupes = new Map<number, number[]>();
    for (let gi = 0; gi < 4; gi++) {
      const op = await operation(compte);
      const p = await element(compte, `Événement ${gi}`, `2026-0${gi + 3}-15`, [bien.id]);
      await rattacher(compte, op, p, true);
      const membres: number[] = [];
      for (const [j, date] of [`2025-0${gi + 1}-0${gi + 1}`, `2026-1${gi % 3}-2${gi}`, null, `2026-0${gi + 3}-15`].entries()) {
        const m = await element(compte, `Lié ${gi}.${j}`, date, [bien.id]);
        await rattacher(compte, op, m);
        membres.push(m);
      }
      groupes.set(p, membres);
      tous.push(p, ...membres);
    }
    asUser(compte);
    for (const limit of [3, 4, 5]) {
      const reg = await toutesLesPages(bien.id, 'grouped', limit);
      expect(reg.pages.length).toBeGreaterThan(1);
      expect(reg.pages[0].timelinePage.remaining).toBe(22 + 4);
      // Aucune entrée en double, aucun élément lié en entrée de premier niveau, chaque groupe complet une seule fois.
      expect(new Set(ids(reg.entries)).size).toBe(reg.entries.length);
      const vus: string[] = [];
      for (const e of reg.entries) {
        vus.push(e.id);
        if (e.kind === 'group') {
          expect(ids(e.members!).sort(), `groupe ${e.id} (limite ${limit})`).toEqual(groupes.get(Number(e.id))!.map(S).sort());
          vus.push(...ids(e.members!));
        }
      }
      expect(reg.entries.filter((e) => e.kind === 'group')).toHaveLength(4);
      const membresTous = [...groupes.values()].flat().map(S);
      expect(reg.entries.some((e) => membresTous.includes(e.id))).toBe(false);
      // Regroupée ∪ éléments liés = détaillée = tous les éléments du bien.
      const det = await toutesLesPages(bien.id, 'detailed', limit);
      expect(new Set(ids(det.entries)).size).toBe(det.entries.length);
      expect([...vus].sort()).toEqual(ids(det.entries).sort());
      expect(ids(det.entries).sort()).toEqual(tous.map(S).sort());
      // Ordre stable : date décroissante, sans date en dernier, puis identifiant décroissant.
      const cle = (e: Entry) => [e.effectiveDate ?? '0000-00-00', Number(e.id)] as const;
      for (const l of [reg.entries, det.entries]) {
        for (let k = 1; k < l.length; k++) {
          const [da, ia] = cle(l[k - 1]);
          const [db, ib] = cle(l[k]);
          expect(da > db || (da === db && ia > ib), `ordre ${l[k - 1].id} → ${l[k].id}`).toBe(true);
        }
      }
    }
    // Une page dont la dernière entrée est un groupe : ses éléments liés (dates d'autres pages) sont dans le groupe.
    const p1 = (await overview(bien.id, '?section=timeline&limit=50')).body.timeline;
    const posGroupe = p1.findIndex((e) => e.kind === 'group');
    const coupe = await overview(bien.id, `?section=timeline&limit=${posGroupe + 1}`);
    expect(coupe.body.timeline.at(-1)!.kind).toBe('group');
    expect(coupe.body.timeline.at(-1)!.members).toHaveLength(4);
  });

  it('L84C-E07 — isolation : élément d\'un autre compte lié à mon bien jamais lu ; bien d\'un autre compte : 404', async () => {
    const moi = await compteEtBien();
    const autre = await compteEtBien('Autre');
    const mien = await element(moi.compte, 'Mon entretien', '2026-02-02', [moi.bien.id]);
    const intrus = await element(autre.compte, 'Élément étranger', '2026-02-03', []);
    await heritee((tx) => tx`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${intrus}, ${moi.bien.id})`);
    asUser(moi.compte);
    for (const mode of ['grouped', 'detailed']) {
      const r = await overview(moi.bien.id, `?section=timeline&mode=${mode}`);
      expect(ids(r.body.timeline)).toEqual([S(mien)]);
    }
    asUser(autre.compte);
    expect((await overview(moi.bien.id)).status).toBe(404);
    expect((await overview(moi.bien.id, '?section=timeline&mode=detailed')).status).toBe(404);
  });

  it('L84C-E08 — performance : jeu volumineux — requête bornée et indexée, plan vérifié', async () => {
    const { compte, bien } = await compteEtBien('Gros bien');
    const bruit = await compteEtBien('Bruit');
    const autresBiens: number[] = [];
    for (let k = 0; k < 20; k++) autresBiens.push((await make.asset(bruit.compte, { category: 'IMMOBILIER', name: `Bruit ${k}` })).id);
    const voisin = await make.asset(compte, { category: 'IMMOBILIER', name: 'Voisin (même compte)' });
    const OPS = 300;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.grouping_write', 'on', true)`;
      const ops = await tx<{ id: number }[]>`
        INSERT INTO business_operations (account_id, status) SELECT ${compte.id}, 'REALIZED' FROM generate_series(1, ${OPS}) RETURNING id::int`;
      const opIds = ops.map((o) => o.id);
      // 300 groupes : principal daté + 4 éléments liés ; 1 500 éléments seuls (dont 10 % sans date).
      await tx`
        INSERT INTO agenda_items (account_id, title, start_date, business_operation_id, operation_role, operation_role_origin)
        SELECT ${compte.id}, 'G' || o.k || '.' || r.j,
               DATE '2020-01-01' + ((o.k * 7 + r.j * 13) % 2500)::int,
               o.id, CASE WHEN r.j = 0 THEN 'PRINCIPAL' ELSE 'RELATED' END, 'T4'
          FROM unnest(${opIds}::bigint[]) WITH ORDINALITY AS o(id, k), generate_series(0, 4) AS r(j)`;
      await tx`
        INSERT INTO agenda_items (account_id, title, start_date)
        SELECT ${compte.id}, 'Seul ' || k, CASE WHEN k % 10 = 0 THEN NULL ELSE DATE '2020-01-01' + (k * 3 % 2500)::int END
          FROM generate_series(1, 1500) AS k`;
      await tx`
        INSERT INTO agenda_asset_links (agenda_item_id, asset_id)
        SELECT id, ${bien.id} FROM agenda_items WHERE account_id = ${compte.id}`;
      await tx`INSERT INTO business_operations (account_id, status) SELECT ${bruit.compte.id}, 'REALIZED' FROM generate_series(1, 20000)`;
      // Même compte, autre bien : 5 000 éléments jamais lus pour « Gros bien ».
      await tx`
        WITH n AS (INSERT INTO agenda_items (account_id, title, start_date)
                   SELECT ${compte.id}, 'Voisin ' || k, DATE '2020-01-01' + (k % 2500)::int FROM generate_series(1, 5000) AS k RETURNING id)
        INSERT INTO agenda_asset_links (agenda_item_id, asset_id) SELECT id, ${voisin.id} FROM n`;
      // Bruit : 20 000 Opérations et 20 000 éléments d'un autre compte sur 20 autres biens.
      await tx`
        INSERT INTO agenda_items (account_id, title, start_date)
        SELECT ${bruit.compte.id}, 'Bruit ' || k, DATE '2020-01-01' + (k % 2500)::int FROM generate_series(1, 20000) AS k`;
      await tx`
        INSERT INTO agenda_asset_links (agenda_item_id, asset_id)
        SELECT i.id, (${autresBiens}::int[])[1 + (i.id % 20)] FROM agenda_items i WHERE i.account_id = ${bruit.compte.id}`;
    });
    await sql`ANALYZE agenda_items`;
    await sql`ANALYZE agenda_asset_links`;
    await sql`ANALYZE business_operations`;

    const { TIMELINE_PAGE_SQL, TIMELINE_MEMBERS_SQL, TIMELINE_COUNTERS_SQL } = await import('@/services/agenda/timeline/read');
    const plan = async (text: string, params: unknown[]) => {
      const [r] = await sql.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params as never[]);
      return (r as Json)['QUERY PLAN'][0] as Json;
    };
    const noeuds = (n: Json): Json[] => [n, ...((n.Plans as Json[] | undefined) ?? []).flatMap(noeuds)];
    const verifier = (p: Json, attendu: { indexOn?: string; borne?: number }) => {
      const tous = noeuds(p.Plan);
      const seq = tous.filter((n) => n['Node Type'] === 'Seq Scan').map((n) => n['Relation Name']);
      expect(seq.filter((t) => ['agenda_items', 'agenda_asset_links', 'business_operations', 'business_operation_documents',
        'agenda_file_links', 'asset_files', 'business_operation_asset_links', 'business_operation_room_links',
        'business_operation_equipment_links', 'agenda_room_links', 'agenda_equipment_links'].includes(t)), JSON.stringify(seq)).toEqual([]);
      if (attendu.indexOn) {
        // Index Scan / Index Only Scan / Bitmap Index Scan : le nom de l'index désigne sa table.
        expect(tous.some((n) => String(n['Index Name'] ?? '').startsWith(`${attendu.indexOn}_`)), `index sur ${attendu.indexOn}`).toBe(true);
      }
      if (attendu.borne !== undefined) {
        const lim = tous.find((n) => n['Node Type'] === 'Limit')!;
        expect(lim).toBeTruthy();
        expect(lim['Actual Rows']).toBeLessThanOrEqual(attendu.borne);
      }
      return tous;
    };

    const debut = Date.now();
    const p1 = await plan(TIMELINE_PAGE_SQL, [compte.id, bien.id, 'grouped', null, null, 13]);
    const tous = verifier(p1, { indexOn: 'agenda_asset_links', borne: 13 });
    // Le parcours du bien passe par l'index du bien (jamais par les 20 000 éléments du bruit).
    const parcours = tous.filter((n) => String(n['Index Name'] ?? '').startsWith('agenda_asset_links_'));
    expect(parcours.length).toBeGreaterThan(0);
    for (const n of parcours) {
      expect(String(n['Index Name'])).toMatch(/^agenda_asset_links_asset/);
      expect(Number(n['Actual Rows']) * Number(n['Actual Loops'] ?? 1)).toBeLessThanOrEqual(3000);
    }
    // Les éléments d'agenda sont lus par index (clé primaire ou compte), jamais en parcours complet ;
    // les Opérations par leur clé primaire, pour les seuls éléments rattachés.
    expect(tous.some((n) => String(n['Index Name'] ?? '').startsWith('agenda_items_'))).toBe(true);
    const ops = tous.filter((n) => n['Relation Name'] === 'business_operations');
    expect(ops.every((n) => /Index/.test(String(n['Node Type'])))).toBe(true);
    // Page suivante (curseur) et mode détaillé : mêmes garanties.
    verifier(await plan(TIMELINE_PAGE_SQL, [compte.id, bien.id, 'detailed', '2023-01-01', 999999999, 13]), { indexOn: 'agenda_asset_links', borne: 13 });
    // Groupes de la page : éléments liés et compteurs par les index menés par l'Opération.
    const page = await sql.unsafe(TIMELINE_PAGE_SQL, [compte.id, bien.id, 'grouped', '2024-06-01', 2_000_000_000, 13] as never[]);
    const heads = (page as Json[]).filter((r) => r.is_head);
    expect(heads.length).toBeGreaterThan(0);
    verifier(await plan(TIMELINE_MEMBERS_SQL, [compte.id, bien.id, heads.map((h) => Number(h.op)), heads.map((h) => Number(h.id))]), { indexOn: 'agenda_items' });
    verifier(await plan(TIMELINE_COUNTERS_SQL, [compte.id, heads.map((h) => Number(h.op)), heads.map((h) => Number(h.id))]), {});
    expect(Number(p1['Execution Time'])).toBeLessThan(2000);
    console.info(`[L84C-E08] page 1 regroupée : ${p1['Execution Time']} ms (3 000 éléments sur le bien, 5 000 sur un voisin, 20 000 + 20 000 Opérations de bruit)`);

    // Résultat : 300 groupes + 1 500 éléments seuls ; la route répond par pages bornées.
    asUser(compte);
    const r = await overview(bien.id, '?section=timeline&limit=100');
    expect(r.body.timeline).toHaveLength(100);
    expect(r.body.timelinePage.remaining).toBe(OPS + 1500);
    const det = await overview(bien.id, '?section=timeline&mode=detailed&limit=100');
    expect(det.body.timelinePage.remaining).toBe(OPS * 5 + 1500);
    expect(Date.now() - debut).toBeLessThan(30_000);
  });

  it('L84C-E09 — export de recette 82E : `calculs/timeline` calculé par la même fonction, vues complètes', async () => {
    const d = await degatDesEaux();
    const store = new Map<string, Buffer>();
    const uploads = new Map<string, { key: string; parts: Buffer[] }>();
    let n = 0;
    const client = {
      async send(c: { constructor: { name: string }; input: Record<string, any> }) {
        const i = c.input;
        switch (c.constructor.name) {
          case 'CreateMultipartUploadCommand': { const id = `u${++n}`; uploads.set(id, { key: i.Key, parts: [] }); return { UploadId: id }; }
          case 'UploadPartCommand': { uploads.get(i.UploadId)!.parts[i.PartNumber - 1] = Buffer.from(i.Body); return { ETag: `e${i.PartNumber}` }; }
          case 'CompleteMultipartUploadCommand': { const u = uploads.get(i.UploadId)!; store.set(i.Key, Buffer.concat(u.parts)); uploads.delete(i.UploadId); return {}; }
          case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
          case 'PutObjectCommand': store.set(i.Key, Buffer.from(i.Body)); return {};
          default: throw new Error(`commande S3 non simulée : ${c.constructor.name}`);
        }
      },
    };
    const { runRecetteExport, recettePrefix } = await import('@/services/admin/diagnostics-export/recette');
    const m = await runRecetteExport({ generationId: 'l84c-e09', adminUserId: null, today: '2026-06-01', storage: { client, bucket: 'b' } as never });
    const fichiers = m.files.filter((f) => f.path.startsWith('calculs/timeline'));
    expect(fichiers.length).toBeGreaterThan(0);
    for (const f of fichiers) expect(f).toMatchObject({ nature: 'calcul', domain: 'agenda-timeline', status: 'COMPLETE' });
    const lignes = fichiers.flatMap((f) => gunzipSync(store.get(`${recettePrefix('l84c-e09')}${f.path}`)!).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json));
    const ligne = lignes.find((l) => l.assetId === d.bien.id)!;
    expect(ligne).toMatchObject({ accountId: d.compte.id, today: '2026-06-01', entrees: { regroupee: 2, detaillee: 5 } });
    const { readAssetTimelineAll } = await import('@/services/agenda/timeline/read');
    expect(ligne.regroupee).toEqual(JSON.parse(JSON.stringify(await readAssetTimelineAll({ accountId: d.compte.id, assetId: d.bien.id, mode: 'grouped', today: '2026-06-01' }))));
    expect(ligne.detaillee).toEqual(JSON.parse(JSON.stringify(await readAssetTimelineAll({ accountId: d.compte.id, assetId: d.bien.id, mode: 'detailed', today: '2026-06-01' }))));
    expect(ligne.regroupee[1]).toMatchObject({ kind: 'group', id: S(d.principal) });
    const dict = JSON.parse(store.get(`${recettePrefix('l84c-e09')}dictionnaire.json`)!.toString('utf8')) as { computed: Json[] };
    expect(dict.computed.some((c) => c.path === 'calculs/timeline.part-NNNN.ndjson.gz')).toBe(true);
  });
});
