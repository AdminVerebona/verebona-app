import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { agendaItems, agendaEquipmentLinks } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { computeEffectiveStatus } from '@/services/agenda/AgendaDomainService';

// GET /api/equipments/[id]/agenda — agenda items linked to an equipment
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

    // Get agenda item IDs linked to this equipment
    const linkedIds = await db
      .selectDistinct({ agendaItemId: agendaEquipmentLinks.agendaItemId })
      .from(agendaEquipmentLinks)
      .where(eq(agendaEquipmentLinks.equipmentId, equipmentId));

    if (linkedIds.length === 0) {
      return NextResponse.json({ items: [] });
    }

    const ids = linkedIds.map(r => r.agendaItemId);

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
        manualStatus: agendaItems.manualStatus,
        originType: agendaItems.originType,
      })
      .from(agendaItems)
      .where(
        and(
          eq(agendaItems.accountId, accountId),
          inArray(agendaItems.id, ids)
        )
      );

    const now = new Date();
    const items = rows.map(item => ({
      id: item.id,
      publicId: item.publicId,
      title: item.title,
      description: item.description,
      startDate: item.startDate,
      startTime: item.startTime,
      endDate: item.endDate,
      manualStatus: item.manualStatus,
      effectiveStatus: computeEffectiveStatus({
        startDate: item.startDate,
        startTime: item.startTime,
        endDate: item.endDate,
        endTime: item.endTime,
        manualStatus: item.manualStatus as 'realise' | 'annule' | null,
      }, now),
      originType: item.originType,
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

    return NextResponse.json({ items });
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
