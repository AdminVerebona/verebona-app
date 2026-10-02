/**
 * Interrupteurs de l'assistant CÔTÉ SERVEUR — CDC §39 ; D-J1 (lot 21).
 *
 * `assistant-flags.ts` est pur (importé aussi par des composants client via
 * `capability-registry`) : il lit les défauts et l'environnement. Ce module
 * y branche la surcharge administrée dans le BO (`assistant-settings.ts`,
 * stockée en base) ; seuls les appelants serveur l'importent — routes,
 * orchestrateur, configuration. Une fois chargé dans un processus serveur,
 * TOUTES les lectures d'interrupteur de ce processus (y compris via
 * `capability-registry`) appliquent la valeur du BO.
 */
import { setAssistantFlagOverrideProvider } from './assistant-flags';
import { settingOverride } from './assistant-settings';

setAssistantFlagOverrideProvider((flag) => {
  const o = settingOverride(flag);
  return typeof o === 'boolean' ? o : undefined;
});

export { FLAG_NAMES, isAssistantFlagOn, assistantFlagsSnapshot, type AssistantFlag } from './assistant-flags';
