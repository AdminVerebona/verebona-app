/**
 * Lot 107G — diagnostics BO DURABLES : vocabulaire, codes stables, règles de
 * reprise et d'affichage. PUR (aucun import serveur) : partagé par le
 * worker, les routes BO, la page « Diagnostics » et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI (incident du 02/11/2026, voir docs/exploitation/diagnostics-bo-107g.md)
 *
 * Avant ce lot, « Générer le diagnostic » produisait TOUT le diagnostic
 * DANS la requête HTTP du processus web (GET /api/admin/diagnostics), puis
 * « Télécharger le ZIP » le produisait une SECONDE fois, toujours dans une
 * requête. Aucune ligne de travail, aucun bail, aucune reprise : un arrêt du
 * processus web (redémarrage, déploiement, mémoire) laissait la ligne de suivi
 * RUNNING pour toujours ; deux heures plus tard la liste l'affichait
 * « génération interrompue (processus arrêté avant la fin) ».
 *
 * Maintenant : la demande crée une ligne QUEUED (identifiant rendu tout de
 * suite) ; un worker (même boucle que les exports lourds) la prend sous bail,
 * produit chaque fichier compressé EN FLUX vers le stockage, valide les
 * fichiers stockés et le manifeste, puis publie COMPLETE / PARTIAL — ou FAILED
 * avec un code stable. Un processus arrêté cesse de renouveler son bail : la
 * génération est reprise (nouvelle tentative, nouvel instantané cohérent) ou
 * passe FAILED explicite quand les tentatives sont épuisées.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type DiagJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
export const DIAG_JOB_FINAL_STATUSES: readonly DiagJobStatus[] = ['COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED'];
export const DIAG_JOB_ACTIVE_STATUSES: readonly DiagJobStatus[] = ['QUEUED', 'RUNNING'];

/** Mode de la ligne `admin_export_generations` d'un diagnostic durable. */
export const DIAG_JOB_MODE = 'job';
/** Préfixe de stockage (OVH S3) des diagnostics durables. */
export const DIAG_JOB_PREFIX = 'admin-exports/diagnostics/';

/** Étapes journalisées (phase + point de reprise). */
export const DIAG_JOB_PHASES = [
  'EN_FILE', 'PLANIFICATION', 'INVENTAIRE', 'EXTRACTION', 'RELATIONS', 'CONTROLES', 'TRACABILITE', 'MANIFESTE', 'VALIDATION', 'PUBLICATION', 'TERMINE',
] as const;
export type DiagJobPhase = (typeof DIAG_JOB_PHASES)[number];

export const DIAG_JOB_PHASE_LABELS: Readonly<Record<DiagJobPhase, string>> = {
  EN_FILE: 'En file d’attente',
  PLANIFICATION: 'Planification (ouverture de l’instantané, périmètre)',
  INVENTAIRE: 'Inventaire des tables et décomptes attendus',
  EXTRACTION: 'Extraction des tables (compression et envoi en flux)',
  RELATIONS: 'Relations et fermeture des dépendances',
  CONTROLES: 'Contrôles (comptes, références, couverture)',
  TRACABILITE: 'Traçabilité (montants, TCO, usage IA)',
  MANIFESTE: 'Rapport et manifeste',
  VALIDATION: 'Validation des fichiers stockés et des empreintes',
  PUBLICATION: 'Publication du résultat',
  TERMINE: 'Terminé',
};

/** Étape d'un fichier du plan (pure). */
export function phaseOfPath(path: string): DiagJobPhase {
  if (path.startsWith('donnees/fermeture/')) return 'RELATIONS';
  if (path.startsWith('donnees/')) return 'EXTRACTION';
  if (path.startsWith('controle/') || path.startsWith('couverture/') || path.startsWith('technique/')) return 'CONTROLES';
  if (path.startsWith('tracabilite/') || path.startsWith('ia/')) return 'TRACABILITE';
  if (path === 'rapport.txt' || path === 'manifeste.json' || path === 'LISEZMOI-ANALYSE.md') return 'MANIFESTE';
  return 'EXTRACTION';
}

/**
 * Codes d'erreur STABLES (affichés au BO, journalisés, documentés). Un code
 * dit la cause technique ; l'étape (`error_phase`) dit où.
 */
export type DiagJobErrorCode =
  | 'WORKER_LOST' | 'WORKER_LOST_MAX_ATTEMPTS' | 'LEGACY_HTTP_INTERRUPTED'
  | 'STORAGE_UNAVAILABLE' | 'STORAGE_UPLOAD_FAILED' | 'COMPRESSION_FAILED'
  | 'READ_TIMEOUT' | 'DB_CONNECTION_LOST' | 'SNAPSHOT_FAILED' | 'TARGET_NOT_FOUND'
  | 'MEMORY_GUARD' | 'JOB_TIMEOUT' | 'VALIDATION_FAILED' | 'CANCELLED' | 'GENERATION_FAILED'
  /** Lot 111C : demande globale remplacée par une demande globale plus récente. */
  | 'REPLACED_BY_NEW_REQUEST';

