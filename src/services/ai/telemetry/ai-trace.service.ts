/**
 * Journalisation des appels modèles — CDC §5.5.
 *
 * Chaque appel est rattaché à : un usage cible, une opération, un compte,
 * éventuellement un utilisateur, une source ou un objet, un modèle, une version
 * de prompt, un résultat métier, un coût et une durée.
 *
 * Écrit dans `ai_pipeline_step`, étendue par la migration 0101 avec
 * `use_case_code`, `operation_code` et `trace_id`. Les tables de suivi
 * existantes sont conservées et renforcées, jamais remplacées.
 */
import { db, pgClient } from '@/db';
import { traceMasterColumnsReady } from './trace-schema';
import { aiPipelineStep, aiUsageEvent } from '@/db/schema';
import type { AiUseCaseCode } from '../registry/use-cases';
import { getExecutionContext, type ModelRank } from './execution-context';
import { currentJobContext } from '../queue/job-context';
import { getCachedPrice } from '../gateway/pricing/pricing.repository';

export interface CallTrace {
  traceId: string;
  useCaseCode: AiUseCaseCode;
  operationCode: string;
  /** `null` : appel technique sans compte (sonde du disjoncteur, MOD-013). */
  accountId: number | null;
  userId?: number;
  parentOperationId?: number;
  provider: string;
  model: string;
  promptVersion: string;
  usedFallback: boolean;
  inputTokens: number;
  outputTokens: number;
  /** `null` = tarif inconnu, coût non calculable (COST-008) — jamais inventé. */
  costMicros: number | null;
  durationMs: number;
  status: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  /** false pour le mode shadow et les opérations internes (CDC §10.2). */
  billable: boolean;
  shadow: boolean;
  outputPreview?: string;
  /**
   * Rang du modèle réellement utilisé (§9.1). Plus précis qu'`usedFallback`,
   * qui ne distingue pas les deux replis — or un traitement qui bascule
   * toujours sur le second est un incident, pas un repli ordinaire.
   */
  modelRank?: ModelRank | null;
  /** Travail de file à l'origine de l'appel, s'il y en a un. */
  jobId?: number | null;
  /**
   * Version dont vient la configuration APPLIQUÉE (figée par l'exécution,
   * VER-015). Absente : version effective au moment de la trace.
   */
  configVersionId?: number | null;
  /** Mode d'appel déclaré par l'appelant (CDC Mascotte BO-009), figé en métadonnée. */
  callerMode?: 'displayed' | 'pregeneration';
  /**
   * CDC 15 DP-05, ARCH-03 : branche TASK/MODE et prompt maître — colonnes
   * `task`, `master_prompt_code`, `master_prompt_version` (migration 0217).
   */
  task?: string | null;
  masterPromptCode?: string | null;
  masterPromptVersion?: string | null;
  /**
   * CDC 15 CFG-02, OBS-CFG : paramètres RÉSOLUS réellement envoyés au
   * fournisseur, figés en métadonnée — niveau de raisonnement du rang
   * sollicité, plafond de jetons de sortie (`null` = défaut du modèle).
   */
  reasoning?: string | null;
  maxOutputTokens?: number | null;
  /** CDC 15 CFG-05 : moteur réellement utilisé (`legacy` = relais historique). */
  engine?: 'legacy' | 'new';
  /** CDC 15 OBS-CFG : déclencheur effectif (absent : celui du job courant). */
  triggerCode?: string | null;
  /**
   * Lot 33D — nature de l'appel (`analysis` / `repair`), résumé de l'échec
   * (famille, sous-type, étape, signature) et métadonnées natives du
   * fournisseur (fin de génération, identifiant de réponse…), figés en
   * métadonnée. Jamais de contenu : le diagnostic complet et la sortie du
   * modèle sont dans `ai_call_diagnostics` (accès BO restreint).
   */
  callKind?: 'analysis' | 'repair';
  failure?: { family: string; subtype: string | null; stage: string | null; signature: string | null };
  providerMeta?: Record<string, unknown>;
  /** Sortie acceptée après correction (normalisation, réparation, élagage). */
  repaired?: boolean;
  /**
   * Lot 34D — contrat runtime de l'appel (identifiant, version, version et
   * empreinte du schéma, structured output transmis ou non, empreinte du
   * schéma fournisseur, version de la table de compatibilité). Figé en
   * métadonnée de CHAQUE appel (réussi compris) : BO › Exécutions IA.
   */
  runtimeContract?: RuntimeContractTrace;
  /**
   * Lot 34D — transformations appliquées à la sortie : normalisations,
   * mappings de compatibilité, passe de réparation (SUCCESS / FAILED).
   */
  transformations?: OutputTransformationsTrace;
  /**
   * Lot 34D (T4) — contexte d'exécution structuré : mode, TASK, versions de
   * prompt / contrat d'entrée / contrat de sortie (tracées séparément),
   * empreinte du prompt et du contexte construit.
   */
  structuredContext?: StructuredContextTrace;
}

