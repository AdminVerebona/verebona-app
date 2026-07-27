/**
 * Configuration V1 de référence — CDC §43.
 *
 * Toutes les valeurs proviennent de l'environnement (ou d'une admin sécurisée) et
 * sont modifiables SANS changer le code métier (§15.8, §43). Les noms d'alias, limites,
 * locale, idempotence et conservation sont obligatoires (§43).
 */

function num(name: string, def: number): number {
  const v = process.env[name];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null) return def;
  return v === 'true' || v === '1';
}
function str(name: string, def: string): string {
  return process.env[name] ?? def;
}

export interface AssistantConfig {
  enabled: boolean;
  aiEnabled: boolean;
  aiFallbackEnabled: boolean;
  defaultModelAlias: string;
  escalationModelAlias: string;
  /** Résolution initiale des alias (le registre de modèles peut surcharger). */
  modelDefault: string;
  modelEscalation: string;
  maxAiCallsPerRequest: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxSources: number;
  maxVisibleSources: number;
  maxExcerptChars: number;
  aiTimeoutMs: number;
  totalTimeoutMs: number;
  historyDays: number;
  rateLimitPerMinute: number;
  locale: string;
  retrievalCacheTtlSeconds: number;
  helpCacheTtlSeconds: number;
  idempotencyTtlSeconds: number;
  webGroundingEnabled: boolean;
  geminiStore: boolean;
  // Limites retrieval (§13.9) et budget (§31.2)
  maxCandidates: number;
  // Coûts (§31.3)
  costAlertPerResponseUsd: number;
}

export function loadAssistantConfig(): AssistantConfig {
  return {
    enabled: bool('VEREBONA_ASSISTANT_ENABLED', true),
    aiEnabled: bool('VEREBONA_ASSISTANT_AI_ENABLED', true),
    aiFallbackEnabled: bool('VEREBONA_ASSISTANT_AI_FALLBACK_ENABLED', true),
    defaultModelAlias: str('VEREBONA_ASSISTANT_DEFAULT_MODEL_ALIAS', 'assistant-default'),
    escalationModelAlias: str('VEREBONA_ASSISTANT_ESCALATION_MODEL_ALIAS', 'assistant-escalation'),
    modelDefault: str('VEREBONA_ASSISTANT_MODEL_ASSISTANT_DEFAULT', 'gemini-2.5-flash-lite'),
    modelEscalation: str('VEREBONA_ASSISTANT_MODEL_ASSISTANT_ESCALATION', 'gemini-3.1-flash-lite'),
    maxAiCallsPerRequest: num('VEREBONA_ASSISTANT_MAX_AI_CALLS_PER_REQUEST', 2),
    maxInputTokens: num('VEREBONA_ASSISTANT_MAX_INPUT_TOKENS', 12000),
    maxOutputTokens: num('VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS', 500),
    maxSources: num('VEREBONA_ASSISTANT_MAX_SOURCES', 8),
    maxVisibleSources: num('VEREBONA_ASSISTANT_MAX_VISIBLE_SOURCES', 5),
    maxExcerptChars: num('VEREBONA_ASSISTANT_MAX_EXCERPT_CHARS', 1500),
    aiTimeoutMs: num('VEREBONA_ASSISTANT_AI_TIMEOUT_MS', 12000),
    totalTimeoutMs: num('VEREBONA_ASSISTANT_TOTAL_TIMEOUT_MS', 20000),
    historyDays: num('VEREBONA_ASSISTANT_HISTORY_DAYS', 7),
    rateLimitPerMinute: num('VEREBONA_ASSISTANT_RATE_LIMIT_PER_MINUTE', 10),
    locale: str('VEREBONA_ASSISTANT_LOCALE', 'fr-FR'),
    retrievalCacheTtlSeconds: num('VEREBONA_ASSISTANT_RETRIEVAL_CACHE_TTL_SECONDS', 300),
    helpCacheTtlSeconds: num('VEREBONA_ASSISTANT_HELP_CACHE_TTL_SECONDS', 86400),
    idempotencyTtlSeconds: num('VEREBONA_ASSISTANT_IDEMPOTENCY_TTL_SECONDS', 900),
    webGroundingEnabled: bool('VEREBONA_ASSISTANT_WEB_GROUNDING_ENABLED', false),
    geminiStore: bool('VEREBONA_ASSISTANT_GEMINI_STORE', false),
    maxCandidates: num('VEREBONA_ASSISTANT_MAX_CANDIDATES', 20),
    costAlertPerResponseUsd: num('VEREBONA_ASSISTANT_COST_ALERT_USD', 0.005),
  };
}

let _cached: AssistantConfig | null = null;
export function getAssistantConfig(): AssistantConfig {
  if (!_cached) _cached = loadAssistantConfig();
  return _cached;
}

/**
 * Contrôle au démarrage — CDC §15.14.
 * Refuse une configuration incohérente (fail-fast) et journalise.
 */
export function assertConfigAtStartup(cfg: AssistantConfig = getAssistantConfig()): void {
  const errors: string[] = [];

  if (cfg.webGroundingEnabled) errors.push('Recherche web interdite en V1 (§15.7)');
  if (cfg.maxAiCallsPerRequest > 2) errors.push('MAX_AI_CALLS_PER_REQUEST > 2 interdit (§15.5)');
  if (cfg.geminiStore) errors.push('GEMINI_STORE doit rester false en V1 (§25.4)');
  if (cfg.maxSources > 8) errors.push('MAX_SOURCES > 8 interdit (§13.9)');
  if (cfg.maxOutputTokens > 500) errors.push('MAX_OUTPUT_TOKENS > 500 hors budget V1 (§31.2)');

  // §15.14 : refuser default == fallback sans décision explicite.
  if (
    cfg.defaultModelAlias === cfg.escalationModelAlias &&
    process.env.VEREBONA_ASSISTANT_ALLOW_SAME_MODEL !== 'true'
  ) {
    errors.push('Alias default == escalation sans décision explicite (§15.14)');
  }
  // Interdiction d'un alias fournisseur "latest" (§15.13).
  for (const m of [cfg.modelDefault, cfg.modelEscalation]) {
    if (/latest/i.test(m)) errors.push(`Modèle "${m}" : alias "latest" interdit (§15.13)`);
  }

  if (errors.length) {
    throw new Error(`[verebona-assistant] Configuration invalide:\n - ${errors.join('\n - ')}`);
  }
}
