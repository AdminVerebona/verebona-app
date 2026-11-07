import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { emitBusinessEvent, emitBusinessEvents } from '@/services/verebona-assistant/events/business-events';
import { NextRequest, NextResponse } from 'next/server';
import { structuralLinkRefusal } from '@/services/agenda/housing-scope-http';
import { SessionService } from '@/lib/session-service';
import { getAgendaItemById } from '@/services/agenda/AgendaQueryService';
import { updateAgendaItem, deleteAgendaItem } from '@/services/agenda/AgendaWriteService';
import { appliquerFournisseurs, preparerFournisseurs } from '@/lib/agenda/agenda-suppliers-route';

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

    const refus = await refuserSiLectureSeule(accountId);
    if (refus) return refus;

    const { suppliers: suppliersBody, ...body } = await req.json();
    // Lot 103E : « Fournisseur / intervenant » — validé AVANT toute écriture (élément du compte requis).
    const fournisseurs = await preparerFournisseurs(accountId, suppliersBody, id);
    if (fournisseurs instanceof NextResponse) return fournisseurs;
    // Lot 103D : dissociation des pièces / équipements devenus incompatibles — seulement sur confirmation explicite.
    if (body && typeof body === 'object' && 'dissociateIncompatible' in body && (body as Record<string, unknown>).dissociateIncompatible !== true) delete (body as Record<string, unknown>).dissociateIncompatible;
    // Lot 113P (#715) : un `manualStatus` envoyé par un ancien client est ignoré (plus de statut d'événement).
    if (body && typeof body === 'object') delete (body as Record<string, unknown>).manualStatus;
    // Lot 77A : l'auteur est tracé avec l'option « Sans échéance » (cochée / retirée).
    const item = await updateAgendaItem(id, body, accountId, session.userId ?? null);
    const suppliers = fournisseurs ? await appliquerFournisseurs(accountId, id, session.userId ?? null, fournisseurs) : undefined;
    // CDC Assistant §25.7 : événement métier (caches de l'assistant).
    await emitBusinessEvent({ type: 'AGENDA_ITEM_UPDATED', accountId, entityId: id });
    return NextResponse.json({ item, ...(suppliers ? { suppliers } : {}) });
  } catch (err) {
    // Lot 103D : pièce / équipement sans logement rattaché, ou logement retiré sans confirmation — code stable, rien n'est écrit.
    const refusLogement = structuralLinkRefusal(err);
    if (refusLogement) return refusLogement;
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

    // Lot 85D : la suppression est une écriture — refusée en lecture seule
    // (essai échu, impayé, résilié, rétractation), comme `PUT` ci-dessus.
    const refus = await refuserSiLectureSeule(accountId);
    if (refus) return refus;

    // Lot 113P (#715) : récurrence — `?scope=series` supprime TOUTE la série (sinon : cet événement seul).
    const scope = new URL(req.url).searchParams.get('scope') === 'series' ? 'SERIES' as const : 'OCCURRENCE' as const;
    // Lot 46 (O7) : l'auteur est mémorisé avec la suppression d'un événement projeté (F-146) ;
    // lot 113P : trace persistante d'exclusion (aucune réanalyse ne recrée l'événement).
    const { deletedIds } = await deleteAgendaItem(id, accountId, session.userId ?? null, { scope });
    // CDC Assistant §25.7 : événement métier (caches de l'assistant, §31.4).
    // Une invalidation par demande (§31.7), même pour une série entière.
    await emitBusinessEvents(deletedIds.map((entityId) => ({ type: 'AGENDA_ITEM_DELETED' as const, accountId, entityId })));
    return NextResponse.json({ success: true, deletedIds });
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
