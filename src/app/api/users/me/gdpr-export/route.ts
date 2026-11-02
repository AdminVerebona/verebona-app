/**
 * Export RGPD « Mes données » — CDC Back-Office V1 GDP-020 à GDP-022.
 *
 * GET  /api/users/me/gdpr-export — état du dernier export de l'utilisateur.
 * POST /api/users/me/gdpr-export — demande un export.
 *
 * Lot 103C (ticket P1 « Fiabilisation de l'export ») : le POST ENREGISTRE la
 * demande (ligne en file, atomique, idempotente) et rend la main
 * (202 + état) ; la génération est faite par le worker durable des exports
 * (`gdpr-export.job.ts`), reprise après un redémarrage ou un déploiement.
 * La requête n'héberge plus le traitement : un arrêt du processus pendant la
 * génération ne peut plus produire une réponse d'erreur non JSON (page du
 * routeur) ni une demande bloquée. GDP-021 (« sinon traitement asynchrone
 * avec notification ») : l'utilisateur est notifié quand l'archive est prête.
 *
 * Chaque réponse porte un identifiant de corrélation (`requestId` dans le
 * corps, en-tête `x-request-id`) ; les erreurs portent un code stable.
 * En-tête facultatif `Idempotency-Key` : un POST rejoué (perte réseau après
 * écriture, double envoi) renvoie la même demande.
 *
 * Distinct des exports fonctionnels des biens (`/api/assets/[id]/exports`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { newRequestId } from '@/lib/auth/session-errors';
import {
  getLatestExport,
  requestGdprExport,
  type GdprExportState,
} from '@/services/gdpr/gdpr-export.service';
import { GDPR_EXPORT_API_CODES, parseClientRequestKey } from '@/services/gdpr/export-state';

const DOWNLOAD_PATH = '/api/users/me/gdpr-export/download';

/**
 * Lot 102C : une URL par partie (`?part=N`) ; `downloadUrl` reste la
 * partie 1 (compatibilité). Accessible dans tous les états restreints.
 */
function body(exp: GdprExportState | null, requestId: string) {
  const ready = exp?.status === 'ready';
  return {
    export: exp,
    downloadUrl: ready ? DOWNLOAD_PATH : null,
    parts: ready ? exp!.parts.map((p) => ({ ...p, downloadUrl: p.number === 1 ? DOWNLOAD_PATH : `${DOWNLOAD_PATH}?part=${p.number}` })) : [],
    view: exp?.view ?? null,
    requestId,
  };
}

function json(data: unknown, status: number, requestId: string): NextResponse {
  const res = NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
  res.headers.set('x-request-id', requestId);
  return res;
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id')?.slice(0, 100) || newRequestId();
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error, requestId);
  }
  try {
    const exp = await getLatestExport(userId);
    if (!exp) {
      const { gdprExportView } = await import('@/services/gdpr/export-state');
      return json({ ...body(null, requestId), view: gdprExportView(null) }, 200, requestId);
    }
    return json(body(exp, requestId), 200, requestId);
  } catch (error) {
    console.error(`[users/me/gdpr-export][${requestId}] lecture :`, (error as Error)?.message ?? error);
    return json({
      error: GDPR_EXPORT_API_CODES.readFailed, code: GDPR_EXPORT_API_CODES.readFailed,
      message: 'Impossible de lire l’état de votre export. Réessayez.', requestId,
    }, 500, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error, requestId);
  }

  const clientKey = parseClientRequestKey(request.headers.get('idempotency-key'));
  if (clientKey === 'invalid') {
    return json({
      error: GDPR_EXPORT_API_CODES.invalidKey, code: GDPR_EXPORT_API_CODES.invalidKey,
      message: 'Demande invalide. Rechargez la page puis réessayez.', requestId,
    }, 400, requestId);
  }

  try {
    const { export: exp, created } = await requestGdprExport(userId, { clientKey });
    console.info(`[users/me/gdpr-export][${requestId}] demande ${created ? 'enregistrée' : 'déjà en cours / rejouée'} : export #${exp.id}`);
    // 202 : demande enregistrée (ou déjà en cours), génération par le worker.
    return json({ ...body(exp, requestId), created }, created || exp.status === 'pending' || exp.status === 'generating' ? 202 : 200, requestId);
  } catch (error) {
    console.error(`[users/me/gdpr-export][${requestId}] demande en échec :`, (error as Error)?.message ?? error);
    return json({
      error: GDPR_EXPORT_API_CODES.requestFailed, code: GDPR_EXPORT_API_CODES.requestFailed,
      message: 'Votre demande d’export n’a pas pu être enregistrée. Réessayez dans un instant.', requestId,
    }, 500, requestId);
  }
}