export const DIAG_JOB_ERROR_LABELS: Readonly<Record<DiagJobErrorCode, string>> = {
  WORKER_LOST: 'Processus du worker arrêté pendant la génération (redémarrage, déploiement ou mémoire) : bail expiré, nouvelle tentative programmée.',
  WORKER_LOST_MAX_ATTEMPTS: 'Processus du worker arrêté à chaque tentative (redémarrage, déploiement ou mémoire) : tentatives épuisées, génération abandonnée.',
  LEGACY_HTTP_INTERRUPTED: 'Ancien moteur (avant le lot 107G) : génération faite dans la requête HTTP du processus web, jamais terminée — le processus web a été arrêté (redémarrage, déploiement ou mémoire) ou la requête abandonnée sans clôture.',
  STORAGE_UNAVAILABLE: 'Stockage OVH non configuré : aucune archive ne peut être produite.',
  STORAGE_UPLOAD_FAILED: 'Envoi d’un fichier vers le stockage en échec.',
  COMPRESSION_FAILED: 'Compression d’un fichier en échec.',
  READ_TIMEOUT: 'Lecture trop longue (délai de requête PostgreSQL dépassé).',
  DB_CONNECTION_LOST: 'Connexion PostgreSQL perdue pendant la lecture.',
  SNAPSHOT_FAILED: 'Ouverture de l’instantané de lecture impossible.',
  TARGET_NOT_FOUND: 'Objet du filtre introuvable.',
  MEMORY_GUARD: 'Mémoire du processus au-delà du seuil de garde : génération arrêtée proprement pour protéger l’application.',
  JOB_TIMEOUT: 'Délai global de la génération dépassé.',
  VALIDATION_FAILED: 'Validation finale en échec (fichier absent, taille ou empreinte divergente, manifeste incomplet) : résultat NON publié.',
  CANCELLED: 'Génération annulée par un administrateur.',
  REPLACED_BY_NEW_REQUEST: 'Demande globale remplacée par une demande globale plus récente (la dernière demande est prioritaire) : ancienne génération annulée, résultat jamais publié.',
  GENERATION_FAILED: 'Erreur inattendue de génération.',
};

/** Erreurs transitoires : nouvelle tentative automatique (bornée). */
const TRANSIENT: ReadonlySet<DiagJobErrorCode> = new Set(['WORKER_LOST', 'STORAGE_UPLOAD_FAILED', 'READ_TIMEOUT', 'DB_CONNECTION_LOST', 'SNAPSHOT_FAILED']);
export function isTransientError(code: DiagJobErrorCode): boolean { return TRANSIENT.has(code); }

function envInt(env: Record<string, string | undefined>, name: string, fallback: number, min = 1): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
}

/** Paramètres d'exploitation (variables Scalingo facultatives, défauts prudents). */
export function diagJobSettings(env: Record<string, string | undefined> = process.env) {
  return {
    /** Tentatives au total (première comprise). */
    maxAttempts: envInt(env, 'DIAG_JOB_MAX_ATTEMPTS', 3),
    /** Durée du bail (renouvelé au tiers). */
    leaseSeconds: envInt(env, 'DIAG_JOB_LEASE_SECONDS', 120, 30),
    /** Délai global d'une tentative. */
    timeoutMs: envInt(env, 'DIAG_JOB_TIMEOUT_MS', 4 * 60 * 60_000, 60_000),
    /** Délai d'UNE requête SQL du diagnostic (hors requête HTTP : plus long que les 20 s interactifs). */
    statementTimeoutMs: envInt(env, 'DIAG_JOB_STATEMENT_TIMEOUT_MS', 5 * 60_000, 1_000),
    /** Générations simultanées sur l'ensemble des instances. */
    globalConcurrency: envInt(env, 'DIAG_JOB_GLOBAL_CONCURRENCY', 1),
    /** Rétention des archives. */
    retentionDays: envInt(env, 'DIAG_JOB_RETENTION_DAYS', 30),
    /** Seuil de garde mémoire (Mo) ; 0 : seuil déduit de la limite du conteneur (85 %). */
    maxRssMb: envInt(env, 'DIAG_JOB_MAX_RSS_MB', 0, 0),
    /** Tour du worker. */
    intervalMs: envInt(env, 'DIAG_JOB_WORKER_INTERVAL_MS', 10_000, 1_000),
    /** Worker retiré de cette instance (désactivation EXPLICITE : jamais contournée). */
    disabled: workerMode(env) === 'disabled',
    /**
     * Lot 111C : `DIAG_JOB_WORKER_DISABLED=auto` — worker démarré, mais un
     * diagnostic ne part que si la mémoire du conteneur est sous le seuil
     * d'admission (aucun départ forcé après attente) : le démarrage sûr
     * proposé au PO à la place d'une désactivation totale.
     */
    memoryGate: workerMode(env) === 'auto' ? 'strict' as const : 'standard' as const,
    /** Lot 111C : attente au-delà de laquelle une demande jamais démarrée est signalée (s). */
    stallAlertSeconds: envInt(env, 'DIAG_JOB_STALL_ALERT_SECONDS', 300, 60),
    /** Lot 111C : lecture de l'annulation pendant une génération (ms). */
    cancelPollMs: envInt(env, 'DIAG_JOB_CANCEL_POLL_MS', 3_000, 500),
    /**
     * Lot 111Q : places RÉSERVÉES aux diagnostics CIBLÉS (compte, utilisateur,
     * bien, document, Opération), en plus de DIAG_JOB_GLOBAL_CONCURRENCY —
     * un diagnostic global en cours (long) ne fait plus attendre un ciblé.
     * 0 : comportement du lot 111C (une seule voie commune).
     */
    targetedConcurrency: envInt(env, 'DIAG_JOB_TARGETED_CONCURRENCY', 1, 0),
  };
}

