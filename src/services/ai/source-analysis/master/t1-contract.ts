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
export const T1_TASKS = ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'] as const;
export type T1Task = (typeof T1_TASKS)[number];

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

export const t1Target = z.object({
  type: z.enum(T1_TARGET_TYPES),
  /** Identifiant présent dans ENTITY_CONTEXT, sinon null (U9) — revérifié en base. */
  entityId: z.number().int().positive().nullable().default(null),
  rawLabel: z.string().max(200).nullable().optional(),
  confidence: confidence.default('probable'),
  evidenceSignals: z.array(z.string().max(200)).max(10).default([]),
});
export type T1Target = z.infer<typeof t1Target>;

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
export const T1_EVENT_NATURES = ['HISTORICAL', 'DEADLINE', 'FACT_ONLY'] as const;
export type T1EventNature = (typeof T1_EVENT_NATURES)[number];

export const t1SemanticEvent = z.object({
  /** `businessType` de l'EVENT_CATALOG (purchase, repair, maintenance…). */
  type: z.string().min(1).max(60),
  nature: z.enum(T1_EVENT_NATURES),
});
export type T1SemanticEvent = z.infer<typeof t1SemanticEvent>;

/** Types de valeur annoncés par le modèle (alignés sur FIELD_CATALOG). */
export const T1_VALUE_TYPES = [
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
  entityId: z.number().int().positive().nullable(),
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
});
export type T1AnalyzeDocumentOutput = z.infer<typeof T1AnalyzeDocumentOutput>;

/** Union discriminée par `task` (CDC 15 §22.2). */
export const T1MasterOutput = z.discriminatedUnion('task', [T1GroupUploadOutput, T1AnalyzeDocumentOutput]);
export type T1MasterOutput = z.infer<typeof T1MasterOutput>;

/** Schéma de sortie attendu pour une TASK donnée. */
export function t1OutputSchemaFor(task: 'GROUP_UPLOAD'): typeof T1GroupUploadOutput;
export function t1OutputSchemaFor(task: 'ANALYZE_DOCUMENT'): typeof T1AnalyzeDocumentOutput;
export function t1OutputSchemaFor(task: T1Task) {
  return task === 'GROUP_UPLOAD' ? T1GroupUploadOutput : T1AnalyzeDocumentOutput;
}

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
}
