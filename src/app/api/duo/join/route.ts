import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, duoAccounts, duoMemberships, accountMemberships, accounts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

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
    return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 404 });
  }

  if (duo.pendingInviteTokenExpiresAt && new Date(duo.pendingInviteTokenExpiresAt) < new Date()) {
    return NextResponse.json({ error: 'EXPIRED_TOKEN' }, { status: 410 });
  }

  if (duo.subscriptionStatus !== 'ACTIVE' && duo.subscriptionStatus !== 'PAST_DUE_GRACE') {
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
    const { token } = body;

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

    if (duo.subscriptionStatus !== 'ACTIVE' && duo.subscriptionStatus !== 'PAST_DUE_GRACE') {
      return NextResponse.json({ error: 'SUBSCRIPTION_INACTIVE' }, { status: 403 });
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

    // Insert slot 1 membership
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

    // Clear the pending invitation
    await db
      .update(duoAccounts)
      .set({
        pendingInviteEmail: null,
        pendingInviteToken: null,
        pendingInviteTokenExpiresAt: null,
        pendingInviteSentAt: null,
        updatedAt: now,
      })
      .where(eq(duoAccounts.id, duo.id));

    // Set member's planType = 'PREMIUM_DUO'
    await db
      .update(users)
      .set({ planType: 'PREMIUM_DUO', updatedAt: now })
      .where(eq(users.id, session.userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
