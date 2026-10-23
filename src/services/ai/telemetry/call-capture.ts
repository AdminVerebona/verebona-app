/**
 * Capture complète à la source des appels IA — lot 82C (CDC Pilotage IA V2,
 * phase P1 : LOG-01 à LOG-10, R25, R26, R29, R30, R62, R65 à R67 ; décisions
 * PO du 22/10 n° 01, 10, 11 et 15). Table `ai_call_captures` (migration 0649).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST CAPTURÉ, POUR CHAQUE TENTATIVE RÉELLE
 *
 * Toutes les tentatives de tous les traitements (T1 à T6, T2 compris, et
 * l'usage technique AI_GOVERNANCE : evaluate_prompt, sondes, qualification,
 * test du fournisseur), réussies ou non, réparations comprises :
 *   · le prompt EFFECTIF FINAL réellement transmis (jamais reconstitué depuis
 *     la configuration courante), les essais internes du même modèle ;
 *   · les variables résolues (après masquage) — une valeur longue déjà
 *     présente telle quelle dans le prompt devient une référence
 *     { position, longueur, empreinte } : aucun doublon de contenu ;
 *   · l'ordre des messages (texte puis pièces jointes, ordre de l'adaptateur)
 *     et les pièces jointes PAR RÉFÉRENCE (type, transport, chemin de stockage
 *     sans paramètre signé, empreinte des données en ligne) ;
 *   · les paramètres effectivement envoyés et leur résolution ;
 *   · la réponse brute, la sortie après parsing, le diagnostic ;
 *   · la durée PROPRE de la tentative et la durée murale de l'exécution.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PROTECTION (LOG-07, LOG-10, décision PO 15)
 *
 * Masquage existant de la passerelle (`redact` : IBAN, cartes, clés d'API,
 * NIR) avant écriture, relevé dans `masking` (statut MASKED ≠ CAPTURED).
 * Lecture uniquement par les routes BO réservées (`model-output-access.ts`,
 * `AI_MODEL_OUTPUT_ADMIN_IDS`, consultation journalisée). Jamais de contenu
 * dans les journaux serveur : une erreur de capture écrit son motif SQL
 * seulement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * JAMAIS BLOQUANTE, VISIBLE ET REPRISE (LOG-07)
 *
 * L'écriture est attendue au plus `CAPTURE_MAX_WAIT_MS` : au-delà, le
 * traitement métier continue et l'écriture se termine en arrière-plan. Un
 * échec place la ligne dans une file locale BORNÉE (nombre, octets) reprise
 * avec un délai croissant (5 tentatives au plus) — sans relancer Gemini ni
 * le traitement. File pleine ou reprises épuisées : une ligne NOT_CAPTURED
 * (sans contenu, avec motif) est écrite si possible ; tout appel sans
 * capture est de toute façon signalé par la Supervision (`captureGap`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { redactWithReport, maskMarkersIn, redact } from '../gateway/redaction';
import type { AiAttachment } from '../gateway/types';
import type { ProviderCallInput } from '../gateway/providers/provider.port';
import { buildGenerationConfig } from '../gateway/providers/gemini-generation-config';

export type PromptStatus = 'CAPTURED' | 'MASKED' | 'NOT_SENT' | 'NOT_CAPTURED';
export type ResponseStatus = 'CAPTURED' | 'MASKED' | 'NO_RESPONSE' | 'NOT_CAPTURED';
export type CaptureOrigin = 'gateway' | 'circuit_breaker_probe' | 'model_operational_probe' | 'model_qualification_probe' | 'provider_test';
export type CaptureCallKind = 'analysis' | 'repair' | 'pre_call_refusal' | 'probe' | 'test';

/** Version du format de capture (colonne `capture_version`). */
export const CAPTURE_VERSION = 1;
/** Attente maximale de l'écriture par le traitement métier. */
export const CAPTURE_MAX_WAIT_MS = 1_500;
/** Valeur de variable remplacée par une référence au prompt au-delà de cette longueur. */
export const VARIABLE_REF_MIN_CHARS = 2_048;
/** File locale de reprise : bornes. */
export const RETRY_MAX_ITEMS = 200;
export const RETRY_MAX_BYTES = 64 * 1024 * 1024;
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/** Requête réellement transmise au fournisseur (un essai interne). */
export interface CapturedRequest {
  /** `initial`, `schema_rejected_retry`, `diagnostic_retry`, `repair`, `probe`… */
  kind: string;
  prompt: string;
  /** Paramètres de génération construits (schéma de sortie remplacé par son empreinte). */
  generationConfig?: Record<string, unknown> | null;
  timeoutMs?: number | null;
  outcome?: 'SUCCESS' | 'FAILED';
  error?: string | null;
}

