/**
 * Contrôle de cohérence global — lot 82B (arbitrages PO du 23/10/2026).
 *
 * Une seule chaîne : registre déclaratif et versionné (`registry/`),
 * orchestrateur unique (`orchestrator.ts`, tâche planifiée `coherence-control`),
 * moteur de contrôle d'objets avec preuve par objet et réparation déléguée
 * aux services métier (`engine.ts`), déclencheurs ciblés (`events.ts`),
 * signalement dans la Supervision existante (`supervision.ts`).
 *
 * Lot 82B (C-Q9) : l'ancienne maintenance horaire est RETIRÉE avec ses
 * dépendances mortes — `coherence-maintenance.service` (marquage « vérifié »
 * sans contrôle, détachement silencieux de documents, statut utilisateur
 * « annulé » posé sur l'agenda), `nightly-catchup.service` (jamais planifié),
 * `version-tracker` (`markVerified` mal parenthésé), la file `impact_queue`
 * (`impact-propagation`, `impact-queue`, `field-dependency`,
 * `inconsistency.service`) qui n'avait plus aucune règle à appliquer.
 */
export { COHERENCE_REGISTRY, activeChecks, getCheck, registryVersion } from './registry';
export { COVERAGE_INVENTORY, C_Q1_DOMAINS } from './registry/coverage';
export type { CoherenceCheck, CoherenceMode, ControlResult, Inspection, Verdict } from './registry/types';
export {
  coherenceMode, startCampaign, ensureDailyCampaign, runCampaignStep, runTargetedChecks, requestTargetedChecks,
  requestCoherenceCatchup, coherenceCatchupReactivationStep, runCoherenceControl, getCampaign,
} from './orchestrator';
export { coherenceAccountEligibility, getAccountProcessingEligibility } from './eligibility';
export { registerCoherenceTriggers } from './events';
