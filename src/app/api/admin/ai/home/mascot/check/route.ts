import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkTarget } from '@/services/home/mascot/actions.service';
import type { MascotActionTarget } from '@/services/home/mascot/types';
import { mascotSession } from '../_session';

/**
 * POST /api/home/mascot/check — revalidation de la cible avant d'ouvrir le
 * parcours (REF-004, §20 : cible supprimée ou action déjà traitée).
 */
const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('drawer'), drawer: z.enum(['document', 'echeance', 'equipement', 'piece']), id: z.number().int().positive() }).passthrough(),
  z.object({ kind: z.literal('to_process'), publicId: z.string().min(1).max(64) }).passthrough(),
  z.object({ kind: z.literal('done'), occurrenceKey: z.string().max(200), cycleKey: z.string().max(100) }),
  z.object({ kind: z.literal('route'), href: z.string().max(300) }),
  z.object({ kind: z.literal('create_asset') }),
  z.object({ kind: z.literal('upload_document') }).passthrough(),
  z.object({ kind: z.literal('ask') }).passthrough(),
]);

export async function POST(req: NextRequest) {
  const s = await mascotSession(req);
  if (!s.ok) return s.response;
  const parsed = z.object({ target: Target }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  try {
    const status = await checkTarget(s.accountId, parsed.data.target as MascotActionTarget);
    return NextResponse.json({ status });
  } catch (e) {
    console.error('[api/home/mascot/check]', (e as Error).message);
    // Vérification impossible : on laisse le parcours normal trancher.
    return NextResponse.json({ status: 'ok' });
  }
}
