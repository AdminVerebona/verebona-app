/**
 * Diagnostic de la connexion — lot 103A (recette iOS du 31/10/2026 :
 * « Votre session a expiré » juste après une saisie e-mail / mot de passe
 * correcte). Module PUR, partagé navigateur / serveur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN IDENTIFIANT PAR TENTATIVE, DES CODES STABLES, DES MESSAGES DISTINCTS
 *
 *   · Chaque tentative de connexion reçoit un identifiant de corrélation
 *     court (`LOGIN_ATTEMPT_HEADER`), sans valeur secrète : ni e-mail, ni mot
 *     de passe, ni jeton. Il accompagne la requête de connexion puis, pendant
 *     `LOGIN_DIAGNOSTIC_WINDOW_MS`, les appels d'API qui suivent : le journal
 *     du serveur (`[auth.diag]`) relie « connexion acceptée » → « premier
 *     appel refusé » → « déconnexion demandée par l'app ».
 *   · Le motif d'un retour à l'écran de connexion est un CODE (`reason`),
 *     jamais un texte libre : session réellement expirée, absence de
 *     session, session révoquée, session refusée juste après une connexion
 *     acceptée, compte suspendu. Chaque code a son message.
 *   · Un refus de la connexion elle-même (identifiants, compte, anti-abus,
 *     version de l'app, origine) a son propre message : jamais « session
 *     expirée ».
 * ══════════════════════════════════════════════════════════════════════════
 */

/** En-tête de corrélation d'une tentative de connexion (aucune donnée secrète). */
export const LOGIN_ATTEMPT_HEADER = 'X-Verebona-Login-Attempt';

/** En-tête : qui demande la déconnexion (utilisateur, refus d'authentification…). */
export const LOGOUT_REASON_HEADER = 'X-Verebona-Logout-Reason';

export const LOGOUT_REASONS = ['user', 'auth-failure'] as const;
export type LogoutReason = typeof LOGOUT_REASONS[number];

/** Durée pendant laquelle les appels qui suivent une connexion portent son identifiant. */
export const LOGIN_DIAGNOSTIC_WINDOW_MS = 10 * 60 * 1000;

/**
 * Fenêtre « juste après une connexion acceptée » : un refus de session dans
 * ce délai n'est pas une expiration (le jeton d'accès vit 15 min) mais une
 * session qui n'a pas été conservée ou transmise.
 */
export const POST_LOGIN_WINDOW_MS = 2 * 60 * 1000;

const ATTEMPT_ID = /^[A-Z0-9]{8,16}$/;
const ATTEMPT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Identifiant de tentative : 10 caractères lisibles au téléphone (pas de 0/O, 1/I). */
export function newLoginAttemptId(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ATTEMPT_ALPHABET[b % ATTEMPT_ALPHABET.length]).join('');
}

export function isLoginAttemptId(v: unknown): v is string {
  return typeof v === 'string' && ATTEMPT_ID.test(v);
}

/** Lecture tolérante de l'en-tête de corrélation (serveur) : null si absent ou mal formé. */
export function readLoginAttemptId(headers: { get(name: string): string | null }): string | null {
  const v = headers.get(LOGIN_ATTEMPT_HEADER)?.trim().toUpperCase() ?? null;
  return isLoginAttemptId(v) ? v : null;
}

export function readLogoutReason(headers: { get(name: string): string | null }): LogoutReason | null {
  const v = headers.get(LOGOUT_REASON_HEADER)?.trim().toLowerCase() ?? '';
  return (LOGOUT_REASONS as readonly string[]).includes(v) ? (v as LogoutReason) : null;
}

// ── Mémoire de la dernière tentative (onglet / vue de l'app) ───────────────

export interface LoginAttemptRecord {
  id: string;
  /** Début de la tentative (ms). */
  at: number;
  /** Connexion acceptée par le serveur (200). */
  ok: boolean;
}

const STORAGE_KEY = 'verebona:auth:login-attempt';

interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function sessionStore(): KeyValueStore | null {
  try { return (globalThis as { sessionStorage?: KeyValueStore }).sessionStorage ?? null; } catch { return null; }
}

