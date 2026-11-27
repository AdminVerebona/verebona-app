/**
 * Carte #851 — audit de performance : défaut d'exactitude ET de coût des
 * sous-requêtes corrélées placées dans la liste SELECT d'une requête Drizzle
 * SANS jointure (PostgreSQL réel).
 *
 * Dans ce cas Drizzle rend `${assetFiles.id}` par `"id"` (sans table). Dans la
 * sous-requête, PostgreSQL résout ce nom nu sur la table la plus proche qui
 * possède la colonne : `document_asset_links.id`, `assets.account_id`,
 * `legal_acceptances.id`… La condition ne portait donc plus sur la ligne
 * externe : parcours complet des tables à chaque ligne (accueil : 3,7 s pour
 * 4 000 documents, 11 s avec 20 000 biens sur la plateforme) et résultats faux.
 *
 * Données construites pour que le défaut se voie de façon déterministe : un
 * lien `document_asset_links` dont l'identifiant ÉGALE celui de son fichier
 * (c'est la seule ligne que l'ancienne condition `dal.file_id = dal.id`
 * retenait) — l'un dans le compte A (bien a2), l'autre dans le compte B (b1).
 *
 *   C851-E2E-01  expression OTHER_ASSET_IDS_SQL (requête sans jointure, forme de
 *                l'accueil) : valeurs exactes, AUCUN bien d'un autre compte ;
 *   C851-E2E-02  accueil (`buildHomeSummary`, vrai chemin) : nombre de
 *                documents par bien exact (= liste du bien) ;
 *   C851-E2E-03  liste groupée (`listDocumentsGrouped`, /api/documents/browse) :
 *                biens et équipements rattachés exacts ;
 *   C851-E2E-04  BO CGVU (`listCguvReferential`) : nombre d'acceptations exact ;
 *   C851-E2E-05  coût : la sous-requête ne lit plus toute la table des liens
 *                (plan PostgreSQL : aucun parcours séquentiel de
 *                document_asset_links répété par document).
 *
 * Sur HEAD 62ce15c (avant correctif) : 01 à 05 sont ROUGES (01 : b1 du compte B
 * présent ; 02 : a2 compte tous les documents du compte ; 03 : a2 ajouté à un
 * document qui ne le concerne pas, équipement lié absent ; 04 : 0 acceptation).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { scenario } from '../scenario';

interface Jeu {
  a: number; b: number; a1: number; a2: number; b1: number; eA: number;
  dA1: number; dForceA: number; dForceB: number; dA3: number;
}

/** Documents (objets portant `associations`) d'une réponse, à toute profondeur. */
function documentsDe(v: unknown, out: Array<{ id: number; associations: { assets: Array<{ id: number }>; elements: Array<{ id: number }> } }> = []) {
  if (Array.isArray(v)) { for (const x of v) documentsDe(x, out); return out; }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'number' && o.associations && typeof o.associations === 'object') out.push(o as never);
    for (const x of Object.values(o)) documentsDe(x, out);
  }
  return out;
}

