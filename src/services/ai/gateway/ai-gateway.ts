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
import { errorOf } from './output-validator';
import { redactVariables, previewForLog, outputDigestForLog, stripRawExcerpt } from './redaction';
import { resolveOutput, reporterCompteurs, type Resolution } from './output-resolution/resolve-output';
import { parseModelOutput } from './output-resolution/json-repair';
import {
  resolveRuntimeContract, contractStamp, contractJsonSchemaText, providerSchemaHash, runtimeContractBlock,
  contractVersionsOf, ContractResolutionError, type RuntimeContract, type ContractMismatch, type ResolvedContract,
} from './output-resolution/runtime-contract';
import type { OutputRepairStep, OutputSchemaRef } from './diagnostics/taxonomy';
import type { RuntimeContractTrace, OutputTransformationsTrace, StructuredContextTrace } from '../telemetry/ai-trace.service';
import {
  structuredSpecFor, executionConfigFor, executionSignature, checkExecutionConfig, buildExecutionContext,
  renderStructuredPrompt, promptHash, StructuredContextError, type MasterExecutionConfig, type BuiltExecutionContext,
} from '../master-prompts/structured-context';
import {
  providerJsonSchema, structuredOutputEnabled, noteSchemaRejected, schemaRejectedRecently,
} from './output-resolution/provider-schema';
import { buildRepairPrompt, mergeRepair, repairPassEnabled, REPAIR_MAX_INPUT_CHARS } from './output-resolution/repair-pass';
import { classifyCallError, failureSignature, type ClassifiedFailure } from './diagnostics/classify';
import { emptyControlChain, type CallDiagnostic, type ProviderCallMetadata } from './diagnostics/taxonomy';
import { recordCallDiagnostic } from './diagnostics/diagnostic.repository';
import { getAiProvider } from './providers';
import { resolvePrompt, resolveMasterPrompt, masterPromptVersionOf, loadMasterTemplate, MasterPromptError } from '../prompts/prompt-loader';
import { resolveOperationConfig, composePrompt } from '../config/config-resolver';
import { recordCallTrace } from '../telemetry/ai-trace.service';
import { buildIdempotencyKey, withIdempotency } from '../idempotency/idempotency.service';
import { treatmentForUseCase, isPromptAdministrable } from '../config/treatments';
import { assertTreatmentRunnable } from '../queue/runnable-guard';
import { noteGatewayOutcome, type ModelAttempt } from '../queue/circuit-breaker.repository';
import { currentJobContext } from '../queue/job-context';
import { assertAccountCostCap } from './account-cost-cap';
import type { ModelRank } from '../telemetry/execution-context';
import type { AiProvider, ProviderCallInput, ProviderCallOutput, ProviderResponseMeta } from './providers/provider.port';
import type { ZodType } from 'zod';
import type { AiOperationDefinition } from '../registry/operations';

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
      // Lot 34D : le mode d'exécution et les versions de contrats entrent
      // dans la clé — basculer T4 en contexte structuré ne sert jamais une
      // sortie mise en cache sous l'autre mode. Inchangé en LEGACY_TEMPLATE.
      const sig = executionSignature(masterExecutionOf(op.masterPromptCode, op.useCaseCode, cfg));
      if (sig !== 'legacy') masterVersion = `${masterVersion}+${sig}`;
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
    // ══════════════════════════════════════════════════════════════════════
    // LOT 34D — CONTEXTE D'EXÉCUTION STRUCTURÉ (T4)
    //
    // Mode EXPLICITE de la configuration (version BO, fichier du dépôt) —
    // jamais déduit du texte. En STRUCTURED_CONTEXT : contrat d'entrée validé
    // AVANT tout appel (0 appel fournisseur si violé), texte maître envoyé
    // tel quel + bloc EXECUTION_CONTEXT unique. Aucun repli vers la
    // substitution d'emplacements. LEGACY_TEMPLATE (T1, T2, T3, T5, T6, et T4
    // tant que sa version active l'est) : comportement historique inchangé.
    // ══════════════════════════════════════════════════════════════════════
    let structured: { built: BuiltExecutionContext; execution: MasterExecutionConfig } | null = null;
    let structuredTrace: StructuredContextTrace | null = null;
    let preCallRefusal: { code: AiErrorCode; message: string; detail: Record<string, unknown> } | null = null;
    const spec = isMasterOperation(op) ? structuredSpecFor(op.masterPromptCode) : null;
    const execution = isMasterOperation(op) ? masterExecutionOf(op.masterPromptCode, op.useCaseCode, configuration) : null;
    if (isMasterOperation(op) && spec && execution?.mode === 'STRUCTURED_CONTEXT') {
      const configured = configuredMasterText(op.useCaseCode, configuration);
      let text: string;
      try {
        text = configured ?? await loadMasterTemplate(op.masterPromptCode, op.useCaseCode);
      } catch (e) {
        if (e instanceof MasterPromptError) throw new AiGatewayError('MASTER_PROMPT_INVALID', operationCode, e.message, { cause: e });
        throw e;
      }
      promptVersion = masterPromptVersionOf({
        masterPromptCode: op.masterPromptCode, configuredText: configured, configVersionId: configuration.configVersionId,
        promptVersionId: configured ? configuration.masterPromptVersionId ?? null : null,
      });
      master = { task: op.task, masterPromptCode: op.masterPromptCode, masterPromptVersion: promptVersion };
      prompt = text;
      try {
        const issues = checkExecutionConfig(spec, execution, (name, v) => contractVersionsOf(name).includes(v));
        if (issues.length > 0) {
          throw new StructuredContextError(issues[0].code, `Configuration d’exécution invalide : ${issues.map((i) => i.message).join(' ; ')}`, {
            task: op.task, field: issues[0].field, step: issues[0].field === 'outputContractVersion' ? 'output_contract' : issues[0].field === 'allowedTasks' ? 'task' : 'input_contract',
            contract: issues[0].field === 'outputContractVersion' ? execution.outputContractVersion : execution.inputContractVersion,
          });
        }
        const built = buildExecutionContext(spec, execution, op.task, safeVariables);
        structured = { built, execution };
        prompt = renderStructuredPrompt(text, built);
      } catch (e) {
        if (!(e instanceof StructuredContextError)) throw e;
        preCallRefusal = { code: e.code as AiErrorCode, message: `${e.code} : ${e.message}`, detail: { ...e.detail } };
      }
      structuredTrace = {
        mode: 'STRUCTURED_CONTEXT', task: op.task, promptVersion, promptHash: promptHash(text),
        inputContractVersion: execution.inputContractVersion, outputContractVersion: execution.outputContractVersion,
        contextHash: structured?.built.hash ?? null,
      };
    } else if (isMasterOperation(op)) {
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
      // Master qui déclare un contrat d'exécution, resté en LEGACY_TEMPLATE :
      // le mode est tracé (versions de contrats : aucune).
      if (spec) {
        structuredTrace = {
          mode: 'LEGACY_TEMPLATE', task: op.task, promptVersion,
          promptHash: promptHash(configuredMasterText(op.useCaseCode, configuration)
            ?? await loadMasterTemplate(op.masterPromptCode, op.useCaseCode).catch(() => prompt)),
          inputContractVersion: null, outputContractVersion: null, contextHash: null,
        };
      }
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

    // ══════════════════════════════════════════════════════════════════════
    // LOT 33D — DIAGNOSTIC ET RÉSOLUTION PROGRESSIVE DES SORTIES
    //
    // Chaque modèle de la chaîne passe par la MÊME résolution (§22) :
    // parsing strict → extraction / réparation JSON → adaptateurs de
    // compatibilité → normalisation → validation → passe de réparation IA
    // ciblée (format seulement, champs valides verrouillés) → validation
    // champ par champ. Le repli d'analyse (modèle suivant) n'est que le
    // dernier recours, et il est INFORMÉ de l'erreur précédente (§21).
    // Chaque appel (analyse ou réparation) a son rapport : famille,
    // sous-type, étape, erreurs par chemin, chaîne de contrôles, métadonnées
    // fournisseur, contrat de sortie, corrections (`ai_call_diagnostics`).
    // ══════════════════════════════════════════════════════════════════════
    const schemaName = op.outputSchema && op.outputSchema !== 'none' ? op.outputSchema : null;
    const discriminant = master && (op.taskField ?? 'task') !== 'none'
      ? { field: op.taskField ?? 'task', value: master.task } : null;

    // ══════════════════════════════════════════════════════════════════════
    // LOT 34D — CONTRAT RUNTIME, SOURCE UNIQUE DE VÉRITÉ
    //
    // Résolu UNE fois, avant tout appel, puis figé pour toute l'exécution :
    // le schéma fournisseur en est dérivé, la validation, la réparation et
    // les replis l'utilisent tel quel — même si une autre version devient
    // active pendant le traitement (RTC-03, RTC-04). Un schéma d'appelant
    // différent du contrat (empreintes différentes) est refusé AVANT l'appel :
    // RUNTIME_CONTRACT_MISMATCH (RTC-07), diagnostiqué au BO seulement.
    // ══════════════════════════════════════════════════════════════════════
    let resolvedContract: ResolvedContract | null = null;
    if (!preCallRefusal) {
      try {
        resolvedContract = resolveRuntimeContract({
          schemaName: structured?.built.output.schemaName ?? schemaName, operationCode,
          callerSchema: req.outputSchema as ZodType,
          requestedVersion: structured?.built.output.contractVersion ?? null,
        });
      } catch (e) {
        if (!(e instanceof ContractResolutionError)) throw e;
        preCallRefusal = structured && spec
          ? { code: spec.errorCodes.versionNotFound as AiErrorCode, message: `${spec.errorCodes.versionNotFound} : ${e.message}`,
            detail: { task: op.task ?? null, field: null, contract: structured.execution.outputContractVersion, step: 'output_contract' } }
          : { code: 'RUNTIME_CONTRACT_MISMATCH', message: `RUNTIME_CONTRACT_MISMATCH : ${e.message}`, detail: { step: 'contract_resolution' } };
      }
      if (resolvedContract?.mismatch) {
        preCallRefusal = { code: 'RUNTIME_CONTRACT_MISMATCH', message: resolvedContract.mismatch.message, detail: mismatchDetail(resolvedContract.mismatch) };
      }
    }
    // Contrat de repli (refus avant appel seulement : rien n'est validé avec lui).
    const contract: RuntimeContract = resolvedContract?.contract
      ?? resolveRuntimeContractSafe(operationCode, req.outputSchema as ZodType);
    const structuredWanted = structuredOutputEnabled() && (op.structuredOutput ?? (jsonResponse && isMasterOperation(op)));
    const providerSchema = structuredWanted ? providerJsonSchema(contract.canonical) : null;
    const psHash = providerSchemaHash(providerSchema?.schema ?? null);
    const generationStamp = contractStamp(contract);
    // Consigne commune « le contrat runtime est prioritaire » : tout appel
    // structuré (sortie JSON), sauf l'évaluation d'un texte candidat
    // (`dynamicPrompt`, texte évalué tel quel).
    const contractBlockApplies = op.outputFormat !== 'text' && !op.dynamicPrompt;
    const withContract = (schemaInPrompt: boolean) => (contractBlockApplies ? `${prompt}${runtimeContractBlock(contract, { schemaInPrompt })}` : prompt);
    /** Référence de contrat d'UN appel (structured output transmis ou non). */
    const schemaRefOf = (soStatus: string | null): OutputSchemaRef => ({
      name: contract.schemaName ?? operationCode, version: contract.schemaVersion, hash: contract.schemaHash,
      contractId: contract.contractId, contractVersion: contract.contractVersion, compatTableVersion: contract.compatTableVersion,
      structuredOutput: soStatus === 'requested_schema', providerSchemaHash: soStatus === 'requested_schema' ? psHash : null,
    });
    const contractTraceOf = (soStatus: string | null, mismatch?: ContractMismatch | null): RuntimeContractTrace => ({
      contractId: contract.contractId, contractVersion: contract.contractVersion, schemaVersion: contract.schemaVersion,
      schemaHash: contract.schemaHash, structuredOutput: soStatus === 'requested_schema',
      providerSchemaHash: soStatus === 'requested_schema' ? psHash : null, compatTableVersion: contract.compatTableVersion,
      ...(mismatch ? { mismatch: { generationHash: mismatch.generation.schemaHash, validationHash: mismatch.validation.schemaHash, validationVersion: mismatch.validation.schemaVersion } } : {}),
    });
    // Réparation ciblée : jamais sous un budget d'appels modèle (CA-07), ni
    // pour l'assistant, qui a sa propre réparation bornée (CDC Assistant
    // §18.6 : une réparation, même modèle, comptée dans son budget).
    const repairAllowed = repairPassEnabled() && req.maxModelAttempts === undefined && op.outputFormat !== 'text'
      && op.useCaseCode !== 'INTELLIGENT_ASSISTANT';
    // Retrait des champs facultatifs invalides : pas pour l'assistant, dont la
    // réponse n'est valide qu'entière (§18.6 : réparation, sinon repli).
    const pruningAllowed = op.useCaseCode !== 'INTELLIGENT_ASSISTANT';
    const keepRawOutput = !sansSortieBrute(op.useCaseCode);
    const sourceIds = (req.sourceIds ?? []).filter((x) => Number.isInteger(x));
    let callIndex = 0;
    let previousFailure: CallDiagnostic | null = null;

    // ── Lot 34D : refus AVANT tout appel fournisseur (contrat T4 violé,
    //    contrat runtime incohérent) — tracé et diagnostiqué au BO, 0 appel ──
    if (preCallRefusal) {
      const refus = preCallRefusal;
      const model = models[0] ?? configuration.primaryModel;
      const mismatch = resolvedContract?.mismatch ?? null;
      const diag = buildDiagnostic({
        outcome: 'FAILED', callKind: 'analysis', family: 'INTERNAL_ERROR',
        subtype: refus.code === 'RUNTIME_CONTRACT_MISMATCH' ? 'RUNTIME_CONTRACT_MISMATCH' : null, stage: 'request_build',
        outputReceived: false, error: { message: refus.message, exception: refus.code }, issues: [], issueCount: 0,
        controls: emptyControlChain(),
        provider: providerMetaOf(provider.name, model, undefined, { input: 0, output: 0 }, 0, maxOutputTokens, 'none', null),
        schema: schemaRefOf(null), repairs: [],
      });
      const usageId = await recordCallTrace({
        traceId, useCaseCode: op.useCaseCode, operationCode, accountId: req.accountId, userId: req.userId,
        parentOperationId: req.parentOperationId, provider: provider.name, model, promptVersion, usedFallback: false,
        shadow: Boolean(req.shadow), modelRank: rankAt(premierRang), jobId, configVersionId: configuration.configVersionId,
        callerMode: req.callerMode, ...traceConfig, reasoning: null, maxOutputTokens: maxOutputTokens ?? null,
        inputTokens: 0, outputTokens: 0, costMicros: 0, durationMs: Date.now() - startedAt, status: 'error',
        errorCode: refus.code, errorMessage: refus.message, billable: false,
        failure: failureSummary(diag), callKind: 'analysis',
        runtimeContract: contractTraceOf(null, mismatch),
        ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
      }).catch(() => null);
      await recordCallDiagnostic({
        traceId, usageEventId: usageId ?? null, callIndex: 0, accountId: req.accountId, useCaseCode: op.useCaseCode,
        operationCode, task: traceConfig.task, model, modelRank: rankAt(premierRang), sourceIds, diagnostic: { ...diag, contractRefusal: refus.detail } as CallDiagnostic, output: null,
      });
      await attachmentSession?.release().catch(() => { /* expiration à 48 h */ });
      throw new AiGatewayError(refus.code, operationCode, refus.message, { recoverable: false, contractDetail: refus.detail });
    }

    try {
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const usedFallback = i + premierRang > 0;
        const modelRank = rankAt(i + premierRang);
        // T1-UI-06, T2-UI-03, T3-UI-03, T4-UI-03 : niveau du rang RÉELLEMENT
        // sollicité. Indexé sur le rang dans la chaîne complète : une escalade
        // (`firstModelIndex`) ne doit pas recevoir le niveau du principal.
        const reasoning = configuration.reasoningByRank[i + premierRang] ?? null;
        const timeoutMs = req.timeoutMsCap && req.timeoutMsCap > 0 ? Math.min(op.timeoutMs, req.timeoutMsCap) : op.timeoutMs;
        // §21 : un repli après une sortie invalide connaît l'erreur précédente.
        const informed = previousFailure?.family === 'INVALID_OUTPUT' && previousFailure.subtype !== 'OUTPUT_TRUNCATED'
          && previousFailure.subtype !== 'EMPTY_RESPONSE';
        const notice = informed ? fallbackNotice(previousFailure!) : '';
        // Structured output transmis à CE modèle ? (refus récent mémorisé : non.)
        const sendSchema = providerSchema?.schema && !schemaRejectedRecently(model, contract.schemaHash) ? providerSchema.schema : null;
        const attemptPrompt = `${withContract(!sendSchema)}${notice}`;
        const attemptStart = Date.now();
        // Sortie du fournisseur conservée hors du try : si la VALIDATION échoue,
        // les jetons ont été consommés et facturés — COST-005 exige de garder
        // le coût réel de l'appel échoué.
        let out: ProviderCallOutput | null = null;
        let soStatus: string = providerSchema?.schema ? 'requested_schema' : jsonResponse ? 'json_mode' : 'none';
        if (providerSchema && !providerSchema.schema) soStatus = `schema_omitted_${providerSchema.omitted ?? 'unknown'}`;

        const baseTrace = {
          traceId, useCaseCode: op.useCaseCode, operationCode, accountId: req.accountId, userId: req.userId,
          parentOperationId: req.parentOperationId, provider: provider.name, model, promptVersion, usedFallback,
          shadow: Boolean(req.shadow), modelRank, jobId, configVersionId: configuration.configVersionId,
          callerMode: req.callerMode, ...traceConfig, reasoning, maxOutputTokens: maxOutputTokens ?? null,
        };

        try {
          out = await callWithSchemaFallback(provider, {
            model, prompt: attemptPrompt, attachments: req.attachments ?? [], timeoutMs, maxOutputTokens, reasoning, operationCode,
            ...(traceConfig.task ? { task: traceConfig.task } : {}),
            ...(jsonResponse ? { jsonResponse: true } : {}),
            ...(attachmentSession ? { attachmentSession } : {}),
          }, sendSchema,
          (s) => { soStatus = s; }, () => noteSchemaRejected(model, contract.schemaHash),
          // Schéma refusé : même modèle, sans structured output — le schéma
          // DÉRIVÉ du même contrat passe alors dans le prompt.
          `${withContract(true)}${notice}`);
          if (soStatus === 'requested_schema' && !sendSchema) soStatus = 'schema_skipped_recent_rejection';
        } catch (e) {
          // ── Échec AVANT toute sortie exploitable (fournisseur, réseau, délai) ──
          const message = e instanceof Error ? e.message : String(e);
          const c = classifyCallError(e);
          const blockedMeta = (e as { providerMeta?: ProviderResponseMeta })?.providerMeta;
          const tokens = {
            input: Number((e as { inputTokens?: number })?.inputTokens ?? 0),
            output: Number((e as { outputTokens?: number })?.outputTokens ?? 0),
          };
          failures.push(`${model} : ${message}`);
          lastFailureCode = isAiGatewayError(e) ? e.code : 'PROVIDER_UNAVAILABLE';
          attempts.push({ model, succeeded: false });
          const diag = buildDiagnostic({
            outcome: 'FAILED', callKind: 'analysis', family: c.family, subtype: c.subtype, stage: c.stage,
            outputReceived: false, error: c.error, issues: [], issueCount: 0,
            controls: { ...emptyControlChain(), providerResponse: 'failed' },
            provider: providerMetaOf(provider.name, model, blockedMeta, tokens, Date.now() - attemptStart, maxOutputTokens, soStatus, c),
            schema: schemaRefOf(soStatus), repairs: [], informedOfPreviousError: informed,
          });
          const usageId = await recordCallTrace({
            ...baseTrace,
            // COST-005 : aucune réponse → rien de consommé (blocage : jetons réels).
            inputTokens: tokens.input, outputTokens: tokens.output,
            costMicros: tokens.input || tokens.output ? calcCostMicros(model, tokens.input, tokens.output, op.provider) : 0,
            durationMs: Date.now() - startedAt, status: 'error',
            errorCode: lastFailureCode, errorMessage: sansSortieBrute(op.useCaseCode) ? stripRawExcerpt(message) : message,
            billable: Boolean(tokens.input || tokens.output) && op.billable && !req.shadow,
            failure: failureSummary(diag), providerMeta: compactProviderMeta(diag.provider), callKind: 'analysis',
            runtimeContract: contractTraceOf(soStatus),
            ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
          }).catch(() => null);
          await recordCallDiagnostic({
            traceId, usageEventId: usageId ?? null, callIndex: callIndex++, accountId: req.accountId, useCaseCode: op.useCaseCode,
            operationCode, task: traceConfig.task, model, modelRank, sourceIds, diagnostic: diag, output: null,
          });
          previousFailure = diag;
          // Une erreur non récupérable arrête immédiatement la chaîne de repli.
          // Elle compte pour le modèle, pas comme échec complet de la chaîne.
          if (isAiGatewayError(e) && !e.recoverable) {
            noteGatewayOutcome({ treatment, attempts, chainSucceeded: null });
            throw e;
          }
          continue;
        }

        // ── Sortie reçue : résolution progressive ─────────────────────────
        const analysisDuration = Date.now() - attemptStart;
        const meta = providerMetaOf(provider.name, model, out.meta, { input: out.inputTokens, output: out.outputTokens }, analysisDuration, maxOutputTokens, soStatus, null);
        // Lot 34D : validation avec le contrat runtime FIGÉ (celui de la génération).
        const resolveBase = {
          schema: contract.schema, schemaName: contract.schemaName, contract, generationStamp, operationCode, format: op.outputFormat ?? 'json',
          expectedTask: discriminant ? master!.task : undefined,
          taskField: master ? (op.taskField ?? 'task') : undefined,
          jsonRequested: jsonResponse || soStatus === 'requested_schema',
          provider: meta,
        } as const;
        const first = resolveOutput({ ...resolveBase, raw: out.rawText, allowPruning: !repairAllowed && pruningAllowed });
        let final: Resolution = first;
        let repairRun: RepairRun | null = null;
        if (!first.ok && repairAllowed && first.repairable && !first.taskMismatch) {
          repairRun = await this.repairPass({
            provider, model, operationCode, op, resolveBase, first, reasoning, maxOutputTokens, timeoutMs,
            providerSchema: providerSchema?.schema && !schemaRejectedRecently(model, contract.schemaHash) ? providerSchema.schema : null,
            discriminant, traceConfig, contract, schemaRefOf,
          });
          final = repairRun?.resolution ?? first;
        }
        if (!final.ok && !(!first.ok && first.taskMismatch) && repairAllowed) {
          // Validation champ par champ sur la sortie d'origine (réparation absente ou insuffisante).
          const pruned = resolveOutput({ ...resolveBase, raw: out.rawText, allowPruning: true });
          if (pruned.ok) final = pruned;
        }

        const costMicros = calcCostMicros(model, out.inputTokens, out.outputTokens, op.provider);
        const succeeded = final.ok;
        const diag = buildDiagnostic({
          outcome: succeeded ? (final.repairs.length > 0 || repairRun?.resolution?.ok ? 'REPAIRED' : 'SUCCEEDED') : 'FAILED',
          callKind: 'analysis',
          family: succeeded ? null : 'INVALID_OUTPUT',
          subtype: succeeded ? null : (first.ok ? null : first.subtype),
          stage: succeeded ? null : (first.ok ? null : first.stage),
          outputReceived: out.rawText.trim() !== '',
          error: succeeded || first.ok ? null : { message: redactMessage(first.message, keepRawOutput) },
          issues: first.ok ? [] : first.issues,
          issueCount: first.ok ? 0 : first.issueCount,
          controls: succeeded ? { ...final.controls, businessValidation: 'not_applicable', persistence: 'not_applicable' } : first.ok ? final.controls : first.controls,
          provider: meta,
          schema: schemaRefOf(soStatus),
          repairs: [...(final.repairs ?? [])],
          informedOfPreviousError: informed,
        });
        // Défaut interne : la sortie serait validée avec un autre contrat que
        // celui de sa génération (RTC-07) — famille INTERNAL_ERROR.
        if (!first.ok && first.contractMismatch) {
          diag.family = 'INTERNAL_ERROR';
          diag.signature = failureSignature(diag);
        }
        // Rapport du premier passage conservé même après réparation réussie :
        // il dit POURQUOI la sortie d'origine ne passait pas.
        if (succeeded && !first.ok) {
          diag.issues = first.issues; diag.issueCount = first.issueCount;
          diag.subtype = first.subtype; diag.stage = first.stage; diag.family = 'INVALID_OUTPUT';
          diag.signature = failureSignature(diag);
        }

        const usageId = await recordCallTrace({
          ...baseTrace,
          inputTokens: out.inputTokens, outputTokens: out.outputTokens,
          // COST-005 / COST-008 : coût réel, y compris d'un appel rejeté ;
          // sans tarif, NULL (« non calculable »), jamais 0.
          costMicros,
          durationMs: Date.now() - startedAt,
          status: succeeded ? 'success' : 'error',
          ...(succeeded ? {} : {
            errorCode: 'INVALID_OUTPUT',
            // §29.6 : le message d'une sortie invalide cite un extrait de la
            // sortie brute — retiré pour l'assistant (code et longueur restent).
            errorMessage: first.ok ? 'Sortie invalide' : redactMessage(first.message, keepRawOutput),
          }),
          // Un appel facturé par le fournisseur reste une dépense métier.
          billable: op.billable && !req.shadow,
          // CDC Assistant §29.6 : pour l'assistant, la sortie brute n'a pas
          // encore passé la validation serveur (sources, sécurité) — jamais
          // stockée, même en extrait : empreinte et longueur seulement.
          outputPreview: keepRawOutput ? previewForLog(out.rawText) : outputDigestForLog(out.rawText),
          failure: failureSummary(diag), providerMeta: compactProviderMeta(meta), callKind: 'analysis',
          ...(diag.outcome === 'REPAIRED' ? { repaired: true } : {}),
          runtimeContract: contractTraceOf(soStatus, first.ok ? null : first.contractMismatch ?? null),
          transformations: transformationsOf(final.ok ? final.repairs : first.repairs, repairRun),
          ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
        }).catch(() => null);
        const thisIndex = callIndex++;
        if (diag.outcome !== 'SUCCEEDED') {
          await recordCallDiagnostic({
            traceId, usageEventId: usageId ?? null, callIndex: thisIndex, accountId: req.accountId, useCaseCode: op.useCaseCode,
            operationCode, task: traceConfig.task, model, modelRank, sourceIds, diagnostic: diag,
            output: keepRawOutput ? {
              raw: out.rawText,
              extracted: first.extracted,
              parsed: first.extracted !== null ? first.parsed : null,
            } : null,
          });
        }
        if (repairRun) {
          const repairUsage = await recordCallTrace({
            ...baseTrace,
            inputTokens: repairRun.inputTokens, outputTokens: repairRun.outputTokens,
            costMicros: repairRun.inputTokens || repairRun.outputTokens
              ? calcCostMicros(model, repairRun.inputTokens, repairRun.outputTokens, op.provider) : 0,
            durationMs: repairRun.durationMs,
            status: repairRun.diagnostic.outcome === 'FAILED' ? 'error' : 'success',
            ...(repairRun.diagnostic.outcome === 'FAILED'
              ? { errorCode: repairRun.errorCode ?? 'INVALID_OUTPUT', errorMessage: redactMessage(repairRun.errorMessage ?? 'Réparation insuffisante', keepRawOutput) }
              : {}),
            billable: repairRun.outputTokens > 0 && op.billable && !req.shadow,
            outputPreview: repairRun.rawText == null ? undefined : keepRawOutput ? previewForLog(repairRun.rawText) : outputDigestForLog(repairRun.rawText),
            failure: failureSummary(repairRun.diagnostic), providerMeta: compactProviderMeta(repairRun.diagnostic.provider), callKind: 'repair',
            runtimeContract: contractTraceOf(repairRun.diagnostic.provider.structuredOutputStatus ?? null),
            transformations: transformationsOf(repairRun.resolution?.repairs ?? [], repairRun),
            ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
          }).catch(() => null);
          await recordCallDiagnostic({
            traceId, usageEventId: repairUsage ?? null, callIndex: callIndex++, accountId: req.accountId, useCaseCode: op.useCaseCode,
            operationCode, task: traceConfig.task, model, modelRank, sourceIds, diagnostic: repairRun.diagnostic,
            output: keepRawOutput && repairRun.rawText != null ? { raw: repairRun.rawText, extracted: null, parsed: null } : null,
          });
        }

        if (final.ok) {
          attempts.push({ model, succeeded: true });
          noteGatewayOutcome({ treatment, attempts, chainSucceeded: true });
          const totalIn = out.inputTokens + (repairRun?.inputTokens ?? 0);
          const totalOut = out.outputTokens + (repairRun?.outputTokens ?? 0);
          const totalCost = (costMicros ?? 0) + (repairRun ? calcCostMicros(model, repairRun.inputTokens, repairRun.outputTokens, op.provider) ?? 0 : 0);
          return {
            data: final.data as T, provider: provider.name, model, promptVersion, usedFallback,
            inputTokens: totalIn, outputTokens: totalOut,
            costMicros: totalCost, durationMs: Date.now() - startedAt, traceId, fromCache: false,
            outputRepairs: final.repairs,
          };
        }

        // ── Contrat runtime incohérent : défaut interne, aucun repli ───────
        if (!first.ok && first.contractMismatch) {
          attempts.push({ model, succeeded: false });
          noteGatewayOutcome({ treatment, attempts, chainSucceeded: null });
          throw new AiGatewayError('RUNTIME_CONTRACT_MISMATCH', operationCode, first.message, {
            recoverable: false, contractDetail: mismatchDetail(first.contractMismatch),
          });
        }

        // ── Sortie inexploitable : échec de ce modèle ─────────────────────
        const err = errorOf(first.ok ? (final as Extract<Resolution, { ok: false }>) : first, operationCode);
        failures.push(`${model} : ${err.message}`);
        lastFailureCode = 'INVALID_OUTPUT';
        attempts.push({ model, succeeded: false });
        previousFailure = diag;
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
  /**
   * Passe de réparation ciblée (lot 33D, §8 à §13) : même modèle, AUCUN
   * document joint, sortie précédente + erreurs + schéma ; seuls les chemins
   * en erreur sont repris de la réponse (`mergeRepair`). Rend `null` si la
   * sortie précédente est trop volumineuse pour être retransmise.
   */
  private static async repairPass(p: {
    provider: AiProvider; model: string; operationCode: string; op: AiOperationDefinition;
    resolveBase: Omit<Parameters<typeof resolveOutput>[0], 'raw' | 'allowPruning' | 'candidate'>;
    first: Extract<Resolution, { ok: false }>;
    reasoning: ProviderCallInput['reasoning']; maxOutputTokens: number | undefined; timeoutMs: number;
    providerSchema: Record<string, unknown> | null;
    discriminant: { field: string; value: string } | null;
    traceConfig: { task: string | null };
    /** Lot 34D : contrat runtime EXACT de l'exécution (jamais reconstruit). */
    contract: RuntimeContract;
    schemaRefOf: (soStatus: string | null) => OutputSchemaRef;
  }): Promise<RepairRun | null> {
    const { first } = p;
    const previous = typeof first.best === 'string' ? first.best : JSON.stringify(first.best ?? first.parsed ?? null);
    if (!previous || previous === 'null' || previous.length > REPAIR_MAX_INPUT_CHARS) return null;
    const malformed = first.subtype === 'MALFORMED_JSON';
    // Contrat runtime EXACT : schéma JSON complet dérivé du contrat figé,
    // avec son identité (le modèle répare contre CE contrat, la sortie est
    // revalidée avec lui — `resolveBase.contract`).
    const prompt = buildRepairPrompt({
      previousOutput: previous, issues: first.issues, malformedJson: malformed,
      schemaJson: contractJsonSchemaText(p.contract), discriminant: p.discriminant,
      contractLabel: `${p.contract.contractId} v${p.contract.contractVersion} · ${p.contract.schemaVersion} · ${p.contract.schemaHash}`,
    });
    const start = Date.now();
    let soStatus = p.providerSchema ? 'requested_schema' : 'json_mode';
    const schemaHash = p.contract.schemaHash;
    let out: ProviderCallOutput;
    try {
      out = await callWithSchemaFallback(p.provider, {
        model: p.model, prompt, attachments: [], timeoutMs: Math.min(p.timeoutMs, 60_000),
        maxOutputTokens: p.maxOutputTokens, reasoning: p.reasoning, operationCode: p.operationCode,
        ...(p.traceConfig.task ? { task: p.traceConfig.task } : {}), jsonResponse: true, callKind: 'repair',
      }, p.providerSchema, (s) => { soStatus = s; }, () => noteSchemaRejected(p.model, schemaHash));
    } catch (e) {
      const c = classifyCallError(e);
      return {
        resolution: null, rawText: null, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - start,
        errorCode: isAiGatewayError(e) ? e.code : 'PROVIDER_UNAVAILABLE', errorMessage: c.error.message,
        diagnostic: buildDiagnostic({
          outcome: 'FAILED', callKind: 'repair', family: c.family, subtype: c.subtype, stage: c.stage, outputReceived: false,
          error: c.error, issues: [], issueCount: 0, controls: { ...emptyControlChain(), providerResponse: 'failed' },
          provider: providerMetaOf(p.provider.name, p.model, (e as { providerMeta?: ProviderResponseMeta })?.providerMeta, { input: 0, output: 0 }, Date.now() - start, p.maxOutputTokens, soStatus, c),
          schema: p.schemaRefOf(soStatus), repairs: [],
        }),
      };
    }
    const meta = providerMetaOf(p.provider.name, p.model, out.meta, { input: out.inputTokens, output: out.outputTokens }, Date.now() - start, p.maxOutputTokens, soStatus, null);
    const parsed = parseModelOutput(out.rawText);
    let resolution: Resolution;
    if (!parsed.ok) {
      resolution = resolveOutput({ ...p.resolveBase, raw: out.rawText, allowPruning: true, provider: meta });
    } else {
      const merge = malformed ? { value: parsed.value, replaced: ['$'] } : mergeRepair(first.best, parsed.value, first.allPaths, first.optionalPaths);
      resolution = resolveOutput({
        ...p.resolveBase, raw: out.rawText, allowPruning: true, provider: meta,
        candidate: {
          value: merge.value,
          repairs: [...first.repairs, ...parsed.repairs, {
            stage: 'ai_repair', rule: 'targeted_repair', path: '$',
            detail: malformed ? 'JSON reconstruit par la passe de réparation' : `${merge.replaced.length} chemin(s) repris de la réparation, champs valides verrouillés`,
          }],
        },
      });
      // Compteurs de préparation du premier passage (faits écartés…) conservés.
      if (resolution.ok) reporterCompteurs(first.prepared, resolution.data);
    }
    const ok = resolution.ok;
    return {
      resolution, rawText: out.rawText, inputTokens: out.inputTokens, outputTokens: out.outputTokens,
      durationMs: Date.now() - start,
      errorCode: ok ? null : 'INVALID_OUTPUT', errorMessage: ok ? null : (resolution as Extract<Resolution, { ok: false }>).message,
      diagnostic: buildDiagnostic({
        outcome: ok ? 'SUCCEEDED' : 'FAILED', callKind: 'repair',
        family: ok ? null : 'INVALID_OUTPUT',
        subtype: ok ? null : (resolution as Extract<Resolution, { ok: false }>).subtype,
        stage: ok ? null : (resolution as Extract<Resolution, { ok: false }>).stage,
        outputReceived: out.rawText.trim() !== '',
        error: ok ? null : { message: (resolution as Extract<Resolution, { ok: false }>).message },
        issues: ok ? [] : (resolution as Extract<Resolution, { ok: false }>).issues,
        issueCount: ok ? 0 : (resolution as Extract<Resolution, { ok: false }>).issueCount,
        controls: resolution.controls, provider: meta, schema: p.schemaRefOf(soStatus), repairs: resolution.repairs,
      }),
    };
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
 * Texte master administré : version active « Prompts maîtres » du BO, sinon
 * texte porté par la version de configuration (D-03). Pour T5 (lot 32B,
 * décision PO n° 15) : SEULEMENT la version active du BO — un texte T5
 * porté par une version de configuration n'est jamais appliqué (T5-003) ;
 * sans version BO, le fichier du dépôt.
 */
function configuredMasterText(
  useCaseCode: Parameters<typeof treatmentForUseCase>[0],
  cfg: { promptArchitecture?: string; masterPromptText?: string | null; masterPromptVersionId?: number | null },
): string | null {
  if (cfg.promptArchitecture !== 'master') return null;
  if (!isPromptAdministrable(treatmentForUseCase(useCaseCode)) && cfg.masterPromptVersionId == null) return null;
  return cfg.masterPromptText ?? null;
}

// ══════════════════════════════════════════════════════════════════════════
// Lot 33D — aides du diagnostic et de la résolution des sorties
// ══════════════════════════════════════════════════════════════════════════

/** Issue d'une passe de réparation ciblée. */
interface RepairRun {
  resolution: Resolution | null;
  diagnostic: CallDiagnostic;
  rawText: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Appel fournisseur avec structured output ; un REFUS du schéma (HTTP 400 sur
 * le schéma, `STRUCTURED_OUTPUT_REJECTED`) est rattrapé : même modèle, sans
 * schéma (mode JSON seul), et le refus est mémorisé pour ne pas le rejouer.
 * Le modèle reste dans la cascade (§24).
 */
async function callWithSchemaFallback(
  provider: AiProvider,
  input: ProviderCallInput,
  schema: Record<string, unknown> | null,
  setStatus: (s: string) => void,
  onRejected: () => void,
  /** Lot 34D : prompt du nouvel essai sans structured output (schéma du contrat inclus). */
  promptWithoutSchema?: string,
): Promise<ProviderCallOutput> {
  if (!schema) return provider.call(input);
  try {
    return await provider.call({ ...input, responseSchema: schema });
  } catch (e) {
    const c = classifyCallError(e);
    if (c.subtype !== 'STRUCTURED_OUTPUT_REJECTED') throw e;
    onRejected();
    setStatus('schema_rejected_retried_without');
    return provider.call(promptWithoutSchema !== undefined ? { ...input, prompt: promptWithoutSchema } : input);
  }
}

/**
 * Consigne ajoutée au prompt d'un REPLI après une sortie invalide (§21) : le
 * modèle suivant connaît l'erreur exacte au lieu de recevoir les mêmes
 * instructions. Seulement des chemins, attendus et types reçus — jamais de
 * valeur issue du document.
 */
export function fallbackNotice(prev: Pick<CallDiagnostic, 'subtype' | 'issues'>): string {
  const lignes = prev.issues.slice(0, 5).map((i) =>
    `- ${i.path} : ${i.subtype}${i.expected ? `, attendu ${i.expected}` : ''}${i.received ? `, reçu ${i.received}` : ''}`
    + `${i.allowedValues?.length ? ` (valeurs autorisées : ${i.allowedValues.slice(0, 12).join(' | ')})` : ''}`);
  return [
    '', '', '---', 'REPRISE APRÈS SORTIE INVALIDE (information du serveur)',
    `Le modèle précédent a renvoyé une réponse invalide (${prev.subtype ?? 'INVALID_OUTPUT'}).`,
    ...(lignes.length ? ['Erreurs constatées :', ...lignes] : []),
    'Tu dois impérativement respecter le CONTRAT RUNTIME de cet appel : types exacts, dates AAAA-MM-JJ,',
    'valeurs d’énumération autorisées uniquement, noms de champs du contrat ; omets un champ facultatif plutôt que d’écrire null.',
  ].join('\n');
}

function buildDiagnostic(d: Omit<CallDiagnostic, 'signature'>): CallDiagnostic {
  const out: CallDiagnostic = { ...d, signature: null };
  out.signature = d.outcome === 'FAILED' || d.family ? failureSignature(out) : null;
  return out;
}

function providerMetaOf(
  providerName: string, model: string, meta: ProviderResponseMeta | undefined,
  tokens: { input: number; output: number }, latencyMs: number, maxOutputTokens: number | undefined,
  structuredOutputStatus: string, c: ClassifiedFailure | null,
): ProviderCallMetadata {
  const m: ProviderCallMetadata = {
    provider: providerName,
    model,
    providerRequestId: meta?.providerRequestId ?? null,
    modelVersion: meta?.modelVersion ?? null,
    finishReason: meta?.finishReason ?? null,
    stopReason: meta?.stopReason ?? null,
    finishMessage: meta?.finishMessage ?? null,
    safetyReason: meta?.safetyReason ?? null,
    structuredOutputStatus,
    tokenUsage: { input: tokens.input, output: tokens.output, thoughts: meta?.thoughtsTokens ?? null, total: meta?.totalTokens ?? null },
    latencyMs,
    configuredMaxOutputTokens: maxOutputTokens ?? null,
    providerErrorCode: c?.providerErrorCode ?? null,
    providerErrorMessage: c?.providerErrorMessage ?? null,
    httpStatus: c?.httpStatus ?? null,
  };
  m.maxTokensReached = String(m.finishReason ?? '').toUpperCase() === 'MAX_TOKENS';
  return m;
}

/** Résumé d'échec figé dans `ai_usage_event.metadata` (listes, filtres). */
function failureSummary(d: CallDiagnostic): { family: string; subtype: string | null; stage: string | null; signature: string | null } | undefined {
  return d.family ? { family: d.family, subtype: d.subtype, stage: d.stage, signature: d.signature } : undefined;
}

/** Métadonnées fournisseur figées dans `ai_usage_event.metadata` (sans contenu). */
function compactProviderMeta(m: ProviderCallMetadata): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    finishReason: m.finishReason, providerRequestId: m.providerRequestId, modelVersion: m.modelVersion,
    thoughtsTokens: m.tokenUsage?.thoughts, structuredOutput: m.structuredOutputStatus, safetyReason: m.safetyReason,
  }).filter(([, v]) => v !== null && v !== undefined));
}

