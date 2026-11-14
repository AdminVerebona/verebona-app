/**
 * Lot 114M — Trello #774 : rendu RÉEL des deux e-mails de sécurité (gabarit
 * transactionnel commun) dans Chromium (playwright-core du dépôt), tels que
 * `EmailService.renderTemplate` les produit.
 *
 * Ce que ce test mesure (CA05, CA06) : colonne ≤ 600 px, aucun débordement
 * horizontal de 320 à 390 px, marges internes, en-tête court, logo 120 × 30,
 * bouton exploitable au doigt, pré-en-tête invisible, images bloquées (texte
 * alternatif, mise en page stable), mode sombre (`prefers-color-scheme`),
 * rendu sans feuille de style (clients qui retirent `<style>`).
 *
 * Ce que ce test NE prouve PAS : le rendu dans Apple Mail iOS, Gmail et
 * Outlook (moteurs différents) — recette manuelle du PO (fiche 114M).
 *
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 * Captures facultatives : $L114M_CAPTURES (dossier).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/lib/notifications/channel-activation', () => ({ isTransactionalEmailActive: async () => true }));
process.env.NEXT_PUBLIC_APP_URL = 'https://app.exemple.fr';

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
const URL = 'http://courriel.test/';
const CAPTURES = process.env.L114M_CAPTURES ?? '';
const SETTINGS = { senderName: 'Verebona', replyToEmail: 'support@verebona.com', footerText: null, logoUrl: null };
const VARIABLES = {
  eventWhen: 'le 13 novembre 2026 à 17 h 06 (heure de Paris)',
  actionUrl: 'https://app.exemple.fr/mon-compte?ouvrir=securite#securite',
};
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

describe.skipIf(!EXE)('L114M — e-mails de sécurité : rendu réel (navigateur)', () => {
  let browser: Browser;
  let ctx: BrowserContext | undefined;
  let page: Page;
  const html: Record<string, string> = {};
  let dark = '';

  beforeAll(async () => {
    const { emailService } = await import('../email-service');
    const { SECURITY_NOTIFICATION_TEMPLATES } = await import('../security-notification-templates');
    const { EMAIL_COLORS } = await import('../email-layout');
    for (const [code, tpl] of Object.entries(SECURITY_NOTIFICATION_TEMPLATES)) {
      html[code] = (await emailService.renderTemplate(tpl, VARIABLES, SETTINGS)).html;
    }
    dark = JSON.stringify(EMAIL_COLORS.dark);
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
    if (CAPTURES) mkdirSync(CAPTURES, { recursive: true });
  }, 120_000);
  afterAll(async () => { await ctx?.close(); await browser?.close(); });

  async function ouvrir(code: string, o: { width: number; scheme?: 'light' | 'dark'; images?: boolean; sansStyle?: boolean }) {
    await ctx?.close();
    ctx = await browser.newContext({
      viewport: { width: o.width, height: 900 }, colorScheme: o.scheme ?? 'light',
      ...(o.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    page = await ctx.newPage();
    const body = o.sansStyle ? html[code].replace(/<style[\s\S]*?<\/style>/gi, '') : html[code];
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u === URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
      // Logos hébergés par l'application : servis depuis `public/brand`, ou bloqués.
      const logo = /\/brand\/(verebona-logo-email(?:-dark)?\.png)/.exec(u);
      if (logo && o.images !== false) return route.fulfill({ contentType: 'image/png', body: readFileSync(resolve(ROOT, 'public/brand', logo[1])) });
      return route.abort();
    });
    await page.goto(URL);
    await page.waitForTimeout(100);
  }

  const capture = async (nom: string) => {
    if (CAPTURES) await page.screenshot({ path: resolve(CAPTURES, `${nom}.png`), fullPage: true });
  };

  const mesures = () => page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const css = (el: Element | null, p: string) => (el ? getComputedStyle(el).getPropertyValue(p) : '');
    const card = document.querySelector('.vb-card');
    const btn = document.querySelector('a.vb-btn');
    const h1 = document.querySelector('h1');
    const visibles = [...document.querySelectorAll('img')].filter((i) => getComputedStyle(i).display !== 'none' && i.getBoundingClientRect().height > 0);
    const debordants = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > window.innerWidth + 0.5 && getComputedStyle(el).display !== 'none';
    }).length;
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      debordants,
      card: box(card),
      cardBg: css(card, 'background-color'),
      pageBg: css(document.body, 'background-color'),
      texte: box(document.querySelector('.vb-text')),
      texteCouleur: css(document.querySelector('.vb-text p'), 'color'),
      textePadding: css(document.querySelector('.vb-text'), 'padding-left'),
      h1: box(h1), h1Taille: css(h1, 'font-size'), h1Couleur: css(h1, 'color'), h1Nombre: document.querySelectorAll('h1').length,
      pTaille: css(document.querySelector('.vb-text p'), 'font-size'),
      btn: box(btn), btnBg: css(btn, 'background-color'), btnCouleur: css(btn, 'color'), btnNombre: document.querySelectorAll('a.vb-btn').length,
      preheader: box(document.querySelector('[data-vb-preheader]')),
      preheaderAffiche: css(document.querySelector('[data-vb-preheader]'), 'display'),
      logos: visibles.map((i) => ({ ...box(i)!, alt: i.alt, charge: i.complete && i.naturalWidth > 0, mode: i.getAttribute('data-vb-logo') })),
      liste: document.querySelectorAll('ol > li').length,
      pied: box(document.querySelector('td.vb-foot')),
    };
  });

  for (const code of ['NOTIF_MFA_PASSKEY_ADDED', 'NOTIF_MFA_TOTP_ENABLED']) {
    const nom = code === 'NOTIF_MFA_PASSKEY_ADDED' ? 'cle-acces' : 'totp';

    it(`${nom} — ordinateur : colonne de 600 px au plus, centrée, en-tête court`, async () => {
      await ouvrir(code, { width: 1024 });
      const m = await mesures();
      expect(m.card!.w).toBeLessThanOrEqual(600);
      expect(m.card!.w).toBeGreaterThanOrEqual(598);
      expect(Math.abs((m.card!.x + m.card!.w / 2) - m.viewport / 2)).toBeLessThan(2);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.viewport);
      // En-tête : du haut de la carte au titre, moins de 80 px (logo 30 px + marges).
      expect(m.h1!.y - m.card!.y).toBeLessThan(80);
      expect(m.logos).toHaveLength(1);
      expect(m.logos[0]).toMatchObject({ w: 120, h: 30, alt: 'Verebona', charge: true, mode: 'light' });
      expect(m.h1Nombre).toBe(1);
      expect(m.h1Taille).toBe('24px');
      expect(m.pTaille).toBe('16px');
      expect(m.btnNombre).toBe(1);
      expect(m.liste).toBe(code === 'NOTIF_MFA_PASSKEY_ADDED' ? 3 : 4);
      expect(m.preheaderAffiche).toBe('none');
      await capture(`${nom}-ordinateur-clair`);
    });

    it.each([320, 360, 390])(`${nom} — téléphone %i px : aucun débordement, marges de 24 px, bouton au doigt`, async (width) => {
      await ouvrir(code, { width });
      const m = await mesures();
      expect(m.scrollWidth).toBeLessThanOrEqual(width);
      expect(m.debordants).toBe(0);
      expect(m.card!.w).toBeLessThanOrEqual(width);
      // La carte occupe la largeur (8 px de marge extérieure de chaque côté).
      expect(m.card!.w).toBeGreaterThanOrEqual(width - 18);
      expect(m.textePadding).toBe('24px');
      // Bouton : dans l'écran, zone tactile d'au moins 44 px de haut.
      expect(m.btn!.h).toBeGreaterThanOrEqual(44);
      expect(m.btn!.x).toBeGreaterThanOrEqual(0);
      expect(m.btn!.right).toBeLessThanOrEqual(width);
      expect(m.h1!.y - m.card!.y).toBeLessThan(110);
      expect(m.pTaille).toBe('16px');
      if (width !== 360) await capture(`${nom}-telephone-${width}-clair`);
    });

    it(`${nom} — mode sombre : fond, carte, texte, bouton et logo sombres`, async () => {
      await ouvrir(code, { width: 390, scheme: 'dark' });
      const m = await mesures();
      const D = JSON.parse(dark) as Record<string, string>;
      expect(m.pageBg).toBe(rgb(D.page));
      expect(m.cardBg).toBe(rgb(D.card));
      expect(m.texteCouleur).toBe(rgb(D.text));
      expect(m.h1Couleur).toBe(rgb(D.text));
      expect(m.btnBg).toBe(rgb(D.accent));
      expect(m.btnCouleur).toBe(rgb(D.onAccent));
      expect(m.logos).toHaveLength(1);
      expect(m.logos[0]).toMatchObject({ w: 120, h: 30, mode: 'dark', charge: true });
      expect(m.debordants).toBe(0);
      await capture(`${nom}-telephone-390-sombre`);
    });

    it(`${nom} — images bloquées : texte alternatif, aucune rupture de mise en page`, async () => {
      await ouvrir(code, { width: 390, images: false });
      const m = await mesures();
      expect(m.logos.every((l) => !l.charge && l.alt === 'Verebona')).toBe(true);
      expect(m.scrollWidth).toBeLessThanOrEqual(390);
      expect(m.debordants).toBe(0);
      expect(m.h1!.y - m.card!.y).toBeLessThan(110);
      // Tout le contenu utile reste du texte.
      const texte = await page.evaluate(() => document.body.innerText);
      expect(texte).toContain('Notification de sécurité');
      expect(texte).toContain('Vérifier la sécurité de mon compte');
      await capture(`${nom}-telephone-390-images-bloquees`);
    });

    it(`${nom} — client qui retire la feuille de style : colonne fluide, lisible à 320 px`, async () => {
      await ouvrir(code, { width: 320, sansStyle: true });
      const m = await mesures();
      expect(m.scrollWidth).toBeLessThanOrEqual(320);
      expect(m.debordants).toBe(0);
      expect(m.card!.w).toBeLessThanOrEqual(320);
      expect(m.textePadding).toBe('24px');
      expect(m.btn!.h).toBeGreaterThanOrEqual(44);
      expect(m.btn!.right).toBeLessThanOrEqual(320);
    });
  }
});
