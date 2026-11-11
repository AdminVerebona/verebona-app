/**
 * Lot 107G — EXÉCUTION d'un diagnostic durable (serveur uniquement, appelé
 * par le worker `worker.ts`, jamais par une requête HTTP).
 *
 * MÊME MOTEUR que toujours (`planDiagnostic` / `engine.ts`, lot 91A) : le plan
 * est établi dans UNE session REPEATABLE READ READ ONLY, puis chaque fichier
 * est produit À LA DEMANDE et écrit — compressé gzip, en flux, à mémoire
 * bornée (`openGzipUpload`, celui de la sauvegarde et de l'export de recette)
 * — sous `admin-exports/diagnostics/<travail>/a<tentative>/<chemin>.gz`.
 * Aucune archive n'est construite en mémoire. Lot 113Q : le ZIP DÉFINITIF
 * est assemblé UNE fois après validation (étape ASSEMBLAGE_ZIP, copie des
 * flux compressés sans recompression, `archive.ts`), stocké, relu et vérifié
 * intégralement (étape VERIFICATION_ZIP) avant publication ; le
 * téléchargement sert cet objet tel quel.
 *
 * JAMAIS DE FAUX COMPLETE : avant publication, VALIDATION — chaque fichier du
 * plan est stocké (présence et taille vérifiées dans le stockage), l'empreinte
 * SHA-256 du contenu écrit est identique à celle du manifeste, l'index
 * d'intégrité (`integrite.json`, `SHA256SUMS.txt`) couvre tous les fichiers ;
 * sinon FAILED (VALIDATION_FAILED), fichiers supprimés.
 *
 * REPRISE : un instantané PostgreSQL ne survit pas à l'arrêt du processus qui
 * le tient. Une reprise est donc une NOUVELLE tentative complète, sur un
 * NOUVEL instantané cohérent (jamais un mélange de deux instantanés) ; les
 * fichiers d'une tentative interrompue sont supprimés au début de la suivante.
 *
 * GARDES : délai global, annulation, bail perdu, mémoire (seuil de garde) —
 * vérifiés entre deux fichiers ET à chaque écriture (une grande table ne
 * retarde pas l'arrêt).
 *
 * Lot 111C — ARRÊT COOPÉRATIF (remplacement d'une demande globale,
 * annulation) : l'annulation est lue en base toutes les
 * DIAG_JOB_CANCEL_POLL_MS (3 s) sans attendre le renouvellement du bail ; la
 * requête SQL en cours de l'instantané est interrompue (`pg_cancel_backend`
 * sur la connexion réservée de la session) ; l'écriture suivante (extraction,
 * envoi) s'arrête ; l'envoi en plusieurs parties ouvert est abandonné,
 * l'instantané fermé (ROLLBACK), les fichiers de la tentative et les envois
 * OVH incomplets supprimés, le bail libéré, puis CANCELLED (motif stable,
 * référence de la remplaçante). Aucun fichier temporaire local : tout est
 * compressé en flux vers le stockage. Une annulation l'emporte sur l'erreur
 * qu'elle provoque (requête interrompue ≠ délai SQL dépassé). La publication
 * vérifie atomiquement bail + statut + absence d'annulation.
 */
import { readContainerMemory } from '@/lib/runtime/memory-monitor';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  DIAG_JOB_PREFIX, DiagJobError, classifyDiagJobError, diagJobSettings, isTransientError, memoryGuardMb, phaseOfPath, sanitizeErrorMessage,
  type DiagJobErrorCode, type DiagJobPhase, type DiagJobProgress, type DiagJobStatus,
} from './state';
import {
  DiagLeaseLostError, failDiagnosticAttempt, publishDiagnosticJob, readDiagnosticControl, saveDiagnosticTimings, setDiagnosticPhase, type DiagJobRow,
} from './repository';
import type { DiagLane } from './state';
import { createMemoryRecorder, createPhaseProfiler, diagMetrics, memPoint, type DiagMemPoint } from './metrics';

export interface DiagStorage { client: Pick<S3Client, 'send'>; bucket: string }

export interface DiagRunContext {
  workerId: string;
  /** Bail toujours détenu ? (renouvellement par le worker). */
  isActive: () => boolean;
  /** Annulation demandée (lue au renouvellement du bail). */
  cancelRequested: () => boolean;
  /** Échéance absolue de la tentative (ms). */
  deadline: number;
  /** Progression partagée (lue par le renouvellement du bail). */
  progress: DiagJobProgress;
  storage?: DiagStorage;
  /** Tests : lignes par partie / par lot. */
  partRows?: number;
  batchRows?: number;
  /** Tests : mesure mémoire imposée (Mo). */
  rssMb?: () => number;
  /** Lot 111C : lecture de l'annulation (ms) ; défaut DIAG_JOB_CANCEL_POLL_MS. */
  cancelPollMs?: number;
  /** Lot 111Q : voie qui exécute (journaux, profilage). */
  lane?: DiagLane;
}

