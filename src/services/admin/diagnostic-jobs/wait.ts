/**
 * Lot 111C — POURQUOI une demande de diagnostic attend, et comment le BO
 * l'affiche. PUR (aucun import serveur) : partagé par le superviseur, les
 * routes BO, la page « Diagnostics » et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONSTAT (04/11/2026) : demande globale renforcée c229c2fd… restée QUEUED
 * plus de 2 h, 0/3 tentative, aucun worker. Le BO disait seulement « EN
 * FILE » ; l'alerte QUEUE_STALLED n'apparaissait qu'en ouvrant « Santé du
 * moteur », et l'état du worker était lu dans la mémoire de l'instance HTTP
 * qui répondait (pas forcément celle qui porte le worker).
 *
 * Chemins de code où le worker des diagnostics NE PREND RIEN (tous rendus
 * visibles ici, à partir des battements PERSISTÉS de chaque processus —
 * `diagnostic_worker_heartbeats`) :
 *   1. DIAG_JOB_WORKER_DISABLED=true (ou EXPORTS_WORKER_DISABLED=true) :
 *      `startDiagnosticWorker()` ne démarre rien      → WORKER_DISABLED ;
 *   2. BACKGROUND_JOBS_PROCESS=worker et type « worker » à 0 conteneur :
 *      le web ne démarre pas le worker, aucun autre processus ne le fait
 *                                                     → NO_WORKER_CONTAINER ;
 *   3. aucun processus vivant ne bat (démarrage interrompu avant l'étape 9 bis,
 *      conteneur arrêté, version sans battement)      → WORKER_UNAVAILABLE ;
 *   4. tour du worker en échec à chaque passage (base, migration, rattrapage)
 *                                                     → WORKER_LOOP_FAILING ;
 *   5. tour bloqué (plus aucun tour depuis plusieurs minutes, aucun travail
 *      en cours)                                      → WORKER_STUCK ;
 *   6. créneau global occupé (DIAG_JOB_GLOBAL_CONCURRENCY) par un autre
 *      diagnostic                                     → OTHER_DIAGNOSTIC_RUNNING,
 *      ou par l'ancien diagnostic global en cours d'arrêt → STOPPING_REPLACED ;
 *   7. admission mémoire (lot 109H) refusée au dernier tour → MEMORY_ADMISSION ;
 *   8. nouvelle tentative programmée (erreur transitoire)  → RETRY_SCHEDULED.
 * Sinon : PICKUP_PENDING (prise imminente) puis, au-delà du seuil d'alerte,
 * UNEXPLAINED_WAIT (worker sain mais demande non prise : anomalie à analyser).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { DiagJobStatus } from './state';

export type DiagWaitReason =
  | 'RETRY_SCHEDULED' | 'WORKER_DISABLED' | 'NO_WORKER_CONTAINER' | 'WORKER_UNAVAILABLE' | 'WORKER_LOOP_FAILING'
  | 'WORKER_STUCK' | 'WORKER_STARTING' | 'STOPPING_REPLACED' | 'OTHER_DIAGNOSTIC_RUNNING' | 'MEMORY_ADMISSION'
  | 'PICKUP_PENDING' | 'UNEXPLAINED_WAIT';

export const DIAG_WAIT_REASONS: readonly DiagWaitReason[] = [
  'RETRY_SCHEDULED', 'WORKER_DISABLED', 'NO_WORKER_CONTAINER', 'WORKER_UNAVAILABLE', 'WORKER_LOOP_FAILING',
  'WORKER_STUCK', 'WORKER_STARTING', 'STOPPING_REPLACED', 'OTHER_DIAGNOSTIC_RUNNING', 'MEMORY_ADMISSION',
  'PICKUP_PENDING', 'UNEXPLAINED_WAIT',
];

/** Raisons de configuration : affichées et signalées dès la demande (aucune attente n'y changera rien). */
const IMMEDIATE: ReadonlySet<DiagWaitReason> = new Set(['WORKER_DISABLED', 'NO_WORKER_CONTAINER']);
/** Attentes normales : jamais signalées. */
const NORMAL: ReadonlySet<DiagWaitReason> = new Set(['RETRY_SCHEDULED', 'PICKUP_PENDING', 'WORKER_STARTING']);

