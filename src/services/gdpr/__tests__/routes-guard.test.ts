/**
 * Gardes des routes RGPD (CDC BO GEN-002, GDP-011, GDP-022) — test statique,
 * complémentaire de `src/app/api/admin/__tests__/admin-guard.test.ts`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'));
const HANDLER = /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)\b/g;

const ADMIN_ROUTES = [
  'src/app/api/admin/gdpr/route.ts',
  'src/app/api/admin/gdpr/[id]/route.ts',
  'src/app/api/admin/gdpr/[id]/reopen/route.ts',
  'src/app/api/admin/gdpr/subjects/route.ts',
];
const USER_ROUTES = [
  'src/app/api/users/me/gdpr-export/route.ts',
  'src/app/api/users/me/gdpr-export/download/route.ts',
];

describe('routes admin RGPD', () => {
  it.each(ADMIN_ROUTES)('%s : chaque handler appelle requireAdmin', (p) => {
    expect(existsSync(join(process.cwd(), p))).toBe(true);
    const src = read(p);
    const handlers = [...src.matchAll(HANDLER)].length;
    expect(handlers).toBeGreaterThan(0);
    expect((src.match(/\brequireAdmin\s*\(/g) ?? []).length).toBe(handlers);
    expect(src).not.toMatch(/x-(?:admin-)?user-id/i);
  });

  it('aucune route n’accepte ni ne transmet d’échéance saisie', () => {
    for (const p of ADMIN_ROUTES) expect(read(p)).not.toMatch(/body\.due|dueDate\s*:\s*body/);
  });
});

describe('routes utilisateur de l’export RGPD', () => {
  it.each(USER_ROUTES)('%s : chaque handler exige la session', (p) => {
    const src = read(p);
    const handlers = [...src.matchAll(HANDLER)].length;
    expect(handlers).toBeGreaterThan(0);
    expect((src.match(/SessionService\.getSession\s*\(/g) ?? []).length).toBe(handlers);
  });

  it('le téléchargement porte sur l’utilisateur de la session, jamais un identifiant fourni', () => {
    const src = read('src/app/api/users/me/gdpr-export/download/route.ts');
    expect(src).toContain('getDownloadUrl(userId)');
    expect(src).not.toMatch(/searchParams/);
  });
});
