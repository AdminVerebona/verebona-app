/**
 * Contrats de données des six templates V12 (CDC Exports V12 §19.1).
 *
 * Reprise typée des `data-example.json` et des README des maquettes validées
 * (`maquettes/<dossier>/README.md`, section « Contrat de données ») : un
 * template ne lit QUE ces clés. Les mappeurs (`data/mappers/*`) produisent ces
 * objets à partir du bien, des informations complémentaires et des choix de
 * l'utilisateur.
 *
 * Conventions (PDF-TXT-005/006, IC-GEN-006/007) : montants en centimes,
 * dates ISO (`YYYY-MM-DD`, `YYYY-MM`, `YYYY`) ou date-heure ISO avec fuseau.
 * Toute valeur vide (null, '', []) est masquée au rendu (PDF-TXT-002).
 *
 * `asset.valuation` / `asset.rentalEstimate` (estimations Verebona) existent
 * dans les données d'exemple pour prouver qu'elles ne sont JAMAIS lues : les
 * mappeurs ne les renseignent jamais et aucun template ne les lit.
 */

import type { DossierCode } from '@/services/exports/catalog';

export type Nullable<T> = T | null | undefined;

/** Ton d'une pastille (statuts, échéances). */
export type Tone = 'ok' | 'warn' | 'bad' | 'blue' | '' | undefined;

export interface ToneLabel {
  label: string;
  tone?: Tone;
}

/** Méta de génération (couverture, en-tête, page Références). */
export interface ExportInfo {
  type: string;
  label?: string;
  reference?: Nullable<string>;
  /** Date-heure ISO avec fuseau, heure de Paris (`2026-09-28T09:14:00+02:00`). */
  generatedAt: string;
  preparedBy?: Nullable<string>;
  /** Libellé affiché « cil · v1.0 ». */
  templateVersion?: Nullable<string>;
  zipName?: Nullable<string>;
}

/** Aperçu d'une pièce intégrée (pages d'annexe). */
export interface DocPreview {
  kind?: 'pdf' | 'image' | 'plan' | string;
  note?: Nullable<string>;
  /**
   * Une entrée par page source. `src` : image posée en *contain* (image
   * intégrée) ; `overlay` : cadre vide, la page PDF source y est apposée en
   * vectoriel après le rendu (pdf-lib, `render/annexes.ts`).
   */
  pages?: Array<{ src?: Nullable<string>; overlay?: boolean }>;
}

/** Pièce proposée (document) — contrat commun §19.1. */
export interface DocItem {
  id: string;
  section?: Nullable<string>;
  title: string;
  typeLabel?: Nullable<string>;
  date?: Nullable<string>;
  dateLabel?: Nullable<string>;
  pages?: Nullable<number>;
  format?: Nullable<string>;
  mode?: 'PDF' | 'ZIP' | null;
  selected?: boolean;
  sensitive?: boolean;
  preselected?: boolean;
  occupantData?: boolean;
  corrupted?: boolean;
  tone?: Nullable<string>;
  detail?: Nullable<string>;
  fileName?: Nullable<string>;
  sizeBytes?: Nullable<number>;
  preview?: Nullable<DocPreview>;
  zipTitle?: Nullable<string>;
  zipPath?: Nullable<string>;
  zipPathLabel?: Nullable<string>;
  annexTitle?: Nullable<string>;
  // Sinistre
  kind?: Nullable<string>;
  issuer?: Nullable<string>;
  amountCents?: Nullable<number>;
  count?: Nullable<number>;
}

/** Photo proposée. `file` : clé résolue par `ctx.asset(file)`. */
export interface PhotoItem {
  id: string;
  file: string;
  caption?: Nullable<string>;
  /** Point focal CSS (`50% 40%`), recadrage validé par le design (ANN-PDF-007). */
  focus?: Nullable<string>;
  selected?: boolean;
  sensitive?: boolean;
  occupantData?: boolean;
  corrupted?: boolean;
  cover?: boolean;
  /** Sinistre : référence « P1 », phase avant / sinistre / après. */
  ref?: Nullable<string>;
  phase?: 'before' | 'claim' | 'after' | string | null;
}

