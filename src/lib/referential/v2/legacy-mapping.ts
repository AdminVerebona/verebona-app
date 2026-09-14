/**
 * Correspondance V1 → V2 — CDC V2.0 §15 et Annexe B.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI NE PEUT PAS ÊTRE MIGRÉ AUTOMATIQUEMENT
 *
 * Le §15.1 refuse la migration nominale : « la nouvelle taxonomie change
 * aussi la règle 1 Type = 1 Rubrique ». Trois familles de valeurs V1 n'ont
 * donc pas d'image directe :
 *
 *   · les Types multi-rubriques (FACTURE, DEVIS, CONTRAT…) : leur cible
 *     dépend de la finalité du document, que seule une analyse peut établir ;
 *   · les pseudo-types de sujet (ISOLATION_TOITURE, EQUIPEMENT_CHAUFFAGE…) :
 *     ils ne décrivent pas une nature documentaire et disparaissent ;
 *   · `AUTRE` employé comme valeur technique par défaut : le §15.1 interdit
 *     de l'assimiler à un choix utilisateur.
 *
 * Ce module ne tente donc pas de deviner. Il rend un verdict — `MAPPED`,
 * `NEEDS_REPROCESSING` ou `DROPPED` — et le traitement d'optimisation fait le
 * reste (§11.6). Une table de correspondance qui inventerait une cible
 * plausible produirait des documents classés à tort, indiscernables des
 * documents correctement classés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DOCUMENT_TYPES } from './document-types';
import type { RubricCode } from './types';

export type LegacyVerdict =
  /** Correspondance certaine : la valeur V2 peut être écrite directement. */
  | 'MAPPED'
  /** Aucune cible déterministe : le document repasse par l'optimisation. */
  | 'NEEDS_REPROCESSING'
  /** La valeur V1 n'a pas d'équivalent documentaire et est abandonnée. */
  | 'DROPPED';

export interface LegacyTypeResolution {
  verdict: LegacyVerdict;
  /** Renseigné uniquement si `verdict === 'MAPPED'`. */
  typeCode?: string;
  rubricCode?: RubricCode;
  /** Explication destinée au rapport de migration. */
  reason: string;
}

/**
 * Catégories V1 → Rubriques V2 (Annexe B).
 *
 * La correspondance n'est retenue que lorsqu'elle est univoque. Les
 * catégories V1 dont le périmètre a été redécoupé sont absentes : leurs
 * documents passent par le retraitement.
 */
export const LEGACY_CATEGORY_TO_RUBRIC: Readonly<Record<string, RubricCode>> = {
  ACHAT_VALEUR: 'PROPERTY_MANAGEMENT',
  PROPRIETE_ADMINISTRATIF: 'PROPERTY_MANAGEMENT',
  FISCALITE_CHARGES: 'PROPERTY_MANAGEMENT',
  GARANTIES_NOTICES: 'CONTRACTS_WARRANTIES_DOCS',
  ENTRETIEN_REPARATIONS: 'MAINTENANCE_WORKS',
  TRAVAUX_TRANSFORMATIONS: 'MAINTENANCE_WORKS',
  CONFORMITE_CONTROLES: 'COMPLIANCE_CONTROLS',
  PHOTOS_VIDEOS: 'MEDIA',
  AUTRES_DOCUMENTS: 'OTHER_DOCUMENTS',
  // CONTRATS_ASSURANCES est volontairement absente : elle couvrait à la fois
  // les contrats de service (CONTRACTS_WARRANTIES_DOCS), l'assurance
  // (INSURANCE_CLAIMS) et le bail (RENTAL_MANAGEMENT). Choisir pour elle
  // reviendrait à classer au hasard deux documents sur trois.
};

