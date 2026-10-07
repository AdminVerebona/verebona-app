/**
 * Configuration V1 de référence — CDC §43.
 *
 * Toutes les valeurs proviennent de l'environnement (ou d'une admin sécurisée) et
 * sont modifiables SANS changer le code métier (§15.8, §43). Les noms d'alias, limites,
 * locale, idempotence et conservation sont obligatoires (§43).
 */

import { isAssistantFlagOn } from './assistant-flags.server';
import { onAssistantSettingsChange, overrideForEnv } from './assistant-settings';
import { ASSISTANT_MAX_OUTPUT_TOKENS } from '@/services/ai/registry/operations';

// D-J1 (lot 21) : une valeur administrée dans le BO (`assistant-settings.ts`)
// prime sur la variable d'environnement, qui reste la valeur initiale et le
// repli documenté.
function num(name: string, def: number): number {
  const o = overrideForEnv(name);
  if (typeof o === 'number') return o;
  const v = process.env[name];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(name: string, def: boolean): boolean {
  const o = overrideForEnv(name);
  if (typeof o === 'boolean') return o;
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
  const o = overrideForEnv('VEREBONA_ASSISTANT_WRITE_COMMANDS');
  if (typeof o === 'boolean') return o;
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
  maxSources: number;
  maxVisibleSources: number;
  maxExcerptChars: number;
  /** Timeout par tentative modèle (§30.1 : 12 s), appliqué par la passerelle. */
  aiTimeoutMs: number;
  /** Retrieval déterministe (§30.1 : 3 s au plus). */
  retrievalTimeoutMs: number;
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
  /**
   * Nombre d'événements d'une chronologie (CDC 15 T2-34), DISTINCT du budget
   * de sources (`maxSources`) : les événements sont regroupés en sources
   * compactes. Défaut 60, borné à 1…200.
   */
  timelineMaxEvents: number;
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
    // Flags du §39 (`assistant-flags.ts`) : account_ai et fallback_model.
    aiEnabled: isAssistantFlagOn('account_ai'),
    aiFallbackEnabled: isAssistantFlagOn('fallback_model'),
    // Les MODÈLES ne sont plus configurés ici (CDC §15.3, §15.8, §15.11) :
    // `registries/model-registry.ts` et les variables
    // VEREBONA_ASSISTANT_MODEL_* n'étaient lus par aucun chemin d'exécution et
    // annonçaient gemini-2.5 alors que la passerelle appelait gemini-3.5.
    // Source unique : `services/ai/registry/operations.ts` (surchargeable par
    // la configuration versionnée du BO). Les alias fonctionnels sont
    // CONFIGURÉS (§15.11, §43 : VEREBONA_ASSISTANT_*_MODEL_ALIAS et
    // VEREBONA_ASSISTANT_MODEL_ASSISTANT_*) dans `registries/model-registry.ts`,
    // résolus au moment de l'appel ; le contrôle du registre (§15.14) tourne
    // au démarrage et à chaque changement de configuration
    // (`core/model-startup-check.ts`).
    writeCommandsEnabled: areWriteCommandsEnabled(),
    maxAiCallsPerRequest: num('VEREBONA_ASSISTANT_MAX_AI_CALLS_PER_REQUEST', 2),
    maxInputTokens: num('VEREBONA_ASSISTANT_MAX_INPUT_TOKENS', 12000),
    // `maxOutputTokens` retiré (CDC 15 T2-43) : la configuration IA effective
    // de l'opération le fixe, bornée par `assistantMaxOutputTokensCap()`.
    maxSources: num('VEREBONA_ASSISTANT_MAX_SOURCES', 8),
    maxVisibleSources: num('VEREBONA_ASSISTANT_MAX_VISIBLE_SOURCES', 5),
    maxExcerptChars: num('VEREBONA_ASSISTANT_MAX_EXCERPT_CHARS', 1500),
    aiTimeoutMs: num('VEREBONA_ASSISTANT_AI_TIMEOUT_MS', 12000),
    retrievalTimeoutMs: num('VEREBONA_ASSISTANT_RETRIEVAL_TIMEOUT_MS', 3000),
    totalTimeoutMs: num('VEREBONA_ASSISTANT_TOTAL_TIMEOUT_MS', 20000),
    // Historique conversationnel : 90 jours (3 mois). Le CDC Assistant §24.1
    // prévoyait 7 jours, mais le cadrage produit, repris par le CDC Centre
    // d'aide (GAP-16, bloquant), a fixé 3 mois — décision la plus récente,
    // déjà livrée au lot 1 et décrite dans les articles d'aide. Seul
    // l'historique suit cette durée ; les journaux ont leurs propres durées
    // (§29.7 : logs techniques 90 j, traces détaillées expurgées 30 j,
    // agrégats et feedback 13 mois — `purge-assistant-logs.job.ts`).
    // La purge lit cette même valeur.
    historyDays: num('VEREBONA_ASSISTANT_HISTORY_DAYS', 90),
    rateLimitPerMinute: num('VEREBONA_ASSISTANT_RATE_LIMIT_PER_MINUTE', 10),
    locale: str('VEREBONA_ASSISTANT_LOCALE', 'fr-FR'),
    retrievalCacheTtlSeconds: num('VEREBONA_ASSISTANT_RETRIEVAL_CACHE_TTL_SECONDS', 300),
    helpCacheTtlSeconds: num('VEREBONA_ASSISTANT_HELP_CACHE_TTL_SECONDS', 86400),
    idempotencyTtlSeconds: num('VEREBONA_ASSISTANT_IDEMPOTENCY_TTL_SECONDS', 900),
    webGroundingEnabled: bool('VEREBONA_ASSISTANT_WEB_GROUNDING_ENABLED', false),
    geminiStore: bool('VEREBONA_ASSISTANT_GEMINI_STORE', false),
    maxCandidates: num('VEREBONA_ASSISTANT_MAX_CANDIDATES', 20),
    timelineMaxEvents: Math.min(Math.max(Math.trunc(num('VEREBONA_ASSISTANT_TIMELINE_MAX_EVENTS', 60)) || 60, 1), 200),
    costAlertPerResponseUsd: num('VEREBONA_ASSISTANT_COST_ALERT_USD', 0.005),
    // Lot 32 (décision PO Q23 : « pas de valeur pour l'instant ») : aucun
    // plafond par défaut (0). Réglable sans développement (BO → Configuration
    // IA → seuils) ; les coûts restent mesurés et les alertes de coût actives.
    monthlyBudgetMicros: num('VEREBONA_ASSISTANT_MONTHLY_BUDGET_MICROS', 0),
    budgetAlertRatio: num('VEREBONA_ASSISTANT_BUDGET_ALERT_RATIO', 0.8),
  };
}

