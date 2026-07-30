/**
 * Référentiel initial des catégories documentaires — CDC 5 §3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SEED VERSIONNÉ, PAS SOURCE DE VÉRITÉ
 *
 * Le §1.3 pose le constat : « le code canonique des types et le référentiel DB
 * doivent rester synchronisés manuellement » — et la correction attendue :
 * « faire du back-office et de la base la source de vérité, avec seed initial
 * versionné ».
 *
 * Ce fichier amorce donc la base, puis s'efface. Il est IDEMPOTENT : relancé,
 * il n'écrase aucune modification faite depuis le back-office. Un
 * administrateur qui renomme une catégorie ou change un ordre d'affichage ne
 * doit pas voir son travail annulé au prochain déploiement.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface CategorySeed {
  code: string;
  genericLabel: string;
  description: string;
  displayOrder: number;
  isSystemRequired?: boolean;
  /**
   * Familles de biens auxquelles la catégorie s'applique.
   * `null` = toutes (§3.2, colonne « Tous »).
   */
  assetTypeCodes: string[] | null;
  /** Libellés contextualisés du §3.3, par code de famille. */
  contextualLabels?: Record<string, string>;
}

/** Les dix catégories du §3.2, dans leur ordre d'affichage. */
export const CATEGORY_SEED: CategorySeed[] = [
  {
    code: 'ACHAT_VALEUR',
    genericLabel: 'Achat et valeur',
    description: 'Prix, acquisition, financement, estimation et valeur du bien.',
    displayOrder: 10,
    assetTypeCodes: null,
  },
  {
    code: 'CONTRATS_ASSURANCES',
    genericLabel: 'Contrats et assurances',
    description: 'Contrats, locations, abonnements, assurances et sinistres.',
    displayOrder: 20,
    assetTypeCodes: null,
  },
  {
    code: 'ENTRETIEN_REPARATIONS',
    genericLabel: 'Entretien et réparations',
    description: 'Maintenance, interventions, réparations et suivi courant.',
    displayOrder: 30,
    assetTypeCodes: null,
  },
  {
    code: 'GARANTIES_NOTICES',
    genericLabel: 'Garanties et notices',
    description: 'Garanties, notices, manuels et fiches techniques.',
    displayOrder: 40,
    assetTypeCodes: null,
  },
  {
    code: 'PROPRIETE_ADMINISTRATIF',
    genericLabel: 'Propriété et administratif',
    description: 'Titres, immatriculation, provenance, inventaire et pièces administratives.',
    displayOrder: 50,
    assetTypeCodes: null,
    contextualLabels: {
      IMMOBILIER: 'Propriété et administratif',
      VEHICULE: 'Immatriculation et administratif',
      MATERIEL_PRO: 'Inventaire et administratif',
      OBJECT: 'Authenticité et propriété',
    },
  },
  {
    code: 'CONFORMITE_CONTROLES',
    genericLabel: 'Conformité et contrôles',
    description: 'Diagnostics, contrôles, certificats et conformité.',
    displayOrder: 60,
    assetTypeCodes: null,
    contextualLabels: {
      IMMOBILIER: 'Diagnostics et conformité',
      VEHICULE: 'Contrôles et conformité',
      MATERIEL_PRO: 'Sécurité et conformité',
      OBJECT: 'Conformité et certificats',
    },
  },
  {
    code: 'TRAVAUX_TRANSFORMATIONS',
    genericLabel: 'Travaux et transformations',
    description: 'Travaux, aménagements, installations et modifications structurantes.',
    displayOrder: 70,
    // §3.2 : « IMMOBILIER, VEHICULE, MATERIEL_PRO ; selon sous-catégories
    // OBJECT ». La restriction par sous-catégorie d'objet n'est pas amorcée
    // ici — elle demande un arbitrage métier que le CDC laisse ouvert
    // (« selon pertinence de la sous-catégorie », §3.3).
    assetTypeCodes: ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO'],
    contextualLabels: {
      IMMOBILIER: 'Travaux et aménagements',
      VEHICULE: 'Modifications et équipements',
      MATERIEL_PRO: 'Installation et évolution',
    },
  },
  {
    code: 'FISCALITE_CHARGES',
    genericLabel: 'Fiscalité et charges',
    description: 'Taxes, copropriété, charges et documents financiers récurrents liés au bien.',
    displayOrder: 80,
    assetTypeCodes: ['IMMOBILIER'],
  },
  {
    code: 'PHOTOS_VIDEOS',
    genericLabel: 'Photos et vidéos',
    description: 'Médias dont le contenu est lui-même une photo ou une vidéo du bien.',
    displayOrder: 90,
    assetTypeCodes: null,
  },
  {
    code: 'AUTRES_DOCUMENTS',
    genericLabel: 'Autres documents',
    description: "Catégorie de dernier recours lorsqu'aucune catégorie métier ne convient.",
    // §3.2 : « AUTRES_DOCUMENTS est toujours affichée en dernier. »
    displayOrder: 9999,
    isSystemRequired: true,
    assetTypeCodes: null,
  },
];

