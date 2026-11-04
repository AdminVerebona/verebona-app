/**
 * Mesure mémoire du processus et du conteneur — lot 109H.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE FAIT (et ne fait pas)
 *
 *  · Échantillon toutes les `MEMORY_SAMPLE_MS` (60 s) — toutes les 5 s tant
 *    qu'un traitement suivi est en cours : RSS, tas V8 (utilisé, réservé,
 *    limite), mémoire externe / tampons, et, si le cgroup est lisible, la
 *    mémoire de TOUT le conteneur (Chromium compris) hors cache disque
 *    récupérable (`memory.current − inactive_file`, « working set »).
 *  · Une ligne `[memory] {…}` par minute (rss/heap), une ligne par traitement
 *    lourd (pic et écart pendant la tâche), jamais de secret ni de donnée
 *    personnelle : des tailles, des rôles, des codes de tâche.
 *  · Pression mémoire (`ok` / `high` / `critical`) rapportée à la limite du
 *    conteneur (CONTAINER_MEMORY posée par Scalingo, sinon cgroup) : sert à
 *    l'ADMISSION des traitements lourds (différés, au plus
 *    `MEMORY_ADMISSION_MAX_WAIT_MS`) et à l'alerte de Supervision (rappel
 *    `onAlert`, câblé par `services/admin/memory-supervision.ts`).
 *  · Taille du conteneur inconnue → mesure seule : aucune admission, aucune
 *    alerte (comportement d'avant).
 *
 * Le pic d'une tâche est le pic OBSERVÉ pendant qu'elle tournait : si deux
 * tâches se chevauchent, elles voient le même pic (champ `concurrent`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';

const MB = 1024 * 1024;
/** Au-delà d'1 Tio, une « limite » cgroup signifie « pas de limite ». */
const NO_LIMIT_MB = 1024 * 1024;

type Env = Record<string, string | undefined>;
type Read = (path: string) => string;

export type MemoryLevel = 'ok' | 'high' | 'critical' | 'unknown';

export interface MemorySample {
  at: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  heapLimitMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  /** Conteneur entier hors cache récupérable (cgroup), sinon null. */
  containerUsedMb: number | null;
  containerLimitMb: number | null;
  limitSource: 'CONTAINER_MEMORY' | 'cgroup' | null;
}

export interface MemorySettings {
  disabled: boolean;
  sampleMs: number;
  activeSampleMs: number;
  logEveryMs: number;
  alertPercent: number;
  admissionPercent: number;
  admissionMaxWaitMs: number;
  taskLogMinMb: number;
  alertConsecutive: number;
  alertRepeatMs: number;
  recoverAfterMs: number;
}

const int = (env: Env, name: string, def: number, min: number, max: number): number => {
  const raw = (env[name] ?? '').trim();
  if (!/^\d+$/.test(raw)) return def;
  const n = Number(raw);
  return n >= min && n <= max ? n : def;
};

/** Réglages (pur). Toute valeur hors bornes reprend son défaut. */
export function memorySettings(env: Env = process.env): MemorySettings {
  const alertPercent = int(env, 'MEMORY_ALERT_PERCENT', 85, 50, 98);
  return {
    disabled: (env.MEMORY_MONITOR_DISABLED ?? '').trim() === 'true',
    sampleMs: int(env, 'MEMORY_SAMPLE_MS', 60_000, 5_000, 3_600_000),
    activeSampleMs: 5_000,
    logEveryMs: int(env, 'MEMORY_LOG_EVERY_MS', 60_000, 0, 86_400_000),
    alertPercent,
    admissionPercent: Math.min(int(env, 'MEMORY_ADMISSION_PERCENT', 75, 40, 95), alertPercent),
    admissionMaxWaitMs: int(env, 'MEMORY_ADMISSION_MAX_WAIT_MS', 600_000, 0, 86_400_000),
    taskLogMinMb: int(env, 'MEMORY_TASK_LOG_MIN_MB', 32, 0, 100_000),
    alertConsecutive: 2,
    alertRepeatMs: 15 * 60_000,
    recoverAfterMs: 30 * 60_000,
  };
}

// ── Lecture du conteneur (pur, injectable) ─────────────────────────────────

