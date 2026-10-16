/**
 * Lot 61 — extract brut persistant et états séparés des phases T1 (ticket T1
 * §3, §6, §7).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   ensureRawExtract  AVANT le modèle : lecture déterministe du fichier,
 *                     écrite dans `document_raw_extracts` (une ligne par
 *                     fichier). Déjà présent pour le même objet de stockage et
 *                     la même version d'extracteur → RÉUTILISÉ (ni nouveau
 *                     téléchargement, ni ré-extraction) : c'est le cas d'une
 *                     reprise après échec de Gemini.
 *   markStructuring   RUNNING → SUCCEEDED | FAILED (code et étape de l'erreur).
 *   markPersistence   SUCCEEDED | PARTIAL | FAILED (étapes en échec).
 *
 * Aucune fonction ne lève : l'extract brut et ses états COMPLÈTENT T1, ils ne
 * peuvent pas le faire échouer. Table absente (migration 0435 non appliquée)
 * → aucune écriture, T1 inchangé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { extractRawText, rawExtractLimits, RAW_EXTRACTOR_VERSION, type RawExtract } from './extract';
import { redact } from '../../gateway/redaction';
import { errorText } from '../../execution-report/model';

/** Message d'erreur technique stocké : secrets masqués (clés d'API, URL de base), borné. */
const safeMessage = (m: string) => redact(errorText(m)).slice(0, 2_000);

type Row = Record<string, unknown>;

let pret: Promise<boolean> | null = null;
/** Table présente ? (mémorisé ; une absence est réévaluée au prochain processus). */
export function rawExtractsReady(): Promise<boolean> {
  pret ??= (pgClient.unsafe(`SELECT to_regclass('public.document_raw_extracts') IS NOT NULL AS ok`) as unknown as Promise<Row[]>)
    .then((r) => r[0]?.ok === true)
    .catch(() => false);
  return pret;
}
/** Tests : oublie l'état mémorisé de la table. */
export function __resetRawExtractsReady(): void { pret = null; }

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Référence stable d'un objet de stockage : URL sans signature (hôte + chemin). */
export function sourceRefOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

/** Résumé d'un extract brut (sans contenu) pour le rapport et les journaux. */
export interface RawExtractSummary {
  id: number;
  fileId: number;
  status: string;
  method: string;
  pageCount: number | null;
  pagesWithText: number;
  pagesWithoutText: number[];
  truncated: boolean;
  truncationReason: string | null;
  chars: number;
  fullTextSha256: string | null;
  reused: boolean;
  error: string | null;
}

const COLS = `id, file_id, extraction_status, method, page_count, pages_with_text, pages_without_text, truncated, truncation_reason,
  full_text_chars, full_text_sha256, extraction_error, source_ref, extractor_version`;

function summary(r: Row, reused: boolean): RawExtractSummary {
  return {
    id: Number(r.id), fileId: Number(r.file_id), status: String(r.extraction_status), method: String(r.method),
    pageCount: r.page_count == null ? null : Number(r.page_count), pagesWithText: Number(r.pages_with_text ?? 0),
    pagesWithoutText: ((r.pages_without_text as number[] | null) ?? []).map(Number), truncated: r.truncated === true,
    truncationReason: (r.truncation_reason as string | null) ?? null, chars: Number(r.full_text_chars ?? 0),
    fullTextSha256: (r.full_text_sha256 as string | null) ?? null, reused, error: (r.extraction_error as string | null) ?? null,
  };
}

export interface EnsureRawExtractInput {
  accountId: number;
  fileId: number;
  url: string | null | undefined;
  mimeType: string | null;
  jobId?: number | null;
  /** Octets du fichier (défaut : `page-chunks#fetchSourceBytes`, remplaçable en test). */
  fetchBytes?: (url: string) => Promise<Uint8Array | null>;
  /** Taille maximale lue (octets) ; au-delà : FAILED explicite. */
  maxBytes?: number;
}

/**
 * Extract brut du fichier : réutilisé s'il existe pour le même objet et la
 * même version d'extracteur (et n'est pas en échec), sinon lu puis écrit.
 * Rend `null` si la table est absente ou si l'écriture échoue (journalisé).
 */
