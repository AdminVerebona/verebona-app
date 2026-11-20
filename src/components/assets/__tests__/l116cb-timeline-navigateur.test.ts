/**
 * Carte #806 §6 (lot 116C, seconde partie) — Timeline du bien dans un
 * NAVIGATEUR RÉEL (Chromium du dépôt, playwright-core), ordinateur ET mobile
 * (iPhone 390 × 844). Composant réel (`AssetTimelineList`), feuille de style
 * réelle (globals.css + Tailwind).
 *
 *   L116CB-NAV01  ordinateur : l'ordre À L'ÉCRAN (de haut en bas) est l'ordre servi — dates décroissantes, sans date en bas
 *   L116CB-NAV02  ordinateur : provenance d'une date déduite visible devant la date ; « Sans date » visible ; rien pour une date propre
 *   L116CB-NAV03  mobile : mêmes textes, même ordre, aucun débordement horizontal, zones tactiles conservées
 *   L116CB-NAV04  mobile : le chevron déplie les seuls événements ; un événement sans date y porte « Sans date » ; le clic
 *                 sur la ligne demande la fiche de l'opération, sans déplier
 *
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';

function chromium(): string | null {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    for (const exe of ['chrome-linux/headless_shell', 'chrome-linux/chrome']) {
      const p = resolve(base, d, exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const EXE = chromium();
const ROOT = resolve(__dirname, '../../../..');
const URL = 'http://verebona.test/';
const MOBILE = { width: 390, height: 844 };
const ORDRE = ['30', 'op-7', 'op-8', '10', 'op-9', '20'];

describe.skipIf(!EXE)('L116CB — Timeline : ordre, provenance des dates et « sans date » (navigateur réel)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let css = '';

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l116cb-timeline-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
    });
    bundle = out.outputFiles[0].text;
    const { compile } = await import('@tailwindcss/node');
    const { Scanner } = await import('@tailwindcss/oxide');
    const compiler = await compile(readFileSync(resolve(ROOT, 'src/app/globals.css'), 'utf8'), { base: resolve(ROOT, 'src/app'), onDependency: () => {} });
    const sources = ['src/components/assets/timeline/AssetTimeline.tsx', 'src/components/assets/__tests__/fixtures/l116cb-timeline-harness.tsx'];
    css = compiler.build(new Scanner({}).scanFiles(sources.map((f) => ({ content: readFileSync(resolve(ROOT, f), 'utf8'), extension: 'tsx' }))));
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile: boolean) {
    await ctx?.close();
    ctx = await browser.newContext(mobile
      ? { viewport: MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u === URL || u.startsWith(`${URL}#`)) {
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript', body: bundle });
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    await page.evaluate((v) => window.__l116cbMonter({ variant: v }), mobile ? 'mobile' as const : 'desktop' as const);
    await page.waitForTimeout(200);
    expect(erreurs).toEqual([]);
  }

  /** Lignes de premier niveau, triées par leur position VERTICALE réelle à l'écran. */
  const ordreEcran = () => page.evaluate(() => {
    const liste = document.querySelector('[data-timeline-mode] > ul')!;
    return [...liste.children].map((li) => {
      const ligne = li.querySelector('[data-timeline-item]') as HTMLElement;
      return { id: ligne.getAttribute('data-timeline-item')!, y: ligne.getBoundingClientRect().top };
    }).sort((a, b) => a.y - b.y).map((x) => x.id);
  });
  const enTete = (id: string) => page.locator(`[data-timeline-item="${id}"] > div.flex-1 > button`).first();
  const dateDe = (id: string) => enTete(id).locator('p').first();

  for (const mobile of [false, true]) {
    const nom = mobile ? 'mobile' : 'ordinateur';
    it(`${mobile ? 'L116CB-NAV03' : 'L116CB-NAV01'} — ${nom} : l'ordre à l'écran est l'ordre servi, sans date en bas${mobile ? ' ; aucun débordement' : ''}`, async () => {
      await ouvrir(mobile);
      expect(await ordreEcran()).toEqual(ORDRE);
      // Les sans-date sont SOUS toutes les lignes datées.
      const y = async (id: string) => (await page.locator(`[data-timeline-item="${id}"]`).first().boundingBox())!.y;
      const derniereDatee = await y('10');
      expect(await y('op-9')).toBeGreaterThan(derniereDatee);
      expect(await y('20')).toBeGreaterThan(await y('op-9'));
      if (mobile) {
        const deborde = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(deborde).toBeLessThanOrEqual(0);
        // Zones tactiles conservées (règle existante de la variante mobile : 32 px au moins).
        const petits = await page.getByTestId('timeline').evaluate((el) =>
          [...el.querySelectorAll('button')].map((b) => ({ t: b.textContent, h: Math.round(b.getBoundingClientRect().height) })).filter((b) => b.h < 32));
        expect(petits).toEqual([]);
      }
    });

    it(`${mobile ? 'L116CB-NAV03 bis' : 'L116CB-NAV02'} — ${nom} : provenance d'une date déduite et mention « Sans date » visibles`, async () => {
      await ouvrir(mobile);
      // Date déduite : le fondement précède la date, sur la même ligne, visible.
      await expect(dateDe('op-7').textContent()).resolves.toBe('Premier devis · 12 mars 2024');
      await expect(dateDe('op-7').isVisible()).resolves.toBe(true);
      // Date propre : la date seule.
      await expect(dateDe('op-8').textContent()).resolves.toBe('20 nov. 2023');
      await expect(dateDe('30').textContent()).resolves.toBe('1 juin 2025');
      // Sans date : mention explicite pour l'opération ET pour l'événement, jamais une date.
      for (const id of ['op-9', '20']) {
        await expect(dateDe(id).textContent(), id).resolves.toBe('Sans date');
        await expect(dateDe(id).isVisible(), id).resolves.toBe(true);
      }
      expect(await page.locator('[data-timeline-undated]').count()).toBe(2);
      expect(await page.locator('[data-timeline-date-basis]').count()).toBe(1);
      // La mention garde le style discret de la date (même taille, même couleur que la ligne de date voisine).
      const style = (id: string) => dateDe(id).evaluate((el) => { const s = getComputedStyle(el); return `${s.fontSize}|${s.color}`; });
      expect(await style('20')).toBe(await style('30'));
      expect(await style('op-7')).toBe(await style('op-8'));
    });
  }

  it('L116CB-NAV04 — mobile : le chevron déplie les seuls événements ; « Sans date » dans le dépliage ; la ligne demande la fiche', async () => {
    await ouvrir(true);
    const groupe = page.locator('[data-timeline-group="op-7"]');
    expect(await groupe.locator('[aria-expanded]').getAttribute('aria-expanded')).toBe('false');
    await groupe.locator('[aria-expanded]').tap();
    await page.waitForTimeout(100);
    expect(await groupe.locator('[aria-expanded]').getAttribute('aria-expanded')).toBe('true');
    expect(await page.evaluate(() => window.__l116cbOuvertures.length)).toBe(0);
    await expect(dateDe('31').textContent()).resolves.toBe('2 avr. 2024');
    await expect(dateDe('32').textContent()).resolves.toBe('Sans date');
    // Le clic sur la ligne de l'opération demande SA fiche, sans replier ni déplier.
    await enTete('op-7').tap();
    expect(await page.evaluate(() => window.__l116cbOuvertures)).toEqual([{ itemId: 'op-7', context: 'group', operationId: 7 }]);
    expect(await groupe.locator('[aria-expanded]').getAttribute('aria-expanded')).toBe('true');
  });
});
