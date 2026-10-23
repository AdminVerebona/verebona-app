/**
 * Lot 75N — contrôles statiques : routes en lecture seule (GET seulement,
 * garde admin), aucune API SQL générique, aucune écriture dans les
 * services, composants client sans accès base, rationalisation de la fiche,
 * desktop ET mobile.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const ROUTES = [
  'src/app/api/admin/accounts/[id]/data/[category]/route.ts',
  'src/app/api/admin/accounts/[id]/entities/[type]/[entityId]/route.ts',
];
const SERVICES = ['src/services/admin/account-data/lists.ts', 'src/services/admin/account-data/dossier.ts', 'src/services/admin/account-data/model.ts'];
const UI = [
  'src/app/admin/accounts/[id]/_components/account-data/AccountDataSection.tsx',
  'src/app/admin/accounts/[id]/_components/account-data/EntityDrawer.tsx',
  'src/app/admin/accounts/[id]/_components/account-data/DossierView.tsx',
];

describe('L75N-S01 sécurité des routes', () => {
  it('GET seulement, garde requireAdmin appelée avant tout accès, réponses no-store', () => {
    for (const r of ROUTES) {
      const src = lire(r);
      expect(src).toMatch(/export async function GET\(/);
      expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
      expect(src).toContain('guardAdmin(() => requireAdmin(request))');
      expect(src.indexOf('guardAdmin(')).toBeLessThan(src.indexOf('resolveAccount('));
      expect(src).toContain('NO_STORE');
    }
  });
  it('aucune API SQL générique : catégorie et type en liste blanche, aucun nom de table / colonne lu dans la requête', () => {
    const list = lire(ROUTES[0]);
    const detail = lire(ROUTES[1]);
    expect(list).toContain('isCategory(p.category)');
    expect(detail).toContain('isEntityType(p.type)');
    for (const src of [list, detail]) expect(src).not.toMatch(/searchParams\.get\('(table|column|sql|where)'\)/);
    expect(lire('src/services/admin/account-data/lists.ts')).toMatch(/LIST_SORTS\[category\]/);
  });
  it('téléchargements journalisés, consultation journalisée, tentative intercomptes tracée', () => {
    const detail = lire(ROUTES[1]);
    expect(detail).toContain("format ? 'ACCOUNT_DATA_EXPORT' : 'ACCOUNT_DATA_READ'");
    expect(detail).toContain("audit(accountId, 'DENIED', { code: 'NOT_FOUND_IN_ACCOUNT' })");
    expect(detail).toContain('Content-Disposition');
  });
});

describe('L75N-S02 lecture seule des services', () => {
  it('aucune instruction d’écriture SQL, transaction READ ONLY', () => {
    for (const f of SERVICES) {
      const src = lire(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+)/i);
    }
    // Lot 81C (adapté) : session de lecture cohérente REPEATABLE READ READ ONLY (instantané) au lieu de `readOnlyExecutor`.
    expect(lire('src/services/admin/account-data/dossier.ts')).toContain('withReadSession');
    expect(lire('src/services/admin/account-data/session.ts')).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const f of ['src/services/admin/account-data/session.ts', 'src/services/admin/account-data/export.ts']) {
      const src = lire(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+)/i);
    }
    expect(lire('src/services/admin/account-data/lists.ts')).toContain('readOnlyExecutor');
    expect(lire('src/services/admin/account-data/dossier.ts')).not.toMatch(/enqueue|t3-queue|reconcile\w*\(/);
  });
});

describe('L75N-S03 interface : client sans base, desktop et mobile, fiche rationalisée', () => {
  it('composants client : aucun import `@/db`, aucune écriture', () => {
    for (const f of UI) {
      const src = lire(f);
      expect(src.startsWith('"use client"')).toBe(true);
      expect(src).not.toMatch(/from '@\/db'/);
      expect(src).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'|apiClient\.(post|put|patch|delete)/);
    }
    expect(lire('src/services/admin/account-data/model.ts')).not.toMatch(/from '@\/db'/);
  });
  it('tiroir : Sheet unique pleine largeur sur mobile, en-tête qui passe à la ligne, historique de navigation', () => {
    const d = lire(UI[1]);
    expect(d).toContain('<SheetContent side="right" className="w-full sm:max-w-3xl lg:max-w-4xl');
    expect(d).toContain('flex flex-wrap items-center gap-1.5');
    expect(d).toContain('Revenir à l’entité précédente');
    expect(d.match(/<Sheet /g)).toHaveLength(1);
    expect(d).toContain('Copier tout');
    expect(d).toContain('Télécharger');
    expect(d).toContain('Actualiser');
    expect(d).toContain('<OperationDetailView d={op} onNavigate=');
  });
  it('listes : tableau desktop, cartes mobile, lignes activables au clavier', () => {
    const s = lire(UI[0]);
    expect(s).toContain('hidden md:block overflow-x-auto');
    expect(s).toContain('<ul className="md:hidden divide-y">');
    expect(s).toContain("if (e.key === 'Enter' || e.key === ' ')");
    expect(s).toContain('flex flex-col md:flex-row md:items-end gap-2');
  });
  it('fiche compte : section unique « Données du compte », ancienne liste de biens et tableau des documents retirés', () => {
    const page = lire('src/app/admin/accounts/[id]/page.tsx');
    expect(page).toContain('<AccountDataSection accountId={account.id} />');
    expect(page).not.toContain('Biens ({assets.length})');
    const docs = lire('src/app/admin/accounts/[id]/_components/AccountDocuments.tsx');
    expect(docs).not.toContain('Date du document');
    expect(docs).toContain('Exports et transmissions');
  });
});
