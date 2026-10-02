/**
 * Décision PO D-G (lot 20, chantier B) — les pièces `rooms` fusionnent dans
 * `substructures`, sur PostgreSQL réel :
 *
 *  · migration 0229 : neutralisation UNIQUE des cibles « ROOM » (identifiants
 *    `rooms`) en LEGACY_ROOM, carte active suspendue, travail T3 annulé ;
 *    relancée, elle ne touche plus rien ;
 *  · reprise (`runRoomsMerge`) : simulation sans effet (rapport seul) ;
 *    application — sous-structure créée (colonnes et fiche reprises),
 *    rapprochée par nom, ou créée malgré des homonymes (signalée) ; preuves,
 *    faits, journal, carte (rouverte), liens N-N, colonnes `linked_room_id`
 *    repointés ; conflit de colonne signalé sans écrasement ; travail T3
 *    relancé ; fiche canonique de la pièce lue sur la sous-structure ;
 *  · relance sans doublon ; restauration fidèle ; ré-application.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('D-G', 'Pièces rooms → substructures : migration 0229 et reprise', ({ sql, make }) => {
  it('neutralisation, simulation, application, relance, restauration', async () => {
    const { runMigrationSql } = await import('@/db/migration-index');
    const { runRoomsMerge, restoreRoomsMerge, summarizeRoomsMerge } = await import('@/services/migration/rooms-merge');
    const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
    const { __resetEntityColumnsForTests } = await import('@/services/canonical/entity-state/entity-schema');
    __resetEntityColumnsForTests(null);

    const compte = await make.account();
    // Identifiants `rooms` hors de la plage des sous-structures : la fenêtre de
    // déploiement (ROOM + identifiant rooms) ne doit pas croiser une sous-structure.
    await sql`SELECT setval(pg_get_serial_sequence('rooms', 'id'),
      (SELECT COALESCE(MAX(id), 0) FROM substructures) + (SELECT COALESCE(MAX(id), 0) FROM rooms) + 100000)`;
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const autre = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const piece = async (name: string, over: { area?: string; kc?: Record<string, unknown>; type?: string } = {}) => (await sql<{ id: number }[]>`
      INSERT INTO rooms (asset_id, account_id, name, room_type, area, description, key_characteristics)
      VALUES (${bien.id}, ${compte.id}, ${name}, ${over.type ?? 'OTHER'}, ${over.area ?? null}, ${'desc ' + name},
              ${JSON.stringify(over.kc ?? {})}::jsonb) RETURNING id`)[0].id;
    const sousStructure = async (assetId: number, name: string) => (await sql<{ id: number }[]>`
      INSERT INTO substructures (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`)[0].id;

    const salon = await piece('Salon', { area: '18.5', type: 'LIVING', kc: { roomArea: 18.5, roomArea__origin: 'USER' } });
    const cuisine = await piece('Cuisine', { area: '9' });
    const chambre = await piece('Chambre');
    const subCuisine = await sousStructure(bien.id, 'cuisine ');
    await sousStructure(bien.id, 'Chambre');
    await sousStructure(bien.id, 'CHAMBRE');
    const subAutre = await sousStructure(bien.id, 'Bureau');
    const subStudio = await sousStructure(autre.id, 'Salon');

    // Références « ROOM » au format ANTÉRIEUR à 0229 (identifiant `rooms`).
    const f1 = await make.assetFile(compte, { assetId: bien.id });
    const f2 = await make.assetFile(compte, { assetId: bien.id });
    const f3 = await make.assetFile(compte, { assetId: bien.id });
    // Rattachés à la seule pièce (aucun bien propre) : survivraient à la suppression du bien sans correctif.
    const f5 = await make.assetFile(compte, { assetId: null, name: 'piece-seule.pdf' });
    await sql`UPDATE asset_files SET linked_room_id = ${cuisine} WHERE id = ${f5.id}`;
    const [evt] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, categorie, titre, linked_room_id)
      VALUES (${compte.id}, ${compte.ownerUserId}, 'travaux', 'Peinture', ${cuisine}) RETURNING id`;
    await sql`UPDATE asset_files SET linked_room_id = ${salon} WHERE id = ${f1.id}`;
    await sql`UPDATE asset_files SET linked_room_id = ${salon}, substructure_id = ${subAutre} WHERE id = ${f2.id}`;
    const [ext] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars) VALUES (${compte.id}, ${f1.id}, '', 0) RETURNING id`;
    const [fait] = await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_number, confidence, excerpt, target_type, target_entity_id)
      VALUES (${compte.id}, ${f1.id}, ${ext.id}, 'roomArea', 20, 'certain', '20 m²', 'ROOM', ${salon}) RETURNING id::int AS id`;
    const [preuve] = await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt,
                                  canonical_key, target_type, target_entity_id)
      VALUES (${compte.id}, ${bien.id}, 'roomArea', '20', 'document', ${f1.id}, 'certain', ${`fp-dg-${salon}`}, '20 m²',
              'roomArea', 'ROOM', ${salon}) RETURNING id`;
    const [journal] = await sql<{ id: string }[]>`
      INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, new_value, origin, target_type, target_id)
      VALUES (${compte.id}, ${bien.id}, 'roomArea', '18.5', 'USER', 'ROOM', ${salon}) RETURNING id::text AS id`;
    const [carte] = await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, trigger_context)
      VALUES (${compte.id}, 'ROOM', ${salon}, 'roomArea', 'ARBITRATE', 'ENTITY-FIELD-ROOM', 'Surface ?', '{"key":"roomArea"}'::jsonb) RETURNING id`;
    const [job] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, payload)
      VALUES ('T3', ${compte.id}, 'room', ${String(salon)}, ${`T3:dg:${salon}`}, 'PENDING', ${JSON.stringify({ kind: 'entity', userId: compte.ownerUserId })}::jsonb)
      RETURNING id`;
    const [lienIa] = await sql<{ id: string }[]>`
      INSERT INTO document_asset_links (account_id, file_id, asset_id, room_id, link_role, origin, confidence, status)
      VALUES (${compte.id}, ${f3.id}, ${bien.id}, ${salon}, 'SECONDARY', 'AI', 0.8, 'ACTIVE') RETURNING id::text AS id`;

    const liensActifs = async () => (await sql<{ file_id: number; asset_id: number | null; room_id: number | null; substructure_id: number | null; origin: string }[]>`
      SELECT file_id, asset_id, room_id, substructure_id, origin FROM document_asset_links
       WHERE account_id = ${compte.id} AND status = 'ACTIVE' ORDER BY file_id, origin, COALESCE(room_id, 0), COALESCE(substructure_id, 0), COALESCE(asset_id, 0)`)
      .map((l) => ({ ...l }));
    expect(await liensActifs()).toContainEqual({ file_id: f1.id, asset_id: bien.id, room_id: salon, substructure_id: null, origin: 'LEGACY_COLUMN' });
    // Le déclencheur 0229 reflète la sous-structure d'un document.
    expect(await liensActifs()).toContainEqual({ file_id: f2.id, asset_id: bien.id, room_id: null, substructure_id: subAutre, origin: 'LEGACY_COLUMN' });

    // ── 1. Migration 0229 rejouée sur une base « avant » (marqueur retiré) ──
    const fichier = readFileSync(join(process.cwd(), 'src/db/migrations/0229_rooms_to_substructures.sql'), 'utf8');
    await sql`DROP TABLE room_merge_runs`;
    await runMigrationSql(sql as never, fichier.replace(/\n/g, '\r\n')); // CRLF toléré
    const cible = async (table: string, id: number | string, col = 'target_entity_id') =>
      (await sql.unsafe(`SELECT target_type AS t, ${col} AS i FROM ${table} WHERE id = $1`, [id] as never[]))[0] as unknown as { t: string; i: number };
    expect(await cible('field_evidence', preuve.id)).toEqual({ t: 'LEGACY_ROOM', i: salon });
    expect(await cible('document_facts', fait.id)).toEqual({ t: 'LEGACY_ROOM', i: salon });
    expect(await cible('canonical_field_writes', journal.id, 'target_id')).toEqual({ t: 'LEGACY_ROOM', i: salon });
    const etatCarte = async () => (await sql<{ target_type: string; target_id: number; resolved_at: Date | null; trigger_context: Record<string, unknown> }[]>`
      SELECT target_type, target_id, resolved_at, trigger_context FROM to_process_actions WHERE id = ${carte.id}`)[0];
    expect(await etatCarte()).toMatchObject({ target_type: 'LEGACY_ROOM', trigger_context: { key: 'roomArea', dgSuspended: true } });
    expect((await etatCarte()).resolved_at).not.toBeNull();
    expect((await sql`SELECT status FROM ai_job_queue WHERE id = ${job.id}`)[0].status).toBe('CANCELLED');
    // Une nouvelle cible ROOM (= sous-structure) écrite APRÈS 0229 n'est jamais neutralisée par une relance.
    const [neuve] = await sql<{ id: string }[]>`
      INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, new_value, origin, target_type, target_id)
      VALUES (${compte.id}, ${bien.id}, 'roomArea', '7', 'USER', 'ROOM', ${subStudio}) RETURNING id::text AS id`;
    await runMigrationSql(sql as never, fichier);
    expect(await cible('canonical_field_writes', neuve.id, 'target_id')).toEqual({ t: 'ROOM', i: subStudio });
    await sql`DELETE FROM canonical_field_writes WHERE id = ${neuve.id}`;

    // Fenêtre de déploiement : l'ANCIEN code écrit encore « ROOM » + identifiant rooms APRÈS 0229.
    const [tardive] = await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt,
                                  canonical_key, target_type, target_entity_id)
      VALUES (${compte.id}, ${bien.id}, 'roomArea', '21', 'document', ${f1.id}, 'certain', ${`fp-dg-tard-${salon}`}, '21 m²',
              'roomArea', 'ROOM', ${salon}) RETURNING id`;

    const nbSous = async () => Number((await sql`SELECT count(*)::int AS n FROM substructures WHERE asset_id = ${bien.id}`)[0].n);
    const relances: unknown[] = [];
    const run = (apply: boolean) => runRoomsMerge({ sql, apply, accountId: compte.id, reenqueue: async (i) => { relances.push(i); } });

    // ── 2. Simulation : rapport seulement ──────────────────────────────────
    const avantSous = await nbSous();
    const dry = await run(false);
    expect(dry.mode).toBe('dry_run');
    expect(dry.counts).toMatchObject({ rooms: 3, created: 2, mapped: 1, failed: 0, 'repointed.field_evidence': 2, 'repointed.asset_files': 2, 'repointed.events': 1, conflict: 1 });
    expect(await nbSous()).toBe(avantSous);
    expect(await cible('field_evidence', preuve.id)).toEqual({ t: 'LEGACY_ROOM', i: salon });
    expect(relances).toEqual([]);
    expect((await sql`SELECT count(*)::int AS n FROM room_merge_changes WHERE run_id = ${dry.runId} AND run_mode = 'dry_run'`)[0].n).toBeGreaterThan(0);
    await expect(restoreRoomsMerge(sql, dry.runId)).rejects.toThrow(/simulation/);

    // ── 3. Application ─────────────────────────────────────────────────────
    const app = await run(true);
    expect(app.counts).toMatchObject({ rooms: 3, created: 2, mapped: 1, reopened: 1, conflict: 1, reenqueued: 1, failed: 0 });
    const subDe = async (roomId: number) => (await sql<{ id: number; name: string; room_type: string | null; area: string | null; description: string | null; key_characteristics: Record<string, unknown> }[]>`
      SELECT id, name, room_type, area, description, key_characteristics FROM substructures WHERE legacy_room_id = ${roomId}`)[0];
    const sSalon = await subDe(salon);
    expect(sSalon).toMatchObject({ name: 'Salon', room_type: 'LIVING', area: '18.5', description: 'desc Salon', key_characteristics: { roomArea: 18.5 } });
    expect(sSalon.id).not.toBe(subStudio); // jamais une sous-structure d'un autre bien
    expect((await subDe(cuisine))).toMatchObject({ id: subCuisine, name: 'cuisine ', area: '9', room_type: 'OTHER' });
    const sChambre = await subDe(chambre);
    expect(sChambre.name).toBe('Chambre');
    expect((await summarizeRoomsMerge(sql, app.runId))!.samples.some((x) => String(x.reason).startsWith('AMBIGUOUS_NAME'))).toBe(true);

    expect(await cible('field_evidence', preuve.id)).toEqual({ t: 'ROOM', i: sSalon.id });
    expect(await cible('field_evidence', tardive.id)).toEqual({ t: 'ROOM', i: sSalon.id }); // fenêtre reprise
    expect((await sql`SELECT linked_room_id, substructure_id FROM asset_files WHERE id = ${f5.id}`)[0]).toEqual({ linked_room_id: null, substructure_id: subCuisine });
    expect((await sql`SELECT asset_id, substructure_id, linked_room_id FROM events WHERE id = ${evt.id}`)[0])
      .toEqual({ asset_id: null, substructure_id: subCuisine, linked_room_id: null });
    expect(await cible('document_facts', fait.id)).toEqual({ t: 'ROOM', i: sSalon.id });
    expect(await cible('canonical_field_writes', journal.id, 'target_id')).toEqual({ t: 'ROOM', i: sSalon.id });
    expect(await etatCarte()).toMatchObject({ target_type: 'ROOM', target_id: sSalon.id, resolved_at: null, trigger_context: { key: 'roomArea' } });
    expect((await etatCarte()).trigger_context).not.toHaveProperty('dgSuspended');
    const fichierLigne = async (id: number) => (await sql<{ linked_room_id: number | null; substructure_id: number | null }[]>`
      SELECT linked_room_id, substructure_id FROM asset_files WHERE id = ${id}`)[0];
    expect(await fichierLigne(f1.id)).toEqual({ linked_room_id: null, substructure_id: sSalon.id });
    expect(await fichierLigne(f2.id)).toEqual({ linked_room_id: salon, substructure_id: subAutre }); // CONFLICT : rien écrasé
    const liens = await liensActifs();
    expect(liens).toContainEqual({ file_id: f1.id, asset_id: bien.id, room_id: null, substructure_id: sSalon.id, origin: 'LEGACY_COLUMN' });
    expect(liens).not.toContainEqual(expect.objectContaining({ file_id: f1.id, room_id: salon }));
    expect(liens).toContainEqual({ file_id: f3.id, asset_id: bien.id, room_id: null, substructure_id: sSalon.id, origin: 'AI' });
    expect(relances).toEqual([{ accountId: compte.id, userId: compte.ownerUserId, targets: [{ type: 'ROOM', id: sSalon.id }] }]);
    expect((await sql`SELECT last_error FROM ai_job_queue WHERE id = ${job.id}`)[0].last_error).toContain(`[relancée : sous-structure ${sSalon.id}]`);
    // Fiche canonique de la pièce : lue sur la sous-structure (D-G).
    const etat = await getCanonicalEntityState({ type: 'ROOM', id: sSalon.id }, compte.id, sql as never);
    expect(etat?.fields.roomArea).toMatchObject({ value: 18.5, origin: 'USER' });
    expect(etat?.name).toBe('Salon');

    // ── 4. Relance : aucun doublon, rien à repointer ───────────────────────
    const nbApres = await nbSous();
    const bis = await run(true);
    // Pièces reprises sans reste (le conflit reste au rapport, jamais retraité) : plus parcourues.
    expect(bis.counts).toMatchObject({ rooms: 0, failed: 0 });
    expect(await fichierLigne(f2.id)).toEqual({ linked_room_id: salon, substructure_id: subAutre });
    expect(await nbSous()).toBe(nbApres);
    expect(relances).toHaveLength(1);

    // ── 5. Restauration fidèle ─────────────────────────────────────────────
    const r = await restoreRoomsMerge(sql, app.runId);
    expect(r.conflicts).toEqual([]);
    expect(r.deletedSubstructures).toBe(2);
    expect(await nbSous()).toBe(avantSous);
    expect((await sql`SELECT legacy_room_id, area FROM substructures WHERE id = ${subCuisine}`)[0]).toEqual({ legacy_room_id: null, area: null });
    expect(await cible('field_evidence', preuve.id)).toEqual({ t: 'LEGACY_ROOM', i: salon });
    expect(await cible('field_evidence', tardive.id)).toEqual({ t: 'ROOM', i: salon }); // restaurée telle qu'écrite
    expect(await cible('document_facts', fait.id)).toEqual({ t: 'LEGACY_ROOM', i: salon });
    expect(await cible('canonical_field_writes', journal.id, 'target_id')).toEqual({ t: 'LEGACY_ROOM', i: salon });
    expect(await etatCarte()).toMatchObject({ target_type: 'LEGACY_ROOM', target_id: salon, trigger_context: { dgSuspended: true } });
    expect((await etatCarte()).resolved_at).not.toBeNull();
    expect(await fichierLigne(f1.id)).toEqual({ linked_room_id: salon, substructure_id: null });
    const restaures = await liensActifs();
    expect(restaures).toContainEqual({ file_id: f1.id, asset_id: bien.id, room_id: salon, substructure_id: null, origin: 'LEGACY_COLUMN' });
    expect(restaures).not.toContainEqual(expect.objectContaining({ file_id: f1.id, substructure_id: expect.any(Number) }));
    expect((await sql`SELECT room_id, substructure_id, status FROM document_asset_links WHERE id = ${lienIa.id}`)[0])
      .toEqual({ room_id: salon, substructure_id: null, status: 'ACTIVE' });
    expect((await sql`SELECT status FROM room_merge_runs WHERE run_id = ${app.runId}`)[0].status).toBe('RESTORED');
    // Restauration rejouée : rien de plus.
    expect(await restoreRoomsMerge(sql, app.runId)).toEqual({ restored: 0, deletedSubstructures: 0, conflicts: [] });

    // ── 6. Ré-application après restauration ───────────────────────────────
    const ter = await run(true);
    expect(ter.counts).toMatchObject({ rooms: 3, created: 2, mapped: 1, failed: 0 });
    expect(await cible('field_evidence', preuve.id)).toMatchObject({ t: 'ROOM' });
    expect(await cible('field_evidence', tardive.id)).toMatchObject({ t: 'ROOM' });
    expect((await sql`SELECT target_entity_id AS i FROM field_evidence WHERE id = ${tardive.id}`)[0].i).not.toBe(salon);

    // ── 7. Pièce supprimée : le lien N-N se replie sur le bien (SET NULL) ──
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    const [x] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${bien.id}, 'Véranda') RETURNING id`;
    const f6 = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET substructure_id = ${x.id} WHERE id = ${f6.id}`;
    const f7 = await make.assetFile(compte, { assetId: null });
    const f8 = await make.assetFile(compte, { assetId: bien.id });
    const l7 = (await linkDocumentToAsset({ accountId: compte.id, fileId: f7.id, target: { substructureId: x.id }, role: 'SECONDARY', origin: 'AI' })).link;
    const l8 = (await linkDocumentToAsset({ accountId: compte.id, fileId: f8.id, target: { substructureId: x.id }, role: 'SECONDARY', origin: 'AI' })).link;
    await sql`DELETE FROM substructures WHERE id = ${x.id}`;
    const lien = async (id: number) => (await sql`SELECT asset_id, substructure_id, status FROM document_asset_links WHERE id = ${id}`)[0];
    expect(await lien(l7.id)).toEqual({ asset_id: bien.id, substructure_id: null, status: 'ACTIVE' }); // repli sur le bien
    expect(await lien(l8.id)).toEqual({ asset_id: bien.id, substructure_id: null, status: 'REMOVED' }); // doublon du lien au bien
    expect((await liensActifs()).filter((l) => l.file_id === f6.id)).toEqual([
      { file_id: f6.id, asset_id: bien.id, room_id: null, substructure_id: null, origin: 'LEGACY_COLUMN' },
    ]);

    // ── 8. Suppression du bien : rattachés à la seule pièce emportés et purgés ──
    const { deleteAssetCompletely, getAssetDeletionSummary } = await import('@/services/assets/asset-deletion.service');
    const resume = await getAssetDeletionSummary(bien.id);
    expect(resume.events).toBeGreaterThanOrEqual(1);
    const [cle5] = await sql<{ k: string }[]>`SELECT s3_key AS k FROM asset_files WHERE id = ${f5.id}`;
    const del = await deleteAssetCompletely({ id: bien.id });
    expect(del.fileIds).toContain(f5.id);
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${f5.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM events WHERE id = ${evt.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM pending_blob_deletions WHERE storage_path = ${cle5.k}`).toHaveLength(1);
  });

  it('--limit progresse d’une exécution à l’autre (pièces reprises sans reste exclues)', async () => {
    const { runRoomsMerge } = await import('@/services/migration/rooms-merge');
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    const ids: number[] = [];
    for (const n of ['A', 'B', 'C']) {
      ids.push((await sql<{ id: number }[]>`INSERT INTO rooms (asset_id, account_id, name, room_type) VALUES (${bien.id}, ${compte.id}, ${n}, 'OTHER') RETURNING id`)[0].id);
    }
    const repris = async () => (await sql<{ r: number }[]>`SELECT legacy_room_id AS r FROM substructures WHERE asset_id = ${bien.id} AND legacy_room_id IS NOT NULL ORDER BY 1`).map((x) => x.r);
    const run = () => runRoomsMerge({ sql, apply: true, accountId: compte.id, limit: 2, reenqueue: async () => {} });
    expect((await run()).counts).toMatchObject({ rooms: 2, created: 2 });
    expect(await repris()).toEqual(ids.slice(0, 2));
    expect((await run()).counts).toMatchObject({ rooms: 1, created: 1 });
    expect(await repris()).toEqual(ids);
    expect((await run()).counts).toMatchObject({ rooms: 0 });
  });
});
