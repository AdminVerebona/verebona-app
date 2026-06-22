/** @deprecated LEGACY — Gel deadlines. Voir /api/deadlines/route.ts pour contexte. */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { deadlines } from '@/db/schema';
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

    const deadline = await db.select()
      .from(deadlines)
      .where(
        and(
          eq(deadlines.id, id),
          eq(deadlines.accountId, session.currentAccountId!)
        )
      )
      .limit(1);

    if (deadline.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Deadline not found');
    }

    const d = deadline[0];
    if (!d.deadlineDate) {
      return apiError(400, 'INVALID_STATE', 'Deadline has no date');
    }

    const dateStr = d.deadlineDate.replace(/-/g, '');
    const summary = d.deadlineType ? `Échéance — ${d.deadlineType}` : 'Échéance';
    const description = `Lien : ${process.env.NEXT_PUBLIC_APP_URL || 'https://app.verebona.com'}/events/${d.id}`;
    
    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Verebona//NONSGML v1.0//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:due_${d.id}@verebona`,
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
        'Content-Disposition': `attachment; filename="echeance-${d.id}.ics"`,
      },
    });

  } catch (error: any) {
    console.error('ICS generation error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + error.message);
  }
}
