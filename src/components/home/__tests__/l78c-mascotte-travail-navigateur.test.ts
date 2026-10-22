/**
 * Lot 78C — retour PO du 21/10/2026 « Elle fout rien la mascotte ! » et date
 * de l'accueil — TEST NAVIGATEUR RÉEL (Chromium, `playwright-core` du dépôt),
 * desktop (1280×800) et mobile (390×844) : le VRAI `MascotSpeaks` et le VRAI
 * hook `useMascotPresentation` (harnais du lot 75E), `GET /api/home/mascot`
 * intercepté et servi par le VRAI moteur (signaux → sélection → présentation).
 *
 *  L78C-NAV-01  documents en cours d'analyse : pose « au travail » animée,
 *               texte alternatif, annonce sobre ; actualisation ciblée à la fin
 *               de l'analyse (retour à la pose habituelle), puis plus aucune
 *               relecture (aucun rafraîchissement permanent)
 *  L78C-NAV-02  mouvement réduit : pose « au travail » STATIQUE, distincte de
 *               la pose neutre
 *  L78C-NAV-03  date et salutation : « Mardi 20 octobre » / « Bonsoir » à 21:30,
 *               puis « Mercredi 21 octobre » / « Bonjour » le lendemain matin
 *               SANS rechargement (page restée ouverte), fuseau Europe/Paris
 *
 * Ignoré (skip) quand aucun Chromium n'est installé : la logique reste
 * couverte en Node (`l78c-t6-pending.test.ts`).
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContextOptions, Page } from 'playwright-core';
import type { MascotPresentation } from '@/services/home/mascot/types';

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
const STUBS = resolve(__dirname, 'fixtures/l75e-stubs.ts');
const TODAY = '2026-10-21';

const { buildCandidates } = await import('@/services/home/mascot/signals');
const { selectSubjects, buildSecondaries } = await import('@/services/home/mascot/selector');
const { buildPresentation } = await import('@/services/home/mascot/presentation');
type Raw = import('@/services/home/mascot/signals').MascotRawData;

/** Accueil du compte de la capture : 8 documents en cours d'analyse (ou aucun), un « À traiter » non prioritaire. */
function accueil(analyses: number, refreshAfterMs?: number): MascotPresentation {
  const raw = {
    accountId: 7, today: TODAY, processing: {
      uploads: [], exports: [],
      analyses: Array.from({ length: analyses }, (_, k) => ({ id: k + 1, title: k === 0 ? '2024-06-11_consignes-de-securite-et-entretien-drone.pdf' : `doc-${k + 1}.pdf`, at: `2026-10-21T14:${String(10 + k)}:00Z` })),
    },
    onboarding: { activeAssets: [{ id: 3, name: 'Drone' }], activeAssetCount: 1, documentCount: 12 },
    toProcess: [], agenda: [], acknowledgments: [], overdueAgenda: [],
  } as unknown as Raw;
  const c = buildCandidates(raw);
  const s = selectSubjects(c.candidates);
  const p = buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: TODAY, todo: { total: 1, items: [] } });
  return refreshAfterMs ? { ...p, refreshAfterMs } : p;
}

