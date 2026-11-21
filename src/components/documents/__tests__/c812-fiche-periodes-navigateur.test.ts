/**
 * Carte #812 (reprise après la recette KO du 21/11/2026) — la fiche d'un document dans un NAVIGATEUR RÉEL
 * (Chromium du dépôt), gabarit MOBILE (iPhone 390 × 844) et ordinateur : la ligne « Début de validité »
 * n'est pas rendue quand l'API ne la restitue pas, et AUCUN cache du client ne continue à servir
 * l'ancienne valeur. VRAIS composants (`useDocumentPeriods`, `DocumentBusinessPeriodField`,
 * `DocumentPeriodsDetail`) et VRAI client d'API ; seule la réponse du serveur est servie par le test.
 *
 *   C812-NAV01  mobile : l'API ne restitue plus la validité (bon de commande Decathlon, garantie conservée)
 *               → « Période de garantie » affichée, aucune ligne « Début de validité », aucun bouton
 *               « Corriger », rien ne déborde ;
 *   C812-NAV02  mobile : l'API ne restitue aucune période → aucun bloc de période, « Date du document » intacte ;
 *   C812-NAV03  mobile : aucun cache client — l'ancienne réponse (avec la validité) puis la nouvelle (sans) :
 *               à la réouverture du tiroir comme au signal de rafraîchissement, la ligne disparaît ; chaque
 *               lecture va au réseau ;
 *   C812-NAV04  ordinateur : même rendu.
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
    for (const exe of ['chrome-linux/headless_shell', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
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
const DOC = 7;

type Vue = Record<string, unknown>;
const ligne = (id: number, kind: string, line: string, start: string | null, end: string | null) => ({ id, kind, segment: 0, start, end, line, userCorrected: false });
const GARANTIE = ligne(31, 'WARRANTY', 'Période de garantie : du 17/11/2026 au 17/11/2028', '2026-11-17', '2028-11-17');
const VALIDITE = ligne(30, 'VALIDITY', 'Début de validité : 17/11/2026', '2026-11-17', null);
/** Ce que l'API rendait AVANT le correctif (capture du PO) : la validité d'un jour en période principale. */
const AVANT: Vue = { documentId: DOC, principal: { kind: 'VALIDITY', line: VALIDITE.line, segments: [VALIDITE] }, secondary: [GARANTIE], coverageHistories: [] };
/** Ce qu'elle rend APRÈS : la garantie seule. */
const APRES: Vue = { documentId: DOC, principal: { kind: 'WARRANTY', line: GARANTIE.line, segments: [GARANTIE] }, secondary: [], coverageHistories: [] };
const RIEN: Vue = { documentId: DOC, principal: null, secondary: [], coverageHistories: [] };

