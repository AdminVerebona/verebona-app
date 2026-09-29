/**
 * Harnais E2E sur PostgreSQL réel — CDC 15 T2-41, DOD-20, décisions D-07/D-17.
 *
 *   E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm run test:e2e
 *
 * Distinct de `vitest.config.ts` : les tests unitaires n'ouvrent jamais de
 * connexion ; ceux-ci n'existent que pour en ouvrir une. Les scénarios
 * (`*.e2e.ts`) ne sont donc jamais ramassés par `npm run test:run`.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/test/e2e/**/*.e2e.ts'],
    globalSetup: ['./src/test/e2e/global-setup.ts'],
    setupFiles: ['./src/test/e2e/setup.ts'],
    // Une seule base par exécution : les fichiers s'exécutent en série.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
});
