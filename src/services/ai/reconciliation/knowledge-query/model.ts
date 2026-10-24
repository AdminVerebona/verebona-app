/**
 * Lot 85F — appel du modèle (branche KNOWLEDGE_QUERY du prompt maître T3) et
 * disponibilité de la capacité.
 *
 * Passe par la passerelle (traces « Exécutions IA », plafonds de coût, arrêt
 * d'urgence, validation discriminée du contrat, masquage) : opération
 * `t3_knowledge_query`. La capacité n'est DISPONIBLE que si la version
 * EFFECTIVE du prompt maître T3 (version BO active, texte de la version de
 * configuration, sinon fichier du dépôt) porte la section
 * « BRANCHE TASK = KNOWLEDGE_QUERY » — texte attendu de l'équipe IA
 * (`MASTER_TASKS_TEXT_PENDING`). Sans elle : aucun appel, jamais une erreur.
 */
import type { T3KnowledgeQueryOutput } from './contract';
import { KNOWLEDGE_QUERY_OPERATION, KNOWLEDGE_QUERY_TASK } from './contract';

export interface KnowledgeCapability {
  available: boolean;
  /** Version du prompt maître T3 effective (mémoire des réponses). */
  version: string | null;
  /** Motif d'indisponibilité (diagnostic). */
  reason: 'AVAILABLE' | 'DISABLED' | 'BRANCH_MISSING' | 'UNREADABLE';
}

/** Coupure d'urgence : `T3_KNOWLEDGE_QUERY_ENABLED=0`. Pure. */
export const knowledgeQueryEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T3_KNOWLEDGE_QUERY_ENABLED ?? '1').trim() !== '0';

let cache: { at: number; value: KnowledgeCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetKnowledgeCapabilityCacheForTests(): void { cache = null; }

/**
 * La capacité KNOWLEDGE_QUERY est-elle disponible ? Même résolution que la
 * passerelle ; lecture seule ; cache de 60 s. Ne lève pas.
 */
export async function knowledgeQueryCapability(): Promise<KnowledgeCapability> {
  if (!knowledgeQueryEnabled()) return { available: false, version: null, reason: 'DISABLED' };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: KnowledgeCapability;
  try {
    const [{ resolveOperationConfig }, loader, { getOperation }] = await Promise.all([
      import('@/services/ai/config/config-resolver'),
      import('@/services/ai/prompts/prompt-loader'),
      import('@/services/ai/registry/operations'),
    ]);
    const op = getOperation(KNOWLEDGE_QUERY_OPERATION);
    const cfg = await resolveOperationConfig(KNOWLEDGE_QUERY_OPERATION);
    const configured = cfg.promptArchitecture === 'master' && cfg.masterPromptText?.trim() ? cfg.masterPromptText : null;
    const text = configured ?? await loader.loadMasterTemplate(op.masterPromptCode!, op.useCaseCode);
    const version = loader.masterPromptVersionOf({
      masterPromptCode: op.masterPromptCode!, configuredText: configured, configVersionId: cfg.configVersionId,
      promptVersionId: configured ? cfg.masterPromptVersionId ?? null : null,
    });
    const available = op.active && loader.inspectMasterTemplate(text).branches.includes(KNOWLEDGE_QUERY_TASK);
    value = { available, version, reason: available ? 'AVAILABLE' : 'BRANCH_MISSING' };
  } catch (e) {
    console.error('[t3-knowledge] version du prompt T3 illisible :', (e as Error).message);
    value = { available: false, version: null, reason: 'UNREADABLE' };
  }
  cache = { at: Date.now(), value };
  return value;
}

export interface KnowledgeCall { accountId: number; sourceIds: number[]; variables: Record<string, unknown> }
export interface KnowledgeCallResult { output: T3KnowledgeQueryOutput; traceId: string | null }

/** Appel réel par la passerelle (sortie validée par le schéma discriminé du contrat). */
export async function callKnowledgeQueryModel(p: KnowledgeCall): Promise<KnowledgeCallResult> {
  const [{ AiGateway }, { T3KnowledgeQueryOutput: schema }] = await Promise.all([
    import('../../gateway/ai-gateway'),
    import('./contract'),
  ]);
  const res = await AiGateway.execute({
    useCaseCode: 'DATA_RECONCILIATION',
    operationCode: KNOWLEDGE_QUERY_OPERATION,
    accountId: p.accountId,
    sourceIds: p.sourceIds,
    promptVariables: p.variables,
    outputSchema: schema,
  });
  return { output: res.data as T3KnowledgeQueryOutput, traceId: res.traceId ?? null };
}
