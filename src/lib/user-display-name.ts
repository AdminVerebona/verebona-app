/**
 * Nom d'affichage et initiales de l'utilisateur — source UNIQUE.
 *
 * Lot 33 (L33-2) : le menu de l'avatar sur ordinateur (TopBar) affichait le
 * nom d'affichage choisi dans Mon compte (`username`), le panneau du compte
 * mobile affichait toujours « Prénom N. ». Les deux écrans lisent désormais
 * cette fonction : le nom d'affichage s'il est renseigné, sinon le prénom
 * suivi de l'initiale du nom.
 *
 * Lot 103B (décision PO du 31/10/2026) : « Prénom ou pseudo » (`username`)
 * est la seule donnée demandée à l'inscription ; prénom et nom civils sont
 * facultatifs. Ordre : pseudo → ancien prénom (comptes historiques) →
 * formulation neutre. Jamais « undefined », jamais d'initiales vides.
 */

interface DisplayNameUser {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  email?: string | null;
}

/** Libellé neutre quand aucun nom n'est connu (menu, panneau mobile). */
export const NEUTRAL_DISPLAY_NAME = 'Mon compte';

const clean = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Nom pour une salutation (« Bonjour Sophie », e-mails) : pseudo, sinon ancien
 * prénom, sinon chaîne vide (l'appelant écrit alors « Bonjour » sans nom).
 */
export function greetingName(user: DisplayNameUser | null | undefined): string {
  if (!user) return '';
  return clean(user.username) || clean(user.firstName);
}

/** Nom d'affichage : `username` s'il est renseigné, sinon « Prénom N. », sinon libellé neutre. */
export function formatUserDisplayName(user: DisplayNameUser | null | undefined): string {
  if (!user) return '';
  const username = clean(user.username);
  if (username) return username;
  const first = clean(user.firstName);
  const lastInitial = clean(user.lastName).charAt(0);
  const civil = [first, lastInitial ? `${lastInitial}.` : ''].filter(Boolean).join(' ');
  return civil || NEUTRAL_DISPLAY_NAME;
}

/** Première lettre ou chiffre d'un texte (Unicode, emoji compris), en capitale. */
function firstLetter(v: string): string {
  const m = v.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toLocaleUpperCase('fr-FR') : '';
}

/**
 * Initiales : prénom + nom civils s'ils sont tous deux connus (comptes
 * historiques, inchangé) ; sinon tirées du pseudo (« Sophie » → « S »,
 * « Jean Marc » → « JM ») ; sinon du prénom seul ; sinon de l'adresse ;
 * sinon « V » (Verebona) — jamais vides.
 */
export function formatUserInitials(user: DisplayNameUser | null | undefined): string {
  if (!user) return '';
  const first = clean(user.firstName);
  const last = clean(user.lastName);
  if (first && last) {
    const civil = `${firstLetter(first)}${firstLetter(last)}`;
    if (civil.length >= 2) return civil;
  }
  const username = clean(user.username);
  if (username) {
    const words = username.split(/\s+/).map(firstLetter).filter(Boolean);
    if (words.length) return words.slice(0, 2).join('');
  }
  return firstLetter(first) || firstLetter(last) || firstLetter(clean(user.email)) || 'V';
}
