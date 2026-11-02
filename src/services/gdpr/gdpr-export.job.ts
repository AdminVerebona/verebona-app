/**
 * Génération DURABLE de l'archive « Mes données » — lot 103C (ticket P1
 * « Fiabilisation complète de l'export », §3 A, D, E).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA LIGNE `gdpr_exports` EST LE TRAVAIL
 *
 * Avant : la requête POST lançait la génération elle-même, attendait 8 s,
 * puis la laissait continuer « après la réponse » (`after`) dans le même
 * processus. Un redémarrage, un déploiement ou un dépassement mémoire
 * pendant ce temps perdait la génération ; la ligne restait « en cours »
 * jusqu'à ce qu'un balayage la déclare en échec 20 minutes plus tard.
 *
 * Maintenant : le POST enregistre la demande (ligne `pending`) et rend la
 * main. Le worker des exports (`services/exports/v12/generation/worker.ts`,
 * une génération lourde à la fois par instance, démarré au boot) consomme
 * cette file avec les mêmes garanties que `export_generation` — la file IA
 * (`ai_job_queue`) n'est pas utilisée pour les mêmes raisons que les
 * dossiers V12 (types T1-T6, arrêt d'urgence IA, métriques IA) :
 *   · prise atomique `FOR UPDATE SKIP LOCKED` (plusieurs instances) ;
 *   · bail (`locked_by`, `locked_until`) renouvelé par un battement : un
 *     processus arrêté cesse de le renouveler, la génération est REPRISE ;
 *   · tentatives bornées (GDPR_EXPORT_MAX_ATTEMPTS, défaut 4) et délais
 *     croissants (1 min, 5 min, 15 min) ; au-delà, échec explicite avec code
 *     stable (`export-state.ts`) — un export qui fait tomber le processus à
 *     chaque fois (mémoire) finit en GENERATION_INTERRUPTED, sans boucler ;
 *   · reprise idempotente : les parties déjà déposées dont le contenu prévu
 *     n'a pas changé ne sont ni relues ni renvoyées ;
 *   · rattrapage des lignes orphelines de l'ancien code (pending jamais
 *     lancée, generating sans bail) au démarrage et à chaque tour.
 *
 * MÉMOIRE BORNÉE (§3 D)
 *   collecte paginée → fichiers JSON temporaires (une page à la fois) ;
 *   documents copiés du stockage vers le disque en flux (SHA-256 au
 *   passage), une partie à la fois ; ZIP écrit en flux sur disque puis envoyé
 *   en flux ; dossier temporaire supprimé dans tous les cas (`finally`) et
 *   restes d'un processus arrêté nettoyés au tour suivant. Pic mémoire et
 *   durée mesurés et conservés (`summary.metrics`, Supervision).
 *
 * MANIFESTE EXACT (§3 E)
 *   les parties 2..N sont construites d'abord, la partie 1 (données +
 *   manifeste global) en DERNIER : le manifeste décrit les fichiers
 *   réellement placés dans les archives (taille, SHA-256) et l'inventaire
 *   précis des manques. Archive incomplète ⇒ `completeness = 'partial'`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { pgClient } from '@/db';
import { collectUserData } from './export-collector';
import {
  EXCLUDED_TABLES, MISSING_REASON_LABELS, buildFinalManifest, completenessOf, filterRow, finalReadme,
  partManifestFromFiles, planExportParts,
  type ExportPartPlan, type MissingItem, type TableStat, type WrittenDocument,
} from './export-content';
import { maxAttempts, retryDelaySeconds, type GdprExportErrorCode } from './export-state';

type Raw = Record<string, unknown>;

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Durée du bail d'une génération (renouvelé au tiers). */
export const GDPR_LEASE_SECONDS = 120;
/** Délai global d'UNE tentative. */
export const jobTimeoutMs = () => envInt('GDPR_EXPORT_JOB_TIMEOUT_MS', 60 * 60 * 1000);
/** Lot 102C : taille maximale des documents d'une partie. */
export const PART_MAX_BYTES = () => envInt('GDPR_EXPORT_PART_MAX_BYTES', 100 * 1024 * 1024);
export const MAX_PARTS = () => envInt('GDPR_EXPORT_MAX_PARTS', 200);
const RETENTION_HOURS = () => envInt('GDPR_EXPORT_RETENTION_HOURS', 72);
/** Génération SANS bail (ancien code) sans progression depuis ce délai : orpheline. */
const LEGACY_STALE_MINUTES = 20;
const TMP_PREFIX = 'verebona-gdpr-';
/** Dossiers temporaires d'un processus arrêté supprimés au-delà de cet âge. */
const TMP_STALE_MS = 6 * 60 * 60 * 1000;

/* ── Erreurs typées ───────────────────────────────────────────────────── */