/** Ce que le PO doit faire, par raison (texte du BO, de l'alerte et de la recette). */
export const DIAG_WAIT_ACTIONS: Readonly<Record<DiagWaitReason, string>> = {
  RETRY_SCHEDULED: 'Rien à faire : la nouvelle tentative partira à l’heure indiquée.',
  WORKER_DISABLED: 'Scalingo › Environnement : retirer la variable indiquée (ou remplacer DIAG_JOB_WORKER_DISABLED=true par auto : démarrage seulement quand la mémoire le permet), puis redémarrer l’application. La demande partira seule.',
  NO_WORKER_CONTAINER: 'Scalingo › Ressources : passer le type « worker » à 1 conteneur, OU retirer BACKGROUND_JOBS_PROCESS (retour des traitements de fond dans le conteneur web). Lot 113Q : avec DIAG_JOB_PROCESS=diagworker, passer le type « diagworker » à 1 conteneur, OU retirer DIAG_JOB_PROCESS. La demande partira seule.',
  WORKER_UNAVAILABLE: 'Scalingo › Journaux : chercher « [diagnostic-job] worker » et « [startup] » au dernier démarrage ; vérifier que la migration 1200 est appliquée et que le conteneur tourne. Redémarrer l’application si besoin.',
  WORKER_LOOP_FAILING: 'Scalingo › Journaux : chercher « [diagnostic-job] tour du worker en échec » (message affiché ici). Corriger la cause (base, migration), le worker reprend seul.',
  WORKER_STUCK: 'Le tour du worker ne se termine plus : redémarrer l’application (Scalingo › Ressources › Redémarrer). La demande sera reprise au démarrage.',
  WORKER_STARTING: 'Rien à faire : le worker vient de démarrer (premier tour sous 15 s).',
  STOPPING_REPLACED: 'Rien à faire : l’ancien diagnostic global s’arrête (annulation coopérative) ; la nouvelle demande part dès que son bail est libéré.',
  OTHER_DIAGNOSTIC_RUNNING: 'Attendre la fin du diagnostic en cours (référence indiquée), ou l’annuler s’il n’est plus utile.',
  MEMORY_ADMISSION: 'Mémoire du conteneur au-delà du seuil d’admission : la demande part dès que la mémoire redescend (voir BO › Supervision › anomalies mémoire).',
  PICKUP_PENDING: 'Rien à faire : prise en charge au prochain tour du worker.',
  UNEXPLAINED_WAIT: 'Worker actif mais demande non prise : copier l’état (« Santé du moteur › Copier l’état ») et les journaux « [diagnostic-job] » pour analyse.',
};

/** Battement persisté d'un processus (lu par le superviseur). */
export interface DiagWorkerBeat {
  instanceId: string;
  processType: 'web' | 'worker';
  placement: 'web' | 'worker' | 'diagworker';
  state: 'STARTED' | 'DISABLED' | 'NOT_THIS_PROCESS' | 'STOPPED';
  disabledReason: string | null;
  buildCommit: string | null;
  startedAt: string;
  seenAt: string;
  lastTickAt: string | null;
  lastTickOkAt: string | null;
  tickRunningSince: string | null;
  lastClaimAt: string | null;
  currentJobId: string | null;
  waitReason: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  intervalMs: number | null;
  /** Lot 111Q (migration 1280) : voie ciblée — travail en cours, raison d'attente, capacité (null : version sans voie ciblée). */
  laneJobId?: string | null;
  laneWaitReason?: string | null;
  laneLastClaimAt?: string | null;
  laneCapacity?: number | null;
}

/** Intervalle du battement de présence (ms). */
export const DIAG_PRESENCE_INTERVAL_MS = 30_000;

/** Processus vivant : vu il y a moins de 3 battements de présence. */
export function isBeatAlive(b: Pick<DiagWorkerBeat, 'seenAt' | 'state'>, now: Date): boolean {
  return b.state !== 'STOPPED' && now.getTime() - Date.parse(b.seenAt) <= 3 * DIAG_PRESENCE_INTERVAL_MS;
}

const t = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export interface WaitInput {
  job: { id: string; scope: string; startedAt: string; nextAttemptAt: string | null };
  beats: readonly DiagWorkerBeat[] | null;
  running: ReadonlyArray<{ id: string; scope: string; leaseAlive: boolean; cancelRequested: boolean; cancelReason: string | null }>;
  globalConcurrency: number;
  /** Lot 111Q : places réservées aux ciblés (DIAG_JOB_TARGETED_CONCURRENCY, défaut 1). */
  targetedConcurrency?: number;
  stallAlertSeconds: number;
  now: Date;
}

