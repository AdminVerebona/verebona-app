/**
 * Jeton signé d'OPEN_SEARCH_RESULTS — CDC Assistant §22.4 (« token signé,
 * court et lié au compte ») ; décision PO D-J3 (lot 21).
 *
 * Le serveur prépare les résultats d'une recherche de l'assistant (documents
 * ou événements trouvés, biens concernés) et les scelle dans un jeton :
 *
 *   base64url(JSON { v, a: compte, s: portée, ids, assets, exp }) . HMAC-SHA256
 *
 * Signé avec `VEREBONA_SEARCH_TOKEN_SECRET` (sinon `JWT_SECRET`), valable
 * `SEARCH_TOKEN_TTL_S` (30 min, comme `expiresAt` de l'action). La route
 * `GET /api/verebona/search-results` le vérifie (signature, expiration,
 * COMPTE de la session) puis REVÉRIFIE chaque identifiant dans le compte
 * avant d'ouvrir Mes documents ou l'agenda filtrés.
 *
 * Aucun contenu : des identifiants et une portée. Pur (crypto Node), testé.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export type SearchScope = 'documents' | 'agenda';
export const SEARCH_TOKEN_TTL_S = 30 * 60;
export const SEARCH_TOKEN_MAX_IDS = 50;

export interface SearchTokenPayload {
  v: 1;
  a: number;
  s: SearchScope;
  ids: number[];
  assets: number[];
  exp: number;
}

function secret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.VEREBONA_SEARCH_TOKEN_SECRET || env.JWT_SECRET;
  if (!s) throw new Error('Aucun secret de signature (VEREBONA_SEARCH_TOKEN_SECRET ou JWT_SECRET).');
  return s;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (body: string, key: string) => createHmac('sha256', key).update(`verebona-search:${body}`).digest('base64url');

const ids = (v: unknown): number[] => (Array.isArray(v) ? v : [])
  .map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
  .filter((n, i, a) => a.indexOf(n) === i).slice(0, SEARCH_TOKEN_MAX_IDS);

export function createSearchToken(
  p: { accountId: number; scope: SearchScope; ids: unknown; assets?: unknown },
  now = Date.now(), env: NodeJS.ProcessEnv = process.env,
): string {
  const payload: SearchTokenPayload = {
    v: 1, a: p.accountId, s: p.scope, ids: ids(p.ids), assets: ids(p.assets ?? []), exp: Math.floor(now / 1000) + SEARCH_TOKEN_TTL_S,
  };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body, secret(env))}`;
}

export type SearchTokenCheck =
  | { ok: true; payload: SearchTokenPayload }
  | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'OTHER_ACCOUNT' };

/** Vérifie signature, expiration et COMPTE. Ne lève jamais. */
export function verifySearchToken(
  token: string | null | undefined, accountId: number, now = Date.now(), env: NodeJS.ProcessEnv = process.env,
): SearchTokenCheck {
  if (!token || token.length > 4000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: 'MALFORMED' };
  const [body, sig] = token.split('.');
  let attendu: string;
  try {
    attendu = sign(body, secret(env));
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(attendu);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  let p: SearchTokenPayload;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SearchTokenPayload;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (p?.v !== 1 || (p.s !== 'documents' && p.s !== 'agenda') || !Number.isFinite(p.exp)) return { ok: false, reason: 'MALFORMED' };
  if (p.exp * 1000 < now) return { ok: false, reason: 'EXPIRED' };
  if (p.a !== accountId) return { ok: false, reason: 'OTHER_ACCOUNT' };
  return { ok: true, payload: { ...p, ids: ids(p.ids), assets: ids(p.assets) } };
}

/** URL de l'application qui affiche les résultats (après revérification). */
export function searchResultsTarget(scope: SearchScope, documentIds: number[], assetIds: number[], demandes = documentIds.length): string {
  const q = new URLSearchParams();
  if (scope === 'documents') {
    if (documentIds.length) q.set('resultats', documentIds.join(','));
    // Le jeton désignait des documents, tous disparus depuis (supprimés,
    // déplacés, autre compte) : « aucun résultat », jamais la liste complète.
    else if (demandes > 0) q.set('resultats', 'aucun');
    return `/documents${q.toString() ? `?${q}` : ''}`;
  }
  // Agenda : filtres existants de la page (biens concernés).
  if (assetIds.length) q.set('assetIds', assetIds.join(','));
  return `/agenda${q.toString() ? `?${q}` : ''}`;
}
