/**
 * Lot 66B1 — charte « Sérénité » 2026, vague 2 : migration écran par écran
 * de l'APPLICATION (hors back-office), clair ET sombre, desktop ET mobile.
 *
 *   L66B1-01 : plus AUCUNE couleur écrite en dur (hex, rgb(a), classes de
 *              palette Tailwind, blanc / noir) dans les composants et pages
 *              de l'application, hors liste blanche justifiée ;
 *   L66B1-02 : plus de variantes `dark:` mortes (le thème passe par
 *              `data-theme`, jamais par la classe `.dark`) ;
 *   L66B1-03 : plus d'anneau de focus local qui double la règle globale ;
 *   L66B1-04 : charte — ni dégradé, ni flou, ni mise à l'échelle / translation
 *              au survol (hors protection de photo) ;
 *   L66B1-05 : Agenda — signaux d'attention TOUJOURS écrits (« en_retard »
 *              s'affichait en code brut) ;
 *   L66B1-06 : tons des statuts — retard strict rouge, attention cuivre,
 *              confirmation pétrole, libellés écrits ;
 *   L66B1-07 : contrastes CALCULÉS des paires texte / fond introduites
 *              (≥ 4,5:1) dans les deux thèmes ;
 *   L66B1-08 : offres, page d'erreur, rubriques, thème des plans : jetons.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  attentionFlagLabel,
  visibleAttentionFlags,
  ATTENTION_FLAG_LABELS,
  EFFECTIVE_STATUS_LABELS,
} from '@/lib/agenda/effective-status';
import { STATUS_COLORS, STATUS_BORDER } from '@/components/agenda/AgendaPeriodViews';
import { PLAN_THEMES } from '@/lib/plan-theme';
import { RUBRIC_COLORS, UNFILED_COLORS } from '@/lib/referential/v2/rubrics';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Fichiers de l'application (hors back-office, hors socle `components/ui`, hors API). */
function perimetre(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(ROOT, d))) {
      const p = `${d}/${e}`;
      if (statSync(join(ROOT, p)).isDirectory()) {
        if (['__tests__', 'admin', 'api', 'ui'].includes(e) && !(e === 'ui' && d !== 'src/components')) continue;
        walk(p);
      } else if (/\.(tsx|ts)$/.test(e) && !/\.test\.tsx?$/.test(e) && !/Admin/.test(e)) {
        out.push(p);
      }
    }
  };
  for (const d of ['src/components', 'src/app', 'src/hooks', 'src/contexts']) {
    try { walk(d); } catch { /* dossier absent */ }
  }
  out.push('src/lib/plan-theme.ts', 'src/lib/referential/v2/rubrics.ts');
  return out.map((p) => relative(ROOT, join(ROOT, p)));
}

/** Retire les commentaires (la charte cite ses couleurs en commentaire). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const PALETTE = '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)';
const MOTIFS: Array<[string, RegExp]> = [
  ['hex', /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g],
  ['rgb', /\brgba?\(\s*\d/g],
  ['palette', new RegExp(`\\b(?:[a-z-]+:)*!?(?:bg|text|border|from|to|via|ring|fill|stroke|outline|decoration|divide|placeholder|shadow|accent|caret)-${PALETTE}-(?:50|[1-9]00|950)\\b`, 'g')],
  ['blanc/noir', /\b(?:[a-z-]+:)*(?:bg|text|border|from|to|via|ring|fill)-(?:white|black)\b/g],
];

/**
 * Exceptions JUSTIFIÉES (fichier → motifs tolérés) :
 *  - protection de photo (charte : « un seul dégradé autorisé : la protection
 *    noire sous le texte posé sur une photo de bien » ; texte blanc dessus) ;
 *  - lecteur vidéo : bandes noires (letterbox) ;
 *  - logo : couleurs maîtresses de la charte §3 (cube cuivre doux, repli
 *    pétrole du jeton) — testées par L66-THEME-05.
 */
