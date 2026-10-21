/**
 * Nom du fichier téléchargé depuis Verebona — règle COMMUNE à tous les points
 * d'entrée (bibliothèque, fiches bien / équipement / pièce, tiroirs, aperçus,
 * archives ZIP, export « Mes données »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE NOM ÉTAIT TECHNIQUE (lot 75L, BUG P1)
 *
 *   · le nom venait de `retainedTitle` BRUT, alors que l'écran affiche
 *     `displayDocumentTitle` (qui écarte les titres techniques) : un titre
 *     « a7f82c91-… » sortait tel quel au téléchargement ;
 *   · « .pdf » retiré du titre une seule fois et quelle que soit l'extension
 *     (« Facture.PDF.pdf », « Rapport v1.2 » → « Rapport v1.pdf ») ;
 *   · l'aperçu et l'ouverture (`inline`) ne portaient aucun nom : le
 *     navigateur reprenait la clé de stockage ;
 *   · chaque ZIP avait sa propre normalisation (accents perdus, sous-type MIME
 *     comme extension, noms identiques écrasés).
 *
 * Règle : nom AFFICHÉ (`displayDocumentTitle`) + extension du format réel
 * (MIME du fichier stocké ; à défaut celle du nom d'origine), sans double
 * extension ; repli sur le nom d'origine. Seuls les caractères refusés par
 * Windows / macOS / Linux sont retirés : accents, apostrophes et espaces sont
 * conservés (en-tête `filename*` UTF-8, RFC 6266 / 5987, plus un `filename`
 * ASCII de repli). Aucun renommage physique : la clé de stockage est ignorée.
 *
 * Module pur (sans dépendance serveur) : utilisable côté client.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { displayDocumentTitle, type DisplayTitleSource } from '@/lib/documents/document-title-rules';

/** MIME → extensions admises (la première est la forme canonique). */
const MIME_EXT: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe'], 'image/jpg': ['jpg', 'jpeg'], 'image/pjpeg': ['jpg', 'jpeg'],
  'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'],
  'image/heic': ['heic'], 'image/heif': ['heif', 'heic'], 'image/tiff': ['tif', 'tiff'],
  'image/bmp': ['bmp'], 'image/svg+xml': ['svg'],
  'text/plain': ['txt'], 'text/csv': ['csv'], 'text/html': ['html', 'htm'], 'text/xml': ['xml'],
  'application/xml': ['xml'], 'application/json': ['json'], 'application/rtf': ['rtf'], 'text/rtf': ['rtf'],
  'application/zip': ['zip'], 'application/x-zip-compressed': ['zip'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.oasis.opendocument.text': ['odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['ods'],
  'application/vnd.oasis.opendocument.presentation': ['odp'],
  'message/rfc822': ['eml'], 'application/vnd.ms-outlook': ['msg'],
  'video/mp4': ['mp4'], 'video/quicktime': ['mov'], 'audio/mpeg': ['mp3'], 'audio/mp4': ['m4a'],
};

/** Extensions de fichier reconnues : seules celles-ci sont retirées d'un titre. */
const KNOWN_EXT = new Set<string>([
  ...Object.values(MIME_EXT).flat(),
  'pages', 'numbers', 'key', 'dwg', 'dxf', 'avi', 'wav', 'ogg', 'webm', '7z', 'rar', 'gz', 'tgz', 'ics', 'vcf',
]);

const EXT_RE = /\.([A-Za-z0-9]{1,5})$/;

function extensionOf(name: string | null | undefined): string | null {
  const m = name ? EXT_RE.exec(name.trim()) : null;
  return m ? m[1].toLowerCase() : null;
}

/** Retire une ou deux extensions CONNUES en fin de nom (« x.pdf.pdf » → « x »). */
function stripKnownExtensions(name: string): string {
  let s = name.trim();
  for (let i = 0; i < 2; i++) {
    const ext = extensionOf(s);
    if (!ext || !KNOWN_EXT.has(ext)) break;
    s = s.slice(0, -(ext.length + 1)).trim();
  }
  return s;
}

