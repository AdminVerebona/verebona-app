/**
 * Lot 66A — charte « Sérénité » 2026, vague 1 : jetons, typographie,
 * composants partagés et coquille (clair ET sombre, desktop ET mobile).
 *
 *   L66-THEME-01 : jetons clair / sombre de la charte présents, noms shadcn
 *                  et historiques conservés ;
 *   L66-THEME-02 : contrastes CALCULÉS des paires texte / fond principales
 *                  (≥ 4,5:1 texte courant) dans les deux thèmes ;
 *   L66-THEME-03 : focus = anneau 3 px cuivre texte décalé ; pas de
 *                  translation / réduction d'échelle, transitions 180 ms ;
 *   L66-THEME-04 : mascotte recolorée (filtre CSS) à TOUTES les occurrences ;
 *   L66-THEME-05 : logo selon le thème (pétrole / ivoire), cube cuivre 18° ;
 *   L66-THEME-06 : mécanisme de thème (choix enregistré, sinon système ;
 *                  barre d'état / theme-color ; manifeste) ;
 *   L66-THEME-07 : Figtree auto-hébergée, seule famille de l'application ;
 *   L66-THEME-08 : coquille — pastille « À traiter », « + » pétrole, champ
 *                  Verebona 560 px, navigation basse sans flou ;
 *   L66-THEME-09 : pastille de date (DateChip) : brume / cuivre / rouge ;
 *   L66-THEME-10 : composants ui : rayons 12 / 16 / 999, ombre unique.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/navigation', () => ({
  usePathname: () => '/accueil',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

// Le harnais (environnement node) compile le JSX en `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const CSS = read('src/app/globals.css');

/** Bloc de déclarations qui suit un sélecteur donné (jusqu'à l'accolade fermante). */
function bloc(selecteur: string): string {
  const i = CSS.indexOf(selecteur);
  expect(i, `sélecteur introuvable : ${selecteur}`).toBeGreaterThanOrEqual(0);
  const debut = CSS.indexOf('{', i);
  const fin = CSS.indexOf('\n}', debut);
  return CSS.slice(debut + 1, fin);
}
const CLAIR = bloc('html[data-theme="beige"] {');
// Lot 67 : le bloc sombre ne porte plus `.public-page` (pages publiques au thème de l'utilisateur).
const SOMBRE = bloc('html[data-theme="blue"] {');

function v(b: string, nom: string): string {
  const m = b.match(new RegExp(`--${nom}:\\s*(#[0-9A-Fa-f]{6})\\b`));
  expect(m, `--${nom} absent`).not.toBeNull();
  return m![1].toUpperCase();
}

