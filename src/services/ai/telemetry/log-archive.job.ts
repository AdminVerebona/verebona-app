/**
 * Archivage S3 des logs IA de plus de 90 jours — CDC BO IA WF-25, WF-45,
 * LOG-UI-09.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST ARCHIVÉ, ET COMMENT
 *
 * `ai_usage_event` (appels modèles) et `ai_pipeline_step` (étapes) sont
 * découpés par JOUR calendaire (UTC), sérialisés en NDJSON compressé, déposés
 * sur S3 (client existant `lib/s3-client`), enregistrés dans
 * `ai_log_archives` (clé, nombre de lignes, bornes d'id, SHA-256 — WF-25
 * étape 160) puis retirés de la base (étape 158 : plus de recherche directe
 * BO). La restauration est technique, hors parcours V1 (étape 161) : il
 * suffit de relire l'objet S3.
 *
 * Avant suppression, les appels sont résumés dans `ai_usage_daily_rollup` :
 * l'écran Coûts reste exact au-delà de 90 jours sans relire l'archive.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 88 JOURS COMPLETS, PAS 90 GLISSANTS
 *
 * La purge de l'assistant (`purge-assistant-logs.job`) supprime les étapes
 * de plus de 90 jours GLISSANTS (fenêtre 5 h – 8 h). L'archivage prend les
 * journées ENTIÈRES antérieures à J-88 : une ligne purgée le jour D (plus de
 * 90 jours à D 5 h) était déjà antérieure à la coupure de D-1 (D 0 h - 89 j),
 * donc archivée la veille — quel que soit l'ordre des deux tâches le jour D.
 * Deux jours trop tôt plutôt qu'une trace perdue.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WF-45 : AUCUN CONTENU T2 DANS L'ARCHIVE
 *
 * Le contenu conversationnel T2 est purgé à 3 mois et ne doit pas survivre
 * dans une archive. Les tables archivées ne portent pas les messages ; les
 * seuls champs susceptibles d'en contenir un fragment (aperçu de sortie,
 * message d'erreur d'un appel de l'assistant, métadonnées libres) sont
 * retirés AVANT sérialisation (`sanitizeForArchive`).
 */
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { pgClient } from '@/db';

type Row = Record<string, unknown>;

/**
 * `home_mascot_generations` : journal T6 de la mascotte d'accueil (CDC
 * Mascotte LOG-006 — « la rétention des logs T6 suit la politique du BO
 * IA »). Même horizon, même registre ; entrée et sortie T6 (données métier
 * du compte) ne sont pas archivées (`sanitizeForArchive`).
 */
export const ARCHIVED_TABLES = ['ai_usage_event', 'ai_pipeline_step', 'home_mascot_generations'] as const;
export type ArchivedTable = (typeof ARCHIVED_TABLES)[number];

const T2_USE_CASE = 'INTELLIGENT_ASSISTANT';

/** Âge (jours complets) au-delà duquel une journée est archivée. */
export function archiveAfterDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AI_LOG_ARCHIVE_AFTER_DAYS);
  return Number.isInteger(n) && n > 0 ? n : 88;
}

/** Dépôt d'archive — S3 en production, injectable en test. */
export interface ArchiveStore {
  put(key: string, body: Buffer): Promise<void>;
}

let injectedStore: ArchiveStore | null = null;

/** Remplace le dépôt S3 — réservé aux tests. */
export function setArchiveStore(store: ArchiveStore | null): void {
  injectedStore = store;
}

async function s3Store(): Promise<ArchiveStore> {
  // Import dynamique : `lib/s3-client` lève au chargement si la configuration
  // S3 est absente ; seul l'archivage doit alors échouer, pas l'application.
  const [{ s3Client, S3_BUCKET }, { PutObjectCommand }] = await Promise.all([
    import('@/lib/s3-client'),
    import('@aws-sdk/client-s3'),
  ]);
  return {
    async put(key, body) {
      await s3Client.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: key, Body: body,
        ContentType: 'application/x-ndjson', ContentEncoding: 'gzip',
      }));
    },
  };
}

