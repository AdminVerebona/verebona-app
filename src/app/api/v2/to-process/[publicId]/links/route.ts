/**
 * POST /api/v2/to-process/[publicId]/links — lot 107E, revalidation d'un lien
 * direct AU CLIC, avant d'ouvrir la destination native (tiroir, page).
 *
 *   corps : { "target": { "kind": "document" | "asset" | "equipement" | "piece" | "echeance" | "reference" | "supplier", "id": 123 } }
 *   réponse : { "status": "ok" | "gone" | "resolved" }
 *
 * · Compte de la SESSION uniquement (isolation des comptes, Duo compris) :
 *   aucun identifiant reçu n'est cru sur parole.
 * · La destination doit faire partie des liens de CETTE carte, recalculés
 *   maintenant (`checkCardLink`) : la route n'est pas un oracle d'existence —
 *   un identifiant étranger, supprimé ou hors de la carte rend `gone`, sans
 *   distinction (anti-énumération).
 * · Lecture seule : aucune décision, aucune écriture (sauf, au besoin, la
 *   trace Supervision d'une référence techniquement cassée).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SessionService } from '@/lib/session-service';
import { checkCardLink } from '@/services/to-process/card-links';

export const dynamic = 'force-dynamic';

const Body = z.object({
  target: z.object({
    kind: z.enum(['document', 'asset', 'equipement', 'piece', 'echeance', 'reference', 'supplier']),
    id: z.number().int().positive().max(2_147_483_647),
  }),
});

export async function POST(req: NextRequest, context: { params: Promise<{ publicId: string }> }) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT_SELECTED' }, { status: 400 });

  const { publicId } = await context.params;
  if (!/^[0-9a-zA-Z-]{8,64}$/.test(publicId ?? '')) return NextResponse.json({ status: 'gone' });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });

  try {
    const status = await checkCardLink(accountId, publicId, parsed.data.target);
    return NextResponse.json({ status }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('[api/v2/to-process/links]', (e as Error).message);
    // Vérification impossible : on n'ouvre rien (variante prudente, comme le lot 76E).
    return NextResponse.json({ error: 'CHECK_FAILED' }, { status: 503 });
  }
}