scenario('C851', 'Références qualifiées des sous-requêtes corrélées (accueil, documents, BO CGVU)', ({ sql, make }) => {
  const j = {} as Jeu;

  beforeAll(async () => {
    const A = await make.account({ plan: 'premium' });
    const B = await make.account({ plan: 'premium' });
    j.a = A.id; j.b = B.id;
    j.a1 = (await make.asset(A, { category: 'IMMOBILIER', name: 'Maison A1' })).id;
    j.a2 = (await make.asset(A, { category: 'VEHICULE', name: 'Voiture A2' })).id;
    j.b1 = (await make.asset(B, { category: 'IMMOBILIER', name: 'Maison B1 (autre compte)' })).id;
    const [e] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${j.a1}, 'Chaudière A1') RETURNING id`;
    j.eA = e.id;
    // dA1 : document du seul bien a1 (lien principal posé par le déclencheur).
    j.dA1 = (await make.assetFile(A, { assetId: j.a1, name: 'facture-a1.pdf' })).id;
    // dA3 : document de a1 qui concerne AUSSI l'équipement eA (lien SECONDARY).
    j.dA3 = (await make.assetFile(A, { assetId: j.a1, name: 'entretien-chaudiere.pdf' })).id;
    await sql`INSERT INTO document_asset_links (account_id, file_id, equipment_id, link_role, origin, status)
              VALUES (${j.a}, ${j.dA3}, ${j.eA}, 'SECONDARY', 'USER', 'ACTIVE')`;
    // Liens dont l'identifiant égale celui du fichier (A → a2, B → b1).
    j.dForceA = 900001; j.dForceB = 900002;
    for (const [id, acc, user, bien] of [[j.dForceA, j.a, A.ownerUserId, j.a2], [j.dForceB, j.b, B.ownerUserId, j.b1]]) {
      await sql`INSERT INTO asset_files (id, user_id, account_id, asset_id, s3_key, mime_type)
                VALUES (${id}, ${user}, ${acc}, NULL, ${`e2e/c851/${id}.pdf`}, 'application/pdf')`;
      await sql`INSERT INTO document_asset_links (id, account_id, file_id, asset_id, link_role, origin, status)
                VALUES (${id}, ${acc}, ${id}, ${bien}, 'PRIMARY', 'USER', 'ACTIVE')`;
    }
  });

  describe('C851-E2E-01 — OTHER_ASSET_IDS_SQL sans jointure', () => {
    it('valeurs exactes par document, aucun bien d’un autre compte', async () => {
      const { db } = await import('@/db');
      const { assetFiles } = await import('@/db/schema');
      const { eq } = await import('drizzle-orm');
      const { OTHER_ASSET_IDS_SQL } = await import('@/services/documents/asset-document-scope');
      const lignes = await db.select({ id: assetFiles.id, autres: OTHER_ASSET_IDS_SQL }).from(assetFiles)
        .where(eq(assetFiles.accountId, j.a));
      const parId = new Map(lignes.map((l) => [l.id, (l.autres as unknown as number[]).map(Number)]));
      expect(parId.get(j.dA1)).toEqual([]);
      expect(parId.get(j.dA3)).toEqual([]);
      expect(parId.get(j.dForceA)).toEqual([j.a2]);
      for (const autres of parId.values()) expect(autres).not.toContain(j.b1);
    });

    it('mêmes valeurs que la forme avec jointure (référence, déjà exacte avant #851)', async () => {
      const { db } = await import('@/db');
      const { assetFiles, assets } = await import('@/db/schema');
      const { and, eq } = await import('drizzle-orm');
      const { OTHER_ASSET_IDS_SQL } = await import('@/services/documents/asset-document-scope');
      const seule = await db.select({ id: assetFiles.id, autres: OTHER_ASSET_IDS_SQL }).from(assetFiles)
        .where(eq(assetFiles.accountId, j.a)).orderBy(assetFiles.id);
      const jointe = await db.select({ id: assetFiles.id, autres: OTHER_ASSET_IDS_SQL }).from(assetFiles)
        .leftJoin(assets, and(eq(assetFiles.assetId, assets.id), eq(assets.accountId, assetFiles.accountId)))
        .where(eq(assetFiles.accountId, j.a)).orderBy(assetFiles.id);
      expect(seule).toEqual(jointe);
    });
  });

  describe('C851-E2E-02 — accueil', () => {
    it('nombre de documents par bien = documents rattachés au bien', async () => {
      const { buildHomeSummary } = await import('@/services/home/HomeSummaryService');
      const resume = await buildHomeSummary(j.a);
      const parBien = new Map(resume.assets.items.map((x) => [x.id, x.documentCount]));
      expect(parBien.get(j.a1)).toBe(2); // dA1, dA3
      expect(parBien.get(j.a2)).toBe(1); // dForceA
      expect([...parBien.keys()]).not.toContain(j.b1);
    });
  });

  describe('C851-E2E-03 — liste groupée des documents', () => {
    it('biens et équipements rattachés exacts, rien d’un autre compte', async () => {
      const { listDocumentsGrouped } = await import('@/services/documents/document-query.service');
      const docs = documentsDe(await listDocumentsGrouped({ accountId: j.a } as never));
      const de = (id: number) => docs.find((d) => d.id === id)!;
      expect(de(j.dA1).associations.assets.map((x) => x.id)).toEqual([j.a1]);
      expect(de(j.dForceA).associations.assets.map((x) => x.id)).toEqual([j.a2]);
      expect(de(j.dA3).associations.elements.map((x) => x.id)).toEqual([j.eA]);
      for (const d of docs) expect(d.associations.assets.map((x) => x.id)).not.toContain(j.b1);
    });
  });

  describe('C851-E2E-04 — BO CGVU', () => {
    it('nombre d’acceptations exact par version', async () => {
      const [v] = await sql<{ id: string }[]>`
        INSERT INTO legal_document_versions (version_code, title, change_summary, status, source, published_at, effective_at, sha256, permalink)
        VALUES ('c851-v1', 'CGVU c851', 'essai', 'ARCHIVED', 'PUBLIC_SITE', now(), now(), 'c851', 'https://exemple.invalid/c851')
        RETURNING id`;
      await sql`INSERT INTO legal_acceptances (legal_document_version_id, acceptance_context)
                VALUES (${v.id}, 'ACCOUNT_CREATION'), (${v.id}, 'VERSION_UPDATE')`;
      const { listCguvReferential } = await import('@/services/legal/cguv-referential.service');
      const ligne = (await listCguvReferential()).find((r) => r.versionCode === 'c851-v1');
      expect(ligne?.acceptances).toBe(2);
    });
  });

  describe('C851-E2E-05 — coût de la sous-requête', () => {
    it('aucun parcours séquentiel de document_asset_links répété par document', async () => {
      const { db, pgClient } = await import('@/db');
      const { assetFiles } = await import('@/db/schema');
      const { eq } = await import('drizzle-orm');
      const { OTHER_ASSET_IDS_SQL } = await import('@/services/documents/asset-document-scope');
      // Volume : 300 documents et leurs liens, pour que le planificateur préfère l'index.
      await sql`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type)
                SELECT owner_user_id, ${j.a}, ${j.a1}, 'e2e/c851/v' || g, 'application/pdf'
                FROM accounts, generate_series(1, 300) g WHERE accounts.id = ${j.a}`;
      await sql`ANALYZE asset_files`;
      await sql`ANALYZE document_asset_links`;
      const q = db.select({ id: assetFiles.id, autres: OTHER_ASSET_IDS_SQL }).from(assetFiles)
        .where(eq(assetFiles.accountId, j.a)).toSQL();
      const plan = (await pgClient.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${q.sql}`, q.params as never[])) as unknown as Array<{ 'QUERY PLAN': unknown }>;
      const noeuds: Array<Record<string, unknown>> = [];
      const parcourir = (n: Record<string, unknown>) => { noeuds.push(n); for (const p of (n.Plans as Array<Record<string, unknown>>) ?? []) parcourir(p); };
      parcourir((plan[0]['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)[0].Plan);
      const seqRepetes = noeuds.filter((n) => n['Node Type'] === 'Seq Scan'
        && (n['Relation Name'] === 'document_asset_links' || n['Relation Name'] === 'assets')
        && Number(n['Actual Loops']) > 1);
      expect(seqRepetes).toEqual([]);
    });
  });
});
