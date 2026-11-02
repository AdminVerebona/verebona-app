/**
 * Lot 100A — isolation de la série E2E : parties pures (sans base).
 */
import { describe, it, expect } from 'vitest';
import { restoreProcessEnv, stableOrder } from '../isolation';
import { derivedDatabaseName } from '../db-bootstrap';

describe('L100A — isolation de la série E2E', () => {
  it('environnement : variables ajoutées supprimées, modifiées et supprimées rétablies, celles de vitest intactes', () => {
    const origine = { A: '1', B: '2', VITEST_POOL_ID: '1' };
    const env = { A: '1', B: 'modifiée', AJOUT: 'x', VITEST_WORKER_ID: '7', VITEST_POOL_ID: '3' } as unknown as NodeJS.ProcessEnv;
    expect(restoreProcessEnv(env, origine)).toEqual(['AJOUT', 'B']);
    expect(env).toEqual({ A: '1', B: '2', VITEST_WORKER_ID: '7', VITEST_POOL_ID: '3' });
    delete env.A;
    expect(restoreProcessEnv(env, origine)).toEqual(['A']);
    expect(env.A).toBe('1');
    expect(restoreProcessEnv(env, origine)).toEqual([]);
  });

  it('ordre stable : chemin du fichier, indépendant de l’ordre reçu', () => {
    const f = (moduleId: string) => ({ moduleId });
    const a = [f('/r/s/l82e.e2e.ts'), f('/r/s/l52a.e2e.ts'), f('/r/s/corpus.e2e.ts')];
    expect(stableOrder(a).map((x) => x.moduleId)).toEqual(['/r/s/corpus.e2e.ts', '/r/s/l52a.e2e.ts', '/r/s/l82e.e2e.ts']);
    expect(stableOrder([...a].reverse())).toEqual(stableOrder(a));
    expect(a[0].moduleId).toBe('/r/s/l82e.e2e.ts'); // entrée non modifiée
  });

  it('noms de bases dérivées : identifiants PostgreSQL sûrs, 63 caractères au plus', () => {
    expect(derivedDatabaseName('verebona_e2e_1793283911360_940', 'modele')).toBe('verebona_e2e_1793283911360_940_modele');
    expect(derivedDatabaseName('verebona_e2e_1_2_f', 'Ab-9')).toBe('verebona_e2e_1_2_f_ab_9');
    expect(() => derivedDatabaseName('x'.repeat(60), 'suffixe')).toThrow(/invalide/);
  });
});

describe('Lot 103 — DATABASE_URL jamais absente pendant la copie de la base du fichier', () => {
  it('setup.ts pose DATABASE_URL (URL de la base du fichier) AVANT d’attendre la copie', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../setup.ts', import.meta.url), 'utf8');
    const pose = src.indexOf('process.env.DATABASE_URL = withDatabase(adminUrl, database);');
    const attente = src.indexOf('await cloneE2eDatabase(');
    expect(pose).toBeGreaterThan(0);
    expect(attente).toBeGreaterThan(pose);
    // Entre la remise à zéro de l'environnement et la pose de l'URL : aucune attente.
    const entre = src.slice(src.indexOf('restoreProcessEnv(process.env'), pose);
    expect(entre).not.toMatch(/\bawait\b/);
  });
});
