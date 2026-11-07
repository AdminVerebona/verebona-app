/**
 * Lot 113T (Trello #718) — bouton d'export JSON du BO dans Chromium RÉEL
 * (playwright-core du dépôt), réponses HTTP servies par Playwright.
 *
 *   L113T-N01  ordinateur : événement de TÉLÉCHARGEMENT, nom du serveur, contenu
 *              identique ; l'écran du BO reste affiché (aucune navigation)
 *   L113T-N02  mobile tactile + Web Share fichiers : partage du FICHIER (.json)
 *   L113T-N03  mobile : annulation du partage → aucun message, aucun téléchargement
 *   L113T-N04  mobile : geste expiré (NotAllowedError) → « Partager le fichier »
 *   L113T-N06  app iOS (pont Capacitor simulé) : fichier écrit dans le cache puis
 *              feuille de partage native AVEC le fichier ; annulation sans message
 *   L113T-N05  session expirée (401 + renouvellement refusé), erreur serveur,
 *              page HTML : message clair, AUCUN fichier, BO intact
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';

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

// Délai borné des attentes (le défaut d'expect.poll, 1 s, est trop court sur une CI chargée — cf. l111e).
const POLL_MS = 10_000;
const EXE = chromium();
const ROOT = resolve(__dirname, '../../../..');
const ORIGIN = 'http://verebona.test';
const API = '/api/admin/ai/business-executions/T1%3Aef883f80-e565-4bd3-a524-340c324205f8/export?download=1&contenus=1';
const NAME = 'verebona-execution-T1-ef883f80-avec-echanges-2026-11-06.json';
const BODY = `${JSON.stringify({ format: 'verebona.ai-business-execution/1', execution: { id: 'T1:ef883f80-e565-4bd3-a524-340c324205f8', jobIds: [6775], accountId: 13 }, calls: [] }, null, 2)}\n`;

type Api = (route: Route) => Promise<void>;
const ok: Api = (route) => route.fulfill({
  status: 200, body: BODY,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${NAME}"; filename*=UTF-8''${NAME}` },
});

describe.skipIf(!EXE)('L113T — export JSON du BO (navigateur)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  const calls: string[] = [];

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l113t-export-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
    });
    bundle = out.outputFiles[0].text;
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 180_000);
  afterAll(async () => { await ctx?.close(); await browser?.close(); });

  async function open(o: { mobile: boolean; api?: Api; refresh?: number; share?: 'ok' | 'abort' | 'notallowed-once'; native?: 'ok' | 'cancel' }) {
    await ctx?.close();
    calls.length = 0;
    ctx = await browser.newContext(o.mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true }
      : { viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    if (o.share) {
      await ctx.addInitScript((mode) => {
        const w = window as unknown as { __shared: Array<{ name: string; type: string; text: string }>; __shareCalls: number };
        w.__shared = []; w.__shareCalls = 0;
        let refusals = mode === 'notallowed-once' ? 1 : 0;
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d: { files?: File[] }) => Array.isArray(d?.files) && d.files.length > 0 });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async (d: { files?: File[] }) => {
            w.__shareCalls += 1;
            if (mode === 'abort') throw new DOMException('Share canceled', 'AbortError');
            if (refusals > 0) { refusals -= 1; throw new DOMException('Must be handling a user gesture', 'NotAllowedError'); }
            for (const f of d.files ?? []) w.__shared.push({ name: f.name, type: f.type, text: await f.text() });
          },
        });
      }, o.share);
    }
    if (o.native) {
      await ctx.addInitScript((mode) => {
        const w = window as unknown as { __native: Array<[string, unknown]>; Capacitor: unknown };
        w.__native = [];
        w.Capacitor = {
          isNativePlatform: () => true, getPlatform: () => 'ios',
          Plugins: {
            Filesystem: {
              rmdir: async (x: unknown) => { w.__native.push(['rmdir', x]); },
              writeFile: async (x: { path: string }) => { w.__native.push(['writeFile', x]); return { uri: `file:///Caches/${x.path}` }; },
            },
            Share: { share: async (x: unknown) => { w.__native.push(['share', x]); if (mode === 'cancel') throw new Error('Share canceled'); return { activityType: 'com.apple.DocumentManagerUICore.SaveToFiles' }; } },
          },
        };
      }, o.native);
    }
    page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      calls.push(`${route.request().method()} ${u.pathname}`);
      if (u.href === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>' });
      if (u.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (u.pathname === '/api/auth/refresh') return route.fulfill({ status: o.refresh ?? 401, contentType: 'application/json', body: JSON.stringify({ code: 'REFRESH_INVALID' }) });
      if (u.pathname.startsWith('/api/admin/ai/business-executions/')) return (o.api ?? ok)(route);
      return route.fulfill({ status: 404, body: '' });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ url: `${ORIGIN}/harness.js` });
    await page.evaluate((url) => (window as unknown as { __mountExport: (u: string) => void }).__mountExport(url), API);
    expect(errors).toEqual([]);
  }

  const bouton = () => page.getByTestId('unit-export');
  const alerte = () => page.getByRole('alert');
  const boIntact = async () => {
    expect(page.url()).toBe(`${ORIGIN}/`);
    expect(await page.getByTestId('bo-ecran').count()).toBe(1);
    await expect.poll(() => bouton().isEnabled(), { timeout: POLL_MS }).toBe(true);
  };

  it('L113T-N01 — ordinateur : téléchargement du fichier .json (nom, contenu), BO intact', async () => {
    await open({ mobile: false });
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), bouton().click()]);
    expect(download.suggestedFilename()).toBe(NAME);
    const path = await download.path();
    expect(readFileSync(path!, 'utf8')).toBe(BODY);
    expect(JSON.parse(readFileSync(path!, 'utf8')).execution.id).toBe('T1:ef883f80-e565-4bd3-a524-340c324205f8');
    expect(calls.filter((c) => c.startsWith('GET /api/admin/'))).toHaveLength(1);
    await boIntact();
    expect(await alerte().count()).toBe(0);
  });

  it('L113T-N02 — mobile (Web Share fichiers) : le FICHIER est partagé, pas d’URL', async () => {
    await open({ mobile: true, share: 'ok' });
    await bouton().tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length), { timeout: POLL_MS }).toBe(1);
    const [f] = await page.evaluate(() => (window as unknown as { __shared: Array<{ name: string; type: string; text: string }> }).__shared);
    expect(f).toEqual({ name: NAME, type: 'application/json', text: BODY });
    await boIntact();
  });

  it('L113T-N03 — mobile : partage annulé → aucun message, aucun téléchargement', async () => {
    await open({ mobile: true, share: 'abort' });
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await bouton().tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shareCalls: number }).__shareCalls), { timeout: POLL_MS }).toBe(1);
    await boIntact();
    await page.waitForTimeout(300);
    expect(await alerte().count()).toBe(0);
    expect(downloads).toBe(0);
  });

  it('L113T-N04 — mobile : geste expiré → bouton « Partager le fichier » sur le fichier prêt', async () => {
    await open({ mobile: true, share: 'notallowed-once' });
    await bouton().tap();
    const relance = page.getByTestId('unit-export-share');
    await relance.waitFor();
    expect(await relance.textContent()).toContain('Partager le fichier');
    await relance.tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length), { timeout: POLL_MS }).toBe(1);
    await expect.poll(() => relance.count(), { timeout: POLL_MS }).toBe(0);
    expect(calls.filter((c) => c.startsWith('GET /api/admin/'))).toHaveLength(1);
    await boIntact();
  });

  for (const mode of ['ok', 'cancel'] as const) {
    it(`L113T-N06 — app iOS : feuille de partage native avec le FICHIER (${mode === 'ok' ? 'enregistré' : 'annulée'}), jamais de page brute`, async () => {
      await open({ mobile: true, native: mode });
      let downloads = 0;
      page.on('download', () => { downloads += 1; });
      await bouton().tap();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __native: unknown[] }).__native.length), { timeout: POLL_MS }).toBe(3);
      const n = await page.evaluate(() => (window as unknown as { __native: Array<[string, Record<string, unknown>]> }).__native);
      expect(n[0]).toEqual(['rmdir', { path: 'exports-verebona', directory: 'CACHE', recursive: true }]);
      expect(n[1]).toEqual(['writeFile', { path: `exports-verebona/${NAME}`, data: BODY, directory: 'CACHE', recursive: true, encoding: 'utf8' }]);
      expect(n[2][0]).toBe('share');
      expect(n[2][1]).toMatchObject({ files: [`file:///Caches/exports-verebona/${NAME}`] });
      expect(n[2][1]).not.toHaveProperty('url');
      expect(downloads).toBe(0);
      await boIntact();
      expect(await alerte().count()).toBe(0);
    });
  }

  const echecs: Array<[string, Api, RegExp]> = [
    ['session expirée', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'AUTH_REQUIRED', code: 'AUTH_REQUIRED' }) }), /^Session expirée : reconnectez-vous/],
    ['erreur serveur', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL' }) }), /erreur serveur/],
    ['page HTML', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>Bad gateway</html>' }), /Réponse inattendue du serveur/],
    ['droits', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'FORBIDDEN', message: 'Contenus des échanges IA réservés aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).' }) }), /réservés aux administrateurs habilités/],
  ];
  for (const mobile of [false, true]) {
    for (const [nom, api, msg] of echecs) {
      it(`L113T-N05 (${mobile ? 'mobile' : 'ordinateur'}) — ${nom} : message clair, aucun fichier, BO intact`, async () => {
        await open({ mobile, api, share: mobile ? 'ok' : undefined });
        let downloads = 0;
        page.on('download', () => { downloads += 1; });
        if (mobile) await bouton().tap(); else await bouton().click();
        await alerte().waitFor();
        expect(await alerte().textContent()).toMatch(msg);
        if (mobile) expect(await page.evaluate(() => (window as unknown as { __shareCalls: number }).__shareCalls)).toBe(0);
        expect(downloads).toBe(0);
        await boIntact();
      });
    }
  }
});
