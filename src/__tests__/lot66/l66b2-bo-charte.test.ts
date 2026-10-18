/**
 * Lot 66B2 — charte « Sérénité » 2026, vague 2 : back-office (src/app/admin,
 * src/components/admin, coquille AdminSidebar) et derniers résidus serveur.
 *
 *   L66B2-01 : plus aucune couleur brute dans le périmètre BO (palette
 *              Tailwind, hex, rgb(a), blanc / noir écrits) ;
 *   L66B2-02 : plus de variante `dark:` (inopérante : le thème pose
 *              `data-theme`, jamais la classe `.dark`) ;
 *   L66B2-03 : rôles d'état du BO lisibles (≥ 4,5:1) et DISTINCTS (succès /
 *              attention / échec / neutre) dans les deux thèmes ;
 *   L66B2-04 : cartes d'état techniques : DONE / SUCCESS pétrole, FAILED
 *              rouge, PARTIAL / SUSPENDED cuivre, PENDING / RUNNING neutre ;
 *   L66B2-05 : graphiques : palette catégorielle = jetons --chart-1 / -2,
 *              repérables (≥ 3:1) sur les cartes claires et sombres ;
 *   L66B2-06 : coquille BO alignée sur l'application (menu, voile, rôle) ;
 *   L66B2-07 : un coût n'est pas une alerte (montants en texte neutre) ;
 *   L66B2-08 : pages juridiques autonomes (serveur) aux couleurs de la charte.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VIZ_STYLE } from '@/app/admin/_dashboard/charts';
import { renderLegalVersionHtml } from '@/services/legal/legal-html.renderer';
import { renderLegalErrorPage } from '@/services/legal/legal-error-page';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const CSS = read('src/app/globals.css');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${n}`;
    if (n === '__tests__' || n === 'node_modules') continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(tsx?|css)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(rel);
  }
  return out;
}
const BO = [...walk('src/app/admin'), ...walk('src/components/admin'), 'src/components/AdminSidebar.tsx'];

/** Retire les commentaires (références de tickets « #419 » ≠ couleurs). */
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PALETTE = /(?<![\w-])(?:[\w[\]=&>:-]+:)*(?:bg|text|border|from|to|via|ring|fill|stroke|outline|decoration|divide|placeholder|shadow|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/g;
const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g;
const RGB = /\brgba?\(\s*\d/g;
const BLANC_NOIR = /(?<![\w-])(?:[\w[\]=&>:-]+:)*(?:bg|text|border|from|to|via|ring|fill)-(?:white|black)\b/g;

function bloc(selecteur: string): string {
  const i = CSS.indexOf(selecteur);
  expect(i, `sélecteur introuvable : ${selecteur}`).toBeGreaterThanOrEqual(0);
  const debut = CSS.indexOf('{', i);
  return CSS.slice(debut + 1, CSS.indexOf('\n}', debut));
}
const THEMES = { clair: bloc('html[data-theme="beige"] {'), sombre: bloc('html[data-theme="beige"] .public-page {') } as const;
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

describe('L66B2-01 — aucune couleur brute dans le back-office', () => {
  it('L66B2-01 — le périmètre est bien parcouru (pages, composants, coquille)', () => {
    expect(BO.length).toBeGreaterThan(80);
    expect(BO).toContain('src/app/admin/ai-usage/[accountId]/page.tsx');
    expect(BO).toContain('src/app/admin/ai-executions/_components/ExecutionReportPanel.tsx');
  });
  for (const f of BO) {
    it(`L66B2-01 — ${f}`, () => {
      const s = sansCommentaires(read(f));
      expect(s.match(PALETTE) ?? [], 'palette Tailwind brute').toEqual([]);
      expect(s.match(HEX) ?? [], 'hexadécimal').toEqual([]);
      expect(s.match(RGB) ?? [], 'rgb(a)').toEqual([]);
      expect(s.match(BLANC_NOIR) ?? [], 'blanc / noir écrits').toEqual([]);
    });
  }
});

describe('L66B2-02 — pas de variante dark: inopérante', () => {
  it('L66B2-02 — aucune classe dark: dans le BO', () => {
    const fautifs = BO.filter((f) => /(?<![\w-])dark:/.test(sansCommentaires(read(f))));
    expect(fautifs).toEqual([]);
  });
});

describe('L66B2-03 — rôles d’état lisibles et distincts, clair et sombre', () => {
  // [texte, fond] : combinaisons réellement employées par les pastilles et encadrés du BO.
  const paires: Array<[string, string]> = [
    ['text-success', 'bg-success'], ['text-warning-soft', 'bg-warning'], ['text-danger', 'bg-danger'],
    ['text-secondary', 'bg-subtle'], ['text-muted', 'bg-subtle'],
    ['text-success', 'bg-card'], ['text-warning-soft', 'bg-card'], ['text-danger', 'bg-card'],
    ['text-primary', 'bg-warning'], ['text-primary', 'bg-danger'], ['text-muted', 'bg-warning'], ['text-muted', 'bg-danger'],
    ['accent', 'accent-soft'], ['on-violet', 'wash-violet'],
  ];
  for (const [theme, b] of Object.entries(THEMES)) {
    for (const [t, f] of paires) {
      it(`L66B2-03 — ${theme} : ${t} sur ${f} ≥ 4,5:1`, () => {
        expect(contraste(v(b, t), v(b, f))).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`L66B2-03 — ${theme} : succès, attention, échec et neutre ont quatre fonds et quatre textes distincts`, () => {
      const fonds = ['bg-success', 'bg-warning', 'bg-danger', 'bg-subtle'].map((n) => v(b, n));
      const textes = ['text-success', 'text-warning-soft', 'text-danger', 'text-secondary'].map((n) => v(b, n));
      expect(new Set(fonds).size).toBe(4);
      expect(new Set(textes).size).toBe(4);
      // Rouge (échec) et cuivre (attention) éloignés : écart de teinte visible.
      expect(v(b, 'text-danger')).not.toBe(v(b, 'text-warning-soft'));
    });
  }
});

describe('L66B2-04 — cartes d’état techniques', () => {
  const SUCCES = 'var(--bg-success)';
  const ECHEC = 'var(--bg-danger)';
  const ATTENTION = 'var(--bg-warning)';
  const NEUTRE = 'var(--bg-subtle)';
  const ligne = (src: string, cle: string) => {
    // Ligne de la table de COULEURS (les tables de libellés ont les mêmes clés).
    const l = src.split('\n').find((x) => x.trimStart().startsWith(`${cle}:`) && x.includes('var(--'));
    expect(l, `${cle} introuvable`).toBeTruthy();
    return l!;
  };
  it('L66B2-04 — File IA : DONE pétrole, FAILED rouge, PENDING / RUNNING neutres', () => {
    const s = read('src/app/admin/ai-queue/page.tsx');
    expect(ligne(s, 'DONE')).toContain(SUCCES);
    expect(ligne(s, 'FAILED')).toContain(ECHEC);
    expect(ligne(s, 'PENDING')).toContain(NEUTRE);
    expect(ligne(s, 'RUNNING')).toContain(NEUTRE);
  });
  it('L66B2-04 — rapport d’exécution : SUCCESS / WRITTEN pétrole, PARTIAL cuivre, FAILED rouge', () => {
    const s = read('src/app/admin/ai-executions/_components/ExecutionReportPanel.tsx');
    expect(ligne(s, 'SUCCESS')).toContain(SUCCES);
    expect(ligne(s, 'WRITTEN')).toContain(SUCCES);
    expect(ligne(s, 'PARTIAL')).toContain(ATTENTION);
    expect(ligne(s, 'FAILED')).toContain(ECHEC);
    expect(ligne(s, 'NOT_PERSISTED')).toContain(ECHEC);
  });
  it('L66B2-04 — état d’un traitement IA : ENABLED pétrole, SUSPENDED cuivre, DISABLED neutre', () => {
    const s = read('src/app/admin/ai-config/_components/TreatmentStateControl.tsx');
    expect(ligne(s, 'ENABLED')).toContain(SUCCES);
    expect(ligne(s, 'SUSPENDED')).toContain(ATTENTION);
    expect(ligne(s, 'DISABLED')).toContain(NEUTRE);
  });
  it('L66B2-04 — usage IA par compte : succès / erreur / quota / en attente', () => {
    const s = read('src/app/admin/ai-usage/[accountId]/page.tsx');
    expect(ligne(s, 'success')).toContain(SUCCES);
    expect(ligne(s, 'error')).toContain(ECHEC);
    expect(ligne(s, 'refused_quota')).toContain(ATTENTION);
    expect(ligne(s, 'pending')).toContain(NEUTRE);
  });
  it('L66B2-04 — tentatives : RUNNING / QUEUED ne prennent pas la couleur du succès', () => {
    const s = read('src/app/admin/ai-executions/_components/JobAttemptsPanel.tsx');
    const tone = s.slice(s.indexOf('const TONE'), s.indexOf('};', s.indexOf('const TONE')));
    expect(tone).toMatch(/SUCCESS: 'text-\[color:var\(--text-success\)\]'/);
    expect(tone).toMatch(/FAILED: 'text-\[color:var\(--text-danger\)\]'/);
    expect(tone).not.toMatch(/(RUNNING|QUEUED): 'text-\[color:var\(--(text-success|accent)\)\]'/);
  });
  it('L66B2-04 — un échec de test de prompt maître s’affiche en rouge', () => {
    expect(read('src/app/admin/ai-config/_components/MasterPrompts.tsx'))
      .toMatch(/test\.run\.failed > 0 && <span className="text-\[color:var\(--text-danger\)\]">/);
  });
});

describe('L66B2-05 — graphiques du dashboard', () => {
  it('L66B2-05 — séries 1 et 2 = jetons --chart-1 / --chart-2, sans hexadécimal', () => {
    expect(VIZ_STYLE).toContain('--viz-1: var(--chart-1)');
    expect(VIZ_STYLE).toContain('--viz-2: var(--chart-2)');
    expect(VIZ_STYLE).not.toMatch(HEX);
    expect(VIZ_STYLE).not.toContain('.dark');
  });
  for (const [theme, b] of Object.entries(THEMES)) {
    it(`L66B2-05 — ${theme} : séries repérables (≥ 3:1) sur la carte et distinctes entre elles`, () => {
      for (const s of ['chart-1', 'chart-2']) expect(contraste(v(b, s), v(b, 'bg-card'))).toBeGreaterThanOrEqual(3);
      expect(v(b, 'chart-1')).not.toBe(v(b, 'chart-2'));
    });
  }
});

describe('L66B2-06 — coquille du back-office', () => {
  const s = read('src/components/AdminSidebar.tsx');
  it('L66B2-06 — entrée active : brume + pétrole + filet, aria-current', () => {
    expect(s).toContain("aria-current={isActive ? 'page' : undefined}");
    expect(s).toContain('border-[color:var(--accent)] bg-[color:var(--accent-soft)] font-semibold text-[color:var(--accent)]');
    expect(s).not.toMatch(/hover:bg-accent\b/);
  });
  it('L66B2-06 — fond du menu = --sidebar, voile mobile = --veil', () => {
    expect(s).toContain('bg-[color:var(--sidebar)]');
    expect(s).toContain('bg-[color:var(--veil)]');
  });
});

describe('L66B2-07 — un coût n’est pas une alerte', () => {
  it('L66B2-07 — montants de coût en texte neutre (usage IA par compte)', () => {
    const s = read('src/app/admin/ai-usage/[accountId]/page.tsx');
    const lignes = s.split('\n').filter((l) => l.includes('formatCostMicros(') && l.includes('className'));
    expect(lignes.length).toBeGreaterThan(5);
    for (const l of lignes) expect(l).not.toMatch(/--(text-warning|attention)/);
  });
});

describe('L66B2-08 — pages juridiques autonomes', () => {
  const doc = renderLegalVersionHtml({
    versionCode: 'CGVU-2026-01', title: 'CGVU', bodyHtml: '<p>Texte</p>',
    effectiveAt: new Date('2026-10-01T00:00:00Z'), changeSummary: 'Résumé',
  });
  const err = renderLegalErrorPage({ title: 'Version introuvable', message: 'Absente.', requestedVersion: '2026-01-01-v1' });
  it('L66B2-08 — document : encre, pétrole, filets et focus de la charte ; plus de serif ni de bleu', () => {
    for (const c of ['#26353B', '#17474D', '#52636A', '#D5DEDC', '#AA4E38']) expect(doc).toContain(c);
    expect(doc).not.toMatch(/#1a1a1a|#0b5fff|#40454d|#c3c8ce|Georgia|[^-]serif;/i);
    expect(doc).not.toMatch(/<link\b|@import|url\(/); // toujours autonome (§13)
  });
  it('L66B2-08 — page d’erreur : mêmes couleurs, lien pétrole, avertissement cuivre', () => {
    expect(err).toContain('a { color: #17474D;');
    expect(err).toContain('.warn { font-size: 0.9rem; color: #AA4E38; }');
    expect(err).not.toMatch(/#1a1a1a|#0b5fff|#7a4a00/i);
  });
});
