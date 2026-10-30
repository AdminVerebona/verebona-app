/**
 * Lot 88A — TABLE DE CORRESPONDANCE « champ API → composant d'écran » de la
 * fiche d'un bien (onglet « Informations »), maintenue dans le code. PUR.
 *
 * Le diagnostic global (`admin/diagnostics-export/properties.ts`) s'en sert
 * pour dire, pour chaque propriété : valeur persistée → valeur renvoyée par
 * `GET /api/assets/[id]/details` (même fonction `buildSections`) → champ
 * réellement consommé par l'écran (section, libellé, condition d'affichage).
 *
 * SYNCHRONISATION : le test `l88a-diagnostic-global.test.ts` compare cette
 * table aux définitions de l'écran (`getCommonFields`, `sectionFieldDefs`,
 * `SECTION_LABELS`, `FAMILY_SECTIONS` de `AssetDetailsTab.tsx`) et aux clés
 * renvoyées par `buildSections` : il échoue si l'écran ou l'API évolue sans
 * cette table. Desktop et mobile : même composant (grille responsive).
 */

export const DETAILS_UI_ROUTE = 'GET /api/assets/[id]/details';
export const DETAILS_UI_COMPONENT = 'AssetDetailsTab › AssetDetailSection (fiche du bien, onglet « Informations » ; desktop et mobile : même composant)';

export type DetailsUiFamily = 'IMMOBILIER' | 'VEHICULE' | 'OBJET';

interface DetailsUiField {
  key: string;
  label: string;
  /** Condition d'affichage (texte) lorsque le champ n'est pas toujours visible. */
  condition?: string;
}

export const DETAILS_UI_SECTION_LABELS: Readonly<Record<string, string>> = {
  common: 'Informations générales',
  location_identification: 'Localisation et identification',
  physical_characteristics: 'Caractéristiques physiques',
  occupancy_usage: 'Occupation / usage',
  performance_technical: 'Performance / technique',
  valuation: 'Valorisation',
  vehicle_identification: 'Identification',
  vehicle_technical: 'Caractéristiques techniques',
  vehicle_usage: 'Usage / kilométrage',
  vehicle_insurance: 'Assurance / conformité',
  insurance: 'Assurance',
  object_identification: 'Identification',
  object_condition: 'Caractéristiques / état',
  object_provenance: 'Provenance / traçabilité',
  object_usage: 'Usage / conservation',
};

export const DETAILS_UI_FAMILY_SECTIONS: Readonly<Record<DetailsUiFamily, readonly string[]>> = {
  IMMOBILIER: ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation', 'insurance'],
  VEHICULE: ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'],
  OBJET: ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation', 'insurance'],
};

/** Champs de la section « common » par famille (getCommonFields). */
export const DETAILS_UI_COMMON_FIELDS: Readonly<Record<DetailsUiFamily, readonly DetailsUiField[]>> = {
  IMMOBILIER: [
    { key: 'name', label: 'Nom' },
    { key: 'subCategory', label: 'Catégorie de bien' },
    { key: 'description', label: 'Description' },
    { key: 'acquisitionDate', label: 'Date d\'achat' },
    { key: 'acquisitionPrice', label: 'Prix d\'achat (€)' },
    { key: 'saleDate', label: 'Date de vente / cession', condition: 'visible seulement pour un bien vendu ou transmis' },
    { key: 'salePrice', label: 'Prix de vente réalisé (€)', condition: 'visible seulement pour un bien vendu' },
    { key: 'notes', label: 'Notes' },
  ],
  VEHICULE: [
    { key: 'name', label: 'Nom' },
    { key: 'subCategory', label: 'Catégorie de bien' },
    { key: 'description', label: 'Description' },
    { key: 'acquisitionDate', label: 'Date d\'achat', condition: 'VEHICULE : sans objet pour un statut de détention LLD, LOA ou prêt gratuit' },
    { key: 'acquisitionPrice', label: 'Prix d\'achat (€)', condition: 'VEHICULE : sans objet pour un statut de détention LLD, LOA ou prêt gratuit' },
    { key: 'vehicleOwnershipStatus', label: 'Statut de détention' },
    { key: 'saleDate', label: 'Date de vente / cession', condition: 'visible seulement pour un bien vendu ou transmis' },
    { key: 'salePrice', label: 'Prix de vente réalisé (€)', condition: 'visible seulement pour un bien vendu' },
    { key: 'notes', label: 'Notes' },
  ],
  OBJET: [
    { key: 'name', label: 'Nom' },
    { key: 'subCategory', label: 'Catégorie de bien' },
    { key: 'description', label: 'Description' },
    { key: 'acquisitionDate', label: 'Date d\'achat' },
    { key: 'acquisitionPrice', label: 'Prix d\'achat (€)' },
    { key: 'saleDate', label: 'Date de vente / cession', condition: 'visible seulement pour un bien vendu ou transmis' },
    { key: 'salePrice', label: 'Prix de vente réalisé (€)', condition: 'visible seulement pour un bien vendu' },
    { key: 'notes', label: 'Notes' },
  ],
};

