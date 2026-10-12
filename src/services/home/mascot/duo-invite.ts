/**
 * Mascotte — « Inviter quelqu'un » pour un nouvel abonné Premium Duo
 * (lot 49A, ticket 13).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Le titulaire (payeur) d'un abonnement Premium Duo actif qui n'a encore
 * invité personne se voit proposer EN PREMIER « Inviter quelqu'un ».
 *
 *   condition   le Duo du compte dont le titulaire est le payeur, statut
 *               d'abonnement ACTIVE (ou TRIALING hérité), AUCUNE invitation
 *               en cours (envoyée, même expirée) et AUCUN autre membre que
 *               le payeur, quel que soit son statut (invité, actif, parti,
 *               retiré) ;
 *   disparition dès qu'une invitation est envoyée (`pending_invite_email`)
 *               ou acceptée (ligne `duo_memberships`) — relu à chaque calcul
 *               de la prise de parole, aucun état propre à la mascotte ;
 *   hiérarchie  compte comme une action « À faire en premier » : avec elle,
 *               au plus UNE action DO_FIRST de la file (MASC3 : deux au
 *               plus au total) ;
 *   clic        parcours d'invitation EXISTANT (« Mon compte » › « 2e
 *               utilisateur Duo », `DuoInvitationPanel`), rien n'est écrit.
 *
 * Lu À CÔTÉ du collecteur (`collector.ts` inchangé) ; une lecture en échec
 * vaut « rien à proposer » (jamais une panne de la mascotte).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { MascotDuoInvite } from './types';

/** Ancre du panneau d'invitation existant (page « Mon compte »). */
export const DUO_INVITE_ANCHOR = 'duo-invitation';
export const DUO_INVITE_HREF = `/mon-compte#${DUO_INVITE_ANCHOR}`;

/** Statuts d'abonnement Duo qui permettent d'inviter. */
const INVITABLE_STATUSES = new Set(['ACTIVE', 'TRIALING']);

export interface DuoInviteRow {
  subscriptionStatus: string;
  pendingInviteEmail: string | null;
  /** Nombre de lignes `duo_memberships` (tous statuts). */
  memberships: number;
}

/** L'action à proposer, ou `null` (pure). */
export function duoInviteFrom(row: DuoInviteRow | null | undefined): MascotDuoInvite | null {
  if (!row) return null;
  if (!INVITABLE_STATUSES.has(String(row.subscriptionStatus ?? '').toUpperCase())) return null;
  if (row.pendingInviteEmail && row.pendingInviteEmail.trim() !== '') return null;
  if (row.memberships > 0) return null;
  return {
    href: DUO_INVITE_HREF,
    title: 'Inviter quelqu’un',
    subtitle: 'Partagez votre espace Premium Duo',
    cta: 'Inviter',
  };
}

/** Lecture (serveur) : le Duo du compte, dont le titulaire du compte est le payeur. */
export async function readDuoInvite(accountId: number): Promise<MascotDuoInvite | null> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    // Le Duo du compte (`accounts.duo_account_id`) dont le titulaire du compte
    // est le payeur ; le payeur a lui-même une adhésion (slot 0) : seules
    // comptent celles d'un AUTRE utilisateur.
    `SELECT d.subscription_status AS "subscriptionStatus", d.pending_invite_email AS "pendingInviteEmail",
            (SELECT COUNT(*) FROM duo_memberships m
              WHERE m.duo_id = d.id AND m.user_id <> d.billing_owner_user_id)::int AS memberships
       FROM accounts a
       JOIN duo_accounts d ON d.id = a.duo_account_id AND d.billing_owner_user_id = a.owner_user_id
      WHERE a.id = $1
      LIMIT 1`,
    [accountId],
  )) as unknown as Array<{ subscriptionStatus: string; pendingInviteEmail: string | null; memberships: number }>;
  const r = rows[0];
  return duoInviteFrom(r ? { subscriptionStatus: r.subscriptionStatus, pendingInviteEmail: r.pendingInviteEmail, memberships: Number(r.memberships ?? 0) } : null);
}