/** Fichier stocké d'une tentative. */
export interface StoredFile { path: string; key: string; bytes: number; compressedBytes: number; sha256: string }

/** Index d'intégrité stocké (`integrite.json`). */
export interface DiagStoredIndex {
  schema: 'verebona.bo.diagnostic-integrite/1';
  jobId: string;
  attempt: number;
  generatedAt: string;
  snapshot: { at: string | null; snapshot: string | null };
  status: 'COMPLETE' | 'PARTIAL';
  fileName: string;
  files: Array<{ path: string; bytes: number; compressedBytes: number; sha256: string }>;
}

/** Erreur d'écriture : nommée `SinkError` pour que le moteur l'interrompe sans la confondre avec une erreur de données. */
class SinkAbort extends Error {
  constructor(readonly diagCode: DiagJobErrorCode, message: string) { super(message); this.name = 'SinkError'; }
}

const MB = 1024 * 1024;
/** Lot 111Q : intervalle minimal entre deux mesures mémoire pendant l'écriture d'un fichier (ms). */
export const MEMORY_SAMPLE_MS = 200;

/**
 * Limite mémoire du conteneur, en Mo ; null si inconnue. Lot 109H : lecture
 * partagée (`lib/runtime/memory-monitor`) — `CONTAINER_MEMORY` posée par
 * Scalingo d'abord, puis cgroup v2 et v1 (comme avant).
 */
export function containerMemoryLimitMb(): number | null {
  return readContainerMemory().containerLimitMb;
}

/**
 * Mesure mémoire du processus, reportée dans la progression (pic compris).
 * Lot 113Q : aussi la mémoire native (`external`) et les ArrayBuffer — les
 * tampons de compression et d'envoi n'apparaissent pas dans le tas V8 —, et
 * la mémoire du conteneur quand `container` est demandé (lecture du cgroup,
 * plus coûteuse : entre deux fichiers seulement). Rend la RSS (Mo).
 */
export function sampleMemory(p: DiagJobProgress, rssMb?: () => number, onPoint?: (pt: DiagMemPoint) => void, container = false): number {
  const m = process.memoryUsage();
  const rss = rssMb ? rssMb() : Math.round(m.rss / MB);
  p.rssMb = rss;
  p.peakRssMb = Math.max(p.peakRssMb ?? 0, rss);
  p.heapUsedMb = Math.round(m.heapUsed / MB);
  p.externalMb = Math.round(m.external / MB);
  p.arrayBuffersMb = Math.round(m.arrayBuffers / MB);
  if (container) { try { p.containerUsedMb = readContainerMemory().containerUsedMb; } catch { /* cgroup illisible */ } }
  p.updatedAt = new Date().toISOString();
  onPoint?.({ ...memPoint(m, container ? p.containerUsedMb ?? null : undefined), rssMb: rss });
  return rss;
}

export function emptyProgress(memoryLimitMb: number | null): DiagJobProgress {
  return { filesPlanned: null, filesDone: 0, rows: 0, bytes: 0, compressedBytes: 0, current: null, rssMb: null, peakRssMb: null, heapUsedMb: null, memoryLimitMb, updatedAt: new Date().toISOString() };
}

async function defaultStorage(): Promise<DiagStorage> {
  const { isS3Configured, getS3Client, getS3Bucket } = await import('@/lib/s3-config');
  if (!isS3Configured()) throw new DiagJobError('STORAGE_UNAVAILABLE', 'variables S3 absentes ou invalides');
  return { client: getS3Client('worker'), bucket: getS3Bucket() };
}

/** Supprime les objets d'un préfixe (sauf ceux qui commencent par `keep`) ; best effort. */
export async function deletePrefix(storage: DiagStorage, prefix: string, keep?: string): Promise<number> {
  const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  let token: string | undefined;
  let n = 0;
  do {
    const r = await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, ContinuationToken: token })) as {
      Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string;
    };
    const keys = (r.Contents ?? []).map((o) => o.Key!).filter((k) => k && (!keep || !k.startsWith(keep)));
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await storage.client.send(new DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
      n += batch.length;
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return n;
}

/**
 * Lot 111C : abandonne les envois en plusieurs parties INCOMPLETS d'un préfixe
 * (objets OVH invisibles dans la liste, mais facturés) ; best effort.
 */
export async function abortIncompleteUploads(storage: DiagStorage, prefix: string): Promise<number> {
  const { ListMultipartUploadsCommand, AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
  let n = 0;
  let keyMarker: string | undefined;
  let idMarker: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await storage.client.send(new ListMultipartUploadsCommand({ Bucket: storage.bucket, Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: idMarker })) as {
      Uploads?: Array<{ Key?: string; UploadId?: string }>; IsTruncated?: boolean; NextKeyMarker?: string; NextUploadIdMarker?: string;
    };
    for (const u of r.Uploads ?? []) {
      if (!u.Key || !u.UploadId || !u.Key.startsWith(prefix)) continue;
      await storage.client.send(new AbortMultipartUploadCommand({ Bucket: storage.bucket, Key: u.Key, UploadId: u.UploadId })).catch(() => undefined);
      n++;
    }
    if (!r.IsTruncated) break;
    keyMarker = r.NextKeyMarker;
    idMarker = r.NextUploadIdMarker;
  }
  return n;
}