/** Octets → Mo ; `max`, vide ou absurde → null. */
export function parseLimitMb(text: string | null | undefined): number | null {
  const t = String(text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const mb = Math.floor(Number(t) / MB);
  return mb > 0 && mb < NO_LIMIT_MB ? mb : null;
}

/** Valeur d'une clé de `memory.stat` (octets), ou null. */
export function statValue(statText: string | null | undefined, key: string): number | null {
  const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(String(statText ?? ''));
  return m ? Number(m[1]) : null;
}

const tryRead = (read: Read, path: string): string | null => {
  try { return read(path); } catch { return null; }
};

/**
 * Limite et usage du conteneur. Limite : CONTAINER_MEMORY (octets, Scalingo),
 * puis cgroup v2, puis v1. Usage : cgroup v2 (`memory.current − inactive_file`)
 * ou v1 (`usage_in_bytes − total_inactive_file`) ; null si illisible.
 *
 * L'usage du cgroup n'est retenu que si CE cgroup porte une limite chiffrée
 * (sinon c'est un groupe plus large que le conteneur : mesure locale du
 * 04/11, 2,3 Go « utilisés » pour un processus de 170 Mo) et s'il reste
 * plausible (≤ 1,5 × la limite) ; à défaut, la RSS du processus sert.
 */
export function readContainerMemory(env: Env = process.env, read: Read = (p) => readFileSync(p, 'utf8')): Pick<MemorySample, 'containerUsedMb' | 'containerLimitMb' | 'limitSource'> {
  let containerLimitMb: number | null = null;
  let limitSource: MemorySample['limitSource'] = null;
  const fromEnv = parseLimitMb(env.CONTAINER_MEMORY);
  if (fromEnv) { containerLimitMb = fromEnv; limitSource = 'CONTAINER_MEMORY'; }
  const v2Max = tryRead(read, '/sys/fs/cgroup/memory.max');
  const v1Max = v2Max === null ? tryRead(read, '/sys/fs/cgroup/memory/memory.limit_in_bytes') : null;
  const cgLimit = parseLimitMb(v2Max ?? v1Max);
  if (!containerLimitMb && cgLimit) { containerLimitMb = cgLimit; limitSource = 'cgroup'; }
  let containerUsedMb: number | null = null;
  if (!cgLimit) {
    // Pas de limite sur ce cgroup : son usage ne représente pas le conteneur.
  } else if (v2Max !== null) {
    const cur = Number(String(tryRead(read, '/sys/fs/cgroup/memory.current') ?? '').trim());
    if (Number.isFinite(cur) && cur > 0) {
      const inactive = statValue(tryRead(read, '/sys/fs/cgroup/memory.stat'), 'inactive_file') ?? 0;
      containerUsedMb = Math.max(0, Math.round((cur - inactive) / MB));
    }
  } else if (v1Max !== null) {
    const cur = Number(String(tryRead(read, '/sys/fs/cgroup/memory/memory.usage_in_bytes') ?? '').trim());
    if (Number.isFinite(cur) && cur > 0) {
      const inactive = statValue(tryRead(read, '/sys/fs/cgroup/memory/memory.stat'), 'total_inactive_file') ?? 0;
      containerUsedMb = Math.max(0, Math.round((cur - inactive) / MB));
    }
  }
  if (containerUsedMb !== null && containerLimitMb && containerUsedMb > containerLimitMb * 1.5) containerUsedMb = null;
  return { containerUsedMb, containerLimitMb, limitSource };
}

export function takeSample(env: Env = process.env, read?: Read): MemorySample {
  const m = process.memoryUsage();
  const h = getHeapStatistics();
  return {
    at: Date.now(),
    rssMb: Math.round(m.rss / MB),
    heapUsedMb: Math.round(m.heapUsed / MB),
    heapTotalMb: Math.round(m.heapTotal / MB),
    heapLimitMb: Math.round(h.heap_size_limit / MB),
    externalMb: Math.round(m.external / MB),
    arrayBuffersMb: Math.round(m.arrayBuffers / MB),
    ...readContainerMemory(env, read),
  };
}

/** Mémoire comptée contre le quota : conteneur si lisible, sinon RSS du processus. */
export function usedMb(s: Pick<MemorySample, 'containerUsedMb' | 'rssMb'>): number {
  return s.containerUsedMb ?? s.rssMb;
}

/** Niveau de pression (pur). Limite inconnue → `unknown`. */
export function pressureLevel(s: Pick<MemorySample, 'containerUsedMb' | 'rssMb' | 'containerLimitMb'>, settings: Pick<MemorySettings, 'alertPercent' | 'admissionPercent'>): MemoryLevel {
  if (!s.containerLimitMb) return 'unknown';
  const pct = (usedMb(s) / s.containerLimitMb) * 100;
  if (pct >= settings.alertPercent) return 'critical';
  if (pct >= settings.admissionPercent) return 'high';
  return 'ok';
}

// ── Alerte (machine d'état pure) ───────────────────────────────────────────

export interface AlertState {
  consecutiveCritical: number;
  open: boolean;
  lastReportAt: number | null;
  belowSince: number | null;
}
export const initialAlertState = (): AlertState => ({ consecutiveCritical: 0, open: false, lastReportAt: null, belowSince: null });

/**
 * Décide d'un signalement : `report` après `alertConsecutive` échantillons
 * critiques (puis au plus un par `alertRepeatMs`), `resolve` après
 * `recoverAfterMs` passées sous le seuil d'admission. Pur.
 */
export function nextAlert(state: AlertState, level: MemoryLevel, now: number, s: Pick<MemorySettings, 'alertConsecutive' | 'alertRepeatMs' | 'recoverAfterMs'>): { state: AlertState; action: 'report' | 'resolve' | null } {
  const st = { ...state };
  if (level === 'critical') {
    st.consecutiveCritical += 1;
    st.belowSince = null;
    if (st.consecutiveCritical >= s.alertConsecutive && (st.lastReportAt === null || now - st.lastReportAt >= s.alertRepeatMs)) {
      st.open = true;
      st.lastReportAt = now;
      return { state: st, action: 'report' };
    }
    return { state: st, action: null };
  }
  st.consecutiveCritical = 0;
  if (level === 'ok') {
    st.belowSince ??= now;
    if (st.open && now - st.belowSince >= s.recoverAfterMs) {
      st.open = false;
      st.lastReportAt = null;
      return { state: st, action: 'resolve' };
    }
  } else {
    st.belowSince = null;
  }
  return { state: st, action: null };
}

// ── Admission des traitements lourds (pure) ────────────────────────────────

/**
 * Lancer maintenant un traitement lourd ? Pression `high`/`critical` → différé,
 * sauf s'il attend depuis `maxWaitMs` (jamais de famine). `waitingSince` : début
 * de l'attente de ce type de traitement (null = pas en attente).
 */
export function decideAdmission(level: MemoryLevel, waitingSince: number | null, now: number, maxWaitMs: number): { allow: boolean; forced: boolean } {
  if (level !== 'high' && level !== 'critical') return { allow: true, forced: false };
  if (waitingSince !== null && now - waitingSince >= maxWaitMs) return { allow: true, forced: true };
  return { allow: false, forced: false };
}

// ── État du processus (porté par globalThis : Next charge les modules plusieurs fois) ──

interface ActiveTask { id: number; kind: string; startedAt: number; startUsedMb: number; peakUsedMb: number; peakRssMb: number; peakHeapMb: number; concurrent: boolean }
export interface TaskPeak { kind: string; runs: number; maxPeakUsedMb: number; maxDeltaMb: number; maxPeakRssMb: number; lastPeakUsedMb: number; lastDeltaMb: number; lastAt: string }

interface MonitorState {
  started: boolean;
  processType: string;
  settings: MemorySettings;
  last: MemorySample | null;
  peak: { usedMb: number; at: string } | null;
  active: Map<number, ActiveTask>;
  nextId: number;
  peaks: Map<string, TaskPeak>;
  waiting: Map<string, number>;
  alert: AlertState;
  lastLogAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  onAlert: ((s: MemorySample, ctx: AlertContext) => void) | null;
  onRecover: ((s: MemorySample, ctx: AlertContext) => void) | null;
}
export interface AlertContext { processType: string; activeTasks: string[]; topPeaks: TaskPeak[]; percent: number | null }

const KEY = Symbol.for('verebona.runtime.memory-monitor');
function state(): MonitorState {
  const g = globalThis as unknown as Record<symbol, MonitorState | undefined>;
  return (g[KEY] ??= {
    started: false, processType: 'web', settings: memorySettings(), last: null, peak: null,
    active: new Map(), nextId: 1, peaks: new Map(), waiting: new Map(), alert: initialAlertState(),
    lastLogAt: 0, timer: null, onAlert: null, onRecover: null,
  });
}

const percentOf = (s: MemorySample): number | null => (s.containerLimitMb ? Math.round((usedMb(s) / s.containerLimitMb) * 100) : null);

function topPeaks(n = 5): TaskPeak[] {
  return [...state().peaks.values()].sort((a, b) => b.maxPeakUsedMb - a.maxPeakUsedMb).slice(0, n);
}

/** Échantillonne, met à jour les pics des tâches actives et l'alerte. Ne lève jamais. */
export function sampleNow(): MemorySample | null {
  const st = state();
  let s: MemorySample;
  try { s = takeSample(); } catch { return null; }
  st.last = s;
  const used = usedMb(s);
  if (!st.peak || used > st.peak.usedMb) st.peak = { usedMb: used, at: new Date(s.at).toISOString() };
  for (const t of st.active.values()) {
    t.peakUsedMb = Math.max(t.peakUsedMb, used);
    t.peakRssMb = Math.max(t.peakRssMb, s.rssMb);
    t.peakHeapMb = Math.max(t.peakHeapMb, s.heapUsedMb);
    if (st.active.size > 1) t.concurrent = true;
  }
  const level = pressureLevel(s, st.settings);
  const { state: next, action } = nextAlert(st.alert, level, s.at, st.settings);
  st.alert = next;
  const ctx = (): AlertContext => ({ processType: st.processType, activeTasks: [...st.active.values()].map((t) => t.kind), topPeaks: topPeaks(), percent: percentOf(s) });
  if (action === 'report') {
    console.error(`[memory] ${JSON.stringify({ event: 'pressure', process: st.processType, level, usedMb: used, limitMb: s.containerLimitMb, percent: percentOf(s), rssMb: s.rssMb, heapUsedMb: s.heapUsedMb, activeTasks: ctx().activeTasks })}`);
    try { st.onAlert?.(s, ctx()); } catch { /* jamais bloquant */ }
  } else if (action === 'resolve') {
    try { st.onRecover?.(s, ctx()); } catch { /* jamais bloquant */ }
  }
  if (st.settings.logEveryMs > 0 && s.at - st.lastLogAt >= st.settings.logEveryMs) {
    st.lastLogAt = s.at;
    console.info(`[memory] ${JSON.stringify({
      event: 'sample', process: st.processType, rssMb: s.rssMb, heapUsedMb: s.heapUsedMb, heapTotalMb: s.heapTotalMb, heapLimitMb: s.heapLimitMb,
      externalMb: s.externalMb, arrayBuffersMb: s.arrayBuffersMb, containerUsedMb: s.containerUsedMb, containerLimitMb: s.containerLimitMb,
      percent: percentOf(s), level, activeTasks: [...st.active.values()].map((t) => t.kind),
    })}`);
  }
  return s;
}

function schedule(): void {
  const st = state();
  if (!st.started) return;
  if (st.timer) clearTimeout(st.timer);
  const every = st.active.size > 0 ? st.settings.activeSampleMs : st.settings.sampleMs;
  st.timer = setTimeout(() => { sampleNow(); schedule(); }, every);
  st.timer.unref?.();
}

/** Démarre l'échantillonnage de ce processus (idempotent). */
export function startMemoryMonitor(opts: { processType: string; onAlert?: MonitorState['onAlert']; onRecover?: MonitorState['onRecover'] }): void {
  const st = state();
  st.settings = memorySettings();
  if (st.started || st.settings.disabled) {
    if (st.settings.disabled) console.info('[memory] mesure désactivée (MEMORY_MONITOR_DISABLED=true).');
    return;
  }
  st.started = true;
  st.processType = opts.processType;
  st.onAlert = opts.onAlert ?? null;
  st.onRecover = opts.onRecover ?? null;
  let s: MemorySample | null = null;
  try { s = takeSample(); } catch { /* mesure impossible : journal sans valeurs */ }
  console.info(`[memory] ${JSON.stringify({
    event: 'start', process: st.processType, heapLimitMb: s?.heapLimitMb ?? null, containerLimitMb: s?.containerLimitMb ?? null,
    limitSource: s?.limitSource ?? null, containerMeasured: s?.containerUsedMb != null,
    alertPercent: st.settings.alertPercent, admissionPercent: st.settings.admissionPercent, sampleMs: st.settings.sampleMs,
  })}`);
  sampleNow();
  schedule();
}

/**
 * Suit la mémoire pendant `fn` (pic, écart, durée) sous le code `kind`
 * (ex. `task:coherence-control`, `queue:T1`, `export:v12`). Ne change rien
 * au résultat ni aux erreurs de `fn`.
 */
export async function trackMemory<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  const st = state();
  const s0 = st.started ? (sampleNow() ?? st.last) : null;
  const id = st.nextId++;
  const start = s0 ? usedMb(s0) : 0;
  const t: ActiveTask = { id, kind, startedAt: Date.now(), startUsedMb: start, peakUsedMb: start, peakRssMb: s0?.rssMb ?? 0, peakHeapMb: s0?.heapUsedMb ?? 0, concurrent: st.active.size > 0 };
  for (const o of st.active.values()) o.concurrent = true;
  st.active.set(id, t);
  if (st.started && st.active.size === 1) schedule();
  try {
    return await fn();
  } finally {
    if (st.started) sampleNow();
    st.active.delete(id);
    if (st.started && st.active.size === 0) schedule();
    if (s0) recordTask(t);
  }
}

