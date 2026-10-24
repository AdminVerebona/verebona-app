/**
 * Paramètres de génération Gemini — CDC BO IA §2.1 ; lot 85C (CDC Pilotage
 * IA V2 P4, INV-03, CAT-03, CFG-03).
 *
 * Projection, sur le `generationConfig` de l'API Gemini, des paramètres
 * RÉSOLUS par le constructeur de requête unique (`request-builder.ts`) à
 * partir des CAPACITÉS du modèle (`model-capabilities.ts`). Ce module ne lit
 * plus jamais le nom du modèle : plus de « famille 3.x → thinkingLevel »,
 * « 2.5 Pro → budget 128 » ni de température imposée à tous (lot 85C — ces
 * règles sont désormais des RÉFÉRENCES documentées et datées, par
 * identifiant exact, dans la fiche de capacités).
 *
 * Validation, qualification et exécution passent par la même fonction : un
 * appel qui a fourni ses paramètres résolus (`generation`, passerelle) les
 * réutilise tels quels ; un appel technique direct (sonde, test de clé) les
 * fait résoudre par le même constructeur.
 */
import type { ReasoningLevel } from '../../config/config-types';
import { AiGatewayError } from '../errors';
import {
  buildModelRequest, thinkingParamLabel, type ModelRequestResult, type ResolvedGenerationParams,
} from '../request-builder';

/** Configuration de raisonnement transmise dans `generationConfig.thinkingConfig`. */
export type GeminiThinkingConfig = { thinkingLevel: string } | { thinkingBudget: number };

/** Libellé BO du raisonnement transmis : `aucun`, `low`, `high`, `budget N`. */
export function thinkingConfigLabel(tc: GeminiThinkingConfig | undefined | null): string {
  return thinkingParamLabel(tc ?? null);
}

export interface GenerationConfigInput {
  model: string;
  maxOutputTokens?: number;
  reasoning?: ReasoningLevel | null;
  jsonResponse?: boolean;
  /** Lot 33D : schéma JSON réduit (structured output). Implique le mode JSON. */
  responseSchema?: Record<string, unknown>;
  /** Lot 85C : paramètres déjà résolus par le constructeur unique (passerelle). */
  generation?: ResolvedGenerationParams;
}

/**
 * Paramètres résolus d'un appel : ceux fournis par la passerelle, sinon ceux
 * du constructeur unique appliqué au niveau et au plafond demandés.
 */
export function resolveGenerationParams(input: GenerationConfigInput): ModelRequestResult {
  if (input.generation) {
    return {
      ok: true, params: input.generation,
      trace: {
        model: input.model, family: null, reasoning: { requested: input.reasoning ?? null, sent: thinkingParamLabel(input.generation.thinking) },
        maxOutputTokens: { requested: input.maxOutputTokens ?? null, origin: 'none', operationFloor: null, callerCap: null, modelLimit: null, adapted: input.generation.maxOutputTokens, sent: input.generation.maxOutputTokens },
        temperature: { profile: null, sent: input.generation.temperature }, adaptations: [], capabilitySources: {},
      },
    };
  }
  return buildModelRequest({ model: input.model, reasoning: input.reasoning ?? null, maxOutputTokens: input.maxOutputTokens ?? null, maxOutputTokensOrigin: 'probe' });
}

/**
 * Lot 52B — réglages EFFECTIFS d'un appel, lus sur le `generationConfig`
 * réellement construit (même fonction que l'adaptateur) : rien n'est
 * recalculé à part. Aucun contenu : ni prompt, ni schéma.
 */
export function describeGenerationConfig(input: GenerationConfigInput): {
  responseSchemaSent: boolean; responseMimeType: string | null; maxOutputTokens: number | null; thinkingConfig: string;
  temperature: number | null; refused: string | null;
} {
  const r = resolveGenerationParams(input);
  if (!r.ok) {
    return { responseSchemaSent: false, responseMimeType: null, maxOutputTokens: null, thinkingConfig: 'refusé', temperature: null, refused: r.refusal.parameter };
  }
  const cfg = generationConfigOf(r.params, input);
  return {
    responseSchemaSent: cfg.responseJsonSchema !== undefined,
    responseMimeType: typeof cfg.responseMimeType === 'string' ? cfg.responseMimeType : null,
    maxOutputTokens: typeof cfg.maxOutputTokens === 'number' ? cfg.maxOutputTokens : null,
    thinkingConfig: thinkingConfigLabel(cfg.thinkingConfig as GeminiThinkingConfig | undefined),
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : null,
    refused: null,
  };
}

/** `generationConfig` Gemini d'un jeu de paramètres résolus (pur). */
export function generationConfigOf(p: ResolvedGenerationParams, input: Pick<GenerationConfigInput, 'jsonResponse' | 'responseSchema'>): Record<string, unknown> {
  return {
    ...(p.temperature !== null ? { temperature: p.temperature } : {}),
    // Absent = défaut du fournisseur. Le §2.1 rend ce plafond administrable ;
    // l'appliquer ici est ce qui empêche le champ d'être décoratif.
    ...(p.maxOutputTokens ? { maxOutputTokens: p.maxOutputTokens } : {}),
    ...(p.thinking ? { thinkingConfig: p.thinking } : {}),
    // Mode JSON natif, déclaré par l'opération.
    ...(input.jsonResponse || input.responseSchema ? { responseMimeType: 'application/json' } : {}),
    // Structured output (lot 33D, §23) : la génération est contrainte par le
    // schéma ; la normalisation et la validation restent appliquées ensuite.
    ...(input.responseSchema ? { responseJsonSchema: input.responseSchema } : {}),
  };
}

/**
 * `generationConfig` complet d'un appel. Combinaison connue comme
 * incompatible : refus AVANT appel (`MODEL_PARAMETERS_INCOMPATIBLE`, étape
 * `request_build`, récupérable — un autre modèle de la chaîne peut convenir).
 */
export function buildGenerationConfig(input: GenerationConfigInput): Record<string, unknown> {
  const r = resolveGenerationParams(input);
  if (!r.ok) {
    throw Object.assign(new AiGatewayError('MODEL_PARAMETERS_INCOMPATIBLE', 'n/a', r.refusal.message, { recoverable: true }), {
      aiStage: 'request_build', rejectedParameter: r.refusal.parameter,
    });
  }
  return generationConfigOf(r.params, input);
}