/** Capture fournie par l'appelant de `recordCallTrace` (passerelle, sondes). */
export interface CallCaptureInput {
  origin: CaptureOrigin;
  callKind: CaptureCallKind;
  /** Requêtes transmises dans l'ordre ; vide : aucun envoi (refus avant appel). */
  sent: CapturedRequest[];
  /** Variables résolues APRÈS masquage. */
  variables?: Record<string, unknown> | null;
  /** Masques appliqués aux variables avant construction du prompt. */
  variableMasks?: Record<string, number>;
  attachments?: ReadonlyArray<AiAttachment>;
  /** Paramètres résolus (raisonnement, plafond demandé/hérité/adapté/envoyé, délai…). */
  params?: Record<string, unknown>;
  /** Réponse brute reçue ; `null` : aucune réponse. */
  responseRaw: string | null;
  parsed?: unknown;
  diagnostic?: unknown;
  attemptDurationMs: number;
  executionElapsedMs?: number | null;
  subjectRef?: string | null;
  sourceIds?: number[];
  callIndex?: number | null;
}

/** Corrélation, issue de la trace (`ai_usage_event`). */
export interface CaptureContext {
  usageEventId: number | null;
  traceId: string;
  accountId: number | null;
  userId?: number | null;
  jobId?: number | null;
  useCaseCode: string | null;
  operationCode: string;
  task?: string | null;
  model?: string | null;
  modelRank?: string | null;
  capturedAt?: Date;
}

export interface CaptureRow {
  captured_at: string;
  trace_id: string;
  usage_event_id: number | null;
  call_index: number | null;
  call_kind: string;
  origin: string;
  account_id: number | null;
  user_id: number | null;
  job_id: number | null;
  use_case_code: string | null;
  operation_code: string;
  task: string | null;
  model: string | null;
  model_rank: string | null;
  subject_ref: string | null;
  source_ids: number[];
  capture_status: 'CAPTURED' | 'PARTIAL' | 'NOT_CAPTURED';
  capture_reason: string | null;
  capture_attempts: number;
  prompt_status: PromptStatus;
  prompt_text: string | null;
  prompt_chars: number | null;
  prompt_sha256: string | null;
  variables: unknown;
  messages: unknown;
  attachments: unknown;
  request_params: unknown;
  provider_steps: unknown;
  response_status: ResponseStatus;
  response_raw: string | null;
  response_chars: number | null;
  response_sha256: string | null;
  parsed_output: unknown;
  diagnostic: unknown;
  masking: unknown;
  attempt_duration_ms: number | null;
  execution_elapsed_ms: number | null;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const entier = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : null);

/**
 * Référence d'une pièce jointe, SANS son contenu (LOG-02) : chemin de
 * stockage sans paramètres (une URL signée porte un jeton : LOG-07), type,
 * transport, empreinte et taille des données en ligne. Pur.
 */
