/**
 * Lot 114 (Trello #750, issue B) — DÉCIDEUR T3 de l'arbitrage d'une
 * contradiction d'attribut (contrat `t3-attribute-arbitration-v1`) : port
 * unique entre le passage T3 et l'IA, sur le modèle du décideur de relation
 * entre périodes (lot 113AD).
 *
 * Production : opération du registre `t3_attribute_arbitration` (prompt maître
 * T3, branche ATTRIBUTE_ARBITRATION, six emplacements existants, schéma
 * `T3AttributeArbitrationOutput` validé par la passerelle — traces, coûts,
 * éligibilité du compte et plafond de coût de la passerelle). ACTIVATION
 * PRUDENTE : la capacité n'existe que si la version T3 EFFECTIVE porte la
 * section « BRANCHE TASK = ATTRIBUTE_ARBITRATION » ET le marqueur
 * `t3-attribute-arbitration-v1` (bloc 38 du guide). Sinon : `CONTRACT_PENDING`,
 * aucune demande, aucun appel (la contradiction réelle va à la carte « À traiter »).
 * Coupure d'urgence : `T3_ATTRIBUTE_ARBITRATION_ENABLED=0`.
 */
import {
  ATTRIBUTE_ARBITRATION_OPERATION, ATTRIBUTE_ARBITRATION_TASK, arbitrationVariables, promptCarriesAttributeArbitration, type ArbitrationInput,
} from './contract';

export interface ArbitrationCapability {
  available: boolean;
  version: string | null;
  reason: 'AVAILABLE' | 'CONTRACT_PENDING' | 'DISABLED';
  contractState?: 'BRANCH_MISSING' | 'MARKER_MISSING' | 'UNREADABLE';
}

interface ArbitrationCall { accountId: number; fileIds: number[]; input: ArbitrationInput }

export interface ArbitrationDecider {
  capability(): Promise<ArbitrationCapability>;
  decide(call: ArbitrationCall): Promise<{ output: unknown; traceId: string | null }>;
}

export const attributeArbitrationEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T3_ATTRIBUTE_ARBITRATION_ENABLED ?? '1').trim() !== '0';

/** Capacité d'après le texte effectif et ses branches (pure). */
export function arbitrationCapabilityOf(p: { text: string; version: string; branches: readonly string[] }): ArbitrationCapability {
  if (promptCarriesAttributeArbitration(p.text, p.branches)) return { available: true, version: p.version, reason: 'AVAILABLE' };
  return { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: p.branches.includes(ATTRIBUTE_ARBITRATION_TASK) ? 'MARKER_MISSING' : 'BRANCH_MISSING' };
}

let cache: { at: number; value: ArbitrationCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetArbitrationCapabilityCacheForTests(): void { cache = null; }

export const productionArbitrationDecider: ArbitrationDecider = {
  async capability() {
    if (!attributeArbitrationEnabled()) return { available: false, version: null, reason: 'DISABLED' };
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    let value: ArbitrationCapability;
    try {
      const [{ effectivePromptOf }, { inspectMasterTemplate }] = await Promise.all([
        import('@/services/ai/master-prompts/effective-prompt'), import('@/services/ai/prompts/prompt-loader'),
      ]);
      const p = await effectivePromptOf(ATTRIBUTE_ARBITRATION_OPERATION);
      value = arbitrationCapabilityOf({ text: p.text, version: p.version, branches: inspectMasterTemplate(p.text).branches });
    } catch (e) {
      console.error('[t3-attribute-arbitration] version du prompt T3 illisible :', (e as Error).message);
      value = { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'UNREADABLE' };
    }
    cache = { at: Date.now(), value };
    return value;
  },
  async decide(call) {
    const [{ AiGateway }, { T3AttributeArbitrationOutput }] = await Promise.all([
      import('@/services/ai/gateway/ai-gateway'), import('./contract'),
    ]);
    const res = await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION',
      operationCode: ATTRIBUTE_ARBITRATION_OPERATION,
      accountId: call.accountId,
      sourceIds: call.fileIds,
      promptVariables: arbitrationVariables(call.input),
      outputSchema: T3AttributeArbitrationOutput,
    });
    return { output: res.data, traceId: res.traceId ?? null };
  },
};

let override: ArbitrationDecider | null = null;

/** Réservé aux tests : fournisseur simulé (null : production). Jamais d'appel Gemini en test. */
export function __setArbitrationDeciderForTests(d: ArbitrationDecider | null): void { override = d; }

export function arbitrationDecider(): ArbitrationDecider {
  return override ?? productionArbitrationDecider;
}
