/**
 * Lot 85D — corrections : écritures permises à tort en lecture seule ; fin des
 * routes `/api/events` héritées — PostgreSQL 16 réel.
 *
 * Chaînes de PRODUCTION : route handlers réels (garde `refuserSiLectureSeule`
 * → `getEntitlements` en base → `restrictedRefusal`), service Agenda, service
 * unique de regroupement (`linkDocumentToAgendaItem` via la route du tiroir),
 * client de la fenêtre « Ajouter un document »
 * (`linkUploadedDocumentsToAgendaItem`) branché sur la route réelle. Seule la
 * session est simulée. Aucun appel IA. Assertions limitées aux comptes créés ici.
 *
 *   L85D-E01  routes d'agenda en lecture seule (sans abonnement, essai échu, impayé, résilié, rétractation) :
 *             DELETE /api/agenda/:id, PATCH /api/agenda/:id/statut, PATCH /api/agenda/conflicts/:id → 403,
 *             message utilisateur existant, RIEN n'est écrit ; la consultation reste permise
 *   L85D-E02  compte actif : suppression et statut inchangés (non-régression)
 *   L85D-E03  autres routes corrigées par l'audit (échantillon) : lien web, document, fournisseur,
 *             suppression d'un document / d'un bien, échéance historique, reclassement → 403 sans écriture
 *   L85D-E04  « Ajouter un document » depuis un événement : document créé (lien web, puis fichier déposé),
 *             relié à l'événement (lien précis) ET à son ensemble, propagé à l'événement de référence (AC01, AC05)
 *   L85D-E05  « Ajouter un document » depuis un élément seul : l'ensemble est créé (AC01) ; lien rejoué sans doublon
 *   L85D-E06  routes « events » retirées : aucun module, aucune référence dans le code de production
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
type Etat = 'sans-abonnement' | 'essai-echu' | 'impaye' | 'resilie' | 'retractation';
const ETATS: readonly Etat[] = ['sans-abonnement', 'essai-echu', 'impaye', 'resilie', 'retractation'];
const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

scenario('L85D', 'Lecture seule (routes d’écriture) et « Ajouter un document » par l’Agenda', ({ sql, make }) => {
  const as = (c: Compte) => { session.userId = c.owner.id; session.currentAccountId = c.id; };

  async function compte(etat: Etat | 'actif'): Promise<{ compte: Compte; maison: AssetRow }> {
    const c = await make.account({ plan: etat === 'actif' ? 'premium' : null }) as Compte;
    switch (etat) {
      case 'essai-echu':
        await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${c.id}, 'premium', 'trialing', now() - interval '2 days')`;
        break;
      case 'impaye':
        await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, first_billed_at) VALUES (${c.id}, 'premium', 'past_due', now() - interval '40 days')`;
        break;
      case 'resilie':
        await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, first_billed_at) VALUES (${c.id}, 'premium', 'canceled', now() - interval '40 days')`;
        break;
      case 'retractation':
        await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, first_billed_at) VALUES (${c.id}, 'premium', 'readonly', now() - interval '3 days')`;
        await sql`UPDATE accounts SET subscription_status = 'WITHDRAWN' WHERE id = ${c.id}`;
        break;
      default:
        break;
    }
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    as(c);
    return { compte: c, maison };
  }
  /** Motif attendu : celui de la garde commune (message utilisateur existant). */
  async function refusAttendu(c: Compte) {
    const { getEntitlements, restrictedRefusal } = await import('@/services/entitlements.service');
    const e = await getEntitlements(c.id);
    expect(e.canWrite).toBe(false);
    return restrictedRefusal(c.id, e.status);
  }

  // ── Routes réelles ────────────────────────────────────────────────────────
  async function supprimer(itemId: number) {
    const { DELETE } = await import('@/app/api/agenda/[id]/route');
    const res = await DELETE(new NextRequest(`http://localhost/api/agenda/${itemId}`, { method: 'DELETE' }), params({ id: String(itemId) }));
    return { status: res.status, body: await res.json() as Json };
  }
  async function statut(itemId: number, manualStatus: string | null) {
    const { PATCH } = await import('@/app/api/agenda/[id]/statut/route');
    const res = await PATCH(new NextRequest(`http://localhost/api/agenda/${itemId}/statut`, { method: 'PATCH', ...json({ manualStatus }) }), params({ id: String(itemId) }));
    return { status: res.status, body: await res.json() as Json };
  }
  async function conflit(conflictId: number) {
    const { PATCH } = await import('@/app/api/agenda/conflicts/[id]/route');
    const res = await PATCH(new NextRequest(`http://localhost/api/agenda/conflicts/${conflictId}`, { method: 'PATCH', ...json({ decision: 'kept_existing' }) }), params({ id: String(conflictId) }));
    return { status: res.status, body: await res.json() as Json };
  }
  async function lire(itemId: number) {
    const { GET } = await import('@/app/api/agenda/[id]/route');
    return (await GET(new NextRequest(`http://localhost/api/agenda/${itemId}`), params({ id: String(itemId) }))).status;
  }
  async function geste(itemId: number, action: string, targetId?: number) {
    const { POST } = await import('@/app/api/agenda/[id]/liens/route');
    const res = await POST(new NextRequest(`http://localhost/api/agenda/${itemId}/liens`, { method: 'POST', ...json({ action, targetId: targetId ?? null }) }), params({ id: String(itemId) }));
    return { status: res.status, body: await res.json() as Json };
  }
  async function lienWeb(c: { maison: AssetRow }, title: string) {
    const { POST } = await import('@/app/api/web-links/route');
    const res = await POST(new NextRequest('http://localhost/api/web-links', { method: 'POST', ...json({ url: 'https://exemple.fr/devis', title, documentType: 'DEVIS', assetId: c.maison.id }) }));
    return { status: res.status, body: await res.json() as Json };
  }
  /** Client RÉEL de la fenêtre d'ajout, branché sur la route réelle du tiroir (au lieu de `fetchDepot`). */
  async function relierCommeLaFenetre(itemId: number, fileIds: number[]) {
    const { linkUploadedDocumentsToAgendaItem, agendaLinkUrl } = await import('@/lib/agenda/document-agenda-link-client');
    const { POST } = await import('@/app/api/documents/[id]/agenda-liens/route');
    const urls: string[] = [];
    const r = await linkUploadedDocumentsToAgendaItem(itemId, fileIds, async (url, body) => {
      urls.push(url);
      const fileId = Number(/\/api\/documents\/(\d+)\/agenda-liens$/.exec(url)![1]);
      const res = await POST(new NextRequest(`http://localhost${url}`, { method: 'POST', ...json(body) }), params({ id: String(fileId) }));
      return { ok: res.ok, status: res.status };
    });
    expect(urls).toEqual(fileIds.map(agendaLinkUrl));
    return r;
  }

  // ── Lectures ──────────────────────────────────────────────────────────────
  const empreinte = async (c: AccountRow) => ({
    items: await sql`SELECT * FROM agenda_items WHERE account_id = ${c.id} ORDER BY id`,
    liens: await sql`SELECT l.* FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${c.id} ORDER BY l.agenda_item_id, l.asset_file_id`,
    biens: await sql`SELECT l.* FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${c.id} ORDER BY l.agenda_item_id, l.asset_id`,
    conflits: await sql`SELECT * FROM agenda_data_conflicts WHERE account_id = ${c.id} ORDER BY id`,
    fichiers: await sql`SELECT id, deleted_at, asset_id, document_type, retained_title FROM asset_files WHERE account_id = ${c.id} ORDER BY id`,
    assets: await sql`SELECT id, name, status, deleted_at FROM assets WHERE account_id = ${c.id} ORDER BY id`,
    ops: await sql`SELECT id, version FROM business_operations WHERE account_id = ${c.id} ORDER BY id`,
    fournisseurs: await sql`SELECT id FROM suppliers WHERE account_id = ${c.id} ORDER BY id`,
    echeances: await sql`SELECT id FROM deadlines WHERE account_id = ${c.id} ORDER BY id`,
  });
  const element = async (id: number) => (await sql<Json[]>`
    SELECT business_operation_id::int AS op, operation_role AS role FROM agenda_items WHERE id = ${id}`)[0];
  const liensDe = (itemId: number) => sql<{ file: number; prov: string[] }[]>`
    SELECT asset_file_id AS file, provenances AS prov FROM agenda_file_links WHERE agenda_item_id = ${itemId} ORDER BY asset_file_id`;
  const membres = (opId: number) => sql<{ file_id: number }[]>`
    SELECT file_id FROM business_operation_documents WHERE operation_id = ${opId} AND active ORDER BY file_id`;

  // ══ Lecture seule ═════════════════════════════════════════════════════════

  it.each(ETATS)('L85D-E01 — %s : suppression, statut et arbitrage d’un conflit refusés (403, message habituel), rien n’est écrit ; la consultation reste permise', async (etat) => {
    const c = await compte(etat);
    const item = await make.agendaItem(c.compte, { title: 'Entretien chaudière', startDate: '2026-11-04', assetIds: [c.maison.id] });
    const [cf] = await sql<{ id: number }[]>`
      INSERT INTO agenda_data_conflicts (account_id, agenda_item_id, conflict_type, source_type_a, value_date_a, source_type_b, value_date_b)
      VALUES (${c.compte.id}, ${item.id}, 'date_mismatch', 'DOCUMENT', '2026-11-04', 'USER', '2026-11-05') RETURNING id`;
    const attendu = await refusAttendu(c.compte);
    const avant = await empreinte(c.compte);

    for (const [nom, r] of [
      ['DELETE /api/agenda/:id', await supprimer(item.id)],
      ['PATCH /api/agenda/:id/statut (réalisé)', await statut(item.id, 'realise')],
      ['PATCH /api/agenda/:id/statut (annulé)', await statut(item.id, 'annule')],
      ['PATCH /api/agenda/conflicts/:id', await conflit(cf.id)],
    ] as const) {
      expect(r.status, nom).toBe(403);
      expect(r.body, nom).toEqual(attendu);
    }
    if (etat === 'retractation') expect(attendu.message).toMatch(/droit de rétractation/);
    if (etat === 'essai-echu') expect(attendu.code).toBe('TRIAL_EXPIRED');
    expect(await empreinte(c.compte)).toEqual(avant);
    expect(await lire(item.id)).toBe(200);
  });

  it('L85D-E02 — compte actif : suppression et changement de statut inchangés', async () => {
    const c = await compte('actif');
    const item = await make.agendaItem(c.compte, { title: 'Contrôle technique', startDate: '2026-11-04' });
    const s = await statut(item.id, 'realise');
    expect(s.status).toBe(200);
    expect((await sql`SELECT manual_status FROM agenda_items WHERE id = ${item.id}`)[0]).toEqual({ manual_status: 'realise' });
    expect((await supprimer(item.id)).status).toBe(200);
    expect(await lire(item.id)).toBe(404);
  });

  it('L85D-E03 — autres écritures corrigées par l’audit : refusées (403, message habituel) sans écriture', async () => {
    const c = await compte('impaye');
    const doc = await make.assetFile(c.compte, { assetId: c.maison.id });
    const attendu = await refusAttendu(c.compte);
    const avant = await empreinte(c.compte);
    const req = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : json(body)) });

    const appels: Array<[string, () => Promise<Response>]> = [
      ['POST /api/web-links', async () => (await import('@/app/api/web-links/route')).POST(req('/api/web-links', 'POST', { url: 'https://exemple.fr', title: 'Notice', assetId: c.maison.id }))],
      ['PUT /api/documents/:id', async () => (await import('@/app/api/documents/[id]/route')).PUT(req(`/api/documents/${doc.id}`, 'PUT', { fileName: 'x.pdf', documentType: 'FACTURE' }), params({ id: String(doc.id) }))],
      ['POST /api/documents/bulk-delete', async () => (await import('@/app/api/documents/bulk-delete/route')).POST(req('/api/documents/bulk-delete', 'POST', { documentIds: [doc.id] }))],
      ['DELETE /api/files/:id', async () => (await import('@/app/api/files/[id]/route')).DELETE(req(`/api/files/${doc.id}`, 'DELETE'), params({ id: String(doc.id) }) as never)],
      ['DELETE /api/assets', async () => (await import('@/app/api/assets/route')).DELETE(req(`/api/assets?id=${c.maison.id}`, 'DELETE'))],
      ['PATCH /api/assets', async () => (await import('@/app/api/assets/route')).PATCH(req(`/api/assets?id=${c.maison.id}`, 'PATCH', { name: 'Renommée' }))],
      ['POST /api/suppliers', async () => (await import('@/app/api/suppliers/route')).POST(req('/api/suppliers', 'POST', { name: 'Plombier Martin' }))],
      ['POST /api/deadlines', async () => (await import('@/app/api/deadlines/route')).POST(req('/api/deadlines', 'POST', { assetId: c.maison.id, label: 'Assurance', deadlineDate: '2026-12-01' }))],
    ];
    for (const [nom, appel] of appels) {
      const res = await appel();
      expect(res.status, nom).toBe(403);
      expect(await res.json(), nom).toEqual(attendu);
    }
    expect(await empreinte(c.compte)).toEqual(avant);
  });

  // ══ « Ajouter un document » par l'Agenda ══════════════════════════════════

  it('L85D-E04 — « Ajouter un document » depuis un événement : document créé, relié à l’événement et à son ensemble, propagé à l’événement de référence', async () => {
    const c = await compte('actif');
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12', assetIds: [c.maison.id] });
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21', assetIds: [c.maison.id] });
    // Ensemble existant : visite rattachée, dégât des eaux désigné événement de référence (gestes réels du tiroir, 84B).
    expect((await geste(degat.id, 'relier-element', visite.id)).status).toBe(200);
    expect((await geste(degat.id, 'designer-reference')).status).toBe(200);
    const op = (await element(visite.id)).op as number;
    expect(op).toBeGreaterThan(0);
    expect(await element(degat.id)).toEqual({ op, role: 'PRINCIPAL' });

    // 1. Lien web (fenêtre, mode « Lien web ») depuis la visite.
    const lw = await lienWeb(c, 'Devis plombier');
    expect(lw.status).toBe(201);
    const devisId = lw.body.webLink.id as number;
    expect(await relierCommeLaFenetre(visite.id, [devisId])).toEqual({ linked: [devisId], failed: [] });
    // 2. Fichier(s) déposé(s) (file globale : presign / confirm — simulés par la fabrique), même élément.
    const photo = await make.assetFile(c.compte, { assetId: c.maison.id });
    const rapport = await make.assetFile(c.compte, { assetId: c.maison.id });
    expect(await relierCommeLaFenetre(visite.id, [photo.id, rapport.id])).toEqual({ linked: [photo.id, rapport.id], failed: [] });

    const tous = [devisId, photo.id, rapport.id].sort((a, b) => a - b);
    // Relié à l'événement (lien précis conservé) …
    expect(await liensDe(visite.id)).toEqual(tous.map((f) => ({ file: f, prov: ['MANUAL_DIRECT'] })));
    // … et à son ensemble (même regroupement, rien de créé en plus) …
    expect((await element(visite.id)).op).toBe(op);
    expect((await membres(op)).map((m) => m.file_id)).toEqual(tous);
    expect((await sql`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${c.compte.id} AND merged_into_operation_id IS NULL AND invalidated_at IS NULL`)[0]).toEqual({ n: 1 });
    // … propagé à l'événement de référence (AC05).
    expect(await liensDe(degat.id)).toEqual(tous.map((f) => ({ file: f, prov: ['OPERATION_PRINCIPAL'] })));
    // Vue du DocumentDrawer : lien précis vers la visite, lien par l'ensemble vers l'événement de référence.
    const { GET } = await import('@/app/api/documents/[id]/agenda-liens/route');
    const vue = await (await GET(new NextRequest(`http://localhost/api/documents/${devisId}/agenda-liens`), params({ id: String(devisId) }))).json() as Json;
    expect(vue.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: visite.id, direct: true }),
      expect.objectContaining({ itemId: degat.id, isMain: true, viaGroup: true }),
    ]));
    // Document bien créé, au bon bien, sans doublon.
    expect((await sql`SELECT asset_id, is_web_link, web_link_title FROM asset_files WHERE id = ${devisId}`)[0]).toEqual({ asset_id: c.maison.id, is_web_link: true, web_link_title: 'Devis plombier' });
  });

  it('L85D-E05 — « Ajouter un document » depuis un élément seul : l’ensemble est créé (AC01) ; rejoué, rien ne change', async () => {
    const c = await compte('actif');
    const seul = await make.agendaItem(c.compte, { title: 'Ramonage', startDate: '2026-10-02', assetIds: [c.maison.id] });
    const facture = await make.assetFile(c.compte, { assetId: c.maison.id });
    expect(await relierCommeLaFenetre(seul.id, [facture.id])).toEqual({ linked: [facture.id], failed: [] });
    const op = (await element(seul.id)).op as number;
    expect(op).toBeGreaterThan(0);
    expect((await sql`SELECT type_code FROM business_operations WHERE id = ${op}`)[0]).toEqual({ type_code: null });
    expect((await membres(op)).map((m) => m.file_id)).toEqual([facture.id]);
    expect(await liensDe(seul.id)).toEqual([{ file: facture.id, prov: ['MANUAL_DIRECT'] }]);
    const avant = await empreinte(c.compte);
    expect(await relierCommeLaFenetre(seul.id, [facture.id])).toEqual({ linked: [facture.id], failed: [] });
    expect((await empreinte(c.compte)).ops.map((o: Json) => o.id)).toEqual(avant.ops.map((o: Json) => o.id));
    expect((await empreinte(c.compte)).liens).toEqual(avant.liens);
    // Sans élément d'agenda : aucun appel.
    const { linkUploadedDocumentsToAgendaItem } = await import('@/lib/agenda/document-agenda-link-client');
    let appels = 0;
    expect(await linkUploadedDocumentsToAgendaItem(null, [facture.id], async () => { appels += 1; return { ok: true, status: 200 }; })).toEqual({ linked: [], failed: [] });
    expect(appels).toBe(0);
  });

  it('L85D-E06 — routes « events » retirées : aucun module, aucune référence dans le code de production', async () => {
    const racine = process.cwd();
    for (const f of ['src/app/api/events', 'src/app/api/documents/[id]/events']) expect(existsSync(join(racine, f)), f).toBe(false);
    await expect(import('@/app/api/' + 'events/route')).rejects.toThrow();
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) { if (e !== '__tests__' && e !== 'test') parcourir(p); }
        else if (/\.(tsx?|mjs)$/.test(e) && !/\.test\.|\.e2e\./.test(e)) fichiers.push(p);
      }
    };
    parcourir(join(racine, 'src'));
    for (const d of ['mobile', 'android', 'ios']) if (existsSync(join(racine, d))) parcourir(join(racine, d));
    const appelants = fichiers.filter((f) => /['"`]\/api\/events\b|\/api\/documents\/\$\{[^}]+\}\/events\b|\/api\/documents\/\d+\/events\b/.test(readFileSync(f, 'utf-8')));
    expect(appelants).toEqual([]);
  });
});
