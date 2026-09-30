/**
 * Commutateur de la lecture canonique de l'assistant — CDC 15 §9 (lot 15).
 *
 *   ASSISTANT_CANONICAL_READ = legacy (défaut) | enabled.
 *
 * Pas de mode observation pour l'assistant (plan, § Déploiement) : une
 * valeur `shadow` se comporte EXACTEMENT comme `legacy` ; elle est signalée
 * une fois par processus. Lu à chaque appel.
 */
import { getRolloutMode } from '@/services/canonical/rollout';

let shadowSignale = false;

export type AssistantReadMode = 'legacy' | 'enabled';

export function assistantReadMode(env: Record<string, string | undefined> = process.env): AssistantReadMode {
  const m = getRolloutMode('ASSISTANT_CANONICAL_READ', env);
  if (m === 'shadow' && !shadowSignale) {
    shadowSignale = true;
    console.info(JSON.stringify({
      event: 'assistant.canonical_read_shadow_ignored',
      message: 'ASSISTANT_CANONICAL_READ=shadow : l’assistant n’a pas de mode observation, comportement legacy.',
    }));
  }
  return m === 'enabled' ? 'enabled' : 'legacy';
}

export const canonicalReadEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  assistantReadMode(env) === 'enabled';

/** Réservé aux tests. */
export function __resetAssistantReadModeForTests(): void {
  shadowSignale = false;
}
