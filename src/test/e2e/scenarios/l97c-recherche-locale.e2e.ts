/**
 * Lot 97C — ticket P1 « Documents & Agenda — Ajouter une recherche locale
 * réactive sur les quatre écrans » (arbitrages PO Q1-B, Q2-A, Q3-B du
 * 26/10/2026), de bout en bout sur PostgreSQL 16.
 *
 * Appelle les VRAIES routes, exactement comme les écrans (session simulée
 * seulement) :
 *   · « Mes documents »         GET /api/v2/documents?…&q=
 *   · Documents d'un bien       GET /api/v2/documents?assets=<bien>&…&q=
 *   · « Mon agenda »            GET /api/agenda?period=…&q=
 *   · Agenda d'un bien          GET /api/agenda?assetIds=<bien>&equipmentFacet=1&q=
 *
 * Couvre AC02-AC05, AC08-AC12, AC16, AC17 (le reste — champ, délai,
 * réponses dans le désordre, URL, onglets — est couvert par les tests
 * unitaires `src/lib/search/__tests__/l97c-recherche-locale.test.ts`) ;
 * cohérence avec la recherche générale (même moteur, sans plafond) ; aucun
 * appel modèle (passerelle de rejeu) ni réseau (fetch espionné) ; mesure
 * des durées (« [L97C-PERF] »).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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

type Compte = { id: number; ownerUserId: number };
type FeedBody = { documents: Array<{ id: number }>; nextCursor: string | null; hasMore: boolean; meta?: { total: number; scopeTotal: number; facets: { types: Array<{ value: string; count: number }> } } };

scenario('L97C-RL', 'Recherche locale réactive : Documents et Agenda, pages générales et onglets des biens', ({ sql, make, replay }) => {
  let moi: Compte;
  let autre: Compte;
  const ids: Record<string, number> = {};
  const linky: number[] = [];
  const homiris: number[] = [];
  const fetchOrigine = globalThis.fetch;
  let appelsReseau = 0;

  const as = (c: Compte) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const tri = (v: number[]) => [...v].sort((a, b) => a - b);

  const doc = async (c: Compte, o: {
    title: string; assetId?: number | null; supplier?: string | null; text?: string | null; type?: string | null; draft?: boolean;
  }) => {
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, retained_title, supplier, extracted_text,
                               document_type_code, upload_status, is_draft)
      VALUES (${c.ownerUserId}, ${c.id}, ${o.assetId ?? null}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`},
              'application/pdf', ${o.title}, ${o.supplier ?? null}, ${o.text ?? null}, ${o.type ?? null}, 'COMPLETED', ${o.draft ?? false})
      RETURNING id`;
    return f.id;
  };
  const evt = async (c: Compte, title: string, o: { date?: string | null; assets?: number[]; equipments?: number[]; rooms?: number[]; cancelled?: boolean; description?: string } = {}) => {
    const i = await make.agendaItem(c as never, { title, startDate: o.date ?? undefined, assetIds: o.assets ?? [] });
    if (o.description) await sql`UPDATE agenda_items SET description = ${o.description} WHERE id = ${i.id}`;
    for (const e of o.equipments ?? []) await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${i.id}, ${e})`;
    for (const r of o.rooms ?? []) await sql`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${i.id}, ${r})`;
    if (o.cancelled) await sql`UPDATE agenda_items SET manual_status = 'annule' WHERE id = ${i.id}`;
    return i.id;
  };

  /** Ce que « Mes documents » / l'onglet Documents demandent (tous les lots, curseur suivi). */
  const documents = async (extra: Record<string, string> = {}, limit = 50) => {
    const { GET } = await import('@/app/api/v2/documents/route');
    const tous: number[] = [];
    let meta: FeedBody['meta'] | undefined;
    let cursor: string | null = null;
    let lots = 0;
    do {
      const p = new URLSearchParams({ sort: 'added', direction: 'desc', limit: String(limit), ...extra, ...(cursor ? { cursor } : {}) });
      const res = await GET(new NextRequest(`http://localhost/api/v2/documents?${p}`));
      expect(res.status).toBe(200);
      const body = await res.json() as FeedBody;
      if (body.meta) meta = body.meta;
      tous.push(...body.documents.map((d) => d.id));
      cursor = body.hasMore ? body.nextCursor : null;
      lots += 1;
    } while (cursor && lots < 20);
    return { ids: tous, meta: meta!, lots };
  };
  /** Ce que « Mon agenda » / l'onglet Agenda demandent. */
  const agenda = async (extra: Record<string, string> = {}) => {
    const { GET } = await import('@/app/api/agenda/route');
    const p = new URLSearchParams({ period: 'all', includeCancelled: 'false', ...extra });
    const res = await GET(new NextRequest(`http://localhost/api/agenda?${p}`));
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ id: number }> }).items.map((i) => i.id);
  };

  beforeAll(() => {
    // Aucun appel réseau (fournisseur IA ou autre) ne doit partir d'une recherche locale.
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { appelsReseau += 1; return fetchOrigine(...args); }) as typeof fetch;
  });
  afterAll(() => { globalThis.fetch = fetchOrigine; });

  it('prépare deux comptes, plusieurs biens, des documents et des éléments d’agenda', async () => {
    moi = await make.account();
    autre = await make.account();
    ids.maison = (await make.asset(moi as never, { category: 'IMMOBILIER', name: 'Maison' })).id;
    ids.voiture = (await make.asset(moi as never, { name: 'Voiture' })).id;
    ids.bienAutre = (await make.asset(autre as never, { category: 'IMMOBILIER', name: 'Maison' })).id;

    // 12 factures Homiris de la Maison : titre, ÉMETTEUR seul ou CONTENU seul.
    for (let i = 1; i <= 12; i++) {
      const variante = i % 3;
      homiris.push(await doc(moi, {
        title: variante === 0 ? `Facture Homiris ${i}` : `Télésurveillance ${i}`,
        supplier: variante === 1 ? 'Homiris' : null,
        text: variante === 2 ? `Votre abonnement HOMIRIS pour la période ${i}` : null,
        type: 'SUBSCRIPTION_INVOICE', assetId: ids.maison,
      }));
    }
    ids.homirisContrat = await doc(moi, { title: 'Contrat Homiris', type: 'SUBSCRIPTION_CONTRACT', assetId: ids.maison });
    ids.homirisVoiture = await doc(moi, { title: 'Homiris garage', type: 'SUBSCRIPTION_INVOICE', assetId: ids.voiture });
    // Rattaché à la Maison par une relation SECONDAIRE (bien principal : Voiture).
    ids.homirisLie = await doc(moi, { title: 'Attestation Homiris', type: 'INSURANCE_CERTIFICATE', assetId: ids.voiture });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
              VALUES (${moi.id}, ${ids.homirisLie}, ${ids.maison}, 'SECONDARY', 'USER', 'ACTIVE')`;
    // « fenêtre » : dans le contenu seulement (« fenêtres »), jamais dans le titre.
    ids.devisFenetre = await doc(moi, { title: 'Devis menuiserie', text: 'Remplacement des fenêtres du salon', assetId: ids.maison });
    ids.factureFenetre = await doc(moi, { title: 'Facture fenêtre cuisine', assetId: ids.maison });
    ids.sansRapport = await doc(moi, { title: 'Taxe foncière', assetId: ids.maison });
    // Même maison, mot absent : n'est PAS pertinent parce que son bien l'est.
    ids.memeBien = await doc(moi, { title: 'Relevé eau', text: 'consommation', assetId: ids.maison });
    // Volumétrie > 50 : 60 relevés Linky, sans bien.
    for (let i = 1; i <= 60; i++) linky.push(await doc(moi, { title: `Relevé Linky ${i}`, type: null }));
    ids.secret = await doc(autre, { title: 'Facture Homiris (autre compte)', supplier: 'Homiris', assetId: ids.bienAutre });

    // Agenda : équipement et pièce de la Maison.
    const [eq] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${ids.maison}, 'Chaudière') RETURNING id`;
    ids.chaudiere = eq.id;
    const [piece] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${ids.maison}, 'Salle de bain') RETURNING id`;
    ids.sdb = piece.id;
    ids.eEntretienPasse = await evt(moi, 'Entretien chaudière', { date: '2024-03-12', assets: [ids.maison], equipments: [ids.chaudiere] });
    ids.eEntretienFutur = await evt(moi, 'Entretien chaudière', { date: '2031-03-12', assets: [ids.maison], equipments: [ids.chaudiere], rooms: [ids.sdb] });
    ids.eEntretienSansDate = await evt(moi, 'Entretien adoucisseur', { assets: [ids.maison] });
    ids.eEquipementSeul = await evt(moi, 'Entretien brûleur', { date: '2031-05-20', equipments: [ids.chaudiere] });
    ids.ePieceSeule = await evt(moi, 'Entretien VMC', { date: '2031-03-25', rooms: [ids.sdb] });
    ids.eAnnule = await evt(moi, 'Entretien annulé', { date: '2031-03-14', assets: [ids.maison], cancelled: true });
    ids.eVoiture = await evt(moi, 'Entretien Voiture', { date: '2031-03-18', assets: [ids.voiture] });
    ids.eCt = await evt(moi, 'Contrôle technique', { date: '2031-06-01', assets: [ids.voiture] });
    ids.eTaxe = await evt(moi, 'Taxe foncière', { date: '2031-10-15', assets: [ids.maison] });
    ids.eAutre = await evt(autre, 'Entretien secret', { date: '2031-03-12', assets: [ids.bienAutre] });
  });

  it('AC01 — recherche vide : la liste est inchangée (aucune restriction)', async () => {
    as(moi);
    const sans = await documents();
    const vide = await documents({ q: '   ' });
    expect(vide.ids).toEqual(sans.ids);
    expect(vide.meta.total).toBe(sans.meta.total);
    expect(await agenda({ q: '' })).toEqual(await agenda());
  });

  it('AC02 / AC17 — « Homiris » : TOUS les documents du compte, sans plafond d’aperçu ; jamais ceux d’un autre compte', async () => {
    as(moi);
    const r = await documents({ q: 'Homiris' });
    const attendus = [...homiris, ids.homirisContrat, ids.homirisVoiture, ids.homirisLie];
    expect(tri(r.ids)).toEqual(tri(attendus));
    expect(r.meta.total).toBe(15);
    expect(r.meta.scopeTotal).toBe(15);
    expect(r.ids).not.toContain(ids.secret);
    // La recherche générale, elle, plafonne ses suggestions à 8 documents.
    const { globalSearch } = await import('@/services/search/global-search.service');
    const g = (await globalSearch(moi.id, 'Homiris')).results.filter((x) => x.category === 'Document');
    expect(g.length).toBe(8);
    // Changement de compte : rien du premier compte.
    as(autre);
    const lui = await documents({ q: 'Homiris' });
    expect(lui.ids).toEqual([ids.secret]);
  });

  it('AC03 — « fenetre » : même moteur que la recherche générale, sans exiger le mot dans le titre ; le bien commun ne suffit pas', async () => {
    as(moi);
    const r = await documents({ q: 'fenetre' });
    expect(tri(r.ids)).toEqual(tri([ids.devisFenetre, ids.factureFenetre]));
    expect(r.ids).not.toContain(ids.memeBien);
    const { globalSearch } = await import('@/services/search/global-search.service');
    const g = (await globalSearch(moi.id, 'fenetre')).results.filter((x) => x.category === 'Document').map((x) => x.docId!);
    for (const id of g) expect(r.ids).toContain(id);
  });

  it('AC04 — « Homiris » + Type : intersection et compteurs exacts (facettes comptées sur les résultats)', async () => {
    as(moi);
    const r = await documents({ q: 'Homiris', types: 'SUBSCRIPTION_INVOICE' });
    expect(tri(r.ids)).toEqual(tri([...homiris, ids.homirisVoiture]));
    expect(r.meta.total).toBe(13);
    expect(r.meta.scopeTotal).toBe(15);
    expect(r.meta.facets.types.find((t) => t.value === 'SUBSCRIPTION_INVOICE')?.count).toBe(13);
    expect(r.meta.facets.types.find((t) => t.value === 'SUBSCRIPTION_CONTRACT')?.count).toBe(1);
  });

  it('AC05 — Documents d’un bien : périmètre strict, relation secondaire incluse, jamais un autre bien', async () => {
    as(moi);
    const r = await documents({ assets: String(ids.maison), q: 'Homiris' });
    expect(tri(r.ids)).toEqual(tri([...homiris, ids.homirisContrat, ids.homirisLie]));
    expect(r.ids).not.toContain(ids.homirisVoiture);
    expect(r.meta.total).toBe(14);
    // Le bien d'un autre compte ne révèle rien.
    expect((await documents({ assets: String(ids.bienAutre), q: 'Homiris' })).ids).toEqual([]);
  });

  it('AC07 — effacer la recherche : liste complète, filtres conservés', async () => {
    as(moi);
    const filtre = await documents({ types: 'SUBSCRIPTION_INVOICE' });
    expect(tri(filtre.ids)).toEqual(tri([...homiris, ids.homirisVoiture]));
  });

  it('AC12 — plus de 50 correspondances : toutes accessibles par lots, total exact, aucun doublon', async () => {
    as(moi);
    const t0 = performance.now();
    const r = await documents({ q: 'linky' }, 50);
    const ms = Math.round(performance.now() - t0);
    expect(r.lots).toBe(2);
    expect(r.ids.length).toBe(60);
    expect(new Set(r.ids).size).toBe(60);
    expect(tri(r.ids)).toEqual(tri(linky));
    expect(r.meta.total).toBe(60);
    // Regroupé par Rubrique, même résultat.
    const g = await documents({ q: 'linky', grouped: '1' }, 50);
    expect(tri(g.ids)).toEqual(tri(linky));
    console.info('[L97C-PERF]', JSON.stringify({ documents: r.ids.length, lots: r.lots, ms }));
  });

  it('`?resultats=` de l’assistant : conservé sans recherche, jamais appliqué à une recherche `q`', async () => {
    as(moi);
    const restreint = await documents({ ids: String(ids.sansRapport) });
    expect(restreint.ids).toEqual([ids.sansRapport]);
    const recherche = await documents({ ids: String(ids.sansRapport), q: 'Homiris' });
    expect(recherche.meta.total).toBe(15);
  });

  it('AC08 — Mon agenda : toutes périodes (passé, futur, sans date), annulés exclus selon la règle existante', async () => {
    as(moi);
    const r = await agenda({ q: 'entretien' });
    expect(tri(r)).toEqual(tri([ids.eEntretienPasse, ids.eEntretienFutur, ids.eEntretienSansDate, ids.eEquipementSeul, ids.ePieceSeule, ids.eVoiture]));
    expect(r).not.toContain(ids.eAutre);
    expect(r).not.toContain(ids.eTaxe);
    expect(await agenda({ q: 'entretien', includeCancelled: 'true' })).toContain(ids.eAnnule);
    // Un élément n'apparaît qu'une fois, malgré ses liens bien + équipement + pièce.
    expect(r.filter((x) => x === ids.eEntretienFutur)).toHaveLength(1);
  });

  it('AC09 / AC10 — filtres explicites conservés : À venir, puis vue mensuelle et annuelle', async () => {
    as(moi);
    const avenir = await agenda({ q: 'entretien', period: 'upcoming', includeUndated: 'false' });
    expect(tri(avenir)).toEqual(tri([ids.eEntretienFutur, ids.eEquipementSeul, ids.ePieceSeule, ids.eVoiture]));
    expect(await agenda({ q: 'entretien', period: 'past' })).toContain(ids.eEntretienPasse);
    expect(await agenda({ q: 'entretien', period: 'past' })).not.toContain(ids.eEntretienFutur);
    // Vue mensuelle (mars 2031) : seuls les résultats du mois (+ le bloc « sans date », règle existante).
    const mois = await agenda({ q: 'entretien', month: '2031-03' });
    expect(tri(mois)).toEqual(tri([ids.eEntretienFutur, ids.ePieceSeule, ids.eVoiture, ids.eEntretienSansDate]));
    // Vue annuelle 2024.
    expect(await agenda({ q: 'entretien', year: '2024' })).toEqual([ids.eEntretienPasse]);
  });

  it('AC11 — Agenda d’un bien : périmètre du bien, équipements et pièces compris, jamais tout le bien', async () => {
    as(moi);
    const r = await agenda({ assetIds: String(ids.maison), equipmentFacet: '1', includeUndated: 'true', q: 'entretien' });
    expect(tri(r)).toEqual(tri([ids.eEntretienPasse, ids.eEntretienFutur, ids.eEntretienSansDate, ids.eEquipementSeul, ids.ePieceSeule]));
    expect(r).not.toContain(ids.eVoiture);
    expect(r).not.toContain(ids.eTaxe);
    // « Contrôle technique » de la Voiture : pas dans l'agenda de la Maison.
    expect(await agenda({ assetIds: String(ids.maison), q: 'controle technique' })).toEqual([]);
    expect(await agenda({ assetIds: String(ids.voiture), q: 'controle technique' })).toEqual([ids.eCt]);
    // Combinée au filtre Équipement : intersection.
    expect(tri(await agenda({ assetIds: String(ids.maison), equipment: String(ids.chaudiere), q: 'entretien' })))
      .toEqual(tri([ids.eEntretienPasse, ids.eEntretienFutur, ids.eEquipementSeul]));
    // Autre compte : rien de « moi ».
    as(autre);
    expect(await agenda({ assetIds: String(ids.maison), q: 'entretien' })).toEqual([]);
    expect(await agenda({ q: 'entretien' })).toEqual([ids.eAutre]);
  });

  it('AC16 — compte en lecture seule : recherche et consultation possibles, aucune écriture', async () => {
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${moi.id}`;
    const { getEntitlements } = await import('@/services/entitlements.service');
    expect((await getEntitlements(moi.id)).canWrite).toBe(false);
    as(moi);
    const empreinte = () => sql<{ d: string; a: string }[]>`
      SELECT (SELECT md5(string_agg(af::text, ',' ORDER BY af.id)) FROM asset_files af WHERE af.account_id = ${moi.id}) AS d,
             (SELECT md5(string_agg(ai::text, ',' ORDER BY ai.id)) FROM agenda_items ai WHERE ai.account_id = ${moi.id}) AS a`;
    const avant = await empreinte();
    expect((await documents({ q: 'Homiris' })).meta.total).toBe(15);
    expect((await agenda({ q: 'entretien' })).length).toBe(6);
    expect(await empreinte()).toEqual(avant);
    await sql`UPDATE account_subscriptions SET status = 'active' WHERE account_id = ${moi.id}`;
  });

  it('aucun appel modèle (T1-T6) ni réseau pendant la saisie ; durée mesurée par frappe validée', async () => {
    as(moi);
    const modele = replay.calls.length;
    const reseau = appelsReseau;
    const t0 = performance.now();
    // Saisie « homiris » validée à chaque palier (cas extrême : pas de délai) — 7 requêtes au plus.
    for (const q of ['ho', 'hom', 'homi', 'homir', 'homiri', 'homiris']) await documents({ q });
    for (const q of ['en', 'ent', 'entretien']) await agenda({ q });
    const ms = Math.round(performance.now() - t0);
    expect(replay.calls.length).toBe(modele);
    expect(appelsReseau).toBe(reseau);
    console.info('[L97C-PERF]', JSON.stringify({ requetes: 9, ms, moyenneMs: Math.round(ms / 9) }));
  });
});
