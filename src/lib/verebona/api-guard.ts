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
 *   · limitent le débit de toutes les routes — écritures (`mutationRateLimited`)
 *     comme lectures (`readRateLimited`) — avec le limiteur dédié de
 *     l'assistant (`rate-limit.ts`).
 */
import { randomUUID } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { ZodType } from 'zod';
import { checkAssistantMutationRateLimit, checkAssistantReadRateLimit, type MutationBucket, type RateDecision } from './rate-limit';
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

/**
 * Corps JSON borné : refuse AVANT analyse un corps de plus de `maxBytes`
 * (en-tête `Content-Length` d'abord, puis lecture du flux interrompue dès le
 * dépassement — un corps sans longueur annoncée n'est jamais lu en entier).
 * `{ tooLarge: true }` → répondre 413 ; JSON illisible → `{ value: {} }`.
 */
export async function readBoundedJson(
  req: Pick<Request, 'headers' | 'body'>,
  maxBytes: number,
): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
  const annonce = Number(req.headers.get('content-length'));
  if (Number.isFinite(annonce) && annonce > maxBytes) return { tooLarge: true };
  if (!req.body) return { tooLarge: false, value: {} };
  const reader = req.body.getReader();
  const morceaux: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    morceaux.push(value);
  }
  const octets = new Uint8Array(total);
  let pos = 0;
  for (const m of morceaux) { octets.set(m, pos); pos += m.byteLength; }
  try {
    return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(octets)) };
  } catch {
    return { tooLarge: false, value: {} };
  }
}

/** Paramètres de la chaîne de requête, sous forme d'objet simple. */
export function queryObject(req: Pick<NextRequest, 'url'>): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

/**
 * Limiteur des routes qui écrivent (§31.10). Rend une réponse 429
 * `RATE_LIMITED` à renvoyer telle quelle, ou `null` si la demande passe.
 * Limiteur partagé entre instances (D-J2), par utilisateur, compte et IP.
 */
export async function mutationRateLimited(
  userId: number,
  accountId: number,
  bucket: MutationBucket,
  requestId: string,
  req?: Pick<NextRequest, 'headers'>,
): Promise<NextResponse | null> {
  return rateLimitedResponse(await checkAssistantMutationRateLimit(userId, accountId, bucket, clientIp(req)), requestId);
}

/**
 * Limiteur des routes de lecture (§27) : explication, sources, historique,
 * état d'une demande, suggestions. Même réponse 429 que les écritures.
 */
export async function readRateLimited(
  userId: number, accountId: number, requestId: string, req?: Pick<NextRequest, 'headers'>,
): Promise<NextResponse | null> {
  return rateLimitedResponse(await checkAssistantReadRateLimit(userId, accountId, clientIp(req)), requestId);
}

/**
 * Nombre de proxys de confiance devant l'application (`TRUSTED_PROXY_HOPS`,
 * défaut 1 : le routeur Scalingo, qui AJOUTE l'adresse du client en fin de
 * `X-Forwarded-For` — à vérifier sur l'hébergement réel). 0 : aucun proxy,
 * l'en-tête n'est pas fiable et n'est pas lu.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

/**
 * Adresse du client pour le limiteur (D-J2) : l'entrée de `X-Forwarded-For`
 * posée par le proxy de confiance — la N-ième en partant de la FIN (N =
 * `TRUSTED_PROXY_HOPS`). Les entrées de tête sont fournies par le client,
 * donc falsifiables : jamais retenues. `null` si rien de fiable.
 */
export function clientIp(req?: Pick<NextRequest, 'headers'>, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!req?.headers) return null;
  const hops = trustedProxyHops(env);
  if (hops === 0) return null;
  const chaine = (req.headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const ip = chaine.length ? chaine[Math.max(0, chaine.length - hops)] : null;
  return ip && /^[0-9a-fA-F:.]{2,64}$/.test(ip) ? ip : null;
}

function rateLimitedResponse(d: RateDecision, requestId: string): NextResponse | null {
  if (d.allowed) return null;
  return withRequestId(NextResponse.json(
    { requestId, status: 'error', error: { code: 'RATE_LIMITED', message: assistantErrorMessage('RATE_LIMITED'), recoverable: true } },
    { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil(d.retryAfterMs / 1000))) } },
  ), requestId);
}
