/**
 * Impression HTML → PDF en deux passes (comme `maquettes/_system/render.mjs`).
 *
 *  1. première passe : nombre total de pages N ;
 *  2. seconde passe : « Page 1 / N » de la couverture et « p. 9–14 » de
 *     l'index des annexes ; si la pagination bouge encore, troisième passe.
 *
 * La page de départ de chaque annexe se déduit de N, sans extraction de
 * texte : par construction (`html/layout.ts`), chaque page d'annexe tient
 * sur UNE page (hauteur fixe) et est suivie d'UNE page « Références ». La
 * page A_k commence donc à `N − 1 − (pages d'annexes) + 1 + (pages des
 * annexes précédentes)`. Le test d'intégration vérifie ce calcul sur le PDF.
 *
 * L'invariant est garanti par les bornes de texte (`TEXT_BOUNDS`) et CONTRÔLÉ
 * à chaque impression : nombre de cadres d'annexe mesurés, absence de
 * débordement des pages d'annexe et de la page « Références » (hauteur fixe),
 * cohérence du total. Un écart lève RENDER_ERROR plutôt que de livrer un
 * index faux ou des pièces apposées sur la mauvaise page.
 *
 * Isolement de la page : JavaScript désactivé, service workers bloqués, et
 * interception de TOUTES les requêtes. La page est chargée depuis l'origine
 * virtuelle `RENDER_ORIGIN` (https, domaine `.invalid`) : le gestionnaire de
 * routes sert lui-même, depuis le disque, les seuls fichiers du répertoire
 * statique V12 et du répertoire de travail de la génération ; toute autre
 * requête (réseau, autre origine) est abandonnée, et Chromium refuse les URL
 * `file://` depuis une origine https. Une donnée utilisateur qui sortirait de
 * son contexte ne pourrait ni appeler l'extérieur ni incruster un fichier du
 * serveur (`file:///etc/…`, `.env`…) dans le PDF.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { Browser } from 'playwright-core';
import { withBrowser } from './browser';
import { RENDER_ORIGIN, renderUrlToPath } from '../static-assets';
import { ExportGenerationError } from '../generation/errors';
import type { PageMap, RenderedHtml } from '../types';

export interface AnnexLayout {
  annexRef: string;
  pageCount: number;
}

/** Cadre « contenu source » d'une page d'annexe, en px CSS depuis le coin haut-gauche de la page. */
export interface FrameRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PrintResult {
  pdf: Buffer;
  pageCount: number;
  pageMap: PageMap;
  /** Un cadre par page d'annexe, dans l'ordre. */
  frames: FrameRect[];
  /** Dimensions (points) de chaque page du PDF imprimé. */
  pageSizes: Array<{ width: number; height: number }>;
  passes: number;
}

/** Largeur de contenu d'une page « Références » (A4 moins marges latérales 2 × 44 px). */
const REFS_CONTENT_WIDTH_PX = 793.7007874 - 88;

interface LayoutCheck { annexPages: number; annexOverflow: number; refsPages: number; refsOverflow: boolean }

/** Carte des pages déduite du total (voir en-tête). */
export function computePageMap(total: number, annexes: AnnexLayout[]): PageMap {
  const annexPages = annexes.reduce((s, a) => s + Math.max(1, a.pageCount), 0);
  const annexStart: Record<string, number> = {};
  let page = total - 1 - annexPages + 1;
  for (const a of annexes) {
    annexStart[a.annexRef] = page;
    page += Math.max(1, a.pageCount);
  }
  return { total, annexStart };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
};

