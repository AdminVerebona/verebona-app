/**
 * Informations complémentaires de la fiche bien — CDC Exports V12 §4,
 * DEC-007, IC-GEN-001..010, EXP-002.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL DICTIONNAIRE, CLIENT ET SERVEUR
 *
 * Les champs vente, location, assurance et sinistre étaient saisis (quand ils
 * l'étaient) dans des fenêtres d'export, puis perdus. Ils vivent désormais
 * dans la fiche bien, table `asset_additional_infos` (migration 0213).
 *
 * Ce module est PUR (aucun accès base, aucun React) : il décrit les champs,
 * les valide (zod) et fusionne un correctif. L'API, le formulaire et le
 * moteur de dossiers lisent la même définition.
 *
 * Champs : les 18 champs du §4.2, complétés par ceux que la maquette PDF
 * validée par le produit affiche (`maquettes/<dossier>/data-example.json`) :
 * accroches, prix neuf de référence, mode de charges, durée et usage du bail,
 * disponibilité locative, dépenses d'énergie, précisions d'objectif,
 * protections, usage à déclarer, et la sous-rubrique « Sinistre » (type,
 * dates, références, statut, circonstances, dommages, mesures, échanges,
 * montants).
 *
 * Listes structurées (schéma v2, migration 0214) : dommages, actions et
 * échanges du sinistre, points forts de vente, protections et éléments à
 * assurer, charges et taxes. Elles vivent dans la même colonne JSONB que leur
 * sous-rubrique (voir « LISTES » plus bas pour le choix et la sémantique de
 * concurrence). Le texte libre historique reste le repli du PDF.
 *
 * IC-GEN-002 — pas de doublon avec la fiche principale : l'assureur, le
 * numéro de contrat, le statut et l'usage d'occupation, le prix d'achat et la
 * surface restent dans la fiche ; seuls des compléments propres aux dossiers
 * sont ici (ex. surface locative = surcharge du dossier de location).
 *
 * Stockage (IC-GEN-006..008) : montants en centimes entiers, dates ISO
 * `AAAA-MM-JJ`, surfaces en nombre décimal. Un champ vide n'est pas stocké ;
 * zéro est une valeur (dépôt de garantie 0 €) distincte du vide.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import {
  toExportFamily, type ExportFamily, type AdditionalInfoSectionKey,
} from '@/services/exports/catalog';

export type { AdditionalInfoSectionKey } from '@/services/exports/catalog';

export const ADDITIONAL_INFO_SECTIONS: readonly AdditionalInfoSectionKey[] = ['commercial', 'rental', 'insurance', 'claim', 'finance'];

/**
 * Version du schéma des sous-rubriques (colonne `schema_version`, migration
 * 0214) : 1 = champs simples seulement, 2 = listes structurées.
 */
export const ADDITIONAL_INFOS_SCHEMA_VERSION = 2;

export const ADDITIONAL_INFO_SECTION_LABELS: Readonly<Record<AdditionalInfoSectionKey, string>> = {
  commercial: 'Informations commerciales',
  rental: 'Informations locatives',
  insurance: 'Informations assurance',
  claim: 'Sinistre',
  finance: 'Valeur et charges',
};

export const ADDITIONAL_INFO_SECTION_DESCRIPTIONS: Readonly<Record<AdditionalInfoSectionKey, string>> = {
  commercial: 'Reprises dans le kit de mise en vente.',
  rental: 'Reprises dans le dossier de mise en location.',
  insurance: "Reprises dans le dossier d'assurance (souscription ou mise à jour).",
  claim: "Reprises dans le dossier d'assurance sinistre / indemnisation.",
  finance: 'Reprises dans la section financière du dossier complet, incluse seulement si vous la cochez.',
};

/** Sous-rubriques visibles par famille (§4.2) : pas de location véhicule ni objet en V1. */
export const SECTIONS_BY_FAMILY: Readonly<Record<ExportFamily, readonly AdditionalInfoSectionKey[]>> = {
  IMMOBILIER: ['commercial', 'rental', 'insurance', 'claim', 'finance'],
  VEHICULE: ['commercial', 'insurance', 'claim', 'finance'],
  OBJET: ['commercial', 'insurance', 'claim', 'finance'],
};

/** Sous-rubriques visibles pour une catégorie de bien stockée (`OBJECT`…). */
export function sectionsForCategory(category: string | null | undefined): readonly AdditionalInfoSectionKey[] {
  const f = toExportFamily(category);
  return f ? SECTIONS_BY_FAMILY[f] : [];
}

// ── Dictionnaire des champs ─────────────────────────────────────────────────

export type AdditionalInfoFieldType = 'money' | 'text' | 'textarea' | 'date' | 'enum' | 'decimal' | 'year' | 'list' | 'eventRef';

export interface AdditionalInfoOption { value: string; label: string }

export interface AdditionalInfoFieldDef {
  section: AdditionalInfoSectionKey;
  key: string;
  type: AdditionalInfoFieldType;
  label: string;
  /** Aide courte sous le champ. */
  help?: string;
  placeholder?: string;
  options?: readonly AdditionalInfoOption[];
  /** Familles concernées ; absent = toutes celles de la sous-rubrique. */
  families?: readonly ExportFamily[];
  /** Champ recommandé pour le dossier (jamais bloquant). */
  recommended?: boolean;
  /** Type `list` : définition des lignes. */
  list?: ListDef;
}

// ── Listes structurées ──────────────────────────────────────────────────────

/**
 * Colonne d'une ligne de liste. `documentRefs` / `photoRefs` : identifiants
 * de pièces (`asset_files.id`) ou de photos (`asset_photos.id`) DU BIEN,
 * vérifiés à l'écriture (`additional-infos-references.service`) ; une pièce
 * supprimée depuis est simplement ignorée à la génération.
 */
export type ListColumnType = 'text' | 'textarea' | 'money' | 'date' | 'enum' | 'year' | 'documentRefs' | 'photoRefs' | 'documentRef';

export interface ListColumnDef {
  key: string;
  type: ListColumnType;
  label: string;
  required?: boolean;
  /** Longueur maximale (texte) ou nombre maximal de références. */
  max?: number;
  options?: readonly AdditionalInfoOption[];
  placeholder?: string;
  help?: string;
  /** Colonne technique non affichée (origine d'un point fort accepté). */
  hidden?: boolean;
  /** Largeur dans la grille de la ligne (formulaire). */
  span?: 1 | 2 | 3;
}

export interface ListDef {
  /** Nombre maximal de lignes (design : 4 points forts, 8 protections…). */
  maxItems: number;
  /** « Dommage », « Action »… (titres de ligne, bouton d'ajout). */
  itemLabel: string;
  addLabel: string;
  columns: readonly ListColumnDef[];
  emptyHint?: string;
}

