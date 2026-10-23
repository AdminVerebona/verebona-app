/**
 * Sauvegarde quotidienne de la base de données.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IL N'Y AVAIT RIEN À RÉPARER : AUCUNE SAUVEGARDE N'ÉTAIT PRODUITE
 *
 * Le tableau de bord d'administration lit `backups/*.json` dans le stockage
 * et affiche l'âge de la dernière sauvegarde. Le menu propose une page
 * « Backups ». Mais :
 *   · aucun code ne déposait de fichier sous `backups/` ;
 *   · la page `/admin/backups` n'existait pas (lien mort) ;
 *   · aucune tâche planifiée ne s'en chargeait.
 *
 * Ce service produit la sauvegarde, `startDatabaseBackupScheduler` la
 * déclenche chaque nuit, et la page d'administration la montre.
 *
 * ── FORMAT ────────────────────────────────────────────────────────────────
 *
 *   backups/<horodatage>/data.ndjson.gz   une ligne JSON par ligne de table :
 *                                         {"t":"<table>","r":{…}} — depuis le
 *                                         lot 82E, `r` est le texte exact de
 *                                         `row_to_json` (format 2, ci-dessous)
 *   backups/<horodatage>.json             manifeste (tables, lignes, taille,
 *                                         durée) — écrit EN DERNIER : sa
 *                                         présence atteste une sauvegarde
 *                                         complète. C'est lui que lit le
 *                                         tableau de bord.
 *
 * Les tables sont lues par curseur et le fichier compressé est envoyé en
 * plusieurs parties : la mémoire reste bornée quelle que soit la taille de
 * la base. Les fichiers déposés par les utilisateurs ne sont pas copiés :
 * ils sont déjà dans le stockage objet.
 *
 * ⚠️ Ce n'est pas un `pg_dump`. Lot 82E (C-Q8, D13) : le format 2 est lu
 * dans UN instantané (relations cohérentes), signé par table (colonnes), et
 * se restaure depuis le BO (Exploitation › Sauvegardes et recette,
 * `database-restore.service.ts`) dans le schéma COURANT, s'il est identique.
 * Les points de format 1 restent listés mais ne sont pas restaurables. La
 * sauvegarde de l'hébergeur, si elle existe, reste la première ligne de
 * défense (procédure : docs/exploitation/recette-sauvegarde-export.md).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getS3Bucket, getS3Client, isS3Configured } from '@/lib/s3-config';
import { openGzipUpload } from './s3-gzip-upload';
import { BACKUP_EXCLUDED_TABLES, readSchemaSignature, signatureFingerprint, type Query } from './schema-signature';

export const BACKUP_PREFIX = 'backups/';
/** Nombre de jours conservés. */
const RETENTION_JOURS = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 30);
/** Lignes lues par tour de curseur. */
const LOT_LIGNES = 500;
/** Délai par lecture dans la session de sauvegarde (une table volumineuse est lue par lots). */
const SAUVEGARDE_STATEMENT_TIMEOUT_MS = 10 * 60_000;

/** Format historique (avant le lot 82) : lignes converties par le pilote, lues table par table hors instantané commun. */
export interface BackupManifestV1 {
  version: 1;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dataKey: string;
  sizeBytes: number;
  tables: Array<{ name: string; rows: number }>;
  totalRows: number;
  trigger: 'scheduler' | 'cron' | 'admin';
  environment: string;
}

/**
 * Lot 82E — format 2 (« point de restauration ») :
 *   · TOUTES les tables lues dans UNE transaction REPEATABLE READ READ ONLY
 *     (session 81C `openReadSession`) : instantané cohérent, relations
 *     entre tables intactes — condition d'une restauration ;
 *   · chaque ligne écrite telle que PostgreSQL la rend (`row_to_json`) :
 *     horodatages à la microseconde, numériques et grands entiers exacts,
 *     binaires en `\\x…` — aucune conversion par le pilote ;
 *   · signature des colonnes de chaque table : la restauration refuse un
 *     point dont le schéma diffère du schéma courant ;
 *   · identifiant stable (`backupId`) et libellé (motif saisi au BO).
 */
