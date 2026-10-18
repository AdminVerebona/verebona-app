/**
 * Lot 67A — finitions de la charte « Sérénité » 2026 dans l'application
 * (clair ET sombre, desktop ET mobile). Décisions du PO du 18/10.
 *
 *   L67-TYPO-01..07 : typographie restante — échelle de la charte, casse
 *                     naturelle, plus de petites capitales hors sur-titres
 *                     prévus, hiérarchie Hn, chiffres tabulaires ;
 *   L67-AUTH-01..04 : connexion / inscription / onboarding / pages publiques
 *                     au thème de l'utilisateur (plus de sombre forcé) ;
 *   L67-RECO-01..03 : pastille « Recommandé » sur Premium (Offres) — paires
 *                     de contraste calculées ;
 *   L67-BORD-01..04 : bordures des champs de saisie ≥ 3:1 (WCAG 1.4.11) dans
 *                     les deux thèmes, jeton dédié, cartes inchangées.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

(globalThis as { React?: typeof React }).React = React;

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const CSS = read('src/app/globals.css');

function bloc(selecteur: string): string {
  const i = CSS.indexOf(selecteur);
  expect(i, `sélecteur introuvable : ${selecteur}`).toBeGreaterThanOrEqual(0);
  const debut = CSS.indexOf('{', i);
  return CSS.slice(debut + 1, CSS.indexOf('\n}', debut));
}
const CLAIR = bloc('html[data-theme="beige"] {');
const SOMBRE = bloc('html[data-theme="blue"] {');
const THEMES = { clair: CLAIR, sombre: SOMBRE } as const;

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
const arrondi = (n: number) => Math.round(n * 100) / 100;

function fichiers(dir: string, ext = /\.tsx$/): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); }
      else if (ext.test(n) && !/\.test\.tsx?$/.test(n)) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, dir));
  return out;
}
/** Application + back-office, hors moteur d'exports (src/services/exports) et e-mails. */
const PERIMETRE = [...fichiers('src/app'), ...fichiers('src/components')];

