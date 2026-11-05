/**
 * Lot 111J — action principale des pieds de fenêtre / tiroirs (« Importer »,
 * « Enregistrer »…) en bouton plein pétrole de la charte « Sérénité ».
 *
 *   L111J-01 : rendu — variante, classes en jetons, états prêt / en cours / désactivé ;
 *   L111J-02 : SegmentedActionBar — ton `primary` rendu par le même composant ;
 *   L111J-03 : tous les pieds concernés utilisent le composant (plus de cellule claire) ;
 *   L111J-04 : contrastes CALCULÉS sur les jetons clair ET sombre ;
 *   L111J-05 : fenêtre « Ajouter un document » — Annuler secondaire 44 px, raison du désactivé.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Upload, X } from 'lucide-react';
import { FooterPrimaryAction, footerPrimaryClass, footerPrimaryState } from '@/components/ui/footer-primary-action';
import { SegmentedActionBar } from '@/components/ui/segmented-action-bar';

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
const THEMES = { clair: bloc('html[data-theme="beige"] {'), sombre: bloc('html[data-theme="blue"] {') };
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

const render = (props: Parameters<typeof FooterPrimaryAction>[0]) => renderToStaticMarkup(h(FooterPrimaryAction, props));

describe('L111J-01 — rendu et états', () => {
  it('prêt : pétrole plein, texte on-accent 15 px gras, cible ≥ 44 px, cliquable', () => {
    const html = render({ label: 'Importer', icon: Upload, layout: 'block' });
    expect(html).toContain('data-variant="footer-primary"');
    expect(html).toContain('data-state="ready"');
    for (const c of ['bg-[color:var(--accent)]', 'text-[color:var(--on-accent)]', 'hover:bg-[color:var(--accent-hover)]',
      'text-[15px]', 'font-bold', 'min-h-[44px]', 'h-12', 'w-full']) expect(html, c).toContain(c);
    expect(html).not.toMatch(/disabled=""/);
    expect(html).toContain('>Importer</span>');
  });

  it('en cours : fond accent-hover, roue, libellé d’envoi, aria-busy, non recliquable', () => {
    const html = render({ label: 'Importer', icon: Upload, busy: true, busyLabel: 'Envoi 2/3…', layout: 'block' });
    expect(html).toContain('data-state="busy"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('animate-spin');
    expect(html).toContain('bg-[color:var(--accent-hover)] text-[color:var(--on-accent)]');
    expect(html).toContain('>Envoi 2/3…</span>');
  });

  it('désactivé : fond muted, texte muted-foreground (pas d’opacité réduite), raison liée', () => {
    const html = render({ label: 'Importer', disabled: true, disabledReasonId: 'raison', layout: 'block' });
    expect(html).toContain('data-state="disabled"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-describedby="raison"');
    expect(html).toContain('bg-[color:var(--muted)] text-[color:var(--muted-foreground)]');
    expect(html).not.toMatch(/opacity-/);
    expect(html).not.toContain('aria-busy');
  });

  it('« en cours » l’emporte sur « désactivé » ; les trois états ont des fonds distincts', () => {
    expect(footerPrimaryState({ busy: true, disabled: true })).toBe('busy');
    expect(footerPrimaryState({ disabled: true })).toBe('disabled');
    expect(footerPrimaryState({})).toBe('ready');
    const fonds = (['ready', 'busy', 'disabled'] as const).map((s) => footerPrimaryClass(s).match(/(?<!hover:)bg-\[color:var\(--[a-z-]+\)\]/)![0]);
    expect(new Set(fonds).size).toBe(3);
  });

  it('cellule de barre segmentée : remplit la cellule, 44 px minimum', () => {
    const c = footerPrimaryClass('ready', 'cell');
    expect(c).toContain('flex-1');
    expect(c).toContain('self-stretch');
    expect(c).toContain('min-h-[44px]');
  });

  it('aucune couleur brute dans le composant', () => {
    const src = read('src/components/ui/footer-primary-action.tsx');
    expect(src).not.toMatch(/#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsl\(|\b(bg|text)-(white|black|gray|slate|teal|green|emerald)-?/);
  });
});

describe('L111J-02 — SegmentedActionBar, ton primary', () => {
  it('rend l’action primaire par FooterPrimaryAction, les autres cellules inchangées (12 px)', () => {
    const html = renderToStaticMarkup(h(SegmentedActionBar, { items: [
      { icon: X, label: 'Annuler' }, { icon: Upload, label: 'Se déconnecter', tone: 'primary' },
    ] }));
    expect(html).toContain('data-variant="footer-primary"');
    expect(html).toContain('text-[12px] font-semibold');
    expect(html.split('data-variant="footer-primary"').length).toBe(2);
  });
  it('décision PO 05/11 : « Se déconnecter » reste discret (ton accent, pas de bouton plein)', () => {
    const src = read('src/components/ConfirmLogoutDialog.tsx');
    expect(src).toContain("label: 'Se déconnecter', tone: 'accent'");
    expect(src).not.toContain("tone: 'primary'");
    expect(src).not.toContain('FooterPrimaryAction');
  });
});

describe('L111J-03 — harmonisation de tous les pieds construits sur la barre', () => {
  const USAGES: Record<string, number> = {
    'src/components/documents/unified-document-dialog.tsx': 1,
    'src/components/assets/DocumentDrawer.tsx': 1,
    'src/components/assets/EquipmentDrawer.tsx': 1,
    'src/components/assets/RoomDrawer.tsx': 1,
    'src/components/assets/ThumbnailEditDrawer.tsx': 1,
    'src/components/agenda/AgendaItemDrawer.tsx': 1,
    'src/components/agenda/CreateAgendaItemDrawer.tsx': 1,
    'src/components/AssetFormDialog.tsx': 1,
  };
  for (const [f, n] of Object.entries(USAGES)) {
    it(`${f} : ${n} action principale pleine, plus de cellule claire`, () => {
      const src = read(f);
      expect((src.match(/<FooterPrimaryAction\b/g) ?? []).length).toBe(n);
      expect(src).not.toContain('hover:bg-primary/10');
    });
  }
  it('fenêtre « Ajouter un document » : bouton pleine largeur, libellés conservés', () => {
    const src = read('src/components/documents/unified-document-dialog.tsx');
    expect(src).toContain('layout="block"');
    expect(src).toMatch(/`Importer \(\$\{files\.length\} fichiers\)` : 'Importer'/);
    expect(src).toContain("mode === 'weblink' ? 'Ajouter'");
    expect(src).not.toMatch(/<div className="flex items-stretch rounded-xl border border-border bg-muted\/30 overflow-hidden">\s*<button[^>]*\s*type="button"\s*className="[^"]*"\s*onClick=\{\(\) => handleSubmit\(\)\}/);
  });
});

describe('L111J-04 — contrastes calculés sur les jetons (clair ET sombre)', () => {
  const paires: Array<[string, string, number, string]> = [
    ['on-accent', 'accent', 4.5, 'libellé du bouton prêt'],
    ['on-accent', 'accent-hover', 4.5, 'libellé au survol / en cours'],
    ['muted-foreground', 'muted', 4.5, 'libellé désactivé (lisible)'],
    ['text-muted', 'bg-page', 4.5, 'raison sous le bouton (pied de la fenêtre d’ajout)'],
    ['accent', 'bg-page', 3, 'bouton plein vs fond du pied (non textuel)'],
    ['accent', 'bg-card', 3, 'cellule pleine vs cellules voisines (non textuel)'],
    ['accent', 'bg-card', 4.5, 'Annuler secondaire (contour + texte pétrole)'],
  ];
  for (const [theme, b] of Object.entries(THEMES)) {
    for (const [t, f, seuil, quoi] of paires) {
      it(`${theme} : ${t} sur ${f} ≥ ${seuil}:1 — ${quoi}`, () => {
        expect(contraste(v(b, t), v(b, f))).toBeGreaterThanOrEqual(seuil);
      });
    }
    it(`${theme} : prêt et désactivé se distinguent (fonds ≥ 3:1 entre eux)`, () => {
      expect(contraste(v(b, 'accent'), v(b, 'muted'))).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('L111J-05 — fenêtre « Ajouter un document » : secondaires et raison', () => {
  const src = read('src/components/documents/unified-document-dialog.tsx');
  it('Annuler / Fermer : bouton secondaire (contour), cible ≥ 44 px', () => {
    expect(src).toMatch(/variant="outline" onClick=\{handleClose\} className="w-full h-11">/);
    expect(src).not.toMatch(/size="sm" onClick=\{handleClose\}/);
  });
  it('raison affichée tant qu’aucun fichier / lien n’est prêt, reliée au bouton', () => {
    expect(src).toContain('disabledReasonId="ajout-document-pas-pret"');
    expect(src).toContain('id="ajout-document-pas-pret"');
    expect(src).toContain('Sélectionnez un fichier pour l’importer.');
  });
});
