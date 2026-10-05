#!/usr/bin/env node
/**
 * Rendu de la 1re page d'un PDF en PNG — processus ISOLÉ (APP-PERF-27).
 *
 * Lancé par `src/services/documents/thumbnails/pdf-render.ts`, jamais par
 * le navigateur ni dans le processus web :
 *   · entrée : le PDF sur stdin (taille bornée par l'appelant) ;
 *   · sortie : PNG sur stdout ;
 *   · argument : largeur cible en pixels (`--width=480`) ;
 *   · codes de sortie : 0 succès, 2 PDF protégé par mot de passe, 3 PDF
 *     illisible/corrompu, 4 page trop grande, 1 autre erreur.
 * L'appelant borne la durée (SIGKILL) et la mémoire (--max-old-space-size) :
 * un PDF hostile ou très complexe ne peut ni bloquer ni faire tomber le
 * serveur web.
 *
 * Moteur : pdfjs-dist (build « legacy » pour Node) + @napi-rs/canvas
 * (dépendance optionnelle de pdfjs-dist, déjà installée) — aucune
 * dépendance ajoutée.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const MAX_PIXELS = 4_000_000;

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

async function main() {
  const width = Math.max(32, Math.min(2000, Number(arg('width', '480')) || 480));
  const data = await readStdin();
  if (data.length === 0) process.exit(3);

  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjs = await import(pathToFileURL(path.join(pdfjsRoot, 'legacy/build/pdf.mjs')).href);

  const task = pdfjs.getDocument({
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pdfjsRoot, 'cmaps') + path.sep,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });

  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    const name = e?.name ?? '';
    if (name === 'PasswordException') process.exit(2);
    if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'UnknownErrorException') process.exit(3);
    throw e;
  }

  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    if (!(base.width > 0 && base.height > 0)) process.exit(3);
    const scale = width / base.width;
    const viewport = page.getViewport({ scale });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);
    if (w * h > MAX_PIXELS) process.exit(4);

    const { canvas, context } = pdf.canvasFactory.create(w, h);
    // Fond blanc : une page sans fond ne doit pas devenir transparente/noire.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, w, h);
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    const png = canvas.toBuffer('image/png');
    page.cleanup();
    await new Promise((resolve, reject) => process.stdout.write(png, (err) => (err ? reject(err) : resolve())));
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`[render-pdf-thumbnail] ${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 300)}\n`);
    process.exit(1);
  },
);
