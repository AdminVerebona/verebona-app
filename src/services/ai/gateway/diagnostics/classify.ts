/**
 * Classification des échecs IA — lot 33D (ticket « rendre INVALID_OUTPUT
 * diagnosticable », §1 à §3, §7, §10, §12, §14).
 *
 * Fonctions PURES : erreur fournisseur → famille + étape, erreurs Zod →
 * détail par chemin, sortie tronquée, signature d'échec, diagnostic de
 * cascade et diagnostic final. Aucun texte n'est spéculatif : chaque phrase
 * du diagnostic final découle d'une donnée constatée.
 */
import { createHash } from 'crypto';
import type { ZodError } from 'zod';
import { redact } from '../redaction';
import { descAt, type FieldDesc } from '../output-resolution/schema-introspect';
import {
  displayCause, PRE_RESPONSE_STAGES,
  type AiFailureFamily, type AiFailureStage, type CallDiagnostic, type InvalidOutputSubtype,
  type ProviderCallMetadata, type ValidationIssueDetail,
} from './taxonomy';

// ── Chemins et valeurs ──────────────────────────────────────────────────────

/** `['document', 'facts', 3, 'target']` → `$.document.facts[3].target`. */
export function jsonPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '$';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (typeof seg === 'string' && /^[A-Za-z_$][\w$]*$/.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(String(seg))}]`;
  }
  return out;
}

/** Valeur à un chemin (lecture tolérante, `undefined` si absente). */
export function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg as never];
  }
  return cur;
}

/** Type JSON lisible : `null`, `array`, `object`, `string`, `undefined`… */
export function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Valeur sérialisée, masquée et bornée (jamais une sortie complète). */
export function boundedValue(v: unknown, max = 400): string | null {
  if (v === undefined) return null;
  let s: string;
  try { s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, null, 2); } catch { s = String(v); }
  if (s === undefined) return null;
  s = redact(s);
  return s.length > max ? `${s.slice(0, max)}… (${s.length} caractères)` : s;
}

// ── Erreurs Zod → détail par chemin (§3) ────────────────────────────────────

type AnyIssue = {
  code: string; path: PropertyKey[]; message: string; expected?: string; values?: unknown[];
  options?: unknown[]; errors?: AnyIssue[][]; note?: string; discriminator?: string; params?: Record<string, unknown>;
  origin?: string; format?: string; maximum?: unknown; minimum?: unknown;
};

const RECEIVED_RE = /received (\w+)/;

/**
 * Détail d'une erreur de validation. `parsed` est la sortie parsée sur
 * laquelle la validation a porté (valeur reçue, type reçu).
 */
export function issueDetail(issue: AnyIssue, parsed: unknown): ValidationIssueDetail {
  const path = jsonPath(issue.path);
  const value = valueAt(parsed, issue.path);
  const received = issue.code === 'invalid_type'
    ? (value === undefined ? (RECEIVED_RE.exec(issue.message)?.[1] ?? 'undefined') : jsonType(value))
    : jsonType(value);
  const base = { path, receivedValue: boundedValue(value), message: redact(issue.message) };
  switch (issue.code) {
    case 'invalid_type': {
      if (value === undefined && received === 'undefined') {
        const last = issue.path[issue.path.length - 1];
        return {
          ...base, subtype: 'MISSING_REQUIRED_FIELD', expected: issue.expected ?? null, received: 'undefined',
          missingField: last === undefined ? undefined : String(last),
        };
      }
      return { ...base, subtype: 'INVALID_TYPE', expected: issue.expected ?? null, received };
    }
    case 'invalid_value':
      return {
        ...base, subtype: 'INVALID_ENUM', expected: 'une des valeurs autorisées', received,
        allowedValues: (issue.values ?? []).map((x) => String(x)),
      };
    case 'invalid_union': {
      if (issue.discriminator || issue.note === 'No matching discriminator') {
        return {
          ...base, subtype: 'INVALID_ENUM', expected: `discriminant ${issue.discriminator ?? ''}`.trim(), received,
          allowedValues: (issue.options ?? []).map((x) => String(x)),
        };
      }
      // Union de types (`string | number | null`) : type incorrect.
      const types = (issue.errors ?? [])
        .map((branch) => (branch.length === 1 && branch[0].code === 'invalid_type' ? branch[0].expected : null))
        .filter((x): x is string => Boolean(x));
      if (types.length > 0 && types.length === (issue.errors ?? []).length) {
        if (value === undefined) {
          const last = issue.path[issue.path.length - 1];
          return { ...base, subtype: 'MISSING_REQUIRED_FIELD', expected: types.join(' | '), received: 'undefined', missingField: last === undefined ? undefined : String(last) };
        }
        return { ...base, subtype: 'INVALID_TYPE', expected: types.join(' | '), received };
      }
      return { ...base, subtype: 'SCHEMA_VALIDATION_FAILED', expected: 'une des formes autorisées', received };
    }
    case 'custom':
      if (issue.params?.kind === 'business') {
        return { ...base, subtype: 'BUSINESS_VALIDATION_FAILED', expected: String(issue.params.expected ?? 'règle métier'), received };
      }
      return { ...base, subtype: 'SCHEMA_VALIDATION_FAILED', expected: 'contrainte personnalisée', received };
    case 'invalid_format':
      return { ...base, subtype: 'SCHEMA_VALIDATION_FAILED', expected: issue.format === 'regex' ? 'format attendu (motif)' : `format ${issue.format ?? ''}`.trim(), received };
    case 'too_big':
      return { ...base, subtype: 'SCHEMA_VALIDATION_FAILED', expected: `${issue.origin ?? 'valeur'} ≤ ${String(issue.maximum)}`, received };
    case 'too_small':
      return { ...base, subtype: 'SCHEMA_VALIDATION_FAILED', expected: `${issue.origin ?? 'valeur'} ≥ ${String(issue.minimum)}`, received };
    default:
      return { ...base, subtype: 'SCHEMA_VALIDATION_FAILED', expected: null, received };
  }
}

/**
 * Détails de toutes les erreurs d'une validation Zod (bornés à `max`). Avec
 * le descripteur du schéma (`root`), l'attendu d'un champ nullable est
 * complété (`string | null`, ticket §3).
 */
export function issuesFromZod(error: ZodError, parsed: unknown, max = 20, root?: FieldDesc): { issues: ValidationIssueDetail[]; total: number } {
  const all = error.issues as unknown as AnyIssue[];
  return {
    issues: all.slice(0, max).map((i) => {
      const d = issueDetail(i, parsed);
      if (root && d.expected && (d.subtype === 'INVALID_TYPE' || d.subtype === 'MISSING_REQUIRED_FIELD') && !/\bnull\b/.test(d.expected)) {
        const desc = descAt(root, i.path, parsed);
        if (desc?.nullable) d.expected = `${d.expected} | null`;
      }
      return d;
    }),
    total: all.length,
  };
}

/**
 * Sous-type principal d'une liste d'erreurs : celui de la première erreur
 * (ordre du validateur), sauf si elles sont de types différents — alors
 * SCHEMA_VALIDATION_FAILED (le détail reste par chemin).
 */
export function mainSubtype(issues: ValidationIssueDetail[]): InvalidOutputSubtype {
  if (issues.length === 0) return 'SCHEMA_VALIDATION_FAILED';
  const kinds = new Set(issues.map((i) => i.subtype));
  return kinds.size === 1 ? issues[0].subtype : 'SCHEMA_VALIDATION_FAILED';
}

/** Étape d'un sous-type de sortie invalide. */
export function stageOfSubtype(subtype: InvalidOutputSubtype): AiFailureStage {
  switch (subtype) {
    case 'EMPTY_RESPONSE': return 'response_reception';
    case 'OUTPUT_TRUNCATED': return 'response_reception';
    case 'MALFORMED_JSON': return 'json_parse';
    case 'STRUCTURED_OUTPUT_REJECTED': return 'structured_output';
    case 'PARSER_ERROR': return 'result_mapping';
    case 'BUSINESS_VALIDATION_FAILED': return 'business_validation';
    case 'UNKNOWN': return 'post_processing';
    default: return 'schema_validation';
  }
}

// ── Sortie tronquée (§7) ────────────────────────────────────────────────────

const TRUNCATION_REASONS = new Set(['MAX_TOKENS', 'LENGTH', 'MAX_OUTPUT_TOKENS']);

/**
 * La génération s'est-elle arrêtée sur la limite de sortie ? Fin déclarée
 * par le fournisseur (`MAX_TOKENS`, `length`, `max_tokens`), sinon plafond
 * configuré atteint par les jetons de sortie.
 */
export function isTruncated(meta: Pick<ProviderCallMetadata, 'finishReason' | 'stopReason' | 'maxTokensReached' | 'tokenUsage' | 'configuredMaxOutputTokens'>): boolean {
  if (meta.maxTokensReached) return true;
  for (const r of [meta.finishReason, meta.stopReason]) {
    if (r && TRUNCATION_REASONS.has(String(r).toUpperCase())) return true;
  }
  // Fin déclarée par le fournisseur (STOP…) : elle fait foi.
  if (meta.finishReason || meta.stopReason) return false;
  const max = meta.configuredMaxOutputTokens;
  const out = meta.tokenUsage?.output ?? 0;
  const thoughts = meta.tokenUsage?.thoughts ?? 0;
  return Boolean(max && max > 0 && out + thoughts >= max);
}

// ── Erreurs fournisseur → famille et étape (§1, §2, §8, §14) ───────────────

export interface ClassifiedFailure {
  family: AiFailureFamily;
  subtype: InvalidOutputSubtype | null;
  stage: AiFailureStage;
  httpStatus: number | null;
  providerErrorCode: string | null;
  providerErrorMessage: string | null;
  error: { message: string; exception: string | null; stack: string | null };
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

function statusOf(e: Record<string, unknown>, message: string): number | null {
  for (const k of ['status', 'statusCode', 'httpStatus']) {
    const v = e[k];
    if (typeof v === 'number' && v >= 100 && v < 600) return v;
  }
  const m = /"code"\s*:\s*(\d{3})/.exec(message) ?? /\b(?:got status|status(?: code)?)[:\s]+(\d{3})\b/i.exec(message);
  return m ? Number(m[1]) : null;
}

function providerStatusOf(message: string): string | null {
  const m = /"status"\s*:\s*"([A-Z_]+)"/.exec(message)
    ?? /\b(RESOURCE_EXHAUSTED|INVALID_ARGUMENT|PERMISSION_DENIED|UNAUTHENTICATED|DEADLINE_EXCEEDED|UNAVAILABLE|INTERNAL|NOT_FOUND|FAILED_PRECONDITION)\b/.exec(message);
  return m ? m[1] : null;
}

/**
 * Famille, étape et métadonnées d'une erreur levée PENDANT l'appel au
 * fournisseur (avant toute sortie exploitable). Les erreurs de sortie
 * (`AiOutputInvalidError`) ne passent pas ici : elles portent déjà leur
 * diagnostic.
 */
export function classifyCallError(err: unknown): ClassifiedFailure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const message = err instanceof Error ? err.message : String(err);
  const exception = err instanceof Error ? err.name : typeof err;
  const stack = err instanceof Error && err.stack ? redact(err.stack).slice(0, 2000) : null;
  const status = statusOf(e, message);
  const pStatus = (typeof e.providerStatus === 'string' ? e.providerStatus : null) ?? providerStatusOf(message);
  const code = typeof e.code === 'string' ? e.code : null;
  const base = {
    httpStatus: status,
    providerErrorCode: pStatus ?? (status ? String(status) : code),
    providerErrorMessage: redact(message).slice(0, 1000),
    error: { message: redact(message).slice(0, 2000), exception, stack: null as string | null },
  };
  const out = (family: AiFailureFamily, stage: AiFailureStage, subtype: InvalidOutputSubtype | null = null): ClassifiedFailure =>
    ({ ...base, family, stage, subtype, error: { ...base.error, stack: family === 'UNKNOWN' || family === 'INTERNAL_ERROR' ? stack : null } });

  // Étape posée par l'adaptateur (préparation des pièces jointes, blocage).
  const declaredStage = typeof e.aiStage === 'string' ? (e.aiStage as AiFailureStage) : null;

  if (code === 'TIMEOUT' || e.name === 'AbortError' || status === 408 || status === 504 || pStatus === 'DEADLINE_EXCEEDED') {
    return out('TIMEOUT', 'provider_generation');
  }
  if (e.blocked === true || /blocked due to (SAFETY|RECITATION|LANGUAGE|PROHIBITED_CONTENT|BLOCKLIST|SPII|IMAGE_SAFETY|OTHER)|Response was blocked/i.test(message)) {
    return out('SAFETY_BLOCK', declaredStage ?? 'provider_generation');
  }
  if (status === 429 || pStatus === 'RESOURCE_EXHAUSTED' || /rate limit|quota exceeded|too many requests/i.test(message)) {
    return out('RATE_LIMIT', 'provider_request');
  }
  if (status === 401 || status === 403 || pStatus === 'PERMISSION_DENIED' || pStatus === 'UNAUTHENTICATED'
    || /api key (not valid|invalid|expired)|Aucune clé/i.test(message)) {
    return out('AUTH_ERROR', declaredStage ?? 'provider_request');
  }
  if (/response_?schema|responseJsonSchema|response_json_schema|schema.*(not supported|too (complex|many states)|invalid)/i.test(message) && (status === 400 || pStatus === 'INVALID_ARGUMENT')) {
    return out('INVALID_OUTPUT', 'structured_output', 'STRUCTURED_OUTPUT_REJECTED');
  }
  if (/(input|prompt) token count|exceeds the maximum number of tokens|context (window|length)|too (long|large)|request payload size|maximum context/i.test(message)) {
    return out('CONTEXT_TOO_LARGE', 'provider_request');
  }
  if (code && NETWORK_CODES.has(code)) return out('NETWORK_ERROR', 'provider_request');
  const cause = e.cause as { code?: unknown } | undefined;
  if ((typeof cause?.code === 'string' && NETWORK_CODES.has(cause.code)) || /fetch failed|network|socket hang up|ECONNRESET|ENOTFOUND/i.test(message)) {
    return out('NETWORK_ERROR', 'provider_request');
  }
  if (status !== null && status >= 500) return out('PROVIDER_ERROR', 'provider_generation');
  if (status === 400 || status === 404 || status === 413 || status === 422 || pStatus === 'INVALID_ARGUMENT'
    || pStatus === 'NOT_FOUND' || pStatus === 'FAILED_PRECONDITION') {
    return out(status === 413 ? 'CONTEXT_TOO_LARGE' : 'INPUT_ERROR', 'provider_request');
  }
  if (pStatus === 'UNAVAILABLE' || pStatus === 'INTERNAL') return out('PROVIDER_ERROR', 'provider_generation');
  if (declaredStage === 'request_build') return out('INTERNAL_ERROR', 'request_build');
  if (code === 'PROVIDER_UNAVAILABLE') return out('PROVIDER_ERROR', 'provider_request');
  return out('UNKNOWN', declaredStage ?? 'provider_request');
}

// ── Signature d'échec (§10) ─────────────────────────────────────────────────

/** Chemin sans indices de tableau (`$.facts[*].target`). */
export function genericPath(path: string): string {
  return path.replace(/\[\d+\]/g, '[*]');
}

/**
 * Signature stable d'un échec : famille, sous-type, étape et première
 * erreur (chemin générique, attendu, reçu). Deux modèles qui échouent sur
 * la même validation ont la même signature.
 */
export function failureSignature(d: Pick<CallDiagnostic, 'family' | 'subtype' | 'stage' | 'issues'>): string | null {
  if (!d.family) return null;
  const first = d.issues[0];
  const parts = [d.family, d.subtype ?? '', d.stage ?? '',
    first ? genericPath(first.path) : '', first?.expected ?? '', first?.received ?? ''];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// ── Diagnostic de cascade (§10) et diagnostic final (§12, §13) ─────────────

export interface CascadeDiagnosis {
  analysisCalls: number;
  failedCalls: number;
  /** Tous les appels d'analyse en échec partagent la même signature. */
  identical: boolean;
  signature: string | null;
  cause: string | null;
  path: string | null;
  expected: string | null;
  received: string | null;
  stage: AiFailureStage | null;
}

export function cascadeDiagnosis(calls: Array<Pick<CallDiagnostic, 'outcome' | 'callKind' | 'family' | 'subtype' | 'stage' | 'issues' | 'signature'>>): CascadeDiagnosis {
  const analyses = calls.filter((c) => c.callKind === 'analysis');
  const failed = analyses.filter((c) => c.outcome === 'FAILED');
  const sigs = new Set(failed.map((c) => c.signature));
  const identical = failed.length >= 2 && failed.length === analyses.length && sigs.size === 1 && !sigs.has(null);
  const ref = failed[0];
  return {
    analysisCalls: analyses.length,
    failedCalls: failed.length,
    identical,
    signature: identical ? ref.signature : null,
    cause: identical ? displayCause(ref.family, ref.subtype) : null,
    path: identical ? ref.issues[0]?.path ?? null : null,
    expected: identical ? ref.issues[0]?.expected ?? null : null,
    received: identical ? ref.issues[0]?.received ?? null : null,
    stage: identical ? ref.stage : null,
  };
}

const STAGE_SENTENCE: Partial<Record<AiFailureStage, string>> = {
  response_reception: 'à la réception de la réponse',
  structured_output: 'au contrôle du structured output',
  json_parse: 'à la lecture du JSON',
  schema_validation: 'pendant la validation du schéma',
  business_validation: 'pendant la validation métier',
  result_mapping: 'pendant la conversion du résultat',
  post_processing: 'pendant le post-traitement',
};

/**
 * Diagnostic final, construit UNIQUEMENT à partir des constats (§12) :
 * aucune hypothèse sur la cause profonde.
 */
export function finalDiagnosis(p: {
  treatment: string | null;
  succeeded: boolean;
  calls: Array<Pick<CallDiagnostic, 'outcome' | 'callKind' | 'family' | 'subtype' | 'stage' | 'issues' | 'signature' | 'outputReceived' | 'repairs'>>;
  businessResult?: string | null;
}): string[] {
  const t = p.treatment ?? 'IA';
  const analyses = p.calls.filter((c) => c.callKind === 'analysis');
  const repairs = p.calls.filter((c) => c.callKind === 'repair');
  const lines: string[] = [];
  if (analyses.length === 0) return [`${t} : aucun appel modèle enregistré pour cette exécution.`];
  const n = analyses.length;
  const recus = analyses.filter((c) => c.outputReceived).length;
  const modeles = n === 1 ? 'Le modèle' : `${n === recus ? `Les ${n}` : `${recus}/${n}`} modèles`;

  if (p.succeeded) {
    lines.push(`Réussite ${t}.`);
    const corriges = p.calls.filter((c) => c.outcome === 'REPAIRED');
    if (corriges.length > 0) {
      const regles = [...new Set(corriges.flatMap((c) => c.repairs.map((r) => r.rule)))].slice(0, 6);
      lines.push(`Sortie acceptée après correction automatique (${regles.join(', ') || 'normalisation'}).`);
    }
    if (n > 1) lines.push(`${n - 1} appel(s) précédent(s) en échec avant la réussite.`);
    if (repairs.length > 0) lines.push(`${repairs.length} passe(s) de réparation ciblée sans relecture du document.`);
    if (p.businessResult && p.businessResult !== 'APPLIED') lines.push(`Résultat métier : ${p.businessResult}.`);
    return lines;
  }

  lines.push(`Échec ${t}.`);
  if (recus === 0) lines.push(n === 1 ? 'Le modèle n’a retourné aucune sortie.' : `Aucun des ${n} modèles n’a retourné de sortie.`);
  else lines.push(`${modeles} ${recus > 1 ? 'ont' : 'a'} retourné une sortie.`);
  const casc = cascadeDiagnosis(analyses);
  if (casc.identical) {
    const ou = casc.stage ? STAGE_SENTENCE[casc.stage] : null;
    lines.push(`${n === 2 ? 'Les deux' : `Les ${n}`} ${recus === n ? 'sorties ont été rejetées' : 'appels ont échoué'}${ou ? ` ${ou}` : ''} avec la même signature (${casc.cause}).`);
    if (casc.path) lines.push(`Cause commune : ${casc.path}.`);
    if (casc.expected) lines.push(`Attendu : ${casc.expected}.`);
    if (casc.received) lines.push(`Reçu : ${casc.received}.`);
  } else {
    for (const c of analyses) {
      const cause = displayCause(c.family, c.subtype) ?? 'cause non enregistrée';
      const where = c.issues[0]?.path ? ` — ${c.issues[0].path}` : '';
      lines.push(`· ${cause}${c.stage ? ` (étape ${c.stage})` : ''}${where}.`);
    }
  }
  if (repairs.length > 0) {
    const ok = repairs.filter((r) => r.outcome !== 'FAILED').length;
    lines.push(`${repairs.length} passe(s) de réparation ciblée : ${ok} réussie(s).`);
  }
  const allPre = analyses.every((c) => c.stage !== null && PRE_RESPONSE_STAGES.includes(c.stage));
  lines.push(allPre
    ? 'Le fournisseur n’a produit aucun résultat : aucune modification métier n’a été appliquée.'
    : 'Aucune modification métier n’a donc été appliquée.');
  return lines;
}
