/**
 * AiGateway — couche unique d'accès aux modèles (CDC §5.2).
 *
 * Aucun autre service ne doit instancier un client fournisseur ni appeler
 * directement son API. Cette classe porte l'intégralité des responsabilités
 * transverses : sélection du modèle, timeout, fallback, fichiers temporaires,
 * validation des sorties, calcul des coûts, journalisation, gestion d'erreurs,
 * masquage des secrets et substituabilité du fournisseur.
 *
 * Critères d'acceptation couverts : n°4 (aucune instanciation hors adaptateur)
 * et n°5 (chaque appel rattaché à un usage et à une opération).
 */
import { randomUUID } from 'crypto';
import type { AiGatewayRequest, AiGatewayResponse } from './types';
import { AiGatewayError, isAiGatewayError } from './errors';
import { getOperation } from '../registry/operations';
import { calcCostMicros } from './cost-catalog';
import { validateOutput } from './output-validator';
import { redactVariables, previewForLog } from './redaction';
import { getAiProvider } from './providers';
import { resolvePrompt } from '../prompts/prompt-loader';
import { recordCallTrace } from '../telemetry/ai-trace.service';
import { buildIdempotencyKey, withIdempotency } from '../idempotency/idempotency.service';

export class AiGateway {
  static async execute<T>(req: AiGatewayRequest<T>): Promise<AiGatewayResponse<T>> {
    const op = getOperation(req.operationCode);

    // ── Garde de cohérence référentielle (CDC §5.1) ────────────────────────
    if (op.useCaseCode !== req.useCaseCode) {
      throw new AiGatewayError('USE_CASE_MISMATCH', req.operationCode,
        `L'opération « ${op.operationCode} » appartient à ${op.useCaseCode}, pas à ${req.useCaseCode}.`);
    }
    if (!op.active) {
      throw new AiGatewayError('OPERATION_INACTIVE', req.operationCode,
        `L'opération « ${op.operationCode} » est désactivée dans le référentiel.`);
    }
    if (op.provider === 'none') {
      throw new AiGatewayError('OPERATION_UNKNOWN', req.operationCode,
        `L'opération « ${op.operationCode} » est déterministe : elle ne doit pas passer par la gateway.`);
    }

    // ── Idempotence (CDC §5.7) ─────────────────────────────────────────────
    const key = req.idempotencyKey ?? buildIdempotencyKey({
      accountId: req.accountId,
      operationCode: op.operationCode,
      sourceIds: req.sourceIds ?? [],
      sourceVersion: req.sourceVersion,
      variables: req.promptVariables,
    });

    return withIdempotency<AiGatewayResponse<T>>(key, () => this.call<T>(req, op.operationCode));
  }

  private static async call<T>(
    req: AiGatewayRequest<T>,
    operationCode: string,
  ): Promise<AiGatewayResponse<T>> {
    const op = getOperation(operationCode);
    const provider = getAiProvider();
    const traceId = randomUUID();
    const startedAt = Date.now();

    if (!provider.isConfigured()) {
      throw new AiGatewayError('PROVIDER_UNAVAILABLE', operationCode,
        `Fournisseur « ${provider.name} » non configuré.`, { recoverable: true });
    }

    // Masquage AVANT construction du prompt (CDC §5.2, §5.6).
    const safeVariables = redactVariables(req.promptVariables);

    // Prompt fourni à l'appel : uniquement pour les opérations déclarées
    // `dynamicPrompt` — en pratique l'évaluation d'une version candidate.
    if (op.dynamicPrompt && !req.promptOverride) {
      throw new AiGatewayError('OPERATION_UNKNOWN', operationCode,
        `L'opération « ${operationCode} » attend un prompt fourni à l'appel (promptOverride).`);
    }
    const { text: prompt, version: promptVersion } = op.dynamicPrompt
      ? { text: substituteOverride(req.promptOverride!, safeVariables), version: 'candidate' }
      : await resolvePrompt(op.promptCode, safeVariables, op.useCaseCode);

    const models = [op.primaryModel, ...op.fallbackModels];
    const failures: string[] = [];

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const usedFallback = i > 0;

      try {
        const out = await provider.call({
          model,
          prompt,
          attachments: req.attachments ?? [],
          timeoutMs: op.timeoutMs,
        });

        // Aucune persistance d'une sortie brute invalide (CDC §5.3).
        const data = validateOutput<T>(out.rawText, req.outputSchema, operationCode);

        const durationMs = Date.now() - startedAt;
        // Le tarif est indexé sur le fournisseur DÉCLARÉ dans le référentiel,
        // non sur l'instance d'exécution : un double de test reste tarifé comme
        // le fournisseur qu'il remplace.
        const costMicros = calcCostMicros(model, out.inputTokens, out.outputTokens, op.provider) ?? 0;

        await recordCallTrace({
          traceId,
          useCaseCode: op.useCaseCode,
          operationCode,
          accountId: req.accountId,
          userId: req.userId,
          parentOperationId: req.parentOperationId,
          provider: provider.name,
          model,
          promptVersion,
          usedFallback,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          costMicros,
          durationMs,
          status: 'success',
          billable: op.billable && !req.shadow,
          shadow: Boolean(req.shadow),
          outputPreview: previewForLog(out.rawText),
        });

        return {
          data, provider: provider.name, model, promptVersion, usedFallback,
          inputTokens: out.inputTokens, outputTokens: out.outputTokens,
          costMicros, durationMs, traceId, fromCache: false,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failures.push(`${model} : ${message}`);

        await recordCallTrace({
          traceId,
          useCaseCode: op.useCaseCode,
          operationCode,
          accountId: req.accountId,
          userId: req.userId,
          parentOperationId: req.parentOperationId,
          provider: provider.name,
          model,
          promptVersion,
          usedFallback,
          inputTokens: 0, outputTokens: 0, costMicros: 0,
          durationMs: Date.now() - startedAt,
          status: 'error',
          errorCode: isAiGatewayError(e) ? e.code : 'PROVIDER_UNAVAILABLE',
          errorMessage: message,
          billable: false,
          shadow: Boolean(req.shadow),
        }).catch(() => { /* la trace ne doit jamais masquer l'erreur d'origine */ });

        // Une erreur non récupérable arrête immédiatement la chaîne de repli.
        if (isAiGatewayError(e) && !e.recoverable) throw e;
      }
    }

    throw new AiGatewayError('ALL_MODELS_FAILED', operationCode,
      `Tous les modèles ont échoué. ${failures.join(' — ')}`, { recoverable: true });
  }
}

/** Substitution `{{VARIABLE}}`, identique à celle du chargeur de prompts. */
function substituteOverride(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    const v = variables[key];
    if (v === undefined || v === null) return match;
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}
