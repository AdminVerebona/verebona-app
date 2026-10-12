/**
 * Modèle des Opérations métier — vocabulaire fermé et règles pures
 * (CDC Opérations V1 C1.1, C2, C8, C8.1, C12, C13.1, C20, C27).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE DÉFINITION DU VOCABULAIRE
 *
 * Les listes ci-dessous sont celles des contraintes CHECK des migrations
 * 0316 / 0317 (test `o1-modele.test.ts`) : le code refuse avant la base, la
 * base refuse ce que le code aurait laissé passer.
 *
 * Fonctions PURES (aucun accès base) : transitions de statut (C8 / B7),
 * relations parent / enfant autorisées (C8.1 / C13.1), garde « OTHER n'est
 * jamais un repli » (P18, C7.7, INV-FINAL-008), normalisation des références
 * métier (rapprochement M1, C6.1).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { BusinessOperationIntegrityError } from './errors';

// ── Types (C27) ─────────────────────────────────────────────────────────────

export const BUSINESS_OPERATION_TYPE_CODES = [
  'ACQUISITION', 'INTERVENTION', 'CONTRACT', 'FINANCING', 'CLAIM', 'DISPOSAL', 'OTHER',
] as const;
export type BusinessOperationTypeCode = (typeof BUSINESS_OPERATION_TYPE_CODES)[number];

export interface BusinessOperationTypeDefinition {
  code: BusinessOperationTypeCode;
  label: string;
  description: string;
  /** Vide = toutes les familles (C27 : aucune restriction en V1). */
  applicableAssetFamilies: readonly string[];
}

/** Seed de 0316 (même texte : test d'alignement). */
export const BUSINESS_OPERATION_TYPES: readonly BusinessOperationTypeDefinition[] = [
  { code: 'ACQUISITION', label: 'Acquisition / entrée en possession', description: 'Achat, don reçu, succession, transfert de propriété vers le compte, levée d\'option lorsque l\'utilisateur devient propriétaire.', applicableAssetFamilies: [] },
  { code: 'INTERVENTION', label: 'Intervention', description: 'Entretien, réparation, travaux, installation, remplacement, rénovation, contrôle, diagnostic réalisé comme prestation, expertise, inspection.', applicableAssetFamilies: [] },
  { code: 'CONTRACT', label: 'Contrat', description: 'Assurance, abonnement, contrat de maintenance, assistance, location, LLD, LOA, service récurrent.', applicableAssetFamilies: [] },
  { code: 'FINANCING', label: 'Financement', description: 'Crédit, prêt ou financement associé à une acquisition.', applicableAssetFamilies: [] },
  { code: 'CLAIM', label: 'Sinistre', description: 'Accident, dégât, vol, incendie, casse ou événement dommageable, assuré ou non.', applicableAssetFamilies: [] },
  { code: 'DISPOSAL', label: 'Cession / sortie de possession', description: 'Vente, don, transmission, reprise, mise au rebut ou autre sortie définitive et établie.', applicableAssetFamilies: [] },
  { code: 'OTHER', label: 'Autre', description: 'Véritable opération métier qui ne relève d\'aucun autre type après qualification. Jamais une valeur de repli : l\'incertitude se note type nul.', applicableAssetFamilies: [] },
];

export function isBusinessOperationTypeCode(v: unknown): v is BusinessOperationTypeCode {
  return typeof v === 'string' && (BUSINESS_OPERATION_TYPE_CODES as readonly string[]).includes(v);
}

// ── Statuts (C8) ───────────────────────────────────────────────────────────

export const BUSINESS_OPERATION_STATUSES = ['ENVISAGED', 'REALIZED', 'CANCELLED'] as const;
export type BusinessOperationStatus = (typeof BUSINESS_OPERATION_STATUSES)[number];

export function isBusinessOperationStatus(v: unknown): v is BusinessOperationStatus {
  return typeof v === 'string' && (BUSINESS_OPERATION_STATUSES as readonly string[]).includes(v);
}

