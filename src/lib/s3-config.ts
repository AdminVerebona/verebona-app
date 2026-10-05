/**
 * Configuration OVH S3 — SOURCE UNIQUE (APP-PERF-26).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CONTRAT DE VARIABLES, UNE SEULE FABRIQUE DE CLIENTS
 *
 * Chaque route construisait son propre `S3Client` : `/api/files` lisait
 * `OVH_S3_ACCESS_KEY` / `OVH_S3_SECRET_KEY` (paire jamais documentée) et
 * masquait l'échec de signature par `previewUrl = null` ; view, proxy et
 * download forçaient l'adressage virtual-host, le client central et les
 * sauvegardes le style chemin ; certains avaient des délais, d'autres aucun.
 *
 * Désormais :
 *   · les variables canoniques sont lues et validées ICI seulement
 *     (`readS3Config`) — aucune autre partie du code ne lit `OVH_S3_*` ;
 *   · les anciennes variables `OVH_S3_ACCESS_KEY` / `OVH_S3_SECRET_KEY` ne
 *     sont JAMAIS utilisées : leur présence est signalée (sans valeur) et une
 *     valeur contradictoire avec la variable canonique est diagnostiquée ;
 *   · `getS3Client(profil)` fournit un client mis en cache par profil :
 *       - `interactive` : requêtes utilisateur (lecture, aperçu, upload
 *         signé) — délais courts, 2 tentatives au plus ;
 *       - `worker` : générations d'exports, sauvegardes, miniatures, purge —
 *         délais plus longs (`EXPORTS_S3_*`), 3 tentatives ;
 *     seuls les délais et tentatives diffèrent, jamais endpoint, région,
 *     bucket, identifiants ni mode d'adressage ;
 *   · une configuration invalide lève `S3ConfigError` (code typé, liste des
 *     variables en cause) au moment de l'usage, pas à l'import : une route
 *     qui n'a pas besoin du stockage reste servie, et l'erreur est
 *     exploitable sans exposer de secret.
 *
 * Mode d'adressage : `OVH_S3_FORCE_PATH_STYLE` (défaut `true`, celui du
 * client central qui sert les uploads signés en production). OVH accepte
 * les deux styles ; le choix est un réglage, pas une croyance — voir
 * `.env.example`. Signer une URL est un calcul LOCAL (aucun appel réseau) :
 * une URL signée produite ne prouve pas que le stockage répond.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

export type S3Profile = 'interactive' | 'worker';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Durée des URL signées de lecture (s). */
  signedUrlTtlSeconds: number;
  timeouts: Record<S3Profile, { connectionTimeout: number; requestTimeout: number; maxAttempts: number }>;
}

export type S3ConfigIssueCode = 'MISSING' | 'INVALID' | 'LEGACY_ONLY' | 'CONFLICT';

export interface S3ConfigIssue {
  code: S3ConfigIssueCode;
  variable: string;
  /** Message lisible, SANS valeur de secret. */
  message: string;
}

export interface S3ConfigResult {
  config: S3Config | null;
  /** Bloquants : `config` est nul. */
  errors: S3ConfigIssue[];
  /** Non bloquants (anciennes variables, valeurs incohérentes). */
  warnings: S3ConfigIssue[];
}

/** Variables canoniques (documentées dans `.env.example`). */
export const S3_ENV = {
  endpoint: 'OVH_S3_ENDPOINT',
  region: 'OVH_S3_REGION',
  bucket: 'OVH_S3_BUCKET',
  accessKeyId: 'OVH_S3_ACCESS_KEY_ID',
  secretAccessKey: 'OVH_S3_SECRET_ACCESS_KEY',
  forcePathStyle: 'OVH_S3_FORCE_PATH_STYLE',
  signedUrlTtl: 'OVH_S3_SIGNED_URL_TTL_S',
  connectTimeout: 'OVH_S3_CONNECT_TIMEOUT_MS',
  requestTimeout: 'OVH_S3_REQUEST_TIMEOUT_MS',
} as const;

/** Anciennes variables : jamais lues comme valeur, seulement signalées. */
export const S3_LEGACY_ENV: Record<string, string> = {
  OVH_S3_ACCESS_KEY: S3_ENV.accessKeyId,
  OVH_S3_SECRET_KEY: S3_ENV.secretAccessKey,
};

const DEFAULT_REGION = 'gra';

type Env = Record<string, string | undefined>;

/** Entier borné ; hors bornes → valeur par défaut et avertissement (non bloquant). */
function entier(env: Env, name: string, def: number, min: number, max: number, issues: S3ConfigIssue[]): number {
  const brut = env[name]?.trim();
  if (!brut) return def;
  const n = Number(brut);
  if (!Number.isFinite(n) || n < min || n > max) {
    issues.push({ code: 'INVALID', variable: name, message: `${name} doit être un entier entre ${min} et ${max} : valeur par défaut (${def}) utilisée.` });
    return def;
  }
  return Math.floor(n);
}

