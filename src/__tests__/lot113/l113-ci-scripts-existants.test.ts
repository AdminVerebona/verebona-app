/**
 * Lot 113 (CI du 07/11 : « npm error Missing script: test:e2e:statut-effectif »).
 * 113P (#715) a retiré les scripts des statuts d'agenda ; le workflow appelait
 * encore leurs étapes. Garde-fou : toute commande `npm run <script>` des
 * workflows doit exister dans le package.json qui la lance (racine ou mobile/).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const scripts = (p: string): Set<string> => new Set(Object.keys((JSON.parse(readFileSync(p, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}));
const racine = scripts('package.json');
const mobile = existsSync('mobile/package.json') ? scripts('mobile/package.json') : new Set<string>();

describe('workflows : aucun appel à un script npm absent', () => {
  const dir = '.github/workflows';
  const fichiers = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
  it('au moins un workflow lu', () => expect(fichiers.length).toBeGreaterThan(0));
  for (const f of fichiers) {
    it(f, () => {
      const lignes = readFileSync(join(dir, f), 'utf8').split('\n');
      const manquants: string[] = [];
      let dansMobile = false;
      for (const l of lignes) {
        if (/^\s*-\s*name:/.test(l)) dansMobile = false;
        if (/working-directory:\s*mobile\b|cd mobile\b/.test(l)) dansMobile = true;
        for (const m of l.matchAll(/npm run ([A-Za-z0-9:_.-]+)/g)) {
          const s = m[1];
          const ok = racine.has(s) || (dansMobile && mobile.has(s)) || mobile.has(s);
          if (!ok) manquants.push(s);
        }
      }
      expect(manquants, `scripts appelés par ${f} absents de package.json`).toEqual([]);
    });
  }
  it('le workflow complet livré du lot 113 aussi', () => {
    const p = process.env.CI_COMPLET_A_VERIFIER;
    if (!p || !existsSync(p)) return;
    const manquants = [...readFileSync(p, 'utf8').matchAll(/npm run ([A-Za-z0-9:_.-]+)/g)].map((m) => m[1]).filter((s) => !racine.has(s) && !mobile.has(s));
    expect(manquants).toEqual([]);
  });
});
