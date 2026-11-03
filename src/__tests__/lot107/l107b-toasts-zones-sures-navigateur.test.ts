/**
 * Lot 107B — toasts et zones sûres, rendu RÉEL dans Chromium (playwright-core).
 *
 * Recette iOS du 02/11/2026 : le toast « Vous recevrez nos actualités »
 * s'affichait sous l'heure / la batterie et sur « Demander à Verebona ».
 * Le harnais monte le vrai `AppToaster` (sonner + ses styles) sur une coquille
 * aux classes de `DashboardLayout`, avec la vraie feuille de style
 * (`globals.css` compilée par Tailwind). Les encarts iOS sont simulés par
 * `--safe-area-inset-*` (Chromium n'émule pas `env()`), comme au lot 81F.
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';

function chromium(): string | null {
  for (const v of [process.env.CHROMIUM_EXECUTABLE_PATH, process.env.CHROMIUM_PATH]) {
    if (v && existsSync(v)) return v;
  }
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    for (const exe of ['chrome-linux/headless_shell', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = resolve(base, d, exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const EXE = chromium();
const ROOT = resolve(__dirname, '../../..');
const URL = 'http://verebona.test/';
const HARNESS = resolve(__dirname, 'fixtures/l107b-toast-harness.tsx');

interface Insets { top: number; bottom: number; left?: number; right?: number }
/** iPhone 15 Pro (îlot dynamique) : 59 px en haut, 34 px en bas. */
const PORTRAIT = { viewport: { width: 393, height: 852 }, insets: { top: 59, bottom: 34 } };
/** iPhone SE (sans encoche) : barre d'état de 20 px. */
const SE = { viewport: { width: 375, height: 667 }, insets: { top: 20, bottom: 0 } };
/** iPhone 15 Pro en paysage : encoche à gauche ou à droite, pas de barre d'état. */
const PAYSAGE = { viewport: { width: 852, height: 393 }, insets: { top: 0, bottom: 21, left: 59, right: 59 } };
/** iPad (≥ 768 px) : barre d'état de 24 px, en-tête de bureau. */
const IPAD = { viewport: { width: 1024, height: 768 }, insets: { top: 24, bottom: 20 } };

