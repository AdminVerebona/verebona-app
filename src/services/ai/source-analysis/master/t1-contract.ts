/**
 * Contrat du prompt maître T1 — CDC 15 §23, PM-T1, PM-T1-PRE, T1-01..T1-08.
 *
 * Une seule consigne (`t1_master_v1`), deux branches imposées par le serveur :
 *   - `GROUP_UPLOAD`     : regrouper les fichiers déposés ensemble ;
 *   - `ANALYZE_DOCUMENT` : analyser complètement un document regroupé.
 *
 * Chaque branche a son schéma ; la sortie est une union discriminée par
 * `task` (CDC 15 §22.2, « un prompt maître n'implique pas un schéma plat »).
 * Le serveur vérifie en plus que `task` renvoyé = `task` demandé
 * (`assertTaskMatches`).
 *
 * Ce fichier est le point de rencontre des trois chantiers du lot 12 :
 * infrastructure des masters (validation par TASK), persistance (faits
 * ciblés) et projection déterministe. Il ne dépend que de zod.
 */
import { z } from 'zod';

export const T1_MASTER_PROMPT_CODE = 't1_master_v1';
/**
 * Version du contrat de sortie ANALYZE_DOCUMENT (lot 33D, registre
 * `gateway/output-resolution/contracts`) : v1 ancien moteur, v2 lot 12,
 * v3 lot 33 (`entityId` absent = null), v4 lot 40 (`businessOperationCandidates[]`,
 * CDC Opérations V1 C3.1 — une sortie v3 reste une v4 valide : aucun
 * candidat), v5 lot 53D (retours PO D2, D9, Q16 : rôle `LOAN_PRINCIPAL`,
 * portée `FEE`, contre-valeur `amountEurMinor`, devise « XXX » non établie —
 * une sortie v4 reste une v5 valide : champs facultatifs, listes étendues),
 * v6 lot 91D (`valueDecisions[]` facultatif : décision de T1 sur les valeurs
 * significatives des unités sources — une sortie v5 reste une v6 valide :
 * tableau ABSENT = contrat non porté, aucun adaptateur).
 * Affichée « t1_analyze_document@v6 ».
 */
export const T1_ANALYZE_DOCUMENT_CONTRACT_VERSION = 6;
export const T1_TASKS = ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'] as const;

const confidence = z.enum(['certain', 'probable', 'conflictual']);
export type T1Confidence = z.infer<typeof confidence>;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const region = z.object({
  x1: z.number().min(0).max(1), y1: z.number().min(0).max(1),
  x2: z.number().min(0).max(1), y2: z.number().min(0).max(1),
});

/** Provenance d'un fait (U2). */
export const T1_PROVENANCES = ['TEXT_EXTRACTION', 'VISUAL_ANALYSIS'] as const;

/**
 * Preuve d'un fait ou d'une métadonnée (U2, U10). `excerpt` est la citation
 * littérale (TEXT_EXTRACTION) ; il est interdit pour VISUAL_ANALYSIS, qui
 * porte `visualEvidence` à la place — contrôle fait par `checkFactEvidence`.
 */
export const t1Evidence = z.object({
  excerpt: z.string().min(1).max(2000).optional(),
  page: z.number().int().positive().optional(),
  section: z.string().max(200).optional(),
  table: z.object({
    index: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  }).optional(),
});
export type T1Evidence = z.infer<typeof t1Evidence>;

export const t1VisualEvidence = z.object({
  description: z.string().min(1).max(500),
  page: z.number().int().positive().optional(),
  imageIndex: z.number().int().nonnegative().optional(),
  region: region.optional(),
});

/** Types de cible d'un fait (U7). */
export const T1_TARGET_TYPES = ['ASSET', 'EQUIPMENT', 'ROOM', 'DOCUMENT', 'SUPPLIER', 'GENERIC'] as const;
export type T1TargetType = (typeof T1_TARGET_TYPES)[number];

const t1Target = z.object({
  type: z.enum(T1_TARGET_TYPES),
  /** Identifiant présent dans ENTITY_CONTEXT, sinon null (U9) — revérifié en base. */
  entityId: z.number().int().positive().nullable().default(null),
  rawLabel: z.string().max(200).nullable().optional(),
  confidence: confidence.default('probable'),
  evidenceSignals: z.array(z.string().max(200)).max(10).default([]),
});

