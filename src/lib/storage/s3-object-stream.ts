/**
 * Relais en flux d'un objet S3 vers une réponse HTTP (APP-PERF-13).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLUS DE MISE EN MÉMOIRE DE L'OBJET COMPLET
 *
 * Le proxy accumulait tous les morceaux puis `Buffer.concat` avant de
 * répondre : premier octet après le dernier octet S3, et un pic mémoire par
 * fichier ouvert. Désormais :
 *   · le corps S3 est relayé morceau par morceau, à la demande du client
 *     (flux « pull » : aucune lecture en avance → contre-pression) ;
 *   · client parti (`request.signal`) ou flux annulé → corps S3 détruit,
 *     connexion amont libérée ;
 *   · erreur amont en cours de flux → flux en erreur : la réponse est
 *     tronquée par rapport au `Content-Length` annoncé, donc jamais prise
 *     pour complète ; aucune relance automatique d'un flux déjà entamé ;
 *   · lectures partielles : `Range` (une seule plage) relayé à S3 → 206 +
 *     `Content-Range` ; plage non satisfiable → 416 ; plage illisible ou
 *     multiple → ignorée (200 complet, RFC 9110 §14.2) ;
 *   · revalidation : `If-None-Match` relayé → 304.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Readable } from 'node:stream';
import { classifyS3Error, type S3ErrorInfo } from '@/lib/s3-config';

export type RangeRequest = { kind: 'none' } | { kind: 'range'; header: string; start: number | null; end: number | null };

/**
 * Analyse un en-tête `Range`. Une seule plage `bytes=a-b`, `bytes=a-` ou
 * `bytes=-n` est relayée ; tout le reste est ignoré (réponse complète).
 */
export function parseRangeHeader(header: string | null | undefined): RangeRequest {
  if (!header) return { kind: 'none' };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return { kind: 'none' };
  const [, a, b] = m;
  if (a === '' && b === '') return { kind: 'none' };
  const start = a === '' ? null : Number(a);
  const end = b === '' ? null : Number(b);
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))) return { kind: 'none' };
  if (start !== null && end !== null && end < start) return { kind: 'none' };
  if (start === null && end === 0) return { kind: 'none' };
  return { kind: 'range', header: `bytes=${a}-${b}`, start, end };
}

/** Sous-ensemble de la sortie `GetObjectCommand` utilisé ici. */
export interface S3GetOutput {
  Body?: unknown;
  ContentLength?: number;
  ContentRange?: string;
  ContentType?: string;
  ETag?: string;
  LastModified?: Date;
  $metadata?: { httpStatusCode?: number };
}

export interface S3GetInput {
  Bucket: string;
  Key: string;
  Range?: string;
  IfNoneMatch?: string;
}

export type S3GetFn = (input: S3GetInput, signal: AbortSignal) => Promise<S3GetOutput>;

export interface StreamObjectOptions {
  bucket: string;
  key: string;
  request: { headers: Headers; signal?: AbortSignal };
  get: S3GetFn;
  contentType: string;
  /** `inline` par défaut. */
  disposition?: string;
  /** Taille connue en base, pour l'en-tête d'un 416. */
  knownSize?: number | null;
  /** Politique de cache (privée). */
  cacheControl?: string;
  /** Diagnostic (route). */
  where?: string;
  /** Délai max avant les en-têtes S3 (ms). */
  headersTimeoutMs?: number;
}

/** Convertit un corps SDK (flux Node, flux web) en flux web « pull ». */
export function toPullStream(body: unknown, onDone?: () => void): ReadableStream<Uint8Array> {
  if (body && typeof (body as ReadableStream).getReader === 'function' && !(Symbol.asyncIterator in (body as object))) {
    return body as ReadableStream<Uint8Array>;
  }
  const node = body as Readable & AsyncIterable<Uint8Array | string>;
  const it = (node as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(typeof value === 'string' ? new TextEncoder().encode(value) : value);
      } catch (e) {
        finish();
        controller.error(e);
      }
    },
    cancel() {
      finish();
      // Libère la connexion amont (client parti, navigation, Range suivante).
      try { (node as Readable).destroy?.(); } catch { /* déjà fermé */ }
      void it.return?.();
    },
  }, { highWaterMark: 0 });
}

