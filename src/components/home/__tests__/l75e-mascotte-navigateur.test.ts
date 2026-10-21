/**
 * Lot 75E — BUG P1 « Mascotte : écarts résiduels du lot 71F » — TEST
 * NAVIGATEUR RÉEL (Chromium, `playwright-core` du dépôt, aucun paquet
 * ajouté, aucun serveur de l'application) : le VRAI `MascotSpeaks` et le
 * VRAI hook `useMascotPresentation` sont empaquetés par esbuild et montés
 * dans une page ; `GET /api/home/mascot` est intercepté et sert des
 * présentations produites par le VRAI moteur (signaux → sélection →
 * présentation), en viewport desktop (1280×800) et mobile (390×844).
 *
 *  L75E-M-NAV-01  ONB-DOC « garage » : instruction directe, une seule fois,
 *                 aucun paragraphe vide, action au clavier (nom accessible)
 *  L75E-M-NAV-02  présentation d'un serveur antérieur (introduction seule) :
 *                 bloc reconstruit sans perte d'action, jamais vide
 *  L75E-M-NAV-03  §5 : même contextHash, formulation interdite remplacée par
 *                 la réponse corrigée ; stabilité RUN-001 ensuite ; aucune
 *                 boucle de relecture ; aucun doublon après rafraîchissement
 *
 * Ignoré (skip) quand aucun Chromium n'est installé : la logique reste
 * couverte en Node (`l75e-mascotte-residuels.test.ts`, rendu serveur
 * `l71f-mascotte-sans-comptage.test.ts`).
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
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
const TODAY = '2026-10-19';
const ONB = 'Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.';

const { buildCandidates } = await import('@/services/home/mascot/signals');
const { selectSubjects, buildSecondaries } = await import('@/services/home/mascot/selector');
const { buildPresentation } = await import('@/services/home/mascot/presentation');
type Raw = import('@/services/home/mascot/signals').MascotRawData;

const GARAGE = {
  accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 3, name: 'garage' }], activeAssetCount: 1, documentCount: 0 },
  toProcess: [], agenda: [], acknowledgments: [], overdueAgenda: [],
} as unknown as Raw;
function garage(): MascotPresentation {
  const c = buildCandidates(GARAGE);
  const s = selectSubjects(c.candidates);
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: TODAY, todo: { total: 0, items: [] } });
}

describe.skipIf(!EXE)('L75E-M-NAV — mascotte dans un vrai navigateur (desktop et mobile)', () => {
  let browser: Browser;
  let bundle = '';
  /** Réponses successives de `GET /api/home/mascot` (la dernière est répétée). */
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

  async function ouvrir(mobile: boolean): Promise<Page> {
    const ctx = await browser.newContext(mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 800 } });
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
      // Télémétrie, rappels, images : réponses neutres.
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
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
    await page.locator('[data-subject-block]').first().waitFor({ timeout: 10_000 });
  }
  /** Texte visible des blocs de sujet (et nombre de paragraphes vides). */
  async function blocs(page: Page) {
    return page.locator('[data-subject-block]').evaluateAll((els) => els.map((el) => ({
      texte: (el.querySelector('p')?.textContent ?? '').trim(),
      pVides: [...el.querySelectorAll('p')].filter((p) => !(p.textContent ?? '').trim()).length,
      boutons: [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()),
    })));
  }
  const bulleTexte = (page: Page) => page.locator('[data-mascot-bubble]').innerText();

  for (const mobile of [false, true]) {
    const vue = mobile ? 'mobile' : 'desktop';

    it(`L75E-M-NAV-01 (${vue}) — ONB-DOC « garage » : instruction directe, une fois, aucun paragraphe vide, action au clavier`, async () => {
      const page = await ouvrir(mobile);
      await monter(page, [garage()]);
      expect(await blocs(page)).toEqual([{ texte: ONB, pVides: 0, boutons: ['Déposer un document'] }]);
      const bulle = await bulleTexte(page);
      expect(bulle.split(ONB).length - 1).toBe(1);
      expect(bulle).not.toMatch(/votre attention|sujets? (m[ée]rit|n[ée]cessit)/i);
      expect(await page.locator('[data-mascot-bubble] p').evaluateAll((ps) => ps.filter((p) => !(p.textContent ?? '').trim()).length)).toBe(0);
      // Clavier : l'action est atteignable, son nom accessible est complet (décrite par le texte du sujet).
      const bouton = page.getByRole('button', { name: 'Déposer un document' });
      await bouton.focus();
      expect(await bouton.evaluate((b) => b === document.activeElement)).toBe(true);
      const desc = await bouton.evaluate((b) => (b.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim());
      expect(desc).toBe(ONB);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as unknown as { __navigations: string[] }).__navigations.length)).toBeGreaterThan(0);
      await page.context().close();
    }, 60_000);

    it(`L75E-M-NAV-02 (${vue}) — présentation d’un serveur antérieur (introduction seule) : bloc lisible, action conservée`, async () => {
      const page = await ouvrir(mobile);
      const p0 = garage();
      const ancienne: MascotPresentation = {
        ...p0, presentationRevision: undefined,
        paragraphs: p0.paragraphs.map(({ fallbackText: _f, tile: _t, ...x }) => ({ ...x, text: 'Un sujet mérite votre attention aujourd’hui.' })),
      };
      await monter(page, [ancienne]);
      const b = await blocs(page);
      expect(b).toEqual([{ texte: 'Déposer un document', pVides: 0, boutons: ['Déposer un document'] }]);
      expect(await bulleTexte(page)).not.toMatch(/votre attention/i);
      await page.context().close();
    }, 60_000);

    it(`L75E-M-NAV-03 (${vue}) — même contextHash : formulation interdite remplacée, puis stable ; aucune boucle ni doublon`, async () => {
      const page = await ouvrir(mobile);
      const base = garage();
      const T6_CORRIGE = 'Déposez votre premier document pour garage, par exemple une facture ou un contrat.';
      const T6_AUTRE = 'Une facture ou un contrat suffit pour commencer avec votre garage.';
      // 1. Serveur antérieur (déploiement en cours) : introduction de comptage, aucune révision.
      const ancienne: MascotPresentation = { ...base, presentationRevision: undefined, source: 't6', paragraphs: base.paragraphs.map((x) => ({ ...x, text: `Un sujet mérite votre attention aujourd’hui, ${x.text.charAt(0).toLowerCase()}${x.text.slice(1)}` })) };
      // 2. Serveur corrigé, MÊME contexte métier (contextHash identique) : formulation T6 valide.
      const corrigee: MascotPresentation = { ...base, source: 't6', paragraphs: base.paragraphs.map((x) => ({ ...x, text: T6_CORRIGE, fallbackText: x.text })) };
      // 3. Même contexte, même révision, autre formulation : jamais remplacée sous les yeux (RUN-001).
      const autre: MascotPresentation = { ...corrigee, paragraphs: corrigee.paragraphs.map((x) => ({ ...x, text: T6_AUTRE })) };
      expect(ancienne.contextHash).toBe(corrigee.contextHash);
      await monter(page, [ancienne, corrigee, autre]);
      // Même la présentation antérieure n'affiche jamais l'introduction (dernier rempart, sans perte).
      expect((await blocs(page))[0].texte).toBe(ONB);
      await page.evaluate(() => window.dispatchEvent(new Event('verebona:data-mutated')));
      await expect.poll(async () => (await blocs(page))[0]?.texte, { timeout: 8_000 }).toBe(T6_CORRIGE);
      await page.evaluate(() => window.dispatchEvent(new Event('verebona:data-mutated')));
      await expect.poll(() => lectures, { timeout: 8_000 }).toBe(3);
      await page.waitForTimeout(1_200);
      expect((await blocs(page)).map((b) => b.texte)).toEqual([T6_CORRIGE]);
      // Aucune relecture spontanée (pas de boucle) ; un seul bloc, aucun doublon.
      expect(lectures).toBe(3);
      expect(await page.locator('[data-subject-block]').count()).toBe(1);
      expect((await bulleTexte(page)).split(T6_CORRIGE).length - 1).toBe(1);
      await page.context().close();
    }, 60_000);
  }
});
