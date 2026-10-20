import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, duoAccounts, duoMemberships, accounts } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { accountCapacity, activeMemberUserIds, resolveDuoAccountId } from '@/services/account/membership.service';
import crypto from 'crypto';
import { getAppBaseUrl } from '@/lib/app-url';
import {
  enqueueDuoInvitationEmail,
  getDuoInvitationEmailState,
  processEmailJob,
  type EmailJobOutcome,
} from '@/services/email/transactional-email-jobs.service';

const TOKEN_TTL_DAYS = 7;
/** Attente maximale de la réponse de Resend avant de répondre au titulaire. */
const SEND_WAIT_MS = 15_000;

/** Statut d'expédition rendu au titulaire (lot 57A, P0-C). */
function emailStatusOf(outcome: EmailJobOutcome | { status: 'timeout' }) {
  if (outcome.status === 'accepted') return { emailStatus: 'accepted' as const, emailAccepted: true };
  if (outcome.status === 'failed') return { emailStatus: 'failed' as const, emailAccepted: false };
  // pending (nouvelle tentative programmée), busy (tentative en cours), timeout.
  return { emailStatus: 'queued' as const, emailAccepted: false };
}

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
    // Lot 57A (E) : invitation créée ≠ expédition acceptée ≠ livraison connue.
    const email = await getDuoInvitationEmailState(duo.id);

    return NextResponse.json({
      status: isExpired ? 'EXPIRED' : 'PENDING',
      inviteEmail: duo.pendingInviteEmail,
      // Date d'expédition CONFIRMÉE (acceptation par Resend) uniquement.
      sentAt: duo.pendingInviteSentAt,
      email,
      inviteLink: duo.pendingInviteToken
        ? (() => {
            return `${getAppBaseUrl(request).replace(/\/$/, '')}/duo/join/${duo.pendingInviteToken}`;
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

    // Lot 72D : limite GÉNÉRIQUE (adhésions actives du compte partagé contre
    // `max_members`) et adresse déjà membre active du compte → refus explicite.
    const sharedAccountId = await resolveDuoAccountId(duo.id);
    if (sharedAccountId) {
      const [acc] = await db
        .select({ planType: accounts.planType, maxMembers: accounts.maxMembers })
        .from(accounts)
        .where(eq(accounts.id, sharedAccountId))
        .limit(1);
      const membres = await activeMemberUserIds(sharedAccountId);
      const [deja] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
        .limit(1);
      if (deja && membres.includes(deja.id)) {
        return NextResponse.json({ error: 'ALREADY_MEMBER', message: 'Cette personne a déjà accès à votre espace.' }, { status: 409 });
      }
      if (acc && membres.length >= accountCapacity(acc)) {
        return NextResponse.json({ error: 'SLOT_ALREADY_TAKEN' }, { status: 409 });
      }
    }

    // Generate new token or reuse existing if resend
    let token: string;
    const reuse = !!(resend && duo.pendingInviteToken && duo.pendingInviteEmail === email);
    if (reuse) {
      token = duo.pendingInviteToken!;
    } else {
      token = crypto.randomBytes(32).toString('hex');
    }

    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    // ════════════════════════════════════════════════════════════════════
    // LOT 57A (P0-C) — PLUS D'EXPÉDITION ANNONCÉE À TORT
    //
    // Avant : date d'envoi posée ici, e-mail « fire and forget », réponse
    // `success: true` sans rien savoir du transport. Désormais :
    //   · l'INVITATION est enregistrée (lien exploitable, copiable) ;
    //   · la date d'envoi n'est posée qu'à l'ACCEPTATION par Resend — par la
    //     demande durable (`transactional_email_jobs`), qui pose aussi la
    //     trace du premier envoi (lot 54F, mascotte) ; une nouvelle
    //     invitation remet la date à vide jusqu'à cette acceptation ;
    //   · la réponse attend Resend (au plus 15 s) et dit ce qu'il en est :
    //     `emailStatus` accepted | queued (nouvelle tentative programmée) |
    //     failed. `success` signifie « invitation enregistrée ».
    // Destinataire de l'e-mail = l'invité ; émetteur = le titulaire (P1-E).
    // ════════════════════════════════════════════════════════════════════
    await db
      .update(duoAccounts)
      .set({
        pendingInviteEmail: email,
        pendingInviteToken: token,
        pendingInviteTokenExpiresAt: expiresAt,
        pendingInviteSentAt: reuse ? duo.pendingInviteSentAt : null,
        updatedAt: new Date(),
      })
      .where(eq(duoAccounts.id, duo.id));

    // Adresse publique de l'application (APP_URL / NEXT_PUBLIC_APP_URL, sinon
    // l'hôte de la requête) : jamais l'en-tête Origin, qui vaut
    // « capacitor://localhost » depuis l'app mobile et rendait le lien
    // d'invitation inutilisable hors de l'app.
    const baseUrl = getAppBaseUrl(request).replace(/\/$/, '');
    const inviteUrl = `${baseUrl}/duo/join/${token}`;

    const job = await enqueueDuoInvitationEmail({
      duoId: duo.id, recipientEmail: email, triggeredByUserId: session.userId, baseUrl,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      processEmailJob(job.jobId),
      new Promise<{ status: 'timeout' }>((r) => { timer = setTimeout(() => r({ status: 'timeout' }), SEND_WAIT_MS); }),
    ]).finally(() => clearTimeout(timer));

    return NextResponse.json({
      success: true,
      inviteLink: inviteUrl,
      ...emailStatusOf(outcome),
    });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

/**
 * DELETE /api/duo/invitation
 * Cancel the pending invitation
 * (lot 54F : `duo_first_invite_sent_at` n'est PAS effacé — la mascotte ne
 * repropose pas l'invitation ; l'invitation manuelle reste possible ici.)
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