/** Valeur d'une cellule : texte, nombre, ou liste d'identifiants. */
export type ListCellValue = string | number | number[];
/** Ligne d'une liste : `id` stable (réordonnancement, clés React). */
export type ListItem = { id: string } & { [key: string]: ListCellValue };

export const LEASE_TYPE_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'NON_MEUBLE', label: 'Location vide (non meublée)' },
  { value: 'MEUBLE', label: 'Location meublée' },
  { value: 'MOBILITE', label: 'Bail mobilité' },
  { value: 'ETUDIANT', label: 'Bail étudiant' },
  { value: 'SAISONNIER', label: 'Location saisonnière' },
  { value: 'AUTRE', label: 'Autre' },
];

export const CHARGES_MODE_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'PROVISION', label: 'Provision sur charges (régularisation annuelle)' },
  { value: 'FORFAIT', label: 'Forfait de charges' },
];

export const LEASE_USAGE_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'RESIDENCE_PRINCIPALE', label: 'Résidence principale du locataire' },
  { value: 'RESIDENCE_SECONDAIRE', label: 'Résidence secondaire du locataire' },
  { value: 'MIXTE', label: 'Usage mixte habitation et professionnel' },
  { value: 'AUTRE', label: 'Autre' },
];

export const INSURANCE_OBJECTIVE_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'SOUSCRIRE', label: 'Souscrire un contrat' },
  { value: 'METTRE_A_JOUR_VALEUR', label: 'Mettre à jour la valeur assurée' },
  { value: 'AJOUT_OBJET', label: 'Ajouter ce bien à un contrat existant' },
  { value: 'AJOUTER_JUSTIFICATIFS', label: 'Transmettre des justificatifs' },
  { value: 'MODIFIER_GARANTIES', label: 'Modifier les garanties' },
  { value: 'AUTRE', label: 'Autre' },
];

export const CLAIM_TYPE_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'DEGAT_DES_EAUX', label: 'Dégât des eaux' },
  { value: 'INCENDIE', label: 'Incendie' },
  { value: 'VOL', label: 'Vol ou cambriolage' },
  { value: 'BRIS_DE_GLACE', label: 'Bris de glace' },
  { value: 'EVENEMENT_CLIMATIQUE', label: 'Tempête, grêle ou neige' },
  { value: 'CATASTROPHE_NATURELLE', label: 'Catastrophe naturelle' },
  { value: 'ACCIDENT', label: 'Accident ou collision' },
  { value: 'VANDALISME', label: 'Vandalisme' },
  { value: 'DOMMAGE_ELECTRIQUE', label: 'Dommage électrique' },
  { value: 'AUTRE', label: 'Autre' },
];

export const CLAIM_STATUS_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'A_DECLARER', label: 'À déclarer' },
  { value: 'DECLARE', label: 'Déclaré' },
  { value: 'EXPERTISE_PREVUE', label: 'Expertise prévue' },
  { value: 'EXPERTISE_REALISEE', label: 'Expertise réalisée' },
  { value: 'EN_ATTENTE_INDEMNISATION', label: "En attente d'indemnisation" },
  { value: 'INDEMNISE', label: 'Indemnisé' },
  { value: 'REFUSE', label: 'Refusé' },
  { value: 'CLOS', label: 'Clos' },
];

export const ACTION_STATUS_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'REALISEE', label: 'Réalisée' },
  { value: 'EN_COURS', label: 'En cours' },
  { value: 'A_REALISER', label: 'À réaliser' },
];

export const EXCHANGE_DIRECTION_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'RECU', label: 'Reçu' },
  { value: 'ENVOYE', label: 'Envoyé' },
];

export const EXCHANGE_PARTY_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'ASSUREUR', label: 'Assureur' },
  { value: 'EXPERT', label: 'Expert' },
  { value: 'AUTRE', label: 'Autre interlocuteur' },
];

export const EXCHANGE_CHANNEL_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'EMAIL', label: 'E-mail' },
  { value: 'COURRIER', label: 'Courrier' },
  { value: 'TELEPHONE', label: 'Téléphone' },
  { value: 'ESPACE_CLIENT', label: 'Espace client' },
  { value: 'RENDEZ_VOUS', label: 'Rendez-vous' },
  { value: 'AUTRE', label: 'Autre' },
];

export const RETAINED_VALUE_SOURCE_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'SAISIE', label: 'Saisie utilisateur' },
  { value: 'EXPERTISE', label: 'Expertise' },
  { value: 'AVIS_PROFESSIONNEL', label: "Avis de valeur d'un professionnel" },
  { value: 'VALEUR_ASSUREE', label: "Valeur déclarée à l'assureur" },
  { value: 'AUTRE', label: 'Autre source' },
];

export const CHARGE_KIND_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'COPROPRIETE', label: 'Charges de copropriété' },
  { value: 'TAXE_FONCIERE', label: 'Taxe foncière' },
  { value: 'TAXE_HABITATION', label: "Taxe d'habitation" },
  { value: 'ASSURANCE', label: 'Assurance' },
  { value: 'CONTRAT_ENTRETIEN', label: "Contrat d'entretien" },
  { value: 'ENERGIE', label: 'Énergie' },
  { value: 'STATIONNEMENT', label: 'Stationnement' },
  { value: 'AUTRE', label: 'Autre' },
];

export const CHARGE_PERIOD_OPTIONS: readonly AdditionalInfoOption[] = [
  { value: 'AN', label: 'par an' },
  { value: 'TRIMESTRE', label: 'par trimestre' },
  { value: 'MOIS', label: 'par mois' },
];

/** Nombre maximal de points forts : 4 cartes dans la maquette du kit de vente. */
export const MAX_SALE_HIGHLIGHTS = 4;

