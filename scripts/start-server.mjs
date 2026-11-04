/**
 * Lancement des processus Scalingo — lot 109H (conteneur web tué pour
 * dépassement du quota mémoire, constat PO du 03-04/11/2026).
 *
 *   web:    node scripts/start-server.mjs web
 *   worker: node scripts/start-server.mjs worker
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE LANCEUR (et plus `npm start`)
 *
 *  · `npm start` gardait un processus npm vivant (≈ 60 Mo mesurés en local)
 *    à côté du serveur, dans le même quota, pour rien : c'est lui qui écrit
 *    « npm notice » après le « Killed » du journal Scalingo. Ici, le processus
 *    est REMPLACÉ par le serveur Next (`process.execve`, Node ≥ 23.11) : un
 *    seul processus Node, qui reçoit directement les signaux de Scalingo.
 *    Repli (execve indisponible) : processus enfant, signaux relayés.
 *  · Limite du tas V8 (`--max-old-space-size`) posée explicitement et
 *    paramétrable : la taille du conteneur est lue dans `CONTAINER_MEMORY`
 *    (posée par Scalingo, en octets) puis dans le cgroup ; sans aucune des
 *    deux, aucune limite n'est posée (comportement d'avant).
 *  · Séparation web / worker ACTIVABLE (BACKGROUND_JOBS_PROCESS) : par
 *    défaut (`web`), le conteneur web garde ses traitements de fond comme
 *    avant et le type `worker` du Procfile — à 0 conteneur tant que le PO ne
 *    le dimensionne pas — reste en veille sans démarrer Next.
 *
 * Variables (toutes facultatives) :
 *   NODE_MAX_OLD_SPACE_MB   entier (Mo) | `auto` (défaut) | `off`
 *   NODE_HEAP_PERCENT       part du conteneur donnée au tas en `auto` (défaut 60, 25 à 75)
 *   BACKGROUND_JOBS_PROCESS `web` (défaut) | `worker`
 *   NODE_OPTIONS            respectée : une limite déjà posée n'est pas remplacée
 *
 * `postdeploy` (migrations) n'est PAS concerné : il garde sa propre commande.
 * Aucun secret n'est lu ni journalisé : seules des tailles et des rôles.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Types de processus du Procfile. */
export const PROCESS_TYPES = Object.freeze(['web', 'worker']);
/** Où tournent les traitements de fond (défaut : conteneur web, comme avant le lot 109H). */
export const JOBS_PLACEMENTS = Object.freeze(['web', 'worker']);
export const DEFAULT_HEAP_PERCENT = 60;
/** Plancher du tas en mode `auto` : en dessous, Next ne démarre pas sereinement. */
export const MIN_AUTO_HEAP_MB = 384;
/** Marge laissée hors tas (code, tampons natifs, Chromium…) en mode `auto`. */
export const MIN_OFF_HEAP_MB = 256;

const MB = 1024 * 1024;

/** @typedef {Record<string, string | undefined>} Env */
/** @typedef {{ mb: number | null, source: 'CONTAINER_MEMORY' | 'cgroup' | null }} Limit */
/** Au-delà d'1 Tio, une « limite » cgroup signifie « pas de limite ». */
const NO_LIMIT_MB = 1024 * 1024;

/**
 * Placement des traitements de fond (pur). Valeur inconnue → `web` + avertissement.
 * @param {Env} [env]
 * @returns {{ placement: string, warning: string | null }}
 */
export function jobsPlacement(env = process.env) {
  const raw = String(env.BACKGROUND_JOBS_PROCESS ?? '').trim().toLowerCase();
  if (raw === '') return { placement: 'web', warning: null };
  if (JOBS_PLACEMENTS.includes(raw)) return { placement: raw, warning: null };
  return { placement: 'web', warning: `BACKGROUND_JOBS_PROCESS=« ${raw.slice(0, 40)} » inconnu : valeur « web » appliquée (traitements de fond dans le conteneur web).` };
}