/**
 * Lit et valide la configuration S3. Pure : n'ouvre aucune connexion et ne
 * journalise rien — l'appelant décide.
 */
export function readS3Config(env: Env = process.env): S3ConfigResult {
  const errors: S3ConfigIssue[] = [];
  const warnings: S3ConfigIssue[] = [];
  const val = (name: string) => env[name]?.trim() || '';

  // ── Anciennes variables : signalées, jamais utilisées ─────────────────────
  for (const [legacy, canonical] of Object.entries(S3_LEGACY_ENV)) {
    const ancien = val(legacy);
    if (!ancien) continue;
    const actuel = val(canonical);
    if (!actuel) {
      errors.push({
        code: 'LEGACY_ONLY',
        variable: canonical,
        message: `${canonical} absente alors que l'ancienne variable ${legacy} est définie : renommer ${legacy} en ${canonical} (l'ancienne n'est plus lue).`,
      });
    } else if (ancien !== actuel) {
      warnings.push({
        code: 'CONFLICT',
        variable: legacy,
        message: `${legacy} (ancienne, ignorée) a une valeur différente de ${canonical} : supprimer ${legacy}.`,
      });
    } else {
      warnings.push({ code: 'CONFLICT', variable: legacy, message: `${legacy} est obsolète (même valeur que ${canonical}) : la supprimer.` });
    }
  }

  // ── Obligatoires ──────────────────────────────────────────────────────────
  const requis = [S3_ENV.endpoint, S3_ENV.bucket, S3_ENV.accessKeyId, S3_ENV.secretAccessKey];
  for (const name of requis) {
    if (!val(name) && !errors.some((e) => e.variable === name)) {
      errors.push({ code: 'MISSING', variable: name, message: `${name} manquante.` });
    }
  }

  const endpoint = val(S3_ENV.endpoint);
  if (endpoint) {
    try {
      const u = new URL(endpoint);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocole');
      if (u.protocol === 'http:' && env.NODE_ENV === 'production') {
        warnings.push({ code: 'INVALID', variable: S3_ENV.endpoint, message: `${S3_ENV.endpoint} n'est pas en HTTPS.` });
      }
    } catch {
      errors.push({ code: 'INVALID', variable: S3_ENV.endpoint, message: `${S3_ENV.endpoint} n'est pas une URL http(s) valide.` });
    }
  }

  const region = val(S3_ENV.region) || DEFAULT_REGION;
  // Région déduite de l'hôte OVH (s3.<région>.io.cloud.ovh.net) : une
  // région différente casse la signature (SignatureDoesNotMatch).
  const regionHote = /(?:^|\.)s3\.([a-z0-9-]+)\.(?:io\.)?cloud\.ovh\.net$/i.exec(safeHost(endpoint))?.[1];
  if (regionHote && regionHote.toLowerCase() !== region.toLowerCase()) {
    warnings.push({
      code: 'CONFLICT',
      variable: S3_ENV.region,
      message: `${S3_ENV.region} (${region}) ne correspond pas à la région de ${S3_ENV.endpoint} (${regionHote}).`,
    });
  }

  const styleBrut = val(S3_ENV.forcePathStyle).toLowerCase();
  let forcePathStyle = true;
  if (styleBrut) {
    if (['1', 'true', 'yes'].includes(styleBrut)) forcePathStyle = true;
    else if (['0', 'false', 'no'].includes(styleBrut)) forcePathStyle = false;
    else errors.push({ code: 'INVALID', variable: S3_ENV.forcePathStyle, message: `${S3_ENV.forcePathStyle} doit valoir true ou false.` });
  }

  // Bornes AWS : une URL signée SigV4 ne peut dépasser 7 jours.
  const signedUrlTtlSeconds = entier(env, S3_ENV.signedUrlTtl, 3600, 60, 7 * 24 * 3600, warnings);
  const iConnect = entier(env, S3_ENV.connectTimeout, 5_000, 500, 120_000, warnings);
  const iRequest = entier(env, S3_ENV.requestTimeout, 30_000, 1_000, 600_000, warnings);
  // Profil worker : variables historiques des générations V12, conservées.
  const wConnect = entier(env, 'EXPORTS_S3_CONNECT_TIMEOUT_MS', 10_000, 1_000, 600_000, warnings);
  const wRequest = entier(env, 'EXPORTS_S3_REQUEST_TIMEOUT_MS', 60_000, 1_000, 3_600_000, warnings);

  // Variables publiques (navigateur) divergentes : signalées.
  const pubBucket = val('NEXT_PUBLIC_OVH_S3_BUCKET');
  if (pubBucket && val(S3_ENV.bucket) && pubBucket !== val(S3_ENV.bucket)) {
    warnings.push({ code: 'CONFLICT', variable: 'NEXT_PUBLIC_OVH_S3_BUCKET', message: `NEXT_PUBLIC_OVH_S3_BUCKET diffère de ${S3_ENV.bucket}.` });
  }
  const pubEndpoint = val('NEXT_PUBLIC_OVH_S3_ENDPOINT');
  if (pubEndpoint && endpoint && pubEndpoint.replace(/\/+$/, '') !== endpoint.replace(/\/+$/, '')) {
    warnings.push({ code: 'CONFLICT', variable: 'NEXT_PUBLIC_OVH_S3_ENDPOINT', message: `NEXT_PUBLIC_OVH_S3_ENDPOINT diffère de ${S3_ENV.endpoint}.` });
  }

  if (errors.length > 0) return { config: null, errors, warnings };
  return {
    config: {
      endpoint,
      region,
      bucket: val(S3_ENV.bucket),
      accessKeyId: val(S3_ENV.accessKeyId),
      secretAccessKey: val(S3_ENV.secretAccessKey),
      forcePathStyle,
      signedUrlTtlSeconds,
      timeouts: {
        interactive: { connectionTimeout: iConnect, requestTimeout: iRequest, maxAttempts: 2 },
        worker: { connectionTimeout: wConnect, requestTimeout: wRequest, maxAttempts: 3 },
      },
    },
    errors,
    warnings,
  };
}

