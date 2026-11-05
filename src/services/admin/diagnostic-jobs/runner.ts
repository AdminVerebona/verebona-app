/**
 * Lot 107G — EXÉCUTION d'un diagnostic durable (serveur uniquement, appelé
 * par le worker `worker.ts`, jamais par une requête HTTP).
 *
 * MÊME MOTEUR que toujours (`planDiagnostic` / `engine.ts`, lot 91A) : le plan
 * est établi dans UNE session REPEATABLE READ READ ONLY, puis chaque fichier
 * est produit À LA DEMANDE et écrit — compressé gzip, en flux, à mémoire
 * bornée (`openGzipUpload`, celui de la sauvegarde et de l'export de recette)
 * — sous `admin-exports/diagnostics/<travail>/a<tentative>/<chemin>.gz`.
 * Aucune archive n'est construite en mémoire ; le ZIP est assemblé au
 * téléchargement, en flux, depuis les fichiers stockés (`download.ts`).
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
  DiagLeaseLostError, failDiagnosticAttempt, publishDiagnosticJob, readDiagnosticControl, setDiagnosticPhase, type DiagJobRow,
} from './repository';

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

/**
 * Limite mémoire du conteneur, en Mo ; null si inconnue. Lot 109H : lecture
 * partagée (`lib/runtime/memory-monitor`) — `CONTAINER_MEMORY` posée par
 * Scalingo d'abord, puis cgroup v2 et v1 (comme avant).
 */
export function containerMemoryLimitMb(): number | null {
  return readContainerMemory().containerLimitMb;
}

