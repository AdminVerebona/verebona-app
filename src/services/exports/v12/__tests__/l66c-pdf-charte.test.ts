/**
 * Lot 66C — dossiers PDF V12 à la charte « Sérénité » 2026 (§1, §2 ligne PDF, §3, §8).
 *
 *  · L66C-PDF-01 : CONTENU et STRUCTURE inchangés — pour les 18 cas × 2 passes des
 *    maquettes, le texte visible ET le HTML hors <style> @page sont identiques, octet
 *    pour octet, à ceux du tag lot65 (`fixtures/l66c-content-lot65.json`, relevés avant
 *    la migration graphique). Seule la présentation a changé.
 *  · L66C-PDF-02 : jetons (couleurs de la charte, plus aucune couleur 2025, géométrie A4).
 *  · L66C-PDF-03 : polices Figtree auto-hébergées (5 graisses, woff2, licence OFL).
 *  · L66C-PDF-04 : en-tête / pied (10,5 px #52636A Figtree, marque pétrole, filet, dernière page ivoire).
 *  · L66C-PDF-05 : logos (ivoire sur couverture, pétrole sur pages claires, cube cuivre).
 *  · L66C-PDF-06 : typographie et composants (sur-titres, h2, h1 couverture, carte prix, codes A1).
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { renderDossierHtml } from '../templates';
import { pageSetup } from '../html/components';
import { staticDir, missingStaticFiles } from '../static-assets';
import type { RenderContext } from '../types';
import type { DossierCode } from '@/services/exports/catalog';

const FIX = join(process.cwd(), 'src/services/exports/v12/__tests__/fixtures');
const DOSSIERS: Array<[string, DossierCode]> = [
  ['cil', 'CIL'], ['dossier-complet', 'DOSSIER_COMPLET'], ['vente', 'VENTE'], ['location', 'LOCATION'],
  ['assurance-souscription', 'ASSURANCE_SOUSCRIPTION'], ['assurance-sinistre', 'ASSURANCE_SINISTRE'],
];
const base = JSON.parse(readFileSync(join(FIX, 'l66c-content-lot65.json'), 'utf8')).hashes as Record<string, { text: string; body: string }>;
const ctx = (pass: 1 | 2): RenderContext => ({
  sys: 'SYS/',
  asset: (p) => (p ? `SYS/assets/${p}` : null),
  stylesheets: ['SYS/tokens.css', 'SYS/components.css'],
  pageMap: pass === 1 ? null : { total: 17, annexStart: { A1: 9, A2: 10, A3: 11, A4: 12, A5: 13, A6: 14, A7: 15 } },
});
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const read = (f: string) => readFileSync(join(staticDir(), f), 'utf8');
const tokens = read('tokens.css');
const components = read('components.css');

describe('L66C-PDF-01 — contenu et structure des dossiers inchangés', () => {
  for (const [dir, code] of DOSSIERS) {
    it(`${dir} : texte visible et HTML hors <style> identiques au lot 65`, () => {
      const cases = JSON.parse(readFileSync(join(FIX, `${dir}.json`), 'utf8')).cases;
      for (const id of ['minimal', 'nominal', 'riche']) {
        for (const pass of [1, 2] as const) {
          const html = renderDossierHtml(code, structuredClone(cases[id]), ctx(pass)).html;
          const noStyle = html.replace(/<style>[\s\S]*?<\/style>/g, '');
          const text = noStyle.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
          const key = `${dir}/${id}/${pass}`;
          expect(sha(text), `${key} texte`).toBe(base[key].text);
          expect(sha(noStyle), `${key} structure`).toBe(base[key].body);
        }
      }
    });
  }
});

describe('L66C-PDF-02 — jetons de la charte', () => {
  it('couleurs Sérénité présentes aux bons rôles', () => {
    expect(tokens).toMatch(/--navy:\s*#17474D/);         // couverture et carte prix pétrole
    expect(tokens).toMatch(/--blue-600:\s*#AA4E38/);     // codes A1 / B1 en cuivre texte
    expect(tokens).toMatch(/--panel:\s*#F8F6F1/);        // encadrés ivoire
    expect(tokens).toMatch(/--line:\s*#E2EBE9/);
    expect(tokens).toMatch(/--line-card:\s*#D5DEDC/);
    expect(tokens).toMatch(/--paper:\s*#FFFFFF/);        // pages intérieures blanches
    expect(tokens).toMatch(/--ink:\s*#26353B/);
    expect(tokens).toMatch(/--ink-2:\s*#52636A/);
    expect(tokens).toMatch(/--eyebrow:\s*#AA4E38/);
    expect(tokens).toMatch(/--on-navy-kicker:\s*#E2896F/); // sur-titres sur pétrole
    expect(tokens).toMatch(/--warn:\s*#AA4E38/);          // attention en cuivre
    expect(tokens).toMatch(/--bad:\s*#B42318/);           // décision PO : rouge accessible pour retards stricts / bloquants
  });
  it('plus aucune couleur ni police de la charte 2025', () => {
    for (const old of ['#020B1A', '#3B82F6', '#2563EB', '#0F1B33', '#8A93A6', '#7EB0FF', '#EF4444', '#15803D', 'Space Mono', 'Bricolage']) {
      expect(tokens + components, old).not.toContain(old);
    }
  });
  it('géométrie A4 inchangée (marges 44 / 70 / 64, couverture 56)', () => {
    expect(tokens).toMatch(/--margin-x:\s*44px/);
    expect(tokens).toMatch(/--margin-top:\s*70px/);
    expect(tokens).toMatch(/--margin-bottom:\s*64px/);
    expect(tokens).toMatch(/--cover-x:\s*56px/);
    expect(pageSetup({ headerLabel: 'x' })).toContain('margin: 70px 44px 64px 44px;');
  });
});

describe('L66C-PDF-03 — polices Figtree auto-hébergées', () => {
  it('une face woff2 par graisse 400 à 800, déclarées et présentes', () => {
    for (const w of [400, 500, 600, 700, 800]) {
      expect(tokens).toContain(`font-family: 'Figtree'; src: url('fonts/figtree-${w}.woff2') format('woff2'); font-weight: ${w};`);
      const buf = readFileSync(join(staticDir(), 'fonts', `figtree-${w}.woff2`));
      expect(buf.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    expect(tokens).toMatch(/--font-body:\s*'Figtree'/);
    expect(tokens).toMatch(/--font-display:\s*'Figtree'/);
    expect(missingStaticFiles()).toEqual([]);
  });
  it('licence OFL de Figtree livrée ; polices retirées absentes', () => {
    const lic = read('fonts/LICENSE.txt');
    expect(lic).toContain('==== figtree');
    expect(lic).toContain('SIL Open Font License, Version 1.1');
    for (const gone of ['space-mono-400.woff2', 'space-mono-700.woff2', 'bricolage-grotesque-latin-opsz-5.3.0.woff2', 'LICENSE-space-mono.txt']) {
      expect(existsSync(join(staticDir(), 'fonts', gone)), gone).toBe(false);
    }
  });
});

describe('L66C-PDF-04 — en-tête, pied et dernière page', () => {
  const css = pageSetup({ headerLabel: 'Kit de vente · Vélo Cargo · 16/10/2026' });
  it('chrome 10,5 px #52636A en Figtree, marque pétrole, filet #D5DEDC', () => {
    expect(css).toContain("font-family:'Figtree','Inter',sans-serif;font-size:10.5px;color:#52636A;");
    expect(css).toMatch(/@top-left \{ content: "Verebona"; font-family: 'Figtree'[^}]*color: #17474D/);
    expect(css).toContain('border-bottom:1px solid #D5DEDC;');
    expect(css).not.toContain('Inter,sans-serif;font-size:10.5px;color:#8A93A6');
  });
  it('pied et pagination conservés (PDF-TXT-008/009)', () => {
    expect(css).toContain('content: "Ce dossier a été préparé avec Verebona."');
    expect(css).toContain('content: "Page " counter(page) " / " counter(pages)');
  });
  it('dernière page « Sources et limites » sur ivoire', () => {
    expect(css).toMatch(/@page refs \{\s*background: #F8F6F1;/);
  });
});

describe('L66C-PDF-05 — logos', () => {
  const svg = (f: string) => read(`assets/brand/${f}`);
  it('ivoire sur couverture, pétrole sur pages claires, cube cuivre tourné de 18°', () => {
    expect(svg('verebona-mark-on-dark.svg')).toContain('fill="#F8F6F1"');
    expect(svg('verebona-mark.svg')).toContain('fill="#17474D"');
    for (const f of ['verebona-mark.svg', 'verebona-mark-on-dark.svg']) {
      expect(svg(f)).toContain('fill="#D66B53" transform="rotate(18 27.43 3.02)"');
      expect(svg(f)).not.toContain('#3B82F6');
    }
  });
});

describe('L66C-PDF-06 — typographie et composants', () => {
  it('sur-titres 10 px / 700 capitales 0,09 em cuivre texte ; h2 26 / 700 pétrole ; h1 couverture 56 / 800', () => {
    expect(tokens).toMatch(/--fs-eyebrow:\s*10px/);
    expect(tokens).toMatch(/--ls-eyebrow:\s*\.09em/);
    expect(components).toMatch(/\.eyebrow \{[^}]*text-transform: uppercase;\s*font-weight: 700;\s*color: var\(--eyebrow\);/);
    expect(tokens).toMatch(/--fs-h2:\s*26px/);
    expect(components).toMatch(/\.sec-title \{[^}]*font-weight: 700;\s*color: var\(--heading\);/);
    expect(tokens).toMatch(/--fs-h1-cover:\s*56px/);
    expect(components).toMatch(/\.cover h1 \{[^}]*font-weight: 800;/);
    expect(tokens).toMatch(/--fs-kv:\s*13\.5px/);
    expect(tokens).toMatch(/--fs-table:\s*13px/);
    expect(tokens).toMatch(/--fs-chrome:\s*10\.5px/);
  });
  it('carte prix pétrole 32 / 800, codes d\'annexe en cuivre texte, couverture en aplat', () => {
    expect(components).toContain('.figure.price .val { font-size: 32px; }');
    expect(components).toMatch(/\.figure\.primary \{ background: var\(--navy\)/);
    expect(components).toMatch(/\.figure \.val \{[^}]*font-weight: 800/);
    expect(components).toMatch(/\.annex-index \.ref \{[^}]*color: var\(--blue-600\)/);
    expect(components).toMatch(/\.annex-banner \.ref \{[^}]*color: var\(--blue-600\)/);
    expect(components).toContain('.cover .halo, .cover .dots { display: none; }');
  });
});

// ── L66C-PDF-07 : rendu Chromium réel — polices réellement incorporées (ignoré sans Chromium).
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && !process.env.CHROMIUM_EXECUTABLE_PATH && existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}
const chromium = process.env.EXPORTS_CHROMIUM_TESTS !== '0' && (await (await import('../render/browser')).isChromiumAvailable());

describe.skipIf(!chromium)('L66C-PDF-07 — PDF généré : Figtree incorporée, aucune ancienne police', () => {
  it('kit de vente rendu par Chromium', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { PDFDocument, PDFDict, PDFName } = await import('pdf-lib');
    const { renderDossier } = await import('../render/render-dossier');
    const { buildDefaultChoices } = await import('../data/choices');
    const { closeBrowser } = await import('../render/browser');
    const { makeSource, TODAY } = await import('./fixtures/sources');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l66c-'));
    try {
      const source = makeSource('VEHICULE', 'VENTE', { documents: [], photos: [] });
      const r = await renderDossier({
        code: 'VENTE', source, choices: buildDefaultChoices('VENTE', source, { today: TODAY }), today: TODAY, workDir: dir,
        fetchToFile: async () => false, timeoutMs: 90_000,
        meta: { reference: 'VBN-L66C-000001', generatedAt: '2026-10-16T10:30:00+02:00', preparedBy: 'Léa Martin' },
      });
      const pdf = await PDFDocument.load(r.pdf);
      const fonts = new Set<string>();
      for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && obj.get(PDFName.of('BaseFont'))) fonts.add(String(obj.get(PDFName.of('BaseFont'))).replace(/^\/[A-Z]{6}\+/, ''));
      }
      const names = [...fonts];
      expect(names.some((n) => n.startsWith('Figtree-'))).toBe(true);
      expect(names.filter((n) => /SpaceMono|Bricolage/.test(n))).toEqual([]);
      for (const w of ['Regular', 'Bold', 'ExtraBold']) expect(names, w).toContain(`Figtree-${w}`);
    } finally {
      await closeBrowser('fin L66C');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
