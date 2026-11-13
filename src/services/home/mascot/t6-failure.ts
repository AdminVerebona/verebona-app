/**
 * Lot 113AO (Trello #748, D) — CAUSE PRIMAIRE d'un échec d'appel T6 (pure,
 * testée), commune à EVALUATE et FORMULATE.
 *
 * Cause démontrée (export 54dc3fd1…, 7 exécutions EVALUATE FAILED) : toute
 * exception de la passerelle devenait `model_unavailable`
 * (`t6RunResultsOf`), publiée `T6_EVALUATE_MODEL_UNAVAILABLE`, alors que le
 * détail disait « Sortie tronquée (limite de génération) » — la cause établie
 * par la passerelle (`failureCause` : OUTPUT_TRUNCATED) était perdue. Une
 * troncature n'est pas une indisponibilité : elle se corrige en fractionnant
 * les candidats (sans en supprimer), pas en relançant la même demande.
 *
 * Familles distinguées (jamais devinées : sans élément probant, `unknown_error`) :
 *   output_truncated     plafond de sortie atteint (finishReason MAX_TOKENS,
 *                        sortie coupée) — cause établie par la passerelle ;
 *   provider_refused     refus d'accès du fournisseur (HTTP 403 /
 *                        PERMISSION_DENIED, clé refusée) ;
 *   model_unavailable    indisponibilité RÉELLE (quota, surcharge, délai,
 *                        modèle connu indisponible, suspension faute de secours) ;
 *   invalid_output       sortie non conforme (hors troncature) ;
 *   contract_invalid     défaut commun (prompt maître, contrat, construction
 *                        de la requête) : identique sur tous les modèles ;
 *   transport            défaut réseau avant réponse (connexion, DNS, coupure) ;
 *   cost_cap             plafond IA mensuel du compte (refus avant appel).
 */
import { gatewayFailureFacts, isCostCapReached } from '@/services/ai/gateway/errors';

export type T6FailureKind =
  | 'output_truncated' | 'provider_refused' | 'model_unavailable' | 'invalid_output' | 'contract_invalid' | 'transport' | 'cost_cap' | 'unknown_error';

export interface T6Failure {
  kind: T6FailureKind;
  /** Code stable de la passerelle (ALL_MODELS_FAILED, AI_SUSPENDED…) et cause établie (OUTPUT_TRUNCATED…). */
  code: string | null;
  cause: string | null;
  lastFailureCode: string | null;
  /** Modèles réellement sollicités / requêtes émises (passerelle, lot 109J). */
  modelsCalled: number | null;
  networkRequests: number | null;
  /** Message court, sans contenu (borné). */
  message: string;
  /** Une nouvelle tentative de la MÊME demande a-t-elle un sens ? */
  retryable: boolean;
}

const LIBELLES: Readonly<Record<T6FailureKind, string>> = {
  output_truncated: 'sortie tronquée (plafond de sortie atteint)',
  provider_refused: 'refus du fournisseur (accès 403)',
  model_unavailable: 'modèle indisponible',
  invalid_output: 'sortie non conforme au contrat',
  contract_invalid: 'défaut commun (prompt, contrat ou construction de la requête)',
  transport: 'défaut de transport (réseau)',
  cost_cap: 'plafond IA du mois du compte atteint',
  unknown_error: 'cause non déterminée',
};

/** Libellé BO d'une famille (pur). */
export function t6FailureLabel(kind: string | null | undefined): string {
  return LIBELLES[(kind ?? 'unknown_error') as T6FailureKind] ?? kind ?? LIBELLES.unknown_error;
}

