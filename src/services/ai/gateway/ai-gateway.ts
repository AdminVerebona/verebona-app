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
import { AiGatewayError, AiSuspendedError, isAiGatewayError, isDeterministicLocalError, type AiErrorCode } from './errors';
import {
  admitCandidate, causeOfFailure, chainOutcome, decisionOf, CAUSE_POLICY, ADMISSION_LABELS,
  type CoupleQualification, type FailureCause, type FallbackDecision,
} from './fallback-policy';
import { fallbackContext, noteKnownUnavailableSkipped, type CoupleQualificationView, type OperationalHint } from './fallback-context';
import { isModelExcluded } from '../config/routing-overlay';
import { getOperation, isMasterOperation } from '../registry/operations';
import { calcCostMicros } from './cost-catalog';
import { errorOf } from './output-validator';
import { redactVariables, redactWithReport, previewForLog, outputDigestForLog, stripRawExcerpt } from './redaction';
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
import { classifyCallError, failureSignature, isGenericInvalidArgument, isTruncated, type ClassifiedFailure } from './diagnostics/classify';
import {
  emptyControlChain, providerFailureCategory,
  type CallDiagnostic, type ProviderCallMetadata, type ProviderAttemptTrace, type ProviderRequestTrace,
} from './diagnostics/taxonomy';
import { describeGenerationConfig } from './providers/gemini-generation-config';
import { describeAttachments, attachmentTransport } from './providers/gemini-files';
import { subjectRefOfIdempotencyKey, capturedRequestOf, type CallCaptureInput, type CapturedRequest } from '../telemetry/call-capture';
import { recordCallDiagnostic } from './diagnostics/diagnostic.repository';
import { getAiProvider } from './providers';
import { resolvePrompt, resolveMasterPrompt, masterPromptVersionOf, loadMasterTemplate, MasterPromptError } from '../prompts/prompt-loader';
import { resolveOperationConfig, composePrompt } from '../config/config-resolver';
import { recordCallTrace } from '../telemetry/ai-trace.service';
import { buildIdempotencyKey, withIdempotency } from '../idempotency/idempotency.service';
import { treatmentOfUseCase, isTechnicalUseCase, type Treatment } from '../config/treatments';
import { assertTreatmentRunnable } from '../queue/runnable-guard';
import { noteGatewayOutcome as noteTreatmentOutcome, type GatewayOutcome, type ModelAttempt } from '../queue/circuit-breaker.repository';
import { currentJobContext } from '../queue/job-context';
import { assertAccountCostCap } from './account-cost-cap';
import { checkAccountProcessingEligibility, INELIGIBILITY_LABELS } from '@/services/account/processing-eligibility';
import { baseMaxOutputTokens, reasoningAtRank, rankSettings } from './generation-profile';
import { buildModelRequest, type ModelRequestResult, type RequestTrace } from './request-builder';
import { ensureModelCapabilitiesLoaded } from '../provider/model-capabilities.repository';
import type { ModelRank } from '../telemetry/execution-context';
import type { AiProvider, ProviderCallInput, ProviderCallOutput, ProviderResponseMeta } from './providers/provider.port';
import type { ZodType } from 'zod';
import type { AiOperationDefinition } from '../registry/operations';

/**
 * Rang d'un modèle dans la chaîne (§9.1, CST-UI-05, LOG-UI-05). L'indice suffit :
 * la chaîne est construite dans l'ordre principal → fallback 1 → fallback 2,
 * et un budget d'appelant ne fait que la tronquer, jamais la réordonner.
 */
