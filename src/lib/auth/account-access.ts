/**
 * Droits EFFECTIFS sur le compte courant d'une session — lot 54 (ticket
 * SEC-P0-CORR, SEC-01 « Révocation effective des droits »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Le jeton d'accès porte `currentAccountId`. Il était cru sur parole jusqu'à
 * son expiration : un membre retiré d'un compte partagé (`removeMember`), ou
 * qui l'avait quitté (`leaveAccount`), gardait l'accès aux données de ce
 * compte avec son ancien jeton.
 *
 * RÈGLE (une seule définition, ici) : à CHAQUE requête authentifiée, le
 * serveur vérifie en base que l'utilisateur a toujours un droit actif sur le
 * compte du jeton :
 *   · adhésion `account_memberships` au statut actif (titulaire, membre,
 *     administrateur — compte partagé ou compte personnel) ;
 *   · ou titulaire du compte (`accounts.owner_user_id`) — repli pour les
 *     comptes historiques sans ligne d'adhésion.
 *
 * Premium Duo (lot 72D) : les deux membres partagent le MÊME compte — le
 * titulaire par son adhésion `owner`, l'invité par son adhésion `member`
 * (`services/account/membership.service`). `duo_memberships` seul n'ouvre
 * aucun accès : c'est l'adhésion au compte, relue ici, qui fait foi ; sa
 * révocation (retrait, départ, fin d'offre) coupe l'accès dès la requête
 * suivante.
 *
 * Droit absent → `INVALID_TOKEN` (401) : le client tente UN renouvellement ;
 * `/api/auth/refresh` recalcule le compte de session parmi les adhésions
 * ACTIVES (`resolveSessionAccount`) — l'utilisateur garde ses autres
 * espaces, il perd seulement celui dont il a été retiré.
 *
 * AUCUN CACHE (ticket §12 « aucune optimisation ne doit réintroduire une
 * fenêtre d'accès non autorisé ») : une lecture par clé indexée
 * (`account_memberships_user_id_idx`). Base injoignable → `SESSION_UNAVAILABLE`
 * (503), jamais un faux « droit actif ».
 *
 * Aucune importation statique de `@/db` : module chargeable par la
 * configuration des tests unitaires (qui n'ouvrent aucune connexion).
 * ══════════════════════════════════════════════════════════════════════════
 */

type AccountAccessCheck = (userId: number, accountId: number) => Promise<boolean>;

/** Lecture en base : droit actif de `userId` sur `accountId`. */
const readAccountAccess: AccountAccessCheck = async (userId, accountId) => {
  const { pgClient } = await import('@/db');
  const rows = await pgClient<{ ok: number }[]>`
    SELECT 1 AS ok FROM account_memberships
     WHERE user_id = ${userId} AND account_id = ${accountId} AND status IN ('active', 'ACTIVE')
    UNION ALL
    SELECT 1 FROM accounts WHERE id = ${accountId} AND owner_user_id = ${userId}
    LIMIT 1`;
  return rows.length > 0;
};

let surcharge: AccountAccessCheck | null = null;

/**
 * TESTS UNITAIRES SEULEMENT (`src/test/setup.ts`) : aucun test unitaire
 * n'ouvre de connexion. Les e2e PostgreSQL exercent la lecture réelle.
 * `null` rétablit la lecture réelle.
 */
export function __setAccountAccessCheckForTests(fn: AccountAccessCheck | null): void {
  surcharge = fn;
}

/** Code levé par la garde : traduit en 401 (renouvellement puis connexion). */
const ACCOUNT_ACCESS_REVOKED = 'INVALID_TOKEN';

/**
 * Vrai si l'utilisateur a toujours un droit actif sur le compte. Lève
 * `SESSION_UNAVAILABLE` si la vérification est impossible (fail closed).
 */
export async function hasActiveAccountAccess(userId: number, accountId: number): Promise<boolean> {
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(accountId) || accountId <= 0) return false;
  try {
    return await (surcharge ?? readAccountAccess)(userId, accountId);
  } catch {
    const { SESSION_UNAVAILABLE_CODE } = await import('./session-errors');
    throw new Error(SESSION_UNAVAILABLE_CODE);
  }
}

/**
 * Garde commune (SessionService, `verifySessionAccessToken`) : un jeton dont
 * le compte courant n'est plus accessible est refusé (`INVALID_TOKEN`). Un
 * jeton sans compte courant n'est pas concerné (les routes qui exigent un
 * compte le refusent déjà).
 */
export async function assertSessionAccountAccess(payload: { userId: number; currentAccountId?: number | null }): Promise<void> {
  const accountId = payload.currentAccountId;
  if (accountId === undefined || accountId === null) return;
  if (!(await hasActiveAccountAccess(payload.userId, accountId))) {
    console.warn(JSON.stringify({ event: 'security.account_access_revoked', userId: payload.userId, accountId }));
    throw new Error(ACCOUNT_ACCESS_REVOKED);
  }
}
