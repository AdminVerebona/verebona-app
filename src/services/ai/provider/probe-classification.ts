/**
 * Classification des résultats de sonde des modèles — lot 49 (49E), ticket 11
 * « BO IA — Fiabiliser la détection “modèle actif indisponible” et les
 * sondes Gemini ». Module PUR (aucune base, aucun réseau).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN ÉCHEC DE SONDE N'EST PAS UNE PANNE DE MODÈLE
 *
 * Le 11/10/2026, le BO affichait « 5 modèles actifs indisponibles » pour un
 * seul modèle sain : la sonde (16 jetons de sortie, sans niveau de
 * raisonnement) rendait une réponse vide, classée « non transitoire », donc
 * persistée `ok=false`, et le modèle sortait des sélecteurs.
 *
 * Trois issues seulement :
 *   · `ok`            — le modèle a répondu ;
 *   · `inconclusive`  — rien n'est conclu sur le MODÈLE : quota (429,
 *                       RESOURCE_EXHAUSTED), 5xx, délai, réseau, réponse
 *                       vide, erreur de sonde / de parsing, erreur GLOBALE de
 *                       clé, d'authentification ou de projet, 403 ambigu.
 *                       L'état connu est CONSERVÉ (jamais `ok=false`) ;
 *   · `failed`        — indisponibilité ATTRIBUABLE AU MODÈLE : modèle
 *                       retiré / inexistant, accès refusé à CE modèle,
 *                       generateContent non pris en charge. `definitive`
 *                       quand le message fournisseur est explicite et non
 *                       ambigu (retrait, 404 du modèle) ; sinon échec
 *                       PRÉSUMÉ, à confirmer par un second contrôle.
 *
 * Le message du fournisseur est analysé, pas seulement le code HTTP : un 400
 * « API key not valid » est une erreur de clé, pas du modèle.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { rejectedParameterOf } from '../gateway/diagnostics/classify';

// ── Paramètres de la sonde (ticket 11) ──────────────────────────────────────

/** Aucune donnée utilisateur ; la réponse attendue tient en un mot. */
export const PROBE_PROMPT = 'Réponds exactement : OK';
/** Délai borné d'une sonde. */
export const PROBE_TIMEOUT_MS = 20_000;
/**
 * Plafond de sortie (ticket 11 : 512 au lieu de 16). Un modèle à
 * raisonnement consommait les 16 jetons avant d'écrire : réponse vide, faux
 * négatif. 512 est un PLAFOND, pas une consommation.
 */
export const PROBE_MAX_OUTPUT_TOKENS = 512;
/** Niveau de raisonnement EXPLICITE de la sonde. */
export const PROBE_REASONING = 'minimal' as const;

export type ProbeErrorKind =
  | 'empty_response'
  | 'quota'
  | 'server'
  | 'timeout'
  | 'network'
  | 'auth_global'
  | 'project_global'
  | 'forbidden_ambiguous'
  | 'forbidden_model'
  | 'model_not_found'
  | 'model_retired'
  /** Lot 114 (#771) : le fournisseur ferme CE modèle à CET accès (clé / projet) — pas un retrait global. */
  | 'model_access_closed'
  | 'unsupported_method'
  | 'model_invalid_request'
  /** Lot 114 (#771, S01) : un PARAMÈTRE de la sonde (raisonnement, plafond…) est refusé par ce modèle — la sonde est en cause, pas le modèle. */
  | 'probe_parameter_rejected'
  | 'probe_error';

export type ProbeOutcome =
  | { status: 'ok' }
  | { status: 'inconclusive'; kind: ProbeErrorKind; error: string }
  | { status: 'failed'; kind: ProbeErrorKind; error: string; definitive: boolean };

