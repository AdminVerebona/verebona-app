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

const MAX_RECIPIENTS_PER_SEND = 10;

function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

/**
 * POST /api/referral/send-email
 * Envoie des invitations de parrainage par email.
 *
 * Body: { emails: string[] }  — max 10 destinataires
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
      return NextResponse.json({ code: 'NO_ACCOUNT' }, { status: 404 });
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
    const rawEmails: unknown = body.emails;

    if (!Array.isArray(rawEmails) || rawEmails.length === 0) {
      return NextResponse.json({ code: 'NO_EMAILS', message: 'Aucun email fourni.' }, { status: 400 });
    }

    // Filtrer et valider les emails
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = rawEmails
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => emailRegex.test(e))
      .slice(0, MAX_RECIPIENTS_PER_SEND);

    if (validEmails.length === 0) {
      return NextResponse.json({ code: 'INVALID_EMAILS', message: 'Aucun email valide fourni.' }, { status: 400 });
    }

    // Récupérer les infos du parrain pour l'email
    const [sender] = await db
      .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    const senderName = sender ? `${sender.firstName} ${sender.lastName}`.trim() : 'Un ami';
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const referralUrl = `${appUrl}/r/${link.code}`;

    // Envoyer les emails via Resend
    const resendApiKey = process.env.RESEND_API_KEY;
    let sentCount = 0;

    if (resendApiKey) {
      const { Resend } = await import('resend');
      const resend = new Resend(resendApiKey);

      for (const email of validEmails) {
        try {
          await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'no-reply@verebona.fr',
            to: email,
            // ⚠️ L'objet promettait « 3 mois offerts » AU DESTINATAIRE.
            // L'avantage revient au parrain : cette promesse serait non tenue,
            // et elle est faite par écrit, nominativement, à un tiers.
            subject: `${senderName} vous invite à découvrir Verebona`,
            html: buildReferralEmailHtml(senderName, referralUrl),
          });
          sentCount++;
        } catch (err) {
          console.error(`[Referral send-email] Failed to send to ${email}:`, err);
        }
      }
    } else {
      // Mode dev : on simule l'envoi
      sentCount = validEmails.length;
      console.log(`[Referral send-email] DEV MODE — would send to: ${validEmails.join(', ')}`);
    }

    // Logger les envois (emails hashés RGPD)
    const now = new Date();
    await db.insert(referralEmailSends).values(
      validEmails.map((email) => ({
        referralLinkId: link.id,
        senderAccountId: membership.accountId,
        recipientEmailHash: hashEmail(email),
        sentAt: now,
        createdAt: now,
      })),
    );

    return NextResponse.json({ sent: sentCount, total: validEmails.length });
  } catch (error) {
    if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) {
      return SessionService.handleSessionError(error);
    }
    console.error('[Referral send-email POST]', error);
    return NextResponse.json({ code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

function buildReferralEmailHtml(senderName: string, referralUrl: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invitation Verebona</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
        <tr>
          <td style="background:#1e40af;padding:28px 32px;text-align:center;">
            <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;letter-spacing:-0.5px;">Verebona</h1>
            <p style="color:#93c5fd;margin:4px 0 0;font-size:13px;">Gérez votre patrimoine en toute sérénité</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px;">
            <p style="font-size:16px;color:#374151;margin:0 0 16px;font-weight:600;">Bonjour,</p>
            <p style="font-size:15px;color:#4b5563;margin:0 0 20px;line-height:1.6;">
              <strong>${senderName}</strong> vous invite à rejoindre <strong>Verebona</strong>, la plateforme de gestion patrimoniale qui simplifie le suivi de vos biens immobiliers et mobiliers.
            </p>
            <div style="background:#eff6ff;border-radius:10px;padding:20px 24px;margin:0 0 28px;">
              <p style="font-size:15px;color:#1e40af;font-weight:700;margin:0 0 8px;">Votre essai gratuit</p>
              <p style="font-size:14px;color:#3b82f6;margin:0;line-height:1.5;">
                Créez votre compte pour découvrir Verebona. En vous inscrivant via ce lien,
                <strong>${senderName}</strong> bénéficiera d'un mois offert si vous souscrivez
                un abonnement annuel.
              </p>
            </div>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:4px 0 28px;">
                  <a href="${referralUrl}" style="display:inline-block;background:#1e40af;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.2px;">
                    Commencer mon essai gratuit →
                  </a>
                </td>
              </tr>
            </table>
            <p style="font-size:13px;color:#9ca3af;margin:0;line-height:1.6;">
              Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
              <a href="${referralUrl}" style="color:#3b82f6;word-break:break-all;">${referralUrl}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb;">
            <p style="font-size:12px;color:#9ca3af;margin:0;line-height:1.6;text-align:center;">
              Vous recevez cet email car ${senderName} souhaitait vous faire découvrir Verebona.<br>
              © ${new Date().getFullYear()} Verebona — Tous droits réservés.<br>
              <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}" style="color:#6b7280;text-decoration:none;">verebona.fr</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
