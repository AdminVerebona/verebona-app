/**
 * POST /api/admin/legal/cgvu/drafts — CDC 7 §15 (administration).
 *
 * Crée un brouillon. Seule voie d'entrée d'un nouveau texte : le §6.3 impose
 * que toute correction passe par un nouveau brouillon, jamais par la
 * modification d'une version publiée.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { createDraft, listVersions, LegalVersionError } from '@/services/legal';

export async function POST(req: NextRequest) {
  let adminId: number;
  try {
    adminId = await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const versionCode = typeof body.versionCode === 'string' ? body.versionCode.trim() : '';
  const bodyHtml = typeof body.bodyHtml === 'string' ? body.bodyHtml : '';
  const changeSummary = typeof body.changeSummary === 'string' ? body.changeSummary : '';
  const effectiveAt = typeof body.effectiveAt === 'string' ? new Date(body.effectiveAt) : null;

  if (!effectiveAt || Number.isNaN(effectiveAt.getTime())) {
    return NextResponse.json(
      { error: "Date d'entrée en vigueur invalide.", code: 'INVALID_EFFECTIVE_DATE' },
      { status: 400 },
    );
  }
  if (!bodyHtml.trim()) {
    return NextResponse.json({ error: 'Le contenu est obligatoire.', code: 'EMPTY_CONTENT' }, { status: 400 });
  }

  try {
    const draft = await createDraft({
      versionCode,
      title: typeof body.title === 'string' ? body.title : undefined,
      bodyHtml,
      changeSummary,
      effectiveAt,
      requiresReacceptance: body.requiresReacceptance === true,
      actorUserId: adminId,
    });
    return NextResponse.json({ version: draft }, { status: 201 });
  } catch (e) {
    if (e instanceof LegalVersionError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error('[legal-admin] création de brouillon impossible :', (e as Error).message);
    return NextResponse.json({ error: 'Une erreur interne est survenue.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

/** GET — historique complet, tous statuts confondus (§15). */
export async function GET(req: NextRequest) {
  try {
    await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();
  const versions = await listVersions();

  // Le contenu HTML n'est pas renvoyé : il pèse plusieurs dizaines de kilo-
  // octets par version et la liste n'en a aucun usage.
  return NextResponse.json({
    versions: versions.map(({ htmlContent, ...rest }) => ({
      ...rest,
      contentLength: htmlContent?.length ?? 0,
    })),
  });
}
