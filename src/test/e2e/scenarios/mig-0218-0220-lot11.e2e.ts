/**
 * Migrations 0218, 0219 et 0220 sur un schéma de niveau LOT 11 (revue lot 12).
 *
 * Le harnais matérialise le schéma Drizzle AVANT les migrations : les
 * colonnes déclarées y existent déjà et les `ADD COLUMN IF NOT EXISTS` ne
 * sont jamais réellement exercés. Ici, un schéma dédié reproduit les tables
 * telles qu'au lot 11 (colonnes nouvelles retirées), puis les fichiers sont
 * appliqués par le MÊME exécuteur que `ensureMigrations` (`runMigrationSql`),
 * deux fois (idempotence). On vérifie aussi la reprise d'un index
 * CONCURRENTLY rendu invalide.
 */
import { it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, indexValidity, indexLockKey, repairInvalidMigrationIndexes, type SqlRunner } from '@/db/migration-index';

const NOUVELLES: Record<string, string[]> = {
  document_facts: ['canonical_key', 'raw_key', 'raw_value', 'value_type', 'canonical_unit', 'target_type', 'target_entity_id',
    'target_entity_label', 'target_confidence', 'semantic_event_type', 'semantic_event_nature', 'recurrence', 'projection_origin', 'projection_rule'],
  document_extractions: ['multi_asset'],
  field_evidence: ['canonical_key', 'canonical_unit', 'raw_value', 'target_type', 'target_entity_id', 'target_entity_label',
    'target_confidence', 'semantic_event_type', 'semantic_event_nature', 'recurrence', 'projection_origin', 'projection_rule',
    'lifecycle_status', 'superseded_at', 'superseded_by_evidence_id', 'analysis_run_id'],
  ai_config_entries: ['prompt_architecture'],
};

scenario('MIG-L12', 'Migrations 0218-0220 sur schéma lot 11', ({ sql }) => {
  it('application, idempotence, données existantes ACTIVE, index valides et reprise d’un index invalide', async () => {
    const schema = `l11_${Date.now().toString(36)}`;
    const cnx = await sql.reserve();
    try {
      await cnx.unsafe(`CREATE SCHEMA ${schema}`);
      await cnx.unsafe(`SET search_path TO ${schema}`);
      await cnx.unsafe(`SET client_min_messages = warning`);
      for (const [table, cols] of Object.entries(NOUVELLES)) {
        await cnx.unsafe(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS)`);
        await cnx.unsafe(`ALTER TABLE ${table} ${cols.map((c) => `DROP COLUMN IF EXISTS ${c}`).join(', ')}`);
      }
      await cnx.unsafe(`CREATE TABLE _migrations (id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await cnx.unsafe(`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint)
                        VALUES (1, 1, 'mileage', '1', 'document', 1, 'certain', 'fp-l11')`);

      const dir = join(process.cwd(), 'src', 'db', 'migrations');
      const fichiers = (await readdir(dir)).filter((f) => /^02(18|19|20)_.*\.sql$/.test(f)).sort();
      expect(fichiers.length).toBeGreaterThanOrEqual(8);
      // Toujours CETTE connexion (search_path du schéma lot 11) : pas de `reserve`.
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) {
        for (const f of fichiers) {
          await expect(runMigrationSql(runner, await readFile(join(dir, f), 'utf-8')), `${f} (passe ${passe})`).resolves.toBeDefined();
        }
      }

      for (const [table, cols] of Object.entries(NOUVELLES)) {
        const rows = await cnx.unsafe(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [schema, table],
        ) as unknown as Array<{ column_name: string }>;
        const presentes = new Set(rows.map((r) => r.column_name));
        expect(cols.filter((c) => !presentes.has(c)), table).toEqual([]);
      }
      const [ligne] = await cnx.unsafe(`SELECT lifecycle_status FROM field_evidence`) as unknown as Array<{ lifecycle_status: string }>;
      expect(ligne.lifecycle_status).toBe('ACTIVE');
      for (const idx of ['document_facts_account_canonical_idx', 'document_facts_target_idx', 'field_evidence_source_lifecycle_idx',
        'field_evidence_account_canonical_idx', 'field_evidence_target_idx']) {
        expect(await indexValidity(runner, idx), idx).toBe(true);
      }

      // Construction interrompue simulée : l'index est rendu invalide, puis le
      // fichier est rejoué — il doit être reconstruit et redevenir valide.
      await cnx.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${schema}.field_evidence_target_idx'::regclass`);
      expect(await indexValidity(runner, 'field_evidence_target_idx')).toBe(false);
      const f = fichiers.find((x) => x.startsWith('0219_') && x.endsWith('_idx_3.sql'))!;
      const texte = await readFile(join(dir, f), 'utf-8');

      // Une autre instance détient le verrou de l'index : rien n'est fait.
      const autre = await sql.reserve();
      try {
        await autre.unsafe(`SELECT pg_advisory_lock(hashtext($1))`, [indexLockKey('field_evidence_target_idx')]);
        expect(await runMigrationSql(runner, texte)).toEqual({ status: 'deferred', index: 'field_evidence_target_idx' });
        expect(await indexValidity(runner, 'field_evidence_target_idx')).toBe(false);
        await autre.unsafe(`SELECT pg_advisory_unlock(hashtext($1))`, [indexLockKey('field_evidence_target_idx')]);
      } finally {
        autre.release();
      }

      // Contrôle de démarrage : fichier déjà marqué appliqué → reconstruit tout de suite.
      await cnx.unsafe(`INSERT INTO _migrations (filename) VALUES ($1)`, [f]);
      const rep = await repairInvalidMigrationIndexes(runner, [{ filename: f, sql: texte }]);
      expect(rep).toEqual({ repaired: ['field_evidence_target_idx'], requeued: [], unknown: [], skipped: [] });
      expect(await indexValidity(runner, 'field_evidence_target_idx')).toBe(true);
    } finally {
      await cnx.unsafe(`SET search_path TO public`);
      await cnx.unsafe(`RESET client_min_messages`);
      await cnx.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      cnx.release();
    }
  });
});
