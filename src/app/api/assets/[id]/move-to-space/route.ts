/**
 * « Déplacer vers l'espace Duo » — lot 74B, point 4.
 *
 * GET  /api/assets/[id]/move-to-space
 *      → { targets: [{ accountId, name, role, roleLabel }] } : espaces Duo
 *        admissibles pour l'utilisateur (vide : l'action n'est pas affichée).
 * POST /api/assets/[id]/move-to-space { targetAccountId, preview: true }
 *      → aperçu EXACT (ce qui part, ce qui reste, quotas après) + empreinte.
 * POST /api/assets/[id]/move-to-space { targetAccountId, confirm: true, fingerprint }
 *      → déplacement (transactionnel, idempotent, journalisé).
 *
 * Le bien doit être dans l'espace COURANT de la session ; l'utilisateur doit
 * être membre actif (titulaire ou membre) des deux espaces — contrôles
 * relus en base dans la transaction (`asset-space-move.service.ts`).
 * Desktop et mobile : même fiche du bien (WebView), même route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import {
  listMoveTargets,
  moveAssetToSpace,
  previewMoveToSpace,
  MOVE_ERROR_HTTP_STATUS,
  type MoveResult,
} from '@/services/assets/asset-space-move.service';

type Ctx = { params: Promise<{ id: string }> };

async function assetIdOf(ctx: Ctx): Promise<number | null> {
  const id = Number.parseInt((await ctx.params).id, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    if (!(await assetIdOf(ctx))) return NextResponse.json({ error: 'INVALID_INPUT', code: 'INVALID_INPUT' }, { status: 400 });
    const targets = await listMoveTargets(session.userId, session.currentAccountId ?? null);
    return NextResponse.json({ targets });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}

function reponse(r: MoveResult): NextResponse {
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, code: r.error, message: r.message, ...(r.preview ? { preview: r.preview } : {}) },
      { status: MOVE_ERROR_HTTP_STATUS[r.error] },
    );
  }
  return NextResponse.json(r);
}

export async function POST(request: NextRequest, ctx: Ctx) {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  try {
    const assetId = await assetIdOf(ctx);
    const body = (await request.json().catch(() => ({}))) as { targetAccountId?: unknown; preview?: unknown; confirm?: unknown; fingerprint?: unknown };
    const targetAccountId = Number(body.targetAccountId);
    if (!assetId || !Number.isInteger(targetAccountId) || targetAccountId <= 0) {
      return NextResponse.json({ error: 'INVALID_INPUT', code: 'INVALID_INPUT', message: 'Espace de destination manquant.' }, { status: 400 });
    }
    if (!session.currentAccountId) {
      return NextResponse.json({ error: 'NO_ACCOUNT', code: 'NO_ACCOUNT', message: 'Aucun espace sélectionné.' }, { status: 403 });
    }
    const p = { userId: session.userId, userEmail: session.email, assetId, sourceAccountId: session.currentAccountId, targetAccountId };
    if (body.preview === true) return reponse(await previewMoveToSpace(p));
    if (body.confirm !== true || typeof body.fingerprint !== 'string' || !body.fingerprint) {
      return NextResponse.json(
        { error: 'CONFIRMATION_REQUIRED', code: 'CONFIRMATION_REQUIRED', message: 'Confirmez le déplacement après avoir consulté ce qui part avec le bien.' },
        { status: 400 },
      );
    }
    return reponse(await moveAssetToSpace({ ...p, fingerprint: body.fingerprint }));
  } catch (error) {
    console.error('[move-to-space] erreur :', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'Le déplacement a échoué : rien n’a été modifié.' }, { status: 500 });
  }
}
