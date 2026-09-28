/**
 * Sauvegarde — contenu réellement produit (stockage et base simulés).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gunzipSync } from 'zlib';

const { envois, tables, echecSur } = vi.hoisted(() => ({
  echecSur: { table: '' },
  envois: [] as Array<{ type: string; input: Record<string, unknown> }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock('@aws-sdk/client-s3', () => {
  const cmd = (type: string) => class { type = type; constructor(public input: Record<string, unknown>) {} };
  class S3Client {
    async send(c: { type: string; input: Record<string, unknown> }) {
      envois.push({ type: c.type, input: c.input });
      if (c.type === 'create') return { UploadId: 'up1' };
      if (c.type === 'part') return { ETag: `e${c.input.PartNumber}` };
      if (c.type === 'list') return { Contents: [], IsTruncated: false };
      return {};
    }
  }
  return {
    S3Client,
    CreateMultipartUploadCommand: cmd('create'),
    UploadPartCommand: cmd('part'),
    CompleteMultipartUploadCommand: cmd('complete'),
    AbortMultipartUploadCommand: cmd('abort'),
    PutObjectCommand: cmd('put'),
    ListObjectsV2Command: cmd('list'),
    DeleteObjectsCommand: cmd('delete'),
    GetObjectCommand: cmd('get'),
  };
});

vi.mock('@/db', () => {
  const $client = (first: unknown, ...values: unknown[]) => {
    // Identifiant : sql('table')
    if (typeof first === 'string') return { ident: first };
    const texte = (first as string[]).join('?');
    if (texte.includes('information_schema')) {
      const rows = Object.keys(tables).concat('_migrations').map((table_name) => ({ table_name }));
      return Promise.resolve(rows);
    }
    const nom = (values[0] as { ident: string }).ident;
    return {
      cursor: (taille: number) => ({
        async *[Symbol.asyncIterator]() {
          if (nom === echecSur.table) throw new Error('connexion perdue');
          const rows = tables[nom] ?? [];
          for (let i = 0; i < rows.length; i += taille) yield rows.slice(i, i + taille);
        },
      }),
    };
  };
  return { db: { $client } };
});

import { runDatabaseBackup } from '@/services/backup/database-backup.service';

beforeEach(() => {
  envois.length = 0;
  echecSur.table = '';
  for (const k of Object.keys(tables)) delete tables[k];
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('runDatabaseBackup', () => {
  it('exporte chaque table, termine l’envoi, puis écrit le manifeste', async () => {
    tables.users = [{ id: 1, email: 'a@b.fr' }, { id: 2, email: 'c@d.fr' }];
    tables.assets = Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `Bien ${i}` }));

    const m = await runDatabaseBackup('admin');

    expect(m.tables).toEqual([{ name: 'users', rows: 2 }, { name: 'assets', rows: 1200 }]);
    expect(m.totalRows).toBe(1202);

    const types = envois.map((e) => e.type);
    expect(types[0]).toBe('create');
    expect(types.indexOf('complete')).toBeLessThan(types.indexOf('put'));

    // Le contenu envoyé se relit ligne par ligne.
    const parties = envois.filter((e) => e.type === 'part').map((e) => e.input.Body as Buffer);
    const lignes = gunzipSync(Buffer.concat(parties)).toString('utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lignes).toHaveLength(1202);
    expect(lignes[0]).toEqual({ t: 'users', r: { id: 1, email: 'a@b.fr' } });
    // Tables techniques exclues.
    expect(lignes.some((l) => l.t === '_migrations')).toBe(false);

    const manifeste = envois.find((e) => e.type === 'put')!;
    expect(manifeste.input.Key).toMatch(/^backups\/[^/]+\.json$/);
    expect(JSON.parse(manifeste.input.Body as string).dataKey).toBe(m.dataKey);
  });

  it('écrit les BigInt et les binaires au lieu d’échouer', async () => {
    tables.compteurs = [{ id: BigInt('9007199254740993'), blob: new Uint8Array([1, 2]) }];
    await runDatabaseBackup('admin');
    const parties = envois.filter((e) => e.type === 'part').map((e) => e.input.Body as Buffer);
    const ligne = JSON.parse(gunzipSync(Buffer.concat(parties)).toString('utf-8').trim());
    expect(ligne.r).toEqual({ id: '9007199254740993', blob: { $binary: 'AQI=' } });
  });

  it('annule l’envoi et n’écrit aucun manifeste si la lecture échoue', async () => {
    tables.users = [{ id: 1 }];
    tables.casse = [{ id: 1 }];
    echecSur.table = 'casse';

    await expect(runDatabaseBackup('admin')).rejects.toThrow();
    const types = envois.map((e) => e.type);
    expect(types).toContain('abort');
    expect(types).not.toContain('put');
  });
});