/** §29.6 : message sans extrait de sortie brute pour l'assistant. */
function redactMessage(message: string, keepRawOutput: boolean): string {
  return keepRawOutput ? message : stripRawExcerpt(message);
}

/**
 * Configuration d'exécution APPLIQUÉE d'un prompt maître (lot 34D) : celle
 * de la version BO active, LEGACY_TEMPLATE pour un texte de version de
 * configuration, le mode déclaré du fichier du dépôt sinon.
 */
function masterExecutionOf(
  masterPromptCode: string,
  useCaseCode: Parameters<typeof treatmentForUseCase>[0],
  cfg: { promptArchitecture?: string; masterPromptText?: string | null; masterPromptVersionId?: number | null; masterExecution?: Partial<MasterExecutionConfig> | null },
): MasterExecutionConfig {
  const text = configuredMasterText(useCaseCode, cfg);
  return executionConfigFor({
    masterPromptCode,
    source: text ? (cfg.masterPromptVersionId != null ? 'version' : 'config') : 'file',
    stored: cfg.masterExecution ?? null,
  });
}

/** Contrat de l'appelant, quand la résolution a échoué (refus avant appel). */
function resolveRuntimeContractSafe(operationCode: string, callerSchema: ZodType): RuntimeContract {
  return resolveRuntimeContract({ schemaName: null, operationCode, callerSchema }).contract;
}

