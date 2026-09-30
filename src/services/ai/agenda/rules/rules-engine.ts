/**
 * Choix du moteur de classification — arbitrage lead, lot 14.
 *
 * « Rien ne change en production sans commutateur » : les corrections T4-02
 * (plus de « champ de bien ⇒ information ») et T4-11 (règles métier stables,
 * plus de « assurance = information ») modifient l'accueil et les
 * notifications. Elles ne s'appliquent donc que :
 *   · sous `AI_T4_EFFECTS=enabled`, ou
 *   · si la version de configuration met T4 en architecture `master`.
 * En `shadow`, le résultat historique est conservé et les divergences sont
 * journalisées ; en `legacy`, résultat strictement identique à avant.
 */
import { t4EffectsMode, type RolloutMode } from '@/services/canonical/rollout';
import type { PromptArchitecture } from '../../config/config-types';
import {
  classifyByRulesDetailed, type RuleClassification, type RulesEngine,
} from './deterministic-classification';
import type { AgendaClassificationInput } from '../types';

export type ClassificationMode = 'legacy' | 'shadow' | 'v2';

export function classificationMode(t4Effects: RolloutMode, architecture: PromptArchitecture): ClassificationMode {
  if (t4Effects === 'enabled' || architecture === 'master') return 'v2';
  return t4Effects === 'shadow' ? 'shadow' : 'legacy';
}

/** Mode courant (commutateur + version de configuration effective). Ne lève pas. */
export async function resolveClassificationMode(opts: {
  t4Effects?: RolloutMode; architecture?: PromptArchitecture;
} = {}): Promise<ClassificationMode> {
  const t4Effects = opts.t4Effects ?? t4EffectsMode();
  let architecture = opts.architecture;
  if (!architecture) {
    try {
      architecture = await (await import('../../config/config-resolver')).getPromptArchitecture('T4');
    } catch {
      architecture = 'steps';
    }
  }
  return classificationMode(t4Effects, architecture);
}

/**
 * Règles selon le mode. `shadow` : résultat historique, divergence avec le
 * moteur v2 journalisée (catégorie ou abstention différente).
 */
export function classifyByRulesInMode(input: AgendaClassificationInput, mode: ClassificationMode): RuleClassification | null {
  const engine: RulesEngine = mode === 'v2' ? 'v2' : 'legacy';
  const retenu = classifyByRulesDetailed(input, engine);
  if (mode === 'shadow') {
    const v2 = classifyByRulesDetailed(input, 'v2');
    if ((retenu?.category ?? null) !== (v2?.category ?? null)) {
      console.info(
        `[agenda][shadow] T4-02/T4-11 : classification divergente — « ${input.title} »`
        + `${input.originFieldKey ? ` (champ ${input.originFieldKey})` : ''} : historique=${retenu?.category ?? 'modèle'}, `
        + `v2=${v2?.category ?? 'modèle'}${v2 ? ` [${v2.ruleCode}]` : ''}`,
      );
    }
  }
  return retenu;
}