export const ADDITIONAL_INFO_FIELDS: readonly AdditionalInfoFieldDef[] = [
  // ── Informations commerciales (§4.2 commercial.*, maquette vente `sale`) ──
  { section: 'commercial', key: 'desiredSalePriceCents', type: 'money', label: 'Prix de vente souhaité', help: "Saisi par vous ; jamais déduit d'une estimation.", recommended: true },
  { section: 'commercial', key: 'newPriceCents', type: 'money', label: "Prix neuf de référence", help: 'Prix du modèle neuf, affiché à titre indicatif.', families: ['VEHICULE', 'OBJET'] },
  { section: 'commercial', key: 'salePitch', type: 'text', label: "Accroche de l'annonce", placeholder: 'Une phrase factuelle qui résume le bien' },
  { section: 'commercial', key: 'saleConditions', type: 'textarea', label: 'Conditions de vente' },
  { section: 'commercial', key: 'availabilityDate', type: 'date', label: 'Date de disponibilité' },
  { section: 'commercial', key: 'availabilityComment', type: 'text', label: 'Commentaire sur la disponibilité', placeholder: 'Ex. remise en main propre' },
  { section: 'commercial', key: 'contactInstructions', type: 'textarea', label: 'Contact et modalités de visite' },
  { section: 'commercial', key: 'includedAccessories', type: 'textarea', label: 'Accessoires ou équipements inclus', help: 'Précisez seulement ce qui ne figure pas déjà dans les équipements du bien.' },
  {
    section: 'commercial', key: 'highlights', type: 'list', label: 'Points forts du bien',
    help: `${MAX_SALE_HIGHLIGHTS} au plus, dans l'ordre d'affichage. Tenez-vous-en aux faits documentés (facture, entretien, garantie).`,
    list: {
      maxItems: MAX_SALE_HIGHLIGHTS, itemLabel: 'Point fort', addLabel: 'Ajouter un point fort',
      emptyHint: 'Sans point fort choisi, le kit reprend les faits documentés du bien (entretiens, garantie, travaux, factures).',
      columns: [
        { key: 'title', type: 'text', label: 'Titre', required: true, max: 80, placeholder: 'Ex. Entretien en atelier agréé', span: 3 },
        { key: 'text', type: 'textarea', label: 'Précision', max: 280, placeholder: 'Dates, intervenant, justificatif…', span: 3 },
        { key: 'origin', type: 'text', label: 'Origine', max: 40, hidden: true },
      ],
    },
  },

  // ── Informations locatives (§4.2 rental.*, maquette location `rental`) ────
  { section: 'rental', key: 'monthlyRentCents', type: 'money', label: 'Loyer mensuel hors charges', help: 'Saisi par vous ; jamais estimé.', recommended: true },
  { section: 'rental', key: 'monthlyChargesCents', type: 'money', label: 'Charges mensuelles' },
  { section: 'rental', key: 'chargesMode', type: 'enum', label: 'Mode de charges', options: CHARGES_MODE_OPTIONS },
  { section: 'rental', key: 'depositCents', type: 'money', label: 'Dépôt de garantie', help: '0 € est accepté si vous le saisissez.' },
  { section: 'rental', key: 'leaseType', type: 'enum', label: 'Type de bail', options: LEASE_TYPE_OPTIONS },
  { section: 'rental', key: 'leaseDuration', type: 'text', label: 'Durée du bail', placeholder: 'Ex. 3 ans' },
  { section: 'rental', key: 'leaseUsage', type: 'enum', label: 'Usage du logement', options: LEASE_USAGE_OPTIONS },
  { section: 'rental', key: 'rentalAreaSqm', type: 'decimal', label: 'Surface locative (m²)', help: 'Utilisée dans le dossier de location seulement ; la surface du bien reste inchangée.' },
  { section: 'rental', key: 'availabilityDate', type: 'date', label: 'Date de disponibilité' },
  { section: 'rental', key: 'availabilityComment', type: 'text', label: 'Commentaire sur la disponibilité' },
  { section: 'rental', key: 'energyCostMinCents', type: 'money', label: "Dépenses annuelles d'énergie estimées — minimum", help: 'Montant indiqué sur le DPE.' },
  { section: 'rental', key: 'energyCostMaxCents', type: 'money', label: "Dépenses annuelles d'énergie estimées — maximum" },
  { section: 'rental', key: 'energyCostReferenceYear', type: 'year', label: 'Année de référence des prix de l’énergie' },
  { section: 'rental', key: 'rentalConditions', type: 'textarea', label: 'Conditions de location', placeholder: 'Garant, garantie Visale, animaux…' },
  { section: 'rental', key: 'rentalPitch', type: 'text', label: "Accroche de l'annonce" },
  { section: 'rental', key: 'contactInstructions', type: 'textarea', label: 'Contact location et modalités de visite', help: 'Peut différer du contact vente.' },

  // ── Informations assurance (§4.2 insurance.*, maquette souscription) ──────
  { section: 'insurance', key: 'insuranceObjective', type: 'enum', label: 'Objectif de la demande', options: INSURANCE_OBJECTIVE_OPTIONS, recommended: true },
  { section: 'insurance', key: 'objectiveDetail', type: 'textarea', label: 'Précisions sur la demande' },
  { section: 'insurance', key: 'valueToInsureCents', type: 'money', label: 'Valeur à assurer', help: 'Valeur que vous retenez ; jamais reprise automatiquement d’une estimation.' },
  { section: 'insurance', key: 'desiredInsuredAmountCents', type: 'money', label: 'Montant assuré souhaité', help: 'Distinct de la valeur estimée.' },
  { section: 'insurance', key: 'coverageComment', type: 'textarea', label: 'Garanties souhaitées ou commentaire' },
  { section: 'insurance', key: 'protections', type: 'textarea', label: 'Protections et conditions de conservation', placeholder: 'Alarme, garage fermé, antivol, rangement…' },
  { section: 'insurance', key: 'occupancyDetails', type: 'textarea', label: 'Usage et occupation à déclarer', help: "Précisions pour l'assureur ; l'usage principal reste celui de la fiche." },
  { section: 'insurance', key: 'specialItems', type: 'textarea', label: 'Éléments particuliers à transmettre', help: 'Objets, équipements, aménagements.' },
  {
    section: 'insurance', key: 'protectionItems', type: 'list', label: 'Protections détaillées',
    help: 'Une ligne par protection. Remplace le texte libre « Protections » dans le dossier.',
    list: {
      maxItems: 8, itemLabel: 'Protection', addLabel: 'Ajouter une protection',
      columns: [
        { key: 'title', type: 'text', label: 'Protection', required: true, max: 80, placeholder: 'Ex. Garage fermé à clé', span: 3 },
        { key: 'text', type: 'textarea', label: 'Précision', max: 280, placeholder: 'Ex. Porte motorisée, accès résidents uniquement', span: 3 },
      ],
    },
  },
  {
    section: 'insurance', key: 'insuredItems', type: 'list', label: 'Accessoires et éléments à assurer',
    help: 'En plus du bien lui-même : valeur que vous déclarez, justificatif si vous en avez un.',
    list: {
      maxItems: 20, itemLabel: 'Élément', addLabel: 'Ajouter un élément',
      columns: [
        { key: 'label', type: 'text', label: 'Élément', required: true, max: 160, placeholder: 'Ex. Housse rembourrée', span: 3 },
        { key: 'valueCents', type: 'money', label: 'Valeur déclarée' },
        { key: 'documentId', type: 'documentRef', label: 'Justificatif', span: 2 },
      ],
    },
  },

  // ── Sinistre (maquette assurance-sinistre `claim`) ────────────────────────
  { section: 'claim', key: 'claimEventKey', type: 'eventRef', label: "Événement sinistre de l'agenda", help: "Recommandé : le sinistre de l'agenda ancre la chronologie. Sans lui, les champs ci-dessous servent de saisie temporaire." },
  { section: 'claim', key: 'claimType', type: 'enum', label: 'Type de sinistre', options: CLAIM_TYPE_OPTIONS, recommended: true },
  { section: 'claim', key: 'occurredOn', type: 'date', label: 'Date du sinistre', recommended: true },
  { section: 'claim', key: 'declaredOn', type: 'date', label: "Date de déclaration à l'assureur" },
  { section: 'claim', key: 'insurerClaimRef', type: 'text', label: 'Référence du dossier sinistre' },
  { section: 'claim', key: 'policyReference', type: 'text', label: 'Contrat concerné', help: 'Seulement s’il diffère du contrat indiqué dans la fiche.' },
  { section: 'claim', key: 'status', type: 'enum', label: 'Avancement', options: CLAIM_STATUS_OPTIONS },
  { section: 'claim', key: 'statusDetail', type: 'text', label: "Précision sur l'avancement" },
  { section: 'claim', key: 'circumstances', type: 'textarea', label: 'Circonstances' },
  { section: 'claim', key: 'consequences', type: 'textarea', label: 'Dommages constatés (synthèse)' },
  { section: 'claim', key: 'measures', type: 'textarea', label: 'Mesures conservatoires (synthèse)' },
  { section: 'claim', key: 'exchangesSummary', type: 'textarea', label: "Échanges avec l'assureur ou l'expert (texte libre)", help: 'Utilisé seulement si la liste des échanges est vide.' },
  { section: 'claim', key: 'estimatedDamageCents', type: 'money', label: 'Montant estimé des dommages' },
  { section: 'claim', key: 'compensationCents', type: 'money', label: 'Indemnité reçue' },
  {
    section: 'claim', key: 'damages', type: 'list', label: 'Dommages et éléments concernés',
    help: 'Une ligne par élément touché. Tenez-vous-en au constat, sans cause ni responsabilité.',
    list: {
      maxItems: 30, itemLabel: 'Dommage', addLabel: 'Ajouter un dommage',
      columns: [
        { key: 'zone', type: 'text', label: 'Zone ou pièce', required: true, max: 120, placeholder: 'Ex. Salle de bain' },
        { key: 'element', type: 'text', label: 'Élément', max: 200, placeholder: 'Ex. Plafond · 5 m²', span: 2 },
        { key: 'finding', type: 'textarea', label: 'Constat', max: 600, placeholder: 'Ex. Auréoles, peinture cloquée', span: 3 },
        { key: 'estimatedAmountCents', type: 'money', label: 'Montant estimé' },
        { key: 'photoIds', type: 'photoRefs', label: 'Photos liées', max: 12 },
        { key: 'documentIds', type: 'documentRefs', label: 'Pièces liées', max: 12 },
      ],
    },
  },
  {
    section: 'claim', key: 'actions', type: 'list', label: 'Actions et mesures',
    help: 'Mesures conservatoires, interventions, réparations. Remplace la synthèse des mesures dans le dossier.',
    list: {
      maxItems: 30, itemLabel: 'Action', addLabel: 'Ajouter une action',
      columns: [
        { key: 'date', type: 'date', label: 'Date' },
        { key: 'endDate', type: 'date', label: "Jusqu'au", help: 'Pour une action sur plusieurs jours.' },
        { key: 'status', type: 'enum', label: 'Statut', options: ACTION_STATUS_OPTIONS },
        { key: 'title', type: 'text', label: 'Action', required: true, max: 160, placeholder: 'Ex. Séchage par déshumidificateur', span: 2 },
        { key: 'performedBy', type: 'text', label: 'Réalisée par', max: 120, placeholder: 'Vous, un artisan…' },
        { key: 'detail', type: 'textarea', label: 'Précision', max: 600, span: 3 },
        { key: 'invoiceDocumentId', type: 'documentRef', label: 'Facture liée', span: 3 },
      ],
    },
  },
  {
    section: 'claim', key: 'exchanges', type: 'list', label: "Échanges avec l'assureur et l'expert",
    help: 'Seuls les échanges liés au sinistre figurent au dossier.',
    list: {
      maxItems: 50, itemLabel: 'Échange', addLabel: 'Ajouter un échange',
      columns: [
        { key: 'date', type: 'date', label: 'Date', required: true },
        { key: 'direction', type: 'enum', label: 'Sens', options: EXCHANGE_DIRECTION_OPTIONS },
        { key: 'party', type: 'enum', label: 'Interlocuteur', options: EXCHANGE_PARTY_OPTIONS },
        { key: 'channel', type: 'enum', label: 'Canal', options: EXCHANGE_CHANNEL_OPTIONS },
        { key: 'summary', type: 'text', label: 'Résumé', required: true, max: 240, placeholder: "Ex. Convocation à l'expertise du 26/08", span: 2 },
        { key: 'documentId', type: 'documentRef', label: 'Document lié', span: 3 },
      ],
    },
  },

  // ── Valeur et charges (maquette dossier complet `finance`, RULE-002) ──────
  { section: 'finance', key: 'retainedValueCents', type: 'money', label: 'Valeur retenue', help: "Valeur que vous retenez ; l'estimation Verebona n'est jamais reprise." },
  { section: 'finance', key: 'retainedValueSource', type: 'enum', label: 'Origine de la valeur retenue', options: RETAINED_VALUE_SOURCE_OPTIONS },
  { section: 'finance', key: 'retainedValueDate', type: 'date', label: 'Date de la valeur retenue' },
  { section: 'finance', key: 'acquisitionFeesCents', type: 'money', label: "Frais d'acquisition", help: 'Notaire, agence : ajoutés au poste « Acquisition ».' },
  {
    section: 'finance', key: 'charges', type: 'list', label: 'Charges et taxes',
    help: 'Montants tels que vous les payez, avec leur périodicité.',
    list: {
      maxItems: 12, itemLabel: 'Charge', addLabel: 'Ajouter une charge ou une taxe',
      columns: [
        { key: 'kind', type: 'enum', label: 'Nature', required: true, options: CHARGE_KIND_OPTIONS },
        { key: 'label', type: 'text', label: 'Libellé', max: 80, placeholder: 'Facultatif, sauf « Autre »' },
        { key: 'year', type: 'year', label: 'Année' },
        { key: 'amountCents', type: 'money', label: 'Montant', required: true },
        { key: 'period', type: 'enum', label: 'Périodicité', options: CHARGE_PERIOD_OPTIONS },
      ],
    },
  },
];