/** Types V1 dont la cible V2 est certaine. */
const DIRECT_TYPE_MAP: Readonly<Record<string, string>> = {
  DPE: 'DPE',
  AUDIT_ENERGETIQUE: 'ENERGY_AUDIT',
  DIAGNOSTIC_AMIANTE: 'ASBESTOS_DIAGNOSTIC',
  DIAGNOSTIC_PLOMB: 'LEAD_DIAGNOSTIC',
  DIAGNOSTIC_TERMITES: 'TERMITE_DIAGNOSTIC',
  DIAGNOSTIC_GAZ: 'GAS_DIAGNOSTIC',
  DIAGNOSTIC_ELECTRICITE: 'ELECTRICITY_DIAGNOSTIC',
  ETAT_DES_RISQUES: 'RISK_STATEMENT',
  CONTROLE_TECHNIQUE: 'VEHICLE_TECHNICAL_INSPECTION',
  CARTE_GRISE: 'REGISTRATION_CERTIFICATE',
  CERTIFICAT_IMMATRICULATION: 'REGISTRATION_CERTIFICATE',
  CERTIFICAT_CESSION: 'TRANSFER_CERTIFICATE',
  CERTIFICAT_AUTHENTICITE: 'AUTHENTICITY_CERTIFICATE',
  PREUVE_PROVENANCE: 'PROVENANCE_PROOF',
  TITRE_PROPRIETE: 'PROPERTY_TITLE',
  ACTE_PROPRIETE: 'PROPERTY_TITLE',
  TAXE_FONCIERE: 'PROPERTY_TAX_NOTICE',
  REGLEMENT_COPROPRIETE: 'COPRO_RULES',
  PV_ASSEMBLEE_GENERALE: 'COPRO_AG_MINUTES',
  APPEL_DE_FONDS: 'COPRO_CALL_FUNDS',
  NOTICE: 'USER_MANUAL',
  MANUEL: 'USER_MANUAL',
  FICHE_TECHNIQUE: 'TECHNICAL_SHEET',
  GARANTIE: 'WARRANTY_CERTIFICATE',
  EXTENSION_GARANTIE: 'EXTENDED_WARRANTY',
  ATTESTATION_ASSURANCE: 'INSURANCE_CERTIFICATE',
  POLICE_ASSURANCE: 'INSURANCE_POLICY',
  DECLARATION_SINISTRE: 'CLAIM_DECLARATION',
  CARNET_ENTRETIEN: 'MAINTENANCE_LOG',
  PLAN_CADASTRAL: 'CADASTRAL_PLAN',
  BAIL: 'RENTAL_LEASE',
  BAIL_LOCATION: 'RENTAL_LEASE',
  ETAT_DES_LIEUX: 'MOVE_IN_REPORT',
  QUITTANCE_LOYER: 'RENT_RECEIPT',
  PHOTO: 'PHOTO',
  VIDEO: 'VIDEO',
};

/**
 * Types V1 génériques, scindés par finalité (Annexe A, « Scission des anciens
 * Types multi-rubriques »). Leur cible dépend du document lui-même.
 */
const SPLIT_TYPES = new Set([
  'FACTURE',
  'DEVIS',
  'CONTRAT',
  'EXPERTISE',
  'PLAN_CONSTRUCTION',
  'PREUVE_PAIEMENT',
  'BON_COMMANDE',
  'BON_LIVRAISON',
  'RAPPORT',
  'ATTESTATION',
  'CERTIFICAT',
]);

/**
 * Pseudo-types décrivant un sujet et non une nature documentaire
 * (Annexe A, « Types historiques retirés comme Types »).
 */
const DROPPED_TYPES = new Set([
  'ISOLATION_TOITURE',
  'ISOLATION_MURS',
  'ISOLATION_VITRAGE',
  'ISOLATION_PLANCHERS',
  'EQUIPEMENT_CHAUFFAGE',
  'EQUIPEMENT_REFROIDISSEMENT',
  'EQUIPEMENT_ECS',
  'EQUIPEMENT_VENTILATION',
  'RESEAU_CHALEUR',
]);

