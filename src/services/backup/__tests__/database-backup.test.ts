/**
 * Sauvegarde — contenu réellement produit (stockage et session simulés).
 *
 * Lot 82E (format 2, point de restauration) : toutes les tables lues dans la
 * session de lecture cohérente (81C) ; texte JSON de PostgreSQL écrit tel
 * quel ; signature des colonnes ; manifeste en dernier, absent si échec.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { gunzipSync } from 'zlib';
import { createHash } from 'node:crypto';

// Configuration S3 canonique (APP-PERF-26) : client simulé ci-dessous, aucun appel réseau.
const envPose = vi.hoisted(() => {
  const valeurs: Record<string, string> = {
    OVH_S3_ENDPOINT: 'http://127.0.0.1:9', OVH_S3_BUCKET: 'test-bucket',
    OVH_S3_ACCESS_KEY_ID: 'test', OVH_S3_SECRET_ACCESS_KEY: 'test',
  };
  const poses = Object.keys(valeurs).filter((k) => process.env[k] === undefined);
  for (const k of poses) process.env[k] = valeurs[k];
  return poses;
});
afterAll(() => { for (const k of envPose) delete process.env[k]; });

import { runDatabaseBackup, findBackupManifest, listDatabaseBackups, type BackupSession } from '@/services/backup/database-backup.service';

type Envoi = { type: string; input: Record<string, unknown> };
const envois: Envoi[] = [];
const objets = new Map<string, string>();
const client = {
  async send(c: { constructor: { name: string }; input: Record<string, unknown> }) {
    const type = c.constructor.name.replace(/Command$/, '');
    envois.push({ type, input: c.input });
    if (type === 'CreateMultipartUpload') return { UploadId: 'up1' };
    if (type === 'UploadPart') return { ETag: `e${c.input.PartNumber}` };
    if (type === 'PutObject') { objets.set(String(c.input.Key), String(c.input.Body)); return {}; }
    if (type === 'ListObjectsV2') return { Contents: [...objets.keys()].map((Key, i) => ({ Key, LastModified: new Date(1_000 + i) })), IsTruncated: false };
    if (type === 'GetObject') return { Body: { transformToString: async () => objets.get(String(c.input.Key)) ?? '' } };
    return {};
  },
};
const storage = { client, bucket: 'test-bucket' };

/** Session simulée : tables, colonnes et texte `row_to_json` (chaînes, jamais reconverties). */
function session(tables: Record<string, string[]>, opts: { failOn?: string } = {}): BackupSession & { closed: boolean } {
  const s = {
    closed: false,
    info: { isolation: 'REPEATABLE READ, READ ONLY', at: '2026-10-23T10:00:00.000000Z', snapshot: '100:100:' },
    q: async (sql: string) => {
      if (sql.includes('FROM information_schema.tables')) return [...Object.keys(tables), '_migrations', 'job_locks'].map((table_name) => ({ table_name }));
      if (sql.includes('FROM information_schema.columns')) {
        return Object.keys(tables).flatMap((t) => [{ table_name: t, column_name: 'id', udt_name: 'int4', is_generated: 'NEVER' }]);
      }
      if (sql.includes('_migrations')) return [{ m: '0657_l82e_export_recette.sql' }];
      return [];
    },
    cursor: (sql: string, _p: unknown[], batch = 500) => ({
      async *[Symbol.asyncIterator]() {
        const t = /FROM "([^"]+)"/.exec(sql)![1];
        if (t === opts.failOn) throw new Error('connexion perdue');
        const rows = tables[t] ?? [];
        for (let i = 0; i < rows.length; i += batch) yield rows.slice(i, i + batch).map((r) => ({ r }));
      },
    }),
    close: async () => { s.closed = true; },
  };
  return s;
}

