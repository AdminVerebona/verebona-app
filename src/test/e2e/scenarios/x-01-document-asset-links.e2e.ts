/**
 * X-01 — relation N-N document ↔ bien (CDC 15 X-01, §12, §14 point 8,
 * T1-05 ; plan D-11 ; migration 0221), sur base réelle :
 *   · déclencheur : insertion, modification, suppression logique et
 *     physique d'un document ; liens USER / AI jamais touchés ;
 *   · rattrapage §14.8 idempotent, cas ambigus au rapport ;
 *   · P-T1-04 : facture de deux véhicules → liens PRIMARY / SECONDARY, le
 *     second bien retrouve le document par la relation N-N.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';
import { loadT1Fixture, type T1Fixture } from '@/services/ai/source-analysis/__fixtures__/t1/load';
import type { AnalysisContext, SourceInput } from '@/services/ai/source-analysis/types';

interface LienRow { asset_id: number | null; room_id: number | null; equipment_id: number | null; link_role: string; origin: string; status: string }

scenario('X-01', 'document_asset_links : déclencheur, rattrapage, liens multi-biens', ({ sql, make, useRecordings }) => {
  const liens = async (fileId: number, statut = 'ACTIVE') => sql<LienRow[]>`
    SELECT asset_id, room_id, equipment_id, link_role, origin, status FROM document_asset_links
     WHERE file_id = ${fileId} AND status = ${statut} ORDER BY id`;
  const piece = async (assetId: number, accountId: number) => (await sql<{ id: number }[]>`
    INSERT INTO rooms (asset_id, account_id, name, room_type) VALUES (${assetId}, ${accountId}, 'Cuisine', 'KITCHEN') RETURNING id`)[0].id;

  it('déclencheur : insertion, changement de colonnes, suppression — liens LEGACY_COLUMN seulement', async () => {
    const compte = await make.account();
    const [a1, a2, a3] = [await make.asset(compte), await make.asset(compte), await make.asset(compte)];
    const f = await make.assetFile(compte, { assetId: a1.id });
    expect(await liens(f.id)).toEqual([{ asset_id: a1.id, room_id: null, equipment_id: null, link_role: 'PRIMARY', origin: 'LEGACY_COLUMN', status: 'ACTIVE' }]);

    // Lien secondaire par linked_asset_id, puis pièce.
    await sql`UPDATE asset_files SET linked_asset_id = ${a2.id} WHERE id = ${f.id}`;
    const r = await piece(a2.id, compte.id);
    await sql`UPDATE asset_files SET linked_room_id = ${r} WHERE id = ${f.id}`;
    expect((await liens(f.id)).map((l) => [l.asset_id, l.room_id, l.link_role])).toEqual([
      [a1.id, null, 'PRIMARY'], [a2.id, null, 'SECONDARY'], [a2.id, r, 'SECONDARY'],
    ]);

    // Lien USER posé par le service : jamais touché par le déclencheur.
    const { linkDocumentToAsset, listAssetDocuments } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: f.id, target: { assetId: a3.id }, role: 'SECONDARY', origin: 'USER' });

    // Déplacement : asset_id a1 → a3 (le lien USER vers a3 existe déjà).
    await sql`UPDATE asset_files SET asset_id = ${a3.id}, linked_asset_id = NULL WHERE id = ${f.id}`;
    const actifs = await liens(f.id);
    expect(actifs.map((l) => [l.asset_id, l.room_id, l.origin])).toEqual([
      [a2.id, r, 'LEGACY_COLUMN'], [a3.id, null, 'USER'],
    ]);
    expect((await liens(f.id, 'REMOVED')).map((l) => l.asset_id)).toEqual([a1.id, a2.id]);

    // Une mise à jour sans changement de rattachement ne sollicite pas le déclencheur.
    const avant = await sql`SELECT max(updated_at) AS t FROM document_asset_links WHERE file_id = ${f.id}`;
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED', notes = 'x' WHERE id = ${f.id}`;
    expect((await sql`SELECT max(updated_at) AS t FROM document_asset_links WHERE file_id = ${f.id}`)[0].t).toEqual(avant[0].t);

    // Lecture N-N : le document est visible depuis a2 (pièce) et a3 (USER).
    expect((await listAssetDocuments(compte.id, a2.id)).map((l) => l.fileId)).toEqual([f.id]);
    expect((await listAssetDocuments(compte.id, a3.id)).map((l) => l.origin)).toEqual(['USER']);

    // Suppression logique : liens LEGACY_COLUMN retirés, le lien USER reste.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f.id}`;
    expect((await liens(f.id)).map((l) => l.origin)).toEqual(['USER']);
    // … mais un document supprimé n'est plus listé pour le bien.
    expect(await listAssetDocuments(compte.id, a3.id)).toEqual([]);
    // Restauration : liens reconstitués.
    await sql`UPDATE asset_files SET deleted_at = NULL WHERE id = ${f.id}`;
    expect((await liens(f.id)).map((l) => [l.asset_id, l.origin])).toEqual([[a3.id, 'USER'], [a2.id, 'LEGACY_COLUMN']]);

    // Suppression physique : cascade.
    await sql`DELETE FROM asset_files WHERE id = ${f.id}`;
    expect(await sql`SELECT id FROM document_asset_links WHERE file_id = ${f.id}`).toHaveLength(0);
  });

  it('transaction de 200 documents déplacés : aucune erreur, liens corrects, aucun bloc d’exception', async () => {
    const compte = await make.account();
    const [a1, a2] = [await make.asset(compte), await make.asset(compte)];
    const ids = (await sql<{ id: number }[]>`
      INSERT INTO asset_files (user_id, account_id, asset_id, s3_key)
      SELECT ${compte.ownerUserId}, ${compte.id}, ${a1.id}, 'lot/' || g FROM generate_series(1, 200) g RETURNING id`).map((r) => r.id);
    // Une seule transaction : déplacement des 200, puis suppression logique de 50.
    await sql.begin(async (tx) => {
      await tx`UPDATE asset_files SET asset_id = ${a2.id} WHERE id = ANY(${tx.array(ids)}::int[])`;
      await tx`UPDATE asset_files SET deleted_at = now() WHERE id = ANY(${tx.array(ids.slice(0, 50))}::int[])`;
    });
    const parBien = await sql<{ asset_id: number; n: string }[]>`
      SELECT asset_id, count(*)::text AS n FROM document_asset_links
       WHERE file_id = ANY(${sql.array(ids)}::int[]) AND status = 'ACTIVE' AND origin = 'LEGACY_COLUMN'
       GROUP BY asset_id`;
    expect(parBien.map((r) => [r.asset_id, Number(r.n)])).toEqual([[a2.id, 150]]);
    // Plus aucun bloc EXCEPTION (sous-transaction par ligne) dans le déclencheur.
    const src = await sql<{ prosrc: string }[]>`
      SELECT prosrc FROM pg_proc WHERE proname IN ('document_asset_links_on_asset_files', 'document_asset_links_sync_file')`;
    expect(src).toHaveLength(2);
    for (const { prosrc } of src) expect(prosrc).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it('colonne vers un bien d’un autre compte : aucun lien, aucune erreur', async () => {
    const [c1, c2] = [await make.account(), await make.account()];
    const etranger = await make.asset(c2);
    const f = await make.assetFile(c1, { assetId: etranger.id });
    expect(await liens(f.id)).toEqual([]);
  });

  it('service : cloisonnement par compte', async () => {
    const [c1, c2] = [await make.account(), await make.account()];
    const bienAutre = await make.asset(c2);
    const f = await make.assetFile(c1);
    const { linkDocumentToAsset, DocumentLinkOwnershipError } = await import('@/services/documents/document-asset-links');
    await expect(linkDocumentToAsset({ accountId: c1.id, fileId: f.id, target: { assetId: bienAutre.id }, role: 'SECONDARY', origin: 'USER' }))
      .rejects.toBeInstanceOf(DocumentLinkOwnershipError);
    expect(await liens(f.id)).toEqual([]);
  });

  it('rattrapage §14.8 : colonnes et rattachements confirmés, idempotent, ambigus au rapport', async () => {
    const [compte, autre] = [await make.account(), await make.account()];
    const [a1, a2] = [await make.asset(compte), await make.asset(compte)];
    const etranger = await make.asset(autre);

    // Documents antérieurs à la migration : déclencheur désactivé le temps de les créer.
    await sql`ALTER TABLE asset_files DISABLE TRIGGER asset_files_document_asset_links_ins_del`;
    let f1: { id: number }, f2: { id: number };
    try {
      f1 = await make.assetFile(compte, { assetId: a1.id });
      f2 = await make.assetFile(compte);
    } finally {
      await sql`ALTER TABLE asset_files ENABLE TRIGGER asset_files_document_asset_links_ins_del`;
    }
    expect(await liens(f1.id)).toEqual([]);

    const [run] = await sql<{ id: number }[]>`
      INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, account_id)
      VALUES (${f2.id}, 'h', 'p', 'gemini', 'm', 'completed', ${compte.id}) RETURNING id`;
    const proposition = (code: string, statut: string) => sql`
      INSERT INTO document_analysis_proposals (run_id, asset_file_id, proposal_type, target_key, canonical_code, proposed_value_json, confidence, status, account_id)
      VALUES (${run.id}, ${f2.id}, 'link', 'asset', ${code}, '{}', 'certain', ${statut}, ${compte.id})`;
    await proposition(String(a2.id), 'kept');
    await proposition(String(etranger.id), 'kept');
    await proposition(String(a1.id), 'modified');
    await proposition('999999', 'kept');

    const { backfillDocumentAssetLinks } = await import('@/services/documents/document-asset-links/backfill');
    const r1 = await backfillDocumentAssetLinks(sql, { batchSize: 2 });
    expect((await liens(f1.id)).map((l) => [l.asset_id, l.link_role, l.origin])).toEqual([[a1.id, 'PRIMARY', 'LEGACY_COLUMN']]);
    expect((await liens(f2.id)).map((l) => [l.asset_id, l.link_role, l.origin])).toEqual([[a2.id, 'SECONDARY', 'MIGRATION']]);
    const miens = r1.ambiguous.filter((a) => a.fileId === f2.id).map((a) => a.reason).sort();
    expect(miens).toEqual(['PROPOSAL_MODIFIED', 'TARGET_NOT_FOUND', 'TARGET_OTHER_ACCOUNT']);

    // Idempotent : relancé, rien de nouveau.
    const total = async () => Number((await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM document_asset_links`)[0].n);
    const avant = await total();
    const r2 = await backfillDocumentAssetLinks(sql, { batchSize: 3 });
    expect(await total()).toBe(avant);
    expect(r2.migrationLinksCreated).toBe(0);
    expect(r2.legacyLinksAfter).toBe(r2.legacyLinksBefore);
  });

  it('P-T1-04 : facture deux véhicules → Clio PRIMARY (colonne), Tesla SECONDARY (AI), visible depuis la Tesla', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const tesla = await make.asset(compte, { category: 'VEHICULE', name: 'Tesla Model 3' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const f: T1Fixture = loadT1Fixture('p-t1-04-facture-deux-vehicules.json');
    let json = JSON.stringify(f.recording.output);
    json = json.replace(/("entityId":)12\b/g, `$1${clio.id}`).replace(/("entityId":)13\b/g, `$1${tesla.id}`);
    await useRecordings([{ operationCode: f.recording.operationCode, task: f.recording.task, output: JSON.parse(json) }]);

    const { analyseGroupWithMaster } = await import('@/services/ai/source-analysis/master/analyse-group-master');
    const { computeMasterDocumentLinks, writeMasterDocumentLinks } = await import('@/services/ai/source-analysis/master/document-links');
    const { listAssetDocuments, listDocumentAssets } = await import('@/services/documents/document-asset-links');
    const { emptyTrace } = await import('@/services/ai/source-analysis/trace');

    const input: SourceInput = {
      sourceType: 'file', sourceIds: [fichier.id], accountId: compte.id, userId: compte.ownerUserId,
      mimeTypes: ['application/pdf'], displayNames: ['facture.pdf'], linkedAssetId: clio.id,
    };
    const ctx: AnalysisContext = {
      accountId: compte.id, userId: compte.ownerUserId, linkedAssetId: clio.id, existingTitles: [], rooms: [], equipments: [],
      assets: [
        { id: clio.id, name: 'Clio', category: 'VEHICULE', subtype: null },
        { id: tesla.id, name: 'Tesla Model 3', category: 'VEHICULE', subtype: null },
      ],
    };
    const m = await analyseGroupWithMaster(input, [0], ctx, emptyTrace());
    const links = computeMasterDocumentLinks({
      facts: m.facts, assetCandidates: m.result.assetCandidates, documentAssetId: m.documentAssetId, knownAssetId: clio.id,
    });
    await writeMasterDocumentLinks({ accountId: compte.id, fileId: fichier.id, links });
    // Relancé (réanalyse) : aucun doublon.
    await writeMasterDocumentLinks({ accountId: compte.id, fileId: fichier.id, links });

    expect((await listDocumentAssets(compte.id, fichier.id)).map((l) => [l.assetId, l.linkRole, l.origin])).toEqual([
      [clio.id, 'PRIMARY', 'LEGACY_COLUMN'], [tesla.id, 'SECONDARY', 'AI'],
    ]);
    expect((await listAssetDocuments(compte.id, tesla.id)).map((l) => l.fileId)).toEqual([fichier.id]);

    // Réanalyse devenue mono-bien : le lien AI est retiré, la colonne reste.
    await writeMasterDocumentLinks({ accountId: compte.id, fileId: fichier.id, links: [] });
    expect((await listDocumentAssets(compte.id, fichier.id)).map((l) => l.origin)).toEqual(['LEGACY_COLUMN']);
  });
});