export interface WaitDiagnosis {
  reason: DiagWaitReason;
  /** Variable(s) en cause, diagnostic bloquant, dernière erreur… (sans secret). */
  detail: string | null;
  /** Diagnostic qui occupe le créneau, s'il y en a un. */
  blockingJobId: string | null;
  /** Attente depuis la demande (ou l'échéance de la nouvelle tentative), en secondes. */
  waitedSeconds: number;
  /** Faut-il une alerte BO maintenant ? */
  alert: boolean;
}

/**
 * Raison d'attente d'UNE demande QUEUED (pure). `beats === null` : table des
 * battements absente (migration 1200 non appliquée) — raison WORKER_UNAVAILABLE
 * avec ce motif.
 */
export function diagnoseWait(i: WaitInput): WaitDiagnosis {
  const now = i.now.getTime();
  const next = t(i.job.nextAttemptAt);
  const since = Number.isFinite(next) && next < now ? next : t(i.job.startedAt);
  const waitedSeconds = Math.max(0, Math.round((now - since) / 1000));
  const out = (reason: DiagWaitReason, detail: string | null = null, blockingJobId: string | null = null): WaitDiagnosis => ({
    reason, detail, blockingJobId, waitedSeconds,
    alert: IMMEDIATE.has(reason) || (!NORMAL.has(reason) && waitedSeconds > i.stallAlertSeconds),
  });
  if (Number.isFinite(next) && next > now) return out('RETRY_SCHEDULED', new Date(next).toISOString());
  if (i.beats === null) return out('WORKER_UNAVAILABLE', 'battements du worker illisibles (migration 1200 non appliquée ?)');
  const alive = i.beats.filter((b) => isBeatAlive(b, i.now));
  const started = alive.filter((b) => b.state === 'STARTED');
  if (!started.length) {
    const disabled = [...new Set(alive.filter((b) => b.state === 'DISABLED').map((b) => b.disabledReason ?? 'DIAG_JOB_WORKER_DISABLED'))];
    if (disabled.length) return out('WORKER_DISABLED', disabled.join(', '));
    // Lot 113Q : processus dédié demandé (DIAG_JOB_PROCESS=diagworker) sans conteneur diagworker.
    if (alive.some((b) => b.state === 'NOT_THIS_PROCESS' && b.placement === 'diagworker')) return out('NO_WORKER_CONTAINER', 'DIAG_JOB_PROCESS=diagworker');
    if (alive.some((b) => b.state === 'NOT_THIS_PROCESS' && b.placement === 'worker')) return out('NO_WORKER_CONTAINER', 'BACKGROUND_JOBS_PROCESS=worker');
    const last = [...i.beats].filter((b) => b.state === 'STARTED').sort((a, b) => t(b.seenAt) - t(a.seenAt))[0];
    return out('WORKER_UNAVAILABLE', last ? `dernier signe de vie d’un worker : ${last.seenAt} (${last.instanceId.split(':').slice(0, 2).join(':')})` : 'aucun worker n’a jamais battu');
  }
  const isGlobal = i.job.scope === 'global';
  const live = i.running.filter((r) => r.leaseAlive && r.id !== i.job.id);
  const T = Math.max(0, i.targetedConcurrency ?? 1);
  const G = Math.max(1, i.globalConcurrency);
  if (isGlobal || T === 0) {
    const stopping = live.find((r) => r.cancelRequested && (r.cancelReason === 'REPLACED_BY_NEW_REQUEST' || (isGlobal && r.scope === 'global')));
    if (stopping) return out('STOPPING_REPLACED', null, stopping.id);
    const globalBusy = isGlobal ? live.find((r) => r.scope === 'global') : undefined;
    if (globalBusy || live.length >= G) {
      const b = globalBusy ?? live[0];
      return out('OTHER_DIAGNOSTIC_RUNNING', `diagnostic ${b.scope} en cours`, b.id);
    }
  } else {
    // Lot 111Q — diagnostic CIBLÉ : un global (en cours, annulé, en cours d'arrêt, orphelin à bail
    // vivant) n'occupe jamais les places réservées ; seul « tout est plein » le fait attendre.
    if (live.length >= G + T) {
      const b = live.find((r) => r.scope !== 'global') ?? live[0];
      return out('OTHER_DIAGNOSTIC_RUNNING', `toutes les places sont occupées (${live.length} / ${G + T}) — diagnostic ${b.scope} en cours`, b.id);
    }
    // Capacité de CHAQUE processus : voie commune occupée et voie ciblée absente, pleine ou retenue.
    const fresh = started.filter((b) => isBeatAlive(b, i.now));
    const mainBusy = fresh.length > 0 && fresh.every((b) => b.currentJobId);
    if (mainBusy) {
      const laneFree = fresh.filter((b) => (b.laneCapacity ?? 0) > 0 && !b.laneJobId);
      if (!laneFree.length) {
        const b = fresh[0];
        const busyId = b.laneJobId ?? b.currentJobId!;
        return out('OTHER_DIAGNOSTIC_RUNNING', (b.laneCapacity ?? 0) > 0 ? 'voie commune et voie ciblée occupées' : 'voie commune occupée (voie ciblée absente : DIAG_JOB_TARGETED_CONCURRENCY=0 ou version antérieure)', busyId);
      }
      if (laneFree.every((b) => b.laneWaitReason === 'MEMORY_ADMISSION')) return out('MEMORY_ADMISSION', 'voie ciblée : mémoire du conteneur au-delà du seuil d’admission');
      if (laneFree.every((b) => b.laneWaitReason === 'LOCAL_SLOT_BUSY')) return out('OTHER_DIAGNOSTIC_RUNNING', 'places de génération du processus occupées', fresh[0].currentJobId);
      // Lot 113Q : une génération à la fois par processus d'export (DIAG_JOB_PROCESS_CONCURRENCY=1).
      if (laneFree.every((b) => b.laneWaitReason === 'PROCESS_BUSY')) return out('OTHER_DIAGNOSTIC_RUNNING', 'une génération à la fois par processus d’export (DIAG_JOB_PROCESS_CONCURRENCY=1) : départ à la fin de la génération en cours', fresh[0].currentJobId);
    }
  }
  const loopFailing = started.every((b) => b.lastError && (!b.lastTickOkAt || t(b.lastErrorAt) >= t(b.lastTickOkAt)));
  if (loopFailing) return out('WORKER_LOOP_FAILING', started[0].lastError);
  const tickFresh = (b: DiagWorkerBeat) => {
    const limit = Math.max(3 * (b.intervalMs ?? 10_000), 120_000);
    if (b.currentJobId) return true;
    if (b.tickRunningSince) return now - t(b.tickRunningSince) <= limit;
    return Number.isFinite(t(b.lastTickAt)) && now - t(b.lastTickAt) <= limit;
  };
  if (!started.some(tickFresh)) {
    if (started.every((b) => !b.lastTickAt && now - t(b.startedAt) <= 120_000)) return out('WORKER_STARTING');
    return out('WORKER_STUCK', started.map((b) => `${b.instanceId.split(':').slice(0, 2).join(':')} : dernier tour ${b.lastTickAt ?? 'jamais'}`).join(' ; '));
  }
  if (started.filter(tickFresh).every((b) => b.waitReason === 'MEMORY_ADMISSION')) return out('MEMORY_ADMISSION');
  return waitedSeconds > i.stallAlertSeconds ? out('UNEXPLAINED_WAIT') : out('PICKUP_PENDING');
}

