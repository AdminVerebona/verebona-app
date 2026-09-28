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

export const ADDITIONAL_INFO_SECTIONS: readonly AdditionalInfoSectionKey[] = ['commercial', 'rental', 'insurance', 'claim'];

export const ADDITIONAL_INFO_SECTION_LABELS: Readonly<Record<AdditionalInfoSectionKey, string>> = {
  commercial: 'Informations commerciales',
  rental: 'Informations locatives',
  insurance: 'Informations assurance',
  claim: 'Sinistre',
};

export const ADDITIONAL_INFO_SECTION_DESCRIPTIONS: Readonly<Record<AdditionalInfoSectionKey, string>> = {
  commercial: 'Reprises dans le kit de mise en vente.',
  rental: 'Reprises dans le dossier de mise en location.',
  insurance: "Reprises dans le dossier d'assurance (souscription ou mise à jour).",
  claim: "Reprises dans le dossier d'assurance sinistre / indemnisation.",
};

/** Sous-rubriques visibles par famille (§4.2) : pas de location véhicule ni objet en V1. */
export const SECTIONS_BY_FAMILY: Readonly<Record<ExportFamily, readonly AdditionalInfoSectionKey[]>> = {
  IMMOBILIER: ['commercial', 'rental', 'insurance', 'claim'],
  VEHICULE: ['commercial', 'insurance', 'claim'],
  OBJET: ['commercial', 'insurance', 'claim'],
};

/** Sous-rubriques visibles pour une catégorie de bien stockée (`OBJECT`…). */
export function sectionsForCategory(category: string | null | undefined): readonly AdditionalInfoSectionKey[] {
  const f = toExportFamily(category);
  return f ? SECTIONS_BY_FAMILY[f] : [];
}

// ── Dictionnaire des champs ─────────────────────────────────────────────────

export type AdditionalInfoFieldType = 'money' | 'text' | 'textarea' | 'date' | 'enum' | 'decimal' | 'year';

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
}

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

  // ── Sinistre (maquette assurance-sinistre `claim`) ────────────────────────
  { section: 'claim', key: 'claimType', type: 'enum', label: 'Type de sinistre', options: CLAIM_TYPE_OPTIONS, recommended: true },
  { section: 'claim', key: 'occurredOn', type: 'date', label: 'Date du sinistre', recommended: true },
  { section: 'claim', key: 'declaredOn', type: 'date', label: "Date de déclaration à l'assureur" },
  { section: 'claim', key: 'insurerClaimRef', type: 'text', label: 'Référence du dossier sinistre' },
  { section: 'claim', key: 'policyReference', type: 'text', label: 'Contrat concerné', help: 'Seulement s’il diffère du contrat indiqué dans la fiche.' },
  { section: 'claim', key: 'status', type: 'enum', label: 'Avancement', options: CLAIM_STATUS_OPTIONS },
  { section: 'claim', key: 'statusDetail', type: 'text', label: "Précision sur l'avancement" },
  { section: 'claim', key: 'circumstances', type: 'textarea', label: 'Circonstances' },
  { section: 'claim', key: 'consequences', type: 'textarea', label: 'Dommages constatés' },
  { section: 'claim', key: 'measures', type: 'textarea', label: 'Mesures conservatoires et actions réalisées' },
  { section: 'claim', key: 'exchangesSummary', type: 'textarea', label: "Échanges avec l'assureur ou l'expert" },
  { section: 'claim', key: 'estimatedDamageCents', type: 'money', label: 'Montant estimé des dommages' },
  { section: 'claim', key: 'compensationCents', type: 'money', label: 'Indemnité reçue' },
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

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1900 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Schéma zod d'une valeur NON vide pour un champ. */
export function valueSchema(def: AdditionalInfoFieldDef): z.ZodType<string | number> {
  switch (def.type) {
    case 'money':
      return z.number({ error: 'Montant invalide.' })
        .int({ error: 'Le montant doit être exprimé en centimes entiers.' })
        .min(0, { error: 'Le montant ne peut pas être négatif.' })
        .max(MONEY_MAX_CENTS, { error: 'Montant trop élevé.' });
    case 'decimal':
      return z.number({ error: 'Nombre invalide.' })
        .gt(0, { error: 'La valeur doit être positive.' })
        .max(100_000, { error: 'Valeur trop élevée.' })
        .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, { error: 'Deux décimales au plus.' });
    case 'year':
      return z.number({ error: 'Année invalide.' }).int({ error: 'Année invalide.' }).min(1990, { error: 'Année invalide.' }).max(2100, { error: 'Année invalide.' });
    case 'date':
      return z.string({ error: 'Date invalide.' }).refine(isValidIsoDate, { error: 'Date invalide (format attendu AAAA-MM-JJ).' });
    case 'enum': {
      const values = (def.options ?? []).map((o) => o.value);
      return z.string({ error: 'Valeur invalide.' }).refine((v) => values.includes(v), { error: 'Valeur non proposée.' });
    }
    case 'textarea':
      return z.string({ error: 'Texte invalide.' }).max(TEXTAREA_MAX, { error: `${TEXTAREA_MAX} caractères au plus.` });
    case 'text':
    default:
      return z.string({ error: 'Texte invalide.' }).max(TEXT_MAX, { error: `${TEXT_MAX} caractères au plus.` });
  }
}