/** Noms de périphériques réservés par Windows (avec ou sans extension). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Longueur maximale du nom SANS extension, en octets UTF-8 (limite FS : 255). */
const MAX_BASE_BYTES = 180;

function truncateUtf8(s: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

/**
 * Nettoie un nom (sans extension) pour tous les systèmes de fichiers : retire
 * uniquement les caractères interdits (`\ / : * ? " < > |`, contrôles), les
 * points initiaux (fichier caché) et finaux / espaces finaux (Windows), et
 * protège les noms réservés. Accents (recomposés en NFC), apostrophes,
 * parenthèses et espaces sont conservés.
 */
export function cleanFilenamePart(s: string): string {
  let out = s
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/(\d)\s*[\\/]\s*(?=\d)/g, '$1-')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');
  out = truncateUtf8(out, MAX_BASE_BYTES).replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(out)) out = `${out}_`;
  return out;
}

export interface DownloadableFile extends DisplayTitleSource {
  mimeType?: string | null;
}

/**
 * Extension du format RÉEL du fichier téléchargé : celle du MIME stocké
 * (l'alias du nom d'origine est respecté : « .jpeg » reste « .jpeg ») ; à
 * défaut de MIME exploitable, celle du nom d'origine puis du nom stocké.
 */
export function realExtension(f: DownloadableFile): string | null {
  const original = extensionOf(f.originalFilename) ?? extensionOf(f.fileName) ?? extensionOf(f.filename);
  const mime = f.mimeType?.split(';')[0].trim().toLowerCase();
  const allowed = mime ? MIME_EXT[mime] : undefined;
  if (allowed) return original && allowed.includes(original) ? original : allowed[0];
  return original;
}

/** Assemble nom + extension sans jamais doubler l'extension. */
export function withExtension(base: string, ext: string | null): string {
  const clean = cleanFilenamePart(stripKnownExtensions(base));
  if (!clean) return '';
  return ext ? `${clean}.${ext}` : clean;
}

/**
 * Nom de téléchargement d'un document : nom affiché dans Verebona + extension
 * réelle ; repli sur le nom d'origine, puis « document ».
 */
export function downloadFilename(f: DownloadableFile): string {
  const ext = realExtension(f);
  const candidats = [
    displayDocumentTitle(f, ''),
    f.originalFilename ?? '',
    f.fileName ?? '',
  ];
  for (const c of candidats) {
    const n = withExtension(c, ext);
    if (n) return n;
  }
  return ext ? `document.${ext}` : 'document';
}

/**
 * Générateur de noms UNIQUES pour un téléchargement multiple (ZIP) : à nom
 * identique (casse et forme Unicode ignorées, comme sous Windows/macOS), le
 * suivant reçoit « (2) », « (3) »… avant l'extension. Aucun écrasement.
 * `folder` : dossier dans l'archive (préfixe du chemin renvoyé).
 */
export function makeUniqueNamer(): (name: string, folder?: string) => string {
  const used = new Set<string>();
  const key = (p: string) => p.normalize('NFC').toLowerCase();
  return (name, folder) => {
    const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
    const ext = extensionOf(name);
    const base = ext ? name.slice(0, -(ext.length + 1)) : name;
    const suffix = ext ? `.${name.slice(-ext.length)}` : '';
    let candidate = `${prefix}${name}`;
    for (let n = 2; used.has(key(candidate)); n++) candidate = `${prefix}${base} (${n})${suffix}`;
    used.add(key(candidate));
    return candidate;
  };
}

/** Version ASCII (repli `filename=`) : accents retirés, reste remplacé. */
export function asciiFallback(name: string): string {
  const ascii = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[Œœ]/g, (c) => (c === 'Œ' ? 'OE' : 'oe')).replace(/[Ææ]/g, (c) => (c === 'Æ' ? 'AE' : 'ae'))
    .replace(/[^\w\s.\-()]/g, '_');
  return ascii || 'document';
}

/** En-tête Content-Disposition (RFC 6266) : `filename` ASCII + `filename*` UTF-8 (RFC 5987). */
export function contentDisposition(name: string, kind: 'attachment' | 'inline' = 'attachment'): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encoded}`;
}
