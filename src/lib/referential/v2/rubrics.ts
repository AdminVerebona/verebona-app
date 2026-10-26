/**
 * Les huit Rubriques du CDC V2.0 §3.2, plus « Équipements et mobilier »
 * (lot 86E, référentiel 2.2.0).
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
import type { RubricCode, RubricDefinition } from './types';

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
      "liés à la mise en location du bien, ni l'achat, la livraison, l'utilisation ou " +
      "la garantie d'un meuble, d'un appareil ou d'un équipement du bien " +
      '(Équipements et mobilier).',
    applicability: 'ALL',
    displayOrder: 10,
  },
  // Lot 86E (référentiel 2.2.0) — ticket P1 « Équipements et mobilier ».
  // Le domaine : meubles, appareils et équipements d'un bien. Les Types
  // (facture, bon de commande, devis…) sont les Types génériques existants,
  // déclarés réutilisables ici (`alsoIn`), jamais dupliqués.
  {
    code: 'EQUIPMENT_FURNITURE',
    label: 'Équipements et mobilier',
    purpose:
      "Acquisition, livraison, utilisation et garantie des meubles, appareils et " +
      "équipements d'un bien : mobilier intérieur ou de jardin, électroménager, " +
      'équipements domestiques ou extérieurs. Le document peut concerner un bien ou ' +
      "une pièce sans désigner d'équipement individualisé.",
    exclusions:
      "Ne couvre pas l'acquisition du bien lui-même (Propriété et gestion), ni les " +
      'travaux, installations, réparations ou entretiens réalisés par un prestataire ' +
      "(Entretien et travaux), ni l'assurance ou les sinistres (Assurances et " +
      'sinistres), ni les contrats de service ou abonnements (Contrats, garanties et notices).',
    applicability: 'ALL',
    displayOrder: 15,
    since: '2.2.0',
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
      'de location (Gestion locative), ni les garanties, notices et fiches ' +
      "techniques d'un meuble, d'un appareil ou d'un équipement acheté " +
      '(Équipements et mobilier).',
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
      '(Contrôles et conformité), ni la gestion d’un sinistre assuré, ni l’achat ' +
      "d'un meuble, d'un appareil ou d'un équipement sans travaux ni installation " +
      '(Équipements et mobilier).',
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

/**
 * Couleurs d'affichage des Rubriques — maquette « Mes documents » (2026-09)
 * et design system Verebona.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * HORS DE `RUBRICS`, ET C'EST VOULU
 *
 * `RUBRICS` fait partie du référentiel versionné : toute modification impose
 * d'incrémenter `REFERENTIAL_VERSION`, ce qui déclenche le retraitement de
 * tous les documents (§11.6). Une couleur n'a aucune incidence sur le
 * classement ; la loger dans `RUBRICS` ferait repasser tout le parc
 * documentaire pour un changement purement visuel.
 *
 * `dot` : pastille (fond sombre) ; `accent` : trait de la mini-page des
 * vignettes. Les codes de la maquette (PROPERTY, CONTRACTS…) sont des
 * abréviations des codes réels ci-dessous ; libellés et ordre sont identiques.
 * ══════════════════════════════════════════════════════════════════════════
 */
export const RUBRIC_COLORS: Readonly<Record<RubricCode, { dot: string; accent: string }>> = {
  // Lot 66B1 — charte « Sérénité » 2026 : plus de palette brute. Couleurs
  // tirées des jetons de MARQUE (indépendants du thème : le trait est posé
  // sur la mini-page BLANCHE du document, identique en clair et en sombre),
  // nuancées par color-mix vers le blanc. Valeurs distinctes (neuf), chacune
  // ≥ 3:1 sur le papier blanc (contraste non textuel) ; la Rubrique reste
  // toujours écrite. Ni rouge (retard) ni cuivre (réservé à « À classer »).
  PROPERTY_MANAGEMENT: { dot: 'var(--vb-petrole)', accent: 'var(--vb-petrole)' },
  // Lot 86E : neuvième valeur distincte, encre nuancée (≥ 3:1 sur le papier blanc).
  EQUIPMENT_FURNITURE: { dot: 'color-mix(in srgb, var(--vb-encre) 75%, var(--vb-blanc))', accent: 'color-mix(in srgb, var(--vb-encre) 75%, var(--vb-blanc))' },
  CONTRACTS_WARRANTIES_DOCS: { dot: 'var(--vb-mascotte-ombre)', accent: 'var(--vb-mascotte-ombre)' },
  MAINTENANCE_WORKS: { dot: 'var(--vb-gris)', accent: 'var(--vb-gris)' },
  INSURANCE_CLAIMS: { dot: 'color-mix(in srgb, var(--vb-petrole) 60%, var(--vb-blanc))', accent: 'color-mix(in srgb, var(--vb-petrole) 60%, var(--vb-blanc))' },
  COMPLIANCE_CONTROLS: { dot: 'var(--vb-encre)', accent: 'var(--vb-encre)' },
  MEDIA: { dot: 'color-mix(in srgb, var(--vb-mascotte-ombre) 80%, var(--vb-blanc))', accent: 'color-mix(in srgb, var(--vb-mascotte-ombre) 80%, var(--vb-blanc))' },
  RENTAL_MANAGEMENT: { dot: 'color-mix(in srgb, var(--vb-petrole) 80%, var(--vb-blanc))', accent: 'color-mix(in srgb, var(--vb-petrole) 80%, var(--vb-blanc))' },
  OTHER_DOCUMENTS: { dot: 'color-mix(in srgb, var(--vb-gris) 70%, var(--vb-blanc))', accent: 'color-mix(in srgb, var(--vb-gris) 70%, var(--vb-blanc))' },
};

/** Zone « Sans rubrique » (documents à classer) : cuivre doux, comme le badge « À classer ». */
export const UNFILED_COLORS = { dot: 'var(--vb-cuivre)', accent: 'var(--vb-cuivre)' } as const;

/** Couleurs d'un code de Rubrique quelconque ; « Sans rubrique » si inconnu ou absent. */
export function rubricColors(code: string | null | undefined): { dot: string; accent: string } {
  return (code && (RUBRIC_COLORS as Record<string, { dot: string; accent: string }>)[code]) || UNFILED_COLORS;
}
