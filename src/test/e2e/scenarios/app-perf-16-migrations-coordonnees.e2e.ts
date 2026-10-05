/**
 * APP-PERF-16 — recette des migrations coordonnées sur PostgreSQL réel.
 *
 * Données synthétiques, schéma dédié par cas (search_path de la connexion),
 * jamais les migrations du produit :
 *   T-01 deux exécutants simultanés (deux clients, puis deux PROCESSUS
 *        `scripts/migrate.mjs`) : une seule exécution, états cohérents ;
 *        verrou détenu ailleurs : attente bornée, aucune DDL ;
 *   T-02 migration critique en échec (exit 1, `failed`), puis optionnelle
 *        (exit 0, `degraded`) ;
 *   T-03 construction d'index interrompue (index INVALIDE) : reprise au
 *        passage suivant, index valide.
 */
import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { scenario } from '../scenario';
import {
  MIGRATION_RUNNER_LOCK_KEY, indexValidity, runMigrations, type MigrationFile, type SqlRunner,
} from '@/db/migration-index';

const silencieux = { info: () => {}, warn: () => {}, error: () => {} };

function clientSur(schema: string) {
  return postgres(process.env.DATABASE_URL!, {
    max: 2, prepare: false, onnotice: () => undefined, connection: { search_path: schema },
  });
}
const runner = (c: postgres.Sql) => c as unknown as SqlRunner;

