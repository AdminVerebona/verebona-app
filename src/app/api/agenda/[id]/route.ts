import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getAgendaItemById } from '@/services/agenda/AgendaQueryService';
import { updateAgendaItem, deleteAgendaItem } from '@/services/agenda/AgendaWriteService';

/**
 * ⚠️ `params` EST UNE PROMESSE (Next.js 15).
 *
 * Ce fichier déclarait `{ params }: { params: { id: string } }`. L'accès
 * synchrone fonctionne encore à l'exécution — Next 15 attache les segments
 * sur la promesse —, mais le validateur de types généré par `next build`
 * attend `params: Promise<SegmentParams>` : la forme synchrone fait échouer
 * la compilation de production, et disparaîtra en Next 16.
 *
 * Les 116 autres routes du dépôt utilisent déjà cette forme.
 */
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    const { id: rawId } = await context.params;
    const id = parseInt(rawId, 10);
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const item = await getAgendaItemById(id, accountId);
    if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ item });
  } catch (err) {
    console.error('[api/agenda/:id] GET', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: RouteContext) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    const { id: rawId } = await context.params;
    const id = parseInt(rawId, 10);
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const body = await req.json();
    const item = await updateAgendaItem(id, body, accountId);
    return NextResponse.json({ item });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('Validation') || message.includes('Cohérence') ? 400 : message === 'Item not found' ? 404 : 500;
    if (status === 500) console.error('[api/agenda/:id] PUT', err);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    const { id: rawId } = await context.params;
    const id = parseInt(rawId, 10);
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    await deleteAgendaItem(id, accountId);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message === 'Item not found' ? 404 : 500;
    // ⚠️ L'ÉCHEC ÉTAIT MUET. Le client n'affiche qu'un toast générique ;
    // sans cette trace, une violation de contrainte référentielle était
    // indiscernable d'une panne réseau dans les journaux serveur.
    if (status === 500) console.error('[api/agenda/:id] DELETE', err);
    return NextResponse.json({ error: message }, { status });
  }
}
