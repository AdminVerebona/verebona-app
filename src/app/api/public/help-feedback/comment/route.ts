/**
 * POST /api/public/help-feedback/comment — commentaire facultatif après « Non ».
 * CDC Centre d'aide V1 FEEDBACK-01, FEEDBACK-02. Sans authentification.
 *
 * Corps : { feedbackId, commentToken, comment } — le jeton rendu par le vote,
 * à usage unique, valable une heure.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { getClientIp } from '@/lib/rate-limiter';
import { allowFeedback, recordComment, sanitizeComment } from '@/services/help-feedback/help-feedback.service';
import { withCors } from '../_cors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  if (!allowFeedback(getClientIp(request.headers))) {
    return withCors(request, NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 }));
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const comment = sanitizeComment(body?.comment);
  if (!body || typeof body.feedbackId !== 'string' || !UUID.test(body.feedbackId)
    || typeof body.commentToken !== 'string' || body.commentToken.length > 100 || !comment) {
    return withCors(request, NextResponse.json({ error: 'INVALID_PAYLOAD' }, { status: 400 }));
  }
  try {
    await ensureMigrations();
    const ok = await recordComment(body.feedbackId, body.commentToken, comment);
    return withCors(request, ok
      ? NextResponse.json({ saved: true })
      : NextResponse.json({ error: 'INVALID_OR_EXPIRED_TOKEN' }, { status: 409 }));
  } catch (e) {
    console.error('[POST /api/public/help-feedback/comment]', (e as Error).message);
    return withCors(request, NextResponse.json({ error: 'FEEDBACK_FAILED' }, { status: 500 }));
  }
}
