/**
 * DOC-PERF — chargement progressif des documents, sur PostgreSQL réel.
 *
 * La pagination par curseur ne vaut que si la condition « après le curseur »
 * traduite en SQL respecte EXACTEMENT l'ordre du `ORDER BY` : égalités de
 * date à la microseconde, dates absentes (`NULLS LAST` dans les deux sens),
 * titres identiques, Rubriques inconnues, regroupement. Le scénario parcourt
 * chaque tri par petits lots et vérifie : aucun doublon, aucun oubli, même
 * ordre quelle que soit la taille des lots, compteurs globaux exacts,
 * périmètre limité au compte, curseur d'un autre tri refusé.
 */
import { expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { FeedDirection, FeedFilters, FeedSort } from '@/lib/documents/document-feed';

const AUCUN_FILTRE: FeedFilters = { biens: [], rubrics: [], types: [] };

scenario('DOC-PERF', 'Chargement progressif : pagination par curseur et compteurs globaux', ({ sql, make }) => {
  let accountId = 0;
  let assetId = 0;
  let autreCompteFileId = 0;
  const ids: number[] = [];

  it('prépare un périmètre riche en égalités et en valeurs absentes', async () => {
    const compte = await make.account();
    const autre = await make.account();
    accountId = compte.id;
    const bienA = await make.asset(compte, { name: 'Appartement Lyon' });
    const bienB = await make.asset(compte, { name: 'vélo cargo' });
    assetId = bienA.id;
    const rubriques = [null, 'PROPERTY_MANAGEMENT', 'MAINTENANCE_WORKS', 'MEDIA', 'LEGACY_X', 'OTHER_DOCUMENTS'];
    const types = [null, 'INVOICE', 'QUOTE'];
    for (let i = 0; i < 64; i += 1) {
      const f = await make.assetFile(compte, { assetId: i % 5 === 0 ? null : (i % 2 ? bienA.id : bienB.id) });
      ids.push(f.id);
      // Quatre dates d'ajout seulement, identiques à la microseconde : la
      // frontière entre deux lots tombe forcément au milieu d'une égalité.
      await sql`
        UPDATE asset_files SET
          uploaded_at = ${`2025-0${1 + (i % 4)}-01 10:00:00.123456+00`}::timestamptz,
          document_date = ${i % 3 === 0 ? null : `2024-0${1 + (i % 6)}-15`}::date,
          retained_title = ${i % 7 === 0 ? null : `Document ${i % 9}`},
          original_filename = ${`scan-${i}.pdf`},
          rubric_code = ${rubriques[i % rubriques.length]},
          document_type_code = ${types[i % types.length]}
        WHERE id = ${f.id}`;
    }
    // Supprimé : jamais listé ni compté.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${ids[3]}`;
    // Autre compte : invisible.
    autreCompteFileId = (await make.assetFile(autre, {})).id;
  });

  async function parcourir(opts: {
    sort: FeedSort; direction: FeedDirection; grouped: boolean; limit: number;
    filters?: FeedFilters; assetIds?: number[]; ids?: number[] | null;
  }) {
    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    const vus: number[] = [];
    let cursor: string | null = null;
    let total = -1;
    let appels = 0;
    do {
      const page = await getDocumentFeed({
        accountId, assetIds: opts.assetIds ?? [], sort: opts.sort, direction: opts.direction,
        grouped: opts.grouped, filters: opts.filters ?? AUCUN_FILTRE, ids: opts.ids ?? null,
        limit: opts.limit, cursor,
      });
      appels += 1;
      if (page.meta) total = page.meta.total;
      expect(page.documents.length).toBeLessThanOrEqual(opts.limit);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      vus.push(...page.documents.map((d) => d.id));
      cursor = page.nextCursor;
      expect(appels).toBeLessThan(200);
    } while (cursor);
    return { vus, total, appels };
  }

  const vivants = () => ids.filter((id) => id !== ids[3]);

  for (const grouped of [false, true]) {
    for (const sort of ['added', 'docDate', 'title', 'bien', 'rubric'] as FeedSort[]) {
      for (const direction of ['desc', 'asc'] as FeedDirection[]) {
        it(`${sort} ${direction}${grouped ? ' regroupé' : ''} : ni doublon ni oubli, ordre stable`, async () => {
          const petit = await parcourir({ sort, direction, grouped, limit: 7 });
          const grand = await parcourir({ sort, direction, grouped, limit: 100 });
          expect(new Set(petit.vus).size).toBe(petit.vus.length);
          expect([...petit.vus].sort((a, b) => a - b)).toEqual(vivants().sort((a, b) => a - b));
          expect(petit.vus).toEqual(grand.vus);
          expect(petit.total).toBe(vivants().length);
          expect(grand.appels).toBe(1);
          expect(petit.vus).not.toContain(autreCompteFileId);
        });
      }
    }
  }

  it('regroupé : « Sans rubrique » d’abord, puis l’ordre du référentiel, code inconnu en dernier', async () => {
    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    const page = await getDocumentFeed({
      accountId, assetIds: [], sort: 'added', direction: 'desc', grouped: true,
      filters: AUCUN_FILTRE, ids: null, limit: 100, cursor: null,
    });
    const sections = [...new Set(page.documents.map((d) => d.rubricCode ?? '__UNFILED__'))];
    expect(sections).toEqual(['__UNFILED__', 'PROPERTY_MANAGEMENT', 'MAINTENANCE_WORKS', 'MEDIA', 'OTHER_DOCUMENTS', 'LEGACY_X']);
    // Dans chaque section, l'ordre global (date d'ajout décroissante).
    for (const code of sections) {
      const dates = page.documents.filter((d) => (d.rubricCode ?? '__UNFILED__') === code).map((d) => d.uploadedAt!);
      expect(dates).toEqual([...dates].sort().reverse());
    }
  });

  it('date du document : les dates absentes en dernier, dans les deux sens', async () => {
    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    for (const direction of ['asc', 'desc'] as FeedDirection[]) {
      const page = await getDocumentFeed({
        accountId, assetIds: [], sort: 'docDate', direction, grouped: false,
        filters: AUCUN_FILTRE, ids: null, limit: 100, cursor: null,
      });
      const dates = page.documents.map((d) => d.documentDate);
      const premiereAbsente = dates.indexOf(null);
      expect(premiereAbsente).toBeGreaterThan(0);
      expect(dates.slice(premiereAbsente).every((d) => d === null)).toBe(true);
      const presentes = dates.slice(0, premiereAbsente) as string[];
      expect(presentes).toEqual(direction === 'asc' ? [...presentes].sort() : [...presentes].sort().reverse());
    }
  });

  it('filtres et recherche appliqués côté serveur, compteurs globaux', async () => {
    const filters: FeedFilters = { biens: [], rubrics: ['__UNFILED__', 'MEDIA'], types: ['__NO_TYPE__'] };
    const r = await parcourir({ sort: 'title', direction: 'asc', grouped: false, limit: 5, filters });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM asset_files
      WHERE account_id = ${accountId} AND deleted_at IS NULL
        AND (rubric_code IS NULL OR rubric_code = 'MEDIA') AND document_type_code IS NULL`;
    expect(r.vus.length).toBe(n);
    expect(r.total).toBe(n);

    const sansBien = await parcourir({ sort: 'added', direction: 'desc', grouped: true, limit: 4, filters: { biens: ['__NO_ASSET__'], rubrics: [], types: [] } });
    const [{ m }] = await sql<{ m: number }[]>`
      SELECT COUNT(*)::int AS m FROM asset_files WHERE account_id = ${accountId} AND deleted_at IS NULL AND asset_id IS NULL`;
    expect(sansBien.vus.length).toBe(m);

    const recherche = await parcourir({ sort: 'added', direction: 'desc', grouped: false, limit: 2, ids: [ids[0], ids[1], ids[3], autreCompteFileId] });
    expect(recherche.vus.sort((a, b) => a - b)).toEqual([ids[0], ids[1]].sort((a, b) => a - b));
    expect((await parcourir({ sort: 'added', direction: 'desc', grouped: false, limit: 2, ids: [] })).vus).toEqual([]);
  });

  it('compteurs : total, Rubriques et options de filtre portent sur l’ensemble, pas sur le lot', async () => {
    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    const page = await getDocumentFeed({
      accountId, assetIds: [], sort: 'added', direction: 'desc', grouped: true,
      filters: { biens: [], rubrics: [], types: ['INVOICE'] }, ids: null, limit: 3, cursor: null,
    });
    const meta = page.meta!;
    expect(page.documents).toHaveLength(3);
    expect(meta.scopeTotal).toBe(vivants().length);
    expect(meta.total).toBeGreaterThan(3);
    expect(meta.rubrics.reduce((s, r) => s + r.count, 0) + meta.unfiledCount).toBe(meta.total);
    expect(meta.rubrics.map((r) => r.code)).toContain('LEGACY_X');
    // Options comptées sur le périmètre, filtre Type ignoré.
    expect(meta.facets.types.reduce((s, t) => s + t.count, 0)).toBe(meta.scopeTotal);
    expect(meta.facets.biens.find((b) => b.value === String(assetId))?.label).toBe('Appartement Lyon');
    // Lot suivant : sans compteurs (déjà connus).
    const suite = await getDocumentFeed({
      accountId, assetIds: [], sort: 'added', direction: 'desc', grouped: true,
      filters: { biens: [], rubrics: [], types: ['INVOICE'] }, ids: null, limit: 3, cursor: page.nextCursor,
    });
    expect(suite.meta).toBeUndefined();
  });

  it('onglet d’un bien : périmètre du bien seul', async () => {
    const r = await parcourir({ sort: 'added', direction: 'desc', grouped: true, limit: 6, assetIds: [assetId] });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM asset_files
      WHERE account_id = ${accountId} AND deleted_at IS NULL AND (asset_id = ${assetId} OR linked_asset_id = ${assetId})`;
    expect(r.vus.length).toBe(n);
    expect(r.total).toBe(n);
  });

  it('curseur illisible ou d’un autre tri : refusé, jamais interprété', async () => {
    const { getDocumentFeed, InvalidCursorError } = await import('@/services/documents/rubric-query.service');
    const base = { accountId, assetIds: [] as number[], grouped: false, filters: AUCUN_FILTRE, ids: null, limit: 5 };
    const page = await getDocumentFeed({ ...base, sort: 'added', direction: 'desc', cursor: null });
    await expect(getDocumentFeed({ ...base, sort: 'title', direction: 'desc', cursor: page.nextCursor }))
      .rejects.toBeInstanceOf(InvalidCursorError);
    await expect(getDocumentFeed({ ...base, sort: 'added', direction: 'desc', cursor: 'pas-un-curseur' }))
      .rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('EXPLAIN ANALYZE des tris principaux (mesure, sans index ajouté)', async () => {
    // Plans relevés pour la recette DB du ticket : le filtre par compte
    // (`asset_files_account_id_deleted_at_idx` / `asset_files_rubric_code_idx`)
    // borne la lecture au périmètre ; le tri s'applique ensuite en mémoire.
    const plans: Record<string, string> = {};
    plans.premierLot = (await sql.unsafe(`
      EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
      SELECT f.id FROM asset_files f LEFT JOIN assets a ON a.id = f.asset_id
      WHERE f.account_id = ${accountId} AND f.deleted_at IS NULL
      ORDER BY f.uploaded_at DESC NULLS LAST, f.id DESC NULLS LAST LIMIT 51`)).map((r) => r['QUERY PLAN']).join('\n');
    plans.lotSuivantDateDocument = (await sql.unsafe(`
      EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
      SELECT f.id FROM asset_files f LEFT JOIN assets a ON a.id = f.asset_id
      WHERE f.account_id = ${accountId} AND f.deleted_at IS NULL
        AND ((f.document_date < '2024-03-15'::date OR f.document_date IS NULL)
          OR (f.document_date = '2024-03-15'::date AND f.uploaded_at < now())
          OR (f.document_date = '2024-03-15'::date AND f.uploaded_at = now() AND f.id < 1000000))
      ORDER BY f.document_date DESC NULLS LAST, f.uploaded_at DESC, f.id DESC LIMIT 51`)).map((r) => r['QUERY PLAN']).join('\n');
    console.info('[DOC-PERF] plans\n' + Object.entries(plans).map(([k, v]) => `-- ${k}\n${v}`).join('\n'));
    expect(plans.premierLot).toMatch(/Limit/);
  });
});
