/**
 * Journal serveur du diagnostic de connexion — lot 103A.
 *
 * Une ligne `[auth.diag] {…}` par étape (connexion, renouvellement,
 * déconnexion, appel d'API refusé) qui porte un identifiant de tentative
 * (`login-diagnostics.ts`). Consultable dans les journaux Scalingo
 * (`scalingo logs` / tableau de bord) en cherchant l'identifiant affiché sur
 * le téléphone. Compatible Edge (middleware) : aucune dépendance Node.
 *
 * Contenu : étape, identifiant de tentative, statut HTTP, code métier,
 * plateforme déclarée (IOS / ANDROID / WEB / PWA), version et build de l'app,
 * chemin. JAMAIS : e-mail, mot de passe, jeton, cookie, adresse IP.
 */
import { readClientContext } from '@/lib/mobile/client-context';
import { readLoginAttemptId } from './login-diagnostics';

export type AuthDiagStep = 'login' | 'refresh' | 'logout' | 'api_rejected' | 'oauth_exchange';

export interface AuthDiagEntry {
  step: AuthDiagStep;
  attemptId: string | null;
  status: number;
  code: string | null;
  client: string;
  appVersion: string | null;
  build: string | null;
  path: string;
  /** Déconnexion : origine déclarée par le client (utilisateur, refus d'authentification). */
  trigger?: string | null;
}

interface RequestLike {
  headers: { get(name: string): string | null };
  nextUrl?: { pathname: string };
  url?: string;
}

function pathOf(request: RequestLike): string {
  if (request.nextUrl?.pathname) return request.nextUrl.pathname;
  try { return new URL(request.url ?? '', 'http://x').pathname; } catch { return ''; }
}

/** Entrée de journal d'une étape (pure, testée). */
export function authDiagEntry(
  request: RequestLike, step: AuthDiagStep, status: number, code: string | null, extra: { trigger?: string | null } = {},
): AuthDiagEntry {
  const ctx = readClientContext(request);
  const rawClient = request.headers.get('x-verebona-client')?.trim().toUpperCase() ?? '';
  return {
    step,
    attemptId: readLoginAttemptId(request.headers),
    status,
    code: code && /^[A-Z0-9_]{2,64}$/.test(code) ? code : null,
    client: ctx.declared ? ctx.client : (rawClient === 'PWA' ? 'PWA' : 'WEB'),
    appVersion: ctx.appVersion,
    build: ctx.build,
    path: pathOf(request),
    ...(extra.trigger !== undefined ? { trigger: extra.trigger } : {}),
  };
}

/** Écrit la ligne de journal (jamais bloquant). */
export function logAuthDiag(entry: AuthDiagEntry): void {
  try {
    const line = `[auth.diag] ${JSON.stringify(entry)}`;
    if (entry.status >= 400) console.warn(line);
    else console.info(line);
  } catch { /* le diagnostic ne casse jamais la réponse */ }
}

/** Code métier d'une réponse JSON (lecture d'une copie ; null si illisible). */
export async function responseCode(res: Response): Promise<string | null> {
  if (res.status < 400) return null;
  try {
    const body = await res.clone().json() as { code?: unknown };
    return typeof body?.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

/**
 * Exécute une route d'authentification et journalise son issue. `always` :
 * journaliser même sans identifiant de tentative (connexion) ; sinon,
 * seulement les appels corrélés (renouvellement, déconnexion).
 */
export async function withAuthDiag<R extends Response>(
  request: RequestLike, step: AuthDiagStep, run: () => Promise<R>, opts: { always?: boolean; trigger?: string | null } = {},
): Promise<R> {
  const res = await run();
  try {
    if (opts.always || readLoginAttemptId(request.headers)) {
      logAuthDiag(authDiagEntry(request, step, res.status, await responseCode(res), opts.trigger !== undefined ? { trigger: opts.trigger } : {}));
    }
  } catch { /* jamais bloquant */ }
  return res;
}