export async function ensureRawExtract(p: EnsureRawExtractInput): Promise<RawExtractSummary | null> {
  try {
    if (!(await rawExtractsReady())) return null;
    const ref = sourceRefOf(p.url);
    const [existant] = (await pgClient.unsafe(
      `SELECT ${COLS} FROM document_raw_extracts WHERE file_id = $1 AND account_id = $2`,
      [p.fileId, p.accountId] as never[],
    )) as unknown as Row[];
    if (existant && ref && existant.source_ref === ref && Number(existant.extractor_version) === RAW_EXTRACTOR_VERSION
      && existant.extraction_status !== 'FAILED') {
      await pgClient.unsafe(
        `UPDATE document_raw_extracts SET reuse_count = reuse_count + 1, last_job_id = COALESCE($3, last_job_id), updated_at = NOW()
          WHERE file_id = $1 AND account_id = $2`,
        [p.fileId, p.accountId, p.jobId ?? null] as never[],
      );
      return summary(existant, true);
    }

    let ex: RawExtract;
    let bytes: Uint8Array | null = null;
    if (!p.url) {
      ex = { method: 'NONE', status: 'FAILED', pageCount: null, pagesWithText: 0, pagesWithoutText: [], truncated: false,
        truncationReason: null, fullText: null, pages: [], error: 'aucun objet de stockage pour ce fichier', durationMs: 0 };
    } else {
      const fetchBytes = p.fetchBytes ?? (await import('../source-units/page-chunks')).fetchSourceBytes;
      bytes = await fetchBytes(p.url);
      const max = p.maxBytes ?? (await import('../source-units/continuation')).probeMaxBytes();
      if (!bytes) {
        ex = { method: 'NONE', status: 'FAILED', pageCount: null, pagesWithText: 0, pagesWithoutText: [], truncated: false,
          truncationReason: null, fullText: null, pages: [], error: 'fichier original illisible (téléchargement impossible)', durationMs: 0 };
      } else if (bytes.length > max) {
        ex = { method: 'NONE', status: 'FAILED', pageCount: null, pagesWithText: 0, pagesWithoutText: [], truncated: true,
          truncationReason: `fichier de ${bytes.length} octets au-delà de la borne de lecture (${max} octets)`, fullText: null, pages: [],
          error: 'fichier trop volumineux pour la lecture déterministe (lecture par le modèle seule)', durationMs: 0 };
      } else {
        ex = await extractRawText({ bytes, mimeType: p.mimeType }, rawExtractLimits());
      }
    }

    const [ecrit] = (await pgClient.unsafe(
      `INSERT INTO document_raw_extracts (account_id, file_id, source_ref, source_sha256, source_bytes, mime_type, method, extractor_version,
         extraction_status, page_count, pages_with_text, pages_without_text, truncated, truncation_reason, full_text, full_text_chars,
         full_text_sha256, pages, extraction_error, extraction_ms, extracted_at, reuse_count, last_job_id,
         structuring_status, structuring_error_code, structuring_error, structuring_at, persistence_status, persistence_error, persistence_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::int[], $13, $14, $15, $16, $17, $18::jsonb, $19, $20, NOW(), 0, $21,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT (file_id) DO UPDATE SET
         account_id = EXCLUDED.account_id, source_ref = EXCLUDED.source_ref, source_sha256 = EXCLUDED.source_sha256,
         source_bytes = EXCLUDED.source_bytes, mime_type = EXCLUDED.mime_type, method = EXCLUDED.method,
         extractor_version = EXCLUDED.extractor_version, extraction_status = EXCLUDED.extraction_status,
         page_count = EXCLUDED.page_count, pages_with_text = EXCLUDED.pages_with_text, pages_without_text = EXCLUDED.pages_without_text,
         truncated = EXCLUDED.truncated, truncation_reason = EXCLUDED.truncation_reason, full_text = EXCLUDED.full_text,
         full_text_chars = EXCLUDED.full_text_chars, full_text_sha256 = EXCLUDED.full_text_sha256, pages = EXCLUDED.pages,
         extraction_error = EXCLUDED.extraction_error, extraction_ms = EXCLUDED.extraction_ms, extracted_at = NOW(),
         reuse_count = 0, last_job_id = EXCLUDED.last_job_id, updated_at = NOW()
       RETURNING ${COLS}`,
      [p.accountId, p.fileId, ref, bytes ? sha(bytes) : null, bytes ? bytes.length : null, p.mimeType, ex.method, RAW_EXTRACTOR_VERSION,
        ex.status, ex.pageCount, ex.pagesWithText, ex.pagesWithoutText, ex.truncated, ex.truncationReason, ex.fullText,
        ex.fullText?.length ?? 0, ex.fullText != null ? sha(ex.fullText) : null, JSON.stringify(ex.pages), ex.error, ex.durationMs,
        p.jobId ?? null] as never[],
    )) as unknown as Row[];
    return ecrit ? summary(ecrit, false) : null;
  } catch (e) {
    console.error(`[t1-raw-extract] extract brut du fichier ${p.fileId} non écrit :`, (e as Error).message);
    return null;
  }
}

