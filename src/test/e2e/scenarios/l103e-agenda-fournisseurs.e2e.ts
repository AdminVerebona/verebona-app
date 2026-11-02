/**
 * Lot 103E — fournisseurs / intervenants des éléments d'Agenda, sur
 * PostgreSQL 16 réel, par les MÊMES routes que les écrans (tiroir Agenda
 * desktop et mobile, fiche fournisseur, recherche, ICS) et le MÊME
 * orchestrateur de cohérence que la tâche quotidienne.
 *
 *  L103E-E2E-AC01-04  création sans / avec fournisseurs, création depuis le tiroir, doublon réutilisé
 *  L103E-E2E-AC05-06  association / dissociation depuis l'élément ET la fiche fournisseur, symétrie, aucune suppression
 *  L103E-E2E-AC07-09  identification automatique par preuve propre (document direct fiable), voisinage ignoré, retrait respecté
 *  L103E-E2E-AC10     contrôle de cohérence sur l'historique : réparé, tracé, idempotent
 *  L103E-E2E-AC11-13  recherche nom / alias (toutes dates, sans doublon), ICS, renommage et fusion
 *  L103E-E2E-AC14     isolation des comptes, lecture seule, aucun lien intercomptes (même en SQL direct)
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { runCoherenceFor } from '../coherence-run';

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

const jour = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const req = (url: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

scenario('L103E-AGENDA-FOURNISSEURS', 'Agenda / Fournisseurs : relation bidirectionnelle, fiable et recherchable (lot 103E)', ({ sql, make }) => {
  const connecter = (a: { id: number; ownerUserId: number }) => { session.userId = a.ownerUserId; session.currentAccountId = a.id; };
  const fournisseur = async (accountId: number, userId: number, name: string, over: { siret?: string; status?: string } = {}) => {
    const { normalizeName } = await import('@/services/suppliers/supplier-service');
    const [s] = await sql<{ id: number }[]>`
      INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, siret, status)
      VALUES (${accountId}, ${userId}, ${name}, ${normalizeName(name)}, ${over.siret ?? null}, ${over.status ?? 'active'}) RETURNING id`;
    return s.id;
  };
  const fiche = async (itemId: number) => {
    const { GET } = await import('@/app/api/agenda/[id]/fournisseurs/route');
    const r = await GET(req(`/api/agenda/${itemId}/fournisseurs`), ctx(itemId));
    return { status: r.status, body: r.status === 200 ? (await r.json()) as { suppliers: Array<{ id: number; name: string; provenance: string }> } : null };
  };
  const creer = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/agenda/route');
    const r = await POST(req('/api/agenda', 'POST', body));
    return { status: r.status, body: (await r.json()) as { item?: { id: number }; suppliers?: { ok: boolean }; error?: string; code?: string } };
  };
  const modifier = async (id: number, body: Record<string, unknown>) => {
    const { PUT } = await import('@/app/api/agenda/[id]/route');
    const r = await PUT(req(`/api/agenda/${id}`, 'PUT', body), ctx(id));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const ficheFournisseur = async (supplierId: number) => {
    const { GET } = await import('@/app/api/suppliers/[id]/agenda/route');
    const r = await GET(req(`/api/suppliers/${supplierId}/agenda`), ctx(supplierId));
    return { status: r.status, items: r.status === 200 ? ((await r.json()) as { items: Array<{ id: number; bucket: string }> }).items : [] };
  };
  const geste = async (supplierId: number, action: 'link' | 'unlink', agendaItemId: number) => {
    const { POST } = await import('@/app/api/suppliers/[id]/agenda/route');
    return POST(req(`/api/suppliers/${supplierId}/agenda`, 'POST', { action, agendaItemId }), ctx(supplierId));
  };
  const rechercher = async (q: string, period = 'all') => {
    const { GET } = await import('@/app/api/agenda/route');
    const r = await GET(req(`/api/agenda?${new URLSearchParams({ period, includeCancelled: 'false', q })}`));
    return ((await r.json()) as { items: Array<{ id: number }> }).items.map((i) => i.id);
  };
  const nbFournisseurs = async (accountId: number, normalized: string) =>
    Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppliers WHERE account_id = ${accountId} AND normalized_name = ${normalized}`)[0].n);
  /** Document du compte rattaché DIRECTEMENT (ou par l'événement de référence) à l'élément, fournisseur établi ou incertain. */
  const documentDe = async (a: { id: number; ownerUserId: number }, itemId: number, supplierId: number, o: { provenance?: string; confirmed?: boolean; confidence?: string | null } = {}) => {
    const f = await make.assetFile(a);
    await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed, confidence_score)
              VALUES (${f.id}, ${supplierId}, ${o.confirmed ?? false}, ${o.confidence === undefined ? '1' : o.confidence})`;
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${itemId}, ${f.id}, ${`{${o.provenance ?? 'AI_DIRECT'}}`}::text[])`;
    return f.id;
  };

  it('L103E-E2E-AC01..04 — tiroir : sans fournisseur, deux existants, création unique, doublon réutilisé', async () => {
    const a = await make.account();
    connecter(a);
    // AC01 : sans fournisseur — aucune rubrique (liste vide), aucune contrainte.
    const seul = await creer({ title: 'Ramonage', startDate: jour(10) });
    expect(seul.status).toBe(201);
    expect((await fiche(seul.body.item!.id)).body!.suppliers).toEqual([]);

    // AC02 : deux fournisseurs existants.
    const s1 = await fournisseur(a.id, a.ownerUserId, 'Durand Expertise');
    const s2 = await fournisseur(a.id, a.ownerUserId, 'Plomberie Martin SARL');
    const visite = await creer({ title: 'Visite de l’expert', startDate: jour(5), suppliers: { supplierIds: [s1, s2] } });
    expect(visite.status).toBe(201);
    const id = visite.body.item!.id;
    expect((await fiche(id)).body!.suppliers.map((s) => s.name).sort()).toEqual(['Durand Expertise', 'Plomberie Martin SARL']);
    // Cartes / liste Agenda : aucun fournisseur dans la représentation compacte.
    const { GET } = await import('@/app/api/agenda/route');
    const liste = (await (await GET(req('/api/agenda?period=all'))).json()) as { items: Array<Record<string, unknown>> };
    expect(JSON.stringify(liste.items.find((i) => i.id === id))).not.toMatch(/Durand|supplier/);

    // AC03 : création depuis le tiroir — une seule fiche, liée, référentiel commun.
    const r3 = await modifier(id, { suppliers: { supplierIds: [s1, s2], newSuppliers: [{ name: 'Toiture Sud Ouest' }] } });
    expect(r3.status).toBe(200);
    expect(await nbFournisseurs(a.id, 'toiture sud ouest')).toBe(1);
    expect((await fiche(id)).body!.suppliers.map((s) => s.name)).toContain('Toiture Sud Ouest');

    // AC04 : doublon — vérification à blanc « certain » puis réutilisation (aucune nouvelle fiche).
    const { POST: creerFournisseur } = await import('@/app/api/suppliers/route');
    const verif = await (await creerFournisseur(req('/api/suppliers', 'POST', { name: 'plomberie martin', dryRun: true }))).json();
    expect(verif).toMatchObject({ decision: 'certain', candidates: [{ id: s2 }] });
    const avant = Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppliers WHERE account_id = ${a.id}`)[0].n);
    const dbl = await creer({ title: 'Fuite cuisine', suppliers: { newSuppliers: [{ name: 'PLOMBERIE MARTIN' }] } });
    expect(dbl.status).toBe(201);
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppliers WHERE account_id = ${a.id}`)[0].n)).toBe(avant);
    expect((await fiche(dbl.body.item!.id)).body!.suppliers.map((s) => s.id)).toEqual([s2]);
    // Fiche proche (incertaine) sans confirmation : nouvelle fiche + revue de doublon (règle des documents).
    await creer({ title: 'Diagnostic', suppliers: { newSuppliers: [{ name: 'Durand' }] } });
    expect(await sql`SELECT 1 FROM supplier_review_items WHERE account_id = ${a.id} AND item_type = 'deduplication' AND detected_name = 'Durand'`).toHaveLength(1);
    // Sélection invalide : refus AVANT toute écriture (aucun élément créé).
    const nbAvant = (await sql`SELECT id FROM agenda_items WHERE account_id = ${a.id}`).length;
    expect((await creer({ title: 'X', suppliers: { supplierIds: [999999999] } })).status).toBe(404);
    expect((await sql`SELECT id FROM agenda_items WHERE account_id = ${a.id}`).length).toBe(nbAvant);
  });

  it('L103E-E2E-AC05..06 — symétrie élément ↔ fiche fournisseur, passés / à venir / sans date, aucune suppression', async () => {
    const a = await make.account();
    connecter(a);
    const s = await fournisseur(a.id, a.ownerUserId, 'Cabinet Expertise Lyon');
    const passe = (await make.agendaItem(a, { title: 'Expertise 2025', startDate: jour(-90) })).id;
    const futur = (await make.agendaItem(a, { title: 'Contre-expertise', startDate: jour(30) })).id;
    const sansDate = (await make.agendaItem(a, { title: 'Rapport à recevoir' })).id;
    for (const i of [passe, futur, sansDate]) expect((await geste(s, 'link', i)).status).toBe(200);
    const f = await ficheFournisseur(s);
    expect(Object.fromEntries(f.items.map((i) => [i.id, i.bucket]))).toEqual({ [passe]: 'past', [futur]: 'future', [sansDate]: 'undated' });
    expect((await fiche(passe)).body!.suppliers.map((x) => x.id)).toEqual([s]);
    // Retrait depuis l'élément → absent de la fiche fournisseur ; entités intactes.
    await modifier(futur, { suppliers: { supplierIds: [] } });
    expect((await ficheFournisseur(s)).items.map((i) => i.id).sort()).toEqual([passe, sansDate].sort());
    // Retrait depuis la fiche fournisseur → absent de l'élément.
    expect((await geste(s, 'unlink', passe)).status).toBe(200);
    expect((await fiche(passe)).body!.suppliers).toEqual([]);
    expect(await sql`SELECT id FROM agenda_items WHERE id IN (${passe}, ${futur})`).toHaveLength(2);
    expect(await sql`SELECT id FROM suppliers WHERE id = ${s} AND status = 'active'`).toHaveLength(1);
  });

  it('L103E-E2E-AC07..09 — preuve propre à l’élément seulement ; ambiguïté = aucun lien ; retrait manuel jamais recréé', async () => {
    const a = await make.account();
    connecter(a);
    const { syncAutomaticAgendaSuppliers } = await import('@/services/agenda/agenda-suppliers');
    const expert = await fournisseur(a.id, a.ownerUserId, 'Expertises Rhône Alpes');
    const plombier = await fournisseur(a.id, a.ownerUserId, 'Plombiers Associés');
    const peintre = await fournisseur(a.id, a.ownerUserId, 'Peintures du Lac');
    const visite = (await make.agendaItem(a, { title: 'Visite de l’expert', startDate: jour(-3) })).id;
    // AC08 : trois fournisseurs dans l'événement de référence, un seul acteur de la visite.
    await documentDe(a, visite, expert, { provenance: 'AI_DIRECT' });
    await documentDe(a, visite, plombier, { provenance: 'OPERATION_PRINCIPAL' });
    // Lien fournisseur INCERTAIN (ni confirmé, ni lu avec certitude) : ambiguïté.
    await documentDe(a, visite, peintre, { provenance: 'MANUAL_DIRECT', confidence: '0.7' });
    const r = await syncAutomaticAgendaSuppliers(a.id, [visite]);
    expect(r[0].added).toEqual([expert]);
    expect((await fiche(visite)).body!.suppliers.map((s) => [s.id, s.provenance])).toEqual([[expert, 'DOCUMENT']]);
    // Idempotent.
    expect((await syncAutomaticAgendaSuppliers(a.id, [visite]))[0]).toMatchObject({ added: [], removed: [], upgraded: [] });
    // AC09 : retrait manuel → jamais recréé (synchronisation, contrôle de cohérence).
    await modifier(visite, { suppliers: { supplierIds: [] } });
    expect((await syncAutomaticAgendaSuppliers(a.id, [visite]))[0]).toMatchObject({ added: [], suppressed: [expert] });
    await runCoherenceFor(sql, [a.id], { mode: 'CORRECTIVE' });
    expect((await fiche(visite)).body!.suppliers).toEqual([]);
    // Nouveau consentement : l'utilisateur le remet → USER.
    await modifier(visite, { suppliers: { supplierIds: [expert] } });
    expect((await fiche(visite)).body!.suppliers.map((s) => s.provenance)).toEqual(['USER']);
    // Mention explicite et non ambiguë dans la description : AUTO.
    const appel = (await make.agendaItem(a, { title: 'Rappeler Peintures du Lac pour le devis' })).id;
    expect((await syncAutomaticAgendaSuppliers(a.id, [appel]))[0].added).toEqual([peintre]);
  });

  it('L103E-E2E-AC10 — cohérence sur l’historique : réparations fiables, tracées, idempotentes, sans nouveau planificateur', async () => {
    const a = await make.account();
    connecter(a);
    const s = await fournisseur(a.id, a.ownerUserId, 'Chauffage Services Plus');
    const items = [];
    for (const n of [-400, -10, 20]) {
      const id = (await make.agendaItem(a, { title: `Entretien chaudière ${n}`, startDate: jour(n) })).id;
      await documentDe(a, id, s, { confirmed: true, confidence: null });
      items.push(id);
    }
    // Lien automatique devenu sans preuve (historique incohérent).
    const orphelin = (await make.agendaItem(a, { title: 'Ancien rendez-vous' })).id;
    await sql`INSERT INTO agenda_item_suppliers (account_id, agenda_item_id, supplier_id, provenance) VALUES (${a.id}, ${orphelin}, ${s}, 'DOCUMENT')`;
    const run1 = await runCoherenceFor(sql, [a.id], { mode: 'CORRECTIVE' });
    expect(run1.results['COH-AGENDA-SUPPLIERS']).toMatchObject({ REPAIRED: 4 });
    expect(await sql`SELECT agenda_item_id FROM agenda_item_suppliers WHERE account_id = ${a.id} ORDER BY 1`).toEqual(items.map((agenda_item_id) => ({ agenda_item_id })));
    const hist = await sql<{ action: string; correlation_id: string }[]>`SELECT action, correlation_id FROM agenda_item_supplier_history WHERE account_id = ${a.id}`;
    expect(hist.filter((h) => h.action === 'LINKED')).toHaveLength(3);
    expect(hist.filter((h) => h.action === 'UNLINKED')).toHaveLength(1);
    expect(hist.every((h) => h.correlation_id.startsWith('coherence:'))).toBe(true);
    const run2 = await runCoherenceFor(sql, [a.id], { mode: 'CORRECTIVE' });
    expect(run2.results['COH-AGENDA-SUPPLIERS']).toEqual({ CONSISTENT: 4 });
  });

  it('L103E-E2E-AC11..13 — recherche (nom, alias, toutes dates, sans doublon), ICS, renommage et fusion', async () => {
    const a = await make.account();
    connecter(a);
    const s1 = await fournisseur(a.id, a.ownerUserId, 'Électricité Vauban');
    const s2 = await fournisseur(a.id, a.ownerUserId, 'Vauban Dépannage');
    await sql`INSERT INTO supplier_contact_observations (supplier_id, observed_name) VALUES (${s1}, 'EVB Services')`;
    const passe = (await make.agendaItem(a, { title: 'Mise aux normes', startDate: jour(-60) })).id;
    const futur = (await make.agendaItem(a, { title: 'Contrôle tableau', startDate: jour(60) })).id;
    const sansDate = (await make.agendaItem(a, { title: 'Devis prise extérieure' })).id;
    const autre = (await make.agendaItem(a, { title: 'Vidange', startDate: jour(5) })).id;
    for (const i of [passe, futur, sansDate]) await modifier(i, { suppliers: { supplierIds: [s1, s2] } });
    const tri = (v: number[]) => [...v].sort((x, y) => x - y);
    // Deux fournisseurs correspondent (« vauban ») : chaque élément une seule fois, toutes dates.
    expect(tri(await rechercher('vauban'))).toEqual(tri([passe, futur, sansDate]));
    expect(await rechercher('electricite vauban')).not.toContain(autre);
    // Alias reconnu par le référentiel.
    expect(tri(await rechercher('EVB'))).toEqual(tri([passe, futur, sansDate]));
    // Filtre temporel EXPLICITE : appliqué (les sans date restent, règle existante de l'Agenda).
    expect(tri(await rechercher('vauban', 'past'))).toEqual(tri([passe, sansDate]));

    // AC12 : ICS — noms à jour, échappés, aucune coordonnée.
    await sql`UPDATE suppliers SET email = 'contact@vauban.test', phone = '0102030405' WHERE id = ${s1}`;
    const { listSuppliersOfItems } = await import('@/services/agenda/agenda-suppliers');
    const { getAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    const { computeICSContent } = await import('@/services/agenda/AgendaCalendarExportService');
    const liste = (await getAgendaItems({ accountId: a.id, includeUndated: false })).filter((i) => i.id === futur);
    const noms = await listSuppliersOfItems(a.id, [futur]);
    const ics = computeICSContent(liste.map((i) => ({ ...i, supplierNames: (noms.get(i.id) ?? []).map((x) => x.name) })), 'Compte').replace(/\r\n /g, '');
    // Ordre alphabétique français, indépendant de la collation de la base (lot 104, CI en_US).
    expect(ics).toContain('Fournisseurs / intervenants : Électricité Vauban\\, Vauban Dépannage');
    expect(ics).not.toMatch(/contact@vauban|0102030405|ATTENDEE/);

    // AC13 : renommage — affichage et recherche à jour (jointure, pas de copie).
    const { PATCH } = await import('@/app/api/suppliers/[id]/route');
    await PATCH(req(`/api/suppliers/${s2}`, 'PATCH', { name: 'Dépannage Bastille' }), ctx(s2));
    expect(tri(await rechercher('bastille'))).toEqual(tri([passe, futur, sansDate]));
    // Fusion s2 → s1 (revue de doublon) : liens reportés, aucun doublon, aucun orphelin.
    const [rev] = await sql<{ id: number }[]>`
      INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id) VALUES (${a.id}, 'deduplication', 'open', ${s2}) RETURNING id`;
    const { POST: resoudre } = await import('@/app/api/to-process/suppliers/[id]/resolve/route');
    expect((await resoudre(req(`/api/to-process/suppliers/${rev.id}/resolve`, 'POST', { resolution: 'merged', targetSupplierId: s1 }), ctx(rev.id))).status).toBe(200);
    expect(await sql`SELECT 1 FROM agenda_item_suppliers WHERE supplier_id = ${s2}`).toHaveLength(0);
    expect((await fiche(passe)).body!.suppliers.map((x) => x.id)).toEqual([s1]);
    expect(await rechercher('bastille')).toEqual([]);
  });

  it('L103E-E2E-AC14 — isolation des comptes, lecture seule, aucun lien intercomptes', async () => {
    const a = await make.account();
    const b = await make.account();
    const sb = await fournisseur(b.id, b.ownerUserId, 'Fournisseur Autre Compte');
    const ib = (await make.agendaItem(b, { title: 'Élément B' })).id;
    connecter(a);
    const ia = (await make.agendaItem(a, { title: 'Élément A' })).id;
    // Fournisseur d'un autre compte : refusé, rien n'est écrit.
    expect((await modifier(ia, { suppliers: { supplierIds: [sb] } })).status).toBe(404);
    expect((await fiche(ib)).status).toBe(404);
    expect((await ficheFournisseur(sb)).status).toBe(404);
    expect((await geste(sb, 'link', ia)).status).toBe(404);
    const sa = await fournisseur(a.id, a.ownerUserId, 'Fournisseur Compte A');
    expect((await geste(sa, 'link', ib)).status).toBe(404);
    // Même une écriture SQL directe est refusée (déclencheur 0950).
    await expect(sql`INSERT INTO agenda_item_suppliers (account_id, agenda_item_id, supplier_id, provenance) VALUES (${a.id}, ${ia}, ${sb}, 'USER')`).rejects.toThrow(/AGENDA_SUPPLIER_CROSS_ACCOUNT/);
    expect(await sql`SELECT 1 FROM agenda_item_suppliers WHERE agenda_item_id IN (${ia}, ${ib})`).toHaveLength(0);
    // Compte en lecture seule : écritures refusées (403), consultation possible.
    const ro = await make.account({ plan: null });
    connecter(ro);
    const sro = await fournisseur(ro.id, ro.ownerUserId, 'Fournisseur Lecture Seule');
    const iro = (await make.agendaItem(ro, { title: 'Élément lecture seule' })).id;
    expect((await geste(sro, 'link', iro)).status).toBe(403);
    expect((await fiche(iro)).status).toBe(200);
    // Suppression du fournisseur (compte) : cascade, aucun lien orphelin.
    connecter(a);
    await modifier(ia, { suppliers: { supplierIds: [sa] } });
    await sql`DELETE FROM suppliers WHERE id = ${sa}`;
    expect(await sql`SELECT 1 FROM agenda_item_suppliers WHERE supplier_id = ${sa}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM agenda_items WHERE id = ${ia}`).toHaveLength(1);
  });

  it('L103E-E2E-DUO — un bien change de compte : liens et retraits de ses éléments suivent, fiche réutilisée ou copiée', async () => {
    const a = await make.account();
    const b = await make.account();
    const bien = await make.asset(a);
    const item = (await make.agendaItem(a, { title: 'Révision', assetIds: [bien.id] })).id;
    const s = await fournisseur(a.id, a.ownerUserId, 'Garage Central Auto');
    const r = await fournisseur(a.id, a.ownerUserId, 'Carrosserie Ouest Pro');
    connecter(a);
    await modifier(item, { suppliers: { supplierIds: [s, r] } });
    await modifier(item, { suppliers: { supplierIds: [s] } }); // r retiré à la main (mémorisé)
    const { db } = await import('@/db');
    const { transferAssetDataInTx } = await import('@/services/assets/asset-account-transfer.service');
    await db.transaction(async (tx) => {
      await tx.execute((await import('drizzle-orm')).sql`UPDATE assets SET account_id = ${b.id} WHERE id = ${bien.id}`);
      await transferAssetDataInTx(tx, { assetId: bien.id, fromAccountId: a.id, toAccountId: b.id });
    });
    const liens = await sql<{ account_id: number; supplier_account: number; name: string }[]>`
      SELECT l.account_id, s.account_id AS supplier_account, s.name FROM agenda_item_suppliers l JOIN suppliers s ON s.id = l.supplier_id WHERE l.agenda_item_id = ${item}`;
    expect(liens).toEqual([{ account_id: b.id, supplier_account: b.id, name: 'Garage Central Auto' }]);
    const retraits = await sql<{ account_id: number; supplier_account: number }[]>`
      SELECT x.account_id, s.account_id AS supplier_account FROM agenda_item_supplier_suppressions x JOIN suppliers s ON s.id = x.supplier_id WHERE x.agenda_item_id = ${item}`;
    expect(retraits).toEqual([{ account_id: b.id, supplier_account: b.id }]);
    // La fiche d'origine reste dans l'ancien compte.
    expect(await sql`SELECT 1 FROM suppliers WHERE id = ${s} AND account_id = ${a.id}`).toHaveLength(1);
  });
});