function jsonError(status: number, code: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...extra },
  });
}

/** Statut HTTP renvoyé pour une erreur S3 classée. */
export function statusForS3Error(info: S3ErrorInfo): { status: number; code: string } {
  switch (info.kind) {
    case 'NOT_FOUND': return { status: 404, code: 'FILE_NOT_FOUND' };
    case 'TIMEOUT': return { status: 504, code: 'STORAGE_TIMEOUT' };
    case 'CONFIG': return { status: 500, code: 'S3_CONFIG_INVALID' };
    case 'ACCESS_DENIED': return { status: 502, code: 'STORAGE_ACCESS_DENIED' };
    case 'UNREACHABLE': return { status: 502, code: 'STORAGE_UNREACHABLE' };
    default: return { status: 502, code: 'STORAGE_ERROR' };
  }
}

/** Relaie l'objet ; ne lève jamais (erreurs traduites en réponses typées). */
export async function streamS3Object(opts: StreamObjectOptions): Promise<Response> {
  const range = parseRangeHeader(opts.request.headers.get('range'));
  const ifNoneMatch = opts.request.headers.get('if-none-match') || undefined;
  const cacheControl = opts.cacheControl ?? 'private, no-cache';

  // Annulation amont : client parti, ou en-têtes S3 trop lents.
  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  opts.request.signal?.addEventListener('abort', onClientAbort, { once: true });
  const detach = () => opts.request.signal?.removeEventListener('abort', onClientAbort);
  const timer = opts.headersTimeoutMs
    ? setTimeout(() => controller.abort(), opts.headersTimeoutMs)
    : null;

  let out: S3GetOutput;
  try {
    out = await opts.get({
      Bucket: opts.bucket,
      Key: opts.key,
      ...(range.kind === 'range' ? { Range: range.header } : {}),
      ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
    }, controller.signal);
  } catch (error) {
    detach();
    if (timer) clearTimeout(timer);
    const info = classifyS3Error(error);
    if (info.kind === 'NOT_MODIFIED') {
      return new Response(null, { status: 304, headers: { 'Cache-Control': cacheControl, ...(ifNoneMatch ? { ETag: ifNoneMatch } : {}) } });
    }
    if (info.kind === 'INVALID_RANGE') {
      return jsonError(416, 'RANGE_NOT_SATISFIABLE', opts.knownSize != null ? { 'Content-Range': `bytes */${opts.knownSize}` } : {});
    }
    if (opts.request.signal?.aborted) {
      // Client parti : personne ne lira la réponse.
      return new Response(null, { status: 499 });
    }
    // Annulé sans départ du client : délai d'en-têtes dépassé.
    const timedOut = controller.signal.aborted || info.kind === 'ABORTED';
    const mapped = timedOut ? { status: 504, code: 'STORAGE_TIMEOUT' } : statusForS3Error(info);
    console.error(`[s3] ${opts.where ?? 'stream'} : ${timedOut ? 'TIMEOUT' : info.kind} (${info.name}${info.httpStatus ? `, HTTP ${info.httpStatus}` : ''})`);
    return jsonError(mapped.status, mapped.code);
  }
  if (timer) clearTimeout(timer);

  if (!out.Body) {
    detach();
    return jsonError(502, 'EMPTY_BODY');
  }

  const partial = out.$metadata?.httpStatusCode === 206 || (range.kind === 'range' && !!out.ContentRange);
  const headers: Record<string, string> = {
    'Content-Type': opts.contentType,
    'Content-Disposition': opts.disposition ?? 'inline',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'X-Frame-Options': 'SAMEORIGIN',
  };
  if (typeof out.ContentLength === 'number') headers['Content-Length'] = String(out.ContentLength);
  if (out.ETag) headers.ETag = out.ETag;
  if (out.LastModified) headers['Last-Modified'] = out.LastModified.toUTCString();
  if (partial && out.ContentRange) headers['Content-Range'] = out.ContentRange;

  const stream = toPullStream(out.Body, detach);
  return new Response(stream, { status: partial ? 206 : 200, headers });
}