function contraste(a: string, b: string): number {
  const lum = (x: string) => {
    const c = x.replace('#', '');
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
      .map((u) => (u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('L66-THEME-01 — jetons de la charte, clair et sombre', () => {
  it('L66-THEME-01 — thème clair : ivoire / pétrole / cuivre (charte §1.2)', () => {
    const attendu: Record<string, string> = {
      'bg-page': '#F8F6F1', 'bg-card': '#FFFFFF', sidebar: '#F2F0EA', border: '#D5DEDC', 'border-subtle': '#E2E8E6',
      'text-primary': '#26353B', 'text-muted': '#52636A', accent: '#17474D', 'on-accent': '#FFFFFF', 'accent-soft': '#E2EBE9',
      attention: '#AA4E38', 'attention-soft': '#F6E4DE', 'badge-todo': '#AA4E38', bubble: '#ECF1EF', 'bubble-edge': '#BBD0CC',
      'accent-hover': '#10383E', 'focus-ring-color': '#AA4E38',
    };
    for (const [k, val] of Object.entries(attendu)) expect(v(CLAIR, k), k).toBe(val);
  });

  it('L66-THEME-01 — thème sombre : encre neutre, accent pétrole clair (jamais pétrole sur pétrole)', () => {
    const attendu: Record<string, string> = {
      'bg-page': '#1B2529', 'bg-card': '#26353B', sidebar: '#161F23', border: '#3A4A51', 'border-subtle': '#304046',
      'text-primary': '#F3F1EB', 'text-muted': '#A7B6B9', accent: '#9FD3CC', 'on-accent': '#1B2529', 'accent-soft': '#2A4347',
      attention: '#E2896F', 'attention-soft': '#3D302C', 'badge-todo': '#D66B53', bubble: '#243C40', 'bubble-edge': '#3E5F63',
      'focus-ring-color': '#E2896F',
    };
    for (const [k, val] of Object.entries(attendu)) expect(v(SOMBRE, k), k).toBe(val);
  });

  it('L66-THEME-01 — noms shadcn et historiques conservés dans les deux thèmes', () => {
    const noms = ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'primary',
      'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent-foreground',
      'destructive', 'border', 'input', 'ring', 'sidebar', 'sidebar-foreground', 'sidebar-primary',
      'sidebar-primary-foreground', 'sidebar-accent', 'sidebar-accent-foreground', 'sidebar-border', 'sidebar-ring',
      'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'text-warning', 'text-danger', 'text-success', 'text-info',
      'on-red', 'on-amber', 'on-green', 'on-blue', 'field-bg', 'row-muted', 'text-secondary', 'bg-input', 'danger'];
    for (const n of noms) {
      expect(CLAIR, n).toMatch(new RegExp(`--${n}:`));
      expect(SOMBRE, n).toMatch(new RegExp(`--${n}:`));
    }
    expect(v(CLAIR, 'primary')).toBe('#17474D');
    expect(v(SOMBRE, 'primary')).toBe('#9FD3CC');
  });

  it('L66-THEME-01 — alias --vb-* de la charte et filtre de la mascotte', () => {
    for (const [n, val] of [['vb-petrole', '#17474D'], ['vb-petrole-hover', '#10383E'], ['vb-cuivre', '#D66B53'],
      ['vb-cuivre-texte', '#AA4E38'], ['vb-ivoire', '#F8F6F1'], ['vb-brume', '#E2EBE9'], ['vb-encre', '#26353B']]) {
      expect(CSS).toContain(`--${n}: ${val};`);
    }
    expect(CSS).toContain('--vb-mascotte-filtre: hue-rotate(-30deg) saturate(1.1) brightness(1.02) contrast(1.08);');
  });

  it('L66-THEME-01 — plus aucune teinte de l’ancienne palette bleue dans les jetons', () => {
    for (const ancien of ['#3B82F6', '#020B1A', '#020617', '#2563EB', '#1D4ED8']) {
      expect(CSS.toUpperCase(), ancien).not.toContain(ancien);
    }
  });
});

describe('L66-THEME-02 — contrastes calculés (WCAG AA)', () => {
  const paires: Array<[string, string, number]> = [
    // [texte, fond, seuil]
    ['text-primary', 'bg-page', 4.5], ['text-primary', 'bg-card', 4.5], ['text-primary', 'sidebar', 4.5],
    ['text-muted', 'bg-page', 4.5], ['text-muted', 'bg-card', 4.5], ['text-muted', 'sidebar', 4.5],
    ['text-muted', 'accent-soft', 4.5], ['text-secondary', 'bg-card', 4.5],
    ['accent', 'bg-page', 4.5], ['accent', 'bg-card', 4.5], ['accent', 'accent-soft', 4.5],
    ['on-accent', 'accent', 4.5], ['primary-foreground', 'primary', 4.5],
    ['attention', 'bg-page', 4.5], ['attention', 'bg-card', 4.5], ['attention-on-soft', 'attention-soft', 4.5],
    ['danger', 'bg-page', 4.5], ['danger', 'bg-card', 4.5], ['danger', 'danger-soft', 4.5],
    ['on-badge-todo', 'badge-todo', 4.5], ['text-primary', 'bubble', 4.5],
    ['muted-foreground', 'muted', 4.5], ['popover-foreground', 'popover', 4.5],
    ['on-red', 'wash-red', 4.5], ['on-amber', 'wash-amber', 4.5], ['on-green', 'wash-green', 4.5],
    ['on-blue', 'wash-blue', 4.5], ['on-violet', 'wash-violet', 4.5],
    // Anneau de focus : contraste non textuel (≥ 3:1) sur le fond de page.
    ['focus-ring-color', 'bg-page', 3], ['focus-ring-color', 'bg-card', 3],
  ];
  for (const [theme, b] of [['clair', CLAIR], ['sombre', SOMBRE]] as const) {
    for (const [t, f, seuil] of paires) {
      it(`L66-THEME-02 — ${theme} : ${t} sur ${f} ≥ ${seuil}:1`, () => {
        expect(contraste(v(b, t), v(b, f))).toBeGreaterThanOrEqual(seuil);
      });
    }
  }

  it('L66-THEME-02 — survol primaire #10383E : texte blanc lisible', () => {
    expect(contraste('#FFFFFF', v(CLAIR, 'accent-hover'))).toBeGreaterThanOrEqual(4.5);
    expect(contraste(v(SOMBRE, 'on-accent'), v(SOMBRE, 'accent-hover'))).toBeGreaterThanOrEqual(4.5);
  });

  it('L66-THEME-02 — rouge (retard strict) distinct du cuivre (attention) dans les deux thèmes', () => {
    expect(v(CLAIR, 'danger')).not.toBe(v(CLAIR, 'attention'));
    expect(v(SOMBRE, 'danger')).not.toBe(v(SOMBRE, 'attention'));
    expect(v(CLAIR, 'text-warning')).toBe('#AA4E38');
    expect(v(CLAIR, 'text-danger')).toBe(v(CLAIR, 'danger'));
  });
});

describe('L66-THEME-03 — focus, mouvement', () => {
  it('L66-THEME-03 — anneau de focus global : 3 px, cuivre texte, décalé de 3 px, hors couche', () => {
    const i = CSS.indexOf(':focus-visible:not([data-focus-ring="off"])');
    expect(i).toBeGreaterThan(0);
    const regle = CSS.slice(i, CSS.indexOf('}', i));
    expect(regle).toContain('outline: 3px solid var(--focus-ring-color)');
    expect(regle).toContain('outline-offset: 3px');
    // Hors `@layer` : l'emporte sur les `outline-none` des utilitaires.
    // Seule couche déclarée dans le fichier : `@layer base`, refermée avant.
    expect((CSS.match(/@layer /g) ?? []).length).toBe(1);
    const base = CSS.indexOf('@layer base {');
    expect(CSS.indexOf('\n}\n', base)).toBeLessThan(i);
  });

  it('L66-THEME-03 — composants ui : ni translation au survol, ni réduction d’échelle à la pression, ni anneau local', () => {
    const dossier = join(ROOT, 'src/components/ui');
    for (const f of readdirSync(dossier).filter((x) => x.endsWith('.tsx'))) {
      const src = readFileSync(join(dossier, f), 'utf8');
      expect(src, f).not.toMatch(/hover:-translate-y|active:scale|hover:scale/);
      expect(src, f).not.toMatch(/focus-visible:ring-ring\/50|focus-visible:ring-\[3px\]/);
      expect(src, f).not.toMatch(/shadow-relief-(md|lg)/);
    }
    const bouton = read('src/components/ui/button.tsx');
    expect(bouton).toContain('duration-[180ms] ease-[cubic-bezier(.2,.7,.2,1)]');
    expect(bouton).toContain('hover:bg-[color:var(--accent-hover)]');
    expect(bouton).toContain('rounded-[12px]');
  });

  it('L66-THEME-03 — mouvement réduit respecté, mascotte sans rebond', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration: \.001ms !important/);
    const pose = CSS.slice(CSS.indexOf('@keyframes vb-pose-a'), CSS.indexOf('@keyframes vb-pose-b'));
    expect(pose).not.toMatch(/scale/);
    expect(CSS).toContain('--vb-dur: 180ms;');
    expect(CSS).toContain('--vb-ease: cubic-bezier(.2,.7,.2,1);');
  });
});

describe('L66-THEME-04 — mascotte recolorée partout', () => {
  it('L66-THEME-04 — MascotPose applique --vb-mascotte-filtre, un filtre appelant s’y AJOUTE', async () => {
    const { MascotPose } = await import('@/components/verebona/space/MascotPose');
    const html = renderToStaticMarkup(h(MascotPose, { pose: 'neutral', size: 26 }));
    expect(html).toContain('/mascot/neutral.webp');
    expect(html).toContain('filter:var(--vb-mascotte-filtre)');
    expect(html).toContain('class="vb-mascotte"');
    const avec = renderToStaticMarkup(h(MascotPose, { pose: 'neutral', size: 26, style: { filter: 'grayscale(1)' } }));
    expect(avec).toContain('filter:var(--vb-mascotte-filtre) grayscale(1)');
    const { mascotFilter } = await import('@/lib/verebona/mascot-motion');
    expect(mascotFilter('none')).toBe('var(--vb-mascotte-filtre)');
  });

  it('L66-THEME-04 — aucune pose public/mascot rendue hors de MascotPose', () => {
    const fichiers: string[] = [];
    const parcours = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') parcours(p); }
        else if (/\.(tsx|ts|css)$/.test(n)) fichiers.push(p);
      }
    };
    parcours(join(ROOT, 'src'));
    const fautifs = fichiers.filter((p) => {
      if (p.endsWith('mascot-motion.ts')) return false; // mascotSrc : seul constructeur de chemin
      const src = readFileSync(p, 'utf8');
      return /["'`(]\/mascot\/[\w-]+\.webp|\/mascot\/\$\{/.test(src);
    }).map((p) => p.replace(ROOT + '/', ''));
    expect(fautifs).toEqual([]);
    // Et les appelants ne posent plus d'ombre portée qui remplacerait le filtre.
    expect(read('src/components/home/MascotSpeaks.tsx')).not.toContain('drop-shadow');
    expect(read('src/app/not-found.tsx')).not.toContain('drop-shadow');
  });

  it('L66-THEME-04 — bulle de la mascotte aux jetons de la charte', () => {
    expect(v(CLAIR, 'bubble')).toBe('#ECF1EF');
    expect(v(SOMBRE, 'bubble')).toBe('#243C40');
    expect(read('src/components/home/MascotSpeaks.tsx')).toContain("const BUBBLE_BG = 'var(--bubble)'");
  });
});

