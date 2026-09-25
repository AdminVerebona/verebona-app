/**
 * Schémas de sortie des opérations d'analyse — CDC §5.3.
 *
 * Toute sortie modèle est validée ici avant la moindre persistance. Les
 * identifiants d'entités acceptés par le schéma restent NON VÉRIFIÉS : leur
 * existence réelle est contrôlée par `identifier-verifier.ts` (§4.1.7).
 */
import { z } from 'zod';

const confidence = z.enum(['certain', 'probable', 'conflictual']);

/** Extrait justificatif : obligatoire et non vide (§4.1.7, « preuve exploitable »). */
const excerpt = z.string().min(1).max(2000);

// ── group_sources ────────────────────────────────────────────────────────────
/** Groupes d'INDICES (positions dans la liste transmise), pas d'identifiants. */
export const GroupSourcesOutput = z.object({
  groups: z.array(z.array(z.number().int().nonnegative()).min(1)).min(1),
  reason: z.string().max(500).optional(),
});
export type GroupSourcesOutput = z.infer<typeof GroupSourcesOutput>;

// ── classify_document ────────────────────────────────────────────────────────
export const ClassifyDocumentOutput = z.object({
  documentType: z.string().min(1).max(80),
  confidence,
  excerpt,
});
export type ClassifyDocumentOutput = z.infer<typeof ClassifyDocumentOutput>;

// ── classify_category ────────────────────────────────────────────────────────
//
// `categoryCode` est un code du référentiel, jamais un libellé libre : la
// catégorie doit exister pour que le document soit affichable (CDC 5 §2.3).
export const ClassifyCategoryOutput = z.object({
  categoryCode: z.string().min(3).max(50).regex(/^[A-Z][A-Z0-9_]{2,49}$/),
  confidence,
  excerpt,
});
export type ClassifyCategoryOutput = z.infer<typeof ClassifyCategoryOutput>;

// ── classify_rubric (CDC V2 §11.4, §11.5) ────────────────────────────────────
//
// ⚠️ La confiance est ici NUMÉRIQUE, là où les autres opérations emploient
// trois niveaux qualitatifs.
//
// Ce n'est pas une incohérence de style : le §11.2 impose « un seuil fixe de
// 90 % » appliqué à toute proposition susceptible d'écrire une donnée. Trois
// niveaux ne permettent pas de situer une proposition par rapport à 0,90 —
// « probable » est-il au-dessus ou en dessous ? La question n'a pas de
// réponse, et c'est le seuil qui deviendrait un réglage.
//
// Le score n'est jamais affiché à l'utilisateur (§11.2, dernier alinéa).
export const ClassifyRubricOutput = z.object({
  rubricCode: z.string().min(3).max(60).regex(/^[A-Z][A-Z0-9_]{2,59}$/),
  /** Facultatif : une Rubrique sans Type reste un classement valide (§2.2). */
  documentTypeCode: z.string().min(3).max(60).regex(/^[A-Z][A-Z0-9_]{2,59}$/).nullable().optional(),
  confidence: z.number().min(0).max(1),
  excerpt,
});
export type ClassifyRubricOutput = z.infer<typeof ClassifyRubricOutput>;

// ── extract_source ───────────────────────────────────────────────────────────
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ══════════════════════════════════════════════════════════════════════════
// CE QUI EST LU ≠ CE QUI EST VU (prompt v4)
//
// Jusqu'en v3, toute valeur devait porter un `excerpt` littéral : une
// information purement visuelle (« chaudière murale » sur une photo) n'avait
// que deux issues — disparaître, ou recevoir un faux extrait. La provenance
// sépare désormais :
//   · TEXT_EXTRACTION : lu dans la source (texte, OCR, plaque, tableau) →
//     `excerpt` littéral OBLIGATOIRE ;
//   · VISUAL_ANALYSIS : observé sur l'image → `visualEvidence` OBLIGATOIRE,
//     jamais d'extrait (il serait inventé).
// Le contrôle est fait champ par champ dans `extract-source.step.ts` : un
// champ mal prouvé est écarté, sans rejeter toute l'analyse.
// ══════════════════════════════════════════════════════════════════════════
export const FACT_PROVENANCES = ['TEXT_EXTRACTION', 'VISUAL_ANALYSIS'] as const;
const unit01 = z.number().min(0).max(1);
/** Zone de la page, en coordonnées relatives (0 à 1), coin haut gauche → bas droit. */
const region = z.object({ x1: unit01, y1: unit01, x2: unit01, y2: unit01 });
export const visualEvidence = z.object({
  page: z.number().int().positive().optional(),
  /** Position de l'image dans les pièces transmises (0 = première). */
  imageIndex: z.number().int().nonnegative().optional(),
  region: region.optional(),
  /** Description courte de l'élément observé (jamais présentée comme citation). */
  description: z.string().min(1).max(500),
});