beforeEach(() => {
  envois.length = 0;
  objets.clear();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('runDatabaseBackup (format 2)', () => {
  it('L82E-BK-01 lit chaque table dans la session, écrit le texte exact de PostgreSQL, termine l’envoi, puis écrit le manifeste', async () => {
    const tables = {
      users: ['{"id":1,"email":"a@b.fr","created_at":"2026-10-23T10:00:00.123456+00:00"}', '{"id":2,"email":"c@d.fr","n":9007199254740993}'],
      assets: Array.from({ length: 1200 }, (_, i) => `{"id":${i},"name":"Bien ${i}","prix":12.50}`),
    };
    const s = session(tables);
    const m = await runDatabaseBackup('admin', { openSession: async () => s, storage, label: 'Avant campagne 1', adminUserId: 7 });

    expect(m.version).toBe(2);
    expect(m.backupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.label).toBe('Avant campagne 1');
    expect(m.adminUserId).toBe(7);
    expect(m.snapshot).toEqual(s.info);
    expect(m.tables.map((t) => [t.name, t.rows])).toEqual([['users', 2], ['assets', 1200]]);
    expect(m.tables[0].columns).toEqual(['id:int4']);
    expect(m.totalRows).toBe(1202);
    expect(m.schema.lastMigration).toBe('0657_l82e_export_recette.sql');
    expect(s.closed).toBe(true);

    const types = envois.map((e) => e.type);
    expect(types[0]).toBe('CreateMultipartUpload');
    expect(types.indexOf('CompleteMultipartUpload')).toBeLessThan(types.indexOf('PutObject'));

    // Contenu : texte exact (microsecondes, grand entier, numérique non reconvertis), relu ligne par ligne.
    const parties = envois.filter((e) => e.type === 'UploadPart').map((e) => e.input.Body as Buffer);
    const brut = gunzipSync(Buffer.concat(parties)).toString('utf-8');
    const lignes = brut.trim().split('\n');
    expect(lignes).toHaveLength(1202);
    expect(lignes[0]).toBe('{"t":"users","r":{"id":1,"email":"a@b.fr","created_at":"2026-10-23T10:00:00.123456+00:00"}}');
    expect(lignes[1]).toContain('"n":9007199254740993');
    expect(lignes[2]).toBe('{"t":"assets","r":{"id":0,"name":"Bien 0","prix":12.50}}');
    expect(lignes.some((l) => l.includes('"t":"_migrations"') || l.includes('"t":"job_locks"'))).toBe(false);
    expect(m.sha256).toBe(createHash('sha256').update(brut).digest('hex'));
    expect(m.rawBytes).toBe(Buffer.byteLength(brut));

    const manifeste = envois.find((e) => e.type === 'PutObject')!;
    expect(manifeste.input.Key).toMatch(/^backups\/[^/]+\.json$/);
    expect(JSON.parse(manifeste.input.Body as string).dataKey).toBe(m.dataKey);
  });

  it('L82E-BK-02 annule l’envoi, n’écrit aucun manifeste et ferme la session si la lecture échoue', async () => {
    const s = session({ users: ['{"id":1}'], casse: ['{"id":1}'] }, { failOn: 'casse' });
    await expect(runDatabaseBackup('admin', { openSession: async () => s, storage })).rejects.toThrow();
    const types = envois.map((e) => e.type);
    expect(types).toContain('AbortMultipartUpload');
    expect(types).not.toContain('PutObject');
    expect(s.closed).toBe(true);
  });

  it('L82E-BK-03 retrouve un point par son identifiant et liste les points (format, libellé, instant de cohérence)', async () => {
    const m = await runDatabaseBackup('admin', { openSession: async () => session({ users: ['{"id":1}'] }), storage, label: 'Point A' });
    objets.set('backups/2026-01-01T00-00-00Z.json', JSON.stringify({ version: 1, finishedAt: '2026-01-01T00:00:00Z', tables: [{ name: 'users', rows: 1 }], totalRows: 1, trigger: 'scheduler' }));
    expect((await findBackupManifest(m.backupId, storage))?.label).toBe('Point A');
    expect(await findBackupManifest('00000000-0000-0000-0000-000000000000', storage)).toBeNull();
    const l = await listDatabaseBackups(10, storage);
    expect(l.map((x) => [x.version, x.label])).toEqual([[2, 'Point A'], [1, null]]);
    expect(l[0].snapshotAt).toBe('2026-10-23T10:00:00.000000Z');
  });
});
