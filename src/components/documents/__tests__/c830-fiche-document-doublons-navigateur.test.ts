/**
 * Carte Trello #830 (P2, Pré-MEP) — la fiche d'un document dans un NAVIGATEUR RÉEL (Chromium du dépôt), gabarit
 * MOBILE (iPhone 390 × 844) et ordinateur. Le VRAI tiroir du document (`DocumentDrawer`, le seul composant de tous
 * les chemins d'ouverture) est monté avec sa vraie rubrique « Opérations » et le vrai client d'API ; seules les
 * réponses du serveur sont servies par le test, dans la forme exacte des routes réelles (prouvée par le scénario
 * PostgreSQL `c830-fiche-document-doublons.e2e.ts`).
 *
 *   C830-NAV01  Decathlon, mobile (critère 1) : l'opération « Achat Decathlon » est dans « Opérations (1) » →
 *               le bloc « Événements associés » qui la répète est entièrement absent (titre, carte, bouton, zone,
 *               conteneur vide), n'apparaît jamais, même un instant ; la carte de l'opération reste un vrai lien,
 *               « Retirer » et « Rattacher à une opération » restent ; capture ;
 *   C830-NAV02  Conforama, mobile (critère 2) : reçu d'acompte du 14/11/2026 — sous « Date du document », aucune
 *               ligne de renvoi vers l'opération (ni lien, ni icône, ni espace réservé) ; date, fournisseur,
 *               35,00 € et bien « Maison » présents ; capture ;
 *   C830-NAV03  événement autonome seul, mobile (critère 3) : la carte reste, s'ouvre, se détache ; aucune
 *               vignette « Jalon de l'opération » ni « Événement de référence », même pour le jalon d'une
 *               opération que la fiche n'affiche pas ; « Associer à l'agenda » reste ;
 *   C830-NAV04  cas mixte, mobile (critère 4) : l'événement indépendant reste, le doublon disparaît ;
 *   C830-NAV05  opération SANS événement correspondant, mobile (critère 4) : aucun événement autonome masqué ;
 *   C830-NAV06  document historique, mobile (critère 5) : lien ancien sans provenance, serveur qui ne fournit pas
 *               la correspondance → rien n'est masqué, aucune vignette, aucune ligne de renvoi ;
 *   C830-NAV07  lecture des liens en échec : tous les événements restent affichés (on ne masque que le prouvé) ;
 *   C830-NAV08  réouverture et rafraîchissement (critère 5) : le doublon ne réapparaît pas ; aucune ÉCRITURE
 *               n'est émise par l'affichage ;
 *   C830-NAV09  ordinateur : mêmes règles (Decathlon et Conforama) ; « Retirer » au clavier ; capture.
 *
 * Captures « avant » (code de la branche d'intégration, avant la carte) : rejouer avec `C830_REF_AVANT=<commit>`.
 * Ignoré (skip) quand aucun Chromium n'est installé (CI).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
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
const FIXTURES = resolve(__dirname, 'fixtures');
const CAPTURES = resolve(ROOT, 'docs/exploitation/captures');
const URL = 'http://verebona.test/';
const MOBILE = { width: 390, height: 844 };
/** Commit dont le tiroir sert aux captures « avant » (facultatif). */
const REF_AVANT = (process.env.C830_REF_AVANT ?? '').trim();

interface Lien { itemId: number; direct: boolean; viaGroup: boolean; isMain: boolean; outsideOperation: boolean; representedOperationIds?: number[] }
interface Cas {
  id: number;
  fichier: Record<string, unknown>;
  bien: { id: number; name: string };
  fournisseur: { id: number; name: string } | null;
  evenements: Array<{ id: number; title: string; startDate: string | null }>;
  /** null : la route des liens répond par une erreur. */
  liens: Lien[] | null;
  operations: Array<{ id: number; label: string; hasAgenda: boolean; coverageCount: number; directAgendaItemIds: number[] }>;
}

