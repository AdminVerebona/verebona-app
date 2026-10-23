/**
 * Liens d'un document avec l'agenda — DocumentDrawer (lot 84B, CDC v5 O-3 :
 * §8.1, §14.4 ; AC01, AC05, AC08).
 *
 *   GET  /api/documents/:id/agenda-liens          nature des liens (précis / par l'ensemble, événement de référence)
 *   GET  /api/documents/:id/agenda-liens?candidats&q=  éléments d'agenda à relier
 *   POST /api/documents/:id/agenda-liens { itemId } lien manuel Document ↔ Agenda : le document rejoint
 *                                                  l'ensemble de l'élément (créé au besoin) — AC01
 *
 * Compte ACTIF seulement ; écriture refusée en lecture seule (403).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';

type RouteContext = { params: Promise<{ id: string }> };

async function compte(req: NextRequest, context: RouteContext): Promise<NextResponse | { accountId: number; userId: number | null; id: number }> {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });
  const { id: rawId } = await context.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  return { accountId, userId: session.userId ?? null, id };
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const c = await compte(req, context);
    if (c instanceof NextResponse) return c;
    const params = new URL(req.url).searchParams;
    if (params.has('candidats')) {
      const { listAgendaCandidatesForDocument } = await import('@/services/business-operations/grouping/read');
      const candidates = await listAgendaCandidatesForDocument(c.accountId, c.id, (params.get('q') ?? '').slice(0, 120));
      if (!candidates) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ candidates });
    }
    const { getDocumentAgendaLinks } = await import('@/services/business-operations/grouping/read');
    const links = await getDocumentAgendaLinks(c.accountId, c.id);
    if (!links) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ links });
  } catch (err) {
    console.error('[api/documents/:id/agenda-liens] GET', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const c = await compte(req, context);
    if (c instanceof NextResponse) return c;
    const refus = await refuserSiLectureSeule(c.accountId);
    if (refus) return refus;
    const body = await req.json().catch(() => null) as { itemId?: unknown } | null;
    const itemId = Number(body?.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) return NextResponse.json({ error: 'Élément invalide.' }, { status: 400 });
    const { applyAgendaDrawerAction } = await import('@/services/business-operations/grouping/drawer-actions');
    const { GroupingError } = await import('@/services/business-operations/grouping/service');
    try {
      await applyAgendaDrawerAction({ accountId: c.accountId, actorUserId: c.userId, itemId, action: 'relier-document', targetId: c.id });
    } catch (e) {
      if (e instanceof GroupingError) {
        const introuvable = e.code === 'ITEM_NOT_FOUND' || e.code === 'CROSS_ACCOUNT' || e.code === 'DOCUMENT_NOT_FOUND';
        return NextResponse.json({ error: introuvable ? 'Élément ou document introuvable.' : 'Ce lien n’a pas pu être créé.', code: e.code }, { status: introuvable ? 404 : 409 });
      }
      throw e;
    }
    await emitBusinessEvent({ type: 'AGENDA_ITEM_UPDATED', accountId: c.accountId, entityId: itemId });
    const { getDocumentAgendaLinks } = await import('@/services/business-operations/grouping/read');
    return NextResponse.json({ links: await getDocumentAgendaLinks(c.accountId, c.id) });
  } catch (err) {
    console.error('[api/documents/:id/agenda-liens] POST', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
