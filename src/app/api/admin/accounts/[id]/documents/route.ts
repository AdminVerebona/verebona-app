/**
 * GET /api/admin/accounts/[id]/documents?page=&sort=&dir= — CDC Back-Office V1
 * ACC-D07, ACC-D08, SEC-001, SEC-002.
 *
 * Métadonnées des documents du compte (jamais le contenu, ni lien de
 * téléchargement, ni nom de fichier) et exports / transmissions associés.
 * Pagination classique (GEN-004).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { parseListParams } from '@/services/admin/list-params';
import {
  DOCUMENT_PAGE_SIZE,
  DOCUMENT_SORTS,
  loadAccountDocuments,
  loadAccountExports,
} from '@/services/admin/account-documents.service';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const accountId = Number((await params).id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return NextResponse.json({ code: 'INVALID_ID', message: 'Identifiant de compte invalide.' }, { status: 400 });
  }
  try {
    const p = parseListParams(request.nextUrl.searchParams, DOCUMENT_SORTS, { sort: 'uploaded', dir: 'desc' }, DOCUMENT_PAGE_SIZE);
    const [documents, exportsAndTransmissions] = await Promise.all([
      loadAccountDocuments(accountId, { page: p.page, sort: p.sort, dir: p.dir }),
      loadAccountExports(accountId),
    ]);
    return NextResponse.json({ documents, exports: exportsAndTransmissions, sort: p.sort, dir: p.dir });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/accounts/documents] GET :', error);
    return NextResponse.json({ code: 'LOAD_FAILED', message: 'Chargement des documents impossible.' }, { status: 500 });
  }
}
