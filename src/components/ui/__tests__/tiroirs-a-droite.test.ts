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

describe('Mes documents — filtre par bien', () => {
  // Maquette « Mes documents » (1a) : le filtre Bien est dans le panneau de
  // filtres de la page, et chaque filtre actif reste visible en pastille.
  const panneau = readFileSync(join(ROOT, 'components/documents/v2/DocumentsFilterPanel.tsx'), 'utf8');
  it('le filtre Bien est dans le panneau de la page, pas dans un tiroir', () => {
    expect(panneau).toContain('title="Bien"');
    expect(panneau).not.toMatch(/<Drawer/);
  });
  it('les biens filtrés restent visibles en pastilles retirables', () => {
    expect(panneau).toMatch(/Filtré par/);
  });
});
