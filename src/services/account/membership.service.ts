/**
 * Adhésions utilisateur ↔ compte — lot 72D (ticket P0 « Premium Duo — compte
 * partagé »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODÈLE UNIQUE Utilisateur ↔ Adhésion ↔ Compte
 *
 *   users                identité, authentification, préférences ;
 *   accounts             espace Verebona : données métier, abonnement, quotas ;
 *   account_memberships  relation utilisateur/compte : rôle (owner | member |
 *                        admin), statut (pending | active | removed | declined
 *                        | left), source, dernier choix.
 *
 * `account_memberships` est la SOURCE DE VÉRITÉ des accès : la garde de
 * chaque requête (`lib/auth/account-access`) la relit en base. Premium Duo
 * n'est qu'une offre du compte (deux places) : l'invité rejoint le compte
 * EXISTANT du titulaire, avec le rôle `member` — jamais un compte personnel,
 * jamais un essai, jamais un second abonnement.
 *
 * `duo_memberships` / `duo_accounts` restent écrits en DOUBLE pendant la
 * transition (lecture par l'ancien code, e-mails 64A/65A, relances) ; leur
 * contraction est hors lot 72D.
 *
 * Aucune limite structurelle à deux : la capacité est `accounts.max_members`
 * (une future offre Pro n'a rien à changer ici).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { accountAuditLog, accountMemberships, accounts, duoAccounts, duoMemberships, users } from '@/db/schema';
import { isDuoJoinable } from '@/lib/billing/subscription-status';
import { inviteTokenHash } from '@/lib/duo/invite-token-hash';
import { invalidateAccountReadCache, invalidateUserReadCache } from '@/lib/server-cache';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Runner = typeof db | Tx;

const ACTIVE_MEMBERSHIP_STATUSES = ['active', 'ACTIVE'] as const;
export type MembershipRole = 'owner' | 'admin' | 'member';

/** Places d'une offre partagée, à défaut de `max_members` cohérent (comptes historiques). */
const PLAN_SEATS: Record<string, number> = { PREMIUM_DUO: 2, DUO: 2 };

export function accountCapacity(account: { planType: string | null; maxMembers: number | null }): number {
  return Math.max(account.maxMembers ?? 1, PLAN_SEATS[String(account.planType ?? '').toUpperCase()] ?? 1);
}

// ── Lecture ─────────────────────────────────────────────────────────────────

/** Adhésion ACTIVE de `userId` sur `accountId` (rôle), ou null. */
async function getActiveMembership(
  userId: number,
  accountId: number,
  runner: Runner = db,
): Promise<{ id: number; role: MembershipRole } | null> {
  if (!Number.isInteger(accountId) || accountId <= 0) return null;
  const [row] = await runner
    .select({ id: accountMemberships.id, role: accountMemberships.role })
    .from(accountMemberships)
    .where(and(
      eq(accountMemberships.userId, userId),
      eq(accountMemberships.accountId, accountId),
      inArray(accountMemberships.status, [...ACTIVE_MEMBERSHIP_STATUSES]),
    ))
    .limit(1);
  return row ? { id: row.id, role: row.role as MembershipRole } : null;
}

/**
 * Compte de la session : `currentAccountId` du jeton ; à défaut (jeton
 * historique émis sans compte courant), l'espace par défaut de l'utilisateur
 * — adhésion ACTIVE, dernier espace choisi d'abord, compte archivé écarté —
 * comme le faisait le repli « première adhésion » des routes, mais dans un
 * ordre déterministe. null : identité sans espace.
 */
export async function effectiveAccountId(session: { userId: number; currentAccountId?: number | null }): Promise<number | null> {
  if (session.currentAccountId) return session.currentAccountId;
  const { AccountService } = await import('@/services/account-service');
  return (await AccountService.getUserDefaultAccount(session.userId))?.id ?? null;
}

/**
 * Rôle de la session sur SON compte courant. Un compte historique sans ligne
 * d'adhésion dont l'utilisateur est `owner_user_id` vaut titulaire (repli de
 * la garde d'accès, retiré à la contraction).
 */