/**
 * Limite mémoire du conteneur en Mo (pur) : CONTAINER_MEMORY (octets), puis cgroup.
 * @param {Env} [env]
 * @param {string | null} [cgroupText]
 * @returns {Limit}
 */
export function containerLimitMb(env = process.env, cgroupText = null) {
  const fromEnv = Number(String(env.CONTAINER_MEMORY ?? '').trim());
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    const mb = Math.floor(fromEnv / MB);
    if (mb > 0 && mb < NO_LIMIT_MB) return { mb, source: 'CONTAINER_MEMORY' };
  }
  const txt = String(cgroupText ?? '').trim();
  if (/^\d+$/.test(txt)) {
    const mb = Math.floor(Number(txt) / MB);
    if (mb > 0 && mb < NO_LIMIT_MB) return { mb, source: 'cgroup' };
  }
  return { mb: null, source: null };
}

function readCgroupLimit() {
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { return readFileSync(p, 'utf8'); } catch { /* absent */ }
  }
  return null;
}

/**
 * Limite du tas à poser (pur). Rend `{ mb, reason }` ; `mb = null` → aucune
 * option ajoutée (comportement d'avant).
 * @param {Env} [env]
 * @param {Limit} [limit]
 * @returns {{ mb: number | null, reason: string }}
 */
