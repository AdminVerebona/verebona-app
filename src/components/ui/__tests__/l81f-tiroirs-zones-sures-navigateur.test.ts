/**
 * Lot 81F — « En mobile, bouton pour quitter les tiroirs inaccessible »
 * (retour PO du 23/10/2026, capture iPhone : le « X » du tiroir document et
 * le titre passent sous l'heure et la batterie).
 *
 * Rendu RÉEL dans Chromium (playwright-core du dépôt) du composant de base
 * `@/components/ui/sheet` (et `@/components/ui/dialog`), avec la feuille de
 * style réelle (`src/app/globals.css` compilée par Tailwind). Les zones sûres
 * d'iOS sont simulées par injection de `--safe-area-inset-*` (Chromium ne sait
 * pas émuler `env(safe-area-inset-*)`) et une fausse barre d'état, posée
 * au-dessus de la page, intercepte les touchers comme sur l'iPhone.
 *
 * Captures : $L81F_CAPTURES (défaut : dossier `captures` du lot), préfixe
 * $L81F_PHASE (`avant` / `apres`).
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
const CAPTURES = process.env.L81F_CAPTURES ?? '';
const PHASE = process.env.L81F_PHASE ?? 'apres';
/** iPhone 15 : barre d'état 47 px (59 px avec l'îlot dynamique), barre d'accueil 34 px. */
const SAFE_TOP = 59;
const SAFE_BOTTOM = 34;
const MOBILE = { width: 390, height: 844 };

type Kind = 'document' | 'auto-defilant' | 'en-tete-libre' | 'dialog';

