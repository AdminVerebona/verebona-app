import { parseWriteBlocked, notifyWriteBlocked } from '@/lib/write-blocked';
import { clearLegacyAuthStorage } from '@/lib/auth-migration';
import { FRESH_HEADER, isDataMutation, markAccountDataMutated, mutatedSince, resetDataFreshness } from './data-freshness';
import {
  beginSessionTransition,
  getSessionEpoch,
  onSessionTransition,
  type SessionTransitionReason,
} from './session/session-lifecycle';
/**
 * API Client — session par cookies HttpOnly (CDC authentification)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BUDGETS, ANNULATION, NOUVELLES TENTATIVES — APP-PERF-03
 *
 * · Le signal de l'appelant (`signal`) est TOUJOURS respecté : avant l'envoi,
 *   pendant l'attente des en-têtes et pendant la lecture du corps. Il était
 *   auparavant remplacé par celui du délai interne : un écran quitté ne
 *   pouvait pas annuler sa lecture.
 * · Le délai couvre les en-têtes ET la lecture du corps : le minuteur n'est
 *   plus arrêté dès la résolution de `fetch`, avant `response.json()`. Un
 *   corps bloqué (en-têtes rapides, JSON jamais terminé) n'échappe plus au
 *   délai. (Un `JSON.parse` synchrone, lui, ne peut pas être interrompu sur
 *   le même fil : d'où la limite de taille des réponses JSON.)
 * · Chaque classe d'opération a un budget TOTAL (`HTTP_POLICIES`) : le
 *   renouvellement de session et la nouvelle tentative s'y imputent, au lieu
 *   d'ouvrir chacun un nouveau délai complet (15 s + 0,8 s + 15 s).
 * · Seules les lectures (GET) sont relancées automatiquement, une fois, sur
 *   délai ou panne réseau. Jamais une annulation volontaire, jamais une
 *   écriture : un POST n'est pas doublé implicitement. (Le rejeu d'une
 *   requête après un 401 renouvelé n'est pas une nouvelle tentative : le
 *   serveur a refusé la première sans l'exécuter.)
 *
 * Annulation volontaire, délai dépassé et panne réseau donnent trois codes
 * distincts : REQUEST_ABORTED, REQUEST_TIMEOUT, NETWORK_ERROR.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LECTURES PARTAGÉES — APP-PERF-23
 *
 * Avec `dedupe` (implicite avec `useCache`), N lectures GET identiques en cours
 * partagent un seul transport. La clé comprend l'URL, les en-têtes, la
 * politique de cache demandée et l'ÉPOQUE de session : deux contextes ou deux
 * demandes de fraîcheur différentes ne partagent jamais une réponse. Le
 * résultat JSON est partagé, pas le flux `Response`. L'annulation d'un
 * consommateur ne coupe pas les autres ; le transport est annulé quand plus
 * personne ne l'attend. La promesse est retirée en succès comme en erreur.
 * `dedupe: false` force un transport propre (contournement explicite).
 * ══════════════════════════════════════════════════════════════════════════
 */

interface ApiClientOptions extends RequestInit {
  skipAuth?: boolean;
  skipRetry?: boolean;
  useCache?: boolean;
  /**
   * Partager une lecture GET identique déjà en cours. Implicite avec
   * `useCache` ; `false` contourne explicitement le partage.
   */
  dedupe?: boolean;
  /**
   * Session refusée définitivement (renouvellement impossible) :
   * `redirect` (défaut) lance la procédure de sortie unique ; `silent` se
   * contente de lever l'erreur 401, l'appelant décide (magasin de session,
   * droits lus sur une page publique).
   */
  onAuthFailure?: 'redirect' | 'silent';
  /** Classe de budget explicite ; déduite de la méthode et de l'URL sinon. */
  policy?: HttpPolicyName;
}

interface ApiError {
  error: string;
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: Record<string, unknown>,
    public requestId?: string,
    public serverMessage?: string
  ) {
    super(serverMessage || `API Error ${status}: ${code}`);
    this.name = 'ApiClientError';
  }
}

/** Annulation volontaire de l'appelant (écran quitté, nouvelle saisie…). */
export function isRequestAborted(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'REQUEST_ABORTED';
}

// ── Politiques de budget ───────────────────────────────────────────────────

export type HttpPolicyName = 'read' | 'write' | 'long';

export interface HttpPolicy {
  /** Délai d'UNE tentative (en-têtes + corps). */
  attemptTimeoutMs: number;
  /** Budget total de l'opération : tentatives, attente, renouvellement compris. */
  totalBudgetMs: number;
  /** Nouvelles tentatives automatiques sur délai / panne réseau. */
  maxNetworkRetries: number;
  /** Pause avant la nouvelle tentative. */
  retryDelayMs: number;
}

