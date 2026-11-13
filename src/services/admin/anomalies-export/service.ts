/**
 * Lot 113AI (Trello #733) — lecture des anomalies de Supervision pour la
 * copie et l'export (serveur uniquement). Formatage : `./model.ts` (pur).
 *
 * EXPORT COMPLET EN FLUX : la liste filtrée ENTIÈRE (pas la page affichée)
 * est lue par un curseur PostgreSQL (`DECLARE … CURSOR` / `FETCH n`) dans
 * une transaction REPEATABLE READ READ ONLY : mémoire bornée à un lot, ordre
 * strictement identique à l'écran (même clause `anomalyOrderBy`), total
 * compté dans le MÊME instantané (total = lignes écrites, sauf interruption
 * déclarée dans le fichier). Le flux est tiré par le client (contre-pression
 * naturelle de `ReadableStream.pull`) ; départ du client, erreur ou délai
 * maximal → curseur fermé, connexion rendue, issue signalée (`onDone`).
 *
 * COPIE DE LA PAGE : mêmes lignes que l'écran (`listAnomalies`, même tri et
 * même page), reformatées sans donnée personnelle.
 */
import { pgClient } from '@/db';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { anomalyOrderBy, domainLabel, getAnomaly, listAnomalies } from '@/services/admin/anomaly.service';
import {
  ANOMALY_CSV_HEADER, ANOMALY_EXPORT_MAX_OCCURRENCES, anomalyCsvLine, anomalyJsonHead, anomalyJsonItem, anomalyJsonTail,
  formatAnomalyListMarkdown, formatAnomalyMarkdown, toConflictsExport, toExportRecord,
  type AnomalyExportQuery, type AnomalyExportRecord, type AnomalyExportSource, type ExportMeta,
} from './model';

/** Lignes lues par FETCH (mémoire bornée). */
export const ANOMALY_EXPORT_BATCH = 500;
/** Délai par requête de lecture. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** Durée maximale d'un export (client qui ne lit plus) : la connexion est rendue. */
const EXPORT_MAX_MS = 10 * 60_000;

type Status = AnomalyExportQuery['status'];

interface RawRow {
  id: number; domain: string; fingerprint: string; title: string; status: Status; account_id: number | null; user_id: number | null;
  occurrence_count: number; first_seen_at: Date; last_seen_at: Date; resolved_at: Date | null; resolution_source: 'manual' | 'auto' | null;
  cause: string | null; corrective_action: string | null; auto_resolution_origin: string | null; auto_resolution_cause: string | null;
  previous_anomaly_id: number | null; technical_detail: Record<string, unknown> | null;
}

function fromRaw(r: RawRow): AnomalyExportSource {
  return {
    id: Number(r.id), domain: r.domain, domainLabel: domainLabel(r.domain), fingerprint: r.fingerprint, title: r.title, status: r.status,
    accountId: r.account_id, userId: r.user_id, occurrenceCount: Number(r.occurrence_count), firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at, resolvedAt: r.resolved_at, resolutionSource: r.resolution_source, cause: r.cause,
    correctiveAction: r.corrective_action, autoResolutionOrigin: r.auto_resolution_origin, autoResolutionCause: r.auto_resolution_cause,
    previousAnomalyId: r.previous_anomaly_id, technicalDetail: r.technical_detail,
  };
}

/** Colonnes exportées : ni nom de compte, ni e-mail (les jointures ne servent qu'au tri de l'écran). */
const EXPORT_SELECT = `
  SELECT an.id, an.domain, an.fingerprint, an.title, an.status, an.account_id, an.user_id, an.occurrence_count,
         an.first_seen_at, an.last_seen_at, an.resolved_at, an.resolution_source, an.cause, an.corrective_action,
         an.auto_resolution_origin, an.auto_resolution_cause, an.previous_anomaly_id, an.technical_detail
    FROM admin_anomalies an
    LEFT JOIN accounts acc ON acc.id = an.account_id
    LEFT JOIN users u ON u.id = an.user_id
   WHERE an.status = $1`;

export function exportMeta(q: Pick<AnomalyExportQuery, 'status' | 'sort' | 'dir'>, baseUrl: string, now: Date = new Date()): ExportMeta {
  const b = getBuildIdentity();
  return { generatedAt: now, filters: { status: q.status, sort: q.sort, dir: q.dir }, build: { version: b.version, commit: b.commit }, baseUrl };
}

