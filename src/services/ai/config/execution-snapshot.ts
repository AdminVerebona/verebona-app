/**
 * Instantané de configuration d'une EXÉCUTION — lot 87A (CDC Pilotage IA V2
 * P7 : RUN-04, DEC-04, R16, R53, R54 ; corrige la limite signalée au lot
 * 86B).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST FIGÉ, ET QUAND
 *
 * La configuration EFFECTIVE (version + révision, lignes des traitements,
 * prompts maîtres actifs, surcouche de routage 86B : exclusions et
 * promotions) est relevée UNE fois au démarrage de l'exécution, puis lue
 * telle quelle par tous ses appels :
 *   · travail de file (T1, T3, T4) : au prélèvement, avec la révision déjà
 *     épinglée (VER-015/016) — `AiJobContext.configSnapshot` ;
 *   · exécution SYNCHRONE à plusieurs appels (T2 : compréhension, réponse,
 *     revalidation ; T6 : version de prompt lue puis génération / évaluation ;
 *     analyse T1 hors file) : `runWithConfigSnapshot`.
 * Avant le lot 87, la révision était figée mais la surcouche de routage
 * était relue à chaque appel quand la révision épinglée était l'active : une
 * promotion prise en cours d'exécution changeait le modèle de tête au milieu
 * du travail. Une activation, un import ou une promotion ne touchent donc
 * plus que les exécutions qui DÉMARRENT ensuite (R16, R53, R54).
 *
 * L'instantané vit en mémoire le temps de l'exécution (référence à l'objet
 * de configuration publié par le résolveur, jamais modifié après
 * publication). Une tentative de file qui reprend (nouvelle tentative,
 * reprise après suspension, processus redémarré) est une NOUVELLE exécution :
 * elle relève la configuration du moment — c'est la « reprise depuis un
 * point sûr » explicite du RUN-04, tracée sur ses appels.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentJobContext } from '../queue/job-context';
import type { Treatment } from './treatments';
import type { TreatmentConfig } from './config-types';
import type { RoutingOverlay } from './routing-overlay';
import type { ActiveMasterPrompt } from '../master-prompts/master-prompt-runtime';

/** Configuration effective telle que publiée par le résolveur (immuable après publication). */
export interface EffectiveConfigState {
  versionId: number | null;
  visibleNumber: number | null;
  revisionId?: number | null;
  revisionNumber?: number | null;
  byTreatment: Map<string, TreatmentConfig>;
  masterPrompts?: Map<string, ActiveMasterPrompt>;
  overlay?: RoutingOverlay;
}

export interface ExecutionConfigSnapshot {
  scope: 'job' | 'sync';
  treatment: Treatment | null;
  takenAt: string;
  effective: EffectiveConfigState;
}

const storage = new AsyncLocalStorage<ExecutionConfigSnapshot>();

/** Instantané de l'exécution synchrone courante, ou `null`. */
export function currentSyncConfigSnapshot(): ExecutionConfigSnapshot | null {
  return storage.getStore() ?? null;
}

/**
 * Relevé de la configuration effective, enregistré par le résolveur à son
 * chargement (`config-resolver#captureExecutionSnapshot`) : aucun import
 * dynamique ni cycle de modules, et aucun délai ajouté avant l'exécution (les
 * déduplications « en vol » des appelants restent synchrones). Résolveur non
 * chargé (doubles de test) : aucun instantané.
 */
type Capture = (scope: 'job' | 'sync', treatment: Treatment | null) => Promise<ExecutionConfigSnapshot>;
let capture: Capture | null = null;
export function registerExecutionSnapshotCapture(fn: Capture | null): void {
  capture = fn;
}

/**
 * Exécute une exécution SYNCHRONE à plusieurs appels (T2, T6, analyse T1
 * hors file) sous la configuration relevée à son démarrage (RUN-04, R53).
 * Sans effet dans un travail de file (déjà figé au prélèvement) ou sous un
 * instantané déjà posé (l'exécution englobante fait foi). Ne lève jamais de
 * lui-même : configuration illisible → exécution sans instantané (résolution
 * par appel, comportement antérieur).
 */
export async function runWithConfigSnapshot<T>(treatment: Treatment | null, fn: () => Promise<T>): Promise<T> {
  let enFile = false;
  try { enFile = currentJobContext() !== null; } catch { enFile = false; }
  if (storage.getStore() || enFile || !capture) return fn();
  let snapshot: ExecutionConfigSnapshot | null = null;
  try {
    snapshot = await capture('sync', treatment);
  } catch {
    snapshot = null;
  }
  return snapshot ? storage.run(snapshot, fn) : fn();
}

/** Métadonnée tracée avec un appel : instantané appliqué (sans contenu). */
export function snapshotTrace(s: ExecutionConfigSnapshot | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  return {
    scope: s.scope, takenAt: s.takenAt, versionId: s.effective.versionId, revisionId: s.effective.revisionId ?? null,
    promotions: s.effective.overlay ? [...s.effective.overlay.promotions.entries()].map(([op, p]) => ({ operationCode: op, model: p.model, promotionId: p.promotionId })) : [],
    exclusions: s.effective.overlay ? s.effective.overlay.exclusions.filter((x) => x.kind === 'EXCLUSION').length : 0,
  };
}
