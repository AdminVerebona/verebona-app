/**
 * Liens entrants de l'application — lot 95 (CDC 12 §19, SEC-04, PUSH-04 ; PO M1, M5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE VALIDATION POUR TOUT CE QUI OUVRE UN ÉCRAN
 *
 * Lien universel / App Link, retour du navigateur système (Google / Apple),
 * clic sur une notification (`data.href`) : tout passe par
 * `resolveAppUrl`, PURE, qui n'accepte que
 *   · l'origine EXACTE de l'environnement du binaire (jamais un autre
 *     domaine : préprod et prod restent isolées, R8),
 *   · un chemin de la liste unique `APP_LINK_ROUTES` (lot 97), après les
 *     exclusions `APP_LINK_EXCLUSIONS` (offres, abonnement, administration,
 *     API : ouverts dans le navigateur système, jamais dans l'app — COM-01/05),
 *   · ou le retour OAuth de l'app (https `/app/retour-connexion?handoff=…`,
 *     ou schéma privé `<appId>:/oauth?handoff=…`, RFC 8252).
 * Tout le reste est refusé (aucune exécution arbitraire, aucune navigation
 * vers une URL fournie par un tiers).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { APP_LINK_EXCLUSIONS, APP_LINK_ROUTES, OAUTH_APP_RETURN_PATH } from '@/lib/mobile/app-links';

export type AppUrlResolution =
  | { kind: 'route'; path: string }
  | { kind: 'oauth'; handoff: string }
  /** Lot 97B : parcours Google / Apple de Mon compte refusé côté serveur (`?error=<CODE>`). */
  | { kind: 'oauth_error'; code: string }
  | { kind: 'external'; url: string }
  /** `<schéma>://share` : réveil par l'extension de partage iOS (le contenu arrive par le plugin). */
  | { kind: 'share' }
  | { kind: 'rejected'; reason: 'invalid_url' | 'foreign_origin' | 'unknown_path' | 'unsupported_scheme' | 'oauth_without_code' };

export interface AppUrlContext {
  /** Origine https de l'environnement du binaire (ex. `https://app.verebona.fr`). */
  origin: string;
  /** Schéma privé de l'app (ex. `fr.verebona.app.preprod`), facultatif. */
  urlScheme?: string | null;
}

const HANDOFF = /^[A-Za-z0-9_-]{20,200}$/;

/** Motif AASA (`*` = toute suite, `?` = un caractère) → expression régulière ancrée. */
export function aasaPatternToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

const EXCLUSIONS = APP_LINK_EXCLUSIONS.map(aasaPatternToRegExp);
const ROUTES = APP_LINK_ROUTES.filter((r) => r.path !== OAUTH_APP_RETURN_PATH).map((r) => aasaPatternToRegExp(r.path));

/** Chemin ouvrable dans l'app (après exclusions), pur. */
export function isAppRoutePath(pathname: string): boolean {
  if (EXCLUSIONS.some((re) => re.test(pathname))) return false;
  return ROUTES.some((re) => re.test(pathname));
}

const OAUTH_ERROR = /^[A-Z][A-Z_]{2,59}$/;

function oauthFrom(params: URLSearchParams): AppUrlResolution {
  const handoff = params.get('handoff') ?? '';
  if (HANDOFF.test(handoff)) return { kind: 'oauth', handoff };
  // Lot 97B : code d'erreur stable (jamais un message libre affiché tel quel).
  const error = params.get('error') ?? '';
  return OAUTH_ERROR.test(error) ? { kind: 'oauth_error', code: error } : { kind: 'rejected', reason: 'oauth_without_code' };
}

/** Résout un lien entrant (pur, testé). */
export function resolveAppUrl(raw: unknown, ctx: AppUrlContext): AppUrlResolution {
  if (typeof raw !== 'string' || raw.length > 4096) return { kind: 'rejected', reason: 'invalid_url' };
  let url: URL;
  let origin: URL;
  try {
    url = new URL(raw);
    origin = new URL(ctx.origin);
  } catch {
    return { kind: 'rejected', reason: 'invalid_url' };
  }

  // Schéma privé : uniquement le retour OAuth (RFC 8252 §7.1).
  if (ctx.urlScheme && url.protocol === `${ctx.urlScheme.toLowerCase()}:`) {
    const target = `${url.host}${url.pathname}`.replace(/^\/+/, '').replace(/\/+$/, '');
    if (target === 'oauth') return oauthFrom(url.searchParams);
    return target === 'share' ? { kind: 'share' } : { kind: 'rejected', reason: 'unsupported_scheme' };
  }
  if (url.protocol !== 'https:') return { kind: 'rejected', reason: 'unsupported_scheme' };
  if (url.origin !== origin.origin || url.username || url.password) return { kind: 'rejected', reason: 'foreign_origin' };

  if (url.pathname === OAUTH_APP_RETURN_PATH) return oauthFrom(url.searchParams);
  if (EXCLUSIONS.some((re) => re.test(url.pathname))) return { kind: 'external', url: url.toString() };
  if (!ROUTES.some((re) => re.test(url.pathname))) return { kind: 'rejected', reason: 'unknown_path' };
  return { kind: 'route', path: `${url.pathname}${url.search}${url.hash}` };
}

/** `data.href` d'une notification push (lot 97 : lien HTTPS de l'écran) → chemin interne, ou null. */
export function pushTargetPath(data: unknown, ctx: AppUrlContext): string | null {
  const href = data && typeof data === 'object' ? (data as Record<string, unknown>).href : null;
  const r = resolveAppUrl(href, ctx);
  return r.kind === 'route' ? r.path : null;
}
