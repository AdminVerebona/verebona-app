/**
 * POST /api/public/help-feedback — vote « Cet article vous a-t-il aidé ? ».
 * CDC Centre d'aide V1 FEEDBACK-01, FEEDBACK-02. Sans authentification.
 *
 * Corps : { articleId: "AID-DOC-001", helpful: boolean, contentVersion?: string }
 * Réponse : { feedbackId, commentToken } — le jeton n'existe que pour « Non ».
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { getClientIp } from '@/lib/rate-limiter';
import { allowFeedback, isArticleId, recordVote } from '@/services/help-feedback/help-feedback.service';
import { withCors } from './_cors';
import { loadHelpCorpus } from '@/services/verebona-assistant/core/help-corpus.service';

export async function POST(request: NextRequest) {
  if (!allowFeedback(getClientIp(request.headers))) {
    return withCors(request, NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 }));
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !isArticleId(body.articleId) || typeof body.helpful !== 'boolean') {
    return withCors(request, NextResponse.json({ error: 'INVALID_PAYLOAD' }, { status: 400 }));
  }
  // Article inconnu du corpus publié ici : refusé. Si le corpus est
  // momentanément illisible, le format suffit — perdre un retour réel serait
  // pire que d'en accepter un sur un ID bien formé.
  const corpus = await loadHelpCorpus();
  if (corpus && !corpus.articles.some((a) => a.id === body.articleId)) {
    return withCors(request, NextResponse.json({ error: 'UNKNOWN_ARTICLE' }, { status: 400 }));
  }
  try {
    await ensureMigrations();
    const r = await recordVote({
      articleId: body.articleId,
      helpful: body.helpful,
      contentVersion: typeof body.contentVersion === 'string' ? body.contentVersion : null,
    });
    return withCors(request, NextResponse.json(r, { status: 201 }));
  } catch (e) {
    console.error('[POST /api/public/help-feedback]', (e as Error).message);
    return withCors(request, NextResponse.json({ error: 'FEEDBACK_FAILED' }, { status: 500 }));
  }
}
