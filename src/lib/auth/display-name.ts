/**
 * « Prénom ou pseudo » — lot 103B (décision PO du 31/10/2026). Source UNIQUE
 * des règles, partagée par le client (formulaires) et le serveur (POST
 * /api/users, inscription Google / Apple, PUT /api/users/me). Module PUR.
 *
 *   · stocké dans `users.username` (existant, déjà lu par l'accueil) ;
 *   · nom d'AFFICHAGE : NON unique (plusieurs « Sophie »), jamais un
 *     identifiant de connexion, jamais une identité légale ou de facturation ;
 *   · obligatoire pour un nouvel inscrit : espaces de bord retirés, refus d'une
 *     valeur vide ou faite seulement d'espaces / caractères invisibles,
 *     longueur bornée (DISPLAY_NAME_MAX_LENGTH), accents, Unicode et espaces
 *     internes acceptés ; caractères de contrôle refusés.
 *   · le texte est inséré tel quel (React échappe ; les e-mails neutralisent
 *     les valeurs, `lib/email/variable-safety.ts`) : « <b>Sophie</b> » reste
 *     un texte, jamais du HTML.
 *   · aucune recherche de disponibilité, aucune réservation, aucune unicité.
 */

/** Longueur maximale (caractères Unicode visibles, emoji composé = 1). Proposition du ticket : 60. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

export const DISPLAY_NAME_LABEL = 'Prénom ou pseudo';
export const DISPLAY_NAME_HELP = 'Utilisé pour personnaliser votre accueil';
export const DISPLAY_NAME_PLACEHOLDER = 'Sophie';

export type DisplayNameError = 'MISSING_DISPLAY_NAME' | 'DISPLAY_NAME_TOO_LONG' | 'INVALID_DISPLAY_NAME';

export const DISPLAY_NAME_ERROR_MESSAGES: Readonly<Record<DisplayNameError, string>> = {
  MISSING_DISPLAY_NAME: 'Indiquez votre prénom ou un pseudo.',
  DISPLAY_NAME_TOO_LONG: `Votre prénom ou pseudo ne doit pas dépasser ${DISPLAY_NAME_MAX_LENGTH} caractères.`,
  INVALID_DISPLAY_NAME: 'Votre prénom ou pseudo contient des caractères non autorisés.',
};

// Caractères de contrôle (C0, DEL, C1) et séparateurs de ligne / paragraphe.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Invisibles (espaces de largeur nulle, marques bidirectionnelles, BOM) : ne
// comptent pas comme contenu ; retirés aux bords.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u00ad]/g;

/** Nombre de caractères perçus (graphèmes si l'environnement le permet). */
function visibleLength(value: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: 'grapheme' }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
  if (Seg) {
    let n = 0;
    for (const _ of new Seg('fr', { granularity: 'grapheme' }).segment(value)) n += 1;
    return n;
  }
  return Array.from(value).length;
}

export type DisplayNameCheck = { ok: true; value: string } | { ok: false; code: DisplayNameError; message: string };

const fail = (code: DisplayNameError): DisplayNameCheck => ({ ok: false, code, message: DISPLAY_NAME_ERROR_MESSAGES[code] });

/** Valide et normalise une saisie (NFC, bords nettoyés, espaces internes réduits à un). */
export function validateDisplayName(raw: unknown): DisplayNameCheck {
  if (typeof raw !== 'string') return fail('MISSING_DISPLAY_NAME');
  if (CONTROL.test(raw.replace(/^\s+|\s+$/g, ''))) return fail('INVALID_DISPLAY_NAME');
  const value = raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`^(?:\\s|${INVISIBLE.source})+|(?:\\s|${INVISIBLE.source})+$`, 'g'), '')
    .trim();
  if (!value || !value.replace(INVISIBLE, '').trim()) return fail('MISSING_DISPLAY_NAME');
  if (visibleLength(value) > DISPLAY_NAME_MAX_LENGTH) return fail('DISPLAY_NAME_TOO_LONG');
  return { ok: true, value };
}

/** Champ civil facultatif (prénom / nom) : texte nettoyé, borné, jamais déduit du pseudo. */
export const CIVIL_NAME_MAX_LENGTH = 100;
export function cleanCivilName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').replace(/\s+/g, ' ').trim().slice(0, CIVIL_NAME_MAX_LENGTH);
}

/** Nom d'un nouveau compte autonome : « Compte de Sophie » (jamais « Compte de  »). */
export const NEUTRAL_ACCOUNT_NAME = 'Mon compte';
export function personalAccountName(user: { username?: string | null; firstName?: string | null; lastName?: string | null }): string {
  const name = user.username?.trim() || [user.firstName?.trim(), user.lastName?.trim()].filter(Boolean).join(' ');
  return name ? `Compte de ${name}` : NEUTRAL_ACCOUNT_NAME;
}
