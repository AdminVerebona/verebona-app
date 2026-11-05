/**
 * Manifeste public des versions de CGUV — lecture et validation (lot 102B).
 *
 * Format défini par docs/exploitation/contrat-site-public-legal.md (§ 4) :
 *
 *   {
 *     "schema": "verebona-legal-cguv-versions-v1",
 *     "document": "CGUV",
 *     "generatedAt": "2026-10-30T08:00:00Z",
 *     "current": "2026-10-30-v1",
 *     "versions": [{ "code", "permalink", "sha256", "publishedAt",
 *                    "effectiveAt"?, "requiresReacceptance", "title"?,
 *                    "changeSummary"?, "textUrl"? }]
 *   }
 *
 * Validation STRICTE et tout-ou-rien : un manifeste invalide n'est jamais
 * appliqué en partie — l'application garde son dernier état connu. Les liens
 * doivent appartenir à l'origine du site public de l'environnement (un
 * manifeste ne peut pas faire pointer les preuves vers un site tiers).
 */
import { createHash } from 'crypto';
import { CGUV_MANIFEST_PATH, isCguvVersionCode } from '@/lib/legal/public-legal';

export const CGUV_MANIFEST_SCHEMA = 'verebona-legal-cguv-versions-v1';

/** Réglages centralisés (aucune durée en dur ailleurs). */
export const LEGAL_MANIFEST_DEFAULTS = Object.freeze({
  /** Délai maximal de lecture du manifeste. */
  timeoutMs: 8_000,
  /** Taille maximale acceptée (le manifeste ne contient aucun texte). */
  maxBytes: 1_000_000,
  /** Nombre maximal de versions lues. */
  maxVersions: 500,
  /** Échecs consécutifs avant alerte Supervision (1 si aucun état connu). */
  alertAfterFailures: 2,
});

export interface CguvManifestVersion {
  code: string;
  permalink: string;
  sha256: string;
  publishedAt: Date;
  effectiveAt: Date;
  requiresReacceptance: boolean;
  title: string | null;
  changeSummary: string | null;
  textUrl: string | null;
}

export interface CguvManifest {
  generatedAt: Date | null;
  current: string;
  versions: CguvManifestVersion[];
}

export type ManifestParseResult =
  | { ok: true; manifest: CguvManifest }
  | {
    ok: false;
    errors: string[];
    /**
     * Lot 111O — origines rencontrées dans les liens du manifeste et
     * étrangères au site public de l'environnement (ex. manifeste construit
     * pour `https://www.verebona.fr` mais servi par la préproduction).
     */
    foreignOrigins?: string[];
    /** Lot 111O — codes de version lisibles (diagnostic, même si le manifeste est refusé). */
    codes?: string[];
    /** Lot 111O — version désignée « en vigueur » par le manifeste refusé, si lisible. */
    current?: string | null;
  };

type Env = Record<string, string | undefined>;

/** Base du site public lue À L'EXÉCUTION (variable par environnement). */
export function publicSiteBase(env: Env = process.env): string {
  const raw = (env.NEXT_PUBLIC_PUBLIC_SITE_URL || 'https://www.verebona.fr').trim();
  return raw.replace(/\/+$/, '');
}

/** URL du manifeste : `LEGAL_CGUV_MANIFEST_URL` sinon base du site + chemin du contrat. */
export function manifestUrl(env: Env = process.env): string {
  const override = (env.LEGAL_CGUV_MANIFEST_URL ?? '').trim();
  return override || `${publicSiteBase(env)}${CGUV_MANIFEST_PATH}`;
}

/** Origines admises pour les liens du manifeste. */
export function allowedLegalOrigins(env: Env = process.env): string[] {
  const out = new Set<string>();
  for (const raw of [publicSiteBase(env), ...(env.LEGAL_PUBLIC_EXTRA_ORIGINS ?? '').split(',')]) {
    const v = raw.trim();
    if (!v) continue;
    try { out.add(new URL(v).origin); } catch { /* ignorée */ }
  }
  return [...out];
}

const SHA256 = /^[0-9a-f]{64}$/;

function isoDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function checkUrl(v: unknown, origins: string[], label: string, errors: string[], foreign?: Set<string>): string | null {
  if (typeof v !== 'string' || v.length > 1000) { errors.push(`${label} : URL absente`); return null; }
  let u: URL;
  try { u = new URL(v); } catch { errors.push(`${label} : URL invalide`); return null; }
  const localHttp = u.protocol === 'http:' && origins.includes(u.origin) && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !localHttp) { errors.push(`${label} : HTTPS exigé`); return null; }
  if (u.username || u.password) { errors.push(`${label} : identifiants interdits dans l'URL`); return null; }
  if (!origins.includes(u.origin)) {
    foreign?.add(u.origin);
    errors.push(`${label} : origine ${u.origin} hors du site public`);
    return null;
  }
  return u.toString();
}

/** Valide un manifeste déjà décodé (pur). */
export function parseCguvManifest(raw: unknown, env: Env = process.env): ManifestParseResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['manifeste : objet JSON attendu'] };
  const o = raw as Record<string, unknown>;
  if (o.schema !== CGUV_MANIFEST_SCHEMA) errors.push(`schema : « ${CGUV_MANIFEST_SCHEMA} » attendu`);
  if (o.document !== 'CGUV') errors.push('document : « CGUV » attendu');
  if (!isCguvVersionCode(o.current)) errors.push('current : code AAAA-MM-JJ-vN attendu');
  if (!Array.isArray(o.versions) || o.versions.length === 0) {
    errors.push('versions : liste non vide attendue');
    return { ok: false, errors };
  }
  if (o.versions.length > LEGAL_MANIFEST_DEFAULTS.maxVersions) errors.push('versions : trop de versions');

  const origins = allowedLegalOrigins(env);
  const foreign = new Set<string>();
  const seen = new Set<string>();
  const permalinks = new Set<string>();
  const versions: CguvManifestVersion[] = [];
  o.versions.slice(0, LEGAL_MANIFEST_DEFAULTS.maxVersions).forEach((item, i) => {
    const at = `versions[${i}]`;
    if (!item || typeof item !== 'object') { errors.push(`${at} : objet attendu`); return; }
    const v = item as Record<string, unknown>;
    if (!isCguvVersionCode(v.code)) { errors.push(`${at}.code : AAAA-MM-JJ-vN attendu`); return; }
    if (seen.has(v.code)) errors.push(`${at}.code : ${v.code} en double`);
    seen.add(v.code);
    const permalink = checkUrl(v.permalink, origins, `${at}.permalink`, errors, foreign);
    if (permalink) {
      if (permalinks.has(permalink)) errors.push(`${at}.permalink : partagé par deux versions`);
      permalinks.add(permalink);
    }
    const sha = typeof v.sha256 === 'string' ? v.sha256.toLowerCase() : '';
    if (!SHA256.test(sha)) errors.push(`${at}.sha256 : empreinte SHA-256 hexadécimale (64 caractères) attendue`);
    const publishedAt = isoDate(v.publishedAt);
    if (!publishedAt) errors.push(`${at}.publishedAt : date ISO 8601 attendue`);
    const effectiveAt = v.effectiveAt === undefined || v.effectiveAt === null ? publishedAt : isoDate(v.effectiveAt);
    if (!effectiveAt) errors.push(`${at}.effectiveAt : date ISO 8601 attendue`);
    // Décision figée à la publication : un booléen explicite, jamais deviné.
    if (typeof v.requiresReacceptance !== 'boolean') errors.push(`${at}.requiresReacceptance : booléen attendu`);
    const textUrl = v.textUrl === undefined || v.textUrl === null ? null : checkUrl(v.textUrl, origins, `${at}.textUrl`, errors, foreign);
    if (permalink && SHA256.test(sha) && publishedAt && effectiveAt && typeof v.requiresReacceptance === 'boolean') {
      versions.push({
        code: v.code, permalink, sha256: sha, publishedAt, effectiveAt,
        requiresReacceptance: v.requiresReacceptance,
        title: str(v.title, 200), changeSummary: str(v.changeSummary, 2000), textUrl,
      });
    }
  });
  if (isCguvVersionCode(o.current) && !seen.has(o.current)) errors.push(`current : ${o.current} absent de versions`);

  if (errors.length > 0) {
    return {
      ok: false, errors,
      foreignOrigins: [...foreign],
      codes: [...seen],
      current: isCguvVersionCode(o.current) ? (o.current as string) : null,
    };
  }
  return {
    ok: true,
    manifest: { generatedAt: isoDate(o.generatedAt), current: o.current as string, versions },
  };
}

