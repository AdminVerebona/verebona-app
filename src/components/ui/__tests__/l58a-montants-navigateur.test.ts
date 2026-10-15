/**
 * Lot 58A — BUG P1 « troncature des montants » : saisie RÉELLE au clavier
 * dans Chromium (playwright-core du dépôt, aucun paquet ajouté).
 *
 * Les VRAIS composants (`AssetDetailSection` + `NumberInput`) sont empaquetés
 * par esbuild et montés dans une page ; la requête PATCH de la fiche est
 * interceptée pour lire le corps réellement envoyé.
 *
 * Cause prouvée (lot 57) : `NumberInput.handleChange` redéfinissait
 * `e.target.value` par `Object.defineProperty` ; cette propriété propre
 * remplaçait le suivi de valeur installé par React sur l'élément, qui ne
 * voyait plus aucun changement : seul le PREMIER événement de saisie
 * atteignait le formulaire (« 20000 » tapé → 2 enregistré, « 20 » collé puis
 * « 000 » tapé → 20). Ce test échoue sur le composant du lot 57.
 *
 * Ignoré (skip) quand aucun Chromium n'est installé (CI) : la logique est
 * aussi couverte en Node par `l58a-number-input.test.ts`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';

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

describe.skipIf(!EXE)('L58A — saisie des montants dans un vrai navigateur', () => {
  let browser: Browser;
  let page: Page;
  let bundle = '';
  const patches: unknown[] = [];

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l58a-number-input-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      // Modules partagés qui lisent `process.env.*` (variables publiques absentes ici).
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
    });
    bundle = out.outputFiles[0].text;
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile = false) {
    const ctx = await browser.newContext(mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (req.url() === URL) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' });
      if (req.url() === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (req.method() === 'PATCH') {
        patches.push(req.postDataJSON());
        return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    expect(erreurs).toEqual([]);
  }

  async function fiche(data: Record<string, unknown> = {}) {
    patches.length = 0;
    await page.evaluate((d) => window.__mount('fiche', d), data);
    // 1er champ numérique de la section (localisateur indépendant du correctif).
    return page.locator('input[inputmode="decimal"]').first();
  }
  async function enregistrer() {
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForTimeout(80);
  }
  async function saisir(input: ReturnType<Page['locator']>, texte: string, mode: 'lent' | 'rapide' | 'collage') {
    await input.click();
    if (mode === 'collage') {
      await input.evaluate((el, t) => { (el as HTMLInputElement).focus(); document.execCommand('insertText', false, t); }, texte);
    } else {
      await input.pressSequentially(texte, { delay: mode === 'lent' ? 40 : 0 });
    }
  }

  const CAS: [string, string, number][] = [
    ['MONTANT-01', '20', 20],
    ['MONTANT-02', '200', 200],
    ['MONTANT-03', '1250', 1250],
    ['MONTANT-04', '12500', 12500],
    ['MONTANT-05', '125000', 125000],
    ['MONTANT-06', '12500,50', 12500.5],
    ['MONTANT-07', '12 500,50', 12500.5],
    ['MONTANT-08', '0', 0],
  ];

  it('MONTANT-01 à 08 — fiche (desktop) : frappe lente, rapide, collage → texte intact et PATCH exact', async () => {
    await ouvrir();
    for (const [id, texte, attendu] of CAS) {
      for (const mode of ['lent', 'rapide', 'collage'] as const) {
        const input = await fiche({ acquisitionPrice: null });
        await saisir(input, texte, mode);
        expect(await input.inputValue(), `${id} ${mode} affichage`).toBe(texte);
        await enregistrer();
        expect(patches, `${id} ${mode} envoi`).toEqual([{ fields: { acquisitionPrice: attendu } }]);
      }
    }
  }, 180_000);

  it('MONTANT-09 — effacement puis ressaisie, correction de chiffres, valeur existante modifiée', async () => {
    // Effacement complet puis nouvelle saisie.
    let input = await fiche({ acquisitionPrice: 20 });
    expect(await input.inputValue()).toBe('20');
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.press('Backspace');
    expect(await input.inputValue()).toBe('');
    await input.pressSequentially('12500');
    await enregistrer();
    expect(patches).toEqual([{ fields: { acquisitionPrice: 12500 } }]);

    // Correction : « 12600 » → 3 retours arrière → « 500 ».
    input = await fiche({ acquisitionPrice: null });
    await input.click();
    await input.pressSequentially('12600');
    for (let i = 0; i < 3; i++) await input.press('Backspace');
    await input.pressSequentially('500,5');
    expect(await input.inputValue()).toBe('12500,5');
    await enregistrer();
    expect(patches).toEqual([{ fields: { acquisitionPrice: 12500.5 } }]);

    // Cas signalé : valeur « 2 » existante, on complète à la fin → 20 000.
    input = await fiche({ acquisitionPrice: 2 });
    await input.click();
    await input.press('End');
    await input.pressSequentially('0000');
    await enregistrer();
    expect(patches).toEqual([{ fields: { acquisitionPrice: 20000 } }]);

    // Effacement seul : la valeur est vidée (null), pas mise à 0.
    input = await fiche({ acquisitionPrice: 1250 });
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.press('Backspace');
    await enregistrer();
    expect(patches).toEqual([{ fields: { acquisitionPrice: null } }]);
  }, 60_000);

  it('MONTANT-10 — saisie invalide ou ambiguë : message explicite, AUCUN envoi', async () => {
    for (const texte of ['20.000', '12 50', '12a', '1.234,56', '12500,', '-5', '12,345']) {
      const input = await fiche({ acquisitionPrice: 900 });
      await input.click();
      await input.press('ControlOrMeta+a');
      await input.pressSequentially(texte);
      await enregistrer();
      expect(patches, texte).toEqual([]);
      expect(await page.getByRole('alert').first().textContent(), texte).toMatch(/\S/);
      expect(await input.getAttribute('aria-invalid')).toBe('true');
    }
  }, 60_000);

  it('MONTANT-11 — champ non monétaire (kilométrage) du même composant', async () => {
    await fiche({ acquisitionPrice: 1000 });
    const km = page.locator('input[inputmode="decimal"]').nth(1);
    await km.click();
    await km.pressSequentially('125 000');
    await enregistrer();
    expect(patches).toEqual([{ fields: { mileage: 125000 } }]);
  }, 30_000);

  it('MONTANT-12 — formulaire texte (création / documents / forfaits) : centimes exacts', async () => {
    for (const [, texte, attendu] of CAS) {
      await page.evaluate(() => window.__mount('texte'));
      const input = page.getByTestId('texte');
      await input.click();
      await input.pressSequentially(texte);
      await page.getByRole('button', { name: 'Valider' }).click();
      expect(JSON.parse((await page.getByTestId('envoye').textContent())!)).toEqual({ ok: true, cents: Math.round(attendu * 100) });
    }
  }, 60_000);

  it('MONTANT-13 — mobile (390 px, tactile) : même saisie, même envoi', async () => {
    await ouvrir(true);
    for (const [, texte, attendu] of CAS.filter(([id]) => ['MONTANT-04', 'MONTANT-07'].includes(id))) {
      const input = await fiche({ acquisitionPrice: null });
      await input.tap();
      await input.pressSequentially(texte);
      expect(await input.inputValue()).toBe(texte);
      await enregistrer();
      expect(patches).toEqual([{ fields: { acquisitionPrice: attendu } }]);
    }
  }, 60_000);
});
