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
    checks: ['COH-TODO-DOCUMENT-FIELDS'],
    gap: { what: 'valeurs canoniques des fiches comparées aux preuves sur le stock', existingMechanism: 'T3 « Informations » 76J par version (t3_information_checks)', planned: 'contrôle du registre au lot suivant (réutilise 76J)' },
  },
  {
    domain: 'operations', label: 'Opérations (identité économique, montants, regroupements)',
    checks: [],
    gap: { what: 'identité et montants des Opérations sur le stock', existingMechanism: 'operations-quality-check (12 anomalies dures, lecture seule) ; identité 78A par version', planned: 'lot suivant, sur le modèle Opérations v5 (V-Q9)' },
  },
  {
    domain: 'rapprochements', label: 'Rapprochements (pièces ↔ Opérations, documents ↔ biens)',
    checks: ['COH-DOC-LINKS'],
    gap: { what: 'rattachement document → bien principal et pièces ↔ Opérations', existingMechanism: 'T3 DOCUMENT_ASSET (balayage des documents sans bien) ; consolidation M1–M3', planned: 'lot suivant' },
  },
  { domain: 'tco', label: 'TCO et dépenses', checks: ['COH-TCO-EXTRACTED-EXPENSES'] },
  { domain: 'agenda', label: 'Agenda (occurrences, échéances de fiche)', checks: ['COH-AGENDA-OCCURRENCES', 'COH-AGENDA-ORPHANS'],
    gap: { what: 'échéances calculables absentes de l’agenda ; groupes T4 « même document, même date » sans Opération', existingMechanism: 'T4 à l’analyse ; signalement 76H', planned: 'lot suivant (T4 décide, V-Q5)' } },
  {
    domain: 'timeline', label: 'Timeline',
    checks: [],
    gap: { what: 'événements de timeline dérivés', existingMechanism: 'calcul à la lecture (aucun état persisté propre)', planned: 'CDC Opérations v5' },
  },
  {
    domain: 'biens', label: 'Biens',
    checks: ['COH-TCO-EXTRACTED-EXPENSES'],
    gap: { what: 'date et prix d’acquisition comparés à l’agenda et aux Opérations sur le stock', existingMechanism: 'T3 « Informations » 76J (par version)', planned: 'lot suivant' },
  },
  { domain: 'equipements', label: 'Équipements (documents rattachés)', checks: ['COH-DOC-LINKS'],
    gap: { what: 'données d’équipement attribuées au bien (séparation bien / équipement)', existingMechanism: 'rattrapage BO « equipment-separation » (manuel)', planned: 'lot suivant' } },
  { domain: 'documents-liens', label: 'Liens documentaires', checks: ['COH-DOC-LINKS'] },
  { domain: 'a-traiter', label: 'Cartes « À traiter »', checks: ['COH-TODO-DOCUMENT-FIELDS'],
    gap: { what: 'familles agenda, équipements, fournisseurs, Opérations, arbitrages T3', existingMechanism: 'producteurs du balayage horaire to-process-scan ; rattrapage 81A des faux arbitrages', planned: 'lot suivant' } },
  {
    domain: 'documents-t1', label: 'Chaîne document → extract → T1 → aval (C-Q7)',
    checks: [],
    gap: { what: 'omissions de T1 par rapport à l’extract', existingMechanism: 't1-completeness-retry (unités non couvertes)', planned: 'COH-DOC-EXTRACT-CHAIN (point d’extension déclaré), contrat IA demandé' },
  },
  {
    domain: 't6', label: 'T6 / mascotte', checks: [],
    gap: { what: 'évaluations T6 bloquées ou périmées', existingMechanism: 'mascot-t6-supervision, mascot-t6-reevaluations (81B)', planned: 'enregistrement au registre au lot suivant' },
  },
  {
    domain: 'comptes', label: 'Comptes, Duo, abonnements, notifications', checks: [],
    gap: { what: 'droits, Duo, abonnements locaux / Stripe, communications', existingMechanism: 'cross-account-relations-check, subscription-sync, santé des notifications', planned: 'lot suivant (détection seule pour l’isolation)' },
  },
];