function safeHost(endpoint: string): string {
  try { return new URL(endpoint).hostname; } catch { return ''; }
}

/** Configuration S3 absente ou invalide. Message sans secret. */
export class S3ConfigError extends Error {
  readonly code = 'S3_CONFIG_INVALID';
  constructor(readonly issues: S3ConfigIssue[]) {
    super(`Configuration S3 invalide : ${issues.map((i) => i.message).join(' ')}`);
    this.name = 'S3ConfigError';
  }
}

let cache: { key: string; result: S3ConfigResult } | null = null;
let warned = '';

/** Empreinte NON réversible de l'environnement, pour invalider le cache. */
function envKey(env: Env): string {
  const noms = [...Object.values(S3_ENV), ...Object.keys(S3_LEGACY_ENV), 'EXPORTS_S3_CONNECT_TIMEOUT_MS', 'EXPORTS_S3_REQUEST_TIMEOUT_MS', 'NEXT_PUBLIC_OVH_S3_BUCKET', 'NEXT_PUBLIC_OVH_S3_ENDPOINT'];
  return noms.map((n) => `${n}=${env[n] ?? ''}`).join('\n');
}

function current(): S3ConfigResult {
  const key = envKey(process.env);
  if (!cache || cache.key !== key) {
    cache = { key, result: readS3Config(process.env) };
    const msg = cache.result.warnings.map((w) => w.message).join(' ');
    if (msg && msg !== warned) {
      warned = msg;
      console.warn(`[s3-config] ${msg}`);
    }
  }
  return cache.result;
}

/** Le stockage est-il correctement configuré ? Ne lève jamais. */
export function isS3Configured(): boolean {
  return current().config !== null;
}

/** Diagnostic de configuration (sans secret) — health, supervision. */
export function s3ConfigDiagnostics(): { configured: boolean; errors: S3ConfigIssue[]; warnings: S3ConfigIssue[]; forcePathStyle?: boolean; region?: string; endpointHost?: string } {
  const r = current();
  return {
    configured: r.config !== null,
    errors: r.errors,
    warnings: r.warnings,
    forcePathStyle: r.config?.forcePathStyle,
    region: r.config?.region,
    endpointHost: r.config ? safeHost(r.config.endpoint) : undefined,
  };
}

/** Configuration validée ; lève `S3ConfigError` sinon. */
export function getS3Config(): S3Config {
  const r = current();
  if (!r.config) throw new S3ConfigError(r.errors);
  return r.config;
}

/** Paramètres du client pour un profil — exposé pour les tests. */
export function s3ClientOptions(config: S3Config, profile: S3Profile): S3ClientConfig {
  const t = config.timeouts[profile];
  return {
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: config.forcePathStyle,
    maxAttempts: t.maxAttempts,
    requestHandler: { connectionTimeout: t.connectionTimeout, requestTimeout: t.requestTimeout },
  };
}

const clients = new Map<string, S3Client>();

/** Client S3 partagé pour un profil (créé au premier usage, puis réutilisé). */
export function getS3Client(profile: S3Profile = 'interactive'): S3Client {
  const config = getS3Config();
  const key = `${profile}\n${envKey(process.env)}`;
  let client = clients.get(key);
  if (!client) {
    client = new S3Client(s3ClientOptions(config, profile));
    clients.set(key, client);
  }
  return client;
}