const INDISPONIBLE = new Set(['QUOTA', 'UNAVAILABLE', 'TIMEOUT', 'KNOWN_UNAVAILABLE', 'MODEL_LIMIT']);
const COMMUN = new Set(['COMMON_DEFECT', 'PARAMETER_REJECTED', 'PARAMETER_INCOMPATIBLE']);
const CODES_CONTRAT = new Set(['MASTER_PROMPT_INVALID', 'RUNTIME_CONTRACT_MISMATCH', 'TASK_MISMATCH', 'REQUEST_BUILD_FAILED', 'OPERATION_UNKNOWN', 'OPERATION_INACTIVE', 'USE_CASE_MISMATCH', 'MODEL_PARAMETERS_INCOMPATIBLE']);
const CODES_INDISPONIBLES = new Set(['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'QUOTA_EXCEEDED', 'AI_BLOCKED']);
const REFUS = /\b403\b|permission[_ ]denied|forbidden|api key (not valid|invalid|expired)|API_KEY_INVALID/i;
const TRONQUE = /sortie tronqu[ée]e|limite de g[ée]n[ée]ration|plafond de sortie|MAX_TOKENS|truncat/i;
const RESEAU = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|UND_ERR/i;

/** Cause primaire d'une exception de la passerelle (pure). */
export function classifyT6Failure(e: unknown): T6Failure {
  const x = (e ?? {}) as { code?: unknown; lastFailureCode?: unknown; message?: unknown };
  const code = typeof x.code === 'string' ? x.code : null;
  const lastFailureCode = typeof x.lastFailureCode === 'string' ? x.lastFailureCode : null;
  const { cause, stats } = gatewayFailureFacts(e);
  const message = String(x.message ?? e ?? '').replace(/\s+/g, ' ').slice(0, 300);
  const base = { code, cause, lastFailureCode, modelsCalled: stats?.modelsCalled ?? null, networkRequests: stats?.networkRequests ?? null, message };
  const de = (kind: T6FailureKind, retryable: boolean): T6Failure => ({ ...base, kind, retryable });
  if (isCostCapReached(e)) return de('cost_cap', false);
  // 1. Cause ÉTABLIE par la passerelle (dernière panne de la chaîne).
  if (cause === 'OUTPUT_TRUNCATED') return de('output_truncated', false);
  if (cause === 'GLOBAL_ACCESS') return de('provider_refused', true);
  if (cause && INDISPONIBLE.has(cause)) return de('model_unavailable', true);
  if (cause && COMMUN.has(cause)) return de('contract_invalid', false);
  // 2. Code typé de la passerelle.
  if (code && CODES_CONTRAT.has(code)) return de('contract_invalid', false);
  if (code === 'INVALID_OUTPUT' || (code === 'ALL_MODELS_FAILED' && lastFailureCode === 'INVALID_OUTPUT')) {
    return TRONQUE.test(message) ? de('output_truncated', false) : de('invalid_output', true);
  }
  // 3. Éléments probants du message (403, troncature, réseau) — jamais une supposition.
  if (REFUS.test(message)) return de('provider_refused', true);
  if (TRONQUE.test(message)) return de('output_truncated', false);
  if (RESEAU.test(message)) return de('transport', true);
  if (code === 'AI_SUSPENDED' || (code && CODES_INDISPONIBLES.has(code)) || /indisponib|unavailable|overloaded|\b503\b|\b429\b|quota|rate.?limit/i.test(message)) {
    return de('model_unavailable', true);
  }
  if (code && CODES_INDISPONIBLES.has(lastFailureCode ?? '')) return de('model_unavailable', true);
  return de('unknown_error', true);
}

/** Texte BO court d'un échec (pur) : cause primaire, code, modèles sollicités — sans contenu. */
export function t6FailureSummary(f: T6Failure, extra: string[] = []): string {
  const parts = [
    `${f.kind.toUpperCase()} — ${t6FailureLabel(f.kind)}`,
    f.cause ? `cause passerelle ${f.cause}` : null,
    f.code ? `code ${f.code}${f.lastFailureCode && f.lastFailureCode !== f.code ? `/${f.lastFailureCode}` : ''}` : null,
    f.modelsCalled != null ? `${f.modelsCalled} modèle(s) sollicité(s), ${f.networkRequests ?? '?'} requête(s)` : null,
    ...extra,
  ].filter(Boolean);
  return `${parts.join(' · ')}${f.message ? ` · ${f.message}` : ''}`.slice(0, 500);
}