async function avecSchema<T>(sql: postgres.Sql, fn: (schema: string) => Promise<T>): Promise<T> {
  const schema = `perf16_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  try {
    return await fn(schema);
  } finally {
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  }
}

/** Fichier lent qui compte ses exécutions : deux exécutions = défaut. */
const FICHIERS: MigrationFile[] = [
  { filename: '0001_base.sql', sql: 'CREATE TABLE IF NOT EXISTS execs (n int); INSERT INTO execs VALUES (1); CREATE TABLE IF NOT EXISTS t (id int, v int); SELECT pg_sleep(0.8);' },
  { filename: '0001_base_idx_1.sql', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON t (v);' },
];

function lancerScript(schema: string, dir: string): Promise<{ code: number | null; sortie: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/migrate.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MIGRATIONS_DIR: dir, MIGRATIONS_SCHEMA: schema, MIGRATION_LOCK_WAIT_MS: '30000' },
    });
    let sortie = '';
    p.stdout.on('data', (d) => { sortie += d; });
    p.stderr.on('data', (d) => { sortie += d; });
    p.on('close', (code) => resolve({ code, sortie }));
  });
}

async function dossier(files: MigrationFile[]): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'perf16-'));
  for (const f of files) await writeFile(join(d, f.filename), f.sql);
  return d;
}

scenario('APP-PERF-16', 'Migrations coordonnées et readiness du schéma', ({ sql }) => {
  it('T-01 : deux exécutants simultanés → une seule exécution, les deux concluent `ready`', async () => {
    await avecSchema(sql, async (schema) => {
      const a = clientSur(schema);
      const b = clientSur(schema);
      try {
        const [ra, rb] = await Promise.all([
          runMigrations(runner(a), FICHIERS, { log: silencieux, lockWaitMs: 30_000, lockPollMs: 50 }),
          runMigrations(runner(b), FICHIERS, { log: silencieux, lockWaitMs: 30_000, lockPollMs: 50 }),
        ]);
        expect([ra.outcome, rb.outcome]).toEqual(['ready', 'ready']);
        expect(ra.applied.length + rb.applied.length).toBe(2);
        // L'un a attendu le verrou de l'autre.
        expect(Math.max(ra.lockWaitMs, rb.lockWaitMs)).toBeGreaterThanOrEqual(500);
        const [{ n }] = await a.unsafe(`SELECT count(*)::int AS n FROM execs`) as unknown as Array<{ n: number }>;
        expect(n).toBe(1);
      } finally {
        await a.end({ timeout: 5 });
        await b.end({ timeout: 5 });
      }
    });
  });

  it('T-01 : deux PROCESSUS `scripts/migrate.mjs` (étape postdeploy) → une exécution, exit 0 ×2', async () => {
    await avecSchema(sql, async (schema) => {
      const d = await dossier(FICHIERS);
      try {
        const [p1, p2] = await Promise.all([lancerScript(schema, d), lancerScript(schema, d)]);
        expect([p1.code, p2.code], `${p1.sortie}\n---\n${p2.sortie}`).toEqual([0, 0]);
        expect(`${p1.sortie}${p2.sortie}`).toMatch(/"outcome":"ready"/);
        const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${schema}.execs`) as unknown as Array<{ n: number }>;
        expect(n).toBe(1);
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    });
  }, 60_000);

  it('T-01 : verrou détenu ailleurs → attente bornée, aucune DDL, `waiting`', async () => {
    await avecSchema(sql, async (schema) => {
      const autre = await sql.reserve();
      const c = clientSur(schema);
      try {
        await autre.unsafe(`SELECT pg_advisory_lock(hashtext($1))`, [MIGRATION_RUNNER_LOCK_KEY]);
        const debut = Date.now();
        const r = await runMigrations(runner(c), FICHIERS, { log: silencieux, lockWaitMs: 300, lockPollMs: 50 });
        expect(Date.now() - debut).toBeLessThan(5_000);
        expect(r).toMatchObject({ outcome: 'waiting', lockAcquired: false, applied: [] });
        expect(r.pendingCritical).toEqual(['0001_base.sql']);
        const [{ existe }] = await sql.unsafe(`SELECT to_regclass('${schema}.execs') IS NOT NULL AS existe`) as unknown as Array<{ existe: boolean }>;
        expect(existe).toBe(false);
      } finally {
        await autre.unsafe(`SELECT pg_advisory_unlock(hashtext($1))`, [MIGRATION_RUNNER_LOCK_KEY]).catch(() => undefined);
        autre.release();
        await c.end({ timeout: 5 });
      }
    });
  });

  it('T-02 : critique en échec → exit 1 / `failed` ; corrigée puis optionnelle en échec → exit 0 / `degraded`', async () => {
    await avecSchema(sql, async (schema) => {
      const critique: MigrationFile[] = [
        { filename: '0001_ok.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id int);' },
        { filename: '0002_ko.sql', sql: 'ALTER TABLE table_absente ADD COLUMN x int;' },
      ];
      const d1 = await dossier(critique);
      try {
        const p = await lancerScript(schema, d1);
        expect(p.code, p.sortie).toBe(1);
        expect(p.sortie).toMatch(/PREMIÈRE CAUSE : 0002_ko\.sql \(42P01\)/);
        expect(p.sortie).toMatch(/"outcome":"failed"/);
      } finally {
        await rm(d1, { recursive: true, force: true });
      }
      const optionnelle: MigrationFile[] = [
        critique[0],
        { filename: '0002_ko.sql', sql: 'CREATE TABLE IF NOT EXISTS table_absente (id int);' },
        { filename: '0002_ko_idx_1.sql', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_absente_idx ON t (colonne_absente);' },
      ];
      const d2 = await dossier(optionnelle);
      try {
        const p = await lancerScript(schema, d2);
        expect(p.code, p.sortie).toBe(0);
        expect(p.sortie).toMatch(/"outcome":"degraded"/);
      } finally {
        await rm(d2, { recursive: true, force: true });
      }
    });
  }, 60_000);

  it('T-03 : index interrompu (INVALIDE) → reconstruit au passage suivant, valide', async () => {
    await avecSchema(sql, async (schema) => {
      const c = clientSur(schema);
      try {
        await c.unsafe(`CREATE TABLE t (id int, v int)`);
        // Construction interrompue simulée : index présent mais invalide, fichier non marqué.
        await c.unsafe(`CREATE INDEX t_v_idx ON t (v)`);
        await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${schema}.t_v_idx'::regclass`);
        expect(await indexValidity(runner(c), 't_v_idx')).toBe(false);
        const r = await runMigrations(runner(c), [FICHIERS[1]], { log: silencieux });
        expect(r.outcome).toBe('ready');
        expect(await indexValidity(runner(c), 't_v_idx')).toBe(true);

        // Index rendu invalide APRÈS marquage : réparé par l'étape de déploiement.
        await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${schema}.t_v_idx'::regclass`);
        const sansReparation = await runMigrations(runner(c), [FICHIERS[1]], { log: silencieux });
        expect(sansReparation.outcome).toBe('ready');
        expect(await indexValidity(runner(c), 't_v_idx')).toBe(false);
        const avec = await runMigrations(runner(c), [FICHIERS[1]], { log: silencieux, repairIndexes: true });
        expect(avec.repair?.repaired).toEqual(['t_v_idx']);
        expect(await indexValidity(runner(c), 't_v_idx')).toBe(true);
      } finally {
        await c.end({ timeout: 5 });
      }
    });
  });
});