/** Récurrence énoncée par la source (U12) — T1 ne calcule aucune occurrence. */
export const t1Recurrence = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().positive().max(120).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  occurrenceCount: z.number().int().positive().max(240).optional(),
  dates: z.array(isoDate).max(120).optional(),
  excerpt: z.string().max(500).optional(),
});
export type T1Recurrence = z.infer<typeof t1Recurrence>;

/** Nature temporelle d'un fait (U13). */
const T1_EVENT_NATURES = ['HISTORICAL', 'DEADLINE', 'FACT_ONLY'] as const;

export const t1SemanticEvent = z.object({
  /** `businessType` de l'EVENT_CATALOG (purchase, repair, maintenance…). */
  type: z.string().min(1).max(60),
  nature: z.enum(T1_EVENT_NATURES),
});
export type T1SemanticEvent = z.infer<typeof t1SemanticEvent>;

/** Types de valeur annoncés par le modèle (alignés sur FIELD_CATALOG). */
const T1_VALUE_TYPES = [
  'string', 'text', 'number', 'money_eur', 'money_cents', 'date', 'boolean', 'enum', 'json', 'quantity',
] as const;

/** Fait structuré (U5 à U16). */
export const t1Fact = z.object({
  /** Clé EXACTE du FIELD_CATALOG, ou null pour une connaissance générique (U5). */
  canonicalKey: z.string().min(1).max(120).nullable(),
  rawKey: z.string().max(200).nullable().optional(),
  label: z.string().max(200).nullable().optional(),
  subject: z.string().max(200).nullable().optional(),
  attribute: z.string().max(200).nullable().optional(),
  rawValue: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]).optional(),
  /** Valeur dans le type et l'unité du catalogue (U6) ; jamais ×100 implicite. */
  normalizedValue: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
  valueType: z.enum(T1_VALUE_TYPES).nullable().optional(),
  /** Unité canonique annoncée (EUR, cents, km, m2…) ; contrôlée contre le registre. */
  canonicalUnit: z.string().max(30).nullable().optional(),
  target: t1Target,
  provenance: z.enum(T1_PROVENANCES).default('TEXT_EXTRACTION'),
  confidence,
  evidence: t1Evidence.default({}),
  visualEvidence: t1VisualEvidence.optional(),
  semanticEvent: t1SemanticEvent.nullable().optional(),
  recurrence: t1Recurrence.nullable().optional(),
  periodStart: isoDate.nullable().optional(),
  periodEnd: isoDate.nullable().optional(),
});
export type T1Fact = z.infer<typeof t1Fact>;

const entityCandidate = z.object({
  /**
   * Lot 33D (contrat v3) : un identifiant ABSENT vaut `null` (entité lue mais
   * inconnue du compte, U9) — un modèle qui l'omet au lieu d'écrire `null`
   * ne fait plus échouer toute la sortie.
   */
  entityId: z.number().int().positive().nullable().default(null),
  rawLabel: z.string().max(200).nullable().optional(),
  score: z.number().min(0).max(1),
  confidence,
  evidenceSignals: z.array(z.string().max(200)).max(10).default([]),
  reason: z.string().max(400).optional(),
});

const tableCell = z.object({
  column: z.number().int().nonnegative().max(199),
  value: z.union([z.string().max(1000), z.number(), z.null()]),
  normalized: z.string().max(200).optional(),
  valueType: z.enum(['text', 'number', 'amount', 'date', 'quantity', 'boolean']).optional(),
  colspan: z.number().int().positive().max(200).optional(),
  rowspan: z.number().int().positive().max(1000).optional(),
  confidence: confidence.optional(),
});
/** Tableau structuré (T1-08, U10) : même forme que l'ancien `extract_source`, lue par `knowledge/document-tables`. */
export const t1Table = z.object({
  title: z.string().max(300).optional(),
  pageStart: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  columns: z.array(z.object({
    header: z.string().max(300),
    path: z.array(z.string().max(200)).max(5).optional(),
  })).min(1).max(200),
  rows: z.array(z.object({
    header: z.string().max(300).optional(),
    page: z.number().int().positive().optional(),
    cells: z.array(tableCell).max(200),
  })).max(1000),
  confidence: confidence.default('certain'),
  uncertain: z.boolean().default(false),
  uncertaintyNote: z.string().max(500).optional(),
});

