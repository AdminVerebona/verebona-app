import { NextRequest, NextResponse } from 'next/server';
import { isDuoJoinable } from '@/lib/billing/subscription-status';
import { signalerDroitsModifies } from '@/services/duo/duo-exit.service';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, duoAccounts, duoMemberships } from '@/db/schema';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { inviteTokenHash } from '@/lib/duo/invite-token-hash';

/**
 * GET /api/duo/join?token=xxx
 * Validate a duo invitation token (public endpoint, no auth required)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

  if (!token) {
    return NextResponse.json({ error: 'MISSING_TOKEN' }, { status: 400 });
  }

  const [duo] = await db
    .select({
      id: duoAccounts.id,
      billingOwnerUserId: duoAccounts.billingOwnerUserId,
      pendingInviteEmail: duoAccounts.pendingInviteEmail,
      pendingInviteTokenExpiresAt: duoAccounts.pendingInviteTokenExpiresAt,
      subscriptionStatus: duoAccounts.subscriptionStatus,
    })
    .from(duoAccounts)
    .where(eq(duoAccounts.pendingInviteToken, token))
    .limit(1);

  if (!duo) {
    // Lot 57A (P2 inscription des invités) : invitation DÉJÀ UTILISÉE
    // distinguée d'un lien inconnu, par l'empreinte du dernier jeton consommé.
    const [used] = await db
      .select({ id: duoAccounts.id })
      .from(duoAccounts)
      .where(eq(duoAccounts.lastUsedInviteTokenHash, inviteTokenHash(token)))
      .limit(1);
    if (used) return NextResponse.json({ error: 'USED_TOKEN' }, { status: 410 });
    return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 404 });
  }

  if (duo.pendingInviteTokenExpiresAt && new Date(duo.pendingInviteTokenExpiresAt) < new Date()) {
    return NextResponse.json({ error: 'EXPIRED_TOKEN' }, { status: 410 });
  }

  // Rejoindre un Duo est une écriture : refusée pendant un impayé
  // (UNPAID_RECOVERY), comme toute écriture — aucune grâce (APP-FUNC-31).
  if (!isDuoJoinable(duo.subscriptionStatus)) {
    return NextResponse.json({ error: 'SUBSCRIPTION_INACTIVE' }, { status: 403 });
  }

  const [owner] = await db
    .select({ firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, duo.billingOwnerUserId))
    .limit(1);

  return NextResponse.json({
    valid: true,
    ownerName: owner ? `${owner.firstName} ${owner.lastName}` : '',
    inviteEmail: duo.pendingInviteEmail,
  });
}

/**
 * POST /api/duo/join
 * Authenticated: join a duo account via invitation token
 * Body: { token: string }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const body = await request.json();
    let token: string | undefined = typeof body?.token === 'string' ? body.token : undefined;

    // ════════════════════════════════════════════════════════════════════
    // LOT 57A — REPRISE SANS JETON LOCAL (deux navigateurs)
    //
    // L'invité a créé son compte dans un navigateur et ouvert l'e-mail de
    // vérification dans un autre (téléphone…) : le jeton mémorisé n'y est
    // pas. `{ invitedEmail: true }` retrouve l'invitation EN ATTENTE adressée
    // à l'adresse de la SESSION — adresse vérifiée (aucune session sans
    // vérification). Jamais un identifiant fourni par le client : aucun
    // rattachement à un autre Duo par manipulation. Toutes les règles
    // ci-dessous (expiration, abonnement, place libre…) s'appliquent.
    // ════════════════════════════════════════════════════════════════════
    if (!token && body?.invitedEmail === true) {
      const email = String(session.email ?? '').trim().toLowerCase();
      const candidates = email
        ? await db
            .select({ token: duoAccounts.pendingInviteToken })
            .from(duoAccounts)
            .where(and(isNotNull(duoAccounts.pendingInviteToken), sql`lower(${duoAccounts.pendingInviteEmail}) = ${email}`))
            .limit(2)
        : [];
      if (candidates.length === 0) return NextResponse.json({ error: 'NO_PENDING_INVITATION' }, { status: 404 });
      if (candidates.length > 1) return NextResponse.json({ error: 'MULTIPLE_INVITATIONS' }, { status: 409 });
      token = candidates[0].token ?? undefined;
    }

    if (!token) {
      return NextResponse.json({ error: 'MISSING_TOKEN' }, { status: 400 });
    }

    const [duo] = await db
      .select()
      .from(duoAccounts)
      .where(eq(duoAccounts.pendingInviteToken, token))
      .limit(1);

    if (!duo) {
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 404 });
    }

    if (duo.pendingInviteTokenExpiresAt && new Date(duo.pendingInviteTokenExpiresAt) < new Date()) {
      return NextResponse.json({ error: 'EXPIRED_TOKEN' }, { status: 410 });
    }

    if (!isDuoJoinable(duo.subscriptionStatus)) {
      return NextResponse.json({ error: 'SUBSCRIPTION_INACTIVE' }, { status: 403 });
    }

    // Invitation nominative : si elle désigne une adresse, seul le compte de
    // cette adresse peut l'utiliser (même règle que l'inscription sur
    // invitation, `lib/prelaunch-invitations.ts`). Sans ce contrôle, toute
    // personne à qui le lien est transféré rejoignait le Duo — et accédait à
    // l'espace partagé du titulaire.
    if (
      duo.pendingInviteEmail
      && duo.pendingInviteEmail.trim().toLowerCase() !== String(session.email ?? '').trim().toLowerCase()
    ) {
      return NextResponse.json(
        {
          error: 'INVITE_EMAIL_MISMATCH',
          message: 'Cette invitation a été envoyée à une autre adresse e-mail. Connectez-vous avec l’adresse invitée.',
        },
        { status: 403 },
      );
    }

    // Cannot join your own duo
    if (duo.billingOwnerUserId === session.userId) {
      return NextResponse.json({ error: 'CANNOT_JOIN_OWN_DUO' }, { status: 409 });
    }

    // Check if slot 1 is already taken
    const [existingSlot1] = await db
      .select({ id: duoMemberships.id })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.slot, 1), eq(duoMemberships.status, 'ACTIVE')))
      .limit(1);

    if (existingSlot1) {
      return NextResponse.json({ error: 'SLOT_ALREADY_TAKEN' }, { status: 409 });
    }

    // Check if this user is already in another duo
    const [existingMembership] = await db
      .select({ id: duoMemberships.id })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.userId, session.userId), eq(duoMemberships.status, 'ACTIVE')))
      .limit(1);

    if (existingMembership) {
      return NextResponse.json({ error: 'ALREADY_IN_DUO' }, { status: 409 });
    }

    const now = new Date();

    // Slot 1. Un ancien membre retiré ou parti (REMOVED / LEFT, GAP-13) a
    // déjà une ligne pour ce Duo — (duo_id, user_id) est unique : on la
    // réactive au lieu d'en insérer une seconde.
    const [previous] = await db
      .select({ id: duoMemberships.id })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.userId, session.userId)))
      .limit(1);

    if (previous) {
      await db
        .update(duoMemberships)
        .set({ status: 'ACTIVE', slot: 1, invitedAt: now, joinedAt: now, leftAt: null, updatedAt: now })
        .where(eq(duoMemberships.id, previous.id));
    } else {
      await db.insert(duoMemberships).values({
        duoId: duo.id,
        userId: session.userId,
        status: 'ACTIVE',
        slot: 1,
        invitedAt: now,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Clear the pending invitation
    await db
      .update(duoAccounts)
      .set({
        pendingInviteEmail: null,
        pendingInviteToken: null,
        pendingInviteTokenExpiresAt: null,
        pendingInviteSentAt: null,
        lastUsedInviteTokenHash: inviteTokenHash(token),
        updatedAt: now,
      })
      .where(eq(duoAccounts.id, duo.id));

    // Set member's planType = 'PREMIUM_DUO'
    await db
      .update(users)
      .set({ planType: 'PREMIUM_DUO', updatedAt: now })
      .where(eq(users.id, session.userId));

    // CDC Assistant §25.7 : droits du nouveau membre modifiés.
    signalerDroitsModifies();
    return NextResponse.json({ success: true });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