// ══════════════════════════════════════════════════════════════════════════
// TABLEAUX : LA STRUCTURE, PAS SEULEMENT LE TEXTE
//
// Une transcription peut contenir toutes les valeurs d'un tableau et en
// perdre les relations (« Tesla, Clio, 42 000 km, 78 000 km… »). Chaque
// cellule porte donc EXPLICITEMENT sa ligne et sa colonne : une cellule vide
// reste une cellule (`value: null`) et ne décale jamais les suivantes. Les
// en-têtes à plusieurs niveaux sont portés par colonne (`path`).
// ══════════════════════════════════════════════════════════════════════════
const tableCell = z.object({
  /** Index de colonne (0 = première). */
  column: z.number().int().nonnegative().max(199),
  /** Valeur brute telle que lue ; `null` = cellule vide (jamais omise). */
  value: z.union([z.string().max(1000), z.number(), z.null()]),
  normalized: z.string().max(200).optional(),
  valueType: z.enum(['text', 'number', 'amount', 'date', 'quantity', 'boolean']).optional(),
  colspan: z.number().int().positive().max(200).optional(),
  rowspan: z.number().int().positive().max(1000).optional(),
  confidence: confidence.optional(),
});
export const tableOutput = z.object({
  title: z.string().max(300).optional(),
  pageStart: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  /** En-têtes de colonnes, dans l'ordre ; `path` pour les en-têtes à plusieurs niveaux. */
  columns: z.array(z.object({
    header: z.string().max(300),
    path: z.array(z.string().max(200)).max(5).optional(),
  })).min(1).max(200),
  rows: z.array(z.object({
    /** En-tête de ligne, s'il existe (« Clio », « Maison A »). */
    header: z.string().max(300).optional(),
    page: z.number().int().positive().optional(),
    cells: z.array(tableCell).max(200),
  })).max(1000),
  confidence: confidence.default('certain'),
  /** Structure douteuse (lecture difficile, association incertaine) : jamais reconstruite. */
  uncertain: z.boolean().default(false),
  uncertaintyNote: z.string().max(500).optional(),
});

const evidenceField = z.object({
  fieldKey: z.string().min(1).max(120),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confidence,
  /** Obligatoire pour TEXT_EXTRACTION, interdit pour VISUAL_ANALYSIS (contrôlé à l'étape). */
  excerpt: excerpt.optional(),
  provenance: z.enum(FACT_PROVENANCES).default('TEXT_EXTRACTION'),
  visualEvidence: visualEvidence.optional(),
  /** Fait lu dans une cellule de tableau : sa position, pour garder le contexte. */
  table: z.object({
    index: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  }).optional(),
  page: z.number().int().positive().optional(),
  selector: z.string().max(300).optional(),
  // ── Fait générique (T1, représentation durable) — tous facultatifs ──
  // « Chaudière / puissance / 24 / kW ». Facultatifs pour rester compatibles
  // avec les réponses produites avant cette évolution du prompt.
  subject: z.string().max(120).optional(),
  attribute: z.string().max(120).optional(),
  label: z.string().max(200).optional(),
  unit: z.string().max(30).optional(),
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  section: z.string().max(200).optional(),
  // ── Récurrence explicite (T4) — seulement si la source l'énonce ──
  recurrence: z.object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive().max(120).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    occurrenceCount: z.number().int().positive().max(240).optional(),
    dates: z.array(isoDate).max(120).optional(),
    excerpt: z.string().max(500).optional(),
  }).optional(),
});

export const ExtractSourceOutput = z.object({
  title: z.object({ value: z.string().min(1).max(300), confidence, excerpt }).optional(),
  description: z.object({ value: z.string().max(2000), confidence, excerpt }).optional(),
  documentDate: z.object({
    // Date ISO stricte : toute autre forme est rejetée avant persistance (§5.3).
    value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    confidence, excerpt,
  }).optional(),
  supplier: z.object({
    name: z.string().min(1).max(200),
    siret: z.string().regex(/^\d{14}$/).optional(),
    confidence, excerpt,
  }).optional(),
  amountCents: z.object({
    value: z.number().int(),
    confidence, excerpt,
  }).optional(),
  /** Texte RÉELLEMENT lisible (PDF, OCR, texte d'image, tableau, schéma) — rien d'interprété. */
  transcription: z.string().max(200_000).optional(),
  /**
   * Observations visuelles, distinctes de la transcription et de la
   * description documentaire : objets visibles, disposition, état apparent,
   * type d'équipement, schéma, relations spatiales.
   */
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
  /** Tableaux utiles, structure ligne/colonne conservée (en plus de la transcription). */
  tables: z.array(tableOutput).max(30).default([]),
  fields: z.array(evidenceField).max(200).default([]),
  /** Le modèle signale lui-même l'absence de contenu exploitable. */
  hasExploitableContent: z.boolean().default(true),
});
export type ExtractSourceOutput = z.infer<typeof ExtractSourceOutput>;

// ── identify_entities ────────────────────────────────────────────────────────
const linkCandidate = z.object({
  entityId: z.number().int().positive().nullable(),
  rawLabel: z.string().max(200).optional(),
  score: z.number().min(0).max(1),
  confidence,
  reason: z.string().max(400),
  excerpt,
});

export const IdentifyEntitiesOutput = z.object({
  assets: z.array(linkCandidate).max(20).default([]),
  rooms: z.array(linkCandidate).max(20).default([]),
  equipments: z.array(linkCandidate).max(20).default([]),
  /** true si le document couvre plusieurs biens — déclenche un avertissement. */
  multiAsset: z.boolean().default(false),
});
export type IdentifyEntitiesOutput = z.infer<typeof IdentifyEntitiesOutput>;

// ── propose_links ────────────────────────────────────────────────────────────
export const ProposeLinksOutput = z.object({
  equipments: z.array(linkCandidate).max(20).default([]),
  suppliers: z.array(linkCandidate).max(10).default([]),
});
export type ProposeLinksOutput = z.infer<typeof ProposeLinksOutput>;

// ── Agenda (produit par extract_source, exploité par l'usage 4) ──────────────
export const AgendaCandidatesOutput = z.object({
  candidates: z.array(z.object({
    title: z.string().min(1).max(200),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    suggestedCategory: z.enum(['action', 'information']).optional(),
    confidence,
    excerpt,
    originFieldKey: z.string().max(120).optional(),
  })).max(50).default([]),
});
export type AgendaCandidatesOutput = z.infer<typeof AgendaCandidatesOutput>;
