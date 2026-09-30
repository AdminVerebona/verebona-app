/**
 * Contrat du prompt maître T2 — CDC 15 §24, §22.2, T2-31, T2-35.
 *
 * Une seule consigne (`t2_master_v1`), trois branches imposées par le
 * serveur, discriminées par `mode` (§24 : « MODE = {{MODE}} ») :
 *   - `UNDERSTAND` : classer dans le catalogue fermé, indices structurés ;
 *   - `ANSWER`     : réponse sourcée, en trois formats (`claims`,
 *                    `comparison`, `timeline` — structure conservée, T2-35) ;
 *   - `REVALIDATE` : relire UNE information, texte OU visuel (T2-30).
 *
 * Monde fermé contrôlé par le serveur après validation : intention du
 * catalogue (schéma), `sourceIds` ⊂ sources fournies, support vérifiable de
 * chaque affirmation (`claim-support`, T2-31), aucun extrait inventé pour une
 * observation visuelle (C3, P-T2-04).
 */
import { z } from 'zod';
import { VEREBONA_INTENTS } from '@/services/verebona-assistant/types/intents';

export const T2_MASTER_PROMPT_CODE = 't2_master_v1';
export const T2_MODES = ['UNDERSTAND', 'ANSWER', 'REVALIDATE'] as const;
export type T2Mode = (typeof T2_MODES)[number];

// ── UNDERSTAND ──────────────────────────────────────────────────────────────
export const T2_ENTITY_TYPES = ['asset', 'document', 'agenda', 'supplier', 'equipment', 'room', 'help', 'period'] as const;

const nullableString = z.string().max(200).nullable().optional();

export const T2UnderstandOutput = z.object({
  mode: z.literal('UNDERSTAND'),
  intent: z.enum(VEREBONA_INTENTS as unknown as [string, ...string[]]),
  confidence: z.enum(['exact', 'probable', 'ambiguous']),
  entityHints: z.array(z.object({ type: z.enum(T2_ENTITY_TYPES), value: z.string().min(1).max(200) })).max(10).default([]),
  /** Clés du FIELD_CATALOG fourni (A4) — contrôlées ensuite par le serveur. */
  requestedFacts: z.array(z.string().min(1).max(80)).max(20).default([]),
  requestedTopics: z.array(z.string().min(1).max(120)).max(20).default([]),
  filters: z.object({
    documentType: nullableString,
    periodStart: nullableString,
    periodEnd: nullableString,
    unlinked: z.boolean().nullable().optional(),
    status: nullableString,
    supplier: nullableString,
    upcoming: z.boolean().nullable().optional(),
  }).default({}),
  reason: z.string().max(300).default(''),
});
export type T2UnderstandOutput = z.infer<typeof T2UnderstandOutput>;

// ── ANSWER ──────────────────────────────────────────────────────────────────

/**
 * Support vérifiable d'une affirmation (T2-31), FACULTATIF dans la sortie :
 * le serveur le contrôle s'il est donné, sinon il vérifie lui-même que les
 * valeurs de la phrase figurent dans les sources citées.
 */
export const t2ClaimSupport = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), sourceId: z.string().min(1).max(200), value: z.string().max(500) }),
  z.object({ kind: z.literal('excerpt'), sourceId: z.string().min(1).max(200), text: z.string().min(1).max(1000) }),
  z.object({
    kind: z.literal('table_cell'), sourceId: z.string().min(1).max(200),
    table: z.object({ index: z.number().int().nonnegative(), row: z.number().int().nonnegative(), column: z.number().int().nonnegative() }),
    value: z.string().max(500),
  }),
  z.object({ kind: z.literal('value'), sourceId: z.string().min(1).max(200), value: z.string().max(500) }),
]);
export type T2ClaimSupport = z.infer<typeof t2ClaimSupport>;

const sourceIds = z.array(z.union([z.string(), z.number()]).transform(String)).max(20).default([]);

export const t2Claim = z.object({
  text: z.string().min(1).max(1000),
  sourceIds,
  derivation: z.enum(['direct', 'calculated', 'synthesized']).optional(),
  factual: z.boolean().optional(),
  support: t2ClaimSupport.optional(),
});
export type T2Claim = z.infer<typeof t2Claim>;

const answerStatus = z.enum(['answered', 'insufficient_data']);

export const T2AnswerClaims = z.object({
  mode: z.literal('ANSWER'),
  format: z.literal('claims'),
  status: answerStatus,
  claims: z.array(t2Claim).max(30).default([]),
});
export const T2AnswerComparison = z.object({
  mode: z.literal('ANSWER'),
  format: z.literal('comparison'),
  status: answerStatus,
  criterion: z.string().min(1).max(300),
  items: z.array(z.object({
    targetId: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    /** `null` : valeur absente — jamais zéro (B9). */
    value: z.union([z.string().max(300), z.number()]).transform(String).nullable(),
    sourceIds,
  })).max(20),
});
export const T2AnswerTimeline = z.object({
  mode: z.literal('ANSWER'),
  format: z.literal('timeline'),
  status: answerStatus,
  events: z.array(z.object({
    /** AAAA-MM-JJ, ou null si la date est inconnue (placée en fin). */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    text: z.string().min(1).max(500),
    sourceIds,
  })).max(50),
});
/** Branche ANSWER : union discriminée par `format` (T2-35). */
export const T2AnswerOutput = z.discriminatedUnion('format', [T2AnswerClaims, T2AnswerComparison, T2AnswerTimeline]);
export type T2AnswerOutput = z.infer<typeof T2AnswerOutput>;

// ── REVALIDATE ──────────────────────────────────────────────────────────────
export const T2RevalidateOutput = z.object({
  mode: z.literal('REVALIDATE'),
  status: z.enum(['confirmed', 'corrected', 'not_found', 'ambiguous']),
  value: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  confidence: z.enum(['certain', 'probable']).default('probable'),
  evidence: z.object({
    provenance: z.enum(['TEXT_EXTRACTION', 'VISUAL_ANALYSIS']),
    excerpt: z.string().max(1000).nullable().optional(),
    page: z.number().int().positive().nullable().optional(),
    visualEvidence: z.union([
      z.string().max(500),
      z.object({ description: z.string().min(1).max(500), page: z.number().int().positive().optional() }),
    ]).nullable().optional(),
  }),
});
export type T2RevalidateOutput = z.infer<typeof T2RevalidateOutput>;

/** Union des trois branches (le serveur valide avec le schéma de la branche). */
export const T2MasterOutput = z.union([T2UnderstandOutput, T2AnswerOutput, T2RevalidateOutput]);
export type T2MasterOutput = z.infer<typeof T2MasterOutput>;
