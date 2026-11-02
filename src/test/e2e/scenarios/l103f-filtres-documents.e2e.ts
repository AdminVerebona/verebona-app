/**
 * Lot 103F — « Mes documents » : filtres « Date du document » et « Date
 * d'ajout », tri, combinaisons et pagination, sur PostgreSQL 16.
 *
 * Appelle la VRAIE route `GET /api/v2/documents` (session simulée) et le
 * service, comme l'écran :
 *   · indépendance des deux dates (facture datée de 2022, ajoutée en 2026) ;
 *   · bornes inclusives, borne unique, 29 février, jours de PARIS pour la
 *     date d'ajout (ajout à 00:30 heure de Paris = la veille en UTC) ;
 *   · « Sans date » ; aucune restriction temporelle par défaut ;
 *   · intersection avec bien, rubrique, type, recherche locale ; compteurs ;
 *   · pagination par curseur avec filtres et tris par date : ni doublon ni
 *     oubli, dates absentes en dernier dans les deux sens, ordre identique
 *     quelle que soit la taille des lots ;
 *   · période refusée (début après la fin) : 400 ;
 *   · isolation des comptes ;
 *   · correction manuelle de la date prioritaire sur l'analyse T1, date
 *     contradictoire non posée, date d'ajout jamais recalculée (renommage,
 *     déplacement, détachement, réanalyse).
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import type { FeedDirection, FeedSort } from '@/lib/documents/document-feed';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type FeedBody = {
  documents: Array<{ id: number; documentDate: string | null; uploadedAt: string | null }>;
  nextCursor: string | null; hasMore: boolean;
  meta?: { total: number; scopeTotal: number; facets: { biens: Array<{ value: string; count: number }> } };
};
interface Ligne { id: number; doc: string | null; ajout: string; bien: number | null; rubrique: string | null; type: string | null; titre: string }

scenario('L103F', 'Mes documents : filtres et tris par date du document / date d’ajout', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  let moi: Compte;
  let autre: Compte;
  let maison = 0;
  let voiture = 0;
  const lignes: Ligne[] = [];
  const ids: Record<string, number> = {};

  const as = (c: Compte) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const tri = (v: number[]) => [...v].sort((a, b) => a - b);

  const inserer = async (c: Compte, l: Omit<Ligne, 'id'>) => {
    const [f] = await sql<{ id: number }[]>`
      INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, s3_bucket, original_filename, filename, mime_type, retained_title,
                               document_type_code, rubric_code, document_date, uploaded_at, upload_status)
      VALUES (${c.ownerUserId}, ${c.id}, ${l.bien}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'e2e-bucket',
              ${`${l.titre}.pdf`}, ${`${l.titre}.pdf`}, 'application/pdf',
              ${l.titre}, ${l.type}, ${l.rubrique}, ${l.doc}::date, ${l.ajout}::timestamptz, 'COMPLETED')
      RETURNING id`;
    if (c === moi) lignes.push({ id: f.id, ...l });
    return f.id;
  };

  const get = async (c: Compte, qs: string): Promise<{ status: number; body: FeedBody }> => {
    as(c);
    const { GET } = await import('@/app/api/v2/documents/route');
    const r = await GET(new NextRequest(`http://x/api/v2/documents?${qs}`));
    return { status: r.status, body: await r.json() as FeedBody };
  };
  /** Tous les identifiants d'une requête, lot après lot (curseur). */
  const tout = async (qs: string, limit = 100) => {
    const vus: number[] = [];
    let cursor: string | null = null;
    let total = -1;
    let appels = 0;
    do {
      const { status, body } = await get(moi, `${qs}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(status).toBe(200);
      if (body.meta) total = body.meta.total;
      vus.push(...body.documents.map((d) => d.id));
      cursor = body.nextCursor;
      appels += 1;
      expect(appels).toBeLessThan(100);
    } while (cursor);
    return { vus, total };
  };
  const attendus = (pred: (l: Ligne) => boolean) => tri(lignes.filter(pred).map((l) => l.id));

  it('prépare deux comptes, des dates aux frontières (bissextile, minuit de Paris, fin d’année)', async () => {
    moi = await make.account();
    autre = await make.account();
    maison = (await make.asset(moi, { name: 'Maison' })).id;
    voiture = (await make.asset(moi, { name: 'Voiture' })).id;
    // Facture datée de 2022, ajoutée en 2026 : le cas du ticket.
    ids.facture2022 = await inserer(moi, { doc: '2022-06-15', ajout: '2026-03-10 09:00:00+01', bien: maison, rubrique: 'MAINTENANCE_WORKS', type: 'INVOICE', titre: 'Facture chaudière Viessmann' });
    ids.recente = await inserer(moi, { doc: '2026-01-05', ajout: '2026-01-06 10:00:00+01', bien: maison, rubrique: 'MAINTENANCE_WORKS', type: 'INVOICE', titre: 'Facture ramonage' });
    // Ajout le 31/12/2025 à 23:30 UTC = 01/01/2026 00:30 à Paris.
    ids.minuitHiver = await inserer(moi, { doc: null, ajout: '2025-12-31 23:30:00+00', bien: voiture, rubrique: null, type: null, titre: 'Scan sans date' });
    ids.bissextile = await inserer(moi, { doc: '2024-02-29', ajout: '2024-03-01 12:00:00+01', bien: voiture, rubrique: 'PROPERTY_MANAGEMENT', type: 'INVOICE', titre: 'Facture entretien voiture' });
    // Ajout le 30/06/2026 à 22:30 UTC = 01/07/2026 00:30 à Paris (heure d'été).
    ids.minuitEte = await inserer(moi, { doc: '2025-12-31', ajout: '2026-06-30 22:30:00+00', bien: null, rubrique: 'MAINTENANCE_WORKS', type: 'QUOTE', titre: 'Devis toiture' });
    // Volume pour la pagination : égalités de dates et dates absentes.
    for (let i = 0; i < 26; i += 1) {
      await inserer(moi, {
        doc: i % 4 === 0 ? null : `2022-0${1 + (i % 3)}-1${i % 2}`,
        ajout: `2026-0${1 + (i % 5)}-15 08:00:00.123456+01`,
        bien: i % 3 === 0 ? voiture : maison,
        rubrique: i % 2 ? 'MAINTENANCE_WORKS' : null,
        type: i % 3 ? 'INVOICE' : null,
        titre: i % 5 === 0 ? `Facture chaudière ${i}` : `Document ${i}`,
      });
    }
    // Autre compte, mêmes dates : jamais listé.
    ids.autre = await inserer(autre, { doc: '2022-06-15', ajout: '2026-03-10 09:00:00+01', bien: null, rubrique: null, type: 'INVOICE', titre: 'Facture chaudière autre' });
  });

  it('aucune restriction temporelle par défaut : documents anciens et sans date visibles, compteur exact', async () => {
    const r = await tout('sort=added&direction=desc');
    expect(tri(r.vus)).toEqual(tri(lignes.map((l) => l.id)));
    expect(r.total).toBe(lignes.length);
    expect(r.vus).not.toContain(ids.autre);
  });

  it('facture 2022 ajoutée en 2026 : retrouvée par « Date du document : 2022 » ET « Date d’ajout : 2026 », dates indépendantes', async () => {
    const doc2022 = await tout('sort=added&direction=desc&docFrom=2022-01-01&docTo=2022-12-31');
    expect(doc2022.vus).toContain(ids.facture2022);
    expect(tri(doc2022.vus)).toEqual(attendus((l) => !!l.doc && l.doc >= '2022-01-01' && l.doc <= '2022-12-31'));
    const ajout2026 = await tout('sort=added&direction=desc&addedFrom=2026-01-01&addedTo=2026-12-31');
    expect(ajout2026.vus).toContain(ids.facture2022);
    expect(ajout2026.vus).not.toContain(ids.bissextile);
    // Intersection des deux dates.
    const lesDeux = await tout('sort=added&direction=desc&docFrom=2022-01-01&docTo=2022-12-31&addedFrom=2026-03-01&addedTo=2026-03-31');
    const attenduLesDeux = attendus((l) => !!l.doc && l.doc.startsWith('2022') && l.ajout.startsWith('2026-03'));
    expect(lesDeux.vus).toContain(ids.facture2022);
    expect(tri(lesDeux.vus)).toEqual(attenduLesDeux);
    expect(lesDeux.total).toBe(attenduLesDeux.length);
    // Date du document 2026 : la facture n'y est pas (elle est datée de 2022).
    expect((await tout('sort=added&direction=desc&docFrom=2026-01-01&docTo=2026-12-31')).vus).not.toContain(ids.facture2022);
    // Isolation : l'autre compte, mêmes dates, n'apparaît jamais.
    expect(lesDeux.vus).not.toContain(ids.autre);
  });

  it('bornes inclusives, borne unique, 29 février', async () => {
    expect((await tout('sort=added&direction=desc&docFrom=2022-06-15&docTo=2022-06-15')).vus).toEqual([ids.facture2022]);
    expect((await tout('sort=added&direction=desc&docFrom=2022-06-16&docTo=2022-12-31')).vus).not.toContain(ids.facture2022);
    expect(tri((await tout('sort=added&direction=desc&docFrom=2025-12-31')).vus)).toEqual(attendus((l) => !!l.doc && l.doc >= '2025-12-31'));
    expect(tri((await tout('sort=added&direction=desc&docTo=2022-01-10')).vus)).toEqual(attendus((l) => !!l.doc && l.doc <= '2022-01-10'));
    expect((await tout('sort=added&direction=desc&docFrom=2024-02-29&docTo=2024-02-29')).vus).toEqual([ids.bissextile]);
    expect((await tout('sort=added&direction=desc&addedFrom=2024-03-01&addedTo=2024-03-01')).vus).toEqual([ids.bissextile]);
  });

  it('date d’ajout : jours de Paris, jamais de décalage UTC (hiver et été)', async () => {
    // 00:30 à Paris le 01/01/2026 : dans 2026, pas dans 2025.
    expect((await tout('sort=added&direction=desc&addedFrom=2026-01-01&addedTo=2026-01-01')).vus).toEqual([ids.minuitHiver]);
    expect((await tout('sort=added&direction=desc&addedFrom=2025-01-01&addedTo=2025-12-31')).vus).not.toContain(ids.minuitHiver);
    // 00:30 à Paris le 01/07/2026 (UTC+2) : en juillet, pas en juin.
    expect((await tout('sort=added&direction=desc&addedFrom=2026-07-01')).vus).toEqual([ids.minuitEte]);
    expect((await tout('sort=added&direction=desc&addedFrom=2026-06-01&addedTo=2026-06-30')).vus).not.toContain(ids.minuitEte);
  });

  it('« Sans date » : seulement les documents sans date du document ; compteur cohérent', async () => {
    const r = await tout('sort=docDate&direction=desc&docNone=1', 4);
    expect(tri(r.vus)).toEqual(attendus((l) => l.doc === null));
    expect(r.total).toBe(r.vus.length);
    expect(r.vus).toContain(ids.minuitHiver);
  });

  it('intersection avec bien + rubrique + type + recherche locale + deux dates ; compteurs des pastilles inchangés', async () => {
    const qs = `sort=docDate&direction=desc&biens=${maison}&rubrics=MAINTENANCE_WORKS&types=INVOICE&q=chaudi%C3%A8re`
      + '&docFrom=2022-01-01&docTo=2022-12-31&addedFrom=2026-01-01&addedTo=2026-12-31';
    const r = await tout(qs, 2);
    const attendu = attendus((l) => l.bien === maison && l.rubrique === 'MAINTENANCE_WORKS' && l.type === 'INVOICE'
      && /chaudière/i.test(l.titre) && !!l.doc && l.doc.startsWith('2022') && l.ajout.startsWith('2026'));
    expect(attendu.length).toBeGreaterThan(0);
    expect(tri(r.vus)).toEqual(attendu);
    expect(new Set(r.vus).size).toBe(r.vus.length);
    expect(r.total).toBe(attendu.length);
    // Pastilles « Bien » : comptées sur le périmètre (recherche comprise), autres filtres ignorés.
    const { body } = await get(moi, `${qs}&limit=50`);
    const perimetreRecherche = (await tout('sort=added&direction=desc&q=chaudi%C3%A8re')).vus;
    const parMaison = lignes.filter((l) => perimetreRecherche.includes(l.id) && l.bien === maison).length;
    expect(body.meta!.facets.biens.find((b) => b.value === String(maison))?.count).toBe(parMaison);
    expect(body.meta!.scopeTotal).toBe(perimetreRecherche.length);
  });

  const parcours: Array<[FeedSort, FeedDirection]> = [['docDate', 'desc'], ['docDate', 'asc'], ['added', 'desc'], ['added', 'asc']];
  for (const [sort, direction] of parcours) {
    it(`tri ${sort} ${direction} avec filtres temporels : pagination stable, ni doublon ni oubli, dates absentes en dernier`, async () => {
      const qs = `sort=${sort}&direction=${direction}&addedFrom=2026-01-01&addedTo=2026-12-31`;
      const petit = await tout(qs, 3);
      const grand = await tout(qs, 100);
      expect(petit.vus).toEqual(grand.vus);
      expect(new Set(petit.vus).size).toBe(petit.vus.length);
      // Ajoutés en 2026 (jours de Paris) : tous sauf la facture de 2024.
      expect(tri(petit.vus)).toEqual(attendus((l) => l.id !== ids.bissextile));
      expect(petit.total).toBe(petit.vus.length);
      const parId = new Map(lignes.map((l) => [l.id, l]));
      if (sort === 'docDate') {
        const dates = petit.vus.map((id) => parId.get(id)!.doc);
        const premiere = dates.indexOf(null);
        expect(premiere).toBeGreaterThan(0);
        expect(dates.slice(premiere).every((d) => d === null)).toBe(true);
        const presentes = dates.slice(0, premiere) as string[];
        expect(presentes).toEqual(direction === 'asc' ? [...presentes].sort() : [...presentes].sort().reverse());
      }
    });
  }

  it('tri regroupé par rubrique + filtre date : mêmes documents, même ordre quel que soit le lot', async () => {
    const qs = 'sort=docDate&direction=asc&grouped=1&docFrom=2022-01-01&docTo=2022-12-31';
    expect((await tout(qs, 4)).vus).toEqual((await tout(qs, 100)).vus);
  });

  it('période refusée : 400, aucune liste élargie', async () => {
    const r = await get(moi, 'sort=added&direction=desc&docFrom=2025-02-01&docTo=2025-01-01');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'INVALID_DATE_RANGE', code: 'START_AFTER_END' });
    expect((await get(moi, 'sort=added&direction=desc&addedFrom=2026-02-30')).status).toBe(400);
  });

  it('isolation : l’autre compte ne voit que son document', async () => {
    const r = await get(autre, 'sort=added&direction=desc&docFrom=2022-01-01&docTo=2022-12-31&limit=50');
    expect(r.body.documents.map((d) => d.id)).toEqual([ids.autre]);
  });

  // ── Provenance de la date du document et date d'ajout figée ──────────────

  const fichier = async (id: number) => (await sql<{ document_date: string | null; uploaded_at: string; ue: Record<string, boolean> | null; retained_title: string | null; asset_id: number | null }[]>`
    SELECT document_date::text AS document_date, uploaded_at::text AS uploaded_at, user_edited_fields AS ue, retained_title, asset_id
      FROM asset_files WHERE id = ${id}`)[0];
  const analyser = async (id: number, date: { value: string; confidence: 'certain' | 'conflictual' }) => {
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${id}`;
    const sortie = sortieT1({ title: 'Facture chaudière Viessmann mars 2022', date: date.value, documentTypeCode: 'INVOICE', rubricCode: 'MAINTENANCE_WORKS', assets: [], facts: [] });
    (sortie.document as Record<string, { confidence: string }>).documentDate.confidence = date.confidence;
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortie, repeat: true }]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([id], moi.id, { userId: moi.ownerUserId, billable: false, origin: 'e2e/l103f' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${id} en échec`);
    await drainQueues();
  };
  const enregistrer = async (id: number, body: Record<string, unknown>) => {
    as(moi);
    const { PUT } = await import('@/app/api/documents/[id]/route');
    const res = await PUT(new NextRequest(`http://x/api/documents/${id}`, { method: 'PUT', body: JSON.stringify({ documentType: 'AUTRE', ...body }) }),
      { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(200);
  };

  it('correction manuelle prioritaire sur T1 ; renommer, déplacer, détacher, réanalyser : la date d’ajout ne change jamais', async () => {
    const id = await inserer(moi, { doc: null, ajout: '2026-02-10 08:00:00+01', bien: null, rubrique: null, type: null, titre: 'scan-0042.pdf' });
    const ajout = (await fichier(id)).uploaded_at;
    // Correction AVANT toute analyse (le tiroir ne marque alors rien) + renommage + déplacement.
    await enregistrer(id, { fileName: 'Facture chaudière corrigée', retainedTitle: 'Facture chaudière corrigée', documentDate: '2021-11-30', assetId: maison, userEditedFields: {} });
    expect(await fichier(id)).toMatchObject({ document_date: '2021-11-30', uploaded_at: ajout, asset_id: maison });
    expect((await fichier(id)).ue?.documentDate).toBe(true);
    // Analyse T1 qui lit une autre date : la correction reste.
    await analyser(id, { value: '2022-03-14', confidence: 'certain' });
    expect(await fichier(id)).toMatchObject({ document_date: '2021-11-30', uploaded_at: ajout });
    // Détachement puis réanalyse : rien ne bouge.
    await sql`UPDATE asset_files SET analysis_state = NULL WHERE id = ${id}`;
    await enregistrer(id, { fileName: 'Facture chaudière corrigée', retainedTitle: 'Facture chaudière corrigée', documentDate: '2021-11-30', assetId: null, userEditedFields: { documentDate: true } });
    await analyser(id, { value: '2022-03-14', confidence: 'certain' });
    expect(await fichier(id)).toMatchObject({ document_date: '2021-11-30', uploaded_at: ajout, asset_id: null });
    // Les résultats suivent la correction aussitôt.
    expect((await tout('sort=added&direction=desc&docFrom=2021-11-30&docTo=2021-11-30')).vus).toEqual([id]);
    expect((await tout('sort=added&direction=desc&docFrom=2022-03-14&docTo=2022-03-14')).vus).not.toContain(id);
    expect((await tout('sort=added&direction=desc&addedFrom=2026-02-10&addedTo=2026-02-10')).vus).toContain(id);
  });

  it('date T1 certaine posée ; date contradictoire jamais posée comme certaine (le document reste « Sans date »)', async () => {
    const sure = await inserer(moi, { doc: null, ajout: '2026-04-01 08:00:00+02', bien: null, rubrique: null, type: null, titre: 'scan-0100.pdf' });
    await analyser(sure, { value: '2022-03-14', confidence: 'certain' });
    expect((await fichier(sure)).document_date).toBe('2022-03-14');
    const douteuse = await inserer(moi, { doc: null, ajout: '2026-04-01 08:00:00+02', bien: null, rubrique: null, type: null, titre: 'scan-0101.pdf' });
    await analyser(douteuse, { value: '2022-03-14', confidence: 'conflictual' });
    expect((await fichier(douteuse)).document_date).toBeNull();
    expect((await tout('sort=added&direction=desc&docNone=1&addedFrom=2026-04-01&addedTo=2026-04-01')).vus).toEqual([douteuse]);
    expect((await fichier(douteuse)).uploaded_at).toBe((await fichier(sure)).uploaded_at);
  });
});