/** Détail BO d'un désaccord de contrat (jamais montré à l'utilisateur). */
function mismatchDetail(m: ContractMismatch): Record<string, unknown> {
  return {
    step: 'contract_check',
    generation: m.generation, validation: m.validation,
  };
}

const NORMALIZATION_STAGES = new Set<OutputRepairStep['stage']>(['normalization', 'json_extraction', 'json_repair']);
const COMPAT_STAGES = new Set<OutputRepairStep['stage']>(['compat_adapter', 'compat_mapping']);
const ligne = (r: OutputRepairStep) => `${r.rule} ${r.path}${r.detail ? ` (${r.detail})` : ''}`;

/** Transformations appliquées à une sortie, pour BO › Exécutions IA (lot 34D). */
function transformationsOf(repairs: OutputRepairStep[], repairRun: RepairRun | null): OutputTransformationsTrace | undefined {
  const t: OutputTransformationsTrace = {
    normalizations: repairs.filter((r) => NORMALIZATION_STAGES.has(r.stage)).slice(0, 50).map(ligne),
    compatMappings: repairs.filter((r) => COMPAT_STAGES.has(r.stage)).slice(0, 50).map(ligne),
    repair: repairRun ? (repairRun.resolution?.ok ? 'SUCCESS' : 'FAILED') : null,
    pruned: repairs.filter((r) => r.stage === 'field_pruning').slice(0, 50).map(ligne),
  };
  return t.normalizations.length || t.compatMappings.length || t.repair || t.pruned.length ? t : undefined;
}
