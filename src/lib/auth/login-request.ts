/**
 * Requête de connexion avec UNE reprise automatique sur coupure réseau.
 *
 * Constat (recette mobile, 5 oct. 2026) : « Une erreur est survenue. Veuillez
 * réessayer. » à la connexion — `fetch` avait levé (TypeError : « Load
 * failed » sous Safari iOS, réseau mobile qui bascule, mise en veille de
 * l'onglet). Un second appui suffisait : la reprise est faite pour
 * l'utilisateur, une seule fois.
 *
 * Rejouer `POST /api/auth/login` est sans risque :
 *   · les jetons sont sans état (JWT en cookies HttpOnly, aucune table de
 *     sessions ni rotation à usage unique) : une seconde réponse remplace
 *     simplement les cookies de la première ;
 *   · effets de bord idempotents quant au résultat : `last_login_at` mis à
 *     jour, étapes de guide « ignorées » réinitialisées, une ligne
 *     LOGIN_SUCCESS de plus au journal d'activité ;
 *   · au pire une tentative de plus comptée par le limiteur (5 / IP / 15 min)
 *     si la première requête était arrivée — et seulement sur coupure réseau.
 * Aucune reprise sur une RÉPONSE du serveur (401, 429, 5xx) : elle est
 * rendue telle quelle. Une annulation volontaire (AbortError) n'est pas
 * rejouée.
 *
 * Journal côté client (console) : tentative, état `navigator.onLine`, nom et
 * message de l'erreur, durée — JAMAIS le mot de passe ni l'e-mail.
 */

export interface LoginNetworkLog {
  event: 'login.network_error';
  attempt: number;
  willRetry: boolean;
  online: boolean | null;
  errorName: string;
  errorMessage: string;
  elapsedMs: number;
}

export const LOGIN_RETRY_DELAY_MS = 800;

/** Coupure réseau (fetch a levé sans réponse), hors annulation volontaire. */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof Error && e.name === 'TypeError');
}

export async function postLogin(
  credentials: { email: string; password: string },
  deps: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    log?: (entry: LoginNetworkLog) => void;
    online?: () => boolean | null;
  } = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((entry: LoginNetworkLog) => console.warn('[Login]', entry));
  const online = deps.online ?? (() => (typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine : null));

  const call = () => fetchImpl('/api/auth/login', {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });

  const maxAttempts = 2;
  for (let attempt = 1; ; attempt++) {
    const start = Date.now();
    try {
      return await call();
    } catch (e) {
      const network = isNetworkError(e);
      const willRetry = network && attempt < maxAttempts;
      const err = e as { name?: unknown; message?: unknown };
      log({
        event: 'login.network_error',
        attempt,
        willRetry,
        online: online(),
        errorName: String(err?.name ?? 'Error'),
        errorMessage: String(err?.message ?? '').slice(0, 200),
        elapsedMs: Date.now() - start,
      });
      if (!willRetry) throw e;
      await sleep(LOGIN_RETRY_DELAY_MS);
    }
  }
}
