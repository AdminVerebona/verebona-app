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

// ── extract_source ───────────────────────────────────────────────────────────
const evidenceField = z.object({
  fieldKey: z.string().min(1).max(120),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confidence,
  excerpt,
  page: z.number().int().positive().optional(),
  selector: z.string().max(300).optional(),
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
  transcription: z.string().max(200_000).optional(),
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
