/**
 * Routes `/api/admin/communications/templates/[code]/**` — éditeur des modèles
 * d'e-mails transactionnels (lot 70A). Garde : `requireAdmin(request)` dans
 * chaque route (rôle ADMIN / SUPER_ADMIN relu en base — seuls rôles du BO) ;
 * CSRF des écritures vérifié par le middleware. Réponses jamais mises en cache.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { EditorErrorCode } from '@/services/admin/email-template-editor.service';
import type { PreviewSelection } from '@/services/admin/communications.service';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Corps JSON borné (gabarit HTML ≤ 200 000 caractères, plus les zones). */
const MAX_JSON_BYTES = 600_000;

export async function readJson(request: NextRequest): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => '');
  if (!text || text.length > MAX_JSON_BYTES) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const STATUS: Record<EditorErrorCode, number> = {
  NOT_FOUND: 404,
  CONTENT_LOCKED: 403,
  INVALID: 422,
  CONFLICT: 409,
  VERSION_NOT_FOUND: 404,
  NO_SHIPPED_TEXT: 409,
  SEND_FAILED: 502,
};

export function editorError(r: { error: EditorErrorCode; message: string; issues?: unknown }): NextResponse {
  return NextResponse.json({ code: r.error, message: r.message, issues: r.issues ?? [] }, { status: STATUS[r.error] ?? 400, headers: NO_STORE });
}

export function invalidBody(message = 'Corps de requête invalide.'): NextResponse {
  return NextResponse.json({ code: 'INVALID_BODY', message }, { status: 400, headers: NO_STORE });
}

export function serverError(context: string, error: unknown): NextResponse {
  console.error(`[admin/communications/templates] ${context} :`, (error as Error)?.message ?? error);
  return NextResponse.json({ code: 'EDITOR_FAILED', message: 'Opération impossible (voir le journal du serveur).' }, { status: 500, headers: NO_STORE });
}

const idOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Contexte de prévisualisation (COM-008), validé ensuite contre le compte de l'administrateur. */
export function selectionOf(body: Record<string, unknown> | null): PreviewSelection {
  const s = (body?.selection ?? {}) as Record<string, unknown>;
  return {
    assetId: idOf(s.assetId), documentId: idOf(s.documentId), deadlineId: idOf(s.deadlineId),
    paymentId: idOf(s.paymentId), withdrawalId: idOf(s.withdrawalId),
  };
}

export function draftOf(body: Record<string, unknown>): { subject: unknown; body?: unknown; zones?: unknown } {
  return { subject: body.subject, body: body.body, zones: body.zones };
}