/**
 * Mémorise la tentative (stockage de l'onglet : survit à la redirection vers
 * la connexion, pas à la fermeture). Aucune donnée personnelle.
 */
export function rememberLoginAttempt(rec: LoginAttemptRecord, store: KeyValueStore | null = sessionStore()): void {
  try { store?.setItem(STORAGE_KEY, JSON.stringify(rec)); } catch { /* stockage indisponible : diagnostic dégradé */ }
}

/** Dernière tentative encore dans la fenêtre de diagnostic, ou null. */
export function currentLoginAttempt(now: number = Date.now(), store: KeyValueStore | null = sessionStore()): LoginAttemptRecord | null {
  let raw: string | null = null;
  try { raw = store?.getItem(STORAGE_KEY) ?? null; } catch { return null; }
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<LoginAttemptRecord>;
    if (!isLoginAttemptId(r.id) || typeof r.at !== 'number' || now - r.at > LOGIN_DIAGNOSTIC_WINDOW_MS || r.at - now > 60_000) return null;
    return { id: r.id, at: r.at, ok: r.ok === true };
  } catch {
    return null;
  }
}

/** En-tête de corrélation à joindre aux appels d'API (vide hors fenêtre). */
export function loginAttemptHeaders(now: number = Date.now()): Record<string, string> {
  const a = currentLoginAttempt(now);
  return a ? { [LOGIN_ATTEMPT_HEADER]: a.id } : {};
}

// ── Motifs de retour à l'écran de connexion ────────────────────────────────

export const AUTH_EXIT_REASONS = [
  'session_expired',
  'no_session',
  'session_revoked',
  'post_login_rejected',
  'account_suspended',
  // Lot 110B : session sans double authentification alors qu'elle est obligatoire.
  'mfa_required',
] as const;
export type AuthExitReason = typeof AUTH_EXIT_REASONS[number];

export function isAuthExitReason(v: unknown): v is AuthExitReason {
  return typeof v === 'string' && (AUTH_EXIT_REASONS as readonly string[]).includes(v);
}

/** Message historique, conservé mot pour mot pour une session réellement expirée. */
export const SESSION_EXPIRED_MESSAGE = 'Votre session a expiré. Merci de vous reconnecter.';

export const AUTH_EXIT_MESSAGES: Readonly<Record<AuthExitReason, string>> = Object.freeze({
  session_expired: SESSION_EXPIRED_MESSAGE,
  no_session: 'Merci de vous connecter pour continuer.',
  session_revoked: 'Vous avez été déconnecté de cet appareil. Merci de vous reconnecter.',
  post_login_rejected:
    'Votre connexion a bien été acceptée, mais la session n’a pas pu être conservée sur cet appareil. '
    + 'Réessayez. Si le problème continue, contactez l’assistance en indiquant le code de diagnostic ci-dessous.',
  account_suspended: 'Votre compte est suspendu. Contactez l’assistance.',
  mfa_required: 'Pour protéger vos biens et vos documents, reconnectez-vous puis confirmez votre identité avec votre méthode de sécurité.',
});

/**
 * Motif d'un refus définitif (renouvellement impossible), d'après le code du
 * refus de `/api/auth/refresh` et la dernière tentative de connexion (pur).
 *
 *   · AUTH_REQUIRED (aucun jeton de renouvellement présenté) : pas de
 *     session — ou, juste après une connexion ACCEPTÉE, session non
 *     conservée / non transmise par la vue (cookie absent) ;
 *   · SESSION_REVOKED : appareil déconnecté (Mon compte, BO, mot de passe) ;
 *   · ACCOUNT_SUSPENDED : compte suspendu ;
 *   · sinon (jeton expiré, invalide, révoqué par la borne globale) : expiration.
 */
export function classifyAuthExit(input: {
  refreshCode: string | null | undefined;
  lastAttempt: LoginAttemptRecord | null;
  now?: number;
}): AuthExitReason {
  const now = input.now ?? Date.now();
  const code = (input.refreshCode ?? '').toUpperCase();
  const recentLogin = !!input.lastAttempt?.ok && now - input.lastAttempt.at <= POST_LOGIN_WINDOW_MS;
  if (code === 'ACCOUNT_SUSPENDED') return 'account_suspended';
  if (recentLogin && (code === 'AUTH_REQUIRED' || code === 'MISSING_TOKEN' || code === '')) return 'post_login_rejected';
  if (code === 'AUTH_REQUIRED' || code === 'MISSING_TOKEN') return 'no_session';
  if (code === 'SESSION_REVOKED') return 'session_revoked';
  return 'session_expired';
}

