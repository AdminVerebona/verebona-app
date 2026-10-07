/**
 * Données du registre canonique des champs d'un bien (CDC 15 §5, REG-01/REG-02).
 *
 * Source de vérité : `assets.key_characteristics` (D-10). Les colonnes de
 * `assets` listées dans `mirrorColumns` en sont des miroirs, recopiés par
 * `writeCanonicalAssetField` (agent B) via `toMirrorValue()`.
 *
 * Montants (D-09) : euros dans la fiche (`money_eur`), centimes seulement pour
 * les clés `*Cents` (`money_cents`). Aucune règle « ×100 » par motif de nom.
 *
 * CIBLES (lot 13, T1-04) : un champ vise un BIEN par défaut. `targetTypes`
 * déclare les champs applicables aussi à un ÉQUIPEMENT (colonnes réelles :
 * `equipments.purchase_price_cents`, `estimated_value_cents`,
 * `equipment_cil_specs.brand`, `model`, `serial_number`, `power_kw` ; dates
 * de garantie et d'entretien portées par preuves et agenda) ou à une PIÈCE
 * (`substructures.area` → `roomArea` ; depuis D-G, lot 20, migration 0229, une
 * pièce est une sous-structure et `rooms` n'est plus lue). Aucune des deux
 * tables n'a de colonne d'étage : `floor`
 * reste un champ du bien. Depuis le lot 18 (R3), ces valeurs s'appliquent à
 * la fiche de l'équipement ou de la pièce (`writeCanonicalEntityField`, fiche
 * 0227, colonnes ci-dessus en miroir — `canonical/entity-state`).
 *
 * Construit à partir de l'existant (lot 10) :
 *   - `components/assets/AssetDetailsTab.tsx` (sections et libellés) ;
 *   - `app/api/assets/[id]/details/route.ts` (clés lues, colonnes de repli) ;
 *   - `verebona-assistant/commands/asset-fields.ts` (champs modifiables T2) ;
 *   - `source-analysis/steps/build-agenda-candidates.step.ts` (DEADLINE_FIELDS) ;
 *   - `lib/asset-detail-rules.ts` (champs datés) ;
 *   - `reconciliation/decision/*` et `coherence-impact.ts` (clés T3) ;
 *   - `governance/corpus/corpus-cases.ts` (clés françaises d'extraction) ;
 *   - CDC §5 (table d'alias) et §13 (matrice des événements).
 */
import type { AssetFamily, CanonicalFieldDef, ExcludedKey } from './types';

export const REGISTRY_VERSION = 'reg-v1-2026-10';

const ALL: AssetFamily[] = ['IMMOBILIER', 'VEHICULE', 'OBJECT'];
const I: AssetFamily[] = ['IMMOBILIER'];
const V: AssetFamily[] = ['VEHICULE'];
const O: AssetFamily[] = ['OBJECT'];

type FieldInput = Omit<CanonicalFieldDef, 'aliases' | 'assistantReadable' | 'assistantWritable'>
  & Partial<Pick<CanonicalFieldDef, 'aliases' | 'assistantReadable' | 'assistantWritable'>>;

/** Valeurs par défaut : lisible par T2, non modifiable par T2, sans alias. */
function f(def: FieldInput): CanonicalFieldDef {
  return {
    aliases: [],
    assistantReadable: true,
    assistantWritable: false,
    ...def,
  };
}

const CLASSES_AG = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
const ETATS = ['NEUF', 'BON', 'MOYEN', 'MAUVAIS'] as const;
const STATUTS_DETENTION = ['PROPRIETAIRE', 'LLD', 'LOA', 'CREDIT', 'PRET_GRATUIT'] as const;

