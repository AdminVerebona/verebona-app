/**
 * Lot 101C — « Appareils connectés » dans un sous-bloc FERMÉ par défaut
 * (retour PO du 30/10/2026 : la liste ne doit pas être visible d'emblée dans
 * le bloc Sécurité).
 *
 * Rendu RÉEL dans Chromium (playwright-core du dépôt) de la carte
 * `SecurityCard` avec la feuille de style réelle (globals.css compilée par
 * Tailwind), en desktop et en mobile tactile (même rendu que la WebView de
 * l'application). Réseau simulé : deux appareils, dont celui-ci.
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';

function chromium(): string | null {
  for (const v of [process.env.CHROMIUM_EXECUTABLE_PATH, process.env.CHROMIUM_PATH]) if (v && existsSync(v)) return v;
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    for (const exe of ['chrome-linux64/chrome', 'chrome-linux/headless_shell', 'chrome-linux/chrome']) {
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
const FIXTURES = resolve(__dirname, 'fixtures');
/** Captures facultatives : $L101C_CAPTURES (dossier). */
const CAPTURES = process.env.L101C_CAPTURES ?? '';

describe.skipIf(!EXE)('L101C — Appareils connectés : sous-bloc fermé par défaut (navigateur)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let css = '';

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(FIXTURES, 'l101c-securite-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src'), 'next/navigation': resolve(FIXTURES, 'l101c-next-navigation-stub.ts') },
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
    const sources = [
      'src/components/ui/collapsible-card.tsx', 'src/components/ui/collapsible-sub-block.tsx', 'src/components/ui/card.tsx',
      'src/components/ui/button.tsx', 'src/components/ui/badge.tsx',
      'src/components/account/security/SecurityCard.tsx', 'src/components/account/security/SignInMethodsBlock.tsx',
    ];
    const candidates = new Scanner({}).scanFiles(sources.map((f) => ({ content: readFileSync(resolve(ROOT, f), 'utf8'), extension: 'tsx' })));
    css = compiler.build(candidates);
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
    if (CAPTURES) mkdirSync(CAPTURES, { recursive: true });
  }, 180_000);
  afterAll(async () => { await ctx?.close(); await browser?.close(); });

  async function ouvrir(mobile: boolean, hash = '') {
    await ctx?.close();
    ctx = await browser.newContext(mobile
      ? { viewport: MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u === URL) {
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript', body: bundle });
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(`${URL}${hash}`);
    await page.addScriptTag({ url: `${URL}harness.js` });
    await page.evaluate(() => window.__mountSecurite());
    await page.waitForTimeout(150);
    expect(erreurs).toEqual([]);
  }

  async function capture(nom: string) {
    if (CAPTURES) await page.locator('#securite').screenshot({ path: resolve(CAPTURES, `${nom}.png`) });
  }

  const carte = () => page.getByRole('button', { name: /^Sécurité/ });
  const entete = () => page.getByRole('button', { name: /^Appareils connectés/ });
  const appelsListe = () => page.evaluate(() => window.__appels.filter((a) => a === 'GET /api/users/me/sessions').length);

  async function ouvrirCarte() {
    await carte().click();
    await entete().waitFor();
  }

  for (const mobile of [false, true]) {
    const vue = mobile ? 'mobile' : 'desktop';

    it(`L101C-01 (${vue}) — Sécurité ouverte : en-tête « Appareils connectés » + résumé, liste et boutons MASQUÉS`, async () => {
      await ouvrir(mobile);
      await ouvrirCarte();
      await expect.poll(() => entete().textContent()).toContain('2 appareils · dont celui-ci');
      expect(await entete().getAttribute('aria-expanded')).toBe('false');
      const controle = await entete().getAttribute('aria-controls');
      expect(controle).toBeTruthy();
      // La cible d'aria-controls existe, vide et masquée.
      expect(await page.locator(`[id="${controle}"]`).getAttribute('hidden')).not.toBeNull();
      expect(await page.locator(`[id="${controle}"]`).textContent()).toBe('');
      await capture(`${vue}-ferme`);
      for (const masque of ['PC Windows', 'Un appareil inconnu ?']) expect(await page.getByText(masque).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Déconnecter tous les autres appareils' }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Déconnecter', exact: true }).count()).toBe(0);
      expect(await page.getByRole('list', { name: 'Appareils connectés' }).count()).toBe(0);
      // Le titre est un vrai titre de section, le bouton est dedans (modèle accordéon).
      expect(await page.getByRole('heading', { name: /Appareils connectés/ }).count()).toBe(1);
    });

    it(`L101C-02 (${vue}) — ouverture : liste, « Déconnecter » par appareil, conseil et « tous les autres » visibles ; liste relue`, async () => {
      await ouvrir(mobile);
      await ouvrirCarte();
      await expect.poll(appelsListe).toBe(1);
      if (mobile) await entete().tap(); else await entete().click();
      expect(await entete().getAttribute('aria-expanded')).toBe('true');
      const controle = await entete().getAttribute('aria-controls');
      const zone = page.locator(`[id="${controle}"]`);
      await expect.poll(() => zone.count()).toBe(1);
      await expect.poll(() => zone.getByRole('list', { name: 'Appareils connectés' }).count()).toBe(1);
      expect(await zone.getByText('PC Windows').count()).toBe(1);
      expect(await zone.getByText('Cet appareil').count()).toBe(1);
      expect(await zone.getByText(/Un appareil inconnu \? Déconnectez-le, puis modifiez votre mot de passe\./).count()).toBe(1);
      expect(await zone.getByRole('button', { name: 'Déconnecter', exact: true }).count()).toBe(1);
      expect(await zone.getByRole('button', { name: 'Déconnecter tous les autres appareils' }).isEnabled()).toBe(true);
      await capture(`${vue}-ouvert`);
      await expect.poll(appelsListe).toBe(2); // relue à l'ouverture
      // Révocation inchangée : le bouton appelle toujours la même route.
      await zone.getByRole('button', { name: 'Déconnecter', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__appels.includes('DELETE /api/users/me/sessions/pc'))).toBe(true);
      // Refermer masque de nouveau la liste.
      await entete().click();
      expect(await entete().getAttribute('aria-expanded')).toBe('false');
      expect(await page.getByText('PC Windows').count()).toBe(0);
    });

    it(`L101C-03 (${vue}) — zone tactile ≥ 44 px, pas de débordement horizontal`, async () => {
      await ouvrir(mobile);
      await ouvrirCarte();
      const b = (await entete().boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await entete().click();
      await page.getByRole('button', { name: 'Déconnecter tous les autres appareils' }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (mobile) {
        for (const nom of ['Déconnecter', 'Déconnecter tous les autres appareils']) {
          expect((await page.getByRole('button', { name: nom, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
      }
    });

    it(`L101C-04 (${vue}) — lien …#appareils-connectes : carte ET sous-bloc ouverts, sous-bloc amené à l'écran`, async () => {
      await ouvrir(mobile, '#appareils-connectes');
      await entete().waitFor();
      await expect.poll(() => entete().getAttribute('aria-expanded')).toBe('true');
      await page.getByRole('button', { name: 'Déconnecter tous les autres appareils' }).waitFor();
      await page.waitForTimeout(900); // défilement doux
      const s = (await page.locator('#appareils-connectes').boundingBox())!;
      const h = mobile ? MOBILE.height : 800;
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThan(h / 2);
    });
  }

  it('L101C-05 — clavier : Tab jusqu’à l’en-tête, anneau de focus visible, Entrée ouvre, Espace ferme', async () => {
    await ouvrir(false);
    await ouvrirCarte();
    await entete().focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect(await entete().evaluate((el) => el === document.activeElement)).toBe(true);
    const outline = await entete().evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    expect(await entete().getAttribute('aria-expanded')).toBe('true');
    await page.getByRole('button', { name: 'Déconnecter tous les autres appareils' }).waitFor();
    await page.keyboard.press('Space');
    expect(await entete().getAttribute('aria-expanded')).toBe('false');
  });

  it('L101C-06 — état non mémorisé : fermé à chaque visite', async () => {
    await ouvrir(false);
    await ouvrirCarte();
    await entete().click();
    expect(await entete().getAttribute('aria-expanded')).toBe('true');
    await page.evaluate(() => window.__mountSecurite()); // nouvelle visite
    await ouvrirCarte();
    expect(await entete().getAttribute('aria-expanded')).toBe('false');
  });

  it('L101C-07 — ancre #securite (méthodes de connexion) : carte ouverte, sous-bloc appareils FERMÉ ; puis #appareils-connectes l’ouvre', async () => {
    await ouvrir(false, '#securite');
    await entete().waitFor();
    expect(await entete().getAttribute('aria-expanded')).toBe('false');
    await page.evaluate(() => { window.location.hash = 'appareils-connectes'; });
    await expect.poll(() => entete().getAttribute('aria-expanded')).toBe('true');
  });
});
