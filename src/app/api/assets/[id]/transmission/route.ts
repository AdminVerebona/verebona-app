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
import { assets, assetTransmissions, users, emailTemplates } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { emit } from '@/lib/notifications';
import { buildExportAssetSnapshot } from '@/services/exports/export-snapshot-source';
import { randomUUID } from 'crypto';
import { Resend } from 'resend';
import { buildTransmissionHtml } from '@/lib/email/transmission-email';

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

  let htmlBody: string;

  // Objet fixe, quel que soit le modèle en base : c'est l'unique e-mail d'une
  // transmission (l'e-mail de la notification TRANSMISSION_RECEIVED a été
  // retiré), et c'est celui que le destinataire doit reconnaître.
  const subject = `${opts.senderName} vous transmet un bien — Verebona`;
  if (tpl) {
    htmlBody = tpl.body
      .replace(/\{\{senderName\}\}/g, opts.senderName)
      .replace(/\{\{assetName\}\}/g, opts.assetName)
      .replace(/\{\{shareUrl\}\}/g, opts.shareUrl)
      .replace(/\{\{year\}\}/g, year);
  } else {
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

// Corps HTML de repli : `buildTransmissionHtml` (lib/email/transmission-email.ts, charte 2026 — lot 66C).

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
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId ?? -1))) // lot 49 : compte actif ; lot 72D : tout membre du compte, plus seulement le créateur
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

    // Lot 72D : compte de la SESSION (le bien vient d'y être vérifié), et non
    // la première adhésion de l'utilisateur, sans ordre.
    const accountId = session.currentAccountId ?? null;
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    // Build snapshot at transmission time
    // X-02 (lot 16) : source canonique ; `snapshot.dataSource` est figé dans
    // `snapshotPayload`.
    const snapshot = await buildExportAssetSnapshot(assetId, session.userId, { accountId }, 'TRANSMISSION') /* lot 72D : accès par compte (bien d'un autre membre) */;
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

    // Lot 72D : bien du compte de la session ; ses transmissions sont visibles
    // de tout membre du compte (titulaire et membre, matrice Q14), plus
    // seulement de celui qui les a lancées.
    const [bien] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId ?? -1)))
      .limit(1);
    if (!bien) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

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
      .where(eq(assetTransmissions.assetId, assetId));

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