export type AdditionalInfoValue = string | number;
export type AdditionalInfoSectionData = Record<string, AdditionalInfoValue>;

export interface AdditionalInfosData {
  commercial: AdditionalInfoSectionData;
  rental: AdditionalInfoSectionData;
  insurance: AdditionalInfoSectionData;
  claim: AdditionalInfoSectionData;
}

/** Correctif : `null` (ou chaîne vide) retire le champ (IC-GEN-009). */
export type AdditionalInfosPatch = Partial<Record<AdditionalInfoSectionKey, Record<string, AdditionalInfoValue | null>>>;

export interface NormalizedPatch {
  /** Valeurs à écrire, par sous-rubrique. */
  set: Partial<Record<AdditionalInfoSectionKey, AdditionalInfoSectionData>>;
  /** Clés à retirer, par sous-rubrique. */
  unset: Partial<Record<AdditionalInfoSectionKey, string[]>>;
}

export interface PatchValidationIssue { path: string; message: string }

export type PatchValidationResult =
  | { ok: true; patch: NormalizedPatch; fieldCount: number }
  | { ok: false; issues: PatchValidationIssue[] };

/** Texte : espaces de bord retirés ; vide ⇒ suppression. */
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
 */
export function validateAdditionalInfosPatch(body: unknown, family: ExportFamily | null): PatchValidationResult {
  const issues: PatchValidationIssue[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, issues: [{ path: '', message: 'Corps attendu : un objet par sous-rubrique.' }] };
  }
  const patch: NormalizedPatch = { set: {}, unset: {} };
  let fieldCount = 0;
  const allowedSections = family ? SECTIONS_BY_FAMILY[family] : ADDITIONAL_INFO_SECTIONS;

  for (const [sectionKey, sectionValue] of Object.entries(body as Record<string, unknown>)) {
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
      const value = normalizeRaw(def, raw);
      fieldCount++;
      if (value === null || value === undefined) {
        (patch.unset[section] ??= []).push(key);
        continue;
      }
      const applicable = allowedSections.includes(section) && (!def.families || !family || def.families.includes(family));
      if (!applicable) { issues.push({ path, message: "Champ non applicable à ce bien." }); continue; }
      const parsed = valueSchema(def).safeParse(value);
      if (!parsed.success) {
        issues.push({ path, message: parsed.error.issues[0]?.message ?? 'Valeur invalide.' });
        continue;
      }
      (patch.set[section] ??= {})[key] = parsed.data;
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  if (fieldCount === 0) return { ok: false, issues: [{ path: '', message: 'Aucun champ à enregistrer.' }] };
  return { ok: true, patch, fieldCount };
}

/**
 * Relecture défensive d'une sous-rubrique stockée : seules les clés connues et
 * les valeurs valides sont rendues (une donnée corrompue n'atteint jamais le
 * PDF ni le formulaire).
 */
export function sanitizeSection(section: AdditionalInfoSectionKey, stored: unknown): AdditionalInfoSectionData {
  const out: AdditionalInfoSectionData = {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [key, raw] of Object.entries(stored as Record<string, unknown>)) {
    const def = findField(section, key);
    if (!def || raw === null || raw === undefined || raw === '') continue;
    const parsed = valueSchema(def).safeParse(raw);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/** Fusion champ par champ (dernier écrit gagne, §4.3 conflictPolicy). */
export function applyPatch(current: AdditionalInfosData, patch: NormalizedPatch): AdditionalInfosData {
  const next: AdditionalInfosData = {
    commercial: { ...current.commercial },
    rental: { ...current.rental },
    insurance: { ...current.insurance },
    claim: { ...current.claim },
  };
  for (const s of ADDITIONAL_INFO_SECTIONS) {
    for (const k of patch.unset[s] ?? []) delete next[s][k];
    Object.assign(next[s], patch.set[s] ?? {});
  }
  return next;
}

export function emptyAdditionalInfos(): AdditionalInfosData {
  return { commercial: {}, rental: {}, insurance: {}, claim: {} };
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
  if (value === undefined || value === null) return '';
  if (def.type === 'money') return typeof value === 'number' ? formatCentsForInput(value) : '';
  if (def.type === 'decimal') return typeof value === 'number' ? formatDecimalForInput(value) : '';
  return String(value);
}
