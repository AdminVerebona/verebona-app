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
import { equipmentIdentityCheck } from './checks/equipment-identity';
// Lot 103E — fournisseurs / intervenants des éléments d'Agenda (preuves propres à l'élément, retraits manuels respectés).
import { agendaSuppliersCheck } from './checks/agenda-suppliers';
import { agendaStructuralHousingCheck } from './checks/agenda-structural-housing';
// Lot 105D : rattachement principal récupérable des documents (fin de registre).
import { documentPrimaryLinkCheck } from './checks/document-primary-link';
// Lot 113W (#724) : périodes métier des documents (fin de registre, reprise de l'historique).
import { documentBusinessPeriodsCheck } from './checks/document-business-periods';
import { operationsPeriodResolutionCheck } from './checks/operations-period-resolution';
import { factProvenanceCheck } from './checks/fact-provenance';
import { documentDescriptionT1Check } from './checks/document-description-t1';
// Lot 106A : représentations équivalentes d'un même fait réalisé, toutes origines (fin de registre).
import { agendaEquivalentRepresentationsCheck } from './checks/agenda-equivalent-representations';
import { priceMultiArticleCheck } from './checks/price-multi-article';
// Lot 108A : un même achat représenté par plusieurs sources compté une seule fois (fin de registre).
import { tcoSameFactCheck } from './checks/tco-same-fact';
// Lot 108B : montants inconnus des justificatifs de dépense récupérés avant toute alerte du TCO (fin de registre).
import { tcoAmountRecoveryCheck } from './checks/tco-amount-recovery';
// Lot 108D : date du document posée par repli sur le jour d'import (fin de registre).
import { documentDateFallbackCheck } from './checks/document-date-fallback';
// Lot 109A : relations métier autour de l'Opération pivot — fournisseurs prouvés, héritages après fusion (fin de registre).
import { operationRelationsCheck } from './checks/operation-relations';
// Lot 109D : remises lues comme des avoirs, achats fragmentés persistés par T3 (fin de registre).
import { tcoCommercialAdjustmentsCheck } from './checks/tco-commercial-adjustments';
// Lot 109K : couverture des PDF confrontée au texte original déterministe (fin de registre).
import { t1PdfCoverageCheck } from './checks/t1-pdf-coverage';
// Lot 111I : rattachements multiples d'un document reflétés par la source canonique (fin de registre).
import { documentTargetsCheck } from './checks/document-targets';
// Lot 111S : acquisition documentaire établie sans Opération active ni historique « Achat » (fin de registre).
import { operationsAcquisitionDocumentCheck } from './checks/operations-acquisition-document';
// Lot 111U : faits documentaires CIL (DPE…) projetés dans les structures spécialisées (fin de registre ; après 111S à la fusion).
import { cilDocumentProjectionCheck } from './checks/cil-document-projection';
import { supplierCoordinatesCheck } from './checks/supplier-coordinates';
// Lot 113G : identité des fiches fournisseur — doublons réels soumis une fois par paire (fin de registre).
import { supplierIdentityCheck } from './checks/supplier-identity';

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
  // Lot 101A (ajouté en fin de liste, sans réordonner l'existant) : identité produit des équipements.
  equipmentIdentityCheck,
  // Lot 103E (ajouté en fin de liste, sans réordonner l'existant) : fournisseurs des éléments d'Agenda.
  agendaSuppliersCheck,
  // Lot 103D (ajoutés en fin de liste, sans réordonner l'existant) : pièces / équipements sans logement rattaché.
  // Lot 113P (#715) : COH-AGENDA-HISTORICAL-STATUS (faits historiques « à confirmer » → « réalisé » prouvé) RETIRÉ —
  // les événements n'ont plus de statut.
  agendaStructuralHousingCheck,
  // Lot 105D (ticket « Rattachement rétroactif après création d'un bien », §G) : ajouté EN FIN de registre.
  documentPrimaryLinkCheck,
  // Lot 106A (ticket « Agenda — doublons DPE non autoréparés ») : ajouté EN FIN de registre.
  agendaEquivalentRepresentationsCheck,
  // Lot 107D (ticket « Draisienne : total multi-articles, arbitrage rouvert ») : ajouté EN FIN de registre.
  priceMultiArticleCheck,
  // Lot 108A (ticket « TCO — correctifs globaux » §A) : ajouté EN FIN de registre.
  tcoSameFactCheck,
  // Lot 108B (ticket TCO-646 §B « montant illisible » : récupération automatique avant alerte) : ajouté EN FIN de registre.
  tcoAmountRecoveryCheck,
  // Lot 108D (ticket « Listes de documents : une seule date documentaire ») : ajouté EN FIN de registre.
  documentDateFallbackCheck,
  // Lot 109A (ticket « Relations métier — Opération pivot ») : ajouté EN FIN de registre.
  operationRelationsCheck,
  // Lot 109D (ticket « TCO — remises vs avoirs, 1 document → 1..N achats ») : ajouté EN FIN de registre.
  tcoCommercialAdjustmentsCheck,
  // Lot 109K (ticket « T1 couverture PDF », COR-01) : ajouté EN FIN de registre.
  t1PdfCoverageCheck,
  // Lot 111I (ticket « rattachement multiple d'un document ») : ajouté EN FIN de registre.
  documentTargetsCheck,
  // Lot 111S (ticket « acquisition prouvée par facture → Opération, Informations, historique Achat ») : ajouté EN FIN de registre.
  operationsAcquisitionDocumentCheck,
  // Lot 111U (ticket « CIL : chaîne DPE et données structurées ») : ajouté EN FIN de registre (après COH-OPS-ACQUISITION-DOCUMENT de 111S à la fusion).
  cilDocumentProjectionCheck,
  // Lot 111X (ticket « Fournisseurs — coordonnées documentaires ») : ajouté EN FIN de registre, après COH-CIL-DOCUMENT-PROJECTION (111U).
  supplierCoordinatesCheck,
  // Lot 113G (ticket #706 « Fournisseurs — création automatique, arbitrage des doublons uniquement ») : ajouté EN FIN de registre, après COH-SUPPLIER-COORDINATES (111X).
  supplierIdentityCheck,
  // Lot 113W (ticket #724 « Gestion transversale des périodes métier ») : ajouté EN FIN de registre, après COH-SUPPLIER-IDENTITY (113G).
  documentBusinessPeriodsCheck,
  // Lot 113Z (ticket #723 « Documents — Unifier « Notes / Description » ») : ajouté EN FIN de registre, après COH-DOC-BUSINESS-PERIODS (113W).
  documentDescriptionT1Check,
  // Lot 113AA (ticket #725 « Périodes métier — conformité au CDC #724 », D11) : ajouté EN FIN de registre, après COH-DOC-DESCRIPTION-T1 (113Z).
  operationsPeriodResolutionCheck,
  // Lot 113AK (ticket #736 « T1 / Preuves — liens vers unités sources, preuves orphelines ») : ajouté EN FIN de registre, après COH-OPS-PERIOD-RESOLUTION (113AA).
  factProvenanceCheck,
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

