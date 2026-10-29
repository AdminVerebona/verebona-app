/**
 * Lot 97A — texte, version et configuration d'exécution du prompt maître
 * EFFECTIF d'une opération, avec la même résolution que la passerelle
 * (version BO active, texte de la version de configuration, sinon fichier du
 * dépôt). Lecture seule, sans appel modèle. Sert aux capacités « activées par
 * marqueur » (T1 période facturée, T3 identité multi-documents, T4
 * représentation Agenda) : le code n'appelle l'IA que si le texte actif porte
 * le contrat — jamais d'après le seul fichier du dépôt quand une version BO
 * est active.
 */
import type { MasterExecutionConfig } from './structured-context';

export interface EffectivePrompt {
  text: string;
  /** Version tracée (`t3_master_v1@pv12:…`, `@file`…) — entre dans les mémoires anti-rappel. */
  version: string;
  /** Configuration d'exécution appliquée (LEGACY_TEMPLATE pour un master sans contrat d'exécution). */
  execution: MasterExecutionConfig;
}

/** Lève si le texte est illisible (l'appelant décide : capacité « illisible »). */
export async function effectivePromptOf(operationCode: string): Promise<EffectivePrompt> {
  const [{ resolveOperationConfig }, loader, { getOperation }, sc] = await Promise.all([
    import('@/services/ai/config/config-resolver'),
    import('@/services/ai/prompts/prompt-loader'),
    import('@/services/ai/registry/operations'),
    import('./structured-context'),
  ]);
  const op = getOperation(operationCode);
  if (!op.masterPromptCode) throw new Error(`${operationCode} : opération sans prompt maître`);
  const cfg = await resolveOperationConfig(operationCode);
  const configured = cfg.promptArchitecture === 'master' && cfg.masterPromptText?.trim() ? cfg.masterPromptText : null;
  const text = configured ?? await loader.loadMasterTemplate(op.masterPromptCode, op.useCaseCode);
  const version = loader.masterPromptVersionOf({
    masterPromptCode: op.masterPromptCode, configuredText: configured, configVersionId: cfg.configVersionId,
    promptVersionId: configured ? cfg.masterPromptVersionId ?? null : null,
  });
  const execution = sc.executionConfigFor({
    masterPromptCode: op.masterPromptCode,
    source: configured ? (cfg.masterPromptVersionId != null ? 'version' : 'config') : 'file',
    stored: (cfg as { masterExecution?: Partial<MasterExecutionConfig> | null }).masterExecution ?? null,
  });
  return { text, version, execution };
}
