/**
 * Nom d'affichage et initiales de l'utilisateur — source UNIQUE.
 *
 * Lot 33 (L33-2) : le menu de l'avatar sur ordinateur (TopBar) affichait le
 * nom d'affichage choisi dans Mon compte (`username`), le panneau du compte
 * mobile affichait toujours « Prénom N. ». Les deux écrans lisent désormais
 * cette fonction : le nom d'affichage s'il est renseigné, sinon le prénom
 * suivi de l'initiale du nom.
 */

export interface DisplayNameUser {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
}

/** Nom d'affichage : `username` s'il est renseigné, sinon « Prénom N. ». */
export function formatUserDisplayName(user: DisplayNameUser | null | undefined): string {
  if (!user) return '';
  const username = user.username?.trim();
  if (username) return username;
  const first = user.firstName?.trim() ?? '';
  const lastInitial = user.lastName?.trim().charAt(0) ?? '';
  return [first, lastInitial ? `${lastInitial}.` : ''].filter(Boolean).join(' ');
}

/** Initiales : première lettre du prénom et du nom, en capitales. */
export function formatUserInitials(user: DisplayNameUser | null | undefined): string {
  if (!user) return '';
  return `${user.firstName?.trim().charAt(0) ?? ''}${user.lastName?.trim().charAt(0) ?? ''}`.toUpperCase();
}
