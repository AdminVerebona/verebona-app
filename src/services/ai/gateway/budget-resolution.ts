/**
 * Lot 111M (ticket « budgets IA », §3) — RÉSOLUTION UNIQUE DES BUDGETS
 * d'entrée et de sortie d'une opération, pour le modèle RÉELLEMENT sollicité.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN SECOND MOTEUR
 *
 * La sortie est résolue par les briques EXISTANTES, dans le même ordre que la
 * passerelle (`AiGateway.execute`, chaque tentative) :
 *   1. `rankSettings` — profil de l'opération pour ce rang, sinon référence du
 *      traitement (version BO), sinon valeur initiale du code ;
 *   2. `buildModelRequest` — plancher de l'opération, plafond d'appelant,
 *      adaptation à la limite DÉCLARÉE du modèle (fiche de capacités).
 * Ce module y ajoute seulement :
 *   · le budget d'ENTRÉE : limite d'entrée du modèle − plafond de sortie
 *     transmis − marge technique ; taille du prompt actif estimée ;
 *   · l'ORIGINE de chaque restriction (BO, opération, code, modèle, appelant,
 *     surcharge explicite) pour le BO et les diagnostics ;
 *   · un instantané en mémoire par opération (lecture synchrone pour les
 *     planificateurs qui ne peuvent pas attendre, ex. DOCUMENT_NAMING).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ESTIMATION CONSERVATRICE (aucun tokeniseur embarqué, aucun appel de plus)
 *
 * Le comptage exact du fournisseur (`usageMetadata.promptTokenCount`) n'est
 * connu qu'APRÈS l'appel : il est tracé par la passerelle (jetons d'entrée
 * réels) et sert à recaler l'estimation en recette. AVANT l'appel, la taille
 * est estimée à 3,5 caractères par jeton (texte français et JSON) : Gemini
 * compte en pratique ≈ 4 caractères par jeton sur ce contenu, l'estimation
 * SURÉVALUE donc d'environ 15 % — un dépassement réel est pire qu'une source
 * de moins. Un appel `countTokens` préalable doublerait la latence de chaque
 * appel pour un gain marginal : écarté (procédure de recalage en recette).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RAISONNEMENT (cohérent 109J / 109L)
 *
 * Chez Gemini, les jetons de raisonnement consomment le MÊME plafond
 * `maxOutputTokens` que la sortie visible ; ils sont facturés au tarif de
 * sortie et comptés UNE seule fois dans le coût (109J). Le plafond transmis
 * couvre donc raisonnement + sortie visible : `reasoningIncludedInCap`.
 * Un budget de raisonnement EXPLICITE (`thinkingBudget`) est déduit de la
 * sortie visible disponible (`visibleOutputAvailable`) ; un niveau
 * (`thinkingLevel`) ou le défaut du modèle : consommation inconnue à
 * l'avance (`null`), surveillée par la saturation (`finishReason`).
 *
 * Pur, sauf `resolveOperationBudget` / `primeOperationBudget` (lecture de la
 * configuration effective, déjà en cache) et l'instantané en mémoire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getOperation, type AiOperationDefinition } from '../registry/operations';
import { capabilitiesOf, type ModelCapabilities } from '../provider/model-capabilities';
import { rankSettings, type GenerationConfigInput } from './generation-profile';
import { buildModelRequest, type RequestTrace } from './request-builder';

/** Caractères par jeton de l'estimation prudente (voir l'en-tête). */
export const CONSERVATIVE_CHARS_PER_TOKEN = 3.5;
/**
 * Marge technique sur la limite d'entrée du modèle (part réservée aux écarts
 * de tokenisation, aux pièces jointes non estimées et à l'enveloppe du
 * fournisseur). 5 % : la limite d'entrée des modèles en service (≥ 1 M) rend
 * cette marge sans effet sur les budgets applicatifs, qui restent bien en deçà.
 */
export const INPUT_SAFETY_MARGIN_RATIO = 0.05;

