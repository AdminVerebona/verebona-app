/**
 * Contrat unique des erreurs de session et des refus d'accès — APP-PERF-20.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUATRE FAMILLES, QUATRE RÉPONSES
 *
 *   authentification (401) : AUTH_REQUIRED, INVALID_TOKEN — le client tente
 *                            UN renouvellement, puis renvoie à la connexion ;
 *   autorisation     (403) : ACCOUNT_SUSPENDED, ACCOUNT_PENDING_DELETION,
 *                            INSUFFICIENT_PERMISSIONS, ACCESS_DENIED —
 *                            jamais une déconnexion. (TRIAL_ACTIVATION_PENDING,
 *                            refus de l'ancienne « fin de grâce », n'existe
 *                            plus : les droits d'abonnement ne sont pas une
 *                            question de session — APP-FUNC-31.)
 *   ressource absente (404): hors de ce module (routes) ;
 *   indisponibilité  (503) : SESSION_UNAVAILABLE — la vérification de session
 *                            n'a pas pu être faite (base injoignable). Ni
 *                            succès, ni refus : le client réessaie plus tard.
 *
 * Les codes publics sont INCHANGÉS (le client et les écrans les consomment) ;
 * chaque réponse porte en plus un message lisible en français et un
 * `requestId` (corps et en-tête `x-request-id`) pour relier un signalement
 * au journal. Les refus normaux ne sont pas journalisés comme des pannes ;
 * une erreur inconnue l'est, sans donnée sensible.
 *
 * Les routes testaient parfois des messages anglais libres
 * (« Unauthorized », « Access denied ») qui ne correspondent à aucun code
 * levé par les gardes : un refus normal y devenait une erreur 500.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { ACCOUNT_PENDING_DELETION_CODE, ACCOUNT_PENDING_DELETION_MESSAGE } from './account-closure';

/** Vérification de session impossible (base injoignable) : ni succès, ni refus. */
export const SESSION_UNAVAILABLE_CODE = 'SESSION_UNAVAILABLE';

interface SessionErrorSpec {
  status: number;
  /** Code public renvoyé (stable). */
  code: string;
  /** Libellé historique du champ `error` (compatibilité des clients). */
  error: string;
  /** Message destiné à l'utilisateur. */
  message: string;
}

/** Erreurs levées par les gardes (`throw new Error(CODE)`) → réponse HTTP. */
export const SESSION_ERRORS: Readonly<Record<string, SessionErrorSpec>> = {
  AUTH_REQUIRED: { status: 401, code: 'AUTH_REQUIRED', error: 'Authentication required', message: 'Authentification requise. Merci de vous connecter.' },
  INVALID_TOKEN: { status: 401, code: 'INVALID_TOKEN', error: 'Invalid or malformed token', message: 'Votre session a expiré. Merci de vous reconnecter.' },
  ACCOUNT_SUSPENDED: { status: 403, code: 'ACCOUNT_SUSPENDED', error: 'Your account has been suspended', message: 'Votre compte est suspendu.' },
  [ACCOUNT_PENDING_DELETION_CODE]: { status: 403, code: ACCOUNT_PENDING_DELETION_CODE, error: 'Forbidden', message: ACCOUNT_PENDING_DELETION_MESSAGE },
  INSUFFICIENT_PERMISSIONS: { status: 403, code: 'INSUFFICIENT_PERMISSIONS', error: 'Insufficient permissions', message: 'Vous n’avez pas les droits nécessaires pour cette action.' },
  FORBIDDEN: { status: 403, code: 'ACCESS_DENIED', error: 'Access denied', message: 'Accès refusé à cette ressource.' },
  [SESSION_UNAVAILABLE_CODE]: { status: 503, code: SESSION_UNAVAILABLE_CODE, error: 'Service Unavailable', message: 'Vérification de session momentanément impossible. Réessayez dans un instant.' },
};

/** Vrai si l'erreur provient d'une garde de session (refus ou indisponibilité). */
export function isKnownSessionError(error: unknown): boolean {
  return error instanceof Error && Object.prototype.hasOwnProperty.call(SESSION_ERRORS, error.message);
}

export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function json(status: number, body: Record<string, unknown>, requestId: string): NextResponse {
  const res = NextResponse.json({ ...body, requestId, timestamp: new Date().toISOString() }, { status });
  res.headers.set('x-request-id', requestId);
  if (status === 503) res.headers.set('Retry-After', '5');
  return res;
}

/**
 * Réponse HTTP d'une erreur de garde de session. Une erreur inconnue donne
 * un 500 journalisé (avec `requestId`, sans message technique au client).
 */
export function sessionErrorToResponse(error: unknown, requestId: string = newRequestId(), context = 'session'): NextResponse {
  const key = error instanceof Error ? error.message : '';
  const spec = Object.prototype.hasOwnProperty.call(SESSION_ERRORS, key) ? SESSION_ERRORS[key] : null;
  if (spec) {
    if (spec.status === 503) {
      // Incident technique utile : journalisé, mais sans jeton ni identité.
      console.warn(`[${context}][${requestId}] vérification de session indisponible`);
    }
    return json(spec.status, { error: spec.error, code: spec.code, message: spec.message }, requestId);
  }
  console.error(`[${context}][${requestId}] erreur inattendue :`, error instanceof Error ? error.message : String(error));
  return json(500, {
    error: 'An unexpected error occurred',
    code: 'INTERNAL_ERROR',
    message: 'Une erreur inattendue est survenue. Réessayez dans un instant.',
  }, requestId);
}

// ── Refus d'accès et ressources absentes (routes) — lot 24, #21/#24 ─────────

/**
 * Réponse d'un refus constaté PAR LA ROUTE (pas par la garde de session),
 * au même format que le contrat (code stable, message français, `requestId`
 * dans le corps et l'en-tête) :
 *   · `no-account` : session sans compte courant → 401 AUTH_REQUIRED ;
 *   · `forbidden`  : 403 ACCESS_DENIED ;
 *   · `not-found`  : 404 (code de la ressource, ex. FILE_NOT_FOUND). Préféré
 *     à 403 pour une ressource d'un AUTRE compte : ne confirme pas son existence.
 * Refus normal : jamais journalisé comme une panne.
 */
export function accessErrorResponse(
  kind: 'no-account' | 'forbidden' | 'not-found',
  requestId: string = newRequestId(),
  opts: { code?: string; message?: string; headers?: Record<string, string> } = {},
): NextResponse {
  let res: NextResponse;
  if (kind === 'no-account') {
    const s = SESSION_ERRORS.AUTH_REQUIRED;
    res = json(s.status, { error: s.error, code: s.code, message: opts.message ?? s.message }, requestId);
  } else if (kind === 'forbidden') {
    const s = SESSION_ERRORS.FORBIDDEN;
    res = json(s.status, { error: s.error, code: opts.code ?? s.code, message: opts.message ?? s.message }, requestId);
  } else {
    res = json(404, { error: 'Not found', code: opts.code ?? 'NOT_FOUND', message: opts.message ?? 'Ressource introuvable.' }, requestId);
  }
  for (const [k, v] of Object.entries(opts.headers ?? {})) res.headers.set(k, v);
  return res;
}
