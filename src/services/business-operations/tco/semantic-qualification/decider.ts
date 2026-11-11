/**
 * Lot 113AL (Trello #737) — DÉCIDEUR T3 de l'arbitrage sémantique des
 * montants non qualifiés (contrat `t3-economic-qualification-v1`) : port
 * unique entre la phase du passage T3 et l'IA, sur le patron du décideur de
 * relation entre périodes (lot 113AD).
 *
 * Production : opération du registre `t3_economic_qualification` (prompt
 * maître T3, branche ECONOMIC_QUALIFICATION, six emplacements existants,
 * schéma `T3EconomicQualificationOutput` validé par la passerelle — traces,
 * coût journalisé (`ai_usage_event`, classification 113AF), éligibilité du
 * compte et plafond de coût de la passerelle). ACTIVATION PRUDENTE : la
 * capacité n'existe que si la version T3 EFFECTIVE porte la section
 * « BRANCHE TASK = ECONOMIC_QUALIFICATION » ET le marqueur
 * `t3-economic-qualification-v1` (bloc 31 du guide). Sinon :
 * `CONTRACT_PENDING`, aucun appel.
 * Coupure d'urgence : `T3_ECONOMIC_QUALIFICATION_ENABLED=0`.
 */
import {
  ECONOMIC_QUALIFICATION_OPERATION, ECONOMIC_QUALIFICATION_TASK, promptCarriesEconomicQualification, qualificationVariables, type QualificationInput,
} from './contract';

export interface QualificationCapability {
  available: boolean;
  version: string | null;
  reason: 'AVAILABLE' | 'CONTRACT_PENDING' | 'DISABLED';
  contractState?: 'BRANCH_MISSING' | 'MARKER_MISSING' | 'UNREADABLE';
}

interface QualificationCall { accountId: number; fileIds: number[]; input: QualificationInput }

/** Réponse du décideur : sortie brute + traçabilité de l'appel (versions, coût). */
export interface QualificationAnswer {
  output: unknown;
  traceId: string | null;
  model?: string | null;
  promptVersion?: string | null;
  costMicros?: number | null;
}

export interface QualificationDecider {
  capability(): Promise<QualificationCapability>;
  decide(call: QualificationCall): Promise<QualificationAnswer>;
}

export const economicQualificationEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T3_ECONOMIC_QUALIFICATION_ENABLED ?? '1').trim() !== '0';

/** Capacité d'après le texte effectif et ses branches (pure). */
export function qualificationCapabilityOf(p: { text: string; version: string; branches: readonly string[] }): QualificationCapability {
  if (promptCarriesEconomicQualification(p.text, p.branches)) return { available: true, version: p.version, reason: 'AVAILABLE' };
  return {
    available: false, version: null, reason: 'CONTRACT_PENDING',
    contractState: p.branches.includes(ECONOMIC_QUALIFICATION_TASK) ? 'MARKER_MISSING' : 'BRANCH_MISSING',
  };
}

let cache: { at: number; value: QualificationCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetQualificationCapabilityCacheForTests(): void { cache = null; }

export const productionQualificationDecider: QualificationDecider = {
  async capability() {
    if (!economicQualificationEnabled()) return { available: false, version: null, reason: 'DISABLED' };
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    let value: QualificationCapability;
    try {
      const [{ effectivePromptOf }, { inspectMasterTemplate }] = await Promise.all([
        import('@/services/ai/master-prompts/effective-prompt'), import('@/services/ai/prompts/prompt-loader'),
      ]);
      const p = await effectivePromptOf(ECONOMIC_QUALIFICATION_OPERATION);
      value = qualificationCapabilityOf({ text: p.text, version: p.version, branches: inspectMasterTemplate(p.text).branches });
    } catch (e) {
      console.error('[t3-economic-qualification] version du prompt T3 illisible :', (e as Error).message);
      value = { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'UNREADABLE' };
    }
    cache = { at: Date.now(), value };
    return value;
  },
  async decide(call) {
    const [{ AiGateway }, { T3EconomicQualificationOutput }] = await Promise.all([
      import('@/services/ai/gateway/ai-gateway'), import('./contract'),
    ]);
    const res = await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION',
      operationCode: ECONOMIC_QUALIFICATION_OPERATION,
      accountId: call.accountId,
      sourceIds: call.fileIds,
      promptVariables: qualificationVariables(call.input),
      outputSchema: T3EconomicQualificationOutput,
    });
    return { output: res.data, traceId: res.traceId ?? null, model: res.model ?? null, promptVersion: res.promptVersion ?? null, costMicros: Number.isFinite(res.costMicros) ? res.costMicros : null };
  },
};

let override: QualificationDecider | null = null;

/** Réservé aux tests : fournisseur simulé (null : production). Jamais d'appel Gemini en test. */
export function __setQualificationDeciderForTests(d: QualificationDecider | null): void { override = d; }

export function qualificationDecider(): QualificationDecider {
  return override ?? productionQualificationDecider;
}