// ── Sources (C2, C2.1, C20) ────────────────────────────────────────────────

export const SOURCE_KINDS = ['DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Convention de `source_entity_key` (identifiant stable de l'objet source,
 * numérique converti en texte — C20) : DOCUMENT = asset_files.id ; AGENDA =
 * agenda_items.id ; ASSET_DATA et CLAIM_FORM = assets.id (le champ / le
 * dossier précis dans `locator`) ; EQUIPMENT_DATA = equipments.id ;
 * USER_ARBITRATION = to_process_actions.id ; MIGRATION = clé stable dérivée
 * du compte, du bien, du champ et de la version de migration (C23.1).
 */
export const SOURCE_KEY_TABLE: Readonly<Record<SourceKind, string | null>> = {
  DOCUMENT: 'asset_files',
  AGENDA: 'agenda_items',
  ASSET_DATA: 'assets',
  CLAIM_FORM: 'assets',
  EQUIPMENT_DATA: 'equipments',
  USER_ARBITRATION: 'to_process_actions',
  MIGRATION: null,
};

export const SOURCE_ROLES = [
  'QUOTE', 'ORDER', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'REFUND_PROOF', 'PAYMENT_PROOF',
  'CONTRACT_DOCUMENT', 'CLAIM_DOCUMENT', 'SALE_DOCUMENT', 'REPORT', 'OTHER_EVIDENCE',
] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

/** Autorité (vocabulaire C20) : USER > DOCUMENT > STRUCTURED > INFERENCE (9.3). */
export const AUTHORITIES = ['USER', 'DOCUMENT', 'STRUCTURED', 'INFERENCE'] as const;
export type Authority = (typeof AUTHORITIES)[number];

