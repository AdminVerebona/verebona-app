/**
 * Compréhension de la demande — branche UNDERSTAND du master T2 (opération
 * `t2_understand`, CDC 15 §24), usage IA n°3. CDC Assistant §9.1, §9.5,
 * §9.10 et §15.5 ; lot 32 (UNDERSTAND, fallback général de compréhension).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNDERSTAND N'EST PAS UN SIMPLE CLASSIFIEUR D'INTENTION
 *
 * Le déterministe reste le PREMIER niveau de compréhension (règles, registre
 * canonique, référentiel des biens, fil, page). UNDERSTAND prend le relais
 * dès qu'il ne suffit pas (`core/understanding-status`) :
 *
 *   · UNKNOWN_INTENT — aucune règle ne donne d'intention fiable ;
 *   · PARTIAL — intention reconnue mais demande incomplète : renvoi non levé
 *     (« et ceux qui concernent l'autre ? »), sens non consommé (« quand ai-je
 *     acheté la Polo et combien l'ai-je payée ? »)…
 *
 * Quand le serveur sait EXACTEMENT ce qui manque (« ce bien » sans contexte :
 * QUEL bien), il clarifie directement, sans appel modèle.
 *
 * La sortie STRUCTURE la demande : intention du catalogue fermé, indices
 * d'entités, faits demandés (FIELD_CATALOG), sujets, filtres, confiance. Elle
 * ne résout rien : les indices sont ramenés au compte par le serveur
 * (`resolveAssistantTargets` — 0 cible ou plusieurs : clarification ; une :
 * on continue). Le modèle ne choisit JAMAIS un identifiant. L'éligibilité
 * (traitement T2 actif, arrêt d'urgence, budgets, offre, `account_ai`) est
 * décidée par l'orchestrateur avant l'appel ; ANSWER n'est jamais utilisé
 * pour comprendre.
 *
 * Lot 16b-2 : l'étape historique `understand_request` et le drapeau
 * `AI_INTELLIGENT_ASSISTANT` sont retirés — le master T2 est le seul moteur.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * LA RÈGLE ABSOLUE DU §9.1
 *
 * « Une intention inconnue n'est JAMAIS créée dynamiquement par le modèle. Le
 *   classifieur ne peut retourner qu'une valeur de cette énumération. »
 *
 * Elle est appliquée par le schéma de sortie du master (`T2UnderstandOutput`,
 * intention du catalogue fermé). Une intention hors catalogue fait échouer la
 * validation, et la compréhension rend `null` — l'orchestrateur ne l'invente
 * pas : clarification ou repli prudent (`UNDERSTANDING_FAILED`). Le modèle ne
 * peut donc pas élargir le catalogue.
 *
 * Et surtout : **le modèle ne décide pas des droits.** Il propose une
 * compréhension, rien de plus. `aiEligible`, `requiresRetrieval` et
 * `allowedActionTypes` sont lus dans le registre côté serveur (§9.2).
 */
import type { VerebonaIntent } from '../types/intents';
import { getIntentDefinition } from '../registries/intent-registry';
import { allowedActionsFor } from '../registries/action-registry';
import type { IntentRoute, AssistantRequestInput, Confidence } from '../types/contracts';

/** Plan proposé par le modèle : une intention du catalogue et des INDICES (jamais d'identifiant). */
export interface ToolPlan {
  intent: string;
  confidence: 'exact' | 'probable' | 'ambiguous';
  entityHints: Array<{ type: IntentRoute['entityHints'][number]['type']; value: string }>;
  /** Justification courte, journalisée — jamais montrée à l'utilisateur. */
  reason: string;
}

/**
 * Comprend une question que le déterministe n'a pas suffi à comprendre
 * (intention inconnue OU compréhension partielle), par la branche UNDERSTAND
 * du master T2.
 *
 * Rend `null` en cas d'échec — jamais une exception. L'orchestrateur traite
 * `null` comme une compréhension impossible (motif `UNDERSTANDING_FAILED`,
 * jamais « aucun résultat »). La route est construite ICI (droits du
 * registre) ; faits demandés, sujets et filtres suivent comme indices
 * (`route.understanding`), résolus ensuite par le serveur.
 */
export async function classifyAssistantIntent(
  message: string,
  input: AssistantRequestInput,
): Promise<IntentRoute | null> {
  if (!message.trim()) return null;
  const { understandWithT2Master } = await import('@/services/ai/assistant/master/t2-understand');
  const r = await understandWithT2Master(message, input);
  if (!r) return null;
  return {
    ...toIntentRoute(r.plan, input.planType),
    understanding: { requestedFacts: r.requestedFacts, requestedTopics: r.requestedTopics, filters: r.filters ?? {} },
  };
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
    // Indices seulement (T2-08) : bornés, sans préfixe « page: » — un indice
    // du modèle ne peut pas se faire passer pour le contexte de page.
    entityHints: plan.entityHints.filter((h) => !h.value.trim().toLowerCase().startsWith('page:')).slice(0, 10),
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

/** Port de compréhension UNDERSTAND (toujours branché depuis le lot 16b-2). */
export function buildClassificationPort(): (message: string, input: AssistantRequestInput) => Promise<IntentRoute | null> {
  return classifyAssistantIntent;
}
