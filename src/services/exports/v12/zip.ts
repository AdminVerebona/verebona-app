/**
 * Archive ZIP d'un dossier V12 (CDC §14.2, ZIP-001 à 008).
 *
 *   /pdf/Verebona_[TypeDossier]_[NomBien]_[YYYY-MM-DD].pdf   (ZIP-002)
 *   /documents/<nom normalisé>.ext                           (ZIP-003, 006, 007)
 *   /photos/<nom normalisé>.ext                              (ZIP-004)
 *
 * Aucun manifeste (ZIP-005). N'est produite que si au moins une pièce est en
 * mode ZIP (ZIP-001) ; une pièce exclue pour corruption n'y figure pas
 * (ZIP-008, filtré en amont par `render-dossier.ts`). Les pièces sont lues en
 * flux depuis le disque et l'archive est écrite en flux sur disque : jamais
 * tout le contenu en mémoire.
 */

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import type { ZipEntry } from './render/render-dossier';

export async function writeDossierZip(params: { pdfPath: string; pdfName: string; entries: ZipEntry[]; dest: string }): Promise<number> {
  const zip = new JSZip();
  zip.file(`pdf/${params.pdfName}`, fs.createReadStream(params.pdfPath), { binary: true });
  for (const e of params.entries) zip.file(e.path, fs.createReadStream(e.localPath), { binary: true });
  await pipeline(
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } }),
    fs.createWriteStream(params.dest),
  );
  return (await fs.promises.stat(params.dest)).size;
}