let _cached: AssistantConfig | null = null;
// Réglages administrés modifiés (cette instance ou une autre) : relecture.
onAssistantSettingsChange(() => { _cached = null; });
export function getAssistantConfig(): AssistantConfig {
  if (!_cached) _cached = loadAssistantConfig();
  return _cached;
}
/** Réservé aux tests : relit l'environnement au prochain appel. */
export function resetAssistantConfigForTests(): void {
  _cached = null;
}

/**
 * Opérations passerelle de l'assistant (source unique des modèles) : les
 * branches du master T2 — seul moteur depuis le lot 16b-2.
 */
export const ASSISTANT_OPERATIONS = ['t2_understand', 't2_revalidate', 't2_answer'] as const;

/** Modèles d'une opération, tels que la contrôle le démarrage. */
export interface OperationModels { primaryModel: string; fallbackModels: string[] }

/**
 * Contrôle au démarrage — CDC §15.14, §15.13, §15.7, §31.2.
 * Refuse une configuration incohérente (fail-fast) et journalise.
 *
 * Les modèles contrôlés sont ceux que la passerelle appelle RÉELLEMENT
 * (`AI_OPERATIONS`), et non plus un registre parallèle jamais lu.
 */
/**
 * Budget V1 de sortie de l'assistant (CDC Assistant §31.2) — la constante du
 * référentiel des opérations, jamais une seconde valeur (T2-43).
 */
