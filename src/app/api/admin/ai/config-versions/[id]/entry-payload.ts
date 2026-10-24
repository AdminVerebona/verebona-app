/**
 * Forme d'une ligne de configuration reçue par les routes d'enregistrement
 * (lot 54 : partagée par l'enregistrement global et la route historique par
 * traitement). Vérifie la FORME ; les contrôles fonctionnels sont au service.
 */
import { z } from 'zod';
import { REASONING_LEVELS, GUARDRAIL_REACTIONS, PROMPT_ARCHITECTURES } from '@/services/ai/config/config-types';

const Guardrail = z.object({
  code: z.string().min(1).max(100),
  threshold: z.number().finite(),
  reaction: z.enum(GUARDRAIL_REACTIONS),
});

const Trigger = z.object({
  kind: z.enum(['event', 'schedule']),
  code: z.string().min(1).max(100),
  active: z.boolean(),
});

/**
 * Lot 85C (CDC Pilotage IA V2 P4) : profil d'une opération — raisonnement et
 * plafond de sortie par emplacement (principal, repli 1, repli 2 ; `null` :
 * hérité), délai. Bornes fonctionnelles (opération du traitement, délai du
 * registre, compatibilité des modèles) contrôlées au service.
 */
const OperationProfile = z.object({
  reasoningByRank: z.array(z.enum(REASONING_LEVELS).nullable()).max(3).optional(),
  maxOutputTokensByRank: z.array(z.number().int().positive().nullable()).max(3).optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
}).strict();

export const EntryPayload = z.object({
  // Pas de borne haute : le SCR-02 veut un éditeur « sans limite artificielle ».
  prompt: z.string().default(''),
  primaryModel: z.string().max(200).nullable().default(null),
  fallback1: z.string().max(200).nullable().default(null),
  fallback2: z.string().max(200).nullable().default(null),
  reasoningPrimary: z.enum(REASONING_LEVELS).nullable().default(null),
  reasoningFallback1: z.enum(REASONING_LEVELS).nullable().default(null),
  reasoningFallback2: z.enum(REASONING_LEVELS).nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  guardrails: z.array(Guardrail).max(50).default([]),
  triggers: z.array(Trigger).max(50).default([]),
  cascade: z.object({
    database: z.number().min(0).max(1),
    text: z.number().min(0).max(1),
    semantic: z.number().min(0).max(1),
    semanticEnabled: z.boolean(),
  }).nullable().default(null),
  promptArchitecture: z.enum(PROMPT_ARCHITECTURES).optional(),
  masterPrompt: z.string().nullable().optional(),
  /** Lot 85C : absent (client antérieur) = profils en place conservés. */
  operationProfiles: z.record(z.string().max(80), OperationProfile).optional(),
});