class LeaseLostError extends Error { constructor() { super('bail perdu : génération reprise par une autre instance'); this.name = 'LeaseLostError'; } }
class JobTimeoutError extends Error { readonly code = 'GENERATION_TIMEOUT'; constructor() { super('délai global de la tentative dépassé'); this.name = 'JobTimeoutError'; } }
class StageError extends Error {
  constructor(readonly code: GdprExportErrorCode, message: string) { super(message); this.name = 'StageError'; }
}

/** Code stable d'une erreur de génération (pur, exporté pour les tests). */
export function classifyGdprError(e: unknown, step: string | null): GdprExportErrorCode {
  const code = (e as { code?: unknown })?.code;
  if (code === 'GENERATION_TIMEOUT' || code === 'STORAGE_UNAVAILABLE' || code === 'ARCHIVE_FAILED' || code === 'COLLECTION_FAILED') return code;
  if (e instanceof StageError) return e.code;
  if (step === 'collect') return 'COLLECTION_FAILED';
  if (step?.startsWith('archive')) return 'ARCHIVE_FAILED';
  if (step?.startsWith('upload') || step?.startsWith('documents')) return 'STORAGE_UNAVAILABLE';
  return 'GENERATION_FAILED';
}

/* ── File : rattrapage, prise, bail ───────────────────────────────────── */

/**
 * Rattrapage (au démarrage et à chaque tour) :
 *   · bail expiré et tentatives épuisées → échec GENERATION_INTERRUPTED ;
 *   · génération SANS bail (ancien code, processus arrêté) sans progrès
 *     depuis 20 min → remise en file (ou échec si tentatives épuisées).
 * Les `pending` orphelines (POST interrompu après l'insertion, ancien code)
 * n'ont besoin de rien : elles sont prises par `claimNextGdprExport`.
 */
export async function recoverGdprExports(): Promise<{ interrupted: number; requeued: number }> {
  const max = maxAttempts();
  const interrupted = await pgClient<Raw[]>`
    UPDATE gdpr_exports
       SET status = 'error', error_code = 'GENERATION_INTERRUPTED', completed_at = now(),
           error_message = 'exécution interrompue à répétition (arrêt du processus : redémarrage, déploiement ou mémoire)',
           locked_by = NULL, locked_until = NULL
     WHERE status = 'generating'
       AND ((locked_until IS NOT NULL AND locked_until < now())
            OR (locked_by IS NULL AND coalesce(progress_at, started_at, created_at) < now() - make_interval(mins => ${LEGACY_STALE_MINUTES})))
       AND attempt_count >= ${max}
     RETURNING id`;
  const requeued = await pgClient<Raw[]>`
    UPDATE gdpr_exports SET status = 'pending', next_attempt_at = NULL, error_code = 'GENERATION_INTERRUPTED',
           error_message = 'génération sans bail interrompue (ancien processus) : remise en file'
     WHERE status = 'generating' AND locked_by IS NULL
       AND coalesce(progress_at, started_at, created_at) < now() - make_interval(mins => ${LEGACY_STALE_MINUTES})
       AND attempt_count < ${max}
     RETURNING id`;
  for (const r of interrupted) {
    console.error(`[gdpr-export] export #${String(r.id)} : GENERATION_INTERRUPTED (tentatives épuisées)`);
    await syncGdprRegistry(Number(r.id));
  }
  return { interrupted: interrupted.length, requeued: requeued.length };
}

/** Prend la prochaine génération à faire (ou abandonnée, bail expiré). */
export async function claimNextGdprExport(workerId: string, onlyId?: number): Promise<Raw | null> {
  const [row] = await pgClient<Raw[]>`
    WITH pick AS (
      SELECT id FROM gdpr_exports
       WHERE ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
           OR (status = 'generating' AND locked_until IS NOT NULL AND locked_until < now()))
         AND attempt_count < ${maxAttempts()}
         ${onlyId ? pgClient`AND id = ${onlyId}` : pgClient``}
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE gdpr_exports g
       SET status = 'generating', locked_by = ${workerId},
           locked_until = now() + make_interval(secs => ${GDPR_LEASE_SECONDS}),
           started_at = now(), progress_at = now(), attempt_count = g.attempt_count + 1,
           next_attempt_at = NULL, step = 'claimed', notify_on_ready = true,
           correlation_id = coalesce(g.correlation_id, ${randomUUID()})
      FROM pick WHERE g.id = pick.id
    RETURNING g.*`;
  return row ?? null;
}

/** Renouvelle le bail ; `false` si la génération a été reprise ailleurs. */
export async function renewGdprLease(id: number, workerId: string): Promise<boolean> {
  const rows = await pgClient`
    UPDATE gdpr_exports SET locked_until = now() + make_interval(secs => ${GDPR_LEASE_SECONDS}), progress_at = now()
     WHERE id = ${id} AND locked_by = ${workerId} AND status = 'generating' RETURNING id`;
  return rows.length > 0;
}

