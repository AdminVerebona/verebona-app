/**
 * Lot 111Q — lectures BO de la page « Diagnostics » AVEC le schéma
 * d'authentification administratif commun (`apiClient` : cookies HttpOnly,
 * renouvellement unique et partagé du jeton d'accès, rejeu de la requête).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ANOMALIE (05/11/2026) : « Détail non chargé : Unauthorized (MISSING_TOKEN) ».
 *
 * La page interrogeait le détail toutes les 3 s (et la liste toutes les 5 s)
 * avec un `fetch` NU. Le jeton d'accès vit 15 min (JWT `exp` ET `Max-Age` du
 * cookie `access_token`, `lib/auth/token-lifetimes.ts`) : passé ce délai, le
 * navigateur ne présente plus le cookie, le middleware répond 401
 * `MISSING_TOKEN`, et un `fetch` nu ne renouvelle jamais la session (seul
 * `apiClient` appelle `/api/auth/refresh` puis rejoue). Une actualisation de
 * page « réparait » : la coquille BO (`useSession`) passe par `apiClient`,
 * qui renouvelle. Indépendant de la file des diagnostics : l'état du travail
 * n'en dépend pas (seul l'affichage était figé).
 *
 * Correctif : toutes les lectures et actions de la page passent par
 * `apiClient` (`onAuthFailure: 'silent'` : la page garde la main et propose la
 * reconnexion au lieu d'une redirection brutale en plein suivi) ; aucun
 * contrôle n'est assoupli (requireAdmin inchangé côté serveur). Une session
 * réellement expirée est dite en français, avec « Se reconnecter » ; la
 * dernière lecture réussie reste affichée AVEC son âge, jamais présentée
 * comme fraîche ; le code technique n'apparaît que discrètement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { apiClient, ApiClientError } from '@/lib/api-client';

export type ReadFailureKind = 'SESSION_EXPIRED' | 'MFA_REQUIRED' | 'FORBIDDEN' | 'NOT_FOUND' | 'NETWORK' | 'SERVER';

export interface ReadFailure {
  kind: ReadFailureKind;
  /** Message français affiché (jamais le code brut). */
  message: string;
  /** Code technique (affichage discret, copie pour le support). */
  code: string | null;
  status: number;
  requestId: string | null;
}

/** Qualification d'un échec de lecture (pure). */
export function describeReadFailure(e: unknown, what = 'Lecture'): ReadFailure {
  const err = e as Partial<ApiClientError> & { name?: string };
  const status = typeof err?.status === 'number' ? err.status : 0;
  const code = typeof err?.code === 'string' ? err.code : null;
  const requestId = typeof err?.requestId === 'string' ? err.requestId : null;
  const f = (kind: ReadFailureKind, message: string): ReadFailure => ({ kind, message, code, status, requestId });
  if (status === 401) return f('SESSION_EXPIRED', 'Votre session a expiré. Reconnectez-vous pour reprendre le suivi ; le diagnostic continue en arrière-plan.');
  if (status === 403 && code === 'MFA_REQUIRED') return f('MFA_REQUIRED', 'Une vérification de sécurité (double authentification) est demandée. Reconnectez-vous pour reprendre le suivi.');
  if (status === 403) return f('FORBIDDEN', 'Accès refusé : cette page est réservée aux administrateurs.');
  if (status === 404) return f('NOT_FOUND', `${what} impossible : diagnostic introuvable.`);
  if (status === 0 && (code === 'NETWORK_ERROR' || code === 'REQUEST_TIMEOUT')) return f('NETWORK', `${what} impossible : réseau indisponible ou délai dépassé. Nouvel essai automatique.`);
  if (status === 0 && code === 'REQUEST_ABORTED') return f('NETWORK', `${what} interrompue.`);
  return f('SERVER', `${what} impossible : le serveur n’a pas répondu correctement${status ? ` (HTTP ${status})` : ''}. Nouvel essai automatique.`);
}

/** Les échecs qui exigent une action de l'administrateur : le suivi automatique s'arrête. */
export function stopsPolling(f: ReadFailure): boolean {
  return f.kind === 'SESSION_EXPIRED' || f.kind === 'MFA_REQUIRED' || f.kind === 'FORBIDDEN' || f.kind === 'NOT_FOUND';
}

/** Âge de la dernière lecture réussie (pur) : « il y a 2 min 05 s ». */
export function freshnessLabel(lastOkAt: number | null, now: number): string {
  if (!lastOkAt) return 'aucune lecture réussie';
  const s = Math.max(0, Math.round((now - lastOkAt) / 1000));
  if (s < 5) return 'à l’instant';
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `il y a ${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

/** Lien de reconnexion qui ramène sur la page (et le diagnostic suivi). */
export function reconnectHref(jobId: string | null): string {
  const back = `/admin/diagnostics${jobId ? `?job=${encodeURIComponent(jobId)}` : ''}`;
  return `/login?reason=session_expired&returnUrl=${encodeURIComponent(back)}`;
}

/** Lecture GET (session renouvelée au besoin) ; jamais de redirection automatique. */
export async function boGet<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; failure: ReadFailure }> {
  try {
    const data = await apiClient.fetch<T>(url, { method: 'GET', onAuthFailure: 'silent', dedupe: false, cache: 'no-store' });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, failure: describeReadFailure(e) };
  }
}

/** Écriture BO (POST) par le même client ; en-têtes additionnels (Idempotency-Key). */
export async function boPost<T>(url: string, body?: unknown, headers?: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; failure: ReadFailure; serverMessage: string | null }> {
  try {
    const data = await apiClient.fetch<T>(url, {
      method: 'POST', onAuthFailure: 'silent', ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(headers ? { headers } : {}),
    });
    return { ok: true, data };
  } catch (e) {
    const err = e as ApiClientError;
    return { ok: false, failure: describeReadFailure(e, 'Action'), serverMessage: typeof err?.serverMessage === 'string' ? err.serverMessage : null };
  }
}

/**
 * Téléchargement du ZIP (navigation directe, hors `apiClient`) : la session
 * est renouvelée juste avant si besoin — sinon, après 15 min de suivi, le
 * lien rendait le JSON « MISSING_TOKEN ».
 */
export async function ensureFreshSession(): Promise<boolean> {
  const r = await apiClient.refreshToken().catch(() => false as const);
  return r === true;
}
