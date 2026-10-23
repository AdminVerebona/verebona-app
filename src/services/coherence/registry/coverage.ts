/**
 * Inventaire de couverture du registre — lot 82B (CDC §3.2 « une
 * fonctionnalité ne doit pas être considérée comme couverte par défaut »,
 * CA-01, CA-19 ; arbitrage C-Q1 : domaines vérifiés au moins quotidiennement).
 *
 * Chaque domaine est soit couvert par des contrôles ACTIFS du registre, soit
 * déclaré en LACUNE avec son motif et le mécanisme existant qui le traite
 * aujourd'hui (jamais réputé conforme). Le test L82B-U-COVERAGE vérifie que
 * les domaines exigés par C-Q1 figurent tous ici et que chaque contrôle cité
 * existe dans le registre.
 */
import { operationsGroupingChecks } from './checks/operations';

/** Lot 83B : contrôles des invariants O-1, dérivés de la liste entière de `grouping/invariants.ts`. */
const O1 = operationsGroupingChecks.map((c) => c.id);

export interface CoverageEntry {
  domain: string;
  label: string;
  /** Contrôles ACTIFS qui couvrent (au moins en partie) le domaine. */
  checks: string[];
  /** Lacune déclarée : ce qui n'est pas (encore) contrôlé, et pourquoi. */
  gap?: { what: string; existingMechanism: string; planned: string };
}

/** Domaines exigés par l'arbitrage C-Q1 (vérification quotidienne sans omission). */
export const C_Q1_DOMAINS = [
  'champs-structures', 'operations', 'rapprochements', 'tco', 'agenda', 'timeline', 'biens', 'equipements', 'documents-liens', 'a-traiter',
] as const;

