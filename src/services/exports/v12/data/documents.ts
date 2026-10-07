/**
 * Classement des pièces pour les dossiers V12 : format, intégrabilité,
 * nature (types de la matrice §24), sensibilité (DEC-006, SEL-GEN-007) et
 * données d'occupant (garde-fou des maquettes).
 *
 * Règles déterministes (DEC-004), sans IA. Sources, par priorité :
 *   1. `document_type_code` (référentiel V2) ;
 *   2. `retained_function_code` puis `document_type` (codes V1) ;
 *   3. le titre / nom de fichier, UNIQUEMENT pour durcir : un mot-clé peut
 *      rendre une pièce sensible ou « occupant », jamais l'inverse.
 */

import { DOCUMENT_TYPE_LABELS } from '@/lib/document-type-constants';
import { resolveDocumentCode } from '@/lib/referential/document-codes';

/** Formats intégrables dans le PDF (SEL-GEN-003). */
export const INTEGRABLE = new Set(['PDF', 'JPG', 'JPEG', 'PNG', 'WEBP']);
export const IMAGE_FORMATS = new Set(['JPG', 'JPEG', 'PNG', 'WEBP']);

/** Nature d'une pièce (lignes de la matrice §24). */
export type DocKind =
  | 'FACTURE' | 'DEVIS' | 'GARANTIE' | 'MANUEL' | 'CONTRAT' | 'ATTESTATION_ASSURANCE'
  | 'DPE' | 'AUDIT_ENERGETIQUE' | 'AMIANTE' | 'PLOMB' | 'TERMITES' | 'GAZ' | 'ELECTRICITE' | 'ASSAINISSEMENT' | 'ERNMT'
  | 'SURFACE_CARREZ' | 'PERMIS_CONSTRUIRE' | 'PLAN_CONSTRUCTION' | 'PLAN_CADASTRAL' | 'RESEAU' | 'ENERGIE_TECHNIQUE'
  | 'RAPPORT_ENTRETIEN' | 'EXPERTISE' | 'SINISTRE' | 'ECHANGE_ASSUREUR' | 'CARTE_GRISE' | 'CONTROLE_TECHNIQUE'
  | 'COPROPRIETE' | 'ACTE_NOTARIE' | 'DOCUMENT_BANCAIRE' | 'DOCUMENT_IDENTITE' | 'FISCAL' | 'LOCATIF'
  | 'PHOTO' | 'AUTRE';

/** Natures sensibles : proposées, jamais pré-cochées (DEC-006, matrice §24). */
export const SENSITIVE_KINDS: ReadonlySet<DocKind> = new Set(['ACTE_NOTARIE', 'DOCUMENT_BANCAIRE', 'DOCUMENT_IDENTITE', 'FISCAL']);

/**
 * Pièces locatives (bail, état des lieux, quittances…) : elles portent les
 * données d'un occupant ou d'un ancien locataire et ne sont JAMAIS rendues,
 * même cochées (garde-fou des maquettes, `selected()`).
 */
export const OCCUPANT_KINDS: ReadonlySet<DocKind> = new Set(['LOCATIF']);

