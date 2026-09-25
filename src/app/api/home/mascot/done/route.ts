import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { acknowledgeOccurrence, undoAcknowledgment } from '@/services/home/mascot/actions.service';
import { scheduleMascotPregeneration } from '@/services/home/mascot/mascot.service';
import { mascotSession } from '../_session';

/**
 * « C'est fait » (POST) et « Annuler » (DELETE) — CDC Mascotte §11, §16.2.
 * Acquittement au niveau du compte (DONE-004) ; aucune donnée métier écrite.
 */
const Body = z.object({
  occurrenceKey: z.string().min(1).max(200),
  cycleKey: z.string().min(1).max(100),
});

async function handle(req: NextRequest, undo: boolean) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  const refus = await refuserSiLectureSeule(s.accountId);
  if (refus) return refus;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });

  try {
    const r = undo
      ? await undoAcknowledgment({ accountId: s.accountId, ...parsed.data })
      : await acknowledgeOccurrence({ accountId: s.accountId, userId: s.userId, ...parsed.data });
    if (!r.ok) {
      const status = r.code === 'NOT_FOUND' ? 404 : r.code === 'UNDO_EXPIRED' ? 409 : 400;
      return NextResponse.json({ error: r.code, message: r.message }, { status });
    }
    scheduleMascotPregeneration(s.accountId);
    return NextResponse.json(r);
  } catch (e) {
    console.error('[api/home/mascot/done]', e);
    // §20 : l'échec est dit, la recommandation reste affichée côté client.
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'L’action n’a pas pu être enregistrée. Réessayez.' }, { status: 500 });
  }
}

export const POST = (req: NextRequest) => handle(req, false);
export const DELETE = (req: NextRequest) => handle(req, true);