/** Élément sélectionnable générique (historique, échéances…). */
export interface Selectable {
  id?: string;
  selected?: boolean;
  occupantData?: boolean;
  corrupted?: boolean;
}

export interface AssetBase {
  id?: number;
  family: string;
  name: string;
  shortName?: Nullable<string>;
  titleLines?: string[];
  categoryLabel?: Nullable<string>;
  /**
   * Lignes « Informations principales » fournies par le mappeur quand la
   * famille du bien n'est pas celle du design (ex. kit de vente d'un
   * appartement : le design est maquetté sur un vélo cargo). Absent : lignes
   * du design.
   */
  infoRows?: Array<{ label: string; value: Nullable<string | number> }>;
  /** Jamais lu (estimation Verebona) — présent dans les données d'exemple seulement. */
  valuation?: unknown;
  rentalEstimate?: unknown;
}

interface CaseBase {
  export: ExportInfo;
  documents?: DocItem[];
  photos?: PhotoItem[];
  /** Contrôle de rendu (maquettes) : chaînes absentes du PDF. */
  mustNotAppear?: string[];
}

// ─── CIL ────────────────────────────────────────────────────────────────────

export type CilBlockStatus = 'complete' | 'unknown' | 'missing' | 'invalid' | 'not_applicable';

export interface CilData extends CaseBase {
  asset: AssetBase & {
    typeLabel?: Nullable<string>;
    location?: { address1?: Nullable<string>; postalCode?: Nullable<string>; city?: Nullable<string> };
    livingAreaSqm?: Nullable<number>;
    floorLotLabel?: Nullable<string>;
    constructionYear?: Nullable<number | string>;
  };
  cil: {
    blocks: Array<{ code: string; status: CilBlockStatus; source?: Nullable<string>; resolution?: Nullable<string>; label?: Nullable<string> }>;
    notApplicableNote?: Nullable<string>;
    profile?: { triggerLabel?: Nullable<string>; triggerDate?: Nullable<string>; authorization?: Nullable<string>; reason?: Nullable<string> };
    networks?: Array<{ network: string; element?: Nullable<string>; docId?: Nullable<string>; status: string | ToneLabel }>;
    materials?: Array<{ post: string; material?: Nullable<string>; spec?: Nullable<string>; source?: Nullable<string> }>;
    equipments?: Array<{ usage: string; equipment?: Nullable<string>; model?: Nullable<string>; installed?: Nullable<string> }>;
    works?: Array<{ date?: Nullable<string>; title: string; description?: Nullable<string>; company?: Nullable<string>; status?: Nullable<ToneLabel> }>;
    energy?: { dpe?: Nullable<string>; ges?: Nullable<string>; consumption?: Nullable<string>; emissions?: Nullable<string>; date?: Nullable<string>; validUntil?: Nullable<string> };
  };
}

// ─── Dossier complet ────────────────────────────────────────────────────────

