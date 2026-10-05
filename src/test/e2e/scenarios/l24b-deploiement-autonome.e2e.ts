/**
 * Lot 24b — le déploiement réussit seul, sans intervention en base
 * (incident préprod du 05/10 : `CREATE INDEX CONCURRENTLY` en 55P03 au bout
 * de 10 s derrière les transactions de l'ancienne version, index laissés
 * INVALIDES, démarrage web en concurrence avec le postdeploy).
 *
 * PostgreSQL réel, schéma dédié par cas, fichiers synthétiques :
 *   T-01 transaction ancienne ouverte sur une autre connexion pendant la
 *        construction : délai court → 55P03, bloqueurs journalisés, passage
 *        `degraded` (index optionnel : non bloquant), une seule tentative ;
 *        délai long → succès dès la fin de la transaction ;
 *   T-02 étape de déploiement (`scripts/migrate.mjs`) avec index INVALIDES
 *        préexistants et transaction ancienne : exit 0, puis réparés ;
 *   T-03 démarrage web pendant un postdeploy : attente puis schéma prêt,
 *        aucune double application, aucun index construit par le web ;
 *   T-04 reconstruction en arrière-plan d'un index resté en attente, sans le
 *        verrou de l'exécutant.
 */
import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { scenario } from '../scenario';
import {
  MIGRATION_RUNNER_LOCK_KEY, indexValidity, runBootMigrations, runIndexMaintenance, runMigrations,
  type MigrationFile, type SqlRunner,
} from '@/db/migration-index';

function journal() {
  const lignes: string[] = [];
  return { lignes, log: { info: (m: string) => lignes.push(m), warn: (m: string) => lignes.push(m), error: (m: string) => lignes.push(m) } };
}

function clientSur(schema: string, nom = 'e2e-l24b') {
  return postgres(process.env.DATABASE_URL!, {
    max: 3, prepare: false, onnotice: () => undefined, connection: { search_path: schema, application_name: nom },
  });
}
const runner = (c: postgres.Sql) => c as unknown as SqlRunner;

async function avecSchema<T>(sql: postgres.Sql, fn: (schema: string) => Promise<T>): Promise<T> {
  const schema = `l24b_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  try {
    return await fn(schema);
  } finally {
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  }
}

/**
 * Transaction ANCIENNE (comme celles de l'ancienne version qui sert encore) :
 * instantané REPEATABLE READ sur une AUTRE table. `CREATE INDEX CONCURRENTLY`
 * l'attend quand même (instantanés plus anciens de la base courante).
 */
async function ouvrirBloqueur(schema: string) {
  const b = clientSur(schema, 'e2e-bloqueur');
  const cnx = await b.reserve();
  await cnx.unsafe(`CREATE TABLE IF NOT EXISTS autre (id int)`);
  await cnx.unsafe(`BEGIN ISOLATION LEVEL REPEATABLE READ`);
  await cnx.unsafe(`SELECT count(*) FROM autre`);
  const [{ pid }] = await cnx.unsafe(`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>;
  let ferme = false;
  return {
    pid,
    fermer: async () => {
      if (ferme) return;
      ferme = true;
      await cnx.unsafe('COMMIT').catch(() => undefined);
      cnx.release();
      await b.end({ timeout: 5 });
    },
  };
}

const BASE: MigrationFile = { filename: '0001_base.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id int, v int, w int); INSERT INTO t SELECT g, g, g FROM generate_series(1, 200) g;' };
const IDX_V: MigrationFile = { filename: '0001_base_idx_1.sql', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON t (v);' };
const IDX_W: MigrationFile = { filename: '0001_base_idx_2.sql', sql: '-- verebona:optional-index\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_w_uidx ON t (w);' };

function lancerScript(schema: string, dir: string, env: Record<string, string> = {}): Promise<{ code: number | null; sortie: string; ms: number }> {
  const debut = Date.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/migrate.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MIGRATIONS_DIR: dir, MIGRATIONS_SCHEMA: schema, MIGRATION_LOCK_WAIT_MS: '30000', ...env },
    });
    let sortie = '';
    p.stdout.on('data', (d) => { sortie += d; });
    p.stderr.on('data', (d) => { sortie += d; });
    p.on('close', (code) => resolve({ code, sortie, ms: Date.now() - debut }));
  });
}

async function dossier(files: MigrationFile[]): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'l24b-'));
  for (const f of files) await writeFile(join(d, f.filename), f.sql);
  return d;
}

async function marques(sql: postgres.Sql, schema: string): Promise<string[]> {
  const rows = await sql.unsafe(`SELECT filename FROM ${schema}._migrations ORDER BY 1`) as unknown as Array<{ filename: string }>;
  return rows.map((r) => r.filename);
}

