/**
 * Limitation de la RÉAUTHENTIFICATION par mot de passe — lot 53A (retour PO
 * Q21) ; CDC 18 §33 (« Reauth password : même niveau de protection que login
 * + user/session key » ; « Account deletion : conserver rate limiting IP +
 * user »), SEC-04 (compteurs partagés entre instances).
 *
 * Actions concernées : changement du mot de passe (mot de passe actuel) et
 * clôture du compte (mot de passe + « SUPPRIMER MON COMPTE ») ; lot 92 :
 * réauthentification du bloc Sécurité (`reauth.ts`, action `reauth`), MÊMES
 * compteurs (par utilisateur et par IP) — la preuve de 5 min ne contourne
 * jamais le limiteur. Une session
 * volée ne doit pas servir à deviner le mot de passe.
 *
 *   · compteurs PARTAGÉS (`auth_rate_limits`) — la clôture utilisait un `Map`
 *     en mémoire par instance ;
 *   · seuls les ÉCHECS de mot de passe comptent ;
 *   · clé par UTILISATEUR (5 échecs / 15 min → 15, 30, 60 min) et par IP
 *     (20 / 15 min). Une session est exigée : aucun tiers ne peut bloquer le
 *     titulaire par ce chemin ;
 *   · réussite : le compteur de l'utilisateur repart à zéro ;
 *   · pause déclenchée : journal AUTH_REAUTH_THROTTLED.
 *
 * CARTE #823 (incident du 20/11/2026) — la trace était lancée sans être
 * attendue (`void logUserActivity`) et toute erreur d'insertion était
 * absorbée : la réponse pouvait précéder la trace (écriture tardive), ou la
 * trace ne jamais exister (perte silencieuse). Désormais :
 *   · les clés utilisateur et IP sont comptées dans UNE transaction ; quand la
 *     tentative pose la pause, la trace (action, durée CALCULÉE) est écrite
 *     dans cette même transaction : pause et trace sont validées ensemble,
 *     avant la réponse, une seule fois par entrée en pause ;
 *   · une tentative ordinaire, ou refusée par une pause en cours, n'écrit et
 *     n'attend aucune trace ;
 *   · trace impossible : l'action reste REFUSÉE et la pause reste appliquée
 *     (tenue en mémoire par l'instance — aucun verrou n'est validé en base sans
 *     sa trace) ; la dégradation est signalée dans les journaux
 *     (`security.reauth_throttle_trace_degraded`) et dans `/api/health`
 *     (`authRateLimiter`). La protection l'emporte sur la journalisation ;
 *   · LIMITE : en repli mémoire (PostgreSQL totalement indisponible), aucune
 *     trace durable ne peut être garantie dans cette base ; seul le signalement
 *     ci-dessus en témoigne, et la pause n'est connue que de l'instance.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_LIMITS, authRateLimitEnabled, getAuthRateLimiter, limitKey, rateLimitBody } from './auth-rate-limit';
import { getClientIp } from './client-ip';
import { insertUserActivity } from '@/lib/audit-logger';

type ReauthAction = 'change_password' | 'account_deletion' | 'reauth';

function entries(userId: number, ip: string) {
  return [
    { key: limitKey('reauth', 'user', String(userId)), policy: AUTH_LIMITS.reauthUser },
    { key: limitKey('reauth', 'ip', ip), policy: AUTH_LIMITS.reauthIp },
  ];
}

/** Réponse 429 si une pause est en cours ; `null` sinon. Ne compte rien. */
export async function reauthBlockedResponse(request: NextRequest, userId: number): Promise<NextResponse | null> {
  if (!authRateLimitEnabled()) return null;
  const d = await getAuthRateLimiter().check(entries(userId, getClientIp(request.headers)));
  if (d.allowed) return null;
  return NextResponse.json(rateLimitBody(d.retryAfterSeconds), {
    status: 429, headers: { 'Retry-After': String(d.retryAfterSeconds) },
  });
}

/**
 * Mot de passe actuel faux : compté (utilisateur et IP) dans une transaction.
 * Pause posée par cette tentative : sa trace AUTH_REAUTH_THROTTLED est validée
 * avec elle (carte #823). Ne lève pas : l'appelant refuse l'action dans tous
 * les cas (401), que la trace ait pu être écrite ou non.
 */
export async function recordReauthFailure(request: NextRequest, userId: number, action: ReauthAction): Promise<void> {
  if (!authRateLimitEnabled()) return;
  const d = await getAuthRateLimiter().recordFailureWithLockTrace(
    entries(userId, getClientIp(request.headers)),
    (tx, lock) => insertUserActivity({
      activityType: 'AUTH_REAUTH_THROTTLED',
      userId,
      userEmail: '',
      details: { action, retryAfterSeconds: lock.retryAfterSeconds },
      request,
    }, tx),
  );
  if (d.lockedNow && d.lockTrace !== 'committed') {
    // Pause appliquée (mémoire de l'instance) SANS trace durable en base : signalement explicite.
    // Aucune donnée sensible : ni mot de passe, ni adresse e-mail, ni adresse IP.
    console.error(JSON.stringify({
      event: 'security.reauth_throttle_trace_degraded',
      userId,
      action,
      retryAfterSeconds: d.retryAfterSeconds,
      protection: 'pause tenue en mémoire par cette instance',
      trace: 'AUTH_REAUTH_THROTTLED non enregistrée en base',
      cause: d.lockTraceError,
    }));
  }
}

/** Mot de passe prouvé : le compteur de l'utilisateur repart à zéro (jamais celui de l'IP). */
export async function recordReauthSuccess(userId: number): Promise<void> {
  if (!authRateLimitEnabled()) return;
  await getAuthRateLimiter().reset(limitKey('reauth', 'user', String(userId)));
}
