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
import { resolveOperationConfig, composePrompt } from '../config/config-resolver';
import { recordCallTrace } from '../telemetry/ai-trace.service';
import { buildIdempotencyKey, withIdempotency } from '../idempotency/idempotency.service';
import { treatmentForUseCase } from '../config/treatments';
import { assertTreatmentRunnable } from '../queue/runnable-guard';
import { noteGatewayOutcome, type ModelAttempt } from '../queue/circuit-breaker.repository';
import { currentJobContext } from '../queue/job-context';
import type { ModelRank } from '../telemetry/execution-context';
import type { ProviderCallOutput } from './providers/provider.port';

/**
 * Rang d'un modèle dans la chaîne (§9.1, CST-UI-05, LOG-UI-05). L'indice suffit :
 * la chaîne est construite dans l'ordre principal → fallback 1 → fallback 2,
 * et un budget d'appelant ne fait que la tronquer, jamais la réordonner.
 */
export const RANKS: readonly ModelRank[] = ['primary', 'fallback_1', 'fallback_2'];
export function rankAt(index: number): ModelRank | null {
  return RANKS[index] ?? null;
}

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

    // ── Arrêt d'urgence et état du traitement (CDC BO IA OPS-011, OPS-008,
    //    OPS-024, WF-07, WF-08, MOD-012) ──────────────────────────────────────
    // Point de passage de TOUS les appels modèle : T2, T3, T4, T1 en file
    // mémoire, T5 et T6 sont couverts sans que chaque appelant y pense. Lève
    // `AI_BLOCKED`, non récupérable ; chaque appelant retombe sur son chemin
    // sans IA. Placée avant l'idempotence : pendant un arrêt, aucun appel ne
    // part, et l'on ne sert pas non plus de résultat mis en cache comme si
    // l'IA tournait. Cache de 5 s (runnable-guard).
    await assertTreatmentRunnable(treatmentForUseCase(op.useCaseCode), op.operationCode);

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

    // Attendu : la clé administrée (BO) est résolue en base, avec cache (WF-21).
    if (!(await provider.isConfigured())) {
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
    const { text: promptTechnique, version: promptVersion } = op.dynamicPrompt
      ? { text: substituteOverride(req.promptOverride!, safeVariables), version: 'candidate' }
      : await resolvePrompt(op.promptCode, safeVariables, op.useCaseCode);

    // ══════════════════════════════════════════════════════════════════════
    // CONFIGURATION ADMINISTRABLE (CDC BO IA GEN-001, §2.1)
    //
    // Modèles et préambule viennent de la version IA effective quand il y en a
    // une, du référentiel sinon. `resolveOperationConfig` ne lève jamais : une
    // console d'administration ne doit pas pouvoir casser le produit qu'elle
    // administre.
    //
    // Le préambule est placé DEVANT le prompt technique, jamais à la place : le
    // BO règle le comportement, le code garde le contrat de sortie. C'est ce qui
    // permet de vérifier leur accord automatiquement — la panne du 18/09/2026
    // venait précisément d'un prompt et d'un schéma désaccordés.
    //
    // Une évaluation de version candidate (`dynamicPrompt`) n'est pas préfixée :
    // elle teste un texte précis, et lui ajouter un préambule ferait évaluer
    // autre chose que ce qui est soumis.
    // ══════════════════════════════════════════════════════════════════════
    const configuration = await resolveOperationConfig(operationCode);
    const prompt = op.dynamicPrompt
      ? promptTechnique
      : composePrompt(configuration.promptPreamble, promptTechnique);

    // Budget de tentatives imposé par l'appelant (CDC Assistant §15.5,
    // CA-07) : la chaîne principal → replis est tronquée, jamais allongée.
    // Sans budget, comportement inchangé.
    const chaine = [configuration.primaryModel, ...configuration.fallbackModels];
    const models = req.maxModelAttempts === undefined
      ? chaine
      : chaine.slice(0, Math.max(0, Math.floor(req.maxModelAttempts)));
    const failures: string[] = [];
    if (models.length === 0) failures.push('budget de tentatives modèle épuisé');

    // Circuit breaker (MOD-007 à MOD-014) : issue de chaque modèle sollicité,
    // puis de la chaîne. Une chaîne tronquée par un budget d'appelant n'est pas
    // un échec COMPLET (tous les modèles configurés n'ont pas été essayés) :
    // elle ne fait pas progresser le disjoncteur, seulement les compteurs des
    // modèles réellement sollicités.
    const treatment = treatmentForUseCase(op.useCaseCode);
    const attempts: ModelAttempt[] = [];
    const chaineComplete = models.length === 1 + configuration.fallbackModels.length;

    // Exécution de file : job parent tracé à chaque appel (§9.1).
    const jobId = currentJobContext()?.jobId ?? null;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const usedFallback = i > 0;
      const modelRank = rankAt(i);
      // Sortie du fournisseur conservée hors du try : si la VALIDATION échoue,
      // les jetons ont été consommés et facturés — COST-005 exige de garder
      // le coût réel de l'appel échoué.
      let out: ProviderCallOutput | null = null;

      try {
        out = await provider.call({
          model,
          prompt,
          attachments: req.attachments ?? [],
          timeoutMs: op.timeoutMs,
          // §2.1 : le plafond ne vaut que pour le modèle principal ; les replis
          // en héritent, faute de valeur propre. C'est ce que dit le CDC, et
          // c'est aussi le comportement le plus sûr — un repli sollicité parce
          // que le principal a échoué ne doit pas en plus changer de format.
          maxOutputTokens: op.minOutputTokens
            ? Math.max(configuration.maxOutputTokens ?? 0, op.minOutputTokens)
            : configuration.maxOutputTokens ?? undefined,
          // T1-UI-06, T2-UI-03, T3-UI-03, T4-UI-03 : niveau du rang sollicité.
          reasoning: configuration.reasoningByRank[i] ?? null,
        });

        // Aucune persistance d'une sortie brute invalide (CDC §5.3).
        const data = validateOutput<T>(out.rawText, req.outputSchema, operationCode);

        const durationMs = Date.now() - startedAt;
        // Le tarif est indexé sur le fournisseur DÉCLARÉ dans le référentiel,
        // non sur l'instance d'exécution : un double de test reste tarifé comme
        // le fournisseur qu'il remplace.
        // COST-008 : sans tarif, le coût reste NULL (« non calculable »), jamais
        // un 0 qui se confondrait avec un appel gratuit dans les agrégats.
        const costMicros = calcCostMicros(model, out.inputTokens, out.outputTokens, op.provider);

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
          modelRank,
          jobId,
          configVersionId: configuration.configVersionId,
        });

        attempts.push({ model, succeeded: true });
        noteGatewayOutcome({ treatment, attempts, chainSucceeded: true });

        return {
          data, provider: provider.name, model, promptVersion, usedFallback,
          inputTokens: out.inputTokens, outputTokens: out.outputTokens,
          costMicros: costMicros ?? 0, durationMs, traceId, fromCache: false,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failures.push(`${model} : ${message}`);
        attempts.push({ model, succeeded: false });

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
          // COST-005 : réponse obtenue puis rejetée (sortie invalide) → jetons
          // et coût réels ; aucune réponse → rien de consommé.
          inputTokens: out?.inputTokens ?? 0,
          outputTokens: out?.outputTokens ?? 0,
          costMicros: out ? calcCostMicros(model, out.inputTokens, out.outputTokens, op.provider) : 0,
          durationMs: Date.now() - startedAt,
          status: 'error',
          errorCode: isAiGatewayError(e) ? e.code : 'PROVIDER_UNAVAILABLE',
          errorMessage: message,
          // Un appel facturé par le fournisseur reste une dépense métier.
          billable: Boolean(out) && op.billable && !req.shadow,
          shadow: Boolean(req.shadow),
          modelRank,
          jobId,
          configVersionId: configuration.configVersionId,
        }).catch(() => { /* la trace ne doit jamais masquer l'erreur d'origine */ });

        // Une erreur non récupérable arrête immédiatement la chaîne de repli.
        // Elle compte pour le modèle, pas comme échec complet de la chaîne.
        if (isAiGatewayError(e) && !e.recoverable) {
          noteGatewayOutcome({ treatment, attempts, chainSucceeded: null });
          throw e;
        }
      }
    }

    noteGatewayOutcome({ treatment, attempts, chainSucceeded: chaineComplete ? false : null });
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