/**
 * Retire ce qui pourrait porter du contenu conversationnel (WF-45). Pure.
 *
 * · `ai_pipeline_step.output_preview` : jamais archivé (déjà expurgé à
 *   30 jours par la purge ; retiré ici quoi qu'il arrive).
 * · appels de l'assistant (T2) : message d'erreur retiré — un fournisseur
 *   cite volontiers le texte reçu ; métadonnées réduites à la trace, à la
 *   version de prompt et au tarif figé.
 */
export function sanitizeForArchive(table: ArchivedTable, row: Row): Row {
  const out: Row = { ...row };
  if (table === 'home_mascot_generations') {
    // LOG-005/LOG-006 : le contexte transmis à T6 et le texte produit restent
    // en base le temps de la rétention BO IA, jamais dans l'archive.
    out.input_json = null;
    out.output_json = null;
    return out;
  }
  const isT2 = row.use_case_code === T2_USE_CASE;
  if (table === 'ai_pipeline_step') {
    out.output_preview = null;
    if (isT2) out.error_message = null;
  } else {
    if (isT2) out.error_message = null;
    const meta = (row.metadata ?? null) as Record<string, unknown> | null;
    if (meta && typeof meta === 'object') {
      out.metadata = isT2
        ? { traceId: meta.traceId ?? null, promptVersion: meta.promptVersion ?? null, pricing: meta.pricing ?? null }
        : meta;
    }
  }
  return out;
}

export function archiveKey(environment: string, table: ArchivedTable, day: string, part: number): string {
  return `ai-logs/${environment}/${table}/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}-part-${String(part).padStart(3, '0')}.ndjson.gz`;
}

export function toNdjsonGzip(rows: Row[]): Buffer {
  const text = rows.map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).join('\n');
  return gzipSync(Buffer.from(text + (rows.length ? '\n' : ''), 'utf8'));
}