/**
 * Lot 111O — motif STABLE d'un échec de lecture du manifeste (BO, journal,
 * Supervision, tests). Chaque cause candidate d'un blocage de l'inscription a
 * son code : l'écran dit laquelle, sans deviner.
 */
export type ManifestFailureReason =
  | 'MANIFEST_HTTP_UNAUTHORIZED'
  | 'MANIFEST_HTTP_NOT_FOUND'
  | 'MANIFEST_HTTP_ERROR'
  | 'MANIFEST_REDIRECT_FOREIGN'
  | 'MANIFEST_REDIRECT_LOOP'
  | 'MANIFEST_NOT_JSON'
  | 'MANIFEST_TOO_LARGE'
  | 'MANIFEST_ORIGIN_MISMATCH'
  | 'MANIFEST_SCHEMA_INVALID'
  | 'MANIFEST_TIMEOUT'
  | 'MANIFEST_NETWORK';

export const MANIFEST_FAILURE_LABELS: Readonly<Record<ManifestFailureReason, string>> = Object.freeze({
  MANIFEST_HTTP_UNAUTHORIZED: 'le site public exige une authentification pour le manifeste (401/403)',
  MANIFEST_HTTP_NOT_FOUND: 'manifeste absent à cette adresse (404)',
  MANIFEST_HTTP_ERROR: 'le site public a répondu par une erreur HTTP',
  MANIFEST_REDIRECT_FOREIGN: 'redirection vers une autre origine (non suivie)',
  MANIFEST_REDIRECT_LOOP: 'trop de redirections',
  MANIFEST_NOT_JSON: 'la réponse n’est pas un manifeste JSON (page HTML ?)',
  MANIFEST_TOO_LARGE: 'manifeste trop volumineux',
  MANIFEST_ORIGIN_MISMATCH: 'les liens du manifeste désignent un autre site que le site public de cet environnement',
  MANIFEST_SCHEMA_INVALID: 'manifeste non conforme au contrat',
  MANIFEST_TIMEOUT: 'délai de lecture dépassé',
  MANIFEST_NETWORK: 'site public injoignable (réseau)',
});

export type ManifestFetchResult =
  | { ok: true; manifest: CguvManifest; sha256: string; url: string; httpStatus: number; finalUrl: string }
  | {
    ok: false;
    kind: 'unavailable' | 'invalid';
    error: string;
    url: string;
    /** Lot 111O : motif stable. */
    reason: ManifestFailureReason;
    /** Lot 111O : statut HTTP de la dernière réponse (null : aucune réponse). */
    httpStatus: number | null;
    /** Lot 111O : adresse effectivement lue (après redirections de même origine). */
    finalUrl: string;
    /** Lot 111O : destination d'une redirection refusée. */
    location?: string | null;
    foreignOrigins?: string[];
    codes?: string[];
    manifestCurrent?: string | null;
  };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function shortError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const extra = cause?.code || cause?.message ? ` (${cause.code ?? cause.message})` : '';
  return `${m}${extra}`.replace(/\s+/g, ' ').slice(0, 300);
}

/** Redirections de même origine suivies au plus (au-delà : refus). */
const MAX_SAME_ORIGIN_REDIRECTS = 3;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Lit le manifeste public (ne lève jamais).
 *
 * Lot 111O : les redirections ne sont plus suivies aveuglément — une
 * redirection vers une AUTRE origine (ex. préproduction → production par
 * `CANONICAL_HOST`) est refusée avec son motif ; seules les redirections de
 * même origine sont suivies. Chaque échec porte un motif stable et le statut
 * HTTP observé.
 */