function recordTask(t: ActiveTask): void {
  const st = state();
  const delta = Math.max(0, t.peakUsedMb - t.startUsedMb);
  const durationMs = Date.now() - t.startedAt;
  const p = st.peaks.get(t.kind) ?? { kind: t.kind, runs: 0, maxPeakUsedMb: 0, maxDeltaMb: 0, maxPeakRssMb: 0, lastPeakUsedMb: 0, lastDeltaMb: 0, lastAt: '' };
  p.runs += 1;
  p.maxPeakUsedMb = Math.max(p.maxPeakUsedMb, t.peakUsedMb);
  p.maxDeltaMb = Math.max(p.maxDeltaMb, delta);
  p.maxPeakRssMb = Math.max(p.maxPeakRssMb, t.peakRssMb);
  p.lastPeakUsedMb = t.peakUsedMb;
  p.lastDeltaMb = delta;
  p.lastAt = new Date().toISOString();
  st.peaks.set(t.kind, p);
  if (delta >= st.settings.taskLogMinMb || durationMs >= 60_000) {
    console.info(`[memory] ${JSON.stringify({ event: 'task', process: st.processType, kind: t.kind, durationMs, startMb: t.startUsedMb, peakMb: t.peakUsedMb, deltaMb: delta, peakRssMb: t.peakRssMb, peakHeapMb: t.peakHeapMb, concurrent: t.concurrent, limitMb: st.last?.containerLimitMb ?? null })}`);
  }
}

