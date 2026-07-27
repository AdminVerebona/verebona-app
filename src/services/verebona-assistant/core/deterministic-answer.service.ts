/**
 * Réponses déterministes — CDC §14.
 *
 * Quand une réponse peut être produite sans IA (politesses, aide, ouverture de page,
 * lecture d'un champ exact, comptage, échéance, statut, calcul), c'est OBLIGATOIRE :
 * l'IA est alors interdite (§4.6, §14.1). Ce service ne fait pas d'appel Gemini.
 *
 * Le calcul des dates/montants se fait par le code (jamais par le modèle — §14.4).
 */
import type { VerebonaIntent } from '../types/intents';
import type { ActionIntent } from '../types/actions';

export interface DeterministicResult {
  handled: boolean;
  answer?: string;
  actionIntents?: ActionIntent[];
  /** Indique si un retrieval SQL simple reste nécessaire (comptage, fact…). */
  needsSimpleRetrieval?: boolean;
}

const TEMPLATES: Partial<Record<VerebonaIntent, string>> = {
  GREETING: 'Bonjour ! Je peux vous aider à retrouver un bien, un document ou une échéance. Que puis-je faire pour vous ?',
  THANKS: 'Avec plaisir. Je reste à votre disposition.',
  GOODBYE: 'À bientôt ! N’hésitez pas à me solliciter dès que vous en avez besoin.',
  OUT_OF_SCOPE: "Je suis l’assistant de Verebona : je peux vous aider sur vos biens, vos documents, vos échéances et l’utilisation de l’application, mais pas sur ce sujet.",
  UNSUPPORTED_ACTION: "Je ne peux pas encore réaliser cette action pour vous, mais je peux vous montrer où la faire dans l’application.",
  SENSITIVE_ADVICE: "Je peux vous donner l’information présente dans vos documents, mais pas de conseil juridique, fiscal ou médical personnalisé.",
  UNSAFE_OR_MALICIOUS: "Je ne peux pas traiter cette demande. Je peux en revanche vous aider sur vos biens, documents et échéances.",
  TECHNICAL_ISSUE: "Je suis désolé pour la gêne. Vous pouvez réessayer ; si le problème persiste, consultez l’aide ou contactez le support.",
};

/**
 * Tente une réponse purement déterministe (§14).
 * Renvoie `handled: false` si l'intention nécessite retrieval/IA.
 */
export function tryDeterministic(intent: VerebonaIntent): DeterministicResult {
  const tpl = TEMPLATES[intent];
  if (tpl) {
    const actionIntents: ActionIntent[] =
      intent === 'UNSUPPORTED_ACTION' || intent === 'TECHNICAL_ISSUE'
        ? [{ type: 'OPEN_HELP' }]
        : intent === 'SENSITIVE_ADVICE'
          ? [{ type: 'OPEN_HELP' }]
          : [];
    return { handled: true, answer: tpl, actionIntents };
  }

  // Intentions nécessitant un retrieval simple mais restant déterministes (§14.3).
  if (
    intent === 'ACCOUNT_TO_PROCESS' ||
    intent === 'ACCOUNT_FACT_ASSET' ||
    intent === 'ACCOUNT_FACT_DOCUMENT' ||
    intent === 'ACCOUNT_FACT_AGENDA'
  ) {
    return { handled: false, needsSimpleRetrieval: true };
  }

  return { handled: false };
}

/**
 * Formatte un comptage de façon déterministe (§14.3). Exemple d'utilitaire pur.
 */
export function formatCount(kind: 'document' | 'échéance' | 'bien' | 'élément', n: number): string {
  if (n === 0) return `Vous n’avez aucun ${kind} correspondant.`;
  const plural = n > 1 ? (kind === 'bien' ? 'biens' : `${kind}s`) : kind;
  return `Vous avez ${n} ${plural}.`;
}