/** Bucket canonique ; lève `S3ConfigError` si la configuration est invalide. */
export function getS3Bucket(): string {
  return getS3Config().bucket;
}

/** Réinitialise caches de configuration et clients — tests uniquement. */
export function resetS3ForTests(): void {
  cache = null;
  warned = '';
  clients.clear();
}

// ── Erreurs de stockage typées (sans secret ni URL signée) ──────────────────

export type S3ErrorKind =
  | 'CONFIG'
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | 'INVALID_RANGE'
  | 'NOT_MODIFIED'
  | 'ABORTED'
  | 'OTHER';

export interface S3ErrorInfo {
  kind: S3ErrorKind;
  /** Nom d'erreur SDK/S3 (NoSuchKey, AccessDenied, TimeoutError…). */
  name: string;
  httpStatus?: number;
}

/** Classe une erreur du SDK S3 en catégorie exploitable. */
export function classifyS3Error(error: unknown): S3ErrorInfo {
  if (error instanceof S3ConfigError) return { kind: 'CONFIG', name: error.name };
  const e = error as { name?: string; code?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  const name = String(e?.name ?? e?.Code ?? e?.code ?? 'Error');
  const httpStatus = e?.$metadata?.httpStatusCode;
  if (name === 'AbortError' || name === 'RequestAbortedError') return { kind: 'ABORTED', name, httpStatus };
  if (httpStatus === 304 || name === 'NotModified') return { kind: 'NOT_MODIFIED', name, httpStatus };
  if (httpStatus === 416 || name === 'InvalidRange') return { kind: 'INVALID_RANGE', name, httpStatus };
  if (name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchBucket' || httpStatus === 404) return { kind: 'NOT_FOUND', name, httpStatus };
  if (name === 'AccessDenied' || name === 'Forbidden' || name === 'SignatureDoesNotMatch' || name === 'InvalidAccessKeyId' || httpStatus === 403) {
    return { kind: 'ACCESS_DENIED', name, httpStatus };
  }
  if (name === 'TimeoutError' || name === 'RequestTimeout' || e?.code === 'ETIMEDOUT' || /timeout/i.test(name)) return { kind: 'TIMEOUT', name, httpStatus };
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(String(e?.code ?? name))) return { kind: 'UNREACHABLE', name: String(e?.code ?? name), httpStatus };
  return { kind: 'OTHER', name, httpStatus };
}

/**
 * Journalise une erreur de stockage sans secret ni URL signée : catégorie,
 * nom, statut, route. Le message SDK n'est pas repris (il peut contenir
 * l'URL de la requête).
 */
export function logS3Error(where: string, error: unknown, extra: Record<string, unknown> = {}): S3ErrorInfo {
  const info = classifyS3Error(error);
  if (info.kind === 'CONFIG') {
    console.error(`[s3] ${where} : ${(error as Error).message}`);
  } else if (info.kind !== 'ABORTED' && info.kind !== 'NOT_MODIFIED') {
    console.error(`[s3] ${where} : ${info.kind} (${info.name}${info.httpStatus ? `, HTTP ${info.httpStatus}` : ''})`, extra);
  }
  return info;
}

// ── URL signées de lecture ─────────────────────────────────────────────────

export interface SignedGetOptions {
  key: string;
  /** Bucket de l'objet (colonne `s3_bucket`) ; défaut : bucket canonique. */
  bucket?: string | null;
  /** Durée de validité (s) ; défaut : `OVH_S3_SIGNED_URL_TTL_S`. */
  expiresIn?: number;
  responseContentDisposition?: string;
  responseContentType?: string;
  responseCacheControl?: string;
  /**
   * Date de signature. Arrondie par l'appelant (ex. à l'heure), elle rend
   * l'URL identique pendant la fenêtre : le cache navigateur la réutilise.
   */
  signingDate?: Date;
}

/**
 * URL signée de lecture. Calcul LOCAL : aucun appel au stockage, donc aucune
 * preuve que l'objet existe ni que le stockage répond.
 */
export async function signGetUrl(opts: SignedGetOptions): Promise<string> {
  const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
  ]);
  const config = getS3Config();
  const command = new GetObjectCommand({
    Bucket: opts.bucket || config.bucket,
    Key: opts.key,
    ResponseContentDisposition: opts.responseContentDisposition,
    ResponseContentType: opts.responseContentType,
    ResponseCacheControl: opts.responseCacheControl,
  });
  return getSignedUrl(getS3Client('interactive'), command, {
    expiresIn: opts.expiresIn ?? config.signedUrlTtlSeconds,
    ...(opts.signingDate ? { signingDate: opts.signingDate } : {}),
  });
}