/** Jetons estimés d'un texte ou d'une valeur sérialisée (prudent, pur). */
export function estimateTokens(v: unknown): number {
  if (v == null) return 0;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return Math.ceil((s?.length ?? 0) / CONSERVATIVE_CHARS_PER_TOKEN);
}

/** Origine d'une restriction appliquée au budget (BO, diagnostics). */
export type BudgetRestrictionOrigin =
  | 'bo_operation_rank' | 'bo_operation' | 'bo_treatment' | 'code_default'
  | 'operation_floor' | 'caller_cap' | 'model_output_limit' | 'model_input_limit'
  | 'explicit_override' | 'reasoning_budget';

export interface BudgetRestriction {
  parameter: 'maxOutputTokens' | 'inputTokens' | 'visibleOutput';
  origin: BudgetRestrictionOrigin;
  value: number | null;
  detail: string;
}

export interface ResolvedBudget {
  operationCode: string;
  rank: number;
  model: string;
  configVersionId: number | null;
  output: {
    /** Valeur DEMANDÉE avant plancher / appelant / modèle (BO ou code). */
    configured: number | null;
    configuredOrigin: RequestTrace['maxOutputTokens']['origin'];
    operationFloor: number | null;
    callerCap: number | null;
    modelLimit: number | null;
    /** Plafond réellement transmis (`null` : défaut du fournisseur). */
    sent: number | null;
    /** Raisonnement compris dans le plafond (convention Gemini). */
    reasoningIncludedInCap: true;
    /** Budget de raisonnement explicite transmis, sinon `null` (niveau ou défaut : inconnu). */
    reasoningBudget: number | null;
    /** Sortie visible disponible si le budget de raisonnement est entièrement consommé ; `null` : inconnue. */
    visibleOutputAvailable: number | null;
  };
  reasoning: { requested: string | null; sent: string | null };
  input: {
    modelLimit: number | null;
    /** Limite d'entrée moins sortie transmise et marge technique ; `null` : limite du modèle inconnue. */
    available: number | null;
    /** Jetons estimés du prompt actif (maître + contrat), avant données. */
    promptTokensEstimate: number | null;
    estimation: 'chars/3.5';
  };
  restrictions: BudgetRestriction[];
  /** Combinaison refusée avant appel (le modèle ne peut pas servir l'opération). */
  refusal: string | null;
}

const ORIGINE_BO: Record<string, BudgetRestrictionOrigin> = {
  operation_rank: 'bo_operation_rank', operation: 'bo_operation', treatment: 'bo_treatment', code: 'code_default',
};

interface PureInput {
  operationCode: string;
  op: Pick<AiOperationDefinition, 'minOutputTokens' | 'timeoutMs'>;
  config: GenerationConfigInput;
  rank?: number;
  /** Fiche injectée (tests) ; défaut : registre des capacités en mémoire. */
  capabilities?: ModelCapabilities;
  callerCap?: number | null;
  /** Texte du prompt actif (maître effectif) pour l'estimation d'entrée. */
  promptText?: string | null;
}

