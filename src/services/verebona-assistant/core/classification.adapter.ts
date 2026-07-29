/**
 * Classification de l'intention — opération `understand_request`, usage IA n°3.
 * CDC §9.1, §9.5, §9.10 et §15.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE FICHIER DÉBLOQUE
 *
 * `ports.ts` portait `classifyWithAI: undefined`. L'orchestrateur ne recourt au
 * modèle que si les règles déterministes n'ont rien reconnu :
 *
 *     } else if (ports.classifyWithAI && isPlanAiEligible(input.planType)) {
 *
 * Le port valant `undefined`, toute question non couverte par une règle
 * retombait sur `UNKNOWN` — donc sur « je n'ai pas assez d'éléments pour
 * répondre », **sans même chercher**. Une question bien posée mais formulée
 * autrement que prévu ne recevait rien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÈGLE ABSOLUE DU §9.1
 *
 * « Une intention inconnue n'est JAMAIS créée dynamiquement par le modèle. Le
 *   classifieur ne peut retourner qu'une valeur de cette énumération. »
 *
 * Elle est appliquée ici par le schéma de sortie : `z.enum(VEREBONA_INTENTS)`.
 * Une intention hors catalogue fait échouer la validation, et la classification
 * rend `null` — l'orchestrateur retombe alors sur `UNKNOWN`, ce qu'il aurait
 * fait de toute façon. Le modèle ne peut donc pas élargir le catalogue, ni par
 * erreur ni autrement.
 *
 * Et surtout : **le modèle ne décide pas des droits.** Il propose une intention,
 * rien de plus. `aiEligible`, `requiresRetrieval` et `allowedActionTypes` sont
 * lus dans le registre côté serveur (§9.2). Laisser le modèle les fournir
 * reviendrait à lui laisser étendre ses propres permissions.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import { AiGateway } from '@/services/ai/gateway/ai-gateway';
import { isAiGatewayError } from '@/services/ai/gateway/errors';
import { isUseCaseRunning } from '@/services/ai/flags/use-case-flags';
import { VEREBONA_INTENTS, type VerebonaIntent } from '../types/intents';
import { getIntentDefinition } from '../registries/intent-registry';
import { allowedActionsFor } from '../registries/action-registry';
import type { IntentRoute, AssistantRequestInput, Confidence } from '../types/contracts';

const ENTITY_TYPES = ['asset', 'document', 'agenda', 'supplier', 'help'] as const;

/** Sortie attendue — volontairement pauvre : une intention et des indices. */
const ToolPlanOutput = z.object({
  intent: z.enum(VEREBONA_INTENTS as unknown as [string, ...string[]]),
  confidence: z.enum(['exact', 'probable', 'ambiguous']).default('probable'),
  entityHints: z.array(z.object({
    type: z.enum(ENTITY_TYPES),
    value: z.string().min(1).max(200),
  })).max(10).default([]),
  /** Justification courte, journalisée — jamais montrée à l'utilisateur. */
  reason: z.string().max(300).default(''),
});

export type ToolPlan = z.infer<typeof ToolPlanOutput>;

/**
 * Classe une question que les règles déterministes n'ont pas reconnue.
 *
 * Rend `null` en cas d'échec — jamais une exception. L'orchestrateur traite
 * `null` comme une classification indisponible et retombe sur `UNKNOWN` : le
 * comportement actuel, exactement.
 */
export async function classifyAssistantIntent(
  message: string,
  input: AssistantRequestInput,
): Promise<IntentRoute | null> {
  if (!message.trim()) return null;

  try {
    const res = await AiGateway.execute({
      useCaseCode: 'INTELLIGENT_ASSISTANT',
      operationCode: 'understand_request',
      accountId: input.accountId,
      userId: input.userId,
      promptVariables: {
        QUESTION: message,
        INTENTS: describeCatalog(),
      },
      outputSchema: ToolPlanOutput,
    });

    return toIntentRoute(res.data as ToolPlan, input.planType);
  } catch (e) {
    const detail = isAiGatewayError(e) ? `${e.code} — ${e.message}` : (e as Error).message;
    console.warn(`[assistant] Classification indisponible (${detail}) — intention inconnue.`);
    return null;
  }
}

/**
 * Construit la route à partir de la seule intention proposée par le modèle.
 *
 * Les droits viennent du registre, pas du modèle. C'est la garantie du §9.2 :
 * une intention proposée ne peut pas apporter avec elle des permissions que le
 * catalogue ne lui accorde pas.
 */
export function toIntentRoute(plan: ToolPlan, planType: string): IntentRoute {
  const intent = plan.intent as VerebonaIntent;
  const def = getIntentDefinition(intent);

  return {
    intent,
    confidence: plan.confidence as Confidence,
    // Toujours imposé côté serveur : jamais dérivé d'une réponse de modèle.
    accountScope: 'server-enforced',
    entityHints: plan.entityHints,
    requiresRetrieval: def.requiresRetrieval,
    aiEligible: def.geminiEligible,
    // Une intention ambiguë demande confirmation plutôt que de deviner (§9.5).
    clarificationRequired: plan.confidence === 'ambiguous',
    allowedActionTypes: allowedActionsFor(intent),
    routeReason: plan.reason
      ? `classification modèle — ${plan.reason}`
      : 'classification modèle',
  };
}

/** Catalogue fermé, transmis au modèle : il choisit dedans, il n'invente pas. */
function describeCatalog(): string {
  return VEREBONA_INTENTS
    .map((i) => `- ${i} : ${getIntentDefinition(i as VerebonaIntent).label}`)
    .join('\n');
}

/**
 * Port à injecter, ou `undefined` si l'usage n'est pas basculé.
 *
 * `undefined` et non une fonction inerte : l'orchestrateur teste la présence du
 * port pour décider d'appeler un modèle, et compte cet appel au titre du §15.5.
 */
export function buildClassificationPort():
  | ((message: string, input: AssistantRequestInput) => Promise<IntentRoute | null>)
  | undefined {
  return isUseCaseRunning('INTELLIGENT_ASSISTANT') ? classifyAssistantIntent : undefined;
}
