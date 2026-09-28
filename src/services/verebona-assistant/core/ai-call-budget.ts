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
import { isAiGatewayError } from '@/services/ai/gateway/errors';
import type { AiGatewayRequest, AiGatewayResponse } from '@/services/ai/gateway/types';
import { getAssistantConfig } from '../config/assistant-config';
import { isAssistantFlagOn } from '../config/assistant-flags';
import { hashPromptVariables, recordAiRun, type AiRunContext } from './usage-tracking.service';
import { alertIfCostlyResponse } from './budget.service';
import { aliasForRank, resolveAliases } from '../registries/model-registry';

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
 * - `maxModelAttempts` = `policy.modelAttempts` (défaut 1 : modèle par
 *   défaut SEUL), borné par ce qu'il reste. L'escalade n'est plus implicite :
 *   elle est demandée explicitement (`firstModelIndex: 1`) pour un motif du
 *   §15.4 (`model-call-policy.ts`). Repli désactivé (flag §39
 *   `fallback_model`) : aucune escalade.
 * - Plafonds §13.9 / §30.1 transmis à la passerelle : 500 jetons de sortie,
 *   12 s par tentative (y compris `revalidate_fact`, déclarée à 20 s).
 * - Réponse issue du cache d'idempotence : aucun appel émis, rien décompté.
 * - Succès sans repli : 1 tentative. Succès après repli : la gateway ne dit
 *   pas combien de replis ont été essayés ; on décompte tout ce qui était
 *   permis (exact avec le plafond par défaut de 2, prudent au-delà).
 * - Échec : décompte prudent de tout ce qui était permis — un appel peut
 *   avoir été facturé avant l'erreur.
 *
 * ── SEUL POINT D'APPEL MODÈLE DE L'ASSISTANT ──────────────────────────────
 * C'est donc ici que chaque tentative est tracée dans `verebona_ai_runs`
 * (`trace` fourni par l'adaptateur — §28.8) et que l'alerte « coût par
 * réponse » est évaluée (§31.3). Le disjoncteur (§30.3) est celui de la
 * passerelle (`ai_treatment_state`, migration 0171) : l'ancien disjoncteur en
 * mémoire de `gemini-router.service.ts`, jamais appelé, a été supprimé.
 *
 * Sans budget (`budget` absent), comportement historique inchangé.
 */
/**
 * Politique de tentatives d'UN appel (CDC §15.4, §15.5, §18.6).
 *
 * - `modelAttempts` : nombre de modèles que la passerelle peut enchaîner
 *   pour cet appel. Défaut : 1 — le modèle par défaut SEUL. L'ancien
 *   comportement (tout le budget restant, donc repli automatique sur toute
 *   erreur, timeout compris) escaladait hors des cas du §15.4 ; l'escalade
 *   est désormais une décision explicite de l'appelant.
 * - `firstModelIndex` : 1 = modèle d'escalade seul (§15.4).
 * - `maxOutputTokens` / `timeoutMs` : plafonds §13.9 (500) et §30.1 (12 s).
 */
export interface CallPolicy {
  modelAttempts?: number;
  firstModelIndex?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export async function executeWithinBudget<T>(
  budget: AiCallBudget | undefined,
  req: AiGatewayRequest<T>,
  trace?: AiRunContext,
  policy: CallPolicy = {},
): Promise<AiGatewayResponse<T>> {
  const cfg = getAssistantConfig();
  const plafonds = {
    maxOutputTokensCap: policy.maxOutputTokens ?? cfg.maxOutputTokens,
    timeoutMsCap: policy.timeoutMs ?? cfg.aiTimeoutMs,
    // §43 IDEMPOTENCY_TTL_SECONDS : durée de vie de la réponse mise en cache
    // par la passerelle pour une même demande (900 s par défaut).
    idempotencyTtlSeconds: cfg.idempotencyTtlSeconds,
    ...(policy.firstModelIndex ? { firstModelIndex: policy.firstModelIndex } : {}),
  };
  // §15.11 : l'appel est émis sous un ALIAS configuré, résolu ici en rang de
  // la chaîne de la passerelle (0 = défaut, 1 = escalade).
  // Modèle attendu = chaîne EFFECTIVE (version BO, sinon code), résolue ici,
  // au moment de l'appel — et non la configuration statique (§31.3).
  const chaine = trace ? await resolveAliases(req.operationCode).catch(() => null) : null;
  const aliasAppel = aliasForRank(policy.firstModelIndex ?? 0, req.operationCode, chaine);
  if (!budget) return AiGateway.execute({ ...req, ...plafonds });
  // Escalade demandée alors que le repli est coupé (§43) : aucun appel.
  if ((policy.firstModelIndex ?? 0) > 0 && !isAssistantFlagOn('fallback_model')) throw new AiBudgetExhaustedError(req.operationCode);
  const voulu = Math.max(1, Math.floor(policy.modelAttempts ?? 1));
  const permis = Math.min(isAssistantFlagOn('fallback_model') ? voulu : 1, budget.remaining);
  if (permis <= 0) throw new AiBudgetExhaustedError(req.operationCode);
  const tentative = budget.used + 1;
  const debut = Date.now();
  try {
    const res = await AiGateway.execute({ ...req, ...plafonds, maxModelAttempts: permis });
    if (!res.fromCache) budget.consume(res.usedFallback && !policy.firstModelIndex ? permis : 1);
    if (trace) {
      // Repli automatique au sein du même appel : c'est l'alias d'escalade
      // qui a répondu.
      const aliasReel = res.usedFallback && !policy.firstModelIndex ? aliasForRank(1, req.operationCode, chaine) : aliasAppel;
      void recordAiRun({
        ...trace, accountId: req.accountId, operationCode: req.operationCode,
        modelAlias: aliasReel.alias, expectedModelId: aliasReel.expectedModel,
        resolvedModelId: res.model, fallbackUsed: res.usedFallback,
        inputTokens: res.inputTokens, outputTokens: res.outputTokens,
        costMicros: res.fromCache ? 0 : res.costMicros, latencyMs: res.durationMs,
        attemptNumber: tentative, status: res.fromCache ? 'cached' : 'ok',
        promptHash: hashPromptVariables(req.promptVariables),
      });
      if (!res.fromCache) alertIfCostlyResponse(req.accountId, trace.requestId, res.costMicros);
    }
    return res;
  } catch (e) {
    budget.consume(permis);
    if (trace) {
      const code = isAiGatewayError(e) ? e.code : 'UNKNOWN';
      void recordAiRun({
        ...trace, accountId: req.accountId, operationCode: req.operationCode,
        modelAlias: aliasAppel.alias, expectedModelId: aliasAppel.expectedModel,
        resolvedModelId: null, fallbackUsed: permis > 1 || (policy.firstModelIndex ?? 0) > 0,
        inputTokens: 0, outputTokens: 0, costMicros: null, latencyMs: Date.now() - debut,
        attemptNumber: tentative, status: /TIMEOUT/i.test(String(code)) ? 'timeout' : 'error',
        errorCode: String(code), promptHash: hashPromptVariables(req.promptVariables),
      });
    }
    throw e;
  }
}