/** Contrat runtime tracé avec un appel (lot 34D). */
export interface RuntimeContractTrace {
  contractId: string;
  contractVersion: number;
  schemaVersion: string;
  schemaHash: string;
  structuredOutput: boolean;
  providerSchemaHash: string | null;
  compatTableVersion: number;
  /** Présent seulement en cas de désaccord génération / validation. */
  mismatch?: { generationHash: string; validationHash: string; validationVersion: string };
}

/** Transformations d'une sortie (lot 34D). */
export interface OutputTransformationsTrace {
  /** `amountCents string → integer` : règle et chemin. */
  normalizations: string[];
  /** `t1_document_date_to_documentDate`, `t1_v1_to_v2`, `enum_synonym` : règle et chemin. */
  compatMappings: string[];
  /** Passe de réparation IA : null si non lancée. */
  repair: 'SUCCESS' | 'FAILED' | null;
  /** Champs retirés (validation champ par champ). */
  pruned: string[];
}

/** Contexte d'exécution structuré (T4, lot 34D). */
export interface StructuredContextTrace {
  mode: 'LEGACY_TEMPLATE' | 'STRUCTURED_CONTEXT';
  task: string;
  promptVersion: string;
  promptHash: string;
  inputContractVersion: string | null;
  outputContractVersion: string | null;
  contextHash: string | null;
}

/**
 * Métadonnées de configuration d'un appel (CDC 15 CFG-02, CFG-05, OBS-CFG).
 * Pur, exporté pour les tests. Seules les valeurs connues sont écrites : une
 * clé absente veut dire « non transmis par l'appelant », jamais « défaut ».
 */
export function configMetadata(t: CallTrace): Record<string, unknown> {
  const trigger = t.triggerCode !== undefined ? t.triggerCode : currentJobContext()?.triggerCode ?? null;
  return {
    ...(t.reasoning !== undefined ? { reasoning: t.reasoning } : {}),
    ...(t.maxOutputTokens !== undefined ? { maxOutputTokens: t.maxOutputTokens } : {}),
    ...(t.engine ? { engine: t.engine } : {}),
    ...(trigger ? { trigger } : {}),
  };
}

/** Tentative du job courant (lot 34C), si l'appel a lieu dans ce job. */
export function jobAttemptMetadata(t: Pick<CallTrace, 'jobId'>): { jobAttempt?: number } {
  const ctx = currentJobContext();
  if (!ctx?.jobAttempt || (t.jobId != null && t.jobId !== ctx.jobId)) return {};
  return { jobAttempt: ctx.jobAttempt };
}

/**
 * Écrit la trace d'un appel. Rend l'identifiant de l'événement d'usage
 * (`ai_usage_event.id`, lot 33D : rattachement du diagnostic), `null` s'il
 * n'a pas pu être écrit.
 */