export async function fetchCguvManifest(opts: { fetchImpl?: FetchLike; env?: Env } = {}): Promise<ManifestFetchResult> {
  const env = opts.env ?? process.env;
  const url = manifestUrl(env);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = Number(env.LEGAL_MANIFEST_TIMEOUT_MS) > 0 ? Number(env.LEGAL_MANIFEST_TIMEOUT_MS) : LEGAL_MANIFEST_DEFAULTS.timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let current = url;
  let httpStatus: number | null = null;
  const fail = (kind: 'unavailable' | 'invalid', reason: ManifestFailureReason, error: string, extra: Partial<Extract<ManifestFetchResult, { ok: false }>> = {}): ManifestFetchResult =>
    ({ ok: false, kind, reason, error, url, httpStatus, finalUrl: current, ...extra });
  try {
    let res: Response | null = null;
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(current, { headers: { accept: 'application/json' }, cache: 'no-store', signal: ctrl.signal, redirect: 'manual' });
      httpStatus = res.status;
      if (!isRedirect(res.status)) break;
      const raw = res.headers.get('location');
      let next: URL | null = null;
      try { next = raw ? new URL(raw, current) : null; } catch { next = null; }
      if (!next) return fail('unavailable', 'MANIFEST_REDIRECT_FOREIGN', `HTTP ${res.status} : redirection sans destination lisible`, { location: raw });
      if (next.origin !== new URL(current).origin) {
        return fail('unavailable', 'MANIFEST_REDIRECT_FOREIGN', `HTTP ${res.status} : redirection vers ${next.origin}${next.pathname} (autre origine, non suivie)`, { location: `${next.origin}${next.pathname}` });
      }
      if (hop >= MAX_SAME_ORIGIN_REDIRECTS) return fail('unavailable', 'MANIFEST_REDIRECT_LOOP', `HTTP ${res.status} : plus de ${MAX_SAME_ORIGIN_REDIRECTS} redirections`, { location: next.toString() });
      current = next.toString();
    }
    if (res.status === 401 || res.status === 403) return fail('unavailable', 'MANIFEST_HTTP_UNAUTHORIZED', `HTTP ${res.status} : ${MANIFEST_FAILURE_LABELS.MANIFEST_HTTP_UNAUTHORIZED}`);
    if (res.status === 404 || res.status === 410) return fail('unavailable', 'MANIFEST_HTTP_NOT_FOUND', `HTTP ${res.status}`);
    if (!res.ok) return fail('unavailable', 'MANIFEST_HTTP_ERROR', `HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > LEGAL_MANIFEST_DEFAULTS.maxBytes) return fail('invalid', 'MANIFEST_TOO_LARGE', 'manifeste trop volumineux');
    let json: unknown;
    try { json = JSON.parse(body); } catch {
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim() || 'inconnu';
      return fail('invalid', 'MANIFEST_NOT_JSON', `JSON illisible (type ${type})`);
    }
    const parsed = parseCguvManifest(json, env);
    if (!parsed.ok) {
      const foreign = parsed.foreignOrigins ?? [];
      return fail('invalid', foreign.length > 0 ? 'MANIFEST_ORIGIN_MISMATCH' : 'MANIFEST_SCHEMA_INVALID', parsed.errors.slice(0, 5).join(' ; '), {
        foreignOrigins: foreign, codes: parsed.codes ?? [], manifestCurrent: parsed.current ?? null,
      });
    }
    return { ok: true, manifest: parsed.manifest, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), url, httpStatus: res.status, finalUrl: current };
  } catch (e) {
    return ctrl.signal.aborted
      ? fail('unavailable', 'MANIFEST_TIMEOUT', `délai dépassé (${timeoutMs} ms)`)
      : fail('unavailable', 'MANIFEST_NETWORK', shortError(e));
  } finally {
    clearTimeout(timer);
  }
}

/** Taille maximale d'un texte figé vérifié (un texte juridique HTML reste bien en deçà). */
export const LEGAL_TEXT_MAX_BYTES = 5_000_000;

/**
 * Lot 104A (P1-C) — résultat DÉTAILLÉ d'une vérification d'octets. Seul
 * `{ ok: true }` autorise un import, une activation ou un rattachement :
 * toute autre issue (URL absente, 404, réseau, délai, empreinte différente,
 * empreinte attendue invalide) est un REFUS. Jamais de « sans conclusion »
 * qui laisserait passer.
 */
export type TextVerification =
  | { ok: true; sha256: string; bytes: number }
  | { ok: false; reason: TextVerificationFailure; detail: string; sha256?: string };

export type TextVerificationFailure =
  | 'TEXT_URL_MISSING'
  | 'EXPECTED_SHA_INVALID'
  | 'HTTP_NOT_FOUND'
  | 'HTTP_UNAUTHORIZED'
  | 'HTTP_REDIRECT'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'TOO_LARGE'
  | 'SHA_MISMATCH';

/** Libellé court (BO, Supervision, journal) d'un échec de vérification — sans URL ni secret. */
export const TEXT_VERIFICATION_LABELS: Readonly<Record<TextVerificationFailure, string>> = Object.freeze({
  TEXT_URL_MISSING: 'adresse du texte figé (textUrl) absente du manifeste',
  EXPECTED_SHA_INVALID: 'empreinte attendue invalide',
  HTTP_NOT_FOUND: 'texte figé introuvable (404)',
  HTTP_UNAUTHORIZED: 'texte figé protégé par une authentification (401/403)',
  HTTP_REDIRECT: 'texte figé redirigé (non suivi : les octets doivent être servis à l’adresse annoncée)',
  HTTP_ERROR: 'texte figé inaccessible (erreur HTTP)',
  TIMEOUT: 'délai de lecture du texte figé dépassé',
  NETWORK: 'texte figé injoignable (réseau)',
  TOO_LARGE: 'texte figé trop volumineux',
  SHA_MISMATCH: 'les octets servis ne correspondent pas à l’empreinte annoncée',
});

/**
 * Vérifie les octets d'un texte figé (`textUrl`) : SHA-256 des octets EXACTS
 * servis, comparé à l'empreinte attendue. Ne lève jamais.
 */
export async function verifyTextBytes(
  textUrl: string | null | undefined,
  expected: string | null | undefined,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<TextVerification> {
  if (!textUrl) return { ok: false, reason: 'TEXT_URL_MISSING', detail: TEXT_VERIFICATION_LABELS.TEXT_URL_MISSING };
  const want = (expected ?? '').toLowerCase();
  if (!SHA256.test(want)) return { ok: false, reason: 'EXPECTED_SHA_INVALID', detail: TEXT_VERIFICATION_LABELS.EXPECTED_SHA_INVALID };
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? LEGAL_MANIFEST_DEFAULTS.timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Lot 111O : `manual` (au lieu de `error`) pour nommer la cause d'une redirection.
    const res = await fetchImpl(textUrl, { cache: 'no-store', signal: ctrl.signal, redirect: 'manual' });
    if (isRedirect(res.status)) {
      const loc = res.headers.get('location');
      let dest = loc ?? '';
      try { if (loc) { const u = new URL(loc, textUrl); dest = `${u.origin}${u.pathname}`; } } catch { /* brute */ }
      return { ok: false, reason: 'HTTP_REDIRECT', detail: `${TEXT_VERIFICATION_LABELS.HTTP_REDIRECT} — HTTP ${res.status}${dest ? ` vers ${dest.slice(0, 160)}` : ''}` };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'HTTP_UNAUTHORIZED', detail: `${TEXT_VERIFICATION_LABELS.HTTP_UNAUTHORIZED} — HTTP ${res.status}` };
    if (res.status === 404 || res.status === 410) return { ok: false, reason: 'HTTP_NOT_FOUND', detail: `${TEXT_VERIFICATION_LABELS.HTTP_NOT_FOUND} — HTTP ${res.status}` };
    if (!res.ok) return { ok: false, reason: 'HTTP_ERROR', detail: `${TEXT_VERIFICATION_LABELS.HTTP_ERROR} — HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > LEGAL_TEXT_MAX_BYTES) return { ok: false, reason: 'TOO_LARGE', detail: TEXT_VERIFICATION_LABELS.TOO_LARGE };
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== want) return { ok: false, reason: 'SHA_MISMATCH', detail: `${TEXT_VERIFICATION_LABELS.SHA_MISMATCH} (servi ${got.slice(0, 12)}…, annoncé ${want.slice(0, 12)}…)`, sha256: got };
    return { ok: true, sha256: got, bytes: buf.length };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, reason: 'TIMEOUT', detail: `${TEXT_VERIFICATION_LABELS.TIMEOUT} (${timeoutMs} ms)` };
    return { ok: false, reason: 'NETWORK', detail: `${TEXT_VERIFICATION_LABELS.NETWORK} — ${shortError(e).slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compatibilité (lot 102B) : `true` = conforme, `false` = empreinte
 * différente, `null` = vérification impossible. Depuis le lot 104A, l'import
 * n'utilise plus cette fonction : un `null` y vaut un REFUS (`verifyTextBytes`).
 */
export async function verifyTextSha256(textUrl: string, expected: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<boolean | null> {
  const r = await verifyTextBytes(textUrl, expected, opts);
  if (r.ok) return true;
  return r.reason === 'SHA_MISMATCH' ? false : null;
}
