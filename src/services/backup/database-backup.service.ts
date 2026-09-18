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
 *                                         {"t":"<table>","r":{…}}
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
 * ⚠️ Ce n'est pas un `pg_dump`. Pour une restauration complète (séquences,
 * index, contraintes), le schéma se recrée par les migrations du dépôt,
 * puis les lignes se réinjectent table par table. La sauvegarde de
 * l'hébergeur, si elle existe, reste la première ligne de défense.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createGzip } from 'zlib';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { db } from '@/db';

export const BACKUP_PREFIX = 'backups/';
/** Nombre de jours conservés. */
const RETENTION_JOURS = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 30);
/** Taille d'une partie envoyée (S3 impose au moins 5 Mo, sauf la dernière). */
const TAILLE_PARTIE = 8 * 1024 * 1024;
/** Lignes lues par tour de curseur. */
const LOT_LIGNES = 500;
/** Tables exclues : volumineuses et reconstituables, ou purement techniques. */
const TABLES_EXCLUES = new Set(['_migrations', 'job_locks']);

export interface BackupManifest {
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

function s3(): S3Client {
  return new S3Client({
    region: process.env.OVH_S3_REGION || 'gra',
    endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
    credentials: {
      accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
    },
    forcePathStyle: true,
  });
}

function bucket(): string {
  return process.env.OVH_S3_BUCKET || 'verebona-files';
}

/** Horodatage utilisable dans une clé : 2026-09-17T02-00-00Z. */
function horodatage(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/** Valeurs que JSON ne sait pas écrire : un BigInt ferait échouer toute la sauvegarde. */
function versJson(_cle: string, valeur: unknown): unknown {
  if (typeof valeur === 'bigint') return valeur.toString();
  if (valeur instanceof Uint8Array) return { $binary: Buffer.from(valeur).toString('base64') };
  return valeur;
}

async function listerTables(): Promise<string[]> {
  const rows = await db.$client<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((r) => r.table_name).filter((t) => !TABLES_EXCLUES.has(t));
}

/**
 * Envoi en plusieurs parties d'un flux compressé.
 * Les morceaux produits par gzip sont accumulés jusqu'à `TAILLE_PARTIE`.
 */
class EnvoiMultipartie {
  private tampon: Buffer[] = [];
  private tailleTampon = 0;
  private parties: { ETag: string; PartNumber: number }[] = [];
  private uploadId: string | null = null;
  total = 0;

  constructor(private readonly client: S3Client, private readonly key: string) {}

  async demarrer(): Promise<void> {
    const r = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: bucket(),
      Key: this.key,
      ContentType: 'application/gzip',
    }));
    if (!r.UploadId) throw new Error('UploadId absent');
    this.uploadId = r.UploadId;
  }

  async ajouter(morceau: Buffer): Promise<void> {
    this.tampon.push(morceau);
    this.tailleTampon += morceau.length;
    if (this.tailleTampon >= TAILLE_PARTIE) await this.vider();
  }

  private async vider(): Promise<void> {
    if (this.tailleTampon === 0) return;
    const corps = Buffer.concat(this.tampon);
    this.tampon = [];
    this.tailleTampon = 0;
    const numero = this.parties.length + 1;
    const r = await this.client.send(new UploadPartCommand({
      Bucket: bucket(),
      Key: this.key,
      UploadId: this.uploadId!,
      PartNumber: numero,
      Body: corps,
    }));
    if (!r.ETag) throw new Error(`ETag absent pour la partie ${numero}`);
    this.parties.push({ ETag: r.ETag, PartNumber: numero });
    this.total += corps.length;
  }

  async terminer(): Promise<void> {
    await this.vider();
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: this.key,
      UploadId: this.uploadId!,
      MultipartUpload: { Parts: this.parties },
    }));
  }

  async annuler(): Promise<void> {
    if (!this.uploadId) return;
    await this.client.send(new AbortMultipartUploadCommand({
      Bucket: bucket(),
      Key: this.key,
      UploadId: this.uploadId,
    })).catch(() => undefined);
  }
}

