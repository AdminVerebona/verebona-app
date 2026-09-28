/**
 * Conventions communes des routes de l'assistant — CDC §27 (préambule),
 * §27.11, §31.10.
 *
 * Toutes les routes `/api/verebona/**` :
 *   · valident leurs entrées (corps, paramètres d'URL, chaîne de requête)
 *     avec un schéma zod — une entrée invalide rend `VALIDATION_FAILED` (400),
 *     code fonctionnel stable du §27.11, jamais un message technique ;
 *   · journalisent un `requestId` — repris de l'en-tête `x-request-id` s'il
 *     est bien formé, sinon généré — et le renvoient dans le même en-tête ;
 *   · limitent le débit de toutes les routes qui écrivent (limiteur dédié de
 *     l'assistant, `rate-limit.ts`).
 */
import { randomUUID } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { ZodType } from 'zod';
import { checkAssistantMutationRateLimit, type MutationBucket } from './rate-limit';
import { assistantErrorMessage } from './error-messages';

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;

/** Identifiant de la demande HTTP : en-tête `x-request-id` valide, sinon nouveau. */
export function httpRequestId(req: Pick<NextRequest, 'headers'>): string {
  const h = req.headers.get('x-request-id');
  return h && REQUEST_ID.test(h) ? h : randomUUID();
}

/** Pose l'en-tête `x-request-id` sur une réponse (§27 : requestId journalisé). */
export function withRequestId<T extends Response>(res: T, requestId: string): T {
  try { res.headers.set('x-request-id', requestId); } catch { /* en-têtes figés : sans effet */ }
  return res;
}

/** Réponse `VALIDATION_FAILED` (§27.11), avec le motif historique éventuel. */
export function validationFailed(requestId: string, reason?: string, status = 400): NextResponse {
  return withRequestId(NextResponse.json(
    {
      requestId,
      status: 'error',
      error: {
        code: 'VALIDATION_FAILED',
        message: 'La demande est incomplète ou mal formée.',
        recoverable: false,
        ...(reason ? { reason } : {}),
      },
    },
    { status },
  ), requestId);
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/**
 * Valide une entrée avec un schéma zod. Le motif retenu est le `message` du
 * premier problème (les schémas y placent un code stable : EMPTY_MESSAGE…).
 */
export function parseWith<T>(schema: ZodType<T>, value: unknown, requestId: string): Parsed<T> {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  const reason = first && /^[A-Z_]+$/.test(first.message) ? first.message : undefined;
  console.warn(`[verebona][${requestId}] entrée refusée (VALIDATION_FAILED)${reason ? ` : ${reason}` : ''}`);
  return { ok: false, response: validationFailed(requestId, reason) };
}

/** Corps JSON (absent ou illisible : objet vide, que le schéma jugera). */
export async function readJson(req: Pick<NextRequest, 'json'>): Promise<unknown> {
  return req.json().catch(() => ({}));
}

/** Paramètres de la chaîne de requête, sous forme d'objet simple. */
export function queryObject(req: Pick<NextRequest, 'url'>): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

/**
 * Limiteur des routes qui écrivent (§31.10). Rend une réponse 429
 * `RATE_LIMITED` à renvoyer telle quelle, ou `null` si la demande passe.
 */
export function mutationRateLimited(
  userId: number,
  accountId: number,
  bucket: MutationBucket,
  requestId: string,
): NextResponse | null {
  const d = checkAssistantMutationRateLimit(userId, accountId, bucket);
  if (d.allowed) return null;
  return withRequestId(NextResponse.json(
    { requestId, status: 'error', error: { code: 'RATE_LIMITED', message: assistantErrorMessage('RATE_LIMITED'), recoverable: true } },
    { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil(d.retryAfterMs / 1000))) } },
  ), requestId);
}
