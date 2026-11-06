/**
 * Lot 111E — remplissage automatique des mots de passe : VRAIS formulaires
 * (connexion, réinitialisation, activation) dans Chromium (playwright-core du
 * dépôt). Un navigateur ne laisse pas un script déclencher son propre
 * remplissage automatique : on reproduit les trois façons dont un
 * gestionnaire pose les valeurs, puis on soumet et on lit la requête envoyée.
 *
 *   natif   : événements `input` réels (Playwright `fill`) — iOS / Chrome ;
 *   naïf    : `champ.value = …` puis `input`/`change` synthétiques — React
 *             ignore ces événements (son suivi de valeur est déjà à jour) :
 *             c'est le cas « champ visiblement rempli, état React vide » ;
 *   silencieux : valeur posée SANS aucun événement juste avant l'envoi
 *             (pré-remplissage non signalé).
 *
 * Attendu : la requête porte les valeurs affichées ; un rendu ultérieur
 * (message d'erreur) ne les efface pas ; les attributs sont ceux que les
 * gestionnaires reconnaissent. Ignoré (skip) sans Chromium (CI).
 */
import { existsSync, readdirSync } from 'node:fs';
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
const ROOT = resolve(__dirname, '../../..');
const ORIGIN = 'https://app.verebona.test';
const FIXTURES = resolve(__dirname, 'fixtures');
const EMAIL = 'camille@exemple.fr';
const SECRET = 'Motdepasse-Test-1!';

// Correctif 113 (suite complète sous charge, 06/11) : le délai par défaut de expect.poll (1 s) ne suffit pas
// quand la machine est chargée — l'envoi arrive, plus tard. Délai borné, l'attendu ne change pas.
const POLL_MS = 10_000;
type Mode = 'natif' | 'naif' | 'silencieux';

