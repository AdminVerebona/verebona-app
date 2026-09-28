/**
 * Statuts d'une génération et représentation exposée par l'API (historique,
 * suivi, téléchargement) — CDC V12 §2.1, §16.2, §17, §18.
 *
 * Statuts stockés : queued, generating, ready, partial, failed, expired,
 * deleted (+ pending / error / cancelled des générations antérieures).
 * Correspondance §2.1 : running = generating ; success_pdf / success_zip =
 * ready + `outputFormat` ; partial_success = partial ; file_deleted = deleted.
 *
 * L'API renvoie `generationStatus` (V12) ET `status` compatible avec
 * l'interface historique (pending / generating / ready / error / deleted /
 * expired) le temps de livrer l'écran de préparation.
 */

import { normalizeExportCode } from '@/services/exports/catalog';
import { EXPORT_ERROR_MESSAGES, safeExportErrorMessage } from '@/services/exports/export-errors';

export const GENERATION_STATUSES = ['queued', 'generating', 'ready', 'partial', 'failed', 'expired', 'deleted'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const PARTIAL_MESSAGE = 'Le dossier a été généré, mais certains fichiers n’ont pas pu être intégrés.'; // MSG-PREP-007

/** Statut V12 d'une ligne (anciennes valeurs comprises ; expiration constatée à la lecture). */
export function normalizeGenerationStatus(status: string, expiresAt?: Date | string | null, now: Date = new Date()): GenerationStatus {
  const s = status === 'pending' ? 'queued' : status === 'error' || status === 'cancelled' ? 'failed' : status;
  if ((s === 'ready' || s === 'partial') && expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return 'expired';
  return (GENERATION_STATUSES as readonly string[]).includes(s) ? (s as GenerationStatus) : 'failed';
}

/** Statut lu par l'interface historique (`AssetExportsTab`). */
export function legacyStatus(s: GenerationStatus): string {
  switch (s) {
    case 'queued': return 'pending';
    case 'partial': return 'ready';
    case 'failed': return 'error';
    default: return s;
  }
}

export const isDownloadable = (s: GenerationStatus): boolean => s === 'ready' || s === 'partial';

/** Clés de stockage d'une génération (`output_payload`, format historique compris). */
export function outputKeys(outputPayload: string | null | undefined): { pdf: string | null; zip: string | null; pdfSize: number | null; zipSize: number | null } {
  try {
    const o = outputPayload ? JSON.parse(outputPayload) as Record<string, unknown> : {};
    const k = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    return { pdf: k(o.pdfS3Key), zip: k(o.zipS3Key), pdfSize: n(o.pdfSize), zipSize: n(o.zipSize) };
  } catch {
    return { pdf: null, zip: null, pdfSize: null, zipSize: null };
  }
}

export interface GenerationRowLike {
  id: number;
  publicId: string;
  exportType: string;
  variant?: string | null;
  status: string;
  requestedOutputs?: string | null;
  outputPayload?: string | null;
  errorPayload?: string | null;
  errorCode?: string | null;
  outputFormat?: string | null;
  expiresAt?: Date | string | null;
  deletedAt?: Date | string | null;
  metricsJson?: Record<string, unknown> | null;
  templateVersion?: string | null;
  userId: number;
  createdAt: Date | string;
  completedAt?: Date | string | null;
  generationAttemptCount?: number;
}

/** URL de téléchargement (endpoint qui revérifie les droits, DRH-010). */
export const downloadPath = (publicId: string, file: 'pdf' | 'zip') => `/api/export-generations/${publicId}/download?file=${file}`;

export function toGenerationDto(row: GenerationRowLike, opts: { authorName?: string | null; now?: Date } = {}) {
  const generationStatus = normalizeGenerationStatus(row.status, row.expiresAt, opts.now);
  const keys = outputKeys(row.outputPayload);
  const downloadable = isDownloadable(generationStatus);
  const metrics = (row.metricsJson ?? {}) as Record<string, unknown>;
  const code = normalizeExportCode(row.exportType);
  const errorMessage = generationStatus === 'failed'
    ? (row.errorCode && row.errorCode in EXPORT_ERROR_MESSAGES
      ? EXPORT_ERROR_MESSAGES[row.errorCode as keyof typeof EXPORT_ERROR_MESSAGES]
      : safeExportErrorMessage(row.errorPayload) ?? EXPORT_ERROR_MESSAGES.GENERATION_FAILED)
    : null;
  let requestedOutputs: string[] = ['PDF'];
  try { if (row.requestedOutputs) requestedOutputs = JSON.parse(row.requestedOutputs); } catch { /* ancien format */ }
  return {
    id: row.id,
    publicId: row.publicId,
    exportType: code ?? row.exportType,
    variant: row.variant ?? null,
    status: legacyStatus(generationStatus),
    generationStatus,
    outputFormat: row.outputFormat ?? (keys.zip ? 'ZIP' : 'PDF'),
    requestedOutputs,
    errorCode: generationStatus === 'failed' ? row.errorCode ?? 'GENERATION_FAILED' : null,
    errorMessage,
    // DRH-008 : seul l'état partiel est signalé dans l'historique.
    partialMessage: generationStatus === 'partial' ? PARTIAL_MESSAGE : null,
    excludedCount: generationStatus === 'partial' ? Number(metrics['items.excluded_count'] ?? 0) || null : null,
    pageCount: typeof metrics['generation.pdf_pages'] === 'number' ? metrics['generation.pdf_pages'] : null,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
    expiresAt: row.expiresAt ?? null,
    // DRH-003 : générateur affiché (nom, à défaut identifiant).
    createdBy: { userId: row.userId, name: opts.authorName ?? null },
    generationAttemptCount: row.generationAttemptCount ?? 0,
    downloadUrl: downloadable && keys.pdf ? downloadPath(row.publicId, 'pdf') : null,
    downloadZipUrl: downloadable && keys.zip ? downloadPath(row.publicId, 'zip') : null,
    pollUrl: `/api/export-generations/${row.publicId}`,
  };
}

export type GenerationDto = ReturnType<typeof toGenerationDto>;