export function attachmentRef(att: Pick<AiAttachment, 'url' | 'mimeType' | 'displayName' | 'data'>, index: number, transport?: string): Record<string, unknown> {
  let storage: string | null = null;
  const url = String(att.url ?? '');
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      storage = `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      storage = null;
    }
  } else if (url) {
    storage = url.split('?')[0];
  }
  const ref: Record<string, unknown> = {
    index, mimeType: att.mimeType, displayName: att.displayName ?? null, storage,
    ...(transport ? { transport } : {}),
  };
  if (typeof att.data === 'string') {
    const bytes = Buffer.from(att.data, 'base64');
    ref.inlineBytes = bytes.length;
    ref.inlineSha256 = createHash('sha256').update(bytes).digest('hex');
  }
  return ref;
}

/**
 * Variables résolues sans doublon : une valeur texte longue (≥ 2 048
 * caractères) présente telle quelle dans le prompt est remplacée par
 * `{ $ref: 'prompt', offset, length, sha256 }` — sans perte, le prompt la
 * contient. Pur.
 */
export function dedupeVariables(vars: Record<string, unknown> | null | undefined, prompt: string | null): Record<string, unknown> | null {
  if (!vars) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string' && v.length >= VARIABLE_REF_MIN_CHARS && prompt) {
      const offset = prompt.indexOf(v);
      if (offset >= 0) {
        out[k] = { $ref: 'prompt', offset, length: v.length, sha256: sha256(v) };
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

function masquerJson(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(masquerJson);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, masquerJson(x)]));
  return v;
}

/** JSON sûr (BigInt, cycles) pour une colonne JSONB ; `undefined` → null. Pur. */
function jsonOrNull(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    const seen = new WeakSet();
    return JSON.parse(JSON.stringify(v, (_k, x) => {
      if (typeof x === 'bigint') return x.toString();
      if (x && typeof x === 'object') {
        if (seen.has(x)) return '[cycle]';
        seen.add(x);
      }
      return x;
    }));
  } catch {
    return null;
  }
}

/**
 * Ligne de capture d'une tentative (pur, testé sans base). `transportOf` :
 * transport d'une pièce jointe selon l'adaptateur (passerelle).
 */
export function buildCaptureRow(ctx: CaptureContext, c: CallCaptureInput, transportOf?: (a: AiAttachment) => string): CaptureRow {
  const last = c.sent.length > 0 ? c.sent[c.sent.length - 1] : null;
  const prompt = last?.prompt ?? null;
  const promptMasks = { ...(c.variableMasks ?? {}) };
  if (prompt && Object.keys(promptMasks).length === 0) Object.assign(promptMasks, maskMarkersIn(prompt));
  const promptStatus: PromptStatus = prompt === null ? 'NOT_SENT' : Object.keys(promptMasks).length > 0 ? 'MASKED' : 'CAPTURED';

  let responseRaw: string | null = null;
  let responseMasks: Record<string, number> = {};
  if (c.responseRaw !== null && c.responseRaw !== undefined) {
    const r = redactWithReport(String(c.responseRaw));
    responseRaw = r.text;
    responseMasks = r.masks;
  }
  const responseStatus: ResponseStatus = responseRaw === null ? 'NO_RESPONSE' : Object.keys(responseMasks).length > 0 ? 'MASKED' : 'CAPTURED';

  const atts = (c.attachments ?? []).map((a, i) => attachmentRef(a, i, transportOf?.(a as AiAttachment)));
  const messages = prompt === null ? [] : [
    { order: 1, role: 'user', type: 'text', source: 'prompt', chars: prompt.length, sha256: sha256(prompt) },
    ...atts.map((a, i) => ({
      order: i + 2, role: 'user', type: 'attachment', attachmentIndex: i, mimeType: a.mimeType,
      transport: a.transport ?? null,
      // Bureautique extraite côté serveur : le texte dérivé du fichier n'est pas dupliqué (référence au fichier).
      ...(a.transport === 'text_extracted' ? { note: 'contenu extrait du fichier par l’adaptateur, non dupliqué' } : {}),
    })),
  ];
  const steps = c.sent.map((s, i) => ({
    step: i + 1, kind: s.kind, promptChars: s.prompt.length, promptSha256: sha256(s.prompt),
    // Prompt d'un essai interne différent du prompt final : conservé (prompts d'essai distincts).
    ...(i < c.sent.length - 1 && s.prompt !== prompt ? { promptText: s.prompt } : {}),
    generationConfig: s.generationConfig ?? null, timeoutMs: s.timeoutMs ?? null,
    outcome: s.outcome ?? null, error: s.error ? redact(String(s.error)).slice(0, 2_000) : null,
  }));

  return {
    captured_at: (ctx.capturedAt ?? new Date()).toISOString(),
    trace_id: ctx.traceId,
    usage_event_id: ctx.usageEventId,
    call_index: c.callIndex ?? null,
    call_kind: c.callKind,
    origin: c.origin,
    account_id: ctx.accountId ?? null,
    user_id: ctx.userId ?? null,
    job_id: ctx.jobId ?? null,
    use_case_code: ctx.useCaseCode,
    operation_code: ctx.operationCode,
    task: ctx.task ?? null,
    model: ctx.model ?? null,
    model_rank: ctx.modelRank ?? null,
    subject_ref: c.subjectRef ?? null,
    source_ids: (c.sourceIds ?? []).filter((x) => Number.isInteger(x)),
    capture_status: 'CAPTURED',
    capture_reason: null,
    capture_attempts: 1,
    prompt_status: promptStatus,
    prompt_text: prompt,
    prompt_chars: prompt?.length ?? null,
    prompt_sha256: prompt === null ? null : sha256(prompt),
    variables: jsonOrNull(dedupeVariables(c.variables ?? null, prompt)),
    messages: jsonOrNull(messages),
    attachments: jsonOrNull(atts),
    request_params: jsonOrNull(c.params ?? null),
    provider_steps: jsonOrNull(steps),
    response_status: responseStatus,
    response_raw: responseRaw,
    response_chars: responseRaw?.length ?? null,
    response_sha256: responseRaw === null ? null : sha256(responseRaw),
    parsed_output: c.parsed === undefined || c.parsed === null ? null : jsonOrNull(masquerJson(c.parsed)),
    diagnostic: jsonOrNull(c.diagnostic ?? null),
    masking: jsonOrNull({
      rule: 'redact (IBAN, cartes, clés d’API, NIR)',
      prompt: promptMasks,
      response: responseMasks,
    }),
    attempt_duration_ms: entier(c.attemptDurationMs),
    execution_elapsed_ms: entier(c.executionElapsedMs),
  };
}

/**
 * Lot 82C — requête réellement transmise, pour la capture : prompt, délai et
 * `generationConfig` CONSTRUIT par l'adaptateur (même fonction), le schéma de
 * sortie étant remplacé par son empreinte (dérivé du contrat, déjà tracé). Pur.
 */
export function capturedRequestOf(i: ProviderCallInput, providerSchemaHashValue: string | null): CapturedRequest {
  const cfg = buildGenerationConfig({
    model: i.model, maxOutputTokens: i.maxOutputTokens, reasoning: i.reasoning, jsonResponse: i.jsonResponse,
    ...(i.responseSchema ? { responseSchema: i.responseSchema } : {}),
  });
  if (cfg.responseJsonSchema !== undefined) cfg.responseJsonSchema = { sent: true, providerSchemaHash: providerSchemaHashValue };
  return {
    kind: i.callKind === 'repair' ? 'repair' : 'initial', prompt: i.prompt, timeoutMs: i.timeoutMs,
    generationConfig: { model: i.model, ...cfg, attachments: i.attachments?.length ?? 0 },
  };
}

/**
 * Capture d'un appel TECHNIQUE direct au port fournisseur (sonde du
 * disjoncteur, sonde opérationnelle, qualification) : mêmes champs que la
 * passerelle. Pur.
 */
export function technicalCapture(p: {
  origin: CaptureOrigin; input: ProviderCallInput; responseRaw: string | null; error?: string | null; durationMs: number;
}): CallCaptureInput {
  const req = capturedRequestOf(p.input, null);
  req.kind = 'probe';
  req.outcome = p.responseRaw !== null ? 'SUCCESS' : 'FAILED';
  req.error = p.error ?? null;
  return {
    origin: p.origin, callKind: 'probe', sent: [req], attachments: p.input.attachments ?? [],
    params: { model: p.input.model, reasoning: p.input.reasoning ?? null, maxOutputTokens: { sent: p.input.maxOutputTokens ?? null }, timeoutMs: p.input.timeoutMs },
    responseRaw: p.responseRaw, attemptDurationMs: p.durationMs, executionElapsedMs: p.durationMs,
    ...(p.error ? { diagnostic: { error: p.error } } : {}),
  };
}

/** Ligne NOT_CAPTURED sans contenu (capture désactivée, ou reprises épuisées). Pur. */
export function notCapturedRow(row: CaptureRow, reason: string, attempts: number): CaptureRow {
  return {
    ...row,
    capture_status: 'NOT_CAPTURED', capture_reason: reason.slice(0, 300), capture_attempts: attempts,
    prompt_status: 'NOT_CAPTURED', prompt_text: null, variables: null, provider_steps: null, parsed_output: null,
    response_status: 'NOT_CAPTURED', response_raw: null,
  };
}

/** Taille approximative d'une ligne en mémoire (borne de la file de reprise). */
export function rowBytes(row: CaptureRow): number {
  return (row.prompt_text?.length ?? 0) + (row.response_raw?.length ?? 0) + JSON.stringify(row.variables ?? null).length
    + JSON.stringify(row.parsed_output ?? null).length + JSON.stringify(row.provider_steps ?? null).length + 2_000;
}

/** Capture active ? `AI_CALL_CAPTURE=off` : coupure d'urgence (volume), défaut actif (décision PO 11). */
export function captureEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !['off', 'false', '0'].includes((env.AI_CALL_CAPTURE ?? '').trim().toLowerCase());
}

// ══════════════════════════════════════════════════════════════════════════
// Écriture, file de reprise bornée
// ══════════════════════════════════════════════════════════════════════════

const COLUMNS = [
  'captured_at', 'trace_id', 'usage_event_id', 'call_index', 'call_kind', 'origin', 'account_id', 'user_id', 'job_id',
  'use_case_code', 'operation_code', 'task', 'model', 'model_rank', 'subject_ref', 'source_ids', 'capture_status',
  'capture_reason', 'capture_attempts', 'prompt_status', 'prompt_text', 'prompt_chars', 'prompt_sha256', 'variables',
  'messages', 'attachments', 'request_params', 'provider_steps', 'response_status', 'response_raw', 'response_chars',
  'response_sha256', 'parsed_output', 'diagnostic', 'masking', 'attempt_duration_ms', 'execution_elapsed_ms',
] as const;
const JSON_COLS = new Set(['variables', 'messages', 'attachments', 'request_params', 'provider_steps', 'parsed_output', 'diagnostic', 'masking']);

export type CaptureWriter = (row: CaptureRow) => Promise<void>;

/** Écriture réelle d'une ligne (exportée pour les tests : simuler un échec puis la reprise). */
export async function writeCaptureRow(row: CaptureRow): Promise<void> {
  const { pgClient } = await import('@/db');
  const values = COLUMNS.map((c) => {
    const v = row[c];
    return JSON_COLS.has(c) ? (v === null || v === undefined ? null : JSON.stringify(v)) : v;
  });
  const placeholders = COLUMNS.map((c, i) => `$${i + 1}${c === 'source_ids' ? '::int[]' : JSON_COLS.has(c) ? '::jsonb' : c === 'captured_at' ? '::timestamptz' : ''}`);
  await pgClient.unsafe(
    `INSERT INTO ai_call_captures (${COLUMNS.join(', ')}, capture_version) VALUES (${placeholders.join(', ')}, ${CAPTURE_VERSION})`,
    values as never[],
  );
}

let writer: CaptureWriter = writeCaptureRow;
/** Réservé aux tests : remplace l'écriture (simulation d'une base indisponible). `null` : écriture réelle. */
export function setCaptureWriterForTests(w: CaptureWriter | null): void {
  writer = w ?? writeCaptureRow;
}

interface Pending { row: CaptureRow; attempts: number; nextAt: number; bytes: number; lastError: string }
const pending: Pending[] = [];
let pendingBytes = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const health = { written: 0, retried: 0, recovered: 0, dropped: 0, lastError: null as string | null };

/** État de la capture sur cette instance (BO, tests). */
export function captureHealth(): { pending: number; pendingBytes: number; written: number; retried: number; recovered: number; dropped: number; lastError: string | null } {
  return { pending: pending.length, pendingBytes, ...health };
}

/** Réservé aux tests. */
export function resetCaptureQueueForTests(): void {
  pending.length = 0;
  pendingBytes = 0;
  if (timer) clearTimeout(timer);
  timer = null;
  Object.assign(health, { written: 0, retried: 0, recovered: 0, dropped: 0, lastError: null });
}

function dbDisponible(): boolean {
  return !(process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) || writer !== writeCaptureRow;
}

const motif = (e: unknown): string => String((e as { code?: string })?.code ?? '') + ' ' + String((e as Error)?.message ?? e).slice(0, 200);

async function abandon(p: Pending, reason: string): Promise<void> {
  health.dropped += 1;
  // Ligne sans contenu : l'absence est visible et motivée (LOG-08), jamais silencieuse.
  try {
    await writer(notCapturedRow(p.row, reason, p.attempts));
  } catch (e) {
    console.error('[ai-capture] capture abandonnée, motif non écrit (non bloquant) :', motif(e));
  }
}

function planifier(): void {
  if (timer || pending.length === 0) return;
  const next = Math.min(...pending.map((p) => p.nextAt));
  timer = setTimeout(() => {
    timer = null;
    void flushCaptureRetries();
  }, Math.max(0, next - Date.now()));
  (timer as { unref?: () => void }).unref?.();
}

function enqueue(row: CaptureRow, error: unknown): void {
  const bytes = rowBytes(row);
  const p: Pending = { row, attempts: 1, nextAt: Date.now() + RETRY_DELAYS_MS[0], bytes, lastError: motif(error) };
  health.lastError = p.lastError;
  if (pending.length >= RETRY_MAX_ITEMS || pendingBytes + bytes > RETRY_MAX_BYTES) {
    void abandon(p, `file de reprise pleine (${pending.length} capture(s), ${pendingBytes} octets) : ${p.lastError}`);
    return;
  }
  pending.push(p);
  pendingBytes += bytes;
  planifier();
}

/**
 * Reprend les captures en attente. `force` : sans attendre l'échéance
 * (tests, fin de traitement). Rend le nombre de captures écrites.
 */
export async function flushCaptureRetries(opts: { force?: boolean } = {}): Promise<number> {
  let ok = 0;
  const now = Date.now();
  for (const p of [...pending]) {
    if (!opts.force && p.nextAt > now) continue;
    health.retried += 1;
    try {
      await writer({ ...p.row, capture_attempts: p.attempts + 1 });
      pending.splice(pending.indexOf(p), 1);
      pendingBytes -= p.bytes;
      health.recovered += 1;
      health.written += 1;
      ok += 1;
    } catch (e) {
      p.attempts += 1;
      p.lastError = motif(e);
      health.lastError = p.lastError;
      if (p.attempts > RETRY_DELAYS_MS.length) {
        pending.splice(pending.indexOf(p), 1);
        pendingBytes -= p.bytes;
        await abandon(p, `${p.attempts} tentatives d’écriture en échec : ${p.lastError}`);
      } else {
        p.nextAt = Date.now() + RETRY_DELAYS_MS[p.attempts - 1];
      }
    }
  }
  planifier();
  return ok;
}

async function writeOrQueue(row: CaptureRow): Promise<void> {
  try {
    await writer(row);
    health.written += 1;
    if (pending.length > 0) void flushCaptureRetries();
  } catch (e) {
    console.error('[ai-capture] capture non écrite, reprise planifiée (non bloquant) :', motif(e));
    enqueue(row, e);
  }
}

/**
 * Enregistre la capture d'une tentative. Ne lève jamais ; attend au plus
 * `CAPTURE_MAX_WAIT_MS` (le traitement métier n'est jamais bloqué).
 */
export async function recordCallCapture(ctx: CaptureContext, c: CallCaptureInput, transportOf?: (a: AiAttachment) => string): Promise<void> {
  if (!dbDisponible()) return;
  let row: CaptureRow;
  try {
    row = buildCaptureRow(ctx, c, transportOf);
  } catch (e) {
    console.error('[ai-capture] capture non construite (non bloquant) :', motif(e));
    return;
  }
  if (!captureEnabled()) {
    await writer(notCapturedRow(row, 'capture désactivée (AI_CALL_CAPTURE=off)', 0)).catch(() => undefined);
    return;
  }
  let delai: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      writeOrQueue(row),
      new Promise<void>((resolve) => {
        delai = setTimeout(resolve, CAPTURE_MAX_WAIT_MS);
        (delai as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (delai) clearTimeout(delai);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Lecture (BO réservé) et suppressions ciblées
// ══════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>;

/** Mention d'un contenu absent ou masqué (LOG-08), en clair pour le BO. */
export const CONTENT_STATUS_LABELS: Record<PromptStatus | ResponseStatus | 'NOT_RETAINED_HISTORICALLY', string> = {
  CAPTURED: 'capturé',
  MASKED: 'capturé, masqué (IBAN, cartes, clés, NIR)',
  NOT_SENT: 'aucun envoi au modèle',
  NO_RESPONSE: 'aucune réponse du modèle',
  NOT_CAPTURED: 'non capturé',
  NOT_RETAINED_HISTORICALLY: 'non conservé historiquement (appel antérieur à la capture)',
};

export interface CallCaptureView {
  captureId: number | null;
  usageEventId: number;
  traceId: string | null;
  callIndex: number | null;
  callKind: string | null;
  origin: string | null;
  model: string | null;
  modelRank: string | null;
  /** CAPTURED / PARTIAL / NOT_CAPTURED / NOT_RETAINED_HISTORICALLY / PENDING (appel récent, capture non encore écrite). */
  captureStatus: string;
  captureReason: string | null;
  promptStatus: string;
  responseStatus: string;
  prompt: string | null;
  promptChars: number | null;
  promptSha256: string | null;
  variables: unknown;
  messages: unknown;
  attachments: unknown;
  requestParams: unknown;
  providerSteps: unknown;
  response: string | null;
  responseChars: number | null;
  responseSha256: string | null;
  parsed: unknown;
  diagnostic: unknown;
  masking: unknown;
  attemptDurationMs: number | null;
  executionElapsedMs: number | null;
  capturedAt: string | null;
}

const j = (v: unknown): unknown => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v ?? null);
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Instant de mise en service de la capture (`null` : migration 0649 absente). */
export async function captureStartedAt(): Promise<Date | null> {
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(`SELECT started_at FROM ai_call_capture_state WHERE id = 1`)) as unknown as Row[];
    return r[0]?.started_at ? new Date(String(r[0].started_at)) : null;
  } catch {
    return null;
  }
}

/** Délai au-delà duquel un appel sans capture n'est plus « en cours d'écriture ». */
export const CAPTURE_PENDING_GRACE_MS = 15 * 60_000;

/**
 * Captures des appels (`ai_usage_event`) d'une trace, AVEC leur contenu —
 * réservé aux routes BO protégées (`model-output-access.ts`), qui
 * journalisent. Un appel sans capture porte sa mention : non conservé
 * historiquement (antérieur à la capture), en cours d'écriture, ou non
 * capturé (échec).
 */
export async function readTraceCaptures(traceId: string, now: Date = new Date()): Promise<CallCaptureView[]> {
  const { pgClient } = await import('@/db');
  const started = await captureStartedAt();
  const calls = (await pgClient.unsafe(
    `SELECT id, created_at, model, model_rank FROM ai_usage_event WHERE metadata->>'traceId' = $1 ORDER BY id LIMIT 60`,
    [traceId] as never[],
  )) as unknown as Row[];
  const caps = started
    ? (await pgClient.unsafe(
      `SELECT * FROM ai_call_captures WHERE trace_id = $1 ORDER BY call_index NULLS LAST, id LIMIT 60`,
      [traceId] as never[],
    )) as unknown as Row[]
    : [];
  const parEvenement = new Map<number, Row>();
  for (const c of caps) if (c.usage_event_id != null) parEvenement.set(Number(c.usage_event_id), c);
  const vus = new Set<number>();
  const out: CallCaptureView[] = [];
  for (const e of calls) {
    const id = Number(e.id);
    const c = parEvenement.get(id);
    if (c) {
      vus.add(Number(c.id));
      out.push(toView(c, id));
      continue;
    }
    const at = new Date(String(e.created_at));
    const status = !started || at < started ? 'NOT_RETAINED_HISTORICALLY'
      : now.getTime() - at.getTime() < CAPTURE_PENDING_GRACE_MS ? 'PENDING' : 'NOT_CAPTURED';
    out.push({
      captureId: null, usageEventId: id, traceId, callIndex: null, callKind: null, origin: null,
      model: s(e.model), modelRank: s(e.model_rank), captureStatus: status,
      captureReason: status === 'NOT_RETAINED_HISTORICALLY' ? 'appel antérieur à la mise en service de la capture (lot 82C) : non conservé historiquement, jamais reconstitué'
        : status === 'PENDING' ? 'capture en cours d’écriture ou en reprise' : 'aucune capture enregistrée pour cet appel (échec de capture)',
      promptStatus: status === 'NOT_RETAINED_HISTORICALLY' ? 'NOT_RETAINED_HISTORICALLY' : 'NOT_CAPTURED',
      responseStatus: status === 'NOT_RETAINED_HISTORICALLY' ? 'NOT_RETAINED_HISTORICALLY' : 'NOT_CAPTURED',
      prompt: null, promptChars: null, promptSha256: null, variables: null, messages: null, attachments: null, requestParams: null,
      providerSteps: null, response: null, responseChars: null, responseSha256: null, parsed: null, diagnostic: null, masking: null,
      attemptDurationMs: null, executionElapsedMs: null, capturedAt: null,
    });
  }
  // Capture sans événement d'usage (trace non écrite) : rendue quand même.
  for (const c of caps) if (!vus.has(Number(c.id)) && (c.usage_event_id == null || !calls.some((e) => Number(e.id) === Number(c.usage_event_id)))) out.push(toView(c, n(c.usage_event_id) ?? 0));
  return out;
}

function toView(c: Row, usageEventId: number): CallCaptureView {
  return {
    captureId: Number(c.id), usageEventId, traceId: s(c.trace_id), callIndex: n(c.call_index), callKind: s(c.call_kind), origin: s(c.origin),
    model: s(c.model), modelRank: s(c.model_rank), captureStatus: String(c.capture_status), captureReason: s(c.capture_reason),
    promptStatus: String(c.prompt_status), responseStatus: String(c.response_status),
    prompt: s(c.prompt_text), promptChars: n(c.prompt_chars), promptSha256: s(c.prompt_sha256),
    variables: j(c.variables), messages: j(c.messages), attachments: j(c.attachments), requestParams: j(c.request_params),
    providerSteps: j(c.provider_steps), response: s(c.response_raw), responseChars: n(c.response_chars), responseSha256: s(c.response_sha256),
    parsed: j(c.parsed_output), diagnostic: j(c.diagnostic), masking: j(c.masking),
    attemptDurationMs: n(c.attempt_duration_ms), executionElapsedMs: n(c.execution_elapsed_ms),
    capturedAt: c.captured_at ? new Date(String(c.captured_at)).toISOString() : null,
  };
}

/** Référence d'objet d'une conversation de l'assistant (`subject_ref`). */
export const t2ConversationRef = (conversationId: number): string => `t2-conversation:${conversationId}`;

/** Conversation T2 d'une clé d'idempotence de l'assistant (`assistant:c{id}:…`). Pur. */
export function subjectRefOfIdempotencyKey(key: string | undefined | null): string | null {
  const m = /^assistant:c(\d+):/.exec(key ?? '');
  return m ? t2ConversationRef(Number(m[1])) : null;
}

/**
 * Effacement manuel de l'historique de l'assistant (§24.5) : droit de
 * suppression exercé par l'utilisateur, maintenu (décision PO 01) — les
 * échanges capturés de ces conversations sont supprimés dans la même
 * transaction. La purge AUTOMATIQUE à 90 jours ne les touche pas (aucune
 * purge par ancienneté, décision PO 01). Table absente : rien.
 */
export async function purgeConversationCaptures(sql: { unsafe: (q: string, p?: never[]) => PromiseLike<unknown> }, conversationIds: number[]): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const reg = await sql.unsafe(`SELECT to_regclass('ai_call_captures') IS NOT NULL AS present`);
  if (!Array.isArray(reg) || !(reg[0] as { present?: boolean } | undefined)?.present) return 0;
  const rows = await sql.unsafe(
    `DELETE FROM ai_call_captures WHERE subject_ref = ANY($1::text[]) RETURNING 1`,
    [conversationIds.map(t2ConversationRef)] as never[],
  );
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Supervision (LOG-07) : appels IA sans capture depuis la mise en service
 * (fenêtre de `days` jours, hors appels récents encore en écriture) et
 * captures abandonnées. Lecture seule.
 */
export async function captureGap(days = 7): Promise<{ missing: number; notCaptured: number; lastAt: Date | null; lastReason: string | null } | null> {
  const started = await captureStartedAt();
  if (!started) return null;
  const { pgClient } = await import('@/db');
  const [m] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n, max(e.created_at) AS last_at
       FROM ai_usage_event e
      WHERE e.created_at >= GREATEST($1::timestamptz, now() - make_interval(days => $2::int))
        AND e.created_at < now() - make_interval(mins => 15)
        AND NOT EXISTS (SELECT 1 FROM ai_call_captures c WHERE c.usage_event_id = e.id)`,
    [started.toISOString(), days] as never[],
  )) as unknown as Row[];
  const [x] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n, max(created_at) AS last_at,
            (array_agg(capture_reason ORDER BY id DESC))[1] AS reason
       FROM ai_call_captures
      WHERE capture_status = 'NOT_CAPTURED' AND created_at >= now() - make_interval(days => $1::int)`,
    [days] as never[],
  )) as unknown as Row[];
  const dates = [m?.last_at, x?.last_at].filter(Boolean).map((d) => new Date(String(d)).getTime());
  return {
    missing: Number(m?.n ?? 0),
    notCaptured: Number(x?.n ?? 0),
    lastAt: dates.length ? new Date(Math.max(...dates)) : null,
    lastReason: x?.reason == null ? null : String(x.reason),
  };
}
