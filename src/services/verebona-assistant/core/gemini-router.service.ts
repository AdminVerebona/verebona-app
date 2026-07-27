/**
 * Routeur Gemini — CDC §15.
 *
 * Décide SI un appel Gemini est justifié (offre éligible + intention éligible + sources
 * présentes + budget restant), choisit l'alias de modèle, gère l'escalade (≤ 2 appels
 * au total — §15.5) et le circuit breaker (§30.4). Ne construit pas le prompt (délégué
 * à prompt-builder) et ne parle jamais d'un id modèle en dur (alias only — §15.11).
 */
import type { IntentRoute } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';
import { getAssistantConfig } from '../config/assistant-config';
import { resolveModel } from '../registries/model-registry';

export interface GeminiDecision {
  shouldCall: boolean;
  modelAlias: string;
  reason: string;
}

export function decideGeminiCall(route: IntentRoute, sources: RetrievedSource[], callsSoFar: number): GeminiDecision {
  const cfg = getAssistantConfig();
  if (!cfg.aiEnabled) return { shouldCall: false, modelAlias: cfg.defaultModelAlias, reason: 'IA désactivée' };
  if (!route.aiEligible) return { shouldCall: false, modelAlias: cfg.defaultModelAlias, reason: 'intention/offre non éligible' };
  if (sources.length === 0) return { shouldCall: false, modelAlias: cfg.defaultModelAlias, reason: 'aucune source (retrieval-first)' };
  if (callsSoFar >= cfg.maxAiCallsPerRequest) return { shouldCall: false, modelAlias: cfg.defaultModelAlias, reason: 'budget IA épuisé' };
  return { shouldCall: true, modelAlias: cfg.defaultModelAlias, reason: 'synthèse justifiée' };
}

/** Choisit l'alias d'escalade si une seconde passe est nécessaire (§15.6). */
export function escalationAlias(): string {
  const cfg = getAssistantConfig();
  // Vérifie la résolvabilité (lève si déprécié).
  resolveModel(cfg.escalationModelAlias);
  return cfg.escalationModelAlias;
}

// ── Circuit breaker minimal en mémoire (§30.4) ──────────────────────────────
let _consecutiveFailures = 0;
let _openedUntil = 0;

export function circuitAllowsCall(now = Date.now()): boolean {
  return now >= _openedUntil;
}
export function recordCallOutcome(success: boolean, now = Date.now()): void {
  if (success) { _consecutiveFailures = 0; return; }
  _consecutiveFailures += 1;
  if (_consecutiveFailures >= 5) { _openedUntil = now + 60_000; _consecutiveFailures = 0; }
}