/**
 * Lot 111Q — voie d'exécution d'un worker : `main` (voie commune : ciblés
 * d'abord, puis le global le plus récent) ; `targeted` (voie réservée : ciblés
 * seulement, ouverte quand la voie commune est occupée, admission mémoire
 * stricte — jamais de départ forcé).
 */
export type DiagLane = 'main' | 'targeted';

/**
 * Lot 111Q — capacité (pure, toutes instances) : un diagnostic global démarre
 * si aucun global ne tient de bail ET si la voie commune a une place ; un
 * ciblé démarre tant que voie commune + voie réservée ne sont pas pleines.
 * Un diagnostic global (même annulé ou en cours d'arrêt) n'occupe jamais les
 * places réservées aux ciblés.
 */
export function laneCapacity(running: { total: number; global: number }, s: { globalConcurrency: number; targetedConcurrency: number }): { globalAllowed: boolean; targetedAllowed: boolean } {
  const G = Math.max(1, s.globalConcurrency);
  const T = Math.max(0, s.targetedConcurrency);
  return { globalAllowed: running.global === 0 && running.total < G, targetedAllowed: running.total < G + T };
}

/**
 * Lot 111C — lecture de `DIAG_JOB_WORKER_DISABLED` (pur) : `true` / `1` /
 * `yes` / `on` → désactivé ; `auto` → démarrage protégé par la mémoire ;
 * absent, `false` ou autre → actif.
 */
export function workerMode(env: Record<string, string | undefined> = process.env): 'enabled' | 'disabled' | 'auto' {
  const v = String(env.DIAG_JOB_WORKER_DISABLED ?? '').trim().toLowerCase();
  if (v === 'auto') return 'auto';
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return 'disabled';
  return 'enabled';
}

/**
 * Lot 111C — variable qui désactive le worker des diagnostics sur ce
 * processus (pur), ou null. `EXPORTS_WORKER_DISABLED=true` le retire aussi
 * (contrat du lot 107G, documenté).
 */
export function workerDisabledReason(env: Record<string, string | undefined> = process.env): string | null {
  if (workerMode(env) === 'disabled') return 'DIAG_JOB_WORKER_DISABLED';
  if (String(env.EXPORTS_WORKER_DISABLED ?? '').trim().toLowerCase() === 'true') return 'EXPORTS_WORKER_DISABLED';
  return null;
}

/** Lot 111C : diagnostic GLOBAL (« Ensemble de l'application ») — seul concerné par le remplacement. */
export function isGlobalRequest(r: { scope: string | null | undefined }): boolean {
  return (r.scope ?? 'global') === 'global';
}

/** Lot 111C : motifs STABLES d'annulation. */
export type DiagCancelReason = 'ADMIN_CANCELLED' | 'REPLACED_BY_NEW_REQUEST';

/** Délai avant la nouvelle tentative n°(attempt + 1) : 1 min, 5 min, 15 min. */
export function retryDelaySeconds(attempt: number): number {
  return [60, 300, 900][Math.min(Math.max(attempt, 1), 3) - 1];
}

/**
 * Code stable d'une erreur de génération (pur). `step` : sous-étape en cours
 * (`upload`, `compress`, `snapshot`…), quand elle est connue.
 */