async function setStep(id: number, workerId: string, step: string): Promise<void> {
  const rows = await pgClient`UPDATE gdpr_exports SET step = ${step}, progress_at = now() WHERE id = ${id} AND locked_by = ${workerId} RETURNING id`;
  if (!rows.length) throw new LeaseLostError();
}

/* ── Registre RGPD (best-effort, dette rejouée) ───────────────────────── */

/**
 * Aligne la demande du registre `gdpr_requests` sur l'état de l'export :
 * rattachement (demande ouverte reprise lors d'une relance, sinon création
 * idempotente par `source_ref`), puis statut (en cours / traitée / erreur).
 * N'échoue jamais : en cas d'erreur, la DETTE est notée sur l'export
 * (`registry_pending`) et rejouée plus tard (`replayGdprRegistryDebt`).
 * La génération n'en dépend jamais.
 */
export async function syncGdprRegistry(exportId: number): Promise<boolean> {
  try {
    const { upsertSystemRequest, updateSystemRequest } = await import('./system-requests');
    const [e] = await pgClient<Raw[]>`SELECT * FROM gdpr_exports WHERE id = ${exportId}`;
    if (!e) return true;
    let requestId = e.request_id == null ? null : Number(e.request_id);
    if (!requestId) {
      const [open] = await pgClient<{ id: number }[]>`
        SELECT r.id FROM gdpr_requests r
         WHERE r.origin = 'system' AND r.status <> 'done' AND r.subject_user_ref = ${Number(e.user_id)}
           AND r.source_ref LIKE 'gdpr_export:%'
         ORDER BY r.id DESC LIMIT 1`;
      requestId = open ? Number(open.id) : await upsertSystemRequest({
        sourceRef: `gdpr_export:${exportId}`,
        rightType: 'access',
        userId: Number(e.user_id),
        accountId: e.account_id == null ? null : Number(e.account_id),
        receivedAt: new Date(e.created_at as string),
        status: 'in_progress',
      });
      if (!requestId) throw new Error('demande du registre non créée');
      await pgClient`UPDATE gdpr_exports SET request_id = ${requestId} WHERE id = ${exportId}`;
    }
    if (e.status === 'ready') {
      const s = (e.summary ?? {}) as Raw;
      const expires = e.expires_at
        ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(new Date(e.expires_at as string))
        : '?';
      const missing = Number(s.missingCount ?? 0);
      await updateSystemRequest({ id: requestId }, {
        status: 'done',
        lastError: null,
        result: `Archive ${e.completeness === 'partial' ? 'PARTIELLE' : 'complète'} générée (${Number(s.tables ?? 0)} catégories, `
          + `${Number(s.rows ?? 0)} enregistrements, ${Number(s.documents ?? 0)} document(s)`
          + `${missing ? `, ${missing} élément(s) non inclus` : ''}${Number(s.parts ?? 1) > 1 ? `, en ${Number(s.parts)} parties` : ''}) `
          + `et mise à disposition jusqu’au ${expires}.`,
      });
    } else if (e.status === 'error') {
      await updateSystemRequest({ id: requestId }, { lastError: `Échec de génération (${String(e.error_code ?? 'GENERATION_FAILED')}, réf. ${String(e.correlation_id ?? '?')}).` });
    } else if (e.status === 'pending' || e.status === 'generating') {
      await updateSystemRequest({ id: requestId }, { lastError: null });
    }
    await pgClient`UPDATE gdpr_exports SET registry_pending = false, registry_error = NULL WHERE id = ${exportId}`;
    return true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    console.error(`[gdpr-export] registre non alimenté pour l’export #${exportId} (dette notée, rejouée) :`, msg);
    await pgClient`UPDATE gdpr_exports SET registry_pending = true, registry_error = ${msg} WHERE id = ${exportId}`.catch(() => undefined);
    return false;
  }
}

/** Rejoue la dette du registre (exports dont la synchronisation a échoué). */
export async function replayGdprRegistryDebt(limit = 50): Promise<{ replayed: number; remaining: number }> {
  const rows = await pgClient<{ id: number }[]>`
    SELECT id FROM gdpr_exports WHERE registry_pending ORDER BY id LIMIT ${limit}`;
  let replayed = 0;
  for (const r of rows) if (await syncGdprRegistry(Number(r.id))) replayed++;
  return { replayed, remaining: rows.length - replayed };
}

/* ── Fichiers temporaires ─────────────────────────────────────────────── */

/** Supprime les dossiers temporaires laissés par un processus arrêté. */
export async function cleanupStaleTempDirs(now = Date.now()): Promise<number> {
  let n = 0;
  try {
    for (const name of await fs.promises.readdir(os.tmpdir())) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const p = path.join(os.tmpdir(), name);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > TMP_STALE_MS) { await fs.promises.rm(p, { recursive: true, force: true }); n++; }
    }
  } catch { /* au mieux */ }
  return n;
}