describe.skipIf(!EXE)('C812 — fiche du document : pas de ligne « Début de validité » quand l’API ne la restitue pas (navigateur réel)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let css = '';
  /** Réponse courante du serveur simulé et nombre de lectures réseau de la route. */
  let reponse: Vue = RIEN;
  let lectures = 0;

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/c812-fiche-periodes-harness.tsx')],
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
    const sources = ['src/components/ui/button.tsx', 'src/components/ui/input.tsx', 'src/components/documents/BusinessPeriods.tsx', 'src/components/documents/__tests__/fixtures/c812-fiche-periodes-harness.tsx'];
    css = compiler.build(new Scanner({}).scanFiles(sources.map((f) => ({ content: readFileSync(resolve(ROOT, f), 'utf8'), extension: 'tsx' }))));
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile: boolean, vue: Vue) {
    await ctx?.close();
    reponse = vue;
    lectures = 0;
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
      if (u.startsWith(`${URL}api/documents/${DOC}/periodes`) && route.request().method() === 'GET') {
        lectures += 1;
        // Mêmes en-têtes que la route réelle.
        return route.fulfill({ contentType: 'application/json', headers: { 'Cache-Control': 'private, no-cache' }, body: JSON.stringify({ periods: reponse }) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    await monter();
    expect(erreurs).toEqual([]);
  }
  const monter = async () => { await page.evaluate((id) => window.__812Monter(id), DOC); await page.waitForTimeout(400); };
  const texte = () => page.getByTestId('fiche-document').innerText();
  const deborde = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));

  it('C812-NAV01 — mobile : l’API ne restitue plus la validité → garantie affichée, aucune ligne « Début de validité », aucun « Corriger »', async () => {
    await ouvrir(true, APRES);
    const t = await texte();
    expect(t).toContain('Date du document');
    expect(t).toContain('Période de garantie : du 17/11/2026 au 17/11/2028');
    expect(t).not.toMatch(/validité/i);
    expect(await page.getByTestId('business-period-principal').count()).toBe(1);
    expect(await page.getByTestId('document-periods-detail').count()).toBe(0);
    // Carte #782 : aucune action sur la ligne du tiroir (ni « Corriger », ni « Modifier »).
    expect(await page.getByTestId('fiche-document').locator('button').count()).toBe(0);
    expect(await deborde()).toBe(0);
    expect(lectures).toBe(1);
  });

  it('C812-NAV02 — mobile : l’API ne restitue aucune période → aucun bloc de période, « Date du document » intacte', async () => {
    await ouvrir(true, RIEN);
    expect(await page.getByTestId('document-business-periods').count()).toBe(0);
    expect(await page.getByTestId('document-periods-detail').count()).toBe(0);
    expect(await page.getByTestId('business-period-row').count()).toBe(0);
    const t = await texte();
    expect(t).toContain('Date du document');
    expect(t).toContain('17 novembre 2026');
    expect(t).not.toMatch(/validité|Période/i);
  });

  it('C812-NAV03 — mobile : aucun cache client — l’ancienne valeur n’est jamais resservie (réouverture du tiroir, signal de rafraîchissement)', async () => {
    // Témoin : quand l'API restitue la validité (état d'AVANT), le composant l'affiche — il rend ce que le serveur rend.
    await ouvrir(true, AVANT);
    expect(await texte()).toContain('Début de validité : 17/11/2026');
    expect(lectures).toBe(1);
    // Le serveur ne la restitue plus. Réouverture du tiroir (nouveau montage), SANS recharger la page.
    reponse = APRES;
    await page.evaluate(() => window.__812Fermer());
    await monter();
    expect(lectures).toBe(2);
    let t = await texte();
    expect(t).not.toMatch(/validité/i);
    expect(t).toContain('Période de garantie : du 17/11/2026 au 17/11/2028');
    // Tiroir resté OUVERT : le signal de rafraîchissement de l'application relit le serveur.
    reponse = AVANT;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('business-periods-mutated', { detail: { fileId: 7 } })));
    await page.waitForTimeout(400);
    expect(lectures).toBe(3);
    expect(await texte()).toContain('Début de validité : 17/11/2026');
    reponse = RIEN;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('business-periods-mutated', { detail: { fileId: 7 } })));
    await page.waitForTimeout(400);
    expect(lectures).toBe(4);
    t = await texte();
    expect(t).not.toMatch(/validité|garantie/i);
    // Rien n'est gardé dans le navigateur pour cette lecture (ni stockage local, ni stockage de session, ni Cache API).
    const stocke = await page.evaluate(async () => ({
      local: Object.keys(localStorage).filter((k) => /period/i.test(k) || /period/i.test(localStorage.getItem(k) ?? '')),
      session: Object.keys(sessionStorage).filter((k) => /period/i.test(k) || /period/i.test(sessionStorage.getItem(k) ?? '')),
      caches: 'caches' in window ? await caches.keys() : [],
    }));
    expect(stocke).toEqual({ local: [], session: [], caches: [] });
  });

  it('C812-NAV04 — ordinateur : même rendu (garantie affichée, aucune ligne de validité)', async () => {
    await ouvrir(false, APRES);
    const t = await texte();
    expect(t).toContain('Période de garantie : du 17/11/2026 au 17/11/2028');
    expect(t).not.toMatch(/validité/i);
    expect(await deborde()).toBe(0);
  });
});
