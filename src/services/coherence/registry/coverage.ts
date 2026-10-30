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

interface CoverageEntry {
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
    // Lot 85F : connaissance T1 NON structurée exploitée par T3 (COH-T1-KNOWLEDGE-CONSUMPTION).
    checks: ['COH-TODO-DOCUMENT-FIELDS', 'COH-DOC-EXTRACT-CHAIN', 'COH-ASSET-EQUIPMENT-SEPARATION', 'COH-T1-KNOWLEDGE-CONSUMPTION',
      // Lot 88B : propriétés canoniques VIDES des biens et équipements reprises à partir de toutes les preuves (arbitrage T3).
      'COH-MISSING-PROPERTIES', 'COH-MISSING-PROPERTIES-EQUIPMENT',
      // Lot 101A : identité produit des équipements (série, modèle, référence, n° de série ; produits connexes, conflits).
      'COH-EQUIPMENT-IDENTITY'],
    gap: {
      what: 'valeurs canoniques RENSEIGNÉES des fiches comparées aux preuves sur le stock ; propriétés vides : arbitrage T3 en attente du contrat d’entrée t3-knowledge-query-v2 (constat MISSING_PROPERTY_ARBITRATION_PENDING) ; propriétés des pièces',
      existingMechanism: 'T3 « Informations » 76J par version (t3_information_checks) ; COH-MISSING-PROPERTIES (lot 88B)',
      planned: 'demande IA 88B-t3-proprietes-manquantes ; valeurs renseignées : contrôle du registre au lot suivant (réutilise 76J)',
    },
  },
  {
    domain: 'operations', label: 'Opérations (identité économique, montants, regroupements)',
    checks: [...O1, 'COH-OPS-IDENTITY', 'COH-OPS-RECURRING-SERIES', 'COH-OPS-ACQUISITION-DATE', 'COH-OPS-CONTRACT-DATES'],
    // Lot 86C : doublons ENTRE Opérations d'une même relation contractuelle (COH-OPS-IDENTITY v2, réexamen T3)
    // et dates de contrat issues de périodes facturées (COH-OPS-CONTRACT-DATES) — contrôlés et réparés.
    // Lot 85E : acquisition réalisée sans date alors que la date du bien est connue — contrôlée et réparée (T3 du bien puis T4).
    // Lot 84E : les factures d'un même service non regroupées sont contrôlées et réparées (reconsolidation ciblée O-6).
    gap: { what: 'montants et dates des Opérations comparés aux preuves sur le stock ; regroupements manqués HORS séries récurrentes établies ; identité 78A en détection seule (correction par le réexamen T3)', existingMechanism: 'operations-quality-check (12 anomalies dures, lecture seule) ; consolidation T3 (78A par version, 55B)', planned: 'lots suivants (O-2 et suivants du CDC v5)' },
  },
  {
    domain: 'rapprochements', label: 'Rapprochements (pièces ↔ Opérations, documents ↔ biens)',
    // Lot 86D : associations Document ↔ Agenda confrontées à leurs preuves (COH-DOC-AGENDA-LINKS).
    checks: ['COH-DOC-LINKS', 'COH-OPS-IDENTITY', 'COH-OPS-RECURRING-SERIES', ...O1.filter((id) => /DOCUMENT/.test(id)), 'COH-DOC-AGENDA-LINKS'],
    gap: { what: 'rattachement document → bien principal ; relation document ↔ équipement que le document ne désigne pas lui-même (constat seul, contrat IA 82D-t3-document-equipement — lot 84E : réparée par O-6 quand le document la désigne)', existingMechanism: 'T3 DOCUMENT_ASSET (balayage continu des documents sans bien) ; consolidation M1–M3 ; reconsolidation ciblée O-6', planned: 'contrat IA 82D-t3-document-equipement' },
  },
  // Lot 86F : date économique de chaque dépense justifiée (jamais la date de l'Opération par défaut), stock réparé.
  { domain: 'tco', label: 'TCO et dépenses', checks: ['COH-TCO-EXTRACTED-EXPENSES', 'COH-TCO-ECONOMIC-DATES'] },
  { domain: 'agenda', label: 'Agenda (occurrences, échéances calculables des Opérations, événements obsolètes, échéances de fiche, appartenance aux Opérations)',
    checks: ['COH-AGENDA-OCCURRENCES', 'COH-AGENDA-ORPHANS', 'COH-AGENDA-OPERATION-PROJECTION', 'COH-AGENDA-PROJECTION-ORPHANS', 'COH-OPS-CONTRACT-DATES', ...O1.filter((id) => /AGENDA|PRINCIPAL|LINK-PROVENANCE/.test(id)), 'COH-DOC-AGENDA-LINKS',
      // Lot 99D : séries récurrentes arrêtées à tort par l'ancienne règle « mot-clé » (rétablies, T4 relancé).
      'COH-AGENDA-RECURRENCE-END'],
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
    checks: ['COH-TCO-EXTRACTED-EXPENSES', 'COH-ASSET-EQUIPMENT-SEPARATION', 'COH-OPS-ACQUISITION-DATE', 'COH-MISSING-PROPERTIES'],
    // Lot 85E : la date d'acquisition du bien est reportée sur l'achat réalisé resté sans date (et son événement de référence).
    // Lot 88B : toute propriété canonique VIDE du bien (prix d'acquisition compris) est reprise à partir des documents, Opérations,
    // montants, Agenda et preuves connus — arbitrage T3, écriture canonique ou abstention tracée (COH-MISSING-PROPERTIES).
    gap: { what: 'prix d’acquisition RENSEIGNÉ comparé aux Opérations sur le stock ; date d’acquisition contradictoire avec un achat déjà daté (tracée par T3, arbitrage 83A)', existingMechanism: 'T3 « Informations » 76J (par version)', planned: 'lot suivant' },
  },
  // Lot 88B : propriétés canoniques vides des équipements (COH-MISSING-PROPERTIES-EQUIPMENT).
  { domain: 'equipements', label: 'Équipements (documents rattachés, séparation bien / équipement, propriétés manquantes, identité produit)', checks: ['COH-DOC-LINKS', 'COH-ASSET-EQUIPMENT-SEPARATION', 'COH-MISSING-PROPERTIES-EQUIPMENT', 'COH-EQUIPMENT-IDENTITY'],
    gap: { what: 'situations de séparation SUSPECTES (constat seul) ; document d’équipement rattaché au seul bien sans preuve propre au document (constat seul — réparé par la reconsolidation ciblée O-6 dès que le document désigne l’équipement, lot 84E) ; liens d’un équipement déplacé vers un autre bien', existingMechanism: 'rattrapage BO « equipment-separation » (même code) ; file EQUIPMENT_DOCUMENT au déplacement et reconsolidation ciblée O-6', planned: 'contrat IA 82D-t3-document-equipement' } },
  { domain: 'documents-liens', label: 'Liens documentaires (documents ↔ biens / équipements, documents ↔ agenda)',
    checks: ['COH-DOC-LINKS', 'COH-DOC-EXTRACT-CHAIN', ...O1.filter((id) => /LINK|DOCUMENT/.test(id)), 'COH-DOC-AGENDA-LINKS'],
    // Lot 86D : un lien Document ↔ Agenda automatique sans preuve propre reste un constat (jugement de pertinence : contrat IA demandé).
    gap: { what: 'pertinence SÉMANTIQUE d’un lien Document ↔ Agenda automatique sans preuve propre au couple (constat AUTOMATIC_LINK_UNPROVEN, aucune écriture)', existingMechanism: 'détachement par l’utilisateur depuis les tiroirs de l’élément et du document (décision mémorisée)', planned: 'contrat IA 86D-t4-pertinence-lien-document-agenda' } },
  { domain: 'a-traiter', label: 'Cartes « À traiter »',
    checks: [
      'COH-TODO-DOCUMENT-FIELDS', 'COH-TODO-STALE-DECISIONS', 'COH-TODO-RELEVANCE-CARDS', 'COH-TODO-ORPHAN-CARDS', 'COH-TODO-RESOLUTION-PROPAGATION',
      // Lot 85B : Opérations, arbitrages T3 et champs d'entité (faux arbitrages 81A compris), revues de migration, propositions d'agenda.
      'COH-TODO-T3-FIELD-CARDS', 'COH-TODO-OPERATION-CARDS', 'COH-TODO-MIGRATION-REVIEW-CARDS', 'COH-TODO-AGENDA-PROPOSAL-CARDS',
      // Lot 85F : carte demandant une information présente dans la connaissance T1 non structurée.
      'COH-T1-KNOWLEDGE-CONSUMPTION',
      // Lot 100E (A7) : cartes devenues inutiles, TOUTES familles (contrat commun de publication).
      'COH-TODO-PUBLISHABILITY',
    ],
    // Lot 83E : la campagne de pertinence l76 est devenue COH-TODO-STALE-DECISIONS + COH-TODO-RELEVANCE-CARDS (moteur retiré).
    // Lot 85B : la campagne automatique 81A des faux arbitrages est devenue COH-TODO-T3-FIELD-CARDS (même réexamen).
    gap: {
      // Lot 100E (A7) : statut déjà posé par l'utilisateur (AGENDA-DONE / -NOT-DONE), statut du bien changé (ASSET-STATUS), document
      // déjà rattaché à un bien (LINK-ASSET), réalité retirée (AGENDA-PROJECTION-MATCH) : fermés par COH-TODO-PUBLISHABILITY.
      what: 'pertinence SÉMANTIQUE (hors état déjà tranché, couvert par COH-TODO-PUBLISHABILITY) des familles T4 « statut » (AGENDA-DONE / AGENDA-NOT-DONE / ASSET-STATUS), doublon d’agenda (AGENDA-DUPLICATE), rapprochement agenda incertain (AGENDA-PROJECTION-MATCH), lien document → équipement proposé (LINK-ELT) et classification (DOC-RUB / DOC-TYP) : décisions T4 / T3 non conservées avec leur candidat, rejeu impossible sans IA (cartes orphelines : COH-TODO-ORPHAN-CARDS) ; effets d’après résolution d’une proposition d’agenda acceptée (recopie de la date d’achat, statut du bien)',
      existingMechanism: 'producteurs T4 / T3 à l’analyse (file durable) ; conflits de rattachement clos par le balayage horaire (closeObsoleteAssetConflicts) ; projection des faits après rattachement contrôlée par COH-DOC-EXTRACT-CHAIN (aval) ; date d’achat : T3 « Informations » 76J',
      planned: 'persistance durable des décisions T4 (même point d’extension que COH-AGENDA-T4-DOCUMENT-DEADLINES)',
    } },
  {
    // Lot 86E : classement documentaire (Rubrique / Type) — nomenclature courante, type identifié = type enregistré.
    domain: 'documents-classement', label: 'Classement documentaire (Rubrique, Type)',
    checks: ['COH-DOC-CLASSIFICATION'],
    gap: {
      what: 'pertinence sémantique d’un classement établi sous la nomenclature courante (seul T1 en décide) ; Type ambigu (plusieurs Types de la nature identifiée dans la Rubrique) : carte DOC-TYP',
      existingMechanism: 'classement T1 à l’analyse (nomenclature transmise en données) ; cartes DOC-RUB / DOC-TYP ; mise à niveau du référentiel (/api/cron/documents/referential-upgrade)',
      planned: 'demande IA 86E-t1-classement-equipements-mobilier (recette corpus ; réévaluation du seul classement sans réanalyse complète)',
    },
  },
  {
    // Lot 87D : titres des documents (convention unique, données de nommage, recherche = fiche).
    domain: 'documents-titres', label: 'Titres des documents (nommage, recherche)',
    checks: ['COH-DOC-TITLES'],
    gap: {
      what: 'mois de rattachement principal d’une facture périodique : décision IA non fournie par le contrat T1 actuel — titre avec la période exacte (règle de présentation), jamais un mois inventé ; harmonisation des titres hors convention (familles libres) : décision T3',
      existingMechanism: 'service de nommage centralisé (fin d’analyse T1, connaissance T3) ; harmonisation T3 DOCUMENT_NAMING hors convention',
      planned: 'demande IA 87D-mois-principal-factures',
    },
  },
  {
    domain: 'documents-t1', label: 'Chaîne document → extract → T1 → aval (C-Q7)',
    checks: ['COH-DOC-EXTRACT-CHAIN'],
    // Lot 91D : décisions T1 par valeur (document_value_decisions) exploitées dès que le prompt T1 porte le contrat.
    gap: { what: 'tant que le prompt T1 actif ne porte pas le contrat t1-value-decisions-v1 : valeur de l’extract absente de T1 sur une unité COUVERTE = constat seul (volontaire ou accidentelle) ; documents analysés sans couche A', existingMechanism: 'décisions T1 par valeur validées et persistées (lot 91D), réexamen ciblé une fois par diagnostic, constats qualifiés en Supervision ; t1-source-units-backfill (couche A historique)', planned: 'activation par le PO du texte T1 du guide des prompts (demande 82B-t1-omissions-extract, contrat t1-value-decisions-v1)' },
  },
  {
    // Lot 87C : questions suggérées conservées confrontées à leurs fondements (COH-T6-SUGGESTIONS).
    domain: 't6', label: 'T6 / mascotte', checks: ['COH-T6-EVALUATIONS', 'COH-T6-SUGGESTIONS'],
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