/** Libellés courts (BO). */
export const PROBE_ERROR_KIND_LABELS: Readonly<Record<ProbeErrorKind, string>> = {
  empty_response: 'réponse vide (non concluant)',
  quota: 'quota ou limite de débit du fournisseur (non concluant)',
  server: 'indisponibilité du fournisseur (5xx, non concluant)',
  timeout: 'délai dépassé (non concluant)',
  network: 'erreur réseau (non concluant)',
  auth_global: 'clé API refusée — erreur globale, pas du modèle (non concluant)',
  project_global: 'projet ou facturation Google — erreur globale (non concluant)',
  forbidden_ambiguous: 'accès refusé sans précision du modèle (non concluant)',
  forbidden_model: 'accès refusé à ce modèle',
  model_not_found: 'modèle introuvable pour cette clé',
  model_retired: 'modèle retiré par le fournisseur',
  model_access_closed: 'modèle fermé à cet accès (clé ou projet) par le fournisseur',
  unsupported_method: 'génération (generateContent) non prise en charge',
  model_invalid_request: 'requête refusée pour ce modèle',
  probe_parameter_rejected: 'paramètre de la sonde refusé par ce modèle (non concluant)',
  probe_error: 'erreur de la sonde (non concluant)',
};

// ── Nettoyage (aucun secret, jamais) ────────────────────────────────────────

/**
 * Message fournisseur NETTOYÉ, exploitable au BO et dans les journaux :
 *   · le secret connu est masqué (`***`) ;
 *   · toute clé reconnaissable aussi, même inconnue : paramètre `key=…`,
 *     préfixe Google `AIza…`, `Bearer …`, `x-goog-api-key` ;
 *   · une réponse JSON Google `{"error":{code,status,message}}` est réduite à
 *     « HTTP 404 NOT_FOUND — message » ;
 *   · borné (500 caractères).
 */
