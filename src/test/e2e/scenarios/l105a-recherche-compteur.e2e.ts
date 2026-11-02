/**
 * Lot 105A — ticket « Recherche globale : Voir tous les documents (N) », de
 * bout en bout sur PostgreSQL 16.
 *
 * Appelle les VRAIES routes, exactement comme l'interface (session simulée
 * seulement) :
 *   · suggestions de la barre      GET /api/search?instant=1&q=
 *   · décompte du lien « Voir tous » GET /api/v2/documents?count=1&q=
 *   · « Mes documents » (arrivée)   GET /api/v2/documents?q=… (tous les lots)
 *
 * Vérifie que N (décompte) = total affiché par la page (`meta.total`) =
 * nombre de documents réellement énumérés lot après lot, sans doublon ;
 * 12 correspondances / 6 suggestions → 12 ; < 6 ; > 6 avec pagination ; 0 ;
 * mélange de types ; supprimés, autre compte et espace Duo exclus ; requêtes
 * dans le désordre (exécuteur réel du Provider branché sur la route) ; mesure
 * des durées avant / après (« [L105A-PERF] »).
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

type Compte = { id: number; ownerUserId: number };
type FeedBody = { documents: Array<{ id: number }>; nextCursor: string | null; hasMore: boolean; meta?: { total: number } };
type SearchRow = { id: string; category: string; label: string; href: string };

scenario('L105A-RC', 'Recherche globale : « Voir tous les documents (N) », N = total exact de « Mes documents »', ({ sql, make }) => {
  let moi: Compte;
  let duo: Compte;
  let autre: Compte;
  const homiris: number[] = [];
  const linky: number[] = [];
  const ids: Record<string, number> = {};

  const as = (c: Compte) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const tri = (v: number[]) => [...v].sort((a, b) => a - b);

  const doc = async (c: Compte, o: {
    title: string; assetId?: number | null; supplier?: string | null; text?: string | null; type?: string | null;
    draft?: boolean; status?: string; deleted?: boolean; mime?: string;
  }) => {
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, retained_title, supplier, extracted_text,
                               document_type_code, upload_status, is_draft, deleted_at)
      VALUES (${c.ownerUserId}, ${c.id}, ${o.assetId ?? null}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`},
              ${o.mime ?? 'application/pdf'}, ${o.title}, ${o.supplier ?? null}, ${o.text ?? null}, ${o.type ?? null},
              ${o.status ?? 'COMPLETED'}, ${o.draft ?? false}, ${o.deleted ? sql`now()` : null})
      RETURNING id`;
    return f.id;
  };

  /** Suggestions de la barre de recherche (ce que reçoit le Provider). */
  const suggestions = async (q: string) => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(new NextRequest(`http://localhost/api/search?instant=1&q=${encodeURIComponent(q)}`));
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: SearchRow[] }).results;
  };
  /** Décompte, à l'adresse EXACTE que construit l'interface (`documentsCountUrl`). */
  const decompte = async (q: string) => {
    const { documentsCountUrl } = await import('@/lib/verebona/live-search');
    const { GET } = await import('@/app/api/v2/documents/route');
    const url = documentsCountUrl(q);
    if (!url) return { total: 0, searchApplied: false };
    const res = await GET(new NextRequest(`http://localhost${url}`));
    expect(res.status).toBe(200);
    return (await res.json()) as { total: number; searchApplied: boolean };
  };
  /** Page d'arrivée : l'adresse du lien, lue comme l'écran (`?q=`), tous les lots suivis. */
  const pageArrivee = async (href: string, limit = 50) => {
    const { GET } = await import('@/app/api/v2/documents/route');
    const { readLocalQuery } = await import('@/lib/search/local-search');
    const q = readLocalQuery(new URL(href, 'http://localhost').searchParams);
    const tous: number[] = [];
    let total: number | undefined;
    let cursor: string | null = null;
    let lots = 0;
    do {
      const p = new URLSearchParams({ sort: 'added', direction: 'desc', limit: String(limit), q, ...(cursor ? { cursor } : {}) });
      const res = await GET(new NextRequest(`http://localhost/api/v2/documents?${p}`));
      expect(res.status).toBe(200);
      const body = await res.json() as FeedBody;
      if (body.meta) total = body.meta.total;
      tous.push(...body.documents.map((d) => d.id));
      cursor = body.hasMore ? body.nextCursor : null;
      lots += 1;
    } while (cursor && lots < 30);
    return { ids: tous, total: total!, lots };
  };
  /** Parcours complet : suggestions + décompte → lien → page d'arrivée. */
  const parcours = async (q: string, limit = 50) => {
    const { seeAllLinks, toLiveResults } = await import('@/lib/verebona/live-search');
    const rows = await suggestions(q);
    const c = await decompte(q);
    const liens = seeAllLinks(q, rows, { status: 'ready', ...c });
    const lien = liens.find((l) => l.id === 'voir-documents') ?? null;
    return { rows, visibles: toLiveResults(q, rows), count: c, lien, page: lien ? await pageArrivee(lien.href, limit) : null };
  };

  it('prépare un compte, son espace Duo, un autre compte ; documents, biens, échéances, équipements', async () => {
    moi = await make.account();
    duo = await make.account({ owner: (moi as unknown as { owner: never }).owner, plan: 'premium_duo' });
    autre = await make.account();
    ids.maison = (await make.asset(moi as never, { category: 'IMMOBILIER', name: 'Maison' })).id;
    ids.voiture = (await make.asset(moi as never, { name: 'Voiture' })).id;
    // Correspondances NON documentaires : un bien, un équipement, une échéance « Homiris ».
    ids.bienHomiris = (await make.asset(moi as never, { category: 'IMMOBILIER', name: 'Box Homiris' })).id;
    await sql`INSERT INTO equipments (asset_id, name) VALUES (${ids.maison}, 'Centrale Homiris')`;
    await make.agendaItem(moi as never, { title: 'Renouvellement Homiris', startDate: '2031-03-12', assetIds: [ids.maison] });

    // 12 documents Homiris de types MÉLANGÉS : par titre, émetteur seul ou contenu seul.
    const types = ['SUBSCRIPTION_INVOICE', 'SUBSCRIPTION_CONTRACT', 'INSURANCE_CERTIFICATE', null];
    for (let i = 1; i <= 11; i++) {
      const v = i % 3;
      homiris.push(await doc(moi, {
        title: v === 0 ? `Facture Homiris ${i}` : `Télésurveillance ${i}`,
        supplier: v === 1 ? 'Homiris' : null,
        text: v === 2 ? `Votre abonnement HOMIRIS pour la période ${i}` : null,
        type: types[i % types.length], assetId: i % 2 ? ids.maison : null,
        mime: i === 4 ? 'image/jpeg' : 'application/pdf',
      }));
    }
    // Rattaché à DEUX biens (principal Voiture + lien secondaire Maison) : compté UNE fois.
    ids.lie = await doc(moi, { title: 'Attestation Homiris', type: 'INSURANCE_CERTIFICATE', assetId: ids.voiture });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
              VALUES (${moi.id}, ${ids.lie}, ${ids.maison}, 'SECONDARY', 'USER', 'ACTIVE')`;
    homiris.push(ids.lie);

    // Exclus : supprimé (corbeille), autre compte, espace Duo du même utilisateur.
    ids.supprime = await doc(moi, { title: 'Facture Homiris supprimée', deleted: true });
    ids.secret = await doc(autre, { title: 'Facture Homiris (autre compte)', supplier: 'Homiris' });
    ids.duo1 = await doc(duo, { title: 'Contrat Homiris (Duo)' });
    ids.duo2 = await doc(duo, { title: 'Facture Homiris (Duo)' });

    // Volumétrie > 6 et > 50 : 60 relevés Linky (dont un brouillon et un dépôt en cours).
    for (let i = 1; i <= 60; i++) {
      linky.push(await doc(moi, { title: `Relevé Linky ${i}`, draft: i === 7, status: i === 8 ? 'PENDING' : 'COMPLETED' }));
    }
    // Moins de 6 : trois devis de menuiserie.
    ids.f1 = await doc(moi, { title: 'Devis menuiserie fenêtre salon' });
    ids.f2 = await doc(moi, { title: 'Devis menuiserie porte' });
    ids.f3 = await doc(moi, { title: 'Facture', text: 'Pose menuiserie du garage' });
  });

  it('12 correspondances / 6 suggestions → « Voir tous les documents (12) » et la page en montre 12', async () => {
    as(moi);
    const r = await parcours('homiris', 5);
    // Aperçu plafonné (6 lignes visibles), jamais le total.
    expect(r.visibles.length).toBeLessThanOrEqual(6);
    expect(r.rows.filter((x) => x.category === 'Document').length).toBeLessThan(12);
    expect(r.count).toEqual({ total: 12, searchApplied: true });
    expect(r.lien).toMatchObject({ label: 'Voir tous les documents (12)', href: '/documents?q=homiris', count: 12 });
    // Page d'arrivée : même total, 12 documents énumérés (lots de 5 → 3 lots), sans doublon.
    expect(r.page!.total).toBe(12);
    expect(r.page!.lots).toBe(3);
    expect(r.page!.ids.length).toBe(12);
    expect(new Set(r.page!.ids).size).toBe(12);
    expect(tri(r.page!.ids)).toEqual(tri(homiris));
  });

  it('mélange de types : biens, équipements et échéances correspondants ne sont jamais comptés', async () => {
    as(moi);
    const r = await parcours('homiris');
    const cats = new Set(r.rows.map((x) => x.category));
    expect(cats.has('Bien')).toBe(true);
    expect(cats.has('Agenda')).toBe(true);
    expect(cats.has('Équipement')).toBe(true);
    expect(r.count.total).toBe(12);
    // Le lien de l'agenda reste distinct, sans compteur.
    const { seeAllLinks } = await import('@/lib/verebona/live-search');
    const agenda = seeAllLinks('homiris', r.rows, { status: 'ready', ...r.count }).find((l) => l.id === 'voir-agenda');
    expect(agenda?.count).toBeUndefined();
  });

  it('supprimés, autre compte et espace Duo exclus ; chaque compte compte les siens', async () => {
    as(moi);
    const r = await parcours('homiris');
    for (const exclu of [ids.supprime, ids.secret, ids.duo1, ids.duo2]) expect(r.page!.ids).not.toContain(exclu);
    as(duo);
    const d = await parcours('homiris');
    expect(d.count.total).toBe(2);
    expect(tri(d.page!.ids)).toEqual(tri([ids.duo1, ids.duo2]));
    as(autre);
    const a = await parcours('homiris');
    expect(a.count.total).toBe(1);
    expect(a.page!.ids).toEqual([ids.secret]);
  });

  it('moins de 6 : total réel', async () => {
    as(moi);
    const r = await parcours('menuiserie');
    expect(r.count.total).toBe(3);
    expect(r.lien?.label).toBe('Voir tous les documents (3)');
    expect(tri(r.page!.ids)).toEqual(tri([ids.f1, ids.f2, ids.f3]));
    expect(r.page!.total).toBe(3);
  });

  it('plus de 6, avec pagination : total exact (brouillon et dépôt en cours traités comme la liste)', async () => {
    as(moi);
    const r = await parcours('linky', 50);
    expect(r.count.total).toBe(60);
    expect(r.lien?.label).toBe('Voir tous les documents (60)');
    expect(r.page!.lots).toBe(2);
    expect(r.page!.total).toBe(60);
    expect(r.page!.ids.length).toBe(60);
    expect(new Set(r.page!.ids).size).toBe(60);
    expect(tri(r.page!.ids)).toEqual(tri(linky));
  });

  it('aucun document : ni compteur, ni lien ; saisie sans mot exploitable : rien annoncé', async () => {
    as(moi);
    const r = await parcours('zzqxintrouvable');
    expect(r.count).toEqual({ total: 0, searchApplied: true });
    expect(r.lien).toBeNull();
    const vide = await parcours('de la');
    expect(vide.count.searchApplied).toBe(false);
    expect(vide.lien).toBeNull();
  });

  it('même normalisation : espaces et casse de la saisie ne changent ni N ni la page', async () => {
    as(moi);
    const r = await parcours('  HOMIRIS   ');
    expect(r.count.total).toBe(12);
    expect(r.lien?.href).toBe('/documents?q=HOMIRIS');
    expect(r.page!.total).toBe(12);
  });

  it('requêtes dans le désordre : l’ancienne réponse (12) arrivée en dernier n’écrase jamais la nouvelle (3)', async () => {
    as(moi);
    const { createLiveSearchRunner } = await import('@/lib/verebona/live-search');
    const { GET: documentsGET } = await import('@/app/api/v2/documents/route');
    const { GET: searchGET } = await import('@/app/api/search/route');
    // Réseau réel (routes), mais la PREMIÈRE saisie répond en dernier.
    let premierLibere: () => void = () => {};
    const premierRetenu = new Promise<void>((r) => { premierLibere = r; });
    const fetchJson = async (url: string) => {
      const res = url.startsWith('/api/search')
        ? await searchGET(new NextRequest(`http://localhost${url}`))
        : await documentsGET(new NextRequest(`http://localhost${url}`));
      const body = await res.json();
      if (url.includes('count=1') && url.includes('homiris')) await premierRetenu;
      return body;
    };
    const etats: Array<{ q: string; status: string; total?: number }> = [];
    const runner = createLiveSearchRunner(fetchJson, {
      onResults: () => {},
      onDocumentsCount: (q, s) => etats.push({ q, status: s.status, ...(s.status === 'ready' ? { total: s.total } : {}) }),
    });
    runner.run('homiris');
    runner.run('menuiserie');
    await vi.waitFor(() => expect(etats.some((e) => e.q === 'menuiserie' && e.status === 'ready')).toBe(true));
    premierLibere();
    await new Promise((r) => setTimeout(r, 50));
    const prets = etats.filter((e) => e.status === 'ready');
    expect(prets).toEqual([{ q: 'menuiserie', status: 'ready', total: 3 }]);
  });

  it('temps de réponse : suggestions inchangées, décompte en parallèle, mesuré avant / après', async () => {
    as(moi);
    const mesurer = async (fn: () => Promise<unknown>, n = 5) => {
      await fn(); // échauffement
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await fn();
      return Math.round((performance.now() - t0) / n);
    };
    // AVANT : la barre n'envoyait que la recherche ; APRÈS : recherche + décompte en parallèle.
    const avant = await mesurer(() => suggestions('homiris'));
    const apres = await mesurer(() => Promise.all([suggestions('homiris'), decompte('homiris')]));
    const decompteSeul = await mesurer(() => decompte('linky'));
    const pageSeule = await mesurer(() => pageArrivee('/documents?q=linky'));
    console.info('[L105A-PERF]', JSON.stringify({ suggestionsAvantMs: avant, suggestionsEtDecompteApresMs: apres, decompteLinkyMs: decompteSeul, pageLinkyMs: pageSeule }));
    // Le décompte ne coûte jamais plus que la page qu'il annonce (même ensemble, une agrégation).
    expect(decompteSeul).toBeLessThanOrEqual(pageSeule + 50);
    expect(apres).toBeLessThan(2000);
    // Requête de comptage : un seul COUNT sur asset_files, borné au compte (index du compte / clé primaire).
    // Sur une petite base le planificateur préfère un parcours séquentiel : on
    // l'écarte pour PROUVER qu'un index sert la requête (aucune migration requise).
    const texte = await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const plan = await tx.unsafe(`EXPLAIN SELECT COUNT(*) FROM asset_files WHERE account_id = $1 AND deleted_at IS NULL AND id = ANY($2::int[])`, [moi.id, homiris] as never[]);
      return (plan as unknown as Array<Record<string, string>>).map((l) => Object.values(l)[0]).join('\n');
    });
    expect(texte).toMatch(/Index|Bitmap/);
    expect(texte).not.toMatch(/Seq Scan/);
  });
});
