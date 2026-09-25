/**
 * Refus de connexion d'un compte suspendu — CDC Back-Office V1 ACC-A02 / ACC-A03.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DRAPEAU `accounts.is_active` N'ÉTAIT LU NULLE PART
 *
 * La « suspension » du BO basculait `accounts.is_active` sans aucun effet :
 * ni le login, ni le renouvellement de session ne le consultaient. Le compte
 * suspendu restait pleinement utilisable.
 *
 * Désormais :
 *   - la suspension révoque toutes les sessions des membres
 *     (`services/admin/account-status.service.ts`) ;
 *   - `POST /api/auth/login` et `POST /api/auth/refresh` refusent d'ouvrir ou
 *     de prolonger une session sur un compte suspendu (403 ACCOUNT_SUSPENDED) ;
 *   - la réactivation remet le drapeau : la connexion redevient possible avec
 *     les identifiants existants, sans réinitialisation (ACC-A03).
 *
 * Le compte contrôlé est celui que la session ouvrirait
 * (`AccountService.getUserDefaultAccount` : le compte détenu d'abord).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { apiError } from '@/lib/api-errors';

export const ACCOUNT_SUSPENDED_MESSAGE =
  'Votre compte a été suspendu. Contactez le support Verebona pour en savoir plus.';

/**
 * Vrai si le compte est explicitement suspendu. Un compte absent (utilisateur
 * sans adhésion active) ou dont le drapeau n'est pas renseigné n'est pas
 * considéré comme suspendu.
 */
export function isAccountSuspended(account: { isActive?: boolean | null } | null | undefined): boolean {
  return account?.isActive === false;
}

/** Réponse 403 `ACCOUNT_SUSPENDED`, message en français. */
export function accountSuspendedResponse() {
  return apiError(403, 'ACCOUNT_SUSPENDED', ACCOUNT_SUSPENDED_MESSAGE);
}
