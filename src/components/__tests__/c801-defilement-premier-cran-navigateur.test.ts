/**
 * Carte 801 — preuve dans un NAVIGATEUR RÉEL que le premier cran de molette
 * descend bien jusqu'à la zone de défilement de la coquille.
 *
 * La cause et la règle tenue sont expliquées dans
 * `c801-defilement-premier-cran.test.ts` (contrôle du code source). Ici, on
 * mesure le comportement : feuille de style RÉELLE (`src/app/globals.css`
 * compilée par Tailwind avec les classes de la coquille, de l'accueil et de
 * la page des biens), chaînes de classes RÉELLES lues dans le code, et de
 * VRAIS événements molette envoyés par Chromium (`page.mouse.wheel`).
 *
 * Le contenu du carrousel reçoit volontairement UN pixel de reste vertical :
 * c'est la condition qui déclenche le bug en production (arrondi sous-pixel
 * d'une vignette, repli d'un libellé, bordure). Le test de contrôle rejoue la
 * même page avec la déclaration `overflow-y-hidden` retirée : il doit, lui,
 * perdre le premier cran — sans quoi la mesure ne prouverait rien.
 *
 * Ignoré (skip) quand aucun Chromium n'est installé (CI), comme les autres
 * tests « navigateur » du dépôt.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const ROOT = resolve(__dirname, '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Classe du `<ul>` de `HomeCarousel`, lue dans le code (gabarit de chaîne). */
function classeCarrousel(): string {
  const src = lire('src/components/home/HomeBlocks.tsx');
  const trouve = src.match(/`(m-0 flex list-none[^`]*)`/)?.[1];
  expect(trouve, 'classe du carrousel introuvable dans HomeBlocks.tsx').toBeTruthy();
  return trouve!.replace('${FOCUS_RING}', '').trim();
}

/** Classe de l'enveloppe du contenu de la page des biens, lue dans le code. */
function classeContenuBiens(): string {
  const src = lire('src/app/(dashboard)/assets/page.tsx');
  const trouve = src.match(/"(space-y-6 w-full max-w-full overflow-x-[a-z]+)"/)?.[1];
  expect(trouve, 'classe du contenu des biens introuvable dans assets/page.tsx').toBeTruthy();
  return trouve!;
}

describe.skipIf(!EXE)('carte 801 — premier cran de molette (navigateur réel)', () => {
  let browser: Browser;
  let feuille = '';

  beforeAll(async () => {
    const { compile } = await import('@tailwindcss/node');
    const { Scanner } = await import('@tailwindcss/oxide');
    const compiler = await compile(lire('src/app/globals.css'), { base: resolve(ROOT, 'src/app'), onDependency: () => {} });
    const sources: { content: string; extension: string }[] = [
      'src/components/DashboardLayout.tsx',
      'src/components/home/HomeBlocks.tsx',
      'src/app/(dashboard)/assets/page.tsx',
    ].map((f) => ({ content: lire(f), extension: 'tsx' }));
    // Les classes du gabarit de test doivent être scannées elles aussi, sinon
    // Tailwind ne produit pas les hauteurs arbitraires et la page ne défile pas.
    sources.push({ content: page_html(classeCarrousel(), classeContenuBiens()), extension: 'html' });
    feuille = compiler.build(new Scanner({}).scanFiles(sources));
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
  }, 180_000);

  afterAll(async () => { await browser?.close(); });

  /** Coquille réelle + un carrousel qui a UN pixel de reste vertical. */
  function page_html(classeUl: string, classeWrap: string): string {
    const tuiles = Array.from({ length: 12 }, () =>
      // 141 px dans une liste calée sur 140 px : un pixel de reste vertical.
      '<li class="flex-shrink-0 snap-start"><span class="block h-[141px] w-[204px] rounded-xl"></span></li>').join('');
    return `<!doctype html><html lang="fr" data-theme="beige"><head><meta charset="utf-8"><style>${feuille}</style>
<style>ul[data-carrousel]{height:140px}</style></head>
<body><div class="flex h-screen overflow-hidden bg-[color:var(--bg-page)]">
  <div class="relative flex min-w-0 flex-1 flex-col">
    <header class="h-14 flex-shrink-0"></header>
    <div id="main-scroll-container" class="relative flex min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden scroll-smooth">
      <main class="w-full flex-1">
        <div class="max-w-full overflow-x-clip">
          <div class="${classeWrap}">
            <ul data-carrousel class="${classeUl}" tabindex="0" aria-label="Mes biens">${tuiles}</ul>
            ${Array.from({ length: 5 }, () => '<div class="h-[320px]"></div>').join('')}
          </div>
        </div>
      </main>
    </div>
  </div>
</div></body></html>`;
  }

  /** Trois crans de molette, pointeur sur le carrousel. Rend les px gagnés par la PAGE. */
  async function crans(classeUl: string, classeWrap: string): Promise<{ crans: number[]; capteur: string | null; reste: number }> {
    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.setContent(page_html(classeUl, classeWrap));
      await page.waitForTimeout(250);
      const etat = await page.evaluate(() => {
        const ul = document.querySelector('ul[data-carrousel]')!;
        const cs = getComputedStyle(ul);
        const reste = ul.scrollHeight - ul.clientHeight;
        return { oy: cs.overflowY, reste, capte: ['auto', 'scroll'].includes(cs.overflowY) && reste > 0 };
      });
      const boite = (await page.locator('ul[data-carrousel]').boundingBox())!;
      await page.mouse.move(boite.x + boite.width / 2, boite.y + boite.height / 2);
      await page.waitForTimeout(120);
      const mesures: number[] = [];
      for (let i = 0; i < 3; i++) {
        const avant = await page.evaluate(() => document.getElementById('main-scroll-container')!.scrollTop);
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(500);
        const apres = await page.evaluate(() => document.getElementById('main-scroll-container')!.scrollTop);
        mesures.push(Math.round(apres - avant));
      }
      return { crans: mesures, capteur: etat.capte ? `ul{overflow-y:${etat.oy}}` : null, reste: etat.reste };
    } finally {
      await page.close();
    }
  }

  it('C801-N1 — un pixel de reste vertical ne vole plus le premier cran', async () => {
    const { crans: mesures, capteur } = await crans(classeCarrousel(), classeContenuBiens());
    expect(capteur, 'aucun conteneur imbriqué ne doit pouvoir capter le cran').toBeNull();
    expect(mesures[0], `premier cran perdu : ${JSON.stringify(mesures)}`).toBeGreaterThan(0);
    expect(mesures.every((m) => m > 0)).toBe(true);
  }, 120_000);

  it('C801-N2 — contrôle : sans la déclaration verticale, le premier cran EST perdu', async () => {
    const regresse = classeCarrousel().replace(/\boverflow-y-hidden\b/, '').replace(/\s+/g, ' ').trim();
    expect(regresse).not.toContain('overflow-y-');
    const { crans: mesures, capteur, reste } = await crans(regresse, classeContenuBiens());
    expect(reste).toBeGreaterThan(0);
    expect(capteur).toBe('ul{overflow-y:auto}');
    expect(mesures[0], 'la mesure ne démontre rien si ce cas passe aussi').toBe(0);
    expect(mesures[1]).toBeGreaterThan(0);
  }, 120_000);
});