/**
 * Budgets par classe d'opération. Les valeurs reprennent les délais
 * existants (15 s lecture, 20 s écriture, 250 s Prompt Control) : les 6-8 s
 * évoquées dans les audits ne sont pas des objectifs validés et ne seront
 * fixées qu'après mesure. Les envois de fichiers ont leur propre couche
 * (`upload-http.ts`) et le renouvellement de session son délai
 * (`REFRESH_TIMEOUT_MS`).
 */
export const HTTP_POLICIES: Record<HttpPolicyName, HttpPolicy> = {
  // Lecture interactive : 15 s par tentative, une nouvelle tentative, 30 s au total.
  read: { attemptTimeoutMs: 15_000, totalBudgetMs: 30_000, maxNetworkRetries: 1, retryDelayMs: 800 },
  // Écriture : 20 s, jamais relancée ; le budget couvre un renouvellement
  // (10 s) suivi du rejeu.
  write: { attemptTimeoutMs: 20_000, totalBudgetMs: 45_000, maxNetworkRetries: 0, retryDelayMs: 0 },
  // Opération longue : Prompt Control (T5) peut réécrire plusieurs prompts
  // complets, 120 s par modèle côté serveur, repli compris (`t5_modify`). Un
  // délai plus court abandonnait alors que l'écriture dans le brouillon
  // pouvait encore aboutir — l'administrateur voyait une erreur pour une
  // modification pourtant faite.
  long: { attemptTimeoutMs: 250_000, totalBudgetMs: 270_000, maxNetworkRetries: 0, retryDelayMs: 0 },
};

/** Durée minimale qu'il doit rester au budget pour qu'une nouvelle tentative ait un sens. */
const MIN_ATTEMPT_MS = 1_000;

/**
 * Taille maximale d'une réponse JSON annoncée (Content-Length). Le parsing est
 * synchrone et bloque le fil principal : un délai ne peut pas l'interrompre.
 */
export const MAX_JSON_RESPONSE_BYTES = 25 * 1024 * 1024;

export function httpPolicyFor(url: string, method: string, explicit?: HttpPolicyName): HttpPolicy {
  if (explicit) return HTTP_POLICIES[explicit];
  if (url.includes('/api/admin/ai/prompt-control')) return HTTP_POLICIES.long;
  return method === 'GET' ? HTTP_POLICIES.read : HTTP_POLICIES.write;
}

// ── Observation (mesures APP-PERF-03 : durée, tentatives, parsing) ─────────

export interface HttpObservation {
  url: string;
  method: string;
  outcome: 'ok' | 'http_error' | 'aborted' | 'timeout' | 'network' | 'invalid_response';
  status: number;
  attempts: number;
  durationMs: number;
  parseMs: number;
  shared: boolean;
}

let observer: ((o: HttpObservation) => void) | null = null;

/** Branche un collecteur de mesures (télémétrie, recette). `null` le retire. */
export function setHttpObserver(fn: ((o: HttpObservation) => void) | null): void {
  observer = fn;
}

function observe(o: HttpObservation): void {
  if (!observer) return;
  try { observer(o); } catch { /* un collecteur défaillant ne casse pas l'appel */ }
}

// ── Cache des réponses terminées — APP-PERF-22 ─────────────────────────────
//
// ══════════════════════════════════════════════════════════════════════════
// POLITIQUE (navigateur, mémoire de l'onglet, `useCache: true` seulement)
//
//   · CLÉ : version de format + ÉPOQUE de session + méthode + URL complète
//     (paramètres compris). Une réponse d'un autre contexte d'identité
//     (connexion, déconnexion, changement de compte) n'est jamais relue ; le
//     cache est de plus vidé à chaque transition.
//   · DURÉE par ressource (`RESPONSE_CACHE_POLICIES`) : compteurs et
//     résumés 15–30 s, comme leur cache serveur ; liens de fichiers signés
//     60 s ; référentiels et fiches 5 min (inchangé).
//   · INVALIDATION : toute écriture réussie (`apiClient` POST/PUT/PATCH/DELETE)
//     ou événement métier (`data-freshness`) rend périmées TOUTES les
//     réponses antérieures — elles ne sont plus servies, la relecture suivante
//     va au serveur. Pas de liste d'URL à tenir à jour : tout est privé.
//   · FRAÎCHEUR EXPLICITE : `cache: 'no-cache' | 'reload' | 'no-store'`
//     demandé par l'appelant, ou en-tête `x-verebona-fresh: 1`, contourne la
//     lecture du cache. Après une écriture, les lectures des routes qui ont
//     un cache serveur (`SERVER_CACHED_READS`) portent automatiquement
//     `x-verebona-fresh: 1`, une fois : le serveur ne ressert pas non plus
//     l'état d'avant, quelle que soit l'instance qui répond.
//
// Un autre utilisateur du même compte (Premium Duo) qui modifie des données
// n'émet rien dans CET onglet : convergence à l'expiration (≤ 30 s pour les
// compteurs et l'accueil, cache serveur compris).
// ══════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
}