/** Définitions d'une sous-rubrique, restreintes à une famille si fournie. */
export function fieldsFor(section: AdditionalInfoSectionKey, family?: ExportFamily | null): AdditionalInfoFieldDef[] {
  return ADDITIONAL_INFO_FIELDS.filter((f) => f.section === section && (!family || !f.families || f.families.includes(family)));
}

export function findField(section: AdditionalInfoSectionKey, key: string): AdditionalInfoFieldDef | undefined {
  return ADDITIONAL_INFO_FIELDS.find((f) => f.section === section && f.key === key);
}

// ── Validation (IC-GEN-006..008) ────────────────────────────────────────────

export const TEXT_MAX = 200;
export const TEXTAREA_MAX = 4000;
/** 1 milliard d'euros, en centimes : au-delà, saisie manifestement erronée. */
export const MONEY_MAX_CENTS = 100_000_000_000;
/** Texte d'une cellule de liste, sans `max` explicite. */
export const LIST_TEXT_MAX = 200;
export const LIST_TEXTAREA_MAX = 1000;
/** Références (photos, pièces) par cellule, sans `max` explicite. */
export const LIST_REFS_MAX = 12;

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1900 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Clé d'événement : `agenda:34` (agenda) ou `event:12` (historique) — `SourceEvent.key`. */
export const EVENT_KEY_RE = /^(agenda|event):[1-9]\d{0,9}$/;

