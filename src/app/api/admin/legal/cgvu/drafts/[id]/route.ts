/**
 * PUT /api/admin/legal/cgvu/drafts/{id} — CDC 7 §15 (administration).
 *
 * Modifie un brouillon. Une version publiée est refusée par le service ET par
 * un déclencheur en base : le critère 13 — « aucune route ne permet de
 * modifier une version publiée » — est tenu quoi qu'il arrive.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { updateDraft, getVersionById, LegalVersionError } from '@/services/legal';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let adminId: number;
  try {
    adminId = await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const { id } = await params;
  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  try {
    const updated = await updateDraft(id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      bodyHtml: typeof body.bodyHtml === 'string' ? body.bodyHtml : undefined,
      changeSummary: typeof body.changeSummary === 'string' ? body.changeSummary : undefined,
      effectiveAt: typeof body.effectiveAt === 'string' ? new Date(body.effectiveAt) : undefined,
      requiresReacceptance:
        typeof body.requiresReacceptance === 'boolean' ? body.requiresReacceptance : undefined,
      actorUserId: adminId,
    });
    return NextResponse.json({ version: updated });
  } catch (e) {
    if (e instanceof LegalVersionError) {
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'ALREADY_PUBLISHED' ? 409 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error('[legal-admin] modification de brouillon impossible :', (e as Error).message);
    return NextResponse.json({ error: 'Une erreur interne est survenue.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

/** GET — prévisualisation d'un brouillon avant publication (§5). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const { id } = await params;
  await ensureMigrations();
  const version = await getVersionById(id);

  if (!version) {
    return NextResponse.json({ error: 'Version introuvable.', code: 'NOT_FOUND' }, { status: 404 });
  }
  return NextResponse.json({ version });
}
