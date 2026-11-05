import { NextRequest, NextResponse } from 'next/server';
import { authenticateShareImportGrant } from '@/services/mobile/share-import/grants';
import { findImportedOperation, runShareImport } from '@/services/mobile/share-import/import-operation';
import {
  SHARE_IMPORT_MAX_BYTES, outcomeHttpStatus, shareImportMessage, type ShareImportOutcome,
} from '@/lib/mobile/share-import-policy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/mobile/share-import/upload — lot 110A (partage natif iOS / Android).
 *
 * Appelée par la partie NATIVE (URLSession d'arrière-plan de l'extension de
 * partage iOS, WorkManager Android), application principale fermée. Aucun
 * cookie : `Authorization: Bearer <jeton d'import>` (jamais une session).
 *
 *   Corps : le fichier, brut (25 Mo au plus).
 *   En-têtes : Content-Type (type du fichier), Content-Length,
 *     X-Verebona-Operation-Id (identifiant d'import unique tiré PAR
 *     L'APPAREIL, identique à chaque reprise), X-Verebona-File-Name (nom,
 *     encodé en pourcentage UTF-8), X-Verebona-Sha256 (empreinte, contrôlée).
 *
 * Même opération d'import que le dépôt de l'application
 * (`services/mobile/share-import/import-operation.ts`). Réponse JSON
 * { outcome: imported | refused | auth | retry, code, message, fileId? } :
 * « imported » = document ENREGISTRÉ (seul cas où le natif affiche un succès).
 * Exemptée du contrôle d'origine (CSRF) et du jeton de session du
 * middleware : aucun cookie n'y est lu.
 */
function reply(outcome: ShareImportOutcome, code: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ outcome, code, message: shareImportMessage(code), ...extra }, { status: outcomeHttpStatus(outcome), headers: { 'Cache-Control': 'no-store' } });
}

/** Corps borné : jamais plus de `max` octets lus en mémoire. */
async function readBounded(request: NextRequest, max: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

function decodeName(raw: string | null): string {
  if (!raw) return '';
  try { return decodeURIComponent(raw).replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 200); } catch { return ''; }
}

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const operationId = request.headers.get('x-verebona-operation-id') ?? '';
  try {
    const a = await authenticateShareImportGrant(token);
    if (!a.ok) {
      const outcome: ShareImportOutcome = a.code === 'FEATURE_OFF' ? 'retry'
        : a.code === 'ACCOUNT_ACCESS_REVOKED' || a.code === 'ACCOUNT_SUSPENDED' || a.code === 'ACCOUNT_PENDING_DELETION' ? 'refused' : 'auth';
      // Lot 111P : motif du refus du jeton, expurgé (jamais le jeton ni le nom du fichier).
      const client = (request.headers.get('x-verebona-share-client') ?? '').toUpperCase();
      console.info(JSON.stringify({ event: 'share_import.grant_rejected', code: a.code, outcome, client: client === 'IOS' || client === 'ANDROID' ? client : null }));
      return reply(outcome, a.code, { operationId });
    }
    // Intégration lot 110 (garde 85D) : compte en lecture seule refusé AVANT tout stockage
    // (les routes de dépôt appelées ensuite refusent aussi, au même titre que l'app).
    const { refuserSiLectureSeule } = await import('@/lib/write-access-guard');
    if (await refuserSiLectureSeule(a.grant.accountId)) return reply('refused', 'ACCOUNT_READ_ONLY', { operationId });
    const replay = await findImportedOperation(a.grant, operationId);
    if (replay) {
      await request.body?.cancel().catch(() => undefined);
      return NextResponse.json(replay.body, { status: replay.status, headers: { 'Cache-Control': 'no-store' } });
    }
    const declared = Number(request.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > SHARE_IMPORT_MAX_BYTES) return reply('refused', 'FILE_TOO_LARGE', { operationId });
    const body = await readBounded(request, SHARE_IMPORT_MAX_BYTES);
    if (!body) return reply('refused', 'FILE_TOO_LARGE', { operationId });
    if (Number.isFinite(declared) && declared !== body.byteLength) return reply('retry', 'INTEGRITY_MISMATCH', { operationId });

    const r = await runShareImport({
      grant: a.grant,
      operationId,
      filename: decodeName(request.headers.get('x-verebona-file-name')),
      mimeType: (request.headers.get('content-type') ?? '').split(';')[0].trim(),
      declaredSha256: request.headers.get('x-verebona-sha256'),
      body,
    });
    return NextResponse.json(r.body, { status: r.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const msg = (e as Error)?.message ?? '';
    console.error(JSON.stringify({ event: 'share_import.error', detail: msg.slice(0, 160) }));
    return reply('retry', msg === 'SESSION_UNAVAILABLE' ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR', { operationId });
  }
}
