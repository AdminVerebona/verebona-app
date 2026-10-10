import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import {
  accountMemberships,
  referralLinks,
  referralEmailSends,
  users,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import { emailService } from '@/lib/email/email-service';
import {
  buildReferralUrl,
  invitationFailureMessage,
  maskEmail,
  normalizeRecipients,
  referralSenderName,
  sendReferralInvitations,
} from '@/services/referral/referral-invitation.service';

function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

/**
 * POST /api/referral/send-email
 * Envoie des invitations de parrainage par email.
 *
 * Body: { emails: string[] }  — max 10 destinataires
 *
 * Réponse 200 `{ sent, total, failed }` si AU MOINS une invitation a été
 * acceptée par le fournisseur ; 502 `EMAIL_NOT_SENT` (message lisible) si
 * aucune. Lot 34I : l'envoi passe par le service e-mail commun, voir
 * `services/referral/referral-invitation.service.ts`.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    const [membership] = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) {
      return NextResponse.json({ code: 'NO_ACCOUNT', message: 'Aucun compte associé.' }, { status: 404 });
    }

    // Récupérer le lien de parrainage
    const [link] = await db
      .select()
      .from(referralLinks)
      .where(eq(referralLinks.accountId, membership.accountId))
      .limit(1);

    if (!link || !link.isActive) {
      return NextResponse.json({ code: 'NO_REFERRAL_LINK', message: 'Veuillez d\'abord créer votre lien de parrainage.' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const rawEmails: unknown = body?.emails;

    if (!Array.isArray(rawEmails) || rawEmails.length === 0) {
      return NextResponse.json({ code: 'NO_EMAILS', message: 'Aucun email fourni.' }, { status: 400 });
    }

    const validEmails = normalizeRecipients(rawEmails);

    if (validEmails.length === 0) {
      return NextResponse.json({ code: 'INVALID_EMAILS', message: 'Aucun email valide fourni.' }, { status: 400 });
    }

    // Récupérer les infos du parrain pour l'email
    const [sender] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    const result = await sendReferralInvitations({
      recipients: validEmails,
      senderName: referralSenderName(sender?.firstName, sender?.lastName),
      referralUrl: buildReferralUrl(link.code),
      send: (o) => emailService.send(o),
    });

    // Trace serveur : le détail par destinataire est dans `email_logs`.
    for (const f of result.failed) {
      console.error(
        `[Referral send-email] échec lien ${link.id} compte ${membership.accountId} → ${maskEmail(f.email)} : ${f.reason}`,
      );
    }
    console.info(
      `[Referral send-email] lien ${link.id} compte ${membership.accountId} : ${result.sent.length}/${validEmails.length} invitation(s) acceptée(s)`,
    );

    // Seuls les envois acceptés sont comptés (emails hashés RGPD)
    if (result.sent.length > 0) {
      const now = new Date();
      await db.insert(referralEmailSends).values(
        result.sent.map((email) => ({
          referralLinkId: link.id,
          senderAccountId: membership.accountId,
          recipientEmailHash: hashEmail(email),
          sentAt: now,
          createdAt: now,
        })),
      );
    }

    if (result.sent.length === 0) {
      return NextResponse.json(
        {
          code: 'EMAIL_NOT_SENT',
          message: invitationFailureMessage(result.failed.map((f) => f.reason)),
          sent: 0,
          total: validEmails.length,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      sent: result.sent.length,
      total: validEmails.length,
      failed: result.failed.length,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) {
      return SessionService.handleSessionError(error);
    }
    console.error('[Referral send-email POST]', error);
    return NextResponse.json(
      { code: 'INTERNAL_ERROR', message: 'L’invitation n’a pas pu être envoyée. Réessayez plus tard.' },
      { status: 500 },
    );
  }
}
