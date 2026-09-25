/**
 * Règle d'interface : aucun tiroir ne s'ouvre par le bas, tous à droite.
 * Balaye les sources pour que la règle tienne aussi pour les ajouts futurs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'src');
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : tsxFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}
const files = tsxFiles(ROOT).map((f) => ({ f, src: readFileSync(f, 'utf8') }));

describe('tiroirs ouverts à droite', () => {
  it('le tiroir vaul ouvre à droite par défaut', () => {
    expect(readFileSync(join(ROOT, 'components/ui/drawer.tsx'), 'utf8')).toContain('direction = "right"');
  });

  it('aucun tiroir ni panneau déclaré par le bas', () => {
    const fautifs = files
      .filter(({ src }) =>
        /direction=["']bottom["']/.test(src)
        || /<SheetContent[^>]*side=\{?["'`]bottom/.test(src)
        || /side=\{isMobile \? ['"]bottom/.test(src)
        || /initial=\{\{\s*y: ['"]100%['"]/.test(src),
      )
      .map(({ f }) => f.replace(ROOT, 'src'));
    expect(fautifs).toEqual([]);
  });
});

describe('Mes documents — filtres rapides par bien', () => {
  const vue = readFileSync(join(ROOT, 'components/documents/v2/DocumentsByRubric.tsx'), 'utf8');
  it('affiche des pastilles de bien sur la page', () => {
    expect(vue).toContain('aria-label="Filtrer par bien"');
    expect(vue).toContain('label="Tous les biens"');
  });
  it('pilotent le même filtre que le tiroir « Tri & filtres »', () => {
    expect(vue).toMatch(/applyFilters\(\{\s*\.\.\.filters,\s*assetIds: \[\]/);
  });
});
