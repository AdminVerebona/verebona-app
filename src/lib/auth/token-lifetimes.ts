/**
 * Durées des jetons et des cookies de session — SOURCE UNIQUE (lot 53A,
 * retour PO Q21 ; CDC 18 §19.1, §19.2, §19.3, SESS-01).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES DEUX JETONS D'UNE SESSION (ne pas les confondre)
 *
 *   · jeton d'ACCÈS (`access_token`, `kid` v2-access) : prouve l'identité à
 *     chaque appel d'API et à chaque page protégée. COURT : 15 minutes (JWT
 *     ET cookie). Il n'est jamais renouvelé tel quel : à son expiration, le
 *     client appelle `/api/auth/refresh` (api-client, au premier 401) ;
 *   · jeton de RENOUVELLEMENT (`refresh_token`, `kid` v2-refresh) : assure la
 *     persistance (« pas de case Rester connecté »). 30 jours, ROTATIF : chaque
 *     renouvellement le consomme et en émet un neuf de 30 jours — la session
 *     expire donc après 30 jours SANS activité (expiration glissante). Il
 *     n'ouvre aucune route hors `/api/auth/refresh` et la déconnexion.
 *
 * Web / PWA et application mobile (Capacitor, WebView de l'application web)
 * utilisent les MÊMES cookies HttpOnly : aucun jeton n'est lisible en
 * JavaScript ni stocké dans localStorage, et le renouvellement lit le
 * cookie. Le passage de l'accès de 2 h à 15 min ne change donc rien pour le
 * client : le cookie d'accès vivait déjà 15 min (sauf après la vérification
 * d'adresse, 2 h — aligné ici) ; seule la durée de validité INTRINSÈQUE du
 * JWT, qui dépassait celle du cookie, est ramenée à 15 min (un jeton capturé
 * n'est plus utilisable 2 h, y compris en `Authorization: Bearer`).
 *
 * Module pur (aucune dépendance Node) : importé par le middleware Edge.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Jeton d'accès : JWT `exp` ET `Max-Age` du cookie `access_token`. */
export const ACCESS_TOKEN_TTL_S = 15 * 60;

/** Jeton de renouvellement : JWT `exp` ET `Max-Age` du cookie `refresh_token` (glissant par rotation). */
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;

/**
 * Durée maximale des jetons d'accès HISTORIQUES (émis avant le lot 37, sans
 * `kid`, par l'ancien émetteur à 2 h). Sert UNIQUEMENT à borner leur double
 * lecture (`LEGACY_TOKENS_ACCEPTED_UNTIL`) — jamais à émettre un jeton.
 */
export const LEGACY_ACCESS_TOKEN_MAX_S = 2 * 60 * 60;
