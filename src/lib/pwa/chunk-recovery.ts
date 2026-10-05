/**
 * Reprise PWA après erreur de chunk ou déploiement — APP-PERF-10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT
 *
 * Trois chemins (erreur globale, rejet non géré, écran d'erreur de route)
 * rechargeaient la page à CHAQUE erreur de chunk, après avoir vidé TOUS les
 * caches de l'origine. Aucune mémoire d'une tentative précédente : un chunk
 * durablement absent (404 permanent) ou un réseau coupé donnaient une boucle
 * de rechargements, en perdant au passage une saisie ou un envoi en cours.
 * Le service worker, lui, ne signalait que les rejets réseau : un 404 HTTP
 * n'est pas un rejet, il passait inaperçu.
 *
 * LA RÈGLE
 *
 *   · Trois causes distinctes, trois reprises distinctes :
 *       - `missing`     : ressource absente (404/410 signalé par le SW, ou
 *                         erreur de chunk en ligne) — l'onglet tourne sur une
 *                         version retirée par un déploiement ;
 *       - `network`     : hors ligne ou transport en échec — recharger ne
 *                         servirait à rien, on attend le réseau ;
 *       - `new-version` : une nouvelle version est disponible (404 vu par le
 *                         SW sur un préchargement) — proposée, jamais imposée.
 *   · Au plus UNE tentative automatique par incident, mémorisée dans
 *     `sessionStorage` (survit au rechargement, propre à l'onglet) pendant
 *     `RECOVERY_WINDOW_MS`. Au-delà : reprise explicite (bouton).
 *     Stockage indisponible → jamais de rechargement automatique (on ne peut
 *     pas prouver qu'il n'y a pas de boucle).
 *   · Jamais de rechargement automatique pendant une saisie ou un envoi :
 *     les « gardes » (`registerReloadBlocker`) le bloquent et la reprise est
 *     proposée avec un avertissement.
 *   · Plus de purge des caches : les chunks ne sont JAMAIS dans le cache du
 *     SW (réseau seul) ; les fichiers hashés restent cacheables par HTTP —
 *     un nom de fichier ne change pas de contenu, l'échec vient d'un fichier
 *     retiré, pas d'un fichier périmé.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type RecoveryCause = 'missing' | 'network' | 'new-version';

export type RecoveryDecision =
  | { action: 'reload'; cause: RecoveryCause }
  | { action: 'prompt'; cause: RecoveryCause; blockedBy: string[]; alreadyRetried: boolean }
  | { action: 'offline'; cause: 'network' };

export interface RecoveryRecord {
  /** Instant de la tentative automatique (ms epoch). */
  at: number;
  /** Adresse visée au moment de l'incident. */
  href: string;
}

export const RECOVERY_STORAGE_KEY = 'verebona:pwa-recovery';
/** Fenêtre pendant laquelle une seconde erreur ne relance PAS automatiquement. */
export const RECOVERY_WINDOW_MS = 10 * 60_000;
/** Validité d'un signalement du service worker pour classer une erreur. */
export const SW_HINT_TTL_MS = 15_000;

const CHUNK_PATTERNS = ['Failed to load chunk', 'Loading chunk', 'Loading CSS chunk', 'dynamically imported module', 'Importing a module script failed'];

/** Erreur de chargement de code (chunk JS/CSS ou import dynamique). */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'string') return CHUNK_PATTERNS.some((p) => error.includes(p));
  if (typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown };
  if (e.name === 'ChunkLoadError') return true;
  return typeof e.message === 'string' && CHUNK_PATTERNS.some((p) => (e.message as string).includes(p));
}

// ── Stockage de la tentative ───────────────────────────────────────────────

export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionStore(): RecoveryStorage | null {
  try {
    const s = globalThis.sessionStorage;
    if (!s) return null;
    // Accès effectif : certains navigateurs lèvent seulement à l'écriture.
    const probe = '__verebona_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function readRecoveryRecord(storage: RecoveryStorage | null): RecoveryRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as RecoveryRecord;
    return typeof r?.at === 'number' ? r : null;
  } catch {
    return null;
  }
}

