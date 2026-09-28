/**
 * Documents d'un compte : MÉTADONNÉES uniquement — CDC Back-Office V1
 * ACC-D07, ACC-D08, SEC-001, SEC-002, REC-ACC-07.
 *
 * Jamais de contenu, de lien de téléchargement, de clé de stockage, de texte
 * extrait ni de nom de fichier (susceptible de contenir des données
 * personnelles) : identifiant interne, type, taille, dates, bien rattaché,
 * statut de traitement, erreur technique, échéances liées. Les exports et
 * transmissions du compte sont listés à part (ACC-D08), sans lien de
 * téléchargement.
 */
import { pgClient } from '@/db';
import type { PageResult } from './list-params';

export const DOCUMENT_PAGE_SIZE = 25;
export const DOCUMENT_SORTS = ['uploaded', 'size', 'type', 'asset', 'status'] as const;
export type DocumentSort = (typeof DOCUMENT_SORTS)[number];

export type ProcessingStatus =
  | 'uploading'
  | 'upload_failed'
  | 'stored'
  | 'analyzing'
  | 'analyzed'
  | 'validation_required'
  | 'conflict'
  | 'analysis_failed';

export const PROCESSING_LABELS: Record<ProcessingStatus, string> = {
  uploading: 'Dépôt en cours',
  upload_failed: 'Échec du dépôt',
  stored: 'Déposé',
  analyzing: 'Analyse en cours',
  analyzed: 'Analysé',
  validation_required: 'Validation requise',
  conflict: 'Conflit détecté',
  analysis_failed: 'Échec de l’analyse',
};

/** Statut de traitement consolidé (dépôt puis analyse). */
export function documentProcessingStatus(uploadStatus: string | null, analysisState: string | null): ProcessingStatus {
  const up = (uploadStatus ?? 'COMPLETED').toUpperCase();
  if (up === 'FAILED' || up === 'ERROR') return 'upload_failed';
  if (up === 'PENDING' || up === 'UPLOADING') return 'uploading';
  switch ((analysisState ?? '').toUpperCase()) {
    case 'UPLOADING': return 'uploading';
    case 'ANALYZING': return 'analyzing';
    case 'ANALYZED': return 'analyzed';
    case 'VALIDATION_REQUIRED': return 'validation_required';
    case 'CONFLICT_DETECTED': return 'conflict';
    case 'ANALYSIS_FAILED': return 'analysis_failed';
    default: return 'stored';
  }
}

/** Erreur technique résumée : une ligne, 160 caractères au plus (COM-015 : liste synthétique). */
export function summarizeTechnicalError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = raw.split('\n')[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

const ORDER_SQL: Record<DocumentSort, string> = {
  uploaded: `coalesce(f.uploaded_at, f.created_at)`,
  size: `f.size`,
  type: `lower(coalesce(f.document_type_code, f.document_type))`,
  asset: `lower(a.name)`,
  status: `f.analysis_state`,
};

export interface AccountDocumentMeta {
  id: number;
  type: string | null;
  extension: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
  documentDate: string | null;
  asset: { id: number; name: string } | null;
  status: ProcessingStatus;
  statusLabel: string;
  error: string | null;
  linkedDeadlines: number;
}

type Row = Record<string, unknown>;

export async function loadAccountDocuments(
  accountId: number,
  opts: { page: number; sort: DocumentSort; dir: 'asc' | 'desc' },
): Promise<PageResult<AccountDocumentMeta>> {
  const [countRow] = await pgClient.unsafe<{ n: string }[]>(
    `SELECT count(*) AS n FROM asset_files f
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.is_web_link = false AND f.grouped_into_file_id IS NULL`,
    [accountId],
  );
  const total = Number(countRow?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / DOCUMENT_PAGE_SIZE));
  const page = Math.min(Math.max(1, opts.page), totalPages);
  const d = opts.dir === 'asc' ? 'ASC' : 'DESC';

  const rows = await pgClient.unsafe<Row[]>(
    `SELECT f.id, coalesce(f.document_type_code, f.document_type) AS type, f.file_extension, f.size,
            coalesce(f.uploaded_at, f.created_at) AS uploaded_at, f.document_date,
            f.upload_status, f.analysis_state, f.analysis_fail_reason,
            a.id AS asset_id, a.name AS asset_name,
            (SELECT count(*) FROM agenda_file_links l WHERE l.asset_file_id = f.id) AS linked_deadlines
       FROM asset_files f
       LEFT JOIN assets a ON a.id = coalesce(f.asset_id, f.linked_asset_id)
      WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.is_web_link = false AND f.grouped_into_file_id IS NULL
      ORDER BY ${ORDER_SQL[opts.sort]} ${d} NULLS LAST, f.id ${d}
      LIMIT $2 OFFSET $3`,
    [accountId, DOCUMENT_PAGE_SIZE, (page - 1) * DOCUMENT_PAGE_SIZE],
  );

  return {
    items: rows.map((r) => {
      const status = documentProcessingStatus(r.upload_status as string | null, r.analysis_state as string | null);
      return {
        id: Number(r.id),
        type: (r.type as string) ?? null,
        extension: (r.file_extension as string) ?? null,
        sizeBytes: r.size == null ? null : Number(r.size),
        uploadedAt: r.uploaded_at ? new Date(r.uploaded_at as string).toISOString() : null,
        documentDate: (r.document_date as string) ?? null,
        asset: r.asset_id ? { id: Number(r.asset_id), name: String(r.asset_name ?? '') } : null,
        status,
        statusLabel: PROCESSING_LABELS[status],
        error: status === 'analysis_failed' || status === 'upload_failed' ? summarizeTechnicalError(r.analysis_fail_reason as string | null) : null,
        linkedDeadlines: Number(r.linked_deadlines ?? 0),
      };
    }),
    page,
    pageSize: DOCUMENT_PAGE_SIZE,
    total,
    totalPages,
  };
}

