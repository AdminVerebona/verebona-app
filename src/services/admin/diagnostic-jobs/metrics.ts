/**
 * Lot 111Q — MÉTRIQUES et PROFILAGE d'un diagnostic durable. PUR (aucun
 * import serveur) : partagé par le worker, les routes BO, la page
 * « Diagnostics » et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONSTAT (05/11/2026, f191d635… « account #13 · renforcé ») : le BO
 * affichait une seule « Durée » (depuis la demande, tant qu'aucune tentative
 * n'avait démarré) — on la prenait pour une durée de génération, alors que
 * rien n'avait démarré. Trois mesures distinctes désormais :
 *   · queue_wait_duration    demande → PREMIER démarrage réel par un worker
 *                            (`first_run_started_at`, migration 1280 ; repli
 *                            sur la première tentative journalisée) ;
 *   · execution_duration     somme des tentatives réellement exécutées ;
 *   · total_elapsed_duration demande → fin (ou maintenant).
 * Et une catégorie d'état lisible, la même partout (BO, journaux, recette) :
 * « Attente de ressource », « Worker indisponible », « Génération en cours »,
 * « Échec », « Terminé », « Annulé » — plus « En file » pour la courte attente
 * normale du prochain tour du worker (jamais indéfinie : au-delà du seuil
 * DIAG_JOB_STALL_ALERT_SECONDS elle devient « Worker indisponible »).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { DiagJobPhase, DiagJobStatus } from './state';
import type { DiagWaitReason } from './wait';

export interface DiagMetricsInput {
  status: DiagJobStatus | string;
  startedAt: string;
  firstRunStartedAt?: string | null;
  runStartedAt?: string | null;
  finishedAt?: string | null;
  attemptsLog?: ReadonlyArray<{ startedAt?: string | null; endedAt?: string | null }> | null;
  now: Date;
}

export interface DiagMetrics {
  /** ms entre la demande et le premier démarrage réel ; en file : jusqu'à maintenant. */
  queueWaitMs: number | null;
  /** ms de génération réellement exécutée (somme des tentatives) ; null si rien n'a démarré. */
  executionMs: number | null;
  /** ms entre la demande et la fin (ou maintenant). */
  totalElapsedMs: number | null;
  /** Vrai si au moins une tentative a réellement démarré. */
  started: boolean;
  firstStartAt: string | null;
}

const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const ACTIVE = new Set(['QUEUED', 'RUNNING']);

/** Métriques d'un travail (pure). */
export function diagMetrics(i: DiagMetricsInput): DiagMetrics {
  const now = i.now.getTime();
  const t0 = ms(i.startedAt);
  const end = ACTIVE.has(String(i.status)) ? now : (Number.isFinite(ms(i.finishedAt)) ? ms(i.finishedAt) : now);
  const log = (i.attemptsLog ?? []).filter((a) => Number.isFinite(ms(a.startedAt)));
  const firstCandidates = [ms(i.firstRunStartedAt), ...log.map((a) => ms(a.startedAt))].filter(Number.isFinite);
  let first = firstCandidates.length ? Math.min(...firstCandidates) : NaN;
  if (!Number.isFinite(first) && Number.isFinite(ms(i.runStartedAt))) first = ms(i.runStartedAt);
  const started = Number.isFinite(first);
  let executionMs: number | null = null;
  if (log.length) {
    executionMs = log.reduce((n, a, idx) => {
      const s = ms(a.startedAt);
      const isLast = idx === log.length - 1;
      const e = Number.isFinite(ms(a.endedAt)) ? ms(a.endedAt) : (isLast ? end : s);
      return n + Math.max(0, e - s);
    }, 0);
  } else if (started) executionMs = Math.max(0, end - first);
  return {
    queueWaitMs: Number.isFinite(t0) ? Math.max(0, (started ? first : end) - t0) : null,
    executionMs,
    totalElapsedMs: Number.isFinite(t0) ? Math.max(0, end - t0) : null,
    started,
    firstStartAt: started ? new Date(first).toISOString() : null,
  };
}

