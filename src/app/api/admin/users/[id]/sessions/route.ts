/**
 * GET /api/admin/users/[id]/sessions — sessions actives d'un utilisateur
 * (lot 92, CDC 18 §20 / §26). Désactivé par défaut (USR-D03) : réglage
 * `AUTH_BO_SESSION_LIST` (`lib/auth/bo-session-list.ts`). Appareil, navigateur
 * ou application, dernière activité ; jamais d'IP ni de `sid`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { listUserSessions } from '@/lib/auth/session-registry';
import { boSessionListEnabled } from '@/lib/auth/bo-session-list';
import { parseUserId, invalidUserId } from '../_shared';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const userId = parseUserId((await context.params).id);
  if (!userId) return invalidUserId();
  if (!boSessionListEnabled()) return NextResponse.json({ enabled: false, sessions: [] });
  const sessions = (await listUserSessions(userId, null)).map(({ current: _current, ...s }) => s);
  return NextResponse.json({ enabled: true, sessions }, { headers: { 'Cache-Control': 'no-store' } });
}
