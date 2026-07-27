/**
 * POST /api/assets/[id]/transmission — Initier une transmission
 * GET  /api/assets/[id]/transmission — Liste des transmissions du bien
 *
 * selected_payload structure :
 * { includeDocuments, selectedDocIds, includeEquipments, selectedEquipmentIds,
 *   includePhotos, selectedPhotoIds, includeEvents, selectedEventIds }
 * Le bien noyau est toujours transmis (non configurable).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, assetTransmissions, accountMemberships, users, emailTemplates } from '@/db/schema';
import { eq, and, or } from 'drizzle-orm';
import { emit } from '@/lib/notifications';
import { buildAssetSnapshot } from '@/services/export-snapshot.service';
import { randomUUID } from 'crypto';
import { Resend } from 'resend';

// ─── Email helper ────────────────────────────────────────────────────────────

async function sendTransmissionEmail(opts: {
  recipientEmail: string;
  senderName: string;
  assetName: string;
  shareUrl: string;
  baseUrl: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Transmission] RESEND_API_KEY not set — email skipped');
    return;
  }

  // Try DB template first
  const [tpl] = await db
    .select({ subject: emailTemplates.subject, body: emailTemplates.body })
    .from(emailTemplates)
    .where(eq(emailTemplates.type, 'TRANSMISSION_INVITE'))
    .limit(1);

  const year = new Date().getFullYear().toString();

  let subject: string;
  let htmlBody: string;

  if (tpl) {
    subject = tpl.subject
      .replace(/\{\{senderName\}\}/g, opts.senderName)
      .replace(/\{\{assetName\}\}/g, opts.assetName);
    htmlBody = tpl.body
      .replace(/\{\{senderName\}\}/g, opts.senderName)
      .replace(/\{\{assetName\}\}/g, opts.assetName)
      .replace(/\{\{shareUrl\}\}/g, opts.shareUrl)
      .replace(/\{\{year\}\}/g, year);
  } else {
    subject = `${opts.senderName} vous transmet un bien — Verebona`;
    htmlBody = buildTransmissionHtml(opts.senderName, opts.assetName, opts.shareUrl, year);
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: 'Verebona <noreply@verebona.com>',
    to: opts.recipientEmail,
    subject,
    html: htmlBody,
  });

  if (error) {
    console.error('[Transmission] Resend error:', error);
  }
}

function buildTransmissionHtml(senderName: string, assetName: string, shareUrl: string, year: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Transmission de bien — Verebona</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <center>
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F5F5F5;padding:40px 20px;">
      <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:600px;margin:0 auto;">

          <!-- Header -->
          <tr>
            <td align="center" style="padding:28px 24px 20px;border-bottom:2px solid #3B82F6;">
              <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;border-collapse:collapse;">
                <tr>
                  <!-- Logo mark : 3×3 grid (table-based, works in all clients incl. Outlook) -->
                  <td valign="middle" style="padding-right:10px;">
                    <table cellpadding="0" cellspacing="3" border="0" style="border-collapse:separate;border-spacing:3px;">
                      <tr>
                        <td style="width:11px;height:11px;background-color:#2D3748;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                        <td style="width:11px;height:11px;background-color:#2D3748;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                        <td style="width:11px;height:11px;background-color:#3B82F6;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                      </tr>
                      <tr>
                        <td style="width:11px;height:11px;background-color:#2D3748;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                        <td style="width:11px;height:11px;background-color:#2D3748;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                        <td style="width:11px;height:11px;background-color:#2D3748;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                      </tr>
                      <tr>
                        <td style="width:11px;height:11px;background-color:#2D3748;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                        <td style="width:11px;height:11px;background-color:#2D3748;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                        <td style="width:11px;height:11px;background-color:#2D3748;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                  <td valign="middle">
                    <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:26px;font-weight:700;color:#2D3748;letter-spacing:-0.5px;">Verebona</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 28px;font-size:16px;color:#374151;line-height:1.6;">
              <p style="margin:0 0 16px 0;">Bonjour,</p>
              <p style="margin:0 0 16px 0;">
                <strong>${senderName}</strong> vous invite à recevoir un bien dans votre portefeuille Verebona :
              </p>

              <!-- Asset box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F6;border-radius:8px;margin:20px 0;">
                <tr>
                  <td style="padding:20px;">
                    <p style="margin:0;font-size:13px;color:#6B7280;text-transform:uppercase;letter-spacing:.05em;font-weight:600;">Bien transmis</p>
                    <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#111827;">${assetName}</p>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 24px 0;">
                Pour accepter ou refuser cette transmission, cliquez sur le bouton ci-dessous.
              </p>

              <!-- CTA -->
              <p style="text-align:center;margin:28px 0;">
                <a href="${shareUrl}" style="background-color:#3B82F6;padding:13px 28px;border-radius:6px;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;display:inline-block;">
                  Voir l'invitation
                </a>
              </p>

              <p style="margin:24px 0 0;font-size:13px;color:#6B7280;">
                Ou copiez ce lien dans votre navigateur :<br/>
                <a href="${shareUrl}" style="color:#3B82F6;word-break:break-all;">${shareUrl}</a>
              </p>

              <p style="margin:20px 0 0;font-size:13px;color:#9CA3AF;">
                Si vous n'attendiez pas cette invitation, vous pouvez l'ignorer.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;text-align:center;border-top:1px solid #E5E7EB;background-color:#F9FAFB;">
              <p style="margin:0 0 4px;font-size:12px;color:#9CA3AF;">© ${year} Verebona — One place. Higher value.</p>
              <p style="margin:0;font-size:11px;color:#9CA3AF;">
                <a href="mailto:support@verebona.com" style="color:#6B7280;text-decoration:none;">support@verebona.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td></tr>
    </table>
  </center>
</body>
</html>`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SelectedPayload {
  includeDocuments: boolean;
  selectedDocIds: number[];
  includeEquipments: boolean;
  selectedEquipmentIds: number[];
  includePhotos: boolean;
  selectedPhotoIds: number[];
  includeEvents: boolean;
  selectedEventIds: number[];
}

async function resolveAccountId(userId: number): Promise<number | null> {
  const [m] = await db
    .select({ accountId: accountMemberships.accountId })
    .from(accountMemberships)
    .where(and(
      eq(accountMemberships.userId, userId),
      or(eq(accountMemberships.status, 'active'), eq(accountMemberships.status, 'ACTIVE')),
    ))
    .limit(1);
  return m?.accountId ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [asset] = await db
      .select({ id: assets.id, name: assets.name, category: assets.category })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    // Fetch sender's name for email
    const [sender] = await db
      .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    const body = await request.json().catch(() => ({}));
    const recipientEmail = body.recipientEmail?.trim();
    if (!recipientEmail) {
      return NextResponse.json({ error: 'RECIPIENT_EMAIL_REQUIRED' }, { status: 400 });
    }
    const keepActiveAfterTransmission = body.keepActiveAfterTransmission === true;

    const selectedPayload: SelectedPayload = {
      includeDocuments: body.selectedPayload?.includeDocuments ?? true,
      selectedDocIds: body.selectedPayload?.selectedDocIds ?? [],
      includeEquipments: body.selectedPayload?.includeEquipments ?? true,
      selectedEquipmentIds: body.selectedPayload?.selectedEquipmentIds ?? [],
      includePhotos: body.selectedPayload?.includePhotos ?? true,
      selectedPhotoIds: body.selectedPayload?.selectedPhotoIds ?? [],
      includeEvents: body.selectedPayload?.includeEvents ?? true,
      selectedEventIds: body.selectedPayload?.selectedEventIds ?? [],
    };

    const accountId = await resolveAccountId(session.userId);
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    // Build snapshot at transmission time
    const snapshot = await buildAssetSnapshot(assetId, session.userId);
    const token = randomUUID();
    const now = new Date();

    const [row] = await db
      .insert(assetTransmissions)
      .values({
        assetId,
        accountId,
        initiatorUserId: session.userId,
        recipientEmail,
        token,
        selectedPayload: JSON.stringify(selectedPayload),
        snapshotPayload: JSON.stringify(snapshot),
        keepActiveAfter: keepActiveAfterTransmission,
        status: 'pending',
        sentAt: now,
        createdAt: now,
      })
      .returning({
        id: assetTransmissions.id,
        publicId: assetTransmissions.publicId,
        token: assetTransmissions.token,
      });

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const shareUrl = `${baseUrl}/transmission/${token}`;

    // Send invitation email (fire-and-forget — do not block response)
    const senderName = sender
      ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.email
      : 'Un utilisateur Verebona';

    sendTransmissionEmail({
      recipientEmail,
      senderName,
      assetName: asset.name,
      shareUrl,
      baseUrl,
    }).catch((err) => console.error('[Transmission] Email send failed:', err));

    // Notify recipient if they already have an account
    const [recipientUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, recipientEmail))
      .limit(1);

    if (recipientUser) {
      await emit({
        type: 'TRANSMISSION_RECEIVED',
        recipientUserIds: [recipientUser.id],
        entityType: 'asset_transmission',
        entityId: row.id,
        payload: { senderName, assetName: asset.name, transmissionToken: token },
        dedupeKey: `transmission:received:${row.id}`,
      });
    }

    return NextResponse.json({
      transmissionId: row.id,
      publicId: row.publicId,
      token: row.token,
      shareUrl,
    });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const rows = await db
      .select({
        id: assetTransmissions.id,
        publicId: assetTransmissions.publicId,
        token: assetTransmissions.token,
        recipientEmail: assetTransmissions.recipientEmail,
        status: assetTransmissions.status,
        sentAt: assetTransmissions.sentAt,
        acceptedAt: assetTransmissions.acceptedAt,
        refusedAt: assetTransmissions.refusedAt,
        cancelledAt: assetTransmissions.cancelledAt,
        createdAt: assetTransmissions.createdAt,
      })
      .from(assetTransmissions)
      .where(and(
        eq(assetTransmissions.assetId, assetId),
        eq(assetTransmissions.initiatorUserId, session.userId),
      ));

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const transmissions = rows.map(r => ({
      ...r,
      shareUrl: `${baseUrl}/transmission/${r.token}`,
    }));

    return NextResponse.json({ transmissions });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
