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
  | { ok: false; errors: string[] };

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

function checkUrl(v: unknown, origins: string[], label: string, errors: string[]): string | null {
  if (typeof v !== 'string' || v.length > 1000) { errors.push(`${label} : URL absente`); return null; }
  let u: URL;
  try { u = new URL(v); } catch { errors.push(`${label} : URL invalide`); return null; }
  const localHttp = u.protocol === 'http:' && origins.includes(u.origin) && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !localHttp) { errors.push(`${label} : HTTPS exigé`); return null; }
  if (u.username || u.password) { errors.push(`${label} : identifiants interdits dans l'URL`); return null; }
  if (!origins.includes(u.origin)) { errors.push(`${label} : origine ${u.origin} hors du site public`); return null; }
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
    const permalink = checkUrl(v.permalink, origins, `${at}.permalink`, errors);
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
    const textUrl = v.textUrl === undefined || v.textUrl === null ? null : checkUrl(v.textUrl, origins, `${at}.textUrl`, errors);
    if (permalink && SHA256.test(sha) && publishedAt && effectiveAt && typeof v.requiresReacceptance === 'boolean') {
      versions.push({
        code: v.code, permalink, sha256: sha, publishedAt, effectiveAt,
        requiresReacceptance: v.requiresReacceptance,
        title: str(v.title, 200), changeSummary: str(v.changeSummary, 2000), textUrl,
      });
    }
  });
  if (isCguvVersionCode(o.current) && !seen.has(o.current)) errors.push(`current : ${o.current} absent de versions`);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: { generatedAt: isoDate(o.generatedAt), current: o.current as string, versions },
  };
}

export type ManifestFetchResult =
  | { ok: true; manifest: CguvManifest; sha256: string; url: string }
  | { ok: false; kind: 'unavailable' | 'invalid'; error: string; url: string };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function shortError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, ' ').slice(0, 300);
}

/** Lit le manifeste public (ne lève jamais). */
export async function fetchCguvManifest(opts: { fetchImpl?: FetchLike; env?: Env } = {}): Promise<ManifestFetchResult> {
  const env = opts.env ?? process.env;
  const url = manifestUrl(env);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = Number(env.LEGAL_MANIFEST_TIMEOUT_MS) > 0 ? Number(env.LEGAL_MANIFEST_TIMEOUT_MS) : LEGAL_MANIFEST_DEFAULTS.timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, kind: 'unavailable', error: `HTTP ${res.status}`, url };
    const body = await res.text();
    if (body.length > LEGAL_MANIFEST_DEFAULTS.maxBytes) return { ok: false, kind: 'invalid', error: 'manifeste trop volumineux', url };
    let json: unknown;
    try { json = JSON.parse(body); } catch { return { ok: false, kind: 'invalid', error: 'JSON illisible', url }; }
    const parsed = parseCguvManifest(json, env);
    if (!parsed.ok) return { ok: false, kind: 'invalid', error: parsed.errors.slice(0, 5).join(' ; '), url };
    return { ok: true, manifest: parsed.manifest, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), url };
  } catch (e) {
    return { ok: false, kind: 'unavailable', error: ctrl.signal.aborted ? `délai dépassé (${timeoutMs} ms)` : shortError(e), url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vérifie l'empreinte d'un texte figé (`textUrl`) : SHA-256 des octets servis.
 * `null` = vérification impossible (réseau) — sans conclusion.
 */
export async function verifyTextSha256(textUrl: string, expected: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<boolean | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? LEGAL_MANIFEST_DEFAULTS.timeoutMs);
  try {
    const res = await fetchImpl(textUrl, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return createHash('sha256').update(buf).digest('hex') === expected;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
