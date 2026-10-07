/**
 * Migrations 0254 / 0255 (BO-IA-PROMPTS-01, lot 27) : tables neuves
 * déclarées dans Drizzle (protection contre `db:push`), alignées EXACTEMENT
 * sur le SQL (colonnes, NOT NULL, contraintes, index) ; migrations
 * idempotentes, sans CONCURRENTLY (tables neuves, vides).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { aiMasterPromptActivations, aiMasterPromptTestRuns, aiMasterPromptVersions } from '../schema';

const MIG = join(process.cwd(), 'src/db/migrations');
const lire = (f: string) => readFileSync(join(MIG, f), 'utf8').replace(/--.*$/gm, '');

function sqlTable(file: string, table: string) {
  const sql = lire(file);
  const bloc = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)![1];
  const colonnes = new Map<string, boolean>();
  for (const l of bloc.split(',\n').map((x) => x.trim()).filter(Boolean)) {
    const [nom] = l.split(/\s+/);
    colonnes.set(nom, /NOT NULL|PRIMARY KEY/i.test(l));
  }
  const contraintes = [...sql.matchAll(new RegExp(`ALTER TABLE ${table} ADD CONSTRAINT (\\w+)\\s+(CHECK|UNIQUE)`, 'g'))]
    .map((m) => ({ nom: m[1], type: m[2] }));
  const index = [...sql.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\\w+)\\s+ON ${table}\\b`, 'g'))].map((m) => m[1]);
  return { colonnes, contraintes, index };
}

const CAS: Array<[PgTable, string, string]> = [
  [aiMasterPromptVersions, '0254_ai_master_prompt_versions.sql', 'ai_master_prompt_versions'],
  [aiMasterPromptActivations, '0254_ai_master_prompt_versions.sql', 'ai_master_prompt_activations'],
  [aiMasterPromptTestRuns, '0255_ai_master_prompt_test_runs.sql', 'ai_master_prompt_test_runs'],
];

describe('0254 / 0255 : Drizzle = SQL', () => {
  for (const [table, file, nom] of CAS) {
    it(nom, () => {
      const cfg = getTableConfig(table);
      const s = sqlTable(file, nom);
      expect(cfg.name).toBe(nom);
      expect(Object.fromEntries(cfg.columns.map((c) => [c.name, c.notNull || c.primary]))).toEqual(Object.fromEntries(s.colonnes));
      expect(cfg.checks.map((c) => c.name).sort()).toEqual(s.contraintes.filter((c) => c.type === 'CHECK').map((c) => c.nom).sort());
      expect(cfg.uniqueConstraints.map((c) => c.getName()).sort()).toEqual(s.contraintes.filter((c) => c.type === 'UNIQUE').map((c) => c.nom).sort());
      expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual(s.index.sort());
    });
  }

  it('migrations idempotentes, sans index CONCURRENTLY (tables neuves), numéros réservés du lot 27', () => {
    for (const f of ['0254_ai_master_prompt_versions.sql', '0255_ai_master_prompt_test_runs.sql']) {
      const sql = lire(f);
      expect(sql).not.toMatch(/CONCURRENTLY/);
      expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
      expect(sql).not.toMatch(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/);
      expect(sql).toMatch(/lock_timeout/);
    }
  });

  it('immuabilité d’une version activée garantie en base (déclencheur)', () => {
    const sql = lire('0254_ai_master_prompt_versions.sql');
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION ai_master_prompt_versions_immutable\(\)/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS ai_master_prompt_versions_immutable_trg/);
    expect(sql).toMatch(/OLD\.status <> 'DRAFT'/);
  });
});