/** Résolution PURE pour un rang de la chaîne effective. */
export function resolveBudget(p: PureInput): ResolvedBudget {
  const rank = Math.max(0, Math.trunc(p.rank ?? 0));
  const chaine = [p.config.primaryModel, ...(p.config.fallbackModels ?? [])].filter((m): m is string => typeof m === 'string' && m !== '');
  const model = chaine[Math.min(rank, Math.max(0, chaine.length - 1))] ?? '';
  const cap = p.capabilities ?? capabilitiesOf(model);
  const rang = rankSettings({ minOutputTokens: p.op.minOutputTokens, timeoutMs: p.op.timeoutMs }, p.config, rank);
  const built = buildModelRequest({
    model, capabilities: cap, reasoning: rang.reasoning, maxOutputTokens: rang.maxOutputTokens, maxOutputTokensOrigin: rang.maxOutputTokensOrigin,
    minOutputTokens: p.op.minOutputTokens ?? null, callerCap: p.callerCap ?? null,
  });
  const t = built.trace;
  const restrictions: BudgetRestriction[] = [];
  const sent = t.maxOutputTokens.sent;
  if (t.maxOutputTokens.requested != null && t.maxOutputTokens.origin !== 'none') {
    restrictions.push({ parameter: 'maxOutputTokens', origin: ORIGINE_BO[t.maxOutputTokens.origin] ?? 'code_default', value: t.maxOutputTokens.requested,
      detail: t.maxOutputTokens.origin === 'code' ? 'valeur initiale du code (aucune version BO ne fixe ce plafond)' : 'configuration IA effective (BO)' });
  }
  if (t.maxOutputTokens.operationFloor && (t.maxOutputTokens.requested ?? 0) < t.maxOutputTokens.operationFloor) {
    restrictions.push({ parameter: 'maxOutputTokens', origin: 'operation_floor', value: t.maxOutputTokens.operationFloor, detail: 'plancher technique de l’opération (registre)' });
  }
  if (t.maxOutputTokens.callerCap && sent != null && sent === t.maxOutputTokens.callerCap) {
    restrictions.push({ parameter: 'maxOutputTokens', origin: 'caller_cap', value: t.maxOutputTokens.callerCap, detail: 'plafond imposé par l’appelant' });
  }
  for (const a of t.adaptations) {
    if (a.parameter === 'maxOutputTokens' && a.reason === 'MODEL_OUTPUT_LIMIT') {
      restrictions.push({ parameter: 'maxOutputTokens', origin: 'model_output_limit', value: Number(a.sent), detail: `limite de sortie déclarée du modèle « ${model} »` });
    }
  }
  const reasoningBudget = built.ok && built.params.thinking && 'thinkingBudget' in built.params.thinking ? built.params.thinking.thinkingBudget : null;
  const visible = sent != null && reasoningBudget != null ? Math.max(0, sent - reasoningBudget) : null;
  if (reasoningBudget != null) {
    restrictions.push({ parameter: 'visibleOutput', origin: 'reasoning_budget', value: visible, detail: `budget de raisonnement explicite (${reasoningBudget}) compris dans le plafond` });
  }
  const limiteEntree = cap.inputTokenLimit;
  const available = limiteEntree != null
    ? Math.max(0, Math.floor(limiteEntree * (1 - INPUT_SAFETY_MARGIN_RATIO)) - (sent ?? 0))
    : null;
  if (limiteEntree != null) {
    restrictions.push({ parameter: 'inputTokens', origin: 'model_input_limit', value: available, detail: `limite d’entrée déclarée du modèle (${limiteEntree}) − sortie − marge ${Math.round(INPUT_SAFETY_MARGIN_RATIO * 100)} %` });
  }
  return {
    operationCode: p.operationCode, rank, model, configVersionId: p.config.configVersionId ?? null,
    output: {
      configured: t.maxOutputTokens.requested, configuredOrigin: t.maxOutputTokens.origin, operationFloor: t.maxOutputTokens.operationFloor,
      callerCap: t.maxOutputTokens.callerCap, modelLimit: t.maxOutputTokens.modelLimit, sent,
      reasoningIncludedInCap: true, reasoningBudget, visibleOutputAvailable: visible,
    },
    reasoning: { requested: t.reasoning.requested, sent: t.reasoning.sent },
    input: { modelLimit: limiteEntree, available, promptTokensEstimate: p.promptText ? estimateTokens(p.promptText) : null, estimation: 'chars/3.5' },
    restrictions,
    refusal: built.ok ? null : built.refusal.message,
  };
}

/**
 * Plafond d'entrée APPLICATIF effectif (pur) : surcharge explicite (BO /
 * variable) bornée par le budget du modèle ; sans surcharge, valeur de
 * sécurité de l'opération bornée de même. Rend l'origine.
 */
