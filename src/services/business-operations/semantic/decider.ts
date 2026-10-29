/**
 * Lot 87B (CODE-03) — DÉCIDEUR T4 de la représentation Agenda multi-
 * événements : port unique entre l'orchestration et l'IA.
 *
 * Lot 97A (demande `87B-t4-representation-agenda-multi-evenements`) : le
 * décideur de production est BRANCHÉ sur l'opération du registre
 * `t4_agenda_representation` (prompt maître T4, TASK AGENDA_REPRESENTATION,
 * contrats d'exécution `t4_input_v3` / `t4_output_v4`, schéma
 * `T4AgendaRepresentationOutput` validé par la passerelle, traces et coûts
 * de la passerelle). ACTIVATION PRUDENTE — la capacité n'est disponible que
 * si la version T4 EFFECTIVE :
 *   · porte le marqueur `t4-agenda-representation-v1` (texte collé par le PO) ;
 *   · est en contexte structuré, autorise la TASK et la décrit par ses
 *     contrats d'entrée et de sortie.
 * Sinon : `CONTRACT_PENDING` (comportement d'avant : aucun appel, aucune
 * décision du code à sa place, constat qualifié du contrôle de cohérence).
 * Coupure d'urgence : `T4_AGENDA_REPRESENTATION_ENABLED=0`.
 *
 * Tests : `__setRepresentationDeciderForTests` installe un fournisseur
 * SIMULÉ (unitaires et e2e PG16).
 */
import { REPRESENTATION_CONTRACT_VERSION, REPRESENTATION_TASK, type RepresentationInput } from './contract';
import { structuredTaskSupport, type MasterExecutionConfig } from '@/services/ai/master-prompts/structured-context';
import { T4_EXECUTION_SPEC } from '@/services/ai/agenda/master/t4-execution-contract';

interface RepresentationCapability {
  available: boolean;
  /** Version du décideur (version de prompt) : entre dans la mémoire anti-rappel. */
  version: string | null;
  reason: 'AVAILABLE' | 'CONTRACT_PENDING' | 'DISABLED';
  /**
   * Lot 97A — détail d'une capacité en attente (diagnostic, guide du PO) :
   * marqueur absent, version T4 sans contexte structuré, TASK non cochée,
   * contrats d'exécution qui ne la décrivent pas, texte illisible.
   */
  contractState?: 'MARKER_MISSING' | 'LEGACY_TEMPLATE' | 'TASK_NOT_ALLOWED' | 'CONTRACTS_MISSING' | 'UNREADABLE';
}

interface RepresentationCall { accountId: number; operationId: number; sourceIds: number[]; input: RepresentationInput }
interface RepresentationAnswer { output: unknown; traceId: string | null }

export interface RepresentationDecider {
  capability(): Promise<RepresentationCapability>;
  decide(call: RepresentationCall): Promise<RepresentationAnswer>;
}

export const representationEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T4_AGENDA_REPRESENTATION_ENABLED ?? '1').trim() !== '0';

/** Opération du registre IA qui porte la décision (lot 97A). */
export const REPRESENTATION_OPERATION = 't4_agenda_representation';

/** Le texte d'un prompt porte-t-il le contrat ? (pure, simple recherche du marqueur) */
export function promptCarriesRepresentation(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(REPRESENTATION_CONTRACT_VERSION);
}

/**
 * Capacité d'après le texte et la configuration d'exécution EFFECTIFS (pure) —
 * même règle pour la production, le diagnostic et les tests.
 */
export function representationCapabilityOf(p: { text: string; version: string; execution: MasterExecutionConfig }): RepresentationCapability {
  if (!promptCarriesRepresentation(p.text)) return { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'MARKER_MISSING' };
  const support = structuredTaskSupport(T4_EXECUTION_SPEC, p.execution, REPRESENTATION_TASK);
  if (!support.supported) {
    return { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: support.reason === 'SUPPORTED' ? undefined : support.reason };
  }
  return { available: true, version: p.version, reason: 'AVAILABLE' };
}

let cache: { at: number; value: RepresentationCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetRepresentationCapabilityCacheForTests(): void { cache = null; }

/** Décideur de production : prompt T4 effectif (marqueur + contrats), passerelle IA. Ne lève jamais sur `capability`. */
export const productionRepresentationDecider: RepresentationDecider = {
  async capability() {
    if (!representationEnabled()) return { available: false, version: null, reason: 'DISABLED' };
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    let value: RepresentationCapability;
    try {
      const { effectivePromptOf } = await import('@/services/ai/master-prompts/effective-prompt');
      value = representationCapabilityOf(await effectivePromptOf(REPRESENTATION_OPERATION));
    } catch (e) {
      console.error('[t4-representation] version du prompt T4 illisible :', (e as Error).message);
      value = { available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'UNREADABLE' };
    }
    cache = { at: Date.now(), value };
    return value;
  },
  async decide(call) {
    const [{ AiGateway }, { T4AgendaRepresentationOutput }] = await Promise.all([
      import('@/services/ai/gateway/ai-gateway'), import('./contract'),
    ]);
    const res = await AiGateway.execute({
      useCaseCode: 'AGENDA_INTELLIGENCE',
      operationCode: REPRESENTATION_OPERATION,
      accountId: call.accountId,
      sourceIds: call.sourceIds,
      promptVariables: { AGENDA_REPRESENTATION: call.input },
      outputSchema: T4AgendaRepresentationOutput,
    });
    return { output: res.data, traceId: res.traceId ?? null };
  },
};

let override: RepresentationDecider | null = null;

/** Réservé aux tests : fournisseur simulé (null : production). */
export function __setRepresentationDeciderForTests(d: RepresentationDecider | null): void { override = d; }

export function representationDecider(): RepresentationDecider {
  return override ?? productionRepresentationDecider;
}
