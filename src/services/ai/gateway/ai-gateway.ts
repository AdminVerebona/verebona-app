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
import { AiGatewayError, isAiGatewayError, type AiErrorCode } from './errors';
import { getOperation, isMasterOperation } from '../registry/operations';
import { calcCostMicros } from './cost-catalog';
import { validateOutput } from './output-validator';
import { redactVariables, previewForLog, outputDigestForLog, stripRawExcerpt } from './redaction';
import { getAiProvider } from './providers';
import { resolvePrompt, resolveMasterPrompt, masterPromptVersionOf, MasterPromptError } from '../prompts/prompt-loader';
import { resolveOperationConfig, composePrompt } from '../config/config-resolver';
import { recordCallTrace } from '../telemetry/ai-trace.service';
import { buildIdempotencyKey, withIdempotency } from '../idempotency/idempotency.service';
import { treatmentForUseCase, isPromptAdministrable } from '../config/treatments';
import { assertTreatmentRunnable } from '../queue/runnable-guard';
import { noteGatewayOutcome, type ModelAttempt } from '../queue/circuit-breaker.repository';
import { currentJobContext } from '../queue/job-context';
import { assertAccountCostCap } from './account-cost-cap';
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
    // CDC 15 §22.2, DP-05 : la branche d'une opération master est imposée par
    // le référentiel. Une requête qui en demande une autre, ou un autre master,
    // est refusée avant tout appel (non récupérable : erreur d'appelant).
    if (isMasterOperation(op)) {
      if (req.task !== undefined && req.task !== op.task) {
        throw new AiGatewayError('TASK_MISMATCH', req.operationCode,
          `L'opération « ${op.operationCode} » exécute TASK=${op.task}, pas TASK=${req.task}.`);
      }
      if (req.masterPromptCode !== undefined && req.masterPromptCode !== op.masterPromptCode) {
        throw new AiGatewayError('TASK_MISMATCH', req.operationCode,
          `L'opération « ${op.operationCode} » utilise le master ${op.masterPromptCode}, pas ${req.masterPromptCode}.`);
      }
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
    // Opération master : la version résolue du master entre dans la clé
    // (`t1_master_v1@file`, `@cfg<id>:<empreinte>` ou `@pv<id>:<empreinte>`) — un nouveau master ne
    // sert jamais une sortie mise en cache sous l'ancien (revue lot 12).
    let masterVersion: string | null = null;
    if (isMasterOperation(op)) {
      const cfg = await resolveOperationConfig(op.operationCode);
      masterVersion = masterPromptVersionOf({
        masterPromptCode: op.masterPromptCode,
        configuredText: configuredMasterText(op.useCaseCode, cfg),
        configVersionId: cfg.configVersionId,
        promptVersionId: configuredMasterText(op.useCaseCode, cfg) ? cfg.masterPromptVersionId ?? null : null,
      });
    }
    const key = req.idempotencyKey
      ? (masterVersion ? `${req.idempotencyKey}:${masterVersion}` : req.idempotencyKey)
      : buildIdempotencyKey({
        accountId: req.accountId,
        operationCode: op.operationCode,
        sourceIds: req.sourceIds ?? [],
        sourceVersion: req.sourceVersion,
        variables: masterVersion ? { ...req.promptVariables, __masterPromptVersion: masterVersion } : req.promptVariables,
      });

    return withIdempotency<AiGatewayResponse<T>>(
      key,
      () => this.call<T>(req, op.operationCode),
      req.idempotencyTtlSeconds && req.idempotencyTtlSeconds > 0 ? Math.floor(req.idempotencyTtlSeconds) : undefined,
    );
  }

  private static async call<T>(
    req: AiGatewayRequest<T>,
    operationCode: string,
  ): Promise<AiGatewayResponse<T>> {
    const op = getOperation(operationCode);
    const provider = getAiProvider();
    const traceId = randomUUID();
    const startedAt = Date.now();

    // ── Plafond mensuel de coût IA du compte (lot 22) ──────────────────────
    // Point unique : tout appel modèle d'un compte passe ici. Après le cache
    // d'idempotence (un résultat déjà payé reste servi), avant tout contact
    // fournisseur. Exemptés : appels sans compte, T5 (administration),
    // campagnes de mesure (`costCapExempt`). Refus `COST_CAP_REACHED`, non
    // récupérable : la file reporte au mois suivant, les usages synchrones
    // prennent leur repli sans IA. Voir `account-cost-cap.ts`.
    await assertAccountCostCap({
      accountId: req.accountId, useCaseCode: op.useCaseCode, operationCode, exempt: req.costCapExempt,
    });

    // Attendu : la clé administrée (BO) est résolue en base, avec cache (WF-21).
    if (!(await provider.isConfigured())) {
      throw new AiGatewayError('PROVIDER_UNAVAILABLE', operationCode,
        `Fournisseur « ${provider.name} » non configuré.`, { recoverable: true });
    }

    // Masquage AVANT construction du prompt (CDC §5.2, §5.6). Lot 16b : plus
    // aucune exemption (les prompts historiques relayés sont retirés).
    const safeVariables = redactVariables(req.promptVariables);

    // Prompt fourni à l'appel : uniquement pour les opérations déclarées
    // `dynamicPrompt` — en pratique l'évaluation d'une version candidate.
    if (op.dynamicPrompt && !req.promptOverride) {
      throw new AiGatewayError('OPERATION_UNKNOWN', operationCode,
        `L'opération « ${operationCode} » attend un prompt fourni à l'appel (promptOverride).`);
    }

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

    // ══════════════════════════════════════════════════════════════════════
    // PROMPT MAÎTRE (CDC 15 §22.3, §29.1, D-03, ARCH-03, DP-05)
    //
    // Opération master : le texte est le master du traitement — celui de la
    // version de configuration si elle le porte (architecture `master`), le
    // fichier du dépôt sinon —, avec `{{TASK}}` fixé ici. AUCUN préambule
    // n'y est ajouté : le master contient déjà les règles du traitement, et
    // le préfixer reviendrait à recréer un second prompt caché. TASK, master
    // et version du master sont tracés sans que l'appelant ait à les fournir.
    // ══════════════════════════════════════════════════════════════════════
    let promptVersion: string;
    let prompt: string;
    let master: { task: string; masterPromptCode: string; masterPromptVersion: string } | null = null;
    if (isMasterOperation(op)) {
      let resolved;
      try {
        resolved = await resolveMasterPrompt({
          masterPromptCode: op.masterPromptCode,
          task: op.task,
          variables: safeVariables,
          useCaseCode: op.useCaseCode,
          configuredText: configuredMasterText(op.useCaseCode, configuration),
          configVersionId: configuration.configVersionId,
          promptVersionId: configuration.masterPromptVersionId ?? null,
        });
      } catch (e) {
        // Master absent, incomplet ou variable non déclarée : erreur de
        // configuration, identique sur tous les modèles — non récupérable.
        if (e instanceof MasterPromptError) {
          throw new AiGatewayError('MASTER_PROMPT_INVALID', operationCode, e.message, { cause: e });
        }
        throw e;
      }
      prompt = resolved.text;
      promptVersion = resolved.version;
      master = { task: resolved.task, masterPromptCode: resolved.masterPromptCode, masterPromptVersion: resolved.version };
    } else {
      const technique = op.dynamicPrompt
        ? { text: substituteOverride(req.promptOverride!, safeVariables), version: 'candidate' }
        : await resolvePrompt(op.promptCode, safeVariables, op.useCaseCode);
      promptVersion = technique.version;
      prompt = op.dynamicPrompt
        ? technique.text
        : composePrompt(configuration.promptPreamble, technique.text);
    }

    // Mode JSON natif : choix de l'appel, sinon déclaration de l'opération.
    const jsonResponse = req.jsonResponse ?? op.jsonResponse ?? false;

    // Budget de tentatives imposé par l'appelant (CDC Assistant §15.5,
    // CA-07) : la chaîne principal → replis est tronquée, jamais allongée.
    // Sans budget, comportement inchangé.
    // Escalade explicite (Assistant §15.4) : la chaîne commence au rang
    // demandé — le modèle d'escalade seul, sans rappeler le principal.
    const premierRang = Math.max(0, Math.floor(req.firstModelIndex ?? 0));
    const chaine = [configuration.primaryModel, ...configuration.fallbackModels].slice(premierRang);
    const models = req.maxModelAttempts === undefined
      ? chaine
      : chaine.slice(0, Math.max(0, Math.floor(req.maxModelAttempts)));
    const failures: string[] = [];
    let lastFailureCode: AiErrorCode | undefined;
    if (models.length === 0) failures.push('budget de tentatives modèle épuisé');

    // Circuit breaker (MOD-007 à MOD-014) : issue de chaque modèle sollicité,
    // puis de la chaîne. Une chaîne tronquée par un budget d'appelant n'est pas
    // un échec COMPLET (tous les modèles configurés n'ont pas été essayés) :
    // elle ne fait pas progresser le disjoncteur, seulement les compteurs des
    // modèles réellement sollicités.
    const treatment = treatmentForUseCase(op.useCaseCode);
    const attempts: ModelAttempt[] = [];
    const chaineComplete = premierRang === 0 && models.length === 1 + configuration.fallbackModels.length;

    // Exécution de file : job parent tracé à chaque appel (§9.1).
    const jobId = currentJobContext()?.jobId ?? null;

    // CDC 15 CFG-02, CFG-05, OBS-CFG, DP-05 : ce qui a réellement été appliqué,
    // tracé avec chaque tentative. Lot 16b : plus de moteur historique — le
    // moteur est toujours `new`, sauf valeur explicite de l'appelant.
    const traceConfig = {
      task: master?.task ?? req.task ?? null,
      masterPromptCode: master?.masterPromptCode ?? req.masterPromptCode ?? null,
      masterPromptVersion: master?.masterPromptVersion ?? req.masterPromptVersion ?? null,
      engine: req.engine ?? ('new' as const),
      triggerCode: req.triggerCode ?? currentJobContext()?.triggerCode ?? null,
    };
    // §2.1 : le plafond ne vaut que pour le modèle principal ; les replis
    // en héritent, faute de valeur propre. C'est ce que dit le CDC, et
    // c'est aussi le comportement le plus sûr — un repli sollicité parce
    // que le principal a échoué ne doit pas en plus changer de format.
    const maxOutputTokens = plafonnerSortie(
      op.minOutputTokens
        ? Math.max(configuration.maxOutputTokens ?? 0, op.minOutputTokens)
        : configuration.maxOutputTokens ?? undefined,
      req.maxOutputTokensCap,
    );

    // Pièces jointes préparées une fois pour toute la chaîne (upload Files API
    // unique, réutilisé par les replis), libérées en fin de chaîne quelle que
    // soit l'issue.
    const attachmentSession = (req.attachments?.length ?? 0) > 0 && provider.openAttachmentSession
      ? provider.openAttachmentSession(req.attachments!)
      : undefined;

    try {
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const usedFallback = i + premierRang > 0;
        const modelRank = rankAt(i + premierRang);
        // T1-UI-06, T2-UI-03, T3-UI-03, T4-UI-03 : niveau du rang RÉELLEMENT
        // sollicité. Indexé sur le rang dans la chaîne complète : une escalade
        // (`firstModelIndex`) ne doit pas recevoir le niveau du principal.
        const reasoning = configuration.reasoningByRank[i + premierRang] ?? null;
        // Sortie du fournisseur conservée hors du try : si la VALIDATION échoue,
        // les jetons ont été consommés et facturés — COST-005 exige de garder
        // le coût réel de l'appel échoué.
        let out: ProviderCallOutput | null = null;

        try {
          out = await provider.call({
            model,
            prompt,
            attachments: req.attachments ?? [],
            timeoutMs: req.timeoutMsCap && req.timeoutMsCap > 0 ? Math.min(op.timeoutMs, req.timeoutMsCap) : op.timeoutMs,
            maxOutputTokens,
            reasoning,
            operationCode,
            ...(traceConfig.task ? { task: traceConfig.task } : {}),
            ...(jsonResponse ? { jsonResponse: true } : {}),
            ...(attachmentSession ? { attachmentSession } : {}),
          });

          // Aucune persistance d'une sortie brute invalide (CDC §5.3).
          // Validation discriminée (CDC 15 §22.2) : une sortie master doit
          // porter la branche demandée, sinon erreur récupérable (modèle suivant).
          const data = validateOutput<T>(
            out.rawText, req.outputSchema, operationCode, op.outputFormat ?? 'json',
            master ? { expectedTask: master.task, taskField: op.taskField ?? 'task' } : undefined,
          );

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
            // CDC Assistant §29.6 : pour l'assistant, la sortie brute n'a pas
            // encore passé la validation serveur (sources, sécurité) — jamais
            // stockée, même en extrait : empreinte et longueur seulement.
            outputPreview: sansSortieBrute(op.useCaseCode) ? outputDigestForLog(out.rawText) : previewForLog(out.rawText),
            modelRank,
            jobId,
            configVersionId: configuration.configVersionId,
            callerMode: req.callerMode,
            ...traceConfig, reasoning, maxOutputTokens: maxOutputTokens ?? null,
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
          lastFailureCode = isAiGatewayError(e) ? e.code : 'PROVIDER_UNAVAILABLE';
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
            // §29.6 : le message d'une sortie invalide cite un extrait de la
            // sortie brute — retiré pour l'assistant (code et longueur restent).
            errorMessage: sansSortieBrute(op.useCaseCode) ? stripRawExcerpt(message) : message,
            ...(sansSortieBrute(op.useCaseCode) && out ? { outputPreview: outputDigestForLog(out.rawText) } : {}),
            // Un appel facturé par le fournisseur reste une dépense métier.
            billable: Boolean(out) && op.billable && !req.shadow,
            shadow: Boolean(req.shadow),
            modelRank,
            jobId,
            configVersionId: configuration.configVersionId,
            callerMode: req.callerMode,
            ...traceConfig, reasoning, maxOutputTokens: maxOutputTokens ?? null,
          }).catch(() => { /* la trace ne doit jamais masquer l'erreur d'origine */ });

          // Une erreur non récupérable arrête immédiatement la chaîne de repli.
          // Elle compte pour le modèle, pas comme échec complet de la chaîne.
          if (isAiGatewayError(e) && !e.recoverable) {
            noteGatewayOutcome({ treatment, attempts, chainSucceeded: null });
            throw e;
          }
        }
      }

      noteGatewayOutcome({
        treatment, attempts, chainSucceeded: chaineComplete ? false : null,
        // Revue L16b-3 : un même document ne fait progresser le disjoncteur
        // qu'une fois par fenêtre (`recordChainOutcome`).
        target: req.sourceIds && req.sourceIds.length > 0 ? `sources:${[...req.sourceIds].sort((x, y) => x - y).join(',')}` : null,
      });
      throw new AiGatewayError('ALL_MODELS_FAILED', operationCode,
        `Tous les modèles ont échoué. ${failures.join(' — ')}`, { recoverable: true, lastFailureCode });
    } finally {
      // Nettoyage systématique des fichiers temporaires (CDC §5.2, §4.1.7).
      await attachmentSession?.release().catch(() => { /* non bloquant : expiration à 48 h */ });
    }
  }
}

