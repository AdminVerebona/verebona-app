/**
 * Nom du fichier téléchargé depuis Verebona.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE NOM ÉTAIT TECHNIQUE
 *
 * Le fichier téléchargé portait le nom d'origine passé dans
 * `[^\w\s.-] → _` : tout accent devenait « _ » (« Facture_lectricit_.pdf »),
 * et le titre du document — ce que l'utilisateur voit dans Verebona — n'était
 * jamais utilisé. Depuis le tiroir, le lien de consultation `inline` ouvrait
 * même le fichier au lieu de le télécharger, et l'enregistrer reprenait la clé
 * de stockage.
 *
 * Règle : le TITRE du document, avec l'extension du fichier ; à défaut le nom
 * d'origine. Accents conservés (en-tête `filename*` UTF-8, RFC 6266 / 5987),
 * avec une version ASCII pour les rares clients qui l'ignorent.
 * ══════════════════════════════════════════════════════════════════════════
 */

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'image/gif': 'gif', 'text/plain': 'txt', 'text/csv': 'csv', 'application/zip': 'zip',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
};

function extensionOf(name: string | null | undefined): string | null {
  const m = name ? /\.([A-Za-z0-9]{1,5})$/.exec(name.trim()) : null;
  return m ? m[1].toLowerCase() : null;
}

/** Retire ce qu'un système de fichiers refuse, sans toucher aux accents. */
function cleanForFilesystem(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 150)
    .trim();
}

export interface DownloadableFile {
  retainedTitle?: string | null;
  originalFilename?: string | null;
  filename?: string | null;
  mimeType?: string | null;
}

export function downloadFilename(f: DownloadableFile): string {
  const ext = extensionOf(f.originalFilename) ?? extensionOf(f.filename) ?? (f.mimeType ? MIME_EXT[f.mimeType] : null);
  const title = f.retainedTitle ? cleanForFilesystem(f.retainedTitle.replace(/\.[A-Za-z0-9]{1,5}$/, '')) : '';
  if (title) return ext ? `${title}.${ext}` : title;
  const original = cleanForFilesystem(f.originalFilename || f.filename || '');
  return original || (ext ? `document.${ext}` : 'document');
}

/** Version ASCII (repli `filename=`) : accents retirés, reste remplacé. */
export function asciiFallback(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s.\-()]/g, '_').replace(/"/g, '_');
}

/** En-tête Content-Disposition, UTF-8 compris. */
export function contentDisposition(name: string, kind: 'attachment' | 'inline' = 'attachment'): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encoded}`;
}