const moneySchema = () => z.number({ error: 'Montant invalide.' })
  .int({ error: 'Le montant doit être exprimé en centimes entiers.' })
  .min(0, { error: 'Le montant ne peut pas être négatif.' })
  .max(MONEY_MAX_CENTS, { error: 'Montant trop élevé.' });

const yearSchema = (min = 1990) => z.number({ error: 'Année invalide.' }).int({ error: 'Année invalide.' })
  .min(min, { error: 'Année invalide.' }).max(2100, { error: 'Année invalide.' });

const dateSchema = () => z.string({ error: 'Date invalide.' }).refine(isValidIsoDate, { error: 'Date invalide (format attendu AAAA-MM-JJ).' });

const enumSchema = (options: readonly AdditionalInfoOption[] | undefined) => {
  const values = (options ?? []).map((o) => o.value);
  return z.string({ error: 'Valeur invalide.' }).refine((v) => values.includes(v), { error: 'Valeur non proposée.' });
};

/** Schéma zod d'une valeur NON vide pour un champ simple (les listes : `validateListValue`). */
export function valueSchema(def: AdditionalInfoFieldDef): z.ZodType<string | number> {
  switch (def.type) {
    case 'money':
      return moneySchema();
    case 'decimal':
      return z.number({ error: 'Nombre invalide.' })
        .gt(0, { error: 'La valeur doit être positive.' })
        .max(100_000, { error: 'Valeur trop élevée.' })
        .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, { error: 'Deux décimales au plus.' });
    case 'year':
      return yearSchema();
    case 'date':
      return dateSchema();
    case 'enum':
      return enumSchema(def.options);
    case 'eventRef':
      return z.string({ error: 'Événement invalide.' }).refine((v) => EVENT_KEY_RE.test(v), { error: 'Événement invalide.' });
    case 'list':
      // Garde-fou : une liste ne passe jamais par ce schéma.
      return z.never({ error: 'Liste attendue.' }) as unknown as z.ZodType<string | number>;
    case 'textarea':
      return z.string({ error: 'Texte invalide.' }).max(TEXTAREA_MAX, { error: `${TEXTAREA_MAX} caractères au plus.` });
    case 'text':
    default:
      return z.string({ error: 'Texte invalide.' }).max(TEXT_MAX, { error: `${TEXT_MAX} caractères au plus.` });
  }
}

export type AdditionalInfoValue = string | number | ListItem[];
export type AdditionalInfoSectionData = Record<string, AdditionalInfoValue>;

export interface AdditionalInfosData {
  commercial: AdditionalInfoSectionData;
  rental: AdditionalInfoSectionData;
  insurance: AdditionalInfoSectionData;
  claim: AdditionalInfoSectionData;
  finance: AdditionalInfoSectionData;
}

/**
 * Correctif : `null` (ou chaîne vide, liste vide) retire le champ (IC-GEN-009).
 * `version` (racine) : version connue du client, OBLIGATOIRE dès qu'une liste
 * est modifiée (contrôle optimiste, 409 si elle a changé).
 */
export type AdditionalInfosPatch = Partial<Record<AdditionalInfoSectionKey, Record<string, AdditionalInfoValue | null>>>;
export type AdditionalInfosPatchBody = AdditionalInfosPatch & { version?: number };

export interface NormalizedPatch {
  /** Valeurs à écrire, par sous-rubrique. */
  set: Partial<Record<AdditionalInfoSectionKey, AdditionalInfoSectionData>>;
  /** Clés à retirer, par sous-rubrique. */
  unset: Partial<Record<AdditionalInfoSectionKey, string[]>>;
}

export interface PatchValidationIssue { path: string; message: string }

export type PatchValidationResult =
  | {
    ok: true;
    patch: NormalizedPatch;
    fieldCount: number;
    /** Chemins `section.clé` des listes touchées (écrites ou vidées). */
    listPaths: string[];
    /** Version attendue (contrôle optimiste) ; `null` si le correctif ne touche aucune liste et n'en fournit pas. */
    expectedVersion: number | null;
  }
  | { ok: false; issues: PatchValidationIssue[] };

// ── LISTES ──────────────────────────────────────────────────────────────────
//
// Stockage : dans la colonne JSONB de la sous-rubrique (`claim_json.damages`…),
// PAS dans une table dédiée. Raisons : (1) listes courtes (≤ 50 lignes) lues et
// écrites avec leur sous-rubrique ; (2) le snapshot de génération (IC-GEN-010)
// les copie telles quelles, sans jointure ; (3) portée compte, cascade à la
// suppression du bien ou du compte et resynchronisation du compte sont déjà
// portées par la ligne `asset_additional_infos` (migration 0213) ; (4) une
// seule version optimiste par ligne suffit à la sémantique retenue.
//
// Sémantique de concurrence : une liste est REMPLACÉE EN BLOC (ajout, retrait,
// réordonnancement = nouvelle liste). Un correctif qui touche une liste porte
// la `version` lue par le client ; si la ligne a changé depuis, le serveur
// refuse (409) et renvoie l'état courant. Le client rejoue alors
// automatiquement si la liste serveur est restée celle qu'il avait lue (la
// version a bougé pour un autre champ), sinon il adopte la liste serveur et le
// signale (`rebaseAfterConflict`). Les champs simples restent fusionnés champ
// par champ (dernier écrit gagne, §4.3).

export const LIST_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Identifiant de ligne court, généré côté client (clé React, réordonnancement). */
export function newListItemId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `r${rnd}`;
}

type CellResult = { value?: ListCellValue; error?: string };

