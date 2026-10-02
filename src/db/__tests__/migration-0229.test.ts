/**
 * Migration 0229 — fusion des pièces sur `substructures` (D-G, lot 20) :
 * forme des fichiers (index CONCURRENTLY seuls, tolérance CRLF), cohérence
 * avec le schéma Drizzle. L'exécution réelle (neutralisation unique,
 * déclencheur, reprise) est couverte par le scénario E2E
 * `d-g-pieces-sous-structures.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { concurrentIndexName } from '../migration-index';
import { documentAssetLinks } from '../schema';

const MIG = join(process.cwd(), 'src/db/migrations');
const lire = (f: string) => readFileSync(join(MIG, f), 'utf8');
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

describe('0229 — fichiers', () => {
  it('idx_1 et idx_2 : une seule instruction CONCURRENTLY, reconnue aussi en CRLF', () => {
    for (const [f, nom] of [
      ['0229_rooms_to_substructures_idx_1.sql', 'substructures_legacy_room_uidx'],
      ['0229_rooms_to_substructures_idx_2.sql', 'document_asset_links_active_uniq2'],
    ] as const) {
      expect(concurrentIndexName(lire(f))).toBe(nom);
      expect(concurrentIndexName(crlf(lire(f)))).toBe(nom);
    }
  });

  it('idx_3 : suppression de l’ancienne unicité GARDÉE (colonne et uniq2 valide, sinon exception), APRÈS la nouvelle', () => {
    const corps = lire('0229_rooms_to_substructures_idx_3.sql').replace(/--.*$/gm, '');
    expect(concurrentIndexName(corps)).toBeNull(); // pas un CREATE INDEX CONCURRENTLY : exécuté tel quel
    expect(corps).toMatch(/RAISE EXCEPTION[^;]*substructure_id absente/);
    expect(corps).toMatch(/document_asset_links_active_uniq2'[\s\S]*i\.indisvalid[\s\S]*RAISE EXCEPTION/);
    expect(corps.indexOf('RAISE EXCEPTION')).toBeLessThan(corps.indexOf('DROP INDEX IF EXISTS document_asset_links_active_uniq;'));
    const ordre = ['0229_rooms_to_substructures.sql', '0229_rooms_to_substructures_idx_1.sql',
      '0229_rooms_to_substructures_idx_2.sql', '0229_rooms_to_substructures_idx_3.sql', '0230_assistant_admin_and_usage.sql'];
    expect([...ordre].sort()).toEqual(ordre);
  });

  it('fichier principal : neutralisation gardée par le marqueur, `rooms` jamais supprimée', () => {
    const sql = lire('0229_rooms_to_substructures.sql').replace(/--.*$/gm, '');
    expect(sql).toMatch(/IF to_regclass\('room_merge_runs'\) IS NULL THEN/);
    expect(sql.indexOf("to_regclass('room_merge_runs') IS NULL")).toBeLessThan(sql.indexOf('CREATE TABLE IF NOT EXISTS room_merge_runs'));
    expect(sql).not.toMatch(/DROP\s+TABLE[^;]*\brooms\b/i);
    expect(sql).not.toMatch(/CONCURRENTLY/);
    for (const c of ['legacy_room_id', 'room_type', 'area', 'description', 'key_characteristics']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE substructures ADD COLUMN IF NOT EXISTS ${c}\\b`));
    }
  });
});

describe('0229 — Drizzle = SQL (document_asset_links)', () => {
  it('colonne substructure_id, unicité étendue et contrainte de cible', () => {
    const cfg = getTableConfig(documentAssetLinks);
    expect(cfg.columns.map((c) => c.name)).toContain('substructure_id');
    expect(cfg.indexes.map((i) => i.config.name)).toContain('document_asset_links_active_uniq2');
    expect(cfg.indexes.map((i) => i.config.name)).not.toContain('document_asset_links_active_uniq');
    const sql = lire('0229_rooms_to_substructures.sql');
    expect(sql).toMatch(/FOREIGN KEY \(substructure_id\) REFERENCES substructures\(id\) ON DELETE SET NULL/);
    expect(cfg.foreignKeys.find((f) => f.reference().columns[0].name === 'substructure_id')?.onDelete).toBe('set null');
    expect(sql).toMatch(/ADD CONSTRAINT document_asset_links_target_check\s+CHECK \(asset_id IS NOT NULL OR room_id IS NOT NULL OR equipment_id IS NOT NULL OR substructure_id IS NOT NULL\)/);
    expect(cfg.checks.map((c) => c.name)).toContain('document_asset_links_target_check');
  });
});
