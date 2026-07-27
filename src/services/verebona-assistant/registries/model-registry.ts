/**
 * Registre de modèles & alias fonctionnels — CDC §15.11 / §15.12 / §15.13.
 *
 * Le métier n'utilise JAMAIS un id fournisseur en dur : il passe par un alias
 * (`assistant-default`, `assistant-escalation`). Changer le modèle résolu ne
 * nécessite aucune modification du routeur métier (CA-25).
 */
import { getAssistantConfig } from '../config/assistant-config';

export type ModelStatus = 'stable' | 'preview' | 'deprecated';

export interface ModelEntry {
  alias: string;                 // alias fonctionnel
  provider: 'google';            // fournisseur
  modelId: string;               // identifiant exact (jamais "latest" — §15.13)
  status: ModelStatus;
  activatedAt: string;           // ISO
  plannedEndAt?: string | null;  // date de fin prévue / dépréciation
  capabilities: string[];        // ex: ['structured_output','fr']
  inputPricePerMTokUsd: number;  // renseigné via pricing-catalog
  outputPricePerMTokUsd: number;
  contextLimit: number;
  compatiblePrompts: string[];
  rollbackModelId?: string | null;
}

/**
 * Registre initial. En production, il peut être surchargé par une table d'admin
 * (§28.11). Les preview ne sont pas utilisés par défaut (§15.12).
 */
function buildRegistry(): Record<string, ModelEntry> {
  const cfg = getAssistantConfig();
  return {
    [cfg.defaultModelAlias]: {
      alias: cfg.defaultModelAlias,
      provider: 'google',
      modelId: cfg.modelDefault, // gemini-2.5-flash-lite
      status: 'stable',
      activatedAt: '2026-07-16',
      plannedEndAt: null,
      capabilities: ['structured_output', 'fr', 'multimodal'],
      inputPricePerMTokUsd: 0.1,
      outputPricePerMTokUsd: 0.4,
      contextLimit: 1_000_000,
      compatiblePrompts: ['account-summary', 'account-comparison', 'account-timeline', 'clarification', 'product-help', 'intent-classification'],
      rollbackModelId: null,
    },
    [cfg.escalationModelAlias]: {
      alias: cfg.escalationModelAlias,
      provider: 'google',
      modelId: cfg.modelEscalation, // gemini-3.1-flash-lite (à revérifier avant prod — §15.13)
      status: 'stable',
      activatedAt: '2026-07-16',
      plannedEndAt: null,
      capabilities: ['structured_output', 'fr', 'multimodal'],
      inputPricePerMTokUsd: 0.1,
      outputPricePerMTokUsd: 0.4,
      contextLimit: 1_000_000,
      compatiblePrompts: ['account-summary', 'account-comparison', 'account-timeline'],
      rollbackModelId: cfg.modelDefault,
    },
  };
}

let _registry: Record<string, ModelEntry> | null = null;
function registry(): Record<string, ModelEntry> {
  if (!_registry) _registry = buildRegistry();
  return _registry;
}

/** Résout un alias vers son id modèle. Refuse un preview en prod par défaut (§15.12). */
export function resolveModel(alias: string, opts?: { allowPreview?: boolean }): ModelEntry {
  const entry = registry()[alias];
  if (!entry) throw new Error(`Alias de modèle inconnu: ${alias}`);
  if (entry.status === 'deprecated') {
    throw new Error(`Modèle déprécié pour l'alias ${alias} — rollback requis (§15.13)`);
  }
  if (entry.status === 'preview' && !opts?.allowPreview) {
    throw new Error(`Modèle preview non autorisé en production pour ${alias} (§15.12)`);
  }
  return entry;
}

/** Alerte de dépréciation (§15.13) — à brancher sur l'observabilité (§32). */
export function getDeprecationAlerts(now = new Date()): Array<{ alias: string; endsAt: string }> {
  return Object.values(registry())
    .filter((e) => e.plannedEndAt && new Date(e.plannedEndAt) <= now)
    .map((e) => ({ alias: e.alias, endsAt: e.plannedEndAt as string }));
}

/** Utilisé au démarrage (§15.14) : les alias configurés se résolvent-ils ? */
export function assertAliasesResolvable(): void {
  const cfg = getAssistantConfig();
  resolveModel(cfg.defaultModelAlias);
  resolveModel(cfg.escalationModelAlias);
}