export async function getSessionRole(session: { userId: number; currentAccountId?: number | null }): Promise<MembershipRole | null> {
  const accountId = await effectiveAccountId(session);
  if (!accountId) return null;
  const m = await getActiveMembership(session.userId, accountId);
  if (m) return m.role;
  const [legacy] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ownerUserId, session.userId)))
    .limit(1);
  return legacy ? 'owner' : null;
}

const NOT_ACCOUNT_OWNER_MESSAGE =
  'Cette action est réservée au titulaire du compte (facturation, abonnement, membres, administration).';

/**
 * Garde UNIQUE des actions réservées au titulaire (matrice Q14 : facturation,
 * abonnement, changement d'offre, portail Stripe, rétractation, invitation et
 * retrait de membres, parrainage, suppression du compte, jeton de calendrier).
 * Renvoie une réponse 403 `NOT_ACCOUNT_OWNER` à retourner telle quelle, ou
 * null si l'appelant est titulaire du compte COURANT de sa session.
 */
export async function requireAccountOwner(
  session: { userId: number; currentAccountId?: number | null },
): Promise<NextResponse | null> {
  const r = await resolveOwnedSessionAccount(session);
  return r.ok ? null : r.response;
}

/** Variante de `requireAccountOwner` qui rend aussi le compte vérifié. */
export async function resolveOwnedSessionAccount(
  session: { userId: number; currentAccountId?: number | null },
): Promise<{ ok: true; accountId: number } | { ok: false; response: NextResponse }> {
  const accountId = await effectiveAccountId(session);
  if (!accountId) {
    return { ok: false, response: NextResponse.json({ error: 'NO_ACCOUNT', code: 'NO_ACCOUNT', message: 'Aucun espace sélectionné.' }, { status: 403 }) };
  }
  const role = await getSessionRole({ userId: session.userId, currentAccountId: accountId });
  if (role === 'owner') return { ok: true, accountId };
  return { ok: false, response: NextResponse.json({ error: 'NOT_ACCOUNT_OWNER', code: 'NOT_ACCOUNT_OWNER', message: NOT_ACCOUNT_OWNER_MESSAGE }, { status: 403 }) };
}