function writeRecoveryRecord(storage: RecoveryStorage, record: RecoveryRecord): boolean {
  try {
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

// ── Décision (pure) ────────────────────────────────────────────────────────

export interface DecideInput {
  cause: RecoveryCause;
  online: boolean;
  now: number;
  /** Stockage de session ; `null` = indisponible. */
  storage: RecoveryStorage | null;
  /** Raisons de ne pas recharger seul (saisie, envoi en cours). */
  blockedBy: string[];
}

export function decideRecovery({ cause, online, now, storage, blockedBy }: DecideInput): RecoveryDecision {
  if (cause === 'network' || !online) return { action: 'offline', cause: 'network' };
  if (cause === 'new-version') return { action: 'prompt', cause, blockedBy, alreadyRetried: false };

  const record = readRecoveryRecord(storage);
  const alreadyRetried = !!record && now - record.at < RECOVERY_WINDOW_MS;
  if (alreadyRetried || !storage || blockedBy.length > 0) {
    return { action: 'prompt', cause, blockedBy, alreadyRetried };
  }
  return { action: 'reload', cause };
}

// ── Gardes contre le rechargement ──────────────────────────────────────────

const blockers = new Map<string, () => boolean>();

/**
 * Déclare une raison de ne pas recharger automatiquement (envoi en cours…).
 * Retourne la fonction de retrait.
 */
export function registerReloadBlocker(name: string, isBlocking: () => boolean): () => void {
  blockers.set(name, isBlocking);
  return () => { if (blockers.get(name) === isBlocking) blockers.delete(name); };
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'number', 'search', 'password', 'date', 'datetime-local', 'time', 'month', 'week']);

/**
 * Saisie en cours dans la page : champ éditable non vide ayant le focus, ou champ texte
 * non vide dans une fenêtre / un tiroir ouvert (`role="dialog"` : création,
 * édition, dépôt). Les champs marqués `data-reload-safe` sont ignorés. Les
 * formulaires de page pré-remplis (réglages) ne comptent que s'ils ont le
 * focus. Prudent par construction : au pire, la reprise est proposée au lieu
 * d'être automatique.
 */
export function hasPendingInput(doc: Document | undefined = globalThis.document): boolean {
  if (!doc) return false;
  const active = doc.activeElement as HTMLElement | null;
  if (active && !active.closest?.('[data-reload-safe]')) {
    if (active.isContentEditable && (active.textContent ?? '').trim() !== '') return true;
    const champ = active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((active as HTMLInputElement).type));
    if (champ && ((active as HTMLInputElement).value ?? '').trim() !== '') return true;
  }
  const fields = doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[role="dialog"] input, [role="dialog"] textarea');
  for (const f of Array.from(fields)) {
    if (f.disabled || f.readOnly) continue;
    if (f.tagName === 'INPUT' && !TEXT_INPUT_TYPES.has((f as HTMLInputElement).type)) continue;
    if (f.closest?.('[data-reload-safe]')) continue;
    if (f.value && f.value.trim() !== '') return true;
  }
  return false;
}

export function currentBlockers(): string[] {
  const raisons: string[] = [];
  try { if (hasPendingInput()) raisons.push('saisie'); } catch { /* DOM indisponible */ }
  for (const [name, isBlocking] of blockers) {
    try { if (isBlocking()) raisons.push(name); } catch { /* garde défaillante : ignorée */ }
  }
  return raisons;
}

// ── Coordination (état partagé de l'onglet) ────────────────────────────────

export interface RecoveryState {
  decision: RecoveryDecision | null;
}

type Listener = (s: RecoveryState) => void;
let state: RecoveryState = { decision: null };
const listeners = new Set<Listener>();
let swHint: { cause: 'missing' | 'network'; at: number } | null = null;
let reloading = false;

function setState(next: RecoveryState) {
  state = next;
  listeners.forEach((l) => l(state));
}

export function getRecoveryState(): RecoveryState {
  return state;
}

