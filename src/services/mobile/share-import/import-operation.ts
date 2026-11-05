/**
 * Import d'un fichier partagé — lot 110A. UNE SEULE OPÉRATION D'IMPORT.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Le fichier reçu (corps de la requête du natif, jeton d'import vérifié) suit
 * EXACTEMENT le circuit du dépôt de l'application, dans le même processus :
 *
 *   1. `POST /api/files/presign` (même route, même code) : nom, type, taille,
 *      empreinte, quotas documentaire / stockage / fichiers, droits du
 *      compte, ligne PENDING et idempotence par `operationId` ;
 *   2. dépôt de l'objet sur l'URL signée rendue par cette route (comme le
 *      navigateur), depuis le serveur ;
 *   3. `POST /api/files/confirm` (même route) : objet vérifié, quota sous
 *      verrou, passage en COMPLETED, événements métier, file T1, miniatures.
 *
 * L'identité est passée aux deux routes par `delegateDepotSession` (aucun
 * en-tête ni cookie ne peut la reproduire). Une reprise (même
 * `operationId`) ne crée jamais de second document : la ligne existante est
 * reprise, ou le document déjà enregistré est rendu (`replay`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { pgClient } from '@/db';
import { delegateDepotSession } from '@/lib/documents/depot-session';
import { estCleOperation } from '@/lib/upload-idempotence';
import {
  classifyDepotStatus, isShareImportMime, outcomeHttpStatus, shareImportMessage,
  type ShareImportOutcome, type ShareImportResponseBody,
} from '@/lib/mobile/share-import-policy';
import type { AuthenticatedGrant } from './grants';

/** Dépôt de l'objet sur l'URL signée (injectable pour les tests). */
export type StorageWriter = (uploadUrl: string, body: Uint8Array, mimeType: string) => Promise<void>;

const defaultWriter: StorageWriter = async (uploadUrl, body, mimeType) => {
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: body as unknown as BodyInit });
  if (!res.ok) throw new Error(`stockage : HTTP ${res.status}`);
};
let writer: StorageWriter = defaultWriter;
/** Tests uniquement. */
export function __setShareImportStorageWriterForTests(w: StorageWriter | null): void { writer = w ?? defaultWriter; }

export interface ShareImportResult { status: number; body: ShareImportResponseBody }

function result(outcome: ShareImportOutcome, code: string, extra: Partial<ShareImportResponseBody> = {}, fallbackMessage?: string | null): ShareImportResult {
  return {
    status: outcomeHttpStatus(outcome, extra.replay === true),
    body: { outcome, code, message: outcome === 'imported' ? 'Document ajouté à Verebona.' : shareImportMessage(code, fallbackMessage), ...extra },
  };
}

function log(event: string, grant: AuthenticatedGrant, d: Record<string, unknown>): void {
  // Jamais de jeton, de nom de fichier ni de contenu.
  console.info(JSON.stringify({ event: `share_import.${event}`, userId: grant.userId, accountId: grant.accountId, platform: grant.platform, ...d }));
}

/**
 * Opération déjà enregistrée pour cet utilisateur ? (avant même de lire le
 * corps : une reprise après accusé perdu répond tout de suite).
 */
export async function findImportedOperation(grant: AuthenticatedGrant, operationId: string): Promise<ShareImportResult | null> {
  if (!estCleOperation(operationId)) return null;
  const [r] = await pgClient`SELECT id, account_id, upload_status, deleted_at FROM asset_files
                             WHERE user_id = ${grant.userId} AND upload_operation_id = ${operationId} LIMIT 1`;
  if (!r) return null;
  if (Number(r.account_id) !== grant.accountId) return result('refused', 'IDEMPOTENCY_KEY_REUSED', { operationId });
  if (r.upload_status === 'COMPLETED' && !r.deleted_at) {
    return result('imported', 'IMPORTED', { operationId, fileId: Number(r.id), replay: true });
  }
  return null;
}

const jsonRequest = (path: string, body: unknown) => new NextRequest(`http://verebona.internal${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return await res.json() as Record<string, unknown>; } catch { return {}; }
}

/** Import d'un fichier reçu (corps déjà lu et borné par la route). */
export async function runShareImport(input: {
  grant: AuthenticatedGrant;
  operationId: string;
  filename: string;
  mimeType: string;
  declaredSha256: string | null;
  body: Uint8Array;
}): Promise<ShareImportResult> {
  const { grant, operationId, filename, body } = input;
  const mimeType = input.mimeType.toLowerCase();
  if (!estCleOperation(operationId)) return result('refused', 'INVALID_OPERATION_ID');
  if (!filename.trim()) return result('refused', 'INVALID_FILENAME', { operationId });
  if (!isShareImportMime(mimeType)) return result('refused', 'INVALID_MIME_TYPE', { operationId });
  if (body.byteLength === 0) return result('refused', 'EMPTY_FILE', { operationId });

  const sha256Hash = createHash('sha256').update(body).digest('hex');
  if (input.declaredSha256 && input.declaredSha256.toLowerCase() !== sha256Hash) {
    log('integrity_mismatch', grant, { operationId });
    return result('refused', 'INTEGRITY_MISMATCH', { operationId });
  }
  const session = { userId: grant.userId, currentAccountId: grant.accountId };

  // 1. Préparation : MÊME route que le dépôt de l'application.
  const { POST: presign } = await import('@/app/api/files/presign/route');
  const p = await presign(delegateDepotSession(jsonRequest('/api/files/presign', {
    filename, mimeType, size: body.byteLength, sha256Hash, operationId, assetId: null,
  }), session));
  const pb = await readJson(p);
  if (p.status < 200 || p.status >= 300) {
    const code = String(pb.code ?? pb.error ?? 'INTERNAL_ERROR');
    const outcome = classifyDepotStatus(p.status, code);
    log('presign_refused', grant, { operationId, status: p.status, code });
    return result(outcome === 'imported' ? 'retry' : outcome, code, { operationId }, typeof pb.message === 'string' ? pb.message : null);
  }
  const fileId = Number(pb.fileId);
  if (pb.uploadStatus === 'COMPLETED') return result('imported', 'IMPORTED', { operationId, fileId, replay: true });

  // 2. Dépôt de l'objet (URL signée rendue par la route, comme le navigateur).
  try {
    await writer(String(pb.uploadUrl), body, mimeType);
  } catch (e) {
    log('storage_failed', grant, { operationId, fileId, detail: (e as Error).message?.slice(0, 120) });
    return result('retry', 'STORAGE_UNAVAILABLE', { operationId });
  }

  // 3. Confirmation : MÊME route (contrôles, COMPLETED, T1, miniatures).
  const { POST: confirm } = await import('@/app/api/files/confirm/route');
  const c = await confirm(delegateDepotSession(jsonRequest('/api/files/confirm', { fileId, operationId }), session));
  const cb = await readJson(c);
  if (c.status < 200 || c.status >= 300) {
    const code = String(cb.code ?? 'INTERNAL_ERROR');
    const outcome = classifyDepotStatus(c.status, code);
    log('confirm_refused', grant, { operationId, fileId, status: c.status, code });
    return result(outcome === 'imported' ? 'retry' : outcome, code, { operationId }, typeof cb.error === 'string' ? cb.error : null);
  }
  log('imported', grant, { operationId, fileId, replay: cb.replay === true });
  return result('imported', 'IMPORTED', { operationId, fileId, ...(cb.replay === true ? { replay: true } : {}) });
}