/** Compte partagé d'un Duo : `duo_accounts.account_id`, sinon l'UNIQUE compte qui porte ce Duo. */
export async function resolveDuoAccountId(duoId: number, runner: Runner = db): Promise<number | null> {
  const [duo] = await runner.select({ accountId: duoAccounts.accountId }).from(duoAccounts).where(eq(duoAccounts.id, duoId)).limit(1);
  if (!duo) return null;
  if (duo.accountId) return duo.accountId;
  const rows = await runner.select({ id: accounts.id }).from(accounts).where(eq(accounts.duoAccountId, duoId)).limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

/** Mémorise le dernier espace choisi (ouverture de session suivante). */
export async function markAccountSelected(userId: number, accountId: number, runner: Runner = db): Promise<void> {
  await runner.update(accountMemberships)
    .set({ lastSelectedAt: new Date() })
    .where(and(
      eq(accountMemberships.userId, userId),
      eq(accountMemberships.accountId, accountId),
      inArray(accountMemberships.status, [...ACTIVE_MEMBERSHIP_STATUSES]),
    ));
}

// ── Rattachement par invitation Duo ─────────────────────────────────────────

type DuoJoinError =
  | 'MISSING_TOKEN'
  | 'INVALID_TOKEN'
  | 'USED_TOKEN'
  | 'DECLINED_TOKEN'
  | 'EXPIRED_TOKEN'
  | 'SUBSCRIPTION_INACTIVE'
  | 'INVITE_EMAIL_MISMATCH'
  | 'CANNOT_JOIN_OWN_DUO'
  | 'SLOT_ALREADY_TAKEN'
  | 'ALREADY_IN_DUO'
  | 'DUO_ACCOUNT_UNRESOLVED';

export const DUO_JOIN_HTTP_STATUS: Record<DuoJoinError, number> = {
  MISSING_TOKEN: 400,
  INVALID_TOKEN: 404,
  USED_TOKEN: 410,
  DECLINED_TOKEN: 410,
  EXPIRED_TOKEN: 410,
  SUBSCRIPTION_INACTIVE: 403,
  INVITE_EMAIL_MISMATCH: 403,
  CANNOT_JOIN_OWN_DUO: 409,
  SLOT_ALREADY_TAKEN: 409,
  ALREADY_IN_DUO: 409,
  DUO_ACCOUNT_UNRESOLVED: 409,
};

export type DuoJoinResult =
  | { ok: true; accountId: number; duoId: number; alreadyMember: boolean }
  | { ok: false; error: DuoJoinError };

/**
 * L'utilisateur (identité VÉRIFIÉE : il a une session) accepte l'invitation
 * Duo `token`. En UNE transaction, compte du Duo verrouillé (`FOR UPDATE`) :
 * jeton, adresse, expiration, abonnement, place libre (`max_members`) ;
 * adhésion `member` créée ou réactivée sur le compte EXISTANT ; double
 * écriture `duo_memberships` (slot 1) ; jeton consommé ; espace mémorisé
 * comme dernier choix ; journal. Idempotent : rejoué après succès, renvoie le
 * même compte sans rien écrire.
 */
export async function joinDuoByInvitation(p: { userId: number; email: string; token: string }): Promise<DuoJoinResult> {
  const token = p.token.trim();
  if (!token) return { ok: false, error: 'MISSING_TOKEN' };
  const email = p.email.trim().toLowerCase();

  const result = await db.transaction(async (tx): Promise<DuoJoinResult> => {
    const [duo] = await tx.select().from(duoAccounts).where(eq(duoAccounts.pendingInviteToken, token)).limit(1).for('update');

    if (!duo) {
      // Rejeu après succès (double clic, deux onglets) : même résultat.
      const [used] = await tx
        .select({ id: duoAccounts.id })
        .from(duoAccounts)
        .where(eq(duoAccounts.lastUsedInviteTokenHash, inviteTokenHash(token)))
        .limit(1);
      if (!used) {
        // Lot 73B : invitation refusée par la personne invitée — refus définitif.
        const [declined] = await tx
          .select({ id: duoAccounts.id })
          .from(duoAccounts)
          .where(eq(duoAccounts.lastDeclinedInviteTokenHash, inviteTokenHash(token)))
          .limit(1);
        return { ok: false, error: declined ? 'DECLINED_TOKEN' : 'INVALID_TOKEN' };
      }
      const accountId = await resolveDuoAccountId(used.id, tx);
      if (accountId && (await getActiveMembership(p.userId, accountId, tx))) {
        return { ok: true, accountId, duoId: used.id, alreadyMember: true };
      }
      return { ok: false, error: 'USED_TOKEN' };
    }

    if (duo.pendingInviteTokenExpiresAt && new Date(duo.pendingInviteTokenExpiresAt) < new Date()) {
      return { ok: false, error: 'EXPIRED_TOKEN' };
    }
    if (!isDuoJoinable(duo.subscriptionStatus)) return { ok: false, error: 'SUBSCRIPTION_INACTIVE' };
    if (duo.pendingInviteEmail && duo.pendingInviteEmail.trim().toLowerCase() !== email) {
      return { ok: false, error: 'INVITE_EMAIL_MISMATCH' };
    }
    if (duo.billingOwnerUserId === p.userId) return { ok: false, error: 'CANNOT_JOIN_OWN_DUO' };

    const accountId = await resolveDuoAccountId(duo.id, tx);
    if (!accountId) return { ok: false, error: 'DUO_ACCOUNT_UNRESOLVED' };
    const [account] = await tx
      .select({ id: accounts.id, planType: accounts.planType, maxMembers: accounts.maxMembers })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
      .for('update');
    if (!account) return { ok: false, error: 'DUO_ACCOUNT_UNRESOLVED' };

    // Règle commerciale conservée (Q12) : membre d'un seul Duo à la fois.
    const [otherDuo] = await tx
      .select({ id: duoMemberships.id })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.userId, p.userId), eq(duoMemberships.status, 'ACTIVE'), ne(duoMemberships.duoId, duo.id)))
      .limit(1);
    if (otherDuo) return { ok: false, error: 'ALREADY_IN_DUO' };

    // Place libre : adhésions actives du compte (titulaire compris) et, pendant
    // la transition, un membre Duo historique encore sans adhésion.
    const [{ n: actives }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(accountMemberships)
      .where(and(
        eq(accountMemberships.accountId, accountId),
        inArray(accountMemberships.status, [...ACTIVE_MEMBERSHIP_STATUSES]),
        ne(accountMemberships.userId, p.userId),
      ));
    const [legacySlot] = await tx
      .select({ userId: duoMemberships.userId })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.slot, 1), eq(duoMemberships.status, 'ACTIVE'), ne(duoMemberships.userId, p.userId)))
      .limit(1);
    const legacyWithoutMembership = legacySlot && !(await getActiveMembership(legacySlot.userId, accountId, tx)) ? 1 : 0;
    if (actives + legacyWithoutMembership >= accountCapacity(account)) return { ok: false, error: 'SLOT_ALREADY_TAKEN' };

    const now = new Date();
    const [previous] = await tx
      .select({ id: accountMemberships.id, status: accountMemberships.status, role: accountMemberships.role })
      .from(accountMemberships)
      .where(and(eq(accountMemberships.accountId, accountId), eq(accountMemberships.userId, p.userId)))
      .limit(1);
    const alreadyMember = !!previous && (ACTIVE_MEMBERSHIP_STATUSES as readonly string[]).includes(previous.status);
    if (previous) {
      await tx.update(accountMemberships).set({
        status: 'active',
        // Un titulaire reste titulaire (cas impossible ici : CANNOT_JOIN_OWN_DUO).
        role: previous.role === 'owner' ? 'owner' : 'member',
        invitedEmail: email,
        invitedBy: duo.billingOwnerUserId,
        joinedAt: alreadyMember ? undefined : now,
        removedAt: null,
        removedBy: null,
        endedReason: null,
        inviteToken: null,
        inviteTokenExpiresAt: null,
        source: 'duo_invitation',
        lastSelectedAt: now,
        updatedAt: now,
      }).where(eq(accountMemberships.id, previous.id));
    } else {
      await tx.insert(accountMemberships).values({
        accountId,
        userId: p.userId,
        invitedEmail: email,
        role: 'member',
        status: 'active',
        invitedBy: duo.billingOwnerUserId,
        invitedAt: duo.pendingInviteSentAt ?? now,
        joinedAt: now,
        source: 'duo_invitation',
        lastSelectedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Double écriture historique (slot 1), réactivation d'une ancienne ligne.
    const [prevDuo] = await tx
      .select({ id: duoMemberships.id })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.userId, p.userId)))
      .limit(1);
    if (prevDuo) {
      await tx.update(duoMemberships)
        .set({ status: 'ACTIVE', slot: 1, invitedAt: now, joinedAt: now, leftAt: null, updatedAt: now })
        .where(eq(duoMemberships.id, prevDuo.id));
    } else {
      await tx.insert(duoMemberships).values({
        duoId: duo.id, userId: p.userId, status: 'ACTIVE', slot: 1, invitedAt: now, joinedAt: now, createdAt: now, updatedAt: now,
      });
    }

    await tx.update(duoAccounts).set({
      pendingInviteEmail: null,
      pendingInviteToken: null,
      pendingInviteTokenExpiresAt: null,
      pendingInviteSentAt: null,
      lastUsedInviteTokenHash: inviteTokenHash(token),
      // Lien compte ↔ Duo posé s'il manquait (comptes antérieurs à 0520).
      ...(duo.accountId ? {} : { accountId }),
      updatedAt: now,
    }).where(eq(duoAccounts.id, duo.id));

    // `users.plan_type` : copie d'AFFICHAGE historique seulement (aucun droit
    // n'en dépend depuis le lot 72D, voir `/api/users/me`). Conservée pour
    // l'ancien code pendant la transition.
    await tx.update(users).set({ planType: 'PREMIUM_DUO', updatedAt: now }).where(eq(users.id, p.userId));

    await tx.insert(accountAuditLog).values({
      accountId,
      userId: p.userId,
      userEmail: email,
      actionType: 'MEMBER_JOINED',
      targetUserId: p.userId,
      targetUserEmail: email,
      details: JSON.stringify({ role: 'member', source: 'duo_invitation', duoId: duo.id }),
      timestamp: now,
    });

    return { ok: true, accountId, duoId: duo.id, alreadyMember };
  });

  if (result.ok) {
    invalidateAccountReadCache(result.accountId);
    invalidateUserReadCache(p.userId);
    signalPermissionsChanged(result.accountId);
  }
  return result;
}

