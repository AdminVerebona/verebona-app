/**
 * Lot 86D — ticket P1 « Documents / Agenda » §2 : documents d'un élément
 * d'agenda dans un NAVIGATEUR RÉEL (Chromium du dépôt), desktop ET mobile
 * (iPhone 390 × 844, zones sûres simulées). Même harnais que 84B (composant de
 * base des tiroirs, VRAI panneau `AgendaGroupingPanel`), vue d'un élément
 * RATTACHÉ portant ses propres documents.
 *
 *   L86D-NAV01  mobile : « Documents de cet élément » sans débordement ; « Détacher » ≥ 44 px ; toucher → geste du lien seul
 *   L86D-NAV02  desktop : détacher au clavier (bouton nommé) ; événement de référence : détacher ≠ retirer de l'ensemble
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

describe.skipIf(!EXE)('L86D — documents d’un élément d’agenda : détacher, mobile et desktop (navigateur réel)', () => {
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

  async function ouvrir(mobile: boolean, vue: 'reference' | 'membre' = 'membre') {
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
    await page.evaluate(([s, v]) => window.__l84bMonter({ statusBar: s as number, vue: v as 'reference' | 'membre' }), [mobile ? SAFE_TOP : 0, vue] as const);
    await page.waitForTimeout(650);
  }


  const tiroirs = () => page.locator('[data-slot="sheet-content"]');

  it('L86D-NAV01 — mobile : documents de l’élément, aucun débordement, « Détacher » ≥ 44 px, toucher → détachement du lien seul', async () => {
    await ouvrir(true, 'membre');
    const bloc = page.getByTestId('regroupement-documents-element');
    await expect(bloc.count()).resolves.toBe(1);
    const deborde = await page.getByTestId('tiroir-evenement').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(deborde).toBeLessThanOrEqual(0);
    const petits = await page.getByTestId('agenda-regroupement').evaluate((el) =>
      [...el.querySelectorAll('button')].map((b) => ({ n: b.getAttribute('aria-label') ?? b.textContent, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width }))
        .filter((b) => b.h < 44 || b.w < 44));
    expect(petits).toEqual([]);
    const bouton = page.getByRole('button', { name: 'Détacher « Facture plombier » de cet élément' });
    const b = (await bouton.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    await bouton.tap();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__l84bGestes)).toEqual(['detacher-document:12']);
    expect(await tiroirs().count()).toBe(1);
  });

  it('L86D-NAV02 — desktop : détacher au clavier ; événement de référence : « Détacher » et « Retirer de l’ensemble » distincts', async () => {
    await ouvrir(false, 'membre');
    const bouton = page.getByRole('button', { name: /^Détacher « Rapport d’expertise/ });
    await bouton.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__l84bGestes)).toEqual(['detacher-document:10']);
    const t = (await bouton.boundingBox())!;
    expect(Math.round(t.height)).toBe(32);
    await ouvrir(false, 'reference');
    await page.getByRole('button', { name: /^Détacher « Rapport d’expertise/ }).click();
    await page.getByRole('button', { name: /^Retirer « Devis réparation plafond » de l’ensemble/ }).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__l84bGestes)).toEqual(['detacher-document:10', 'retirer-document:11']);
    await expect(page.getByRole('button', { name: /^Détacher « Devis réparation plafond/ }).count()).resolves.toBe(1);
  });
});
