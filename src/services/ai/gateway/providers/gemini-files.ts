/**
 * Préparation des pièces jointes Gemini — centralise la logique jusqu'ici
 * dispersée dans `upload-to-gemini.ts` et `gemini-client.ts`.
 *
 * Règle CDC §4.1.7 : les fichiers temporaires côté fournisseur sont supprimés
 * après usage, y compris en cas d'échec.
 */
import type { Part } from '@google/genai';
import type { AiAttachment } from '../types';
import { redact } from '../redaction';
import {
  TRANSFER_BODY_MAX_CHARS, TRANSFER_DETAILS_MAX,
  type AttachmentTransferFailure, type AttachmentTransferFailureKind, type AttachmentTransferStep,
} from '../diagnostics/taxonomy';

const FILES_API = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const FILES_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const INLINE_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
]);

/** Longueur maximale d'une valeur d'en-tête dérivée d'un nom (octets ASCII). */
const HEADER_VALUE_MAX = 512;

/**
 * Lot 61 — valeur d'en-tête HTTP sûre pour un nom fourni par l'utilisateur.
 *
 * Un en-tête n'accepte que des octets (ByteString ≤ 255) : un nom en forme
 * décomposée (NFD, macOS : « e » + U+0301) faisait échouer `fetch` AVANT tout
 * envoi (« Cannot convert argument to a ByteString … value of 768 »). Le nom
 * est normalisé NFC puis encodé en pourcent (RFC 3986, ASCII pur, réversible
 * par `decodeURIComponent`), borné sans couper une séquence `%XX`. Jamais
 * vide : `source`. Fonction pure — l'original n'est pas modifié.
 */
export function encodeHeaderValue(name: string | null | undefined): string {
  const nfc = (name ?? '').normalize('NFC').trim();
  if (!nfc) return 'source';
  let out = '';
  for (const ch of nfc) {
    const enc = encodeURIComponent(ch);
    if (out.length + enc.length > HEADER_VALUE_MAX) break;
    out += enc;
  }
  return out || 'source';
}

/**
 * Lot 61 — échec LOCAL et DÉTERMINISTE de construction d'une requête
 * fournisseur (en-tête invalide, paramètre impossible à encoder) : rien n'a
 * été envoyé, et réessayer avec un autre modèle donnerait la même erreur.
 * La passerelle le convertit en `REQUEST_BUILD_FAILED` non récupérable
 * (aucun repli). Les vraies erreurs récupérables (réseau, HTTP 5xx du
 * stockage ou de la Files API, délai d'activation) ne passent pas par ici.
 */
export class AttachmentRequestBuildError extends Error {
  readonly deterministic = true as const;
  readonly aiStage = 'request_build' as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AttachmentRequestBuildError';
  }
}

/** URI accessible nativement par Gemini (reprise de l'ancien `gemini-client`). */
function isProviderNativeUri(url: string): boolean {
  return url.startsWith('gs://') || url.startsWith('https://generativelanguage.googleapis.com/');
}

/** Types nécessitant l'upload via Files API (taille, durée). */
function needsFilesApi(mimeType: string): boolean {
  return mimeType === 'application/pdf' || mimeType.startsWith('video/') || mimeType.startsWith('audio/');
}

/**
 * Lot 52B — transport d'une pièce jointe, selon les MÊMES règles que
 * `appendParts` (observabilité BO, sans téléchargement) : `inline` (données
 * en ligne), `files_api` (upload temporaire), `provider_uri` (URI déjà chez
 * le fournisseur), `text_extracted` (bureautique extraite côté serveur).
 */
export function attachmentTransport(att: Pick<AiAttachment, 'url' | 'mimeType' | 'data'>): 'inline' | 'files_api' | 'provider_uri' | 'text_extracted' {
  if (att.data !== undefined) return 'inline';
  if (isProviderNativeUri(att.url)) return 'provider_uri';
  if (needsFilesApi(att.mimeType)) return 'files_api';
  if (INLINE_IMAGE_MIMES.has(att.mimeType)) return 'inline';
  return 'text_extracted';
}

