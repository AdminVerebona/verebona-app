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

/**
 * Lot 113Q — mesure mémoire du PROCESSUS (Mo) : RSS (tout le processus), tas
 * V8 utilisé, mémoire native (`external` : tampons, zlib) et ArrayBuffer ;
 * mémoire du conteneur (cgroup) quand elle est lisible.
 */
export interface DiagMemPoint { rssMb: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number; containerUsedMb?: number | null }

/** Lot 113Q — mémoire pendant la production d'un fichier : au début, au pic, à la fin. */
export interface DiagFileMemory { path: string; phase: string; startRssMb: number; peakRssMb: number; endRssMb: number; peakHeapMb: number; peakExternalMb: number; peakArrayBuffersMb: number; ms: number; bytes: number }

/** Lot 113Q — profil mémoire d'une tentative (persisté avec les durées). */
export interface DiagMemoryProfile {
  initial: DiagMemPoint | null;
  peak: DiagMemPoint | null;
  /** Pic de chaque étape. */
  byPhase: Record<string, DiagMemPoint>;
  /** Fichiers au pic le plus haut (au plus DIAG_MEMORY_FILES). */
  files: DiagFileMemory[];
  /** Fichiers dont la mémoire a le plus augmenté pendant leur production (au plus DIAG_MEMORY_FILES). */
  growth: DiagFileMemory[];
}

/** Lot 113Q : fichiers conservés dans le profil mémoire. */
export const DIAG_MEMORY_FILES = 12;

/** Lot 113Q : point mémoire du processus (Mo, arrondi). */
export function memPoint(m: { rss: number; heapUsed: number; external: number; arrayBuffers: number }, containerUsedMb?: number | null): DiagMemPoint {
  const MB = 1024 * 1024;
  return { rssMb: Math.round(m.rss / MB), heapUsedMb: Math.round(m.heapUsed / MB), externalMb: Math.round(m.external / MB), arrayBuffersMb: Math.round(m.arrayBuffers / MB), ...(containerUsedMb !== undefined ? { containerUsedMb } : {}) };
}

const maxPoint = (a: DiagMemPoint | null | undefined, b: DiagMemPoint): DiagMemPoint => (!a ? { ...b } : {
  rssMb: Math.max(a.rssMb, b.rssMb), heapUsedMb: Math.max(a.heapUsedMb, b.heapUsedMb), externalMb: Math.max(a.externalMb, b.externalMb), arrayBuffersMb: Math.max(a.arrayBuffersMb, b.arrayBuffersMb),
  ...(a.containerUsedMb != null || b.containerUsedMb != null ? { containerUsedMb: Math.max(a.containerUsedMb ?? 0, b.containerUsedMb ?? 0) } : {}),
});

/**
 * Lot 113Q — enregistreur mémoire (pur : les mesures sont fournies) : pic
 * par étape, pic et croissance par fichier — mémoire bornée (les
 * DIAG_MEMORY_FILES fichiers les plus marquants seulement).
 */
