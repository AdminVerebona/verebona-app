/**
 * Schémas de sortie structurée (Zod v4) — CDC §18.
 *
 * Chaque appel Gemini utilise un JSON Schema correspondant à l'intention (§17.8).
 * Les listes d'actions / intentions / types de sources sont des énumérations FERMÉES.
 * Le serveur ne consomme jamais de texte libre comme réponse finale (§18.1).
 *
 * Le schéma porte une version ; une modification incompatible => nouvelle version (§18.8).
 */
import { z } from 'zod';
import { VEREBONA_INTENTS } from '../types/intents';
import { VEREBONA_ACTION_TYPES } from '../types/actions';
import { RESPONSE_SCHEMA_VERSION } from '../types/contracts';

const intentEnum = z.enum(VEREBONA_INTENTS);
const actionTypeEnum = z.enum(VEREBONA_ACTION_TYPES);

/** Un claim factuel doit citer ≥ 1 source (§18.4). */
export const claimSchema = z.object({
  claimKey: z.string().min(1).max(80),
  text: z.string().min(1).max(500),
  sourceIds: z.array(z.string().min(1)).min(1),
  derivation: z.enum(['direct', 'calculated', 'synthesized']),
});

/** Le modèle ne propose que type + id fourni ; jamais d'URL (§18.4, §18.7). */
export const actionIntentSchema = z.object({
  type: actionTypeEnum,
  targetId: z.union([z.string(), z.number()]).nullable().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const clarificationOutSchema = z
  .object({
    question: z.string().min(1).max(240),
    candidateType: z.enum(['asset', 'document', 'agenda', 'supplier']),
    candidateIds: z.array(z.string()).min(2),
  })
  .nullable();

/** Schéma de réponse de référence — CDC §18.2. */
export const assistantResponseSchema = z
  .object({
    schemaVersion: z.literal(RESPONSE_SCHEMA_VERSION),
    intent: intentEnum,
    answer: z.string().min(1).max(1200), // ≤ 4 phrases visibles (§21.2) — borne dure
    supportLevel: z.enum(['supported', 'partial', 'insufficient', 'conflicting']),
    claims: z.array(claimSchema),
    actionIntents: z.array(actionIntentSchema).max(3), // 1 principale + 2 secondaires (§22.9)
    clarification: clarificationOutSchema,
  })
  // §18.4 : une réponse factuelle « supported » contient au moins un claim.
  .refine(
    (o) => (o.supportLevel === 'supported' ? o.claims.length >= 1 : true),
    { message: 'Réponse soutenue sans claim (§18.4)', path: ['claims'] },
  );

export type AssistantResponseParsed = z.infer<typeof assistantResponseSchema>;

/**
 * JSON Schema natif à transmettre au provider — §18.1.
 *
 * ── LE TODO EST LEVÉ PAR VÉRIFICATION, NON PAR SUPPOSITION ────────────────
 *
 * Le code portait « selon la version de zod, brancher le converter
 * approprié ». Le projet emploie zod 4, où `z.toJSONSchema` est natif — c'est
 * vérifié par un test, qui échouerait si une mise à jour la retirait.
 *
 * Le repli est conservé, avec un message actionnable : une conversion
 * indisponible empêcherait toute sortie structurée, et un message vague
 * coûterait une heure de recherche au moment le plus inopportun.
 */
export function toJsonSchema(): Record<string, unknown> {
  const anyZ = z as unknown as { toJSONSchema?: (s: unknown) => Record<string, unknown> };
  if (typeof anyZ.toJSONSchema === 'function') {
    return anyZ.toJSONSchema(assistantResponseSchema);
  }
  throw new Error(
    'z.toJSONSchema indisponible : le projet requiert zod 4 ou supérieur. ' +
    'Vérifiez la version installée — `npm ls zod` — ou employez ' +
    'zod-to-json-schema comme convertisseur de remplacement.',
  );
}

export const OUTPUT_SCHEMAS = {
  version: RESPONSE_SCHEMA_VERSION,
  assistantResponse: assistantResponseSchema,
} as const;