export interface ArchiveReport {
  archives: number;
  rowsArchived: Record<ArchivedTable, number>;
  days: string[];
  durationMs: number;
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/**
 * Archive les journées échues. Borné (`maxDays` journées par table et par
 * passage, `chunk` lignes par objet) : un premier passage sur un historique
 * ancien se répartit sur plusieurs nuits au lieu de bloquer la base.
 */
export async function archiveAiLogs(opts: { maxDays?: number; chunk?: number; store?: ArchiveStore } = {}): Promise<ArchiveReport> {
  const started = Date.now();
  const maxDays = opts.maxDays ?? 14;
  const chunk = opts.chunk ?? 5_000;
  const store = opts.store ?? injectedStore ?? await s3Store();
  const { getAiEnvironment } = await import('../config/environment');
  const environment = getAiEnvironment();
  const after = archiveAfterDays();

  const report: ArchiveReport = {
    archives: 0,
    rowsArchived: { ai_usage_event: 0, ai_pipeline_step: 0, home_mascot_generations: 0 },
    days: [],
    durationMs: 0,
  };

  for (const table of ARCHIVED_TABLES) {
    const days = (await pgClient.unsafe(
      `SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d
         FROM ${table}
        WHERE created_at < (date_trunc('day', NOW() AT TIME ZONE 'UTC') - make_interval(days => $1::int)) AT TIME ZONE 'UTC'
        ORDER BY d LIMIT ${Math.max(1, maxDays)}`,
      [after] as never[],
    )) as unknown as Row[];

    for (const d of days) {
      const day = iso(d.d);
      if (!report.days.includes(day)) report.days.push(day);
      // Boucle par paquets : chaque paquet archivé est supprimé, le suivant
      // relit la tête de la journée.
      for (;;) {
        const rows = (await pgClient.unsafe(
          `SELECT * FROM ${table}
            WHERE created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
              AND created_at <  ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
            ORDER BY id LIMIT ${chunk}`,
          [day] as never[],
        )) as unknown as Row[];
        if (rows.length === 0) break;

        const [p] = (await pgClient.unsafe(
          `SELECT COALESCE(MAX(part) + 1, 0)::int AS part FROM ai_log_archives
            WHERE source_table = $1 AND period_day = $2::date`,
          [table, day] as never[],
        )) as unknown as Row[];
        const part = Number(p?.part ?? 0);

        const body = toNdjsonGzip(rows.map((r) => sanitizeForArchive(table, r)));
        const sha256 = createHash('sha256').update(body).digest('hex');
        const key = archiveKey(environment, table, day, part);
        // 1. Dépôt d'abord : une suppression ne précède jamais une archive.
        await store.put(key, body);

        const ids = rows.map((r) => Number(r.id));
        // 2. Registre, agrégats et retrait, atomiquement.
        await pgClient.begin(async (tx) => {
          const t = tx as unknown as { unsafe: (q: string, p?: never[]) => Promise<unknown> };
          await t.unsafe(
            `INSERT INTO ai_log_archives
               (source_table, period_day, part, s3_key, row_count, min_id, max_id, bytes, sha256, t2_content_excluded, environment)
             VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, TRUE, $10)
             ON CONFLICT (source_table, period_day, part) DO NOTHING`,
            [table, day, part, key, rows.length, Math.min(...ids), Math.max(...ids), body.length, sha256, environment] as never[],
          );
          if (table === 'ai_usage_event') {
            await t.unsafe(
              `INSERT INTO ai_usage_daily_rollup
                 (day, use_case_code, account_id, config_version_id, model, model_rank, is_billable,
                  calls, failed_calls, unpriced_calls, input_tokens, output_tokens, cost_micros)
               SELECT $2::date, use_case_code, account_id, config_version_id, model, model_rank, is_billable,
                      COUNT(*)::int,
                      COUNT(*) FILTER (WHERE status = 'error')::int,
                      COUNT(*) FILTER (WHERE cost_micros IS NULL OR (cost_micros = 0 AND COALESCE(input_tokens, 0) > 0))::int,
                      COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost_micros), 0)
                 FROM ai_usage_event WHERE id = ANY($1::int[])
                GROUP BY use_case_code, account_id, config_version_id, model, model_rank, is_billable`,
              [ids, day] as never[],
            );
          }
          // bigint[] : `home_mascot_generations.id` est un BIGSERIAL.
          await t.unsafe(`DELETE FROM ${table} WHERE id = ANY($1::bigint[])`, [ids] as never[]);
        });

        report.archives += 1;
        report.rowsArchived[table] += rows.length;
        if (rows.length < chunk) break;
      }
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}

export interface ArchiveListItem {
  id: number;
  sourceTable: string;
  periodDay: string;
  part: number;
  s3Key: string;
  rowCount: number;
  bytes: number;
  sha256: string;
  t2ContentExcluded: boolean;
  createdAt: string;
}

/**
 * Statut des archives (LOG-UI-09) : liste des objets, jamais leur contenu —
 * l'archive n'est pas interrogeable depuis le BO en V1.
 */
export async function listAiLogArchives(limit = 60): Promise<{ items: ArchiveListItem[]; totals: { archives: number; rows: number; bytes: number; oldestDay: string | null; newestDay: string | null } }> {
  const lim = Math.min(Math.max(limit, 1), 200);
  const [rows, totals] = await Promise.all([
    pgClient.unsafe(
      `SELECT id, source_table, period_day, part, s3_key, row_count, bytes, sha256, t2_content_excluded, created_at
         FROM ai_log_archives ORDER BY period_day DESC, source_table, part DESC LIMIT ${lim}`,
    ),
    pgClient.unsafe(
      `SELECT COUNT(*)::int AS archives, COALESCE(SUM(row_count), 0)::bigint AS rows,
              COALESCE(SUM(bytes), 0)::bigint AS bytes, MIN(period_day) AS oldest, MAX(period_day) AS newest
         FROM ai_log_archives`,
    ),
  ]);
  const t = (totals as unknown as Row[])[0] ?? {};
  return {
    items: (rows as unknown as Row[]).map((r) => ({
      id: Number(r.id),
      sourceTable: String(r.source_table),
      periodDay: iso(r.period_day),
      part: Number(r.part),
      s3Key: String(r.s3_key),
      rowCount: Number(r.row_count),
      bytes: Number(r.bytes),
      sha256: String(r.sha256),
      t2ContentExcluded: Boolean(r.t2_content_excluded),
      createdAt: new Date(String(r.created_at)).toISOString(),
    })),
    totals: {
      archives: Number(t.archives ?? 0),
      rows: Number(t.rows ?? 0),
      bytes: Number(t.bytes ?? 0),
      oldestDay: t.oldest ? iso(t.oldest) : null,
      newestDay: t.newest ? iso(t.newest) : null,
    },
  };
}
