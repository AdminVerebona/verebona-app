/**
 * Lot 108J — CONTRÔLE VISUEL dans un vrai navigateur (Chromium,
 * `playwright-core` du dépôt) : le VRAI `MascotSpeaks` et le VRAI magasin des
 * suggestions partagées, empaquetés par esbuild, avec la feuille de style
 * RÉELLE de l'application (Tailwind compilé depuis `globals.css`, charte
 * Sérénité). `GET /api/home/mascot` et `GET /api/suggestions` sont
 * interceptés.
 *
 *  L108J-NAV-01  RETIRÉ au lot 110C (décision PO du 04/11/2026 : plus de
 *                suggestions sur l'accueil mobile) — remplacé par
 *                L110C-NAV-02/03 (`l110c-suggestions-accueil-navigateur.test.ts`) ;
 *  L108J-NAV-02  ordinateur : présentation compacte, sans débordement ;
 *  L108J-NAV-03  clic : vraie question posée avec sa référence, remplacement
 *                immédiat par la réserve, aucune relecture, aucun
 *                « Autre suggestion » ;
 *  L108J-NAV-04  bulle en panne : les suggestions restent affichées.
 * Lot 110C : NAV-03 et NAV-04 passent sur ordinateur (1280 px), seul support
 * de l'accueil qui montre encore les suggestions ; règles #657 inchangées.
 * Captures : dossier `L108J_SCREENSHOTS_DIR` s'il est défini.
 *
 * Ignoré (skip) quand aucun Chromium n'est installé.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import type { MascotPresentation } from '@/services/home/mascot/types';

function chromium(): string | null {
  for (const p of [process.env.CHROMIUM_EXECUTABLE_PATH, process.env.CHROMIUM_PATH]) if (p && existsSync(p)) return p;
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
const STUBS = resolve(__dirname, 'fixtures/l108j-stubs.ts');
const SHOTS = process.env.L108J_SCREENSHOTS_DIR ?? null;
const TODAY = '2026-11-03';

const { buildCandidates } = await import('@/services/home/mascot/signals');
const { selectSubjects, buildSecondaries } = await import('@/services/home/mascot/selector');
const { buildPresentation } = await import('@/services/home/mascot/presentation');
type Raw = import('@/services/home/mascot/signals').MascotRawData;

/** Bulle d'un compte avec un bien sans document (étape d'accueil). */
function bulle(): MascotPresentation {
  const raw = {
    accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: [{ id: 3, name: 'Maison de famille' }], activeAssetCount: 1, documentCount: 0 },
    toProcess: [], agenda: [], acknowledgments: [], overdueAgenda: [],
  } as unknown as Raw;
  const c = buildCandidates(raw);
  const s = selectSubjects(c.candidates);
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: TODAY, todo: { total: 0, items: [] } });
}

const SELECTION = {
  contract: 'shared-suggestions-v1', version: 'a1b2c3d4e5f60718', generatedAt: '2026-11-03T10:00:00.000Z',
  items: [
    // Lot 111L : libellé long d'une question réellement servie (une liste « Quels sont les documents de… » ne l'est plus).
    { id: 'acc_assets_deadlines', label: 'Quelles sont les prochaines échéances de Maison de famille à Saint-Jean-de-Luz ?', objective: 'ANTICIPATE', source: 'ACCOUNT_DATA', assetId: 3 },
    { id: 'guide_detected_deadlines', label: 'Comment les échéances sont-elles détectées dans les documents ?', objective: 'GUIDE', source: 'HELP_CENTER' },
    { id: 'res_works_invoices', label: 'Quels documents conserver après des travaux dans un logement ?', objective: 'GUIDE', source: 'RESOURCES' },
  ],
  reserve: [
    { id: 'res_car_service', label: 'Quand faire la révision d’une voiture ?', objective: 'GUIDE', source: 'RESOURCES' },
    { id: 'guide_agenda_sync', label: 'Comment synchroniser mon agenda ?', objective: 'GUIDE', source: 'HELP_CENTER' },
  ],
};

