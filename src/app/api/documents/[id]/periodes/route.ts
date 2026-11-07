/**
 * Périodes métier d'un document — lot 113W (Trello #724).
 *
 *   GET /api/documents/:id/periodes
 *     → { periods: { documentId, principal, secondary, coverageHistories } }
 *       période principale (une ligne, ou « Plusieurs périodes concernées »),
 *       autres natures, historique de couverture des événements de référence
 *       dont le document est membre. Lecture seule, aucune IA, aucune
 *       réanalyse à la consultation.
 *   PUT /api/documents/:id/periodes { periodId?, kind?, start, end }
 *     correction de l'utilisateur (dates partielles AAAA | AAAA-MM |
 *     AAAA-MM-JJ, ou null) — même fait, que la correction vienne du document
 *     ou de l'événement de référence ; protégée des retraitements.
 *
 * Compte actif de la session seulement (un document d'un autre compte,
 * supprimé ou inexistant → 404) ; écriture refusée à un compte en lecture
 * seule (403). Aucun mot « Opération » dans les réponses destinées à l'écran.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { isBusinessPeriodKind, isPartialDate, PERIOD_INVALID_MESSAGE } from '@/lib/documents/business-periods';

type RouteContext = { params: Promise<{ id: string }> };

async function contexte(req: NextRequest, context: RouteContext): Promise<NextResponse | { accountId: number; userId: number | null; id: number }> {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
  const { id } = await context.params;
  if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Valid document ID required');
  return { accountId: session.currentAccountId, userId: session.userId ?? null, id: Number(id) };
}

export async function GET(req: NextRequest, context: RouteContext) {
  const c = await contexte(req, context);
  if (c instanceof NextResponse) return c;
  try {
    const { readDocumentPeriods } = await import('@/services/documents/business-periods/service');
    const periods = await readDocumentPeriods(c.accountId, c.id);
    if (!periods) return apiError(404, 'NOT_FOUND', 'Document introuvable.');
    return NextResponse.json({ periods }, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/documents/:id/periodes] GET', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

const borne = (v: unknown): string | null | undefined => (v === null || v === undefined || v === '' ? null : isPartialDate(v) ? v : undefined);

export async function PUT(req: NextRequest, context: RouteContext) {
  const c = await contexte(req, context);
  if (c instanceof NextResponse) return c;
  const refus = await refuserSiLectureSeule(c.accountId);
  if (refus) return refus;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError(400, 'INVALID_INPUT', PERIOD_INVALID_MESSAGE);
  }
  const start = borne(body?.start);
  const end = borne(body?.end);
  const periodId = body?.periodId == null ? null : Number(body.periodId);
  const kind = body?.kind == null ? null : body.kind;
  if (start === undefined || end === undefined || (periodId !== null && !Number.isSafeInteger(periodId))
    || (periodId === null && !isBusinessPeriodKind(kind))) {
    return apiError(400, 'INVALID_INPUT', PERIOD_INVALID_MESSAGE);
  }
  try {
    const { correctDocumentPeriod, readDocumentPeriods } = await import('@/services/documents/business-periods/service');
    const r = await correctDocumentPeriod(c.accountId, c.userId, c.id, {
      periodId, kind: isBusinessPeriodKind(kind) ? kind : null, start, end,
    }, `user:${c.userId ?? 0}:periodes:${c.id}`);
    if (!r.ok) {
      if (r.error === 'NOT_FOUND') return apiError(404, 'NOT_FOUND', 'Période introuvable. Rechargez le document.');
      if (r.error === 'UNAVAILABLE') return apiError(503, 'INTERNAL_ERROR', 'La correction n’est pas disponible pour le moment.');
      return apiError(400, 'INVALID_INPUT', PERIOD_INVALID_MESSAGE);
    }
    const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
    await emitBusinessEvent({ type: 'DOCUMENT_UPDATED', accountId: c.accountId, entityId: c.id }).catch(() => {});
    return NextResponse.json({ period: r.period, periods: await readDocumentPeriods(c.accountId, c.id) });
  } catch (err) {
    console.error('[api/documents/:id/periodes] PUT', (err as Error).message);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