// ── Fin d'adhésion ──────────────────────────────────────────────────────────

type MembershipEndKind = 'left' | 'removed';

/**
 * Fin d'adhésion d'un membre (non titulaire) dans une transaction existante :
 * statut `left` / `removed`, motif, auteur. N'écrit rien si l'adhésion n'est
 * plus active (idempotent). Les caches sont invalidés par l'appelant, APRÈS
 * la transaction (`afterMembershipEnded`).
 */
export async function endAccountMembershipInTx(tx: Runner, p: {
  accountId: number;
  userId: number;
  kind: MembershipEndKind;
  byUserId?: number | null;
  reason: string;
  now?: Date;
}): Promise<boolean> {
  const now = p.now ?? new Date();
  const rows = await tx.update(accountMemberships)
    .set({
      status: p.kind,
      removedAt: now,
      removedBy: p.kind === 'removed' ? (p.byUserId ?? null) : null,
      endedReason: p.reason,
      updatedAt: now,
    })
    .where(and(
      eq(accountMemberships.accountId, p.accountId),
      eq(accountMemberships.userId, p.userId),
      ne(accountMemberships.role, 'owner'),
      inArray(accountMemberships.status, [...ACTIVE_MEMBERSHIP_STATUSES]),
    ))
    .returning({ id: accountMemberships.id });
  return rows.length > 0;
}