const isPositiveId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Normalise une cellule : vide → `{}` ; invalide → `{ error }`. */
export function normalizeListCell(col: ListColumnDef, raw: unknown): CellResult {
  if (raw === null || raw === undefined) return {};
  switch (col.type) {
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string') return { error: 'Texte invalide.' };
      const t = col.type === 'textarea' ? raw.replace(/\r\n/g, '\n').trim() : raw.replace(/\s+/g, ' ').trim();
      if (t === '') return {};
      const max = col.max ?? (col.type === 'textarea' ? LIST_TEXTAREA_MAX : LIST_TEXT_MAX);
      return t.length > max ? { error: `${max} caractères au plus.` } : { value: t };
    }
    case 'money': {
      if (raw === '') return {};
      const r = moneySchema().safeParse(raw);
      return r.success ? { value: r.data } : { error: r.error.issues[0]?.message ?? 'Montant invalide.' };
    }
    case 'year': {
      if (raw === '') return {};
      const r = yearSchema(1900).safeParse(raw);
      return r.success ? { value: r.data } : { error: 'Année invalide.' };
    }
    case 'date': {
      if (raw === '') return {};
      return typeof raw === 'string' && isValidIsoDate(raw) ? { value: raw } : { error: 'Date invalide (format attendu AAAA-MM-JJ).' };
    }
    case 'enum': {
      if (raw === '') return {};
      return typeof raw === 'string' && (col.options ?? []).some((o) => o.value === raw) ? { value: raw } : { error: 'Valeur non proposée.' };
    }
    case 'documentRef':
      if (raw === '') return {};
      return isPositiveId(raw) ? { value: raw } : { error: 'Document invalide.' };
    case 'documentRefs':
    case 'photoRefs': {
      if (!Array.isArray(raw)) return { error: 'Liste de références attendue.' };
      if (!raw.every(isPositiveId)) return { error: col.type === 'photoRefs' ? 'Photo invalide.' : 'Document invalide.' };
      const ids = [...new Set(raw as number[])];
      if (ids.length === 0) return {};
      const max = col.max ?? LIST_REFS_MAX;
      return ids.length > max ? { error: `${max} au plus.` } : { value: ids };
    }
    default:
      return { error: 'Valeur invalide.' };
  }
}

/** Règles entre colonnes d'une même ligne (au-delà du « requis »). */
function crossCellIssues(fieldKey: string, item: Record<string, ListCellValue>): Array<{ key: string; message: string }> {
  const out: Array<{ key: string; message: string }> = [];
  if (fieldKey === 'actions' && typeof item.date === 'string' && typeof item.endDate === 'string' && item.endDate < item.date) {
    out.push({ key: 'endDate', message: 'La date de fin précède la date de début.' });
  }
  if (fieldKey === 'actions' && item.endDate !== undefined && item.date === undefined) {
    out.push({ key: 'date', message: 'Indiquez la date de début.' });
  }
  if (fieldKey === 'charges' && item.kind === 'AUTRE' && item.label === undefined) {
    out.push({ key: 'label', message: 'Précisez le libellé de cette charge.' });
  }
  return out;
}

export type ListValidation = { ok: true; items: ListItem[] } | { ok: false; issues: PatchValidationIssue[] };

/**
 * Valide une liste complète (corps d'un PATCH, ou relecture). Les lignes
 * entièrement vides (brouillons du formulaire) sont ignorées ; un `id`
 * manquant est attribué ; les doublons d'`id` sont refusés.
 */