/**
 * Compatibilités type → catégories (§3.4).
 *
 * `AUTRE` n'y figure pas : il est disponible dans toutes les catégories (§6.2),
 * et l'inscrire explicitement obligerait à le réinscrire à chaque nouvelle
 * catégorie créée — avec l'oubli garanti au bout de la troisième.
 */
export const TYPE_CATEGORY_SEED: Record<string, string[]> = {
  FACTURE: ['ACHAT_VALEUR', 'ENTRETIEN_REPARATIONS', 'TRAVAUX_TRANSFORMATIONS', 'FISCALITE_CHARGES'],
  DEVIS: ['ACHAT_VALEUR', 'ENTRETIEN_REPARATIONS', 'TRAVAUX_TRANSFORMATIONS'],
  CONTRAT: ['CONTRATS_ASSURANCES', 'PROPRIETE_ADMINISTRATIF', 'ENTRETIEN_REPARATIONS'],
  GARANTIE: ['GARANTIES_NOTICES'],
  ATTESTATION_ASSURANCE: ['CONTRATS_ASSURANCES'],
  MANUEL: ['GARANTIES_NOTICES'],
  RAPPORT_ENTRETIEN: ['ENTRETIEN_REPARATIONS'],
  ACTE_TRANSACTION: ['PROPRIETE_ADMINISTRATIF', 'ACHAT_VALEUR'],
  PERMIS_CONSTRUIRE: ['TRAVAUX_TRANSFORMATIONS', 'CONFORMITE_CONTROLES'],
  SURFACE_CARREZ: ['CONFORMITE_CONTROLES'],
  EXPERTISE: ['ACHAT_VALEUR', 'CONTRATS_ASSURANCES'],
  CONSTAT_SINISTRE: ['CONTRATS_ASSURANCES'],
  DIAGNOSTIC: ['CONFORMITE_CONTROLES'],
  PHOTO: ['PHOTOS_VIDEOS'],
  VIDEO: ['PHOTOS_VIDEOS'],
  DPE: ['CONFORMITE_CONTROLES'],
  AUDIT_ENERGETIQUE: ['CONFORMITE_CONTROLES'],
  AMIANTE: ['CONFORMITE_CONTROLES'],
  PLOMB: ['CONFORMITE_CONTROLES'],
  TERMITES: ['CONFORMITE_CONTROLES'],
  GAZ: ['CONFORMITE_CONTROLES'],
  ELECTRICITE: ['CONFORMITE_CONTROLES'],
  ASSAINISSEMENT: ['CONFORMITE_CONTROLES'],
  ERNMT: ['CONFORMITE_CONTROLES'],
  PLAN_CONSTRUCTION: ['TRAVAUX_TRANSFORMATIONS', 'PROPRIETE_ADMINISTRATIF'],
  PLAN_CADASTRAL: ['PROPRIETE_ADMINISTRATIF'],
  RE2020: ['CONFORMITE_CONTROLES'],
  LABEL_CERTIFICATION: ['CONFORMITE_CONTROLES'],
  ISOLATION_TOITURE: ['TRAVAUX_TRANSFORMATIONS'],
  ISOLATION_MURS: ['TRAVAUX_TRANSFORMATIONS'],
  ISOLATION_VITRAGE: ['TRAVAUX_TRANSFORMATIONS'],
  ISOLATION_PLANCHERS: ['TRAVAUX_TRANSFORMATIONS'],
  EQUIPEMENT_CHAUFFAGE: ['TRAVAUX_TRANSFORMATIONS', 'GARANTIES_NOTICES'],
  EQUIPEMENT_REFROIDISSEMENT: ['TRAVAUX_TRANSFORMATIONS', 'GARANTIES_NOTICES'],
  EQUIPEMENT_ECS: ['TRAVAUX_TRANSFORMATIONS', 'GARANTIES_NOTICES'],
  RESEAU_CHALEUR: ['TRAVAUX_TRANSFORMATIONS', 'CONFORMITE_CONTROLES'],
  EQUIPEMENT_VENTILATION: ['TRAVAUX_TRANSFORMATIONS', 'GARANTIES_NOTICES'],
};

export interface NewTypeSeed {
  code: string;
  label: string;
  categories: string[];
  /** Familles de biens pertinentes. `null` = toutes. */
  assetTypeCodes: string[] | null;
}

/**
 * Types complémentaires du §3.5.
 *
 * « Cette liste est une base de démarrage et n'est pas exhaustive. » Ils sont
 * créés s'ils n'existent pas, jamais modifiés s'ils existent déjà.
 */
