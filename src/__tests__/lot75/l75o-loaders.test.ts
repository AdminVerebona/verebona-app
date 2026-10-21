/**
 * Lot 75O — « le loader ne tourne plus ».
 *
 * Le CSS est compilé comme par Next (@tailwindcss/postcss sur
 * src/app/globals.css), puis on vérifie :
 *  - L75O-1 : la rotation est bien générée (`.animate-spin`, `@keyframes spin`,
 *    `.animate-pulse`, `vb-dot`) — pas de purge, pas de keyframes manquantes,
 *    aucune règle `animation: none` qui l'écraserait ;
 *  - L75O-2 : en « réduire les animations » (iPhone : Accessibilité >
 *    Mouvement), la règle globale §12bis (une itération de 0,001 ms) figeait
 *    TOUS les indicateurs de chargement. Les indicateurs de progression en
 *    sont désormais exemptés (rotation lente, comme l'indicateur natif iOS ;
 *    trois points en fondu, sans déplacement) ;
 *  - L75O-3 : les loaders à style en ligne (LogoLoader, écran de
 *    rechargement) portent la classe `vb-loader-spin` qui les exempte.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss, { type Root, type Rule, type AtRule } from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { LogoLoader } from '@/components/LogoLoader';

(globalThis as { React?: typeof React }).React = React;

const ROOT = path.resolve(__dirname, '../../..');
const GLOBALS = path.join(ROOT, 'src/app/globals.css');
let css = '';
let ast: Root;

beforeAll(async () => {
  const r = await postcss([tailwind({ base: ROOT })]).process(fs.readFileSync(GLOBALS, 'utf8'), { from: GLOBALS });
  css = r.css;
  ast = postcss.parse(css);
}, 60_000);

/** Règles d'un sélecteur donné, avec la media query englobante éventuelle. */
function rulesFor(selector: string): { rule: Rule; media: string | null }[] {
  const out: { rule: Rule; media: string | null }[] = [];
  ast.walkRules((rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    let p = rule.parent;
    let media: string | null = null;
    while (p && p.type !== 'root') {
      if (p.type === 'atrule' && (p as AtRule).name === 'media') { media = (p as AtRule).params; break; }
      p = p.parent;
    }
    out.push({ rule, media });
  });
  return out;
}
const decl = (rule: Rule, prop: string) => {
  let v: string | null = null;
  rule.walkDecls(prop, (d) => { v = d.value + (d.important ? ' !important' : ''); });
  return v;
};
const keyframes = (name: string) => {
  let body: string | null = null;
  ast.walkAtRules('keyframes', (a) => { if (a.params === name) body = a.toString(); });
  return body as string | null;
};
const REDUCE = /prefers-reduced-motion:\s*reduce/;

describe('L75O-1 — la rotation est générée et appliquée', () => {
  it('L75O-1a : .animate-spin → spin 1s linear infinite + @keyframes spin rotate(360deg)', () => {
    const base = rulesFor('.animate-spin').filter((r) => !r.media);
    expect(base.length).toBeGreaterThan(0);
    expect(decl(base[0].rule, 'animation')).toBe('var(--animate-spin)');
    expect(css).toMatch(/--animate-spin:\s*spin 1s linear infinite/);
    expect(keyframes('spin')).toMatch(/rotate\(360deg\)/);
  });

  it('L75O-1b : .animate-pulse et les trois points vb-dot ont leurs keyframes', () => {
    expect(css).toMatch(/--animate-pulse:\s*pulse 2s/);
    expect(keyframes('pulse')).not.toBeNull();
    expect(keyframes('vb-dot')).not.toBeNull();
    expect(decl(rulesFor('.vb-dot')[0].rule, 'animation')).toMatch(/vb-dot 1\.2s infinite/);
  });

  it('L75O-1c : aucune règle hors mouvement réduit ne neutralise les animations', () => {
    const killers: string[] = [];
    ast.walkDecls(/^animation(-name|-play-state)?$/, (d) => {
      if (!/^(none|paused)$/.test(d.value)) return;
      const rule = d.parent as Rule;
      let p = rule.parent; let reduce = false;
      while (p && p.type !== 'root') { if (p.type === 'atrule' && REDUCE.test((p as AtRule).params)) reduce = true; p = p.parent; }
      // `.paused` / `hover:[animation-play-state:paused]` : utilitaires explicites (défilement en pause au survol).
      if (!reduce && !/\.paused|animation-play-state\\:paused/.test(rule.selector)) killers.push(`${rule.selector} { ${d.prop}: ${d.value} }`);
    });
    expect(killers).toEqual([]);
  });
});

describe('L75O-2 — mouvement réduit : les indicateurs de chargement restent animés', () => {
  const exempt = (sel: string) => rulesFor(sel).filter((r) => r.media && REDUCE.test(r.media));

  it('L75O-2a : la règle globale §12bis est conservée (transitions et décor figés)', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-iteration-count: 1 !important/);
  });

  it.each(['.animate-spin', '.vb-loader-spin'])('L75O-2b : %s tourne encore (infinite, plus lent)', (sel) => {
    const r = exempt(sel);
    expect(r.length, `${sel} non exempté`).toBeGreaterThan(0);
    expect(decl(r[0].rule, 'animation-iteration-count')).toBe('infinite !important');
    const dur = decl(r[0].rule, 'animation-duration') ?? '';
    expect(parseFloat(dur)).toBeGreaterThanOrEqual(1);
  });

  it('L75O-2c : squelettes animate-pulse — fondu conservé (opacité seule)', () => {
    const r = exempt('.animate-pulse');
    expect(r.length).toBeGreaterThan(0);
    expect(decl(r[0].rule, 'animation-iteration-count')).toBe('infinite !important');
    expect(keyframes('pulse')).not.toMatch(/transform/);
  });

  it('L75O-2d : trois points — fondu sans déplacement, décalés', () => {
    const r = exempt('.vb-dot');
    expect(r.length).toBeGreaterThan(0);
    expect(decl(r[0].rule, 'animation-name')).toBe('vb-dot-fade !important');
    expect(decl(r[0].rule, 'animation-iteration-count')).toBe('infinite !important');
    const fade = keyframes('vb-dot-fade');
    expect(fade).toMatch(/opacity/);
    expect(fade).not.toMatch(/transform/);
    expect(exempt('.vb-dot:nth-child(2)').length).toBeGreaterThan(0);
  });
});

describe('L75O-3 — loaders à style en ligne', () => {
  it('L75O-3a : LogoLoader — orbite et carré portent vb-loader-spin', () => {
    const html = renderToStaticMarkup(createElement(LogoLoader, { size: 40 }));
    expect(html.match(/class="vb-loader-spin"/g)?.length).toBe(2);
  });

  it('L75O-3b : écran « Mise à jour détectée, rechargement… » (error.tsx) porte vb-loader-spin', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/app/error.tsx'), 'utf8');
    expect(src).toMatch(/className="vb-loader-spin"[\s\S]{0,400}animation: 'spin 0\.8s linear infinite'/);
  });
});