/** Durée lisible (pure) : « 4 min 12 s ». */
export function formatDuration(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v < 0) return '—';
  const s = Math.round(v / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

// ── Catégorie d'état (libellés du ticket) ───────────────────────────────────

export type DiagStateCategory = 'EN_FILE' | 'ATTENTE_RESSOURCE' | 'WORKER_INDISPONIBLE' | 'GENERATION_EN_COURS' | 'ECHEC' | 'TERMINE' | 'ANNULE';

export const DIAG_STATE_CATEGORY_LABELS: Readonly<Record<DiagStateCategory, string>> = {
  EN_FILE: 'En file',
  ATTENTE_RESSOURCE: 'Attente de ressource',
  WORKER_INDISPONIBLE: 'Worker indisponible',
  GENERATION_EN_COURS: 'Génération en cours',
  ECHEC: 'Échec',
  TERMINE: 'Terminé',
  ANNULE: 'Annulé',
};

const WORKER_DOWN: ReadonlySet<DiagWaitReason> = new Set(['WORKER_DISABLED', 'NO_WORKER_CONTAINER', 'WORKER_UNAVAILABLE', 'WORKER_LOOP_FAILING', 'WORKER_STUCK', 'UNEXPLAINED_WAIT']);
const RESOURCE: ReadonlySet<DiagWaitReason> = new Set(['OTHER_DIAGNOSTIC_RUNNING', 'STOPPING_REPLACED', 'MEMORY_ADMISSION', 'RETRY_SCHEDULED']);

/** Catégorie d'état affichée (pure). `waitReason` : raison d'attente actuelle d'une demande en file. */
export function stateCategory(status: DiagJobStatus | string, waitReason: DiagWaitReason | string | null | undefined, cancelRequested = false): DiagStateCategory {
  switch (status) {
    case 'QUEUED':
      if (cancelRequested) return 'ANNULE';
      if (waitReason && WORKER_DOWN.has(waitReason as DiagWaitReason)) return 'WORKER_INDISPONIBLE';
      if (waitReason && RESOURCE.has(waitReason as DiagWaitReason)) return 'ATTENTE_RESSOURCE';
      return 'EN_FILE';
    case 'RUNNING': return 'GENERATION_EN_COURS';
    case 'COMPLETE': case 'PARTIAL': return 'TERMINE';
    case 'CANCELLED': return 'ANNULE';
    default: return 'ECHEC';
  }
}

// ── Profilage des étapes ────────────────────────────────────────────────────

export interface DiagFileTiming { path: string; ms: number; bytes: number }

/** Profilage persisté (`phase_timings`) : durées par étape, fichiers les plus lents, totaux. */
export interface DiagTimings {
  schema: 'verebona.bo.diagnostic-profilage/1';
  attempt: number;
  lane: string | null;
  startedAt: string;
  /** Durée cumulée (ms) de chaque étape terminée (ou en cours, à la dernière écriture). */
  phases: Partial<Record<DiagJobPhase | 'NETTOYAGE' | 'INSTANTANE', number>>;
  current: { phase: string; since: string } | null;
  /** Les fichiers les plus lents du ZIP (chemin, ms, octets non compressés). */
  slowestFiles: DiagFileTiming[];
  files: number;
  /** Compteurs techniques (écritures, mesures mémoire…) : preuve des traitements évités. */
  counters?: Record<string, number>;
  /** Renseignées à la publication. */
  final?: { queueWaitMs: number | null; executionMs: number | null; totalElapsedMs: number | null; zipFiles: number; bytes: number; compressedBytes: number; status: string } | null;
}

/** Nombre de fichiers lents conservés dans le profilage. */
export const DIAG_SLOWEST_FILES = 12;

/**
 * Chronomètre des étapes d'une tentative (pur : l'horloge est injectée).
 * `enter` clôt l'étape courante ; `file` consigne un fichier (les plus
 * lents seulement, mémoire bornée).
 */
export function createPhaseProfiler(o: { attempt: number; lane: string | null; now?: () => number }) {
  const clock = o.now ?? (() => Date.now());
  const t0 = clock();
  let phase = 'NETTOYAGE';
  let since = t0;
  const phases: Record<string, number> = {};
  const slow: DiagFileTiming[] = [];
  let files = 0;
  const counters: Record<string, number> = {};
  const close = (at: number) => { phases[phase] = (phases[phase] ?? 0) + Math.max(0, at - since); since = at; };
  return {
    /** Passe à l'étape `p` ; rend la durée (ms) de l'étape quittée. */
    enter(p: string): { left: string; ms: number } {
      const at = clock();
      const left = phase;
      const before = phases[left] ?? 0;
      close(at);
      phase = p;
      return { left, ms: (phases[left] ?? 0) - before };
    },
    file(path: string, durationMs: number, bytes: number) {
      files++;
      if (slow.length < DIAG_SLOWEST_FILES || durationMs > slow[slow.length - 1].ms) {
        slow.push({ path, ms: Math.round(durationMs), bytes });
        slow.sort((a, b) => b.ms - a.ms);
        if (slow.length > DIAG_SLOWEST_FILES) slow.length = DIAG_SLOWEST_FILES;
      }
    },
    counter(name: string, value: number) { counters[name] = value; },
    snapshot(final?: DiagTimings['final']): DiagTimings {
      const at = clock();
      const cur = { ...phases, [phase]: (phases[phase] ?? 0) + Math.max(0, at - since) };
      return {
        schema: 'verebona.bo.diagnostic-profilage/1', attempt: o.attempt, lane: o.lane, startedAt: new Date(t0).toISOString(),
        phases: Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Math.round(v)])), current: final ? null : { phase, since: new Date(since).toISOString() },
        slowestFiles: [...slow], files, counters: { ...counters }, ...(final ? { final } : {}),
      };
    },
    get phase() { return phase; },
  };
}

export const DIAG_PROFILE_PHASE_LABELS: Readonly<Record<string, string>> = {
  NETTOYAGE: 'Nettoyage des fichiers d’une tentative précédente',
  INSTANTANE: 'Ouverture de l’instantané de lecture',
  PLANIFICATION: 'Planification',
  INVENTAIRE: 'Inventaire et décomptes attendus (plan)',
  EXTRACTION: 'Extraction des tables',
  RELATIONS: 'Relations et fermeture',
  CONTROLES: 'Contrôles',
  TRACABILITE: 'Traçabilité (TCO, usage IA, sorties modèle)',
  MANIFESTE: 'Rapport et manifeste',
  VALIDATION: 'Validation (empreintes, stockage)',
  PUBLICATION: 'Publication',
};
