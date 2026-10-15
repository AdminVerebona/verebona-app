import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { clearT6Reminder, getT6ReminderState, setT6Reminder } from '@/services/home/mascot/t6-reminders.service';
import { mascotSession } from '../_session';

/**
 * Rappels T6 de l'accueil — lot 60.
 *
 *   GET    ?agendaItemId=…  état des rappels de l'échéance pour l'utilisateur
 *                           de la session (occurrence, série, date proposée) ;
 *   POST   { agendaItemId, action: SNOOZE | DISMISS, scope?, remindAt? } ;
 *   DELETE { agendaItemId, scope? } : réactive les rappels.
 *
 * Préférence PERSONNELLE (Duo : jamais celle de l'autre membre) : aucune
 * donnée métier n'est modifiée — l'échéance reste dans l'agenda. La cible est
 * toujours revalidée dans le compte de la session (SEC-006).
 */
const Id = z.coerce.number().int().positive().max(2_147_483_647);
const Scope = z.enum(['OCCURRENCE', 'SERIES']).optional();
const Post = z.object({
  agendaItemId: Id,
  action: z.enum(['SNOOZE', 'DISMISS']),
  scope: Scope,
  remindAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
const Del = z.object({ agendaItemId: Id, scope: Scope });

const STATUS: Record<string, number> = { NOT_FOUND: 404, INVALID_DATE: 400, NO_SERIES: 400, INVALID_INPUT: 400 };
const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  const id = Id.safeParse(req.nextUrl.searchParams.get('agendaItemId'));
  if (!id.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  try {
    const r = await getT6ReminderState({ accountId: s.accountId, userId: s.userId, agendaItemId: id.data });
    if ('ok' in r) return NextResponse.json({ error: r.code, message: r.message }, { status: STATUS[r.code] ?? 400 });
    return NextResponse.json(r, { headers: noStore });
  } catch (e) {
    console.error('[api/home/mascot/reminders] GET', e);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Les rappels n’ont pas pu être lus.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  const parsed = Post.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  try {
    const r = await setT6Reminder({ accountId: s.accountId, userId: s.userId, ...parsed.data });
    if (!r.ok) return NextResponse.json({ error: r.code, message: r.message }, { status: STATUS[r.code] ?? 400 });
    return NextResponse.json(r.state, { headers: noStore });
  } catch (e) {
    console.error('[api/home/mascot/reminders] POST', e);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Votre choix n’a pas pu être enregistré. Réessayez.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  const parsed = Del.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  try {
    const r = await clearT6Reminder({ accountId: s.accountId, userId: s.userId, ...parsed.data });
    if (!r.ok) return NextResponse.json({ error: r.code, message: r.message }, { status: STATUS[r.code] ?? 400 });
    return NextResponse.json(r.state, { headers: noStore });
  } catch (e) {
    console.error('[api/home/mascot/reminders] DELETE', e);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Votre choix n’a pas pu être enregistré. Réessayez.' }, { status: 500 });
  }
}