// ══════════════════════════════════════════════════════════════════════════
// L67-TYPO
// ══════════════════════════════════════════════════════════════════════════
describe('L67-TYPO — typographie de la charte, casse naturelle', () => {
  /**
   * Seules capitales conservées, prévues par la charte ou les maquettes :
   * mois de la pastille de date (§5 « mois 9 px capitales »), catégorie sur
   * la photo des tuiles « Mes biens » (maquette App 2026), code d'annexe
   * (A1, B1 — un code, pas un style de titre).
   */
  const CAPITALES_PREVUES: Record<string, number> = {
    'src/components/ui/date-chip.tsx': 1,
    'src/components/agenda/AgendaPeriodViews.tsx': 1, // pastille « Date » (même gabarit que DateChip)
    'src/components/agenda/AgendaItemDrawer.tsx': 1, // pastille de date du tiroir (mois)
    'src/app/(dashboard)/assets/page.tsx': 1, // catégorie sur photo (maquette)
    'src/components/exports/preparation/PreparationSummary.tsx': 1, // code d'annexe
  };

  it('L67-TYPO-01 — plus de petites capitales (`uppercase`) hors sur-titres et repères prévus', () => {
    const trouves: Record<string, number> = {};
    for (const f of PERIMETRE) {
      const n = (read(f).match(/\buppercase\b/g) ?? []).length;
      if (n) trouves[f] = n;
    }
    expect(trouves).toEqual(CAPITALES_PREVUES);
    // Et ces repères restent petits (pas un titre de section déguisé).
    expect(read('src/components/ui/date-chip.tsx')).toContain('text-[9px] font-bold uppercase');
  });

  it('L67-TYPO-01 — plus d’espacement large (tracking-wide*) sur du texte de l’application', () => {
    const fautifs = PERIMETRE.filter((f) => /tracking-(wide|wider|widest)\b/.test(read(f)))
      // raccourci clavier d'un menu (kbd) et étiquettes de format de fichier
      // (« PDF » sur une vignette) : des codes, pas des titres.
      .filter((f) => ![
        'src/components/ui/dropdown-menu.tsx',
        'src/components/documents/v2/DocumentsByRubric.tsx',
        'src/components/exports/preparation/ui.tsx',
      ].includes(f));
    expect(fautifs).toEqual([]);
  });

  it('L67-TYPO-02 — échelle : titre 34/800, salutation 32/800, section 17/700, bloc 15/700, intitulé 13/600, sur-titre 14 capitales 0,06 em cuivre', () => {
    expect(CSS).toContain('--fs-app-title: 34px;');
    expect(CSS).toContain('--fs-app-greeting: 32px;');
    expect(CSS).toContain('--fs-app-section: 17px;');
    expect(CSS).toContain('--fs-app-body: 14px;');
    expect(CSS).toContain('--fs-app-meta: 12.5px;');
    expect(CSS).toContain('--fs-eyebrow: 14px;');
    const regle = (cls: string) => {
      const m = CSS.match(new RegExp(`\\.${cls} \\{([^}]*)\\}`));
      expect(m, cls).not.toBeNull();
      return m![1];
    };
    expect(regle('vb-app-title')).toMatch(/font-size: var\(--fs-app-title\); font-weight: 800/);
    expect(regle('vb-app-greeting')).toMatch(/font-size: var\(--fs-app-greeting\); font-weight: 800/);
    expect(regle('vb-app-section')).toMatch(/font-size: var\(--fs-app-section\); font-weight: 700/);
    expect(regle('vb-app-subsection')).toMatch(/font-size: 15px; font-weight: 700/);
    expect(regle('vb-app-label')).toMatch(/font-size: 13px; font-weight: 600/);
    for (const cls of ['vb-app-title', 'vb-app-section', 'vb-app-subsection', 'vb-app-label']) {
      expect(regle(cls), cls).not.toMatch(/uppercase/);
    }
    const eyebrow = regle('vb-eyebrow');
    expect(eyebrow).toContain('font-size: var(--fs-eyebrow)');
    expect(eyebrow).toContain('letter-spacing: .06em; text-transform: uppercase; color: var(--attention)');
  });

  it('L67-TYPO-02 — classes en couche de base : un utilitaire voisin (couleur d’erreur, taille) n’est plus écrasé', () => {
    const base = CSS.slice(CSS.indexOf('@layer base {'), CSS.indexOf('FOCUS — anneau 3 px'));
    for (const cls of ['vb-app-title', 'vb-app-greeting', 'vb-app-section', 'vb-app-subsection', 'vb-app-label', 'vb-group-label', 'vb-eyebrow']) {
      expect(base, cls).toContain(`.${cls} {`);
      expect(CSS.split(`.${cls} { font-size: var(--fs-app`).length + CSS.split(`.${cls} { font-size: 1`).length - 2, `${cls} déclarée une seule fois`).toBeLessThanOrEqual(1);
      expect(CSS.slice(CSS.indexOf('FOCUS — anneau 3 px')), `${cls} hors couche`).not.toContain(`.${cls} {`);
    }
  });

  it('L67-TYPO-03 — barres d’actions des tiroirs : libellés 12 px, casse naturelle (document, échéance, équipement, fournisseur, pièce, création)', () => {
    for (const f of [
      'src/components/assets/DocumentDrawer.tsx', 'src/components/agenda/AgendaItemDrawer.tsx',
      'src/components/agenda/CreateAgendaItemDrawer.tsx', 'src/components/assets/EquipmentDrawer.tsx',
      'src/components/suppliers/SupplierDrawer.tsx', 'src/components/assets/RoomDrawer.tsx',
      'src/components/assets/ThumbnailEditDrawer.tsx', 'src/components/AssetFormDialog.tsx',
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/text-\[10px\] font-semibold uppercase/);
      expect(src, f).toMatch(/<span className="text-\[12px\] font-semibold">/);
    }
    expect(read('src/components/ui/segmented-action-bar.tsx')).toContain('text-[12px] font-semibold');
  });

  it('L67-TYPO-04 — titres de section des tiroirs et onglets : 15 / 700 ou 17 / 700, casse naturelle', () => {
    const doc = read('src/components/assets/DocumentDrawer.tsx');
    expect(doc).toContain('<p className="vb-app-subsection">Informations</p>');
    expect(doc).toContain('<p className="vb-app-label mb-1">Description</p>');
    const eq = read('src/components/assets/EquipmentDrawer.tsx');
    for (const t of ['Fournisseurs', 'Documents associés', 'Agenda associé']) expect(eq).toContain(`<p className="vb-app-subsection">${t}</p>`);
    // Étiquettes de type (pastilles) : 11 px, rayon 999, casse naturelle.
    expect(eq).not.toMatch(/text-\[9px\]/);
    expect(eq).toMatch(/text-\[11px\] font-semibold px-2 py-0\.5 rounded-full/);
    // Onglet Exports : sections 17 / 700 (maquette « Écrans 2026 »).
    const exp = read('src/components/assets/AssetExportsTab.tsx');
    expect((exp.match(/<h3 className="vb-app-section mb-3">/g) ?? []).length).toBe(4);
    // Titres de tiroir, de carte, de bloc repliable : 17 / 700.
    expect(read('src/components/ui/sheet.tsx')).toContain('text-[17px] font-bold');
    expect(read('src/components/ui/card.tsx')).toContain('text-[17px] leading-tight font-bold');
    expect(read('src/components/ui/collapsible-card.tsx')).toContain('text-[17px] font-bold');
  });

  it('L67-TYPO-05 — titres de page des écrans secondaires et du BO : .vb-app-title (34 / 800, 26 sur mobile)', () => {
    for (const f of [
      'src/app/(dashboard)/assets/[id]/page.tsx', 'src/app/(dashboard)/fournisseurs/[id]/page.tsx',
      'src/app/(dashboard)/documents/[id]/page.tsx', 'src/app/abonnement/onboarding/page.tsx',
      'src/components/exports/preparation/ExportPreparationScreen.tsx',
    ]) expect(read(f), f).toMatch(/<h1[^>]*className="vb-app-title/);
    // Back-office : TOUS les <h1> au style de la charte, sections en 17 / 700.
    const bo = fichiers('src/app/admin');
    const h1 = bo.flatMap((f) => [...read(f).matchAll(/<h1[^>]*className="([^"]*)"/g)].map((m) => [f, m[1]]));
    expect(h1.length).toBeGreaterThan(15);
    for (const [f, cls] of h1) expect(cls, f).toMatch(/^vb-app-title\b/);
    expect(read('src/app/admin/_dashboard/shared.tsx')).toContain('<h2 className="vb-app-section pt-2">');
    const h2 = bo.flatMap((f) => [...read(f).matchAll(/<h2[^>]*className="([^"]*)"/g)].map((m) => [f, m[1]]));
    for (const [f, cls] of h2) expect(cls, f).toMatch(/^vb-app-section\b/);
    expect(CSS).toMatch(/@media \(max-width: 767px\) \{\s*\.vb-app-title \{ font-size: 26px; \}/);
  });

  it('L67-TYPO-06 — hiérarchie Hn et accessibilité : sur-titre unique, titres de cartes d’offre en h2, titre de connexion annoncé', () => {
    const ui = read('src/components/exports/preparation/ui.tsx');
    expect(ui).toContain("return <p className={cn('vb-eyebrow', className)}>{children}</p>;");
    expect(ui).toContain("return <h3 className={cn('vb-app-subsection m-0', className)}>{children}</h3>;");
    // Le sur-titre n'est employé qu'au-dessus du titre de l'écran.
    const avecEyebrow = PERIMETRE.filter((f) => /<Eyebrow>/.test(read(f)));
    expect(avecEyebrow).toEqual(['src/components/exports/preparation/ExportPreparationScreen.tsx']);
    expect(read('src/app/(dashboard)/mon-compte/offres/page.tsx')).toMatch(/<h2 className="flex-1 min-w-0 text-lg sm:text-xl font-bold/);
    expect(read('src/app/(auth)/login/page.tsx')).toMatch(/<CardTitle role="heading" aria-level=\{1\} className="text-center text-\[26px\] font-extrabold/);
  });

  it('L67-TYPO-07 — chiffres tabulaires sur montants et tableaux', () => {
    expect(CSS).toMatch(/table, td, th, input\[type="number"\][^{]*\{\s*font-variant-numeric: tabular-nums;/);
    expect(read('src/app/(dashboard)/mon-compte/offres/page.tsx')).toMatch(/font-extrabold tracking-\[-\.02em\] vb-tabular/);
    expect(read('src/components/assets/ValuationHistoryDrawer.tsx').match(/vb-tabular/g)?.length).toBe(2);
    expect(read('src/components/subscription/SubscriptionSummary.tsx').match(/vb-tabular/g)?.length).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// L67-AUTH
// ══════════════════════════════════════════════════════════════════════════
describe('L67-AUTH — pages publiques au thème de l’utilisateur', () => {
  const PAGES_PUBLIQUES = [
    'src/app/(auth)/layout.tsx', 'src/app/(auth)/login/page.tsx', 'src/app/(auth)/signup/SignupForm.tsx',
    'src/app/(auth)/signup/SignupClosed.tsx', 'src/app/(auth)/signup/SignupInvitationInvalid.tsx',
    'src/app/(auth)/forgot-password/page.tsx', 'src/app/(auth)/reset-password/page.tsx',
    'src/app/(auth)/verify-email/page.tsx', 'src/app/abonnement/onboarding/page.tsx',
    'src/app/abonnement/checkout/page.tsx', 'src/app/duo/join/[token]/page.tsx', 'src/app/retractation/page.tsx',
  ];

  it('L67-AUTH-01 — plus aucun thème forcé : ForceTheme supprimé, FollowTheme sur chaque page publique', () => {
    expect(existsSync(join(ROOT, 'src/components/ForceTheme.tsx'))).toBe(false);
    const restes = PERIMETRE.filter((f) => /ForceTheme|theme="blue"|applyThemeToDocument\('blue'\)/.test(read(f)));
    expect(restes).toEqual([]);
    for (const f of PAGES_PUBLIQUES) {
      const src = read(f);
      expect(src, f).toContain("import { FollowTheme } from '@/components/FollowTheme';");
      expect(src, f).toContain('<FollowTheme />');
    }
  });

  it('L67-AUTH-02 — `.public-page` ne redéfinit plus aucun jeton (le sombre n’est plus imposé)', () => {
    expect(CSS).not.toMatch(/\.public-page\s*[,{]/);
    // Le bloc sombre ne s'applique qu'au choix « blue » (menu ou système).
    const avant = CSS.slice(0, CSS.indexOf('html[data-theme="blue"] {'));
    expect(avant.trimEnd().endsWith('*/')).toBe(true);
  });

  it('L67-AUTH-03 — pas de flash : le script bloquant du layout RACINE couvre aussi les pages publiques', async () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toContain('dangerouslySetInnerHTML={{ __html: themeBootScript() }}');
    // Les pages publiques sont rendues sous ce layout (aucun <html> propre).
    for (const f of PAGES_PUBLIQUES) expect(read(f), f).not.toMatch(/<html\b/);
    const { themeBootScript } = await import('@/lib/theme');
    const executer = (saved: string | null, dark: boolean) => {
      const attrs: Record<string, string> = {};
      const document = { documentElement: { setAttribute: (k: string, val: string) => { attrs[k] = val; } }, querySelectorAll: () => [] };
      new Function('window', 'document', 'localStorage', themeBootScript())({ matchMedia: () => ({ matches: dark }) }, document, { getItem: () => saved });
      return attrs['data-theme'];
    };
    expect(executer(null, false)).toBe('beige'); // système clair, sans choix → clair (plus de sombre imposé)
    expect(executer(null, true)).toBe('blue');
    expect(executer('beige', true)).toBe('beige'); // choix du menu prioritaire
    expect(executer('blue', false)).toBe('blue');
  });

  describe('L67-AUTH-04 — FollowTheme : choix enregistré, sinon système suivi en direct ; jamais d’écriture', () => {
    const env = (saved: string | null, dark: boolean) => {
      const attrs: Record<string, string> = {};
      const classes = new Set<string>();
      let ecoute: ((e: { matches: boolean }) => void) | null = null;
      const ecrits: string[] = [];
      const store: Record<string, string> = saved ? { 'verebona-theme': saved } : {};
      (globalThis as Record<string, unknown>).window = {
        localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string) => { ecrits.push(k); } },
        matchMedia: () => ({ matches: dark, addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { ecoute = fn; }, removeEventListener: () => {} }),
      };
      (globalThis as Record<string, unknown>).document = {
        documentElement: { setAttribute: (k: string, val: string) => { attrs[k] = val; } },
        body: { classList: { remove: (...c: string[]) => c.forEach((x) => classes.delete(x)), add: (c: string) => classes.add(c) } },
        querySelectorAll: () => [{ content: '' }],
        head: null,
        createElement: () => ({}),
      };
      return { attrs, classes, ecrits, store, change: (m: boolean) => ecoute?.({ matches: m }) };
    };
    afterEach(() => {
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      vi.resetModules();
      vi.doUnmock('react');
    });
    const monter = async () => {
      vi.resetModules();
      vi.doMock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useLayoutEffect: (fn: () => void) => { fn(); } }));
      const { FollowTheme } = await import('@/components/FollowTheme');
      return FollowTheme();
    };

    it('L67-AUTH-04 — système clair sans choix → clair ; bascule système suivie', async () => {
      const e = env(null, false);
      expect(await monter()).toBeNull();
      expect(e.attrs['data-theme']).toBe('beige');
      expect([...e.classes]).toEqual(['theme-beige']);
      e.change(true);
      expect(e.attrs['data-theme']).toBe('blue');
      expect(e.ecrits).toEqual([]);
    });

    it('L67-AUTH-04 — choix « clair » enregistré : prioritaire sur un système sombre, et non écrasé par une bascule', async () => {
      const e = env('beige', true);
      await monter();
      expect(e.attrs['data-theme']).toBe('beige');
      e.change(true);
      expect(e.attrs['data-theme']).toBe('beige');
      expect(e.ecrits).toEqual([]);
    });

    it('L67-AUTH-04 — choix « sombre » enregistré : respecté', async () => {
      const e = env('blue', false);
      await monter();
      expect(e.attrs['data-theme']).toBe('blue');
    });
  });

  it('L67-AUTH-05 — lisibilité des pages publiques dans les deux thèmes (contrastes calculés)', () => {
    const paires: Array<[string, string, number]> = [
      ['text-primary', 'bg-page', 4.5], ['text-primary', 'bg-card', 4.5], ['text-muted', 'bg-card', 4.5],
      ['text-muted', 'bg-page', 4.5], ['primary-foreground', 'primary', 4.5], ['accent', 'bg-card', 4.5],
      ['danger', 'danger-soft', 4.5], ['danger', 'bg-card', 4.5], ['text-primary', 'field-bg', 4.5],
      ['muted-foreground', 'field-bg', 4.5], ['input', 'field-bg', 3], ['input', 'bg-card', 3],
      ['vb-logo-cells', 'bg-card', 3], ['vb-logo-text', 'bg-card', 4.5], ['focus-ring-color', 'bg-card', 3],
    ];
    for (const [theme, b] of Object.entries(THEMES)) {
      for (const [t, f, seuil] of paires) {
        expect(contraste(v(b, t), v(b, f)), `${theme} : ${t} sur ${f}`).toBeGreaterThanOrEqual(seuil);
      }
    }
    // Aucune couleur écrite en dur sur ces pages (elles suivent les jetons).
    for (const f of PAGES_PUBLIQUES) {
      expect(read(f), f).not.toMatch(/#[0-9a-fA-F]{6}\b|\b(?:bg|text|border)-(?:white|black)\b|\b(?:bg|text)-(?:slate|gray|zinc|blue)-\d{2,3}\b/);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// L67-RECO
// ══════════════════════════════════════════════════════════════════════════
describe('L67-RECO — pastille « Recommandé » (Offres)', () => {
  it('L67-RECO-01 — paires calculées : blanc sur cuivre texte (clair), encre sur cuivre sombre (sombre), ≥ 4,5:1', () => {
    expect(v(CLAIR, 'badge-recommended')).toBe('#AA4E38');
    expect(v(CLAIR, 'on-badge-recommended')).toBe('#FFFFFF');
    expect(v(SOMBRE, 'badge-recommended')).toBe('#E2896F');
    expect(v(SOMBRE, 'on-badge-recommended')).toBe('#1B2529');
    expect(arrondi(contraste('#FFFFFF', '#AA4E38'))).toBe(5.45);
    expect(arrondi(contraste('#1B2529', '#E2896F'))).toBe(5.99);
    // Le cuivre doux, écarté : 3,45:1 avec du blanc (charte §1.3).
    expect(arrondi(contraste('#FFFFFF', '#D66B53'))).toBe(3.45);
    for (const [theme, b] of Object.entries(THEMES)) {
      expect(contraste(v(b, 'on-badge-recommended'), v(b, 'badge-recommended')), theme).toBeGreaterThanOrEqual(4.5);
      // La pastille reste repérable sur la carte (contraste non textuel ≥ 3:1).
      expect(contraste(v(b, 'badge-recommended'), v(b, 'bg-card')), theme).toBeGreaterThanOrEqual(3);
    }
  });

  it('L67-RECO-02 — composant : rayon 999, 12 px gras, jetons dédiés (jamais le cuivre doux en fond)', async () => {
    const { Badge } = await import('@/components/ui/badge');
    const html = renderToStaticMarkup(h(Badge, { variant: 'recommended' }, 'Recommandé'));
    expect(html).toContain('rounded-full');
    expect(html).toContain('text-xs');
    expect(html).toContain('font-bold');
    expect(html).toContain('bg-[color:var(--badge-recommended)] text-[color:var(--on-badge-recommended)]');
    expect(html).not.toContain('--vb-cuivre)');
    expect(html).toContain('>Recommandé<');
  });

  it('L67-RECO-03 — écran Offres : Premium recommandé (déclaré une fois), même grille desktop / mobile, prix et logique inchangés', () => {
    const src = read('src/app/(dashboard)/mon-compte/offres/page.tsx');
    expect((src.match(/recommended: true/g) ?? []).length).toBe(1);
    const premium = src.slice(src.indexOf("id: 'PREMIUM',"), src.indexOf("id: 'PREMIUM_DUO'"));
    expect(premium).toContain('recommended: true');
    expect(src).toContain('<Badge variant="recommended" data-testid={`recommande-${offer.id.toLowerCase()}`}>Recommandé</Badge>');
    // Une seule carte par offre, rendue à toutes les largeurs (pas de variante mobile qui l'oublierait).
    expect(src).toContain('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4');
    // Pas d'offre « Bientôt » recommandée ; ordre et identifiants des offres inchangés.
    expect(src).toContain("'recommended' in offer && offer.recommended && !offer.comingSoon");
    expect([...src.matchAll(/^\s{4}id: '([A-Z_]+)',/gm)].map((m) => m[1])).toEqual(['STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO']);
    // Toujours aucun montant écrit dans la page (catalogue serveur, LK-31).
    expect(src).not.toMatch(/\d+,\d{2} ?€|\d+ ?€/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// L67-BORD
// ══════════════════════════════════════════════════════════════════════════
describe('L67-BORD — bordures des champs de saisie ≥ 3:1 (WCAG 1.4.11)', () => {
  it('L67-BORD-01 — jeton dédié --input, cartes et séparateurs inchangés', () => {
    expect(v(CLAIR, 'input')).toBe('#76878D');
    expect(v(SOMBRE, 'input')).toBe('#7C8F95');
    expect(v(CLAIR, 'vb-field-border')).toBe(v(CLAIR, 'input'));
    expect(v(SOMBRE, 'vb-field-border')).toBe(v(SOMBRE, 'input'));
    // Filets de la charte conservés.
    expect(v(CLAIR, 'border')).toBe('#D5DEDC');
    expect(v(SOMBRE, 'border')).toBe('#3A4A51');
    expect(v(CLAIR, 'border-subtle')).toBe('#E2E8E6');
    expect(v(SOMBRE, 'border-subtle')).toBe('#304046');
    expect(CSS).toContain('--color-input: var(--input);');
  });

  describe('L67-BORD-02 — ratios calculés contre chaque fond où un champ peut se trouver', () => {
    const fonds = ['field-bg', 'bg-card', 'bg-page', 'sidebar', 'bg-subtle', 'accent-soft'];
    const attendus: Record<string, Record<string, number>> = {
      clair: { 'field-bg': 3.74, 'bg-card': 3.74, 'bg-page': 3.46, sidebar: 3.28, 'bg-subtle': 3.28, 'accent-soft': 3.08 },
      sombre: { 'field-bg': 4.2, 'bg-card': 3.76, 'bg-page': 4.63, sidebar: 4.96, 'bg-subtle': 4.2, 'accent-soft': 3.12 },
    };
    for (const [theme, b] of Object.entries(THEMES)) {
      for (const f of fonds) {
        it(`L67-BORD-02 — ${theme} : --input sur --${f} ≥ 3:1 (${attendus[theme][f]}:1)`, () => {
          const r = contraste(v(b, 'input'), v(b, f));
          expect(r).toBeGreaterThanOrEqual(3);
          expect(arrondi(r)).toBe(attendus[theme][f]);
        });
      }
      it(`L67-BORD-02 — ${theme} : l’ancienne bordure (--border) échouait (< 3:1)`, () => {
        expect(contraste(v(b, 'border'), v(b, 'field-bg'))).toBeLessThan(3);
      });
      it(`L67-BORD-02 — ${theme} : case / bouton radio / interrupteur non cochés (--text-muted) ≥ 3:1`, () => {
        for (const f of ['field-bg', 'bg-card', 'bg-page']) expect(contraste(v(b, 'text-muted'), v(b, f))).toBeGreaterThanOrEqual(3);
        // Pouce de l'interrupteur (fond carte) sur la piste non cochée.
        expect(contraste(v(b, 'bg-card'), v(b, 'text-muted'))).toBeGreaterThanOrEqual(3);
      });
    }
  });

  it('L67-BORD-03 — composants : input, textarea, select, date, calendrier, champ Verebona sur le jeton ; cases et interrupteur ≥ 3:1', () => {
    expect(read('src/components/ui/input.tsx')).toMatch(/border-input .*rounded-\[12px\] border/);
    expect(read('src/components/ui/textarea.tsx')).toContain('border-input');
    expect(read('src/components/ui/select.tsx')).toContain('border-input');
    expect(read('src/components/ui/date-picker.tsx')).toContain('border border-input input-field');
    expect(read('src/components/ui/calendar.tsx')).toContain('border border-input');
    expect(read('src/components/ui/checkbox.tsx')).toContain('border-[color:var(--text-muted)]');
    expect(read('src/components/ui/radio-group.tsx')).toContain('border-[color:var(--text-muted)]');
    expect(read('src/components/ui/switch.tsx')).toContain('data-[state=unchecked]:bg-[color:var(--text-muted)]');
    const vf = read('src/components/verebona/space/VerebonaField.tsx');
    expect(vf).toContain("borderColor: actif ? 'var(--accent)' : 'var(--input)'");
    expect(vf).toContain('rounded-full border border-[color:var(--input)]');
    // Règles globales : fond « champ » + bordure --input (DatePicker, Select, .input-field, .form-field).
    expect(CSS).toMatch(/\.form-field \[role="combobox"\] \{[^}]*border: 1px solid var\(--input\)/);
    expect(CSS).toMatch(/\[data-slot="select-trigger"\][\s\S]{0,200}border-color: var\(--input\) !important/);
  });

  it('L67-BORD-04 — champs écrits à la main : bordure « champ » par défaut (couche de base), plus de filet de carte sur un champ', () => {
    const base = CSS.slice(CSS.indexOf('@layer base {'), CSS.indexOf('FOCUS — anneau 3 px'));
    expect(base).toMatch(/input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)[^{]*,\s*textarea,\s*select \{\s*border-color: var\(--input\);/);
    const fautifs: string[] = [];
    for (const f of PERIMETRE) {
      read(f).split('\n').forEach((l, i) => {
        // Classe d'un champ (fond champ) bordée du filet des cartes — hors pastilles d'état (« CLÉ: 'bg-… »).
        if (/bg-\[color:var\(--(bg-input|field-bg)\)\]/.test(l) && /border-\[color:var\(--border(-subtle)?\)\]/.test(l) && !/^\s*[A-Z_]+: '/.test(l)) fautifs.push(`${f}:${i + 1}`);
      });
    }
    expect(fautifs).toEqual([]);
  });
});
