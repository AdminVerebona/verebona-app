/**
 * Relecture lot 17 — tables NEUVES des lots 14 à 17 déclarées dans Drizzle
 * (protection contre `db:push`) : alignement EXACT avec le SQL de leur
 * migration (colonnes, NOT NULL, contraintes CHECK, index).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { agendaItemRemovals, aiMasterCorpusRuns, documentFieldValues, cdc15MigrationBackups, cdc15MigrationReport, cdc15MigrationRuns, roomMergeChanges, roomMergeRuns } from '../schema';

const MIG = join(process.cwd(), 'src/db/migrations');

/** Colonnes (nom → NOT NULL) d'un CREATE TABLE, et noms des contraintes / index du fichier. */
function sqlTable(file: string, table: string) {
  const sql = readFileSync(join(MIG, file), 'utf8').replace(/--.*$/gm, '');
  const bloc = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)![1];
  const colonnes = new Map<string, boolean>();
  for (const l of bloc.split(',\n').map((x) => x.trim()).filter(Boolean)) {
    if (/^CONSTRAINT\b/i.test(l)) continue;
    const [nom] = l.split(/\s+/);
    colonnes.set(nom, /NOT NULL|PRIMARY KEY/i.test(l));
  }
  for (const m of sql.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS (\\w+) ([^;]+);`, 'g'))) colonnes.set(m[1], /NOT NULL/i.test(m[2]));
  const checks = [...sql.matchAll(/CONSTRAINT (\w+)\s+CHECK/g)].map((m) => m[1]).filter((n) => n.startsWith(table));
  const index = [...sql.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\\w+)\\s+ON ${table}\\b`, 'g'))].map((m) => m[1]);
  return { colonnes, checks, index };
}

const CAS: Array<[PgTable, string, string]> = [
  [agendaItemRemovals, '0223_agenda_functional_key_removals.sql', 'agenda_item_removals'],
  [aiMasterCorpusRuns, '0224_ai_master_corpus_runs.sql', 'ai_master_corpus_runs'],
  [cdc15MigrationRuns, '0225_cdc15_migration_report.sql', 'cdc15_migration_runs'],
  [cdc15MigrationReport, '0225_cdc15_migration_report.sql', 'cdc15_migration_report'],
  [cdc15MigrationBackups, '0225_cdc15_migration_report_backups.sql', 'cdc15_migration_backups'],
  [roomMergeRuns, '0229_rooms_to_substructures.sql', 'room_merge_runs'],
  [roomMergeChanges, '0229_rooms_to_substructures.sql', 'room_merge_changes'],
  // Lot 28 : valeur retenue des données documentaires du catalogue « À traiter ».
  [documentFieldValues, '0256_to_process_document_rules.sql', 'document_field_values'],
];

describe('tables neuves : Drizzle = SQL', () => {
  for (const [table, file, nom] of CAS) {
    it(nom, () => {
      const cfg = getTableConfig(table);
      const s = sqlTable(file, nom);
      expect(cfg.name).toBe(nom);
      expect(Object.fromEntries(cfg.columns.map((c) => [c.name, c.notNull || c.primary])))
        .toEqual(Object.fromEntries(s.colonnes));
      expect(cfg.checks.map((c) => c.name).sort()).toEqual(s.checks.length ? s.checks.sort() : cfg.checks.map((c) => c.name).sort());
      expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual(s.index.sort());
    });
  }
  it('contraintes de 0224 (posées par ALTER) déclarées', () => {
    const sql = readFileSync(join(MIG, '0224_ai_master_corpus_runs.sql'), 'utf8');
    const attendues = [...sql.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]).sort();
    expect(getTableConfig(aiMasterCorpusRuns).checks.map((c) => c.name).sort()).toEqual(attendues);
  });
});