export async function recordCallTrace(t: CallTrace): Promise<number | null> {
  // Version IA effective et commit déployé (§9.1, GEN-008). Lus ici plutôt
  // que demandés à chaque appelant : une information de traçabilité qu'il
  // faut penser à passer finit par manquer là où elle compte le plus.
  const ctx = await getExecutionContext().catch(() => ({ configVersionId: null, appVersion: null, environment: null }));
  const master = {
    task: t.task ?? null,
    masterPromptCode: t.masterPromptCode ?? null,
    masterPromptVersion: t.masterPromptVersion ?? null,
  };

  // Les deux écritures sont ISOLÉES : l'échec de l'étape de pipeline ne doit
  // pas faire perdre l'événement d'usage (coût, quota), ni l'inverse.
  // La télémétrie ne fait jamais échouer un traitement métier.
  if (t.parentOperationId) {
    try {
      const rows = await avecId(db.insert(aiPipelineStep).values({
        operationId: t.parentOperationId,
        stepName: t.operationCode,
        stepOrder: 0,
        provider: t.provider,
        model: t.model,
        durationMs: t.durationMs,
        status: t.status === 'success' ? 'done' : 'failed',
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        costMicros: t.costMicros,
        isFallback: t.usedFallback,
        errorCode: t.errorCode,
        errorMessage: t.errorMessage,
        promptVersion: t.promptVersion,
        outputPreview: t.outputPreview,
        // Colonnes ajoutées par la migration 0101.
        useCaseCode: t.useCaseCode,
        operationCode: t.operationCode,
        traceId: t.traceId,
      } as never), aiPipelineStep.id);
      await writeMasterFields('ai_pipeline_step', rows?.[0]?.id, master);
    } catch (e) {
      console.error('[ai-trace] étape de pipeline non écrite (non bloquant) :', (e as Error).message);
    }
  }

  try {
    const rows = await avecId(db.insert(aiUsageEvent).values({
      accountId: t.accountId,
      userId: t.userId,
      operationType: t.operationCode,
      provider: t.provider,
      model: t.model,
      isBillable: t.billable,
      isFallback: t.usedFallback,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      costMicros: t.costMicros,
      durationMs: t.durationMs,
      status: t.status,
      errorCode: t.errorCode,
      errorMessage: t.errorMessage,
      metadata: {
        traceId: t.traceId, promptVersion: t.promptVersion, shadow: t.shadow,
        // COST-007 (§9.1, lot IA 2) : référence tarifaire FIGÉE avec l'appel —
        // le tarif appliqué reste lisible même après une révision de grille.
        // `null` = aucun tarif connu (coût non calculable, COST-008).
        pricing: pricingRef(t.provider, t.model),
        ...(t.callerMode ? { callerMode: t.callerMode } : {}),
        ...configMetadata(t),
        ...(t.callKind && t.callKind !== 'analysis' ? { callKind: t.callKind } : {}),
        ...(t.failure ? { failure: t.failure } : {}),
        ...(t.providerMeta && Object.keys(t.providerMeta).length ? { providerMeta: t.providerMeta } : {}),
        ...(t.repaired ? { repaired: true } : {}),
        ...(t.runtimeContract ? { runtimeContract: t.runtimeContract } : {}),
        ...(t.transformations ? { transformations: t.transformations } : {}),
        ...(t.structuredContext ? { structuredContext: t.structuredContext } : {}),
        // Lot 34C : tentative du JOB de file pendant laquelle l'appel a eu
        // lieu — BO › Exécutions IA regroupe la cascade de modèles par
        // tentative (fallback modèle ≠ retry du job).
        ...jobAttemptMetadata(t),
      },
      useCaseCode: t.useCaseCode,
      operationCode: t.operationCode,
      configVersionId: t.configVersionId !== undefined ? t.configVersionId : ctx.configVersionId,
      appVersion: ctx.appVersion,
      // §18 (lot 17) : environnement réel de l'appel. La colonne vaut
      // 'production' PAR DÉFAUT : sans cette écriture, un appel de
      // préproduction ou local y était enregistré comme de production.
      // Inconnu → défaut de la colonne, comme avant.
      ...(ctx.environment ? { environment: ctx.environment } : {}),
      modelRank: t.modelRank ?? (t.usedFallback ? null : 'primary'),
      jobId: t.jobId ?? currentJobContext()?.jobId ?? null,
    } as never), aiUsageEvent.id);
    await writeMasterFields('ai_usage_event', rows?.[0]?.id, master);
    return rows?.[0]?.id ?? null;
  } catch (e) {
    console.error('[ai-trace] événement d\'usage non écrit (non bloquant) :', (e as Error).message);
    return null;
  }
}

/** INSERT avec identifiant rendu ; tolère un double de test sans `returning`. */
async function avecId(q: unknown, col: unknown): Promise<Array<{ id: number }>> {
  const r = q as { returning?: (c: unknown) => Promise<Array<{ id: number }>> } & PromiseLike<unknown>;
  if (typeof r.returning === 'function') return r.returning({ id: col });
  await r;
  return [];
}

/**
 * TASK et prompt maître (migration 0217, CDC 15 DP-05), écrits à part : ces
 * colonnes ne sont pas déclarées dans Drizzle (voir `trace-schema.ts`).
 * Aucune écriture tant que les trois valeurs sont nulles — le cas de tous les
 * appels hors master aujourd'hui — ni si la migration est absente.
 */
async function writeMasterFields(
  table: 'ai_usage_event' | 'ai_pipeline_step',
  id: number | undefined,
  m: { task: string | null; masterPromptCode: string | null; masterPromptVersion: string | null },
): Promise<void> {
  if (!id || (m.task === null && m.masterPromptCode === null && m.masterPromptVersion === null)) return;
  try {
    if (!(await traceMasterColumnsReady())) return;
    await pgClient.unsafe(
      `UPDATE ${table} SET task = $2, master_prompt_code = $3, master_prompt_version = $4 WHERE id = $1`,
      [id, m.task, m.masterPromptCode, m.masterPromptVersion] as never[],
    );
  } catch (e) {
    console.error(`[ai-trace] TASK / prompt maître non écrits sur ${table} (non bloquant) :`, (e as Error).message);
  }
}

/** Tarif en cache au moment de l'appel, sous forme de référence figée (COST-007). */
export function pricingRef(provider: string, model: string): {
  inputMicros: number; outputMicros: number; currency: string; source: string; verified: boolean;
} | null {
  try {
    const p = getCachedPrice(provider, model);
    return p
      ? { inputMicros: p.inputMicros, outputMicros: p.outputMicros, currency: p.currency, source: String(p.source), verified: p.verified }
      : null;
  } catch {
    return null;
  }
}