const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : '?');

/** Libellé BO d'une raison d'attente (pur). */
export function waitLabel(d: Pick<WaitDiagnosis, 'reason' | 'detail' | 'blockingJobId'>): string {
  switch (d.reason) {
    case 'RETRY_SCHEDULED': return `En attente — nouvelle tentative programmée${d.detail ? ` (${new Date(d.detail).toLocaleString('fr-FR')})` : ''}`;
    case 'WORKER_DISABLED': return `En attente — worker désactivé (${d.detail ?? 'DIAG_JOB_WORKER_DISABLED'})`;
    case 'NO_WORKER_CONTAINER': return d.detail === 'DIAG_JOB_PROCESS=diagworker'
      ? 'En attente — worker indisponible (DIAG_JOB_PROCESS=diagworker sans conteneur diagworker)'
      : 'En attente — worker indisponible (BACKGROUND_JOBS_PROCESS=worker sans conteneur worker)';
    case 'WORKER_UNAVAILABLE': return 'En attente — worker indisponible';
    case 'WORKER_LOOP_FAILING': return 'En attente — worker en échec (tour en erreur)';
    case 'WORKER_STUCK': return 'En attente — worker bloqué (plus aucun tour)';
    case 'WORKER_STARTING': return 'En attente — worker en démarrage';
    case 'STOPPING_REPLACED': return `En attente — arrêt de l’ancien diagnostic ${short(d.blockingJobId)} en cours`;
    case 'OTHER_DIAGNOSTIC_RUNNING': return `En attente — autre diagnostic en cours (${short(d.blockingJobId)})`;
    case 'MEMORY_ADMISSION': return 'En attente — mémoire du conteneur (admission différée)';
    case 'PICKUP_PENDING': return 'En attente — prise en charge imminente';
    case 'UNEXPLAINED_WAIT': return 'En attente — non prise malgré un worker actif (anomalie)';
  }
}