export function validateListValue(def: AdditionalInfoFieldDef, raw: unknown, path = `${def.section}.${def.key}`): ListValidation {
  const list = def.list;
  if (!list) return { ok: false, issues: [{ path, message: 'Champ non liste.' }] };
  if (!Array.isArray(raw)) return { ok: false, issues: [{ path, message: 'Liste attendue.' }] };
  const issues: PatchValidationIssue[] = [];
  const items: ListItem[] = [];
  const seen = new Set<string>();
  const known = new Set(['id', ...list.columns.map((c) => c.key)]);
  raw.forEach((row, i) => {
    const rowPath = `${path}[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { issues.push({ path: rowPath, message: 'Ligne invalide.' }); return; }
    const r = row as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!known.has(k)) issues.push({ path: `${rowPath}.${k}`, message: 'Colonne inconnue.' });
    const cells: Record<string, ListCellValue> = {};
    let rowIssues = 0;
    for (const col of list.columns) {
      const c = normalizeListCell(col, r[col.key]);
      if (c.error) { issues.push({ path: `${rowPath}.${col.key}`, message: c.error }); rowIssues++; continue; }
      if (c.value !== undefined) cells[col.key] = c.value;
    }
    // Brouillon (aucune cellule visible renseignée) : ignoré, jamais une erreur.
    const visible = list.columns.filter((c) => !c.hidden).some((c) => cells[c.key] !== undefined);
    if (!visible && rowIssues === 0) return;
    for (const col of list.columns) {
      if (col.required && cells[col.key] === undefined && !issues.some((x) => x.path === `${rowPath}.${col.key}`)) {
        issues.push({ path: `${rowPath}.${col.key}`, message: 'Champ requis.' });
      }
    }
    for (const x of crossCellIssues(def.key, cells)) issues.push({ path: `${rowPath}.${x.key}`, message: x.message });
    let id = typeof r.id === 'string' ? r.id : '';
    if (r.id !== undefined && !LIST_ITEM_ID_RE.test(id)) { issues.push({ path: `${rowPath}.id`, message: 'Identifiant de ligne invalide.' }); return; }
    if (!id) { let n = i + 1; do { id = `r${n++}`; } while (seen.has(id)); }
    if (seen.has(id)) { issues.push({ path: `${rowPath}.id`, message: 'Identifiant de ligne en double.' }); return; }
    seen.add(id);
    items.push({ ...cells, id } as ListItem);
  });
  if (items.length > list.maxItems) issues.push({ path, message: `${list.maxItems} lignes au plus.` });
  return issues.length ? { ok: false, issues } : { ok: true, items };
}

/** Relecture défensive d'une liste stockée : lignes valides seulement, plafond respecté. */
export function sanitizeList(def: AdditionalInfoFieldDef, stored: unknown): ListItem[] {
  if (!def.list || !Array.isArray(stored)) return [];
  const out: ListItem[] = [];
  const ids = new Set<string>();
  for (const row of stored) {
    const r = validateListValue(def, [row]);
    if (!r.ok || r.items.length === 0) continue;
    const item = r.items[0];
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    out.push(item);
    if (out.length >= def.list.maxItems) break;
  }
  return out;
}

/** Texte libre : espaces de bord retirés ; vide ⇒ suppression. */
function normalizeRaw(def: AdditionalInfoFieldDef, raw: unknown): unknown {
  if (typeof raw === 'string') {
    const t = def.type === 'textarea' ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
    return t === '' ? null : t;
  }
  return raw;
}

/**
 * Valide un correctif (corps du PATCH). Clés inconnues refusées ; champs non
 * applicables à la famille refusés en écriture (leur suppression reste admise).
 * Une liste est validée en entier et remplace la précédente ; vide ⇒ retirée.
 */
export function validateAdditionalInfosPatch(body: unknown, family: ExportFamily | null): PatchValidationResult {
  const issues: PatchValidationIssue[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, issues: [{ path: '', message: 'Corps attendu : un objet par sous-rubrique.' }] };
  }
  const patch: NormalizedPatch = { set: {}, unset: {} };
  let fieldCount = 0;
  const listPaths: string[] = [];
  let expectedVersion: number | null = null;
  const allowedSections = family ? SECTIONS_BY_FAMILY[family] : ADDITIONAL_INFO_SECTIONS;

  for (const [sectionKey, sectionValue] of Object.entries(body as Record<string, unknown>)) {
    if (sectionKey === 'version') {
      if (typeof sectionValue !== 'number' || !Number.isSafeInteger(sectionValue) || sectionValue < 0) {
        issues.push({ path: 'version', message: 'Version invalide.' });
      } else {
        expectedVersion = sectionValue;
      }
      continue;
    }
    if (!(ADDITIONAL_INFO_SECTIONS as readonly string[]).includes(sectionKey)) {
      issues.push({ path: sectionKey, message: 'Sous-rubrique inconnue.' });
      continue;
    }
    const section = sectionKey as AdditionalInfoSectionKey;
    if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
      issues.push({ path: section, message: 'Objet attendu.' });
      continue;
    }
    for (const [key, raw] of Object.entries(sectionValue as Record<string, unknown>)) {
      const path = `${section}.${key}`;
      const def = findField(section, key);
      if (!def) { issues.push({ path, message: 'Champ inconnu.' }); continue; }
      fieldCount++;
      const applicable = allowedSections.includes(section) && (!def.families || !family || def.families.includes(family));

      if (def.type === 'list') {
        listPaths.push(path);
        if (raw === null || raw === undefined) { (patch.unset[section] ??= []).push(key); continue; }
        const r = validateListValue(def, raw, path);
        if (!r.ok) { issues.push(...r.issues); continue; }
        if (r.items.length === 0) { (patch.unset[section] ??= []).push(key); continue; }
        if (!applicable) { issues.push({ path, message: 'Champ non applicable à ce bien.' }); continue; }
        (patch.set[section] ??= {})[key] = r.items;
        continue;
      }

      const value = normalizeRaw(def, raw);
      if (value === null || value === undefined) {
        (patch.unset[section] ??= []).push(key);
        continue;
      }
      if (!applicable) { issues.push({ path, message: "Champ non applicable à ce bien." }); continue; }
      const parsed = valueSchema(def).safeParse(value);
      if (!parsed.success) {
        issues.push({ path, message: parsed.error.issues[0]?.message ?? 'Valeur invalide.' });
        continue;
      }
      (patch.set[section] ??= {})[key] = parsed.data;
    }
  }
  if (listPaths.length > 0 && expectedVersion === null && !issues.some((i) => i.path === 'version')) {
    issues.push({ path: 'version', message: 'Version requise pour enregistrer une liste : rechargez la page.' });
  }
  if (issues.length > 0) return { ok: false, issues };
  if (fieldCount === 0) return { ok: false, issues: [{ path: '', message: 'Aucun champ à enregistrer.' }] };
  return { ok: true, patch, fieldCount, listPaths, expectedVersion };
}

/**
 * Relecture défensive d'une sous-rubrique stockée : seules les clés connues et
 * les valeurs valides sont rendues (une donnée corrompue n'atteint jamais le
 * PDF ni le formulaire). Listes : lignes valides seulement.
 */
export function sanitizeSection(section: AdditionalInfoSectionKey, stored: unknown): AdditionalInfoSectionData {
  const out: AdditionalInfoSectionData = {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [key, raw] of Object.entries(stored as Record<string, unknown>)) {
    const def = findField(section, key);
    if (!def || raw === null || raw === undefined || raw === '') continue;
    if (def.type === 'list') {
      const items = sanitizeList(def, raw);
      if (items.length) out[key] = items;
      continue;
    }
    const parsed = valueSchema(def).safeParse(raw);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/** Fusion champ par champ (dernier écrit gagne, §4.3) ; une liste est remplacée en bloc. */
export function applyPatch(current: AdditionalInfosData, patch: NormalizedPatch): AdditionalInfosData {
  const next = Object.fromEntries(ADDITIONAL_INFO_SECTIONS.map((s) => [s, { ...(current[s] ?? {}) }])) as unknown as AdditionalInfosData;
  for (const s of ADDITIONAL_INFO_SECTIONS) {
    for (const k of patch.unset[s] ?? []) delete next[s][k];
    Object.assign(next[s], patch.set[s] ?? {});
  }
  return next;
}

export function emptyAdditionalInfos(): AdditionalInfosData {
  return { commercial: {}, rental: {}, insurance: {}, claim: {}, finance: {} };
}

/** Liste stockée d'une sous-rubrique (lecture typée ; `[]` si absente ou non liste). */
export function listValue(section: AdditionalInfoSectionData | Record<string, unknown> | null | undefined, key: string): ListItem[] {
  const v = section?.[key];
  return Array.isArray(v) ? (v as ListItem[]) : [];
}

/** Égalité profonde de deux listes (ordre compris) — détection de conflit. */
export function sameList(a: readonly ListItem[] | undefined, b: readonly ListItem[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

// ── Saisie d'une cellule de liste (formulaire) ─────────────────────────────

/**
 * Texte saisi dans une cellule → valeur de ligne. Montants saisis en euros,
 * années sur quatre chiffres ; références et listes déroulantes passent tels quels.
 */
export function interpretListCellInput(col: ListColumnDef, raw: string): { kind: 'set'; value: ListCellValue } | { kind: 'clear' } | { kind: 'invalid'; message: string } {
  if (col.type === 'money') {
    const cents = parseEurosToCents(raw);
    if (cents === null) return { kind: 'clear' };
    if (Number.isNaN(cents)) return { kind: 'invalid', message: 'Montant invalide (ex. 1 250,50).' };
    const c = normalizeListCell(col, cents);
    return c.error ? { kind: 'invalid', message: c.error } : { kind: 'set', value: c.value! };
  }
  if (col.type === 'year') {
    const t = raw.trim();
    if (t === '') return { kind: 'clear' };
    if (!/^\d{4}$/.test(t)) return { kind: 'invalid', message: 'Année sur quatre chiffres.' };
    const c = normalizeListCell(col, Number(t));
    return c.error ? { kind: 'invalid', message: c.error } : { kind: 'set', value: c.value! };
  }
  if (col.type === 'documentRef') {
    const t = raw.trim();
    if (t === '') return { kind: 'clear' };
    const n = Number(t);
    return isPositiveId(n) ? { kind: 'set', value: n } : { kind: 'invalid', message: 'Document invalide.' };
  }
  const c = normalizeListCell(col, raw);
  if (c.error) return { kind: 'invalid', message: c.error };
  // Le texte est conservé tel que saisi (espaces compris) ; il est normalisé à l'envoi.
  return c.value === undefined ? { kind: 'clear' } : { kind: 'set', value: col.type === 'text' || col.type === 'textarea' ? raw : c.value };
}

// ── Montants : saisie en euros, stockage en centimes (IC-GEN-006) ───────────

/**
 * « 1 250,50 », « 1250.5 », « 1 250 € » → 125050. Vide → null.
 * Valeur illisible → NaN (le formulaire affiche l'erreur, rien n'est envoyé).
 */
export function parseEurosToCents(input: string): number | null {
  const s = input.replace(/[\s  €]/g, '').replace(',', '.');
  if (s === '') return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}

/** 125050 → « 1 250,50 » ; 120000 → « 1 200 » (saisie). */
export function formatCentsForInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(cents / 100);
}

/** « 12,5 » → 12.5 ; vide → null ; illisible → NaN. */
export function parseDecimalInput(input: string): number | null {
  const s = input.replace(/[\s  ]/g, '').replace(',', '.');
  if (s === '') return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Number(s);
}

export function formatDecimalForInput(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return String(n).replace('.', ',');
}

// ── Saisie formulaire ↔ valeur stockée ──────────────────────────────────────

export type FieldInputResult =
  | { kind: 'set'; value: AdditionalInfoValue }
  | { kind: 'clear' }
  | { kind: 'invalid'; message: string };

/**
 * Texte saisi dans le formulaire → action d'enregistrement. Un champ vidé
 * est retiré (IC-GEN-009) ; « 0 » reste une valeur (IC-GEN-008) ; une saisie
 * invalide n'est jamais envoyée.
 */
export function interpretFieldInput(def: AdditionalInfoFieldDef, raw: string): FieldInputResult {
  let candidate: AdditionalInfoValue | null;
  switch (def.type) {
    case 'money': {
      const cents = parseEurosToCents(raw);
      if (cents !== null && Number.isNaN(cents)) return { kind: 'invalid', message: 'Montant invalide (ex. 1 250,50).' };
      candidate = cents;
      break;
    }
    case 'decimal': {
      const n = parseDecimalInput(raw);
      if (n !== null && Number.isNaN(n)) return { kind: 'invalid', message: 'Nombre invalide (ex. 67,4).' };
      candidate = n;
      break;
    }
    case 'year': {
      const t = raw.trim();
      if (t === '') { candidate = null; break; }
      if (!/^\d{4}$/.test(t)) return { kind: 'invalid', message: 'Année sur quatre chiffres.' };
      candidate = Number(t);
      break;
    }
    case 'textarea':
      candidate = raw.replace(/\r\n/g, '\n').trim() === '' ? null : raw;
      break;
    default:
      candidate = raw.trim() === '' ? null : raw.trim();
  }
  if (candidate === null) return { kind: 'clear' };
  const parsed = valueSchema(def).safeParse(typeof candidate === 'string' && def.type === 'textarea' ? candidate.trim() : candidate);
  if (!parsed.success) return { kind: 'invalid', message: parsed.error.issues[0]?.message ?? 'Valeur invalide.' };
  return { kind: 'set', value: parsed.data };
}

/** Valeur stockée → texte du champ de saisie. */
export function toFieldInput(def: AdditionalInfoFieldDef, value: AdditionalInfoValue | undefined): string {
  if (value === undefined || value === null || Array.isArray(value)) return '';
  if (def.type === 'money') return typeof value === 'number' ? formatCentsForInput(value) : '';
  if (def.type === 'decimal') return typeof value === 'number' ? formatDecimalForInput(value) : '';
  return String(value);
}

// ── Listes : brouillons et erreurs par ligne (formulaire) ──────────────────

const isEmptyCell = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'string' && v.trim() === '');

/** Lignes du formulaire sans aucune cellule visible renseignée (ajoutées, pas encore remplies) : jamais envoyées. */
export function stripDraftRows(def: AdditionalInfoFieldDef, items: readonly ListItem[]): ListItem[] {
  const cols = (def.list?.columns ?? []).filter((c) => !c.hidden);
  return items.filter((it) => cols.some((c) => !isEmptyCell(it[c.key])));
}

export interface ListFormState {
  /** Liste à envoyer (brouillons retirés), ou `null` si elle ne peut pas partir (erreur). */
  payload: ListItem[] | null;
  /** Erreurs par ligne (`id`) puis par colonne. */
  rowErrors: Record<string, Record<string, string>>;
  /** Erreur de la liste entière (nombre de lignes…). */
  listError: string | null;
}

/**
 * État d'une liste du formulaire : ce qui partirait au serveur et les erreurs
 * à afficher, calculés avec la MÊME validation que le serveur.
 */
export function listFormState(def: AdditionalInfoFieldDef, items: readonly ListItem[]): ListFormState {
  const rows = stripDraftRows(def, items);
  const r = validateListValue(def, rows);
  if (r.ok) return { payload: r.items, rowErrors: {}, listError: null };
  const rowErrors: Record<string, Record<string, string>> = {};
  let listError: string | null = null;
  const prefix = `${def.section}.${def.key}`;
  for (const issue of r.issues) {
    const m = /^\[(\d+)\]\.(\w+)$/.exec(issue.path.slice(prefix.length));
    if (m) {
      const row = rows[Number(m[1])];
      if (row) (rowErrors[row.id] ??= {})[m[2]] = issue.message;
    } else {
      listError = issue.message;
    }
  }
  return { payload: null, rowErrors, listError };
}

// ── Éléments citables (sélecteurs du formulaire, GET ?include=references) ──

/** Suggestion de point fort : fait documenté du bien ; `key` devient `origin: suggestion:<key>` une fois acceptée. */
export interface HighlightSuggestion { key: string; title: string; text: string }

export interface AdditionalInfoReferencesDto {
  documents: Array<{ id: number; title: string; typeLabel: string; date: string | null; format: string; sensitive: boolean; occupantData: boolean }>;
  /** `id` : photo de la galerie (`asset_photos.id`) ; `fileId` : fichier pour la vignette. */
  photos: Array<{ id: number; fileId: number | null; caption: string | null; date: string | null; isPrimary: boolean }>;
  /** Événements « sinistre » (agenda ou historique), du plus récent au plus ancien. */
  claimEvents: Array<{ key: string; title: string; date: string | null; source: 'agenda' | 'event' }>;
  highlightSuggestions: HighlightSuggestion[];
}

/** Origine enregistrée d'un point fort accepté depuis une suggestion. */
export const suggestionOrigin = (key: string): string => `suggestion:${key}`.slice(0, 40);