export function effectiveInputCap(p: { override: number | null | undefined; safetyDefault: number; budget: Pick<ResolvedBudget, 'input'> | null }):
  { value: number; origin: 'explicit_override' | 'operation_default' | 'model_input_limit' } {
  const modele = p.budget?.input.available ?? null;
  const demande = p.override != null && Number.isFinite(p.override) && p.override > 0 ? Math.trunc(p.override) : null;
  const base = demande ?? p.safetyDefault;
  if (modele != null && modele < base) return { value: modele, origin: 'model_input_limit' };
  return { value: base, origin: demande != null ? 'explicit_override' : 'operation_default' };
}

// ── Instantané en mémoire (lecture synchrone) ────────────────────────────────

const instantanes = new Map<string, { budget: ResolvedBudget; at: number }>();
/** Au-delà, l'instantané est réputé périmé (la configuration a pu changer). */
const SNAPSHOT_TTL_MS = 10 * 60_000;

/** Dernier budget résolu pour une opération (rang 0), ou `null`. */
export function budgetSnapshot(operationCode: string, now = Date.now()): ResolvedBudget | null {
  const s = instantanes.get(operationCode);
  return s && now - s.at < SNAPSHOT_TTL_MS ? s.budget : null;
}

/** Enregistre un budget résolu (passerelle, BO, amorçage). */
export function recordBudgetSnapshot(b: ResolvedBudget, now = Date.now()): void {
  if (b.rank === 0) instantanes.set(b.operationCode, { budget: b, at: now });
}

/** Réservé aux tests. */
export function __resetBudgetSnapshotsForTests(): void {
  instantanes.clear();
}

/**
 * Budget EFFECTIF d'une opération (configuration IA active, prompt maître
 * actif), rang donné. Ne lève jamais : configuration illisible → valeurs du
 * code. Met à jour l'instantané (rang 0).
 */
export async function resolveOperationBudget(operationCode: string, opts: { rank?: number; callerCap?: number | null } = {}): Promise<ResolvedBudget> {
  const op = getOperation(operationCode);
  const { resolveOperationConfig, effectiveMasterPromptText } = await import('../config/config-resolver');
  let config: GenerationConfigInput = {
    primaryModel: op.primaryModel, fallbackModels: [...op.fallbackModels], maxOutputTokens: op.defaultMaxOutputTokens ?? null, configVersionId: null,
  };
  let promptText: string | null = null;
  try {
    const r = await resolveOperationConfig(operationCode);
    config = r;
    promptText = r.masterPromptText ?? null;
    if (!promptText) {
      const { treatmentOfUseCase } = await import('../config/treatments');
      const tr = (() => { try { return treatmentOfUseCase(op.useCaseCode); } catch { return null; } })();
      if (tr) promptText = await effectiveMasterPromptText(tr);
    }
    if (!promptText && op.masterPromptCode) promptText = await repoMasterPromptText(op.masterPromptCode);
  } catch { /* valeurs du code */ }
  const b = resolveBudget({ operationCode, op, config, rank: opts.rank, callerCap: opts.callerCap ?? null, promptText });
  recordBudgetSnapshot(b);
  return b;
}

/** Amorce l'instantané d'une opération avant un planificateur synchrone. Ne lève jamais. */
export async function primeOperationBudget(operationCode: string): Promise<ResolvedBudget | null> {
  try { return await resolveOperationBudget(operationCode); } catch { return null; }
}

/** Texte du prompt maître du dépôt (taille seulement ; lecture locale, jamais modifiée). */
async function repoMasterPromptText(code: string): Promise<string | null> {
  try {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const racine = join(process.cwd(), 'src/services/ai/prompts');
    const chercher = (dir: string): string | null => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (n === '__tests__') continue;
        if (statSync(p).isDirectory()) { const r = chercher(p); if (r) return r; } else if (n === `${code}.txt`) return readFileSync(p, 'utf8');
      }
      return null;
    };
    return chercher(racine);
  } catch {
    return null;
  }
}