/** Champs des autres sections (sectionFieldDefs). */
export const DETAILS_UI_SECTION_FIELDS: Readonly<Record<string, readonly DetailsUiField[]>> = {
  location_identification: [
    { key: 'address1', label: 'Adresse' },
    { key: 'address2', label: 'Complément d\'adresse' },
    { key: 'postalCode', label: 'Code postal' },
    { key: 'city', label: 'Ville' },
    { key: 'country', label: 'Pays' },
    { key: 'cadastralRef', label: 'Référence cadastrale' },
    { key: 'lotNumber', label: 'Numéro de lot' },
    { key: 'floor', label: 'Étage' },
    { key: 'gpsCoords', label: 'Coordonnées GPS' },
  ],
  physical_characteristics: [
    { key: 'livingArea', label: 'Surface habitable (m²)' },
    { key: 'carrezArea', label: 'Surface Carrez (m²)' },
    { key: 'listedArea', label: 'Surface annoncée (m²)' },
    { key: 'landArea', label: 'Surface terrain (m²)' },
    { key: 'roomCount', label: 'Nombre de pièces' },
    { key: 'bedroomCount', label: 'Nombre de chambres' },
    { key: 'levels', label: 'Nombre de niveaux' },
    { key: 'constructionYear', label: 'Année de construction' },
    { key: 'parking', label: 'Stationnement' },
    { key: 'generalCondition', label: 'État général' },
  ],
  occupancy_usage: [
    { key: 'occupancyUsage', label: 'Usage' },
    { key: 'occupancyStatus', label: 'Statut d\'occupation' },
    { key: 'leaseEndDate', label: 'Fin de contrat prévue', condition: 'visible seulement pour une détention à durée limitée (clé retenue par lib/assets/tenure-end)' },
    { key: 'contractEndDate', label: 'Fin de contrat prévue', condition: 'visible seulement pour une détention à durée limitée (clé retenue par lib/assets/tenure-end)' },
    { key: 'monthlyRent', label: 'Loyer mensuel (€)' },
    { key: 'charges', label: 'Charges (€)' },
    { key: 'occupancyNotes', label: 'Notes occupation' },
  ],
  performance_technical: [
    { key: 'heatingType', label: 'Type de chauffage' },
    { key: 'mainEnergy', label: 'Énergie principale' },
    { key: 'dpeClass', label: 'Classe DPE' },
    { key: 'dpeDate', label: 'Date DPE' },
    { key: 'dpeExpiryDate', label: 'Fin de validité du DPE' },
    { key: 'dpeAdemeNumber', label: 'N° ADEME du DPE' },
    { key: 'energyConsumption', label: 'Consommation énergétique (kWh/m²/an)' },
    { key: 'gesClass', label: 'Classe GES' },
    { key: 'lastRevision', label: 'Dernier entretien' },
    { key: 'maintenanceDueDate', label: 'Prochain entretien' },
    { key: 'networks', label: 'Réseaux' },
  ],
  valuation: [
    { key: 'estimatedValue', label: 'Valeur estimée (€)' },
    { key: 'valuationSource', label: 'Source de valorisation' },
    { key: 'valuationDate', label: 'Date de valorisation' },
    { key: 'listingPrice', label: 'Prix annoncé (€)' },
  ],
  vehicle_identification: [
    { key: 'make', label: 'Marque' },
    { key: 'model', label: 'Modèle' },
    { key: 'registrationNumber', label: 'Immatriculation', condition: 'visible seulement si le bien porte une immatriculation (assetHasRegistration)' },
    { key: 'registrationExpiry', label: 'Fin de validité d\'immatriculation', condition: 'visible seulement si le bien porte une immatriculation (assetHasRegistration)' },
    { key: 'vin', label: 'VIN / Numéro de série' },
    { key: 'year', label: 'Année' },
  ],
  vehicle_technical: [
    { key: 'engine', label: 'Motorisation' },
    { key: 'engineDisplacement', label: 'Cylindrée (cm³)' },
    { key: 'fuelType', label: 'Carburant' },
    { key: 'fiscalHp', label: 'Puissance administrative (CV)' },
    { key: 'powerKw', label: 'Puissance réelle (kW)' },
    { key: 'ptac', label: 'PTAC (kg)' },
    { key: 'seats', label: 'Nombre de places' },
    { key: 'firstRegistrationDate', label: 'Première mise en circulation', condition: 'visible seulement si le bien porte une immatriculation (assetHasRegistration)' },
  ],
  vehicle_usage: [
    { key: 'vehicleOwnershipStatus', label: 'Statut de détention' },
    { key: 'mileage', label: 'Kilométrage' },
    { key: 'mileageUnit', label: 'Unité (km/h)' },
    { key: 'mileageDate', label: 'Date du relevé' },
    { key: 'primaryUse', label: 'Usage principal' },
    { key: 'lastRevision', label: 'Dernière révision' },
    { key: 'maintenanceDueDate', label: 'Prochain entretien' },
    { key: 'contractNumber', label: 'N° de contrat (LLD / LOA / crédit)' },
    { key: 'contractStartDate', label: 'Début de contrat' },
    { key: 'leaseDurationMonths', label: 'Durée du contrat (mois)' },
    { key: 'leaseEndDate', label: 'Fin de contrat prévue', condition: 'visible seulement pour une détention à durée limitée (clé retenue par lib/assets/tenure-end)' },
    { key: 'contractEndDate', label: 'Fin de contrat prévue', condition: 'visible seulement pour une détention à durée limitée (clé retenue par lib/assets/tenure-end)' },
    { key: 'leaseMonthlyPayment', label: 'Loyer mensuel LLD / LOA (€)' },
    { key: 'leaseResidualValue', label: 'Valeur de rachat (€)' },
  ],
  vehicle_insurance: [
    { key: 'isInsured', label: 'Assuré' },
    { key: 'insurer', label: 'Assureur' },
    { key: 'insuranceContractNumber', label: 'N° de contrat' },
    { key: 'insuranceClientNumber', label: 'N° de client' },
    { key: 'insuranceExpiry', label: 'Date d\'échéance' },
    { key: 'insurancePremium', label: 'Prime annuelle (€)' },
    { key: 'lastInspectionDate', label: 'Dernier contrôle technique' },
    { key: 'nextInspection', label: 'Prochain contrôle technique' },
  ],
  insurance: [
    { key: 'isInsured', label: 'Assuré' },
    { key: 'insurer', label: 'Assureur' },
    { key: 'insuranceContractNumber', label: 'N° de contrat' },
    { key: 'insuranceClientNumber', label: 'N° de client' },
    { key: 'insuranceExpiry', label: 'Date d\'échéance' },
    { key: 'insurancePremium', label: 'Prime annuelle (€)' },
  ],
  object_identification: [
    { key: 'objectCategory', label: 'Catégorie' },
    { key: 'brand', label: 'Marque' },
    { key: 'productSeries', label: 'Série du produit' },
    { key: 'modelName', label: 'Modèle' },
    { key: 'productReference', label: 'Référence commerciale' },
    { key: 'productDesignation', label: 'Désignation commerciale' },
    { key: 'serialNumber', label: 'Numéro de série' },
  ],
  object_condition: [
    { key: 'condition', label: 'État' },
    { key: 'dimensions', label: 'Dimensions' },
    { key: 'weight', label: 'Poids (kg)' },
    { key: 'accessories', label: 'Accessoires' },
  ],
  object_provenance: [
    { key: 'acquisitionMode', label: 'Mode d\'acquisition' },
    { key: 'provenance', label: 'Provenance' },
    { key: 'authenticityProof', label: 'Preuve d\'authenticité' },
    { key: 'warrantyStartDate', label: 'Début de garantie' },
  ],
  object_usage: [
    { key: 'primaryUse', label: 'Usage principal' },
    { key: 'storageLocation', label: 'Lieu de stockage' },
    { key: 'lastRevision', label: 'Dernière révision' },
    { key: 'maintenanceDueDate', label: 'Prochain entretien' },
    { key: 'isInsured', label: 'Assuré' },
    { key: 'contractEndDate', label: 'Fin de contrat prévue', condition: 'visible seulement pour une détention à durée limitée (clé retenue par lib/assets/tenure-end)' },
  ],
};

