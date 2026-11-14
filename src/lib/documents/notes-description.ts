/**
 * Champ unique « Notes / Description » d'un document — lot 113Z (Trello #723).
 *
 * Module PUR (aucun accès base), importé côté serveur ET côté client : la même
 * règle décide de ce qu'affichent le tiroir (desktop / mobile), la route GET
 * du document et le diagnostic BO.
 *
 * Deux colonnes, deux rôles (aucune migration de l'une vers l'autre) :
 *   · `asset_files.notes`        texte de l'UTILISATEUR (éditable) ;
 *   · `asset_files.description`  description T1 (interne / compatibilité
 *                                historique), jamais écrite par le tiroir.
 * Priorité d'affichage : notes utilisateur > description T1 > vide.
 *   · reprise en main explicite (`notes_user_owned`) → `notes`, même VIDE
 *     (effacement volontaire : la description ne réapparaît jamais) ;
 *   · sinon `notes` non vide (saisies antérieures au lot, faites par
 *     l'utilisateur dans l'ancien champ « Notes ») ;
 *   · sinon `description` ; provenance « IA » SEULEMENT si elle est établie
 *     (`description_source = 'T1'`), sinon origine inconnue (aucun badge) ;
 *   · sinon vide.
 * « Saisie utilisateur » est une indication d'origine, pas une preuve.
 */

/** Libellé du champ (ticket #723, repris à l'identique). */
export const NOTES_DESCRIPTION_LABEL = 'Notes / Description';

/** Provenance affichable : USER (saisie), AI (T1 établi), UNKNOWN (historique non qualifié). */
export type NotesDescriptionOrigin = 'USER' | 'AI' | 'UNKNOWN';

export interface NotesDescriptionRecord {
  notes?: string | null;
  description?: string | null;
  /** `asset_files.notes_user_owned` (absent : colonne non migrée → false). */
  notesUserOwned?: boolean | null;
  /** `asset_files.description_source` (`'T1'` = provenance établie). */
  descriptionSource?: string | null;
}

export interface NotesDescriptionView {
  /** Texte affiché (chaîne vide si rien). */
  text: string;
  /** Provenance du texte affiché ; `null` quand le champ est vide sans saisie. */
  origin: NotesDescriptionOrigin | null;
  /** L'utilisateur a repris la main (texte modifié enregistré, ou effacé volontairement). */
  userOwned: boolean;
  /** Le texte vient de `notes` (true) ou de `description` (false). */
  fromNotes: boolean;
}

const plein = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim().length > 0;

/** Ce qu'affiche « Notes / Description » (règle unique). Pure. */
export function resolveNotesDescription(r: NotesDescriptionRecord): NotesDescriptionView {
  if (r.notesUserOwned === true) {
    const text = plein(r.notes) ? r.notes.trim() : '';
    return { text, origin: 'USER', userOwned: true, fromNotes: true };
  }
  if (plein(r.notes)) return { text: r.notes.trim(), origin: 'USER', userOwned: false, fromNotes: true };
  if (plein(r.description)) {
    return { text: r.description.trim(), origin: r.descriptionSource === 'T1' ? 'AI' : 'UNKNOWN', userOwned: false, fromNotes: false };
  }
  return { text: '', origin: null, userOwned: false, fromNotes: false };
}

/** Normalisation de comparaison : espaces de fin de ligne et de bord, fins de ligne. */
export function normalizeNotesText(v: string | null | undefined): string {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim() : '';
}

/**
 * Écriture demandée par l'édition du champ unique. Ouvrir / enregistrer SANS
 * modifier le texte → rien (ni valeur, ni provenance). Texte modifié →
 * `notes` = texte (null si effacé) et reprise en main. Pure.
 */
export function notesWriteFromEdit(shown: string | null | undefined, edited: string | null | undefined):
  { write: false } | { write: true; notes: string | null; cleared: boolean } {
  const avant = normalizeNotesText(shown);
  const apres = normalizeNotesText(edited);
  if (avant === apres) return { write: false };
  return { write: true, notes: apres || null, cleared: apres.length === 0 };
}

/** Borne d'une note utilisateur (caractères). */
export const NOTES_MAX_LENGTH = 5000;

/** Code d'erreur d'une note trop longue (carte #767, E04). */
export const NOTES_TOO_LONG_CODE = 'NOTES_TOO_LONG';
/** Message d'une note trop longue — même texte que la modification d'un document (lot 113Z). */
export const NOTES_TOO_LONG_MESSAGE = `${NOTES_DESCRIPTION_LABEL} : ${NOTES_MAX_LENGTH} caractères au plus`;
/** Message d'un texte libre qui n'est pas une chaîne. */
export const NOTES_INVALID_MESSAGE = `${NOTES_DESCRIPTION_LABEL} invalide`;

export type NotesInputValidation =
  | { ok: true; notes: string | null }
  | { ok: false; code: typeof NOTES_TOO_LONG_CODE | 'INVALID_INPUT'; message: string; max: number; length: number | null };

/**
 * Carte #767 (E04) — validation du texte libre saisi à la CRÉATION d'un
 * document (import, lien web). Plus aucune troncature silencieuse : au-delà de
 * `NOTES_MAX_LENGTH`, la demande est refusée (aucune écriture), avec la limite.
 *
 *   · `notes` : champ courant ; `legacyDescription` : ancien champ « Titre /
 *     Description » des clients antérieurs, lu comme texte libre de
 *     l'utilisateur (→ `notes`, jamais la description T1) quand `notes` est vide ;
 *   · longueur comptée comme le fait le champ de saisie (`maxLength` : unités
 *     UTF-16 du texte reçu, avant rognage des bords) et comme la modification
 *     d'un document — une même saisie est acceptée ou refusée partout ;
 *   · vide, absent ou `null` → aucune note (`notes: null`).
 * Pure.
 */
export function validateNotesInput(notes: unknown, legacyDescription?: unknown): NotesInputValidation {
  const refusType: NotesInputValidation = { ok: false, code: 'INVALID_INPUT', message: NOTES_INVALID_MESSAGE, max: NOTES_MAX_LENGTH, length: null };
  for (const v of [notes, legacyDescription]) {
    if (v !== undefined && v !== null && typeof v !== 'string') return refusType;
  }
  const choisi = typeof notes === 'string' && notes.trim() ? notes
    : typeof legacyDescription === 'string' && legacyDescription.trim() ? legacyDescription : '';
  if (choisi.length > NOTES_MAX_LENGTH) {
    return { ok: false, code: NOTES_TOO_LONG_CODE, message: NOTES_TOO_LONG_MESSAGE, max: NOTES_MAX_LENGTH, length: choisi.length };
  }
  return { ok: true, notes: choisi.trim() || null };
}

// ── Trace T1 de la description (diagnostic, jamais affichée à l'utilisateur) ──

/** Constats T1 sur la description (colonne `description_t1_status`, migration 1580). */
export const DESCRIPTION_T1_STATUSES = [
  'PRODUCED', 'ABSENT', 'REMOVED_AT_VALIDATION', 'PERSIST_FAILED', 'KEPT_UNKNOWN_ORIGIN', 'KEPT_USER_LOCKED', 'RECOVERED',
] as const;
export type DescriptionT1Status = (typeof DESCRIPTION_T1_STATUSES)[number];
