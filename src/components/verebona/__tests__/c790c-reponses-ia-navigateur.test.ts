/**
 * Carte #790 RECENTRÉE (22/11/2026), complément du 24/11 — preuve À L'ÉCRAN, dans un NAVIGATEUR RÉEL (Chromium du
 * dépôt), gabarit MOBILE (390 × 844) puis ORDINATEUR (1280 × 800), des réponses que le premier passage ne montrait
 * pas : réponse IA à PLUSIEURS AFFIRMATIONS, comparaison, chronologie, question simple.
 *
 * VRAI espace de réponse (`VerebonaSpaceProvider`, `SpaceBody`, `AnswerBlocks`), VRAI client (`useVerebona`), VRAIE
 * feuille de style. Le serveur est simulé par le test, mais ce qu'il rend est produit par le code de PRODUCTION :
 * une sortie du modèle au contrat ANSWER réel (`T2AnswerOutput`), ramenée en lignes (`t2AnswerLines`), contrôlée et
 * assemblée (`toGeneratedAnswer`), puis la charge de l'API (`toApiPayload`). AUCUN appel à un fournisseur d'IA.
 *
 *   IA01  mobile — réponse IA à trois affirmations : trois paragraphes réellement distincts (boîtes mesurées, espace
 *         visible entre elles, ordre de lecture), rien ne déborde, aucune forme forcée, copie dans l'ordre ; capture ;
 *   IA02  mobile — historique (texte seul, aucun bloc reçu) : exactement les mêmes blocs ;
 *   IA03  mobile — rejeu (réseau perdu puis rétabli) : même identifiant de demande, une seule réponse, mêmes blocs ;
 *   IA04  ordinateur — mêmes blocs ; capture ;
 *   IA05  mobile — comparaison (format `comparison`) : le critère, puis une ligne par bien ; capture ;
 *   IA06  mobile — chronologie (format `timeline`) : liste « date · libellé » nommée « Chronologie » ; capture ;
 *   IA07  mobile — question simple : UNE phrase, aucune liste, aucun titre, aucun chiffre clé ; capture ;
 *   IA08  témoin — l'ancien texte (affirmations recollées par une espace) rend bien UN seul paragraphe.
 *
 * Ces captures sont celles d'un Chromium au gabarit iPhone : ce ne sont PAS des captures d'un iPhone réel.
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';

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
const PUBLIC = resolve(ROOT, 'public');
const STUBS = resolve(__dirname, 'fixtures/c790b-stubs.ts');
const CAPTURES = resolve(ROOT, 'docs/exploitation/captures');
const URL = 'http://verebona.test/';
const IPHONE = { width: 390, height: 844 };
const CONVERSATION = 78;
const nb = (s: string) => s.replace(/[  ]/g, ' ');

const Q_IA = 'Fais-moi le point sur la Clio';
const Q_COMPARAISON = 'Compare le kilométrage de mes deux voitures';
const Q_CHRONOLOGIE = 'Historique de la Clio';
const Q_SIMPLE = 'Quel est le kilométrage de la Clio ?';
const KM = 'Le kilométrage de la Clio est de 82 000 km.';
const CT = 'Son contrôle technique est prévu le 12/03/2027.';
const VIDANGE = 'La dernière vidange a coûté 189,90 €, chez Garage Martin.';

interface BlocMesure { kind: string | null; tag: string; text: string; top: number; bottom: number; left: number; right: number; items: string[] }
interface Servie { charge: Record<string, unknown>; texte: string }

describe.skipIf(!EXE)('C790C — réponse IA à plusieurs affirmations, comparaison, chronologie, question simple : à l’écran (navigateur réel)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let css = '';
  /** Réponses servies, par question — toutes produites par le code de production. */
  const reponses = new Map<string, Servie>();
  const recues: Array<{ message: string; clientRequestId: string }> = [];
  let pannes = 0;
  let historiqueDe: string | null = null;
  let texteForce: string | null = null;

  beforeAll(async () => {
    const { toApiPayload } = await import('@/services/verebona-assistant/core/api-payload');
    const { toGeneratedAnswer } = await import('@/services/verebona-assistant/core/generation.adapter');
    const { clientTimelineEvents } = await import('@/services/verebona-assistant/core/synthesis-planner');
    const { t2AnswerLines } = await import('@/services/ai/assistant/master/t2-answer');
    const { T2AnswerOutput } = await import('@/services/ai/assistant/master/t2-contract');
    const { fieldAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const sources = [
      { id: 'asset_field:7:mileage', content: 'Kilométrage : 82 000 km' },
      { id: 'asset_field:41:mileage', content: 'Kilométrage : 131 500 km' },
      { id: 'agenda:12', content: 'Contrôle technique le 12/03/2027' },
      { id: 'doc:31', content: 'Facture Garage Martin : vidange 189,90 € le 04/02/2026' },
      { id: 'doc:9', content: 'Achat de la Clio le 15/06/2021' },
    ].map((s) => ({ id: s.id, type: 'document' as const, title: s.id, content: s.content, relevanceScore: 1, meta: {} }));
    /** Sortie du modèle (simulée) → réponse contrôlée et assemblée par la production → charge de l'API. */
    const ia = (question: string, intent: string, messageId: string, sortie: unknown) => {
      const data = T2AnswerOutput.parse(sortie);
      const l = t2AnswerLines(data);
      const out = toGeneratedAnswer({ claims: l.lines, status: l.status, actionIntents: [], derivations: [] }, sources, [], { verifySupport: true, supportEvents: [], separator: l.separator });
      if (!out) throw new Error(`sortie rejetée : ${question}`);
      const events = data.format === 'timeline' ? clientTimelineEvents(data.events.map((e) => ({ date: e.date, text: e.text, sourceIds: e.sourceIds })), sources as never) : undefined;
      const charge = toApiPayload({
        requestId: `req-${messageId}`, messageId, conversationId: CONVERSATION, mode: 'ai', answer: out.answer,
        sources: [], actions: [], claims: out.claims, route: { intent }, ...(events ? { events } : {}),
      } as never) as unknown as Record<string, unknown>;
      reponses.set(question, { charge, texte: out.answer });
    };
    const c = (text: string, sourceId: string) => ({ text, sourceIds: [sourceId] });
    ia(Q_IA, 'ACCOUNT_SUMMARY', '601', { mode: 'ANSWER', format: 'claims', status: 'answered', claims: [c(KM, 'asset_field:7:mileage'), c(CT, 'agenda:12'), c(VIDANGE, 'doc:31')] });
    ia(Q_COMPARAISON, 'ACCOUNT_COMPARISON', '602', { mode: 'ANSWER', format: 'comparison', status: 'answered', criterion: 'kilométrage', items: [
      { targetId: 'asset:7', label: 'Clio', value: '82 000 km', sourceIds: ['asset_field:7:mileage'] },
      { targetId: 'asset:41', label: 'Polo', value: '131 500 km', sourceIds: ['asset_field:41:mileage'] },
    ] });
    ia(Q_CHRONOLOGIE, 'ACCOUNT_TIMELINE', '603', { mode: 'ANSWER', format: 'timeline', status: 'answered', events: [
      { date: '2021-06-15', text: 'Achat de la Clio', sourceIds: ['doc:9'] },
      { date: '2026-02-04', text: 'Vidange chez Garage Martin', sourceIds: ['doc:31'] },
      { date: '2027-03-12', text: 'Contrôle technique', sourceIds: ['agenda:12'] },
    ] });
    // Question simple : réponse du code (lecture de la fiche), une phrase.
    const simple = fieldAnswer({ assetId: 7, assetName: 'Clio', key: 'mileage', label: 'Kilométrage', value: 82000, display: '82 000 km', origin: 'USER', originLabel: 'saisie par vous', updatedAt: null, from: 'key', evidence: null, openConflict: null, sensitive: false } as never);
    reponses.set(Q_SIMPLE, { texte: simple, charge: toApiPayload({
      requestId: 'req-604', messageId: '604', conversationId: CONVERSATION, mode: 'deterministic', answer: simple, sources: [], actions: [], claims: [], route: { intent: 'ACCOUNT_FACT_ASSET' },
    } as never) as unknown as Record<string, unknown> });

    const esbuild = await import('esbuild');
    const out = await esbuild.build({
      entryPoints: [resolve(__dirname, 'fixtures/c790b-espace-harness.tsx')],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': resolve(ROOT, 'src') },
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      tsconfig: resolve(ROOT, 'tsconfig.json'),
      plugins: [{ name: 'c790b-stubs', setup(b) { b.onResolve({ filter: /^(next\/navigation|@\/contexts\/WriteGuardContext)$/ }, () => ({ path: STUBS })); } }],
    });
    bundle = out.outputFiles[0].text;
    const postcss = (await import('postcss')).default;
    const tailwind = (await import('@tailwindcss/postcss')).default;
    const from = resolve(ROOT, 'src/app/globals.css');
    css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(from, 'utf8'), { from })).css;
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
    mkdirSync(CAPTURES, { recursive: true });
  }, 300_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile: boolean, o: { historique?: string; pannes?: number; texte?: string } = {}) {
    await ctx?.close();
    recues.length = 0;
    pannes = o.pannes ?? 0;
    historiqueDe = o.historique ?? null;
    texteForce = o.texte ?? null;
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
      const chemin = decodeURIComponent(u.slice(URL.length - 1).split('?')[0]);
      if (chemin === '/api/verebona/messages' && req.method() === 'POST') {
        const corps = JSON.parse(req.postData() ?? '{}') as { message: string; clientRequestId: string };
        recues.push({ message: corps.message, clientRequestId: corps.clientRequestId });
        if (pannes > 0) { pannes -= 1; await ctx.setOffline(true); return route.abort('internetdisconnected'); }
        const servie = reponses.get(corps.message);
        if (!servie) return route.fulfill(json({}));
        if (texteForce !== null) {
          // Témoin : un texte d'avant correctif ; la charge est recalculée par la même fonction de production.
          const { answerBlocksForApi } = await import('@/services/verebona-assistant/core/api-payload');
          const blocs = answerBlocksForApi(texteForce);
          const { answerBlocks: _b, ...reste } = servie.charge;
          return route.fulfill(json({ ...reste, answer: texteForce, ...(blocs ? { answerBlocks: blocs } : {}) }));
        }
        return route.fulfill(json(servie.charge));
      }
      if (chemin === '/api/verebona/conversations' && req.method() === 'GET') {
        return route.fulfill(json({ conversations: historiqueDe
          ? [{ id: CONVERSATION, title: historiqueDe, createdAt: '2026-11-24T09:00:00.000Z', lastMessageAt: '2026-11-24T09:00:05.000Z', messageCount: 2, lastAnswer: reponses.get(historiqueDe)!.texte.slice(0, 80) }]
          : [] }));
      }
      if (chemin === '/api/verebona/conversation' && req.method() === 'GET') {
        // Forme de la route d'historique : le TEXTE enregistré, aucun bloc.
        return route.fulfill(json({ conversationId: CONVERSATION, nextCursor: null, clarification: null, commandPlans: [], messages: [
          { id: 600, role: 'user', content: historiqueDe },
          { id: 601, role: 'assistant', content: reponses.get(historiqueDe!)!.texte, mode: 'ai', intent: 'ACCOUNT_SUMMARY', source_count: 0 },
        ] }));
      }
      if (chemin.startsWith('/api/')) return route.fulfill(json({}));
      // Images de l'application (mascotte) : servies depuis `public/`, comme en production.
      const fichier = resolve(PUBLIC, `.${chemin}`);
      if (fichier.startsWith(`${PUBLIC}/`) && existsSync(fichier) && statSync(fichier).isFile()) {
        const type = /\.webp$/.test(fichier) ? 'image/webp' : /\.png$/.test(fichier) ? 'image/png' : /\.svg$/.test(fichier) ? 'image/svg+xml' : 'application/octet-stream';
        return route.fulfill({ contentType: type, body: readFileSync(fichier) });
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

  async function demander(mobile: boolean, question: string) {
    if (mobile) await page.locator('[data-verebona-field="mobile"]').tap();
    else await page.getByRole('combobox', { name: 'Demander à Verebona' }).click();
    const champ = page.getByRole('combobox', { name: 'Demander à Verebona' });
    await champ.focus();
    await page.keyboard.type(question);
    await page.keyboard.press('Enter');
  }

  const mesurer = (): Promise<BlocMesure[]> => page.evaluate(() => {
    const racine = document.querySelector('[data-answer-blocks]');
    if (!racine) return [];
    return [...racine.children].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        kind: el.getAttribute('data-answer-block') ?? (el.tagName === 'P' ? 'paragraph' : el.tagName === 'H4' ? 'heading' : null), tag: el.tagName,
        text: (el as HTMLElement).innerText, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        items: [...el.querySelectorAll('li')].map((li) => (li as HTMLElement).innerText),
      };
    });
  });
  const deborde = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  const lecture = (blocs: BlocMesure[]) => blocs.map((b) => ({ kind: b.kind, text: nb(b.text), items: b.items.map(nb) }));
  const stable = async () => { await page.waitForSelector('[data-answer-blocks]', { timeout: 10_000 }); await page.waitForTimeout(450); };
  const fin = async (capture: string) => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.getByRole('combobox', { name: 'Demander à Verebona' }).blur();
    // Les images de l'application sont chargées (aucune vignette cassée dans la capture).
    expect(await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')))).toEqual([]);
    await page.screenshot({ path: resolve(CAPTURES, capture) });
  };
  const copie = async () => nb(await page.evaluate(() => {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('[data-answer-blocks]')!);
    sel.addRange(range);
    return sel.toString();
  }));

  /** Trois affirmations = trois paragraphes distincts, dans l'ordre, sans forme forcée. */
  async function verifierTroisAffirmations(largeur: number): Promise<BlocMesure[]> {
    await stable();
    const blocs = await mesurer();
    expect(blocs.map((b) => b.tag)).toEqual(['P', 'P', 'P']);
    expect(blocs.map((b) => nb(b.text))).toEqual([KM, CT, VIDANGE]);
    for (let i = 1; i < blocs.length; i += 1) {
      // Chaque affirmation commence sous la précédente, avec un espace visible : ce n'est plus un bloc unique.
      expect(blocs[i].top, `affirmation ${i + 1}`).toBeGreaterThanOrEqual(blocs[i - 1].bottom + 4);
    }
    for (const b of blocs) {
      expect(b.bottom - b.top).toBeGreaterThan(10);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(largeur);
    }
    expect(await deborde()).toBe(0);
    // Rien n'est forcé sur des phrases : ni chiffre clé, ni liste, ni titre, ni tableau.
    expect(await page.locator('[data-answer-blocks] [data-answer-block]').count()).toBe(0);
    expect(await page.locator('[data-answer-blocks] h4, [data-answer-blocks] ul, [data-answer-blocks] ol, [data-answer-blocks] table').count()).toBe(0);
    // Le montant reste mis en évidence dans son paragraphe ; aucun signe technique.
    expect(nb(await page.locator('[data-answer-blocks] strong').allInnerTexts().then((t) => t.join('|')))).toBe('189,90 €');
    expect(await page.locator('[data-answer-blocks]').innerText()).not.toMatch(/[{}[\]]|"kind"|•|##|\|/);
    // Annoncée au lecteur d'écran, dans la fenêtre de l'Assistant ; ordre de lecture = ordre visuel.
    expect(await page.evaluate(() => {
      const r = document.querySelector('[data-answer-blocks]')!;
      return { annonce: r.closest('[aria-live="polite"]') !== null, dialogue: r.closest('[role="dialog"][aria-label="Verebona"]') !== null };
    })).toEqual({ annonce: true, dialogue: true });
    // Copie : les trois affirmations, dans l'ordre, une seule fois chacune, séparées par un retour à la ligne.
    const c = await copie();
    const positions = [KM, CT, VIDANGE].map((t) => c.indexOf(t));
    expect(positions.every((p) => p >= 0), c).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const t of [KM, CT, VIDANGE]) expect(c.split(t).length - 1).toBe(1);
    expect(c).toMatch(/82 000 km\.\s*\n+\s*Son contrôle/);
    return blocs;
  }

  let blocsMobile: ReturnType<typeof lecture> = [];

  it('IA01 — mobile 390 × 844, réponse IA à trois affirmations : trois paragraphes distincts, rien de forcé, copie dans l’ordre', async () => {
    await ouvrir(true);
    await demander(true, Q_IA);
    const blocs = await verifierTroisAffirmations(IPHONE.width);
    blocsMobile = lecture(blocs);
    expect(recues.map((r) => r.message)).toEqual([Q_IA]);
    await fin('117a-ia-claims-mobile.png');
  });

  it('IA02 — mobile, historique : la conversation rouverte (texte seul, aucun bloc reçu) rend exactement les mêmes paragraphes', async () => {
    await ouvrir(true, { historique: Q_IA });
    await page.locator('[data-verebona-field="mobile"]').tap();
    await page.getByRole('list', { name: 'Recherches récentes' }).getByRole('button', { name: Q_IA, exact: true }).tap();
    expect(lecture(await verifierTroisAffirmations(IPHONE.width))).toEqual(blocsMobile);
    expect(recues).toEqual([]);
  });

  it('IA03 — mobile, rejeu : réseau perdu pendant l’envoi puis rétabli — même identifiant de demande, une seule réponse, mêmes paragraphes', async () => {
    await ouvrir(true, { pannes: 1 });
    await demander(true, Q_IA);
    await expect.poll(() => recues.length, { timeout: 10_000 }).toBe(1);
    await page.getByRole('status').filter({ hasText: /./ }).first().waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-answer-blocks]').count()).toBe(0);
    await ctx.setOffline(false);
    expect(lecture(await verifierTroisAffirmations(IPHONE.width))).toEqual(blocsMobile);
    expect(recues).toHaveLength(2);
    // MÊME identifiant : le serveur reconnaît un rejeu et n'appelle pas le modèle (scénario PostgreSQL C790C-IA Q01).
    expect(recues[1].clientRequestId).toBe(recues[0].clientRequestId);
    expect(await page.locator('[data-answer-blocks]').count()).toBe(1);
  });

  it('IA04 — ordinateur 1280 × 800 : mêmes trois paragraphes distincts', async () => {
    await ouvrir(false);
    await demander(false, Q_IA);
    expect(lecture(await verifierTroisAffirmations(1280))).toEqual(blocsMobile);
    await fin('117a-ia-claims-ordinateur.png');
  });

  it('IA05 — mobile, comparaison (format `comparison`) : le critère, puis une ligne par bien', async () => {
    await ouvrir(true);
    await demander(true, Q_COMPARAISON);
    await stable();
    const blocs = await mesurer();
    expect(blocs.map((b) => b.kind)).toEqual(['paragraph', 'list']);
    expect(nb(blocs[0].text)).toBe('Critère comparé: kilométrage');
    expect(blocs[1].items.map(nb)).toEqual(['Clio: 82 000 km', 'Polo: 131 500 km']);
    expect(blocs[1].top).toBeGreaterThanOrEqual(blocs[0].bottom + 4);
    expect(await page.locator('[data-answer-blocks]').getByRole('list').getByRole('listitem').count()).toBe(2);
    expect(await deborde()).toBe(0);
    await fin('117a-comparaison-mobile.png');
  });

  it('IA06 — mobile, chronologie (format `timeline`) : liste « date · libellé », nommée, dans l’ordre du modèle', async () => {
    await ouvrir(true);
    await demander(true, Q_CHRONOLOGIE);
    const liste = page.getByRole('list', { name: 'Chronologie', exact: true });
    await liste.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(450);
    const lignes = (await liste.getByRole('listitem').allInnerTexts()).map((t) => nb(t).replace(/\s+/g, ' ').trim());
    expect(lignes).toHaveLength(3);
    expect(lignes[0]).toMatch(/2021.*·.*Achat de la Clio$/);
    expect(lignes[1]).toMatch(/2026.*·.*Vidange chez Garage Martin$/);
    expect(lignes[2]).toMatch(/2027.*·.*Contrôle technique$/);
    // La chronologie est présentée UNE fois (par ses événements), pas une seconde fois en texte.
    expect(await page.locator('[data-answer-blocks]').count()).toBe(0);
    const boites = await liste.getByRole('listitem').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; }));
    for (let i = 1; i < boites.length; i += 1) expect(boites[i].top).toBeGreaterThanOrEqual(boites[i - 1].bottom);
    for (const b of boites) expect(b.right).toBeLessThanOrEqual(IPHONE.width);
    expect(await deborde()).toBe(0);
    await page.getByRole('combobox', { name: 'Demander à Verebona' }).blur();
    expect(await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length)).toBe(0);
    await page.screenshot({ path: resolve(CAPTURES, '117a-chronologie-mobile.png') });
  });

  it('IA07 — mobile, question simple : UNE phrase — aucune liste, aucun titre, aucun chiffre clé', async () => {
    await ouvrir(true);
    await demander(true, Q_SIMPLE);
    await stable();
    const blocs = await mesurer();
    expect(blocs.map((b) => b.tag)).toEqual(['P']);
    expect(nb(blocs[0].text)).toBe('Kilométrage de Clio : 82 000 km.');
    expect(await page.locator('[data-answer-blocks] [data-answer-block], [data-answer-blocks] h4, [data-answer-blocks] ul, [data-answer-blocks] table').count()).toBe(0);
    expect(await page.getByRole('group', { name: /Chiffre clé/ }).count()).toBe(0);
    expect(await deborde()).toBe(0);
    await fin('117a-simple-mobile.png');
  });

  it('IA08 — témoin du défaut : les mêmes affirmations recollées par une espace (texte d’avant) rendent UN seul paragraphe', async () => {
    const ancien = [KM, CT, VIDANGE].join(' ');
    await ouvrir(true, { texte: ancien });
    await demander(true, Q_IA);
    await stable();
    const blocs = await mesurer();
    expect(blocs.map((b) => b.tag)).toEqual(['P']);
    expect(nb(blocs[0].text)).toBe(ancien);
  });
});
