import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { events } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: idStr } = await params;
    const id = parseInt(idStr);

    if (isNaN(id)) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const event = await db.select()
      .from(events)
      .where(
        and(
          eq(events.id, id),
          eq(events.accountId, session.currentAccountId!)
        )
      )
      .limit(1);

    if (event.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Echéance non trouvée');
    }

    const e = event[0];
    if (!e.date) {
      return apiError(400, 'INVALID_STATE', 'L\'échéance n\'a pas de date');
    }

    // Format YYYYMMDD
    const dateStr = e.date.replace(/-/g, '').split('T')[0];
    const summary = e.categorie ? `Échéance — ${e.categorie.charAt(0).toUpperCase() + e.categorie.slice(1)}` : 'Échéance';
    const description = `Lien : ${process.env.NEXT_PUBLIC_APP_URL || 'https://app.verebona.fr'}/events/${e.id}`;
    
    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Verebona//NONSGML v1.0//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:due_${e.id}@verebona`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
      `DTSTART;VALUE=DATE:${dateStr}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    return new NextResponse(icsContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="echeance-${e.id}.ics"`,
      },
    });

  } catch (error: any) {
    console.error('ICS generation error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + error.message);
  }
}