describe.skipIf(!EXE)('L107B — toasts : jamais sous la barre d’état ni sur « Demander à Verebona »', () => {
  let browser: Browser;
  let ctx: BrowserContext | undefined;
  let page: Page;
  let bundle = '';
  let css = '';

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [HARNESS],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
    });
    bundle = out.outputFiles[0].text;
    const { compile } = await import('@tailwindcss/node');
    const { Scanner } = await import('@tailwindcss/oxide');
    const compiler = await compile(readFileSync(resolve(ROOT, 'src/app/globals.css'), 'utf8'), {
      base: resolve(ROOT, 'src/app'), onDependency: () => {},
    });
    const sources = [HARNESS, resolve(ROOT, 'src/components/AppToaster.tsx')];
    const candidates = new Scanner({}).scanFiles(sources.map((f) => ({ content: readFileSync(f, 'utf8'), extension: 'tsx' })));
    css = compiler.build(candidates);
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 180_000);
  afterAll(async () => { await ctx?.close(); await browser?.close(); });

  async function ouvrir(viewport: { width: number; height: number }, insets: Insets) {
    await ctx?.close();
    ctx = await browser.newContext({ viewport, isMobile: viewport.width < 768, hasTouch: true, deviceScaleFactor: 2 });
    page = await ctx.newPage();
    const safeCss = `:root{--safe-area-inset-top:${insets.top}px;--safe-area-inset-bottom:${insets.bottom}px;--safe-area-inset-left:${insets.left ?? 0}px;--safe-area-inset-right:${insets.right ?? 0}px}`;
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u === URL) {
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style><style>${safeCss}</style></head><body><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript', body: bundle });
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    await page.evaluate(() => window.__mountShell());
    await page.evaluate(() => window.__toast('Réglage non enregistré. Réessayez.'));
    await page.waitForSelector('[data-sonner-toast][data-mounted="true"]');
    await page.waitForTimeout(500); // fin de l'animation d'entrée (400 ms)
    expect(erreurs).toEqual([]);
  }

  const boite = async (sel: string) => (await page.locator(sel).first().boundingBox())!;

  it('L107B-T1 — iPhone îlot dynamique (portrait) : toast sous l’encart haut ET sous le champ Assistant', async () => {
    await ouvrir(PORTRAIT.viewport, PORTRAIT.insets);
    const t = await boite('[data-sonner-toast]');
    const barre = await boite('[data-testid="mobile-topbar"]');
    const champ = await boite('[data-testid="mobile-field"]');
    expect(champ.y).toBeGreaterThanOrEqual(PORTRAIT.insets.top); // le champ lui-même n'est pas sous l'heure
    expect(t.y).toBeGreaterThanOrEqual(PORTRAIT.insets.top);
    expect(t.y).toBeGreaterThanOrEqual(barre.y + barre.height); // ne recouvre ni le champ ni l'avatar
    // Pas d'espace excessif : juste sous la barre haute (8 px de respiration).
    expect(t.y - (barre.y + barre.height)).toBeLessThanOrEqual(12);
    // Le champ reste touchable au centre.
    const cible = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="mobile-field"]') ? 'champ' : 'autre',
      [champ.x + champ.width / 2, champ.y + champ.height / 2]);
    expect(cible).toBe('champ');
  });

  it('L107B-T2 — iPhone SE : même règle, sans valeur propre au modèle', async () => {
    await ouvrir(SE.viewport, SE.insets);
    const t = await boite('[data-sonner-toast]');
    const barre = await boite('[data-testid="mobile-topbar"]');
    expect(barre.y).toBe(0);
    expect(t.y).toBeGreaterThanOrEqual(barre.y + barre.height);
    expect(t.y - (barre.y + barre.height)).toBeLessThanOrEqual(12);
  });

  it('L107B-T3 — paysage (encoche latérale) : toast et en-tête hors des encarts latéraux', async () => {
    await ouvrir(PAYSAGE.viewport, PAYSAGE.insets);
    const t = await boite('[data-sonner-toast]');
    const entete = await boite('[data-testid="desktop-topbar"]');
    expect(entete.x).toBeGreaterThanOrEqual(PAYSAGE.insets.left!);
    expect(entete.x + entete.width).toBeLessThanOrEqual(PAYSAGE.viewport.width - PAYSAGE.insets.right! + 0.5);
    expect(t.x).toBeGreaterThanOrEqual(PAYSAGE.insets.left!);
    expect(t.x + t.width).toBeLessThanOrEqual(PAYSAGE.viewport.width - PAYSAGE.insets.right!);
    expect(t.y).toBeGreaterThanOrEqual(entete.y + entete.height);
  });

  it('L107B-T4 — iPad / ordinateur : en-tête sous la barre d’état, toast sous l’en-tête (encart compté une seule fois)', async () => {
    await ouvrir(IPAD.viewport, IPAD.insets);
    const t = await boite('[data-sonner-toast]');
    const entete = await boite('[data-testid="desktop-topbar"]');
    expect(entete.y).toBe(IPAD.insets.top);
    expect(entete.height).toBe(60);
    expect(t.y).toBeGreaterThanOrEqual(entete.y + entete.height);
    expect(t.y - (entete.y + entete.height)).toBeLessThanOrEqual(12);
  });

  it('L107B-T5 — navigateur de bureau sans encart : aucun décalage parasite', async () => {
    await ouvrir({ width: 1280, height: 800 }, { top: 0, bottom: 0 });
    const entete = await boite('[data-testid="desktop-topbar"]');
    const t = await boite('[data-sonner-toast]');
    expect(entete.y).toBe(0);
    expect(t.y).toBeGreaterThanOrEqual(60);
    expect(t.y).toBeLessThanOrEqual(72);
  });
});