/** Pièces jointes décrites sans contenu ni nom (au plus 20 détaillées). */
export function describeAttachments(atts: ReadonlyArray<Pick<AiAttachment, 'url' | 'mimeType' | 'data'>>): {
  count: number; items: Array<{ mimeType: string; transport: string }>;
} {
  return { count: atts.length, items: atts.slice(0, 20).map((a) => ({ mimeType: a.mimeType, transport: attachmentTransport(a) })) };
}

interface PreparedAttachments {
  parts: Part[];
  /** URIs à supprimer après l'appel. */
  temporaryFileUris: string[];
}

export async function prepareAttachmentParts(
  attachments: AiAttachment[],
  apiKey: string,
): Promise<PreparedAttachments> {
  const parts: Part[] = [];
  const temporaryFileUris: string[] = [];

  try {
    await appendParts(attachments, apiKey, parts, temporaryFileUris);
  } catch (e) {
    // Échec sur la pièce k : les fichiers 1..k-1 déjà envoyés à la Files API
    // doivent être supprimés ici — l'appelant ne reçoit jamais leurs URI.
    await cleanupTemporaryFiles(temporaryFileUris, apiKey);
    throw e;
  }

  return { parts, temporaryFileUris };
}

async function appendParts(
  attachments: AiAttachment[],
  apiKey: string,
  parts: Part[],
  temporaryFileUris: string[],
): Promise<void> {
  for (const att of attachments) {
    // Contenu déjà en mémoire (base64) : données en ligne, sans téléchargement.
    if (att.data !== undefined) {
      parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
      continue;
    }

    // URI déjà lisible par le fournisseur (GCS, fichier Files API existant) :
    // référencée telle quelle — ni téléchargement, ni fichier temporaire à
    // supprimer, il ne nous appartient pas.
    if (isProviderNativeUri(att.url)) {
      parts.push({ fileData: { fileUri: att.url, mimeType: att.mimeType } });
      continue;
    }

    if (needsFilesApi(att.mimeType)) {
      const uri = await uploadToFilesApi(att, apiKey);
      temporaryFileUris.push(uri);
      parts.push({ fileData: { fileUri: uri, mimeType: att.mimeType } });
      continue;
    }

    if (INLINE_IMAGE_MIMES.has(att.mimeType)) {
      // Lot 113R : lecture du stockage structurée (jamais l'URL signée dans un message).
      const source = endpointOf('GET', att.url, { hostOnly: true });
      const res = await envoyer(fetch, att.url, undefined, { step: 'source_download', endpoint: source, secret: apiKey });
      if (!res.ok) await echecHttp(res, { step: 'source_download', endpoint: source, secret: apiKey });
      const data = Buffer.from(await res.arrayBuffer()).toString('base64');
      parts.push({ inlineData: { mimeType: att.mimeType, data } });
      continue;
    }

    // Bureautique et texte : extraction côté serveur, jamais d'envoi binaire.
    const { extractTextContent } = await import('./content-extractors');
    const text = await extractTextContent(att);
    if (text) parts.push({ text });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 113R (carte #717) — ÉCHEC DE TRANSFERT STRUCTURÉ
//
// Avant : une réponse non OK de la Files API devenait un simple
// `Error('Upload Files API échoué : HTTP 403')` ; le statut et le corps de la
// réponse Google étaient perdus, l'erreur restait sans statut à l'étape
// `request_build` et devenait INTERNAL_ERROR (« défaut commun »).
// Désormais l'échec est une `AttachmentTransferError` : statut, code,
// message, raison, détails, identifiant de requête, corps BORNÉ, étape
// réelle et endpoint SANS SECRET. La classification lit ces champs, jamais
// le texte du message.
// ══════════════════════════════════════════════════════════════════════════

/** En-têtes de réponse conservés (aucun n'est sensible). */
const SAFE_RESPONSE_HEADERS = ['content-type', 'content-length', 'server', 'date', 'x-request-id', 'x-goog-request-id', 'x-guploader-uploadid', 'x-cloud-trace-context', 'retry-after', 'www-authenticate'];
/** En-têtes porteurs d'un identifiant de requête, par ordre de préférence. */
const REQUEST_ID_HEADERS = ['x-request-id', 'x-goog-request-id', 'x-guploader-uploadid', 'x-cloud-trace-context'];

/**
 * Retire tout secret d'un texte destiné à être conservé : clé fournie, clé
 * Google (`AIza…`), paramètre `key=`, signatures d'URL signées (S3, GCS),
 * jetons porteurs ; puis masquage commun de la passerelle. Pur.
 */
export function sanitizeTransferText(raw: string, secret?: string | null): string {
  let s = String(raw ?? '');
  if (secret) s = s.split(secret).join('***');
  s = s
    .replace(/([?&](?:key|access_token|token|sig|signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential|Expires|GoogleAccessId)=)[^&\s"'<>]+/gi, '$1***')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1***');
  return redact(s);
}

/** `POST host/chemin`, sans requête ni clé (pur). Une URL de stockage (signée) ne garde que l'hôte. */
export function endpointOf(method: string, url: string, opts: { hostOnly?: boolean } = {}): string {
  try {
    const u = new URL(url);
    return `${method} ${u.host}${opts.hostOnly ? ' (URL signée masquée)' : u.pathname}`;
  } catch {
    return `${method} (adresse illisible)`;
  }
}

const borne = (s: string, max: number): { text: string; truncated: boolean } =>
  s.length > max ? { text: `${s.slice(0, max)}…`, truncated: true } : { text: s, truncated: false };

function masquerProfond(v: unknown, secret: string | null, depth = 0): unknown {
  if (depth > 6) return '[profondeur bornée]';
  if (typeof v === 'string') return borne(sanitizeTransferText(v, secret), 500).text;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => masquerProfond(x, secret, depth + 1));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 30)
      .map(([k, x]) => [k, masquerProfond(x, secret, depth + 1)]));
  }
  return v;
}

/**
 * Lecture d'un corps d'erreur fournisseur (pur) : erreur JSON Google
 * (`{"error":{code,status,message,details}}`), corps texte (HTML d'un
 * frontal…) ou corps vide. Tout est masqué et borné.
 */
export function parseProviderErrorBody(text: string | null, contentType: string | null, secret: string | null = null): Pick<AttachmentTransferFailure,
  'providerStatus' | 'providerCode' | 'providerMessage' | 'providerReason' | 'providerDomain' | 'providerMetadata' | 'details' | 'body' | 'providerDetail'> & { requestIdFromBody: string | null } {
  const vide = {
    providerStatus: null, providerCode: null, providerMessage: null, providerReason: null, providerDomain: null,
    providerMetadata: null, details: [] as Array<Record<string, unknown>>, requestIdFromBody: null,
  };
  if (text === null) return { ...vide, body: { kind: 'unread', length: null, excerpt: null, truncated: false }, providerDetail: 'NONE' };
  const length = text.length;
  if (text.trim() === '') return { ...vide, body: { kind: 'empty', length, excerpt: null, truncated: false }, providerDetail: 'NONE' };
  const ex = borne(sanitizeTransferText(text, secret), TRANSFER_BODY_MAX_CHARS);
  let json: unknown = null;
  if (/json/i.test(contentType ?? '') || /^\s*[[{]/.test(text)) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  const err = json && typeof json === 'object' && !Array.isArray(json)
    ? (json as { error?: unknown }).error : null;
  if (!err || typeof err !== 'object') {
    return { ...vide, body: { kind: json ? 'json' : 'text', length, excerpt: ex.text, truncated: ex.truncated }, providerDetail: 'TEXT' };
  }
  const e = err as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
  const details = Array.isArray(e.details) ? e.details.filter((d) => d && typeof d === 'object') as Array<Record<string, unknown>> : [];
  const info = details.find((d) => String(d['@type'] ?? '').endsWith('google.rpc.ErrorInfo')) ?? null;
  const reqInfo = details.find((d) => String(d['@type'] ?? '').endsWith('google.rpc.RequestInfo')) ?? null;
  const metadata = info?.metadata && typeof info.metadata === 'object'
    ? Object.fromEntries(Object.entries(info.metadata as Record<string, unknown>).slice(0, 12)
      .map(([k, v]) => [k, borne(sanitizeTransferText(String(v), secret), 300).text]))
    : null;
  return {
    providerStatus: typeof e.status === 'string' ? e.status.slice(0, 64) : null,
    providerCode: typeof e.code === 'number' ? e.code : null,
    providerMessage: typeof e.message === 'string' && e.message.trim() ? borne(sanitizeTransferText(e.message, secret), 1_000).text : null,
    providerReason: info && typeof info.reason === 'string' ? info.reason.slice(0, 120) : null,
    providerDomain: info && typeof info.domain === 'string' ? info.domain.slice(0, 120) : null,
    providerMetadata: metadata,
    details: details.slice(0, TRANSFER_DETAILS_MAX).map((d) => masquerProfond(d, secret) as Record<string, unknown>),
    requestIdFromBody: reqInfo && typeof reqInfo.requestId === 'string' ? reqInfo.requestId.slice(0, 200) : null,
    body: { kind: 'json', length, excerpt: ex.text, truncated: ex.truncated },
    providerDetail: 'STRUCTURED',
  };
}

/**
 * Échec de TRANSFERT d'une pièce jointe (lot 113R) — jamais une erreur de
 * construction locale, jamais une génération échouée : le modèle n'a pas
 * été sollicité. Étape `attachment_transfer` (classification), détail
 * structuré et masqué dans `transfer`.
 */
export class AttachmentTransferError extends Error {
  readonly aiStage = 'attachment_transfer' as const;
  readonly httpStatus: number | null;
  readonly providerStatus: string | null;
  constructor(readonly transfer: AttachmentTransferFailure, readonly cause?: unknown) {
    super(transfer.message);
    this.name = 'AttachmentTransferError';
    this.httpStatus = transfer.httpStatus;
    this.providerStatus = transfer.providerStatus;
  }
}

/** Échec de transfert structuré (lot 113R) ? Reconnu par sa forme (erreur possiblement enveloppée). */
export function transferFailureOf(e: unknown): AttachmentTransferFailure | null {
  const t = (e as { transfer?: unknown } | null)?.transfer;
  return t && typeof t === 'object' && (t as { format?: unknown }).format === 'transfer-v1' ? t as AttachmentTransferFailure : null;
}

const STEP_TEXT: Record<AttachmentTransferStep, string> = {
  source_download: 'Lecture du document dans le stockage impossible',
  provider_upload: 'Envoi du document au fournisseur (Files API) refusé ou impossible',
  file_activation: 'Activation du fichier chez le fournisseur impossible',
};

interface FailureInput {
  step: AttachmentTransferStep; kind: AttachmentTransferFailureKind; endpoint: string;
  status?: number | null; headers?: Headers | null; bodyText?: string | null; networkCode?: string | null;
  note?: string; secret: string | null; startedAt?: number;
}

/** Construit l'échec structuré (pur, hors lecture du corps). */
export function buildTransferFailure(p: FailureInput, provider = 'gemini'): AttachmentTransferFailure {
  const parsed = parseProviderErrorBody(p.bodyText ?? null, p.headers?.get('content-type') ?? null, p.secret);
  const responseHeaders: Record<string, string> = {};
  for (const h of SAFE_RESPONSE_HEADERS) {
    const v = p.headers?.get(h);
    if (v) responseHeaders[h] = borne(sanitizeTransferText(v, p.secret), 300).text;
  }
  const requestId = REQUEST_ID_HEADERS.map((h) => responseHeaders[h]).find(Boolean) ?? parsed.requestIdFromBody ?? null;
  const statut = p.status ?? null;
  const fournisseur = [parsed.providerStatus, parsed.providerReason].filter(Boolean).join(' / ');
  const message = sanitizeTransferText([
    `${STEP_TEXT[p.step]}${statut !== null ? ` : HTTP ${statut}` : ''}${fournisseur ? ` ${fournisseur}` : ''}`,
    parsed.providerMessage ? `« ${parsed.providerMessage} »` : null,
    p.kind === 'network' ? `réseau${p.networkCode ? ` (${p.networkCode})` : ''}` : null,
    p.note ?? null,
    p.kind === 'http' && parsed.providerDetail === 'NONE' ? 'aucun détail fourni par le fournisseur (corps vide)' : null,
    p.kind === 'http' && parsed.providerDetail === 'TEXT' ? 'réponse non JSON du fournisseur (extrait conservé)' : null,
  ].filter(Boolean).join(' — '), p.secret).slice(0, 1_500);
  const { requestIdFromBody: _r, ...rest } = parsed;
  return {
    format: 'transfer-v1', step: p.step, kind: p.kind, provider, endpoint: p.endpoint,
    httpStatus: statut, ...rest, requestId, responseHeaders,
    networkCode: p.networkCode ?? null, message,
    durationMs: p.startedAt ? Date.now() - p.startedAt : null,
    generationRequested: false,
  };
}

/** Code réseau d'une erreur `fetch` (undici : `cause.code`). */
function networkCodeOf(e: unknown): string | null {
  const c = (e as { cause?: { code?: unknown } } | null)?.cause?.code ?? (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c.slice(0, 40) : null;
}

async function lireCorps(res: Response): Promise<string | null> {
  try { return await res.text(); } catch { return null; }
}

type FetchLike = (input: string | Request, init?: RequestInit) => Promise<Response>;

/** Requête de transfert qui échoue au RÉSEAU (aucune réponse) → échec structuré. */
async function envoyer(fetchImpl: FetchLike, input: string | Request, init: RequestInit | undefined, f: Omit<FailureInput, 'kind'>): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (e) {
    // Erreur LOCALE de construction déjà levée par `new Request` (en-tête) :
    // jamais ici — cette erreur-ci n'a pas obtenu de réponse.
    throw new AttachmentTransferError(buildTransferFailure({
      ...f, kind: 'network', networkCode: networkCodeOf(e),
      note: sanitizeTransferText(e instanceof Error ? e.message : String(e), f.secret).slice(0, 300),
    }), e);
  }
}

async function echecHttp(res: Response, f: Omit<FailureInput, 'kind' | 'status' | 'headers' | 'bodyText'>): Promise<never> {
  const bodyText = await lireCorps(res);
  throw new AttachmentTransferError(buildTransferFailure({ ...f, kind: 'http', status: res.status, headers: res.headers, bodyText }));
}

async function uploadToFilesApi(att: AiAttachment, apiKey: string): Promise<string> {
  const startedAt = Date.now();
  const source = endpointOf('GET', att.url, { hostOnly: true });
  // Lecture du document dans le STOCKAGE Verebona (URL signée, jamais conservée).
  const res = await envoyer(fetch, att.url, undefined, { step: 'source_download', endpoint: source, secret: apiKey, startedAt });
  if (!res.ok) await echecHttp(res, { step: 'source_download', endpoint: source, secret: apiKey, startedAt });
  const buffer = Buffer.from(await res.arrayBuffer());
  return transferBufferToFilesApi(buffer, { mimeType: att.mimeType, displayName: att.displayName ?? null }, apiKey);
}

/**
 * Envoi d'un contenu à la Files API, puis attente de l'état ACTIVE — chemin
 * UNIQUE de l'analyse et du test d'envoi du BO (lot 113R). `fetchImpl` :
 * injectable en test seulement.
 */
export async function transferBufferToFilesApi(
  buffer: Buffer,
  meta: { mimeType: string; displayName: string | null },
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const startedAt = Date.now();
  const endpoint = endpointOf('POST', FILES_API);
  // Lot 61 (incident fileId=98) : la requête est CONSTRUITE à part, avant
  // tout envoi. Un échec ici (en-tête invalide…) est local et déterministe :
  // identique sur tous les modèles, il ne doit déclencher aucun repli.
  let request: Request;
  try {
    request = new Request(`${FILES_API}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'raw',
        'Content-Type': meta.mimeType,
        // Nom d'origine (Unicode, NFD compris) encodé en ASCII pour l'en-tête
        // uniquement : le nom enregistré en base n'est jamais modifié.
        'X-Goog-Upload-File-Name': encodeHeaderValue(meta.displayName),
      },
      body: new Uint8Array(buffer),
    });
  } catch (e) {
    throw new AttachmentRequestBuildError(
      `Construction de la requête Files API impossible : ${sanitizeTransferText(e instanceof Error ? e.message : String(e), apiKey)}`, e);
  }
  const f = { step: 'provider_upload' as const, endpoint, secret: apiKey, startedAt };
  const upload = await envoyer(fetchImpl, request, undefined, f);
  if (!upload.ok) await echecHttp(upload, f);

  const texte = await lireCorps(upload);
  let json: { file?: { uri?: string; name?: string; state?: string } } | null = null;
  try { json = texte ? JSON.parse(texte) : null; } catch { json = null; }
  const uri = json?.file?.uri;
  if (!uri) {
    throw new AttachmentTransferError(buildTransferFailure({
      ...f, kind: 'invalid_response', status: upload.status, headers: upload.headers, bodyText: texte,
      note: 'URI absente de la réponse',
    }));
  }

  // Un fichier encore en traitement chez le fournisseur (vidéo, gros PDF) fait
  // échouer la génération : attendre l'état ACTIVE, comme le faisait l'ancien
  // `upload-to-gemini`. Hors du délai de l'appel modèle, comme avant.
  if (json?.file?.state && json.file.state !== 'ACTIVE') {
    const name = json.file.name ?? `files/${uri.split('/files/')[1] ?? ''}`;
    try {
      await waitForFileActive(name, apiKey, fetchImpl);
    } catch (e) {
      await cleanupTemporaryFiles([uri], apiKey, fetchImpl);
      throw e;
    }
  }
  return uri;
}

const ACTIVE_POLL_INTERVAL_MS = 3_000;
const ACTIVE_MAX_WAIT_MS = 300_000;

async function waitForFileActive(name: string, apiKey: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + ACTIVE_MAX_WAIT_MS;
  const endpoint = endpointOf('GET', `${FILES_BASE}/files/…`);
  const f = { step: 'file_activation' as const, endpoint, secret: apiKey, startedAt };
  while (Date.now() < deadline) {
    const res = await envoyer(fetchImpl, `${FILES_BASE}/${name}?key=${apiKey}`, undefined, f);
    if (!res.ok) await echecHttp(res, f);
    const { state } = ((await res.json().catch(() => ({}))) ?? {}) as { state?: string };
    if (state === 'ACTIVE') return;
    if (state === 'FAILED') {
      throw new AttachmentTransferError(buildTransferFailure({ ...f, kind: 'activation_failed', status: res.status, note: 'traitement du fichier échoué chez le fournisseur (state=FAILED)' }));
    }
    await new Promise((r) => setTimeout(r, ACTIVE_POLL_INTERVAL_MS));
  }
  throw new AttachmentTransferError(buildTransferFailure({ ...f, kind: 'activation_timeout', note: 'fichier non devenu ACTIVE dans le délai' }));
}

export async function cleanupTemporaryFiles(uris: string[], apiKey: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await Promise.all(
    uris.map(async (uri) => {
      try {
        const name = uri.split('/files/')[1];
        if (!name) return;
        await fetchImpl(`${FILES_BASE}/files/${name}?key=${apiKey}`, { method: 'DELETE' });
      } catch {
        // Non bloquant : les fichiers Files API expirent d'eux-mêmes sous 48 h.
      }
    }),
  );
}
