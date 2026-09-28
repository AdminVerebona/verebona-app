/**
 * Injection dans le HTML/CSS des dossiers V12 et isolement des ressources.
 *
 *  · `cssString` : une donnée utilisateur écrite dans l'en-tête (`@top-right
 *    { content: "…" }`) ne peut ni sortir de la chaîne CSS (guillemet,
 *    anti-slash, retour ligne, caractères de contrôle), ni fermer la balise
 *    <style>, ni ouvrir un `url()` ;
 *  · `renderUrlToPath` : seules les URL de l'origine virtuelle, sous le
 *    répertoire statique ou le répertoire de travail, sont servies à Chromium.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { cssString, pageSetup, clip, TEXT_BOUNDS } from '../html/components';
import { RENDER_ORIGIN, renderUrlToPath, staticDir, workFileUrl } from '../static-assets';

/** Contenu de la chaîne CSS, guillemets exclus. */
const inner = (s: string) => {
  expect(s.startsWith('"') && s.endsWith('"')).toBe(true);
  return s.slice(1, -1);
};

/** Aucun caractère capable de terminer la chaîne ou la déclaration CSS. */
const assertInert = (s: string) => {
  const body = inner(s);
  // (L'apostrophe reste littérale : sans effet dans une chaîne entre guillemets doubles.)
  expect(body).not.toMatch(/["(){};<>[\]\n\r\f\u0000\t]/);
  // Tout anti-slash est un échappement hexadécimal complet suivi d'une espace.
  expect(body.replace(/\\[0-9A-F]{1,6} /g, '')).not.toContain('\\');
};

describe('cssString — échappement des chaînes CSS', () => {
  const payloads = [
    'Maison "principale"',
    'a\\"; } body { background: red } x { content: "',
    'Ligne 1\nLigne 2\r\nLigne 3\fLigne 4\u0000fin',
    '"; } @page { @top-left { content: url(file:///etc/passwd) } } x { content: "',
    'url(file:///app/.env)',
    '</style><script>alert(1)</script>',
    '</STYLE ><img src=x>',
    '\\\\"\\A \\"',
    'Tab\tVT\u000bDEL\u007fC1\u0085LS PS ',
    'Substitut \ud800 isolé',
    '{ } ; ( ) [ ] \' ` < > &',
  ];

  it.each(payloads)('reste inerte : %j', (p) => {
    assertInert(cssString(p));
  });

  it('retours ligne et tabulations → espace ; \\r, \\f, \\0 et contrôles supprimés', () => {
    expect(cssString('a\nb\tc')).toBe('"a b c"');
    expect(cssString('a\r\nb')).toBe('"a b"');
    expect(cssString('a\fb\u0000c\u0007d\u0085e')).toBe('"abcde"');
  });

  it('caractères usuels du libellé conservés tels quels', () => {
    expect(cssString('Dossier complet · Appartement Lyon 2e · 28 sept. 2026')).toBe('"Dossier complet · Appartement Lyon 2e · 28 sept. 2026"');
    expect(cssString('Kit de vente · Vélo cargo « Family » — 12 % / 5°')).toBe('"Kit de vente · Vélo cargo « Family » — 12 % / 5°"');
    expect(cssString('Café Noël ÆØ 東京 ١٢٣')).toBe('"Café Noël ÆØ 東京 ١٢٣"');
  });

  it('caractères dangereux en échappement hexadécimal', () => {
    expect(cssString('a"b')).toBe('"a\\22 b"');
    expect(cssString('a\\b')).toBe('"a\\5C b"');
    expect(cssString('<')).toBe('"\\3C "');
    expect(cssString('url(x)')).toBe('"url\\28 x\\29 "');
    expect(cssString('😀')).toBe('"\\1F600 "');
  });

  it('pageSetup : la balise <style> ne peut pas être fermée par le libellé', () => {
    const css = pageSetup({ headerLabel: 'x</style><h1>INJECTE</h1>"; } @page { @top-left { content: url(file:///etc/passwd) } }\n' });
    expect(css.match(/<\/style>/gi)?.length).toBe(1);
    expect(css).not.toContain('<h1>');
    expect(css).not.toContain('url(file:');
    const line = css.split('\n').find((l) => l.includes('@top-right'))!;
    assertInert(line.match(/content: ("[^"]*");/)![1]);
  });

  it('libellé d\'en-tête borné', () => {
    const css = pageSetup({ headerLabel: 'x'.repeat(500) });
    const value = css.match(/@top-right \{ content: "([^"]*)"/)![1];
    expect(value.length).toBe(TEXT_BOUNDS.header);
    expect(value.endsWith('…')).toBe(true);
  });

  it('clip : borne sans toucher aux textes courts ni aux non-textes', () => {
    expect(clip('court', 10)).toBe('court');
    expect(clip('abcdefghijkl', 5)).toBe('abcd…');
    expect(clip(null, 5)).toBeNull();
    expect(clip(42, 1)).toBe(42);
  });
});

describe('renderUrlToPath — ressources servies à Chromium', () => {
  const workDir = path.join('/tmp', 'v12-work-test');

  it('sert le répertoire statique et le répertoire de travail', () => {
    expect(renderUrlToPath(`${RENDER_ORIGIN}/static/tokens.css`, workDir)).toBe(path.join(staticDir(), 'tokens.css'));
    expect(renderUrlToPath(`${RENDER_ORIGIN}/static/fonts/inter-400.woff2`, workDir)).toBe(path.join(staticDir(), 'fonts', 'inter-400.woff2'));
    expect(renderUrlToPath(`${RENDER_ORIGIN}/work/index.html`, workDir)).toBe(path.join(workDir, 'index.html'));
    const photo = path.join(workDir, 'files', 'photo-1-print.jpg');
    expect(renderUrlToPath(workFileUrl(workDir, photo), workDir)).toBe(photo);
  });

  it.each([
    'file:///etc/passwd',
    `file://${path.join(staticDir(), 'tokens.css')}`,
    'https://example.com/tokens.css',
    'http://dossier.verebona.invalid/static/tokens.css',
    'https://dossier.verebona.invalid.example.com/static/tokens.css',
    `${RENDER_ORIGIN}/etc/passwd`,
    `${RENDER_ORIGIN}/static/`,
    `${RENDER_ORIGIN}/static/..%2F..%2F..%2Fpackage.json`,
    `${RENDER_ORIGIN}/work/..%2F..%2Fetc%2Fpasswd`,
    `${RENDER_ORIGIN}/work/%2e%2e/%2e%2e/etc/passwd`,
    `${RENDER_ORIGIN}/work/a%00b`,
    `${RENDER_ORIGIN}/work/%E0%A4%A`,
    'data:text/css,body{}',
    'javascript:alert(1)',
    'pas une url',
  ])('refuse %s', (url) => {
    expect(renderUrlToPath(url, workDir)).toBeNull();
  });

  it('workFileUrl refuse un fichier hors du répertoire de travail', () => {
    expect(() => workFileUrl(workDir, '/etc/passwd')).toThrow();
    expect(() => workFileUrl(workDir, path.join(workDir, '..', 'x'))).toThrow();
  });
});
