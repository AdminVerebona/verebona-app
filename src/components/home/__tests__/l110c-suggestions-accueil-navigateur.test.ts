/**
 * Lot 110C — suggestions de l'accueil selon le support, CONTRÔLE dans un
 * vrai navigateur (Chromium, `playwright-core` du dépôt) : le VRAI
 * `MascotSpeaks`, la VRAIE règle d'emplacement, le VRAI magasin des
 * suggestions partagées et l'état initial RÉEL de « Demander à Verebona »,
 * empaquetés par esbuild, avec la feuille de style RÉELLE (Tailwind compilé
 * depuis `globals.css`). `GET /api/home/mascot` et `GET /api/suggestions`
 * sont interceptés et COMPTÉS.
 *
 *  L110C-NAV-01  ordinateur 1440 px : au plus trois cartes sur UNE rangée,
 *                même hauteur de ligne, aucun débordement, texte non rogné,
 *                ≥ 44 px, sous la bulle ;
 *  L110C-NAV-02  mobile 390 px : aucune zone, aucun espace réservé, AUCUNE
 *                lecture de GET /api/suggestions (même après un événement de
 *                données) ;
 *  L110C-NAV-03  application iOS / Android (coque Capacitor) en 1024 px :
 *                aucune zone, aucune lecture ;
 *  L110C-NAV-04  transitions de largeur (1440 → 390 → 767 → 768 → 1024 →
 *                1440) : rangée unique ou absence, jamais de chevauchement ;
 *  L110C-NAV-05  clic (ordinateur) : vraie question avec intention et
 *                contexte (#657), remplacement par la réserve, sans relecture ;
 *  L110C-NAV-06  « Demander à Verebona » sur mobile 390 px : les trois
 *                suggestions à l'ouverture (une lecture), cliquables ;
 *  L110C-NAV-07  grande police (ordinateur) : toujours une rangée, rien rogné.
 * Captures : dossier `L110C_SCREENSHOTS_DIR` s'il est défini.
 *
 * Ignoré (skip) quand aucun Chromium n'est installé.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContextOptions, Page } from 'playwright-core';
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
const STUBS = resolve(__dirname, 'fixtures/l110c-stubs.ts');
const SHOTS = process.env.L110C_SCREENSHOTS_DIR ?? null;
const TODAY = '2026-11-04';

const { buildCandidates } = await import('@/services/home/mascot/signals');
const { selectSubjects, buildSecondaries } = await import('@/services/home/mascot/selector');
const { buildPresentation } = await import('@/services/home/mascot/presentation');
type Raw = import('@/services/home/mascot/signals').MascotRawData;

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
  contract: 'shared-suggestions-v1', version: 'a1b2c3d4e5f60718', generatedAt: '2026-11-04T10:00:00.000Z',
  items: [
    { id: 'acc_home_asset_docs', label: 'Quels sont les documents de Maison de famille à Saint-Jean-de-Luz ?', objective: 'EXPLOIT', source: 'ACCOUNT_DATA', assetId: 3 },
    { id: 'guide_detected_deadlines', label: 'Comment les échéances sont-elles détectées dans les documents ?', objective: 'GUIDE', source: 'HELP_CENTER' },
    { id: 'res_works_invoices', label: 'Quels documents conserver après des travaux dans un logement ?', objective: 'GUIDE', source: 'RESOURCES' },
  ],
  reserve: [
    { id: 'res_car_service', label: 'Quand faire la révision d’une voiture ?', objective: 'GUIDE', source: 'RESOURCES' },
    { id: 'guide_agenda_sync', label: 'Comment synchroniser mon agenda ?', objective: 'GUIDE', source: 'HELP_CENTER' },
  ],
};

const MOBILE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = (width: number): BrowserContextOptions => ({ viewport: { width, height: 900 } });

describe.skipIf(!EXE)('L110C-NAV — suggestions de l’accueil selon le support (vrai navigateur)', () => {
  let browser: Browser;
  let bundle = '';
  let css = '';
  let lectures = 0;

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l110c-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
      plugins: [{
        name: 'l110c-stubs',
        setup(b) {
          b.onResolve({ filter: /^(next\/navigation|@\/components\/verebona\/space\/VerebonaSpaceProvider|\.\/VerebonaSpaceProvider|@\/contexts\/WriteGuardContext)$/ }, () => ({ path: STUBS }));
        },
      }],
    });
    bundle = out.outputFiles[0].text;
    const postcss = (await import('postcss')).default;
    const tailwind = (await import('@tailwindcss/postcss')).default;
    const from = resolve(ROOT, 'src/app/globals.css');
    css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(from, 'utf8'), { from })).css;
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(opts: BrowserContextOptions, monter: 'home' | 't2' = 'home', native = false): Promise<Page> {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    lectures = 0;
    if (native) await page.addInitScript(() => { (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} }; });
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = req.url();
      if (u === URL) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="fr" data-theme="beige"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="background:var(--bg-page);font-family:system-ui,sans-serif"><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundle });
      if (u.startsWith(`${URL}api/suggestions`)) { lectures += 1; return route.fulfill({ contentType: 'application/json', body: JSON.stringify(SELECTION) }); }
      if (u.startsWith(`${URL}api/home/mascot`) && req.method() === 'GET' && !u.includes('/events') && !u.includes('/reminders')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(bulle()) });
      }
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    await page.evaluate((m) => {
      const w = window as unknown as { __mountHome: () => void; __mountT2: (v: string) => void };
      if (m === 'home') w.__mountHome(); else w.__mountT2('mobile');
    }, monter);
    await page.locator('[data-mascot-bubble] p, [data-subject-block], [data-t2-body] button').first().waitFor({ timeout: 10_000 }).catch(() => {});
    expect(erreurs).toEqual([]);
    return page;
  }

  const mesurer = (page: Page) => page.evaluate(() => {
    const r = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    const zone = r(document.querySelector('[data-home-suggestions]'));
    const bulle = r(document.querySelector('[data-mascot-bubble]'));
    const section = r(document.querySelector('section[aria-label="Message de Verebona"]'));
    const suite = r(document.querySelector('[data-home-next]'));
    const boutons = [...document.querySelectorAll('[data-home-suggestions] button')].map((b) => {
      const x = b.getBoundingClientRect();
      const t = b.querySelector('span:last-child') as HTMLElement;
      return { top: x.top, bottom: x.bottom, left: x.left, right: x.right, width: x.width, height: x.height, texte: (b.textContent ?? '').trim().replace(/^›/, ''), coupe: t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1 };
    });
    return {
      zone: zone && { left: zone.left, right: zone.right, top: zone.top, bottom: zone.bottom, width: zone.width },
      bulleBas: bulle?.bottom ?? null, sectionBas: section?.bottom ?? null, suiteHaut: suite?.top ?? null,
      zonePresente: !!document.querySelector('[data-home-suggestions-zone], [data-home-suggestions], [data-home-suggestions-loading]'),
      boutons, scrollX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  type M = Awaited<ReturnType<typeof mesurer>>;

  /** Rangée unique, sans débordement ni chevauchement avec la bulle ou la section suivante. */
  function rangeeUnique(m: M, width: number) {
    expect(m.boutons.length).toBeGreaterThan(0);
    expect(m.boutons.length).toBeLessThanOrEqual(3);
    expect(m.scrollX).toBeLessThanOrEqual(0);
    const top = m.boutons[0].top;
    for (const b of m.boutons) {
      expect(Math.abs(b.top - top), `${width} px — ${b.texte}`).toBeLessThan(1); // même ligne : aucun empilement
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.coupe, b.texte).toBe(false);
      expect(b.left).toBeGreaterThanOrEqual(m.zone!.left - 0.5);
      expect(b.right).toBeLessThanOrEqual(m.zone!.right + 0.5);
      expect(b.right).toBeLessThanOrEqual(width);
    }
    for (let i = 1; i < m.boutons.length; i++) expect(m.boutons[i].left).toBeGreaterThanOrEqual(m.boutons[i - 1].right); // côte à côte, dans l'ordre
    if (m.bulleBas != null) expect(m.zone!.top).toBeGreaterThanOrEqual(m.bulleBas);
    if (m.suiteHaut != null) expect(m.zone!.bottom).toBeLessThanOrEqual(m.suiteHaut);
  }

  /** Absence : ni zone, ni espace réservé (la section se termine avec la bulle). */
  function absente(m: M) {
    expect(m.zonePresente).toBe(false);
    expect(m.boutons).toHaveLength(0);
    expect(m.scrollX).toBeLessThanOrEqual(0);
    if (m.bulleBas != null && m.sectionBas != null) expect(Math.abs(m.sectionBas - m.bulleBas)).toBeLessThanOrEqual(1);
  }

  it('L110C-NAV-01 (ordinateur 1440 px) — trois cartes sur UNE rangée, lisibles, sans débordement', async () => {
    const page = await ouvrir(DESKTOP(1440));
    await page.locator('[data-home-suggestions] button').first().waitFor({ timeout: 10_000 });
    const m = await mesurer(page);
    expect(m.boutons).toHaveLength(3);
    rangeeUnique(m, 1440);
    expect(m.boutons.map((b) => b.texte)).toEqual(SELECTION.items.map((x) => x.label));
    expect(lectures).toBe(1);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'l110c-accueil-1440.png'), fullPage: true });
    await page.context().close();
  });

  it('L110C-NAV-02 (mobile 390 px) — aucune zone, aucun espace, AUCUNE lecture des suggestions (même après un événement)', async () => {
    const page = await ouvrir(MOBILE);
    absente(await mesurer(page));
    // Un événement de données (document ajouté) ne relit pas non plus : aucune surface active.
    await page.evaluate(() => window.dispatchEvent(new Event('document-added')));
    await page.waitForTimeout(2_600);
    absente(await mesurer(page));
    expect(lectures).toBe(0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'l110c-accueil-390.png'), fullPage: true });
    await page.context().close();
  });

  it('L110C-NAV-03 (application iOS / Android, 1024 px) — aucune zone, aucune lecture', async () => {
    const page = await ouvrir({ viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true }, 'home', true);
    absente(await mesurer(page));
    expect(lectures).toBe(0);
    await page.context().close();
  });

  it('L110C-NAV-04 — transitions de largeur : rangée unique ou absence, jamais de chevauchement', async () => {
    const page = await ouvrir(DESKTOP(1440));
    await page.locator('[data-home-suggestions] button').first().waitFor({ timeout: 10_000 });
    for (const width of [390, 767, 768, 1024, 1440, 600, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(80);
      if (width >= 768) await page.locator('[data-home-suggestions] button').first().waitFor({ timeout: 5_000 });
      const m = await mesurer(page);
      if (width >= 768) {
        rangeeUnique(m, width);
        if (SHOTS && width === 768) await page.screenshot({ path: join(SHOTS, 'l110c-accueil-768.png'), fullPage: true });
      } else absente(m);
    }
    // La liste déjà lue est reprise telle quelle (même version, aucune relecture).
    expect(lectures).toBe(1);
    await page.context().close();
  });

  it('L110C-NAV-05 (ordinateur) — clic : vraie question avec intention et contexte (#657), remplacement sans relecture', async () => {
    const page = await ouvrir(DESKTOP(1440));
    await page.locator('[data-home-suggestions] button').first().waitFor({ timeout: 10_000 });
    await page.locator('[data-home-suggestions] button').nth(1).click();
    const asks = await page.evaluate(() => (window as unknown as { __asks: unknown[] }).__asks);
    expect(asks).toEqual([{ question: SELECTION.items[1].label, context: { suggestionId: SELECTION.items[1].id, suggestionVersion: SELECTION.version } }]);
    const m = await mesurer(page);
    expect(m.boutons.map((b) => b.texte)).toEqual([SELECTION.items[0].label, SELECTION.reserve[0].label, SELECTION.items[2].label]);
    rangeeUnique(m, 1440);
    expect(lectures).toBe(1);
    // Clavier : Tab atteint une carte, Entrée la pose.
    await page.locator('[data-home-suggestions] button').first().focus();
    await page.keyboard.press('Enter');
    expect(((await page.evaluate(() => (window as unknown as { __asks: unknown[] }).__asks)) as unknown[]).length).toBe(2);
    await page.context().close();
  });

  it('L110C-NAV-06 (« Demander à Verebona », mobile 390 px) — les trois suggestions à l’ouverture, cliquables', async () => {
    const page = await ouvrir(MOBILE, 't2');
    await page.locator('[data-t2-body] button[data-suggestion-id]').first().waitFor({ timeout: 10_000 });
    const ids = await page.locator('[data-t2-body] button[data-suggestion-id]').evaluateAll((bs) => bs.map((b) => b.getAttribute('data-suggestion-id')));
    expect(ids).toEqual(SELECTION.items.map((x) => x.id));
    const hauteurs = await page.locator('[data-t2-body] button[data-suggestion-id]').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().height));
    for (const h of hauteurs) expect(h).toBeGreaterThanOrEqual(44);
    expect(lectures).toBe(1);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'l110c-t2-390.png'), fullPage: true });
    await page.locator('[data-t2-body] button[data-suggestion-id]').first().click();
    const asks = await page.evaluate(() => (window as unknown as { __asks: unknown[] }).__asks);
    expect(asks).toEqual([{ question: SELECTION.items[0].label, context: { suggestionId: SELECTION.items[0].id, suggestionVersion: SELECTION.version } }]);
    await page.context().close();
  });

  it('L110C-NAV-07 (ordinateur 1024 px, grande police) — toujours une rangée, aucun texte rogné', async () => {
    const page = await ouvrir(DESKTOP(1024));
    await page.locator('[data-home-suggestions] button').first().waitFor({ timeout: 10_000 });
    await page.evaluate(() => { document.querySelectorAll<HTMLElement>('[data-home-suggestions] button').forEach((b) => { b.style.fontSize = '20px'; }); });
    rangeeUnique(await mesurer(page), 1024);
    await page.context().close();
  });
});
