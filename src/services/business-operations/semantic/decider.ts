/**
 * Lot 87B (CODE-03) — DÉCIDEUR T4 de la représentation Agenda multi-
 * événements : port unique entre l'orchestration et l'IA.
 *
 * Le contrat T4 ACTUEL ne permet pas de décider sur plusieurs éléments à la
 * fois (CLASSIFY_EVENT, VERIFY_COMPLETION, TEMPORAL_AMBIGUITY portent sur UN
 * événement). La branche `AGENDA_REPRESENTATION` et son contrat sont demandés
 * à l'équipe IA (`87B-t4-representation-agenda-multi-evenements`) : tant
 * qu'ils ne sont pas livrés, la capacité de production est INDISPONIBLE
 * (`CONTRACT_PENDING`) — aucun appel, aucune décision du code à sa place
 * (constat qualifié du contrôle de cohérence). Coupure d'urgence :
 * `T4_AGENDA_REPRESENTATION_ENABLED=0`.
 *
 * Branchement à la livraison (équipe code) : opération du registre
 * `t4_agenda_representation` (prompt maître T4, branche AGENDA_REPRESENTATION),
 * contrats d'entrée / sortie T4 (`t4-execution-contract.ts`, schéma
 * `T4AgendaRepresentationOutput` de `contract.ts`), puis `capability()` lit
 * la version EFFECTIVE du prompt T4 (tâches autorisées) — même modèle que la
 * capacité KNOWLEDGE_QUERY du lot 85F. Le reste de la chaîne (contexte,
 * validation, application, journal, contrôle) est déjà en place.
 *
 * Tests : `__setRepresentationDeciderForTests` installe un fournisseur
 * SIMULÉ (unitaires et e2e PG16).
 */
import type { RepresentationInput } from './contract';

export interface RepresentationCapability {
  available: boolean;
  /** Version du décideur (version de prompt) : entre dans la mémoire anti-rappel. */
  version: string | null;
  reason: 'AVAILABLE' | 'CONTRACT_PENDING' | 'DISABLED';
}

export interface RepresentationCall { accountId: number; operationId: number; sourceIds: number[]; input: RepresentationInput }
export interface RepresentationAnswer { output: unknown; traceId: string | null }

export interface RepresentationDecider {
  capability(): Promise<RepresentationCapability>;
  decide(call: RepresentationCall): Promise<RepresentationAnswer>;
}

export const representationEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T4_AGENDA_REPRESENTATION_ENABLED ?? '1').trim() !== '0';

/** Décideur de production : contrat IA non livré → indisponible (jamais d'erreur). */
export const productionRepresentationDecider: RepresentationDecider = {
  async capability() {
    if (!representationEnabled()) return { available: false, version: null, reason: 'DISABLED' };
    return { available: false, version: null, reason: 'CONTRACT_PENDING' };
  },
  async decide() {
    throw new Error('CONTRACT_PENDING : contrat T4 multi-événements non livré (87B-t4-representation-agenda-multi-evenements)');
  },
};

let override: RepresentationDecider | null = null;

/** Réservé aux tests : fournisseur simulé (null : production). */
export function __setRepresentationDeciderForTests(d: RepresentationDecider | null): void { override = d; }

export function representationDecider(): RepresentationDecider {
  return override ?? productionRepresentationDecider;
}