scenario('L24B', 'Déploiement autonome : index CONCURRENTLY, transactions anciennes, coordination', ({ sql }) => {
  it('T-01 : délai court → 55P03 journalisé, `degraded`, tentative unique ; délai long → succès à la fin de la transaction', async () => {
    await avecSchema(sql, async (schema) => {
      const c = clientSur(schema);
      const bloqueur = await ouvrirBloqueur(schema);
      try {
        const j = journal();
        const r = await runMigrations(runner(c), [BASE, IDX_V], { log: j.log, indexLockTimeout: '1s', repairIndexes: true });
        expect(r.outcome).toBe('degraded');
        expect(r.applied).toEqual(['0001_base.sql']);
        expect(r.failures).toEqual([expect.objectContaining({ filename: '0001_base_idx_1.sql', code: '55P03', criticality: 'optional' })]);
        expect(r.failures[0].blockers?.map((b) => b.pid)).toContain(bloqueur.pid);
        const texte = j.lignes.join('\n');
        expect(texte).toMatch(new RegExp(`pid=${bloqueur.pid} app=e2e-bloqueur state=idle in transaction`));
        expect(texte).toMatch(/transaction=\d+s query="SELECT pg_backend_pid\(\) AS pid"/);
        // Index laissé invalide par la construction interrompue : PAS retenté par la réparation.
        expect(await indexValidity(runner(c), 't_v_idx')).toBe(false);
        expect(r.repair?.skipped).toEqual(['t_v_idx']);
        expect(texte.match(/délai de verrou dépassé \(55P03\)/g)).toHaveLength(1);

        // Délai long : la construction attend la fin de la transaction, puis réussit.
        const debut = Date.now();
        const enCours = runMigrations(runner(c), [BASE, IDX_V], { log: journal().log, indexLockTimeout: '30s', repairIndexes: true });
        await new Promise((res) => setTimeout(res, 1_500));
        await bloqueur.fermer();
        const r2 = await enCours;
        expect(r2.outcome).toBe('ready');
        expect(Date.now() - debut).toBeGreaterThanOrEqual(1_400);
        expect(await indexValidity(runner(c), 't_v_idx')).toBe(true);
      } finally {
        await bloqueur.fermer();
        await c.end({ timeout: 5 });
      }
    });
  }, 60_000);

  it('T-02 : postdeploy avec index INVALIDES préexistants et transaction ancienne → exit 0, puis réparés au passage suivant', async () => {
    await avecSchema(sql, async (schema) => {
      const c = clientSur(schema);
      await c.unsafe(BASE.sql);
      // État de la préprod : index invalides (constructions interrompues), fichiers non marqués.
      for (const ddl of ['CREATE INDEX t_v_idx ON t (v)', 'CREATE UNIQUE INDEX t_w_uidx ON t (w)']) await c.unsafe(ddl);
      await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid IN ('${schema}.t_v_idx'::regclass, '${schema}.t_w_uidx'::regclass)`);
      await c.unsafe(`CREATE TABLE _migrations (id serial PRIMARY KEY, filename text NOT NULL UNIQUE, applied_at timestamptz NOT NULL DEFAULT now())`);
      await c.unsafe(`INSERT INTO _migrations (filename) VALUES ('0001_base.sql')`);
      const d = await dossier([BASE, IDX_V, IDX_W]);
      const bloqueur = await ouvrirBloqueur(schema);
      try {
        const p = await lancerScript(schema, d, { MIGRATION_INDEX_LOCK_TIMEOUT: '1s' });
        expect(p.code, p.sortie).toBe(0);
        expect(p.sortie).toMatch(/"outcome":"degraded"/);
        expect(p.sortie).toMatch(/app=e2e-bloqueur/);
        // Après le premier 55P03, le second index n'est pas tenté : la même transaction l'aurait bloqué.
        expect(p.sortie).toMatch(/0001_base_idx_2\.sql differee \(index t_w_uidx : transaction bloquante toujours ouverte/);
        expect(p.sortie.match(/délai de verrou dépassé \(55P03\)/g)).toHaveLength(1);
        expect(p.sortie).toMatch(/déploiement NON bloqué/);
        expect(p.ms).toBeLessThan(20_000);
      } finally {
        await bloqueur.fermer();
      }
      try {
        const p = await lancerScript(schema, d);
        expect(p.code, p.sortie).toBe(0);
        expect(p.sortie).toMatch(/"outcome":"ready"/);
        expect(await indexValidity(runner(c), 't_v_idx')).toBe(true);
        expect(await indexValidity(runner(c), 't_w_uidx')).toBe(true);
        expect(await marques(sql, schema)).toEqual(['0001_base.sql', '0001_base_idx_1.sql', '0001_base_idx_2.sql']);
      } finally {
        await rm(d, { recursive: true, force: true });
        await c.end({ timeout: 5 });
      }
    });
  }, 90_000);

  it('T-03 : démarrage web pendant le postdeploy → attente, schéma prêt, aucune double application, aucun index par le web', async () => {
    await avecSchema(sql, async (schema) => {
      const lent: MigrationFile = { filename: '0001_base.sql', sql: 'CREATE TABLE IF NOT EXISTS execs (n int); INSERT INTO execs VALUES (1); CREATE TABLE IF NOT EXISTS t (id int, v int, w int); SELECT pg_sleep(2);' };
      const fichiers = [lent, IDX_V];
      const d = await dossier(fichiers);
      const web = clientSur(schema, 'e2e-web');
      try {
        const postdeploy = lancerScript(schema, d);
        // Le postdeploy tient le verrou de l'exécutant.
        for (let i = 0; i < 100; i += 1) {
          const [{ n }] = await sql.unsafe(
            `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE l.locktype = 'advisory' AND a.application_name LIKE 'verebona-migrate%'`,
          ) as unknown as Array<{ n: number }>;
          if (n > 0) break;
          await new Promise((res) => setTimeout(res, 100));
        }
        const j = journal();
        const r = await runBootMigrations(runner(web), fichiers, { log: j.log, pollMs: 200, waitMs: 30_000 });
        expect(['ready', 'degraded']).toContain(r.outcome);
        expect(r.applied).toEqual([]);
        expect(r.pendingCritical).toEqual([]);
        expect(j.lignes.join('\n')).toMatch(/un autre exécutant \(étape de déploiement \?\) a la main/);
        const p = await postdeploy;
        expect(p.code, p.sortie).toBe(0);
        const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${schema}.execs`) as unknown as Array<{ n: number }>;
        expect(n).toBe(1);
        expect(await indexValidity(runner(web), 't_v_idx')).toBe(true); // construit par le postdeploy
      } finally {
        await rm(d, { recursive: true, force: true });
        await web.end({ timeout: 5 });
      }
    });
  }, 60_000);

  it('T-03 bis : web seul (local, sans postdeploy) → critiques appliqués, AUCUN index CONCURRENTLY construit', async () => {
    await avecSchema(sql, async (schema) => {
      const web = clientSur(schema, 'e2e-web');
      try {
        const r = await runBootMigrations(runner(web), [BASE, IDX_V], { log: journal().log });
        expect(r).toMatchObject({ outcome: 'degraded', applied: ['0001_base.sql'], skipped: ['0001_base_idx_1.sql'] });
        expect(await indexValidity(runner(web), 't_v_idx')).toBeNull();
      } finally {
        await web.end({ timeout: 5 });
      }
    });
  });

  it('T-04 : index resté en attente → reconstruit en arrière-plan, sans le verrou de l’exécutant', async () => {
    await avecSchema(sql, async (schema) => {
      const c = clientSur(schema);
      const autre = await sql.reserve();
      const bloqueur = await ouvrirBloqueur(schema);
      try {
        const r = await runMigrations(runner(c), [BASE, IDX_V, IDX_W], { log: journal().log, indexLockTimeout: '1s', repairIndexes: true });
        expect(r.outcome).toBe('degraded');
        expect(r.pendingOptional.sort()).toEqual(['0001_base_idx_1.sql', '0001_base_idx_2.sql']);
        await bloqueur.fermer(); // l'ancienne version s'est arrêtée

        // Un autre exécutant tient le verrou (déploiement suivant) : la maintenance n'en a pas besoin.
        await autre.unsafe(`SELECT pg_advisory_lock(hashtext($1))`, [MIGRATION_RUNNER_LOCK_KEY]);
        const j = journal();
        const m = await runIndexMaintenance(runner(c), [BASE, IDX_V, IDX_W], { log: j.log, indexLockTimeout: '30s' });
        expect(m.kind).toBe('done');
        expect(m.built.sort()).toEqual(['0001_base_idx_1.sql', '0001_base_idx_2.sql']);
        expect(await indexValidity(runner(c), 't_v_idx')).toBe(true);
        expect(await indexValidity(runner(c), 't_w_uidx')).toBe(true);
        expect(await marques(sql, schema)).toEqual(['0001_base.sql', '0001_base_idx_1.sql', '0001_base_idx_2.sql']);
        // Plus rien à faire : passage suivant `done` sans construction.
        expect((await runIndexMaintenance(runner(c), [BASE, IDX_V, IDX_W], { log: journal().log })).built).toEqual([]);
      } finally {
        await bloqueur.fermer();
        await autre.unsafe(`SELECT pg_advisory_unlock(hashtext($1))`, [MIGRATION_RUNNER_LOCK_KEY]).catch(() => undefined);
        autre.release();
        await c.end({ timeout: 5 });
      }
    });
  }, 60_000);
});