async function hashFile(p: string): Promise<{ bytes: number; sha256: string }> {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(p)) { h.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { bytes, sha256: h.digest('hex') };
}

/** Données JSON écrites table par table, page par page (mémoire bornée). */
class TableFilesWriter {
  private readonly tables = new Map<string, { file: string; rows: number; omitted: Set<string> }>();
  constructor(private readonly dir: string) {}
  write = async (table: string, rows: Record<string, unknown>[]): Promise<void> => {
    if (EXCLUDED_TABLES.has(table)) return;
    let t = this.tables.get(table);
    const chunks: string[] = [];
    for (const row of rows) {
      const { out, omitted } = filterRow(table, row);
      if (!t) {
        t = { file: path.join(this.dir, `${table}.json`), rows: 0, omitted: new Set() };
        this.tables.set(table, t);
      }
      for (const c of omitted) t.omitted.add(c);
      const text = JSON.stringify(out, null, 2).replace(/\n/g, '\n  ');
      chunks.push(`${t.rows === 0 && chunks.length === 0 ? '[\n  ' : ',\n  '}${text}`);
      t.rows++;
    }
    if (t && chunks.length) await fs.promises.appendFile(t.file, chunks.join(''));
  };
  async close(collected: Array<{ table: string; truncated: boolean; depthLimited: boolean }>): Promise<TableStat[]> {
    const byTable = new Map(collected.map((c) => [c.table, c]));
    const out: TableStat[] = [];
    for (const [table, t] of this.tables) {
      await fs.promises.appendFile(t.file, '\n]\n');
      const h = await hashFile(t.file);
      const c = byTable.get(table);
      out.push({
        table, rows: t.rows, omittedColumns: [...t.omitted],
        file: { path: `donnees/${table}.json`, bytes: h.bytes, sha256: h.sha256 },
        complete: !(c?.truncated || c?.depthLimited),
      });
    }
    return out;
  }
  localPath(table: string): string { return path.join(this.dir, `${table}.json`); }
}

type ZipEntry = { path: string; file: string } | { path: string; text: string };

/** ZIP écrit en flux sur disque (entrées lues en flux) ; taille et SHA-256 du résultat. */
async function writeZip(entries: ZipEntry[], dest: string, date: Date): Promise<{ bytes: number; sha256: string }> {
  try {
    const zip = new JSZip();
    for (const e of entries) {
      if ('file' in e) zip.file(e.path, fs.createReadStream(e.file), { binary: true, date, createFolders: false });
      else zip.file(e.path, e.text, { date, createFolders: false });
    }
    await pipeline(
      zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' }),
      fs.createWriteStream(dest),
    );
  } catch (e) {
    throw new StageError('ARCHIVE_FAILED', `archive non construite : ${(e as Error).message}`);
  }
  return hashFile(dest);
}

/* ── Exécution d'une génération ───────────────────────────────────────── */

export interface GdprJobContext {
  workerId: string;
  /** Faux si le bail a été perdu (reprise par une autre instance) ou délai dépassé. */
  isActive?: () => boolean;
  deadline?: number;
}

export type GdprJobOutcome = 'ready' | 'retry' | 'failed' | 'lost';

interface PartResult { part: number; fileName: string; s3Key: string; bytes: number; sha256: string; files: WrittenDocument[]; missing: MissingItem[] }

const partContentHash = (fileName: string, part: ExportPartPlan) => createHash('sha256')
  .update(JSON.stringify({ fileName, docs: part.documents.map((d) => [d.id, d.s3Key, d.s3Bucket ?? null, d.size ?? null, d.path]) }))
  .digest('hex');

/**
 * Exécute une génération PRISE par `claimNextGdprExport` (statut
 * `generating`, bail détenu par `ctx.workerId`). Toute écriture est
 * conditionnée au bail : une exécution dépossédée n'écrit plus rien.
 */
