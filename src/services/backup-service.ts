import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { format } from 'date-fns';
import { execSync } from 'child_process';
import fs from 'fs';
import postgres from 'postgres';

const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || 'gra',
  endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true,
});

const bucketName = process.env.OVH_S3_BUCKET || 'verebona-files';

export interface BackupData {
  timestamp: string;
  version: string;
  triggeredBy: string;
  tables: Record<string, unknown[]>;
  metadata: {
    totalRows: number;
    tables: Record<string, number>;
  };
}

export class BackupService {
  static async listBackups() {
    const backups: {
      key: string;
      filename: string;
      size: number;
      lastModified: string;
      date: string;
      type: 'database' | 'code';
    }[] = [];

    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: 'backups/',
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const response = await s3Client.send(command);

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key && (obj.Key.endsWith('.json') || obj.Key.endsWith('.tar.gz'))) {
            const filename = obj.Key.replace('backups/', '');
            const isCode = obj.Key.endsWith('.tar.gz');

            const dateMatch = isCode
              ? filename.match(/code-backup-(\d{4}-\d{2}-\d{2})_/)
              : filename.match(/database-backup-(\d{4}-\d{2}-\d{2})_/);

            const date = dateMatch ? dateMatch[1] : 'Unknown';

            backups.push({
              key: obj.Key,
              filename,
              size: obj.Size || 0,
              lastModified: obj.LastModified?.toISOString() || '',
              date,
              type: isCode ? 'code' : 'database',
            });
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    backups.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    return backups;
  }

  static async backupCode(dateStr: string) {
    const tempFile = `/tmp/code-backup-${dateStr}.tar.gz`;
    const backupKey = `backups/code-backup-${dateStr}.tar.gz`;

    try {
      execSync(`tar -czf ${tempFile} --exclude='node_modules' --exclude='.next' --exclude='.git' --exclude='sqlite.db*' --exclude='.turbo' --exclude='dist' .`);

      const fileBuffer = fs.readFileSync(tempFile);

      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: backupKey,
          Body: fileBuffer,
          ContentType: 'application/x-gzip',
        })
      );

      fs.unlinkSync(tempFile);

      return {
        success: true,
        filename: backupKey,
        size: fileBuffer.length,
      };
    } catch (error) {
      console.error('Error backing up code:', error);
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      throw error;
    }
  }

  static async runBackup(triggeredBy: string = 'automatic') {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

    try {
      // Liste toutes les tables utilisateur (hors tables système Postgres)
      const tablesResult = await sql`
        SELECT tablename as name FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `;

      const backupTables = tablesResult.map(row => row.name as string);

      const backup: BackupData = {
        timestamp: new Date().toISOString(),
        version: '1.0',
        triggeredBy,
        tables: {},
        metadata: {
          totalRows: 0,
          tables: {},
        },
      };

      for (const table of backupTables) {
        try {
          const rows = await sql`SELECT * FROM ${sql(table)}`;
          backup.tables[table] = rows.map(row => ({ ...row }));
          backup.metadata.tables[table] = rows.length;
          backup.metadata.totalRows += rows.length;
        } catch (tableError) {
          console.error(`Error backing up table ${table}:`, tableError);
          backup.tables[table] = [];
          backup.metadata.tables[table] = 0;
        }
      }

      const dateStr = format(new Date(), 'yyyy-MM-dd_HH-mm-ss');
      const backupFileName = `backups/database-backup-${dateStr}.json`;
      const backupContent = JSON.stringify(backup, null, 2);

      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: backupFileName,
          Body: backupContent,
          ContentType: 'application/json',
        })
      );

      const codeBackupResult = await this.backupCode(dateStr);

      return {
        success: true,
        database: {
          filename: backupFileName,
          size: backupContent.length,
          totalRows: backup.metadata.totalRows,
          tables: Object.keys(backup.metadata.tables).length,
        },
        code: {
          filename: codeBackupResult.filename,
          size: codeBackupResult.size,
        }
      };
    } finally {
      await sql.end();
    }
  }
}
