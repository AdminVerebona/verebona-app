/**
 * Regroupement d'un élément d'agenda — tiroirs (lot 84B, CDC v5 O-3 : §7,
 * §8, §11.9, §14 ; AC01–AC08, AC27, AC28, AC32).
 *
 *   GET  /api/agenda/:id/liens                      vue du tiroir (ensemble, événement de référence)
 *   GET  /api/agenda/:id/liens?candidats=<type>&q=  objets du compte à relier (elements, documents, biens, pieces, equipements)
 *   POST /api/agenda/:id/liens { action, targetId } geste de l'utilisateur (service unique de regroupement)
 *
 * Compte ACTIF de la session seulement (un identifiant d'un autre compte →
 * 404, rien n'est écrit) ; écriture refusée à un compte en lecture seule
 * (403, `refuserSiLectureSeule`). Aucun mot « Opération » dans les réponses
 * destinées à l'écran.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { GROUPING_CANDIDATE_KINDS, isGroupingAction, type GroupingCandidateKind } from '@/lib/agenda/grouping-view';

type RouteContext = { params: Promise<{ id: string }> };

/** Message affiché pour une erreur technique du regroupement (jamais le code interne). */
const MESSAGES: Record<string, { status: number; message: string }> = {
  ITEM_NOT_FOUND: { status: 404, message: 'Élément introuvable.' },
  CROSS_ACCOUNT: { status: 404, message: 'Élément introuvable.' },
  DOCUMENT_NOT_FOUND: { status: 404, message: 'Document introuvable.' },
  OPERATION_NOT_FOUND: { status: 409, message: 'Cet élément n’est relié à rien pour le moment.' },
  OPERATION_INACTIVE: { status: 409, message: 'Cet ensemble a changé entre-temps. Rechargez le tiroir.' },
  NOT_GROUPED: { status: 409, message: 'Cet élément n’est relié à rien pour le moment.' },
  SAME_ITEM: { status: 400, message: 'Un élément ne peut pas être relié à lui-même.' },
  MERGE_REFUSED: { status: 409, message: 'Ces deux éléments ne peuvent pas être réunis automatiquement.' },
  LINKED_ELSEWHERE: { status: 409, message: 'Cet élément est déjà relié à un autre ensemble.' },
};

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
    const kind = params.get('candidats');
    if (kind !== null) {
      if (!(GROUPING_CANDIDATE_KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: 'Type inconnu.' }, { status: 400 });
      const { listGroupingCandidates } = await import('@/services/business-operations/grouping/read');
      const candidates = await listGroupingCandidates(c.accountId, c.id, kind as GroupingCandidateKind, (params.get('q') ?? '').slice(0, 120));
      if (!candidates) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ candidates });
    }
    const { getAgendaGroupingView } = await import('@/services/business-operations/grouping/read');
    const view = await getAgendaGroupingView(c.accountId, c.id);
    if (!view) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ view });
  } catch (err) {
    console.error('[api/agenda/:id/liens] GET', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const c = await compte(req, context);
    if (c instanceof NextResponse) return c;
    const refus = await refuserSiLectureSeule(c.accountId);
    if (refus) return refus;
    const body = await req.json().catch(() => null) as { action?: unknown; targetId?: unknown } | null;
    if (!body || !isGroupingAction(body.action)) return NextResponse.json({ error: 'Geste inconnu.' }, { status: 400 });
    const targetId = body.targetId === undefined || body.targetId === null ? null : Number(body.targetId);
    if (targetId !== null && (!Number.isSafeInteger(targetId) || targetId <= 0)) return NextResponse.json({ error: 'Cible invalide.' }, { status: 400 });
    const { applyAgendaDrawerAction } = await import('@/services/business-operations/grouping/drawer-actions');
    const { GroupingError } = await import('@/services/business-operations/grouping/service');
    try {
      const result = await applyAgendaDrawerAction({ accountId: c.accountId, actorUserId: c.userId, itemId: c.id, action: body.action, targetId });
      await emitBusinessEvent({ type: 'AGENDA_ITEM_UPDATED', accountId: c.accountId, entityId: c.id });
      const { getAgendaGroupingView } = await import('@/services/business-operations/grouping/read');
      return NextResponse.json({ changed: result.changed, view: await getAgendaGroupingView(c.accountId, c.id) });
    } catch (e) {
      if (e instanceof GroupingError) {
        const m = MESSAGES[e.code] ?? { status: 409, message: 'Ce geste n’a pas pu être appliqué.' };
        return NextResponse.json({ error: m.message, code: e.code }, { status: m.status });
      }
      throw e;
    }
  } catch (err) {
    console.error('[api/agenda/:id/liens] POST', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