describe.skipIf(!EXE)('L78C-NAV — mascotte « au travail » et date de l’accueil (navigateur réel, desktop et mobile)', () => {
  let browser: Browser;
  let bundle = '';
  let reponses: MascotPresentation[] = [];
  let lectures = 0;

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l75e-mascotte-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
      plugins: [{
        name: 'l75e-stubs',
        setup(b) {
          b.onResolve({ filter: /^(next\/navigation|@\/components\/verebona\/space\/VerebonaSpaceProvider|@\/contexts\/WriteGuardContext)$/ }, () => ({ path: STUBS }));
        },
      }],
    });
    bundle = out.outputFiles[0].text;
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile: boolean, o: BrowserContextOptions = {}, avant?: (p: Page) => Promise<void>): Promise<Page> {
    const ctx = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } }),
      timezoneId: 'Europe/Paris', locale: 'fr-FR', ...o,
    });
    const page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = req.url();
      if (u === URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="fr"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' });
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundle });
      if (u.startsWith(`${URL}api/home/mascot`) && req.method() === 'GET' && !u.includes('/events') && !u.includes('/reminders')) {
        const r = reponses[Math.min(lectures, reponses.length - 1)];
        lectures += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(r) });
      }
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    if (avant) await avant(page);
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    expect(erreurs).toEqual([]);
    return page;
  }
  async function monter(page: Page, liste: MascotPresentation[]) {
    reponses = liste;
    lectures = 0;
    await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
    await page.locator('[data-mascot-bubble]').first().waitFor({ timeout: 10_000 });
  }
  /** La mascotte affichée à cette largeur (desktop 112 px ou mobile 72 px). */
  const mascotte = (page: Page) => page.locator('img[data-mascot-pose]:visible').first();
  const animation = (page: Page) => mascotte(page).evaluate((el) => getComputedStyle(el).animationName);

  for (const mobile of [false, true]) {
    const vue = mobile ? 'mobile' : 'desktop';

    it(`L78C-NAV-01 (${vue}) — analyse en cours : mascotte au travail animée ; fin d’analyse : pose habituelle, sans relecture permanente`, async () => {
      const page = await ouvrir(mobile);
      // 1re lecture : 8 documents en analyse (relecture ciblée suggérée) ; 2e : analyse terminée.
      await monter(page, [accueil(8, 5_000), accueil(0)]);
      await expect.poll(() => mascotte(page).getAttribute('data-mascot-pose'), { timeout: 10_000 }).toBe('document-analysis-pdf');
      expect(await page.locator('[data-mascot-bubble]').innerText()).toMatch(/8 documents sont en cours d’analyse/);
      expect(await mascotte(page).getAttribute('alt')).toBe('Verebona analyse vos documents');
      expect(await mascotte(page).getAttribute('data-mascot-working')).toBe('true');
      await expect.poll(() => animation(page)).toContain('vb-mascotte-travail');
      expect(await page.locator('[data-mascot-status]').textContent()).toBe('Verebona analyse vos documents.');
      // Actualisation ciblée (≈ 5 s) : l'analyse est terminée, la mascotte revient à sa pose habituelle.
      // (« Aucun sujet à traiter en priorité » : un élément ouvert non prioritaire → pose neutre, jamais la réussite.)
      await expect.poll(() => mascotte(page).getAttribute('data-mascot-pose'), { timeout: 12_000 }).toBe('neutral');
      expect(await mascotte(page).getAttribute('data-mascot-working')).toBeNull();
      expect(await page.locator('[data-mascot-status]').textContent()).toBe('');
      expect(lectures).toBe(2);
      // Plus aucune relecture ciblée : rien d'autre que le rafraîchissement habituel (10 min).
      await page.waitForTimeout(6_500);
      expect(lectures).toBe(2);
      await page.context().close();
    }, 60_000);

    it(`L78C-NAV-02 (${vue}) — mouvement réduit : pose « au travail » statique, distincte de la pose neutre`, async () => {
      const page = await ouvrir(mobile, { reducedMotion: 'reduce' });
      await monter(page, [accueil(3)]);
      await expect.poll(() => mascotte(page).getAttribute('data-mascot-pose'), { timeout: 10_000 }).toBe('document-analysis-pdf');
      expect(await animation(page)).toBe('none');
      expect(await mascotte(page).getAttribute('src')).toBe('/mascot/document-analysis-pdf.webp');
      await page.context().close();
    }, 60_000);

    it(`L78C-NAV-03 (${vue}) — page restée ouverte : la date et la salutation suivent le jour (Europe/Paris)`, async () => {
      const page = await ouvrir(mobile, {}, (p) => p.clock.install({ time: new Date('2026-10-20T19:30:00Z') })); // mardi 21:30 à Paris
      await monter(page, [accueil(0)]);
      const date = () => page.locator('[data-greeting-date]').innerText();
      const titre = () => page.locator('h1').innerText();
      await expect.poll(date, { timeout: 10_000 }).toBe('Mardi 20 octobre');
      expect(await titre()).toBe('Bonsoir, Fabien');
      // Mercredi 21 octobre, 8 h : la même page, jamais rechargée.
      await page.clock.fastForward('10:30:00');
      await expect.poll(date, { timeout: 10_000 }).toBe('Mercredi 21 octobre');
      expect(await titre()).toBe('Bonjour, Fabien');
      // Retour au premier plan après une veille (minuteries suspendues) : relue aussitôt.
      await page.clock.setSystemTime(new Date('2026-10-21T16:05:00Z')); // 18:05 à Paris, sans minuterie
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(titre, { timeout: 10_000 }).toBe('Bonsoir, Fabien');
      await page.context().close();
    }, 60_000);
  }
});