/** Valeur technique par défaut de la V1 (§15.1, dernier alinéa). */
export const LEGACY_GENERIC_TYPE = 'AUTRE';

export interface LegacyTypeInput {
  typeCode: string | null;
  /**
   * Le Type V1 porte-t-il une preuve de sélection manuelle ?
   *
   * Sans preuve, le §15.1 impose de traiter `AUTRE` comme non renseigné :
   * « Les anciens AUTRE utilisés comme valeur technique par défaut ne doivent
   * pas être assimilés à un choix utilisateur. »
   */
  userSelected: boolean;
}

export function resolveLegacyType(input: LegacyTypeInput): LegacyTypeResolution {
  const { typeCode, userSelected } = input;

  if (!typeCode) {
    return {
      verdict: 'NEEDS_REPROCESSING',
      reason: 'Aucun Type V1 : le document est soumis au traitement d’optimisation.',
    };
  }

  if (typeCode === LEGACY_GENERIC_TYPE) {
    return userSelected
      ? {
          verdict: 'NEEDS_REPROCESSING',
          reason:
            'AUTRE choisi par l’utilisateur : le Type V2 « Autre » dépend de la ' +
            'Rubrique retenue, qui reste à déterminer. La validation utilisateur ' +
            'est conservée et protège la valeur (§15.1).',
        }
      : {
          verdict: 'NEEDS_REPROCESSING',
          reason:
            'AUTRE sans preuve de sélection manuelle : traité comme non renseigné (§15.1).',
        };
  }

  if (DROPPED_TYPES.has(typeCode)) {
    return {
      verdict: 'DROPPED',
      reason:
        `${typeCode} décrit le sujet du document, pas sa nature. Retiré du ` +
        'référentiel ; la nature réelle est déterminée par le retraitement.',
    };
  }

  if (SPLIT_TYPES.has(typeCode)) {
    return {
      verdict: 'NEEDS_REPROCESSING',
      reason:
        `${typeCode} était compatible avec plusieurs Rubriques. Sa cible V2 ` +
        'dépend de la finalité du document (Annexe A).',
    };
  }

  const target = DIRECT_TYPE_MAP[typeCode];
  if (target) {
    return {
      verdict: 'MAPPED',
      typeCode: target,
      rubricCode: rubricOfTypeCode(target),
      reason: `Correspondance directe ${typeCode} → ${target}.`,
    };
  }

  return {
    verdict: 'NEEDS_REPROCESSING',
    reason: `Type V1 inconnu du plan de correspondance : ${typeCode}.`,
  };
}

/**
 * Lecture directe de `document-types` plutôt que de `index` : ce module est
 * chargé par des scripts de migration, et passer par le point d'accès
 * complet y ferait entrer le référentiel entier sans nécessité.
 */
function rubricOfTypeCode(typeCode: string): RubricCode | undefined {
  return DOCUMENT_TYPES.find((t) => t.code === typeCode)?.rubric;
}

/** Correspondance des natures d'action V1 → V2 (§15.3). */
export const LEGACY_ACTION_FAMILY_MAP: Readonly<Record<string, 'ARBITRATE' | 'COMPLETE'>> = {
  a_arbitrer: 'ARBITRATE',
  a_confirmer: 'ARBITRATE',
  a_rattacher: 'ARBITRATE',
  a_completer: 'COMPLETE',
};

/** Correspondance des priorités V1 → V2 (Annexe B). */
export const LEGACY_PRIORITY_MAP: Readonly<Record<string, 'DO_FIRST' | 'DO_NEXT' | 'CAN_WAIT'>> = {
  HIGH: 'DO_FIRST',
  HAUTE: 'DO_FIRST',
  MEDIUM: 'DO_NEXT',
  MOYENNE: 'DO_NEXT',
  LOW: 'CAN_WAIT',
  BASSE: 'CAN_WAIT',
};
