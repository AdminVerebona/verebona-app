/**
 * Lot 113AD (Trello #725, D11) — DÉCIDEUR T3 de la relation entre deux
 * périodes divergentes (contrat `t3-period-relation-v1`) : port unique entre
 * le passage T3 et l'IA, sur le modèle du décideur d'identité (lot 97A).
 *
 * Production : opération du registre `t3_period_relation` (prompt maître T3,
 * branche PERIOD_RELATION, six emplacements existants, schéma
 * `T3PeriodRelationOutput` validé par la passerelle — traces, coûts,
 * éligibilité du compte et plafond de coût de la passerelle). ACTIVATION
 * PRUDENTE : la capacité n'existe que si la version T3 EFFECTIVE porte la
 * section « BRANCHE TASK = PERIOD_RELATION » ET le marqueur
 * `t3-period-relation-v1` (bloc 29 du guide). Sinon : `CONTRACT_PENDING`,
 * aucune demande, aucun appel (comportement 113AA).
 * Coupure d'urgence : `T3_PERIOD_RELATION_ENABLED=0`.
 */
import { PERIOD_RELATION_OPERATION, PERIOD_RELATION_TASK, promptCarriesPeriodRelation, relationVariables, type RelationInput } from './relation-contract';

export interface RelationCapability {
  available: boolean;
  version: string | null;
  reason: 'AVAILABLE' | 'CONTRACT_PENDING' | 'DISABLED';
  contractState?: 'BRANCH_MISSING' | 'MARKER_MISSING' | 'UNREADABLE';
}

interface RelationCall { accountId: number; fileIds: number[]; input: RelationInput }

export interface RelationDecider {
  capability(): Promise<RelationCapability>;
  decide(call: RelationCall): Promise<{ output: unknown; traceId: string | null }>;
}

export const periodRelationEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T3_PERIOD_RELATION_ENABLED ?? '1').trim() !== '0';

/** Capacité d'après le texte effectif et ses branches (pure). */
export function relationCapabilityOf(p: { text: string; version: string; branches: readonly string[] }): RelationCapability {
  if (promptCarriesPeriodRelation(p.text, p.branches)) return { available: true, version: p.version, reason: 'AVAILABLE' };
  return { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: p.branches.includes(PERIOD_RELATION_TASK) ? 'MARKER_MISSING' : 'BRANCH_MISSING' };
}

let cache: { at: number; value: RelationCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetRelationCapabilityCacheForTests(): void { cache = null; }

export const productionRelationDecider: RelationDecider = {
  async capability() {
    if (!periodRelationEnabled()) return { available: false, version: null, reason: 'DISABLED' };
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    let value: RelationCapability;
    try {
      const [{ effectivePromptOf }, { inspectMasterTemplate }] = await Promise.all([
        import('@/services/ai/master-prompts/effective-prompt'), import('@/services/ai/prompts/prompt-loader'),
      ]);
      const p = await effectivePromptOf(PERIOD_RELATION_OPERATION);
      value = relationCapabilityOf({ text: p.text, version: p.version, branches: inspectMasterTemplate(p.text).branches });
    } catch (e) {
      console.error('[t3-period-relation] version du prompt T3 illisible :', (e as Error).message);
      value = { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'UNREADABLE' };
    }
    cache = { at: Date.now(), value };
    return value;
  },
  async decide(call) {
    const [{ AiGateway }, { T3PeriodRelationOutput }] = await Promise.all([
      import('@/services/ai/gateway/ai-gateway'), import('./relation-contract'),
    ]);
    const res = await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION',
      operationCode: PERIOD_RELATION_OPERATION,
      accountId: call.accountId,
      sourceIds: call.fileIds,
      promptVariables: relationVariables(call.input),
      outputSchema: T3PeriodRelationOutput,
    });
    return { output: res.data, traceId: res.traceId ?? null };
  },
};

let override: RelationDecider | null = null;

/** Réservé aux tests : fournisseur simulé (null : production). Jamais d'appel Gemini en test. */
export function __setRelationDeciderForTests(d: RelationDecider | null): void { override = d; }

export function relationDecider(): RelationDecider {
  return override ?? productionRelationDecider;
}
