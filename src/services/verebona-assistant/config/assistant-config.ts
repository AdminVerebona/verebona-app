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
/**
 * Interrupteur « activé par défaut » : seules les valeurs explicites
 * off / false / 0 / no le coupent (casse et espaces ignorés). Toute autre
 * valeur, ou l'absence de variable, le laisse actif — une faute de frappe ne
 * doit pas couper silencieusement une fonction en production.
 */
export function flagOnByDefault(raw: string | undefined): boolean {
  if (raw == null) return true;
  return !['off', 'false', '0', 'no'].includes(raw.trim().toLowerCase());
}

/**
 * Commandes d'écriture actives ? Lu à CHAQUE appel (pas de cache) : couper
 * l'interrupteur prend effet dès la relecture de l'environnement, et les
 * tests peuvent le basculer sans réinitialiser la configuration.
 */
export function areWriteCommandsEnabled(): boolean {
  return flagOnByDefault(process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS);
}

/** Message français rendu quand une commande est refusée par l'interrupteur. */
export const WRITE_COMMANDS_DISABLED_MESSAGE =
  'Les modifications depuis l’assistant sont désactivées. Rien n’a été modifié : '
  + 'vous pouvez faire ce changement directement depuis l’écran concerné.';

export interface AssistantConfig {
  enabled: boolean;
  aiEnabled: boolean;
  /** false : une seule tentative modèle par appel, sans escalade (§15.6, §43). */
  aiFallbackEnabled: boolean;
  /**
   * Commandes d'écriture depuis le chat (« ajoute un rappel… »).
   *
   * Écart assumé au CDC §4.8 / §5.2 / §22.5 (V1 sans écriture) : décision
   * produit de les CONSERVER, mais derrière l'interrupteur
   * `VEREBONA_ASSISTANT_WRITE_COMMANDS` (défaut : activé ; off/false/0 →
   * désactivé). Désactivé : aucun plan n'est préparé (ports.prepareCommand)
   * et toute confirmation est refusée (routes commands/[planId]/confirm|cancel).
   */
  writeCommandsEnabled: boolean;
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
  /**
   * Plafond budgétaire par compte et par mois civil (§6.6, §31.3), en
   * micro-unités de la grille tarifaire de la passerelle (colonne
   * `estimated_cost_micros` de `verebona_ai_runs`). 0 = pas de plafond.
   */
  monthlyBudgetMicros: number;
  /** Part du plafond à partir de laquelle une alerte d'exploitation est émise. */
  budgetAlertRatio: number;
}

export function loadAssistantConfig(): AssistantConfig {
  return {
    enabled: bool('VEREBONA_ASSISTANT_ENABLED', true),
    aiEnabled: bool('VEREBONA_ASSISTANT_AI_ENABLED', true),
    aiFallbackEnabled: bool('VEREBONA_ASSISTANT_AI_FALLBACK_ENABLED', true),
    // Les MODÈLES ne sont plus configurés ici (CDC §15.3, §15.8, §15.11) :
    // `registries/model-registry.ts` et les variables
    // VEREBONA_ASSISTANT_MODEL_* n'étaient lus par aucun chemin d'exécution et
    // annonçaient gemini-2.5 alors que la passerelle appelait gemini-3.5.
    // Source unique : `services/ai/registry/operations.ts` (surchargeable par
    // la configuration versionnée du BO). Les alias fonctionnels
    // (assistant-default / assistant-escalation) sont dérivés à la trace
    // (`usage-tracking.service.ts`), le contrôle de démarrage lit les
    // opérations réelles (`assertConfigAtStartup`).
    writeCommandsEnabled: flagOnByDefault(process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS),
    maxAiCallsPerRequest: num('VEREBONA_ASSISTANT_MAX_AI_CALLS_PER_REQUEST', 2),
    maxInputTokens: num('VEREBONA_ASSISTANT_MAX_INPUT_TOKENS', 12000),
    maxOutputTokens: num('VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS', 500),
    maxSources: num('VEREBONA_ASSISTANT_MAX_SOURCES', 8),
    maxVisibleSources: num('VEREBONA_ASSISTANT_MAX_VISIBLE_SOURCES', 5),
    maxExcerptChars: num('VEREBONA_ASSISTANT_MAX_EXCERPT_CHARS', 1500),
    aiTimeoutMs: num('VEREBONA_ASSISTANT_AI_TIMEOUT_MS', 12000),
    totalTimeoutMs: num('VEREBONA_ASSISTANT_TOTAL_TIMEOUT_MS', 20000),
    // Centre d'aide GAP-16 / T2-09 : la décision produit fixe 3 mois
    // d'historique conversationnel (et non 7 jours). Surchargeable par
    // environnement ; la purge doit lire la même variable.
    historyDays: num('VEREBONA_ASSISTANT_HISTORY_DAYS', 90),
    rateLimitPerMinute: num('VEREBONA_ASSISTANT_RATE_LIMIT_PER_MINUTE', 10),
    locale: str('VEREBONA_ASSISTANT_LOCALE', 'fr-FR'),
    retrievalCacheTtlSeconds: num('VEREBONA_ASSISTANT_RETRIEVAL_CACHE_TTL_SECONDS', 300),
    helpCacheTtlSeconds: num('VEREBONA_ASSISTANT_HELP_CACHE_TTL_SECONDS', 86400),
    idempotencyTtlSeconds: num('VEREBONA_ASSISTANT_IDEMPOTENCY_TTL_SECONDS', 900),
    webGroundingEnabled: bool('VEREBONA_ASSISTANT_WEB_GROUNDING_ENABLED', false),
    geminiStore: bool('VEREBONA_ASSISTANT_GEMINI_STORE', false),
    maxCandidates: num('VEREBONA_ASSISTANT_MAX_CANDIDATES', 20),
    costAlertPerResponseUsd: num('VEREBONA_ASSISTANT_COST_ALERT_USD', 0.005),
    // 2 000 000 micro-unités ≈ 2 USD / compte / mois, soit ~1 000 réponses
    // intelligentes à l'objectif de 0,002 USD (§31.3) : un garde-fou contre
    // l'usage anormal, jamais atteint par un usage normal.
    monthlyBudgetMicros: num('VEREBONA_ASSISTANT_MONTHLY_BUDGET_MICROS', 2_000_000),
    budgetAlertRatio: num('VEREBONA_ASSISTANT_BUDGET_ALERT_RATIO', 0.8),
  };
}

