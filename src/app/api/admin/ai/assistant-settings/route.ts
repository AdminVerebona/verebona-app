/**
 * Seuils et interrupteurs de l'assistant — CDC Assistant §6.6, §32.6, §32.7,
 * CA-30 ; décision PO D-J1 (lot 21).
 *
 *   GET  : réglages (valeur effective et provenance : BO, environnement,
 *          défaut), demandes de double validation, historique des
 *          modifications (journal admin), journal des consultations
 *          sensibles, état du limiteur de débit de l'instance.
 *   PUT  : { key, value } — appliqué tout de suite (toutes instances en
 *          ≤ 5 s), ou mis en attente d'un second administrateur.
 *
 * Administrateurs seulement ; chaque modification est journalisée.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/db';
import {
  AssistantSettingRefused, effectiveAssistantSettings, listAssistantSettingRequests, refreshAssistantSettings,
  SETTING_GROUP_LABELS, updateAssistantSetting,
} from '@/services/verebona-assistant/config/assistant-settings';
import { listT2ContentAccesses } from '@/services/ai/telemetry/t2-request-detail.repository';
import { rateLimiterHealth } from '@/lib/verebona/rate-limit';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

const ACTIONS = ['ASSISTANT_SETTING_UPDATE', 'ASSISTANT_SETTING_REQUEST', 'ASSISTANT_SETTING_APPROVE', 'ASSISTANT_SETTING_REJECT', 'ASSISTANT_SETTING_CANCEL'];

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    await refreshAssistantSettings(true);
    const [requests, history, contentReads] = await Promise.all([
      listAssistantSettingRequests(20),
      pgClient.unsafe(
        `SELECT timestamp, admin_email, action_type, result, old_value, new_value
           FROM admin_audit_log WHERE action_type = ANY($1::text[])
          ORDER BY timestamp DESC LIMIT 50`,
        [ACTIONS] as never[],
      ).catch(() => []),
      listT2ContentAccesses(50).catch(() => []),
    ]);
    return NextResponse.json({
      adminUserId: guard.ctx.adminUserId,
      groups: SETTING_GROUP_LABELS,
      settings: effectiveAssistantSettings(),
      requests,
      history: (history as unknown as Array<Record<string, unknown>>).map((h) => ({
        at: new Date(String(h.timestamp)).toISOString(),
        admin: String(h.admin_email),
        action: String(h.action_type),
        result: String(h.result ?? 'SUCCESS'),
        before: h.old_value ?? null,
        after: h.new_value ?? null,
      })),
      contentReads,
      rateLimiter: rateLimiterHealth(),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/assistant-settings');
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => null)) as { key?: unknown; value?: unknown } | null;
  if (!body || typeof body.key !== 'string') {
    return NextResponse.json({ error: 'INVALID_BODY', message: '`key` et `value` sont requis.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await updateAssistantSetting({ key: body.key, value: body.value, adminId: guard.ctx.adminUserId }));
  } catch (e) {
    if (e instanceof AssistantSettingRefused) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    return toErrorResponse(e, 'PUT /api/admin/ai/assistant-settings');
  }
}
