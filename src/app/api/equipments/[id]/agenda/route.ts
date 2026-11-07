import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { agendaItems } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { equipmentInAccount } from '@/services/security/account-ownership';

// GET /api/equipments/[id]/agenda — agenda items linked to an equipment
// Lot 49 (SEC-06) : équipement du compte vérifié AVANT la lecture ; éléments
// d'agenda du compte seulement.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const equipmentId = parseInt(id);
    if (isNaN(equipmentId)) return apiError(400, 'INVALID_INPUT', 'Invalid equipment id');
    if (!(await equipmentInAccount(accountId, equipmentId))) return apiError(404, 'NOT_FOUND', 'Equipment not found');

    // Lot 109A (ticket « Relations métier », §6) : CONTRAT DE LECTURE UNIQUE — éléments
    // DIRECTEMENT liés (`agenda_equipment_links`) et éléments des Opérations actives de
    // l'équipement (VIA_OPERATION), chacun une fois, liste exhaustive (toutes les pages).
    const { listAll, listEntityAgendaItems } = await import('@/services/relations/read-contract');
    const relations = await listAll((p) => listEntityAgendaItems(accountId, { kind: 'equipment', id: equipmentId }, { page: p, pageSize: 200 }));
    const provenance = new Map((relations?.items ?? []).map((r) => [r.id, r]));

    if (provenance.size === 0) {
      return NextResponse.json({ items: [], total: 0, totals: relations?.totals ?? { all: 0, direct: 0, viaOperationOnly: 0 } });
    }

    const ids = [...provenance.keys()];

    const rows = await db
      .select({
        id: agendaItems.id,
        publicId: agendaItems.publicId,
        title: agendaItems.title,
        description: agendaItems.description,
        startDate: agendaItems.startDate,
        startTime: agendaItems.startTime,
        endDate: agendaItems.endDate,
        endTime: agendaItems.endTime,
        originType: agendaItems.originType,
        originFieldKey: agendaItems.originFieldKey,
        noDeadline: agendaItems.noDeadline,
      })
      .from(agendaItems)
      .where(
        and(
          eq(agendaItems.accountId, accountId),
          inArray(agendaItems.id, ids)
        )
      );

    // Lot 113P (#715) : plus de statut d'événement — chaque élément à sa date.
    const items = rows.map(item => ({
      id: item.id,
      publicId: item.publicId,
      title: item.title,
      description: item.description,
      startDate: item.startDate,
      startTime: item.startTime,
      endDate: item.endDate,
      originType: item.originType,
      // Lot 77A : tâche « Sans échéance » (mention dans la fiche équipement).
      noDeadline: item.noDeadline === true,
      // Lot 109A : provenance (DIRECT / VIA_OPERATION) et Opérations de contexte.
      provenance: provenance.get(item.id)?.provenance ?? 'DIRECT',
      viaOperations: provenance.get(item.id)?.viaOperations ?? [],
    }));

    // Sort: upcoming first, then past
    items.sort((a, b) => {
      const da = a.startDate ?? '';
      const db2 = b.startDate ?? '';
      if (!da && !db2) return 0;
      if (!da) return 1;
      if (!db2) return -1;
      return da.localeCompare(db2);
    });

    return NextResponse.json({ items, total: items.length, totals: relations?.totals });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
