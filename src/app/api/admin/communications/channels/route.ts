/**
 * PATCH /api/admin/communications/channels — CDC Back-Office V1 COM-011, COM-012.
 *
 * Corps : `{ eventCode, channel: 'email' | 'push' | 'in_app', isActive, confirmed? }`.
 *
 * Seule mutation de l'écran Communications. Par canal, jamais pour tout
 * l'événement (COM-002). La désactivation exige `confirmed: true` — la
 * confirmation explicite de l'interface — et chaque changement est journalisé
 * (AUD-003), y compris un refus ou un échec. Un canal obligatoire du catalogue
 * ne peut pas être désactivé. Idempotente (ERR-002).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { isCommunicationChannel, setChannelActivation } from '@/services/admin/communications.service';

const ALLOWED_FIELDS = new Set(['eventCode', 'channel', 'isActive', 'confirmed']);

export async function PATCH(request: NextRequest) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const extra = body ? Object.keys(body).filter((k) => !ALLOWED_FIELDS.has(k)) : [];
  if (
    !body ||
    typeof body.eventCode !== 'string' ||
    !isCommunicationChannel(body.channel) ||
    typeof body.isActive !== 'boolean' ||
    extra.length > 0
  ) {
    return NextResponse.json(
      {
        code: 'INVALID_BODY',
        message:
          "Corps attendu : { eventCode, channel: 'email' | 'push' | 'in_app', isActive, confirmed? }. " +
          'Le contenu des modèles n’est pas modifiable depuis le back-office.',
        rejectedFields: extra,
      },
      { status: 400 },
    );
  }

  const eventCode = body.eventCode;
  const channel = body.channel;
  const isActive = body.isActive;
  const details = { eventCode, channel };

  try {
    const result = await setChannelActivation({
      eventCode,
      channel,
      isActive,
      confirmed: body.confirmed === true,
      adminId,
    });

    if (!result.ok) {
      if (result.error === 'CHANNEL_LOCKED') {
        await logAdminAction({
          adminId,
          action: 'COMMUNICATION_CHANNEL_TOGGLE',
          targetType: 'COMMUNICATION_CHANNEL',
          targetId: null,
          result: 'DENIED',
          after: { isActive },
          details: { ...details, reason: result.error },
        });
      }
      const status = result.error === 'UNKNOWN_CHANNEL' ? 404 : result.error === 'CHANNEL_LOCKED' ? 409 : 400;
      return NextResponse.json({ code: result.error, message: result.message }, { status });
    }

    if (result.changed) {
      await logAdminAction({
        adminId,
        action: 'COMMUNICATION_CHANNEL_TOGGLE',
        targetType: 'COMMUNICATION_CHANNEL',
        targetId: null,
        result: 'SUCCESS',
        before: { isActive: result.before },
        after: { isActive: result.after },
        details: { ...details, label: result.event.label },
      });
    }

    return NextResponse.json({ success: true, eventCode, channel, isActive: result.after, changed: result.changed });
  } catch (error) {
    console.error('[admin/communications/channels] PATCH :', error);
    await logAdminAction({
      adminId,
      action: 'COMMUNICATION_CHANNEL_TOGGLE',
      targetType: 'COMMUNICATION_CHANNEL',
      targetId: null,
      result: 'FAILURE',
      after: { isActive },
      details: { ...details, error: (error as Error).message },
    });
    return NextResponse.json(
      { code: 'CHANNEL_TOGGLE_FAILED', message: 'Le changement n’a pas pu être enregistré. Aucun effet appliqué.' },
      { status: 500 },
    );
  }
}
