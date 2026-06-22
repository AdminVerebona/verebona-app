import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, duoAccounts, duoMemberships } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';
import crypto from 'crypto';

const TOKEN_TTL_DAYS = 7;

/**
 * GET /api/duo/invitation
 * Returns current invitation status for the billing owner's duo account
 */
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    const [duo] = await db
      .select()
      .from(duoAccounts)
      .where(eq(duoAccounts.billingOwnerUserId, session.userId))
      .limit(1);

    if (!duo) {
      return NextResponse.json({ error: 'DUO_NOT_FOUND' }, { status: 404 });
    }

    // Check if slot 1 is already taken (active member)
    const [activeMember] = await db
      .select({ id: duoMemberships.id, userId: duoMemberships.userId, status: duoMemberships.status })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.slot, 1)))
      .limit(1);

    if (activeMember && activeMember.status === 'ACTIVE') {
      const [memberUser] = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, activeMember.userId))
        .limit(1);

      return NextResponse.json({
        status: 'ACTIVE_MEMBER',
        memberEmail: memberUser?.email || null,
        memberName: memberUser ? `${memberUser.firstName} ${memberUser.lastName}` : null,
      });
    }

    if (!duo.pendingInviteEmail) {
      return NextResponse.json({ status: 'NONE' });
    }

    const isExpired = duo.pendingInviteTokenExpiresAt && new Date(duo.pendingInviteTokenExpiresAt) < new Date();

    return NextResponse.json({
      status: isExpired ? 'EXPIRED' : 'PENDING',
      inviteEmail: duo.pendingInviteEmail,
      sentAt: duo.pendingInviteSentAt,
      inviteLink: duo.pendingInviteToken
        ? (() => {
            const origin = request.headers.get('origin') || request.headers.get('referer')?.split('/').slice(0,3).join('/') || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
            return `${origin.replace(/\/$/, '')}/duo/join/${duo.pendingInviteToken}`;
          })()
        : null,
    });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

/**
 * POST /api/duo/invitation
 * Create or resend a Duo invitation
 * Body: { email: string, resend?: boolean }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const body = await request.json();
    const { email, resend = false } = body;

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'INVALID_EMAIL' }, { status: 400 });
    }

    const [duo] = await db
      .select()
      .from(duoAccounts)
      .where(eq(duoAccounts.billingOwnerUserId, session.userId))
      .limit(1);

    if (!duo) {
      return NextResponse.json({ error: 'DUO_NOT_FOUND' }, { status: 404 });
    }

    // Check if slot 1 already has an active member
    const [activeMember] = await db
      .select({ id: duoMemberships.id })
      .from(duoMemberships)
      .where(and(eq(duoMemberships.duoId, duo.id), eq(duoMemberships.slot, 1), eq(duoMemberships.status, 'ACTIVE')))
      .limit(1);

    if (activeMember) {
      return NextResponse.json({ error: 'SLOT_ALREADY_TAKEN' }, { status: 409 });
    }

    // Generate new token or reuse existing if resend
    let token: string;
    if (resend && duo.pendingInviteToken && duo.pendingInviteEmail === email) {
      token = duo.pendingInviteToken;
    } else {
      token = crypto.randomBytes(32).toString('hex');
    }

    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    await db
      .update(duoAccounts)
      .set({
        pendingInviteEmail: email,
        pendingInviteToken: token,
        pendingInviteTokenExpiresAt: expiresAt,
        pendingInviteSentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(duoAccounts.id, duo.id));

    // Fetch owner name
    const [owner] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    // Derive base URL from the incoming request so it works in all environments (dev, staging, prod)
    const requestOrigin = request.headers.get('origin') || request.headers.get('referer')?.replace(/\/$/, '').split('/').slice(0, 3).join('/') || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const baseUrl = requestOrigin.replace(/\/$/, '');
    const inviteUrl = `${baseUrl}/duo/join/${token}`;

    // Send invitation email (fire-and-forget)
    emailService.send({
      templateCode: 'DUO_INVITATION',
      to: email,
      variables: {
        ownerFirstName: owner?.firstName || '',
        ownerLastName: owner?.lastName || '',
        ownerFullName: owner ? `${owner.firstName} ${owner.lastName}` : '',
        inviteUrl,
        expiresIn: `${TOKEN_TTL_DAYS} jours`,
      },
      userId: session.userId,
    }).catch((err) => console.error('[DuoInvitation] Email send failed:', err));

    return NextResponse.json({
      success: true,
      inviteLink: inviteUrl,
    });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

/**
 * DELETE /api/duo/invitation
 * Cancel the pending invitation
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    const [duo] = await db
      .select({ id: duoAccounts.id })
      .from(duoAccounts)
      .where(eq(duoAccounts.billingOwnerUserId, session.userId))
      .limit(1);

    if (!duo) {
      return NextResponse.json({ error: 'DUO_NOT_FOUND' }, { status: 404 });
    }

    await db
      .update(duoAccounts)
      .set({
        pendingInviteEmail: null,
        pendingInviteToken: null,
        pendingInviteTokenExpiresAt: null,
        pendingInviteSentAt: null,
        updatedAt: new Date(),
      })
      .where(eq(duoAccounts.id, duo.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