export const CONFIDENCES = ['certain', 'probable', 'conflictual'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const MATCH_METHODS = ['M0', 'M1', 'M2', 'M3'] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export const ASSET_LINK_ROLES = ['PRIMARY', 'CONCERNED'] as const;
export type AssetLinkRole = (typeof ASSET_LINK_ROLES)[number];

// ── Composantes financières (C12) ──────────────────────────────────────────

export const FINANCIAL_COMPONENT_KINDS = ['FORECAST_COST', 'REALIZED_COST', 'REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED'] as const;
export type FinancialComponentKind = (typeof FINANCIAL_COMPONENT_KINDS)[number];

/** Signe économique porté par le rôle, jamais par le montant (C12). */
export const COMPONENT_SIGN: Readonly<Record<FinancialComponentKind, 1 | -1>> = {
  FORECAST_COST: 1, REALIZED_COST: 1, REDUCTION: -1, REFUND: -1, INDEMNITY: -1, PROCEED: -1,
};

export const EVIDENCE_ROLES = ['SUPPORTS', 'CORRECTS', 'SUPERSEDES'] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

// ── Historique (10.7, C20) ─────────────────────────────────────────────────

export const HISTORY_EVENT_TYPES = [
  'CREATED', 'UPDATED', 'TYPE_CHANGED', 'STATUS_CHANGED', 'TARGET_CHANGED', 'FINANCIAL_CHANGED',
  'MERGED', 'INVALIDATED', 'REACTIVATED', 'PARENT_CHANGED', 'SOURCE_ADDED', 'SOURCE_REMOVED',
] as const;
export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

// ── Références métier (écart C20 documenté, 0316) ──────────────────────────

export const REFERENCE_KINDS = ['INVOICE', 'QUOTE', 'ORDER', 'WORK_ORDER', 'CONTRACT', 'POLICY', 'CLAIM', 'LOAN', 'CUSTOMER', 'DELIVERY', 'OTHER'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/**
 * Valeur normalisée d'une référence métier pour le rapprochement EXACT (M1) :
 * majuscules, sans accents, sans espaces ni ponctuation. « FA-2026/001 » et
 * « fa 2026 001 » se rapprochent ; « 2026-001 » et « 2026-0001 » non.
 */
export function normalizeBusinessReference(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// ── Détails par type (C13, C14) ────────────────────────────────────────────

export const CONTRACT_PERIODICITIES = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'MULTIANNUAL', 'ONE_OFF', 'OTHER'] as const;
export type ContractPeriodicity = (typeof CONTRACT_PERIODICITIES)[number];

/** Avancement du dossier assurance (C14.1) — distinct du statut de l'Opération. */
export const CLAIM_FILE_STATUSES = [
  'A_DECLARER', 'DECLARE', 'EXPERTISE_PREVUE', 'EXPERTISE_REALISEE', 'EN_ATTENTE_INDEMNISATION', 'INDEMNISE', 'REFUSE', 'CLOS',
] as const;
export type ClaimFileStatus = (typeof CLAIM_FILE_STATUSES)[number];

/** Table de détail admise par type (C13) ; les autres types n'en ont pas. */
export const DETAILS_TYPE: Readonly<Record<'contract' | 'financing' | 'claim', BusinessOperationTypeCode>> = {
  contract: 'CONTRACT', financing: 'FINANCING', claim: 'CLAIM',
};

// ── Garde « OTHER n'est jamais un repli » (P18, C7.7, INV-FINAL-008) ───────

/**
 * Type demandé à l'API d'écriture.
 *   · `null` : existence établie, qualification encore incertaine (4.1) ;
 *   · un des six types principaux ;
 *   · OTHER : SEULEMENT avec une qualification explicite et certaine (« type
 *     compris mais hors des six catégories », INV-009) et son motif.
 * Aucune autre forme n'est admise : un appelant ne peut pas « tomber » sur
 * OTHER faute de mieux.
 */
export type OperationTypeInput =
  | null
  | { code: Exclude<BusinessOperationTypeCode, 'OTHER'> }
  | { code: 'OTHER'; qualification: { confidence: 'certain'; reason: string } };

/** Valide un type demandé ; rend le code à écrire (ou null). Lève sinon. */
export function resolveOperationTypeInput(input: OperationTypeInput | undefined): BusinessOperationTypeCode | null {
  if (input === null || input === undefined) return null;
  const code = (input as { code?: unknown }).code;
  if (!isBusinessOperationTypeCode(code)) {
    throw new BusinessOperationIntegrityError('UNKNOWN_TYPE', `Type d'Opération inconnu : ${String(code)}.`);
  }
  if (code === 'OTHER') {
    const q = (input as { qualification?: { confidence?: unknown; reason?: unknown } }).qualification;
    if (!q || q.confidence !== 'certain' || typeof q.reason !== 'string' || !q.reason.trim()) {
      throw new BusinessOperationIntegrityError(
        'OTHER_AS_FALLBACK',
        'OTHER exige une qualification explicite et certaine ; une qualification incertaine se note type nul (P18).',
      );
    }
  }
  return code;
}

/**
 * Indice de type venu d'une extraction (T1, `typeHint`) : un des 7 codes
 * EXACTEMENT, sinon null. Jamais OTHER par défaut pour une valeur inconnue,
 * vide ou ambiguë.
 */
export function normalizeOperationTypeHint(raw: unknown): BusinessOperationTypeCode | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  return isBusinessOperationTypeCode(v) ? v : null;
}

// ── Transitions de statut (C8, B7) ─────────────────────────────────────────

export type StatusTransitionReason = 'PROOF' | 'REALIZATION_PROOF_WITHDRAWN';

/**
 * Transition autorisée ? (pure)
 *   ENVISAGED → REALIZED | CANCELLED     : oui (preuve) ;
 *   CANCELLED → ENVISAGED | REALIZED     : oui, exceptionnellement (preuve) ;
 *   REALIZED  → ENVISAGED                : seulement après retrait de la
 *                                          preuve de réalisation (F-070) ;
 *   REALIZED  → CANCELLED                : jamais (« utiliser
 *                                          l'invalidation », B7) ;
 *   même statut                          : aucun changement (no-op).
 */
export function checkStatusTransition(
  from: BusinessOperationStatus, to: BusinessOperationStatus, reason: StatusTransitionReason = 'PROOF',
): 'NOOP' | 'ALLOWED' {
  if (from === to) return 'NOOP';
  if (from === 'REALIZED' && to === 'CANCELLED') {
    throw new BusinessOperationIntegrityError(
      'STATUS_TRANSITION_FORBIDDEN',
      'Une Opération réalisée ne devient pas annulée : l\'invalider si elle était erronée (B7).',
    );
  }
  if (from === 'REALIZED' && to === 'ENVISAGED' && reason !== 'REALIZATION_PROOF_WITHDRAWN') {
    throw new BusinessOperationIntegrityError(
      'STATUS_TRANSITION_FORBIDDEN',
      'REALIZED → ENVISAGED seulement après retrait de la preuve de réalisation (C8, F-070).',
    );
  }
  return 'ALLOWED';
}

// ── Parent / enfant (C8.1, C13.1) ──────────────────────────────────────────

export const MAX_OPERATION_DEPTH = 3;

/**
 * Relations « fait partie de » admises (enfant → parents possibles) :
 *   FINANCING    → ACQUISITION  (PARENT-004, C13.1) ;
 *   INTERVENTION → CLAIM        (PARENT-005, C13.1) ;
 *   INTERVENTION → INTERVENTION (sous-intervention réellement autonome, 5.1).
 * Toute autre relation est refusée — notamment CONTRACT parent d'un CLAIM ou
 * d'une INTERVENTION (PARENT-006) ; la référence CLAIM → contrat d'assurance
 * passe par `claim_details.insurance_contract_operation_id`, pas par le parent.
 */
export const ALLOWED_PARENT_TYPES: Readonly<Partial<Record<BusinessOperationTypeCode, readonly BusinessOperationTypeCode[]>>> = {
  FINANCING: ['ACQUISITION'],
  INTERVENTION: ['CLAIM', 'INTERVENTION'],
};

export function checkParentRelation(childType: BusinessOperationTypeCode | null, parentType: BusinessOperationTypeCode | null): void {
  if (childType === null || parentType === null) {
    throw new BusinessOperationIntegrityError(
      'PARENT_TYPE_UNKNOWN',
      'Une relation parent / enfant exige deux Opérations qualifiées (C8.1).',
    );
  }
  if (!(ALLOWED_PARENT_TYPES[childType] ?? []).includes(parentType)) {
    throw new BusinessOperationIntegrityError(
      'PARENT_RELATION_NOT_ALLOWED',
      `${childType} ne peut pas être enfant de ${parentType} (C8.1, C13.1).`,
    );
  }
}

/**
 * Profondeur et cycle (PARENT-001, PARENT-002) — pure, sur des données lues.
 *   ancestorsOfParent : chaîne parent → racine, parent COMPRIS (ids) ;
 *   childSubtreeHeight : niveaux du sous-arbre de l'enfant, enfant compris (≥ 1).
 */
export function checkHierarchy(childId: number, ancestorsOfParent: readonly number[], childSubtreeHeight: number): void {
  if (ancestorsOfParent.includes(childId)) {
    throw new BusinessOperationIntegrityError('PARENT_CYCLE', 'Ce rattachement créerait un cycle parent / enfant (C20.1).');
  }
  if (ancestorsOfParent.length + childSubtreeHeight > MAX_OPERATION_DEPTH) {
    throw new BusinessOperationIntegrityError(
      'PARENT_DEPTH_EXCEEDED',
      `Profondeur maximale de ${MAX_OPERATION_DEPTH} niveaux dépassée (PARENT-002).`,
    );
  }
}

// ── Devises (C12.3) ────────────────────────────────────────────────────────

export function isIsoCurrency(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Z]{3}$/.test(v);
}

/** Montant en unités mineures : entier sûr ≥ 0 (C12). */
export function isMinorAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