/** Lot 111C : nettoyage complet d'un préfixe (objets + envois incomplets), sans jamais lever. */
export async function purgeDiagnosticPrefix(storage: DiagStorage, prefix: string, keep?: string): Promise<void> {
  await deletePrefix(storage, prefix, keep).catch((e) => console.error('[diagnostic-job] suppression des fichiers impossible :', sanitizeErrorMessage(e)));
  await abortIncompleteUploads(storage, prefix).catch(() => undefined);
}

/**
 * Lot 111Q — contexte CORRÉLABLE de chaque ligne de journal d'une tentative :
 * travail, demande (requestId), périmètre, cible, option renforcée, tentative,
 * voie, worker (instance:processus), version (commit). Aucune donnée métier.
 */
export function diagLogContext(job: DiagJobRow, workerId: string, lane: string | null, build: { commit: string | null; version?: string | null }): Record<string, unknown> {
  return {
    jobId: job.id, requestId: job.requestId, scope: job.request.scope, targetId: job.request.id, reinforced: job.request.reinforced,
    attempt: job.attempt, lane, worker: workerId.split(':').slice(0, 2).join(':'), commit: build.commit, version: build.version ?? null,
  };
}

/**
 * Exécute UNE tentative ; rend le statut écrit (null : bail perdu — rien
 * écrit, la génération appartient à une autre tentative).
 */