async function fingerprints(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await pgClient.unsafe(`SELECT id, fingerprint FROM admin_anomalies WHERE id = ANY($1::int[])`, [ids] as never[]);
  return new Map((rows as unknown as Array<{ id: number; fingerprint: string }>).map((r) => [Number(r.id), r.fingerprint]));
}

/** Copie de la page affichée (mêmes lignes que l'écran). */
export async function copyAnomalyPage(q: AnomalyExportQuery, baseUrl: string): Promise<{ text: string; count: number; total: number }> {
  const list = await listAnomalies({ status: q.status, sort: q.sort, dir: q.dir, page: q.page });
  const fp = await fingerprints(list.items.map((i) => i.id));
  const records = list.items.map((i) => toExportRecord({
    id: i.id, domain: i.domain, domainLabel: i.domainLabel, fingerprint: fp.get(i.id) ?? '', title: i.title, status: q.status,
    accountId: i.accountId, userId: i.userId, occurrenceCount: i.occurrenceCount, firstSeenAt: i.firstSeenAt, lastSeenAt: i.lastSeenAt,
    resolvedAt: i.resolvedAt, resolutionSource: i.resolutionSource, cause: i.cause, correctiveAction: i.correctiveAction,
    autoResolutionOrigin: i.autoResolutionOrigin, autoResolutionCause: i.autoResolutionCause, previousAnomalyId: i.previousAnomalyId,
    technicalDetail: i.technicalDetail,
  }, baseUrl));
  const meta = { ...exportMeta(q, baseUrl), page: list.page, pageSize: list.pageSize, total: list.total };
  return { text: formatAnomalyListMarkdown(records, meta), count: records.length, total: list.total };
}

/** Une anomalie (avec ses occurrences les plus récentes) ; null si inconnue. */
export async function anomalyRecord(id: number, baseUrl: string): Promise<AnomalyExportRecord | null> {
  const a = await getAnomaly(id);
  if (!a) return null;
  const fp = await fingerprints([id]);
  const rec = toExportRecord({
    id: a.id, domain: a.domain, domainLabel: a.domainLabel, fingerprint: fp.get(id) ?? '', title: a.title, status: a.status,
    accountId: a.accountId, userId: a.userId, occurrenceCount: a.occurrenceCount, firstSeenAt: a.firstSeenAt, lastSeenAt: a.lastSeenAt,
    resolvedAt: a.resolvedAt, resolutionSource: a.resolutionSource, cause: a.cause, correctiveAction: a.correctiveAction,
    autoResolutionOrigin: a.autoResolutionOrigin, autoResolutionCause: a.autoResolutionCause, previousAnomalyId: a.previousAnomalyId,
    technicalDetail: a.technicalDetail,
  }, baseUrl, a.occurrences.slice(0, ANOMALY_EXPORT_MAX_OCCURRENCES));
  // Lot 113AQ (#751) : contradictions d'attributs — même diagnostic que l'écran, borné, lecture seule.
  const { isAttributeConflictAnomaly } = await import('@/services/admin/anomaly-conflicts');
  if (isAttributeConflictAnomaly(a)) {
    try {
      const { readConflictDiagnostic } = await import('@/services/business-operations/diagnostics/attribute-conflicts-read');
      const { CONFLICT_DIAGNOSTIC_EXPORT_MAX } = await import('@/services/business-operations/diagnostics/attribute-conflicts-model');
      const d = await readConflictDiagnostic({
        pageSize: CONFLICT_DIAGNOSTIC_EXPORT_MAX, occurrences: a.occurrences, occurrenceCount: a.occurrenceCount, anomalyStatus: a.status,
      });
      rec.conflitsAttributs = toConflictsExport(d);
    } catch (e) {
      rec.conflitsAttributs = toConflictsExport(null, (e as Error)?.message ?? String(e));
    }
  }
  return rec;
}

export function anomalyMarkdown(r: AnomalyExportRecord, baseUrl: string): string {
  return formatAnomalyMarkdown(r, exportMeta({ status: r.statut === 'ouverte' ? 'open' : 'resolved', sort: 'date', dir: 'desc' }, baseUrl));
}

