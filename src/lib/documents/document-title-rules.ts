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

// ══════════════════════════════════════════════════════════════════════════
// Lot 34E — QUALITÉ d'un titre (ticket « Documents : refondre le moteur de
// titre et assurer la repasse T3 sur l'existant »). Règles pures.
//
// `isValidBusinessTitle` ne dit que « technique ou non ». Un titre peut être
// valide techniquement mais AMÉLIORABLE fonctionnellement :
//   « Facture fibre internet » → valid = true, sufficient = false
//   (fournisseur Orange et période septembre 2026 connus, absents du titre).
// `shouldReplaceSystemTitle` n'autorise un remplacement que si le candidat
// APPORTE quelque chose (fournisseur, cible, période, sujet, doublon résolu,
// titre générique ou technique remplacé) — jamais une simple reformulation.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Version des règles de titre. Une version supérieure rend automatiquement
 * tous les titres SYSTEM antérieurs éligibles au rattrapage T3
 * (`asset_files.title_rule_version`, migration 0293).
 *   · 1 (implicite, NULL en base) — lot 33C ;
 *   · 2 — lot 34E : nature + sujet + discriminants utiles, période métier,
 *     cible (bien / équipement / pièce), titres similaires du compte.
 */
export const DOCUMENT_TITLE_RULE_VERSION = 2;

export const TITLE_QUALITY_REASONS = [
  'TECHNICAL_TITLE', 'GENERIC_TITLE', 'MISSING_SUBJECT', 'MISSING_SUPPLIER', 'MISSING_TARGET', 'MISSING_PERIOD',
  'DUPLICATE_OR_TOO_SIMILAR', 'SUFFICIENT',
] as const;
export type TitleQualityReason = (typeof TITLE_QUALITY_REASONS)[number];

/** Motifs d'un renommage (ou d'une absence de renommage), journalisés. */
export type TitleChangeReason =
  | 'NON_COMPLIANT_TITLE' | 'GENERIC_TITLE' | 'SUPPLIER_ADDED' | 'PERIOD_ADDED' | 'TARGET_ADDED' | 'EQUIPMENT_ADDED'
  | 'DUPLICATE_DISAMBIGUATED' | 'FIRST_TITLE' | 'NO_BETTER_TITLE' | 'USER_TITLE_PROTECTED';

/** Ce que le MEILLEUR titre constructible porte (attentes d'un titre suffisant). */
export interface TitleExpectations {
  nature: string;
  subject: string | null;
  supplier: string | null;
  target: { kind: 'ASSET' | 'EQUIPMENT' | 'ROOM'; name: string } | null;
  /** Période / date retenue (« Septembre 2026 », « 18 septembre 2026 »). */
  period: string | null;
  /** Titres SYSTEM similaires d'autres documents du compte. */
  duplicates: string[];
}

export interface TitleEvaluation {
  valid: boolean;
  sufficient: boolean;
  improvable: boolean;
  reasons: TitleQualityReason[];
}