export async function runGdprExportJob(row: Raw, ctx: GdprJobContext): Promise<GdprJobOutcome> {
  const exportId = Number(row.id);
  const userId = Number(row.user_id);
  const attempt = Number(row.attempt_count ?? 1);
  const corr = String(row.correlation_id ?? '');
  const { workerId } = ctx;
  const deadline = ctx.deadline ?? Date.now() + jobTimeoutMs();
  const startedAt = Date.now();
  const generatedAt = new Date();
  const metrics = { peakRssMb: 0, bytesRead: 0, bytesWritten: 0 };
  const sample = () => { metrics.peakRssMb = Math.max(metrics.peakRssMb, Math.round(process.memoryUsage().rss / 1048576)); };
  const checkpoint = () => {
    sample();
    if (ctx.isActive && !ctx.isActive()) throw new LeaseLostError();
    if (Date.now() > deadline) throw new JobTimeoutError();
  };
  let step = 'claimed';
  const go = async (s: string) => { step = s; checkpoint(); await setStep(exportId, workerId, s); };
  const log = (msg: string) => console.info(`[gdpr-export] export #${exportId} réf=${corr} tentative=${attempt} ${msg}`);

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${TMP_PREFIX}${exportId}-`));
  const uploadedThisRun: string[] = [];
  try {
    const storage = await import('./gdpr-storage');
    log('début');

    // 1. Collecte → fichiers JSON temporaires.
    await go('collect');
    await fs.promises.mkdir(path.join(tmp, 'donnees'));
    const writer = new TableFilesWriter(path.join(tmp, 'donnees'));
    let data: Awaited<ReturnType<typeof collectUserData>>;
    try {
      data = await collectUserData(userId, { onRows: writer.write, checkpoint });
    } catch (e) {
      if (e instanceof LeaseLostError || e instanceof JobTimeoutError) throw e;
      throw new StageError('COLLECTION_FAILED', `collecte impossible : ${(e as Error).message}`);
    }
    const tableStats = await writer.close(data.stats);

    // 2. Plan des parties et manques connus d'avance.
    await go('plan');
    const plan = planExportParts(data.documents, { maxPartBytes: PART_MAX_BYTES(), maxParts: MAX_PARTS() });
    const total = plan.parts.length;
    const day = generatedAt.toISOString().slice(0, 10);
    const fileNameOf = (n: number) => (total === 1
      ? `verebona-mes-donnees-${day}.zip`
      : `verebona-mes-donnees-${day}-partie-${String(n).padStart(String(total).length, '0')}-sur-${total}.zip`);
    const keyOf = (n: number) => `gdpr-exports/${userId}/${exportId}/${fileNameOf(n)}`;
    const missing: MissingItem[] = [];
    for (const s of plan.skipped) if (s.reason === 'PART_LIMIT') missing.push({ kind: 'document', id: s.id, name: s.name, reason: 'PART_LIMIT' });
    const withoutStoredFile = plan.skipped.filter((s) => s.reason === 'NO_STORED_FILE').map((s) => ({ id: s.id, name: s.name }));
    for (const s of data.stats) {
      if (s.truncated) missing.push({ kind: 'table', table: s.table, reason: 'ROW_LIMIT' });
      else if (s.depthLimited) missing.push({ kind: 'table', table: s.table, reason: 'DEPTH_LIMIT' });
    }
    const lastAttempt = attempt >= maxAttempts();
    const existing = new Map((await pgClient<Raw[]>`
      SELECT part_number, s3_key, size_bytes, sha256, content_hash, files, missing FROM gdpr_export_parts WHERE export_id = ${exportId}`)
      .map((p) => [Number(p.part_number), p]));

    /** Copie les documents d'une partie sur disque ; manques notés (ou nouvelle tentative du job). */
    const fetchDocs = async (part: ExportPartPlan, dir: string): Promise<{ files: Array<WrittenDocument & { local: string }>; missing: MissingItem[] }> => {
      await fs.promises.mkdir(dir, { recursive: true });
      const files: Array<WrittenDocument & { local: string }> = [];
      const miss: MissingItem[] = [];
      for (const [i, d] of part.documents.entries()) {
        checkpoint();
        const local = path.join(dir, `${i}.bin`);
        const r = await storage.downloadStoredFileToPath(d.s3Key!, d.s3Bucket, local);
        if (r.ok) {
          metrics.bytesRead += r.bytes;
          files.push({ id: d.id, path: d.path, part: part.number, bytes: r.bytes, sha256: r.sha256, local });
        } else if (r.reason === 'NOT_FOUND') {
          miss.push({ kind: 'document', id: d.id, name: d.path.replace(/^documents\//, ''), reason: 'OBJECT_MISSING' });
        } else if (!lastAttempt) {
          // Stockage momentanément en erreur : nouvelle tentative du job (les parties déjà déposées sont gardées).
          throw new StageError('STORAGE_UNAVAILABLE', `lecture du document ${d.id} impossible (${r.detail})`);
        } else {
          miss.push({ kind: 'document', id: d.id, name: d.path.replace(/^documents\//, ''), reason: 'READ_FAILED' });
        }
      }
      return { files, missing: miss };
    };

    const results = new Map<number, PartResult>();
    const replacedKeys: string[] = [];
    const recordPart = async (r: PartResult, contentHash: string | null) => {
      const prev = existing.get(r.part);
      if (prev?.s3_key && prev.s3_key !== r.s3Key) replacedKeys.push(String(prev.s3_key));
      const rows = await pgClient`
        INSERT INTO gdpr_export_parts (export_id, part_number, s3_key, size_bytes, document_count, missing_count, sha256, content_hash, files, missing)
        SELECT ${exportId}, ${r.part}, ${r.s3Key}, ${r.bytes}, ${r.files.length}, ${r.missing.length}, ${r.sha256}, ${contentHash},
               ${JSON.stringify(r.files)}::jsonb, ${JSON.stringify(r.missing)}::jsonb
         WHERE EXISTS (SELECT 1 FROM gdpr_exports WHERE id = ${exportId} AND locked_by = ${workerId})
        ON CONFLICT (export_id, part_number) DO UPDATE
           SET s3_key = EXCLUDED.s3_key, size_bytes = EXCLUDED.size_bytes, document_count = EXCLUDED.document_count,
               missing_count = EXCLUDED.missing_count, sha256 = EXCLUDED.sha256, content_hash = EXCLUDED.content_hash,
               files = EXCLUDED.files, missing = EXCLUDED.missing
        RETURNING id`;
      if (!rows.length) throw new LeaseLostError();
      results.set(r.part, r);
    };
    const upload = async (local: string, key: string) => {
      await storage.uploadFileFromPath(local, key, 'application/zip');
      uploadedThisRun.push(key);
    };

    // 3. Parties N..2 (documents seulement) — reprises si déjà déposées à l'identique.
    for (const part of [...plan.parts].reverse()) {
      if (part.number === 1) continue;
      const fileName = fileNameOf(part.number);
      const key = keyOf(part.number);
      const contentHash = partContentHash(fileName, part);
      const prev = existing.get(part.number);
      if (prev?.s3_key === key && prev.content_hash === contentHash && Array.isArray(prev.files)) {
        results.set(part.number, {
          part: part.number, fileName, s3Key: key, bytes: Number(prev.size_bytes ?? 0), sha256: String(prev.sha256 ?? ''),
          files: prev.files as WrittenDocument[], missing: (prev.missing ?? []) as MissingItem[],
        });
        log(`partie ${part.number}/${total} reprise (déjà déposée)`);
        continue;
      }
      await go(`documents:${part.number}`);
      const dir = path.join(tmp, `p${part.number}`);
      const { files, missing: miss } = await fetchDocs(part, dir);
      await go(`archive:${part.number}`);
      const zipPath = path.join(tmp, fileName);
      const z = await writeZip([
        { path: `manifest-partie-${part.number}.json`, text: partManifestFromFiles({ generatedAt, part: part.number, totalParts: total, files, missing: miss }) },
        ...files.map((f) => ({ path: f.path, file: f.local })),
      ], zipPath, generatedAt);
      await go(`upload:${part.number}`);
      await upload(zipPath, key);
      metrics.bytesWritten += z.bytes;
      await recordPart({ part: part.number, fileName, s3Key: key, bytes: z.bytes, sha256: z.sha256, files: files.map(({ local: _l, ...f }) => f), missing: miss }, contentHash);
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.rm(zipPath, { force: true });
    }

    // 4. Partie 1 en dernier : données, manifeste global exact, LISEZ-MOI.
    const part1 = plan.parts[0];
    await go('documents:1');
    const p1 = await fetchDocs(part1, path.join(tmp, 'p1'));
    const allMissing = [...missing, ...[...results.values()].flatMap((r) => r.missing), ...p1.missing];
    const p1Files: WrittenDocument[] = p1.files.map(({ local: _l, ...f }) => f);
    const partsForManifest = [
      { part: 1, fileName: fileNameOf(1), files: p1Files },
      ...[...results.values()].map((r) => ({ part: r.part, fileName: r.fileName, files: r.files })),
    ];
    const manifest = buildFinalManifest({
      generatedAt, userId, accountIds: data.accountIds, tables: tableStats, excludedTables: [...EXCLUDED_TABLES],
      expectedDocuments: data.documents.length, documents: partsForManifest.flatMap((p) => p.files),
      withoutStoredFile, missing: allMissing, parts: partsForManifest,
    });
    await go('archive:1');
    const entries: ZipEntry[] = [
      { path: 'manifest.json', text: JSON.stringify(manifest, null, 2) },
      { path: 'LISEZ-MOI.txt', text: finalReadme(manifest) },
      { path: 'manifest-partie-1.json', text: partManifestFromFiles({ generatedAt, part: 1, totalParts: total, files: p1Files, missing: p1.missing }) },
      ...tableStats.filter((t) => t.file).map((t) => ({ path: t.file!.path, file: writer.localPath(t.table) })),
      ...p1.files.map((f) => ({ path: f.path, file: f.local })),
    ];
    const docMissing = allMissing.filter((m): m is Extract<MissingItem, { kind: 'document' }> => m.kind === 'document');
    if (docMissing.length) {
      entries.push({
        path: 'documents/NON-RECUPERES.txt',
        text: 'Documents qui n’ont pas pu être joints à cette archive (identifiant, nom, motif) :\n'
          + docMissing.map((m) => ` - ${m.id} « ${m.name} » : ${MISSING_REASON_LABELS[m.reason]}`).join('\n') + '\n',
      });
    }
    const zip1 = path.join(tmp, fileNameOf(1));
    const z1 = await writeZip(entries, zip1, generatedAt);
    await go('upload:1');
    await upload(zip1, keyOf(1));
    metrics.bytesWritten += z1.bytes;
    await recordPart({ part: 1, fileName: fileNameOf(1), s3Key: keyOf(1), bytes: z1.bytes, sha256: z1.sha256, files: p1Files, missing: p1.missing }, null);

    // 5. Parties d'une tentative précédente qui ne font plus partie de l'archive.
    const stale = await pgClient<Raw[]>`
      DELETE FROM gdpr_export_parts WHERE export_id = ${exportId} AND part_number > ${total} RETURNING s3_key`;
    const keep = new Set([...results.values()].map((r) => r.s3Key).concat(keyOf(1)));
    for (const k of [...replacedKeys, ...stale.map((s) => String(s.s3_key ?? ''))]) {
      if (k && !keep.has(k)) await storage.deleteStoredFile(k);
    }

    // 6. Prêt — conditionné au bail.
    await go('finalize');
    const completeness = completenessOf(allMissing);
    const tablesWritten = tableStats.filter((t) => t.file);
    const totalBytes = z1.bytes + [...results.values()].reduce((n, r) => n + r.bytes, 0);
    sample();
    const summary = {
      tables: tablesWritten.length,
      rows: tablesWritten.reduce((n, t) => n + t.rows, 0),
      documents: partsForManifest.reduce((n, p) => n + p.files.length, 0),
      documentsExpected: data.documents.length,
      documentsWithoutStoredFile: withoutStoredFile.length,
      documentsSkipped: docMissing.length,
      missingCount: allMissing.length,
      missing: allMissing.slice(0, 100),
      parts: total,
      metrics: { attempt, durationMs: Date.now() - startedAt, peakRssMb: metrics.peakRssMb, bytesRead: metrics.bytesRead, bytesWritten: metrics.bytesWritten },
    };
    const ready = await pgClient<Raw[]>`
      UPDATE gdpr_exports
         SET status = 'ready', completeness = ${completeness}, s3_key = ${keyOf(1)}, size_bytes = ${totalBytes}, parts_count = ${total},
             summary = ${JSON.stringify(summary)}::jsonb, error_message = NULL, error_code = NULL, step = 'done',
             completed_at = now(), progress_at = now(), locked_by = NULL, locked_until = NULL, next_attempt_at = NULL,
             expires_at = now() + make_interval(hours => ${RETENTION_HOURS()})
       WHERE id = ${exportId} AND locked_by = ${workerId}
       RETURNING id`;
    if (!ready.length) throw new LeaseLostError();
    log(`prête (${completeness}, ${total} partie(s), ${summary.documents}/${summary.documentsExpected} document(s), ${summary.missingCount} manque(s), ${summary.metrics.durationMs} ms, pic ${metrics.peakRssMb} Mo)`);
    await syncGdprRegistry(exportId);
    const { notifyGdprExportIfDue } = await import('./gdpr-export.service');
    await notifyGdprExportIfDue(exportId);
    return 'ready';
  } catch (e) {
    if (e instanceof LeaseLostError) {
      console.warn(`[gdpr-export] export #${exportId} réf=${corr} : ${e.message} — aucune écriture.`);
      // Export disparu entre-temps (compte supprimé) : les objets déposés par cette exécution ne sont rattachés à rien.
      const [still] = await pgClient<Raw[]>`SELECT id FROM gdpr_exports WHERE id = ${exportId}`.catch(() => [{ id: exportId }] as Raw[]);
      if (!still && uploadedThisRun.length) {
        const storage = await import('./gdpr-storage').catch(() => null);
        if (storage) for (const k of uploadedThisRun) await storage.deleteStoredFile(k);
      }
      return 'lost';
    }
    const code = classifyGdprError(e, step);
    const message = String((e as Error)?.message ?? e).slice(0, 2000);
    sample();
    const lastAttemptMetrics = { attempt, step, code, durationMs: Date.now() - startedAt, peakRssMb: metrics.peakRssMb, at: new Date().toISOString() };
    if (attempt < maxAttempts()) {
      const delay = retryDelaySeconds(attempt);
      console.error(`[gdpr-export] export #${exportId} réf=${corr} tentative=${attempt} étape=${step} code=${code} : ${message} — nouvelle tentative dans ${delay} s.`);
      const rows = await pgClient`
        UPDATE gdpr_exports SET status = 'pending', next_attempt_at = now() + make_interval(secs => ${delay}),
               error_code = ${code}, error_message = ${message}, locked_by = NULL, locked_until = NULL,
               summary = coalesce(summary, '{}'::jsonb) || ${JSON.stringify({ lastAttempt: lastAttemptMetrics })}::jsonb
         WHERE id = ${exportId} AND locked_by = ${workerId} RETURNING id`.catch(() => []);
      return rows.length ? 'retry' : 'lost';
    }
    console.error(`[gdpr-export] export #${exportId} réf=${corr} en échec définitif (tentative ${attempt}, étape ${step}, code ${code}) : ${message}`);
    const rows = await pgClient`
      UPDATE gdpr_exports SET status = 'error', error_code = ${code}, error_message = ${message}, completed_at = now(),
             locked_by = NULL, locked_until = NULL,
             summary = coalesce(summary, '{}'::jsonb) || ${JSON.stringify({ lastAttempt: lastAttemptMetrics })}::jsonb
       WHERE id = ${exportId} AND locked_by = ${workerId} RETURNING id`.catch(() => []);
    if (!rows.length) return 'lost';
    await syncGdprRegistry(exportId);
    // Objets déposés (cette exécution et les précédentes) sans archive prête : supprimés.
    const storage = await import('./gdpr-storage').catch(() => null);
    const partKeys = (await pgClient<Raw[]>`SELECT s3_key FROM gdpr_export_parts WHERE export_id = ${exportId} AND s3_key IS NOT NULL`
      .catch(() => [] as Raw[])).map((p) => String(p.s3_key));
    let allDeleted = true;
    if (storage) for (const k of new Set([...uploadedThisRun, ...partKeys])) allDeleted = (await storage.deleteStoredFile(k)) && allDeleted;
    if (allDeleted) await pgClient`UPDATE gdpr_export_parts SET s3_key = NULL WHERE export_id = ${exportId}`.catch(() => undefined);
    return 'failed';
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ── Boucle (appelée par le worker des exports) ───────────────────────── */

