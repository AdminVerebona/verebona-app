/**
 * Migration 0229 (D-G, lot 20) appliquée sur le schéma RÉEL d'avant le lot 20
 * — revue lot 20, constat bloquant sur `0229_*_idx_3`.
 *
 * Le harnais construit sa base depuis le schéma Drizzle ACTUEL (qui contient
 * déjà les objets 0229) : 0229 n'y ajoute rien. Ce scénario crée donc SA
 * base, la ramène exactement à l'état « lot 21 » (schéma Drizzle d'alors +
 * migrations jusqu'à 0228 et 0230 : colonnes, index, contraintes, table et
 * déclencheur 0221 d'origine), puis applique les fichiers 0229 par la boucle
 * même de `ensureMigrations` (`applyMigrationFiles`) :
 *
 *  1. 0229 principal en ÉCHEC (verrou tenu sur `substructures`, lock_timeout)
 *     → idx_1, idx_2, idx_3 échouent aussi, l'ANCIENNE unicité des liens reste
 *     en place et valide, aucune donnée touchée, rien marqué appliqué ;
 *  2. démarrage suivant : les quatre fichiers passent, dans l'ordre ;
 *  3. principal appliqué mais idx_2 absent → idx_3 refuse de supprimer
 *     l'ancienne unicité (exception), puis passe une fois idx_2 construit.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { scenario } from '../scenario';
import { adminUrlFromEnv, bootstrapE2eDatabase, dropE2eDatabase } from '../db-bootstrap';

const MIG = join(process.cwd(), 'src', 'db', 'migrations');
const silencieux = { info: () => {}, warn: () => {}, error: () => {} };

scenario('MIG-0229', 'Migration 0229 sur le schéma réel d’avant : échec, retente, ordre, garde de idx_3', () => {
  it('échec du principal → ancienne unicité conservée ; retente → tout passe dans l’ordre ; idx_3 gardé', async () => {
    const { applyMigrationFiles, runMigrationSql } = await import('@/db/migration-index');
    const admin = adminUrlFromEnv()!;
    const base = `verebona_e2e_mig0229_${Date.now()}`;
    const boot = await bootstrapE2eDatabase({ adminUrl: admin, database: base });
    const sql = postgres(boot.url, { max: 4, onnotice: () => undefined });
    try {
      const lire = (f: string) => readFile(join(MIG, f), 'utf8');
      const fichiers = await Promise.all((await readdir(MIG)).filter((f) => f.endsWith('.sql')).sort()
        .map(async (filename) => ({ filename, sql: await lire(filename) })));

      // ── État « lot 21 » : 0229 défaite objet par objet ──────────────────
      await sql.unsafe(`
        -- Déclencheurs du journal de connaissance T3 (0292, postérieurs) : ils
        -- citent des colonnes 0229 (substructure_id, key_characteristics).
        DROP TRIGGER IF EXISTS t3_knowledge_links_upd ON document_asset_links;
        DROP TRIGGER IF EXISTS t3_knowledge_substructures_upd ON substructures;
        DROP TRIGGER IF EXISTS substructures_links_before_delete ON substructures;
        DROP FUNCTION IF EXISTS substructures_links_before_delete();
        DROP INDEX IF EXISTS document_asset_links_active_uniq2;
        DROP INDEX IF EXISTS substructures_legacy_room_uidx;
        ALTER TABLE document_asset_links DROP CONSTRAINT IF EXISTS document_asset_links_target_check;
        ALTER TABLE document_asset_links DROP COLUMN IF EXISTS substructure_id;
        ALTER TABLE document_asset_links ADD CONSTRAINT document_asset_links_target_check
          CHECK (asset_id IS NOT NULL OR room_id IS NOT NULL OR equipment_id IS NOT NULL);
        ALTER TABLE substructures DROP COLUMN IF EXISTS legacy_room_id, DROP COLUMN IF EXISTS room_type,
          DROP COLUMN IF EXISTS area, DROP COLUMN IF EXISTS description, DROP COLUMN IF EXISTS key_characteristics;
        DROP TABLE IF EXISTS room_merge_runs, room_merge_changes;
        ALTER TABLE canonical_field_writes DROP CONSTRAINT IF EXISTS canonical_field_writes_target_ck;
        ALTER TABLE canonical_field_writes ADD CONSTRAINT canonical_field_writes_target_ck
          CHECK ((target_type IS NULL AND target_id IS NULL) OR (target_type IN ('EQUIPMENT', 'ROOM') AND target_id IS NOT NULL)) NOT VALID;
        DELETE FROM _migrations WHERE filename LIKE '0229\\_%';`);
      await runMigrationSql(sql as never, await lire('0221_document_asset_links_idx_1.sql'));
      await sql.unsafe(await lire('0221_document_asset_links_trigger.sql'));

      // Données « lot 21 » : pièce rooms, preuve ROOM, carte active, lien.
      const [u] = await sql<{ id: number }[]>`INSERT INTO users (email, password_hash, status) VALUES (${`m0229-${Date.now()}@test.invalid`}, 'x', 'ACTIVE') RETURNING id`;
      const [c] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES ('m0229', ${u.id}) RETURNING id`;
      const [a] = await sql<{ id: number }[]>`INSERT INTO assets (user_id, account_id, category, name) VALUES (${u.id}, ${c.id}, 'IMMOBILIER', 'Maison') RETURNING id`;
      const [r] = await sql<{ id: number }[]>`INSERT INTO rooms (asset_id, account_id, name, room_type) VALUES (${a.id}, ${c.id}, 'Salon', 'LIVING') RETURNING id`;
      const [f] = await sql<{ id: number }[]>`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, linked_room_id) VALUES (${u.id}, ${c.id}, ${a.id}, 'k', ${r.id}) RETURNING id`;
      const [carte] = await sql<{ id: number }[]>`
        INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
        VALUES (${c.id}, 'ROOM', ${r.id}, 'roomArea', 'ARBITRATE', 'ENTITY-FIELD-ROOM', '?') RETURNING id`;

      const indexValide = async (nom: string) => (await sql<{ v: boolean }[]>`
        SELECT i.indisvalid AS v FROM pg_class x JOIN pg_index i ON i.indexrelid = x.oid WHERE x.relname = ${nom}`)[0]?.v ?? null;
      const colonne = async (t: string, col: string) => (await sql`
        SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${t} AND column_name = ${col}`).length > 0;
      const appliquees = async () => (await sql<{ filename: string }[]>`SELECT filename FROM _migrations WHERE filename LIKE '0229%' ORDER BY 1`).map((x) => x.filename);
      const carteType = async () => (await sql`SELECT target_type FROM to_process_actions WHERE id = ${carte.id}`)[0].target_type;
      expect(await indexValide('document_asset_links_active_uniq')).toBe(true);
      expect(await colonne('document_asset_links', 'substructure_id')).toBe(false);

      // ── 1. Principal en échec (verrou tenu) ─────────────────────────────
      const autre = postgres(boot.url, { max: 1, onnotice: () => undefined });
      const verrou = await autre.reserve();
      await verrou`BEGIN`;
      await verrou`LOCK TABLE substructures IN ACCESS EXCLUSIVE MODE`;
      const echec = await applyMigrationFiles(sql as never, fichiers, silencieux);
      await verrou`ROLLBACK`;
      verrou.release();
      await autre.end();
      expect(echec.failures.map((x) => x.filename)).toEqual([
        '0229_rooms_to_substructures.sql', '0229_rooms_to_substructures_idx_1.sql',
        '0229_rooms_to_substructures_idx_2.sql', '0229_rooms_to_substructures_idx_3.sql',
      ]);
      expect(echec.failures[3].message).toMatch(/substructure_id absente/);
      expect(echec.applied).toEqual([]);
      expect(await appliquees()).toEqual([]);
      expect(await indexValide('document_asset_links_active_uniq')).toBe(true); // jamais de fenêtre sans unicité
      expect(await colonne('document_asset_links', 'substructure_id')).toBe(false);
      expect(await carteType()).toBe('ROOM'); // transaction annulée : rien neutralisé
      expect(await indexValide('substructures_legacy_room_uidx')).toBeNull(); // aucun index invalide laissé

      // ── 2. Démarrage suivant : tout passe, dans l'ordre ─────────────────
      const ok = await applyMigrationFiles(sql as never, fichiers, silencieux);
      expect(ok.failures).toEqual([]);
      expect(ok.applied).toEqual([
        '0229_rooms_to_substructures.sql', '0229_rooms_to_substructures_idx_1.sql',
        '0229_rooms_to_substructures_idx_2.sql', '0229_rooms_to_substructures_idx_3.sql',
      ]);
      expect(await indexValide('document_asset_links_active_uniq')).toBeNull();
      expect(await indexValide('document_asset_links_active_uniq2')).toBe(true);
      expect(await indexValide('substructures_legacy_room_uidx')).toBe(true);
      expect(await carteType()).toBe('LEGACY_ROOM');
      expect((await sql`SELECT confdeltype FROM pg_constraint WHERE conname = 'document_asset_links_substructure_id_substructures_id_fk'`)[0].confdeltype).toBe('n');
      // Le déclencheur d'origine (0221) est remplacé : la sous-structure du document devient un lien.
      const [s] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${a.id}, 'Bureau') RETURNING id`;
      await sql`UPDATE asset_files SET substructure_id = ${s.id} WHERE id = ${f.id}`;
      expect((await sql`SELECT count(*)::int AS n FROM document_asset_links WHERE file_id = ${f.id} AND substructure_id = ${s.id} AND status = 'ACTIVE'`)[0].n).toBe(1);
      // Relance complète : rien à faire.
      expect((await applyMigrationFiles(sql as never, fichiers, silencieux)).applied).toEqual([]);

      // ── 3. Principal appliqué, idx_2 absent : idx_3 refuse ──────────────
      await sql`DROP INDEX document_asset_links_active_uniq2`;
      // (l'ancienne unicité ne distingue pas les pièces : lien de pièce retiré pour pouvoir la reconstruire)
      await sql`UPDATE document_asset_links SET status = 'REMOVED', removed_at = now() WHERE substructure_id IS NOT NULL`;
      await runMigrationSql(sql as never, await lire('0221_document_asset_links_idx_1.sql'));
      await sql`DELETE FROM _migrations WHERE filename IN ('0229_rooms_to_substructures_idx_2.sql', '0229_rooms_to_substructures_idx_3.sql')`;
      const seul3 = await applyMigrationFiles(sql as never, fichiers.filter((x) => x.filename.endsWith('_idx_3.sql')), silencieux);
      expect(seul3.failures[0]?.message).toMatch(/active_uniq2 absent ou invalide/);
      expect(await indexValide('document_asset_links_active_uniq')).toBe(true);
      const fin = await applyMigrationFiles(sql as never, fichiers, silencieux);
      expect(fin.applied).toEqual(['0229_rooms_to_substructures_idx_2.sql', '0229_rooms_to_substructures_idx_3.sql']);
      expect(await indexValide('document_asset_links_active_uniq')).toBeNull();
      expect(await indexValide('document_asset_links_active_uniq2')).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      await dropE2eDatabase(admin, base, { force: true });
    }
  }, 180_000);
});