let _cached: AssistantConfig | null = null;
export function getAssistantConfig(): AssistantConfig {
  if (!_cached) _cached = loadAssistantConfig();
  return _cached;
}
/** Réservé aux tests : relit l'environnement au prochain appel. */
export function resetAssistantConfigForTests(): void {
  _cached = null;
}

/** Opérations passerelle de l'assistant (source unique des modèles). */
export const ASSISTANT_OPERATIONS = ['understand_request', 'revalidate_fact', 'generate_answer'] as const;

/** Modèles d'une opération, tels que la contrôle le démarrage. */
export interface OperationModels { primaryModel: string; fallbackModels: string[] }

/**
 * Contrôle au démarrage — CDC §15.14, §15.13, §15.7, §31.2.
 * Refuse une configuration incohérente (fail-fast) et journalise.
 *
 * Les modèles contrôlés sont ceux que la passerelle appelle RÉELLEMENT
 * (`AI_OPERATIONS`), et non plus un registre parallèle jamais lu.
 */
export function assertConfigAtStartup(
  cfg: AssistantConfig = getAssistantConfig(),
  operations: Record<string, OperationModels | undefined> = {},
): void {
  const errors: string[] = [];

  if (cfg.webGroundingEnabled) errors.push('Recherche web interdite en V1 (§15.7)');
  if (cfg.maxAiCallsPerRequest > 2) errors.push('MAX_AI_CALLS_PER_REQUEST > 2 interdit (§15.5)');
  if (cfg.geminiStore) errors.push('GEMINI_STORE doit rester false en V1 (§25.4)');
  if (cfg.maxSources > 8) errors.push('MAX_SOURCES > 8 interdit (§13.9)');
  if (cfg.maxOutputTokens > 500) errors.push('MAX_OUTPUT_TOKENS > 500 hors budget V1 (§31.2)');
  if (cfg.monthlyBudgetMicros < 0) errors.push('MONTHLY_BUDGET_MICROS négatif');

  for (const code of ASSISTANT_OPERATIONS) {
    const op = operations[code];
    if (!op) { errors.push(`Opération passerelle « ${code} » absente`); continue; }
    const modeles = [op.primaryModel, ...op.fallbackModels];
    // §15.13 : jamais d'alias fournisseur « latest ».
    for (const m of modeles) if (/latest/i.test(m)) errors.push(`${code} : alias « latest » interdit (${m}) (§15.13)`);
    // §15.6 / §31.2 : aucun modèle Pro dans le chemin utilisateur.
    for (const m of modeles) if (/-pro\b/i.test(m)) errors.push(`${code} : modèle Pro interdit (${m}) (§15.6)`);
    // §15.14 : escalade identique au modèle par défaut sans décision explicite.
    if (op.fallbackModels.includes(op.primaryModel) && process.env.VEREBONA_ASSISTANT_ALLOW_SAME_MODEL !== 'true') {
      errors.push(`${code} : modèle d'escalade identique au modèle par défaut (§15.14)`);
    }
  }

  if (errors.length) {
    throw new Error(`[verebona-assistant] Configuration invalide:\n - ${errors.join('\n - ')}`);
  }
}
