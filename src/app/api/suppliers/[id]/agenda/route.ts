/**
 * Événements d'Agenda d'un fournisseur — fiche fournisseur (lot 103E,
 * relation bidirectionnelle).
 *
 *   GET  /api/suppliers/:id/agenda                    événements rattachés (passés, à venir, sans date)
 *   GET  /api/suppliers/:id/agenda?candidats=1&q=…    événements du compte à rattacher (recherche Agenda)
 *   POST /api/suppliers/:id/agenda { action: 'link' | 'unlink', agendaItemId }
 *
 * Même relation persistante que depuis le tiroir Agenda (`agenda_item_suppliers`) ;
 * une dissociation ne supprime ni l'événement ni le fournisseur, et elle est
 * mémorisée (aucun traitement automatique ne recrée le lien). Compte actif
 * seulement (un identifiant d'un autre compte → 404) ; écriture refusée en
 * lecture seule (403).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { agendaTimeBucket } from '@/lib/agenda/agenda-suppliers-rules';
import { todayParisDateStr } from '@/lib/notifications/time-paris';

type RouteContext = { params: Promise<{ id: string }> };

async function contexte(req: NextRequest, context: RouteContext): Promise<NextResponse | { accountId: number; userId: number | null; supplierId: number }> {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });
  const { id } = await context.params;
  if (!/^\d{1,10}$/.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const { refsInAccount } = await import('@/services/security/account-ownership');
  if (!(await refsInAccount(accountId, { supplier: Number(id) }))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return { accountId, userId: session.userId ?? null, supplierId: Number(id) };
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const c = await contexte(req, context);
    if (c instanceof NextResponse) return c;
    const params = new URL(req.url).searchParams;
    const svc = await import('@/services/agenda/agenda-suppliers');
    const today = todayParisDateStr();
    if (params.get('candidats') !== null) {
      const { normalizeLocalQuery } = await import('@/lib/search/local-search');
      const q = normalizeLocalQuery(params.get('q'));
      const { matchingIdsForList } = await import('@/services/search/global-search.service');
      const deja = new Set((await svc.listItemsOfSupplier(c.accountId, c.supplierId)).map((i) => i.id));
      const ids = q ? await matchingIdsForList(c.accountId, q, 'agenda_item') : null;
      const { pgClient } = await import('@/db');
      const lignes = (await pgClient.unsafe(
        `SELECT id, title, start_date::text AS "startDate", manual_status AS "manualStatus" FROM agenda_items
          WHERE account_id = $1 ${ids ? 'AND id = ANY($2::int[])' : ''}
          ORDER BY start_date DESC NULLS LAST, id DESC LIMIT 60`,
        (ids ? [c.accountId, ids] : [c.accountId]) as never[],
      )) as unknown as Array<{ id: number; title: string; startDate: string | null; manualStatus: string | null }>;
      const candidates = lignes.filter((l) => !deja.has(Number(l.id))).slice(0, 20).map((l) => ({
        id: Number(l.id), title: l.title, startDate: l.startDate ? String(l.startDate).slice(0, 10) : null,
        manualStatus: l.manualStatus, bucket: agendaTimeBucket(l.startDate, today),
      }));
      return NextResponse.json({ candidates }, { headers: { 'Cache-Control': 'private, no-cache' } });
    }
    const items = (await svc.listItemsOfSupplier(c.accountId, c.supplierId)).map((i) => ({ ...i, bucket: agendaTimeBucket(i.startDate, today) }));
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'private, no-cache' } });
  } catch (err) {
    console.error('[api/suppliers/:id/agenda] GET', (err as Error).message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const c = await contexte(req, context);
    if (c instanceof NextResponse) return c;
    const refus = await refuserSiLectureSeule(c.accountId);
    if (refus) return refus;
    const body = await req.json().catch(() => null) as { action?: unknown; agendaItemId?: unknown } | null;
    const itemId = Number(body?.agendaItemId);
    if (!body || (body.action !== 'link' && body.action !== 'unlink') || !Number.isSafeInteger(itemId) || itemId <= 0) {
      return NextResponse.json({ error: 'Geste inconnu.' }, { status: 400 });
    }
    const svc = await import('@/services/agenda/agenda-suppliers');
    try {
      const p = { accountId: c.accountId, itemId, supplierId: c.supplierId, actorUserId: c.userId };
      const changed = body.action === 'link' ? await svc.linkSupplierByUser(p) : await svc.unlinkSupplierByUser(p);
      const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
      if (changed) await emitBusinessEvent({ type: 'AGENDA_ITEM_UPDATED', accountId: c.accountId, entityId: itemId });
      return NextResponse.json({ changed });
    } catch (e) {
      if (e instanceof svc.AgendaSupplierError) {
        return NextResponse.json({ error: e.code === 'ITEM_NOT_FOUND' ? 'Élément introuvable.' : 'Fournisseur introuvable.', code: `AGENDA_SUPPLIERS_${e.code}` }, { status: 404 });
      }
      throw e;
    }
  } catch (err) {
    console.error('[api/suppliers/:id/agenda] POST', (err as Error).message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
