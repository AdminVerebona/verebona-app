/**
 * État CIL commun — DTO (lot 111U). Produit par `services/cil/state`
 * (UNE projection), lu par l'onglet Informations, la préparation, le mappeur
 * PDF et le diagnostic BO. Aucun accès base ici : importable côté client.
 */
import type { CilBlockId, CilCategory, CilItemStatus } from './cil-catalog';

export const CIL_STATE_VERSION = 'cil-state-v1';

/** Source d'une valeur : document ouvrable, saisie, décision. */
export interface CilValueSource {
  kind: 'document' | 'user' | 'admin' | 'automatic' | 'rule';
  /** Document (ouvrable) — preuve. */
  fileId?: number | null;
  title?: string | null;
  date?: string | null;
  page?: number | null;
  /** Libellé lisible (« DPE du 12 mars 2025 », « Saisie »). */
  label: string;
}

export interface CilValue {
  label: string;
  value: string;
  source: CilValueSource | null;
}

export interface CilStateItem {
  id: string;
  block: CilBlockId;
  label: string;
  category: CilCategory;
  status: CilItemStatus;
  /** Compté dans l'avancement de sa catégorie (applicable et déterminé). */
  counted: boolean;
  values: CilValue[];
  /** Données manquantes PRÉCISES (statut partiel / manquant). */
  missing: string[];
  /** Explication (à confirmer, contradiction, non applicable, règle). */
  reason: string | null;
  /** Déclaration « Non applicable » (utilisateur) ou règle appliquée. */
  notApplicable: { by: 'user' | 'rule'; justification: string | null } | null;
  naAllowed: boolean;
  blocking: boolean;
  action: { kind: string; label: string; target: string | null } | null;
}

export interface CilProgressDto {
  done: number;
  applicable: number;
  percentage: number;
  renseigne: number;
  partiel: number;
  manquant: number;
  aConfirmer: number;
  nonApplicable: number;
}

export interface CilStateBlock {
  id: CilBlockId;
  label: string;
  status: CilItemStatus;
  items: CilStateItem[];
  /** Information affichée (déclaration neutralisée, plusieurs DPE…). */
  notice: string | null;
}

export interface CilState {
  version: typeof CIL_STATE_VERSION;
  assetId: number;
  computedAt: string;
  /** Avancement sur les obligations applicables (OBLIGATOIRE + CONDITIONNEL). */
  regulatory: CilProgressDto;
  /** Couverture complémentaire (informations proposées par Verebona), séparée. */
  complement: CilProgressDto;
  blocks: CilStateBlock[];
  /** Équipements retenus pour B6 (règle partagée `classifyCilEnergyEquipment`). */
  energyEquipmentIds: number[];
  /** Recommandations de travaux lues dans les diagnostics : JAMAIS des travaux réalisés. */
  recommendations: { count: number; sourceFileIds: number[] };
  /** Documents cités (sources ouvrables), une seule fois chacun. */
  documents: Array<{ id: number; title: string; date: string | null; kind: string }>;
  /** B7 : travaux RÉALISÉS (saisis, ou Opérations prouvées par facture / attestation). Absent d'un état antérieur. */
  works?: CilStateWork[];
}

export interface CilStateWork {
  kind: 'energy_works' | 'operation';
  id: number;
  title: string;
  date: string | null;
  company: string | null;
  /** Catégories `energy_works.category` (isolation_toiture, chauffage…). */
  categories: string[];
  /** Pièces justificatives (facture, attestation). */
  fileIds: number[];
}
