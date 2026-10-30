/**
 * Registre central et versionné des contrôles de cohérence — lot 82B (CDC
 * §3.2, CA-01 ; arbitrages C-Q1, C-Q11).
 *
 * Ordre = ordre d'exécution par compte. Une évolution fonctionnelle (C-Q11)
 * ajoute ou modifie ici le contrôle concerné et incrémente sa `version` :
 * la version du registre change, la preuve de chaque objet porte la version
 * de règles appliquée, et la campagne quotidienne réexamine tout le stock.
 */
import { createHash } from 'node:crypto';
import type { CoherenceCheck } from './types';
import { toProcessDocumentFieldsCheck } from './checks/to-process';
import { documentLinksCheck } from './checks/document-links';
import { agendaOccurrencesCheck, agendaOrphansCheck } from './checks/agenda';
import { tcoExtractedExpensesCheck } from './checks/tco';
import { extractChainCheck } from './checks/extract-chain';
// Lot 83B (C3, C4) : séparation bien / équipement, invariants O-1 (liste entière de grouping/invariants.ts), identité 78A.
import { equipmentSeparationCheck } from './checks/equipment-separation';
import { operationsGroupingChecks, operationsIdentityCheck } from './checks/operations';
// Lot 83E — C5 (Agenda / T4 / « À traiter ») et C6 (T6, notifications, abonnements, Duo).
import {
  toProcessStaleDecisionsCheck, toProcessRelevanceCardsCheck, toProcessOrphanCardsCheck, toProcessResolutionPropagationCheck,
} from './checks/to-process-relevance';
import { agendaOperationProjectionCheck, agendaProjectionOrphansCheck, agendaT4DocumentDeadlinesCheck } from './checks/agenda-projection';
import { t6EvaluationsCheck, notificationOutboxCheck, subscriptionCommunicationsCheck } from './checks/t6-notifications';
import { billingStripeCheck, entitlementsCheck, duoRelationsCheck } from './checks/billing';
// Lot 84E — O-6 : factures d'un même service non regroupées (réparation : reconsolidation ciblée).
import { operationsRecurringSeriesCheck } from './checks/operations-recurrence';
// Lot 85B — familles « À traiter » restantes (producteur de la famille en réparation).
import { toProcessFamilyChecks } from './checks/to-process-families';
// Lot 85E — acquisition réalisée sans date alors que la date du bien est connue (réparation : T3 du bien puis T4).
import { operationsAcquisitionDateCheck } from './checks/operations-acquisition-date';
// Lot 85F — connaissance T1 persistée exploitée par T3 avant toute conclusion « information absente ».
import { t1KnowledgeConsumptionCheck } from './checks/t1-knowledge-consumption';
// Lot 86C — dates de contrat issues de périodes facturées (réparation : consolidation T3 puis projection Agenda).
import { operationsContractDatesCheck } from './checks/operations-contract-dates';
// Lot 86D — associations Document ↔ Agenda confrontées à leurs preuves (réparation : service de regroupement).
import { documentAgendaLinksCheck } from './checks/document-agenda-links';
// Lot 86E — classement documentaire : nomenclature courante (Équipements et mobilier), type identifié = type enregistré.
import { documentClassificationCheck } from './checks/document-classification';
// Lot 86F — dates économiques injustifiées des composantes (réparation : trace de la date retenue, recalcul à la lecture).
import { tcoEconomicDatesCheck } from './checks/tco-economic-dates';
// Lot 87C — questions suggérées T6 fondées sur des sources actuelles (réparation : invalidation du cache T6).
import { t6SuggestionsCheck } from './checks/t6-suggestions';
// Lot 87D — titres des documents : convention unique, données de nommage propagées, même libellé partout (réparation : service de nommage).
import { documentTitlesCheck } from './checks/document-titles';
// Lot 88B — propriétés métier manquantes reprises à partir de l'ensemble des preuves (réparation : arbitrage T3 puis writer canonique).
import { missingPropertiesCheck, missingPropertiesEquipmentCheck } from './checks/missing-properties';
import { agendaRecurrenceEndCheck } from './checks/agenda-recurrence-end';
// Lot 100E (décision PO A7) — cartes « À traiter » devenues inutiles, toutes familles (nettoyage rétroactif).
import { toProcessPublishabilityCheck } from './checks/to-process-publishability';