const meta = <T extends z.ZodType>(value: T) => z.object({ value, confidence, evidence: t1Evidence.default({}) });

// ── Candidats Opération (lot 40, CDC Opérations V1 C3, C3.1, B3, C2.1) ──────
//
// Vocabulaire FERMÉ, recopié ici pour que ce fichier ne dépende que de zod :
// identique à `business-operations/model.ts` (test d'alignement C3-01).
// T1 EXTRAIT, T3 DÉCIDE : un candidat n'est jamais une Opération.

/** Types d'Opération (C27) — `OTHER` n'est jamais un repli (P18). */
export const T1_OPERATION_TYPES = ['ACQUISITION', 'INTERVENTION', 'CONTRACT', 'FINANCING', 'CLAIM', 'DISPOSAL', 'OTHER'] as const;
export const T1_OPERATION_STATUSES = ['ENVISAGED', 'REALIZED', 'CANCELLED'] as const;
/** Rôle de la source documentaire (C2.1). */
export const T1_SOURCE_ROLES = [
  'QUOTE', 'ORDER', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'REFUND_PROOF', 'PAYMENT_PROOF',
  'CONTRACT_DOCUMENT', 'CLAIM_DOCUMENT', 'SALE_DOCUMENT', 'REPORT', 'OTHER_EVIDENCE',
] as const;
export type T1SourceRole = (typeof T1_SOURCE_ROLES)[number];
/**
 * Rôle économique d'un montant (C11.2, C12) ; `PAYMENT` = règlement prouvé,
 * JAMAIS un coût (INV-FINAL-015) ; `LOAN_PRINCIPAL` (lot 53D, Q16) = capital
 * emprunté d'un financement : une dette, JAMAIS une dépense.
 */
export const T1_FINANCIAL_ROLES = ['FORECAST_COST', 'REALIZED_COST', 'REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED', 'PAYMENT', 'LOAN_PRINCIPAL'] as const;
export type T1FinancialRole = (typeof T1_FINANCIAL_ROLES)[number];
/**
 * Portée d'un montant : total, acompte, solde, échéance (F-092, F-093) ;
 * `FEE` (lot 53D, D9) = frais annexes facturés à part (livraison, mise en
 * service, frais de dossier, immatriculation…), jamais additionnés d'office
 * au prix d'achat.
 */
export const T1_AMOUNT_SCOPES = ['TOTAL', 'DEPOSIT', 'BALANCE', 'INSTALLMENT', 'FEE'] as const;
export type T1AmountScope = (typeof T1_AMOUNT_SCOPES)[number];
/** Références métier (même liste que `business_operation_references`). */
export const T1_REFERENCE_KINDS = ['INVOICE', 'QUOTE', 'ORDER', 'WORK_ORDER', 'CONTRACT', 'POLICY', 'CLAIM', 'LOAN', 'CUSTOMER', 'DELIVERY', 'OTHER'] as const;
/**
 * Motif d'exclusion (B3 : valorisation_only, deadline_only, descriptive_only,
 * simulation_only…) — seuls les quatre derniers codes sont posés par le
 * serveur (`operation-candidates/gate.ts`).
 */
export const T1_EXCLUSION_REASONS = [
  'VALUATION_ONLY', 'DEADLINE_ONLY', 'DESCRIPTIVE_ONLY', 'SIMULATION_ONLY', 'WARRANTY_ONLY',
  'METER_READING_ONLY', 'UNQUALIFIED_AMOUNT', 'OTHER',
  'NO_EVIDENCE', 'VISUAL_ONLY', 'DOCUMENT_TYPE_NOT_BUSINESS', 'NO_EXPLOITABLE_CONTENT',
] as const;
export type T1ExclusionReason = (typeof T1_EXCLUSION_REASONS)[number];
/** Borne du contrat (T1-OP-008) : au-delà, regrouper au niveau métier. */
export const T1_MAX_OPERATION_CANDIDATES = 20;

const t1OperationTargetHint = z.object({
  type: z.enum(['ASSET', 'EQUIPMENT', 'ROOM']),
  /** Identifiant présent dans ENTITY_CONTEXT, sinon null (U9) — revérifié en base. */
  entityId: z.number().int().positive().nullable().default(null),
  rawLabel: z.string().max(200).nullable().optional(),
  confidence: confidence.default('probable'),
});

