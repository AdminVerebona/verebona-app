/**
 * Intégration : rendu RÉEL d'un dossier en PDF avec Chromium (Playwright) et
 * apposition des annexes (pdf-lib), puis lecture du texte du PDF (pdf.js).
 *
 * Vérifie sur le PDF produit :
 *   · pages > 0, mention de pied « Ce dossier a été préparé avec Verebona. »
 *     et « Page X / Y » sur CHAQUE page, couverture comprise (PDF-TXT-008/009) ;
 *   · annexes : la page A1 commence où l'index l'annonce, chaque page source
 *     est apposée en vectoriel (son texte est extractible), bannière
 *     « Page n / N du document » (ANN-PDF-001 à 005) ; image annexée ;
 *   · exclusions : PDF illisible, PDF chiffré et bombe de décompression
 *     exclus partout, génération partielle (SEL-GEN-006, ALT-004) ;
 *   · textes très longs / injection dans l'en-tête : pagination intacte,
 *     aucune sortie de la chaîne CSS ;
 *   · page « Références » qui déborderait : détectée (RENDER_ERROR) ;
 *   · isolement : un fichier local hors des répertoires autorisés n'est
 *     jamais chargé par Chromium ;
 *   · sinistre et kit de vente alimentés par les listes structurées des
 *     informations complémentaires (dommages, actions, échanges, points
 *     forts) : contenu présent dans le PDF, renvois d'annexes, pied partout.
 *     `EXPORTS_RENDER_OUT=<dossier>` y enregistre les deux PDF (aperçus) ;
 *     `EXPORTS_RENDER_PHOTO=<image>` remplace les photos unies par une vraie.
 *
 * Ignoré proprement sans Chromium : `EXPORTS_CHROMIUM_TESTS=0`, ou binaire
 * introuvable (`CHROMIUM_EXECUTABLE_PATH`, `PLAYWRIGHT_BROWSERS_PATH`,
 * ou `/opt/pw-browsers` s'il existe).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { makeSource, doc, photo, event, TODAY } from './fixtures/sources';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && !process.env.CHROMIUM_EXECUTABLE_PATH && fs.existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

const { isChromiumAvailable, closeBrowser } = await import('../render/browser');
const enabled = process.env.EXPORTS_CHROMIUM_TESTS !== '0' && (await isChromiumAvailable());

async function pdfText(bytes: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), useSystemFonts: false,
    standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
  });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' ').normalize('NFKC').replace(/[  ]/g, ' ').replace(/\s+/g, ' '));
  }
  await pdf.destroy();
  return pages;
}

describe.skipIf(!enabled)('Rendu Chromium d’un dossier complet (intégration)', () => {
  let dir: string;
  const files: Record<string, string> = {};

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v12-it-'));
    const src = await PDFDocument.create();
    const font = await src.embedFont(StandardFonts.Helvetica);
    src.addPage([595, 842]).drawText('SOURCE PAGE UN', { x: 60, y: 760, size: 22, font });
    src.addPage([842, 595]).drawText('SOURCE PAGE DEUX', { x: 60, y: 520, size: 22, font });
    fs.writeFileSync(files.dpe = path.join(dir, 'dpe.pdf'), await src.save());
    fs.writeFileSync(files.broken = path.join(dir, 'broken.pdf'), '%PDF-1.7\nceci n’est pas un PDF');
    const enc = await PDFDocument.create();
    enc.addPage();
    enc.context.trailerInfo.Encrypt = enc.context.obj({ Filter: 'Standard', V: 2 });
    fs.writeFileSync(files.encrypted = path.join(dir, 'enc.pdf'), await enc.save());
    // Bombe de décompression : ~64 Ko compressés → 96 Mo de contenu de page.
    const bomb = await PDFDocument.create();
    const bombPage = bomb.addPage([595, 842]);
    const inflated = zlib.deflateSync(Buffer.alloc(96 * 1024 * 1024, 0x20), { level: 9 });
    bombPage.node.set(PDFName.of('Contents'), bomb.context.register(bomb.context.stream(inflated, { Filter: 'FlateDecode' })));
    fs.writeFileSync(files.bomb = path.join(dir, 'bomb.pdf'), await bomb.save());
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 40, g: 90, b: 160 } } }).png().toFile(files.plan = path.join(dir, 'plan.png'));
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 180, b: 150 } } }).jpeg().toFile(files.photo = path.join(dir, 'photo.jpg'));
  }, 60_000);

  afterAll(async () => {
    await closeBrowser('fin des tests');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('PDF paginé, pied et « Page X / Y » partout, annexes apposées, exclusions partielles', async () => {
    const { renderDossier } = await import('../render/render-dossier');
    const { parseChoicesPayload } = await import('../data/choices');
    const source = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      documents: [
        doc({ id: 1, kind: 'DPE', title: 'Diagnostic de performance énergétique', s3Key: 'dpe' }),
        doc({ id: 2, kind: 'PLAN_CONSTRUCTION', title: 'Plan du logement', format: 'PNG', mimeType: 'image/png', s3Key: 'plan', fileName: 'plan.png' }),
        doc({ id: 3, kind: 'FACTURE', title: 'Facture illisible', s3Key: 'broken' }),
        doc({ id: 4, kind: 'GARANTIE', title: 'Garantie protégée', s3Key: 'encrypted' }),
        doc({ id: 5, kind: 'FACTURE', title: 'Facture introuvable', s3Key: 'absent' }),
        doc({ id: 6, kind: 'FACTURE', title: 'Facture piégée', s3Key: 'bomb' }),
      ],
      photos: [photo(1, { s3Key: 'photo' }), photo(2, { s3Key: 'photo' })],
    });
    const parsed = parseChoicesPayload('DOSSIER_COMPLET', {
      outputFormat: 'PDF',
      items: [1, 2, 3, 4, 5, 6].map((id) => ({ sourceType: 'document', sourceId: id, selected: true, mode: 'PDF' }))
        .concat([1, 2].map((id) => ({ sourceType: 'photo', sourceId: id, selected: true, mode: 'PDF' }))),
    });
    if (!parsed.ok) throw new Error('payload');
    const workDir = fs.mkdtempSync(path.join(dir, 'work-'));
    const fetchToFile = async (key: string, _b: string | null, dest: string) => {
      if (!files[key]) return false;
      fs.copyFileSync(files[key], dest);
      return true;
    };

    const r = await renderDossier({
      code: 'DOSSIER_COMPLET', source, choices: parsed.choices, today: TODAY, workDir, fetchToFile, timeoutMs: 90_000,
      meta: { reference: 'VBN-TEST-000001', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Claire Martin' },
    });

    const pages = await pdfText(r.pdf);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.length).toBe(r.pageCount);
    pages.forEach((t, i) => {
      expect(t, `page ${i + 1}`).toContain('Ce dossier a été préparé avec Verebona.');
      expect(t.replace(/\s/g, ''), `page ${i + 1}`).toContain(`Page${i + 1}/${pages.length}`);
    });

    // Annexes : A1 (PDF, 2 pages) puis A2 (image), avant la page Références.
    const n = pages.length;
    expect(pages[n - 1]).toContain('Méthode, sources et limites');
    const a1 = n - 1 - 3; // index 0-based de la 1re page de A1
    expect(pages[a1]).toContain('A1');
    expect(pages[a1]).toContain('Page 1 / 2 du document');
    expect(pages[a1]).toContain('SOURCE PAGE UN'); // page source apposée en vectoriel
    expect(pages[a1 + 1]).toContain('SOURCE PAGE DEUX');
    expect(pages[a1 + 2]).toContain('A2');
    expect(pages[a1 + 2]).toContain('Plan du logement');
    // L'index annonce les vrais numéros de page (deux passes).
    const all = pages.join(' ');
    expect(all).toContain(`p. ${a1 + 1}–${a1 + 2}`);
    expect(all).toContain(`p. ${a1 + 3}`);
    // Couverture : « Page 1 / N ».
    expect(pages[0].replace(/\s/g, '')).toContain(`Page1/${n}`);

    // Exclusions : illisible, chiffré, absent → absents partout, génération partielle.
    for (const t of ['Facture illisible', 'Garantie protégée', 'Facture introuvable', 'Facture piégée']) expect(all).not.toContain(t);
    expect(r.partial).toBe(true);
    const reasons = Object.fromEntries(r.items.filter((i) => i.status === 'excluded').map((i) => [i.sourceId, i.reason]));
    expect(reasons).toEqual({ 3: 'corrupted', 4: 'protected', 5: 'missing', 6: 'corrupted' });
    expect(r.counts).toMatchObject({ integratedPdf: 2, photos: 2 });
  }, 120_000);

  it('textes très longs et injection dans l’en-tête : pagination et index intacts', async () => {
    const { renderDossier } = await import('../render/render-dossier');
    const { parseChoicesPayload } = await import('../data/choices');
    const injected = 'Maison"; } @page { @top-left { content: url(file:///etc/hostname) } } </style><h1>INJECTE</h1>\n\r\f\0 fin';
    const source = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      asset: { ...makeSource('IMMOBILIER', 'DOSSIER_COMPLET').asset, name: injected + ' ' + 'très long '.repeat(40) },
      documents: [doc({ id: 1, kind: 'DPE', title: 'Diagnostic '.repeat(300), s3Key: 'dpe' })],
    });
    const parsed = parseChoicesPayload('DOSSIER_COMPLET', {
      outputFormat: 'PDF', items: [{ sourceType: 'document', sourceId: 1, selected: true, mode: 'PDF' }],
    });
    if (!parsed.ok) throw new Error('payload');
    const workDir = fs.mkdtempSync(path.join(dir, 'work-'));
    const r = await renderDossier({
      code: 'DOSSIER_COMPLET', source, choices: parsed.choices, today: TODAY, workDir, timeoutMs: 90_000,
      fetchToFile: async (key, _b, dest) => { fs.copyFileSync(files[key], dest); return true; },
      meta: { reference: 'VBN-TEST-000002', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Claire '.repeat(200) },
    });
    const pages = await pdfText(r.pdf);
    const n = pages.length;
    pages.forEach((t, i) => expect(t.replace(/\s/g, ''), `page ${i + 1}`).toContain(`Page${i + 1}/${n}`));
    expect(pages[n - 1]).toContain('Méthode, sources et limites');
    expect(pages[n - 3]).toContain('SOURCE PAGE UN');
    expect(pages[n - 2]).toContain('SOURCE PAGE DEUX');
    expect(pages.join(' ')).toContain(`p. ${n - 2}–${n - 1}`);
    // La chaîne injectée reste du texte : pas de balise interprétée, pas de fichier local.
    expect(pages.join(' ')).not.toMatch(/^INJECTE$/m);
    const header = fs.readFileSync(path.join(workDir, 'index.html'), 'utf8').match(/@top-right \{ content: ("(?:[^"\\]|\\.)*");/)?.[1] ?? '';
    expect(header).toMatch(/^"Dossier complet · Maison\\22 \\3B  \\7D  @page /);
    expect(header.slice(1, -1)).not.toMatch(/["(){};<>\n]/);
  }, 120_000);

  it('page « Références » trop longue : débordement détecté (RENDER_ERROR)', async () => {
    const { printDossier } = await import('../render/render-pdf');
    const { References, htmlDocument, pageSetup } = await import('../html/components');
    const { staticBaseUrl, stylesheetUrls } = await import('../static-assets');
    const sys = staticBaseUrl();
    const refs = References({
      sys, title: 'Sources et limites',
      exportInfo: { type: 'X', label: 'X', reference: 'R', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'A', templateVersion: 'x', zipName: null },
      paragraphs: Array.from({ length: 12 }, () => 'Texte très long. '.repeat(60)),
    });
    const workDir = fs.mkdtempSync(path.join(dir, 'work-'));
    await expect(printDossier({
      workDir, annexes: [], timeoutMs: 60_000,
      build: () => ({ title: 't', html: htmlDocument({ title: 't', stylesheets: stylesheetUrls(sys), head: pageSetup({ headerLabel: 'x' }), body: `<section class="cover-sheet">c</section>${refs}` }) }),
    })).rejects.toMatchObject({ code: 'RENDER_ERROR', message: expect.stringContaining('Références') });
  }, 60_000);

  it('isolement : un fichier local hors des répertoires autorisés n’est jamais chargé', async () => {
    const { printDossier } = await import('../render/render-pdf');
    const { pathToFileURL } = await import('node:url');
    const { RENDER_ORIGIN, workFileUrl } = await import('../static-assets');
    const workDir = fs.mkdtempSync(path.join(dir, 'work-'));
    // Trois images distinctes (largeurs 1200 / 1000 / 900) pour savoir laquelle a été chargée.
    const inside = path.join(workDir, 'dedans.jpg');
    const insideFile = path.join(workDir, 'dedans-file.jpg');
    const outside = path.join(dir, 'dehors.jpg');
    fs.copyFileSync(files.photo, inside);
    await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toFile(insideFile);
    await sharp({ create: { width: 1000, height: 700, channels: 3, background: { r: 90, g: 20, b: 30 } } }).jpeg().toFile(outside);
    const img = (src: string) => `<img src="${src}" width="120">`;
    const body = `<div style="break-after:page">couverture</div><section class="refs">${[
      workFileUrl(workDir, inside), // seul fichier autorisé
      pathToFileURL(outside).href, // file:// hors racine
      pathToFileURL(insideFile).href, // file:// même dans la racine : jamais depuis l'origine https
      `${RENDER_ORIGIN}/work/..%2Fdehors.jpg`, // sortie de racine encodée
      `${RENDER_ORIGIN}/static/../work/../../dehors.jpg`,
      `https://example.com/x.jpg`, // réseau
    ].map(img).join('')}</section>`;
    const printed = await printDossier({ workDir, annexes: [], timeoutMs: 60_000, build: () => ({ title: 't', html: `<!doctype html><html><body>${body}</body></html>` }) });
    const pdf = await PDFDocument.load(printed.pdf);
    const images = pdf.context.enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    // (Chromium dessine une icône « image manquante » pour les refus : on compare les largeurs.)
    const widths = images.map(([, o]) => (o as PDFRawStream).dict.get(PDFName.of('Width'))?.toString());
    expect(widths).toContain('1200');
    expect(widths).not.toContain('1000');
    expect(widths).not.toContain('900');
  }, 60_000);
  it('sinistre et kit de vente à données structurées : contenu, renvois d’annexes, pied sur chaque page', async () => {
    const { renderDossier } = await import('../render/render-dossier');
    const { buildDefaultChoices } = await import('../data/choices');
    // Pièces : trois PDF d'une page, lisibles.
    for (const [key, label] of [['devis', 'DEVIS PEINTURE'], ['facture', 'FACTURE LOXAM'], ['echanges', 'ECHANGES ASSUREUR']] as const) {
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      d.addPage([595, 842]).drawText(label, { x: 60, y: 760, size: 22, font: f });
      fs.writeFileSync(files[key] = path.join(dir, `${key}.pdf`), await d.save());
    }
    // Photos : recadrages d'une vraie photo si fournie (« sinistre.webp[,vente.webp] »), sinon aplats de couleur.
    const [realSin, realVen] = (process.env.EXPORTS_RENDER_PHOTO ?? '').split(',').map((x) => (x && fs.existsSync(x) ? x : null));
    const makePhotos = async (prefix: string, real: string | null) => {
      const meta = real ? await sharp(real).metadata() : null;
      for (let i = 1; i <= 6; i++) {
        const out = files[`${prefix}${i}`] = path.join(dir, `${prefix}${i}.jpg`);
        if (real && meta?.width && meta.height) {
          const w = Math.round(meta.width * 0.6); const h = Math.round(meta.height * 0.6);
          await sharp(real).extract({ left: Math.round((meta.width - w) * ((i - 1) % 3) / 2), top: Math.round((meta.height - h) * (i > 3 ? 1 : 0)), width: w, height: h })
            .jpeg({ quality: 82 }).toFile(out);
        } else {
          await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 40 + i * 25, g: 90, b: 160 - i * 15 } } }).jpeg().toFile(out);
        }
      }
    };
    await makePhotos('ph', realSin);
    await makePhotos('pv', realVen ?? realSin);
    const fetchToFile = async (key: string, _b: string | null, dest: string) => {
      if (!files[key]) return false;
      fs.copyFileSync(files[key], dest);
      return true;
    };
    const outDir = process.env.EXPORTS_RENDER_OUT;
    if (outDir) fs.mkdirSync(outDir, { recursive: true });

    // ── Sinistre ──
    const sinistre = makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', {
      asset: { ...makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE').asset, name: 'Appartement Lyon 2ᵉ' },
      documents: [
        doc({ id: 31, kind: 'DEVIS', title: 'Devis peinture et plâtrerie', date: '2026-08-19', supplier: 'Artisan peintre', amountCents: 284000, s3Key: 'devis' }),
        doc({ id: 32, kind: 'FACTURE', title: 'Facture location déshumidificateur', date: '2026-08-22', supplier: 'Loxam Lyon', amountCents: 18600, s3Key: 'facture' }),
        doc({ id: 33, kind: 'ECHANGE_ASSUREUR', title: 'Échanges assureur (3 messages)', date: '2026-08-04', s3Key: 'echanges' }),
        doc({ id: 34, kind: 'DOCUMENT_BANCAIRE', title: 'RIB compte joint', sensitive: true, date: '2026-08-05', s3Key: 'devis' }),
      ],
      photos: [1, 2, 3, 4, 5, 6].map((i) => photo(i, { s3Key: `ph${i}`, date: i === 1 ? '2026-04-21' : '2026-08-03', caption: ['plafond SDB avant sinistre', 'auréoles plafond SDB', 'angle plâtre cloqué', 'plafonnier', 'mur chambre 2', 'parquet gonflé'][i - 1] })),
      events: [
        event(41, { title: 'Contrôle VMC, aucun désordre constaté', category: 'entretien', date: '2026-04-21' }),
        event(42, { title: 'Sinistre · infiltration constatée à 19 h 40', category: 'sinistre', date: '2026-08-03', description: "Infiltration d'eau au plafond de la salle de bain et de la chambre 2, en provenance du 4ᵉ étage." }),
        event(43, { title: 'Recherche de fuite · origine confirmée au 4ᵉ étage', category: 'reparation', date: '2026-08-07', provider: 'Plomberie Bellecour' }),
        event(44, { title: 'Expertise sur place', category: 'sinistre', date: '2026-08-26', provider: 'Cabinet Rhône Expertises' }),
      ],
      additionalInfo: {
        commercial: {}, rental: {}, insurance: {}, updatedAt: null,
        claim: {
          claimEventKey: 'event:42', occurredOn: '2026-08-03', claimType: 'DEGAT_DES_EAUX', declaredOn: '2026-08-04',
          insurerClaimRef: 'SIN-2026-08-77412', policyReference: 'MRH n° 4471 992', status: 'EXPERTISE_REALISEE',
          consequences: 'Plafonds et murs tachés et cloqués sur 11 m² environ, luminaire de salle de bain hors service, parquet de la chambre 2 gonflé sur 2 m².',
          measures: 'Coupure du circuit électrique, bâchage, séchage par déshumidificateur, déclaration sous 24 h.',
          statusDetail: "Expertise réalisée le 26/08/2026 · en attente de l'accord d'indemnisation",
          damages: [
            { id: 'd1', zone: 'Salle de bain', element: 'Plafond · 5 m²', finding: 'Auréoles, peinture cloquée, plâtre friable en angle', estimatedAmountCents: 284000, photoIds: [2, 3], documentIds: [31] },
            { id: 'd2', zone: 'Salle de bain', element: 'Luminaire plafonnier', finding: 'Eau dans le boîtier, hors service depuis le 03/08', photoIds: [4] },
            { id: 'd3', zone: 'Chambre 2', element: 'Plafond et mur mitoyen · 6 m²', finding: 'Traces d’humidité, décollement du papier peint', photoIds: [5] },
            { id: 'd4', zone: 'Chambre 2', element: 'Parquet stratifié · 2 m²', finding: 'Lames gonflées le long du mur mitoyen', photoIds: [6], documentIds: [34] },
          ],
          actions: [
            { id: 'a1', date: '2026-08-03', title: 'Mesures conservatoires', detail: 'Coupure électrique du circuit SDB, bâchage, déplacement du mobilier', performedBy: 'Assurée' },
            { id: 'a2', date: '2026-08-07', title: 'Recherche et réparation de la fuite', performedBy: 'Plomberie Bellecour', detail: "À la charge de l'occupant du 4ᵉ" },
            { id: 'a3', date: '2026-08-08', endDate: '2026-08-22', title: 'Séchage', detail: 'Déshumidificateur en location, 14 jours', performedBy: 'Loxam Lyon', invoiceDocumentId: 32 },
            { id: 'a4', status: 'A_REALISER', title: 'Remise en état', detail: "En attente de l'accord d'indemnisation · devis joints" },
          ],
          exchanges: [
            { id: 'x1', date: '2026-08-04', direction: 'RECU', party: 'ASSUREUR', channel: 'EMAIL', summary: 'Accusé de réception de la déclaration · SIN-2026-08-77412', documentId: 33 },
            { id: 'x2', date: '2026-08-18', direction: 'RECU', party: 'EXPERT', channel: 'COURRIER', summary: "Convocation à l'expertise du 26/08/2026" },
            { id: 'x3', date: '2026-09-15', direction: 'ENVOYE', party: 'ASSUREUR', channel: 'EMAIL', summary: "Relance de l'assuré · sans réponse à ce jour" },
          ],
        },
      },
    });
    const sinChoices = buildDefaultChoices('ASSURANCE_SINISTRE', sinistre, { today: TODAY });
    const rs = await renderDossier({
      code: 'ASSURANCE_SINISTRE', source: sinistre, choices: sinChoices, today: TODAY, workDir: fs.mkdtempSync(path.join(dir, 'work-')), fetchToFile, timeoutMs: 90_000,
      meta: { reference: 'VBN-SIN-2026-0928-002', generatedAt: '2026-09-28T10:02:00+02:00', preparedBy: 'Claire Martin' },
    });
    const sp = await pdfText(rs.pdf);
    sp.forEach((t, i) => expect(t.replace(/\s/g, ''), `sinistre page ${i + 1}`).toContain(`Page${i + 1}/${sp.length}`));
    const st = sp.join(' ');
    for (const t of ['Dommages et éléments concernés', 'Photos · pièces', 'Plafond · 5 m', 'Actions déjà réalisées', 'Non réalisé', '08/08 → 22/08/2026',
      'Intervenant : Loxam Lyon', 'Assureur · E-mail reçu', 'Expert · Courrier reçu', '2 zones endommagées']) expect(st.toLowerCase(), t).toContain(t.toLowerCase());
    // Renvois : photos retenues (P1…) et pièce intégrée (A2) dans le tableau des dommages.
    expect(st).toMatch(/P1, P2 · A\d/);
    expect(st).toMatch(/facture · annexe A\d/);
    expect(st).not.toContain('RIB compte joint');
    if (outDir) fs.writeFileSync(path.join(outDir, 'data-assurance-sinistre.pdf'), rs.pdf);

    // ── Kit de vente ──
    const vente = makeSource('VEHICULE', 'VENTE', {
      asset: { ...makeSource('VEHICULE', 'VENTE').asset, name: 'Vélo cargo Urban Arrow Family', characteristics: { ...makeSource('VEHICULE', 'VENTE').asset.characteristics, parking: 'Garage fermé', engine: 'Bosch Cargo Line · 85 Nm', color: 'Blanc' } },
      documents: [doc({ id: 51, kind: 'FACTURE', title: 'Facture d’achat', s3Key: 'facture' })],
      photos: [1, 2, 3, 4].map((i) => photo(i, { s3Key: `pv${i}`, caption: ['Vue de trois quarts', 'Caisse et banc enfant', 'Moteur Bosch', 'Tente de pluie'][i - 1] })),
      events: [event(61, { title: 'Révision complète', provider: 'Cyclable Lyon', date: '2025-07-03' })],
      additionalInfo: {
        rental: {}, insurance: {}, claim: {}, updatedAt: null,
        commercial: {
          desiredSalePriceCents: 390000, newPriceCents: 549000, salePitch: 'Modèle 2022 · moteur Bosch Cargo Line · 3 480 km · entretien suivi.',
          availabilityDate: '2026-10-15', availabilityComment: 'remise en main propre',
          includedAccessories: 'Tente de pluie, banc enfant 2 places, antivol de cadre Abus, chargeur 4 A',
          saleConditions: 'Vente entre particuliers, essai possible sur rendez-vous, paiement par virement',
          contactInstructions: 'Par message via l’annonce · visites en semaine après 18 h, Lyon 7ᵉ',
          highlights: [
            { id: 'h1', title: 'Entretien en atelier agréé', text: 'Révisions complètes le 12/06/2023 et le 03/07/2025 chez Cyclable Lyon. Factures disponibles.', origin: 'suggestion:maintenance' },
            { id: 'h2', title: 'Pièces d’usure récentes', text: 'Plaquettes de frein et chaîne remplacées le 03/07/2025 (1 240 km avant la date du dossier).' },
            { id: 'h3', title: 'Batterie d’origine, garantie constructeur', text: 'Garantie Bosch 2 ans / 500 cycles échue ; 112 cycles de charge relevés à la révision 2025.' },
            { id: 'h4', title: 'Stationnement abrité', text: 'Garage fermé déclaré comme lieu de stationnement depuis l’achat.', origin: 'suggestion:parking' },
          ],
        },
      },
    });
    const rv = await renderDossier({
      code: 'VENTE', source: vente, choices: buildDefaultChoices('VENTE', vente, { today: TODAY }), today: TODAY, workDir: fs.mkdtempSync(path.join(dir, 'work-')), fetchToFile, timeoutMs: 90_000,
      meta: { reference: 'VBN-VEN-2026-0928-001', generatedAt: '2026-09-28T09:40:00+02:00', preparedBy: 'Julien Roux' },
    });
    const vp = await pdfText(rv.pdf);
    vp.forEach((t, i) => expect(t.replace(/\s/g, ''), `vente page ${i + 1}`).toContain(`Page${i + 1}/${vp.length}`));
    const vt = vp.join(' ');
    for (const t of ['Mise en valeur du bien', 'Entretien en atelier agréé', 'Pièces d’usure récentes', 'Stationnement abrité', 'Prix souhaité']) expect(vt.toLowerCase(), t).toContain(t.toLowerCase());
    expect(vt).not.toContain('suggestion:');
    expect(vt).not.toContain('UA22F0000004871');
    if (outDir) fs.writeFileSync(path.join(outDir, 'data-vente.pdf'), rv.pdf);
  }, 180_000);
});
