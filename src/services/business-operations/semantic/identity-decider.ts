/**
 * Lot 97A — DÉCIDEUR T3 de l'identité d'une Opération à plusieurs sources
 * (contrat `t3-operation-identity-v1`, demande `87B-t3-identite-multi-operations`) :
 * port unique entre l'orchestration et l'IA, sur le modèle du décideur T4.
 *
 * Production : opération du registre `t3_operation_identity` (prompt maître
 * T3, branche OPERATION_IDENTITY, six emplacements existants, schéma
 * `T3OperationIdentityOutput` validé par la passerelle, traces et coûts de la
 * passerelle). ACTIVATION PRUDENTE : la capacité n'est disponible que si la
 * version T3 EFFECTIVE porte la section « BRANCHE TASK = OPERATION_IDENTITY »
 * ET le marqueur `t3-operation-identity-v1`. Sinon : `CONTRACT_PENDING`
 * (constat `MULTI_SOURCE_IDENTITY`, comportement d'avant).
 * Coupure d'urgence : `T3_OPERATION_IDENTITY_ENABLED=0`.
 */
import { IDENTITY_OPERATION, identityVariables, promptCarriesIdentity, type IdentityInput } from './identity-contract';

export interface IdentityCapability {
  available: boolean;
  version: string | null;
  reason: 'AVAILABLE' | 'CONTRACT_PENDING' | 'DISABLED';
  contractState?: 'BRANCH_MISSING' | 'MARKER_MISSING' | 'UNREADABLE';
}

interface IdentityCall { accountId: number; operationId: number; sourceIds: number[]; input: IdentityInput }

export interface IdentityDecider {
  capability(): Promise<IdentityCapability>;
  decide(call: IdentityCall): Promise<{ output: unknown; traceId: string | null }>;
}

export const identityEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T3_OPERATION_IDENTITY_ENABLED ?? '1').trim() !== '0';

/** Capacité d'après le texte effectif et ses branches (pure). */
export function identityCapabilityOf(p: { text: string; version: string; branches: readonly string[] }): IdentityCapability {
  if (promptCarriesIdentity(p.text, p.branches)) return { available: true, version: p.version, reason: 'AVAILABLE' };
  return { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: p.branches.includes('OPERATION_IDENTITY') ? 'MARKER_MISSING' : 'BRANCH_MISSING' };
}

let cache: { at: number; value: IdentityCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetIdentityCapabilityCacheForTests(): void { cache = null; }

export const productionIdentityDecider: IdentityDecider = {
  async capability() {
    if (!identityEnabled()) return { available: false, version: null, reason: 'DISABLED' };
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    let value: IdentityCapability;
    try {
      const [{ effectivePromptOf }, { inspectMasterTemplate }] = await Promise.all([
        import('@/services/ai/master-prompts/effective-prompt'), import('@/services/ai/prompts/prompt-loader'),
      ]);
      const p = await effectivePromptOf(IDENTITY_OPERATION);
      value = identityCapabilityOf({ text: p.text, version: p.version, branches: inspectMasterTemplate(p.text).branches });
    } catch (e) {
      console.error('[t3-identity] version du prompt T3 illisible :', (e as Error).message);
      value = { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'UNREADABLE' };
    }
    cache = { at: Date.now(), value };
    return value;
  },
  async decide(call) {
    const [{ AiGateway }, { T3OperationIdentityOutput }] = await Promise.all([
      import('@/services/ai/gateway/ai-gateway'), import('./identity-contract'),
    ]);
    const res = await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION',
      operationCode: IDENTITY_OPERATION,
      accountId: call.accountId,
      sourceIds: call.sourceIds,
      promptVariables: identityVariables(call.input),
      outputSchema: T3OperationIdentityOutput,
    });
    return { output: res.data, traceId: res.traceId ?? null };
  },
};

let override: IdentityDecider | null = null;

/** Réservé aux tests : fournisseur simulé (null : production). */
export function __setIdentityDeciderForTests(d: IdentityDecider | null): void { override = d; }

export function identityDecider(): IdentityDecider {
  return override ?? productionIdentityDecider;
}
