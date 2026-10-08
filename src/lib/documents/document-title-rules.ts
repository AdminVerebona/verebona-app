/**
 * Titre MÉTIER d'un document — règles pures, partagées client / serveur
 * (lot 33C, ticket « T1/T3 : garantir le renommage métier des documents »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « 5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf » N'EST PAS UN TITRE
 *
 * Un document analysé peut garder comme titre le nom technique de son dépôt
 * (UUID d'un scanner ou d'une appli mobile, `upload_12345.pdf`, nom de
 * stockage horodaté…). Ce module dit, de façon GÉNÉRIQUE et indépendante du
 * type documentaire, si une chaîne est un titre métier :
 *
 *   · `isValidBusinessTitle` — vide, UUID (avec ou sans extension), empreinte
 *     (hex ≥ 16), jeton aléatoire, clé ou nom de stockage, nom temporaire /
 *     d'upload (`upload_`, `tmp_`, `IMG_2024…`, `Document (1)`, « Sans
 *     titre »…), chaîne sans lettre → NON ;
 *   · `displayDocumentTitle` — ordre d'affichage : titre métier → nom
 *     original exploitable → nom technique en dernier recours ;
 *   · `technicalTitleSqlPredicate` — PRÉFILTRE SQL du balayage T3 : un
 *     sur-ensemble de la règle JS (tout titre technique y répond ; quelques
 *     titres valides aussi, que la règle JS écarte ensuite). La liste des mots
 *     techniques est la même des deux côtés (`TECHNICAL_WORDS`).
 *
 * Aucune dépendance serveur : importable par les composants (aucun `@/db`).
 * Les RÈGLES DE CONSTRUCTION d'un titre ne sont pas ici (inchangées :
 * `services/ai/source-analysis/document-title.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Mots qui, seuls ou suivis de chiffres / d'un horodatage, forment un nom
 * technique : noms générés par un serveur, un appareil photo, un scanner ou
 * un navigateur. Minuscules, sans accent.
 */
export const TECHNICAL_WORDS = [
  'upload', 'uploaded', 'uploads', 'tmp', 'temp', 'temporary', 'file', 'files', 'fichier', 'blob', 'attachment',
  'document', 'documents', 'doc', 'image', 'img', 'photo', 'pic', 'scan', 'scanned', 'capture', 'screenshot',
  'pxl', 'dsc', 'dscn', 'dcim', 'vid', 'video', 'mvimg', 'wa', 'copy', 'copie', 'untitled', 'sans', 'titre',
  'nouveau', 'new', 'download', 'telechargement', 'export', 'storage', 'object', 'key', 'id', 'uuid',
] as const;

const TECH = new Set<string>(TECHNICAL_WORDS);

const UUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;
const S3_KEY = /^(?:verebona|owntrack)\/u_\d+\//i;
/** Nom de stockage `{horodatage ms}_{nom}` (`s3-naming.ts`). */
const STORAGE_TIMESTAMP_PREFIX = /^\d{10,13}_/;
const EXTENSION = /\.[a-z0-9]{1,5}$/i;
const SEPARATORS = /[\s_.\-()[\]{}+,;:#~]+/;

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Jeton technique : nombre, UUID, empreinte, jeton aléatoire, mot technique, préfixe court + chiffres. */
function isTechnicalToken(tok: string): boolean {
  if (!tok) return true;
  if (/^\d+$/.test(tok)) return true;
  if (TECH.has(tok)) return true;
  if (/^[0-9a-f]{16,}$/.test(tok)) return true;
  // Jeton aléatoire (base62 / base64url) : ≥ 20 caractères mêlant lettres et chiffres.
  if (/^[a-z0-9]{20,}$/.test(tok) && /\d/.test(tok) && /[a-z]/.test(tok)) return true;
  // « WA0001 », « f123 », « v2 » : préfixe court suivi de chiffres.
  if (/^[a-z]{1,3}\d+$/.test(tok)) return true;
  // Mot technique collé à des chiffres : « upload12345 », « IMG20240418 ».
  const m = /^([a-z]+)(\d+)$/.exec(tok);
  return !!m && TECH.has(m[1]);
}

export interface TitleIdentifiers {
  /** Clé objet du fichier (jamais un titre). */
  s3Key?: string | null;
  /** Identifiant public du document. */
  publicId?: string | null;
}

/**
 * Le titre est-il un titre MÉTIER ? Détection générique, indépendante du
 * type documentaire. `ids` : identifiants techniques du document, jamais
 * acceptés comme titre.
 */
export function isValidBusinessTitle(title: string | null | undefined, ids: TitleIdentifiers = {}): boolean {
  if (title == null) return false;
  const brut = title.trim();
  if (!brut) return false;
  if (ids.s3Key && brut === ids.s3Key.trim()) return false;
  if (ids.publicId && normalize(brut) === normalize(ids.publicId)) return false;
  if (S3_KEY.test(brut) || STORAGE_TIMESTAMP_PREFIX.test(brut)) return false;

  let t = normalize(brut);
  // Jusqu'à deux extensions (« scan.pdf.pdf », « archive.tar.gz »).
  for (let i = 0; i < 2 && EXTENSION.test(t); i++) t = t.replace(EXTENSION, '').trim();
  if (!t) return false;
  // Aucune lettre : horodatage, numéro seul.
  if (!/\p{L}/u.test(t)) return false;
  // Les UUID sont retirés AVANT le découpage (leurs tirets sont des séparateurs).
  const tokens = t.replace(UUID, ' ').split(SEPARATORS).filter(Boolean);
  return !tokens.every(isTechnicalToken);
}

export interface DisplayTitleSource {
  retainedTitle?: string | null;
  webLinkTitle?: string | null;
  originalFilename?: string | null;
  fileName?: string | null;
  filename?: string | null;
  s3Key?: string | null;
  publicId?: string | null;
}

/**
 * Titre à afficher (tiroir, listes, vignettes, accueil, recherche, exports) :
 * titre métier → nom original exploitable → nom technique en dernier recours.
 */
export function displayDocumentTitle(doc: DisplayTitleSource, fallback = 'Document sans titre'): string {
  const ids = { s3Key: doc.s3Key ?? null, publicId: doc.publicId ?? null };
  const candidats = [doc.retainedTitle, doc.webLinkTitle, doc.originalFilename, doc.fileName, doc.filename]
    .map((c) => c?.trim() ?? '')
    .filter((c) => c.length > 0);
  return candidats.find((c) => isValidBusinessTitle(c, ids)) ?? candidats[0] ?? fallback;
}

/**
 * Prédicat SQL (PostgreSQL) — SUR-ENSEMBLE des titres techniques, pour
 * préfiltrer le balayage sans lire toute la table en JS. `col` : expression
 * de la colonne titre (ex. `f.retained_title`). Tout titre que
 * `isValidBusinessTitle` refuse y répond (vérifié en e2e sur base réelle) ;
 * la règle JS reste seule juge.
 *
 * Principe : extensions, UUID, empreintes, jetons aléatoires et mots
 * techniques retirés, il ne reste aucune suite de 4 lettres.
 */
export function technicalTitleSqlPredicate(col: string): string {
  const mots = [...TECHNICAL_WORDS].sort((a, b) => b.length - a.length).join('|');
  const base = `translate(unaccent(lower(coalesce(${col}, ''))), '_', ' ')`;
  const sansExt = `regexp_replace(btrim(${base}), '(\\.[a-z0-9]{1,5}){1,2}$', '')`;
  const nettoye = `regexp_replace(regexp_replace(${sansExt}, '[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9a-f]{16,}|[a-z0-9]{20,}', ' ', 'g'), '\\m(${mots})', ' ', 'g')`;
  return `(${col} IS NULL OR btrim(${col}) = '' OR btrim(${col}) ~* '^(verebona|owntrack)/u_[0-9]+/' OR btrim(${col}) ~ '^[0-9]{10,13}_' OR ${nettoye} !~ '[a-z]{4,}')`;
}