export interface DossierCompletData extends CaseBase {
  asset: AssetBase & {
    fields?: {
      typeLabel?: Nullable<string>; livingAreaSqm?: Nullable<number>; address1?: Nullable<string>; roomsLabel?: Nullable<string>;
      postalCode?: Nullable<string>; city?: Nullable<string>; floorLabel?: Nullable<string>; constructionYear?: Nullable<number | string>;
      conditionLabel?: Nullable<string>; dpe?: Nullable<string>; ges?: Nullable<string>; heatingLabel?: Nullable<string>;
      coproLabel?: Nullable<string>; equipmentSummary?: Nullable<string>; equipmentChips?: string[];
    };
  };
  summary?: { asset?: Nullable<string>; status?: Nullable<string>; condition?: Nullable<string> };
  finance?: {
    enabled: boolean;
    acquisition?: { priceCents?: Nullable<number>; deedDate?: Nullable<string> };
    retainedValue?: { amountCents?: Nullable<number>; sourceLabel?: Nullable<string>; date?: Nullable<string> };
    lines?: Array<Selectable & { label: string; date?: Nullable<string>; amountCents: number; kind: 'acquisition' | 'works' | string }>;
    charges?: Array<{ label: string; amountCents?: Nullable<number>; period?: Nullable<string> }>;
  } | null;
  history?: Array<Selectable & { date?: Nullable<string>; title: string; typeLabel?: Nullable<string>; provider?: Nullable<string> }>;
  deadlines?: Array<Selectable & { title: string; date: string }>;
  contracts?: Array<Selectable & { title: string; detail?: Nullable<string> }>;
}

// ─── Vente ──────────────────────────────────────────────────────────────────

export interface VenteData extends CaseBase {
  asset: AssetBase & {
    fields?: {
      brand?: Nullable<string>; model?: Nullable<string>; modelYear?: Nullable<number | string>; purchaseDate?: Nullable<string>;
      purchaseCondition?: Nullable<string>; frameNumber?: Nullable<string>; color?: Nullable<string>; markingLabel?: Nullable<string>;
      mileageKm?: Nullable<number>; mileageDate?: Nullable<string>; motorLabel?: Nullable<string>; batteryLabel?: Nullable<string>;
      transmissionLabel?: Nullable<string>; conditionLabel?: Nullable<string>; parkingLabel?: Nullable<string>; locationLabel?: Nullable<string>;
    };
  };
  summary?: Nullable<string>;
  sale?: {
    pitch?: Nullable<string>; desiredPriceCents?: Nullable<number>; newPriceCents?: Nullable<number>;
    availabilityDate?: Nullable<string>; availabilityComment?: Nullable<string>; includedAccessories?: Nullable<string>;
    saleConditions?: Nullable<string>; contactInstructions?: Nullable<string>;
  };
  highlights?: Array<Selectable & { title: string; text?: Nullable<string> }>;
  followUp?: Array<Selectable & { date?: Nullable<string>; title: string; mileageKm?: Nullable<number>; provider?: Nullable<string> }>;
  documentsNote?: Nullable<string>;
}

// ─── Location ───────────────────────────────────────────────────────────────

export type LeaseType = 'NON_MEUBLE' | 'MEUBLE' | 'MOBILITE' | 'ETUDIANT' | 'SAISONNIER' | 'AUTRE';

export interface LocationData extends CaseBase {
  asset: AssetBase & {
    fields?: {
      livingAreaSqm?: Nullable<number>; roomsLabel?: Nullable<string>; locationLabel?: Nullable<string>; floorLabel?: Nullable<string>;
      conditionLabel?: Nullable<string>; dpe?: Nullable<string>; ges?: Nullable<string>; exposure?: Nullable<string>; transport?: Nullable<string>;
      address1?: Nullable<string>;
    };
  };
  summary?: Nullable<string>;
  rental?: {
    pitch?: Nullable<string>; monthlyRentCents?: Nullable<number>; monthlyChargesCents?: Nullable<number>; chargesLabel?: Nullable<string>;
    depositCents?: Nullable<number>; leaseType?: Nullable<LeaseType | string>; leaseDurationLabel?: Nullable<string>; leaseUsageLabel?: Nullable<string>;
    rentalAreaSqm?: Nullable<number>; availabilityDate?: Nullable<string>; availabilityComment?: Nullable<string>;
    rentalConditions?: Nullable<string>; contactInstructions?: Nullable<string>;
  };
  equipments?: string[];
  energy?: { dpe?: Nullable<string>; consumption?: Nullable<string>; ges?: Nullable<string>; heating?: Nullable<string>; hotWater?: Nullable<string>; ventilation?: Nullable<string>; parking?: Nullable<string> };
  followUp?: Array<Selectable & { date?: Nullable<string>; title: string; provider?: Nullable<string>; costCents?: Nullable<number> }>;
}