describe.skipIf(!EXE)('L108J-NAV — suggestions partagées dans un vrai navigateur', () => {
  let browser: Browser;
  let bundle = '';
  let css = '';
  let lecturesSuggestions = 0;
  let mascotteEnPanne = false;

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l108j-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
      plugins: [{
        name: 'l108j-stubs',
        setup(b) {
          b.onResolve({ filter: /^(next\/navigation|@\/components\/verebona\/space\/VerebonaSpaceProvider|@\/contexts\/WriteGuardContext)$/ }, () => ({ path: STUBS }));
        },
      }],
    });
    bundle = out.outputFiles[0].text;
    // Feuille de style RÉELLE : Tailwind v4 compilé depuis globals.css (sources du dépôt).
    const postcss = (await import('postcss')).default;
    const tailwind = (await import('@tailwindcss/postcss')).default;
    const from = resolve(ROOT, 'src/app/globals.css');
    css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(from, 'utf8'), { from })).css;
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(width: number, mobile: boolean): Promise<Page> {
    const ctx = await browser.newContext(mobile ? { viewport: { width, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    lecturesSuggestions = 0;
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = req.url();
      if (u === URL) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="fr" data-theme="beige"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="background:var(--bg-page);font-family:system-ui,sans-serif"><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundle });
      if (u.startsWith(`${URL}api/suggestions`)) { lecturesSuggestions += 1; return route.fulfill({ contentType: 'application/json', body: JSON.stringify(SELECTION) }); }
      if (u.startsWith(`${URL}api/home/mascot`) && req.method() === 'GET' && !u.includes('/events') && !u.includes('/reminders')) {
        return mascotteEnPanne ? route.fulfill({ status: 500, body: '{}' }) : route.fulfill({ contentType: 'application/json', body: JSON.stringify(bulle()) });
      }
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
    await page.locator('[data-home-suggestions] button').first().waitFor({ timeout: 10_000 });
    expect(erreurs).toEqual([]);
    return page;
  }

  /** Mesures de la zone : boutons, textes, débordements, position par rapport à la bulle. */
  const mesurer = (page: Page) => page.evaluate(() => {
    const zone = document.querySelector('[data-home-suggestions]')!.getBoundingClientRect();
    const bulle = document.querySelector('[data-mascot-bubble]')?.getBoundingClientRect() ?? null;
    const boutons = [...document.querySelectorAll('[data-home-suggestions] button')].map((b) => {
      const r = b.getBoundingClientRect();
      const t = b.querySelector('span:last-child') as HTMLElement;
      return { top: r.top, left: r.left, width: r.width, height: r.height, texte: (b.textContent ?? '').trim(), coupe: t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1 };
    });
    return {
      zone: { left: zone.left, width: zone.width, top: zone.top }, bulleBas: bulle ? bulle.bottom : null,
      boutons, scrollX: document.documentElement.scrollWidth - window.innerWidth,
      autre: /Autre suggestion/.test(document.body.innerText) || !!document.querySelector('[aria-label="Autre suggestion"]'),
    };
  });

  // L108J-NAV-01 (mobile, trois boutons empilés) : retiré au lot 110C — voir L110C-NAV-02.

  it('L108J-NAV-02 (ordinateur 1280 px) — cartes compactes sous la bulle, aucun débordement (lot 110C : une rangée)', async () => {
    const page = await ouvrir(1280, false);
    const m = await mesurer(page);
    expect(m.boutons).toHaveLength(3);
    expect(m.scrollX).toBeLessThanOrEqual(0);
    for (const b of m.boutons) { expect(b.height).toBeGreaterThanOrEqual(44); expect(b.coupe).toBe(false); expect(b.width).toBeLessThan(m.zone.width + 1); expect(Math.abs(b.top - m.boutons[0].top)).toBeLessThan(1); }
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'l108j-accueil-1280.png') });
    await page.context().close();
  });

  it('L108J-NAV-03 — clic : vraie question avec sa référence ; remplacement immédiat par la réserve, sans relecture', async () => {
    const page = await ouvrir(1280, false);
    expect(lecturesSuggestions).toBe(1);
    await page.locator('[data-home-suggestions] button').nth(1).click();
    const asks = await page.evaluate(() => (window as unknown as { __asks: Array<{ question: string; context?: Record<string, string> }> }).__asks);
    expect(asks).toEqual([{ question: SELECTION.items[1].label, context: { suggestionId: SELECTION.items[1].id, suggestionVersion: SELECTION.version } }]);
    const apres = (await mesurer(page)).boutons.map((b) => b.texte.replace(/^›/, ''));
    expect(apres).toEqual([SELECTION.items[0].label, SELECTION.reserve[0].label, SELECTION.items[2].label]);
    expect(lecturesSuggestions).toBe(1);
    await page.context().close();
  });

  it('L108J-NAV-04 — prise de parole de la mascotte en panne : les trois suggestions restent affichées', async () => {
    mascotteEnPanne = true;
    try {
      const page = await ouvrir(1280, false);
      expect((await mesurer(page)).boutons).toHaveLength(3);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, 'l108j-accueil-1280-bulle-en-panne.png'), fullPage: true });
      await page.context().close();
    } finally { mascotteEnPanne = false; }
  });
});