/**
 * Admission d'un traitement lourd de type `kind` : rend `true` s'il peut
 * partir maintenant. Taille du conteneur inconnue ou mesure désactivée →
 * toujours `true` (comportement d'avant).
 */
export function admitHeavyTask(kind: string, now: number = Date.now()): boolean {
  const st = state();
  if (!st.started) return true;
  const s = sampleNow() ?? st.last;
  if (!s) return true;
  const level = pressureLevel(s, st.settings);
  const since = st.waiting.get(kind) ?? null;
  const d = decideAdmission(level, since, now, st.settings.admissionMaxWaitMs);
  if (d.allow) {
    if (d.forced) console.warn(`[memory] ${JSON.stringify({ event: 'admission-forced', process: st.processType, kind, waitedMs: now - (since ?? now), usedMb: usedMb(s), limitMb: s.containerLimitMb })}`);
    st.waiting.delete(kind);
    return true;
  }
  if (since === null) {
    st.waiting.set(kind, now);
    console.warn(`[memory] ${JSON.stringify({ event: 'admission-deferred', process: st.processType, kind, level, usedMb: usedMb(s), limitMb: s.containerLimitMb, percent: percentOf(s) })}`);
  }
  return false;
}

/** Vue sans secret pour la santé (BO › Exploitation). */
export function memorySnapshot(): { started: boolean; processType: string; last: MemorySample | null; level: MemoryLevel; peak: MonitorState['peak']; activeTasks: string[]; taskPeaks: TaskPeak[]; settings: Pick<MemorySettings, 'alertPercent' | 'admissionPercent' | 'sampleMs'> } {
  const st = state();
  return {
    started: st.started,
    processType: st.processType,
    last: st.last,
    level: st.last ? pressureLevel(st.last, st.settings) : 'unknown',
    peak: st.peak,
    activeTasks: [...st.active.values()].map((t) => t.kind),
    taskPeaks: topPeaks(10),
    settings: { alertPercent: st.settings.alertPercent, admissionPercent: st.settings.admissionPercent, sampleMs: st.settings.sampleMs },
  };
}

/** Réservé aux tests. */
export function __resetMemoryMonitorForTests(): void {
  const st = state();
  if (st.timer) clearTimeout(st.timer);
  const g = globalThis as unknown as Record<symbol, MonitorState | undefined>;
  delete g[KEY];
}