const RANKS: readonly ModelRank[] = ['primary', 'fallback_1', 'fallback_2'];
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
    // mémoire et T6 sont couverts sans que chaque appelant y pense ; l'usage
    // technique AI_GOVERNANCE (lot 49) n'est soumis qu'à l'arrêt d'urgence. Lève
    // `AI_BLOCKED`, non récupérable ; chaque appelant retombe sur son chemin
    // sans IA. Placée avant l'idempotence : pendant un arrêt, aucun appel ne
    // part, et l'on ne sert pas non plus de résultat mis en cache comme si
    // l'IA tournait. Cache de 5 s (runnable-guard).
    await assertTreatmentRunnable(treatmentOfUseCase(op.useCaseCode), op.operationCode);

    // ── Éligibilité du compte (lot 82A, décision PO C-Q10, §3.3) ───────────
    // Même point de passage obligé : aucun appel modèle pour un compte non
    // actif (essai échu), suspendu ou en lecture seule — y compris pour une
    // exécution DÉJÀ EN COURS quand l'éligibilité disparaît. Exemptés : appels
    // sans compte, usage technique AI_GOVERNANCE, compte technique des
    // campagnes. Cache de 5 s (chemin chaud) ; la file durable revérifie
    // sans cache au démarrage de chaque travail.
    await assertAccountEligibleForAi(req.accountId, op.useCaseCode, op.operationCode);

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
    const traceId = randomUUID();
    try {
      return await this.callTraced<T>(req, operationCode, traceId);
    } catch (e) {
      // Lot 71E (T4 fiabilisation, §E) : l'appelant d'un appel EN ÉCHEC
      // retrouve l'exécution tracée (mêmes `metadata.traceId`) pour y
      // rattacher sa décision — même quand tous les modèles ont échoué.
      if (e && typeof e === 'object' && !Object.prototype.hasOwnProperty.call(e, 'traceId')) {
        try { Object.defineProperty(e, 'traceId', { value: traceId, enumerable: false, configurable: true }); } catch { /* objet gelé : sans trace */ }
      }
      throw e;
    }
  }

  private static async callTraced<T>(
    req: AiGatewayRequest<T>,
    operationCode: string,
    traceId: string,
  ): Promise<AiGatewayResponse<T>> {
    const op = getOperation(operationCode);
    const provider = getAiProvider();
    const startedAt = Date.now();

    // ── Plafond mensuel de coût IA du compte (lot 22) ──────────────────────
    // Point unique : tout appel modèle d'un compte passe ici. Après le cache
    // d'idempotence (un résultat déjà payé reste servi), avant tout contact
    // fournisseur. Exemptés : appels sans compte, usage technique AI_GOVERNANCE,
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
    // Lot 82C (LOG-07, LOG-08) : masques appliqués, relevés pour la capture
    // (« contenu masqué » ≠ « contenu capturé tel quel »).
    const variableMasks = masksOfVariables(req.promptVariables);

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
    // Lot 85C (P4, CAT-03) : fiches de capacités des modèles à jour (lecture
    // bornée, cache) — le constructeur de requête unique les lit ensuite.
    await ensureModelCapabilitiesLoaded();

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
    // substitution d'emplacements. LEGACY_TEMPLATE (T1, T2, T3, T6, et T4
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
    // Lot 49 : un usage technique (AI_GOVERNANCE) n'a pas de traitement, donc
    // pas de disjoncteur T1–T6 — ses échecs restent tracés (ai_usage_event).
    const treatment: Treatment | null = treatmentOfUseCase(op.useCaseCode);
    const noteGatewayOutcome = (o: Omit<GatewayOutcome, 'treatment'>): void => {
      if (treatment) noteTreatmentOutcome({ ...o, treatment });
    };
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
      // Lot 54 : révision de la configuration réellement appliquée.
      configRevisionId: configuration.configRevisionId ?? null,
      configRevisionNumber: configuration.configRevisionNumber ?? null,
    };
    // §2.1 : le plafond ne vaut que pour le modèle principal ; les replis
    // en héritent, faute de valeur propre. C'est ce que dit le CDC, et
    // c'est aussi le comportement le plus sûr — un repli sollicité parce
    // que le principal a échoué ne doit pas en plus changer de format.
    // Lot 76A : même calcul que le profil de génération (`generation-profile.ts`,
    // signature de configuration T6 EVALUATE) — une seule source.
    const maxOutputTokens = plafonnerSortie(baseMaxOutputTokens(op, configuration), req.maxOutputTokensCap);

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
        // Lot 54 : l'appelant peut accepter plusieurs contrats (T4 v1 / v2) —
        // on retient le schéma qui correspond au contrat résolu.
        for (const callerSchema of [req.outputSchema as ZodType, ...(req.acceptedOutputSchemas ?? [])]) {
          resolvedContract = resolveRuntimeContract({
            schemaName: structured?.built.output.schemaName ?? schemaName, operationCode,
            callerSchema,
            requestedVersion: structured?.built.output.contractVersion ?? null,
          });
          if (!resolvedContract.mismatch) break;
        }
        if (resolvedContract?.mismatch && req.acceptedOutputSchemas?.length) {
          resolvedContract = resolveRuntimeContract({
            schemaName: structured?.built.output.schemaName ?? schemaName, operationCode,
            callerSchema: req.outputSchema as ZodType,
            requestedVersion: structured?.built.output.contractVersion ?? null,
          });
        }
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

    // ══════════════════════════════════════════════════════════════════════
    // LOT 82C — CAPTURE COMPLÈTE À LA SOURCE (CDC Pilotage IA V2, LOG-01)
    //
    // Chaque requête réellement transmise au fournisseur (essais internes du
    // même modèle et passes de réparation compris) est relevée AU POINT
    // D'APPEL : prompt final, paramètres de génération construits, délai,
    // issue. La capture de chaque tentative accompagne sa trace
    // (`recordCallTrace` → `ai_call_captures`) : rien n'est reconstitué
    // ensuite à partir de la configuration courante.
    // ══════════════════════════════════════════════════════════════════════
    const sent: CapturedRequest[] = [];
    const capturing: AiProvider = {
      name: provider.name,
      isConfigured: () => provider.isConfigured(),
      call: async (i: ProviderCallInput) => {
        const entry = capturedRequestOf(i, psHash);
        sent.push(entry);
        try {
          const o = await provider.call(i);
          entry.outcome = 'SUCCESS';
          return o;
        } catch (e) {
          entry.outcome = 'FAILED';
          entry.error = e instanceof Error ? e.message : String(e);
          throw e;
        }
      },
    };
    const subjectRef = subjectRefOfIdempotencyKey(req.idempotencyKey);
    const configuredMax = configuration.maxOutputTokens ?? null;
    /** Paramètres résolus d'une tentative (rang, raisonnement, plafond demandé / hérité / adapté / envoyé). */
    const paramsOf = (p: { model: string; rankIndex: number; reasoning: ProviderCallInput['reasoning'] | null; timeoutMs: number; soStatus: string | null; requests: CapturedRequest[]; request?: RequestTrace | null }): Record<string, unknown> => {
      const lastCfg = p.requests[p.requests.length - 1]?.generationConfig ?? null;
      const envoye = lastCfg && typeof lastCfg.maxOutputTokens === 'number' ? lastCfg.maxOutputTokens : null;
      const rt = p.request ?? null;
      return {
        provider: provider.name, model: p.model, rank: rankAt(p.rankIndex), reasoning: p.reasoning ?? null,
        // Lot 85C (CFG-02, décision 08) : demandé / hérité / adapté / envoyé,
        // tels que résolus par le constructeur de requête unique.
        maxOutputTokens: {
          requested: rt ? rt.maxOutputTokens.requested : configuredMax, origin: rt?.maxOutputTokens.origin ?? null,
          operationFloor: op.minOutputTokens ?? null, callerCap: req.maxOutputTokensCap ?? null,
          inherited: p.rankIndex > 0 && rt && rt.maxOutputTokens.origin !== 'operation_rank' ? rt.maxOutputTokens.requested : null,
          modelLimit: rt?.maxOutputTokens.modelLimit ?? null,
          adapted: rt ? rt.maxOutputTokens.adapted : maxOutputTokens ?? null, sent: p.requests.length ? envoye : null,
        },
        ...(rt ? {
          reasoningSent: rt.reasoning.sent, temperature: rt.temperature, family: rt.family,
          adaptations: rt.adaptations, capabilitySources: rt.capabilitySources,
        } : {}),
        timeoutMs: p.timeoutMs, jsonResponse, structuredOutput: p.soStatus, providerSchemaHash: psHash,
        contract: { id: contract.contractId, version: contract.contractVersion, schemaVersion: contract.schemaVersion, schemaHash: contract.schemaHash },
        promptVersion, masterPrompt: master ? { code: master.masterPromptCode, version: master.masterPromptVersion, task: master.task } : null,
        executionMode: structuredTrace?.mode ?? null, configVersionId: configuration.configVersionId ?? null,
        configRevisionId: configuration.configRevisionId ?? null, informedOfPreviousError: undefined,
      };
    };
    const captureOf = (c: Omit<CallCaptureInput, 'origin' | 'variables' | 'variableMasks' | 'subjectRef' | 'sourceIds'>): CallCaptureInput => ({
      origin: 'gateway', variables: safeVariables, variableMasks, subjectRef, sourceIds, ...c,
    });

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
        // Lot 82C (LOG-05) : aucun appel fournisseur → durée propre nulle ; temps écoulé à part.
        inputTokens: 0, outputTokens: 0, costMicros: 0, durationMs: 0, executionElapsedMs: Date.now() - startedAt, status: 'error',
        errorCode: refus.code, errorMessage: refus.message, billable: false,
        failure: failureSummary(diag), callKind: 'analysis',
        runtimeContract: contractTraceOf(null, mismatch),
        ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
        capture: captureOf({
          callKind: 'pre_call_refusal', sent: [], attachments: req.attachments ?? [], callIndex: 0,
          params: paramsOf({ model, rankIndex: premierRang, reasoning: reasoningAtRank(configuration, premierRang), timeoutMs: op.timeoutMs, soStatus: null, requests: [] }),
          responseRaw: null, diagnostic: { ...diag, contractRefusal: refus.detail }, attemptDurationMs: 0, executionElapsedMs: Date.now() - startedAt,
        }),
        captureTransportOf: attachmentTransport,
      }).catch(() => null);
      await recordCallDiagnostic({
        traceId, usageEventId: usageId ?? null, callIndex: 0, accountId: req.accountId, useCaseCode: op.useCaseCode,
        operationCode, task: traceConfig.task, model, modelRank: rankAt(premierRang), sourceIds, diagnostic: { ...diag, contractRefusal: refus.detail } as CallDiagnostic, output: null,
      });
      await attachmentSession?.release().catch(() => { /* expiration à 48 h */ });
      throw new AiGatewayError(refus.code, operationCode, refus.message, { recoverable: false, contractDetail: refus.detail });
    }

    // ══════════════════════════════════════════════════════════════════════
    // LOT 87A — SECOURS PAR CAUSE (CDC Pilotage IA V2 P7 : RUN-01 à RUN-03,
    // R09, R10, R11, R57 ; décision PO 08). Même boucle qu'avant (aucun
    // second moteur) : avant chaque rang, la politique (`fallback-policy`)
    // décide si le modèle peut être sollicité — modèle connu indisponible
    // sauté sans appel, secours limité aux couples qualifiés (règle prudente
    // sans preuve admissible), exclusions respectées, au plus un essai
    // alternatif pour une cause indéterminée, aucune cascade après un défaut
    // commun. Chaque choix ou refus est tracé (`metadata.fallback`, capture,
    // erreur finale). Sans secours admissible après une panne de
    // disponibilité : `AI_SUSPENDED` (aucune écriture, reprise depuis un
    // point sûr). Les sondes de qualification (rang forcé) ne sautent jamais
    // leur modèle : elles doivent l'atteindre.
    // ══════════════════════════════════════════════════════════════════════
    const fbCtx = fallbackContext();
    const rangForce = traceConfig.triggerCode === 'qualification';
    const knownDown: ReadonlyMap<string, OperationalHint> = rangForce
      ? new Map() : await fbCtx.knownUnavailable().catch(() => new Map<string, OperationalHint>());
    // Exclusions manuelles EN VIGUEUR (86B), lues au moment de l'appel : la
    // chaîne figée au démarrage (RUN-04) perd ainsi un modèle exclu depuis.
    // Même règle que la surcouche : jamais de chaîne vidée (exclusions alors
    // ignorées) ; jamais pour une épreuve de qualification.
    const exclusVifs = new Set<string>();
    if (!rangForce) {
      const vives = await fbCtx.currentExclusions(treatment).catch(() => []);
      for (const m of models) if (isModelExcluded(m, treatment, vives)) exclusVifs.add(m);
      if (exclusVifs.size >= models.length) exclusVifs.clear();
    }
    let qualifView: CoupleQualificationView | null = null;
    const qualificationOf = async (model: string): Promise<CoupleQualification> => {
      if (!qualifView) {
        qualifView = await fbCtx.coupleQualifications({
          operationCode, configVersionId: configuration.configVersionId, configRevisionId: configuration.configRevisionId ?? null,
        }).catch(() => ({ origin: null, byModel: new Map() }));
      }
      return qualifView.byModel.get(model) ?? 'UNKNOWN';
    };
    const decisions: FallbackDecision[] = [];
    /** Échec (ou saut) qui conduit au rang suivant ; `null` : premier modèle à considérer. */
    let previous: { cause: FailureCause; model: string; truncatedAt: number | null } | null = null;
    let lastCause: FailureCause | null = null;
    let unknownAlternativesUsed = 0;
    let attempted = 0;
    /** Rang sans appel (modèle sauté ou secours refusé) : trace d'usage + capture « aucun envoi ». */
    const traceNoCall = async (p: { model: string; rankIndex: number; decision: FallbackDecision; reasoning: ProviderCallInput['reasoning'] | null; timeoutMs: number; request?: RequestTrace | null }) => {
      const code = p.decision.decision === 'KNOWN_UNAVAILABLE' ? 'MODEL_KNOWN_UNAVAILABLE' : 'FALLBACK_NOT_ADMISSIBLE';
      const message = `${p.model} non sollicité : ${p.decision.decisionLabel}${p.decision.afterCause ? ` (après « ${p.decision.afterCauseLabel} » sur ${p.decision.afterModel ?? '?'})` : ''}.`;
      const elapsedMs = Date.now() - startedAt;
      await recordCallTrace({
        traceId, useCaseCode: op.useCaseCode, operationCode, accountId: req.accountId, userId: req.userId,
        parentOperationId: req.parentOperationId, provider: provider.name, model: p.model, promptVersion, usedFallback: p.rankIndex > 0,
        shadow: Boolean(req.shadow), modelRank: rankAt(p.rankIndex), jobId, configVersionId: configuration.configVersionId,
        callerMode: req.callerMode, ...traceConfig, reasoning: p.reasoning, maxOutputTokens: null,
        inputTokens: 0, outputTokens: 0, costMicros: 0, durationMs: 0, executionElapsedMs: elapsedMs, status: 'error',
        errorCode: code, errorMessage: message, billable: false, callKind: 'analysis', fallback: p.decision,
        ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
        capture: captureOf({
          callKind: 'pre_call_refusal', sent: [], attachments: req.attachments ?? [], callIndex,
          params: { ...paramsOf({ model: p.model, rankIndex: p.rankIndex, reasoning: p.reasoning, timeoutMs: p.timeoutMs, soStatus: null, requests: [], request: p.request ?? null }), fallback: p.decision },
          responseRaw: null, diagnostic: { fallback: p.decision, message }, attemptDurationMs: 0, executionElapsedMs: elapsedMs,
        }),
        captureTransportOf: attachmentTransport,
      }).catch(() => null);
      callIndex++;
    };

    try {
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const usedFallback = i + premierRang > 0;
        const modelRank = rankAt(i + premierRang);
        // T1-UI-06, T2-UI-03, T3-UI-03, T4-UI-03 : niveau du rang RÉELLEMENT
        // sollicité. Indexé sur le rang dans la chaîne complète : une escalade
        // (`firstModelIndex`) ne doit pas recevoir le niveau du principal.
        // Lot 85C (P4, CFG-01/02, OP-03, décision 08) : réglage PROPRE au rang
        // (profil de l'opération, sinon référence du traitement), puis
        // paramètres effectifs construits d'après les CAPACITÉS du modèle par
        // le constructeur unique — même fonction que la validation et la
        // qualification. Un repli ne copie plus aveuglément le principal.
        const rang = rankSettings(op, configuration, i + premierRang);
        const reasoning = rang.reasoning;
        const timeoutMs = req.timeoutMsCap && req.timeoutMsCap > 0 ? Math.min(rang.timeoutMs, req.timeoutMsCap) : rang.timeoutMs;
        const built: ModelRequestResult = buildModelRequest({
          model, reasoning, maxOutputTokens: rang.maxOutputTokens, maxOutputTokensOrigin: rang.maxOutputTokensOrigin,
          minOutputTokens: op.minOutputTokens ?? null, callerCap: req.maxOutputTokensCap ?? null,
          needsImageInput: needsImageInput(req.attachments),
        });
        const maxOutputTokens = built.ok ? built.params.maxOutputTokens ?? undefined : undefined;

        // ── Lot 87A (P7) : ce rang peut-il être sollicité ? ─────────────────
        const down = knownDown.get(model) ?? null;
        let excluded = false;
        let qualification: CoupleQualification = 'UNKNOWN';
        // Exclusions EN VIGUEUR (une exclusion prise pendant l'exécution ne
        // fait que retirer) ; qualification pour les secours.
        if (!down) excluded = exclusVifs.has(model);
        if (previous !== null && !down && !excluded) qualification = await qualificationOf(model);
        const admission = admitCandidate({
          model, rankIndex: i + premierRang, knownUnavailable: down !== null, excluded, qualification,
          maxOutputTokens: built.ok ? built.params.maxOutputTokens ?? null : null,
        }, previous ? { cause: previous.cause, truncatedAtMaxOutputTokens: previous.truncatedAt, unknownAlternativesUsed } : null,
        { configOrigin: (qualifView as CoupleQualificationView | null)?.origin ?? null });
        const decision = decisionOf({
          rank: modelRank, model, admission, afterCause: previous?.cause ?? null, afterModel: previous?.model ?? null, qualification,
          operational: down,
        });
        decisions.push(decision);
        if (!admission.admitted) {
          failures.push(`${model} : ${ADMISSION_LABELS[admission.reason]}`);
          await traceNoCall({ model, rankIndex: i + premierRang, decision, reasoning, timeoutMs, request: built.trace });
          if (admission.reason === 'KNOWN_UNAVAILABLE') {
            // RUN-03 : vérification bornée de rétablissement (sonde existante).
            noteKnownUnavailableSkipped(model, down!);
            if (!previous) previous = { cause: 'KNOWN_UNAVAILABLE', model, truncatedAt: null };
            if (!lastCause) lastCause = 'KNOWN_UNAVAILABLE';
            continue;
          }
          // Cause qui arrête la chaîne (défaut commun, cause indéterminée déjà
          // retentée) : les rangs suivants sont refusés pour le même motif.
          if (admission.reason === 'CAUSE_STOPS_CHAIN' || admission.reason === 'UNKNOWN_CAUSE_LIMIT') {
            for (let k = i + 1; k < models.length; k++) {
              const d = decisionOf({ rank: rankAt(k + premierRang), model: models[k], admission, afterCause: previous?.cause ?? null, afterModel: previous?.model ?? null, qualification: 'UNKNOWN' });
              decisions.push(d);
              failures.push(`${models[k]} : ${ADMISSION_LABELS[admission.reason]}`);
              await traceNoCall({ model: models[k], rankIndex: k + premierRang, decision: d, reasoning: rankSettings(op, configuration, k + premierRang).reasoning, timeoutMs });
            }
            break;
          }
          continue;
        }
        if (previous?.cause && CAUSE_POLICY[previous.cause].fallback === 'ONE_ALTERNATIVE') unknownAlternativesUsed++;
        // §21 : un repli après une sortie invalide connaît l'erreur précédente.
        const informed = previousFailure?.family === 'INVALID_OUTPUT' && previousFailure.subtype !== 'OUTPUT_TRUNCATED'
          && previousFailure.subtype !== 'EMPTY_RESPONSE';
        const notice = informed ? fallbackNotice(previousFailure!) : '';
        // Structured output transmis à CE modèle ? (refus récent mémorisé : non.)
        const sendSchema = providerSchema?.schema && !schemaRejectedRecently(model, contract.schemaHash) ? providerSchema.schema : null;
        const attemptPrompt = `${withContract(!sendSchema)}${notice}`;
        const attemptStart = Date.now();
        const attemptFrom = sent.length;
        // Sortie du fournisseur conservée hors du try : si la VALIDATION échoue,
        // les jetons ont été consommés et facturés — COST-005 exige de garder
        // le coût réel de l'appel échoué.
        let out: ProviderCallOutput | null = null;
        let soStatus: string = providerSchema?.schema ? 'requested_schema' : jsonResponse ? 'json_mode' : 'none';
        if (providerSchema && !providerSchema.schema) soStatus = `schema_omitted_${providerSchema.omitted ?? 'unknown'}`;

        // Lot 52B : requête fournisseur décrite sans contenu, et tentatives
        // internes de CET appel (structurée, puis éventuel essai sans schéma).
        const trail: ProviderAttemptTrace[] = [];
        const providerRequest = providerRequestOf({
          model, maxOutputTokens, reasoning, jsonResponse, sendSchema, attachments: req.attachments ?? [],
          generation: built.ok ? built.params : undefined,
          psHash, providerSchema, omittedReason: sendSchema ? null
            : !(op.structuredOutput ?? (jsonResponse && isMasterOperation(op))) ? 'not_requested'
              : !structuredOutputEnabled() ? 'structured_output_off'
                : !providerSchema?.schema ? providerSchema?.omitted ?? 'unknown'
                  : 'recent_rejection',
        });

        const baseTrace = {
          traceId, useCaseCode: op.useCaseCode, operationCode, accountId: req.accountId, userId: req.userId,
          parentOperationId: req.parentOperationId, provider: provider.name, model, promptVersion, usedFallback,
          shadow: Boolean(req.shadow), modelRank, jobId, configVersionId: configuration.configVersionId,
          callerMode: req.callerMode, ...traceConfig, reasoning, maxOutputTokens: maxOutputTokens ?? null,
          // Lot 87A : choix de ce rang (cause, rang, modèle, motif).
          fallback: decision,
        };

        // ── Lot 85C (CFG-03, R02) : combinaison CONNUE comme incompatible →
        //    refus AVANT appel, catégorie explicite (journal P3), aucun coût ;
        //    le rang suivant, avec son propre profil, peut prendre le relais. ──
        if (!built.ok) {
          const refus = built.refusal;
          failures.push(`${model} : ${refus.message}`);
          lastFailureCode = 'MODEL_PARAMETERS_INCOMPATIBLE';
          const c = classifyCallError(Object.assign(new AiGatewayError('MODEL_PARAMETERS_INCOMPATIBLE', operationCode, refus.message, { recoverable: true }), { rejectedParameter: refus.parameter }));
          const diag = buildDiagnostic({
            outcome: 'FAILED', callKind: 'analysis', family: c.family, subtype: c.subtype, stage: c.stage,
            outputReceived: false, error: c.error, issues: [], issueCount: 0, controls: emptyControlChain(),
            provider: providerMetaOf(provider.name, model, undefined, { input: 0, output: 0 }, 0, undefined, 'none', c),
            schema: schemaRefOf(null), repairs: [], informedOfPreviousError: informed,
          });
          const elapsedMs = Date.now() - startedAt;
          const usageId = await recordCallTrace({
            ...baseTrace,
            inputTokens: 0, outputTokens: 0, costMicros: 0, durationMs: 0, executionElapsedMs: elapsedMs, status: 'error',
            errorCode: 'MODEL_PARAMETERS_INCOMPATIBLE', errorMessage: refus.message, billable: false,
            failure: failureSummary(diag), callKind: 'analysis', runtimeContract: contractTraceOf(null),
            ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
            capture: captureOf({
              callKind: 'pre_call_refusal', sent: [], attachments: req.attachments ?? [], callIndex,
              params: { ...paramsOf({ model, rankIndex: i + premierRang, reasoning, timeoutMs, soStatus: null, requests: [], request: built.trace }), refusal: refus, fallback: decision },
              responseRaw: null, diagnostic: { ...diag, parameterRefusal: refus }, attemptDurationMs: 0, executionElapsedMs: elapsedMs,
            }),
            captureTransportOf: attachmentTransport,
          }).catch(() => null);
          await recordCallDiagnostic({
            traceId, usageEventId: usageId ?? null, callIndex: callIndex++, accountId: req.accountId, useCaseCode: op.useCaseCode,
            operationCode, task: traceConfig.task, model, modelRank, sourceIds, diagnostic: diag, output: null,
          });
          previousFailure = diag;
          previous = { cause: 'PARAMETER_INCOMPATIBLE', model, truncatedAt: null };
          lastCause = 'PARAMETER_INCOMPATIBLE';
          continue;
        }

        attempted++;
        try {
          out = await callWithSchemaFallback(capturing, {
            model, prompt: attemptPrompt, attachments: req.attachments ?? [], timeoutMs, maxOutputTokens, reasoning, operationCode,
            generation: built.params,
            ...(traceConfig.task ? { task: traceConfig.task } : {}),
            ...(jsonResponse ? { jsonResponse: true } : {}),
            ...(attachmentSession ? { attachmentSession } : {}),
          }, sendSchema,
          (s) => { soStatus = s; }, () => noteSchemaRejected(model, contract.schemaHash),
          // Schéma refusé : même modèle, sans structured output — le schéma
          // DÉRIVÉ du même contrat passe alors dans le prompt.
          `${withContract(true)}${notice}`,
          // Lot 52B : 400 INVALID_ARGUMENT générique → essai diagnostique.
          { trail, providerSchemaHash: psHash, diagnosticRetry: true });
          if (soStatus === 'requested_schema' && !sendSchema) soStatus = 'schema_skipped_recent_rejection';
        } catch (raw) {
          // ── Échec AVANT toute sortie exploitable (fournisseur, réseau, délai) ──
          // Lot 61 : erreur locale déterministe (construction de la requête) →
          // REQUEST_BUILD_FAILED non récupérable : aucun repli, jamais
          // PROVIDER_UNAVAILABLE (incident fileId=98, appels 3738-3740).
          const e = !isAiGatewayError(raw) && isDeterministicLocalError(raw)
            ? Object.assign(new AiGatewayError('REQUEST_BUILD_FAILED', operationCode,
              raw instanceof Error ? raw.message : String(raw), { recoverable: false, cause: raw }), { aiStage: 'request_build' })
            : raw;
          const message = e instanceof Error ? e.message : String(e);
          const c = classifyCallError(e);
          const blockedMeta = (e as { providerMeta?: ProviderResponseMeta })?.providerMeta;
          const tokens = {
            input: Number((e as { inputTokens?: number })?.inputTokens ?? 0),
            output: Number((e as { outputTokens?: number })?.outputTokens ?? 0),
          };
          failures.push(`${model} : ${message}`);
          lastFailureCode = gatewayCodeOf(e, c);
          // Lot 87A : cause établie de la panne (tableau §8). Un paramètre
          // refusé est une incompatibilité de requête : jamais « modèle
          // indisponible », le disjoncteur n'avance pas.
          const cause = causeOfFailure({
            family: c.family, subtype: c.subtype, code: lastFailureCode, httpStatus: c.httpStatus, providerErrorCode: c.providerErrorCode, message,
          });
          previous = { cause, model, truncatedAt: null };
          lastCause = cause;
          if (CAUSE_POLICY[cause].countsForBreaker) attempts.push({ model, succeeded: false });
          const diag = buildDiagnostic({
            outcome: 'FAILED', callKind: 'analysis', family: c.family, subtype: c.subtype, stage: c.stage,
            outputReceived: false, error: c.error, issues: [], issueCount: 0,
            controls: { ...emptyControlChain(), providerResponse: 'failed' },
            provider: providerMetaOf(provider.name, model, blockedMeta, tokens, Date.now() - attemptStart, maxOutputTokens, soStatus, c),
            schema: schemaRefOf(soStatus), repairs: [], informedOfPreviousError: informed,
          });
          const requests = withTrailKinds(sent.slice(attemptFrom), trail);
          const attemptMs = Date.now() - attemptStart;
          const elapsedMs = Date.now() - startedAt;
          const usageId = await recordCallTrace({
            ...baseTrace,
            // COST-005 : aucune réponse → rien de consommé (blocage : jetons réels).
            inputTokens: tokens.input, outputTokens: tokens.output,
            costMicros: tokens.input || tokens.output ? calcCostMicros(model, tokens.input, tokens.output, op.provider) : 0,
            // Lot 82C (LOG-05, R29) : durée PROPRE de la tentative (corrige le
            // cumul depuis le début de l'exécution) ; temps total à part.
            durationMs: attemptMs, executionElapsedMs: elapsedMs, status: 'error',
            errorCode: lastFailureCode, errorMessage: sansSortieBrute(op.useCaseCode) ? stripRawExcerpt(message) : message,
            billable: Boolean(tokens.input || tokens.output) && op.billable && !req.shadow,
            failure: failureSummary(diag), providerMeta: compactProviderMeta(diag.provider), callKind: 'analysis',
            providerRequest, providerAttempts: trail,
            runtimeContract: contractTraceOf(soStatus),
            ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
            capture: captureOf({
              callKind: 'analysis', sent: requests, attachments: req.attachments ?? [], callIndex,
              params: { ...paramsOf({ model, rankIndex: i + premierRang, reasoning, timeoutMs, soStatus, requests, request: built.trace }), informedOfPreviousError: informed, fallback: decision },
              responseRaw: null, diagnostic: diag, attemptDurationMs: attemptMs, executionElapsedMs: elapsedMs,
            }),
            captureTransportOf: attachmentTransport,
          }).catch(() => null);
          await recordCallDiagnostic({
            traceId, usageEventId: usageId ?? null, callIndex: callIndex++, accountId: req.accountId, useCaseCode: op.useCaseCode,
            operationCode, task: traceConfig.task, model, modelRank, sourceIds, diagnostic: diag, output: null,
          });
          previousFailure = diag;
          // Une erreur non récupérable arrête immédiatement la chaîne de repli.
          // Elle compte pour le modèle, pas comme échec complet de la chaîne.
          if (isAiGatewayError(e) && !e.recoverable) {
            noteGatewayOutcome({ attempts, chainSucceeded: null });
            throw e;
          }
          continue;
        }

        // ── Sortie reçue : résolution progressive ─────────────────────────
        const analysisDuration = Date.now() - attemptStart;
        const analysisRequests = withTrailKinds(sent.slice(attemptFrom), trail);
        const repairFrom = sent.length;
        const meta = providerMetaOf(provider.name, model, out.meta, { input: out.inputTokens, output: out.outputTokens }, analysisDuration, maxOutputTokens, soStatus, null);
        // Lot 34D : validation avec le contrat runtime FIGÉ (celui de la génération).
        const resolveBase = {
          schema: contract.schema, schemaName: contract.schemaName, contract, generationStamp, operationCode, format: op.outputFormat ?? 'json',
          expectedTask: discriminant ? master!.task : undefined,
          taskField: master ? (op.taskField ?? 'task') : undefined,
          jsonRequested: jsonResponse || soStatus === 'requested_schema',
          provider: meta,
        } as const;
        // Lot 87A (décision PO 08) : une génération arrêtée sur le plafond de
        // sortie n'est jamais exhaustive — principal ou secours, elle ne
        // devient JAMAIS une réussite (ni par réparation JSON, ni par retrait
        // de champs).
        const truncated = isTruncated(meta);
        const resolved = resolveOutput({ ...resolveBase, raw: out.rawText, allowPruning: !repairAllowed && pruningAllowed });
        const first = resolved.ok && truncated ? truncatedFailure(resolved) : resolved;
        let final: Resolution = first;
        let repairRun: RepairRun | null = null;
        if (!first.ok && repairAllowed && first.repairable && !first.taskMismatch) {
          repairRun = await this.repairPass({
            provider: capturing, model, operationCode, op, resolveBase, first, reasoning, maxOutputTokens, timeoutMs, generation: built.params,
            providerSchema: providerSchema?.schema && !schemaRejectedRecently(model, contract.schemaHash) ? providerSchema.schema : null,
            discriminant, traceConfig, contract, schemaRefOf,
          });
          final = repairRun?.resolution ?? first;
        }
        if (!final.ok && !(!first.ok && first.taskMismatch) && repairAllowed) {
          // Validation champ par champ sur la sortie d'origine (réparation absente ou insuffisante).
          const pruned = resolveOutput({ ...resolveBase, raw: out.rawText, allowPruning: true });
          if (pruned.ok && !truncated) final = pruned;
        }
        // Réparation dont la propre sortie est tronquée : même règle.
        if (final.ok && repairRun?.resolution?.ok && final === repairRun.resolution && isTruncated(repairRun.diagnostic.provider)) {
          final = truncatedFailure(final);
        }

        const costMicros = calcCostMicros(model, out.inputTokens, out.outputTokens, op.provider);
        const succeeded = final.ok;
        const elapsedAtTrace = Date.now() - startedAt;
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
          // Lot 82C (LOG-05, R29) : durée PROPRE de l'appel d'analyse (sans la
          // passe de réparation, tracée à part) ; temps total de l'exécution à part.
          durationMs: analysisDuration, executionElapsedMs: elapsedAtTrace,
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
          providerRequest, providerAttempts: trail,
          ...(diag.outcome === 'REPAIRED' ? { repaired: true } : {}),
          runtimeContract: contractTraceOf(soStatus, first.ok ? null : first.contractMismatch ?? null),
          transformations: transformationsOf(final.ok ? final.repairs : first.repairs, repairRun),
          ...(structuredTrace ? { structuredContext: structuredTrace } : {}),
          capture: captureOf({
            callKind: 'analysis', sent: analysisRequests, attachments: req.attachments ?? [], callIndex,
            params: { ...paramsOf({ model, rankIndex: i + premierRang, reasoning, timeoutMs, soStatus, requests: analysisRequests, request: built.trace }), informedOfPreviousError: informed, fallback: decision },
            responseRaw: out.rawText,
            // LOG-03 : sortie d'origine (`response_raw`), parsing du premier passage, sortie acceptée après normalisation / réparation.
            parsed: { firstPass: first.parsed ?? null, accepted: final.ok ? final.data : null },
            diagnostic: diag, attemptDurationMs: analysisDuration, executionElapsedMs: elapsedAtTrace,
          }),
          captureTransportOf: attachmentTransport,
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
            durationMs: repairRun.durationMs, executionElapsedMs: Date.now() - startedAt,
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
            capture: captureOf({
              callKind: 'repair', sent: sent.slice(repairFrom).map((r) => ({ ...r, kind: 'repair' })), attachments: [], callIndex,
              params: { ...paramsOf({ model, rankIndex: i + premierRang, reasoning, timeoutMs: Math.min(timeoutMs, 60_000), soStatus: repairRun.diagnostic.provider.structuredOutputStatus ?? null, requests: sent.slice(repairFrom), request: built.trace }), fallback: decision },
              responseRaw: repairRun.rawText,
              parsed: { firstPass: null, accepted: repairRun.resolution?.ok ? repairRun.resolution.data : null },
              diagnostic: repairRun.diagnostic, attemptDurationMs: repairRun.durationMs, executionElapsedMs: Date.now() - startedAt,
            }),
          }).catch(() => null);
          await recordCallDiagnostic({
            traceId, usageEventId: repairUsage ?? null, callIndex: callIndex++, accountId: req.accountId, useCaseCode: op.useCaseCode,
            operationCode, task: traceConfig.task, model, modelRank, sourceIds, diagnostic: repairRun.diagnostic,
            output: keepRawOutput && repairRun.rawText != null ? { raw: repairRun.rawText, extracted: null, parsed: null } : null,
          });
        }

        if (final.ok) {
          attempts.push({ model, succeeded: true });
          noteGatewayOutcome({ attempts, chainSucceeded: true });
          const totalIn = out.inputTokens + (repairRun?.inputTokens ?? 0);
          const totalOut = out.outputTokens + (repairRun?.outputTokens ?? 0);
          const totalCost = (costMicros ?? 0) + (repairRun ? calcCostMicros(model, repairRun.inputTokens, repairRun.outputTokens, op.provider) ?? 0 : 0);
          return {
            data: final.data as T, provider: provider.name, model, promptVersion, usedFallback,
            inputTokens: totalIn, outputTokens: totalOut,
            costMicros: totalCost, durationMs: Date.now() - startedAt, traceId, fromCache: false,
            outputRepairs: final.repairs,
            // Lot 54G : originaux des champs retirés — en mémoire pour l'appelant, jamais tracés.
            ...(final.pruned?.length ? { prunedValues: final.pruned } : {}),
          };
        }

        // ── Contrat runtime incohérent : défaut interne, aucun repli ───────
        if (!first.ok && first.contractMismatch) {
          attempts.push({ model, succeeded: false });
          noteGatewayOutcome({ attempts, chainSucceeded: null });
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
        {
          const sub = first.ok ? (final.ok ? null : final.subtype) : first.subtype;
          const cause: FailureCause = sub === 'OUTPUT_TRUNCATED' || truncated ? 'OUTPUT_TRUNCATED' : 'INVALID_OUTPUT';
          previous = { cause, model, truncatedAt: cause === 'OUTPUT_TRUNCATED' ? maxOutputTokens ?? null : null };
          lastCause = cause;
        }
      }

      noteGatewayOutcome({
        // Lot 85C : une chaîne entièrement refusée AVANT appel (configuration
        // incompatible) n'est pas une panne de modèle : le disjoncteur n'avance pas.
        // Lot 87A : idem pour une chaîne dont tous les modèles sont connus
        // indisponibles (sautés) ou dont les seuls échecs sont des paramètres
        // refusés (incompatibilité de requête, jamais une indisponibilité).
        attempts, chainSucceeded: chaineComplete && attempts.length > 0 ? false : null,
        // Revue L16b-3 : un même document ne fait progresser le disjoncteur
        // qu'une fois par fenêtre (`recordChainOutcome`).
        target: req.sourceIds && req.sourceIds.length > 0 ? `sources:${[...req.sourceIds].sort((x, y) => x - y).join(',')}` : null,
      });
      if (chainOutcome({ lastCause, decisions, attempted }) === 'SUSPEND') {
        const cause = lastCause ?? 'UNKNOWN';
        throw new AiSuspendedError(operationCode,
          `Exécution suspendue sans écriture : aucun secours admissible après « ${CAUSE_POLICY[cause].label} ». ${failures.join(' — ')}`,
          cause, decisions as unknown as Array<Record<string, unknown>>, lastFailureCode, treatment);
      }
      const err = new AiGatewayError('ALL_MODELS_FAILED', operationCode,
        `Tous les modèles ont échoué. ${failures.join(' — ')}`, { recoverable: true, lastFailureCode });
      // Lot 87A : décisions de secours portées par l'erreur (diagnostic des appelants).
      Object.defineProperty(err, 'fallbackDecisions', { value: decisions, enumerable: false, configurable: true });
      throw err;
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
    /** Lot 85C : paramètres résolus du rang (même constructeur que l'analyse). */
    generation?: ProviderCallInput['generation'];
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
        ...(p.generation ? { generation: p.generation } : {}),
        ...(p.traceConfig.task ? { task: p.traceConfig.task } : {}), jsonResponse: true, callKind: 'repair',
      }, p.providerSchema, (s) => { soStatus = s; }, () => noteSchemaRejected(p.model, schemaHash));
    } catch (e) {
      const c = classifyCallError(e);
      return {
        resolution: null, rawText: null, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - start,
        errorCode: gatewayCodeOf(e, c), errorMessage: c.error.message,
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

/** Lot 85C : l'appel transmet une image ou un PDF (modalité d'entrée exigée du modèle). */
export function needsImageInput(attachments: ReadonlyArray<{ mimeType?: string | null }> | undefined): boolean {
  return (attachments ?? []).some((a) => typeof a.mimeType === 'string' && (a.mimeType.startsWith('image/') || a.mimeType === 'application/pdf'));
}

/**
 * Plafond de sortie de l'appelant : ne fait que réduire (jamais augmenter) la
 * valeur configurée ; sans valeur configurée, le plafond s'applique seul.
 */
function plafonnerSortie(configure: number | undefined, plafond: number | undefined): number | undefined {
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
 * texte porté par la version de configuration (D-03).
 */
function configuredMasterText(
  _useCaseCode: Parameters<typeof treatmentOfUseCase>[0],
  cfg: { promptArchitecture?: string; masterPromptText?: string | null; masterPromptVersionId?: number | null },
): string | null {
  if (cfg.promptArchitecture !== 'master') return null;
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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 52B — 400 INVALID_ARGUMENT GÉNÉRIQUE (« Request contains an invalid
 * argument. ») sur une requête qui portait un `responseSchema`
 *
 * Google ne dit pas QUEL argument est refusé : le schéma n'est pas cité,
 * donc pas de `STRUCTURED_OUTPUT_REJECTED`. Avant de changer de modèle (qui
 * recevrait le MÊME schéma), UNE tentative diagnostique du MÊME modèle :
 *   · sans `responseSchema`, `responseMimeType` application/json conservé ;
 *   · prompt `promptWithoutSchema` : schéma DÉRIVÉ du même contrat runtime
 *     joint au prompt (`runtimeContractBlock(…, schemaInPrompt: true)`) ;
 *   · succès → le structured output est la cause opérationnelle : statut
 *     `schema_rejected_retried_without`, refus mémorisé (modèle + schemaHash,
 *     TTL existant), la réponse est validée normalement, la cascade s'arrête ;
 *   · échec → cause NON démontrée : rien n'est mémorisé, l'erreur d'ORIGINE
 *     est relevée (INPUT_ERROR, cause réellement observée), cascade normale.
 * Jamais pour AUTH_ERROR, RATE_LIMIT, CONTEXT_TOO_LARGE, SAFETY_BLOCK,
 * TIMEOUT, NETWORK_ERROR (`isGenericInvalidArgument`). Une seule tentative,
 * aucune boucle. Réservé aux appels d'ANALYSE (`diagnosticRetry`) : la passe
 * de réparation garde le comportement historique.
 * ══════════════════════════════════════════════════════════════════════════
 */
async function callWithSchemaFallback(
  provider: AiProvider,
  input: ProviderCallInput,
  schema: Record<string, unknown> | null,
  setStatus: (s: string) => void,
  onRejected: () => void,
  /** Lot 34D : prompt du nouvel essai sans structured output (schéma du contrat inclus). */
  promptWithoutSchema?: string,
  /** Lot 52B : tentatives internes (tracées) et essai diagnostique autorisé. */
  opts: { trail?: ProviderAttemptTrace[]; providerSchemaHash?: string | null; diagnosticRetry?: boolean } = {},
): Promise<ProviderCallOutput> {
  const trail = opts.trail;
  const note = (a: Omit<ProviderAttemptTrace, 'step'>) => { trail?.push({ step: (trail?.length ?? 0) + 1, ...a }); };
  const mime = (structured: boolean, i: ProviderCallInput) => (structured || i.jsonResponse ? 'application/json' : null);
  const timed = async (i: ProviderCallInput, kind: ProviderAttemptTrace['kind']): Promise<ProviderCallOutput> => {
    const structured = i.responseSchema !== undefined;
    const t0 = Date.now();
    const base = { kind, responseSchemaSent: structured, providerSchemaHash: structured ? opts.providerSchemaHash ?? null : null, responseMimeType: mime(structured, i) };
    try {
      const out = await provider.call(i);
      note({ ...base, outcome: 'SUCCESS', httpStatus: null, providerErrorCode: null, family: null, durationMs: Date.now() - t0 });
      return out;
    } catch (e) {
      const c = classifyCallError(e);
      note({ ...base, outcome: 'FAILED', httpStatus: c.httpStatus, providerErrorCode: c.providerErrorCode, family: c.family, durationMs: Date.now() - t0 });
      throw e;
    }
  };
  if (!schema) return timed(input, 'initial');
  try {
    return await timed({ ...input, responseSchema: schema }, 'initial');
  } catch (e) {
    const c = classifyCallError(e);
    // Nouvel essai SANS schéma : `responseMimeType` application/json conservé.
    const sansSchema: ProviderCallInput = {
      ...input, jsonResponse: true, ...(promptWithoutSchema !== undefined ? { prompt: promptWithoutSchema } : {}),
    };
    if (c.subtype === 'STRUCTURED_OUTPUT_REJECTED') {
      onRejected();
      setStatus('schema_rejected_retried_without');
      return timed(sansSchema, 'schema_rejected_retry');
    }
    if (!opts.diagnosticRetry || !isGenericInvalidArgument(c)) throw e;
    let out: ProviderCallOutput;
    try {
      out = await timed(sansSchema, 'diagnostic_retry');
    } catch {
      // Cause non démontrée : erreur d'origine, aucune mémorisation.
      throw e;
    }
    onRejected();
    setStatus('schema_rejected_retried_without');
    return out;
  }
}

/**
 * Lot 87A (décision PO 08) — sortie TRONQUÉE rendue conforme par une
 * réparation ou un retrait de champs : échec `OUTPUT_TRUNCATED` (jamais une
 * réussite). Pur.
 */
function truncatedFailure(r: Resolution): Extract<Resolution, { ok: false }> {
  return {
    ok: false, subtype: 'OUTPUT_TRUNCATED', stage: 'response_reception',
    issues: [], issueCount: 0,
    message: 'Sortie tronquée (plafond de sortie atteint) : jamais acceptée comme réussite, même rendue conforme (décision PO 08).',
    controls: r.controls, repairs: r.repairs, parsed: r.parsed, extracted: r.extracted ?? null,
    best: undefined, prepared: undefined, repairable: false, allPaths: [], optionalPaths: [],
  };
}

/**
 * Consigne ajoutée au prompt d'un REPLI après une sortie invalide (§21) : le
 * modèle suivant connaît l'erreur exacte au lieu de recevoir les mêmes
 * instructions. Seulement des chemins, attendus et types reçus — jamais de
 * valeur issue du document.
 */
function fallbackNotice(prev: Pick<CallDiagnostic, 'subtype' | 'issues'>): string {
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
    ...(c?.rejectedParameter ? { rejectedParameter: c.rejectedParameter } : {}),
  };
  m.maxTokensReached = String(m.finishReason ?? '').toUpperCase() === 'MAX_TOKENS';
  return m;
}

/**
 * Code de passerelle d'une erreur levée PENDANT l'appel fournisseur. Lot 52B :
 * une erreur brute du fournisseur n'est plus systématiquement
 * `PROVIDER_UNAVAILABLE` — une requête REFUSÉE (400 INVALID_ARGUMENT,
 * contexte trop grand, clé refusée, structured output refusé) devient
 * `PROVIDER_REQUEST_REJECTED`. Même caractère récupérable qu'avant.
 */
export function gatewayCodeOf(e: unknown, c: Pick<ClassifiedFailure, 'family' | 'subtype'>): AiErrorCode {
  if (isAiGatewayError(e)) return e.code;
  // Lot 61 : erreur locale déterministe — jamais une indisponibilité fournisseur.
  if (isDeterministicLocalError(e)) return 'REQUEST_BUILD_FAILED';
  const cat = providerFailureCategory(c.family, c.subtype);
  return cat === 'REQUEST_REJECTED' || cat === 'STRUCTURED_OUTPUT_REJECTED' || cat === 'PARAMETER_REJECTED' ? 'PROVIDER_REQUEST_REJECTED' : 'PROVIDER_UNAVAILABLE';
}

/** Lot 52B — requête fournisseur d'un appel, sans contenu (BO › Exécutions IA). */
function providerRequestOf(p: {
  model: string; maxOutputTokens: number | undefined; reasoning: ProviderCallInput['reasoning']; jsonResponse: boolean;
  generation?: ProviderCallInput['generation'];
  sendSchema: Record<string, unknown> | null; attachments: ProviderCallInput['attachments'];
  psHash: string | null; providerSchema: { nodes: number; dropped: string[] } | null; omittedReason: string | null;
}): ProviderRequestTrace {
  const g = describeGenerationConfig({
    model: p.model, maxOutputTokens: p.maxOutputTokens, reasoning: p.reasoning, jsonResponse: p.jsonResponse,
    ...(p.generation ? { generation: p.generation } : {}),
    ...(p.sendSchema ? { responseSchema: p.sendSchema } : {}),
  });
  return {
    responseSchemaSent: g.responseSchemaSent,
    providerSchemaHash: p.psHash,
    schemaNodes: p.providerSchema ? p.providerSchema.nodes : null,
    droppedKeywords: p.providerSchema ? [...p.providerSchema.dropped].slice(0, 40) : [],
    schemaOmittedReason: p.omittedReason,
    responseMimeType: g.responseMimeType,
    maxOutputTokens: g.maxOutputTokens,
    thinkingConfig: g.thinkingConfig,
    attachments: describeAttachments(p.attachments),
  };
}

/** Résumé d'échec figé dans `ai_usage_event.metadata` (listes, filtres). */
function failureSummary(d: CallDiagnostic): { family: string; subtype: string | null; stage: string | null; signature: string | null; parameter?: string } | undefined {
  return d.family ? {
    family: d.family, subtype: d.subtype, stage: d.stage, signature: d.signature,
    // Lot 82C (LOG-04) : paramètre refusé, lisible dans les listes et filtres.
    ...(d.provider?.rejectedParameter ? { parameter: d.provider.rejectedParameter } : {}),
  } : undefined;
}

/** Lot 82C — masques appliqués aux variables d'un appel (sans conserver les valeurs d'origine). Pur. */
function masksOfVariables(vars: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const [k, n] of Object.entries(redactWithReport(v).masks)) out[k] = (out[k] ?? 0) + n;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(vars);
  return out;
}

/** Nature des essais internes d'un appel (structuré, puis sans schéma), dans l'ordre des requêtes. Pur. */
function withTrailKinds(requests: CapturedRequest[], trail: ProviderAttemptTrace[]): CapturedRequest[] {
  return requests.map((r, k) => (trail[k] ? { ...r, kind: trail[k].kind } : r));
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
  useCaseCode: Parameters<typeof treatmentOfUseCase>[0],
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

/** Délai de prise d'effet d'une perte d'éligibilité pour les appels modèle (lot 82A). */
const ELIGIBILITY_CACHE_MS = 5_000;

/**
 * Lot 82A (C-Q10) : refuse un appel modèle pour un compte non éligible
 * (`ACCOUNT_INELIGIBLE`, non récupérable, motif dans `reason`). Lecture
 * impossible : l'erreur remonte (aucun appel à l'aveugle) — dans la file,
 * reprise technique normale.
 */
async function assertAccountEligibleForAi(accountId: number | null | undefined, useCaseCode: string, operationCode: string): Promise<void> {
  if (!accountId || accountId <= 0 || isTechnicalUseCase(useCaseCode)) return;
  const e = await checkAccountProcessingEligibility(accountId, { maxAgeMs: ELIGIBILITY_CACHE_MS });
  if (e.eligible) return;
  const err = new AiGatewayError('ACCOUNT_INELIGIBLE', operationCode,
    `Appel IA refusé : compte ${accountId} non éligible aux traitements (${INELIGIBILITY_LABELS[e.reason ?? 'READ_ONLY']}) — décision PO C-Q10.`,
    { recoverable: false });
  Object.defineProperty(err, 'reason', { value: e.reason ?? 'READ_ONLY', enumerable: true });
  throw err;
}
