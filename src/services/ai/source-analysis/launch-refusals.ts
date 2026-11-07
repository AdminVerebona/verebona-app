/**
 * Journal des refus de lancement d'une analyse depuis le tiroir — lot 113U
 * (carte #720). Table `document_analysis_launch_refusals` (migration 1550).
 *
 * `recordLaunchRefusal` NE LÈVE JAMAIS : le journal observe une réponse, il
 * ne doit pas la faire échouer (table absente avant la migration, base
 * momentanément injoignable…). Aucun texte libre n'est écrit : codes, états,
 * identifiants, statut HTTP et origine du client seulement.
 */
import {
  launchCategoryOf, normalizeLaunchCode, parseIncidentRef, isInformativeLaunchCategory,
  type LaunchCategory, type LaunchOrigin,
} from '@/lib/ai/analysis-launch';

export const LAUNCH_REFUSAL_TABLE = 'document_analysis_launch_refusals';

/** Rétention par défaut (jours), surchargée par ANALYSIS_LAUNCH_REFUSAL_RETENTION_DAYS. */
export const LAUNCH_REFUSAL_RETENTION_DAYS_DEFAULT = 180;

/** Clés de `detail` admises (codes / états seulement, valeurs bornées). */
const DETAIL_KEYS = ['userMessageCode', 'retryScheduled', 'jobStatus', 'stage', 'reason', 'clientPhase', 'sessionCode', 'attempt'] as const;

export interface LaunchRefusalInput {
  incidentRef: string;
  source: 'server' | 'client';
  code: string;
  httpStatus?: number | null;
  assetFileId?: number | null;
  accountId?: number | null;
  userId?: number | null;
  client?: LaunchOrigin | null;
  appVersion?: string | null;
  processingStatus?: string | null;
  nextAttemptAt?: string | Date | null;
  detail?: Partial<Record<(typeof DETAIL_KEYS)[number], unknown>>;
}

export interface LaunchRefusalRow {
  incidentRef: string;
  source: 'server' | 'client';
  code: string;
  category: LaunchCategory;
  level: 'info' | 'error';
  httpStatus: number | null;
  assetFileId: number | null;
  accountId: number | null;
  userId: number | null;
  client: LaunchOrigin | null;
  appVersion: string | null;
  processingStatus: string | null;
  nextAttemptAt: string | null;
  detail: Record<string, string | number | boolean>;
}

const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31 ? v : null);
const shortCode = (v: unknown): string | null => {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null;
};

/** Ligne normalisée (pure) : rien d'arbitraire n'atteint la base. */
export function normalizeLaunchRefusal(input: LaunchRefusalInput): LaunchRefusalRow | null {
  const incidentRef = parseIncidentRef(input.incidentRef);
  if (!incidentRef) return null;
  const code = normalizeLaunchCode(input.code) || 'UNKNOWN_CODE';
  const httpStatus = typeof input.httpStatus === 'number' && input.httpStatus >= 100 && input.httpStatus <= 599 ? input.httpStatus : null;
  const category = launchCategoryOf(code, httpStatus);
  const detail: Record<string, string | number | boolean> = {};
  for (const k of DETAIL_KEYS) {
    const v = input.detail?.[k];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) detail[k] = v;
    else { const s = shortCode(v); if (s) detail[k] = s; }
  }
  const next = input.nextAttemptAt instanceof Date ? input.nextAttemptAt : (typeof input.nextAttemptAt === 'string' ? new Date(input.nextAttemptAt) : null);
  const client = input.client && ['WEB', 'PWA', 'IOS', 'ANDROID'].includes(input.client) ? input.client : null;
  const appVersion = typeof input.appVersion === 'string' && /^[0-9A-Za-z.+() -]{1,32}$/.test(input.appVersion) ? input.appVersion : null;
  return {
    incidentRef, source: input.source === 'client' ? 'client' : 'server', code, category,
    level: isInformativeLaunchCategory(category) ? 'info' : 'error',
    httpStatus, assetFileId: intOrNull(input.assetFileId), accountId: intOrNull(input.accountId), userId: intOrNull(input.userId),
    client, appVersion,
    processingStatus: shortCode(input.processingStatus),
    nextAttemptAt: next && !Number.isNaN(next.getTime()) ? next.toISOString() : null,
    detail,
  };
}