export interface BackupManifestV2 {
  version: 2;
  format: 'ndjson-row_to_json';
  backupId: string;
  label: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dataKey: string;
  sizeBytes: number;
  /** Octets non compressés et SHA-256 du contenu non compressé (intégrité vérifiée à la restauration). */
  rawBytes: number;
  sha256: string;
  snapshot: { isolation: string; at: string; snapshot: string | null };
  schema: { fingerprint: string; lastMigration: string | null };
  tables: Array<{ name: string; rows: number; columns: string[] }>;
  totalRows: number;
  trigger: 'scheduler' | 'cron' | 'admin';
  adminUserId: number | null;
  environment: string;
}

export type BackupManifest = BackupManifestV1 | BackupManifestV2;

/** Session de lecture cohérente (81C) — injectable pour les tests. */
export interface BackupSession {
  q: Query;
  cursor: (sql: string, params: unknown[], batch?: number) => AsyncIterable<Array<Record<string, unknown>>>;
  info: { isolation: string; at: string; snapshot: string | null };
  close(): Promise<void>;
}

export interface BackupOptions {
  label?: string | null;
  adminUserId?: number | null;
  /** Tests : session et stockage simulés, horloge. */
  openSession?: () => Promise<BackupSession>;
  storage?: { client: Pick<S3Client, 'send'>; bucket: string };
  now?: () => Date;
  /** Progression (BO). */
  onTable?: (table: string, rows: number, index: number, total: number) => void;
}

/** Client du profil `worker` de la configuration centrale (APP-PERF-26). */
function s3(): S3Client {
  return getS3Client('worker');
}

function bucket(): string {
  return getS3Bucket();
}

/** Horodatage utilisable dans une clé : 2026-09-17T02-00-00Z. */
function horodatage(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

async function sessionParDefaut(): Promise<BackupSession> {
  const { openReadSession } = await import('@/services/admin/account-data/session');
  const s = await openReadSession();
  // Une table volumineuse est lue par lots : délai par lecture élargi pour la sauvegarde.
  await s.q(`SET LOCAL statement_timeout = ${SAUVEGARDE_STATEMENT_TIMEOUT_MS}`);
  return s;
}

async function listerTables(q: Query): Promise<string[]> {
  const rows = await q(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return rows.map((r) => String(r.table_name)).filter((t) => !BACKUP_EXCLUDED_TABLES.includes(t));
}

const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** Produit une sauvegarde complète (format 2) et renvoie son manifeste. */
export async function runDatabaseBackup(
  trigger: BackupManifest['trigger'],
  opts: BackupOptions = {},
): Promise<BackupManifestV2> {
  const now = opts.now ?? (() => new Date());
  const debut = now();
  const stamp = horodatage(debut);
  const dataKey = `${BACKUP_PREFIX}${stamp}/data.ndjson.gz`;
  const storage = opts.storage ?? { client: s3(), bucket: bucket() };
  const session = await (opts.openSession ?? sessionParDefaut)();
  const tables: BackupManifestV2['tables'] = [];
  let envoi: Awaited<ReturnType<typeof openGzipUpload>> | null = null;
  let resultat: { compressedBytes: number; bytes: number; sha256: string };
  let schema: BackupManifestV2['schema'];
  try {
    // Tout est lu dans l'instantané de la session : liste, signature, lignes.
    const noms = await listerTables(session.q);
    const signature = await readSchemaSignature(session.q);
    const [derniere] = await session.q(`SELECT CASE WHEN to_regclass('_migrations') IS NULL THEN NULL ELSE (SELECT max(filename) FROM _migrations) END AS m`).catch(() => [{ m: null }]);
    schema = { fingerprint: signatureFingerprint(Object.fromEntries(noms.map((t) => [t, signature[t] ?? []]))), lastMigration: derniere?.m == null ? null : String(derniere.m) };
    envoi = await openGzipUpload(storage.client, storage.bucket, dataKey);
    for (const [i, table] of noms.entries()) {
      let lignes = 0;
      const prefixe = `{"t":${JSON.stringify(table)},"r":`;
      // Nom issu d'information_schema ; échappé malgré tout. Texte JSON de PostgreSQL, jamais reconverti.
      for await (const lot of session.cursor(`SELECT row_to_json(t)::text AS r FROM ${ident(table)} t`, [], LOT_LIGNES)) {
        let bloc = '';
        for (const r of lot) bloc += `${prefixe}${String(r.r)}}\n`;
        await envoi.write(bloc);
        lignes += lot.length;
      }
      tables.push({ name: table, rows: lignes, columns: signature[table] ?? [] });
      opts.onTable?.(table, lignes, i + 1, noms.length);
    }
    resultat = await envoi.finish();
  } catch (e) {
    await envoi?.abort();
    throw e;
  } finally {
    await session.close().catch(() => undefined);
  }

  const finAt = now();
  const manifest: BackupManifestV2 = {
    version: 2,
    format: 'ndjson-row_to_json',
    backupId: randomUUID(),
    label: opts.label?.trim() ? opts.label.trim().slice(0, 500) : null,
    startedAt: debut.toISOString(),
    finishedAt: finAt.toISOString(),
    durationMs: finAt.getTime() - debut.getTime(),
    dataKey,
    sizeBytes: resultat.compressedBytes,
    rawBytes: resultat.bytes,
    sha256: resultat.sha256,
    snapshot: { isolation: session.info.isolation, at: session.info.at, snapshot: session.info.snapshot },
    schema,
    tables,
    totalRows: tables.reduce((t, x) => t + x.rows, 0),
    trigger,
    adminUserId: opts.adminUserId ?? null,
    environment: process.env.NEXT_PUBLIC_APP_ENV || 'unknown',
  };

  // Le manifeste en dernier : il atteste une sauvegarde complète.
  await storage.client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: `${BACKUP_PREFIX}${stamp}.json`,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
  }));

  console.info(
    `[backup] sauvegarde ${stamp} (${manifest.backupId}) : ${manifest.tables.length} tables, ${manifest.totalRows} lignes, ` +
    `${Math.round(manifest.sizeBytes / 1024)} Ko en ${Math.round(manifest.durationMs / 1000)} s (${trigger})`,
  );

  await purgerAnciennesSauvegardes(storage.client as S3Client, storage.bucket).catch((e: Error) =>
    console.error('[backup] purge des anciennes sauvegardes impossible :', e.message),
  );

  return manifest;
}