export function subscribeRecovery(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Priorité d'affichage : une erreur effective l'emporte sur une simple proposition. */
function rank(d: RecoveryDecision | null): number {
  if (!d) return 0;
  if (d.cause === 'new-version') return 1;
  return d.action === 'offline' ? 2 : 3;
}

function show(decision: RecoveryDecision) {
  if (rank(decision) >= rank(state.decision)) setState({ decision });
}

export interface RecoveryEnv {
  now?: () => number;
  online?: () => boolean;
  storage?: () => RecoveryStorage | null;
  reload?: () => void;
  href?: () => string;
}

const defaultEnv: Required<RecoveryEnv> = {
  now: () => Date.now(),
  online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  storage: sessionStore,
  reload: () => { if (typeof window !== 'undefined') window.location.reload(); },
  href: () => (typeof window !== 'undefined' ? window.location.href : ''),
};

let env: Required<RecoveryEnv> = defaultEnv;

/** Réservé aux tests. */
export function __setRecoveryEnvForTests(next: RecoveryEnv | null): void {
  env = next ? { ...defaultEnv, ...next } : defaultEnv;
  state = { decision: null };
  swHint = null;
  reloading = false;
  listeners.clear();
  blockers.clear();
}

/** Signalement du service worker (statut HTTP ou transport) sur un chunk. */
export function reportServiceWorkerChunkProblem(cause: 'missing' | 'network'): void {
  swHint = { cause, at: env.now() };
  // Un 404 sur un chunk signifie qu'une autre version est en ligne. Seul,
  // il ne casse rien (un préchargement, par exemple) : on PROPOSE la mise
  // à jour, sans recharger. L'erreur effective, si elle survient, décidera.
  if (cause === 'missing') show({ action: 'prompt', cause: 'new-version', blockedBy: [], alreadyRetried: false });
}

/** Classe une erreur de chunk : signal récent du SW, sinon état du réseau. */
export function classifyChunkError(): 'missing' | 'network' {
  if (swHint && env.now() - swHint.at < SW_HINT_TTL_MS) return swHint.cause;
  return env.online() ? 'missing' : 'network';
}

/**
 * Point d'entrée unique pour une erreur de chunk constatée (erreur globale,
 * rejet non géré, écran d'erreur de route, chargement dynamique). Applique
 * la règle, recharge au plus une fois, sinon affiche la reprise.
 */
export function handleChunkError(opts: { inline?: boolean } = {}): RecoveryDecision {
  if (reloading) return { action: 'reload', cause: 'missing' };
  const storage = env.storage();
  const decision = decideRecovery({
    cause: classifyChunkError(),
    online: env.online(),
    now: env.now(),
    storage,
    blockedBy: currentBlockers(),
  });
  if (decision.action === 'reload') {
    // La tentative est notée AVANT de recharger : si la page rechargée
    // échoue encore, la règle le saura. Écriture impossible → pas de reload.
    if (!storage || !writeRecoveryRecord(storage, { at: env.now(), href: env.href() })) {
      const fallback: RecoveryDecision = { action: 'prompt', cause: decision.cause, blockedBy: [], alreadyRetried: false };
      if (!opts.inline) show(fallback);
      return fallback;
    }
    reloading = true;
    setState({ decision });
    // Laisse le temps d'afficher « rechargement… ».
    setTimeout(() => env.reload(), 300);
    return decision;
  }
  // Écran d'erreur qui affiche lui-même la reprise : pas de bandeau en
  // double, sauf hors ligne (le bandeau proposera la reprise au retour du réseau).
  if (!opts.inline || decision.action === 'offline') show(decision);
  return decision;
}

/** Reprise explicite (bouton) : rechargement demandé par l'utilisateur. */
export function manualReload(): void {
  reloading = true;
  env.reload();
}

/** Le réseau est revenu : la reprise « hors ligne » devient une reprise explicite. */
export function onNetworkRestored(): void {
  if (state.decision?.action === 'offline') {
    setState({ decision: { action: 'prompt', cause: 'network', blockedBy: currentBlockers(), alreadyRetried: false } });
  }
}

export function dismissRecovery(): void {
  setState({ decision: null });
}

/** Message utilisateur de chaque reprise. */
export function recoveryMessage(d: RecoveryDecision): { title: string; detail: string; button: string | null } {
  if (d.action === 'reload') {
    return { title: 'Mise à jour détectée', detail: 'Rechargement de la page…', button: null };
  }
  if (d.action === 'offline') {
    return {
      title: 'Connexion perdue',
      detail: 'Une partie de l’application n’a pas pu être chargée. Vérifiez votre connexion : la reprise sera proposée dès son retour.',
      button: null,
    };
  }
  const avertissement = d.blockedBy.length > 0
    ? ' Une saisie ou un envoi est en cours : terminez-le avant de recharger, sinon il sera perdu.'
    : '';
  if (d.cause === 'new-version') {
    return {
      title: 'Nouvelle version disponible',
      detail: `Rechargez quand vous le souhaitez pour en profiter.${avertissement}`,
      button: 'Recharger',
    };
  }
  if (d.cause === 'network') {
    return { title: 'Connexion rétablie', detail: `Rechargez pour reprendre.${avertissement}`, button: 'Recharger' };
  }
  return {
    title: 'Cette page n’a pas pu être chargée',
    detail: d.alreadyRetried
      ? `Le rechargement automatique n’a pas suffi. Réessayez dans un instant ; si le problème persiste, revenez à l’accueil.${avertissement}`
      : `Une nouvelle version de Verebona a été mise en ligne.${avertissement}`,
    button: d.blockedBy.length > 0 ? 'Recharger quand même' : 'Recharger',
  };
}