describe('L66-THEME-05 — logo selon le thème', () => {
  it('L66-THEME-05 — géométrie 32 × 32, cases au jeton du thème, cube cuivre tourné de 18°', async () => {
    const { Logo } = await import('@/components/Logo');
    const html = renderToStaticMarkup(h(Logo, { size: 24, withText: true }));
    expect(html).toContain('viewBox="0 0 32 32"');
    expect(html.match(/fill:var\(--vb-logo-cells, #17474D\)/g)).toHaveLength(8);
    expect(html).toContain('fill="#D66B53" transform="rotate(18 27.43 3.02)"');
    expect(html).toContain('color:var(--vb-logo-text, #17474D)');
    expect(html).toContain('>Verebona<');
    expect(html).not.toMatch(/#3B82F6|theme-beige/i);
  });

  it('L66-THEME-05 — pétrole sur clair, ivoire sur sombre (pages publiques comprises, selon le thème)', () => {
    expect(v(CLAIR, 'vb-logo-cells')).toBe('#17474D');
    expect(v(CLAIR, 'vb-logo-text')).toBe('#17474D');
    expect(v(SOMBRE, 'vb-logo-cells')).toBe('#F8F6F1');
    expect(v(SOMBRE, 'vb-logo-text')).toBe('#F3F1EB');
    // Lot 67 : les pages publiques suivent le thème — plus de forçage `.public-page`.
    expect(CSS).toMatch(/^html\[data-theme="blue"\] \{/m);
    expect(CSS).not.toMatch(/\.public-page\s*[,{]/);
  });
});

describe('L66-THEME-06 — mécanisme de thème', () => {
  it('L66-THEME-06 — choix enregistré prioritaire, sinon préférence du système', async () => {
    const { resolveTheme } = await import('@/lib/theme');
    expect(resolveTheme('blue', false)).toBe('blue');
    expect(resolveTheme('beige', true)).toBe('beige');
    expect(resolveTheme(null, true)).toBe('blue');
    expect(resolveTheme(null, false)).toBe('beige');
    expect(resolveTheme('autre', false)).toBe('beige');
  });

  it('L66-THEME-06 — application au document : data-theme, classe du body, theme-color', async () => {
    const { applyThemeToDocument } = await import('@/lib/theme');
    const attrs: Record<string, string> = {};
    const classes = new Set<string>(['theme-blue']);
    const metas = [{ content: '#000' }, { content: '#000' }];
    const doc = {
      documentElement: { setAttribute: (k: string, val: string) => { attrs[k] = val; } },
      body: { classList: { remove: (...c: string[]) => c.forEach((x) => classes.delete(x)), add: (c: string) => classes.add(c) } },
      querySelectorAll: () => metas,
      head: null,
      createElement: () => ({}),
    } as unknown as Document;
    applyThemeToDocument('beige', doc);
    expect(attrs['data-theme']).toBe('beige');
    expect([...classes]).toEqual(['theme-beige']);
    expect(metas.map((m) => m.content)).toEqual(['#F8F6F1', '#F8F6F1']);
    applyThemeToDocument('blue', doc);
    expect(metas[0].content).toBe('#1B2529');
  });

  it('L66-THEME-06 — script bloquant : même règle, exécutable', async () => {
    const { themeBootScript } = await import('@/lib/theme');
    const script = themeBootScript();
    const fakeDoc = (saved: string | null, dark: boolean) => {
      const attrs: Record<string, string> = {};
      const meta = { c: '', setAttribute: (_k: string, val: string) => { meta.c = val; } };
      const win = { matchMedia: () => ({ matches: dark }) };
      const ls = { getItem: () => saved };
      const document = { documentElement: { setAttribute: (k: string, val: string) => { attrs[k] = val; } }, querySelectorAll: () => [meta] };
      new Function('window', 'document', 'localStorage', script)(win, document, ls);
      return { theme: attrs['data-theme'], meta: meta.c };
    };
    expect(fakeDoc(null, true)).toEqual({ theme: 'blue', meta: '#1B2529' });
    expect(fakeDoc(null, false)).toEqual({ theme: 'beige', meta: '#F8F6F1' });
    expect(fakeDoc('blue', false).theme).toBe('blue');
    expect(fakeDoc('beige', true).theme).toBe('beige');
    expect(read('src/app/layout.tsx')).toContain('themeBootScript()');
  });

  it('L66-THEME-06 — barre d’état et manifeste aux couleurs de la charte (app installée)', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toContain("statusBarStyle: 'black-translucent'");
    expect(layout).toMatch(/media: '\(prefers-color-scheme: light\)', color: THEME_PAGE_COLOR\.beige/);
    expect(layout).toMatch(/media: '\(prefers-color-scheme: dark\)', color: THEME_PAGE_COLOR\.blue/);
    const manifeste = read('src/app/api/manifest/route.ts');
    expect(manifeste).not.toMatch(/#020B1A|#3B82F6/);
    expect(manifeste).toContain("background_color: '#F8F6F1'");
    expect(JSON.parse(read('public/manifest.json')).background_color).toBe('#F8F6F1');
  });

  it('L66-THEME-06 — le hook suit la préférence système tant qu’aucun choix n’est enregistré', () => {
    const src = read('src/components/ThemeToggle.tsx');
    expect(src).toContain("matchMedia?.('(prefers-color-scheme: dark)')");
    expect(src).toMatch(/if \(readSavedTheme\(\)\) return;/);
    expect(src).toContain('localStorage.setItem(THEME_STORAGE_KEY, next)');
  });
});

describe('L66-THEME-07 — Figtree', () => {
  it('L66-THEME-07 — 5 graisses auto-hébergées (CSP font-src self), licence OFL jointe', () => {
    for (const w of [400, 500, 600, 700, 800]) {
      expect(existsSync(join(ROOT, `public/fonts/figtree-latin-${w}-normal.woff2`)), String(w)).toBe(true);
      expect(CSS).toContain(`font-family: 'Figtree'; font-style: normal; font-weight: ${w}; font-display: swap; src: url('/fonts/figtree-latin-${w}-normal.woff2')`);
    }
    expect(read('public/fonts/Figtree-OFL.txt')).toContain('SIL Open Font License');
  });

  it('L66-THEME-07 — famille unique : plus d’Inter ni de Bricolage dans l’application, repli système', () => {
    expect(CSS).not.toMatch(/font-family: 'Inter'|'Bricolage Grotesque'|font-geist/);
    expect(CSS).toMatch(/--vb-font: 'Figtree', system-ui, -apple-system/);
    expect(CSS).toContain('--font-sans: var(--vb-font);');
    expect(CSS).toContain('--font-display: var(--vb-font);');
    expect(CSS).toMatch(/body \{[\s\S]*?font-family: var\(--vb-font\);/);
  });

  it('L66-THEME-07 — chiffres tabulaires pour les tableaux et montants', () => {
    expect(CSS).toMatch(/table, td, th, input\[type="number"\][^{]*\{\s*font-variant-numeric: tabular-nums;/);
    expect(read('src/components/ui/table.tsx')).toContain('tabular-nums');
    expect(read('src/components/ui/number-input.tsx')).toContain('tabular-nums');
  });
});

describe('L66-THEME-08 — coquille', () => {
  it('L66-THEME-08 — pastille « À traiter » : --badge-todo (desktop et mobile), plus de rouge', () => {
    for (const f of ['src/components/shell/AppSidebar.tsx', 'src/components/mobile/bottom-navigation.tsx']) {
      const src = read(f);
      expect(src, f).toContain('bg-[color:var(--badge-todo)]');
      expect(src, f).toContain('text-[color:var(--on-badge-todo)]');
      expect(src, f).not.toContain('--vb-red-500');
      expect(src, f).not.toMatch(/linear-gradient/);
    }
  });

  it('L66-THEME-08 — « + Ajouter » / « + » : pétrole plein, survol pétrole foncé, sans dégradé ni échelle', () => {
    const side = read('src/components/shell/AppSidebar.tsx');
    expect(side).toContain('bg-[color:var(--accent)]');
    expect(side).toContain('hover:bg-[color:var(--accent-hover)]');
    const nav = read('src/components/mobile/bottom-navigation.tsx');
    expect(nav).toContain('bg-[color:var(--accent)] text-[color:var(--on-accent)]');
    expect(nav).not.toMatch(/hover:scale|backdrop-blur/);
  });

  it('L66-THEME-08 — champ Verebona : pilule 38 px, 560 px, fond carte', () => {
    const src = read('src/components/verebona/space/VerebonaField.tsx');
    expect(src).toContain("'min(560px, calc(100% - 170px))'");
    expect(src).toContain('h-[38px]');
    expect(src).toContain("background: 'var(--bg-card)'");
    expect(src).toContain('<MascotPose pose={api.pose} size={26} priority />');
  });

  it('L66-THEME-08 — menu latéral 240 / 64 px, header 60 px', async () => {
    const { sidebarWidth } = await import('@/lib/shell/sidebar-state');
    expect(sidebarWidth(false)).toBe(240);
    expect(sidebarWidth(true)).toBe(64);
    expect(read('src/components/TopBar.tsx')).toContain('h-[60px]');
  });

  it('L66-THEME-08 — texte posé sur l’accent : couleur « on-accent » (lisible en sombre sur #9FD3CC)', () => {
    for (const f of ['src/components/TopBar.tsx', 'src/components/DashboardLayout.tsx', 'src/components/mobile/mobile-account-panel.tsx', 'src/components/home/HomeBlocks.tsx']) {
      expect(read(f), f).not.toMatch(/bg-\[color:var\(--accent\)\][^"'`]*\btext-white\b/);
    }
  });
});

describe('L66-THEME-09 — pastille de date', () => {
  it('L66-THEME-09 — 48 × 48 desktop, jour 17 / 700, mois 9 px capitales ; trois tons', async () => {
    const { DateChip } = await import('@/components/ui/date-chip');
    const def = renderToStaticMarkup(h(DateChip, { day: '26', month: 'oct.' }));
    expect(def).toContain('data-tone="default"');
    expect(def).toContain('md:h-12 md:w-12');
    expect(def).toContain('rounded-[10px]');
    expect(def).toContain('md:text-[17px]');
    expect(def).toContain('text-[9px] font-bold uppercase');
    expect(def).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(h(DateChip, { day: '1', month: 'x', tone: 'attention' }))).toContain('bg-[color:var(--attention-soft)]');
    expect(renderToStaticMarkup(h(DateChip, { day: '1', month: 'x', tone: 'late' }))).toContain('text-[color:var(--danger)]');
  });
});

describe('L66-THEME-10 — composants ui', () => {
  it('L66-THEME-10 — rayons : 12 boutons et champs, 16 cartes et fenêtres, 999 pastilles', () => {
    expect(read('src/components/ui/button.tsx')).toContain('rounded-[12px]');
    expect(read('src/components/ui/input.tsx')).toContain('rounded-[12px]');
    expect(read('src/components/ui/textarea.tsx')).toContain('rounded-[12px]');
    expect(read('src/components/ui/select.tsx')).toContain('rounded-[12px] border px-3');
    expect(read('src/components/ui/card.tsx')).toContain('rounded-[16px] border');
    expect(read('src/components/ui/dialog.tsx')).toContain('rounded-[16px] border');
    expect(read('src/components/ui/alert-dialog.tsx')).toContain('rounded-[16px] border');
    expect(read('src/components/ui/badge.tsx')).toContain('rounded-full');
  });

  it('L66-THEME-10 — une seule ombre, réservée aux surfaces flottantes ; cartes de contenu sans ombre', () => {
    expect(read('src/components/ui/card.tsx')).not.toMatch(/shadow/);
    for (const f of ['dialog', 'alert-dialog', 'sheet', 'popover', 'dropdown-menu', 'select']) {
      expect(read(`src/components/ui/${f}.tsx`), f).toContain('shadow-[var(--vb-shadow-card)]');
    }
    expect(CLAIR).toContain('--shadow-md: none;');
    expect(SOMBRE).toContain('--shadow-md: none;');
  });

  it('L66-THEME-10 — pastilles : libellé écrit, attention cuivre, retard rouge, « Recommandé » cuivre (texte ≥ 4,5:1, lot 67)', async () => {
    const { Badge } = await import('@/components/ui/badge');
    expect(renderToStaticMarkup(h(Badge, { variant: 'attention' }, 'À traiter'))).toContain('text-[color:var(--attention-on-soft)]');
    expect(renderToStaticMarkup(h(Badge, { variant: 'destructive' }, 'En retard de 2 j'))).toContain('text-[color:var(--danger)]');
    // Lot 67 : plus de blanc sur cuivre doux (3,45:1) — jetons dédiés, voir L67-RECO.
    expect(renderToStaticMarkup(h(Badge, { variant: 'recommended' }, 'Recommandé'))).toContain('bg-[color:var(--badge-recommended)] text-[color:var(--on-badge-recommended)] font-bold');
    expect(renderToStaticMarkup(h(Badge, { variant: 'success' }, 'Actif'))).not.toMatch(/emerald|#10b981/);
  });
});