export async function runDiagnosticJob(job: DiagJobRow, ctx: DiagRunContext): Promise<DiagJobStatus | null> {
  const settings = diagJobSettings();
  const progress = ctx.progress;
  const { getBuildIdentity } = await import('@/lib/runtime-identity');
  const base = diagLogContext(job, ctx.workerId, ctx.lane ?? null, getBuildIdentity());
  const log = (event: string, data: Record<string, unknown>) => console.info(`[diagnostic-job] ${JSON.stringify({ event, ...base, ...data })}`);
  // Lot 111Q : profilage des étapes (durées, fichiers les plus lents) — persisté et journalisé.
  const prof = createPhaseProfiler({ attempt: job.attempt, lane: ctx.lane ?? null });
  // Lot 113Q : profil mémoire (initial, pic, par étape, par fichier) — origine du pic MESURÉE.
  const mem = createMemoryRecorder();
  const onPoint = (pt: DiagMemPoint) => mem.sample(phase, pt);
  let sessionStats: import('@/services/admin/account-data/session').SessionStats | null = null;
  let sessionTrace: import('@/services/admin/account-data/session').SessionTrace | null = null;
  /** Lot 113AG : bilan des erreurs SQL de la session (journal final). */
  const sqlSummary = () => {
    const h = sessionTrace?.health();
    if (!h) return null;
    return { session: h.state, total: h.total, origins: h.origins, consequences: h.consequences, firstError: h.firstError ? { seq: h.firstError.seq, at: h.firstError.at, sqlstate: h.firstError.sqlstate, file: h.firstError.file, caller: h.firstError.caller } : null, fatal: h.fatal ? h.fatal.reason : null };
  };
  const queries = () => (sessionStats ? {
    count: sessionStats.queries, ms: Math.round(sessionStats.queryMs), fetches: sessionStats.fetches, rows: sessionStats.rows, bytes: sessionStats.bytes,
    oversizedRows: sessionStats.oversizedRows, maxRowBytes: sessionStats.maxRowBytes, slowest: sessionStats.slowest.map((x) => ({ sql: sanitizeErrorMessage(x.sql), ms: x.ms })),
  } : null);
  const guardMb = memoryGuardMb(settings.maxRssMb, progress.memoryLimitMb);
  let phase: DiagJobPhase = 'PLANIFICATION';
  let step: string | null = null;
  // Racine du travail : toujours dérivée de son identifiant (jamais d'un préfixe stocké).
  const root = `${DIAG_JOB_PREFIX}${job.id}/`;
  const prefix = `${root}a${job.attempt}/`;
  let storage: DiagStorage | null = null;
  const stored: StoredFile[] = [];
  let openUpload: { abort(): Promise<void> } | null = null;

  // ── Lot 111C : annulation lue en base, interruption de la requête SQL en cours ──
  let cancelSeen = false;
  let backendPid: number | null = null;
  /** Début de la transaction de l'instantané : l'interruption ne vise QUE cette transaction (jamais une connexion rendue au pool). */
  let backendXact: string | null = null;
  let interrupted = false;
  const cancelled = () => cancelSeen || ctx.cancelRequested();
  // Interruption RÉPÉTÉE à chaque lecture tant que l'instantané est ouvert : une requête suivante
  // (même table, verrou toujours tenu ailleurs) ne peut pas reprendre l'attente.
  const interrupt = async () => {
    if (!interrupted) log('interrupt', { phase, current: progress.current, backendPid, cause: 'CANCEL_REQUESTED' });
    interrupted = true;
    if (backendPid) {
      const { pgClient } = await import('@/db');
      await pgClient`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = ${backendPid} AND xact_start::text = ${backendXact}`.catch(() => undefined);
    }
  };
  const poll = setInterval(() => {
    if (cancelled()) { void interrupt(); return; }
    void readDiagnosticControl(job.id, ctx.workerId).then((c) => {
      if (c.cancelRequested) { cancelSeen = true; void interrupt(); }
    }).catch(() => undefined);
  }, ctx.cancelPollMs ?? settings.cancelPollMs);
  poll.unref?.();

  /**
   * Garde commune : rend le motif d'arrêt, ou null. Lot 111Q : la mesure
   * mémoire (`process.memoryUsage()`, lecture de /proc) était refaite à
   * CHAQUE écriture (des milliers par diagnostic) ; elle est désormais
   * bornée à une mesure toutes les MEMORY_SAMPLE_MS pendant l'écriture d'un
   * fichier, et toujours refaite entre deux fichiers (`force`) — la garde
   * reste vérifiée au plus tard toutes les 200 ms.
   */
  let lastSampleAt = 0;
  let writes = 0;
  let samples = 0;
  let uploadMs = 0;
  let uploadParts = 0;
  const stopReason = (force = false): { code: DiagJobErrorCode | 'LEASE'; message: string } | null => {
    if (!ctx.isActive()) return { code: 'LEASE', message: 'bail perdu' };
    if (cancelled()) return { code: 'CANCELLED', message: 'annulation demandée' };
    if (Date.now() > ctx.deadline) return { code: 'JOB_TIMEOUT', message: `délai global de ${Math.round(settings.timeoutMs / 60_000)} min dépassé` };
    let rss = progress.rssMb ?? 0;
    if (force || progress.rssMb == null || Date.now() - lastSampleAt >= MEMORY_SAMPLE_MS) {
      rss = sampleMemory(progress, ctx.rssMb, onPoint, force);
      lastSampleAt = Date.now();
      samples++;
    }
    if (guardMb && rss > guardMb) {
      // Lot 113Q : la mesure dit ce qui est plein (tas V8, mémoire native, ArrayBuffer), et d'où le fichier en cours est parti.
      const f = mem.current();
      return {
        code: 'MEMORY_GUARD',
        message: `mémoire du processus ${rss} Mo > seuil ${guardMb} Mo (limite du conteneur ${progress.memoryLimitMb ?? '?'} Mo) — tas ${progress.heapUsedMb ?? '?'} Mo, natif ${progress.externalMb ?? '?'} Mo, ArrayBuffer ${progress.arrayBuffersMb ?? '?'} Mo, mémoire au démarrage ${progress.initialRssMb ?? '?'} Mo${f ? ` ; fichier ${f.path} commencé à ${f.startRssMb} Mo` : ''}`,
      };
    }
    return null;
  };
  const check = () => {
    const r = stopReason(true);
    if (!r) return;
    if (r.code === 'LEASE') throw new DiagLeaseLostError();
    throw new DiagJobError(r.code, r.message);
  };
  const enter = async (p: DiagJobPhase) => {
    if (p === phase) return;
    phase = p;
    sessionTrace?.setContext({ phase: p });
    const left = prof.enter(p);
    await setDiagnosticPhase(job.id, ctx.workerId, p, progress, prof.snapshot());
    log('phase', { phase: p, previous: left.left, previousMs: Math.round(left.ms), filesDone: progress.filesDone, filesPlanned: progress.filesPlanned, rssMb: progress.rssMb });
  };

  try {
    // Lot 113Q : mémoire au démarrage (avant toute lecture) — distingue la part du processus de celle du diagnostic.
    progress.initialRssMb = sampleMemory(progress, ctx.rssMb, onPoint, true);
    storage = ctx.storage ?? await defaultStorage();
    // Fichiers d'une tentative précédente (interrompue) : supprimés — jamais mélangés à ceux-ci.
    step = 'cleanup';
    await purgeDiagnosticPrefix(storage, root, prefix);
    const st = storage;
    const { openGzipUpload } = await import('@/services/backup/s3-gzip-upload');
    const { openReadSession } = await import('@/services/admin/account-data/session');
    const { withDiagnosticPlan } = await import('@/services/admin/diagnostics-export/collect');
    const { zipFileName } = await import('@/services/admin/diagnostics-export/model');

    /** Écrit un fichier compressé en flux ; empreinte et tailles rendues par l'envoi. */
    const storeFile = async (path: string, produce: (write: (c: string) => Promise<void>) => Promise<void>): Promise<StoredFile> => {
      const key = `${prefix}${path}.gz`;
      const fileStart = Date.now();
      step = 'upload';
      // Lot 113Q : coût des envois (ouverture + fin d'envoi, hors production) mesuré — beaucoup de petits fichiers.
      const u0 = Date.now();
      const up = await openGzipUpload(st.client, st.bucket, key, { contentType: 'application/gzip', metadata: { job: job.id, attempt: String(job.attempt) } });
      uploadMs += Date.now() - u0;
      openUpload = up;
      const write = async (c: string) => {
        writes++;
        const r = stopReason();
        if (r) throw r.code === 'LEASE' ? Object.assign(new DiagLeaseLostError(), { name: 'SinkError', lease: true }) : new SinkAbort(r.code, r.message);
        try { await up.write(c); } catch (e) { throw new SinkAbort('STORAGE_UPLOAD_FAILED', `envoi de ${path} : ${(e as Error)?.message ?? e}`); }
        progress.bytes += Buffer.byteLength(c);
      };
      step = 'produce';
      sampleMemory(progress, ctx.rssMb, (pt) => mem.fileStart(path, phase, pt));
      await produce(write);
      step = 'upload';
      const u1 = Date.now();
      const r = await up.finish().catch((e) => { throw new SinkAbort('STORAGE_UPLOAD_FAILED', `fin d'envoi de ${path} : ${(e as Error)?.message ?? e}`); });
      uploadMs += Date.now() - u1;
      uploadParts += r.parts;
      openUpload = null;
      const f: StoredFile = { path, key, bytes: r.bytes, compressedBytes: r.compressedBytes, sha256: r.sha256 };
      stored.push(f);
      progress.filesDone++;
      progress.compressedBytes += r.compressedBytes;
      prof.file(path, Date.now() - fileStart, r.bytes);
      sampleMemory(progress, ctx.rssMb, (pt) => mem.fileEnd(pt, r.bytes));
      lastSampleAt = Date.now();
      return f;
    };

    step = 'snapshot';
    prof.enter('INSTANTANE');
    // Lot 113AG : chaque erreur SQL d'ORIGINE et l'incident fatal journalisés AU MOMENT où ils surviennent
    // (horodatage corrélable Scalingo / PostgreSQL) ; les 25P02 secondaires sont comptés, rattachés à leur cause.
    let sqlLogged = 0;
    const session = await openReadSession({}, {
      statementTimeoutMs: settings.statementTimeoutMs,
      onIncident: (i) => {
        if (i.kind === 'CONSEQUENCE' || sqlLogged >= 20) return;
        sqlLogged++;
        console.error(`[diagnostic-job] ${JSON.stringify({ event: sqlLogged === 1 ? 'sql-first-error' : 'sql-error', ...base, seq: i.seq, at: i.at, sqlstate: i.sqlstate, kind: i.kind, phase: i.phase ?? phase, file: i.file, caller: i.caller, savepoint: i.savepoint, statement: sanitizeErrorMessage(i.statement), message: sanitizeErrorMessage(i.message), stack: i.stack.slice(0, 4) })}`);
      },
      onFatal: (f) => {
        console.error(`[diagnostic-job] ${JSON.stringify({ event: 'sql-session-broken', ...base, at: f.at, reason: f.reason, phase, origin: f.origin ? { seq: f.origin.seq, sqlstate: f.origin.sqlstate, file: f.origin.file, caller: f.origin.caller, message: sanitizeErrorMessage(f.origin.message) } : null, rollback: f.rollback ? { seq: f.rollback.seq, sqlstate: f.rollback.sqlstate, message: sanitizeErrorMessage(f.rollback.message) } : null, connection: 'libérée', reads: 'arrêtées' })}`);
      },
    });
    sessionStats = session.stats ?? null;
    sessionTrace = session.trace ?? null;
    // Lot 111C : connexion réservée de l'instantané — cible de l'interruption en cas d'annulation.
    await session.q('SELECT pg_backend_pid() AS pid, (SELECT xact_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS xs').then((r) => {
      backendXact = r[0]?.xs == null ? null : String(r[0].xs);
      backendPid = backendXact ? Number(r[0]?.pid) || null : null;
    }, () => undefined);
    if (cancelled()) void interrupt();
    let outcome: { status: 'COMPLETE' | 'PARTIAL' | 'FAILED'; manifest: import('@/services/admin/diagnostics-export/model').DiagManifest; fileName: string };
    try {
      await enter('INVENTAIRE');
      step = 'plan';
      outcome = await withDiagnosticPlan(
        { scope: job.request.scope as never, id: job.request.id, reinforced: job.request.reinforced },
        { adminUserId: job.adminUserId ?? 0, generationId: job.id, session, partRows: ctx.partRows, batchRows: ctx.batchRows },
        async (plan) => {
          progress.filesPlanned = plan.entries.length + 2;
          for (const e of plan.entries) {
            check();
            await enter(phaseOfPath(e.path));
            progress.current = e.path;
            await storeFile(e.path, (write) => e.produce({ write }));
          }
          const { manifest } = plan.result();
          return { status: (manifest.status ?? 'FAILED') as 'COMPLETE' | 'PARTIAL' | 'FAILED', manifest, fileName: zipFileName(manifest) };
        },
      );
    } finally {
      backendPid = null;
      await session.close().catch(() => undefined);
    }
    const m = outcome.manifest;

    // ── Index d'intégrité (empreintes de TOUS les fichiers stockés) ──────────
    check();
    await enter('VALIDATION');
    progress.current = 'integrite.json';
    const listed = stored.map((f) => ({ path: f.path, bytes: f.bytes, compressedBytes: f.compressedBytes, sha256: f.sha256 }));
    const pubStatus = outcome.status === 'FAILED' ? 'PARTIAL' : outcome.status;
    const index: DiagStoredIndex = {
      schema: 'verebona.bo.diagnostic-integrite/1', jobId: job.id, attempt: job.attempt, generatedAt: m.generatedAt,
      snapshot: { at: m.snapshot?.at ?? null, snapshot: m.snapshot?.snapshot ?? null }, status: pubStatus, fileName: outcome.fileName, files: [...listed],
    };
    const sums = await storeFile('SHA256SUMS.txt', async (w) => { await w(listed.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n'); });
    // L'index liste tous les fichiers de l'archive (sommes comprises), sauf lui-même.
    index.files.push({ path: sums.path, bytes: sums.bytes, compressedBytes: sums.compressedBytes, sha256: sums.sha256 });
    await storeFile('integrite.json', async (w) => { await w(`${JSON.stringify(index, null, 2)}\n`); });

    // ── Validation : rien n'est publié tant qu'un contrôle échoue ─────────────
    step = 'validate';
    const problems = await validateStored(st, stored, m, plan2paths(m));
    if (problems.length) throw new DiagJobError('VALIDATION_FAILED', problems.slice(0, 5).join(' ; ') + (problems.length > 5 ? ` … (+${problems.length - 5})` : ''));
    if (outcome.status === 'FAILED') {
      // Le moteur n'a rien pu exporter d'exploitable (erreur fatale ou aucun fichier complet) : pas de publication.
      throw new DiagJobError('GENERATION_FAILED', `statut du moteur FAILED — ${m.warnings.slice(0, 3).join(' ; ')}`);
    }

    // ── Lot 113Q : ZIP DÉFINITIF — assemblé une fois, stocké, relu, vérifié ──
    check();
    await enter('ASSEMBLAGE_ZIP');
    const integ = stored.find((f) => f.path === 'integrite.json')!;
    const { archiveOrder, writeArchive, verifyStoredArchive } = await import('./archive');
    const { openRawUpload } = await import('@/services/backup/s3-gzip-upload');
    const entries = archiveOrder(index, prefix, integ);
    const archiveKey = `${prefix}archive/${archiveObjectName(outcome.fileName)}`;
    let archive: DiagArchiveInfo | null = null;
    // Reprise de l'ASSEMBLAGE seul (fichiers validés de CETTE tentative, même instantané) : bornée.
    for (let k = 1; k <= ARCHIVE_ASSEMBLY_TRIES && !archive; k++) {
      step = 'archive';
      const t0 = Date.now();
      const up = await openRawUpload(st.client, st.bucket, archiveKey, { contentType: 'application/zip', metadata: { job: job.id, attempt: String(job.attempt) } });
      openUpload = up;
      try {
        const zr = await writeArchive(st, entries, new Date(m.generatedAt), async (c) => {
          const r = stopReason();
          if (r) throw r.code === 'LEASE' ? new DiagLeaseLostError() : new DiagJobError(r.code, r.message);
          await up.write(c);
        }, (p) => { progress.current = `ZIP › ${p}`; });
        const fin = await up.finish();
        openUpload = null;
        prof.counter('archiveAssemblyMs', Date.now() - t0);
        await enter('VERIFICATION_ZIP');
        step = 'archive-verify';
        progress.current = 'ZIP › vérification';
        const t1 = Date.now();
        const chk = await verifyStoredArchive(st, archiveKey, entries, fin.bytes);
        prof.counter('archiveVerifyMs', Date.now() - t1);
        if (!chk.ok) throw new DiagJobError('ARCHIVE_FAILED', chk.problems.slice(0, 5).join(' ; '));
        archive = { key: archiveKey, bytes: fin.bytes, sha256: fin.sha256, entries: zr.entries, zip64: zr.zip64, verifiedAt: new Date().toISOString() };
      } catch (e) {
        await up.abort().catch(() => undefined);
        openUpload = null;
        const code = (e as { diagCode?: string })?.diagCode;
        // Arrêt (garde, annulation, bail) ou dernière reprise : l'erreur remonte telle quelle.
        if (e instanceof DiagLeaseLostError || (code && code !== 'ARCHIVE_FAILED') || k === ARCHIVE_ASSEMBLY_TRIES) {
          if (!code && !(e instanceof DiagLeaseLostError)) {
            throw new DiagJobError((e as { $metadata?: unknown })?.$metadata !== undefined ? 'STORAGE_UPLOAD_FAILED' : 'ARCHIVE_FAILED', `assemblage de l’archive : ${sanitizeErrorMessage(e)}`);
          }
          throw e;
        }
        log('archive-retry', { try: k, message: sanitizeErrorMessage(e) });
        await purgeDiagnosticPrefix(st, `${prefix}archive/`);
        await enter('ASSEMBLAGE_ZIP');
      }
    }

    // ── Publication ─────────────────────────────────────────────────────────
    await enter('PUBLICATION');
    progress.current = null;
    sampleMemory(progress, ctx.rssMb);
    const sections = (m.sections ?? []).map((x) => ({ code: x.code, label: x.label, status: x.status, motif: x.motif, expected: x.expected, exported: x.exported, files: x.files.length, errors: x.errors.slice(0, 3) }));
    const files = m.files;
    // Lot 111Q : métriques finales (temps en file / exécution / total) et profilage persistés avant publication.
    const metrics = diagMetrics({ status: 'RUNNING', startedAt: job.queuedAt ?? new Date().toISOString(), firstRunStartedAt: job.firstRunStartedAt, attemptsLog: job.attemptsLog, now: new Date() });
    prof.counter('writes', writes);
    prof.counter('memorySamples', samples);
    prof.counter('uploadOpenFinishMs', uploadMs);
    prof.counter('uploadParts', uploadParts);
    const timings = prof.snapshot({
      queueWaitMs: metrics.queueWaitMs, executionMs: metrics.executionMs, totalElapsedMs: metrics.totalElapsedMs,
      zipFiles: stored.length, bytes: stored.reduce((n, f) => n + f.bytes, 0), compressedBytes: progress.compressedBytes, status: outcome.status,
      archiveBytes: archive?.bytes ?? null,
    }, { memory: mem.snapshot(), queries: queries() });
    await saveDiagnosticTimings(job.id, ctx.workerId, timings);
    await publishDiagnosticJob(job, ctx.workerId, {
      status: outcome.status, snapshotAt: m.snapshot?.at ?? null, pgSnapshot: m.snapshot?.snapshot ?? null,
      rowsExpected: files.reduce((n, f) => n + (f.expected ?? 0), 0),
      rowsExported: files.reduce((n, f) => n + (f.expected !== undefined && f.expected !== null ? (f.count ?? 0) : 0), 0),
      batches: files.reduce((n, f) => n + (f.batches ?? 0), 0),
      bytes: stored.reduce((n, f) => n + f.bytes, 0), files: stored.length, sections,
      warning: outcome.status === 'COMPLETE' ? null : m.warnings.slice(0, 20).join(' ; '), fileName: outcome.fileName, progress, storagePrefix: prefix,
      archive,
    });
    log('published', {
      status: outcome.status, files: stored.length, bytes: timings.final?.bytes ?? null, compressedBytes: progress.compressedBytes, peakRssMb: progress.peakRssMb,
      queueWaitMs: metrics.queueWaitMs, executionMs: metrics.executionMs, totalElapsedMs: metrics.totalElapsedMs, phases: timings.phases,
      slowest: timings.slowestFiles.slice(0, 5).map((x) => `${x.path}:${x.ms}ms`), counters: timings.counters,
      archiveBytes: archive?.bytes ?? null, archiveEntries: archive?.entries ?? null, zip64: archive?.zip64 ?? null,
      memory: memoryLogLine(timings.memory ?? null, progress), queries: timings.queries ? { count: timings.queries.count, ms: timings.queries.ms, oversizedRows: timings.queries.oversizedRows, maxRowBytes: timings.queries.maxRowBytes } : null,
      sql: sqlSummary(),
    });
    return outcome.status;
  } catch (e) {
    clearInterval(poll);
    await (openUpload as { abort(): Promise<void> } | null)?.abort().catch(() => undefined);
    const lease = e instanceof DiagLeaseLostError || (e as { lease?: boolean })?.lease === true;
    if (lease) {
      log('lease-lost', { phase, cause: 'LEASE_LOST' });
      // Lot 111C : demande close entre-temps (annulée, remplacée, en échec) — plus personne ne
      // reprendra ces fichiers : supprimés. Reprise ailleurs (RUNNING) : la suivante s'en charge.
      const c = await readDiagnosticControl(job.id, ctx.workerId).catch(() => null);
      if (storage && c && c.status !== 'RUNNING') await purgeDiagnosticPrefix(storage, prefix);
      return null;
    }
    const isCancel = cancelled() || (e as { diagCode?: unknown })?.diagCode === 'CANCELLED';
    const code = isCancel ? 'CANCELLED' : classifyDiagJobError(e, step);
    const message = sanitizeErrorMessage(e);
    if (storage) await purgeDiagnosticPrefix(storage, prefix);
    // Lot 113Q : profilage CLOS (durées figées, aucune étape « en cours »), mémoire et requêtes mesurées.
    const memory = mem.snapshot();
    const closed = prof.snapshot(undefined, { ended: { status: isCancel ? 'CANCELLED' : 'FAILED', code, phase, at: new Date().toISOString() }, memory, queries: queries() });
    await saveDiagnosticTimings(job.id, ctx.workerId, closed);
    const status = await failDiagnosticAttempt(job, ctx.workerId, {
      code, phase, message, transient: isTransientError(code), progress, cancelled: isCancel,
    });
    console.error(`[diagnostic-job] ${JSON.stringify({ event: isCancel ? 'attempt-cancelled' : 'attempt-failed', ...base, code, cause: code, phase, step, status, autoRetry: status === 'QUEUED', rssMb: progress.rssMb, peakRssMb: progress.peakRssMb, phases: closed.phases, memory: memoryLogLine(memory, progress), queries: closed.queries ? { count: closed.queries.count, ms: closed.queries.ms, oversizedRows: closed.queries.oversizedRows } : null, sql: sqlSummary(), message })}`);
    return status;
  } finally {
    clearInterval(poll);
  }
}

/** Lot 113Q : archive ZIP définitive publiée (objet stocké, vérifié). */
export interface DiagArchiveInfo { key: string; bytes: number; sha256: string; entries: number; zip64: boolean; verifiedAt: string }

/** Lot 113Q : essais d'assemblage de l'archive dans une même tentative (fichiers validés réutilisés). */
export const ARCHIVE_ASSEMBLY_TRIES = 2;

/** Nom d'objet sûr de l'archive (pur). */
export function archiveObjectName(fileName: string): string {
  const base = String(fileName || 'diagnostic.zip').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 150);
  return base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
}

/**
 * Lot 113Q : résumé mémoire journalisé (Scalingo) — initial, pic (RSS, tas,
 * natif, ArrayBuffer, conteneur), pic par étape, 5 fichiers au pic le plus
 * haut et 5 à la plus forte croissance. Aucune donnée métier.
 */
export function memoryLogLine(m: import('./metrics').DiagMemoryProfile | null, p: DiagJobProgress): Record<string, unknown> {
  if (!m) return { initialRssMb: p.initialRssMb ?? null, peakRssMb: p.peakRssMb };
  return {
    initial: m.initial, peak: m.peak,
    byPhase: Object.fromEntries(Object.entries(m.byPhase).map(([k, v]) => [k, `${v.rssMb}/${v.heapUsedMb}/${v.externalMb}/${v.arrayBuffersMb}`])),
    topFiles: m.files.slice(0, 5).map((f) => `${f.path}:${f.startRssMb}→${f.peakRssMb}Mo`),
    topGrowth: m.growth.slice(0, 5).map((f) => `${f.path}:+${f.peakRssMb - f.startRssMb}Mo`),
    legend: 'rss/tas/natif/arrayBuffers (Mo)',
  };
}

/** Chemins attendus : ceux du manifeste (fichiers du plan, rapport et manifeste compris). */
function plan2paths(m: { files: Array<{ path: string }> }): string[] {
  return m.files.map((f) => f.path);
}

/**
 * Validation finale (pure côté décision, lit le stockage) : chaque fichier
 * attendu est stocké, présent avec la taille envoyée, et son empreinte est
 * celle du manifeste ; l'index d'intégrité et les sommes sont présents.
 */
export async function validateStored(storage: DiagStorage, stored: readonly StoredFile[], m: { files: Array<{ path: string; sha256?: string }> }, expected: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const byPath = new Map(stored.map((f) => [f.path, f]));
  for (const p of expected) if (!byPath.has(p)) problems.push(`${p} : prévu au manifeste, absent du stockage`);
  for (const p of ['integrite.json', 'SHA256SUMS.txt']) if (!byPath.has(p)) problems.push(`${p} : absent`);
  const declared = new Set(expected);
  for (const f of stored) if (!declared.has(f.path) && f.path !== 'integrite.json' && f.path !== 'SHA256SUMS.txt') problems.push(`${f.path} : stocké mais absent du manifeste`);
  for (const info of m.files) {
    const f = byPath.get(info.path);
    if (f && info.sha256 && info.sha256 !== f.sha256) problems.push(`${info.path} : SHA-256 du manifeste différent du contenu stocké`);
  }
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  for (const f of stored) {
    try {
      const h = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: f.key })) as { ContentLength?: number };
      if (h.ContentLength !== undefined && Number(h.ContentLength) !== f.compressedBytes) problems.push(`${f.path} : taille stockée ${h.ContentLength} ≠ envoyée ${f.compressedBytes}`);
    } catch (e) {
      problems.push(`${f.path} : absent du stockage (${sanitizeErrorMessage((e as { name?: string })?.name ?? e)})`);
    }
  }
  return problems;
}