async function printOnce(browser: Browser, workDir: string, measureFrames: boolean): Promise<{ pdf: Buffer; frames: FrameRect[]; check: LayoutCheck }> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: 'block',
    viewport: { width: 794, height: 1123 },
    deviceScaleFactor: 1,
  });
  try {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('data:')) return route.continue(); // marque de l'en-tête (data-URI)
      const file = renderUrlToPath(url, workDir);
      if (!file) return route.abort('blockedbyclient');
      const body = await fs.readFile(file).catch(() => null);
      if (!body) return route.abort('filenotfound');
      return route.fulfill({ status: 200, body, contentType: CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    await page.goto(`${RENDER_ORIGIN}/work/index.html`, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const frames = measureFrames
      ? await page.evaluate(() => [...document.querySelectorAll('.annex-page')].map((pg) => {
        const r = pg.getBoundingClientRect();
        const f = (pg.querySelector('.annex-frame') ?? pg).getBoundingClientRect();
        return { top: f.top - r.top, left: f.left - r.left, width: f.width, height: f.height };
      }))
      : [];
    // Contrôle de l'invariant de pagination (zones de hauteur fixe). La page
    // « Références » est mesurée à la largeur de contenu de la page imprimée,
    // puis rendue à son état initial avant l'impression.
    const check = await page.evaluate((refsWidth) => {
      const annex = [...document.querySelectorAll<HTMLElement>('.annex-page')];
      const refs = [...document.querySelectorAll<HTMLElement>('.refs')];
      let refsOverflow = false;
      for (const el of refs) {
        const prev = el.style.width;
        el.style.width = `${refsWidth}px`;
        if (el.scrollHeight > el.clientHeight + 1) refsOverflow = true;
        el.style.width = prev;
      }
      return {
        annexPages: annex.length,
        annexOverflow: annex.filter((el) => el.scrollHeight > el.clientHeight + 1).length,
        refsPages: refs.length,
        refsOverflow,
      };
    }, REFS_CONTENT_WIDTH_PX);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true, outline: true });
    await page.close();
    return { pdf: Buffer.from(pdf), frames, check };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Pages du PDF imprimé par Chromium (sortie de confiance : lue dans le processus). */
async function pageSizesOf(pdf: Buffer): Promise<Array<{ width: number; height: number }>> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  return doc.getPages().map((p) => p.getSize());
}

/** Vérifie l'invariant de pagination ; lève RENDER_ERROR sinon. */
export function assertLayout(params: { check: LayoutCheck; frames: FrameRect[] | null; annexes: AnnexLayout[]; total: number }): void {
  const expected = params.annexes.reduce((s, a) => s + Math.max(1, a.pageCount), 0);
  const problems: string[] = [];
  if (params.check.annexPages !== expected) problems.push(`pages d'annexe ${params.check.annexPages}/${expected}`);
  if (params.frames && params.frames.length !== expected) problems.push(`cadres ${params.frames.length}/${expected}`);
  if (params.check.annexOverflow > 0) problems.push(`${params.check.annexOverflow} page(s) d'annexe en débordement`);
  if (params.check.refsPages !== 1) problems.push(`pages « Références » ${params.check.refsPages}/1`);
  if (params.check.refsOverflow) problems.push('page « Références » en débordement');
  if (params.total < expected + 2) problems.push(`total ${params.total} < ${expected + 2}`);
  if (problems.length) {
    throw new ExportGenerationError('RENDER_ERROR', 'render_pdf', `pagination du dossier incohérente : ${problems.join(', ')}`, { problems });
  }
}

/**
 * Rend un dossier en PDF (sans les pages sources apposées : voir `annexes.ts`).
 *  build(pageMap) : HTML du template pour une carte de pages (null en 1re passe).
 */
export async function printDossier(params: {
  workDir: string;
  build: (pageMap: PageMap | null) => RenderedHtml;
  annexes: AnnexLayout[];
  timeoutMs: number;
}): Promise<PrintResult> {
  const htmlFile = path.join(params.workDir, 'index.html');
  return withBrowser(async (browser) => {
    let pageMap: PageMap | null = null;
    let passes = 0;
    let last: { pdf: Buffer; frames: FrameRect[]; check: LayoutCheck } | null = null;
    let sizes: Array<{ width: number; height: number }> = [];
    let total = 0;
    // Au plus trois passes : la seconde stabilise dans tous les cas observés.
    while (passes < 3) {
      await fs.writeFile(htmlFile, params.build(pageMap).html, 'utf8');
      last = await printOnce(browser, params.workDir, passes > 0 || params.annexes.length === 0);
      passes++;
      sizes = await pageSizesOf(last.pdf);
      total = sizes.length;
      const next = computePageMap(total, params.annexes);
      if (pageMap && pageMap.total === next.total) { pageMap = next; break; }
      pageMap = next;
    }
    const measured = passes > 1 || params.annexes.length === 0;
    assertLayout({ check: last!.check, frames: measured ? last!.frames : null, annexes: params.annexes, total });
    return { pdf: last!.pdf, pageCount: total, pageMap: pageMap!, frames: last!.frames, pageSizes: sizes, passes };
  }, params.timeoutMs);
}