export const COVERAGE_INVENTORY: readonly CoverageEntry[] = [
  {
    domain: 'champs-structures', label: 'Champs structurés (fiches bien / équipement, données documentaires)',
    checks: ['COH-TODO-DOCUMENT-FIELDS', 'COH-DOC-EXTRACT-CHAIN', 'COH-ASSET-EQUIPMENT-SEPARATION'],
    gap: { what: 'valeurs canoniques des fiches comparées aux preuves sur le stock', existingMechanism: 'T3 « Informations » 76J par version (t3_information_checks)', planned: 'contrôle du registre au lot suivant (réutilise 76J)' },
  },
  {
    domain: 'operations', label: 'Opérations (identité économique, montants, regroupements)',
    checks: [...O1, 'COH-OPS-IDENTITY', 'COH-OPS-RECURRING-SERIES'],
    // Lot 84E : les factures d'un même service non regroupées sont contrôlées et réparées (reconsolidation ciblée O-6).
    gap: { what: 'montants et dates des Opérations comparés aux preuves sur le stock ; regroupements manqués HORS séries récurrentes établies ; identité 78A en détection seule (correction par le réexamen T3)', existingMechanism: 'operations-quality-check (12 anomalies dures, lecture seule) ; consolidation T3 (78A par version, 55B)', planned: 'lots suivants (O-2 et suivants du CDC v5)' },
  },
  {
    domain: 'rapprochements', label: 'Rapprochements (pièces ↔ Opérations, documents ↔ biens)',
    checks: ['COH-DOC-LINKS', 'COH-OPS-IDENTITY', 'COH-OPS-RECURRING-SERIES', ...O1.filter((id) => /DOCUMENT/.test(id))],
    gap: { what: 'rattachement document → bien principal ; relation document ↔ équipement que le document ne désigne pas lui-même (constat seul, contrat IA 82D-t3-document-equipement — lot 84E : réparée par O-6 quand le document la désigne)', existingMechanism: 'T3 DOCUMENT_ASSET (balayage continu des documents sans bien) ; consolidation M1–M3 ; reconsolidation ciblée O-6', planned: 'contrat IA 82D-t3-document-equipement' },
  },
  { domain: 'tco', label: 'TCO et dépenses', checks: ['COH-TCO-EXTRACTED-EXPENSES'] },
  { domain: 'agenda', label: 'Agenda (occurrences, échéances calculables des Opérations, événements obsolètes, échéances de fiche, appartenance aux Opérations)',
    checks: ['COH-AGENDA-OCCURRENCES', 'COH-AGENDA-ORPHANS', 'COH-AGENDA-OPERATION-PROJECTION', 'COH-AGENDA-PROJECTION-ORPHANS', ...O1.filter((id) => /AGENDA|PRINCIPAL|LINK-PROVENANCE/.test(id))],
    // Lot 83E : les échéances calculables issues des Opérations sont contrôlées (projection rejouée sans IA) ; 83B : invariants O-1.
    gap: {
      what: 'échéances DOCUMENTAIRES décidées par T4 (IA) : décisions non conservées avec leur candidat, rejeu impossible sans IA ; groupes T4 « même document, même date » sans Opération',
      existingMechanism: 'T4 à l’analyse (file durable, reprise du même travail) ; signalement 76H',
      planned: 'COH-AGENDA-T4-DOCUMENT-DEADLINES (point d’extension déclaré) — persistance durable des décisions T4 à décider',
    } },
  {
    // Lot 84C (O-4) : la Timeline (regroupée / détaillée) est un CALCUL DE LECTURE sans état propre ;
    // ses seules entrées de regroupement — principal unique, 0..1 Opération par élément — sont les invariants O-1.
    domain: 'timeline', label: 'Timeline',
    checks: O1.filter((id) => /PRINCIPAL-UNIQUE|AGENDA-ONE-OPERATION/.test(id)),
    gap: {
      what: 'aucune donnée propre à contrôler : groupes et compteurs recalculés à chaque lecture depuis l’agenda et les Opérations',
      existingMechanism: 'calcul à la lecture `services/agenda/timeline` (même fonction pour la fiche du bien et l’export de recette `calculs/timeline`)',
      planned: 'aucun contrôle propre (rien de persisté) ; les contrôles Agenda et O-1 couvrent ses entrées',
    },
  },
  {
    domain: 'biens', label: 'Biens',
    checks: ['COH-TCO-EXTRACTED-EXPENSES', 'COH-ASSET-EQUIPMENT-SEPARATION'],
    gap: { what: 'date et prix d’acquisition comparés à l’agenda et aux Opérations sur le stock', existingMechanism: 'T3 « Informations » 76J (par version)', planned: 'lot suivant' },
  },
  { domain: 'equipements', label: 'Équipements (documents rattachés, séparation bien / équipement)', checks: ['COH-DOC-LINKS', 'COH-ASSET-EQUIPMENT-SEPARATION'],
    gap: { what: 'situations de séparation SUSPECTES (constat seul) ; document d’équipement rattaché au seul bien sans preuve propre au document (constat seul — réparé par la reconsolidation ciblée O-6 dès que le document désigne l’équipement, lot 84E) ; liens d’un équipement déplacé vers un autre bien', existingMechanism: 'rattrapage BO « equipment-separation » (même code) ; file EQUIPMENT_DOCUMENT au déplacement et reconsolidation ciblée O-6', planned: 'contrat IA 82D-t3-document-equipement' } },
  { domain: 'documents-liens', label: 'Liens documentaires', checks: ['COH-DOC-LINKS', 'COH-DOC-EXTRACT-CHAIN', ...O1.filter((id) => /LINK|DOCUMENT/.test(id))] },
  { domain: 'a-traiter', label: 'Cartes « À traiter »',
    checks: ['COH-TODO-DOCUMENT-FIELDS', 'COH-TODO-STALE-DECISIONS', 'COH-TODO-RELEVANCE-CARDS', 'COH-TODO-ORPHAN-CARDS', 'COH-TODO-RESOLUTION-PROPAGATION'],
    // Lot 83E : la campagne de pertinence l76 est devenue COH-TODO-STALE-DECISIONS + COH-TODO-RELEVANCE-CARDS (moteur retiré).
    gap: {
      what: 'pertinence des familles Opérations, champs d’entité, revues de migration, propositions d’agenda, arbitrages T3 ; propagation des résolutions autres que le rattachement document → équipement',
      existingMechanism: 'producteurs du balayage horaire to-process-scan (décision par famille) ; rattrapage 81A des faux arbitrages ; résolutions transactionnelles (valeur et carte dans une transaction)',
      planned: 'lot suivant (une famille = son producteur en réparation, comme COH-TODO-RELEVANCE-CARDS)',
    } },
  {
    domain: 'documents-t1', label: 'Chaîne document → extract → T1 → aval (C-Q7)',
    checks: ['COH-DOC-EXTRACT-CHAIN'],
    gap: { what: 'valeur de l’extract absente de T1 sur une unité COUVERTE : constat seul (volontaire ou accidentelle : disposition T1 non livrée) ; documents analysés sans couche A', existingMechanism: 'constat tracé et Supervision ; t1-source-units-backfill (couche A historique)', planned: 'contrat IA 82B-t1-omissions-extract (unitDispositions, FOCUS_VALUES)' },
  },
  {
    domain: 't6', label: 'T6 / mascotte', checks: ['COH-T6-EVALUATIONS'],
    gap: {
      what: 'texte affiché par la mascotte comparé aux échéances (rendu) ; persistance des résultats de pré-génération',
      existingMechanism: 'mascot-pregeneration, mascot-t6-reevaluations, mascot-t6-supervision (81B)', planned: 'lot suivant',
    },
  },
  {
    domain: 'comptes', label: 'Comptes, Duo, habilitations', checks: ['COH-DUO-RELATIONS'],
    gap: {
      what: 'isolation des données entre comptes (relations intercomptes)', existingMechanism: 'cross-account-relations-check (quotidien, lecture seule, jamais de correction — lot 49)',
      planned: 'enregistrement au registre en détection seule (lot suivant)',
    },
  },
  {
    domain: 'abonnements', label: 'Offres, abonnements Stripe, droits et quotas', checks: ['COH-BILLING-STRIPE', 'COH-ENTITLEMENTS'],
    gap: {
      what: 'comptes sans abonnement Stripe (essai) : statut d’essai persisté par expire-trials ; Stripe non configuré : contrôle non applicable',
      existingMechanism: 'droits calculés à la date (entitlementsFromSubscription) ; tâche expire-trials', planned: '—',
    },
  },
  {
    domain: 'notifications', label: 'Notifications et communications', checks: ['COH-NOTIF-OUTBOX', 'COH-SUBSCRIPTION-COMMUNICATIONS'],
    gap: {
      what: 'événement métier sans communication hors transitions d’abonnement ; préférences et canaux autorisés',
      existingMechanism: 'santé des notifications (81E), anomalies de canal (Supervision)', planned: 'lot suivant',
    },
  },
];