const V2_KIND: Record<string, DocKind> = {
  ACQUISITION_INVOICE: 'FACTURE', MAINTENANCE_INVOICE: 'FACTURE', REPAIR_INVOICE: 'FACTURE', WORKS_INVOICE: 'FACTURE', SUBSCRIPTION_INVOICE: 'FACTURE',
  ACQUISITION_ORDER: 'FACTURE', ACQUISITION_DELIVERY: 'FACTURE', WORKS_PURCHASE_ORDER: 'FACTURE', WORKS_DELIVERY_NOTE: 'FACTURE',
  MAINTENANCE_QUOTE: 'DEVIS', REPAIR_QUOTE: 'DEVIS', WORKS_QUOTE: 'DEVIS',
  WARRANTY_CERTIFICATE: 'GARANTIE', EXTENDED_WARRANTY: 'GARANTIE',
  USER_MANUAL: 'MANUEL', TECHNICAL_SHEET: 'MANUEL', SOFTWARE_LICENSE: 'MANUEL',
  SERVICE_CONTRACT: 'CONTRAT', SUBSCRIPTION_CONTRACT: 'CONTRAT', MAINTENANCE_CONTRACT: 'CONTRAT',
  INSURANCE_POLICY: 'ATTESTATION_ASSURANCE', INSURANCE_CERTIFICATE: 'ATTESTATION_ASSURANCE', INSURANCE_DUE_NOTICE: 'ATTESTATION_ASSURANCE',
  CLAIM_DECLARATION: 'SINISTRE', CLAIM_REPORT: 'SINISTRE', CLAIM_APPRAISAL: 'SINISTRE', CLAIM_INDEMNITY: 'SINISTRE',
  CLAIM_CORRESPONDENCE: 'ECHANGE_ASSUREUR',
  DPE: 'DPE', ENERGY_AUDIT: 'AUDIT_ENERGETIQUE', ASBESTOS_DIAGNOSTIC: 'AMIANTE', LEAD_DIAGNOSTIC: 'PLOMB', TERMITE_DIAGNOSTIC: 'TERMITES',
  GAS_DIAGNOSTIC: 'GAZ', ELECTRICITY_DIAGNOSTIC: 'ELECTRICITE', SANITATION_DIAGNOSTIC: 'ASSAINISSEMENT', RISK_STATEMENT: 'ERNMT',
  CARREZ_CERTIFICATE: 'SURFACE_CARREZ', BUILDING_PERMIT: 'PERMIS_CONSTRUIRE', WORKS_PLAN: 'PLAN_CONSTRUCTION', ASSET_REFERENCE_PLAN: 'PLAN_CONSTRUCTION',
  CADASTRAL_PLAN: 'PLAN_CADASTRAL', RE2020_CERTIFICATE: 'ENERGIE_TECHNIQUE', BUILDING_LABEL_CERTIFICATE: 'ENERGIE_TECHNIQUE',
  MAINTENANCE_REPORT: 'RAPPORT_ENTRETIEN', INTERVENTION_REPORT: 'RAPPORT_ENTRETIEN', MAINTENANCE_LOG: 'RAPPORT_ENTRETIEN', INSTALLATION_REPORT: 'RAPPORT_ENTRETIEN',
  SAFETY_CONTROL_REPORT: 'RAPPORT_ENTRETIEN', GENERAL_TECHNICAL_DIAGNOSTIC: 'RAPPORT_ENTRETIEN', COMPLIANCE_CERTIFICATE: 'RAPPORT_ENTRETIEN',
  CE_DECLARATION: 'MANUEL', CALIBRATION_CERTIFICATE: 'RAPPORT_ENTRETIEN',
  VEHICLE_TECHNICAL_INSPECTION: 'CONTROLE_TECHNIQUE', REGISTRATION_CERTIFICATE: 'CARTE_GRISE', ADMIN_STATUS_CERTIFICATE: 'CARTE_GRISE',
  VALUE_ESTIMATE: 'EXPERTISE', VALUE_APPRAISAL: 'EXPERTISE', VALUED_INVENTORY: 'EXPERTISE', AUTHENTICITY_CERTIFICATE: 'EXPERTISE', PROVENANCE_PROOF: 'EXPERTISE',
  PROPERTY_TITLE: 'ACTE_NOTARIE', TRANSACTION_ACT: 'ACTE_NOTARIE', TRANSFER_CERTIFICATE: 'ACTE_NOTARIE',
  FINANCING_CONTRACT: 'DOCUMENT_BANCAIRE', FINANCING_SCHEDULE: 'DOCUMENT_BANCAIRE', FINANCING_GUARANTEE: 'DOCUMENT_BANCAIRE',
  LEASING_FINANCING_CONTRACT: 'DOCUMENT_BANCAIRE', ACQUISITION_PAYMENT: 'DOCUMENT_BANCAIRE', WORKS_PAYMENT_PROOF: 'DOCUMENT_BANCAIRE',
  PROPERTY_TAX_NOTICE: 'FISCAL',
  COPRO_RULES: 'COPROPRIETE', COPRO_AG_MINUTES: 'COPROPRIETE', COPRO_CALL_FUNDS: 'COPROPRIETE', CHARGE_STATEMENT: 'COPROPRIETE', CHARGE_RECEIPT: 'COPROPRIETE',
  RENTAL_LEASE: 'LOCATIF', RENTAL_LEASE_AMENDMENT: 'LOCATIF', MOVE_IN_REPORT: 'LOCATIF', MOVE_OUT_REPORT: 'LOCATIF', RENT_RECEIPT: 'LOCATIF',
  SECURITY_DEPOSIT_RECEIPT: 'LOCATIF', RENTAL_CHARGE_ADJUSTMENT: 'LOCATIF', RENTAL_MANAGEMENT_STATEMENT: 'LOCATIF', RENTAL_CORRESPONDENCE: 'LOCATIF', OTHER_RENTAL: 'LOCATIF',
  PHOTO: 'PHOTO',
};

