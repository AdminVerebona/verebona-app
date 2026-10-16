/**
 * Lot 65A — suppression des modules qui ne servaient plus qu'à des tests
 * (graphe d'imports du lot 64 : atteints depuis les tests seulement).
 *
 * L65-NET-01  Les sept modules n'existent plus (le jeu d'évaluation de
 *             l'assistant, données de test, vit sous `__tests__/fixtures`).
 * L65-NET-02  Plus aucun import (statique, dynamique, `vi.mock`) ni lecture de
 *             leur chemin, dans `src/` et `scripts/`.
 * L65-NET-03  La migration 0315 ne fait que CITER `seed-dependencies.ts` en
 *             commentaire : aucune instruction ne l'exécute (migration intacte).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const SUPPRIMES = [
  'src/components/dashboard/AssetCard.tsx',
  'src/components/verebona/VerebonaThreads.tsx',
  'src/services/ai/source-analysis/schemas.ts',
  'src/services/ai/source-analysis/source-units/index.ts',
  'src/services/verebona-assistant/canonical/index.ts',
  'src/services/verebona-assistant/eval/cases.ts',
  'src/services/coherence/seed-dependencies.ts',
];
/** Spécificateurs d'import qui résoudraient vers ces modules. */
const SPECIFIERS = [
  /['"`]@\/components\/dashboard\/AssetCard['"`]/,
  /['"`]@\/components\/verebona\/VerebonaThreads['"`]/,
  /['"`](?:@\/services\/ai\/source-analysis|\.\.?)\/schemas['"`]/,
  /['"`]@\/services\/ai\/source-analysis\/source-units['"`]/,
  /['"`]@\/services\/verebona-assistant\/canonical['"`]/,
  /['"`]\.\.\/cases['"`]/,
  /['"`](?:@\/services\/coherence|\.\.?)\/seed-dependencies['"`]/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

describe('L65-NET — modules utilisés seulement par des tests : supprimés', () => {
  it('L65-NET-01 — absents ; jeu d’évaluation déplacé en données de test', () => {
    for (const f of SUPPRIMES) expect(existsSync(join(ROOT, f)), f).toBe(false);
    expect(existsSync(join(ROOT, 'src/services/verebona-assistant/eval/__tests__/fixtures/cases.ts'))).toBe(true);
  });

  it('L65-NET-02 — plus aucun import ni chemin lu', () => {
    const fichiers = [...walk(join(ROOT, 'src')), ...(existsSync(join(ROOT, 'scripts')) ? walk(join(ROOT, 'scripts')) : [])]
      .filter((f) => !f.endsWith('l65-net-suppressions.test.ts'));
    const fautes: string[] = [];
    for (const f of fichiers) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(ROOT, f);
      for (const re of SPECIFIERS) {
        if (!re.test(src)) continue;
        // `../schemas` / `./schemas` : seulement depuis source-analysis ; `../cases` : seulement depuis eval.
        if (String(re).includes('schemas') && !rel.startsWith('src/services/ai/source-analysis/') && !/source-analysis\/schemas/.test(src)) continue;
        if (String(re).includes('cases') && !rel.startsWith('src/services/verebona-assistant/eval/')) continue;
        if (String(re).includes('seed-dependencies') && !rel.startsWith('src/services/coherence/') && !/coherence\/seed-dependencies/.test(src)) continue;
        fautes.push(`${rel} : ${re}`);
      }
      for (const chemin of SUPPRIMES) if (src.includes(`'${chemin}'`)) fautes.push(`${rel} lit ${chemin}`);
    }
    expect(fautes).toEqual([]);
  });

  it('L65-NET-03 — migration 0315 : simple mention en commentaire, aucune exécution', () => {
    const m = readFileSync(join(ROOT, 'src/db/migrations/0315_neutralize_generic_propagations.sql'), 'utf8');
    const lignes = m.split('\n').filter((l) => l.includes('seed-dependencies'));
    expect(lignes.length).toBeGreaterThan(0);
    for (const l of lignes) expect(l.trimStart().startsWith('--'), l).toBe(true);
  });
});
