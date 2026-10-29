/**
 * T3 — harmonisation du nommage documentaire (lot 61) : appel du modèle.
 *
 * Passe par la passerelle (traces « Exécutions IA », plafonds, arrêt
 * d'urgence, contrat de sortie, masquage, idempotence) : opération
 * `t3_document_naming`, branche DOCUMENT_NAMING du prompt maître T3.
 */
import { T3_NAMING_PERIOD_CONTRACT } from '@/lib/documents/document-title-period';
import type { T3DocumentNamingOutput } from '../master/t3-contract';

const DOCUMENT_NAMING_OPERATION = 't3_document_naming';
const DOCUMENT_NAMING_TASK = 'DOCUMENT_NAMING';

export interface NamingPromptStatus {
  available: boolean;
  version: string | null;
  /**
   * Lot 99C : la branche porte le contrat `t3-naming-period-v1` (représentation
   * temporelle des titres). Absent ou faux : aucun appel de représentation,
   * repli prudent du nommage.
   */
  periodContract?: boolean;
}

/** Lot 99C : le texte d'un prompt T3 porte-t-il le contrat de représentation temporelle ? (pure, recherche du marqueur) */
export function promptCarriesNamingPeriod(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(T3_NAMING_PERIOD_CONTRACT);
}

/**
 * La version EFFECTIVE du prompt maître T3 porte-t-elle la branche
 * DOCUMENT_NAMING ? Même résolution que la passerelle (version BO active,
 * texte de la version de configuration, sinon fichier du dépôt). Ne lève pas.
 */
export async function documentNamingPromptStatus(): Promise<NamingPromptStatus> {
  try {
    const [{ resolveOperationConfig }, loader, { getOperation }] = await Promise.all([
      import('@/services/ai/config/config-resolver'),
      import('@/services/ai/prompts/prompt-loader'),
      import('@/services/ai/registry/operations'),
    ]);
    const op = getOperation(DOCUMENT_NAMING_OPERATION);
    const cfg = await resolveOperationConfig(DOCUMENT_NAMING_OPERATION);
    const configured = cfg.promptArchitecture === 'master' && cfg.masterPromptText?.trim() ? cfg.masterPromptText : null;
    const text = configured ?? await loader.loadMasterTemplate(op.masterPromptCode!, op.useCaseCode);
    const version = loader.masterPromptVersionOf({
      masterPromptCode: op.masterPromptCode!, configuredText: configured, configVersionId: cfg.configVersionId,
      promptVersionId: configured ? cfg.masterPromptVersionId ?? null : null,
    });
    const available = loader.inspectMasterTemplate(text).branches.includes(DOCUMENT_NAMING_TASK);
    return { available, version, periodContract: available && promptCarriesNamingPeriod(text) };
  } catch (e) {
    console.error('[t3-naming] version du prompt T3 illisible :', (e as Error).message);
    return { available: false, version: null, periodContract: false };
  }
}

export interface NamingCall { accountId: number; sourceIds: number[]; variables: Record<string, unknown> }
export interface NamingCallResult { output: T3DocumentNamingOutput; traceId: string | null }

/** Appel réel par la passerelle. */
export async function callDocumentNamingModel(p: NamingCall): Promise<NamingCallResult> {
  const [{ AiGateway }, { T3DocumentNamingOutput: schema }] = await Promise.all([
    import('../../gateway/ai-gateway'),
    import('../master/t3-contract'),
  ]);
  const res = await AiGateway.execute({
    useCaseCode: 'DATA_RECONCILIATION',
    operationCode: DOCUMENT_NAMING_OPERATION,
    accountId: p.accountId,
    sourceIds: p.sourceIds,
    promptVariables: p.variables,
    outputSchema: schema,
  });
  return { output: res.data as T3DocumentNamingOutput, traceId: res.traceId ?? null };
}

/**
 * Lot 99C — déclaration du contrat de prompt `t3-naming-period-v1` (point de
 * raccord d'un registre des contrats de prompt / de conformité : marqueur,
 * prompt, branche, bloc du guide PO, coupure d'urgence, détection).
 */
export const T3_NAMING_PERIOD_PROMPT_CONTRACT = {
  id: T3_NAMING_PERIOD_CONTRACT,
  treatment: 'T3',
  masterPromptCode: 't3_master_v1',
  operationCode: DOCUMENT_NAMING_OPERATION,
  task: DOCUMENT_NAMING_TASK,
  marker: T3_NAMING_PERIOD_CONTRACT,
  guide: { file: 'docs/exploitation/prompts-a-appliquer-par-le-po.md', blockId: 't3-naming-period-v1', step: 9 },
  emergencyEnv: 'T3_NAMING_PERIOD_ENABLED',
  carried: promptCarriesNamingPeriod,
  /** Effet tant que le marqueur manque : aucun appel, repli prudent du nommage (mois écrit, sinon période exacte, sinon rien). */
  fallback: 'STATED_MONTH_OR_EXACT_PERIOD',
} as const;