/**
 * Codes V1 (et rubriques CIL fines) → nature. Les ANCIENS codes (TITRE_PROPRIETE,
 * PEB, TAXE_FONCIERE, CADASTRE…) n'y figurent plus : ils passent par le
 * résolveur documentaire unique (lot 30), comme partout ailleurs.
 */
const V1_KIND: Record<string, DocKind> = {
  FACTURE: 'FACTURE', DEVIS: 'DEVIS', CONTRAT: 'CONTRAT', GARANTIE: 'GARANTIE', ATTESTATION_ASSURANCE: 'ATTESTATION_ASSURANCE', MANUEL: 'MANUEL',
  RAPPORT_ENTRETIEN: 'RAPPORT_ENTRETIEN', ACTE_TRANSACTION: 'ACTE_NOTARIE',
  PERMIS_CONSTRUIRE: 'PERMIS_CONSTRUIRE', SURFACE_CARREZ: 'SURFACE_CARREZ', EXPERTISE: 'EXPERTISE',
  CONSTAT_SINISTRE: 'SINISTRE', DIAGNOSTIC: 'AUTRE', DPE: 'DPE', AUDIT_ENERGETIQUE: 'AUDIT_ENERGETIQUE', AMIANTE: 'AMIANTE', PLOMB: 'PLOMB',
  TERMITES: 'TERMITES', GAZ: 'GAZ', ELECTRICITE: 'ELECTRICITE', ASSAINISSEMENT: 'ASSAINISSEMENT', ERNMT: 'ERNMT',
  PLAN_CONSTRUCTION: 'PLAN_CONSTRUCTION', PLAN_CADASTRAL: 'PLAN_CADASTRAL',
  RE2020: 'ENERGIE_TECHNIQUE', LABEL_CERTIFICATION: 'ENERGIE_TECHNIQUE',
  ISOLATION_TOITURE: 'ENERGIE_TECHNIQUE', ISOLATION_MURS: 'ENERGIE_TECHNIQUE', ISOLATION_VITRAGE: 'ENERGIE_TECHNIQUE', ISOLATION_PLANCHERS: 'ENERGIE_TECHNIQUE',
  EQUIPEMENT_CHAUFFAGE: 'ENERGIE_TECHNIQUE', EQUIPEMENT_REFROIDISSEMENT: 'ENERGIE_TECHNIQUE', EQUIPEMENT_ECS: 'ENERGIE_TECHNIQUE',
  EQUIPEMENT_VENTILATION: 'ENERGIE_TECHNIQUE', RESEAU_CHALEUR: 'RESEAU',
  RESEAU_EAU: 'RESEAU', RESEAU_ELECTRICITE: 'RESEAU', RESEAU_GAZ: 'RESEAU', RESEAU_AERATION: 'RESEAU',
  PHOTO: 'PHOTO',
};

/** Mots-clés qui rendent une pièce sensible (durcissement uniquement). */
const SENSITIVE_WORDS = /\b(rib|iban|relev[ée]s? (de compte|bancaire)|pi[eè]ce d.identit[ée]|carte (nationale )?d.identit[ée]|cni|passeport|permis de conduire|avis d.imp[oô]t|imp[oô]t sur le revenu|taxe fonci[eè]re|bulletin de (salaire|paie)|acte (de vente|notari[ée]|authentique)|titre de propri[ée]t[ée])\b/i;
/** Mots-clés « occupant » (durcissement uniquement). */
const OCCUPANT_WORDS = /\b(bail|baux|[ée]tat des lieux|quittance|locataire|preneur)\b/i;

export interface DocumentLike {
  id: number;
  documentType?: string | null;
  documentTypeCode?: string | null;
  retainedFunctionCode?: string | null;
  retainedTitle?: string | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  cilRubricCodes?: string[] | null;
}

