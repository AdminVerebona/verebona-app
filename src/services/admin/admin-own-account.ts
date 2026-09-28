/**
 * Compte PROPRE de l'administrateur connecté — CDC Back-Office V1 SEC-005,
 * COM-007, EXP-009. Les prévisualisations n'utilisent que ce compte.
 *
 * Le compte courant de la session est retenu s'il appartient à
 * l'administrateur (titulaire ou membre actif) ; sinon, son compte de
 * titulaire, puis sa première adhésion active. `null` : aucun compte.
 */
import { pgClient } from '@/db';

export async function resolveAdminOwnAccountId(adminUserId: number, sessionAccountId?: number | null): Promise<number | null> {
  const rows = await pgClient.unsafe<{ id: number; is_session: boolean; is_owner: boolean }[]>(
    `SELECT a.id, (a.id = $2) AS is_session, (a.owner_user_id = $1) AS is_owner
       FROM accounts a
      WHERE a.owner_user_id = $1
         OR EXISTS (SELECT 1 FROM account_memberships m
                     WHERE m.account_id = a.id AND m.user_id = $1 AND m.status = 'active')
      ORDER BY (a.id = $2) DESC, (a.owner_user_id = $1) DESC, a.id ASC
      LIMIT 1`,
    [adminUserId, sessionAccountId ?? 0],
  );
  return rows[0]?.id ?? null;
}
