/**
 * Carte #790, relance du 21/11/2026 (E03) — la réponse « coût de possession de Polo » dans un NAVIGATEUR RÉEL
 * (Chromium du dépôt), gabarit MOBILE (iPhone, 390 × 844) puis ORDINATEUR (1280 × 800).
 *
 * VRAI espace de réponse (`VerebonaSpaceProvider`, champ, panneau, `SpaceBody`, `AnswerBlocks`), VRAI client
 * (`useVerebona`), VRAIE feuille de style (Tailwind compilé depuis `globals.css`). Le serveur est simulé par le
 * test, mais ce qu'il rend est produit par le code de PRODUCTION : la stratégie `structured.ownership_cost`
 * sur le jeu « Polo » (montants exacts de la carte), puis la charge de l'API (`toApiPayload`).
 *
 *   NAV01  mobile, question tapée et envoyée au CLAVIER : cinq blocs réellement distincts (boîtes mesurées, sans
 *          recouvrement, dans l'ordre de lecture) — chiffre principal seul, ventilation, réserves ; rien ne
 *          déborde ; blocs nommés pour un lecteur d'écran ; copie dans le bon ordre ; capture d'écran ;
 *   NAV02  mobile, HISTORIQUE (conversation rouverte, aucun bloc reçu) : exactement les mêmes blocs ;
 *   NAV03  mobile, REJEU : le réseau tombe pendant l'envoi (demande reçue, réponse perdue) ; au retour du réseau
 *          l'application renvoie la demande avec le MÊME identifiant — une seule réponse, les mêmes blocs ;
 *   NAV04  ordinateur : mêmes blocs, mêmes mesures ; capture d'écran ;
 *   NAV05  témoin : l'ancien texte (référence d'avant correctif) rend bien UN seul paragraphe — le test voit le défaut.
 *
 * Ces captures sont celles d'un Chromium au gabarit iPhone : ce ne sont PAS des captures d'un iPhone réel.
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { CasProduit } from '@/services/verebona-assistant/canonical/__tests__/fixtures/c790b-cas';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

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
const STUBS = resolve(__dirname, 'fixtures/c790b-stubs.ts');
const CAPTURES = resolve(ROOT, 'docs/exploitation/captures');
const URL = 'http://verebona.test/';
const IPHONE = { width: 390, height: 844 };
const QUESTION = 'Quel est le coût de possession de Polo ?';
const CONVERSATION = 77;
const nb = (s: string) => s.replace(/[  ]/g, ' ');

interface BlocMesure {
  kind: string | null; tag: string; text: string; nom: string | null; role: string | null;
  top: number; bottom: number; left: number; right: number;
  items: Array<{ text: string; top: number; bottom: number }>;
}

describe.skipIf(!EXE)('C790B — réponse « coût de possession de Polo » : blocs réellement distincts à l’écran (navigateur réel)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let css = '';
  /** Texte de la réponse et charge de l'API, produits par le code de production. */
  let reponse = '';
  let charge: Record<string, unknown> = {};
  let ancienTexte = '';
  /** Serveur simulé : demandes reçues, pannes à simuler, conversation existante. */
  const recues: Array<{ message: string; clientRequestId: string }> = [];
  let pannes = 0;
  let avecHistorique = false;
  let texteServi = '';

  beforeAll(async () => {
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const { toApiPayload } = await import('@/services/verebona-assistant/core/api-payload');
    const { POLO, poloTco } = await import('@/services/verebona-assistant/canonical/__tests__/fixtures/c790b-polo');
    const r = ownershipCostAnswer(POLO as never, poloTco()) as { answer: string; claims: unknown[] };
    reponse = r.answer;
    charge = toApiPayload({
      requestId: 'req-790', messageId: '501', conversationId: CONVERSATION, mode: 'deterministic', answer: r.answer,
      sources: [], actions: [], claims: r.claims, route: { intent: 'ACCOUNT_FACT_ASSET' },
    } as never) as unknown as Record<string, unknown>;
    const avant = JSON.parse(readFileSync(resolve(ROOT, 'src/services/verebona-assistant/canonical/__tests__/fixtures/c790b-avant-correctif.json'), 'utf8')) as Record<string, CasProduit>;
    ancienTexte = avant.polo.answer;

    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/c790b-espace-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
      plugins: [{
        name: 'c790b-stubs',
        setup(b) { b.onResolve({ filter: /^(next\/navigation|@\/contexts\/WriteGuardContext)$/ }, () => ({ path: STUBS })); },
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
    mkdirSync(CAPTURES, { recursive: true });
  }, 300_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile: boolean, o: { historique?: boolean; pannes?: number; texte?: string } = {}) {
    await ctx?.close();
    recues.length = 0;
    pannes = o.pannes ?? 0;
    avecHistorique = o.historique ?? false;
    texteServi = o.texte ?? reponse;
    ctx = await browser.newContext(mobile
      ? { viewport: IPHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: 'fr-FR' }
      : { viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
    page = await ctx.newPage();
    const json = (body: unknown) => ({ contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = req.url();
      if (u === URL) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="fr" data-theme="beige"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body style="background:var(--bg-page);font-family:system-ui,sans-serif"><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundle });
      const chemin = u.slice(URL.length - 1).split('?')[0];
      if (chemin === '/api/verebona/messages' && req.method() === 'POST') {
        const corps = JSON.parse(req.postData() ?? '{}') as { message: string; clientRequestId: string };
        recues.push({ message: corps.message, clientRequestId: corps.clientRequestId });
        // Demande REÇUE par le serveur, réponse perdue : le réseau tombe avant le retour.
        if (pannes > 0) { pannes -= 1; await ctx.setOffline(true); return route.abort('internetdisconnected'); }
        // Texte d'avant correctif (témoin) : la charge est recalculée par la même fonction de production.
        if (texteServi !== reponse) {
          const { answerBlocksForApi } = await import('@/services/verebona-assistant/core/api-payload');
          const blocs = answerBlocksForApi(texteServi);
          const { answerBlocks: _b, ...reste } = charge;
          return route.fulfill(json({ ...reste, answer: texteServi, ...(blocs ? { answerBlocks: blocs } : {}) }));
        }
        return route.fulfill(json(charge));
      }
      if (chemin === '/api/verebona/conversations' && req.method() === 'GET') {
        return route.fulfill(json({ conversations: avecHistorique
          ? [{ id: CONVERSATION, title: QUESTION, createdAt: '2026-11-21T09:00:00.000Z', lastMessageAt: '2026-11-21T09:00:05.000Z', messageCount: 2, lastAnswer: reponse.slice(0, 80) }]
          : [] }));
      }
      if (chemin === '/api/verebona/conversation' && req.method() === 'GET') {
        // Forme de la route d'historique : le TEXTE enregistré, aucun bloc.
        return route.fulfill(json({ conversationId: CONVERSATION, nextCursor: null, clarification: null, commandPlans: [], messages: [
          { id: 500, role: 'user', content: QUESTION },
          { id: 501, role: 'assistant', content: reponse, mode: 'deterministic', intent: 'ACCOUNT_FACT_ASSET', source_count: 0 },
        ] }));
      }
      if (chemin.startsWith('/api/')) return route.fulfill(json({}));
      // Carte #790 recentrée : les images de l'application (mascotte) sont servies depuis `public/`, comme en
      // production — la vignette n'apparaît plus cassée dans les captures.
      const fichier = resolve(ROOT, 'public', `.${decodeURIComponent(chemin)}`);
      if (fichier.startsWith(`${resolve(ROOT, 'public')}/`) && existsSync(fichier) && statSync(fichier).isFile()) {
        return route.fulfill({ contentType: /\.webp$/.test(fichier) ? 'image/webp' : /\.png$/.test(fichier) ? 'image/png' : 'application/octet-stream', body: readFileSync(fichier) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    await page.evaluate((m) => (window as unknown as { __790Monter: (mobile: boolean) => void }).__790Monter(m), mobile);
    await page.waitForTimeout(300);
    expect(erreurs).toEqual([]);
  }

  /** Ouvre l'espace, tape la question AU CLAVIER et l'envoie par « Entrée ». */
  async function demanderAuClavier(mobile: boolean) {
    if (mobile) await page.locator('[data-verebona-field="mobile"]').tap();
    else await page.getByRole('combobox', { name: 'Demander à Verebona' }).click();
    const champ = page.getByRole('combobox', { name: 'Demander à Verebona' });
    await champ.focus();
    await page.keyboard.type(QUESTION);
    await page.keyboard.press('Enter');
  }

  const mesurer = (): Promise<BlocMesure[]> => page.evaluate(() => {
    const racine = document.querySelector('[data-answer-blocks]');
    if (!racine) return [];
    return [...racine.children].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        kind: el.getAttribute('data-answer-block') ?? (el.tagName === 'P' ? 'paragraph' : el.tagName === 'H4' ? 'heading' : null), tag: el.tagName, text: (el as HTMLElement).innerText,
        nom: el.getAttribute('aria-label'), role: el.getAttribute('role'),
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        items: [...el.querySelectorAll('li')].map((li) => { const b = li.getBoundingClientRect(); return { text: (li as HTMLElement).innerText, top: b.top, bottom: b.bottom }; }),
      };
    });
  });
  const deborde = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  /** Ce qu'un utilisateur voit, bloc par bloc (texte sans espaces insécables, sans géométrie). */
  const lecture = (blocs: BlocMesure[]) => blocs.map((b) => ({ kind: b.kind, text: nb(b.text), nom: b.nom ? nb(b.nom) : null, items: b.items.map((i) => nb(i.text)) }));

  async function verifierBlocsPolo(largeur: number): Promise<BlocMesure[]> {
    await page.waitForSelector('[data-answer-blocks] [data-answer-block="list"]', { timeout: 10_000 });
    await page.waitForTimeout(450); // fin de l'animation d'ouverture : boîtes stables
    const blocs = await mesurer();
    // Cinq éléments SÉPARÉS, dans l'ordre de lecture : total, annonce, ventilation, annonce, réserves.
    expect(blocs.map((b) => b.kind)).toEqual(['metric', 'paragraph', 'list', 'paragraph', 'list']);
    expect(blocs.map((b) => b.tag)).toEqual(['DIV', 'P', 'UL', 'P', 'UL']);
    for (let i = 1; i < blocs.length; i += 1) {
      // Aucune boîte n'en recouvre une autre : chaque bloc commence sous le précédent, avec un espace visible.
      expect(blocs[i].top, `bloc ${i}`).toBeGreaterThanOrEqual(blocs[i - 1].bottom + 4);
    }
    for (const b of blocs) {
      expect(b.bottom - b.top, String(b.kind)).toBeGreaterThan(10);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(largeur);
    }
    const [principal, annonceVentilation, ventilation, annonceLimites, limites] = blocs;
    // 1. Le chiffre principal, SEUL : aucun poste dans sa boîte.
    expect(nb(principal.text).split('\n')).toEqual(['Chiffre clé', '2 476,41 €', 'coût cumulé documenté de Polo']);
    expect(nb(principal.text)).not.toMatch(/559,51|1 115,53|801,37/);
    // 2. La ventilation : trois postes, un par ligne, chacun dans sa propre boîte.
    expect(annonceVentilation.text).toBe('Ventilation :');
    expect(ventilation.items.map((i) => nb(i.text))).toEqual(['Entretien, réparations et travaux : 559,51 €', 'Contrats et assurances : 1 115,53 €', 'Autres coûts : 801,37 €']);
    // 3. Les réserves : à part, après les montants, une par ligne.
    expect(annonceLimites.text).toBe('Limites :');
    expect(limites.items.map((i) => nb(i.text))).toEqual([
      'Coût annuel moyen de possession non calculé : date d’achat du bien inconnue : renseignez-la sur la fiche pour calculer la moyenne.',
      'Coût net estimé non calculé : aucune estimation de valeur admissible postérieure à l’achat (le prix d’achat n’est jamais une valeur actuelle).',
      'Ce total peut être incomplet.',
    ]);
    for (const liste of [ventilation, limites]) {
      for (let i = 1; i < liste.items.length; i += 1) expect(liste.items[i].top).toBeGreaterThanOrEqual(liste.items[i - 1].bottom);
    }
    // Le total est réellement mis en avant : sa valeur est écrite plus grand que le texte courant.
    const tailles = await page.evaluate(() => ({
      valeur: parseFloat(getComputedStyle(document.querySelector('[data-answer-block="metric"] strong')!).fontSize),
      texte: parseFloat(getComputedStyle(document.querySelector('[data-answer-block="list"] li')!).fontSize),
    }));
    expect(tailles.valeur).toBeGreaterThan(tailles.texte);
    expect(await deborde()).toBe(0);
    // Aucun marqueur technique à l'écran : ni JSON, ni puce écrite, ni « ## ».
    const visible = await page.locator('[data-answer-blocks]').innerText();
    expect(visible).not.toMatch(/[{}[\]]|"kind"|•|##|\|/);
    return blocs;
  }

  async function verifierLecteurEcranEtCopie() {
    // Lecteur d'écran : un groupe nommé pour le chiffre principal, deux listes nommées par leur annonce.
    await expect.poll(() => page.getByRole('group', { name: /^Chiffre clé : 2.476,41.€ — coût cumulé documenté de Polo$/ }).count()).toBe(1);
    expect(await page.getByRole('list', { name: 'Ventilation', exact: true }).getByRole('listitem').count()).toBe(3);
    expect(await page.getByRole('list', { name: 'Limites', exact: true }).getByRole('listitem').count()).toBe(3);
    // La réponse est annoncée (zone « polite ») et vit dans la fenêtre de l'Assistant.
    expect(await page.evaluate(() => {
      const r = document.querySelector('[data-answer-blocks]')!;
      return { annonce: r.closest('[aria-live="polite"]') !== null, dialogue: r.closest('[role="dialog"][aria-label="Verebona"]') !== null };
    })).toEqual({ annonce: true, dialogue: true });
    // Ordre de lecture du document = ordre visuel (aucun réordonnancement par le style).
    const ordre = await page.evaluate(() => [...document.querySelectorAll('[data-answer-blocks] > *')].map((e) => e.getAttribute('data-answer-block') ?? e.tagName));
    expect(ordre).toEqual(['metric', 'P', 'list', 'P', 'list']);
    // Copie : sélection de toute la réponse — le total, puis la ventilation, puis les réserves.
    const copie = nb(await page.evaluate(() => {
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('[data-answer-blocks]')!);
      sel.addRange(range);
      return sel.toString();
    }));
    const reperes = ['Chiffre clé', '2 476,41 €', 'coût cumulé documenté de Polo', 'Ventilation :', '559,51 €', '1 115,53 €', '801,37 €', 'Limites :', 'Coût annuel moyen', 'Coût net estimé', 'Ce total peut être incomplet.'];
    const positions = reperes.map((r) => copie.indexOf(r));
    expect(positions.every((p) => p >= 0), JSON.stringify(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Chaque montant n'est copié qu'une fois.
    for (const m of ['2 476,41 €', '559,51 €', '1 115,53 €', '801,37 €']) expect(copie.split(m).length - 1, m).toBe(1);
  }

  let blocsMobile: ReturnType<typeof lecture> = [];

  it('NAV01 — mobile 390 × 844, question tapée au clavier : total seul, ventilation, réserves — boîtes distinctes, nommées, copie dans l’ordre', async () => {
    await ouvrir(true);
    await demanderAuClavier(true);
    const blocs = await verifierBlocsPolo(IPHONE.width);
    blocsMobile = lecture(blocs);
    expect(recues).toHaveLength(1);
    expect(recues[0].message).toBe(QUESTION);
    // Toute la réponse tient dans la fenêtre de l'Assistant, sous le champ.
    const dialogue = await page.locator('[role="dialog"][aria-label="Verebona"]').boundingBox();
    expect(dialogue?.width).toBe(IPHONE.width);
    await verifierLecteurEcranEtCopie();
    // Clavier : le focus reste piégé dans la fenêtre ; « Nouvelle demande » et « Fermer » sont atteignables.
    await page.getByRole('combobox', { name: 'Demander à Verebona' }).focus();
    const atteints: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      atteints.push(await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return a && a.closest('[role="dialog"]') ? (a.getAttribute('aria-label') ?? a.innerText.trim()) : 'HORS FENÊTRE';
      }));
    }
    expect(atteints).not.toContain('HORS FENÊTRE');
    expect(atteints).toContain('Fermer');
    expect(atteints).toContain('Nouvelle demande');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.getByRole('combobox', { name: 'Demander à Verebona' }).blur();
    await page.screenshot({ path: resolve(CAPTURES, '116k-polo-mobile.png') });
  });

  it('NAV02 — mobile, historique : la conversation rouverte (texte seul, aucun bloc reçu) rend exactement les mêmes blocs', async () => {
    await ouvrir(true, { historique: true });
    await page.locator('[data-verebona-field="mobile"]').tap();
    await page.getByRole('list', { name: 'Recherches récentes' }).getByRole('button', { name: QUESTION, exact: true }).tap();
    const blocs = await verifierBlocsPolo(IPHONE.width);
    expect(lecture(blocs)).toEqual(blocsMobile);
    await verifierLecteurEcranEtCopie();
    // Rien n'a été renvoyé au serveur : l'historique est une lecture.
    expect(recues).toEqual([]);
  });

  it('NAV03 — mobile, rejeu : réseau perdu pendant l’envoi puis rétabli — même identifiant de demande renvoyé, une seule réponse, mêmes blocs', async () => {
    await ouvrir(true, { pannes: 1 });
    await demanderAuClavier(true);
    // La question reste affichée, en attente ; aucune réponse, aucune erreur.
    await expect.poll(() => recues.length, { timeout: 10_000 }).toBe(1);
    await page.getByRole('status').filter({ hasText: /./ }).first().waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-answer-blocks]').count()).toBe(0);
    expect(await page.getByRole('alert').count()).toBe(0);
    // Retour du réseau : l'application renvoie la demande d'elle-même.
    await ctx.setOffline(false);
    const blocs = await verifierBlocsPolo(IPHONE.width);
    expect(lecture(blocs)).toEqual(blocsMobile);
    expect(recues).toHaveLength(2);
    expect(recues[1].message).toBe(QUESTION);
    // MÊME identifiant de demande : le serveur reconnaît un rejeu (scénario PostgreSQL C790B-POLO P04).
    expect(recues[1].clientRequestId).toBe(recues[0].clientRequestId);
    // Une seule question, une seule réponse à l'écran.
    expect(await page.locator('[data-answer-blocks]').count()).toBe(1);
    await verifierLecteurEcranEtCopie();
  });

  it('NAV04 — ordinateur 1280 × 800 : mêmes blocs distincts, nommés, copie dans l’ordre', async () => {
    await ouvrir(false);
    await demanderAuClavier(false);
    const blocs = await verifierBlocsPolo(1280);
    expect(lecture(blocs)).toEqual(blocsMobile);
    await verifierLecteurEcranEtCopie();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.screenshot({ path: resolve(CAPTURES, '116k-polo-ordinateur.png') });
  });

  it('NAV05 — témoin du défaut : le texte d’avant correctif (une seule ligne) rend UN seul paragraphe dense', async () => {
    await ouvrir(true, { texte: ancienTexte });
    await demanderAuClavier(true);
    await page.waitForSelector('[data-answer-blocks]', { timeout: 10_000 });
    await page.waitForTimeout(450);
    const blocs = await mesurer();
    expect(blocs.map((b) => b.kind)).toEqual(['paragraph']);
    expect(nb(blocs[0].text)).toContain('coût cumulé documenté 2 476,41 € (entretien, réparations et travaux 559,51 €');
    expect(await page.getByRole('group', { name: /Chiffre clé/ }).count()).toBe(0);
    expect(await page.getByRole('list', { name: 'Ventilation', exact: true }).count()).toBe(0);
  });
});