/** Champs d'une ligne utiles au statut affiché. */
export interface DisplayRow {
  status: DiagJobStatus | string;
  cancelRequested: boolean;
  cancelReason: string | null;
  replacedBy: string | null;
  errorCode: string | null;
  leaseExpired?: boolean;
}

/**
 * Statut EXPLICITE affiché au BO (pur) : « En attente — … », « Annulation
 * demandée », « Annulé — remplacé par la demande … ».
 */
export function displayStatus(r: DisplayRow, wait: Pick<WaitDiagnosis, 'reason' | 'detail' | 'blockingJobId'> | null): string {
  const replaced = r.cancelReason === 'REPLACED_BY_NEW_REQUEST' || r.errorCode === 'REPLACED_BY_NEW_REQUEST';
  switch (r.status) {
    case 'QUEUED':
      if (r.cancelRequested) return replaced ? `Annulé — remplacé par la demande ${short(r.replacedBy)}` : 'Annulation demandée';
      return wait ? waitLabel(wait) : 'En attente';
    case 'RUNNING':
      if (r.cancelRequested) return replaced ? `Annulation demandée — remplacé par la demande ${short(r.replacedBy)}` : 'Annulation demandée';
      return r.leaseExpired ? 'En cours — sans signe de vie (reprise au prochain tour)' : 'En cours';
    case 'CANCELLED':
      return replaced ? `Annulé — remplacé par la demande ${short(r.replacedBy)}` : 'Annulé';
    case 'COMPLETE': return 'Terminé (complet)';
    case 'PARTIAL': return 'Terminé (partiel)';
    case 'FAILED': return 'Échec';
    default: return String(r.status);
  }
}

/**
 * Lot 113K (Trello #699, recette KO du 06/11/2026) — LIBELLÉ HONNÊTE du worker
 * vu pour une demande (pur, partagé par la page BO et les tests).
 *
 * Constat : demande ciblée « compte #13 · renforcé » (f191d635…) QUEUED depuis
 * 24 h, BO affichant à la fois « En attente — worker désactivé
 * (DIAG_JOB_WORKER_DISABLED) » et « Worker disponible : app-preprod-web-1:23 ».
 * La page disait « Worker disponible » pour TOUTE demande non RUNNING, sans
 * regarder l'état du processus. Désormais « Worker disponible » n'est écrit
 * que si le processus a un worker DÉMARRÉ, vivant, et qu'au moins un worker
 * vivant existe ; sinon l'état réel est nommé.
 */
export interface WorkerViewLike {
  state: string;
  alive: boolean;
  aliveWorkers: number;
  disabledReason?: string | null;
  lane?: 'main' | 'targeted' | null;
}
export type WorkerHeadlineCode = 'EXECUTING' | 'AVAILABLE' | 'DISABLED' | 'NO_WORKER_IN_PROCESS' | 'OFFLINE' | 'STOPPED' | 'UNKNOWN';
export interface WorkerHeadline { code: WorkerHeadlineCode; label: string; problem: boolean }

export function workerHeadline(v: WorkerViewLike, jobStatus: string): WorkerHeadline {
  if (jobStatus === 'RUNNING' && v.lane && v.state === 'STARTED' && v.alive) return { code: 'EXECUTING', label: 'Worker qui exécute', problem: false };
  if (v.state === 'DISABLED') return { code: 'DISABLED', label: `Worker désactivé (${v.disabledReason || 'DIAG_JOB_WORKER_DISABLED'})`, problem: true };
  if (v.state === 'NOT_THIS_PROCESS') return { code: 'NO_WORKER_IN_PROCESS', label: 'Processus sans worker', problem: true };
  if (v.state === 'STOPPED') return { code: 'STOPPED', label: 'Worker arrêté', problem: true };
  if (!v.alive) return { code: 'OFFLINE', label: 'Worker hors ligne (battement périmé)', problem: true };
  if (v.state === 'STARTED' && v.aliveWorkers > 0) return { code: jobStatus === 'RUNNING' ? 'EXECUTING' : 'AVAILABLE', label: jobStatus === 'RUNNING' ? 'Worker qui exécute' : 'Worker disponible', problem: false };
  return { code: 'UNKNOWN', label: `Worker : état ${v.state}`, problem: true };
}