export interface BackupListItem {
  key: string;
  date: string;
  sizeBytes: number | null;
  totalRows: number | null;
  tables: number | null;
  durationMs: number | null;
  trigger: string | null;
  /** Lot 82E : format (1 historique, 2 point de restauration), identifiant, libellé. */
  version: number | null;
  backupId: string | null;
  label: string | null;
  snapshotAt: string | null;
  adminUserId: number | null;
}

type Storage = NonNullable<BackupOptions['storage']>;
const stockage = (st?: Storage): Storage => st ?? { client: s3(), bucket: bucket() };

/** Clés des manifestes (`backups/<horodatage>.json`), toutes pages lues, du plus récent au plus ancien. */
async function clesManifestes(st: Storage): Promise<Array<{ key: string; modified: number }>> {
  const out: Array<{ key: string; modified: number }> = [];
  let token: string | undefined;
  do {
    const r = await st.client.send(new ListObjectsV2Command({ Bucket: st.bucket, Prefix: BACKUP_PREFIX, ContinuationToken: token })) as {
      Contents?: Array<{ Key?: string; LastModified?: Date }>; IsTruncated?: boolean; NextContinuationToken?: string;
    };
    for (const o of r.Contents ?? []) if (o.Key && /^backups\/[^/]+\.json$/.test(o.Key)) out.push({ key: o.Key, modified: o.LastModified?.getTime() ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  // L'horodatage est dans la clé : ordre stable même si les dates de dépôt sont égales.
  return out.sort((x, y) => (y.key > x.key ? 1 : y.key < x.key ? -1 : y.modified - x.modified));
}

async function lireManifeste(st: Storage, key: string): Promise<BackupManifest> {
  const obj = await st.client.send(new GetObjectCommand({ Bucket: st.bucket, Key: key })) as { Body?: { transformToString(): Promise<string> } };
  return JSON.parse(await obj.Body!.transformToString()) as BackupManifest;
}

/** Sauvegardes complètes (manifestes), la plus récente en premier. */
export async function listDatabaseBackups(limit = 60, storage?: Storage): Promise<Array<BackupListItem & { manifest: BackupManifest | null }>> {
  const st = stockage(storage);
  const manifestes = (await clesManifestes(st)).slice(0, limit);
  return Promise.all(manifestes.map(async (o) => {
    const base: BackupListItem & { manifest: BackupManifest | null } = {
      key: o.key,
      date: new Date(o.modified).toISOString(),
      sizeBytes: null, totalRows: null, tables: null, durationMs: null, trigger: null,
      version: null, backupId: null, label: null, snapshotAt: null, adminUserId: null, manifest: null,
    };
    try {
      const m = await lireManifeste(st, o.key);
      const v2 = m.version === 2 ? m : null;
      return {
        ...base,
        date: m.finishedAt ?? base.date,
        sizeBytes: m.sizeBytes ?? null,
        totalRows: m.totalRows ?? null,
        tables: m.tables?.length ?? null,
        durationMs: m.durationMs ?? null,
        trigger: m.trigger ?? null,
        version: m.version ?? 1,
        backupId: v2?.backupId ?? null,
        label: v2?.label ?? null,
        snapshotAt: v2?.snapshot?.at ?? null,
        adminUserId: v2?.adminUserId ?? null,
        manifest: m,
      };
    } catch {
      return base;
    }
  }));
}

/** Manifeste d'un point de restauration (format 2) par son identifiant ; null : introuvable. */
export async function findBackupManifest(backupId: string, storage?: Storage): Promise<BackupManifestV2 | null> {
  const st = stockage(storage);
  for (const o of await clesManifestes(st)) {
    try {
      const m = await lireManifeste(st, o.key);
      if (m.version === 2 && m.backupId === backupId) return m;
    } catch { /* manifeste illisible : ignoré */ }
  }
  return null;
}

/** Contenu (compressé) d'une sauvegarde, en flux. */
export async function openBackupData(m: Pick<BackupManifestV2, 'dataKey'>, storage?: Storage): Promise<NodeJS.ReadableStream> {
  const st = stockage(storage);
  const obj = await st.client.send(new GetObjectCommand({ Bucket: st.bucket, Key: m.dataKey })) as { Body?: unknown };
  if (!obj.Body) throw new Error(`sauvegarde ${m.dataKey} : contenu absent`);
  return obj.Body as NodeJS.ReadableStream;
}

/**
 * Date du dernier manifeste de sauvegarde (écrit en dernier sous `backups/`).
 *
 * `undefined` = état inconnu (identifiants absents, stockage injoignable ou
 * trop lent) : l'appelant ne doit RIEN conclure — surtout pas « aucune
 * sauvegarde ». `null` = stockage lu, aucune sauvegarde.
 *
 * Déplacée depuis `/api/admin/dashboard` : le contrôle d'ancienneté tourne
 * aussi chaque jour dans `daily-maintenance-scheduler`, sans attendre qu'un
 * administrateur ouvre la Supervision.
 */
export async function latestBackupAt(timeoutMs = 5000): Promise<Date | null | undefined> {
  if (!isS3Configured()) return undefined;
  try {
    const result = await Promise.race([
      s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: BACKUP_PREFIX, MaxKeys: 1000 })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!result) return undefined;
    const dates = (result.Contents ?? [])
      .filter((o) => o.Key?.endsWith('.json') && o.LastModified)
      .map((o) => o.LastModified!.getTime());
    return dates.length ? new Date(Math.max(...dates)) : null;
  } catch (error) {
    console.error('[backup] lecture des sauvegardes impossible :', (error as Error).message);
    return undefined;
  }
}

/** Supprime les sauvegardes plus anciennes que la durée de rétention. */
async function purgerAnciennesSauvegardes(client: S3Client, bucketName: string = bucket()): Promise<number> {
  const limite = Date.now() - RETENTION_JOURS * 24 * 60 * 60 * 1000;
  let supprimes = 0;
  let token: string | undefined;
  do {
    const r = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: BACKUP_PREFIX,
      ContinuationToken: token,
    }));
    const anciens = (r.Contents ?? [])
      .filter((o) => o.Key && o.LastModified && o.LastModified.getTime() < limite)
      .map((o) => ({ Key: o.Key! }));
    if (anciens.length > 0) {
      await client.send(new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: anciens, Quiet: true },
      }));
      supprimes += anciens.length;
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  if (supprimes > 0) console.info(`[backup] ${supprimes} objet(s) de plus de ${RETENTION_JOURS} jours supprimé(s)`);
  return supprimes;
}