export function sanitizeProviderError(raw: unknown, secret?: string | null): string {
  let msg = typeof raw === 'string' ? raw : String((raw as { message?: unknown } | null)?.message ?? raw ?? 'erreur inconnue');
  if (secret) msg = msg.split(secret).join('***');
  msg = msg
    .replace(/([?&]key=)[^&\s"'<>]+/gi, '$1***')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1***');
  const google = googleErrorOf(msg);
  if (google) {
    const prefixe = msg.slice(0, msg.indexOf('{')).replace(/got status:\s*/i, '').trim();
    const entete = [google.code ? `HTTP ${google.code}` : null, google.status].filter(Boolean).join(' ');
    msg = `${entete || prefixe}${google.message ? ` — ${google.message}` : ''}`.trim();
  }
  return msg.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Erreur JSON Google contenue dans un message (`{"error":{…}}`), ou null. */
function googleErrorOf(msg: string): { code: number | null; status: string | null; message: string | null } | null {
  const debut = msg.indexOf('{');
  if (debut < 0) return null;
  try {
    const o = JSON.parse(msg.slice(debut)) as { error?: { code?: unknown; status?: unknown; message?: unknown } };
    if (!o?.error || typeof o.error !== 'object') return null;
    return {
      code: typeof o.error.code === 'number' ? o.error.code : null,
      status: typeof o.error.status === 'string' ? o.error.status : null,
      message: typeof o.error.message === 'string' ? o.error.message : null,
    };
  } catch {
    return null;
  }
}

/** Code HTTP d'une erreur (propriété `status`/`code` numérique, sinon lu dans le message). */
function httpStatusOf(err: unknown, message: string): number | null {
  const e = err as { status?: unknown; code?: unknown } | null;
  for (const v of [e?.status, e?.code]) {
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
  }
  const m = /"code"\s*:\s*(\d{3})/.exec(message)
    ?? /got status:\s*(\d{3})/i.exec(message)
    ?? /\bHTTP\s*(\d{3})\b/i.exec(message)
    ?? /\((\d{3})\)/.exec(message)
    ?? /^\s*(\d{3})\b/.exec(message);
  return m ? Number(m[1]) : null;
}

// ── Classification ──────────────────────────────────────────────────────────

const RE_QUOTA = /RESOURCE_EXHAUSTED|quota|rate[ -]?limit|too many requests/i;
const RE_SERVER = /\b(UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|overloaded|backend error|service unavailable|bad gateway)\b/i;
const RE_TIMEOUT = /timeout|timed out|délai|DEADLINE|aborted|AbortError|TIMEOUT/i;
const RE_NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket|network|getaddrinfo/i;
const RE_KEY = /API[_ ]?key (?:not valid|invalid|expired|was reported as leaked)|API_KEY_INVALID|API_KEY_EXPIRED|UNAUTHENTICATED|invalid authentication|missing (?:api )?key|Aucune clé|credentials/i;
const RE_PROJECT = /billing|has not been used in project|SERVICE_DISABLED|API has not been (?:used|enabled)|consumer|CONSUMER_INVALID|project .* (?:suspended|denied|disabled)|organization policy|location is not supported|User location is not supported/i;
const RE_RETIRED = /no longer (?:available|supported|served)|has been (?:deprecated|retired|discontinued|shut ?down|removed)|is deprecated|was (?:retired|shut ?down|discontinued)|end[- ]of[- ]life/i;
/**
 * Lot 114 (#771, appel 15389) : refus EXPLICITE et définitif du modèle pour l'accès utilisé (« is no longer
 * available to new users ») — ce n'est pas la preuve d'un retrait global chez le fournisseur.
 */
const RE_ACCESS_CLOSED = /(?:not|no longer) (?:available|accessible|offered|supported) (?:to|for) (?:new (?:users|customers|accounts|projects)|(?:your|this) (?:account|project|organization|api key|key))/i;
const RE_UNSUPPORTED = /not supported for generateContent|does not support generateContent|generateContent is not supported|method is not supported/i;
const RE_NOT_FOUND_MODEL = /models\/[\w.-]+ is not found|model[^.]{0,80}(?:is )?not found|NOT_FOUND[^.]{0,80}model|unknown model|model .* does not exist/i;

/** Le message vise-t-il explicitement CE modèle (ou « le modèle ») ? */
function mentionsModel(message: string, model?: string | null): boolean {
  if (model && message.toLowerCase().includes(model.toLowerCase())) return true;
  return /\bmodels?\/|\bmodel\b|\bmodèle\b/i.test(message);
}

/**
 * Classe un ÉCHEC de sonde (exception ou réponse HTTP en erreur). `model`
 * sert à reconnaître un message qui vise ce modèle. Pure.
 */
export function classifyProbeFailure(
  err: unknown,
  opts: { model?: string | null; secret?: string | null; httpStatus?: number | null } = {},
): Exclude<ProbeOutcome, { status: 'ok' }> {
  const brut = typeof err === 'string' ? err : String((err as { message?: unknown } | null)?.message ?? err ?? '');
  const error = sanitizeProviderError(brut, opts.secret);
  const status = opts.httpStatus ?? httpStatusOf(err, brut);
  const nc = (kind: ProbeErrorKind) => ({ status: 'inconclusive' as const, kind, error });
  const ko = (kind: ProbeErrorKind, definitive: boolean) => ({ status: 'failed' as const, kind, error, definitive });

  // 1. Transitoires et réseau : jamais concluants.
  if (status === 429 || RE_QUOTA.test(brut)) return nc('quota');
  if ((status !== null && status >= 500) || RE_SERVER.test(brut)) return nc('server');
  if (RE_TIMEOUT.test(brut) || (err as { code?: unknown } | null)?.code === 'TIMEOUT') return nc('timeout');
  if (RE_NETWORK.test(brut)) return nc('network');

  // 2. Erreurs GLOBALES (clé, authentification, projet) : jamais imputées au modèle.
  if (status === 401 || RE_KEY.test(brut)) return nc('auth_global');
  if (RE_PROJECT.test(brut)) return nc('project_global');

  // 3. Indisponibilité attribuable au modèle.
  // Retrait explicite : message qui vise le modèle, ou 404 de l'appel de
  // génération (l'URL appelée EST celle du modèle).
  // Lot 114 (#771) : fermeture du modèle à CET accès — explicite et définitive pour la route, sans retrait global.
  if (RE_ACCESS_CLOSED.test(brut) && (mentionsModel(brut, opts.model) || status === 404)) return ko('model_access_closed', true);
  if (RE_RETIRED.test(brut) && (mentionsModel(brut, opts.model) || status === 404)) return ko('model_retired', true);
  if (RE_UNSUPPORTED.test(brut)) return ko(status === 404 || RE_NOT_FOUND_MODEL.test(brut) ? 'model_not_found' : 'unsupported_method', true);
  if (status === 404 || /\bNOT_FOUND\b/.test(brut)) {
    // 404 de l'appel de génération : l'URL appelée est celle du modèle.
    // Message qui le vise : définitif ; 404 nu : échec PRÉSUMÉ, à confirmer.
    return ko('model_not_found', RE_NOT_FOUND_MODEL.test(brut) || mentionsModel(brut, opts.model));
  }
  if (status === 403 || /PERMISSION_DENIED/.test(brut)) {
    // 403 : refus GLOBAL (clé, projet — traités plus haut) ou refus de CE
    // modèle. Sans mention du modèle : ambigu, donc non concluant.
    return mentionsModel(brut, opts.model) ? ko('forbidden_model', false) : nc('forbidden_ambiguous');
  }
  if (status === 400 || /INVALID_ARGUMENT|FAILED_PRECONDITION/.test(brut)) {
    // Lot 114 (#771, S01 / R05) : le fournisseur NOMME un paramètre de la requête (niveau de raisonnement, plafond
    // de sortie…) — la sonde est incompatible avec ce modèle, rien n'est conclu sur sa disponibilité. Même
    // détection que la passerelle (`PARAMETER_REJECTED`).
    if (rejectedParameterOf(brut)) return nc('probe_parameter_rejected');
    return mentionsModel(brut, opts.model) ? ko('model_invalid_request', false) : nc('probe_error');
  }

  // 4. Le reste (parsing, erreur de construction, inconnue) : non concluant.
  return nc('probe_error');
}

/** Issue d'une génération réussie : texte non vide = ok, vide = non concluant. */
export function classifyProbeResponse(rawText: string | null | undefined): ProbeOutcome {
  return (rawText ?? '').trim().length > 0
    ? { status: 'ok' }
    : { status: 'inconclusive', kind: 'empty_response', error: 'réponse vide' };
}

// ── Confirmation avant dégradation ──────────────────────────────────────────

/** Statut du DERNIER contrôle, exposé au BO. */
export type CheckStatus = 'ok' | 'inconclusive' | 'suspect' | 'failed_confirmed';

/** État connu d'un modèle avec la clé active (ligne `ai_model_operational_status`). */
export interface KnownOperationalState {
  /** État RETENU : `true` sain, `false` indisponible confirmé, `null` inconnu. */
  ok: boolean | null;
  checkStatus: CheckStatus | null;
  /** Premier échec présumé non encore confirmé (ISO), sinon null. */
  suspectSince: string | null;
}

export interface NextOperationalState extends KnownOperationalState {
  error: string | null;
  errorKind: ProbeErrorKind | null;
  /** Le modèle a-t-il RÉPONDU à ce contrôle ? (date du dernier état sain) */
  healthy: boolean;
}

/**
 * Transition d'état après un contrôle (pure).
 *   · ok → sain ;
 *   · non concluant → état retenu INCHANGÉ (jamais `ok=false`), suspicion
 *     éventuelle conservée ;
 *   · échec explicitement définitif → indisponible confirmé ;
 *   · échec présumé : déjà suspect (ou déjà confirmé) → confirmé ; sinon
 *     SUSPECT — l'état retenu (sain) est conservé provisoirement, un second
 *     contrôle tranchera.
 */
export function nextOperationalState(
  prev: KnownOperationalState | null,
  outcome: ProbeOutcome,
  now: Date = new Date(),
): NextOperationalState {
  if (outcome.status === 'ok') {
    return { ok: true, checkStatus: 'ok', suspectSince: null, error: null, errorKind: null, healthy: true };
  }
  if (outcome.status === 'inconclusive') {
    return {
      ok: prev?.ok ?? null, checkStatus: 'inconclusive', suspectSince: prev?.suspectSince ?? null,
      error: outcome.error, errorKind: outcome.kind, healthy: false,
    };
  }
  const dejaSuspect = Boolean(prev?.suspectSince) || prev?.checkStatus === 'failed_confirmed';
  if (outcome.definitive || dejaSuspect) {
    return { ok: false, checkStatus: 'failed_confirmed', suspectSince: null, error: outcome.error, errorKind: outcome.kind, healthy: false };
  }
  return {
    ok: prev?.ok ?? null, checkStatus: 'suspect', suspectSince: now.toISOString(),
    error: outcome.error, errorKind: outcome.kind, healthy: false,
  };
}

/**
 * Relecture d'un état ANCIEN (avant le lot 49, sans statut de contrôle) :
 * un `ok=false` enregistré pour un motif aujourd'hui non concluant (réponse
 * vide, quota, clé…) ne vaut plus indisponibilité — état inconnu.
 */
export function reinterpretLegacyState(row: { ok: boolean | null; checkStatus: CheckStatus | null; error: string | null }): boolean | null {
  if (row.checkStatus !== null || row.ok !== false) return row.ok;
  if (row.error == null || /^réponse vide/i.test(row.error.trim())) return null;
  return classifyProbeFailure(row.error).status === 'failed' ? false : null;
}


// ── Lot 114 (carte #771) : diagnostic restitué, recontrôle borné ─────────────

/** Capacité éprouvée par la sonde (la seule aujourd'hui) et point d'accès appelé. */
export const PROBE_CAPABILITY = 'text_generation' as const;
export const PROBE_ENDPOINT = 'generateContent' as const;

/**
 * Codes d'erreur d'un contrôle de disponibilité (trace technique, export, BO) — #771, S07 / B04 :
 *   · `MODEL_UNAVAILABLE_CONFIRMED` — refus explicite et définitif attribuable au modèle pour cet accès ;
 *   · `MODEL_UNAVAILABLE_SUSPECTED` — échec présumé, en attente de confirmation ;
 *   · `PROVIDER_AUTH_FAILURE`       — incident GLOBAL (clé, authentification, projet) : aucun modèle en cause ;
 *   · `PROBE_INCONCLUSIVE`          — rien n'est conclu (quota, 5xx, délai, réseau, réponse vide, erreur de sonde).
 */
export type ProbeErrorCode = 'MODEL_UNAVAILABLE_CONFIRMED' | 'MODEL_UNAVAILABLE_SUSPECTED' | 'PROVIDER_AUTH_FAILURE' | 'PROBE_INCONCLUSIVE';

/** Catégories GLOBALES (clé, projet) : jamais imputées à un modèle. */
export const GLOBAL_PROBE_KINDS: ReadonlySet<ProbeErrorKind> = new Set<ProbeErrorKind>(['auth_global', 'project_global']);

/** Code d'erreur d'une issue de contrôle (pure) ; `null` : le modèle a répondu. */
export function probeErrorCodeOf(outcome: ProbeOutcome): ProbeErrorCode | null {
  if (outcome.status === 'ok') return null;
  if (outcome.status === 'failed') return outcome.definitive ? 'MODEL_UNAVAILABLE_CONFIRMED' : 'MODEL_UNAVAILABLE_SUSPECTED';
  return GLOBAL_PROBE_KINDS.has(outcome.kind) ? 'PROVIDER_AUTH_FAILURE' : 'PROBE_INCONCLUSIVE';
}

/** Code HTTP et code fournisseur (`NOT_FOUND`…) lus dans une erreur ou un message nettoyé (pure). */
export function providerCodesOf(err: unknown): { httpStatus: number | null; providerCode: string | null } {
  const brut = typeof err === 'string' ? err : String((err as { message?: unknown } | null)?.message ?? err ?? '');
  const google = googleErrorOf(brut);
  const httpStatus = httpStatusOf(err, brut) ?? google?.code ?? null;
  const m = /"status"\s*:\s*"([A-Z_]+)"/.exec(brut)
    ?? /\b(RESOURCE_EXHAUSTED|INVALID_ARGUMENT|PERMISSION_DENIED|UNAUTHENTICATED|DEADLINE_EXCEEDED|UNAVAILABLE|INTERNAL|NOT_FOUND|FAILED_PRECONDITION)\b/.exec(brut);
  return { httpStatus, providerCode: google?.status ?? (m ? m[1] : null) };
}

/**
 * Recontrôle BORNÉ d'un modèle confirmé indisponible (#771, A06) : délai doublé à chaque échec confirmé
 * consécutif, de `baseMs` à `maxMs` — jamais d'exclusion permanente, jamais de retest en boucle. Pure.
 */
export const REPROBE_BASE_MS = 60 * 60_000;
export const REPROBE_MAX_MS = 24 * 60 * 60_000;
export function nextProbeDelayMs(failureCount: number, baseMs: number = REPROBE_BASE_MS, maxMs: number = REPROBE_MAX_MS): number {
  const n = Math.max(1, Math.floor(failureCount));
  return Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 20));
}