// ─── Assurance souscription ─────────────────────────────────────────────────

export interface SouscriptionData extends CaseBase {
  asset: AssetBase & {
    fields?: {
      categoryLabel?: Nullable<string>; serialNumber?: Nullable<string>; brand?: Nullable<string>; model?: Nullable<string>;
      purchaseDate?: Nullable<string>; purchaseCondition?: Nullable<string>; dimensions?: Nullable<string>; seller?: Nullable<string>;
      usageLabel?: Nullable<string>; storageLabel?: Nullable<string>; conditionLabel?: Nullable<string>; transportLabel?: Nullable<string>;
    };
  };
  insurance?: {
    objective?: Nullable<{ code?: Nullable<string>; headline: string; detail?: Nullable<string> }>;
    desiredInsuredAmountCents?: Nullable<number>;
    insuredName?: Nullable<string>; contractLabel?: Nullable<string>; accessoriesLabel?: Nullable<string>;
  };
  summary?: Array<{ label: string; value: Nullable<string>; strong?: boolean }>;
  items?: Array<Selectable & { kind: 'main' | 'accessory' | string; label: string; valueCents?: Nullable<number>; docId?: Nullable<string>; proofLabel?: Nullable<string>; proofDate?: Nullable<string> }>;
  protections?: Array<Selectable & { title: string; text?: Nullable<string> }>;
  condition?: Array<Selectable & { date?: Nullable<string>; title: string; aside?: Nullable<string> }>;
}

// ─── Assurance sinistre ─────────────────────────────────────────────────────

export interface SinistreData extends CaseBase {
  asset: AssetBase & { addressLabel?: Nullable<string> };
  claim?: {
    typeLabel?: Nullable<string>; date?: Nullable<string>; declaredAt?: Nullable<string>; contractLabel?: Nullable<string>;
    insurerRef?: Nullable<string>; statusLabel?: Nullable<string>; circumstances?: Nullable<string>; consequences?: Nullable<string>;
    measures?: Nullable<string>; statusDetail?: Nullable<string>;
  };
  timeline?: Array<Selectable & { date?: Nullable<string>; dateLabel?: Nullable<string>; tone?: 'past' | 'key' | 'open' | string | null; title: string; text?: Nullable<string> }>;
  damages?: Array<Selectable & { zone?: Nullable<string>; element?: Nullable<string>; finding?: Nullable<string>; photoRefs?: Nullable<string> }>;
  actions?: Array<Selectable & { date?: Nullable<string>; whenLabel?: Nullable<string>; title: string; text?: Nullable<string> }>;
  exchanges?: Array<Selectable & { date?: Nullable<string>; title: string; channel?: Nullable<string>; docId?: Nullable<string>; linkedToClaim?: boolean }>;
}

export interface DossierDataMap {
  CIL: CilData;
  DOSSIER_COMPLET: DossierCompletData;
  VENTE: VenteData;
  LOCATION: LocationData;
  ASSURANCE_SOUSCRIPTION: SouscriptionData;
  ASSURANCE_SINISTRE: SinistreData;
}

export type AnyDossierData = DossierDataMap[DossierCode];

/** Carte des pages, fournie au 2ᵉ passage du rendu. */
export interface PageMap {
  total: number;
  annexStart: Record<string, number>;
}

/** Contexte de rendu d'un template (équivalent du `ctx` des maquettes). */
export interface RenderContext {
  /** URL (se terminant par « / ») du répertoire statique (`static/`). */
  sys: string;
  /** Résout la clé d'une photo (`PhotoItem.file`) en URL chargeable. */
  asset: (file: string | null | undefined) => string | null;
  stylesheets: string[];
  pageMap: PageMap | null;
}

export interface RenderedHtml {
  title: string;
  html: string;
}
