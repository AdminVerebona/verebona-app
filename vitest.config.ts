/**
 * Harnais de test — préalable aux critères d'acceptation n°22 et 23 du CDC §12.
 * Le dépôt n'en comportait aucun avant ce chantier.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Le socle et le moteur de décision sont les zones où la couverture
      // conditionne la recette (CDC §11.2).
      include: ['src/services/ai/**'],
      thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
});
