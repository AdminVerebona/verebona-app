/**
 * Scanner natif → PDF multipage → parcours d'ajout existant — lot 95
 * (CDC 12 SCAN-01..03, REC-021/022 ; PO M9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   · Interface de numérisation DU SYSTÈME : VisionKit (iOS) / ML Kit
 *     Document Scanner (Android), par `@capgo/capacitor-document-scanner` :
 *     détection des bords, perspective, recadrage, plusieurs pages, revue
 *     avant validation (aperçu, reprise d'une page, rotation sur Android).
 *   · Les pages (JPEG du système, résolution d'origine) sont assemblées ici
 *     en UN PDF, sans recompression ni réduction : montants, dates, petites
 *     mentions et annotations restent lisibles (M9). Une page par image, dans
 *     l'ordre du scanner (REC-022).
 *   · Le PDF entre dans le formulaire d'ajout HABITUEL (`openCreateFlow`
 *     avec fichiers) : mêmes contrôles (25 Mo, format, rattachement, quota,
 *     droits Duo), même file idempotente, même pipeline documentaire (T1) —
 *     aucun parcours parallèle.
 *   · Les images temporaires du scanner (cache privé de l'app) sont effacées
 *     dès le PDF construit ; le PDF n'existe qu'en mémoire jusqu'à l'envoi
 *     (l'envoi natif écrit puis efface sa propre copie, UPL-05).
 *   · Scanner indisponible ou caméra refusée : `unavailable` → l'interface
 *     propose l'import classique (§20).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NATIVE_PLUGINS, nativePlugin } from './bridge';
import { readNativeFile } from './files';

export interface ScannedImage { bytes: Uint8Array; mime: string }

/** Largeur de page : A4 (595,28 pt) ; la hauteur suit les proportions de l'image. */
const LARGEUR_PAGE_PT = 595.28;

/** Assemble des images en un PDF (pur, testé) — une page par image, sans recompression. */
export async function imagesToPdf(images: ScannedImage[], title = 'Document scanné'): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('Aucune page');
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('Verebona');
  pdf.setCreator('Verebona — scanner du téléphone');
  for (const img of images) {
    const embedded = img.mime === 'image/png' ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
    const height = LARGEUR_PAGE_PT * (embedded.height / embedded.width);
    const page = pdf.addPage([LARGEUR_PAGE_PT, height]);
    page.drawImage(embedded, { x: 0, y: 0, width: LARGEUR_PAGE_PT, height });
  }
  return pdf.save();
}

/** Nom du PDF : « Scan 2026-10-26 14h05.pdf » (pur). */
export function scanFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}.pdf`;
}

function mimeOf(path: string, bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  return /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
}

interface ScannerPlugin {
  scanDocument(o: Record<string, unknown>): Promise<{ scannedImages?: string[]; status?: 'success' | 'cancel' }>;
}
interface FilesystemPlugin { deleteFile(o: { path: string }): Promise<void> }

export type ScanOutcome = { status: 'ok'; file: File } | { status: 'cancelled' } | { status: 'unavailable' } | { status: 'failed' };

/** Lance le scanner du système et rend le PDF prêt à déposer. */
export async function scanDocumentToPdf(now: () => Date = () => new Date()): Promise<ScanOutcome> {
  const scanner = nativePlugin<ScannerPlugin>(NATIVE_PLUGINS.scanner);
  if (!scanner) return { status: 'unavailable' };
  let paths: string[];
  try {
    const r = await scanner.scanDocument({ maxNumDocuments: 24, responseType: 'imageFilePath', letUserAdjustCrop: true });
    if (r.status === 'cancel' || !r.scannedImages?.length) return { status: 'cancelled' };
    paths = r.scannedImages;
  } catch {
    // Caméra refusée, scanner absent (services Google indisponibles), émulateur.
    return { status: 'unavailable' };
  }
  const fs = nativePlugin<FilesystemPlugin>(NATIVE_PLUGINS.filesystem);
  try {
    const images: ScannedImage[] = [];
    for (const path of paths) {
      const blob = await readNativeFile(path, /\.png$/i.test(path) ? 'image/png' : 'image/jpeg');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      images.push({ bytes, mime: mimeOf(path, bytes) });
    }
    const date = now();
    const name = scanFileName(date);
    const pdf = await imagesToPdf(images, name.replace(/\.pdf$/, ''));
    return { status: 'ok', file: new File([pdf as BlobPart], name, { type: 'application/pdf', lastModified: date.getTime() }) };
  } catch {
    return { status: 'failed' };
  } finally {
    for (const path of paths) await fs?.deleteFile({ path }).catch(() => undefined);
  }
}