/** Format d'un fichier (« PDF », « JPG »…) depuis le type MIME, à défaut l'extension. */
export function fileFormatOf(mimeType: string | null | undefined, filename: string | null | undefined): string {
  const m = (mimeType ?? '').toLowerCase();
  if (m === 'application/pdf') return 'PDF';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'JPG';
  if (m === 'image/png') return 'PNG';
  if (m === 'image/webp') return 'WEBP';
  if (m === 'image/heic' || m === 'image/heif') return 'HEIC';
  if (m.includes('wordprocessingml') || m === 'application/msword') return 'DOCX';
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel') return 'XLSX';
  if (m.includes('presentationml') || m === 'application/vnd.ms-powerpoint') return 'PPTX';
  if (m === 'application/zip') return 'ZIP';
  if (m.startsWith('text/')) return 'TXT';
  const ext = (filename ?? '').split('.').pop()?.toUpperCase() ?? '';
  if (ext === 'JPEG') return 'JPG';
  return ext && ext.length <= 5 && ext !== (filename ?? '').toUpperCase() ? ext : 'FICHIER';
}

export const isIntegrable = (format: string | null | undefined): boolean => INTEGRABLE.has(String(format ?? '').toUpperCase());

/** Nature d'un code V1 ou ancien : code V1 exact, sinon sa correspondance V2 certaine, sinon son code V1 de rangement. */
function kindOfLegacyCode(code: string): DocKind | undefined {
  const r = resolveDocumentCode(code);
  return (r.code ? V1_KIND[r.code] : undefined)
    ?? (r.v2Type ? V2_KIND[r.v2Type] : undefined)
    ?? (r.storageCode ? V1_KIND[r.storageCode] : undefined);
}

/** Nature d'une pièce. */
export function documentKind(d: DocumentLike): DocKind {
  const v2 = d.documentTypeCode ? V2_KIND[d.documentTypeCode] : undefined;
  if (v2) return v2;
  for (const c of [d.retainedFunctionCode, d.documentType]) {
    const k = c ? kindOfLegacyCode(c) : undefined;
    if (k && k !== 'AUTRE') return k;
  }
  // `DIAGNOSTIC` générique : rubrique CIL la plus précise si l'IA l'a posée.
  for (const r of d.cilRubricCodes ?? []) {
    const k = V1_KIND[String(r).toUpperCase()];
    if (k && k !== 'AUTRE') return k;
  }
  return 'AUTRE';
}

export interface DocumentClass {
  kind: DocKind;
  sensitive: boolean;
  occupantData: boolean;
}

export function classifyDocument(d: DocumentLike): DocumentClass {
  const kind = documentKind(d);
  const text = `${d.retainedTitle ?? ''} ${d.originalFilename ?? ''}`;
  const occupantData = OCCUPANT_KINDS.has(kind) || OCCUPANT_WORDS.test(text);
  const sensitive = SENSITIVE_KINDS.has(kind) || SENSITIVE_WORDS.test(text);
  return { kind, sensitive, occupantData };
}

/** Libellé de type affiché (« Facture », « DPE »…) ; '' si inconnu. Résolveur documentaire unique (lot 30). */
export function documentTypeLabel(d: DocumentLike): string {
  const v2 = resolveDocumentCode(d.documentTypeCode);
  if (v2.origin === 'V2_TYPE' && v2.label) return v2.label;
  for (const c of [d.retainedFunctionCode, d.documentType]) {
    const v1 = resolveDocumentCode(c).storageCode;
    if (v1 && v1 !== 'AUTRE') return DOCUMENT_TYPE_LABELS[v1] ?? '';
  }
  return '';
}

/** Ton du badge de format (design) : diagnostics énergie ambre, attestations vert, techniques neutre. */
export function documentTone(kind: DocKind): string | undefined {
  if (kind === 'DPE' || kind === 'AUDIT_ENERGETIQUE' || kind === 'ENERGIE_TECHNIQUE') return 'amber';
  if (kind === 'ATTESTATION_ASSURANCE' || kind === 'GARANTIE' || kind === 'CARTE_GRISE') return 'green';
  if (kind === 'MANUEL' || kind === 'PLAN_CONSTRUCTION' || kind === 'PLAN_CADASTRAL' || kind === 'RESEAU') return 'neutral';
  return undefined;
}

/** Titre affiché d'une pièce : titre retenu, sinon nom de fichier sans extension. */
export function documentTitle(d: { retainedTitle?: string | null; originalFilename?: string | null; id: number }): string {
  const t = d.retainedTitle?.trim();
  if (t) return t;
  const f = d.originalFilename?.trim();
  if (f) return f.replace(/\.[a-z0-9]{2,5}$/i, '');
  return `Document ${d.id}`;
}
