/**
 * Aiguillage T1 : étapes historiques, observation du master, ou master —
 * CDC 15 §29 (étapes 11 à 14), D-04, D-18 ; plan § Déploiement.
 *
 * Deux commandes indépendantes, lues à CHAQUE lancement d'analyse :
 *
 *   · le commutateur de déploiement `AI_T1_ANALYSIS_MODE` (rollout.ts) :
 *       - `legacy`  (défaut) : pipeline historique, strictement inchangé ;
 *       - `shadow`  : pipeline historique + master EN OBSERVATION, sur un
 *                     échantillon (`AI_T1_SHADOW_SAMPLE_RATE`, défaut 0,1).
 *                     Rien n'est persisté ; seule une comparaison résumée est
 *                     journalisée. ⚠️ Coût T1 doublé sur l'échantillon :
 *                     PRÉPRODUCTION SEULEMENT (D-18) ;
 *       - `enabled` : chemin master — MAIS seulement si la version de
 *                     configuration T1 déclare `promptArchitecture = master`
 *                     (D-04 : TO_TEST en préprod, ACTIVE en prod). Sinon,
 *                     chemin historique.
 *
 *   · l'architecture de prompts portée par la version de configuration
 *     (fonction de l'infrastructure des masters, `getPromptArchitecture`).
 *
 * Le commutateur ouvre la porte ; la version de configuration décide. Ainsi,
 * un rollback de configuration ramène T1 aux étapes sans redéploiement.
 */
import { getRolloutMode, type RolloutMode } from '@/services/canonical/rollout';
import { getPromptArchitecture } from '../../config/prompt-architecture';
import { getAiEnvironment, type AiEnvironment } from '../../config/environment';

type Env = Record<string, string | undefined>;

/** Variable d'environnement du taux d'échantillonnage du mode observation. */
export const T1_SHADOW_SAMPLE_RATE_ENV = 'AI_T1_SHADOW_SAMPLE_RATE';
/** D-18 : observation sur échantillon — 10 % des analyses par défaut. */
export const DEFAULT_T1_SHADOW_SAMPLE_RATE = 0.1;

/** Chemin retenu pour UNE exécution du pipeline. */
export type T1Route =
  /** Étapes historiques seules. */
  | 'steps'
  /** Étapes historiques + master en observation (sans écriture). */
  | 'steps+shadow'
  /** Prompt maître, projection déterministe, faits ciblés. */
  | 'master';

/** Mode du commutateur `AI_T1_ANALYSIS_MODE` (`legacy` si absent ou invalide). */
export function t1AnalysisMode(env: Env = process.env): RolloutMode {
  return getRolloutMode('AI_T1_ANALYSIS_MODE', env);
}

/**
 * Taux d'échantillonnage du mode observation, borné à [0, 1]. Une valeur
 * illisible retombe sur le défaut (jamais sur 1 : une faute de frappe ne doit
 * pas doubler le coût de toutes les analyses).
 */
export function t1ShadowSampleRate(env: Env = process.env): number {
  const raw = env[T1_SHADOW_SAMPLE_RATE_ENV]?.trim();
  if (!raw) return DEFAULT_T1_SHADOW_SAMPLE_RATE;
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n)) return DEFAULT_T1_SHADOW_SAMPLE_RATE;
  return Math.min(1, Math.max(0, n));
}

/** Tirage de l'échantillon (injecté en test). */
export function sampledForShadow(rate: number, random: () => number = Math.random): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return random() < rate;
}

/**
 * Architecture de prompts de T1 dans la version de configuration effective.
 * Ne lève jamais : une configuration illisible laisse T1 sur ses étapes.
 */
export async function t1PromptArchitecture(): Promise<'steps' | 'master'> {
  try {
    return (await getPromptArchitecture('T1')) === 'master' ? 'master' : 'steps';
  } catch (e) {
    console.error('[t1-mode] architecture de prompts T1 illisible, étapes conservées :', (e as Error).message);
    return 'steps';
  }
}

/**
 * D-18 : l'observation est INTERDITE en production (coût doublé). Un
 * environnement illisible est traité comme la production : dans le doute,
 * pas de second appel facturé.
 */
function shadowAllowed(environment: () => AiEnvironment): boolean {
  try {
    return environment() !== 'production';
  } catch {
    return false;
  }
}

let refusProdJournalise = false;
/** Réinitialise le journal « une seule fois » (tests). */
export function __resetT1ModeLogForTests(): void { refusProdJournalise = false; }

export interface ResolveT1RouteOptions {
  env?: Env;
  random?: () => number;
  /** Environnement IA (injecté en test). */
  environment?: () => AiEnvironment;
  /** Lecture de l'architecture (injectée en test). */
  architecture?: () => Promise<'steps' | 'master'>;
}

/**
 * Chemin d'une exécution. Le tirage d'échantillon est fait une fois par
 * exécution (un lot entier est observé ou pas), ce qui rend la comparaison
 * lisible document par document dans un même lot.
 */
export async function resolveT1Route(opts: ResolveT1RouteOptions = {}): Promise<T1Route> {
  const env = opts.env ?? process.env;
  const mode = t1AnalysisMode(env);
  if (mode === 'legacy') return 'steps';
  if (mode === 'shadow') {
    if (!shadowAllowed(opts.environment ?? getAiEnvironment)) {
      if (!refusProdJournalise) {
        refusProdJournalise = true;
        console.warn('[t1-mode] AI_T1_ANALYSIS_MODE=shadow ignoré en production (D-18 : préproduction seulement) — comportement legacy.');
      }
      return 'steps';
    }
    return sampledForShadow(t1ShadowSampleRate(env), opts.random) ? 'steps+shadow' : 'steps';
  }
  const architecture = await (opts.architecture ?? t1PromptArchitecture)();
  return architecture === 'master' ? 'master' : 'steps';
}
