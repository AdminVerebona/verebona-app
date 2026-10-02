/**
 * Garde-fou : taille de l'image Scalingo (limite 2048 Mo).
 *
 * `next build` laisse ≈ 1,1 Go de cache webpack dans `.next/cache`. S'il part
 * dans l'image, le déploiement est refusé (preprod, 2 oct. 2026 : 2561 Mo).
 * `scripts/prune-image.mjs` le supprime ; il doit rester branché sur les DEUX
 * déclencheurs : le hook npm `postbuild` et le hook buildpack `scalingo-cleanup`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

describe('image Scalingo : nettoyage après build', () => {
  it('prune-image est lancé par postbuild et par scalingo-cleanup', () => {
    expect(scripts.postbuild).toContain('scripts/prune-image.mjs');
    expect(scripts['scalingo-cleanup']).toContain('scripts/prune-image.mjs');
  });

  it('pas de scalingo-postbuild : le buildpack lancerait ce script À LA PLACE de build', () => {
    expect(scripts['scalingo-postbuild']).toBeUndefined();
    expect(scripts.build).toMatch(/next build/);
  });

  it('prune-image supprime bien le cache webpack de Next', () => {
    const src = read('scripts/prune-image.mjs');
    expect(src).toContain("'.next/cache/webpack'");
    // Le cache utile à l'exécution (images, fetch) n'est jamais visé.
    expect(src).not.toMatch(/'\.next\/cache'\s*,/);
  });
});
