/**
 * APP-PERF-01 — pool PostgreSQL explicite pour Scalingo.
 *
 * T-01 : démarrer avec DB_POOL_MAX valide, nul, négatif et non numérique →
 * valeur effective explicite ou rejet contrôlé ; aucun secret dans les logs.
 * CA-01 : la configuration ne dépend plus de Vercel ni du runtime Next.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DB_POOL_MAX,
  PoolConfigError,
  describePoolConfig,
  resolvePoolConfig,
} from '@/db/pool-config';

describe('resolvePoolConfig', () => {
  it('valeur valide : appliquée telle quelle, origine explicite', () => {
    const c = resolvePoolConfig({ DB_POOL_MAX: '7' });
    expect(c).toMatchObject({ max: 7, maxSource: 'DB_POOL_MAX' });
  });

  it('absente ou vide : valeur par défaut, signalée comme telle', () => {
    expect(resolvePoolConfig({})).toMatchObject({ max: DEFAULT_DB_POOL_MAX, maxSource: 'défaut' });
    expect(resolvePoolConfig({ DB_POOL_MAX: '  ' })).toMatchObject({ max: DEFAULT_DB_POOL_MAX, maxSource: 'défaut' });
  });

  it.each(['0', '-3', 'abc', '5abc', '1.5', '1e2', 'NaN'])('valeur invalide « %s » : rejet contrôlé', (v) => {
    expect(() => resolvePoolConfig({ DB_POOL_MAX: v })).toThrow(PoolConfigError);
    expect(() => resolvePoolConfig({ DB_POOL_MAX: v })).toThrow(/DB_POOL_MAX invalide/);
  });

  it('borne de sécurité : une taille démesurée est refusée, pas appliquée', () => {
    expect(() => resolvePoolConfig({ DB_POOL_MAX: '500' })).toThrow(/borne de sécurité/);
  });

  it('CA-01 : VERCEL et NEXT_RUNTIME n’ont plus aucun effet', () => {
    const base = resolvePoolConfig({ DB_POOL_MAX: '6' });
    expect(resolvePoolConfig({ DB_POOL_MAX: '6', VERCEL: '1', NEXT_RUNTIME: 'nodejs' })).toEqual(base);
    expect(resolvePoolConfig({ NEXT_RUNTIME: 'nodejs' }).max).toBe(DEFAULT_DB_POOL_MAX);
  });

  it('durées d’un processus persistant, surchargeables et validées', () => {
    expect(resolvePoolConfig({})).toMatchObject({ idleTimeoutS: 60, maxLifetimeS: 1800, connectTimeoutS: 20 });
    expect(resolvePoolConfig({ DB_POOL_IDLE_TIMEOUT_S: '120', DB_POOL_MAX_LIFETIME_S: '900' }))
      .toMatchObject({ idleTimeoutS: 120, maxLifetimeS: 900 });
    expect(() => resolvePoolConfig({ DB_POOL_IDLE_TIMEOUT_S: '0' })).toThrow(PoolConfigError);
  });

  it('rôle du processus : DB_PROCESS_ROLE, sinon CONTAINER (Scalingo), sinon web', () => {
    expect(resolvePoolConfig({}).role).toBe('web');
    expect(resolvePoolConfig({ CONTAINER: 'web-2' }).role).toBe('web-2');
    expect(resolvePoolConfig({ CONTAINER: 'web-2', DB_PROCESS_ROLE: 'worker' }).role).toBe('worker');
  });

  it('journal de démarrage : valeurs effectives, jamais DATABASE_URL ni identifiant', () => {
    const env = { DB_POOL_MAX: '4', DATABASE_URL: 'postgres://admin:s3cr3t@db.interne:5432/prod', CONTAINER: 'web-1' };
    const ligne = describePoolConfig(resolvePoolConfig(env));
    expect(ligne).toMatch(/rôle=web-1 max=4 \(DB_POOL_MAX\)/);
    expect(ligne).not.toMatch(/s3cr3t|admin|db\.interne|postgres:\/\//);
  });
});

describe('câblage', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('src/db/index.ts : plus de détection VERCEL / NEXT_RUNTIME, prepare: false conservé', () => {
    const src = read('src/db/index.ts');
    expect(src).not.toMatch(/process\.env\.VERCEL|process\.env\.NEXT_RUNTIME|isServerless/);
    expect(src).toMatch(/max: poolConfig\.max/);
    expect(src).toMatch(/prepare: false/);
    expect(src).toMatch(/console\.info\(describePoolConfig\(poolConfig\)\)/);
  });

  it('.env.example documente DB_POOL_MAX', () => {
    expect(read('.env.example')).toMatch(/^DB_POOL_MAX=/m);
  });
});
