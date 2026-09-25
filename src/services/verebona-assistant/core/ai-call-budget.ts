/**
 * Budget d'appels modèle par message utilisateur — CDC §15.5, §0.9, CA-07.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN BUDGET PARTAGÉ
 *
 * « Par message utilisateur : un premier appel au modèle par défaut ; au
 *   maximum un second appel (réparation ou escalade). Le total ne peut jamais
 *   dépasser 2 appels. » (§15.5)
 *
 * Avant ce module, rien ne bornait le total : un même message pouvait
 * enchaîner classification (principal + repli), revalidation (N faits × 2
 * modèles) et génération (principal + repli) — jusqu'à 6 appels facturés et
 * plus. `trace.aiCalls` était incrémenté sans jamais être comparé au plafond.
 *
 * Un seul objet est créé par demande (`runAssistant`) et voyage dans
 * `AssistantRequestInput.aiBudget` : les copies `{ ...input }` gardent la même
 * référence, donc le même compteur. Chaque tentative modèle — classification,
 * revalidation, génération, repli compris — le décrémente. Budget épuisé :
 * l'appel n'est pas émis et l'appelant applique son repli déterministe.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AiGateway } from '@/services/ai/gateway/ai-gateway';
import { AiGatewayError } from '@/services/ai/gateway/errors';
import type { AiGatewayRequest, AiGatewayResponse } from '@/services/ai/gateway/types';

export class AiCallBudget {
  private consumed = 0;

  constructor(readonly max: number) {}

  /** Tentatives modèle déjà consommées pour ce message. */
  get used(): number {
    return this.consumed;
  }

  /** Tentatives encore permises (jamais négatif). */
  get remaining(): number {
    return Math.max(0, this.max - this.consumed);
  }

  canCall(): boolean {
    return this.remaining > 0;
  }

  /** Décompte `n` tentatives, sans jamais dépasser le plafond. */
  consume(n: number): void {
    this.consumed = Math.min(this.max, this.consumed + Math.max(0, Math.floor(n)));
  }
}

export function createAiCallBudget(max: number): AiCallBudget {
  return new AiCallBudget(Math.max(0, Math.floor(max)));
}

/** Levée quand le budget du message est épuisé : aucun appel n'est émis. */
export class AiBudgetExhaustedError extends AiGatewayError {
  constructor(operationCode: string) {
    super('QUOTA_EXCEEDED', operationCode,
      'Budget d’appels modèle du message épuisé (§15.5) — repli déterministe.', { recoverable: true });
  }
}

/**
 * Appel gateway décompté sur le budget du message.
 *
 * - `maxModelAttempts = remaining` : la gateway ne tente jamais plus de
 *   modèles (principal + replis) que ce qu'il reste.
 * - Réponse issue du cache d'idempotence : aucun appel émis, rien décompté.
 * - Succès sans repli : 1 tentative. Succès après repli : la gateway ne dit
 *   pas combien de replis ont été essayés ; on décompte tout ce qui était
 *   permis (exact avec le plafond par défaut de 2, prudent au-delà).
 * - Échec : décompte prudent de tout ce qui était permis — un appel peut
 *   avoir été facturé avant l'erreur.
 *
 * Sans budget (`budget` absent), comportement historique inchangé.
 */
export async function executeWithinBudget<T>(
  budget: AiCallBudget | undefined,
  req: AiGatewayRequest<T>,
): Promise<AiGatewayResponse<T>> {
  if (!budget) return AiGateway.execute(req);
  const permis = budget.remaining;
  if (permis <= 0) throw new AiBudgetExhaustedError(req.operationCode);
  try {
    const res = await AiGateway.execute({ ...req, maxModelAttempts: permis });
    if (!res.fromCache) budget.consume(res.usedFallback ? permis : 1);
    return res;
  } catch (e) {
    budget.consume(permis);
    throw e;
  }
}
