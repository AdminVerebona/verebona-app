/**
 * Carte #807 (E01 – E04) — LIBELLÉS compris par l'Assistant pour les champs d'un équipement, d'une échéance de
 * l'Agenda et d'un fournisseur (pur). Les CLÉS sont celles des fiches existantes : `EQUIPMENT_FICHE_FIELDS`
 * (fiche d'un équipement), le tiroir de l'Agenda, `SUPPLIER_EDITABLE_FIELDS` (fiche fournisseur). Aucune règle
 * métier ici : seulement les mots par lesquels un utilisateur nomme un champ. Un test vérifie l'alignement.
 */
import type { LabelDef } from './labelled-values';
import type { SupplierCommandField } from './catalog';

/** Champs d'un équipement : colonnes de la fiche, clés de `EQUIPMENT_FICHE_FIELDS`, pièce et bien parent. */
export type EquipmentLabelKey =
  | 'name' | 'type' | 'category' | 'status' | 'energyUsage' | 'purchasePriceCents' | 'estimatedValueCents'
  | 'brand' | 'productSeries' | 'modelName' | 'productReference' | 'productDesignation' | 'serialNumber'
  | 'powerKw' | 'cop' | 'refrigerant' | 'hourMeter'
  | 'room' | 'asset';

// L'ordre compte : le libellé le plus long d'abord (« série du produit » avant « numéro de série »).
export const EQUIPMENT_LABELS: ReadonlyArray<LabelDef<EquipmentLabelKey>> = [
  { key: 'productSeries', re: String.raw`serie du produit|gamme` },
  { key: 'serialNumber', re: String.raw`numero de serie|n° de serie|no de serie|n de serie|n°\s?serie` },
  { key: 'productReference', re: String.raw`reference commerciale|reference` },
  { key: 'productDesignation', re: String.raw`designation commerciale|designation` },
  { key: 'purchasePriceCents', re: String.raw`prix d'achat|prix` },
  { key: 'estimatedValueCents', re: String.raw`valeur estimee|valeur` },
  { key: 'energyUsage', re: String.raw`usage energetique` },
  { key: 'refrigerant', re: String.raw`fluide frigorigene|fluide` },
  { key: 'hourMeter', re: String.raw`compteur horaire|compteur` },
  { key: 'powerKw', re: String.raw`puissance` },
  { key: 'cop', re: String.raw`cop` },
  { key: 'brand', re: String.raw`marque` },
  { key: 'modelName', re: String.raw`modele` },
  { key: 'category', re: String.raw`categorie` },
  { key: 'status', re: String.raw`statut|etat` },
  { key: 'type', re: String.raw`type` },
  { key: 'name', re: String.raw`nom` },
  { key: 'room', re: String.raw`piece` },
  { key: 'asset', re: String.raw`bien parent|bien` },
];

export type AgendaLabelKey =
  | 'title' | 'description' | 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'situation' | 'noDeadline'
  | 'asset' | 'room' | 'equipment' | 'document';

export const AGENDA_LABELS: ReadonlyArray<LabelDef<AgendaLabelKey>> = [
  { key: 'noDeadline', re: String.raw`sans echeance` },
  { key: 'endDate', re: String.raw`date de fin` },
  { key: 'endTime', re: String.raw`heure de fin|horaire de fin` },
  { key: 'startTime', re: String.raw`heure de debut|horaire de debut|heure|horaire` },
  { key: 'startDate', re: String.raw`date de debut|date` },
  { key: 'situation', re: String.raw`situation` },
  { key: 'description', re: String.raw`description|notes?` },
  { key: 'title', re: String.raw`titre|intitule` },
  { key: 'equipment', re: String.raw`equipement` },
  { key: 'document', re: String.raw`document` },
  { key: 'room', re: String.raw`piece` },
  { key: 'asset', re: String.raw`bien` },
];

// « adresse e-mail » avant « adresse » ; « complément d'adresse » avant « adresse ».
export const SUPPLIER_LABELS: ReadonlyArray<LabelDef<SupplierCommandField>> = [
  { key: 'email', re: String.raw`adresse e-mail|adresse email|adresse mail|e-mail|email|mail|courriel` },
  { key: 'addressLine2', re: String.raw`complement d'adresse|complement` },
  { key: 'addressLine1', re: String.raw`adresse postale|adresse` },
  { key: 'postalCode', re: String.raw`code postal` },
  { key: 'city', re: String.raw`ville|commune` },
  { key: 'country', re: String.raw`pays` },
  { key: 'siren', re: String.raw`numero siren|siren` },
  { key: 'siret', re: String.raw`numero siret|siret` },
  { key: 'vatNumber', re: String.raw`numero de tva|n° de tva|tva intracommunautaire|tva` },
  { key: 'ibanHolderName', re: String.raw`titulaire du compte|titulaire` },
  { key: 'iban', re: String.raw`iban|rib|coordonnees bancaires` },
  { key: 'phone', re: String.raw`numero de telephone|telephone|portable|tel` },
  { key: 'website', re: String.raw`site internet|site web|site` },
  { key: 'name', re: String.raw`nom` },
];