export const ASSISTANT_OUTPUT_TOKENS_BUDGET = ASSISTANT_MAX_OUTPUT_TOKENS;

let varRetireeSignalee = false;

/**
 * Plafond de jetons de sortie de l'assistant, appliqué PAR-DESSUS la
 * configuration IA effective (CDC 15 T2-43, arbitrage PO en attente) :
 * `min(valeur BO, 500)` — une version BO au-delà de 500 est signalée à la
 * validation et plafonnée ici.
 *
 * T2-43 (lot 15) : SOURCE UNIQUE. `VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS`
 * n'est plus lue du tout — ni pour relever, ni pour abaisser : une variable
 * d'environnement qui abaisse silencieusement le plafond BO est une seconde
 * source de vérité. Encore posée, elle est seulement SIGNALÉE (une fois).
 */
export function assistantMaxOutputTokensCap(env: NodeJS.ProcessEnv = process.env): number {
  const brut = env.VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS;
  if (brut !== undefined && brut.trim() !== '' && !varRetireeSignalee) {
    varRetireeSignalee = true;
    console.warn(
      `[verebona-assistant] VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS=${brut} : variable RETIRÉE et IGNORÉE (CDC 15 T2-43). `
      + 'Le plafond de sortie vient de la seule configuration IA (BO, traitement T2), borné à 500. '
      + 'À supprimer de l\'environnement.',
    );
  }
  return ASSISTANT_OUTPUT_TOKENS_BUDGET;
}

/** Réservé aux tests. */
export function __resetOutputTokensWarningForTests(): void {
  varRetireeSignalee = false;
}

export function assertConfigAtStartup(
  cfg: AssistantConfig = getAssistantConfig(),
  operations: Record<string, OperationModels | undefined> = {},
): void {
  const errors: string[] = [];
  // CDC 15 T2-43 : signale au démarrage une variable retirée encore posée.
  assistantMaxOutputTokensCap();

  if (cfg.webGroundingEnabled) errors.push('Recherche web interdite en V1 (§15.7)');
  if (cfg.maxAiCallsPerRequest > 2) errors.push('MAX_AI_CALLS_PER_REQUEST > 2 interdit (§15.5)');
  if (cfg.geminiStore) errors.push('GEMINI_STORE doit rester false en V1 (§25.4)');
  if (cfg.maxSources > 8) errors.push('MAX_SOURCES > 8 interdit (§13.9)');
  if (cfg.monthlyBudgetMicros < 0) errors.push('MONTHLY_BUDGET_MICROS négatif');

  for (const code of ASSISTANT_OPERATIONS) {
    const op = operations[code];
    if (!op) { errors.push(`Opération passerelle « ${code} » absente`); continue; }
    const modeles = [op.primaryModel, ...op.fallbackModels];
    // §15.13 : jamais d'alias fournisseur « latest ».
    for (const m of modeles) if (/latest/i.test(m)) errors.push(`${code} : alias « latest » interdit (${m}) (§15.13)`);
    // Lot 32B : plus d'interdit sur le NOM du modèle (ancien « aucun Pro »,
    // CDC Assistant V1 §15.6 / §31.2). Statut, compatibilité t2_master_v1,
    // capacités, tarif et preview sont contrôlés par le registre
    // (`model-startup-check`, `usableModelsForTreatment`).
    // §15.14 : escalade identique au modèle par défaut sans décision explicite.
    if (op.fallbackModels.includes(op.primaryModel) && process.env.VEREBONA_ASSISTANT_ALLOW_SAME_MODEL !== 'true') {
      errors.push(`${code} : modèle d'escalade identique au modèle par défaut (§15.14)`);
    }
  }

  if (errors.length) {
    throw new Error(`[verebona-assistant] Configuration invalide:\n - ${errors.join('\n - ')}`);
  }
}