export const NEW_TYPE_SEED: NewTypeSeed[] = [
  { code: 'PREUVE_PAIEMENT', label: 'Preuve de paiement', assetTypeCodes: null,
    categories: ['ACHAT_VALEUR', 'ENTRETIEN_REPARATIONS', 'TRAVAUX_TRANSFORMATIONS'] },
  { code: 'BON_COMMANDE', label: 'Bon de commande', assetTypeCodes: null,
    categories: ['ACHAT_VALEUR', 'TRAVAUX_TRANSFORMATIONS'] },
  { code: 'BON_LIVRAISON', label: 'Bon de livraison', assetTypeCodes: null,
    categories: ['ACHAT_VALEUR', 'PROPRIETE_ADMINISTRATIF'] },
  { code: 'RAPPORT_INTERVENTION', label: "Rapport d'intervention", assetTypeCodes: null,
    categories: ['ENTRETIEN_REPARATIONS'] },
  { code: 'FICHE_TECHNIQUE', label: 'Fiche technique', assetTypeCodes: null,
    categories: ['GARANTIES_NOTICES'] },
  { code: 'AVIS_ECHEANCE_ASSURANCE', label: "Avis d'échéance d'assurance", assetTypeCodes: null,
    categories: ['CONTRATS_ASSURANCES'] },

  { code: 'ETAT_DES_LIEUX', label: 'État des lieux', assetTypeCodes: ['IMMOBILIER'],
    categories: ['PROPRIETE_ADMINISTRATIF'] },
  { code: 'REGLEMENT_COPROPRIETE', label: 'Règlement de copropriété', assetTypeCodes: ['IMMOBILIER'],
    categories: ['PROPRIETE_ADMINISTRATIF'] },
  { code: 'PV_ASSEMBLEE_GENERALE', label: "Procès-verbal d'assemblée générale", assetTypeCodes: ['IMMOBILIER'],
    categories: ['FISCALITE_CHARGES'] },
  { code: 'APPEL_FONDS_COPROPRIETE', label: 'Appel de fonds de copropriété', assetTypeCodes: ['IMMOBILIER'],
    categories: ['FISCALITE_CHARGES'] },
  { code: 'TAXE_FONCIERE', label: 'Taxe foncière', assetTypeCodes: ['IMMOBILIER'],
    categories: ['FISCALITE_CHARGES'] },
  { code: 'QUITTANCE_LOYER', label: 'Quittance de loyer', assetTypeCodes: ['IMMOBILIER'],
    categories: ['CONTRATS_ASSURANCES', 'FISCALITE_CHARGES'] },

  { code: 'CERTIFICAT_IMMATRICULATION', label: "Certificat d'immatriculation", assetTypeCodes: ['VEHICULE'],
    categories: ['PROPRIETE_ADMINISTRATIF'] },
  { code: 'CERTIFICAT_CESSION', label: 'Certificat de cession', assetTypeCodes: ['VEHICULE'],
    categories: ['PROPRIETE_ADMINISTRATIF'] },
  { code: 'CERTIFICAT_SITUATION_ADMINISTRATIVE', label: 'Certificat de situation administrative',
    assetTypeCodes: ['VEHICULE'], categories: ['PROPRIETE_ADMINISTRATIF'] },
  { code: 'CONTROLE_TECHNIQUE', label: 'Contrôle technique', assetTypeCodes: ['VEHICULE'],
    categories: ['CONFORMITE_CONTROLES'] },
  { code: 'CARNET_ENTRETIEN', label: "Carnet d'entretien", assetTypeCodes: ['VEHICULE'],
    categories: ['ENTRETIEN_REPARATIONS'] },
  { code: 'CONTRAT_LOCATION_LEASING', label: 'Contrat de location / leasing', assetTypeCodes: ['VEHICULE'],
    categories: ['CONTRATS_ASSURANCES'] },

  { code: 'DECLARATION_CONFORMITE_CE', label: 'Déclaration de conformité CE',
    assetTypeCodes: ['MATERIEL_PRO'], categories: ['CONFORMITE_CONTROLES'] },
  { code: 'CERTIFICAT_ETALONNAGE', label: "Certificat d'étalonnage",
    assetTypeCodes: ['MATERIEL_PRO'], categories: ['CONFORMITE_CONTROLES'] },
  { code: 'RAPPORT_CONTROLE_SECURITE', label: 'Rapport de contrôle de sécurité',
    assetTypeCodes: ['MATERIEL_PRO'], categories: ['CONFORMITE_CONTROLES'] },
  { code: 'LICENCE_LOGICIELLE', label: 'Licence logicielle', assetTypeCodes: ['MATERIEL_PRO'],
    categories: ['CONTRATS_ASSURANCES', 'GARANTIES_NOTICES'] },

  { code: 'CERTIFICAT_AUTHENTICITE', label: "Certificat d'authenticité", assetTypeCodes: ['OBJECT'],
    categories: ['PROPRIETE_ADMINISTRATIF'] },
  { code: 'PREUVE_PROVENANCE', label: 'Preuve de provenance', assetTypeCodes: ['OBJECT'],
    categories: ['PROPRIETE_ADMINISTRATIF'] },
];
