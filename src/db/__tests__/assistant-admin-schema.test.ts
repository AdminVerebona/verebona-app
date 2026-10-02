/**
 * Lot 21 — tables de la migration 0230 déclarées dans Drizzle
 * (`verebona-schema.ts`, protection contre `db:push`) : colonnes, NOT NULL,
 * contraintes CHECK et index alignés sur le SQL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { verebonaAssistantSettings, verebonaAssistantSettingRequests, verebonaRateLimitCounters, verebonaUsageEvents } from '../verebona-schema';

const SQL = readFileSync(join(process.cwd(), 'src/db/migrations/0230_assistant_admin_and_usage.sql'), 'utf8').replace(/--.*$/gm, '');

function sqlTable(table: string) {
  const bloc = new RegExp(`CREATE (?:UNLOGGED )?TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(SQL)![1];
  const colonnes = new Map<string, boolean>();
  for (const l of bloc.split(',\n').map((x) => x.trim()).filter(Boolean)) {
    if (/^(CONSTRAINT|PRIMARY KEY)\b/i.test(l)) continue;
    const [nom] = l.split(/\s+/);
    colonnes.set(nom, /NOT NULL|PRIMARY KEY/i.test(l));
  }
  const checks = [...bloc.matchAll(/CONSTRAINT (\w+)\s+CHECK/g)].map((m) => m[1]);
  const index = [...SQL.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\\w+)\\s+ON ${table}\\b`, 'g'))].map((m) => m[1]);
  return { colonnes, checks, index };
}

const CAS: Array<[PgTable, string]> = [
  [verebonaAssistantSettings, 'verebona_assistant_settings'],
  [verebonaAssistantSettingRequests, 'verebona_assistant_setting_requests'],
  [verebonaRateLimitCounters, 'verebona_rate_limit_counters'],
  [verebonaUsageEvents, 'verebona_usage_events'],
];

describe('0230 : Drizzle = SQL', () => {
  for (const [table, nom] of CAS) {
    it(nom, () => {
      const cfg = getTableConfig(table);
      const s = sqlTable(nom);
      expect(cfg.name).toBe(nom);
      const pk = new Set(cfg.primaryKeys.flatMap((p) => p.columns.map((c) => c.name)));
      expect(Object.fromEntries(cfg.columns.map((c) => [c.name, c.notNull || c.primary || pk.has(c.name)]))).toEqual(Object.fromEntries(s.colonnes));
      expect(cfg.checks.map((c) => c.name).sort()).toEqual(s.checks.sort());
      expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual(s.index.sort());
    });
  }
});