const fichier = (id: number, o: Record<string, unknown>) => ({
  id, publicId: `pub-${id}`, rubricCode: null, documentTypeCode: null, originalFilename: `document-${id}.pdf`, mimeType: 'application/pdf',
  documentType: 'OTHER', retainedTitle: null, retainedFunctionCode: null, uploadedAt: '2026-11-18T09:12:00.000Z', lastAnalysisAt: '2026-11-18T09:13:00.000Z',
  size: 120_000, supplier: null, amountCents: null, description: null, notes: null, notesUserOwned: false, descriptionSource: null,
  substructureId: null, equipmentId: null, analysisState: 'ANALYZED', processingStatus: null, userEditedFields: null, ...o,
});
const dansOperation = (itemId: number, operationId: number): Lien => ({ itemId, direct: false, viaGroup: true, isMain: true, outsideOperation: false, representedOperationIds: [operationId] });
const autonome = (itemId: number): Lien => ({ itemId, direct: true, viaGroup: false, isMain: false, outsideOperation: true, representedOperationIds: [] });
const operation = (id: number, label: string) => ({ id, label, hasAgenda: true, coverageCount: 0, directAgendaItemIds: [] });

/** Cas réel n° 1 du PO (22/11/2026) : bon de commande Decathlon, vélo, achat répété par un événement. */
const DECATHLON: Cas = {
  id: 101,
  fichier: fichier(101, { displayTitle: 'Bon de commande Decathlon France — 17 novembre 2026', documentDate: '2026-11-17', supplier: 'Decathlon France', amountCents: 54900, assetId: 11, rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_ORDER' }),
  bien: { id: 11, name: 'Vélo Jean Fourche' }, fournisseur: { id: 71, name: 'Decathlon France' },
  evenements: [{ id: 501, title: 'Achat Decathlon', startDate: '2026-11-20' }],
  liens: [dansOperation(501, 9001)],
  operations: [operation(9001, 'Achat Decathlon')],
};
/** Cas réel n° 2 du PO : reçu d'acompte Conforama du 14/11/2026, 35,00 €, bien « Maison ». */
const CONFORAMA: Cas = {
  id: 102,
  fichier: fichier(102, { displayTitle: 'Reçu Acompte CONFORAMA FRANCE SA — 14 novembre 2026', documentDate: '2026-11-14', supplier: 'CONFORAMA FRANCE SA', amountCents: 3500, assetId: 12, rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_PAYMENT' }),
  bien: { id: 12, name: 'Maison' }, fournisseur: { id: 72, name: 'CONFORAMA FRANCE SA' },
  evenements: [{ id: 502, title: 'Achat', startDate: '2026-11-14' }],
  liens: [dansOperation(502, 9002)],
  operations: [operation(9002, 'Achat d’une table de cuisson à induction')],
};
/** Événements autonomes seuls : un lien direct, et le jalon d'une opération que la fiche n'affiche PAS. */
const AUTONOME: Cas = {
  id: 103,
  fichier: fichier(103, { displayTitle: 'Devis de ramonage', documentDate: '2026-10-02', assetId: 12 }),
  bien: { id: 12, name: 'Maison' }, fournisseur: null,
  evenements: [{ id: 503, title: 'Passage du ramoneur', startDate: '2026-12-03' }, { id: 513, title: 'Visite de contrôle', startDate: '2026-12-10' }],
  liens: [autonome(503), { itemId: 513, direct: false, viaGroup: true, isMain: true, outsideOperation: true, representedOperationIds: [] }],
  operations: [],
};
/**
 * Cas mixte : l'événement qui représente l'opération affichée, et un événement indépendant que l'utilisateur a associé
 * par « Associer à l'agenda » (le geste l'a fait rejoindre l'opération en simple membre — il ne porte aucun fait).
 */
const MIXTE: Cas = {
  id: 104,
  fichier: fichier(104, { displayTitle: 'Facture de la chaudière', documentDate: '2026-09-12', assetId: 12 }),
  bien: { id: 12, name: 'Maison' }, fournisseur: null,
  evenements: [{ id: 504, title: 'Pose de la chaudière', startDate: '2026-09-10' }, { id: 505, title: 'Rappel : relever le compteur', startDate: '2026-12-01' }],
  liens: [dansOperation(504, 9004), { itemId: 505, direct: true, viaGroup: false, isMain: false, outsideOperation: false, representedOperationIds: [] }],
  operations: [operation(9004, 'Intervention — Pose de la chaudière')],
};
/** Opération sans événement correspondant : l'événement du document est indépendant. */
const OPERATION_SANS_EVENEMENT: Cas = {
  id: 105,
  fichier: fichier(105, { displayTitle: 'Contrat d’entretien', documentDate: '2026-01-15', assetId: 12 }),
  bien: { id: 12, name: 'Maison' }, fournisseur: null,
  evenements: [{ id: 506, title: 'Visite annuelle', startDate: '2027-01-15' }],
  liens: [autonome(506)],
  operations: [{ ...operation(9005, 'Contrat — Entretien de la chaudière'), hasAgenda: false }],
};
/** Document historique : jamais analysé, lien ancien sans provenance, réponse sans la correspondance (`representedOperationIds` absent). */
const HISTORIQUE: Cas = {
  id: 106,
  fichier: fichier(106, { displayTitle: 'Facture de toiture 2019', documentDate: '2019-03-04', uploadedAt: '2019-03-20T10:00:00.000Z', lastAnalysisAt: null, analysisState: null, assetId: 12 }),
  bien: { id: 12, name: 'Maison' }, fournisseur: null,
  evenements: [{ id: 507, title: 'Réfection de la toiture', startDate: '2019-03-01' }],
  liens: [{ itemId: 507, direct: true, viaGroup: false, isMain: false, outsideOperation: true }],
  operations: [],
};
const CAS = [DECATHLON, CONFORAMA, AUTONOME, MIXTE, OPERATION_SANS_EVENEMENT, HISTORIQUE];

const INTERDITS = ['Événements associés', 'Jalon de l’opération', 'Événement de référence', 'Voir l’opération', 'Voir l’événement de référence'];
const TECHNIQUE = /Jalon de l.op[ée]ration|[ÉE]v[ée]nement de r[ée]f[ée]rence|Voir l.op[ée]ration|Voir l.[ée]v[ée]nement/i;

/** Construit le harnais ; `ref` : le tiroir et sa rubrique « Opérations » sont lus dans ce commit (captures « avant »). */
async function construire(ref: string | null): Promise<string> {
  const esbuild = await import('esbuild');
  const anciens = ['src/components/assets/DocumentDrawer.tsx', 'src/components/documents/DocumentOperations.tsx'];
  const out = await esbuild.build({
    entryPoints: [resolve(FIXTURES, 'c830-tiroir-document-harness.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'silent',
    alias: {
      '@': resolve(ROOT, 'src'), 'next/link': resolve(FIXTURES, 'c830-next-stubs.tsx'),
      'next/image': resolve(FIXTURES, 'c830-next-image-stub.tsx'), 'next/dynamic': resolve(FIXTURES, 'c830-next-dynamic-stub.tsx'),
    },
    define: { 'process.env.NODE_ENV': '"development"' },
    banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
    tsconfig: resolve(ROOT, 'tsconfig.json'),
    plugins: ref ? [{
      name: 'c830-avant',
      setup(b) {
        b.onLoad({ filter: /(DocumentDrawer|DocumentOperations)\.tsx$/ }, (args) => {
          const rel = relative(ROOT, args.path).split('\\').join('/');
          if (!anciens.includes(rel)) return null;
          return { contents: execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }), loader: 'tsx', resolveDir: resolve(args.path, '..') };
        });
      },
    }] : [],
  });
  return out.outputFiles[0].text;
}

describe.skipIf(!EXE)('C830 — fiche du document : ni doublon événement / opération, ni vignette technique, ni ligne de renvoi (navigateur réel)', () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let bundle = '';
  let bundleAvant = '';
  let css = '';
  /** Requêtes d'ÉCRITURE émises par la page (aucune n'est attendue de l'affichage). */
  let ecritures: string[] = [];
  let lecturesLiens = 0;
  let erreurs: string[] = [];

  beforeAll(async () => {
    bundle = await construire(null);
    if (REF_AVANT) bundleAvant = await construire(REF_AVANT);
    const { compile } = await import('@tailwindcss/node');
    const { Scanner } = await import('@tailwindcss/oxide');
    const compiler = await compile(readFileSync(resolve(ROOT, 'src/app/globals.css'), 'utf8'), { base: resolve(ROOT, 'src/app'), onDependency: () => {} });
    const sources = [
      'src/components/ui/sheet.tsx', 'src/components/ui/button.tsx', 'src/components/ui/input.tsx', 'src/components/ui/alert-dialog.tsx', 'src/components/ui/separator.tsx',
      'src/components/ui/footer-primary-action.tsx', 'src/components/drawers/EntityCard.tsx', 'src/components/agenda/AgendaGroupingPanel.tsx',
      'src/components/documents/DocumentOperations.tsx', 'src/components/documents/BusinessPeriods.tsx', 'src/components/documents/DocumentTypeBadge.tsx',
      'src/components/documents/targets/DocumentTargetsSummary.tsx', 'src/components/assets/DocumentSupplierField.tsx', 'src/components/assets/DocumentDrawer.tsx',
    ].filter((f) => existsSync(resolve(ROOT, f)));
    css = compiler.build(new Scanner({}).scanFiles(sources.map((f) => ({ content: readFileSync(resolve(ROOT, f), 'utf8'), extension: 'tsx' }))));
    const { chromium: pw } = await import('playwright-core');
    browser = await pw.launch({ executablePath: EXE! });
    mkdirSync(CAPTURES, { recursive: true });
  }, 300_000);
  afterAll(async () => { await browser?.close(); });

  async function ouvrir(mobile: boolean, cas: Cas, o: { avant?: boolean } = {}) {
    await ctx?.close();
    ecritures = [];
    lecturesLiens = 0;
    erreurs = [];
    ctx = await browser.newContext(mobile
      ? { viewport: MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'fr-FR', timezoneId: 'Europe/Paris' }
      : { viewport: { width: 1280, height: 800 }, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
    page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const req = route.request();
      const u = req.url();
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-cache' }, body: JSON.stringify(body) });
      if (u === URL || u.startsWith(`${URL}#`)) {
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>` });
      }
      if (u === `${URL}harness.js`) return route.fulfill({ contentType: 'text/javascript', body: o.avant ? bundleAvant : bundle });
      const chemin = u.slice(URL.length - 1).split('?')[0];
      if (req.method() !== 'GET') { ecritures.push(`${req.method()} ${chemin}`); return json({ error: 'refusé par le test' }, 409); }
      const c = cas;
      if (chemin === `/api/files/${c.id}`) return json(c.fichier);
      if (chemin === '/api/assets') return json({ data: CAS.map((x) => ({ id: x.bien.id, name: x.bien.name, category: 'MOBILIER' })) });
      if (chemin === `/api/documents/${c.id}/analysis-proposals`) return json({ proposals: [] });
      if (chemin === '/api/agenda') return json({ items: cas.evenements });
      if (chemin === `/api/documents/${c.id}/targets`) {
        return json({ targets: { assets: [{ id: c.bien.id, name: c.bien.name, assetId: c.bien.id, provenance: 'AI', principal: true, implied: false }], rooms: [], equipments: [] } });
      }
      if (chemin === `/api/documents/${c.id}/periodes`) return json({ periods: { documentId: c.id, principal: null, secondary: [], coverageHistories: [] } });
      if (chemin === `/api/documents/${c.id}/supplier`) return json({ suppliers: c.fournisseur ? [c.fournisseur] : [] });
      if (chemin === `/api/documents/${c.id}/agenda-liens`) {
        lecturesLiens += 1;
        return c.liens ? json({ links: c.liens }) : json({ error: 'Internal server error' }, 500);
      }
      if (chemin === `/api/documents/${c.id}/evenements-reference`) return json({ references: c.operations });
      const evenement = /^\/api\/agenda\/(\d+)$/.exec(chemin);
      if (evenement) return json({ item: { id: Number(evenement[1]), title: 'événement', fileLinks: [] } });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' });
    });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(URL);
    await page.addScriptTag({ url: `${URL}harness.js` });
    await page.evaluate((m) => window.__830Surveiller(m), INTERDITS);
    await monter(cas);
  }
  const monter = async (cas: Cas) => {
    await page.evaluate((d) => window.__830Monter(d), { id: cas.id, originalFilename: `document-${cas.id}.pdf`, mimeType: 'application/pdf', documentType: 'OTHER', assetId: cas.bien.id });
    await page.getByTestId('document-operations').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('document-supplier-field').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(500);
  };
  const tiroir = () => page.locator('[role="dialog"]').first();
  const texte = () => tiroir().innerText();
  const vus = () => page.evaluate(() => window.__830Vus);
  const deborde = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  const capturer = async (nom: string, repere: string) => {
    await page.getByText(repere, { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    // L'anneau de focus posé par l'ouverture du tiroir n'est pas l'objet de la capture.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(CAPTURES, nom) });
  };
  /** Géométrie de la rubrique « Opérations » et de ce qui la précède (aucun conteneur vide, aucun espace résiduel). */
  const avantOperations = () => page.getByTestId('document-operations').evaluate((el) => {
    const parent = el.parentElement!;
    const enfants = [...parent.children] as HTMLElement[];
    const prec = el.previousElementSibling as HTMLElement | null;
    return {
      vides: enfants.filter((e) => e.getBoundingClientRect().height === 0 || !(e.innerText ?? '').trim()).map((e) => e.outerHTML.slice(0, 80)),
      precedent: (prec?.innerText ?? '').trim().slice(0, 60),
      ecart: prec ? Math.round(el.getBoundingClientRect().top - prec.getBoundingClientRect().bottom) : -1,
    };
  });
  /** Lignes du bloc « Informations » autour de « Date du document » : ordre, écarts verticaux, liens. */
  const autourDeLaDate = () => page.getByTestId('document-detail-document-date').evaluate((el) => {
    const lignes = [...el.parentElement!.children] as HTMLElement[];
    const i = lignes.indexOf(el as HTMLElement);
    const ecart = (a: HTMLElement, b: HTMLElement) => Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
    return {
      suivante: lignes[i + 1]?.getAttribute('data-testid') ?? null,
      ecartApres: lignes[i + 1] ? ecart(lignes[i], lignes[i + 1]) : null,
      ecartAvant: i > 0 ? ecart(lignes[i - 1], lignes[i]) : null,
      liensDansLaLigne: el.querySelectorAll('a, button, svg + a').length,
      texte: (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
    };
  });

  it('C830-NAV01 — Decathlon, mobile : l’achat est dans « Opérations (1) » → aucun bloc « Événements associés » (titre, carte, bouton, espace) ; la carte de l’opération reste accessible', async () => {
    if (REF_AVANT) {
      await ouvrir(true, DECATHLON, { avant: true });
      // Témoin de l'état d'avant : l'achat est montré deux fois, avec sa vignette technique.
      const avant = await texte();
      expect(avant).toContain('Événements associés');
      expect(avant).toContain('Jalon de l’opération');
      expect(avant).toContain('Opérations (1)');
      await capturer('117e-decathlon-mobile-avant.png', 'Informations');
    }
    await ouvrir(true, DECATHLON);
    expect(erreurs).toEqual([]);
    const t = await texte();
    expect(t).toContain('Bon de commande Decathlon France — 17 novembre 2026');
    expect(t).toContain('Opérations (1)');
    expect(t).not.toContain('Événements associés');
    expect(t).not.toMatch(TECHNIQUE);
    expect(t).not.toContain('Associer à l’agenda');
    // L'achat n'est nommé qu'UNE fois dans la fiche : par la carte de l'opération.
    expect(t.match(/Achat Decathlon/g)?.length).toBe(1);
    expect(await page.getByTestId('document-relier-agenda').count()).toBe(0);
    expect(await page.getByTestId('document-relier-agenda-zone').count()).toBe(0);
    expect(await page.locator('[data-testid^="document-detacher-agenda-"]').count()).toBe(0);
    // Ni conteneur vide, ni espace résiduel : la rubrique « Opérations » suit directement la rubrique précédente.
    const g = await avantOperations();
    expect(g.vides).toEqual([]);
    expect(g.precedent).not.toBe('');
    expect(g.ecart).toBeLessThanOrEqual(16);
    // Jamais, même un instant, depuis l'ouverture.
    expect(await vus()).toEqual([]);
    // La carte de l'opération : un vrai lien vers sa fiche, « Retirer » et « Rattacher » présents, cibles de 44 px.
    const lien = page.getByRole('link', { name: 'Ouvrir l’opération « Achat Decathlon »' });
    expect(await lien.getAttribute('href')).toBe('/agenda/evenements-reference/9001');
    await lien.tap();
    expect(await page.evaluate(() => window.__830Liens)).toEqual(['/agenda/evenements-reference/9001']);
    const retirer = page.getByTestId('document-operation-retirer-9001');
    expect((await retirer.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.getByTestId('document-operation-rattacher').count()).toBe(1);
    expect(await deborde()).toBe(0);
    expect(ecritures).toEqual([]);
    await capturer('117e-decathlon-mobile.png', 'Informations');
  });

  it('C830-NAV02 — Conforama, mobile : sous « Date du document », aucune ligne de renvoi (lien, icône, espace) ; date, fournisseur, 35,00 € et bien « Maison » inchangés', async () => {
    if (REF_AVANT) {
      await ouvrir(true, CONFORAMA, { avant: true });
      await capturer('117e-conforama-mobile-avant.png', 'Informations');
    }
    await ouvrir(true, CONFORAMA);
    expect(erreurs).toEqual([]);
    const t = await texte();
    expect(t).toContain('Reçu Acompte CONFORAMA FRANCE SA — 14 novembre 2026');
    expect(t).not.toMatch(TECHNIQUE);
    // La date du document, telle quelle ; rien d'autre dans sa ligne.
    const d = await autourDeLaDate();
    expect(d.texte).toBe('Date du document 14 novembre 2026');
    expect(d.liensDansLaLigne).toBe(0);
    // La ligne suivante est « Date d'ajout » : aucune ligne intercalée, aucun espace réservé (même écart qu'entre les autres lignes).
    expect(d.suivante).toBe('document-detail-added-date');
    expect(d.ecartApres).toBe(d.ecartAvant);
    expect(await page.getByTestId('document-reference-events').count()).toBe(0);
    // Le seul lien vers une opération est la carte de la rubrique « Opérations ».
    expect(await page.locator('[data-reference-event-open]').count()).toBe(1);
    expect(await page.getByTestId('document-operations').locator('[data-reference-event-open]').count()).toBe(1);
    // Fournisseur, montant et bien.
    expect((await page.getByTestId('document-supplier-field').textContent()) ?? '').toContain('CONFORAMA FRANCE SA');
    expect(t).toMatch(/Montant\s+35,00\s€/);
    expect(t).toContain('Maison');
    expect(t).toMatch(/Type\s+Justificatif de paiement/);
    expect(t).toContain('Date d’ajout');
    // L'événement « Achat » est porté par l'opération affichée : il n'est pas répété (règle A), et n'a jamais paru.
    expect(t).toContain('Opérations (1)');
    expect(t).toContain('Achat d’une table de cuisson à induction');
    expect(t).not.toContain('Événements associés');
    expect(await vus()).toEqual([]);
    expect(await deborde()).toBe(0);
    expect(ecritures).toEqual([]);
    await capturer('117e-conforama-mobile.png', 'Informations');
  });

  it('C830-NAV03 — événement autonome seul, mobile : la carte reste, s’ouvre et se détache ; aucune vignette technique ; « Associer à l’agenda » reste', async () => {
    await ouvrir(true, AUTONOME);
    expect(erreurs).toEqual([]);
    const t = await texte();
    expect(t).toContain('Événements associés');
    expect(t).toContain('Passage du ramoneur');
    expect(t).toContain('3 décembre 2026');
    // Jalon d'une opération que la fiche n'affiche pas : l'événement reste, SANS vignette.
    expect(t).toContain('Visite de contrôle');
    expect(t).not.toMatch(TECHNIQUE);
    expect((await vus()).filter((m) => m !== 'Événements associés')).toEqual([]);
    // Interactions conservées : ouvrir (le tiroir de l'événement est demandé), détacher (cible de 44 px), associer.
    await page.getByRole('link', { name: /Passage du ramoneur/ }).tap();
    await page.getByTestId('c830-tiroir-evenement').waitFor({ state: 'attached', timeout: 10_000 });
    expect(await page.getByTestId('c830-tiroir-evenement').getAttribute('data-item')).toBe('503');
    const detacher = page.getByTestId('document-detacher-agenda-503');
    expect((await detacher.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await detacher.getAttribute('aria-label')).toBe('Retirer l’association avec « Passage du ramoneur »');
    expect(await page.getByTestId('document-detacher-agenda-513').count()).toBe(1);
    expect(await page.getByTestId('document-relier-agenda').innerText()).toContain('Associer à l’agenda');
    expect(await deborde()).toBe(0);
    // Ouvrir une carte ne fait que LIRE.
    expect(ecritures).toEqual([]);
  });

  it('C830-NAV04 — cas mixte, mobile : l’événement indépendant reste ; le doublon de l’opération affichée disparaît', async () => {
    await ouvrir(true, MIXTE);
    expect(erreurs).toEqual([]);
    const t = await texte();
    expect(t).toContain('Événements associés');
    expect(t).toContain('Rappel : relever le compteur');
    expect(await page.getByTestId('document-detacher-agenda-505').count()).toBe(1);
    expect(await page.getByTestId('document-detacher-agenda-504').count()).toBe(0);
    // « Pose de la chaudière » n'est plus nommée que par la carte de son opération.
    expect(t.match(/Pose de la chaudière/g)?.length).toBe(1);
    expect(t).toContain('Opérations (1)');
    expect(await page.getByTestId('document-relier-agenda').count()).toBe(1);
    expect(t).not.toMatch(TECHNIQUE);
    expect((await vus()).filter((m) => m !== 'Événements associés')).toEqual([]);
  });

  it('C830-NAV05 — opération sans événement correspondant, mobile : aucun événement autonome n’est masqué', async () => {
    await ouvrir(true, OPERATION_SANS_EVENEMENT);
    expect(erreurs).toEqual([]);
    const t = await texte();
    expect(t).toContain('Opérations (1)');
    expect(t).toContain('Contrat — Entretien de la chaudière');
    expect(t).toContain('Événements associés');
    expect(t).toContain('Visite annuelle');
    expect(await page.getByTestId('document-detacher-agenda-506').count()).toBe(1);
    expect(await page.getByTestId('document-relier-agenda').count()).toBe(1);
    expect(t).not.toMatch(TECHNIQUE);
  });

  it('C830-NAV06 — document historique, mobile : lien ancien, correspondance non fournie → rien n’est masqué, aucune vignette, aucune ligne de renvoi', async () => {
    await ouvrir(true, HISTORIQUE);
    expect(erreurs).toEqual([]);
    const t = await texte();
    expect(t).toContain('Facture de toiture 2019');
    expect(t).toContain('Événements associés');
    expect(t).toContain('Réfection de la toiture');
    expect(t).not.toMatch(TECHNIQUE);
    const d = await autourDeLaDate();
    expect(d.texte).toBe('Date du document 4 mars 2019');
    expect(d.suivante).toBe('document-detail-added-date');
    expect(d.ecartApres).toBe(d.ecartAvant);
    expect(await page.locator('[data-reference-event-open]').count()).toBe(0);
    expect(t).toContain('Ce document n’appartient à aucune opération.');
    expect(await page.getByTestId('document-relier-agenda').count()).toBe(1);
  });

  it('C830-NAV07 — lecture des liens en échec : tous les événements restent affichés (on ne masque que ce qui est prouvé)', async () => {
    await ouvrir(true, { ...DECATHLON, liens: null });
    expect(erreurs).toEqual([]);
    await page.getByText('Événements associés', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    const t = await texte();
    expect(t.match(/Achat Decathlon/g)?.length).toBe(2);
    expect(t).toContain('Opérations (1)');
    expect(t).not.toMatch(TECHNIQUE);
    expect(await page.getByTestId('document-relier-agenda').count()).toBe(1);
  });

  it('C830-NAV08 — réouverture et rafraîchissement : le doublon ne réapparaît pas ; l’affichage n’émet aucune écriture', async () => {
    await ouvrir(true, DECATHLON);
    expect(await texte()).not.toContain('Événements associés');
    const premieres = lecturesLiens;
    expect(premieres).toBeGreaterThanOrEqual(1);
    // Tiroir resté ouvert : le signal de rafraîchissement de l'application relit le serveur.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('agenda-mutated')));
    await page.waitForTimeout(700);
    expect(lecturesLiens).toBeGreaterThan(premieres);
    expect(await texte()).not.toContain('Événements associés');
    expect(await texte()).toContain('Opérations (1)');
    // Fermeture puis réouverture (nouveau montage), sans recharger la page.
    await page.evaluate(() => window.__830Fermer());
    const avantReouverture = lecturesLiens;
    await monter(DECATHLON);
    expect(lecturesLiens).toBeGreaterThan(avantReouverture);
    const t = await texte();
    expect(t).not.toContain('Événements associés');
    expect(t).not.toContain('Associer à l’agenda');
    expect(t).toContain('Opérations (1)');
    // Rechargement complet de la page.
    await page.reload();
    await page.addScriptTag({ url: `${URL}harness.js` });
    await page.evaluate((m) => window.__830Surveiller(m), INTERDITS);
    await monter(DECATHLON);
    expect(await texte()).not.toContain('Événements associés');
    expect(await vus()).toEqual([]);
    // Rien n'est gardé dans le navigateur pour cette règle.
    const stocke = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => /agenda-liens|evenements-reference|doublon/i.test(k)));
    expect(stocke).toEqual([]);
    expect(ecritures).toEqual([]);
  });

  it('C830-NAV09 — ordinateur : mêmes règles (Decathlon, Conforama) ; « Retirer » au clavier', async () => {
    if (REF_AVANT) {
      await ouvrir(false, DECATHLON, { avant: true });
      await capturer('117e-decathlon-ordinateur-avant.png', 'Informations');
    }
    await ouvrir(false, DECATHLON);
    expect(erreurs).toEqual([]);
    let t = await texte();
    expect(t).toContain('Opérations (1)');
    expect(t).not.toContain('Événements associés');
    expect(t).not.toContain('Associer à l’agenda');
    expect(t).not.toMatch(TECHNIQUE);
    expect(t.match(/Achat Decathlon/g)?.length).toBe(1);
    expect(await vus()).toEqual([]);
    const g = await avantOperations();
    expect(g.vides).toEqual([]);
    expect(g.ecart).toBeLessThanOrEqual(16);
    // « Retirer » reste atteignable au clavier ; la fenêtre de confirmation s'ouvre, « Annuler » n'écrit rien.
    await page.getByTestId('document-operation-retirer-9001').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('document-operation-retrait').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Annuler' }).click();
    expect(ecritures).toEqual([]);
    expect(await deborde()).toBe(0);
    await capturer('117e-decathlon-ordinateur.png', 'Informations');

    await ouvrir(false, CONFORAMA);
    expect(erreurs).toEqual([]);
    t = await texte();
    const d = await autourDeLaDate();
    expect(d.texte).toBe('Date du document 14 novembre 2026');
    expect(d.suivante).toBe('document-detail-added-date');
    expect(d.ecartApres).toBe(d.ecartAvant);
    expect(t).toMatch(/Montant\s+35,00\s€/);
    expect(t).toContain('Maison');
    expect(t).not.toMatch(TECHNIQUE);
    expect(t).not.toContain('Événements associés');
    expect(await page.locator('[data-reference-event-open]').count()).toBe(1);
    await capturer('117e-conforama-ordinateur.png', 'Informations');
  });
});