/** Révocation effective tout de suite : caches de lecture et assistant. */
export function afterMembershipEnded(accountId: number | null, userId: number): void {
  if (accountId) invalidateAccountReadCache(accountId);
  invalidateUserReadCache(userId);
  signalPermissionsChanged(accountId);
}

/**
 * CDC Assistant §25.7 : droits modifiés (entrée ou sortie d'un membre).
 * Non bloquant.
 */
function signalPermissionsChanged(accountId: number | null): void {
  void import('@/services/verebona-assistant/events/business-events')
    .then(({ emitBusinessEvent }) => emitBusinessEvent({ type: 'ACCOUNT_PERMISSION_CHANGED', accountId }))
    .catch(() => { /* non bloquant */ });
}

/**
 * Duo porté par un compte (lien 0520, sinon `accounts.duo_account_id`).
 */
export async function duoOfAccount(accountId: number, runner: Runner = db): Promise<number | null> {
  const [byLink] = await runner.select({ id: duoAccounts.id }).from(duoAccounts).where(eq(duoAccounts.accountId, accountId)).limit(1);
  if (byLink) return byLink.id;
  const [acc] = await runner.select({ duoId: accounts.duoAccountId }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return acc?.duoId ?? null;
}

/** Utilisateurs à adhésion active d'un compte (titulaire compris). */
export async function activeMemberUserIds(accountId: number, roles?: MembershipRole[]): Promise<number[]> {
  const rows = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(and(
      eq(accountMemberships.accountId, accountId),
      inArray(accountMemberships.status, [...ACTIVE_MEMBERSHIP_STATUSES]),
      ...(roles ? [inArray(accountMemberships.role, roles)] : []),
    ));
  return rows.map((r) => r.userId).filter((u): u is number => typeof u === 'number');
}


// ── Espaces de l'utilisateur ────────────────────────────────────────────────

export interface UserSpace {
  id: number;
  name: string;
  role: MembershipRole;
  plan: string;
  current: boolean;
}

/** Libellé court de l'offre d'un espace (sélecteur). */
export function spacePlanLabel(planType: string | null | undefined, role: MembershipRole): string {
  const plan = String(planType ?? 'STANDARD').toUpperCase();
  const base = plan === 'PREMIUM_DUO' || plan === 'DUO' ? 'Premium Duo' : plan === 'PREMIUM' ? 'Premium' : plan === 'PREMIUM_PRO' || plan === 'PRO' ? 'Premium Pro' : 'Standard';
  if (base === 'Standard' || base === 'Premium') return base;
  return `${base} — ${role === 'owner' ? 'Titulaire' : 'Membre'}`;
}

/** Espaces accessibles (adhésions actives), archivés exclus sauf l'espace ouvert. */
export async function listUserSpaces(userId: number, currentAccountId: number | null): Promise<UserSpace[]> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      planType: accounts.planType,
      archivedAt: accounts.archivedAt,
      role: accountMemberships.role,
      lastSelectedAt: accountMemberships.lastSelectedAt,
    })
    .from(accountMemberships)
    .innerJoin(accounts, eq(accounts.id, accountMemberships.accountId))
    .where(and(eq(accountMemberships.userId, userId), inArray(accountMemberships.status, [...ACTIVE_MEMBERSHIP_STATUSES])));
  const rank: Record<string, number> = { owner: 0, admin: 1, member: 2 };
  return rows
    .filter((r) => !r.archivedAt || r.id === currentAccountId)
    .sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9) || a.id - b.id)
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role as MembershipRole,
      plan: spacePlanLabel(r.planType, r.role as MembershipRole),
      current: r.id === currentAccountId,
    }));
}

