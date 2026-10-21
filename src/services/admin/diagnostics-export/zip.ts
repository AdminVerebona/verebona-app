/**
 * Lot 77C — archive ZIP du diagnostic, générée CÔTÉ SERVEUR avec la
 * dépendance existante `jszip` (aucune nouvelle dépendance). Les fichiers
 * sont déjà masqués et sérialisés par `generateDiagnostic`.
 */
import JSZip from 'jszip';
import type { DiagBundle } from './collect';

export async function buildDiagnosticZip(bundle: Pick<DiagBundle, 'files' | 'manifest'>): Promise<Buffer> {
  const zip = new JSZip();
  const date = new Date(bundle.manifest.generatedAt);
  for (const f of bundle.files) zip.file(f.path, f.content, { date, createFolders: true });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
}