/** Produit une sauvegarde complète et renvoie son manifeste. */
export async function runDatabaseBackup(
  trigger: BackupManifest['trigger'],
): Promise<BackupManifest> {
  const debut = new Date();
  const stamp = horodatage(debut);
  const dataKey = `${BACKUP_PREFIX}${stamp}/data.ndjson.gz`;
  const client = s3();
  const envoi = new EnvoiMultipartie(client, dataKey);
  const gzip = createGzip({ level: 6 });
  const tables: BackupManifest['tables'] = [];

  // Les morceaux compressés sont envoyés dans l'ordre, un à la fois.
  let chaine: Promise<void> = Promise.resolve();
  let erreurEnvoi: Error | null = null;
  gzip.on('data', (morceau: Buffer) => {
    chaine = chaine.then(() => envoi.ajouter(morceau)).catch((e: Error) => { erreurEnvoi = e; });
  });
  const fini = new Promise<void>((resolve, reject) => {
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });
  const ecrire = (ligne: string) =>
    new Promise<void>((resolve) => {
      if (gzip.write(ligne)) resolve();
      else gzip.once('drain', resolve);
    });

  await envoi.demarrer();
  try {
    for (const table of await listerTables()) {
      let lignes = 0;
      // Nom issu d'information_schema ; échappé malgré tout.
      const cursor = db.$client`SELECT * FROM ${db.$client(table)}`.cursor(LOT_LIGNES);
      for await (const lot of cursor) {
        let bloc = '';
        for (const r of lot) bloc += JSON.stringify({ t: table, r }, versJson) + '\n';
        await ecrire(bloc);
        // Contre-pression : on attend que les parties déjà produites soient
        // envoyées, pour que la mémoire ne grossisse pas si le stockage est lent.
        await chaine;
        lignes += lot.length;
        if (erreurEnvoi) throw erreurEnvoi;
      }
      tables.push({ name: table, rows: lignes });
    }
    gzip.end();
    await fini;
    await chaine;
    if (erreurEnvoi) throw erreurEnvoi;
    await envoi.terminer();
  } catch (e) {
    gzip.destroy();
    await envoi.annuler();
    throw e;
  }

  const finAt = new Date();
  const manifest: BackupManifest = {
    version: 1,
    startedAt: debut.toISOString(),
    finishedAt: finAt.toISOString(),
    durationMs: finAt.getTime() - debut.getTime(),
    dataKey,
    sizeBytes: envoi.total,
    tables,
    totalRows: tables.reduce((t, x) => t + x.rows, 0),
    trigger,
    environment: process.env.NEXT_PUBLIC_APP_ENV || 'unknown',
  };

  // Le manifeste en dernier : il atteste une sauvegarde complète.
  await client.send(new PutObjectCommand({
    Bucket: bucket(),
    Key: `${BACKUP_PREFIX}${stamp}.json`,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
  }));

  console.info(
    `[backup] sauvegarde ${stamp} : ${manifest.tables.length} tables, ${manifest.totalRows} lignes, ` +
    `${Math.round(manifest.sizeBytes / 1024)} Ko en ${Math.round(manifest.durationMs / 1000)} s (${trigger})`,
  );

  await purgerAnciennesSauvegardes(client).catch((e: Error) =>
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
}

/** Sauvegardes complètes (manifestes), la plus récente en premier. */
export async function listDatabaseBackups(limit = 60): Promise<BackupListItem[]> {
  const client = s3();
  const r = await client.send(new ListObjectsV2Command({
    Bucket: bucket(),
    Prefix: BACKUP_PREFIX,
    MaxKeys: 1000,
  }));
  const manifestes = (r.Contents ?? [])
    .filter((o) => o.Key && /^backups\/[^/]+\.json$/.test(o.Key))
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
    .slice(0, limit);

  return Promise.all(manifestes.map(async (o): Promise<BackupListItem> => {
    const base: BackupListItem = {
      key: o.Key!,
      date: (o.LastModified ?? new Date(0)).toISOString(),
      sizeBytes: null, totalRows: null, tables: null, durationMs: null, trigger: null,
    };
    try {
      const obj = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: o.Key! }));
      const m = JSON.parse(await obj.Body!.transformToString()) as BackupManifest;
      return {
        ...base,
        date: m.finishedAt ?? base.date,
        sizeBytes: m.sizeBytes ?? null,
        totalRows: m.totalRows ?? null,
        tables: m.tables?.length ?? null,
        durationMs: m.durationMs ?? null,
        trigger: m.trigger ?? null,
      };
    } catch {
      return base;
    }
  }));
}

/** Supprime les sauvegardes plus anciennes que la durée de rétention. */
async function purgerAnciennesSauvegardes(client: S3Client): Promise<number> {
  const limite = Date.now() - RETENTION_JOURS * 24 * 60 * 60 * 1000;
  let supprimes = 0;
  let token: string | undefined;
  do {
    const r = await client.send(new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: BACKUP_PREFIX,
      ContinuationToken: token,
    }));
    const anciens = (r.Contents ?? [])
      .filter((o) => o.Key && o.LastModified && o.LastModified.getTime() < limite)
      .map((o) => ({ Key: o.Key! }));
    if (anciens.length > 0) {
      await client.send(new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: anciens, Quiet: true },
      }));
      supprimes += anciens.length;
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  if (supprimes > 0) console.info(`[backup] ${supprimes} objet(s) de plus de ${RETENTION_JOURS} jours supprimé(s)`);
  return supprimes;
}
