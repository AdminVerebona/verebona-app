/**
 * Carte #744, travaux D — écriture : outils COMMUNS des routes d'écriture de
 * la page d'un événement de référence (`/api/evenements-reference/:id/...`).
 * Dossier privé (`_shared`) : ce n'est pas une route.
 *
 * Chaque route d'écriture :
 *   1. ouvre son contexte (`openReferenceEventRoute`) : session, compte ACTIF
 *      de la session, identifiant de l'adresse ;
 *   2. appelle ELLE-MÊME la garde `refuserSiLectureSeule` (audit
 *      `l85d-garde-ecriture-routes` : la garde est dans le fichier de route) ;
 *   3. lit la demande (forme seulement) et appelle UNE commande de la façade
 *      `operation-write.facade.ts` — qui recontrôle l'adhésion, la lecture
 *      seule, le compte de chaque identifiant et la version attendue ;
 *   4. rend la réponse par `referenceEventWriteResponse` : phrase pour
 *      l'utilisateur, jamais un code brut à afficher.
 * Aucune règle métier ici.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { referenceEventIdFromParam } from '@/lib/reference-events/reference-event-page';
import {
  REFERENCE_EVENT_INVALID_REQUEST, referenceEventWriteOutcome,
  type ReferenceEventGesture, type ReferenceEventWriteResponse,
} from '@/lib/reference-events/reference-event-write';
import type { OperationWriteResult } from '@/services/business-operations/graph/model';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

export type ReferenceEventRouteContext = { params: Promise<{ id: string }> };

export interface ReferenceEventRouteScope {
  accountId: number;
  userId: number;
  operationId: number;
  /** Contexte de la façade : geste de l'utilisateur depuis un écran. */
  ctx: OperationWriteContext;
}

/** Session, compte actif et identifiant de l'adresse ; sinon la réponse d'erreur à rendre. */
export async function openReferenceEventRoute(req: NextRequest, context: ReferenceEventRouteContext): Promise<ReferenceEventRouteScope | NextResponse> {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId || !session.userId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
  const { id } = await context.params;
  const operationId = referenceEventIdFromParam(id);
  if (operationId === null) return apiError(400, 'INVALID_INPUT', REFERENCE_EVENT_INVALID_REQUEST);
  const accountId = Number(session.currentAccountId);
  const userId = Number(session.userId);
  return { accountId, userId, operationId, ctx: { accountId, actor: { kind: 'USER', userId, channel: 'UI' } } };
}

/** Corps JSON de la demande ; null : illisible. */
export async function readJsonBody(req: NextRequest): Promise<unknown | null> {
  try {
    return (await req.json()) as unknown;
  } catch {
    return null;
  }
}

/** Demande illisible ou incomplète : 400, phrase utilisateur. */
export function invalidReferenceEventRequest(): NextResponse {
  return apiError(400, 'INVALID_INPUT', REFERENCE_EVENT_INVALID_REQUEST);
}

/**
 * Réponse d'une commande de la façade. Réussite : `{ ok, changed, message,
 * version }`. Refus : corps d'erreur standard (`message` = phrase utilisateur) ;
 * le code de la façade n'y figure que dans `details.reason` (diagnostic et
 * tests — jamais affiché), avec la version courante en cas de conflit.
 */
export function referenceEventWriteResponse(gesture: ReferenceEventGesture, result: OperationWriteResult<unknown>): NextResponse {
  const o = referenceEventWriteOutcome(gesture, result);
  const data = (result.data && typeof result.data === 'object' ? result.data : {}) as { version?: unknown; currentVersion?: unknown; newOperationId?: unknown };
  if (o.ok) {
    const body: ReferenceEventWriteResponse = {
      ok: true, changed: o.changed, message: o.message, version: typeof data.version === 'number' ? data.version : null,
      // Scission : l'événement de référence créé, pour que la page propose de l'ouvrir.
      ...(typeof data.newOperationId === 'number' ? { newOperationId: data.newOperationId } : {}),
    };
    return NextResponse.json(body);
  }
  return apiError(o.http, o.apiCode ?? 'INTERNAL_ERROR', o.message, {
    reason: result.code, ...(typeof data.currentVersion === 'number' ? { currentVersion: data.currentVersion } : {}),
  });
}

/** Panne imprévue d'une route (la façade ne lève pas : import, lecture) : 500, phrase utilisateur. */
export function referenceEventRouteFailure(route: string, err: unknown): NextResponse {
  console.error(`[api/evenements-reference] ${route}`, (err as Error)?.message ?? err);
  return referenceEventWriteResponse('correct', { status: 'FAILED', code: 'TECHNICAL_FAILURE', changed: false, replayed: false });
}