describe.skipIf(!EXE)('L81F — tiroirs mobiles : zones sûres et fermeture', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let css = '';

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l81f-sheet-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
    });
    bundle = out.outputFiles[0].text;
    // Feuille de style réelle : globals.css + utilitaires des composants rendus.
    const { compile } = await import('@tailwindcss/node');
    const { Scanner } = await import('@tailwindcss/oxide');
    const compiler = await compile(readFileSync(resolve(ROOT, 'src/app/globals.css'), 'utf8'), {
      base: resolve(ROOT, 'src/app'), onDependency: () => {},
    });
    const sources = ['src/components/ui/sheet.tsx', 'src/components/ui/dialog.tsx', 'src/components/ui/__tests__/fixtures/l81f-sheet-harness.tsx'];
    const candidates = new Scanner({}).scanFiles(sources.map((f) => ({ content: readFileSync(resolve(ROOT, f), 'utf8'), extension: 'tsx' })));
    css = compiler.build(candidates);
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
    if (CAPTURES) mkdirSync(CAPTURES, { recursive: true });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile: boolean, safe = mobile) {
    await ctx?.close();
    ctx = await browser.newContext(mobile
      ? { viewport: MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    const safeCss = safe ? `:root{--safe-area-inset-top:${SAFE_TOP}px;--safe-area-inset-bottom:${SAFE_BOTTOM}px}` : '';
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u === URL || u.startsWith(`${URL}#`)) {
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"><style>${css}</style><style>${safeCss}</style></head><body><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript', body: bundle });
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    expect(erreurs).toEqual([]);
  }

  async function monter(kind: Kind, statusBar = 0) {
    await page.evaluate(([k, s]) => window.__mountTiroir(k as Kind, { statusBar: s as number }), [kind, statusBar] as const);
    await page.waitForTimeout(650); // fin de l'animation d'ouverture (500 ms)
  }

  async function capture(nom: string) {
    if (CAPTURES) await page.screenshot({ path: resolve(CAPTURES, `${PHASE}-${nom}.png`) });
  }

  const fermer = () => page.getByRole('button', { name: 'Fermer', exact: true });

  /** Le point touché au centre du bouton atteint-il bien le bouton ? */
  async function boutonAtteignable() {
    const b = (await fermer().boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    const cible = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return el?.closest('[data-slot="sheet-close"], [data-slot="dialog-close"]') ? 'bouton' : (el?.getAttribute('data-testid') ?? el?.tagName ?? 'rien');
    }, [x, y]);
    return { b, x, y, cible };
  }

  for (const kind of ['document', 'auto-defilant', 'en-tete-libre'] as const) {
    it(`L81F-01 (${kind}) — mobile iPhone : le X est sous la zone sûre, ≥ 44×44, touchable, et ferme le tiroir`, async () => {
      await ouvrir(true);
      await monter(kind, SAFE_TOP);
      await capture(`mobile-${kind}`);
      const { b, x, y, cible } = await boutonAtteignable();
      expect(b.y).toBeGreaterThanOrEqual(SAFE_TOP);
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(cible).toBe('bouton');
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => window.__fermetures)).toBe(1);
    });

    it(`L81F-02 (${kind}) — mobile : le titre ne passe ni sous la barre d'état ni sous le X`, async () => {
      await ouvrir(true);
      await monter(kind, SAFE_TOP);
      const t = (await page.getByTestId('titre').boundingBox())!;
      const b = (await fermer().boundingBox())!;
      expect(t.y).toBeGreaterThanOrEqual(SAFE_TOP);
      const chevauchementVertical = t.y < b.y + b.height && b.y < t.y + t.height;
      if (chevauchementVertical) expect(t.x + t.width).toBeLessThanOrEqual(b.x);
    });
  }

  it('L81F-03 — mobile : la barre d\'actions en pied reste au-dessus de la barre d\'accueil', async () => {
    await ouvrir(true);
    await monter('document', SAFE_TOP);
    const p = (await page.getByTestId('pied').boundingBox())!;
    expect(p.y + p.height).toBeLessThanOrEqual(MOBILE.height - SAFE_BOTTOM);
  });

  it('L81F-04 — mobile, panneau qui défile lui-même : le X reste visible et touchable après défilement', async () => {
    await ouvrir(true);
    await monter('auto-defilant', SAFE_TOP);
    await page.locator('[data-slot="sheet-content"]').evaluate((el) => { el.scrollTop = 900; });
    await page.waitForTimeout(50);
    await capture('mobile-auto-defilant-defile');
    const { b, cible } = await boutonAtteignable();
    expect(b.y).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(cible).toBe('bouton');
  });

  it('L81F-05 — mobile : fenêtre (Dialog) haute — bord haut et X sous la zone sûre, X touchable', async () => {
    await ouvrir(true);
    await monter('dialog', SAFE_TOP);
    await capture('mobile-dialog');
    const d = (await page.locator('[data-slot="dialog-content"]').boundingBox())!;
    expect(d.y).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(d.y + d.height).toBeLessThanOrEqual(MOBILE.height - SAFE_BOTTOM);
    const { b, cible } = await boutonAtteignable();
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(cible).toBe('bouton');
  });

  it('L81F-06 — desktop sans zone sûre : aucun décalage, X au même centre qu\'avant (30 px du coin)', async () => {
    await ouvrir(false);
    await monter('document');
    await capture('desktop-document');
    const b = (await fermer().boundingBox())!;
    expect(Math.round(b.x + b.width / 2)).toBe(1280 - 30);
    expect(Math.round(b.y + b.height / 2)).toBe(30);
    const pad = await page.locator('[data-slot="sheet-content"]').evaluate((el) => getComputedStyle(el).paddingTop);
    expect(pad).toBe('0px');
    const t = (await page.getByTestId('titre').boundingBox())!;
    expect(t.y).toBeLessThan(40); // titre toujours en haut du tiroir
  });

  it('L81F-07 — Échap ferme le tiroir (desktop et mobile)', async () => {
    for (const mobile of [false, true]) {
      await ouvrir(mobile);
      await monter('document');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => window.__fermetures)).toBe(1);
    }
  });

  it('L81F-08 — mobile : le bouton retour (Android / geste retour) ferme le tiroir sans quitter la page', async () => {
    await ouvrir(true);
    await page.evaluate(() => history.pushState({ page: 'polo' }, '', '#polo'));
    await monter('document');
    await page.evaluate(() => history.back());
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__fermetures)).toBe(1);
    expect(await page.evaluate(() => location.hash)).toBe('#polo');
    expect(await page.locator('[data-slot="sheet-content"]').count()).toBe(0);
  });

  it('L81F-09 — mobile : après fermeture par le X, un seul « retour » quitte la page (pas d\'appui perdu)', async () => {
    await ouvrir(true);
    await page.evaluate(() => history.pushState({ page: 'polo' }, '', '#polo'));
    await monter('document');
    await fermer().click();
    await page.waitForTimeout(450);
    expect(await page.evaluate(() => window.__fermetures)).toBe(1);
    expect(await page.evaluate(() => location.hash)).toBe('#polo');
    await page.evaluate(() => history.back());
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => location.hash)).toBe('');
  });

  it('L81F-10 — mobile : retour pendant une fermeture interdite (analyse en cours) → le tiroir reste ouvert et le retour suivant le ferme', async () => {
    await ouvrir(true);
    await page.evaluate(() => history.pushState({ page: 'polo' }, '', '#polo'));
    await monter('document');
    await page.evaluate(() => { (window as unknown as { __bloque: boolean }).__bloque = true; });
    await page.evaluate(() => history.back());
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__fermetures)).toBe(0);
    expect(await page.locator('[data-slot="sheet-content"]').count()).toBe(1);
    await page.evaluate(() => { (window as unknown as { __bloque: boolean }).__bloque = false; });
    await page.evaluate(() => history.back());
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__fermetures)).toBe(1);
    expect(await page.evaluate(() => location.hash)).toBe('#polo');
  });

  it('L81F-11 — desktop : l\'historique du navigateur n\'est pas modifié à l\'ouverture d\'un tiroir', async () => {
    await ouvrir(false);
    const avant = await page.evaluate(() => history.length);
    await monter('document');
    expect(await page.evaluate(() => history.length)).toBe(avant);
  });
});