describe.skipIf(!EXE)('L111E — remplissage automatique puis envoi (navigateur)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let sent: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(FIXTURES, 'l111e-autofill-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: {
        '@': resolve(ROOT, 'src'),
        'next/navigation': resolve(FIXTURES, 'l111e-next-navigation-stub.ts'),
        'next/link': resolve(FIXTURES, 'l111e-next-link-stub.tsx'),
      },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
    });
    bundle = out.outputFiles[0].text;
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 180_000);
  afterAll(async () => { await ctx?.close(); await browser?.close(); });

  async function ouvrir(path: string, which: 'login' | 'reset' | 'activate' | 'signup', mobile = false) {
    await ctx?.close();
    sent = [];
    ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (u.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
      if (u.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (u.pathname.startsWith('/api/')) {
        if (req.method() === 'POST') {
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(req.postData() ?? '{}'); } catch { /* corps non JSON */ }
          sent.push({ url: u.pathname, body });
          return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'INVALID_CREDENTIALS', error: 'Identifiants incorrects', message: 'Identifiants incorrects' }) });
        }
        return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(`${ORIGIN}${path}`);
    await page.addScriptTag({ url: `${ORIGIN}/harness.js` });
    await page.evaluate((w) => (window as unknown as { __mount: (p: string) => void }).__mount(w), which);
    await page.locator('form').first().waitFor();
    expect(erreurs).toEqual([]);
  }

  /** Pose `valeur` dans le champ `selector` comme le ferait un gestionnaire. */
  async function remplir(selector: string, valeur: string, mode: Mode) {
    if (mode === 'natif') { await page.fill(selector, valeur); return; }
    await page.evaluate(({ s, v, m }) => {
      const el = document.querySelector<HTMLInputElement>(s)!;
      el.value = v; // setter de l'instance : le suivi de valeur de React est mis à jour → React ignorera l'événement
      if (m === 'naif') {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, { s: selector, v: valeur, m: mode });
  }

  for (const mode of ['natif', 'naif', 'silencieux'] as const) {
    it(`L111E-NAV-01 (${mode}) — connexion : e-mail + mot de passe remplis puis envoyés tels qu'affichés, conservés après l'erreur`, async () => {
      await ouvrir('/login', 'login', mode === 'naif');
      const email = page.locator('input[name="username"]');
      const pwd = page.locator('input[name="password"]');
      expect(await email.getAttribute('autocomplete')).toBe('username');
      expect(await email.getAttribute('type')).toBe('email');
      expect(await email.getAttribute('inputmode')).toBe('email');
      expect(await pwd.getAttribute('autocomplete')).toBe('current-password');
      expect(await pwd.getAttribute('type')).toBe('password');
      // Les deux champs dans le MÊME vrai formulaire, chacun avec son libellé.
      expect(await page.evaluate(() => {
        const e = document.querySelector<HTMLInputElement>('input[name="username"]')!;
        const p = document.querySelector<HTMLInputElement>('input[name="password"]')!;
        return !!e.form && e.form === p.form && e.labels!.length === 1 && p.labels!.length === 1;
      })).toBe(true);

      await remplir('input[name="username"]', EMAIL, mode);
      await remplir('input[name="password"]', SECRET, mode);
      if (mode === 'naif') await page.waitForTimeout(50); // resynchronisation de l'état contrôlé
      await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await expect.poll(() => sent.filter((s) => s.url === '/api/auth/login').length, { timeout: POLL_MS }).toBe(1);
      const body = sent.find((s) => s.url === '/api/auth/login')!.body;
      expect(body.email).toBe(EMAIL);
      expect(body.password).toBe(SECRET);
      // Refus affiché → nouveau rendu : rien n'est écrasé.
      await page.getByRole('alert').waitFor();
      expect(await email.inputValue()).toBe(EMAIL);
      expect(await pwd.inputValue()).toBe(SECRET);
      // Mot de passe redevenu masqué à l'envoi, même s'il avait été affiché.
      expect(await pwd.getAttribute('type')).toBe('password');
    });
  }

  it('L111E-NAV-02 — connexion : mot de passe affiché puis envoyé → redevient masqué (proposition d’enregistrement)', async () => {
    await ouvrir('/login', 'login');
    await page.fill('input[name="username"]', EMAIL);
    await page.fill('input[name="password"]', SECRET);
    await page.getByRole('button', { name: 'Afficher le mot de passe' }).click();
    expect(await page.locator('#password').getAttribute('type')).toBe('text');
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await expect.poll(() => sent.length, { timeout: POLL_MS }).toBe(1);
    expect(await page.locator('#password').getAttribute('type')).toBe('password');
  });

  for (const mode of ['naif', 'silencieux'] as const) {
    it(`L111E-NAV-03 (${mode}) — réinitialisation : mot de passe GÉNÉRÉ posé dans les deux champs en même temps → envoyé, pas de faux « ne correspondent pas »`, async () => {
      await ouvrir('/reset-password?token=jeton-de-test', 'reset');
      const a = page.locator('input[name="new-password"]');
      const b = page.locator('input[name="confirm-password"]');
      expect(await a.getAttribute('autocomplete')).toBe('new-password');
      expect(await b.getAttribute('autocomplete')).toBe('new-password');
      await page.evaluate(({ v, m }) => {
        for (const n of ['new-password', 'confirm-password']) {
          const el = document.querySelector<HTMLInputElement>(`input[name="${n}"]`)!;
          el.value = v;
          if (m === 'naif') el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, { v: SECRET, m: mode });
      if (mode === 'naif') {
        await page.waitForTimeout(50);
        // L'état contrôlé est resynchronisé : la valeur survit à un rendu.
        expect(await a.inputValue()).toBe(SECRET);
        expect(await b.inputValue()).toBe(SECRET);
      }
      await page.getByRole('button', { name: 'Modifier mon mot de passe' }).click();
      // Valeurs lues dans le formulaire à l'envoi (même sans événement).
      await expect.poll(() => sent.filter((s) => s.url === '/api/auth/reset-password').length, { timeout: POLL_MS }).toBe(1);
      expect(sent[0].body.newPassword).toBe(SECRET);
      expect(await page.getByText('Les deux mots de passe ne correspondent pas.').count()).toBe(0);
    });
  }

  it('L111E-NAV-04 — activation : mot de passe rempli par le gestionnaire (naïf) → bouton actif et envoi du mot de passe', async () => {
    await ouvrir('/verify-email/activer?token=jeton-de-test', 'activate', true);
    const pwd = page.locator('input[name="password"]');
    expect(await pwd.getAttribute('autocomplete')).toBe('current-password');
    await remplir('input[name="password"]', SECRET, 'naif');
    await page.waitForTimeout(50);
    const bouton = page.getByRole('button', { name: 'Activer mon compte' });
    expect(await bouton.isEnabled()).toBe(true);
    await bouton.click();
    await expect.poll(() => sent.filter((s) => s.url === '/api/auth/verify-email').length, { timeout: POLL_MS }).toBe(1);
    expect(sent[0].body.password).toBe(SECRET);
  });

  it('L111E-NAV-05 — pré-remplissage avant la première saisie (au montage) : état resynchronisé sans événement', async () => {
    await ouvrir('/login', 'login');
    await remplir('input[name="username"]', EMAIL, 'silencieux');
    // Resynchronisation programmée au montage (jusqu'à 2 s) : pas d'événement nécessaire.
    await page.waitForTimeout(2200);
    // Un rendu provoqué (le bouton « Afficher ») ne vide pas le champ.
    await page.getByRole('button', { name: 'Afficher le mot de passe' }).click();
    expect(await page.locator('input[name="username"]').inputValue()).toBe(EMAIL);
  });
  it('L111E-NAV-06 — inscription : mot de passe généré posé sans événement exploitable (naïf) → état React resynchronisé avant tout envoi (critères affichés)', async () => {
    await ouvrir('/signup', 'signup');
    expect(await page.locator('#displayName').getAttribute('autocomplete')).toBe('nickname');
    expect(await page.locator('input[name="username"]').getAttribute('autocomplete')).toBe('username');
    expect(await page.locator('input[name="new-password"]').getAttribute('autocomplete')).toBe('new-password');
    expect(await page.locator('input[name="confirm-password"]').getAttribute('autocomplete')).toBe('new-password');
    expect(await page.getByTestId('password-requirements').getAttribute('data-mode')).toBe('short');
    await page.evaluate((v) => {
      for (const n of ['new-password', 'confirm-password']) {
        const el = document.querySelector<HTMLInputElement>(`input[name="${n}"]`)!;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, SECRET);
    // Sans resynchronisation, React ignorerait l'événement : critères repliés, état vide.
    await expect.poll(() => page.getByTestId('password-requirements').getAttribute('data-mode'), { timeout: POLL_MS }).toBe('detailed');
    expect(await page.locator('input[name="new-password"]').inputValue()).toBe(SECRET);
    expect(await page.locator('input[name="confirm-password"]').inputValue()).toBe(SECRET);
  });
});
