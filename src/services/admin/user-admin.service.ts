/**
 * Actions administrateur sur un utilisateur — CDC Back-Office V1 §6.3
 * (USR-A02 à USR-A09), REC-USR-02, REC-USR-04.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DERNIER ADMINISTRATEUR ACTIF EST PROTÉGÉ (USR-A09)
 *
 * Retirer le statut administrateur du dernier administrateur actif — ou le
 * désactiver, ce qui revient au même — rendrait le BO inaccessible à tous.
 * Le contrôle se fait DANS une transaction qui verrouille les lignes des
 * administrateurs actifs (`SELECT … FOR UPDATE`) : deux retraits simultanés
 * de deux administrateurs différents ne peuvent pas passer tous les deux.
 * Refus : `LAST_ADMIN` (HTTP 409).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN CHANGEMENT DE DROITS DOIT COUPER LES SESSIONS
 *
 * Le jeton d'accès porte le rôle et le statut. Sans révocation :
 *   - un utilisateur désactivé garderait l'accès jusqu'à l'expiration de son
 *     jeton (USR-A03) ;
 *   - un administrateur rétrogradé garderait le BO : `requireAdmin` fait
 *     confiance au rôle du jeton lorsqu'il vaut ADMIN.
 * Les deux actions révoquent donc toutes les sessions de la cible. La
 * promotion n'en a pas besoin : `requireAdmin` relit le rôle en base quand le
 * jeton dit USER.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { users } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { revokeUserSessionsNow } from '@/services/admin/account-status.service';

export const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;

export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && (ADMIN_ROLES as readonly string[]).includes(role);
}

/** Administrateur ACTIF : rôle admin et statut ACTIVE. */
export function isActiveAdmin(user: { role: string; status: string }): boolean {
  return isAdminRole(user.role) && user.status === 'ACTIVE';
}

/**
 * Règle USR-A09, pure : l'action retirerait-elle le dernier administrateur
 * actif ? `activeAdminIds` = administrateurs actifs AVANT l'action.
 */
export function wouldRemoveLastActiveAdmin(targetId: number, activeAdminIds: number[]): boolean {
  return activeAdminIds.includes(targetId) && activeAdminIds.length <= 1;
}

export class UserAdminError extends Error {
  constructor(readonly code: 'USER_NOT_FOUND' | 'LAST_ADMIN', message: string) {
    super(message);
    this.name = 'UserAdminError';
  }
}

export const LAST_ADMIN_MESSAGE =
  "Impossible : c'est le dernier administrateur actif. Accordez d'abord le statut administrateur à un autre utilisateur.";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Verrouille et renvoie les administrateurs actifs (dans la transaction). */
async function lockActiveAdminIds(tx: Tx): Promise<number[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.role, [...ADMIN_ROLES]), eq(users.status, 'ACTIVE')))
    .for('update');
  return rows.map((r) => r.id);
}

async function loadTarget(tx: Tx, userId: number) {
  const [row] = await tx
    .select({ id: users.id, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new UserAdminError('USER_NOT_FOUND', 'Utilisateur introuvable.');
  return row;
}

export interface StatusChange {
  before: { status: string };
  after: { status: string };
}

/**
 * Désactive un utilisateur (USR-A02, USR-A03). Le titulaire peut être
 * désactivé : le compte n'est ni supprimé, ni transféré. Aucun motif requis,
 * aucun e-mail (USR-A05).
 */
export async function suspendUser(userId: number): Promise<StatusChange> {
  const change = await db.transaction(async (tx) => {
    const activeAdmins = await lockActiveAdminIds(tx);
    const target = await loadTarget(tx, userId);
    if (wouldRemoveLastActiveAdmin(target.id, activeAdmins)) {
      throw new UserAdminError('LAST_ADMIN', LAST_ADMIN_MESSAGE);
    }
    await tx.update(users).set({ status: 'SUSPENDED', updatedAt: new Date() }).where(eq(users.id, userId));
    return { before: { status: target.status }, after: { status: 'SUSPENDED' } };
  });
  // Après validation : révoquer avant la validation laisserait une fenêtre où
  // un refresh réussirait sur un statut encore ACTIVE.
  await revokeUserSessionsNow(userId, 'ADMIN_DEACTIVATE');
  return change;
}

/**
 * Réactive un utilisateur (USR-A04) : identifiants inchangés, aucun
 * changement de mot de passe forcé, aucun e-mail.
 */
export async function reactivateUser(userId: number): Promise<StatusChange> {
  return db.transaction(async (tx) => {
    const target = await loadTarget(tx, userId);
    await tx.update(users).set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(users.id, userId));
    return { before: { status: target.status }, after: { status: 'ACTIVE' } };
  });
}

export interface RoleChange {
  before: { role: string };
  after: { role: string };
  changed: boolean;
}

/**
 * Accorde ou retire le statut administrateur (USR-A08, USR-A09). Un seul type
 * d'administrateur en V1 (GEN-002) : ADMIN. Un SUPER_ADMIN historique
 * rétrogradé devient USER.
 */
export async function setUserAdminStatus(userId: number, makeAdmin: boolean): Promise<RoleChange> {
  const change = await db.transaction(async (tx) => {
    const activeAdmins = await lockActiveAdminIds(tx);
    const target = await loadTarget(tx, userId);
    const already = isAdminRole(target.role) === makeAdmin;
    if (already) return { before: { role: target.role }, after: { role: target.role }, changed: false };

    if (!makeAdmin && wouldRemoveLastActiveAdmin(target.id, activeAdmins)) {
      throw new UserAdminError('LAST_ADMIN', LAST_ADMIN_MESSAGE);
    }
    const newRole = makeAdmin ? 'ADMIN' : 'USER';
    await tx.update(users).set({ role: newRole, updatedAt: new Date() }).where(eq(users.id, userId));
    return { before: { role: target.role }, after: { role: newRole }, changed: true };
  });
  if (change.changed && !makeAdmin) {
    await revokeUserSessionsNow(userId, 'ADMIN_ROLE_REVOKED');
  }
  return change;
}

/** « Déconnecter toutes les sessions » (USR-A06), sans lister les sessions. */
export async function forceLogoutUser(userId: number): Promise<{ revokedBefore: Date }> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new UserAdminError('USER_NOT_FOUND', 'Utilisateur introuvable.');
  const revokedBefore = await revokeUserSessionsNow(userId, 'ADMIN_FORCE_LOGOUT');
  return { revokedBefore };
}