type PersonalSpaceResult =
  | { ok: true; accountId: number; trialGranted: boolean }
  | { ok: false; error: 'ALREADY_HAS_OWN_SPACE' };

/**
 * « Créer mon espace » (Q8) : compte Standard + adhésion titulaire, essai
 * seulement si l'adresse n'en a jamais consommé. Refusé si l'utilisateur est
 * déjà titulaire d'un espace actif non archivé.
 */
export async function createPersonalSpace(user: { id: number; email: string; firstName: string | null; lastName: string | null }): Promise<PersonalSpaceResult> {
  const now = new Date();
  const created = await db.transaction(async (tx) => {
    // Sérialise deux demandes simultanées du même utilisateur.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72004, ${user.id})`);
    const [owned] = await tx
      .select({ id: accounts.id })
      .from(accountMemberships)
      .innerJoin(accounts, eq(accounts.id, accountMemberships.accountId))
      .where(and(
        eq(accountMemberships.userId, user.id),
        eq(accountMemberships.role, 'owner'),
        inArray(accountMemberships.status, [...ACTIVE_MEMBERSHIP_STATUSES]),
        sql`${accounts.archivedAt} IS NULL`,
      ))
      .limit(1);
    if (owned) return null;
    const [account] = await tx.insert(accounts).values({
      name: `Compte de ${(user.firstName ?? '').trim()} ${(user.lastName ?? '').trim()}`.replace(/\s+/g, ' ').trim(),
      ownerUserId: user.id,
      planType: 'STANDARD',
      subscriptionTier: 'free',
      subscriptionStatus: 'NONE',
      createdAt: now,
      updatedAt: now,
    }).returning({ id: accounts.id });
    await tx.insert(accountMemberships).values({
      accountId: account.id, userId: user.id, role: 'owner', status: 'active', source: 'signup',
      invitedAt: now, joinedAt: now, lastSelectedAt: now, createdAt: now, updatedAt: now,
    });
    return account.id;
  });
  if (!created) return { ok: false, error: 'ALREADY_HAS_OWN_SPACE' };
  let trialGranted = false;
  try {
    const { grantTrial } = await import('@/services/trial.service');
    trialGranted = (await grantTrial({ accountId: created, email: user.email, now })).granted;
  } catch (e) {
    console.error('[personal-space] attribution d\'essai impossible:', (e as Error).message);
  }
  invalidateUserReadCache(user.id);
  return { ok: true, accountId: created, trialGranted };
}

/**
 * Écran « sans espace » (Q8) : invitation Premium Duo en attente pour cette
 * adresse (vérifiée : la personne a une session), et essai encore disponible
 * (jamais consommé par cette adresse) pour « Créer mon espace ».
 */
export async function noSpaceOptions(email: string): Promise<{ pendingDuoInvitation: boolean; trialAvailable: boolean }> {
  const normalized = email.trim().toLowerCase();
  const [duo] = await db
    .select({ id: duoAccounts.id })
    .from(duoAccounts)
    .where(and(
      sql`${duoAccounts.pendingInviteToken} IS NOT NULL`,
      sql`lower(${duoAccounts.pendingInviteEmail}) = ${normalized}`,
      sql`(${duoAccounts.pendingInviteTokenExpiresAt} IS NULL OR ${duoAccounts.pendingInviteTokenExpiresAt} > now())`,
      eq(duoAccounts.subscriptionStatus, 'ACTIVE'),
    ))
    .limit(1);
  const { hasUsedTrial } = await import('@/services/trial.service');
  return { pendingDuoInvitation: !!duo, trialAvailable: !(await hasUsedTrial(normalized)) };
}