export const CANONICAL_FIELDS: readonly CanonicalFieldDef[] = [
  /* ── Informations générales (toutes familles) ──────────────────────────── */
  f({
    key: 'description', label: 'Description', families: ALL, valueType: 'string', section: 'common',
  }),
  f({
    key: 'notes', label: 'Notes', families: ALL, valueType: 'string', section: 'common',
    mirrorColumns: [{ table: 'assets', column: 'notes', transform: 'identity' }],
  }),
  f({
    key: 'acquisitionDate', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Date d’achat', families: ALL, valueType: 'date', section: 'common',
    aliases: ['dateAchat', 'purchaseDate', 'dateAcquisition', 'acquisitionDay', 'dateDAchat'],
    assistantPhrases: ["date d'achat", "date d'acquisition", 'date achat', 'date acquisition', 'achete le', 'acquis le'],
    mirrorColumns: [{ table: 'assets', column: 'purchase_date', transform: 'date' }],
    agendaEffect: { nature: 'HISTORICAL', businessType: 'purchase' },
    assistantWritable: true,
    completenessRule: { required: true },
  }),
  f({
    key: 'acquisitionPrice', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Prix d’achat', families: ALL, valueType: 'money_eur', unit: 'EUR', section: 'common',
    aliases: ['prixAchat', 'purchasePrice', 'prixAcquisition', 'purchasePriceCents'],
    aliasUnits: { purchasePriceCents: 'cents' },
    assistantPhrases: ["prix d'achat", "prix d'acquisition", 'prix achat', "cout d'achat"],
    mirrorColumns: [{ table: 'assets', column: 'purchase_price_cents', transform: 'eur_to_cents' }],
    range: { min: 0 },
    assistantWritable: true,
    // Règle À traiter DATA-ACQUISITION-PRICE : l'absence seule ne déclenche rien (§10.5).
    completenessRule: { required: false },
  }),
  f({
    key: 'acquisitionCurrency', label: 'Devise d’achat', families: ALL, valueType: 'string', section: 'common',
  }),
  f({
    key: 'acquisitionLocation', label: 'Lieu d’achat', families: ALL, valueType: 'string', section: 'common',
    aliases: ['purchaseLocation', 'lieuAchat'],
    mirrorColumns: [{ table: 'assets', column: 'purchase_location', transform: 'identity' }],
  }),
  f({
    key: 'estimatedValue', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Valeur estimée', families: ALL, valueType: 'money_eur', unit: 'EUR', section: 'valuation',
    aliases: ['valeurEstimee', 'estimatedValueCents', 'currentValue'],
    aliasUnits: { estimatedValueCents: 'cents' },
    assistantPhrases: ['valeur estimee', 'valeur actuelle', 'estimation', 'valeur'],
    mirrorColumns: [{ table: 'assets', column: 'estimated_value_cents', transform: 'eur_to_cents' }],
    range: { min: 0 },
    assistantWritable: true,
  }),
  f({ key: 'estimatedValueCurrency', label: 'Devise de la valeur estimée', families: ALL, valueType: 'string', section: 'common' }),
  f({
    key: 'estimatedValueDate', label: 'Date de la valeur estimée', families: ALL, valueType: 'date', section: 'common',
    aliases: ['dateEstimation'],
  }),
  f({ key: 'estimatedValueMode', label: 'Mode d’estimation', families: ALL, valueType: 'string', section: 'common' }),
  f({ key: 'valuationLow', label: 'Valorisation basse', families: ALL, valueType: 'money_eur', unit: 'EUR', section: 'valuation', range: { min: 0 } }),
  f({ key: 'valuationHigh', label: 'Valorisation haute', families: ALL, valueType: 'money_eur', unit: 'EUR', section: 'valuation', range: { min: 0 } }),
  f({ key: 'valuationSource', label: 'Source de valorisation', families: ALL, valueType: 'string', section: 'valuation' }),
  f({ key: 'valuationDate', label: 'Date de valorisation', families: ALL, valueType: 'date', section: 'valuation' }),

  /* ── Assurance (toutes familles) ────────────────────────────────────────── */
  f({
    key: 'isInsured', label: 'Assuré', families: ALL, valueType: 'boolean', section: 'insurance',
    aliases: ['assure', 'estAssure'],
  }),
  f({
    key: 'insurer', label: 'Assureur', families: ALL, valueType: 'string', section: 'insurance',
    aliases: ['assureur', 'compagnieAssurance', 'insuranceCompany'],
    assistantPhrases: ['assureur', "compagnie d'assurance"],
    assistantWritable: true,
  }),
  f({
    key: 'insuranceContractNumber', label: 'N° de contrat d’assurance', families: ALL, valueType: 'string', section: 'insurance',
    aliases: ['policyNumber', 'numeroPolice', 'insurancePolicyNumber', 'numeroContratAssurance'],
  }),
  f({
    key: 'insuranceClientNumber', label: 'N° de client assurance', families: ALL, valueType: 'string', section: 'insurance',
    aliases: ['numeroClient', 'numeroSocietaire'],
    sensitive: true,
  }),
  f({
    key: 'insuranceExpiry', label: 'Échéance de l’assurance', families: ALL, valueType: 'date', section: 'insurance',
    aliases: ['dateEcheance', 'echeanceAssurance', 'insuranceExpiryDate', 'insuranceEndDate', 'dateEcheanceAssurance'],
    assistantPhrases: ["echeance de l'assurance", "echeance d'assurance", "fin d'assurance", "date d'echeance de l'assurance"],
    agendaEffect: { nature: 'DEADLINE', businessType: 'insurance', recurrence: 'FREQ=YEARLY' },
    assistantWritable: true,
  }),
  f({
    key: 'insurancePremium', label: 'Prime annuelle d’assurance', families: ALL, valueType: 'money_eur', unit: 'EUR', section: 'insurance',
    aliases: ['primeAssurance', 'primeAnnuelle', 'annualPremium'],
    range: { min: 0 },
  }),

  /* ── Entretien, garantie, contrats (toutes familles) ────────────────────── */
  f({
    key: 'lastRevision', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Dernier entretien', families: ALL, valueType: 'date', section: 'object_usage',
    aliases: ['lastMaintenanceDate', 'dateIntervention', 'dateDernierEntretien', 'derniereRevision', 'lastServiceDate'],
    mirrorColumns: [{ table: 'assets', column: 'last_maintenance_date', transform: 'date' }],
    agendaEffect: { nature: 'HISTORICAL', businessType: 'maintenance' },
  }),
  f({
    key: 'maintenanceDueDate', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Prochain entretien', families: ALL, valueType: 'date',
    aliases: ['prochaineEcheance', 'prochainEntretien', 'nextMaintenanceDate', 'nextServiceDate', 'prochaineRevision'],
    agendaEffect: { nature: 'DEADLINE', businessType: 'maintenance' },
  }),
  f({
    key: 'warrantyStartDate', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Début de garantie', families: ALL, valueType: 'date',
    aliases: ['debutGarantie', 'dateDebutGarantie'],
  }),
  f({
    key: 'warrantyEndDate', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Fin de garantie', families: ALL, valueType: 'date',
    aliases: ['finGarantie', 'dateFinGarantie', 'warrantyExpiry', 'warrantyEnd', 'warrantyExpiryDate'],
    mirrorColumns: [{ table: 'assets', column: 'warranty_end_date', transform: 'date' }],
    agendaEffect: { nature: 'DEADLINE', businessType: 'warranty' },
  }),
  f({
    key: 'contractNumber', label: 'N° de contrat', families: ALL, valueType: 'string',
    // `numeroContrat` : branche générale de l'alias CONTEXTUEL (D-C2,
    // CONTEXTUAL_ALIASES) — document d'assurance → insuranceContractNumber.
    aliases: ['numeroContrat'],
  }),
  f({
    key: 'contractStartDate', label: 'Début de contrat', families: ALL, valueType: 'date',
    aliases: ['dateDebutContrat'],
  }),
  f({
    key: 'contractEndDate', label: 'Fin de contrat', families: ALL, valueType: 'date',
    // `dateFinContrat` : branche générale de l'alias CONTEXTUEL (D-C1,
    // CONTEXTUAL_ALIASES) — bail / location (LLD, LOA) → leaseEndDate.
    aliases: ['dateFinContrat', 'finContrat'],
    agendaEffect: { nature: 'DEADLINE', businessType: 'contract' },
  }),

  /* ── Immobilier : localisation et identification ────────────────────────── */
  f({
    key: 'address1', label: 'Adresse', families: I, valueType: 'string', section: 'location_identification',
    aliases: ['address', 'adresse', 'adresseBien', 'streetAddress'],
    mirrorColumns: [{ table: 'assets', column: 'address', transform: 'identity' }],
    completenessRule: { required: true },
    sensitive: true,
    // « L'adresse » demandée : adresse complète, composée par le serveur (ticket 8a §G).
    composedDisplay: [['address1'], ['address2'], ['postalCode', 'city'], ['country']],
  }),
  f({ key: 'address2', label: 'Complément d’adresse', families: I, valueType: 'string', section: 'location_identification', aliases: ['complementAdresse'], sensitive: true }),
  f({
    key: 'postalCode', label: 'Code postal', families: I, valueType: 'string', section: 'location_identification',
    aliases: ['codePostal', 'zipCode'],
    mirrorColumns: [{ table: 'assets', column: 'postal_code', transform: 'identity' }],
    completenessRule: { required: true },
  }),
  f({
    key: 'city', label: 'Ville', families: I, valueType: 'string', section: 'location_identification',
    aliases: ['ville', 'commune'],
    mirrorColumns: [{ table: 'assets', column: 'city', transform: 'identity' }],
    completenessRule: { required: true },
  }),
  f({ key: 'country', label: 'Pays', families: I, valueType: 'string', section: 'location_identification', aliases: ['pays'] }),
  f({ key: 'cadastralRef', label: 'Référence cadastrale', families: I, valueType: 'string', section: 'location_identification', aliases: ['referenceCadastrale', 'cadastre'] }),
  f({ key: 'lotNumber', label: 'Numéro de lot', families: I, valueType: 'string', section: 'location_identification', aliases: ['numeroLot'] }),
  f({ key: 'floor', label: 'Étage', families: I, valueType: 'string', section: 'location_identification', aliases: ['etage'] }),
  f({ key: 'gpsCoords', label: 'Coordonnées GPS', families: I, valueType: 'string', section: 'location_identification', aliases: ['coordonneesGps'], sensitive: true }),

  /* ── Immobilier : caractéristiques physiques ───────────────────────────── */
  f({
    key: 'livingArea', label: 'Surface habitable', families: I, valueType: 'number', unit: 'm2', section: 'physical_characteristics',
    aliases: ['surfaceHabitable', 'surface', 'habitableArea'],
    range: { min: 0 },
  }),
  // Pièce (table `substructures`, colonne `area` — D-G) — CDC 15 T1-04 : une surface lue
  // pour une pièce ne devient jamais la surface habitable du bien.
  f({
    key: 'roomArea', label: 'Surface de la pièce', families: I, valueType: 'number', unit: 'm2',
    targetTypes: ['ROOM'], range: { min: 0 }, aliases: ['surfacePiece'],
  }),
  f({
    key: 'landArea', label: 'Surface du terrain', families: I, valueType: 'number', unit: 'm2', section: 'physical_characteristics',
    aliases: ['surfaceTerrain', 'plotArea'],
    range: { min: 0 },
  }),
  f({ key: 'roomCount', label: 'Nombre de pièces', families: I, valueType: 'number', integer: true, range: { min: 0 }, section: 'physical_characteristics', aliases: ['nombrePieces'] }),
  f({ key: 'bedroomCount', label: 'Nombre de chambres', families: I, valueType: 'number', integer: true, range: { min: 0 }, section: 'physical_characteristics', aliases: ['nombreChambres'] }),
  f({ key: 'levels', label: 'Nombre de niveaux', families: I, valueType: 'number', integer: true, range: { min: 0 }, section: 'physical_characteristics', aliases: ['nombreNiveaux'] }),
  f({ key: 'constructionYear', label: 'Année de construction', families: I, valueType: 'number', integer: true, range: { min: 1000, max: 2100 }, section: 'physical_characteristics', aliases: ['anneeConstruction', 'yearBuilt'] }),
  f({
    key: 'generalCondition', label: 'État général', families: I, valueType: 'enum', enumValues: ETATS,
    enumLabels: { NEUF: 'Neuf', BON: 'Bon', MOYEN: 'Moyen', MAUVAIS: 'Mauvais' },
    section: 'physical_characteristics', aliases: ['etatGeneral'],
    mirrorColumns: [{ table: 'assets', column: 'general_condition', transform: 'identity' }],
  }),

  /* ── Immobilier : occupation / usage ───────────────────────────────────── */
  f({
    key: 'occupancyUsage', label: 'Usage', families: I, valueType: 'enum', section: 'occupancy_usage',
    enumValues: ['RESIDENCE_PRINCIPALE', 'RESIDENCE_SECONDAIRE', 'LOCATIF', 'VACANT'],
    enumLabels: { RESIDENCE_PRINCIPALE: 'Résidence principale', RESIDENCE_SECONDAIRE: 'Résidence secondaire', LOCATIF: 'Mis en location', VACANT: 'Vacant' },
  }),
  f({
    key: 'occupancyStatus', label: 'Statut d’occupation', families: I, valueType: 'enum', section: 'occupancy_usage',
    enumValues: ['PROPRIETAIRE', 'LOCATAIRE', 'OCCUPANT_GRATUIT', 'USUFRUITIER'],
    enumLabels: { PROPRIETAIRE: 'Propriétaire', LOCATAIRE: 'Locataire', OCCUPANT_GRATUIT: 'Occupant à titre gratuit', USUFRUITIER: 'Usufruitier' },
  }),
  f({ key: 'monthlyRent', label: 'Loyer mensuel', families: I, valueType: 'money_eur', unit: 'EUR', range: { min: 0 }, section: 'occupancy_usage', aliases: ['loyerMensuel', 'loyer'] }),
  f({ key: 'charges', label: 'Charges', families: I, valueType: 'money_eur', unit: 'EUR', range: { min: 0 }, section: 'occupancy_usage', aliases: ['chargesMensuelles'] }),
  f({ key: 'occupancyNotes', label: 'Notes occupation', families: I, valueType: 'string', section: 'occupancy_usage' }),
  f({
    key: 'leaseEndDate', label: 'Fin de bail / location', families: ['IMMOBILIER', 'VEHICULE'], valueType: 'date',
    aliases: ['dateFinBail', 'finBail', 'leaseEnd'],
    agendaEffect: { nature: 'DEADLINE', businessType: 'lease' },
  }),

  /* ── Immobilier : performance / technique ──────────────────────────────── */
  f({ key: 'heatingType', label: 'Type de chauffage', families: I, valueType: 'string', section: 'performance_technical', aliases: ['typeChauffage', 'chauffage'] }),
  f({ key: 'mainEnergy', label: 'Énergie principale', families: I, valueType: 'string', section: 'performance_technical', aliases: ['energiePrincipale', 'energie'] }),
  f({
    key: 'dpeClass', label: 'Classe DPE', families: I, valueType: 'enum', enumValues: CLASSES_AG, section: 'performance_technical',
    aliases: ['classeEnergie', 'energyClass', 'classeDpe', 'etiquetteEnergie'],
  }),
  f({
    key: 'dpeDate', label: 'Date du DPE', families: I, valueType: 'date', section: 'performance_technical',
    aliases: ['dateDpe', 'dateEtablissementDpe'],
    // T4-03 : date de réalisation → événement historique, jamais une échéance.
    agendaEffect: { nature: 'HISTORICAL', businessType: 'dpe' },
  }),
  f({
    key: 'dpeExpiryDate', label: 'Fin de validité du DPE', families: I, valueType: 'date',
    aliases: ['dateFinValiditeDpe', 'dpeValidUntil', 'validiteDpe'],
    // Créée seulement si l'expiration est EXPLICITE dans la source (T4-03).
    agendaEffect: { nature: 'DEADLINE', businessType: 'dpe' },
  }),
  f({
    key: 'gesClass', label: 'Classe GES', families: I, valueType: 'enum', enumValues: CLASSES_AG, section: 'performance_technical',
    aliases: ['classeGES', 'ghgClass', 'etiquetteClimat'],
  }),
  f({
    key: 'energyConsumption', label: 'Consommation énergétique', families: I, valueType: 'number', unit: 'kWh/m2/an',
    aliases: ['consommation', 'consommationEnergie', 'primaryEnergyConsumption'],
    range: { min: 0 },
  }),
  f({ key: 'dpeAdemeNumber', label: 'N° ADEME du DPE', families: I, valueType: 'string', aliases: ['numeroAdeme'] }),
  f({ key: 'networks', label: 'Réseaux', families: I, valueType: 'json', section: 'performance_technical', aliases: ['reseaux'] }),

  /* ── Véhicule : identification ─────────────────────────────────────────── */
  f({ key: 'vehicleOwnershipStatus', label: 'Statut de détention', families: V, valueType: 'enum', enumValues: STATUTS_DETENTION,
    enumLabels: { PROPRIETAIRE: 'Propriétaire', LLD: 'Location longue durée (LLD)', LOA: 'Location avec option d’achat (LOA)', CREDIT: 'Crédit auto', PRET_GRATUIT: 'Prêt / utilisation gratuite' },
    section: 'vehicle_usage', aliases: ['ownershipStatus', 'statutDetention'] }),
  f({ key: 'make', label: 'Marque', families: V, valueType: 'string', section: 'vehicle_identification', aliases: ['marque', 'brand'] }),
  f({ key: 'model', label: 'Modèle', families: V, valueType: 'string', section: 'vehicle_identification', aliases: ['modele', 'modelName'] }),
  f({
    key: 'registrationNumber', label: 'Immatriculation', families: V, valueType: 'string', section: 'vehicle_identification',
    aliases: ['immatriculation', 'plaque', 'numeroImmatriculation', 'licensePlate', 'plateNumber'],
    assistantPhrases: ['immatriculation', "plaque d'immatriculation", 'plaque'],
    mirrorColumns: [{ table: 'assets', column: 'registration_number', transform: 'identity' }],
    assistantWritable: true,
    completenessRule: { required: true },
  }),
  f({ key: 'vin', label: 'VIN / numéro de châssis', families: V, valueType: 'string', section: 'vehicle_identification', aliases: ['chassisNumber', 'numeroChassis', 'numeroVin', 'vehicleIdentificationNumber'] }),
  f({ key: 'year', label: 'Année', families: V, valueType: 'number', integer: true, range: { min: 1880, max: 2100 }, section: 'vehicle_identification', aliases: ['annee', 'modelYear'] }),

  /* ── Véhicule : technique ──────────────────────────────────────────────── */
  f({
    key: 'engine', label: 'Motorisation', families: V, valueType: 'string', section: 'vehicle_technical',
    aliases: ['motorisation', 'engineInfo'],
    mirrorColumns: [{ table: 'assets', column: 'engine_info', transform: 'identity' }],
  }),
  f({
    key: 'fuelType', label: 'Carburant', families: V, valueType: 'enum', section: 'vehicle_technical',
    enumValues: ['ESSENCE', 'DIESEL', 'ELECTRIQUE', 'HYBRIDE', 'GPL', 'AUTRE'],
    enumLabels: { ESSENCE: 'Essence', DIESEL: 'Diesel', ELECTRIQUE: 'Électrique', HYBRIDE: 'Hybride', GPL: 'GPL', AUTRE: 'Autre' },
    aliases: ['carburant', 'energie'],
  }),
  f({ key: 'fiscalHp', label: 'Puissance administrative', families: V, valueType: 'number', unit: 'CV', integer: true, range: { min: 0 }, section: 'vehicle_technical', aliases: ['puissanceFiscale', 'chevauxFiscaux'] }),
  // `puissance` (D-D) : puissance d'un équipement (fiche produit PAC) ou
  // puissance réelle d'un véhicule, en kW — jamais la puissance fiscale (CV).
  f({ key: 'powerKw', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Puissance réelle', families: V, valueType: 'number', unit: 'kW', range: { min: 0 }, section: 'vehicle_technical', aliases: ['puissanceKw', 'puissanceReelle', 'puissance', 'puissanceNominale'] }),
  f({ key: 'ptac', label: 'PTAC', families: V, valueType: 'number', unit: 'kg', range: { min: 0 }, section: 'vehicle_technical', aliases: ['poidsTotalAutorise'] }),
  f({ key: 'seats', label: 'Nombre de places', families: V, valueType: 'number', integer: true, range: { min: 0 }, section: 'vehicle_technical', aliases: ['nombrePlaces', 'places'] }),
  f({ key: 'engineDisplacement', label: 'Cylindrée', families: V, valueType: 'number', unit: 'cm3', integer: true, range: { min: 0 }, aliases: ['cylindree'] }),
  f({
    key: 'firstRegistrationDate', label: 'Date de première immatriculation', families: V, valueType: 'date', section: 'vehicle_technical',
    aliases: ['premiereImmatriculation', 'datePremiereImmatriculation', 'dateMiseEnCirculation', 'miseEnCirculation'],
    assistantPhrases: ['date de premiere immatriculation', 'premiere immatriculation', 'date de mise en circulation', 'mise en circulation'],
    assistantWritable: true,
  }),
  f({
    key: 'registrationExpiry', label: 'Fin de validité d’immatriculation', families: V, valueType: 'date',
    aliases: ['finValiditeImmatriculation'],
    agendaEffect: { nature: 'DEADLINE', businessType: 'registration' },
  }),

  /* ── Véhicule : usage / kilométrage / contrôle ─────────────────────────── */
  f({
    key: 'mileage', label: 'Kilométrage', families: V, valueType: 'number', unit: 'km', integer: true, range: { min: 0 }, section: 'vehicle_usage',
    aliases: ['kilometrage', 'odometer', 'compteur', 'mileageOrHours'],
    assistantPhrases: ['kilometrage', 'compteur', 'nombre de kilometres'],
    // La colonne porte aussi des heures quand mileageUnit = 'h' (engins).
    mirrorColumns: [{ table: 'assets', column: 'mileage_or_hours', transform: 'integer' }],
    assistantWritable: true,
  }),
  f({ key: 'mileageUnit', label: 'Unité du compteur', families: V, valueType: 'enum', enumValues: ['km', 'h'], enumLabels: { km: 'Km', h: 'Heures' }, section: 'vehicle_usage' }),
  f({ key: 'mileageDate', label: 'Date du relevé', families: V, valueType: 'date', section: 'vehicle_usage', aliases: ['dateReleve'] }),
  f({ key: 'primaryUse', label: 'Usage principal', families: ['VEHICULE', 'OBJECT'], valueType: 'string', section: 'vehicle_usage', aliases: ['usagePrincipal'] }),
  f({
    key: 'nextInspection', label: 'Prochain contrôle technique', families: V, valueType: 'date', section: 'vehicle_insurance',
    aliases: ['prochainControleTechnique', 'dateProchainControle', 'nextInspectionDate', 'nextTechnicalInspection'],
    assistantPhrases: ['prochain controle technique', 'date du controle technique', 'controle technique', 'prochain ct'],
    agendaEffect: { nature: 'DEADLINE', businessType: 'inspection' },
    assistantWritable: true,
  }),
  f({
    key: 'lastInspectionDate', label: 'Dernier contrôle technique', families: V, valueType: 'date',
    aliases: ['dateControleTechnique', 'dernierControleTechnique', 'inspectionDate'],
    agendaEffect: { nature: 'HISTORICAL', businessType: 'inspection' },
  }),
  f({ key: 'leaseMonthlyPayment', label: 'Loyer mensuel (LOA / LLD)', families: V, valueType: 'money_eur', unit: 'EUR', range: { min: 0 }, aliases: ['loyerMensuel', 'mensualite'] }),
  f({ key: 'leaseDurationMonths', label: 'Durée du contrat (mois)', families: V, valueType: 'number', unit: 'mois', integer: true, range: { min: 0 }, aliases: ['dureeMois'] }),
  f({ key: 'leaseResidualValue', label: 'Valeur de rachat', families: V, valueType: 'money_eur', unit: 'EUR', range: { min: 0 }, aliases: ['valeurRachat', 'optionAchat'] }),

  /* ── Objet ─────────────────────────────────────────────────────────────── */
  f({
    key: 'objectCategory', label: 'Catégorie d’objet', families: O, valueType: 'enum', section: 'object_identification',
    enumValues: ['OBJECT_CATEGORY_TECH', 'OBJECT_CATEGORY_SPORT', 'OBJECT_CATEGORY_HOME'],
    enumLabels: { OBJECT_CATEGORY_TECH: 'Tech / IT / Électronique', OBJECT_CATEGORY_SPORT: 'Loisir / Sport', OBJECT_CATEGORY_HOME: 'Maison & équipement' },
    mirrorColumns: [{ table: 'assets', column: 'object_category', transform: 'identity' }],
  }),
  f({ key: 'brand', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Marque', families: O, valueType: 'string', section: 'object_identification', aliases: ['marque', 'fabricant', 'manufacturer'] }),
  f({ key: 'modelName', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Modèle', families: O, valueType: 'string', section: 'object_identification', aliases: ['modele', 'model'] }),
  f({ key: 'serialNumber', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Numéro de série', families: O, valueType: 'string', section: 'object_identification', aliases: ['numeroSerie', 'serial', 'numSerie'] }),
  f({
    key: 'condition', label: 'État', families: O, valueType: 'enum', enumValues: ETATS,
    enumLabels: { NEUF: 'Neuf', BON: 'Bon état', MOYEN: 'État moyen', MAUVAIS: 'Mauvais état' },
    section: 'object_condition', aliases: ['etat', 'generalCondition'],
    mirrorColumns: [{ table: 'assets', column: 'general_condition', transform: 'identity' }],
  }),
  f({
    key: 'dimensions', label: 'Dimensions', families: O, valueType: 'string', section: 'object_condition',
    mirrorColumns: [{ table: 'assets', column: 'dimensions', transform: 'identity' }],
  }),
  f({ key: 'weight', label: 'Poids', families: O, valueType: 'number', unit: 'kg', range: { min: 0 }, section: 'object_condition', aliases: ['poids'] }),
  f({ key: 'accessories', label: 'Accessoires', families: O, valueType: 'string', section: 'object_condition', aliases: ['accessoires'] }),
  f({ key: 'acquisitionMode', label: 'Mode d’acquisition', families: O, valueType: 'string', section: 'object_provenance', aliases: ['modeAcquisition'] }),
  f({ key: 'provenance', label: 'Provenance', families: O, valueType: 'string', section: 'object_provenance' }),
  f({ key: 'authenticityProof', label: 'Preuve d’authenticité', families: O, valueType: 'string', section: 'object_provenance', aliases: ['preuveAuthenticite'] }),
  f({ key: 'storageLocation', label: 'Lieu de stockage', families: O, valueType: 'string', section: 'object_usage', aliases: ['lieuStockage'] }),

  /* ── Clés classées par la décision PO D-D (lot 20) ──────────────────────── */
  // Surface « loi Carrez » : distincte de la surface habitable, jamais recopiée
  // dans livingArea (ni l'inverse).
  f({
    key: 'carrezArea', label: 'Surface Carrez', families: I, valueType: 'number', unit: 'm2', range: { min: 0 },
    section: 'physical_characteristics', aliases: ['surfaceCarrez', 'surfaceLoiCarrez', 'carrez'],
  }),
  // Stationnement déclaré (place, box, garage…) — clé lue par les exports
  // Vente / Location (`characteristics.parking`).
  f({
    key: 'parking', label: 'Stationnement', families: I, valueType: 'string', section: 'physical_characteristics',
    aliases: ['stationnement', 'placeParking', 'placeDeParking'],
  }),
  // Faits d'ANNONCE : SAISIE UNIQUEMENT (`inputOnly`), jamais inférés par l'IA
  // — ni la surface habitable, ni le prix d'achat, ni la valeur estimée.
  f({
    key: 'listedArea', label: 'Surface annoncée', families: I, valueType: 'number', unit: 'm2', range: { min: 0 },
    aliases: ['surfaceAnnoncee'], inputOnly: true,
  }),
  f({
    key: 'listingPrice', label: 'Prix annoncé', families: ALL, valueType: 'money_eur', unit: 'EUR', range: { min: 0 },
    aliases: ['prixAnnonce', 'prixAffiche'], inputOnly: true,
  }),
  // Équipement (PAC, climatisation) : cible ÉQUIPEMENT seulement, jamais le
  // bien. La « puissance » d'un équipement est l'alias de powerKw (colonne
  // réelle `equipment_cil_specs.power_kw`, voir plus haut).
  f({
    key: 'cop', label: 'Coefficient de performance (COP)', families: ALL, valueType: 'number', range: { min: 0, max: 20 },
    targetTypes: ['EQUIPMENT'], aliases: ['coefficientPerformance', 'coefficientDePerformance'],
  }),
  f({
    key: 'refrigerant', label: 'Fluide frigorigène', families: ALL, valueType: 'string',
    targetTypes: ['EQUIPMENT'], aliases: ['fluideFrigorigene', 'refrigerantFluid', 'gazFrigorigene'],
  }),
  // Date d'établissement d'un diagnostic immobilier (amiante, plomb,
  // électricité, gaz, termites, ERP…). `dateEtablissement` est un alias
  // CONTEXTUEL (CONTEXTUAL_ALIASES) : DPE → dpeDate, diagnostic → diagnosticDate,
  // autre document → date du document (hors registre, non résolue).
  f({
    key: 'diagnosticDate', label: 'Date d’établissement du diagnostic', families: I, valueType: 'date',
    section: 'performance_technical', aliases: ['dateDiagnostic', 'dateEtablissementDiagnostic'],
  }),
  // Compteur horaire (engins, bateaux, groupes électrogènes, PAC) : SÉPARÉ du
  // kilométrage, aucune conversion heures ↔ km, aucune colonne miroir
  // (`mileage_or_hours` reste celle de `mileage`).
  f({
    key: 'hourMeter', targetTypes: ['ASSET', 'EQUIPMENT'], label: 'Compteur horaire', families: ['VEHICULE', 'OBJECT'],
    valueType: 'number', unit: 'h', range: { min: 0 }, section: 'vehicle_usage',
    aliases: ['compteurHoraire', 'heuresMoteur', 'heuresFonctionnement', 'engineHours', 'horametre'],
  }),
];

/**
 * Alias dont la clé canonique dépend du TYPE DOCUMENTAIRE (décisions PO D-C,
 * D-D, lot 20), résolus par `resolveAliasDetailed(raw, family, { documentType })` :
 *   · `dateFinContrat` : bail / location (LLD, LOA, bail) → `leaseEndDate`,
 *     sinon `contractEndDate` ;
 *   · `numeroContrat` : document d'assurance → `insuranceContractNumber`,
 *     sinon `contractNumber` ;
 *   · `dateEtablissement` : DPE → `dpeDate`, diagnostic → `diagnosticDate`,
 *     sinon date du document (hors registre : non résolue).
 * Sans type documentaire, ou si la clé retenue ne s'applique pas à la famille
 * (bail d'un objet), la branche générale `otherwise`. Les branches générales
 * de `dateFinContrat` et `numeroContrat` restent des alias déclarés : la
 * résolution SANS contexte est inchangée.
 */
export interface ContextualAliasRule {
  lease?: string;
  insurance?: string;
  dpe?: string;
  diagnostic?: string;
  otherwise: string | null;
}
export const CONTEXTUAL_ALIASES: Readonly<Record<string, ContextualAliasRule>> = {
  dateFinContrat: { lease: 'leaseEndDate', otherwise: 'contractEndDate' },
  numeroContrat: { insurance: 'insuranceContractNumber', otherwise: 'contractNumber' },
  dateEtablissement: { dpe: 'dpeDate', diagnostic: 'diagnosticDate', otherwise: null },
};

/**
 * Clés rencontrées dans le code ou les extractions, volontairement HORS
 * registre. Une clé exclue n'est jamais résolue par `resolveAlias`.
 */
export const EXCLUDED_KEYS: readonly ExcludedKey[] = [
  // Techniques / affichage (voir coherence-impact.ts, IGNORED).
  { key: 'coherenceAlerts', kind: 'TECHNICAL', reason: 'Alertes de cohérence affichées sur la fiche.' },
  { key: 'dismissedCoherenceAlerts', kind: 'TECHNICAL', reason: 'Acquittement des alertes.' },
  { key: 'valuationHistory', kind: 'TECHNICAL', reason: 'Historique des valorisations, alimenté par estimatedValue.' },
  // Colonnes d'identité du bien (lues par CanonicalAssetView depuis `assets`).
  { key: 'name', kind: 'IDENTITY_COLUMN', reason: 'Colonne assets.name.' },
  { key: 'category', kind: 'IDENTITY_COLUMN', reason: 'Famille du bien (assets.category), non modifiable par la fiche.' },
  { key: 'subCategory', kind: 'IDENTITY_COLUMN', reason: 'Catégorie de bien (assets.subtype).' },
  { key: 'subtype', kind: 'IDENTITY_COLUMN', reason: 'Colonne assets.subtype.' },
  { key: 'status', kind: 'IDENTITY_COLUMN', reason: 'Statut du bien (assets.status) : règle métier séparée (D-15).' },
  // Faits portés par le document (asset_files, document_facts), pas par le bien.
  { key: 'amountCents', kind: 'DOCUMENT', reason: 'Montant du document, en centimes (asset_files.amount_cents).' },
  { key: 'montantTotal', kind: 'DOCUMENT', reason: 'Montant total du document (corpus) → amountCents.' },
  { key: 'documentDate', kind: 'DOCUMENT', reason: 'Date du document.' },
  { key: 'dateFacture', kind: 'DOCUMENT', reason: 'Date de facture → documentDate.' },
  { key: 'dateActe', kind: 'DOCUMENT', reason: 'Date de l’acte → documentDate (l’acquisitionDate est émise séparément par T1).' },
  { key: 'supplier', kind: 'DOCUMENT', reason: 'Fournisseur du document.' },
  { key: 'tauxTva', kind: 'DOCUMENT', reason: 'Taux de TVA d’une facture.' },
  { key: 'resteACharge', kind: 'DOCUMENT', reason: 'Reste à charge d’une facture.' },
  { key: 'retainedTitle', kind: 'DOCUMENT', reason: 'Titre retenu du document.' },
  { key: 'retainedFunctionCode', kind: 'DOCUMENT', reason: 'Fonction documentaire retenue.' },
  { key: 'rubricCode', kind: 'DOCUMENT', reason: 'Rubrique documentaire.' },
  { key: 'documentTypeCode', kind: 'DOCUMENT', reason: 'Type documentaire.' },
  { key: 'iban', kind: 'DOCUMENT', reason: 'Coordonnées bancaires lues dans un document (jamais sur la fiche).' },
  { key: 'bic', kind: 'DOCUMENT', reason: 'Coordonnées bancaires lues dans un document.' },
  { key: 'accountNumber', kind: 'DOCUMENT', reason: 'Coordonnées bancaires lues dans un document.' },
  { key: 'bonusMalus', kind: 'DOCUMENT', reason: 'Coefficient bonus-malus d’un avis d’échéance auto.' },
  // Informations complémentaires des exports (D-12) — `lib/assets/additional-infos.ts`.
  ...[
    'desiredSalePriceCents', 'newPriceCents', 'salePitch', 'saleConditions', 'availabilityDate', 'availabilityComment',
    'contactInstructions', 'includedAccessories', 'highlights', 'monthlyRentCents', 'monthlyChargesCents', 'chargesMode',
    'depositCents', 'leaseType', 'leaseDuration', 'leaseUsage', 'rentalAreaSqm', 'energyCostMinCents', 'energyCostMaxCents',
    'energyCostReferenceYear', 'rentalConditions', 'rentalPitch', 'insuranceObjective', 'objectiveDetail', 'valueToInsureCents',
    'desiredInsuredAmountCents', 'coverageComment', 'protections', 'occupancyDetails', 'specialItems', 'protectionItems',
    'insuredItems', 'retainedValueCents', 'retainedValueSource', 'retainedValueDate', 'acquisitionFeesCents',
    'estimatedDamageCents', 'compensationCents', 'claimEventKey', 'claimType', 'insurerClaimRef', 'policyReference',
  ].map((key): ExcludedKey => ({ key, kind: 'ADDITIONAL_INFO', reason: 'Information complémentaire des exports (D-12), hors registre.' })),
  // Les anciennes clés « non classées » sont au registre depuis la décision PO
  // D-D (lot 20) : voir la fin de CANONICAL_FIELDS et CONTEXTUAL_ALIASES.
];