/** Forme normalisée d'un titre (minuscules, sans accent ni ponctuation). */
export function normalizeTitle(s: string | null | undefined): string {
  return normalize(String(s ?? '')).replace(/[’'`]/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const MOIS = 'janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre';

/** Le titre porte-t-il une période ou une date (mois + année, date numérique, année seule en fin) ? */
export function titleHasPeriod(title: string | null | undefined): boolean {
  const t = normalizeTitle(title);
  return new RegExp(`\\b(${MOIS})\\s+\\d{4}\\b`).test(t) || /\b\d{1,2}\s+\d{1,2}\s+\d{2,4}\b/.test(t) || /\b(19|20)\d{2}\s+\d{2}\b/.test(t)
    || /\b(t[1-4]|trimestre|semestre)\b.*\b(19|20)\d{2}\b/.test(t);
}

/** Tous les mots significatifs de `phrase` figurent-ils dans le titre ? */
export function titleHasPhrase(title: string | null | undefined, phrase: string | null | undefined): boolean {
  const mots = normalizeTitle(phrase).split(' ').filter((m) => m.length >= 2 && !['de', 'du', 'des', 'la', 'le', 'les', 'et'].includes(m));
  if (mots.length === 0) return true;
  const present = new Set(normalizeTitle(title).split(' '));
  return mots.every((m) => present.has(m));
}

/** Titre réduit à sa nature, ou nature + simple référence (« Facture », « Facture N° 2024-1187 »). */
function isGenericTitle(title: string, nature: string): boolean {
  const t = normalizeTitle(title);
  const n = normalizeTitle(nature);
  const reste = (t.startsWith(n) ? t.slice(n.length) : t).trim()
    .replace(/^(n|no|numero|num|ref|reference)\s+/, '').trim();
  if (!reste) return true;
  return reste.split(' ').every((m) => /\d/.test(m) || m.length <= 2);
}

/**
 * Qualité d'un titre au regard des données ACTUELLES (pure). `ids` : identifiants
 * techniques du document (jamais un titre).
 */
export function evaluateBusinessTitle(title: string | null | undefined, exp: TitleExpectations, ids: TitleIdentifiers = {}): TitleEvaluation {
  const valid = isValidBusinessTitle(title, ids);
  const reasons: TitleQualityReason[] = [];
  if (!valid) reasons.push('TECHNICAL_TITLE');
  else {
    const t = title!.trim();
    if (isGenericTitle(t, exp.nature)) reasons.push('GENERIC_TITLE');
    if (exp.subject && !titleHasPhrase(t, exp.subject) && isGenericTitle(t, exp.nature)) reasons.push('MISSING_SUBJECT');
    if (exp.supplier && !titleHasPhrase(t, exp.supplier)) reasons.push('MISSING_SUPPLIER');
    if (exp.target && !titleHasPhrase(t, exp.target.name)) reasons.push('MISSING_TARGET');
    if (exp.period && !titleHasPeriod(t) && !titleHasPhrase(t, exp.period)) reasons.push('MISSING_PERIOD');
    if (exp.duplicates.some((d) => normalizeTitle(d) === normalizeTitle(t))) reasons.push('DUPLICATE_OR_TOO_SIMILAR');
  }
  const sufficient = valid && reasons.length === 0;
  return { valid, sufficient, improvable: !sufficient, reasons: sufficient ? ['SUFFICIENT'] : reasons };
}

/**
 * Le candidat est-il RÉELLEMENT meilleur que le titre SYSTEM en place ?
 * (pure). Jamais une variation stylistique : « Facture fibre Orange _
 * Septembre 2026 » ne devient pas « Facture Orange fibre _ Septembre 2026 ».
 * Un candidat qui PERDRAIT une information du titre actuel (fournisseur,
 * cible, période) n'est pas retenu.
 */
export function shouldReplaceSystemTitle(
  current: string | null | undefined,
  candidate: string | null | undefined,
  exp: TitleExpectations,
  ids: TitleIdentifiers = {},
): { replace: boolean; reason: TitleChangeReason } {
  if (!candidate || !isValidBusinessTitle(candidate, ids)) return { replace: false, reason: 'NO_BETTER_TITLE' };
  if (normalizeTitle(current) === normalizeTitle(candidate)) return { replace: false, reason: 'NO_BETTER_TITLE' };
  const actuel = evaluateBusinessTitle(current, exp, ids);
  if (!actuel.valid) return { replace: true, reason: 'NON_COMPLIANT_TITLE' };
  const cur = current!.trim();

  // Perte d'information : jamais.
  const perd = (exp.supplier && titleHasPhrase(cur, exp.supplier) && !titleHasPhrase(candidate, exp.supplier))
    || (exp.target && titleHasPhrase(cur, exp.target.name) && !titleHasPhrase(candidate, exp.target.name))
    || (titleHasPeriod(cur) && !titleHasPeriod(candidate));
  if (perd) return { replace: false, reason: 'NO_BETTER_TITLE' };

  const manque = (r: TitleQualityReason) => actuel.reasons.includes(r);
  const candidat = evaluateBusinessTitle(candidate, exp, ids);
  const comble = (r: TitleQualityReason) => manque(r) && !candidat.reasons.includes(r);
  if (comble('GENERIC_TITLE') || comble('MISSING_SUBJECT')) return { replace: true, reason: 'GENERIC_TITLE' };
  if (comble('DUPLICATE_OR_TOO_SIMILAR')) return { replace: true, reason: 'DUPLICATE_DISAMBIGUATED' };
  if (comble('MISSING_TARGET')) return { replace: true, reason: exp.target?.kind === 'ASSET' ? 'TARGET_ADDED' : 'EQUIPMENT_ADDED' };
  if (comble('MISSING_SUPPLIER')) return { replace: true, reason: 'SUPPLIER_ADDED' };
  if (comble('MISSING_PERIOD')) return { replace: true, reason: 'PERIOD_ADDED' };
  return { replace: false, reason: 'NO_BETTER_TITLE' };
}