/** Code et étape d'une erreur de structuration (passerelle, master). */
function errorCodeOf(e: unknown): string | null {
  const x = e as { lastFailureCode?: unknown; code?: unknown } | null;
  const c = x?.lastFailureCode ?? x?.code;
  return typeof c === 'string' ? c : null;
}

async function update(fileIds: readonly number[], accountId: number, set: string, params: unknown[]): Promise<void> {
  if (fileIds.length === 0) return;
  try {
    if (!(await rawExtractsReady())) return;
    await pgClient.unsafe(
      `UPDATE document_raw_extracts SET ${set}, updated_at = NOW() WHERE file_id = ANY($1::int[]) AND account_id = $2`,
      [fileIds, accountId, ...params] as never[],
    );
  } catch (e) {
    console.error('[t1-raw-extract] état de phase non écrit :', (e as Error).message);
  }
}

/** Structuration : RUNNING au départ (persistance remise à zéro), puis SUCCEEDED / FAILED. */
export async function markStructuring(fileIds: readonly number[], accountId: number, status: 'RUNNING' | 'SUCCEEDED' | 'FAILED', error?: unknown): Promise<void> {
  const message = error == null ? null : safeMessage(error instanceof Error ? error.message : String(error));
  await update(fileIds, accountId,
    `structuring_status = $3, structuring_error_code = $4, structuring_error = $5, structuring_at = NOW()${status === 'RUNNING' ? ', persistence_status = NULL, persistence_error = NULL, persistence_at = NULL' : ''}`,
    [status, error == null ? null : errorCodeOf(error), message]);
}

/** Persistance métier : SUCCEEDED, PARTIAL (étapes secondaires) ou FAILED (étapes bloquantes). */
export async function markPersistence(fileIds: readonly number[], accountId: number, status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED', error?: string | null): Promise<void> {
  await update(fileIds, accountId, `persistence_status = $3, persistence_error = $4, persistence_at = NOW()`, [status, error ? safeMessage(error) : null]);
}

/** Étapes d'écriture BLOQUANTES (données métier) et SECONDAIRES (rattachements). */
export const PERSISTENCE_BLOCKING_STEPS = ['ANALYSIS_RUN', 'KNOWLEDGE', 'EVIDENCE', 'RULES'] as const;
export const PERSISTENCE_SECONDARY_STEPS = ['LINKS', 'PRIMARY_ASSET'] as const;

/** État de la persistance déduit des étapes du rapport (pur). */
export function persistenceOutcome(steps: ReadonlyArray<{ step: string; status: string; error?: string | null }>): { status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'; error: string | null } {
  const failed = (names: readonly string[]) => steps.filter((s) => s.status === 'FAILED' && names.includes(s.step));
  const bloquantes = failed(PERSISTENCE_BLOCKING_STEPS);
  if (bloquantes.length) return { status: 'FAILED', error: bloquantes.map((s) => `${s.step} : ${s.error ?? 'échec'}`).join(' · ') };
  const secondaires = failed(PERSISTENCE_SECONDARY_STEPS);
  if (secondaires.length) return { status: 'PARTIAL', error: secondaires.map((s) => `${s.step} : ${s.error ?? 'échec'}`).join(' · ') };
  return { status: 'SUCCEEDED', error: null };
}
