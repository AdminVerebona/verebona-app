/**
 * Export RGPD « Mes données » dans les ÉTATS RESTREINTS — lot 102C (ticket
 * conformité légale, P2 « Export RGPD dans les états restreints »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE : L'EXPORT N'EST JAMAIS RETIRÉ À UN UTILISATEUR QUI PEUT SE CONNECTER
 *
 * États restreints couverts (décisions PO du ticket) :
 *   · lecture seule après la fin de l'essai (90 jours de conservation) ;
 *   · lecture seule après la fin d'un abonnement payant ;
 *   · lecture seule après une rétractation ;
 *   · suppression demandée, en attente de purge (`PENDING_DELETION`) ;
 *   · impayé (compte restreint) et compte sans abonnement.
 * Seuls un compte SUSPENDU par l'administration ou déjà SUPPRIMÉ n'y ont
 * pas accès (la connexion elle-même leur est refusée).
 *
 * Mécanismes actuels qui garantissent l'accès (vérifiés par les tests L102C) :
 *   1. middleware (Edge) : les routes d'export ne sont soumises qu'à la
 *      session ; pour un compte `PENDING_DELETION`, elles figurent dans la
 *      liste d'autorisations `GDPR_EXPORT_API_ALLOWLIST` reprise par
 *      `lib/auth/account-closure` (ALLOWED) — même liste, une seule source ;
 *   2. `SessionService.getSession` (défense en profondeur) : même liste ;
 *   3. les gardes de lecture seule (`write-access-guard`,
 *      `entitlements.service`) ne sont JAMAIS appelées par les routes
 *      d'export : un `canWrite: false` n'y change rien ;
 *   4. l'interface « Mes données » est affichée dans Mon compte en mode
 *      restreint et sur l'écran « Compte en cours de suppression ».
 *
 * RACCORD 102A (modèle d'état restreint du compte) : ce module ne dépend
 * d'aucun modèle d'état. 102A appelle `canExportInRestrictedState(état)` et
 * reprend `GDPR_EXPORT_API_ALLOWLIST` dans sa propre liste d'autorisations
 * (ou `isGdprExportApiRequest`) ; tout nouvel état restreint qu'il crée doit
 * renvoyer `true` ici (test L102C-EXP-02 à étendre). Voir
 * docs/exploitation/export-rgpd-etats-restreints.md.
 *
 * Module PUR (lu par le middleware Edge) : aucune base, aucun import Node.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * États de compte connus aujourd'hui (sans dépendre du modèle 102A). Les
 * valeurs de `getEntitlements().status` (`readonly`, `canceled`, `past_due`,
 * `none`) et le statut utilisateur `PENDING_DELETION` s'y projettent par
 * `restrictedStateOf`.
 */
export type RestrictedAccountState =
  | 'active'
  | 'trial_readonly'
  | 'subscription_ended_readonly'
  | 'withdrawal_readonly'
  | 'unpaid_restricted'
  | 'no_subscription'
  | 'pending_deletion'
  | 'suspended'
  | 'deleted';

/** États où l'export reste possible : tous, sauf suspendu / supprimé. */
const EXPORT_ALLOWED_STATES: ReadonlySet<RestrictedAccountState> = new Set([
  'active',
  'trial_readonly',
  'subscription_ended_readonly',
  'withdrawal_readonly',
  'unpaid_restricted',
  'no_subscription',
  'pending_deletion',
]);

/**
 * L'utilisateur peut-il demander et télécharger son export RGPD dans cet
 * état ? Point d'appel de 102A. Un état INCONNU (chaîne nouvelle) est
 * traité comme autorisé : un oubli de raccord ne doit jamais retirer un
 * droit RGPD (les refus explicites sont seulement `suspended` / `deleted`).
 */
export function canExportInRestrictedState(state: RestrictedAccountState | string | null | undefined): boolean {
  if (state === 'suspended' || state === 'deleted') return false;
  if (state == null) return true;
  return EXPORT_ALLOWED_STATES.has(state as RestrictedAccountState) || !KNOWN_STATES.has(state);
}

const KNOWN_STATES: ReadonlySet<string> = new Set([...EXPORT_ALLOWED_STATES, 'suspended', 'deleted']);

/**
 * Projection des mécanismes ACTUELS vers un état (sans modèle 102A) :
 * statut utilisateur (`users.status`) puis statut d'abonnement
 * (`getEntitlements().status`). `withdrawn` : rétractation constatée
 * (`withdrawal_requests` traitée) — fourni par l'appelant s'il le sait.
 */
export function restrictedStateOf(input: {
  userStatus?: string | null;
  subscriptionStatus?: string | null;
  withdrawn?: boolean;
}): RestrictedAccountState {
  const u = (input.userStatus ?? '').toUpperCase();
  if (u === 'DELETED') return 'deleted';
  if (u === 'SUSPENDED') return 'suspended';
  if (u === 'PENDING_DELETION') return 'pending_deletion';
  if (input.withdrawn) return 'withdrawal_readonly';
  switch ((input.subscriptionStatus ?? '').toLowerCase()) {
    case 'readonly': return 'trial_readonly';
    case 'canceled':
    case 'cancelled':
    case 'expired': return 'subscription_ended_readonly';
    case 'past_due':
    case 'unpaid': return 'unpaid_restricted';
    case 'none':
    case '': return 'no_subscription';
    default: return 'active';
  }
}

/** Routes de l'export RGPD (demande, état, téléchargement des parties). */
export const GDPR_EXPORT_API_ALLOWLIST: ReadonlyArray<{ path: string; methods: ReadonlyArray<string> }> = [
  { path: '/api/users/me/gdpr-export', methods: ['GET', 'POST'] },
  { path: '/api/users/me/gdpr-export/download', methods: ['GET'] },
];

/** Requête vers l'export RGPD ? (chemin exact, méthode autorisée ; HEAD/OPTIONS admis). */
export function isGdprExportApiRequest(pathname: string, method: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  return GDPR_EXPORT_API_ALLOWLIST.some((a) => a.path === p && (m === 'HEAD' || m === 'OPTIONS' || a.methods.includes(m)));
}

/** Numéro de partie demandé au téléchargement (`?part=N`, 1 si absent) ; null si invalide. */
export function parseExportPartParam(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return 1;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}
