/**
 * Lot 84B — tiroirs du regroupement (CDC v5 O-3, §14) dans un NAVIGATEUR RÉEL
 * (Chromium du dépôt, playwright-core), desktop ET mobile (iPhone 390 × 844,
 * zones sûres simulées comme au lot 81F). Composants réels : base des tiroirs
 * (`@/components/ui/sheet`), panneau `AgendaGroupingPanel`, tiroir de choix
 * `GroupingPicker` EMPILÉ ; feuille de style réelle (globals.css + Tailwind).
 *
 *   L84B-NAV01  mobile : largeur d'écran, aucun débordement horizontal, gestes ≥ 44 px
 *   L84B-NAV02  mobile : tiroir de choix plein écran, « Fermer » sous la zone sûre, touchable, ne ferme que lui
 *   L84B-NAV03  mobile : retour Android → ferme le tiroir de choix seul, puis le tiroir de l'événement
 *   L84B-NAV04  focus : à la fermeture (Échap), le focus revient au bouton d'origine ; recherche au clavier
 *   L84B-NAV05  desktop : 520 px / 440 px, aucun décalage
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
const SAFE_TOP = 59;
const SAFE_BOTTOM = 34;
const MOBILE = { width: 390, height: 844 };

describe.skipIf(!EXE)('L84B — tiroirs du regroupement : mobile et desktop (navigateur réel)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let css = '';

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l84b-regroupement-harness.tsx')],
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
    const sources = [
      'src/components/ui/sheet.tsx', 'src/components/ui/button.tsx', 'src/components/ui/input.tsx', 'src/components/drawers/EntityCard.tsx',
      'src/components/agenda/AgendaGroupingPanel.tsx', 'src/components/agenda/__tests__/fixtures/l84b-regroupement-harness.tsx',
    ];
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
    const safeCss = mobile ? `:root{--safe-area-inset-top:${SAFE_TOP}px;--safe-area-inset-bottom:${SAFE_BOTTOM}px}` : '';
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u === URL || u.startsWith(`${URL}#`)) {
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style><style>${safeCss}</style></head><body><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript', body: bundle });
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    expect(erreurs).toEqual([]);
    await page.evaluate((s) => window.__l84bMonter({ statusBar: s }), mobile ? SAFE_TOP : 0);
    await page.waitForTimeout(650);
  }

  const tiroirs = () => page.locator('[data-slot="sheet-content"]');
  const choix = () => page.getByTestId('regroupement-choix');
  const fermer = (dans: ReturnType<Page['locator']>) => dans.locator('[data-slot="sheet-close"]');

  async function ouvrirChoix() {
    await page.getByTestId('regroupement-relier-documents').click();
    await page.waitForTimeout(650);
    await expect(choix().count()).resolves.toBe(1);
  }

  it('L84B-NAV01 — mobile : tiroir pleine largeur, aucun débordement horizontal, gestes ≥ 44 px', async () => {
    await ouvrir(true);
    const t = (await page.getByTestId('tiroir-evenement').boundingBox())!;
    expect(Math.round(t.width)).toBe(MOBILE.width);
    const deborde = await page.getByTestId('tiroir-evenement').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(deborde).toBeLessThanOrEqual(0);
    const petits = await page.getByTestId('agenda-regroupement').evaluate((el) =>
      [...el.querySelectorAll('button')].map((b) => ({ n: b.getAttribute('aria-label') ?? b.textContent, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width }))
        .filter((b) => b.h < 44 || b.w < 44));
    expect(petits).toEqual([]);
    // Le titre ne passe pas sous la barre d'état.
    expect((await page.getByTestId('titre').boundingBox())!.y).toBeGreaterThanOrEqual(SAFE_TOP);
  });

  it('L84B-NAV02 — mobile : tiroir de choix empilé plein écran ; « Fermer » sous la zone sûre, ≥ 44 px, touchable, ne ferme que lui', async () => {
    await ouvrir(true);
    await ouvrirChoix();
    expect(Math.round((await choix().boundingBox())!.width)).toBe(MOBILE.width);
    const b = (await fermer(choix()).boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
    const cible = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-slot="sheet-close"]') ? 'bouton' : 'autre', [b.x + b.width / 2, b.y + b.height / 2]);
    expect(cible).toBe('bouton');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__l84bFermetures)).toEqual({ tiroir: 0, choix: 1 });
    expect(await tiroirs().count()).toBe(1);
    // Un choix touché relie l'objet et referme le tiroir de choix.
    await ouvrirChoix();
    await page.getByRole('button', { name: /Facture plombier/ }).tap();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__l84bGestes)).toEqual(['choisi:31']);
    expect(await tiroirs().count()).toBe(1);
  });

  it('L84B-NAV03 — mobile : le retour Android ferme le tiroir de choix seul, puis le tiroir de l’événement', async () => {
    await ouvrir(true);
    await ouvrirChoix();
    expect(await tiroirs().count()).toBe(2);
    await page.evaluate(() => history.back());
    await page.waitForTimeout(600);
    expect(await tiroirs().count()).toBe(1);
    expect(await page.evaluate(() => window.__l84bFermetures)).toEqual({ tiroir: 0, choix: 1 });
    await page.evaluate(() => history.back());
    await page.waitForTimeout(600);
    expect(await tiroirs().count()).toBe(0);
    expect(await page.evaluate(() => window.__l84bFermetures.tiroir)).toBe(1);
  });

  it('L84B-NAV04 — clavier : recherche, Échap ferme le choix seul et rend le focus au bouton d’origine', async () => {
    await ouvrir(false);
    await page.getByTestId('regroupement-relier-documents').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(650);
    await expect(page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).resolves.toBe('Rechercher');
    await page.keyboard.type('courrier');
    await page.waitForTimeout(400);
    await expect(choix().getByRole('button', { name: /Courrier d’indemnisation/ }).count()).resolves.toBe(1);
    await expect(choix().getByRole('button', { name: /Facture plombier/ }).count()).resolves.toBe(0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    expect(await tiroirs().count()).toBe(1);
    await expect(page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).resolves.toBe('regroupement-relier-documents');
    // Bouton « Retirer » nommé, atteignable au clavier.
    await expect(page.getByRole('button', { name: 'Retirer « Cuisine »' }).count()).resolves.toBe(1);
  });

  it('L84B-NAV05 — desktop : tiroir 520 px, choix 440 px, X au même centre qu’avant', async () => {
    await ouvrir(false);
    expect(Math.round((await page.getByTestId('tiroir-evenement').boundingBox())!.width)).toBe(520);
    await ouvrirChoix();
    expect(Math.round((await choix().boundingBox())!.width)).toBe(440);
    const b = (await fermer(choix()).boundingBox())!;
    expect(Math.round(b.x + b.width / 2)).toBe(1280 - 30);
    expect(Math.round(b.y + b.height / 2)).toBe(30);
  });
});