const t1FinancialHint = z.object({
  role: z.enum(T1_FINANCIAL_ROLES),
  /** Montant en UNITÉS MINEURES (centimes) ≥ 0 ; le signe est porté par le rôle (C12). */
  amountMinor: z.number().int().nonnegative(),
  /** Devise ISO 4217 LUE (C12.3) — jamais convertie par T1 ; « XXX » : aucune devise écrite (lot 53D, D2). */
  currency: z.string().regex(/^[A-Z]{3}$/),
  /**
   * Lot 53D (Q16, écart F-106) : contre-valeur EUR EXPLICITEMENT écrite sur le
   * document pour ce montant en devise étrangère (montant débité / facturé en
   * euros), en centimes — jamais calculée. Revérifiée par le serveur.
   */
  amountEurMinor: z.number().int().nonnegative().nullable().optional(),
  amountScope: z.enum(T1_AMOUNT_SCOPES).nullable().optional(),
  economicDate: isoDate.nullable().optional(),
  periodStart: isoDate.nullable().optional(),
  periodEnd: isoDate.nullable().optional(),
  /** Index (dans `facts`) du fait qui porte ce montant (T1-OP-006). */
  factIndex: z.number().int().nonnegative(),
});

/** Candidat Opération (C3.1). */
export const t1OperationCandidate = z.object({
  /** Clé locale, unique dans l'analyse ; jamais l'identifiant d'une Opération. */
  candidateKey: z.string().min(1).max(60),
  /** La source affirme-t-elle une réalité métier ? */
  established: z.boolean(),
  /** certain : établit ; probable : suggère sans suffire seul ; conflictual : aucune création automatique (T1-OP-003). */
  confidence,
  typeHint: z.enum(T1_OPERATION_TYPES).nullable().default(null),
  statusHint: z.enum(T1_OPERATION_STATUSES).nullable().default(null),
  /** Synthèse métier factuelle courte. */
  summary: z.string().min(1).max(500),
  sourceRoleHint: z.enum(T1_SOURCE_ROLES).nullable().default(null),
  /** Prestataire / organisme principal explicitement identifié. */
  provider: z.string().max(200).nullable().optional(),
  targetHints: z.array(t1OperationTargetHint).max(10).default([]),
  businessReferences: z.array(z.object({
    kind: z.enum(T1_REFERENCE_KINDS),
    value: z.string().min(1).max(120),
  })).max(10).default([]),
  temporalHints: z.object({
    plannedDate: isoDate.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    realizedDate: isoDate.nullable().optional(),
    endDate: isoDate.nullable().optional(),
  }).default({}),
  financialHints: z.array(t1FinancialHint).max(20).default([]),
  /** Index (dans `facts`) des faits qui motivent le candidat — obligatoire si `established` (T1-OP-006). */
  evidenceFactIndexes: z.array(z.number().int().nonnegative()).max(50).default([]),
  exclusionReason: z.enum(T1_EXCLUSION_REASONS).nullable().optional(),
});
export type T1OperationCandidate = z.infer<typeof t1OperationCandidate>;

// ── Décisions sur les valeurs significatives (lot 91D, contrat t1-value-decisions-v1) ──
//
// T1 QUALIFIE une valeur écrite dans la source (montant, date, identifiant)
// qu'il ne reprend pas forcément comme fait autonome : structurée, exploitée
// comme composante ou contexte d'un fait / candidat, non retenue (motif), ou
// indéterminée. Le code VÉRIFIE (valeur présente dans l'unité citée,
// rattachements existants, motif présent) et CONSERVE ; il ne juge jamais la
// pertinence d'une valeur (`value-decisions/validate.ts`).

/** Nature d'une valeur significative (même vocabulaire que `significantValues`). */
export const T1_VALUE_KINDS = ['AMOUNT', 'DATE', 'IDENTIFIER'] as const;
export type T1ValueKind = (typeof T1_VALUE_KINDS)[number];
/**
 * Décision sémantique de T1 :
 *   STRUCTURED            reprise dans un fait (`relatedFactIndexes` obligatoire) ;
 *   COMPONENT_OR_CONTEXT  comprise comme composante ou contexte d'un fait ou d'un candidat (ex. frais inclus dans un total) ;
 *   NOT_RETAINED          volontairement non retenue, avec un motif propre à CETTE valeur ;
 *   UNDETERMINED          identifiée, interprétation incertaine (toujours signalée par le contrôle).
 */
