/**
 * Vignettes PDF : un aperçu de la première page, pas le logo PDF.
 *
 * Cause constatée : le worker servi (public/pdf.worker.min.mjs, 5.6.205)
 * n'avait pas la version de pdfjs-dist installée (5.7.284) ; pdf.js rejette
 * alors tout document et la vignette retombait sur l'icône.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const racine = process.cwd();
const read = (p: string) => readFileSync(join(racine, p), 'utf-8');
const require = createRequire(join(racine, 'package.json'));

describe('worker pdf.js', () => {
  it('le worker public a exactement la version de la bibliothèque installée', () => {
    const { version } = require('pdfjs-dist/package.json') as { version: string };
    const worker = read('public/pdf.worker.min.mjs');
    expect(worker).toContain(`"${version}"`);
  });

  it('il est recopié avant dev et build', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.prebuild).toBe('node scripts/sync-pdf-worker.mjs');
    expect(pkg.scripts.predev).toBe('node scripts/sync-pdf-worker.mjs');
  });
});

describe('composant', () => {
  const C = read('src/components/ui/pdf-thumbnail.tsx');
  it('URL du worker versionnée, repli sur le worker du paquet', () => {
    expect(C).toMatch(/workerSrc = `\/pdf\.worker\.min\.mjs\?v=\$\{pdfjsLib\.version\}`/);
    expect(C).toMatch(/import\('pdfjs-dist\/build\/pdf\.worker\.min\.mjs'\)/);
  });
  it('document relu par le proxy de même origine si l’URL signée échoue', () => {
    expect(C).toMatch(/sources\.push\(`\/api\/files\/\$\{fileId\}\/proxy`\)/);
  });
  it('un PDF au type imprécis est reconnu par son extension', () => {
    expect(read('src/components/documents/v2/DocumentsByRubric.tsx')).toMatch(/const isPdf = \/pdf\/i\.test\(mime\) \|\| \/\\\.pdf\$\/i\.test/);
  });
});