/** Mesure mémoire du processus, reportée dans la progression (pic compris). */
export function sampleMemory(p: DiagJobProgress, rssMb?: () => number): number {
  const m = process.memoryUsage();
  const rss = rssMb ? rssMb() : Math.round(m.rss / MB);
  p.rssMb = rss;
  p.peakRssMb = Math.max(p.peakRssMb ?? 0, rss);
  p.heapUsedMb = Math.round(m.heapUsed / MB);
  p.updatedAt = new Date().toISOString();
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

const log = (event: string, data: Record<string, unknown>) => console.info(`[diagnostic-job] ${JSON.stringify({ event, ...data })}`);

/**
 * Exécute UNE tentative ; rend le statut écrit (null : bail perdu — rien
 * écrit, la génération appartient à une autre tentative).
 */
export async function runDiagnosticJob(job: DiagJobRow, ctx: DiagRunContext): Promise<DiagJobStatus | null> {
  const settings = diagJobSettings();
  const progress = ctx.progress;
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
    if (!interrupted) log('interrupt', { jobId: job.id, attempt: job.attempt, phase, current: progress.current, backendPid });
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

  /** Garde commune : rend le motif d'arrêt, ou null. */
  const stopReason = (): { code: DiagJobErrorCode | 'LEASE'; message: string } | null => {
    if (!ctx.isActive()) return { code: 'LEASE', message: 'bail perdu' };
    if (cancelled()) return { code: 'CANCELLED', message: 'annulation demandée' };
    if (Date.now() > ctx.deadline) return { code: 'JOB_TIMEOUT', message: `délai global de ${Math.round(settings.timeoutMs / 60_000)} min dépassé` };
    const rss = sampleMemory(progress, ctx.rssMb);
    if (guardMb && rss > guardMb) return { code: 'MEMORY_GUARD', message: `mémoire ${rss} Mo > seuil ${guardMb} Mo (limite du conteneur ${progress.memoryLimitMb ?? '?'} Mo)` };
    return null;
  };
  const check = () => {
    const r = stopReason();
    if (!r) return;
    if (r.code === 'LEASE') throw new DiagLeaseLostError();
    throw new DiagJobError(r.code, r.message);
  };
  const enter = async (p: DiagJobPhase) => {
    if (p === phase) return;
    phase = p;
    await setDiagnosticPhase(job.id, ctx.workerId, p, progress);
    log('phase', { jobId: job.id, attempt: job.attempt, phase: p, filesDone: progress.filesDone, filesPlanned: progress.filesPlanned, rssMb: progress.rssMb });
  };

  try {
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
      step = 'upload';
      const up = await openGzipUpload(st.client, st.bucket, key, { contentType: 'application/gzip', metadata: { job: job.id, attempt: String(job.attempt) } });
      openUpload = up;
      const write = async (c: string) => {
        const r = stopReason();
        if (r) throw r.code === 'LEASE' ? Object.assign(new DiagLeaseLostError(), { name: 'SinkError', lease: true }) : new SinkAbort(r.code, r.message);
        try { await up.write(c); } catch (e) { throw new SinkAbort('STORAGE_UPLOAD_FAILED', `envoi de ${path} : ${(e as Error)?.message ?? e}`); }
        progress.bytes += Buffer.byteLength(c);
      };
      step = 'produce';
      await produce(write);
      step = 'upload';
      const r = await up.finish().catch((e) => { throw new SinkAbort('STORAGE_UPLOAD_FAILED', `fin d'envoi de ${path} : ${(e as Error)?.message ?? e}`); });
      openUpload = null;
      const f: StoredFile = { path, key, bytes: r.bytes, compressedBytes: r.compressedBytes, sha256: r.sha256 };
      stored.push(f);
      progress.filesDone++;
      progress.compressedBytes += r.compressedBytes;
      return f;
    };

    step = 'snapshot';
    const session = await openReadSession({}, { statementTimeoutMs: settings.statementTimeoutMs });
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

    // ── Publication ─────────────────────────────────────────────────────────
    await enter('PUBLICATION');
    progress.current = null;
    sampleMemory(progress, ctx.rssMb);
    const sections = (m.sections ?? []).map((x) => ({ code: x.code, label: x.label, status: x.status, motif: x.motif, expected: x.expected, exported: x.exported, files: x.files.length, errors: x.errors.slice(0, 3) }));
    const files = m.files;
    await publishDiagnosticJob(job, ctx.workerId, {
      status: outcome.status, snapshotAt: m.snapshot?.at ?? null, pgSnapshot: m.snapshot?.snapshot ?? null,
      rowsExpected: files.reduce((n, f) => n + (f.expected ?? 0), 0),
      rowsExported: files.reduce((n, f) => n + (f.expected !== undefined && f.expected !== null ? (f.count ?? 0) : 0), 0),
      batches: files.reduce((n, f) => n + (f.batches ?? 0), 0),
      bytes: stored.reduce((n, f) => n + f.bytes, 0), files: stored.length, sections,
      warning: outcome.status === 'COMPLETE' ? null : m.warnings.slice(0, 20).join(' ; '), fileName: outcome.fileName, progress, storagePrefix: prefix,
    });
    log('published', { jobId: job.id, attempt: job.attempt, status: outcome.status, files: stored.length, compressedBytes: progress.compressedBytes, peakRssMb: progress.peakRssMb });
    return outcome.status;
  } catch (e) {
    clearInterval(poll);
    await (openUpload as { abort(): Promise<void> } | null)?.abort().catch(() => undefined);
    const lease = e instanceof DiagLeaseLostError || (e as { lease?: boolean })?.lease === true;
    if (lease) {
      log('lease-lost', { jobId: job.id, attempt: job.attempt, phase });
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
    const status = await failDiagnosticAttempt(job, ctx.workerId, {
      code, phase, message, transient: isTransientError(code), progress, cancelled: isCancel,
    });
    console.error(`[diagnostic-job] ${JSON.stringify({ event: isCancel ? 'attempt-cancelled' : 'attempt-failed', jobId: job.id, attempt: job.attempt, code, phase, step, status, rssMb: progress.rssMb, peakRssMb: progress.peakRssMb, message })}`);
    return status;
  } finally {
    clearInterval(poll);
  }
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