export function classifyDiagJobError(e: unknown, step: string | null = null): DiagJobErrorCode {
  const own = (e as { diagCode?: unknown })?.diagCode;
  if (typeof own === 'string' && own in DIAG_JOB_ERROR_LABELS) return own as DiagJobErrorCode;
  const name = (e as { name?: string })?.name;
  if (name === 'DiagTargetNotFoundError') return 'TARGET_NOT_FOUND';
  const code = String((e as { code?: unknown })?.code ?? '');
  if (code === '57014') return 'READ_TIMEOUT';
  if (/^08/.test(code) || code === 'CONNECTION_CLOSED' || code === 'CONNECTION_ENDED' || code === 'CONNECTION_DESTROYED' || code === 'ECONNRESET' || code === '57P01') return 'DB_CONNECTION_LOST';
  if (step === 'snapshot') return 'SNAPSHOT_FAILED';
  if (step === 'compress') return 'COMPRESSION_FAILED';
  if (step === 'upload' || (e as { $metadata?: unknown })?.$metadata !== undefined) return 'STORAGE_UPLOAD_FAILED';
  return 'GENERATION_FAILED';
}

/** Erreur porteuse de son code (levée par le worker). */
export class DiagJobError extends Error {
  constructor(readonly diagCode: DiagJobErrorCode, message: string) { super(message); this.name = 'DiagJobError'; }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRETS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi,
  /\b(?:password|passwd|mot_de_passe|secret|api[_-]?key|token|signature|x-amz-[a-z-]+)\s*[=:]\s*\S+/gi,
  /\bX-Amz-(?:Signature|Credential|Security-Token)=[^&\s]+/gi,
];

/**
 * Message d'erreur ASSAINI pour l'affichage et le journal (pur) : aucun
 * e-mail, secret, jeton, identifiant d'URL ni valeur littérale de requête
 * (`"…"` entre guillemets doubles d'un message PostgreSQL) ; 500 caractères.
 */
export function sanitizeErrorMessage(message: unknown): string {
  let s = String((message as Error)?.message ?? message ?? '').replace(/\s+/g, ' ').trim();
  for (const r of SECRETS) s = s.replace(r, '[secret masqué]');
  s = s.replace(EMAIL, '[e-mail masqué]');
  // Valeurs littérales citées par PostgreSQL (« invalid input syntax … : "valeur" ») : jamais affichées.
  s = s.replace(/"[^"]{1,200}"/g, '"…"');
  return s.slice(0, 500);
}

/** Clé d'une demande identique (même périmètre, même option) : double clic → même travail. */
export function requestKey(r: { scope: string; id: number | null; reinforced: boolean }): string {
  return `diag:${r.scope}:${r.id ?? '-'}:${r.reinforced ? 'R' : 'S'}`;
}

/** Clé d'idempotence transmise par le client (en-tête `Idempotency-Key`) : 8 à 80 caractères sûrs. */
export function parseIdempotencyKey(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return /^[A-Za-z0-9_.:-]{8,80}$/.test(s) ? s : null;
}

/** Progression légère conservée sur la ligne (jamais le contenu). */
export interface DiagJobProgress {
  filesPlanned: number | null;
  filesDone: number;
  rows: number;
  bytes: number;
  compressedBytes: number;
  current: string | null;
  rssMb: number | null;
  peakRssMb: number | null;
  heapUsedMb: number | null;
  memoryLimitMb: number | null;
  updatedAt: string;
}

/** Entrée de l'historique des tentatives. */
export interface DiagJobAttempt {
  attempt: number;
  worker: string;
  commit: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Lot 111C : LOST_BEFORE_START — processus arrêté avant l'ouverture de l'instantané (tentative rendue). */
  outcome: DiagJobStatus | 'RETRY' | 'LOST' | 'LOST_BEFORE_START' | null;
  errorCode: DiagJobErrorCode | null;
  phase: DiagJobPhase | null;
  lastProgress?: Pick<DiagJobProgress, 'filesDone' | 'filesPlanned' | 'current' | 'rssMb' | 'peakRssMb'> | null;
}

/** Pourcentage affichable (pur) : fichiers produits / prévus ; null tant que le plan n'est pas établi. */
export function progressPercent(p: Pick<DiagJobProgress, 'filesPlanned' | 'filesDone'> | null | undefined, status: DiagJobStatus): number | null {
  if (status === 'COMPLETE' || status === 'PARTIAL') return 100;
  if (!p || !p.filesPlanned) return null;
  return Math.max(0, Math.min(99, Math.floor((p.filesDone / p.filesPlanned) * 100)));
}

/**
 * Seuil de garde mémoire (Mo, pur) : variable explicite, sinon 85 % de la
 * limite du conteneur (cgroup), sinon aucun (mesure seule).
 */
export function memoryGuardMb(explicitMb: number, containerLimitMb: number | null): number | null {
  if (explicitMb > 0) return explicitMb;
  if (containerLimitMb && containerLimitMb > 0 && containerLimitMb < 1024 * 1024) return Math.floor(containerLimitMb * 0.85);
  return null;
}