/** Message affiché par l'écran de connexion pour ses paramètres d'URL (pur). */
export function loginBannerFromParams(params: { get(name: string): string | null }): { message: string; reason: AuthExitReason | null } | null {
  const reason = params.get('reason');
  if (isAuthExitReason(reason)) return { message: AUTH_EXIT_MESSAGES[reason], reason };
  if (params.get('error') === 'ACCOUNT_SUSPENDED') return { message: AUTH_EXIT_MESSAGES.account_suspended, reason: 'account_suspended' };
  // Liens antérieurs au lot 103A (`?expired=1` sans motif).
  if (params.get('expired') === '1') return { message: SESSION_EXPIRED_MESSAGE, reason: 'session_expired' };
  return null;
}

/** Paramètres de motif à retirer de l'adresse une fois lus (jamais réaffichés). */
export const LOGIN_BANNER_PARAMS = ['expired', 'reason', 'error', 'social_error', 'diag'] as const;

// ── Refus de la connexion elle-même ────────────────────────────────────────

const GENERIC_LOGIN_FAILURE = 'La connexion n’a pas abouti. Veuillez réessayer.';

/**
 * Message d'un refus de `POST /api/auth/login` (pur). Fondé sur le statut et
 * le code stable ; le message du serveur n'est repris que lorsqu'il est déjà
 * rédigé pour l'utilisateur (français). Ne renvoie JAMAIS le message
 * d'expiration de session : la connexion n'a pas été acceptée.
 */
export function loginFailureMessage(status: number, body: { code?: unknown; message?: unknown; error?: unknown } | null | undefined): { code: string; message: string } {
  const code = typeof body?.code === 'string' && body.code ? body.code : `HTTP_${status}`;
  const serverMessage = typeof body?.message === 'string' && body.message ? body.message
    : typeof body?.error === 'string' && body.error ? body.error : '';
  const message = ((): string => {
    if (status === 503 || code === 'SERVICE_UNAVAILABLE') return 'Service temporairement indisponible. Veuillez réessayer dans quelques instants.';
    if (status >= 500) return 'Une erreur est survenue sur le serveur. Veuillez réessayer.';
    switch (code) {
      case 'INVALID_CREDENTIALS': return serverMessage || 'Identifiants incorrects. Veuillez réessayer.';
      case 'RATE_LIMIT_EXCEEDED': return serverMessage || 'Trop de tentatives de connexion. Réessayez dans quelques minutes.';
      case 'EMAIL_NOT_VERIFIED': return serverMessage;
      case 'ACCOUNT_SUSPENDED': return AUTH_EXIT_MESSAGES.account_suspended;
      case 'ACCOUNT_INACTIVE': return 'Ce compte n’est plus actif. Contactez l’assistance si vous pensez qu’il s’agit d’une erreur.';
      case 'APP_UPDATE_REQUIRED': return 'Une mise à jour de l’application Verebona est nécessaire pour vous connecter.';
      case 'CSRF_ORIGIN_REJECTED':
        return 'La connexion a été refusée pour une raison de sécurité (origine non reconnue). Fermez puis rouvrez l’application et réessayez ; si le problème continue, contactez l’assistance.';
      case 'MISSING_FIELD':
      case 'VALIDATION_ERROR': return 'Renseignez votre e-mail et votre mot de passe.';
      default: break;
    }
    if (status === 429) return 'Trop de tentatives de connexion. Réessayez dans quelques minutes.';
    return GENERIC_LOGIN_FAILURE;
  })();
  // Garde-fou : un refus de connexion n'est jamais présenté comme une session expirée.
  return { code, message: message === SESSION_EXPIRED_MESSAGE || !message ? GENERIC_LOGIN_FAILURE : message };
}