export const COHERENCE_REGISTRY: readonly CoherenceCheck[] = [
  toProcessDocumentFieldsCheck,
  documentLinksCheck,
  agendaOccurrencesCheck,
  agendaOrphansCheck,
  tcoExtractedExpensesCheck,
  extractChainCheck,
  // Lot 83B
  equipmentSeparationCheck,
  ...operationsGroupingChecks,
  operationsIdentityCheck,
  // Lot 83E (ajoutés en fin de liste, sans réordonner l'existant).
  toProcessStaleDecisionsCheck,
  toProcessRelevanceCardsCheck,
  toProcessOrphanCardsCheck,
  toProcessResolutionPropagationCheck,
  agendaOperationProjectionCheck,
  agendaProjectionOrphansCheck,
  agendaT4DocumentDeadlinesCheck,
  t6EvaluationsCheck,
  notificationOutboxCheck,
  subscriptionCommunicationsCheck,
  billingStripeCheck,
  entitlementsCheck,
  duoRelationsCheck,
  // Lot 84E (ajouté en fin de liste, sans réordonner l'existant).
  operationsRecurringSeriesCheck,
  // Lot 85B (ajoutés en fin de liste, sans réordonner l'existant).
  ...toProcessFamilyChecks,
  // Lot 85E (ajouté en fin de liste, sans réordonner l'existant).
  operationsAcquisitionDateCheck,
  // Lot 85F (ajouté en fin de liste, sans réordonner l'existant).
  t1KnowledgeConsumptionCheck,
  // Lot 86C (ajouté en fin de liste, sans réordonner l'existant).
  operationsContractDatesCheck,
  // Lot 86D (ajouté en fin de liste, sans réordonner l'existant).
  documentAgendaLinksCheck,
  // Lot 86E (ajouté en fin de liste, sans réordonner l'existant).
  documentClassificationCheck,
  // Lot 86F (ajouté en fin de liste, sans réordonner l'existant).
  tcoEconomicDatesCheck,
  // Lot 87C (ajouté en fin de liste, sans réordonner l'existant).
  t6SuggestionsCheck,
  // Lot 87D (ajouté en fin de liste, sans réordonner l'existant).
  documentTitlesCheck,
  // Lot 88B (ajoutés APRÈS COH-DOC-TITLES, sans réordonner l'existant) : biens d'abord, puis équipements.
  missingPropertiesCheck,
  missingPropertiesEquipmentCheck,
  // Lot 99D (ajouté en fin de liste, sans réordonner l'existant) : séries arrêtées par l'ancienne règle « mot-clé ».
  agendaRecurrenceEndCheck,
  // Lot 100E (ajouté en fin de liste, sans réordonner l'existant) : publiabilité A7 de toutes les familles.
  toProcessPublishabilityCheck,
];

/** Contrôles exécutés par l'orchestrateur (les points d'extension PLANNED sont exclus). */
export function activeChecks(registry: readonly CoherenceCheck[] = COHERENCE_REGISTRY): CoherenceCheck[] {
  return registry.filter((c) => c.status === 'ACTIVE' && !!c.listObjects && !!c.inspect);
}

export function getCheck(id: string, registry: readonly CoherenceCheck[] = COHERENCE_REGISTRY): CoherenceCheck | undefined {
  return registry.find((c) => c.id === id);
}

/** Version du registre : dérivée des couples (contrôle, version, statut). */
export function registryVersion(registry: readonly CoherenceCheck[] = COHERENCE_REGISTRY): string {
  const sig = registry.map((c) => `${c.id}@${c.version}:${c.status}`).sort().join('|');
  return `r1-${createHash('sha256').update(sig).digest('hex').slice(0, 12)}`;
}