/**
 * Plafond de sortie de l'appelant : ne fait que réduire (jamais augmenter) la
 * valeur configurée ; sans valeur configurée, le plafond s'applique seul.
 */
export function plafonnerSortie(configure: number | undefined, plafond: number | undefined): number | undefined {
  if (!plafond || plafond <= 0) return configure;
  return configure && configure > 0 ? Math.min(configure, plafond) : plafond;
}

/** Substitution `{{VARIABLE}}`, identique à celle du chargeur de prompts. */
function substituteOverride(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    const v = variables[key];
    if (v === undefined || v === null) return match;
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/**
 * Usages dont la sortie brute n'est jamais journalisée (CDC Assistant §29.6) :
 * l'assistant, dont la réponse n'est valide qu'après les contrôles serveur.
 * Diagnostic ponctuel possible par `VEREBONA_ASSISTANT_DIAGNOSTIC_PREVIEW=on`
 * (extrait expurgé, comme les autres usages).
 */
function sansSortieBrute(useCaseCode: string): boolean {
  if (useCaseCode !== 'INTELLIGENT_ASSISTANT') return false;
  return !/^(on|true|1)$/i.test(process.env.VEREBONA_ASSISTANT_DIAGNOSTIC_PREVIEW ?? '');
}

/**
 * Texte master porté par la version (D-03) — JAMAIS pour un traitement non
 * administrable (T5, §10 / T5-003 / §27 « Tu ne modifies JAMAIS T5 ») : son
 * master est toujours le fichier du dépôt.
 */
function configuredMasterText(
  useCaseCode: Parameters<typeof treatmentForUseCase>[0],
  cfg: { promptArchitecture?: string; masterPromptText?: string | null },
): string | null {
  if (!isPromptAdministrable(treatmentForUseCase(useCaseCode))) return null;
  return cfg.promptArchitecture === 'master' ? cfg.masterPromptText ?? null : null;
}
