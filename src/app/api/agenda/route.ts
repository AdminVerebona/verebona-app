import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { NextRequest, NextResponse } from 'next/server';
import { structuralLinkRefusal } from '@/services/agenda/housing-scope-http';
import { SessionService } from '@/lib/session-service';
import { getAgendaItems, getAgendaItemsWithEquipmentFacet } from '@/services/agenda/AgendaQueryService';
import { equipmentFilterParam } from '@/lib/filters/equipment-filter';
import { roomFilterParam } from '@/lib/filters/room-filter';
import { LOCAL_SEARCH_PARAM, normalizeLocalQuery } from '@/lib/search/local-search';
import { createAgendaItem } from '@/services/agenda/AgendaWriteService';
import { appliquerFournisseurs, preparerFournisseurs } from '@/lib/agenda/agenda-suppliers-route';

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    const { searchParams } = new URL(req.url);
    const assetIds = searchParams.get('assetIds')
      ? searchParams.get('assetIds')!.split(',').map(Number).filter(Boolean)
      : undefined;
    const fileId = searchParams.get('fileId') ? Number(searchParams.get('fileId')) : undefined;
    const period = (searchParams.get('period') as 'all' | 'past' | 'today' | 'upcoming') ?? 'all';
    // Lot 113P (#715) : `includeCancelled` (ancien filtre « annulés ») accepté et ignoré — plus de statut d'événement.
    const month = searchParams.get('month') ?? undefined;
    const year = searchParams.get('year') ?? undefined;
    const includeUndated = searchParams.get('includeUndated') !== 'false';

    // Lot 71 (71C) : filtre Équipement (`?equipment=asset|<id>`, avec
    // `assetIds`) et, sur demande (`?equipmentFacet=1`, « Mon agenda »), les
    // équipements des biens retenus avec leurs compteurs.
    // Lot 75B : filtre Pièce (`?piece=<id>`, avec `assetIds`) — échéances
    // directes de la pièce, de ses équipements et de ses documents ; la
    // facette (`roomFacet`) accompagne `equipmentFacet=1`.
    const equipment = equipmentFilterParam(searchParams.get('equipment')) ?? undefined;
    const piece = roomFilterParam(searchParams.get('piece')) ?? undefined;
    // Lot 97C : recherche locale (`?q=`), combinée aux filtres en intersection.
    const q = normalizeLocalQuery(searchParams.get(LOCAL_SEARCH_PARAM)) || undefined;
    const query = { accountId, assetIds, fileId, period, month, year, includeUndated, equipment, piece, q };
    if (searchParams.get('equipmentFacet') === '1') {
      const { items, equipmentFacet, roomFacet } = await getAgendaItemsWithEquipmentFacet(query);
      return NextResponse.json({ items, equipmentFacet, roomFacet }, { headers: { 'Cache-Control': 'private, no-cache' } });
    }
    const items = await getAgendaItems(query);
    return NextResponse.json({ items }, {
      // APP-PERF-22 : pas de réutilisation par le cache HTTP du navigateur
      // (non cloisonné par compte, non invalidé par les écritures).
      headers: { 'Cache-Control': 'private, no-cache' },
    });
  } catch (err) {
    console.error('GET /api/agenda error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    // Essai terminé : création refusée, avec le code que le client affiche
    // dans la fenêtre de fin d'essai.
    const refus = await refuserSiLectureSeule(accountId);
    if (refus) return refus;

    const body = await req.json();
    // Lot 113P (#715) : un `manualStatus` envoyé par un ancien client est IGNORÉ (plus de statut d'événement).
    const { title, description, startDate, startTime, endDate, endTime, assetIds, fileIds, substructureIds, equipmentIds, noDeadline, situation } = body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return NextResponse.json({ error: 'title est requis' }, { status: 400 });
    }

    // Lot 103E : « Fournisseur / intervenant » (facultatif) — validé AVANT toute écriture :
    // une sélection invalide ne crée ni l'élément, ni une fiche, ni un lien.
    const fournisseurs = await preparerFournisseurs(accountId, body.suppliers, null);
    if (fournisseurs instanceof NextResponse) return fournisseurs;

    const item = await createAgendaItem(
      // Lot 77A : « Sans échéance » validée par le service (booléen, incompatible avec une date).
      // Lot 114V (#742) : « Situation de l'événement » validée par le service ; absente (ancien client) → « À prévoir ».
      { title: title.trim(), description, startDate, startTime, endDate, endTime, assetIds, fileIds, substructureIds, equipmentIds, noDeadline, situation },
      accountId,
      session.userId
    );
    const itemId = (item as { id?: number } | null)?.id ?? null;
    const suppliers = fournisseurs && itemId ? await appliquerFournisseurs(accountId, itemId, session.userId ?? null, fournisseurs) : undefined;
    // CDC Assistant §25.7, §31.7 : cache de l'assistant invalidé avant la réponse.
    await emitBusinessEvent({ type: 'AGENDA_ITEM_CREATED', accountId, entityId: itemId });
    return NextResponse.json({ item, ...(suppliers ? { suppliers } : {}) }, { status: 201 });
  } catch (err) {
    // Lot 103D : pièce / équipement sans logement rattaché — code stable, rien n'est écrit.
    const refusLogement = structuralLinkRefusal(err);
    if (refusLogement) return refusLogement;
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.includes('Validation') || message.includes('Cohérence') ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