export const T1_VALUE_DECISIONS = ['STRUCTURED', 'COMPONENT_OR_CONTEXT', 'NOT_RETAINED', 'UNDETERMINED'] as const;
export type T1ValueDecisionCode = (typeof T1_VALUE_DECISIONS)[number];
/** Borne PAR LOT (une passe ou un lot de pages). */
export const T1_MAX_VALUE_DECISIONS = 200;

export const t1ValueDecision = z.object({
  /** Valeur TELLE QU'ÉCRITE dans la source (« 34,00 € », « 15/03/2026 », « AB-123-CD »). */
  value: z.string().min(1).max(200),
  kind: z.enum(T1_VALUE_KINDS),
  /** Forme normalisée annoncée : centimes (montant), AAAA-MM-JJ (date), jeton compact (identifiant) — recalculée par le serveur. */
  normalizedValue: z.union([z.string().max(200), z.number(), z.null()]).optional(),
  decision: z.enum(T1_VALUE_DECISIONS),
  /** Motif propre à cette valeur (jamais une formule générique). */
  reason: z.string().min(1).max(400),
  /** Unité source citée telle que transmise (`page:2:block:14`) quand le contenu préextrait la porte ; sinon null. */
  sourceUnitId: z.string().max(120).nullable().optional(),
  /** Preuve (extrait recopié, page, cellule) : rattache la valeur à son unité source. */
  evidence: t1Evidence.default({}),
  /** Index (dans `facts`) des faits auxquels la valeur se rattache. */
  relatedFactIndexes: z.array(z.number().int().nonnegative()).max(10).default([]),
  /** Clés (`candidateKey`) des candidats Opération auxquels la valeur se rattache. */
  relatedCandidateKeys: z.array(z.string().min(1).max(60)).max(5).default([]),
  confidence,
});
export type T1ValueDecision = z.infer<typeof t1ValueDecision>;

// ── Branche GROUP_UPLOAD ────────────────────────────────────────────────────
export const T1GroupUploadOutput = z.object({
  task: z.literal('GROUP_UPLOAD'),
  groups: z.array(z.array(z.number().int().nonnegative()).min(1)).min(1),
  reason: z.string().max(500).optional(),
});
export type T1GroupUploadOutput = z.infer<typeof T1GroupUploadOutput>;

// ── Branche ANALYZE_DOCUMENT ────────────────────────────────────────────────
export const T1AnalyzeDocumentOutput = z.object({
  task: z.literal('ANALYZE_DOCUMENT'),
  document: z.object({
    title: meta(z.string().min(1).max(300)).optional(),
    description: meta(z.string().max(2000)).optional(),
    documentDate: meta(isoDate).optional(),
    supplier: z.object({
      name: z.string().min(1).max(200),
      siret: z.string().regex(/^\d{14}$/).nullable().optional(),
      confidence,
      evidence: t1Evidence.default({}),
    }).optional(),
    /** Montant DOCUMENTAIRE, toujours en centimes — distinct des montants métier. */
    amountCents: meta(z.number().int()).optional(),
    classification: z.object({
      canonicalType: z.string().max(60).nullable().optional(),
      rubricCode: z.string().max(60).nullable().optional(),
      documentTypeCode: z.string().max(60).nullable().optional(),
      confidence: z.number().min(0).max(1),
      evidence: t1Evidence.default({}),
    }).optional(),
  }).default({}),
  entities: z.object({
    assets: z.array(entityCandidate).max(20).default([]),
    rooms: z.array(entityCandidate).max(20).default([]),
    equipments: z.array(entityCandidate).max(20).default([]),
    suppliers: z.array(entityCandidate).max(10).default([]),
    multiAsset: z.boolean().default(false),
  }).default({ assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false }),
  transcription: z.string().max(200_000).optional(),
  visual: z.object({
    summary: z.string().max(2000).optional(),
    observations: z.array(z.object({
      description: z.string().min(1).max(500),
      subject: z.string().max(120).optional(),
      confidence,
      page: z.number().int().positive().optional(),
      imageIndex: z.number().int().nonnegative().optional(),
      region: region.optional(),
    })).max(50).default([]),
  }).optional(),
  tables: z.array(t1Table).max(30).default([]),
  facts: z.array(t1Fact).max(300).default([]),
  hasExploitableContent: z.boolean().default(true),
  /**
   * Lot 40 (contrat v4, CDC Opérations V1 C3) : candidats Opération, tableau
   * SÉPARÉ des faits (T1-OP-001). Absent (sortie v3) = aucun candidat.
   */
  businessOperationCandidates: z.array(t1OperationCandidate).max(T1_MAX_OPERATION_CANDIDATES).default([]),
  /**
   * Lot 91D (contrat v6, demande 82B-t1-omissions-extract) : décisions de T1
   * sur les valeurs significatives. ABSENT (prompt sans le contrat
   * `t1-value-decisions-v1`) ≠ liste vide (contrat porté, rien à qualifier).
   */
  valueDecisions: z.array(t1ValueDecision).max(T1_MAX_VALUE_DECISIONS).optional(),
});
export type T1AnalyzeDocumentOutput = z.infer<typeof T1AnalyzeDocumentOutput>;