let lastMaintenanceAt = 0;
const MAINTENANCE_EVERY_MS = 60_000;

/** Rattrapage, dette du registre et temporaires — au plus une fois par minute et par instance. */
export async function gdprExportMaintenance(force = false): Promise<void> {
  if (!force && Date.now() - lastMaintenanceAt < MAINTENANCE_EVERY_MS) return;
  lastMaintenanceAt = Date.now();
  await recoverGdprExports().catch((e) => console.error('[gdpr-export] rattrapage impossible :', (e as Error).message));
  await replayGdprRegistryDebt().catch((e) => console.error('[gdpr-export] dette du registre non rejouée :', (e as Error).message));
  await cleanupStaleTempDirs();
}

/**
 * Traite au plus `maxJobs` générations (une à la fois). Battement de bail,
 * délai global par tentative ; au-delà, l'exécution est abandonnée (elle
 * n'écrit plus rien) et la génération est remise en file / close.
 */
export async function drainGdprExportQueue(workerId: string, opts: { maxJobs?: number; onlyId?: number } = {}): Promise<number> {
  await gdprExportMaintenance(opts.onlyId != null);
  let done = 0;
  const maxJobs = opts.maxJobs ?? 1;
  while (done < maxJobs) {
    const row = await claimNextGdprExport(workerId, opts.onlyId);
    if (!row) break;
    const id = Number(row.id);
    let active = true;
    const timeoutMs = jobTimeoutMs();
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - startedAt > timeoutMs + 60_000) { active = false; clearInterval(heartbeat); return; }
      void renewGdprLease(id, workerId).then((ok) => { if (!ok) active = false; }).catch(() => undefined);
    }, Math.max(5_000, (GDPR_LEASE_SECONDS * 1000) / 3));
    heartbeat.unref?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = runGdprExportJob(row, { workerId, isActive: () => active, deadline: startedAt + timeoutMs })
        .catch((e) => { console.error(`[gdpr-export] export #${id} : erreur inattendue du worker :`, (e as Error).message); return 'failed' as const; });
      const outcome = await Promise.race([
        run,
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs + 30_000); timer.unref?.(); }),
      ]);
      if (outcome === 'timeout') {
        // L'exécution bloquée ne pourra plus écrire (bail rendu) ; la ligne est remise en file ou close.
        active = false;
        await pgClient`
          UPDATE gdpr_exports SET status = CASE WHEN attempt_count < ${maxAttempts()} THEN 'pending' ELSE 'error' END,
                 next_attempt_at = CASE WHEN attempt_count < ${maxAttempts()} THEN now() + make_interval(secs => ${retryDelaySeconds(Number(row.attempt_count))}) ELSE NULL END,
                 completed_at = CASE WHEN attempt_count < ${maxAttempts()} THEN NULL ELSE now() END,
                 error_code = 'GENERATION_TIMEOUT', error_message = 'délai global de la tentative dépassé', locked_by = NULL, locked_until = NULL
           WHERE id = ${id} AND locked_by = ${workerId}`.catch(() => undefined);
        await syncGdprRegistry(id);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
    done++;
  }
  return done;
}
