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
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUEL COMPTE EST CONTRÔLÉ (revue indépendante)
 *
 * Le contrôle portait sur le compte « par défaut », choisi par un tri
 * instable (`Array.sort` avec un comparateur qui ne renvoyait jamais 0 de
 * façon cohérente) : selon l'ordre des lignes renvoyées par PostgreSQL, un
 * utilisateur membre de deux comptes pouvait être refusé alors qu'il avait
 * un compte actif, ou admis sur le compte suspendu au refresh.
 *
 * Règles retenues :
 *   - ordre STABLE des comptes d'un utilisateur : titulaire (`owner`)
 *     d'abord, puis administrateur, puis membre ; à rôle égal, le plus
 *     ancien (date d'adhésion, sinon de création), puis l'id ;
 *   - LOGIN : la session s'ouvre sur le premier compte NON suspendu ; elle
 *     n'est refusée que si l'utilisateur a des comptes et qu'ils sont TOUS
 *     suspendus ;
 *   - REFRESH : c'est le compte DE LA SESSION (`currentAccountId`) qui est
 *     contrôlé. S'il est suspendu, la session n'est pas prolongée (une
 *     nouvelle connexion ouvrira, le cas échéant, un autre compte actif) ; si
 *     l'adhésion a disparu, on reprend la règle du login.
 *
 * ADMINISTRATEURS DU BACK-OFFICE (ADMIN / SUPER_ADMIN)
 *   Deux options étaient possibles : interdire de suspendre un compte dont
 *   un membre est administrateur, ou laisser passer les administrateurs.
 *   La première est la moins sûre : elle ferait d'un rôle BO un bouclier
 *   contre la suspension (un compte ne pourrait plus être suspendu dès
 *   qu'un administrateur y est invité), et un administrateur pourrait
 *   protéger ses propres données de toute mesure.
 *   Solution retenue : la suspension s'applique à tous, administrateurs
 *   compris, pour les DONNÉES du compte ; mais un administrateur garde
 *   toujours l'accès au BO. Si tous ses comptes sont suspendus, sa session
 *   s'ouvre SANS compte courant (`currentAccountId` absent) : les routes
 *   /api/admin/** (garde `SessionService.requireAdmin`, indépendante du
 *   compte) restent accessibles, aucune donnée du compte suspendu ne l'est.
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

/** Rôles du back-office qui gardent l'accès au BO malgré une suspension. */
export function isBackOfficeRole(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

/** Adhésion candidate à l'ouverture d'une session. */
export interface SessionAccountCandidate<A extends { id: number; isActive?: boolean | null }> {
  account: A;
  membershipId: number;
  role: string;
  joinedAt?: Date | null;
  createdAt?: Date | null;
}

const ROLE_RANK: Record<string, number> = { owner: 0, admin: 1, member: 2 };

function time(d: Date | null | undefined): number {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : Number.POSITIVE_INFINITY;
}

/**
 * Ordre stable : titulaire, puis administrateur, puis membre ; à rôle égal,
 * adhésion la plus ancienne ; en dernier recours l'id d'adhésion — le
 * comparateur est total, le résultat ne dépend donc plus de l'ordre SQL.
 */
export function orderSessionAccounts<A extends { id: number; isActive?: boolean | null }>(
  candidates: SessionAccountCandidate<A>[],
): SessionAccountCandidate<A>[] {
  return [...candidates].sort((a, b) =>
    (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9)
    || time(a.joinedAt ?? a.createdAt) - time(b.joinedAt ?? b.createdAt)
    || a.membershipId - b.membershipId);
}

export type SessionAccountResolution<A> =
  | { allowed: true; account: A | null; reason: 'ACTIVE_ACCOUNT' | 'NO_ACCOUNT' | 'BACK_OFFICE_ONLY' }
  | { allowed: false; reason: 'ALL_SUSPENDED' | 'SESSION_ACCOUNT_SUSPENDED'; suspendedAccountId: number };

/**
 * Choisit le compte sur lequel ouvrir (login) ou prolonger (refresh) une
 * session, selon les règles documentées en tête de fichier.
 *
 * @param preferredAccountId compte courant de la session (refresh) ; absent au login.
 */
export function resolveSessionAccount<A extends { id: number; isActive?: boolean | null }>(
  candidates: SessionAccountCandidate<A>[],
  opts: { role: string | null | undefined; preferredAccountId?: number | null },
): SessionAccountResolution<A> {
  const backOffice = isBackOfficeRole(opts.role);
  const ordered = orderSessionAccounts(candidates);

  if (opts.preferredAccountId != null) {
    const current = ordered.find((c) => c.account.id === opts.preferredAccountId);
    if (current) {
      if (!isAccountSuspended(current.account)) {
        return { allowed: true, account: current.account, reason: 'ACTIVE_ACCOUNT' };
      }
      // Compte de la session suspendu : pas de bascule silencieuse vers un
      // autre compte au refresh — la suspension met fin à CETTE session.
      if (backOffice) return { allowed: true, account: null, reason: 'BACK_OFFICE_ONLY' };
      return { allowed: false, reason: 'SESSION_ACCOUNT_SUSPENDED', suspendedAccountId: current.account.id };
    }
    // Adhésion disparue depuis l'émission du jeton : règle du login.
  }

  const firstActive = ordered.find((c) => !isAccountSuspended(c.account));
  if (firstActive) return { allowed: true, account: firstActive.account, reason: 'ACTIVE_ACCOUNT' };
  if (ordered.length === 0) return { allowed: true, account: null, reason: 'NO_ACCOUNT' };
  if (backOffice) return { allowed: true, account: null, reason: 'BACK_OFFICE_ONLY' };
  return { allowed: false, reason: 'ALL_SUSPENDED', suspendedAccountId: ordered[0].account.id };
}