export interface AccountExportMeta {
  kind: 'export' | 'transmission';
  at: string;
  assetName: string | null;
  type: string;
  status: string;
  error: string | null;
}

const EXPORT_STATUS: Record<string, string> = {
  queued: 'En attente',
  pending: 'En attente',
  generating: 'En cours',
  ready: 'Prêt',
  partial: 'Prêt (partiel)',
  failed: 'En erreur',
  error: 'En erreur',
  expired: 'Expiré',
  deleted: 'Supprimé',
  cancelled: 'Annulé',
};
const TRANSMISSION_STATUS: Record<string, string> = {
  pending: 'En attente',
  accepted: 'Acceptée',
  refused: 'Refusée',
  cancelled: 'Annulée',
};

/** ACC-D08 : exports et transmissions du compte (50 derniers), sans lien. */
export async function loadAccountExports(accountId: number): Promise<AccountExportMeta[]> {
  const [exportsRows, transmissionRows] = await Promise.all([
    pgClient.unsafe<Row[]>(
      `SELECT e.created_at, e.export_type, e.status, e.error_payload, a.name AS asset_name
         FROM export_generation e LEFT JOIN assets a ON a.id = e.asset_id
        WHERE e.account_id = $1 ORDER BY e.created_at DESC LIMIT 50`,
      [accountId],
    ),
    pgClient.unsafe<Row[]>(
      `SELECT t.sent_at, t.created_at, t.status, a.name AS asset_name
         FROM asset_transmissions t LEFT JOIN assets a ON a.id = t.asset_id
        WHERE t.account_id = $1 ORDER BY t.created_at DESC LIMIT 50`,
      [accountId],
    ),
  ]);
  const out: AccountExportMeta[] = [];
  for (const r of exportsRows) {
    let error: string | null = null;
    if (r.status === 'error' && r.error_payload) {
      try {
        error = summarizeTechnicalError(JSON.parse(String(r.error_payload))?.message ?? null);
      } catch {
        error = 'Erreur de génération';
      }
    }
    out.push({
      kind: 'export',
      at: new Date(r.created_at as string).toISOString(),
      assetName: (r.asset_name as string) ?? null,
      type: String(r.export_type),
      status: EXPORT_STATUS[String(r.status)] ?? String(r.status),
      error,
    });
  }
  for (const r of transmissionRows) {
    out.push({
      kind: 'transmission',
      at: new Date((r.sent_at ?? r.created_at) as string).toISOString(),
      assetName: (r.asset_name as string) ?? null,
      type: 'Transmission de bien',
      status: TRANSMISSION_STATUS[String(r.status)] ?? String(r.status),
      error: null,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
}
