/**
 * Worker d'isolement des PDF sources (dossiers V12) — lancé par `annexes.ts`.
 *
 * Un PDF importé par l'utilisateur n'est JAMAIS décodé dans le processus web :
 * lecture, décompression des flux et apposition (pdf-lib) se font ici, dans un
 * `worker_thread` au tas plafonné (`resourceLimits`) et tué au-delà d'un délai.
 * Une « bombe de décompression » ou un PDF pathologique fait échouer le worker,
 * pas le serveur ; la pièce est alors traitée comme illisible (`corrupted`).
 *
 * Fichier CommonJS autonome (pas de TypeScript, pas d'alias `@/`) : il est
 * chargé tel quel par Node, hors bundle Next.js.
 *
 * Opérations (`workerData.op`) :
 *  · inspect : { path, strict } → { status, pages, boxes } ; en mode strict,
 *    chaque page est réellement incorporée (embedPages + save) : un fichier qui
 *    passe l'inspection stricte s'appose ensuite sans surprise ;
 *  · overlay : { pdf, annexes: [{ annexRef, path, draws }], metadata } →
 *    { pdf, failed } ; `draws` = positions calculées par `placeInFrame`.
 */
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { PDFDocument, degrees, EncryptedPDFError } = require('pdf-lib');

/*
 * Plafond de décompression. Le tas du worker est borné par `resourceLimits`,
 * mais les tampons décodés (Uint8Array) sont alloués HORS tas V8 : une bombe
 * de décompression (quelques Ko → plusieurs Go) les ferait grossir sans
 * limite. Tous les décodeurs de pdf-lib (Flate, LZW, RunLength, ASCII85,
 * ASCIIHex — y compris les flux d'objets lus au chargement) passent par
 * `DecodeStream.ensureBuffer` : on y impose un plafond par flux et un budget
 * total pour le document. Dépassement → exception → pièce « corrupted ».
 */
const limits = workerData.limits || {};
const MAX_TOTAL = Number(limits.maxDecodedBytes) > 0 ? Number(limits.maxDecodedBytes) : 256 * 1024 * 1024;
const MAX_STREAM = Math.min(MAX_TOTAL, 64 * 1024 * 1024);
let decodedBudget = MAX_TOTAL;
try {
  const DecodeStream = require('pdf-lib/cjs/core/streams/DecodeStream').default;
  const ensureBuffer = DecodeStream.prototype.ensureBuffer;
  DecodeStream.prototype.ensureBuffer = function limitedEnsureBuffer(requested) {
    if (requested > MAX_STREAM) throw new Error(`flux décompressé trop volumineux (> ${MAX_STREAM} octets)`);
    const before = this.buffer ? this.buffer.byteLength : 0;
    const buffer = ensureBuffer.call(this, requested);
    decodedBudget -= Math.max(0, buffer.byteLength - before);
    if (decodedBudget < 0) throw new Error(`volume décompressé excessif (> ${MAX_TOTAL} octets)`);
    return buffer;
  };
} catch (e) {
  // Structure interne de pdf-lib modifiée : refuser plutôt que décoder sans plafond.
  parentPort.postMessage({ ok: false, error: `plafond de décompression indisponible : ${String((e && e.message) || e)}` });
  process.exit(0);
}

/** Page sans flux de contenu (page blanche) : rien à incorporer — pdf-lib refuse de l'incorporer. */
const hasContents = (page) => !!page.node.Contents();

const boxOf = (page) => {
  const c = page.getCropBox();
  return { left: c.x, bottom: c.y, right: c.x + c.width, top: c.y + c.height };
};

async function inspect({ path, strict }) {
  let doc;
  try {
    doc = await PDFDocument.load(fs.readFileSync(path), { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(String(e && e.message))) {
      return { status: 'protected', pages: null, reason: 'PDF chiffré' };
    }
    return { status: 'corrupted', pages: null, reason: String((e && e.message) || 'illisible').slice(0, 200) };
  }
  try {
    const pages = doc.getPages();
    if (pages.length < 1) return { status: 'corrupted', pages: null, reason: 'aucune page' };
    const boxes = pages.map((p) => {
      const c = p.getCropBox();
      if (!(c.width > 0 && c.height > 0)) throw new Error('page de dimensions nulles');
      return { width: c.width, height: c.height, rotation: p.getRotation().angle };
    });
    if (strict) {
      // Apposition « à blanc » : décode réellement tous les contenus.
      const probe = await PDFDocument.create();
      const withContent = pages.filter(hasContents);
      const embedded = withContent.length ? await probe.embedPages(withContent, withContent.map(boxOf)) : [];
      for (const e of embedded) probe.addPage([e.width, e.height]).drawPage(e);
      await probe.save();
    }
    return { status: 'ok', pages: pages.length, boxes };
  } catch (e) {
    return { status: 'corrupted', pages: null, reason: String((e && e.message) || 'illisible').slice(0, 200) };
  }
}

async function overlay({ pdf, annexes, metadata }) {
  const out = await PDFDocument.load(pdf, { updateMetadata: false });
  const failed = [];
  for (const a of annexes) {
    try {
      const src = await PDFDocument.load(fs.readFileSync(a.path), { updateMetadata: false });
      const srcPages = src.getPages();
      for (const d of a.draws) if (!srcPages[d.srcIndex]) throw new Error(`page source ${d.srcIndex + 1} absente`);
      // Pages blanches (sans contenu) : le cadre reste blanc, comme la source.
      const draws = a.draws.filter((d) => hasContents(srcPages[d.srcIndex]));
      const selected = draws.map((d) => srcPages[d.srcIndex]);
      const embedded = selected.length ? await out.embedPages(selected, selected.map(boxOf)) : [];
      draws.forEach((d, i) => {
        const target = out.getPage(d.targetIndex);
        target.drawPage(embedded[i], { x: d.x, y: d.y, xScale: d.scale, yScale: d.scale, rotate: degrees(d.rotate) });
      });
    } catch (e) {
      failed.push({ annexRef: a.annexRef, reason: String((e && e.message) || 'échec').slice(0, 200) });
    }
  }
  out.setTitle(metadata.title);
  if (metadata.subject) out.setSubject(metadata.subject);
  out.setAuthor('Verebona');
  out.setCreator('Verebona');
  out.setProducer('Verebona — dossiers V12 (Chromium, pdf-lib)');
  out.setLanguage('fr-FR');
  out.setCreationDate(new Date(metadata.date));
  out.setModificationDate(new Date(metadata.date));
  return { pdf: await out.save(), failed };
}

(async () => {
  try {
    const result = workerData.op === 'inspect' ? await inspect(workerData) : await overlay(workerData);
    const transfer = result.pdf ? [result.pdf.buffer] : [];
    parentPort.postMessage({ ok: true, result }, transfer);
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
})();
