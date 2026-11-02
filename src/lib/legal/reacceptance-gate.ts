/**
 * Réacceptation des CGUV — règles d'accès (lot 102B). Module PUR.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VERSION SUBSTANTIELLE NON ACCEPTÉE → USAGE NORMAL BLOQUÉ
 *
 * Quand une version publiée « substantielle » (`requiresReacceptance = true`,
 * décision figée avec la version) est en vigueur et que l'utilisateur n'a
 * accepté ni elle ni une version postérieure, l'usage normal s'arrête jusqu'à
 * son acceptation explicite :
 *   · écran dédié (ordinateur, mobile et vue de l'application) ;
 *   · API : les ÉCRITURES métier sont refusées (403
 *     `CGUV_REACCEPTANCE_REQUIRED`) ; les lectures restent permises.
 * Restent toujours possibles : lire le texte (site public), accepter, se
 * déconnecter, exporter ses données (RGPD), supprimer son compte, résilier
 * son abonnement, exercer la rétractation, la sécurité du compte et le BO.
 * Version NON substantielle : aucune réacceptation, aucun blocage.
 *
 * LOT 104A (P1-E) — « NON REQUIS » ≠ « CONTRÔLE IMPOSSIBLE »
 * Si le contrôle ne peut pas être fait (base injoignable, état incohérent :
 * version substantielle due mais aucune version en vigueur à présenter), les
 * écritures métier sont refusées TEMPORAIREMENT (503
 * `CGUV_CHECK_UNAVAILABLE`, message explicite, Supervision) — jamais
 * acceptées implicitement. Les accès indispensables ci-dessous restent
 * ouverts dans les deux cas (même liste).
 * ══════════════════════════════════════════════════════════════════════════
 */

export const CGUV_REACCEPTANCE_REQUIRED_CODE = 'CGUV_REACCEPTANCE_REQUIRED';

export const CGUV_REACCEPTANCE_REQUIRED_MESSAGE =
  'Les CGUV ont changé : acceptez la nouvelle version pour continuer. Vous pouvez la lire, exporter vos données ou vous déconnecter.';

/** Événement navigateur émis par le client API sur ce refus. */
export const CGUV_REACCEPTANCE_EVENT = 'verebona:cguv-reacceptance-required';

/** Lot 104A : contrôle de réacceptation impossible → écritures métier suspendues (503). */
export const CGUV_CHECK_UNAVAILABLE_CODE = 'CGUV_CHECK_UNAVAILABLE';

export const CGUV_CHECK_UNAVAILABLE_MESSAGE =
  'Vérification des CGUV momentanément impossible : par sécurité, les modifications sont suspendues. '
  + 'Vous pouvez consulter et exporter vos données, lire les CGUV ou vous déconnecter. Réessayez dans un instant.';

/** Événement navigateur émis par le client API sur ce refus temporaire. */
export const CGUV_CHECK_UNAVAILABLE_EVENT = 'verebona:cguv-check-unavailable';

/** Préfixes d'API toujours ouverts (écritures comprises). */
const ALWAYS_ALLOWED_PREFIXES: readonly string[] = [
  '/api/auth/',               // déconnexion, renouvellement, connexion sociale, réauthentification
  '/api/me/legal/',           // acceptation, version applicable, preuves
  '/api/legal/',              // métadonnées publiques
  '/api/users/me/gdpr-export',// export RGPD
  '/api/users/me/deletion',   // suppression du compte
  '/api/users/me/password',
  '/api/users/me/change-password',
  '/api/users/me/sessions',   // appareils connectés (sécurité)
  '/api/users/me/security',
  '/api/withdrawal/',         // droit de rétractation
  '/api/billing/cancel-subscription',
  '/api/billing/stop-renewal',
  '/api/billing/create-customer-portal-session',
  '/api/admin/',              // back-office (exploitation)
  '/api/mobile/',             // enregistrement de l'appareil, configuration
  '/api/cron/',
];

/** L'appel d'API reste-t-il permis à un utilisateur à qui la réacceptation est demandée ? */
export function isApiAllowedDuringReacceptance(pathname: string, method: string): boolean {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const p = pathname.replace(/\/+$/, '') || '/';
  return ALWAYS_ALLOWED_PREFIXES.some((prefix) => {
    const base = prefix.replace(/\/$/, '');
    return p === base || p.startsWith(`${base}/`);
  });
}

/** Pages qui restent affichées sans l'écran de réacceptation. */
export function isPageAllowedDuringReacceptance(pathname: string): boolean {
  return pathname === '/compte-en-suppression' || pathname.startsWith('/admin');
}

/**
 * Issue du contrôle (lot 104A) : `not_required` (aucune version substantielle
 * due, ou phase de transition), `required` (écran dédié, écritures refusées),
 * `unavailable` (contrôle impossible : écritures suspendues, pas d'écran
 * d'acceptation — il n'y a rien de fiable à présenter).
 */
export type ReacceptanceStatus = 'not_required' | 'required' | 'unavailable';

/** État servi au client par `/api/users/me` et `/api/me/legal/cguv-applicable`. */
export interface ReacceptanceState {
  required: boolean;
  /** Lot 104A : absent chez un serveur antérieur (= déduit de `required`). */
  status?: ReacceptanceStatus;
  /** Version à accepter (la version en vigueur). */
  versionCode: string | null;
  permalinkUrl: string | null;
  changeSummary: string | null;
  effectiveAt: string | null;
  /** Version substantielle à l'origine de la demande. */
  substantialVersionCode: string | null;
}

export const NO_REACCEPTANCE: ReacceptanceState = Object.freeze({
  required: false, status: 'not_required', versionCode: null, permalinkUrl: null, changeSummary: null, effectiveAt: null, substantialVersionCode: null,
}) as ReacceptanceState;

/** Lot 104A : contrôle impossible — aucune écriture métier tant qu'il le reste. */
export const REACCEPTANCE_UNAVAILABLE: ReacceptanceState = Object.freeze({
  required: false, status: 'unavailable', versionCode: null, permalinkUrl: null, changeSummary: null, effectiveAt: null, substantialVersionCode: null,
}) as ReacceptanceState;

/** Statut effectif d'un état reçu (compatibilité : état sans `status`). */
export function reacceptanceStatusOf(state: Pick<ReacceptanceState, 'required' | 'status'> | null | undefined): ReacceptanceStatus {
  if (!state) return 'not_required';
  if (state.status === 'unavailable' || state.status === 'required' || state.status === 'not_required') return state.status;
  return state.required ? 'required' : 'not_required';
}
