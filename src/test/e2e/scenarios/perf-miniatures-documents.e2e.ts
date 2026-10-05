/**
 * APP-PERF-06 / APP-PERF-27 — miniatures de documents sur PostgreSQL réel
 * (stockage simulé : aucun appel S3).
 *
 *  1. une génération par version, réutilisée (deux « appareils ») ;
 *  2. réservations concurrentes : une seule gagne ;
 *  3. route autorisée : redirection signée vers le dérivé ; autre compte,
 *     document supprimé → 404 ; absent → 404 PENDING ;
 *  4. remplacement du fichier : dérivé périmé jamais servi, régénéré sous une
 *     autre clé, ancien objet mis en file de purge ;
 *  5. purge du document : dérivé supprimé en cascade, objet en file de purge ;
 *  6. format illisible : UNSUPPORTED, pas de boucle de génération.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(JSON.stringify({ error: 'AUTH' }), { status: 401 }),
  },
}));

// File en mémoire neutralisée : la génération est pilotée par le test (stockage
// simulé), jamais lancée en arrière-plan contre un S3 réel.
const misesEnFile = vi.hoisted(() => [] as number[]);
vi.mock('@/services/documents/thumbnails/thumbnail.service', async (o) => ({
  ...(await o<object>()),
  enqueueThumbnail: (id: number) => { misesEnFile.push(id); return true; },
}));

scenario('PERF-06/27', 'Miniatures de documents (version, droits, purge)', ({ sql, make }) => {
  beforeAll(async () => {
    process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
    process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
    process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
    process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
    const { ensureMigrations } = await import('@/db');
    await ensureMigrations();
  });

  const stockage = () => {
    const objets = new Map<string, Buffer>();
    const puts: string[] = [];
    let png: Buffer | null = null;
    return {
      objets, puts,
      async source(b: Buffer) { png = b; },
      deps: {
        readObject: async () => { if (!png) throw Object.assign(new Error('absent'), { name: 'NoSuchKey' }); return png; },
        putObject: async (key: string, body: Buffer) => { puts.push(key); objets.set(key, body); },
        deleteObject: async (key: string) => { objets.delete(key); },
        renderPdf: async () => { throw new Error('non utilisé'); },
      },
    };
  };

  const photo = () => sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#88aa44' } }).jpeg().toBuffer();

  const fichierImage = async () => {
    const compte = await make.account();
    const f = await make.assetFile(compte, { name: `photo-${Date.now()}-${Math.random()}.jpg`, mimeType: 'image/jpeg' });
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED' WHERE id = ${f.id}`;
    return { compte, f };
  };

  const appelRoute = async (fileId: number, accountId: number, userId: number) => {
    session.currentAccountId = accountId;
    session.userId = userId;
    const { GET } = await import('@/app/api/files/[id]/thumbnail/route');
    const req = new NextRequest(`http://localhost/api/files/${fileId}/thumbnail`);
    return GET(req, { params: Promise.resolve({ id: String(fileId) }) });
  };

  it('1-3 : une génération par version, servie par redirection signée, refusée hors droits', async () => {
    const { generateThumbnail } = await import('@/services/documents/thumbnails/thumbnail.service');
    const { compte, f } = await fichierImage();
    const s = stockage();
    await s.source(await photo());

    // Avant génération : 404 PENDING (placeholder côté interface).
    const avant = await appelRoute(f.id, compte.id, compte.ownerUserId);
    expect(avant.status).toBe(404);
    expect(await avant.json()).toEqual({ status: 'PENDING' });
    expect(misesEnFile).toContain(f.id); // absence → génération demandée

    expect(await generateThumbnail(f.id, s.deps)).toBe('READY');
    // Second « appareil » / seconde demande : rien à refaire.
    expect(await generateThumbnail(f.id, s.deps)).toBe('SKIPPED_NOT_CLAIMED');
    expect(s.puts).toHaveLength(1);

    const [row] = await sql<{ status: string; s3_key: string; width: number; height: number; format: string; bytes: number }[]>`
      SELECT status, s3_key, width, height, format, bytes FROM asset_file_thumbnails WHERE file_id = ${f.id}`;
    expect(row).toMatchObject({ status: 'READY', width: 480, height: 360, format: 'image/webp' });
    expect(row.s3_key).toMatch(new RegExp(`^derivatives/thumbnails/a_${compte.id}/f_${f.id}/list-`));

    const ok = await appelRoute(f.id, compte.id, compte.ownerUserId);
    expect(ok.status).toBe(302);
    const loc = ok.headers.get('location')!;
    expect(loc).toContain(encodeURI(row.s3_key).replace(/\//g, '/'));
    expect(loc).toContain('X-Amz-Signature=');
    expect(ok.headers.get('cache-control')).toMatch(/^private/);
    // Deux affichages dans l'heure : même URL (cache navigateur réutilisable).
    expect((await appelRoute(f.id, compte.id, compte.ownerUserId)).headers.get('location')).toBe(loc);

    // Autre compte : 404, aucune fuite.
    const autre = await make.account();
    const refus = await appelRoute(f.id, autre.id, autre.ownerUserId);
    expect(refus.status).toBe(404);
    expect(refus.headers.get('location')).toBeNull();

    // Document supprimé : 404.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f.id}`;
    expect((await appelRoute(f.id, compte.id, compte.ownerUserId)).status).toBe(404);
  });

  it('2 : réservations concurrentes — une seule génération', async () => {
    const { claimThumbnail } = await import('@/services/documents/thumbnails/thumbnail.service');
    const { compte, f } = await fichierImage();
    const [src] = await sql<{ s3_key: string }[]>`SELECT s3_key FROM asset_files WHERE id = ${f.id}`;
    const source = { id: f.id, accountId: compte.id, s3Key: src.s3_key, s3Bucket: null, size: 10, kind: 'image' as const };
    const res = await Promise.all([claimThumbnail(source), claimThumbnail(source), claimThumbnail(source)]);
    expect(res.filter(Boolean)).toHaveLength(1);
    // Bail expiré (génération interrompue) : reprise possible.
    await sql`UPDATE asset_file_thumbnails SET lease_until = now() - interval '1 minute' WHERE file_id = ${f.id}`;
    expect(await claimThumbnail(source)).toMatchObject({ attempts: 2 });
  });

  it('4-5 : remplacement → nouvelle clé, ancien dérivé purgé ; purge du document → dérivé purgé', async () => {
    const { generateThumbnail, getThumbnailRow } = await import('@/services/documents/thumbnails/thumbnail.service');
    const { decideThumbnail } = await import('@/services/documents/thumbnails/thumbnail-spec');
    const { compte, f } = await fichierImage();
    const s = stockage();
    await s.source(await photo());
    expect(await generateThumbnail(f.id, s.deps)).toBe('READY');
    const ancienne = (await getThumbnailRow(f.id))!.s3Key!;

    await sql`UPDATE asset_files SET s3_key = ${`e2e/${compte.id}/remplace-${f.id}.jpg`} WHERE id = ${f.id}`;
    const row = await getThumbnailRow(f.id);
    expect(decideThumbnail(row, `e2e/${compte.id}/remplace-${f.id}.jpg`).action).toBe('generate');
    // Pendant ce temps, la route ne sert pas le dérivé périmé.
    expect((await appelRoute(f.id, compte.id, compte.ownerUserId)).status).toBe(404);

    expect(await generateThumbnail(f.id, s.deps)).toBe('READY');
    const nouvelle = (await getThumbnailRow(f.id))!.s3Key!;
    expect(nouvelle).not.toBe(ancienne);
    const enFile = await sql<{ storage_path: string }[]>`SELECT storage_path FROM pending_blob_deletions WHERE storage_path = ${ancienne}`;
    expect(enFile).toHaveLength(1);

    // Purge physique du document : cascade + file de purge.
    await sql`DELETE FROM asset_files WHERE id = ${f.id}`;
    expect(await sql`SELECT 1 FROM asset_file_thumbnails WHERE file_id = ${f.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM pending_blob_deletions WHERE storage_path = ${nouvelle} AND processed_at IS NULL`).toHaveLength(1);
  });

  it('6 : format illisible → UNSUPPORTED, sans boucle', async () => {
    const { generateThumbnail } = await import('@/services/documents/thumbnails/thumbnail.service');
    const { compte, f } = await fichierImage();
    const s = stockage();
    await s.source(Buffer.from('pas une image'));
    expect(await generateThumbnail(f.id, s.deps)).toBe('UNSUPPORTED');
    expect(await generateThumbnail(f.id, s.deps)).toBe('SKIPPED_NOT_CLAIMED');
    const r = await appelRoute(f.id, compte.id, compte.ownerUserId);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ status: 'UNSUPPORTED' });
    expect(s.puts).toHaveLength(0);
  });
});