export function heapLimit(env = process.env, limit = { mb: null, source: null }) {
  if (/--max-old-space-size[= ]/.test(String(env.NODE_OPTIONS ?? ''))) {
    return { mb: null, reason: 'NODE_OPTIONS fixe déjà --max-old-space-size : valeur conservée' };
  }
  const raw = String(env.NODE_MAX_OLD_SPACE_MB ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0') return { mb: null, reason: 'NODE_MAX_OLD_SPACE_MB=off : aucune limite posée' };
  if (raw !== '' && raw !== 'auto') {
    if (/^\d+$/.test(raw) && Number(raw) >= 128 && Number(raw) <= 16384) return { mb: Number(raw), reason: 'NODE_MAX_OLD_SPACE_MB' };
    return { mb: autoHeap(env, limit), reason: `NODE_MAX_OLD_SPACE_MB=« ${raw.slice(0, 20)} » invalide (entier 128 à 16384, auto ou off) : mode auto` };
  }
  const mb = autoHeap(env, limit);
  return { mb, reason: mb === null ? 'taille du conteneur inconnue : aucune limite posée' : `auto (${limit.source})` };
}

/** @param {Env} env @param {Limit} limit @returns {number | null} */
function autoHeap(env, limit) {
  if (!limit.mb) return null;
  const p = Number(String(env.NODE_HEAP_PERCENT ?? '').trim());
  const percent = Number.isFinite(p) && p >= 25 && p <= 75 ? p : DEFAULT_HEAP_PERCENT;
  const wanted = Math.floor((limit.mb * percent) / 100);
  // Plafond : la marge hors tas est toujours laissée (au moins 256 Mo de tas).
  const hi = Math.max(256, limit.mb - MIN_OFF_HEAP_MB);
  const lo = Math.min(MIN_AUTO_HEAP_MB, hi);
  return Math.min(hi, Math.max(lo, wanted));
}

/**
 * @typedef {{ mode: 'next' | 'idle', processType: string, placement: string, notes: string[],
 *   nodeArgs: string[], nextArgs: string[], nextBin: string, env: Env,
 *   heap: { mb: number | null, reason: string }, limit: Limit }} LaunchPlan
 */
/**
 * Plan de lancement (pur, testé) : que faire pour ce type de processus.
 *   · `next`  : serveur Next (`next start`), options Node et environnement ;
 *   · `idle`  : conteneur worker alors que les traitements restent dans le
 *               conteneur web — veille, sans Next (quelques dizaines de Mo).
 * @param {{ processType: string, env?: Env, cgroupText?: string | null, nextBin?: string }} input
 * @returns {LaunchPlan}
 */
export function planLaunch({ processType, env = process.env, cgroupText = null, nextBin = 'node_modules/next/dist/bin/next' }) {
  const type = PROCESS_TYPES.includes(processType) ? processType : null;
  if (!type) throw new Error(`type de processus inconnu : « ${String(processType).slice(0, 20)} » (attendu : web ou worker)`);
  const { placement, warning } = jobsPlacement(env);
  const notes = warning ? [warning] : [];
  if (type === 'worker' && placement !== 'worker') {
    notes.push('BACKGROUND_JOBS_PROCESS n’est pas « worker » : les traitements de fond restent dans le conteneur web ; ce conteneur worker reste en veille (le ramener à 0 conteneur dans Scalingo).');
    return { mode: 'idle', processType: type, placement, notes, nodeArgs: [], nextArgs: [], nextBin, env: { ...env }, heap: { mb: null, reason: 'veille' }, limit: { mb: null, source: null } };
  }
  const limit = containerLimitMb(env, cgroupText);
  const heap = heapLimit(env, limit);
  const nodeArgs = heap.mb ? [`--max-old-space-size=${heap.mb}`] : [];
  // Le worker ne reçoit aucun trafic : écoute locale seulement (sonde interne).
  const nextArgs = type === 'worker' ? ['start', '-H', '127.0.0.1', '-p', String(env.PORT || 3000)] : ['start'];
  const childEnv = { ...env, APP_PROCESS_TYPE: type, BACKGROUND_JOBS_PROCESS: placement };
  return { mode: 'next', processType: type, placement, nodeArgs, nextArgs, nextBin, env: childEnv, heap, limit, notes };
}

/**
 * Ligne de journal (sans secret : rôles et tailles uniquement).
 * @param {LaunchPlan} plan
 */
export function launchLogLine(plan) {
  /** @type {Record<string, unknown>} */
  const base = { process: plan.processType, placement: plan.placement, mode: plan.mode };
  if (plan.mode === 'next') Object.assign(base, { heapMb: plan.heap.mb, heapReason: plan.heap.reason, containerMb: plan.limit.mb, containerSource: plan.limit.source });
  return `[start] ${JSON.stringify(base)}`;
}

/** @param {LaunchPlan} plan */
function runIdle(plan) {
  for (const n of plan.notes) console.warn(`[start] ${n}`);
  console.info(launchLogLine(plan));
  // Veille : le conteneur reste vivant (pas de boucle de redémarrage Scalingo).
  setInterval(() => console.warn(`[start] ${plan.notes[plan.notes.length - 1]}`), 6 * 3600_000);
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0));
}

/** @param {LaunchPlan} plan @param {string} root */
function runNext(plan, root) {
  for (const n of plan.notes) console.warn(`[start] ${n}`);
  console.info(launchLogLine(plan));
  const bin = join(root, plan.nextBin);
  if (!existsSync(bin)) {
    console.error(`[start] serveur Next introuvable (${plan.nextBin}) : dépendances non installées ?`);
    process.exit(1);
  }
  const args = [...plan.nodeArgs, bin, ...plan.nextArgs];
  if (typeof process.execve === 'function') {
    try {
      // Remplace ce processus : un seul Node dans le conteneur.
      process.execve(process.execPath, [process.execPath, ...args], plan.env);
      return;
    } catch (e) {
      console.warn(`[start] remplacement du processus impossible (${String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200)}) : lancement en processus enfant.`);
    }
  }
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: plan.env, cwd: root });
  for (const s of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) process.on(s, () => { try { child.kill(s); } catch { /* déjà arrêté */ } });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let plan;
  try {
    plan = planLaunch({ processType: process.argv[2] ?? 'web', env: process.env, cgroupText: readCgroupLimit() });
  } catch (e) {
    console.error(`[start] ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
  if (plan.mode === 'idle') runIdle(plan);
  else runNext(plan, root);
}
