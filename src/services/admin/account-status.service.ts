/**
 * Suspension / réactivation d'un compte par l'administrateur — CDC Back-Office
 * V1 §5.3.1 (ACC-A01 à ACC-A05), REC-ACC-02, REC-ACC-03.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SUSPENDRE = COUPER TOUT DE SUITE, PAS SEULEMENT MARQUER
 *
 * ACC-A02 : la suspension « révoque immédiatement toutes les sessions actives
 * de tous les utilisateurs du compte et bloque les nouvelles connexions ».
 *
 *   1. `accounts.is_active = false` — lu par le login et le refresh
 *      (`lib/auth/account-suspension.ts`), qui refusent ACCOUNT_SUSPENDED ;
 *   2. révocation globale des sessions de chaque membre actif (et du
 *      titulaire) : tout jeton émis avant est refusé, jeton d'accès compris
 *      (`SessionService.getSession`) ;
 *   3. cache local de la borne de révocation vidé, pour que l'effet soit
 *      immédiat sur cette instance (les autres suivent sous 60 s).
 *
 * Réactiver (ACC-A03) remet seulement le drapeau : aucune réinitialisation de
 * mot de passe, les identifiants existants fonctionnent de nouveau.
 *
 * ACC-A04 : aucun motif obligatoire. ACC-A05 : aucune notification.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db, revokeAllUserSessions } from '@/db';
import { accountMemberships, accounts } from '@/db/schema';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { serverCacheDelete } from '@/lib/server-cache';
import { sessionCutoffCacheKey } from '@/lib/auth/session-cutoff';

export type AccountStatusOutcome =
  | { ok: true; wasActive: boolean; isActive: boolean; revokedUserIds: number[] }
  | { ok: false; code: 'ACCOUNT_NOT_FOUND' };

/** Utilisateurs dont la session donne accès au compte : titulaire + membres actifs. */
export async function listAccountUserIds(accountId: number, ownerUserId: number): Promise<number[]> {
  const rows = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(
      and(
        eq(accountMemberships.accountId, accountId),
        isNotNull(accountMemberships.userId),
        or(eq(accountMemberships.status, 'active'), eq(accountMemberships.status, 'ACTIVE')),
      ),
    );
  return [...new Set([ownerUserId, ...rows.map((r) => r.userId as number)])];
}

/**
 * Révoque toutes les sessions d'un utilisateur et vide le cache local de sa
 * borne de révocation. Partagé par les actions compte et utilisateur.
 */
export async function revokeUserSessionsNow(userId: number, reason: string): Promise<Date> {
  const cutoff = await revokeAllUserSessions(userId, reason);
  serverCacheDelete(sessionCutoffCacheKey(userId));
  // `/api/users/me` garde 30 s une réponse en cache : sans cela, l'interface
  // continuerait d'afficher le profil d'une session déjà révoquée.
  serverCacheDelete(`users:me:${userId}`);
  return cutoff;
}

export async function suspendAccount(accountId: number): Promise<AccountStatusOutcome> {
  const [account] = await db
    .select({ id: accounts.id, ownerUserId: accounts.ownerUserId, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

  // Drapeau D'ABORD : un membre qui renouvellerait sa session entre la
  // révocation et la bascule serait sinon réadmis.
  await db.update(accounts).set({ isActive: false, updatedAt: new Date() }).where(eq(accounts.id, accountId));

  const userIds = await listAccountUserIds(accountId, account.ownerUserId);
  for (const userId of userIds) {
    await revokeUserSessionsNow(userId, 'ADMIN_ACCOUNT_SUSPEND');
  }

  return { ok: true, wasActive: account.isActive, isActive: false, revokedUserIds: userIds };
}

export async function reactivateAccount(accountId: number): Promise<AccountStatusOutcome> {
  const [account] = await db
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

  await db.update(accounts).set({ isActive: true, updatedAt: new Date() }).where(eq(accounts.id, accountId));
  return { ok: true, wasActive: account.isActive, isActive: true, revokedUserIds: [] };
}