/** Union discriminée par `task` (CDC 15 §22.2). */
export const T1MasterOutput = z.discriminatedUnion('task', [T1GroupUploadOutput, T1AnalyzeDocumentOutput]);
export type T1MasterOutput = z.infer<typeof T1MasterOutput>;

// ══════════════════════════════════════════════════════════════════════════
// Contrat interne après projection (code → persistance). Jamais produit par
// le modèle : c'est ce que la projection déterministe remet à la persistance.
// ══════════════════════════════════════════════════════════════════════════

/** Cible persistée d'un fait (CDC 15 T1-04 ; colonnes 0218/0219). */
export interface PersistedFactTarget {
  targetType: T1TargetType;
  /** Identifiant VÉRIFIÉ en base pour le compte, sinon null. */
  targetEntityId: number | null;
  targetEntityLabel: string | null;
  targetConfidence: T1Confidence;
}

/** Origine d'un fait projeté. */
export type ProjectionOrigin =
  /** Fait canonique renvoyé tel quel par le modèle, validé contre le registre. */
  | 'MODEL_CANONICAL'
  /** Fait dérivé par une règle déterministe (ex. ticket d'achat → acquisitionDate). */
  | 'DETERMINISTIC_RULE'
  /** Connaissance générique (hors registre, ou clé inconnue ramenée à générique). */
  | 'GENERIC';

/**
 * Fait prêt à persister. `canonicalKey` non nul ⇒ clé EXISTANTE du registre,
 * `value` déjà normalisée dans l'unité canonique du registre.
 */
export interface ProjectedFact {
  canonicalKey: string | null;
  rawKey: string | null;
  label: string | null;
  subject: string | null;
  attribute: string | null;
  rawValue: string | number | boolean | null;
  /** Valeur normalisée (registre) ; pour un générique, la valeur lue. */
  value: string | number | boolean | null;
  valueType: string | null;
  /** Unité canonique du registre (null si sans unité). */
  canonicalUnit: string | null;
  target: PersistedFactTarget;
  provenance: (typeof T1_PROVENANCES)[number];
  confidence: T1Confidence;
  evidence: T1Evidence;
  visualEvidence?: z.infer<typeof t1VisualEvidence>;
  semanticEvent: T1SemanticEvent | null;
  recurrence: T1Recurrence | null;
  periodStart: string | null;
  periodEnd: string | null;
  origin: ProjectionOrigin;
  /** Règle déterministe appliquée (ex. `PURCHASE_RECEIPT_ACQUISITION`), sinon null. */
  ruleCode: string | null;
  /**
   * Lot 34F (additif, contrat INTERNE — jamais produit par le modèle) :
   * unités de la source qui prouvent le fait (`page:2:block:14`,
   * `page:5:table:2:row:4:cell:3`…), posées après projection.
   */
  sourceUnitIds?: string[];
  /**
   * Lot 40 (contrat INTERNE) : empreinte du fait T1 d'origine
   * (`factFingerprint`, posée à la réception de la sortie — voir
   * `operation-candidates/anchor.ts`). Elle relie les preuves des candidats
   * Opération au fait persisté, quels que soient les décalages d'index
   * (lots de débordement, de pages, faits écartés).
   */
  t1FactRef?: string;
}

/** Lot 40 — marque interne portée par un fait T1 après réception (jamais par le modèle). */
export type T1FactWithRef = T1Fact & { t1FactRef?: string };