function retentionDays(): number {
  const n = Number(process.env.ANALYSIS_LAUNCH_REFUSAL_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 7 && n <= 3650 ? n : LAUNCH_REFUSAL_RETENTION_DAYS_DEFAULT;
}

/** Écrit le refus (jamais bloquant) ; purge bornée des lignes échues. Rend vrai si la ligne est écrite. */
export async function recordLaunchRefusal(input: LaunchRefusalInput): Promise<boolean> {
  try {
    const row = normalizeLaunchRefusal(input);
    if (!row) return false;
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO ${LAUNCH_REFUSAL_TABLE}
         (incident_ref, source, code, category, level, http_status, asset_file_id, account_id, user_id,
          client, app_version, processing_status, next_attempt_at, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               (SELECT id FROM accounts WHERE id = $8), (SELECT id FROM users WHERE id = $9),
               $10, $11, $12, $13, $14::jsonb)`,
      [row.incidentRef, row.source, row.code, row.category, row.level, row.httpStatus, row.assetFileId, row.accountId, row.userId,
        row.client, row.appVersion, row.processingStatus, row.nextAttemptAt, JSON.stringify(row.detail)] as never[],
    );
    // Journal d'exploitation sans secret (Scalingo) : retrouvable par la référence.
    console.warn(`[analysis.launch] ${JSON.stringify({ ref: row.incidentRef, source: row.source, code: row.code, category: row.category, http: row.httpStatus, file: row.assetFileId, account: row.accountId, client: row.client })}`);
    await pgClient.unsafe(
      `DELETE FROM ${LAUNCH_REFUSAL_TABLE} WHERE id IN (
         SELECT id FROM ${LAUNCH_REFUSAL_TABLE} WHERE created_at < now() - ($1::int * interval '1 day') ORDER BY created_at LIMIT 200)`,
      [retentionDays()] as never[],
    ).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Plafond d'écritures CLIENT par utilisateur et par heure (anti-abus de la route de rapport). */
export const CLIENT_REPORTS_PER_HOUR = 30;

/** L'utilisateur peut-il encore écrire un rapport client cette heure-ci ? (jamais bloquant : vrai en cas de doute). */
export async function clientReportAllowed(userId: number): Promise<boolean> {
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT count(*)::int AS n FROM ${LAUNCH_REFUSAL_TABLE}
        WHERE source = 'client' AND user_id = $1 AND created_at > now() - interval '1 hour'`,
      [userId] as never[],
    )) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0) < CLIENT_REPORTS_PER_HOUR;
  } catch {
    return true;
  }
}

// ── Lecture BO ──────────────────────────────────────────────────────────────

export interface LaunchRefusalListItem extends LaunchRefusalRow {
  id: number;
  createdAt: string;
  /** Métadonnées du document (jamais son nom : CDC BO V1 SEC-001). */
  documentType: string | null;
  fileExtension: string | null;
  uploadedAt: string | null;
  analysisState: string | null;
  accountName: string | null;
  userEmail: string | null;
}

export interface LaunchRefusalFilters {
  incidentRef?: string | null;
  assetFileId?: number | null;
  accountId?: number | null;
  category?: string | null;
  limit?: number;
}

/** Refus récents (BO), filtrés ; `available: false` si la migration 1550 n'est pas appliquée. */
export async function listLaunchRefusals(f: LaunchRefusalFilters): Promise<{ available: boolean; items: LaunchRefusalListItem[] }> {
  const { pgClient } = await import('@/db');
  const where: string[] = [];
  const params: unknown[] = [];
  const ref = parseIncidentRef(f.incidentRef);
  if (f.incidentRef && !ref) return { available: true, items: [] };
  if (ref) { params.push(ref); where.push(`r.incident_ref = $${params.length}`); }
  if (intOrNull(f.assetFileId)) { params.push(f.assetFileId); where.push(`r.asset_file_id = $${params.length}`); }
  if (intOrNull(f.accountId)) { params.push(f.accountId); where.push(`r.account_id = $${params.length}`); }
  if (f.category && /^[A-Z_]{2,32}$/.test(f.category)) { params.push(f.category); where.push(`r.category = $${params.length}`); }
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const [present] = (await pgClient.unsafe(`SELECT to_regclass('public.${LAUNCH_REFUSAL_TABLE}') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
  if (!present?.ok) return { available: false, items: [] };
  const rows = (await pgClient.unsafe(
    `SELECT r.*, coalesce(f.document_type_code, f.document_type) AS document_type, f.file_extension,
            coalesce(f.uploaded_at, f.created_at) AS uploaded_at, f.analysis_state, a.name AS account_name, u.email AS user_email
       FROM ${LAUNCH_REFUSAL_TABLE} r
       LEFT JOIN asset_files f ON f.id = r.asset_file_id
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN users u ON u.id = r.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit}`,
    params as never[],
  )) as unknown as Array<Record<string, unknown>>;
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
  return {
    available: true,
    items: rows.map((r) => ({
      id: Number(r.id), createdAt: iso(r.created_at)!, incidentRef: String(r.incident_ref), source: r.source as 'server' | 'client',
      code: String(r.code), category: String(r.category) as LaunchCategory, level: r.level as 'info' | 'error',
      httpStatus: r.http_status == null ? null : Number(r.http_status), assetFileId: r.asset_file_id == null ? null : Number(r.asset_file_id),
      accountId: r.account_id == null ? null : Number(r.account_id), userId: r.user_id == null ? null : Number(r.user_id),
      client: (r.client as LaunchOrigin | null) ?? null, appVersion: (r.app_version as string | null) ?? null,
      processingStatus: (r.processing_status as string | null) ?? null, nextAttemptAt: iso(r.next_attempt_at),
      detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail ?? {}) as Record<string, string | number | boolean>,
      documentType: (r.document_type as string | null) ?? null, fileExtension: (r.file_extension as string | null) ?? null,
      uploadedAt: iso(r.uploaded_at), analysisState: (r.analysis_state as string | null) ?? null,
      accountName: (r.account_name as string | null) ?? null,
      userEmail: (r.user_email as string | null) ?? null,
    })),
  };
}