export function createMemoryRecorder() {
  let initial: DiagMemPoint | null = null;
  let peak: DiagMemPoint | null = null;
  const byPhase: Record<string, DiagMemPoint> = {};
  const files: DiagFileMemory[] = [];
  const growth: DiagFileMemory[] = [];
  let cur: { path: string; phase: string; start: DiagMemPoint; peak: DiagMemPoint; t0: number } | null = null;
  const keep = (list: DiagFileMemory[], f: DiagFileMemory, score: (x: DiagFileMemory) => number) => {
    if (list.length >= DIAG_MEMORY_FILES && score(f) <= score(list[list.length - 1])) return;
    list.push(f);
    list.sort((a, b) => score(b) - score(a));
    if (list.length > DIAG_MEMORY_FILES) list.length = DIAG_MEMORY_FILES;
  };
  return {
    sample(phase: string, p: DiagMemPoint) {
      if (!initial) initial = { ...p };
      peak = maxPoint(peak, p);
      byPhase[phase] = maxPoint(byPhase[phase], p);
      if (cur) cur.peak = maxPoint(cur.peak, p);
    },
    fileStart(path: string, phase: string, p: DiagMemPoint, now = Date.now()) { this.sample(phase, p); cur = { path, phase, start: { ...p }, peak: { ...p }, t0: now }; },
    fileEnd(p: DiagMemPoint, bytes: number, now = Date.now()): DiagFileMemory | null {
      if (!cur) return null;
      this.sample(cur.phase, p);
      const f: DiagFileMemory = {
        path: cur.path, phase: cur.phase, startRssMb: cur.start.rssMb, peakRssMb: cur.peak.rssMb, endRssMb: p.rssMb, peakHeapMb: cur.peak.heapUsedMb,
        peakExternalMb: cur.peak.externalMb, peakArrayBuffersMb: cur.peak.arrayBuffersMb, ms: Math.round(now - cur.t0), bytes,
      };
      cur = null;
      keep(files, f, (x) => x.peakRssMb);
      keep(growth, f, (x) => x.peakRssMb - x.startRssMb);
      return f;
    },
    /** Fichier en cours au moment d'un arrêt (garde mémoire) : sa mesure partielle. */
    current(): Omit<DiagFileMemory, 'endRssMb' | 'bytes' | 'ms'> | null {
      if (!cur) return null;
      return { path: cur.path, phase: cur.phase, startRssMb: cur.start.rssMb, peakRssMb: cur.peak.rssMb, peakHeapMb: cur.peak.heapUsedMb, peakExternalMb: cur.peak.externalMb, peakArrayBuffersMb: cur.peak.arrayBuffersMb };
    },
    snapshot(): DiagMemoryProfile {
      return { initial, peak, byPhase: Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, { ...v }])), files: files.map((f) => ({ ...f })), growth: growth.map((f) => ({ ...f })) };
    },
  };
}

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
  final?: { queueWaitMs: number | null; executionMs: number | null; totalElapsedMs: number | null; zipFiles: number; bytes: number; compressedBytes: number; status: string; archiveBytes?: number | null } | null;
  /**
   * Lot 113Q — tentative ARRÊTÉE (échec, annulation) : durées figées, plus
   * aucune étape « en cours » (`current` est null).
   */
  ended?: { status: string; code: string | null; phase: string | null; at: string } | null;
  /** Lot 113Q : profil mémoire (initial, pic, par étape, par fichier). */
  memory?: DiagMemoryProfile | null;
  /** Lot 113Q : requêtes de la session de lecture (nombre, durée, lots, octets, grosses lignes, plus lentes). */
  queries?: { count: number; ms: number; fetches: number; rows: number; bytes: number; oversizedRows: number; maxRowBytes: number; slowest: Array<{ sql: string; ms: number }> } | null;
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
    snapshot(final?: DiagTimings['final'], extra: { ended?: DiagTimings['ended']; memory?: DiagMemoryProfile | null; queries?: DiagTimings['queries'] } = {}): DiagTimings {
      const at = clock();
      const cur = { ...phases, [phase]: (phases[phase] ?? 0) + Math.max(0, at - since) };
      const closed = !!final || !!extra.ended;
      return {
        schema: 'verebona.bo.diagnostic-profilage/1', attempt: o.attempt, lane: o.lane, startedAt: new Date(t0).toISOString(),
        phases: Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Math.round(v)])), current: closed ? null : { phase, since: new Date(since).toISOString() },
        slowestFiles: [...slow], files, counters: { ...counters }, ...(final ? { final } : {}),
        ...(extra.ended ? { ended: extra.ended } : {}), ...(extra.memory ? { memory: extra.memory } : {}), ...(extra.queries ? { queries: extra.queries } : {}),
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
  ASSEMBLAGE_ZIP: 'Assemblage de l’archive ZIP définitive',
  VERIFICATION_ZIP: 'Vérification de l’archive ZIP stockée',
  PUBLICATION: 'Publication',
};