const requestCache = new Map<string, CacheEntry<any>>();
/** Version du format des clés ; la changer rend les anciennes illisibles. */
const RESPONSE_CACHE_VERSION = 'v2';
/** Durée par défaut (fiches, référentiels) — inchangée, jamais allongée. */
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Durée de conservation par ressource (préfixe d'URL, premier trouvé). */
export const RESPONSE_CACHE_POLICIES: ReadonlyArray<{ prefix: string; ttlMs: number }> = [
  { prefix: '/api/to-process', ttlMs: 15_000 },
  { prefix: '/api/v2/to-process', ttlMs: 15_000 },
  { prefix: '/api/dashboard/a-traiter', ttlMs: 15_000 },
  { prefix: '/api/home/summary', ttlMs: 30_000 },
  { prefix: '/api/users/me', ttlMs: 30_000 },
  { prefix: '/api/billing/', ttlMs: 30_000 },
  { prefix: '/api/files/', ttlMs: 60_000 },
];

/** Routes servies depuis un cache serveur, à relire « fraîches » après une écriture. */
export const SERVER_CACHED_READS: ReadonlyArray<string> = [
  '/api/home/summary',
  '/api/dashboard/a-traiter',
  '/api/to-process/suppliers',
  '/api/users/me',
];

/** Durée de conservation d'une réponse pour cette URL. */
export function responseCacheTtl(url: string): number {
  const path = url.split('?')[0];
  return RESPONSE_CACHE_POLICIES.find((p) => path.startsWith(p.prefix))?.ttlMs ?? CACHE_TTL;
}

/** Clé du cache de réponses : format, époque de session, méthode, URL. */
export function responseCacheKey(url: string, method: string, epoch: number = getSessionEpoch()): string {
  return `${RESPONSE_CACHE_VERSION}|e${epoch}|${method}|${url}`;
}

function getCacheKey(url: string, method: string): string {
  return responseCacheKey(url, method);
}

function getCachedData<T>(key: string): T | null {
  const cached = requestCache.get(key);
  if (!cached) return null;

  const now = Date.now();
  // Expirée, ou antérieure à une écriture : n'est plus servie.
  if (now - cached.timestamp > cached.ttlMs || mutatedSince(cached.timestamp)) {
    requestCache.delete(key);
    return null;
  }

  return cached.data as T;
}

function setCachedData<T>(key: string, url: string, data: T, timestamp: number): void {
  // Réponse partie AVANT une écriture survenue entre-temps : non conservée.
  if (mutatedSince(timestamp)) return;
  requestCache.set(key, {
    data,
    timestamp,
    ttlMs: responseCacheTtl(url),
  });
}

/** L'appelant demande-t-il explicitement un état frais ? */
function wantsFresh(options: ApiClientOptions): boolean {
  if (options.cache === 'no-cache' || options.cache === 'reload' || options.cache === 'no-store') return true;
  if (!options.headers) return false;
  return new Headers(options.headers).get(FRESH_HEADER) === '1';
}

/** Dernière lecture aboutie de chaque route à cache serveur (début de requête). */
const lastServerCachedRead = new Map<string, number>();

function serverCachedPath(url: string): string | null {
  const path = url.split('?')[0];
  return SERVER_CACHED_READS.find((p) => path === p) ?? null;
}

/**
 * Après une écriture, la première relecture d'une route à cache serveur
 * demande un état frais (`x-verebona-fresh: 1`). Rend les options à utiliser.
 */
function withFreshnessAfterMutation(url: string, options: ApiClientOptions): ApiClientOptions {
  const path = serverCachedPath(url);
  if (!path) return options;
  const last = lastServerCachedRead.get(path) ?? 0;
  if (!mutatedSince(last)) return options;
  const headers = new Headers(options.headers);
  if (headers.get(FRESH_HEADER) === '1') return options;
  headers.set(FRESH_HEADER, '1');
  const plain: Record<string, string> = {};
  headers.forEach((v, k) => { plain[k] = v; });
  return { ...options, headers: plain };
}

// ── Annulation combinée : appelant + délai ─────────────────────────────────

type AbortCause = 'caller' | 'timeout';

interface AttemptSignal {
  signal: AbortSignal;
  cause: () => AbortCause | null;
  dispose: () => void;
}

/**
 * Signal d'une tentative : abandonné par l'appelant OU par le délai, avec la
 * cause retenue. Sans `AbortSignal.any` (navigateurs ciblés : iOS 16 ne l'a pas).
 */
function attemptSignal(caller: AbortSignal | null | undefined, timeoutMs: number): AttemptSignal {
  const controller = new AbortController();
  let cause: AbortCause | null = null;
  const abort = (c: AbortCause) => {
    if (cause) return;
    cause = c;
    controller.abort();
  };
  const onCallerAbort = () => abort('caller');
  if (caller) {
    if (caller.aborted) abort('caller');
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = cause ? null : setTimeout(() => abort('timeout'), Math.max(0, timeoutMs));
  return {
    signal: controller.signal,
    cause: () => cause,
    dispose: () => {
      if (timer) clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/**
 * Attend `p`, mais rejette dès que `signal` est abandonné. Sert à la lecture
 * du corps : selon l'implémentation de `fetch`, l'abandon n'interrompt pas
 * toujours un `response.json()` déjà commencé.
 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** Pause interrompue par l'annulation de l'appelant. */
function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortedClientError(): ApiClientError {
  return new ApiClientError(0, 'REQUEST_ABORTED', {}, undefined, 'Requête annulée.');
}

function timeoutClientError(detail?: unknown): ApiClientError {
  return new ApiClientError(
    0, 'REQUEST_TIMEOUT', detail ? { originalError: String(detail) } : {}, undefined,
    'Délai de connexion dépassé. Vérifiez votre réseau.',
  );
}

// ── Codes d'authentification (APP-PERF-20) ─────────────────────────────────

/**
 * 401 qui ne relèvent PAS de la session : un mot de passe saisi faux n'est
 * pas une session expirée. Les renouveler faisait tourner les jetons pour rien.
 */
const NON_RENEWABLE_401_CODES = new Set(['INVALID_CREDENTIALS', 'INVALID_CURRENT_PASSWORD']);

function bodyCode(body: any): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  return (typeof body.code === 'string' && body.code) || (typeof body.error === 'string' && body.error) || undefined;
}

// ── Lectures partagées en cours ────────────────────────────────────────────

interface Inflight {
  promise: Promise<unknown>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

const inflight = new Map<string, Inflight>();

function headersKey(headers: HeadersInit | undefined): string {
  if (!headers) return '';
  const entries: [string, string][] = [];
  new Headers(headers).forEach((v, k) => entries.push([k.toLowerCase(), v]));
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
}

/** Clé de partage : URL, en-têtes, fraîcheur demandée, traitement d'auth, époque de session. */
export function dedupeKey(url: string, options: ApiClientOptions, epoch: number = getSessionEpoch()): string {
  return [
    `e${epoch}`,
    'GET',
    url,
    headersKey(options.headers),
    `cache=${options.cache ?? 'no-store'}`,
    `auth=${options.skipAuth ? 'skip' : (options.onAuthFailure ?? 'redirect')}`,
    `retry=${options.skipRetry ? 0 : 1}`,
    `policy=${options.policy ?? ''}`,
  ].join('|');
}

// ── Renouvellement et sortie ───────────────────────────────────────────────

/** Promesse de renouvellement en cours (CDC §7.3). */
let pendingRefresh: Promise<boolean | 'server_error'> | null = null;

/**
 * Délai maximal du renouvellement de session.
 *
 * Tous les appels qui reçoivent un 401 attendent la MÊME promesse de
 * renouvellement (ci-dessus). Sans délai, une requête `/api/auth/refresh`
 * restée sans réponse (preprod, 2 oct. 2026 : « refresh » en pending)
 * bloquait indéfiniment toutes les lectures de l'écran — accueil, biens,
 * « À traiter », assistant — sans erreur ni redirection. Au-delà de ce
 * délai, l'échec est traité comme transitoire (`server_error`) : pas de
 * déconnexion, et le prochain appel retente un renouvellement.
 */
export const REFRESH_TIMEOUT_MS = 10_000;

/** Délai de l'appel `/api/auth/logout` (APP-PERF-21). */
export const LOGOUT_TIMEOUT_MS = 5_000;
/** Délai de la désinscription push avant la déconnexion (APP-PERF-21). */
export const PUSH_UNSUBSCRIBE_TIMEOUT_MS = 3_000;

/**
 * Résultat côté serveur d'une déconnexion :
 *   · `revoked`         : cookies effacés ET session révoquée (ou rien à révoquer) ;
 *   · `cookies-cleared` : cookies effacés, révocation non confirmée ;
 *   · `failed`          : réponse en erreur ou réseau — rien n'est garanti ;
 *   · `timeout`         : pas de réponse dans LOGOUT_TIMEOUT_MS — rien n'est garanti.
 */
export type ServerSignOutOutcome = 'revoked' | 'cookies-cleared' | 'failed' | 'timeout';

export interface SignOutResult {
  server: ServerSignOutOutcome;
  push: 'done' | 'skipped' | 'timeout' | 'failed';
}

let pendingSignOut: Promise<SignOutResult> | null = null;
/** Une seule transition vers la connexion par chargement de page. */
let authFailureInProgress = false;

/**
 * Clés navigateur qui portent des données du compte (identifiants de fil de
 * l'assistant, biens récemment consultés). Effacées à la sortie, comme les
 * anciennes clés d'authentification. Les préférences d'affichage restent.
 */
const PRIVATE_STORAGE_KEYS = ['verebona:conversationId', 'verebona:recent-assets'];

function navigate(target: string): void {
  if (typeof window === 'undefined') return;
  window.location.href = target;
}

// Toute transition de session vide les réponses en cache et abandonne les
// lectures partagées : rien de l'ancien contexte ne doit être resservi.
onSessionTransition(() => {
  requestCache.clear();
  lastServerCachedRead.clear();
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
});

export const apiClient = {
  async fetch<T = unknown>(
    url: string,
    options: ApiClientOptions = {}
  ): Promise<T> {
    const method = (options.method || 'GET').toUpperCase();
    const { useCache = false } = options;

    if (method === 'GET') {
      // Fraîcheur demandée par l'appelant : le cache n'est pas lu (APP-PERF-22).
      if (useCache && !wantsFresh(options)) {
        const cachedData = getCachedData<T>(getCacheKey(url, method));
        if (cachedData) {
          return cachedData;
        }
      }
      // Après une écriture, la route à cache serveur est relue fraîche.
      options = withFreshnessAfterMutation(url, options);
    }

    if (method === 'GET' && !options.body && (options.dedupe ?? useCache)) {
      return this.sharedGet<T>(url, options);
    }

    return this.request<T>(url, options, options.signal ?? null, false);
  },

  /**
   * Lecture partagée : un transport par clé, un abonnement par appelant.
   * @internal
   */
  sharedGet<T>(url: string, options: ApiClientOptions): Promise<T> {
    const caller = options.signal ?? null;
    if (caller?.aborted) return Promise.reject(abortedClientError());

    const key = dedupeKey(url, options);
    let entry = inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      // Le transport ne dépend d'AUCUN appelant : chacun garde sa propre annulation.
      const { signal: _ignored, ...rest } = options;
      const created: Inflight = { controller, subscribers: 0, settled: false, promise: Promise.resolve() };
      created.promise = this.request<T>(url, rest, controller.signal, true).finally(() => {
        created.settled = true;
        if (inflight.get(key) === created) inflight.delete(key);
      });
      // Transport abandonné faute d'abonnés : rejet attendu, sans écouteur.
      created.promise.catch(() => undefined);
      inflight.set(key, created);
      entry = created;
    }

    const shared = entry;
    shared.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const leave = () => {
        shared.subscribers -= 1;
        if (shared.subscribers <= 0 && !shared.settled) {
          shared.controller.abort();
          if (inflight.get(key) === shared) inflight.delete(key);
        }
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        leave();
        reject(abortedClientError());
      };
      caller?.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (value) => {
          if (done) return;
          done = true;
          caller?.removeEventListener('abort', onAbort);
          shared.subscribers -= 1;
          // Un flux `Response` ne se lit qu'une fois : chacun reçoit sa copie.
          resolve((value instanceof Response ? value.clone() : value) as T);
        },
        (error) => {
          if (done) return;
          done = true;
          caller?.removeEventListener('abort', onAbort);
          shared.subscribers -= 1;
          reject(error);
        },
      );
    });
  },

  /**
   * Exécution d'une requête dans son budget : tentatives, renouvellement de
   * session et nouvelle tentative éventuelle.
   * @internal
   */
  async request<T>(url: string, options: ApiClientOptions, signal: AbortSignal | null, shared: boolean): Promise<T> {
    const { skipAuth, skipRetry, useCache = false, dedupe: _dedupe, onAuthFailure = 'redirect', policy: policyName, signal: _signal, ...fetchOptions } = options;
    const method = (options.method || 'GET').toUpperCase();
    const policy = httpPolicyFor(url, method, policyName);

    // CDC §10.2 : la session voyage par cookies HttpOnly, jamais par un jeton lu en JS.
    const config: RequestInit = {
      cache: 'no-store',
      ...fetchOptions,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      },
    };

    const startedAt = Date.now();
    const deadline = startedAt + policy.totalBudgetMs;
    // Une réponse arrivée après une transition de session n'alimente pas le cache.
    const epochAtStart = getSessionEpoch();
    let attempts = 0;
    let networkRetries = 0;
    let authReplayed = false;
    let parseMs = 0;
    let lastStatus = 0;
    const allowAuthRetry = !skipRetry && !skipAuth;
    const allowNetworkRetry = !skipRetry && method === 'GET';
    const report = (outcome: HttpObservation['outcome']) => observe({
      url, method, outcome, status: lastStatus, attempts, durationMs: Date.now() - startedAt, parseMs, shared,
    });

    while (true) {
      if (signal?.aborted) { report('aborted'); throw abortedClientError(); }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { report('timeout'); throw timeoutClientError(); }

      attempts += 1;
      const attempt = attemptSignal(signal, Math.min(policy.attemptTimeoutMs, remaining));
      let response: Response | null = null;
      try {
        response = await fetch(url, { ...config, signal: attempt.signal });
        lastStatus = response.status;

        if ((response.status === 401 || response.status === 403) && allowAuthRetry && !authReplayed) {
          // Try refresh for both 401 (expired token) and 403 with INSUFFICIENT_PERMISSIONS
          // (stale role in JWT — refresh reads fresh role from DB)
          const errorBody = await untilAborted(response.clone().json().catch(() => ({})), attempt.signal) as any;
          const code = bodyCode(errorBody);
          const isStaleRole = response.status === 403 && (
            errorBody.error === 'INSUFFICIENT_PERMISSIONS' || errorBody.code === 'INSUFFICIENT_PERMISSIONS'
          );
          const renewable401 = response.status === 401 && !(code && NON_RENEWABLE_401_CODES.has(code));
          if (renewable401 || isStaleRole) {
            // Le renouvellement a son propre délai (REFRESH_TIMEOUT_MS) mais
            // s'impute au budget de l'opération : l'échéance ne bouge pas.
            attempt.dispose();
            const refreshed = await untilAborted(this.refreshToken(), signal ?? new AbortController().signal)
              .catch((e) => { if ((e as Error)?.name === 'AbortError') throw abortedClientError(); throw e; });
            if (refreshed === true) {
              authReplayed = true;
              continue;
            }
            // Server error during refresh — don't log out, bubble up the original error
            if (refreshed === 'server_error') {
              report('http_error');
              throw new ApiClientError(503, 'SERVICE_UNAVAILABLE', {}, undefined, 'Service temporairement indisponible');
            }
            if (onAuthFailure !== 'silent') void this.handleAuthFailure();
            report('http_error');
            throw new ApiClientError(response.status, 'UNAUTHORIZED', {}, errorBody.requestId);
          } else if (response.status === 403) {
            // Refus de droits (essai terminé, quota…) sur une ACTION de
            // l'utilisateur : la fenêtre partagée s'ouvre, quel que soit l'écran.
            //
            // ⚠️ Jamais sur une lecture (GET). « Mon compte » lit le jeton
            // d'agenda au chargement ; un compte sans Premium reçoit un 403
            // `PREMIUM_REQUIRED`, et la fenêtre « Fonctionnalité Premium »
            // s'ouvrait à la simple visite de la page, sans aucun clic.
            // L'appelant reçoit toujours l'erreur, pour interrompre son traitement.
            const refus = method === 'GET' ? null : parseWriteBlocked(errorBody);
            if (refus) notifyWriteBlocked(refus);
            report('http_error');
            throw new ApiClientError(
              response.status,
              errorBody.code ?? errorBody.error ?? 'FORBIDDEN',
              errorBody.details,
              errorBody.requestId,
              errorBody.message ?? errorBody.error
            );
          }
          // 401 non renouvelable (mot de passe saisi faux…) : erreur ordinaire ci-dessous.
        }

        if (!response.ok) {
          const errorData: ApiError = await untilAborted(response.json(), attempt.signal).catch((e) => {
            if (attempt.cause()) throw e;
            return { error: 'Unknown error', code: 'UNKNOWN_ERROR', message: response!.statusText };
          });

          report('http_error');
          throw new ApiClientError(
            response.status,
            errorData.code ?? errorData.error ?? 'UNKNOWN_ERROR',
            errorData.details,
            errorData.requestId,
            errorData.message ?? errorData.error
          );
        }

        // Écriture réussie : les écrans qui résument le compte (accueil)
        // demanderont un état frais au prochain chargement.
        // Les réponses antérieures en cache deviennent périmées (`mutatedSince`).
        if (isDataMutation(method, url)) {
          markAccountDataMutated();
          // Mascotte d'accueil : un changement validé prépare sa prochaine prise
          // de parole (CDC Mascotte RUN-007) — écouté par DashboardLayout.
          if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('verebona:data-mutated'));
        }

        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const announced = Number(response.headers.get('content-length'));
          if (Number.isFinite(announced) && announced > MAX_JSON_RESPONSE_BYTES) {
            response.body?.cancel().catch(() => undefined);
            report('invalid_response');
            throw new ApiClientError(0, 'RESPONSE_TOO_LARGE', { bytes: announced }, undefined, 'Réponse trop volumineuse.');
          }
          // Le corps est lu SOUS le délai de la tentative (minuteur actif).
          const parseStart = Date.now();
          const data = await untilAborted(response.json(), attempt.signal);
          parseMs += Date.now() - parseStart;

          if (method === 'GET') {
            const path = serverCachedPath(url);
            if (path) lastServerCachedRead.set(path, Math.max(lastServerCachedRead.get(path) ?? 0, startedAt));
          }
          if (useCache && method === 'GET' && getSessionEpoch() === epochAtStart) {
            setCachedData(responseCacheKey(url, method, epochAtStart), url, data, startedAt);
          }

          report('ok');
          return data;
        }

        report('ok');
        return response as T;
      } catch (error) {
        if (error instanceof ApiClientError) {
          throw error;
        }

        const cause = attempt.cause();
        if (cause === 'caller') {
          response?.body?.cancel().catch(() => undefined);
          report('aborted');
          throw abortedClientError();
        }
        const isTimeout = cause === 'timeout';
        if (isTimeout) response?.body?.cancel().catch(() => undefined);
        // `fetch` lève un TypeError sur une panne réseau ; un JSON invalide
        // lève un SyntaxError : ce n'est pas le réseau, inutile de relancer.
        const isNetwork = !isTimeout && error instanceof TypeError;
        if (!isTimeout && !isNetwork) {
          report('invalid_response');
          throw new ApiClientError(0, 'INVALID_RESPONSE', { originalError: String(error) }, undefined, 'Réponse du serveur illisible.');
        }

        // Timeout or network error on GET → retry once after short delay,
        // si le budget total le permet encore.
        if (allowNetworkRetry && networkRetries < policy.maxNetworkRetries
          && deadline - Date.now() > policy.retryDelayMs + MIN_ATTEMPT_MS) {
          networkRetries += 1;
          attempt.dispose();
          try {
            await pause(policy.retryDelayMs, signal);
          } catch {
            report('aborted');
            throw abortedClientError();
          }
          continue;
        }

        report(isTimeout ? 'timeout' : 'network');
        if (isTimeout) throw timeoutClientError(error);
        throw new ApiClientError(
          0,
          'NETWORK_ERROR',
          { originalError: String(error) },
          undefined,
          'Erreur réseau. Vérifiez votre connexion.'
        );
      } finally {
        attempt.dispose();
      }
    }
  },

  async refreshToken(): Promise<boolean | 'server_error'> {
    // CDC §7.3 : une seule requete de renouvellement a la fois. Les appels
    // concurrents partagent la meme promesse plutot que de declencher
    // plusieurs rotations, ce qui invaliderait les jetons les uns apres
    // les autres et deconnecterait l'utilisateur.
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
      const attempt = attemptSignal(null, REFRESH_TIMEOUT_MS);
      try {
        // Le jeton de renouvellement vit dans un cookie HttpOnly : le serveur
        // le lit lui-meme, le front n'a rien a transmettre (CDC §7.2).
        const response = await fetch('/api/auth/refresh', {
          credentials: 'include',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: attempt.signal,
        });

        // Server error (5xx / 503) — don't treat as auth failure, could be transient
        if (response.status >= 500) {
          return 'server_error';
        }

        if (response.ok) {
          // Corps lu sous le même délai ; son contenu n'est pas utilisé
          // (les jetons voyagent par cookies).
          await untilAborted(response.json().catch(() => null), attempt.signal);
          return true;
        }

        return false;
      } catch {
        // Network error or timeout — treat as transient server error, don't log out
        return 'server_error';
      } finally {
        attempt.dispose();
      }
    })();
    try { return await pendingRefresh; } finally { pendingRefresh = null; }
  },

  /**
   * Appel serveur de déconnexion, borné à LOGOUT_TIMEOUT_MS. Distingue la
   * révocation effective, le simple effacement des cookies et l'échec : un
   * nettoyage JavaScript n'efface pas un cookie HttpOnly et ne révoque rien.
   * @internal
   */
  async requestServerLogout(): Promise<ServerSignOutOutcome> {
    const attempt = attemptSignal(null, LOGOUT_TIMEOUT_MS);
    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        signal: attempt.signal,
      });
      if (!res.ok) return 'failed';
      const body = await untilAborted(res.json().catch(() => ({})), attempt.signal) as { revocation?: string };
      return body?.revocation === 'revoked' || body?.revocation === 'none' ? 'revoked' : 'cookies-cleared';
    } catch {
      return attempt.cause() === 'timeout' ? 'timeout' : 'failed';
    } finally {
      attempt.dispose();
    }
  },

  /**
   * Nettoyage local d'une fin de session : nouvelle époque (caches HTTP,
   * lectures partagées, identité et droits en mémoire purgés), anciennes clés
   * d'authentification et données privées du navigateur effacées.
   */
  purgeLocalSession(reason: SessionTransitionReason): void {
    requestCache.clear();
    beginSessionTransition(reason);
    clearLegacyAuthStorage();
    if (typeof window === 'undefined') return;
    for (const key of PRIVATE_STORAGE_KEYS) {
      try { window.localStorage.removeItem(key); } catch { /* stockage indisponible */ }
    }
  },

  /** Une déconnexion est-elle en cours ? */
  isSigningOut(): boolean {
    return pendingSignOut !== null;
  },

  /**
   * Déconnexion demandée par l'utilisateur — procédure UNIQUE (APP-PERF-21).
   *
   * 1. nettoyage local immédiat (aucune réponse tardive ne repeuple l'interface) ;
   * 2. désinscription push de l'appareil, bornée (elle a besoin du cookie,
   *    donc AVANT l'appel de déconnexion) ;
   * 3. déconnexion serveur, bornée, dont le résultat réel est rendu.
   *
   * Les appels concurrents partagent la même procédure. La navigation est
   * laissée à l'appelant : en cas d'échec serveur, il propose de réessayer
   * plutôt que d'annoncer une révocation non obtenue.
   */
  signOut(opts: { unsubscribePush?: (signal: AbortSignal) => Promise<void> } = {}): Promise<SignOutResult> {
    if (pendingSignOut) return pendingSignOut;
    pendingSignOut = (async (): Promise<SignOutResult> => {
      this.purgeLocalSession('logout');

      let push: SignOutResult['push'] = 'skipped';
      if (opts.unsubscribePush) {
        const attempt = attemptSignal(null, PUSH_UNSUBSCRIBE_TIMEOUT_MS);
        try {
          await untilAborted(opts.unsubscribePush(attempt.signal), attempt.signal);
          push = 'done';
        } catch {
          push = attempt.cause() === 'timeout' ? 'timeout' : 'failed';
        } finally {
          attempt.dispose();
        }
      }

      const server = await this.requestServerLogout();
      return { server, push };
    })();
    const current = pendingSignOut;
    return current.finally(() => { if (pendingSignOut === current) pendingSignOut = null; });
  },

  /**
   * Session definitivement expiree (CDC cookies §6.3).
   *
   * Le renouvellement a echoue : on vide l'etat en memoire, on invalide la
   * session cote serveur pour que les cookies soient effaces, puis on
   * redirige vers la connexion avec un message neutre. La page en cours
   * (chemin ET paramètres) est conservee pour y revenir apres reconnexion.
   *
   * Procédure unique (APP-PERF-21) : plusieurs consommateurs en erreur en
   * même temps ne déclenchent qu'une sortie et une navigation. L'appel de
   * déconnexion est borné (LOGOUT_TIMEOUT_MS) : la redirection a lieu quel
   * qu'en soit le résultat, sans jamais rester en attente.
   *
   * Aucune boucle possible : la redirection est ignoree si l'on se trouve
   * deja sur une page d'authentification.
   */
  handleAuthFailure(opts: { code?: string } = {}): Promise<void> {
    requestCache.clear();
    pendingRefresh = null;

    if (typeof window === 'undefined') return Promise.resolve();

    // Evite toute boucle de redirection sur les pages d'authentification.
    const path = window.location.pathname;
    if (path.startsWith('/login') || path.startsWith('/signup')) return Promise.resolve();
    if (authFailureInProgress) return Promise.resolve();
    authFailureInProgress = true;

    // Purge des eventuelles traces d'authentification et des etats de session.
    this.purgeLocalSession('auth-failure');

    const returnUrl = `${window.location.pathname}${window.location.search}`;
    const target = opts.code === 'ACCOUNT_SUSPENDED'
      ? '/login?error=ACCOUNT_SUSPENDED'
      : `/login?expired=1&returnUrl=${encodeURIComponent(returnUrl)}`;

    // Invalidation cote serveur : effacer le cookie sans revoquer la session
    // ne suffit pas (CDC §8). Bornée : la redirection suit dans tous les cas.
    return this.requestServerLogout().then(() => { navigate(target); });
  },

  get<T = unknown>(url: string, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, { ...options, method: 'GET' });
  },

  post<T = unknown>(url: string, data?: unknown, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  put<T = unknown>(url: string, data?: unknown, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  patch<T = unknown>(url: string, data?: unknown, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  delete<T = unknown>(url: string, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, { ...options, method: 'DELETE' });
  },

  clearCache(): void {
    requestCache.clear();
  },

  invalidateCache(url: string): void {
    requestCache.delete(getCacheKey(url, 'GET'));
  },
};

/** Réservé aux tests : remet à zéro l'état du module. */
export function __resetApiClientForTests(): void {
  requestCache.clear();
  lastServerCachedRead.clear();
  resetDataFreshness();
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
  pendingRefresh = null;
  pendingSignOut = null;
  authFailureInProgress = false;
  observer = null;
}

/** Réservé aux tests : nombre de lectures partagées en cours. */
export function __inflightCountForTests(): number {
  return inflight.size;
}

export function getApiErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Une erreur est survenue';
}

export { ApiClientError };
export type { ApiClientOptions };
