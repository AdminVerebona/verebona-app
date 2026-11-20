/**
 * Carte Trello #806, volet B §7 et §8 — fiche d'une opération, opérations d'un document (tiroir) et liste des
 * opérations dans un NAVIGATEUR RÉEL (Chromium du dépôt), ordinateur (1280 × 800) ET mobile (iPhone 390 × 844, tactile).
 * Les VRAIS composants sont montés par le harnais `fixtures/l116cb-operations-harness.tsx` (même procédé que 84B / 86D).
 *
 *   L116CB-NAV01  fiche, mobile : aucun débordement horizontal ; un titre très long passe à la ligne (rien n'est coupé) ;
 *                 quatre natures de documents, une ligne par document ; « Retirer » seulement sur les justificatifs de
 *                 l'opération ; cibles ≥ 44 px ; toucher « Retirer » → le bon geste ; toucher un document → il s'ouvre
 *   L116CB-NAV02  fiche, ordinateur : type, pièces, montants par nature, valeurs différentes et renvoi vers « À
 *                 traiter » ; la source d'une date s'ouvre AU CLAVIER ; liens vers la liste, l'Agenda, « À traiter »,
 *                 les documents ; gestes distincts (corriger, rattacher, associer, scinder, retirer)
 *   L116CB-NAV03  tiroir du document, mobile : douze opérations, liste défilable sans débordement ; « Retirer » ≥ 44 px
 *                 → fenêtre qui dit ce qui reste → confirmation → l'opération quitte la liste ; « Rattacher à une
 *                 opération » → choix empilé, recherche, choix → l'opération entre dans la liste
 *   L116CB-NAV04  tiroir du document, ordinateur : « Retirer » au clavier ; « Annuler » ne retire rien
 *   L116CB-NAV05  liste, mobile : aucun débordement ; recherche, filtre par type, « Sans date », page suivante ;
 *                 chaque ligne est un lien vers la fiche ; cibles ≥ 44 px
 *   L116CB-NAV06  liste, ordinateur : tri par montant puis par intitulé au clavier ; « Réinitialiser » ; pagination
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
type Vue = 'fiche' | 'document' | 'liste';

describe.skipIf(!EXE)('L116CB — fiche, opérations d’un document et liste des opérations : ordinateur et mobile (navigateur réel)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let css = '';

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/l116cb-operations-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src'), 'next/link': resolve(__dirname, 'fixtures/next-link-stub.tsx') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
    });
    bundle = out.outputFiles[0].text;
    const { compile } = await import('@tailwindcss/node');
    const { Scanner } = await import('@tailwindcss/oxide');
    const compiler = await compile(readFileSync(resolve(ROOT, 'src/app/globals.css'), 'utf8'), { base: resolve(ROOT, 'src/app'), onDependency: () => {} });
    const sources = [
      'src/components/ui/sheet.tsx', 'src/components/ui/button.tsx', 'src/components/ui/input.tsx', 'src/components/ui/card.tsx', 'src/components/ui/alert-dialog.tsx',
      'src/components/drawers/EntityCard.tsx', 'src/components/agenda/AgendaGroupingPanel.tsx', 'src/components/documents/DocumentOperations.tsx',
      'src/components/documents/BusinessPeriods.tsx', 'src/components/reference-events/ReferenceEventPageContent.tsx', 'src/components/reference-events/ReferenceEventList.tsx',
      'src/components/reference-events/__tests__/fixtures/l116cb-operations-harness.tsx',
    ];
    css = compiler.build(new Scanner({}).scanFiles(sources.map((f) => ({ content: readFileSync(resolve(ROOT, f), 'utf8'), extension: 'tsx' }))));
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile: boolean, vue: Vue) {
    await ctx?.close();
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
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    expect(erreurs).toEqual([]);
    await page.evaluate((v) => window.__806Monter(v as Vue), vue);
    await page.waitForTimeout(500);
    expect(erreurs).toEqual([]);
  }
  const gestes = () => page.evaluate(() => window.__806Gestes);
  /** Débordement horizontal de la page (0 : aucun). */
  const deborde = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  /** Boutons et liens d'action plus petits que 44 px dans la zone (mobile). */
  const petits = (testId: string) => page.getByTestId(testId).evaluate((el) =>
    [...el.querySelectorAll('button, select, input')].map((b) => ({ n: b.getAttribute('aria-label') ?? b.getAttribute('data-testid') ?? b.textContent, h: Math.round(b.getBoundingClientRect().height) }))
      .filter((b) => b.h > 0 && b.h < 44));

  it('L116CB-NAV01 — fiche, mobile : rien ne déborde, le titre long passe à la ligne, quatre natures, « Retirer » sur les seuls justificatifs, cibles ≥ 44 px', async () => {
    await ouvrir(true, 'fiche');
    expect(await deborde()).toBe(0);
    // Le titre très long est rendu en ENTIER, sur plusieurs lignes (aucune ellipse, aucun texte rogné).
    const titre = page.getByTestId('reference-event-page-title');
    const t = await titre.evaluate((el) => ({ haut: el.getBoundingClientRect().height, ligne: parseFloat(getComputedStyle(el).lineHeight), rogne: el.scrollWidth > el.clientWidth, ellipse: getComputedStyle(el).textOverflow }));
    expect(t.haut).toBeGreaterThan(t.ligne * 2);
    expect(t.rogne).toBe(false);
    expect(t.ellipse).not.toBe('ellipsis');
    const lignes = page.locator('[data-testid="reference-event-page-documents"] [data-document-nature]');
    expect(await lignes.evaluateAll((els) => els.map((e) => e.getAttribute('data-document-nature')))).toEqual(['MEMBER', 'MEMBER', 'EVENT', 'RELATED']);
    // Aucune ligne de document n'est rognée : son intitulé long passe à la ligne.
    expect(await lignes.evaluateAll((els) => els.filter((e) => [...e.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1)).length)).toBe(0);
    for (const texte of ['Appartient à cette opération · Lié directement à l’événement « Passage de l’expert »', 'Justificatif partagé avec l’opération « Intervention — Réparation du plafond »',
      'Lié directement à l’événement « Passage de l’expert »', 'Document de l’opération associée « Contrat — Assurance habitation »']) {
      expect(await page.getByText(texte, { exact: false }).count(), texte).toBeGreaterThan(0);
    }
    expect(await page.getByTestId('reference-event-unlink-document-11').count()).toBe(1);
    expect(await page.getByTestId('reference-event-unlink-document-13').count()).toBe(0);
    expect(await page.getByTestId('reference-event-unlink-document-14').count()).toBe(0);
    expect(await petits('reference-event-page')).toEqual([]);
    await page.getByTestId('reference-event-unlink-document-12').tap();
    await page.getByRole('button', { name: 'Ouvrir le document : Photo du plafond' }).tap();
    await page.locator('[data-reference-event-room="31"]').tap();
    expect(await gestes()).toEqual(['retirer-document:12', 'document:13', 'piece:31']);
  });

  it('L116CB-NAV02 — fiche, ordinateur : type, pièces, montants par nature, valeurs différentes ; source ouverte au clavier ; écrans voisins ; gestes distincts', async () => {
    await ouvrir(false, 'fiche');
    expect(await deborde()).toBe(0);
    expect(await page.getByTestId('reference-event-page-type').innerText()).toBe('Type : Sinistre');
    expect(await page.getByTestId('reference-event-page-rooms').innerText()).toContain('Cuisine');
    const montants = await page.getByTestId('reference-event-page-amounts').innerText();
    for (const t of ['Coûts réalisés', '1 850,00 €', '1 montant dans une autre devise, non converti', 'Prévisions (devis, commandes, échéances à venir)', '2 100,00 €', 'Indemnités', '1 500,00 €']) {
      expect(montants.replace(/[  ]/g, ' '), t).toContain(t);
    }
    const ecarts = await page.getByTestId('reference-event-page-conflicts').innerText();
    expect(ecarts).toContain('Date de réalisation');
    expect(ecarts).toContain('02/04/2025');
    expect(ecarts).toContain('05/04/2025');
    expect(ecarts).toContain('(valeur affichée)');
    expect(ecarts).toContain('À confirmer');
    // La source de la date s'ouvre AU CLAVIER (vrai bouton, focus visible).
    const source = page.locator('[data-fact-source="REALIZED"]');
    await source.focus();
    expect(await source.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    // Écrans voisins : quatre vrais liens.
    const nav = page.getByTestId('reference-event-page-nav');
    expect(await nav.locator('a').evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(['/agenda/evenements-reference', '/agenda', '/accueil/a-traiter', '/documents']);
    await nav.getByText('Toutes les opérations').click();
    expect(await page.evaluate(() => window.__806Liens)).toEqual(['/agenda/evenements-reference']);
    // Gestes réellement distincts : chacun son bouton, chacun son effet.
    for (const id of ['correct', 'link-document', 'associate', 'split']) await page.getByTestId(`reference-event-action-${id}`).click();
    await page.getByTestId('reference-event-unlink-document-11').click();
    expect(await gestes()).toEqual(['document:11', 'corriger', 'rattacher-document', 'associer', 'scinder', 'retirer-document:11']);
  });

  it('L116CB-NAV03 — tiroir du document, mobile : douze opérations ; retirer (fenêtre, confirmation) ; rattacher (choix empilé, recherche)', async () => {
    await ouvrir(true, 'document');
    const tiroir = page.getByTestId('tiroir-document');
    expect(await tiroir.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.locator('[data-testid^="document-operation-retirer-"]').count()).toBe(12);
    expect(await page.getByTestId('document-operations').innerText()).toContain('Opérations (12)');
    expect(await petits('document-operations')).toEqual([]);
    // Le libellé très long de la première opération n'est pas rogné.
    expect(await page.getByTestId('document-operation-1').evaluate((el) => [...el.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1))).toBe(false);
    // RETIRER : la fenêtre dit ce qui part et ce qui reste ; la confirmation retire le lien seul.
    await page.getByRole('button', { name: 'Retirer ce document de l’opération « Intervention — Lot de travaux 03 »' }).tap();
    const fenetre = page.getByTestId('document-operation-retrait');
    await fenetre.waitFor();
    const texte = await fenetre.innerText();
    expect(texte).toContain('Retirer ce document de cette opération ?');
    expect(texte).toContain('Seul ce lien est retiré');
    expect(texte).toContain('ses autres opérations et ses liens directs avec votre agenda ne changent pas');
    await fenetre.getByRole('button', { name: 'Retirer de l’opération' }).tap();
    await page.waitForTimeout(300);
    expect(await page.locator('[data-testid^="document-operation-retirer-"]').count()).toBe(11);
    expect(await page.getByTestId('document-operation-3').count()).toBe(0);
    // RATTACHER : choix empilé, recherche, choix.
    await page.getByTestId('document-operation-rattacher').tap();
    const choix = page.getByTestId('regroupement-choix');
    await choix.waitFor();
    expect(await choix.innerText()).toContain('Choisir une opération');
    await choix.getByLabel('Rechercher une opération').fill('toiture');
    await page.waitForTimeout(500);
    expect(await choix.locator('li').count()).toBe(1);
    await choix.getByText('Intervention — Réfection de la toiture').tap();
    await page.waitForTimeout(400);
    expect(await page.getByTestId('document-operation-32').count()).toBe(1);
    expect(await gestes()).toEqual(['retirer:3', 'rattacher:32']);
  });

  it('L116CB-NAV04 — tiroir du document, ordinateur : « Retirer » au clavier ; « Annuler » ne retire rien', async () => {
    await ouvrir(false, 'document');
    const bouton = page.getByTestId('document-operation-retirer-2');
    await bouton.focus();
    await page.keyboard.press('Enter');
    const fenetre = page.getByTestId('document-operation-retrait');
    await fenetre.waitFor();
    await fenetre.getByRole('button', { name: 'Annuler' }).click();
    await page.waitForTimeout(300);
    expect(await page.locator('[data-testid^="document-operation-retirer-"]').count()).toBe(12);
    expect(await gestes()).toEqual(['retrait-annule']);
    // Chaque opération est un vrai lien vers sa fiche.
    expect(await page.getByTestId('document-operation-2').locator('a').getAttribute('href')).toBe('/agenda/evenements-reference/2');
    expect(Math.round((await bouton.boundingBox())!.height)).toBe(32);
  });

  it('L116CB-NAV05 — liste, mobile : rien ne déborde ; recherche, filtre par type, « Sans date », page suivante ; lignes cliquables ; cibles ≥ 44 px', async () => {
    await ouvrir(true, 'liste');
    expect(await deborde()).toBe(0);
    expect(await petits('operation-list')).toEqual([]);
    expect(await page.getByTestId('operation-list-count').innerText()).toBe('60 opérations');
    expect(await page.locator('[data-testid^="operation-list-item-"]').count()).toBe(25);
    expect(await page.getByTestId('operation-list-page').innerText()).toBe('Page 1 sur 3');
    // Page suivante : d'autres lignes, aucune en commun avec la première page.
    const premiere = await page.locator('[data-operation-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-operation-id')));
    await page.getByTestId('operation-list-next').tap();
    await page.waitForTimeout(200);
    const seconde = await page.locator('[data-operation-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-operation-id')));
    expect(seconde).toHaveLength(25);
    expect(seconde.filter((id) => premiere.includes(id))).toEqual([]);
    expect(await page.getByTestId('operation-list-page').innerText()).toBe('Page 2 sur 3');
    // Filtre par type, puis « Sans date ».
    await page.getByTestId('operation-list-type').selectOption('CLAIM');
    await page.waitForTimeout(200);
    expect(await page.getByTestId('operation-list-count').innerText()).toBe('6 opérations sur 60');
    await page.getByTestId('operation-list-type').selectOption('');
    await page.getByTestId('operation-list-state').selectOption('UNDATED');
    await page.waitForTimeout(200);
    expect(await page.getByTestId('operation-list-count').innerText()).toBe('6 opérations sur 60');
    expect((await page.locator('[data-testid^="operation-list-meta-"]').allInnerTexts()).every((t) => t.includes('Sans date'))).toBe(true);
    await page.getByTestId('operation-list-reset').tap();
    // Recherche (validée par le bouton) : par pièce — les dix opérations de la pièce « Cuisine » et celle dont
    // l'intitulé nomme la cuisine.
    await page.getByTestId('operation-list-search').fill('cuisine');
    await page.getByTestId('operation-list-search-submit').tap();
    await page.waitForTimeout(200);
    expect(await page.getByTestId('operation-list-count').innerText()).toBe('11 opérations sur 60');
    // Le titre très long de la première opération est rendu en entier, et c'est un lien vers sa fiche.
    await page.getByTestId('operation-list-reset').tap();
    await page.getByTestId('operation-list-search').fill('expertise contradictoire');
    await page.getByTestId('operation-list-search-submit').tap();
    await page.waitForTimeout(200);
    const lien = page.getByTestId('operation-list-item-1').locator('a').first();
    expect(await lien.getAttribute('href')).toBe('/agenda/evenements-reference/1');
    expect(await lien.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    expect(await deborde()).toBe(0);
  });

  it('L116CB-NAV06 — liste, ordinateur : tri par montant puis par intitulé au clavier ; pagination ; « Réinitialiser »', async () => {
    await ouvrir(false, 'liste');
    expect(await deborde()).toBe(0);
    await page.getByTestId('operation-list-sort').selectOption('AMOUNT_DESC');
    await page.waitForTimeout(200);
    const montants = await page.locator('[data-operation-id]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-operation-id'))));
    expect(montants.slice(0, 3)).toEqual([60, 59, 58]);
    // Au clavier : le tri est une vraie liste déroulante.
    const tri = page.getByTestId('operation-list-sort');
    await tri.focus();
    expect(await tri.evaluate((el) => el === document.activeElement && el.tagName === 'SELECT')).toBe(true);
    await tri.selectOption('TITLE');
    await page.waitForTimeout(200);
    const titres = await page.locator('[data-testid^="operation-list-item-"] a[aria-label]').evaluateAll((els) => els.map((a) => a.textContent ?? ''));
    expect(titres).toEqual([...titres].sort((a, b) => a.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().localeCompare(b.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(), 'fr')));
    // Dernière page : cinq… dix lignes restantes (60 = 25 + 25 + 10) ; « suivante » désactivée.
    await page.getByTestId('operation-list-next').click();
    await page.getByTestId('operation-list-next').click();
    await page.waitForTimeout(200);
    expect(await page.locator('[data-testid^="operation-list-item-"]').count()).toBe(10);
    expect(await page.getByTestId('operation-list-next').isDisabled()).toBe(true);
    expect(Math.round((await page.getByTestId('operation-list-sort').boundingBox())!.height)).toBe(36);
  });
});
