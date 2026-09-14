/**
 * Les huit Rubriques du CDC V2.0 §3.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES EXCLUSIONS COMPTENT AUTANT QUE LES FINALITÉS
 *
 * Le §3.4 est une instruction normative pour l'IA : « Classer selon la
 * finalité principale du document, jamais selon son caractère
 * administratif, officiel, contrat, facture ou un mot-clé isolé. »
 *
 * Une finalité seule ne suffit pas à tenir cette promesse. « Propriété et
 * gestion » et « Entretien et travaux » acceptent toutes deux le mot
 * « facture » ; ce qui les sépare est ce que chacune refuse. Le champ
 * `exclusions` est donc transmis au prompt au même titre que `purpose`
 * (§11.4) — c'est lui qui empêche une facture de réparation d'atterrir dans
 * la Rubrique d'acquisition.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RubricDefinition } from './types';

export const RUBRICS: readonly RubricDefinition[] = [
  {
    code: 'PROPERTY_MANAGEMENT',
    label: 'Propriété et gestion',
    purpose:
      "Acquisition, propriété, cession, valeur, financement, immatriculation, provenance, " +
      'copropriété, taxes et charges de détention.',
    exclusions:
      "Ne couvre pas les dépenses d'entretien, de réparation ou de travaux, ni les " +
      "documents d'assurance, ni les diagnostics réglementaires, ni les documents " +
      'liés à la mise en location du bien.',
    applicability: 'ALL',
    displayOrder: 10,
  },
  {
    code: 'CONTRACTS_WARRANTIES_DOCS',
    label: 'Contrats, garanties et notices',
    purpose:
      'Contrats de service, abonnements, garanties, licences, notices, manuels et ' +
      'documentation technique.',
    exclusions:
      "Ne couvre pas les contrats d'assurance (Assurances et sinistres), ni les " +
      'contrats de financement ou de leasing (Propriété et gestion), ni le bail ' +
      'de location (Gestion locative).',
    applicability: 'ALL',
    displayOrder: 20,
  },
  {
    code: 'MAINTENANCE_WORKS',
    label: 'Entretien et travaux',
    purpose:
      'Entretien, maintenance, réparations, interventions, travaux, installations, ' +
      'aménagements et modifications.',
    exclusions:
      "Ne couvre pas l'acquisition initiale du bien, ni les contrôles réglementaires " +
      '(Contrôles et conformité), ni la gestion d’un sinistre assuré.',
    applicability: 'ALL',
    displayOrder: 30,
  },
  {
    code: 'INSURANCE_CLAIMS',
    label: 'Assurances et sinistres',
    purpose:
      "Assurance du bien et gestion d'un sinistre, de la déclaration à l'indemnisation.",
    exclusions:
      "Ne couvre pas les expertises de valeur réalisées hors sinistre (Propriété et " +
      'gestion), ni les réparations facturées sans lien avec un sinistre.',
    applicability: 'ALL',
    displayOrder: 40,
  },
  {
    code: 'COMPLIANCE_CONTROLS',
    label: 'Contrôles et conformité',
    purpose:
      'Diagnostics, contrôles, autorisations, certifications, sécurité et conformité ' +
      'réglementaire.',
    exclusions:
      "Ne couvre pas les rapports d'intervention technique relevant de l'entretien, " +
      'ni les expertises de valeur, ni les rapports d’expertise de sinistre.',
    applicability: 'ALL',
    displayOrder: 50,
  },
  {
    code: 'MEDIA',
    label: 'Photos et vidéos',
    purpose:
      'Médias dont la photo ou la vidéo constitue elle-même le contenu documentaire.',
    exclusions:
      "Ne couvre pas la photographie d'un document : une photo de facture est classée " +
      'selon la finalité de la facture (§4.7).',
    applicability: 'ALL',
    displayOrder: 60,
  },
  {
    code: 'RENTAL_MANAGEMENT',
    label: 'Gestion locative',
    purpose:
      'Bail, état des lieux, loyers, dépôt de garantie, charges et échanges liés à la ' +
      "location d'un bien immobilier.",
    exclusions:
      'Ne couvre pas les charges de copropriété du propriétaire ni la fiscalité de ' +
      'détention, qui relèvent de Propriété et gestion.',
    applicability: ['IMMOBILIER'],
    displayOrder: 70,
    contextual: true,
  },
  {
    code: 'OTHER_DOCUMENTS',
    label: 'Autres documents',
    purpose: "Dernier recours lorsqu'aucune Rubrique métier ne convient.",
    exclusions:
      'À ne retenir que si aucune autre Rubrique ne correspond à la finalité du document.',
    applicability: 'ALL',
    displayOrder: 999,
    fallback: true,
  },
] as const;