/** Champs affichés d'une section pour une famille (« common » : selon la famille). */
export function detailsUiFields(family: DetailsUiFamily, section: string): readonly DetailsUiField[] {
  return section === 'common' ? DETAILS_UI_COMMON_FIELDS[family] : (DETAILS_UI_SECTION_FIELDS[section] ?? []);
}

/**
 * Champ d'écran qui consomme `section.key` de la réponse API pour cette
 * famille, ou null (champ renvoyé par l'API mais non affiché par la fiche).
 * Règle de l'écran : chaque section de la réponse est rendue avec SES champs,
 * lus dans SA donnée (`sections[section][key]`) — un champ défini pour une
 * section qui ne le reçoit pas s'affiche vide.
 */
export function detailsUiFieldFor(family: DetailsUiFamily, section: string, key: string): (DetailsUiField & { section: string; sectionLabel: string }) | null {
  // L'écran affiche CHAQUE section renvoyée par l'API avec les champs définis pour elle
  // (`DETAILS_UI_FAMILY_SECTIONS` ne sert qu'au surlignage d'un champ).
  const f = detailsUiFields(family, section).find((x) => x.key === key);
  return f ? { ...f, section, sectionLabel: DETAILS_UI_SECTION_LABELS[section] ?? section } : null;
}
