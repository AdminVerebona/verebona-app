/**
 * Redirection après authentification : chemin interne uniquement.
 *
 * `/login?returnUrl=https://site-tiers` renvoyait l'utilisateur, tout juste
 * connecté sur le vrai domaine, vers un site tiers (redirection ouverte).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_AUTH_PATH, safeInternalPath, safeReturnUrl } from '@/lib/safe-redirect';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('safeInternalPath', () => {
  it('conserve un chemin interne, requête et ancre comprises', () => {
    expect(safeInternalPath('/accueil')).toBe('/accueil');
    expect(safeInternalPath('/duo/join/abc123')).toBe('/duo/join/abc123');
    expect(safeInternalPath('/documents?filtre=x&tri=date#haut')).toBe('/documents?filtre=x&tri=date#haut');
    expect(safeInternalPath('/transmission/tok%2F1')).toBe('/transmission/tok%2F1');
  });

  it.each([
    null,
    undefined,
    '',
    'accueil',
    'https://evil.example',
    'http://evil.example/accueil',
    '//evil.example',
    '//evil.example/%2F..',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    ' /accueil',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/' + 'a'.repeat(3000),
  ])('refuse %j', (bad) => {
    expect(safeInternalPath(bad as string | null | undefined)).toBe(DEFAULT_AFTER_AUTH_PATH);
  });

  it('utilise le repli fourni', () => {
    expect(safeInternalPath('//evil.example', '/')).toBe('/');
  });
});

describe('safeReturnUrl (page de connexion)', () => {
  it('évite la boucle vers une page d’authentification', () => {
    for (const p of ['/login', '/login?returnUrl=/x', '/signup', '/verify-email?status=success', '/reset-password?token=t']) {
      expect(safeReturnUrl(p)).toBe('/accueil');
    }
    // Un préfixe homonyme n'est pas une page d'authentification.
    expect(safeReturnUrl('/loginfo')).toBe('/loginfo');
    expect(safeReturnUrl('/admin/gdpr')).toBe('/admin/gdpr');
  });

  it('refuse les cibles externes', () => {
    expect(safeReturnUrl('https://evil.example')).toBe('/accueil');
    expect(safeReturnUrl('//evil.example')).toBe('/accueil');
  });
});

describe('câblage', () => {
  it('la page de connexion ne redirige plus vers une valeur brute', () => {
    const src = read('src/app/(auth)/login/page.tsx');
    expect(src).toMatch(/safeReturnUrl\(searchParams\.get\('returnUrl'\)\)/);
    expect(src).not.toMatch(/rawReturn/);
  });

  it('le Centre d’aide partage la même règle', () => {
    expect(read('src/lib/help-center/open.ts')).toMatch(/safeInternalPath\(raw, '\/accueil'\)/);
  });
});