// ── Export complet en flux ──────────────────────────────────────────────────

export interface ExportOutcome { exported: number; total: number; complete: boolean; error: string | null; bytes: number }

interface StreamOptions {
  baseUrl: string;
  batchSize?: number;
  /** Fin du flux (complet, interrompu ou en échec) — journal d'audit. Ne doit pas lever. */
  onDone?: (o: ExportOutcome) => void | Promise<void>;
  /** Tests : nombre de FETCH exécutés. */
  onBatch?: (rows: number) => void;
}

/**
 * Ouvre l'instantané, compte, déclare le curseur, et rend le corps de
 * réponse (JSON ou CSV) produit lot par lot. Lève si l'ouverture échoue
 * (connexion rendue) : la route répond alors une erreur claire.
 */
export async function openAnomalyExportStream(
  q: AnomalyExportQuery & { format: 'json' | 'csv' },
  opts: StreamOptions,
): Promise<{ total: number; snapshotAt: Date; body: ReadableStream<Uint8Array> }> {
  const batch = Math.max(1, Math.min(5000, Math.floor(opts.batchSize ?? ANOMALY_EXPORT_BATCH)));
  const orderBy = anomalyOrderBy(q.status, q.sort, q.dir);
  const conn = await pgClient.reserve();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await conn.unsafe('ROLLBACK'); } catch { /* transaction déjà close */ }
    conn.release();
  };
  let total = 0;
  let snapshotAt = new Date();
  try {
    await conn.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await conn.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const [c] = await conn.unsafe(`SELECT count(*)::int AS n, now() AS at FROM admin_anomalies WHERE status = $1`, [q.status]) as unknown as Array<{ n: number; at: Date }>;
    total = Number(c?.n ?? 0);
    snapshotAt = new Date(c?.at ?? Date.now());
    await conn.unsafe(`DECLARE vb_anomaly_export NO SCROLL CURSOR FOR ${EXPORT_SELECT} ORDER BY ${orderBy}`, [q.status]);
  } catch (e) {
    await close();
    throw e;
  }

  const meta = { ...exportMeta(q, opts.baseUrl), total, snapshotAt };
  const enc = new TextEncoder();
  let exported = 0;
  let bytes = 0;
  let finished = false;
  const finish = async (error: string | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    await close();
    try { await opts.onDone?.({ exported, total, complete: error === null && exported === total, error, bytes }); } catch { /* audit : ne lève pas */ }
  };
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const timer = setTimeout(() => {
    void finish('EXPORT_TIMEOUT');
    try { ctrl?.error(new Error('EXPORT_TIMEOUT')); } catch { /* déjà fermé */ }
  }, EXPORT_MAX_MS);
  (timer as { unref?: () => void }).unref?.();
  const push = (c: ReadableStreamDefaultController<Uint8Array>, s: string) => { const b = enc.encode(s); bytes += b.length; c.enqueue(b); };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      push(c, q.format === 'json' ? anomalyJsonHead(meta) : ANOMALY_CSV_HEADER);
    },
    async pull(c) {
      if (finished) return;
      try {
        const rows = await conn.unsafe(`FETCH ${batch} FROM vb_anomaly_export`) as unknown as RawRow[];
        if (finished) return; // client parti ou délai dépassé pendant la lecture
        opts.onBatch?.(rows.length);
        if (rows.length === 0) {
          if (q.format === 'json') push(c, anomalyJsonTail(exported, total));
          await finish(null);
          c.close();
          return;
        }
        let chunk = '';
        for (const r of rows) {
          const rec = toExportRecord(fromRaw(r), opts.baseUrl);
          chunk += q.format === 'json' ? anomalyJsonItem(rec, exported) : anomalyCsvLine(rec);
          exported++;
        }
        push(c, chunk);
      } catch (e) {
        const code = (e as { code?: string })?.code;
        console.error('[admin/anomalies/export] lecture :', (e as Error)?.message ?? e);
        await finish(code === '57014' ? 'READ_TIMEOUT' : 'READ_FAILED');
        // Réponse tronquée signalée comme erreur réseau : jamais un fichier « complet ».
        c.error(e instanceof Error ? e : new Error(String(e)));
      }
    },
    async cancel() {
      await finish('CLIENT_ABORTED');
    },
  });
  return { total, snapshotAt, body };
}
