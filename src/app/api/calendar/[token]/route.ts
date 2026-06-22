import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getAgendaItems } from '@/services/agenda/AgendaQueryService';
import { computeICSContent } from '@/services/agenda/AgendaCalendarExportService';

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const token = params.token.replace(/\.ics$/, '');

    const [account] = await db.select({
      id: accounts.id,
      name: accounts.name,
      calendarShareTokenActive: accounts.calendarShareTokenActive,
      planType: accounts.planType,
      premiumUntil: accounts.premiumUntil,
    }).from(accounts).where(eq(accounts.calendarShareToken, token));

    if (!account) {
      return new NextResponse('Token invalide', { status: 404 });
    }
    if (!account.calendarShareTokenActive) {
      return new NextResponse('Calendrier désactivé', { status: 403 });
    }

    // Premium check — source de vérité : accounts.planType
    const now = Date.now();
    const isPremium =
      account.planType === 'PREMIUM' ||
      account.planType === 'PREMIUM_DUO' ||
      account.planType === 'PREMIUM_PRO' ||
      (account.premiumUntil !== null && account.premiumUntil > now);

    if (!isPremium) {
      return new NextResponse('Fonctionnalité premium requise', { status: 403 });
    }

    const items = await getAgendaItems({
      accountId: account.id,
      includeCancelled: false,
      includeUndated: false,
    });

    const ics = computeICSContent(items, account.name);

    return new NextResponse(ics, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (err) {
    console.error('ICS export error:', err);
    return new NextResponse('Erreur serveur', { status: 500 });
  }
}