const LISTE_BLANCHE: Record<string, RegExp> = {
  'src/app/(dashboard)/assets/page.tsx': /^(?:(?:[a-z-]+:)*(?:text|bg|border|from|via|to)-(?:white|black))$/,
  'src/app/(dashboard)/assets/[id]/page.tsx': /^(?:text-white|bg-black)$/,
  'src/components/home/HomeBlocks.tsx': /^(?:text-white|rgba\(\s*\d)$/,
  'src/components/thumbnail-upload.tsx': /^(?:text-white|bg-black)$/,
  'src/components/exports/preparation/PreparationItem.tsx': /^(?:text-white|bg-black)$/,
  'src/components/assets/DocumentDrawer.tsx': /^bg-black$/,
  'src/components/Logo.tsx': /^#(?:D66B53|17474D)$/,
  'src/components/LogoLoader.tsx': /^#D66B53$/,
};

describe('L66B1-01 — aucune couleur brute dans l’application (hors liste blanche)', () => {
  it('L66B1-01 — hex, rgb(a), palette Tailwind, blanc / noir : remplacés par les jetons du thème', () => {
    const fautes: string[] = [];
    for (const f of perimetre()) {
      const src = sansCommentaires(read(f));
      for (const [nom, rx] of MOTIFS) {
        for (const m of src.matchAll(rx)) {
          const regle = LISTE_BLANCHE[f];
          const tolere = !!regle && (regle.test(m[0]) || regle.test(m[0].replace(/^(?:[a-z-]+:)+!?/, '')));
          if (!tolere) fautes.push(`${f} [${nom}] ${m[0]}`);
        }
      }
    }
    expect(fautes, fautes.join('\n')).toEqual([]);
  });

  it('L66B1-01 — le contrôle voit bien l’application et détecte une couleur brute', () => {
    const fichiers = perimetre();
    expect(fichiers.length).toBeGreaterThan(150);
    expect(fichiers).toContain('src/components/agenda/AgendaItemDrawer.tsx');
    expect(fichiers.some((f) => f.includes('/admin/') || f.startsWith('src/components/ui/'))).toBe(false);
    const temoin = sansCommentaires('<p className="text-blue-500 bg-[#3b82f6] hover:text-white" style={{ color: "rgba(0,0,0,.5)" }} /> // #ffffff');
    expect(MOTIFS.map(([, rx]) => (temoin.match(rx) ?? []).length)).toEqual([1, 1, 1, 1]);
  });

  it('L66B1-01 — la liste blanche reste justifiée : chaque exception existe encore', () => {
    for (const f of Object.keys(LISTE_BLANCHE)) {
      expect(() => read(f), f).not.toThrow();
    }
  });
});

describe('L66B1-02 — plus de variantes `dark:` mortes', () => {
  it('L66B1-02 — aucune couleur sous `dark:` (le thème suit data-theme, la classe .dark n’existe pas)', () => {
    const fautes: string[] = [];
    for (const f of perimetre()) {
      const src = sansCommentaires(read(f));
      if (/(?:^|[\s"'`])dark:[a-z-]+-(?:\[|white|black|transparent|[a-z]+-\d)/m.test(src)) fautes.push(f);
    }
    expect(fautes).toEqual([]);
  });
});

describe('L66B1-03 — focus : la règle globale suffit', () => {
  it('L66B1-03 — aucun anneau de focus local (focus:ring / focus-visible:ring / outline-none au focus)', () => {
    const fautes: string[] = [];
    for (const f of perimetre()) {
      const src = sansCommentaires(read(f));
      const m = src.match(/\b(?:focus|focus-visible):(?:ring(?:-[^\s"'`]+)?|outline-none)\b/g);
      if (m) fautes.push(`${f} : ${m.join(' ')}`);
    }
    expect(fautes, fautes.join('\n')).toEqual([]);
  });
});

describe('L66B1-04 — ni dégradé, ni flou, ni mouvement au survol', () => {
  it('L66B1-04 — dégradés réservés à la protection des photos ; aucun flou ; aucune échelle / translation au survol', () => {
    const photos = new Set(['src/app/(dashboard)/assets/page.tsx', 'src/components/home/HomeBlocks.tsx', 'src/components/mobile/bottom-navigation.tsx']);
    const fautes: string[] = [];
    for (const f of perimetre()) {
      const src = sansCommentaires(read(f));
      if (!photos.has(f) && /bg-gradient-to-|linear-gradient\(/.test(src)) fautes.push(`${f} : dégradé`);
      if (f !== 'src/app/(dashboard)/assets/page.tsx' && /\bbackdrop-blur/.test(src)) fautes.push(`${f} : flou`);
      if (/\b(?:hover|active|group-hover):(?:scale-|-?translate-)/.test(src)) fautes.push(`${f} : mouvement`);
    }
    expect(fautes, fautes.join('\n')).toEqual([]);
  });
});

describe('L66B1-05 — Agenda : signaux d’attention écrits, jamais le code brut', () => {
  it('L66B1-05 — libellés en toutes lettres, signal inconnu « À vérifier »', () => {
    expect(attentionFlagLabel('en_retard')).toBe('Date échue');
    expect(attentionFlagLabel('sans_bien')).toBe('Sans bien associé');
    expect(attentionFlagLabel('date_incoherente')).toBe('Date incohérente');
    expect(attentionFlagLabel('donnee_distincte_a_qualifier')).toBe('Donnée à qualifier');
    expect(attentionFlagLabel('nouveau_code_serveur')).toBe('À vérifier');
    for (const l of Object.values(ATTENTION_FLAG_LABELS)) expect(l).not.toMatch(/_/);
  });

  it('L66B1-05 — « en_retard » n’est pas répété à côté du statut « Date échue »', () => {
    expect(visibleAttentionFlags(['en_retard', 'sans_bien'])).toEqual(['sans_bien']);
    expect(visibleAttentionFlags(null)).toEqual([]);
  });

  it('L66B1-05 — les trois vues passent par le libellé partagé (plus de `: f}` ni de « Date? »)', () => {
    for (const f of ['src/app/(dashboard)/agenda/page.tsx', 'src/components/assets/AssetAgendaTab.tsx', 'src/components/agenda/AgendaItemDrawer.tsx']) {
      const src = read(f);
      expect(src, f).toMatch(/attentionFlagLabel\(f\)/);
      expect(src, f).toMatch(/visibleAttentionFlags\(item\.attentionFlags\)/);
      expect(src, f).not.toMatch(/:\s*f\s*\}|'Date\?'/);
    }
  });
});

describe('L66B1-06 — tons des statuts (décision PO lot 66)', () => {
  it('L66B1-06 — date échue rouge, statut à confirmer cuivre, à venir / réalisé pétrole ; libellés écrits', () => {
    expect(STATUS_COLORS.en_retard).toContain('var(--danger)');
    expect(STATUS_BORDER.en_retard).toContain('var(--danger-edge)');
    expect(STATUS_COLORS.a_confirmer).toContain('var(--attention-on-soft)');
    expect(STATUS_COLORS.a_venir).toContain('var(--accent)');
    expect(STATUS_COLORS.realise).toContain('var(--text-success)');
    for (const s of Object.keys(STATUS_COLORS)) {
      expect(EFFECTIVE_STATUS_LABELS[s as keyof typeof EFFECTIVE_STATUS_LABELS]).toBeTruthy();
    }
    // Ni rouge ni cuivre pour un état neutre.
    expect(STATUS_COLORS.a_venir).not.toMatch(/danger|attention/);
  });

  it('L66B1-06 — la pastille de date de l’agenda est le DateChip de la charte (late / attention / default)', () => {
    const src = read('src/components/agenda/AgendaPeriodViews.tsx');
    expect(src).toMatch(/<DateChip /);
    expect(src).toMatch(/status === 'en_retard' \? 'late'/);
    expect(read('src/app/(dashboard)/agenda/page.tsx')).toMatch(/<DateBlock dateStr=\{item\.startDate \?\? null\} status=\{item\.effectiveStatus\} \/>/);
  });

  it('L66B1-06 — couleur par bien (vue Mois / Année) : ni rouge ni cuivre, infobulle écrite', () => {
    const src = read('src/components/agenda/AgendaPeriodViews.tsx');
    const palette = src.slice(src.indexOf('const ASSET_PALETTE'), src.indexOf('const NO_ASSET'));
    expect(palette).not.toMatch(/danger|attention|badge-todo/);
    expect(src).toMatch(/title=\{itemTooltip\(item\)\}/);
  });
});

describe('L66B1-07 — contrastes calculés des paires introduites (WCAG AA)', () => {
  const CSS = read('src/app/globals.css');
  const bloc = (sel: string) => {
    const i = CSS.indexOf(sel);
    const d = CSS.indexOf('{', i);
    return CSS.slice(d + 1, CSS.indexOf('\n}', d));
  };
  const RACINE = bloc(':root {');
  const THEMES = { clair: bloc('html[data-theme="beige"] {'), sombre: bloc('html[data-theme="beige"] .public-page {') };
  const v = (b: string, n: string) => {
    const m = b.match(new RegExp(`--${n}:\\s*(#[0-9A-Fa-f]{6})\\b`)) ?? RACINE.match(new RegExp(`--${n}:\\s*(#[0-9A-Fa-f]{6})\\b`));
    expect(m, `--${n}`).not.toBeNull();
    return m![1];
  };
  const lum = (x: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255)
      .map((u) => (u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contraste = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const PAIRES: Array<[string, string]> = [
    ['text-success', 'bg-success'], ['accent', 'accent-soft'], ['attention-on-soft', 'attention-soft'],
    ['danger', 'danger-soft'], ['on-accent', 'accent'], ['bg-card', 'danger'], ['on-accent', 'danger'],
    ['on-badge-todo', 'badge-todo'], ['text-primary', 'attention-soft'], ['text-primary', 'accent-soft'],
    ['text-secondary', 'bg-subtle'], ['text-muted', 'bg-subtle'], ['text-info-soft', 'accent-soft'],
    ['text-warning-soft', 'attention-soft'], ['text-primary', 'danger-soft'], ['text-muted', 'bg-success'],
    ['text-muted', 'attention-soft'], ['text-muted', 'danger-soft'], ['attention', 'bg-card'],
    ['attention-on-soft', 'bg-card'], ['attention-on-soft', 'bg-page'], ['danger', 'bg-subtle'],
    ['text-success', 'bg-card'], ['accent', 'bg-subtle'], ['text-secondary', 'sidebar'], ['text-muted', 'sidebar'],
    ['text-muted', 'field-bg'], ['text-primary', 'bg-subtle'],
  ];
  for (const [theme, b] of Object.entries(THEMES)) {
    for (const [t, f] of PAIRES) {
      it(`L66B1-07 — ${theme} : ${t} sur ${f} ≥ 4,5:1`, () => {
        expect(contraste(v(b, t), v(b, f))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('L66B1-07 — jetons de marque : ivoire sur pétrole (fenêtre de blocage), gris sur papier blanc (vignettes)', () => {
    expect(contraste(v(RACINE, 'vb-ivoire'), v(RACINE, 'vb-petrole'))).toBeGreaterThanOrEqual(4.5);
    expect(contraste(v(RACINE, 'vb-gris'), v(RACINE, 'vb-blanc'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('L66B1-08 — écrans aux jetons', () => {
  it('L66B1-08 — thème des plans : jetons uniquement, plus de variante sombre écrite', () => {
    for (const [plan, t] of Object.entries(PLAN_THEMES)) {
      for (const [k, cls] of Object.entries(t.colors)) {
        if (!cls || cls === 'border-border') continue;
        expect(cls, `${plan}.${k}`).toMatch(/^[a-z-]+-\[color:var\(--[a-z-]+\)\]$/);
      }
      expect(t.colors.bgDark).toBe('');
      expect(t.colors.textDark).toBe('');
    }
  });

  it('L66B1-08 — offres : cartes neutres (filet, offre actuelle soulignée pétrole), bouton primaire de la charte', () => {
    const src = read('src/app/(dashboard)/mon-compte/offres/page.tsx');
    expect(src).toMatch(/isCurrentPlan \? 'border-\[color:var\(--accent\)\] ring-1 ring-\[color:var\(--accent\)\]' : 'border-\[color:var\(--border\)\]'/);
    expect(src).not.toMatch(/!bg-/);
    expect(src).toMatch(/rounded-\[8px\] bg-\[color:var\(--accent\)\]/); // sélecteur Mensuel / Annuel
  });

  it('L66B1-08 — page d’erreur : jetons du thème, aucun emoji, boutons primaire / secondaire', () => {
    const src = read('src/app/error.tsx');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(src).not.toMatch(/⚠️/u);
    expect(src).toMatch(/background: 'var\(--accent\)', color: 'var\(--on-accent\)'/);
    expect(src).toMatch(/background: 'var\(--bg-page\)'/);
  });

  it('L66B1-08 — rubriques : repères aux jetons de marque', () => {
    for (const c of [...Object.values(RUBRIC_COLORS), UNFILED_COLORS]) {
      expect(c.accent).toMatch(/^(?:var\(--vb-[a-z-]+\)|color-mix\(in srgb, var\(--vb-[a-z-]+\) \d+%, var\(--vb-blanc\)\))$/);
    }
  });

  it('L66B1-08 — titres de page : style de la charte (34 / 800, 26 sur mobile)', () => {
    for (const f of [
      'src/app/(dashboard)/agenda/page.tsx', 'src/app/(dashboard)/assets/page.tsx', 'src/components/to-process/ToProcessQueue.tsx',
      'src/components/documents/v2/DocumentsByRubric.tsx', 'src/app/(dashboard)/mon-compte/page.tsx', 'src/app/(dashboard)/mon-compte/offres/page.tsx',
    ]) {
      expect(read(f), f).toMatch(/<h1 className="vb-app-title/);
    }
  });
});
