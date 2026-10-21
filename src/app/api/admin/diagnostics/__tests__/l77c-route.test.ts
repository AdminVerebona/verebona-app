/**
 * Lot 77C — contrôles statiques de la route et de l'emplacement BO :
 *   · L77C-S01 route `GET` uniquement (aucune écriture métier exposée), garde
 *     `requireAdmin`, journalisation de chaque issue ;
 *   · L77C-S02 aucune nouvelle entrée de barre latérale : accès depuis
 *     Dashboard › Supervision (lien vers `/admin/diagnostics`) ;
 *   · L77C-S03 le service n'écrit rien : aucun INSERT / UPDATE / DELETE dans
 *     le module, lectures en transaction READ ONLY réutilisée ;
 *   · L77C-S04 ZIP généré côté serveur avec la dépendance existante `jszip`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('L77C route et emplacement', () => {
  it('L77C-S01 GET seul, requireAdmin, journal', () => {
    const src = read('src/app/api/admin/diagnostics/route.ts');
    expect(src).toMatch(/export async function GET\(/);
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\(/);
    expect(src).toContain('requireAdmin(request)');
    expect(src).toContain("'TECH_DIAGNOSTIC_EXPORT'");
    expect(src).toContain("'TECH_DIAGNOSTIC_VIEW'");
    expect(src.match(/await audit\(/g)?.length).toBeGreaterThanOrEqual(6);
  });
  it('L77C-S02 lien depuis Dashboard › Supervision, pas d’entrée de barre latérale', () => {
    expect(read('src/app/admin/_dashboard/SupervisionTab.tsx')).toContain('href="/admin/diagnostics"');
    expect(read('src/components/AdminSidebar.tsx')).not.toContain('/admin/diagnostics');
  });
  it('L77C-S03 module en lecture seule', () => {
    const dir = 'src/services/admin/diagnostics-export';
    for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith('.ts'))) {
      const src = read(`${dir}/${f}`);
      expect(src, f).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE)\b/i);
    }
    expect(read(`${dir}/collect.ts`)).toContain('readOnlyDossierExecutor');
  });
  it('L77C-S04 jszip déjà déclaré, utilisé côté serveur', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies.jszip).toBeTruthy();
    expect(read('src/services/admin/diagnostics-export/zip.ts')).toContain("from 'jszip'");
    expect(read('src/app/admin/diagnostics/page.tsx')).not.toContain('jszip');
  });
});
