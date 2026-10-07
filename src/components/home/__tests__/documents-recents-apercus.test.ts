/**
 * Lot 26, point 16 — aperçus des « Documents récents » de l'accueil.
 *
 *   AC16-1 : la carte montre la miniature serveur (chargement paresseux,
 *            décodage asynchrone), comme « Mes documents » ;
 *   AC16-2 : sans aperçu : l'icône, sans aucune requête d'image ;
 *   AC16-3 : l'aperçu vient du résumé (une requête pour toutes les cartes) :
 *            miniature prête de la version courante → URL signée ; absente
 *            ou périmée → icône et génération demandée (rattrapage) ;
 *            échec → icône, jamais d'erreur du résumé ;
 *   AC16-4 : au plus UNE signature par dérivé et par heure (mémorisée),
 *            URL stable pendant l'heure, différente l'heure suivante.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('next/navigation', () => ({
  usePathname: () => '/accueil',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
// Le service est importé pour sa fonction pure : aucune connexion.
vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { RecentDocuments } = await import('../HomeBlocks');
const { recentDocumentPreviews } = await import('@/services/home/HomeSummaryService');
const { signedThumbnailUrl, resetThumbnailUrlMemo, thumbnailUrlStats, THUMBNAIL_SIGNING_WINDOW_MS } =
  await import('@/services/documents/thumbnails/thumbnail-url');
const { documentThumbnailKey } = await import('@/services/documents/thumbnails/thumbnail-spec');

(globalThis as { React?: typeof React }).React = React;
const noop = () => {};

const doc = (id: number, extra: Record<string, unknown> = {}) => ({
  id, title: `Document ${id}`, assetId: null, assetName: null, typeLabel: 'Facture', date: '2026-10-01', status: null, tone: 'slate' as const, ...extra,
});

describe('rendu des cartes (AC16-1, AC16-2)', () => {
  it('AC16-1 — aperçu : miniature paresseuse, page posée comme dans Mes documents', () => {
    const html = renderToStaticMarkup(h(RecentDocuments, { onUpload: noop, docs: [doc(1, { previewUrl: 'https://s3/derivatives/thumbnails/a_1/f_1/list-x.webp?X-Amz-Signature=s' }), doc(2)] }));
    // Bureau (tuile) et mobile (ligne) : la même URL, jamais l'original.
    expect(html.match(/src="https:\/\/s3\/derivatives\/thumbnails\/a_1\/f_1\/list-x\.webp/g)).toHaveLength(2);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).not.toContain('/proxy');
    expect(html).not.toContain('/api/files/1/view');
  });

  it('AC16-2 — sans aperçu : l’icône, aucune image demandée', () => {
    const html = renderToStaticMarkup(h(RecentDocuments, { onUpload: noop, docs: [doc(2), doc(3, { previewUrl: null, status: 'En analyse' })] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('lucide-file-text');
    expect(html).toContain('En analyse');
  });

  it('AC16-2 — repli en échec : route autorisée (re-signature), puis l’icône', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/home/HomeBlocks.tsx'), 'utf-8');
    expect(src).toMatch(/step === 1 \? `\/api\/files\/\$\{doc\.id\}\/thumbnail`/);
    expect(src).toMatch(/onError=\{\(\) => setStep\(\(x\) => \(x === 0 \? 1 : 2\)\)\}/);
  });
});

describe('aperçus calculés par le résumé (AC16-3)', () => {
  const base = {
    s3Key: 'accounts/1/a.pdf', mimeType: 'application/pdf', fileExtension: 'pdf', originalFilename: 'a.pdf', isWebLink: false,
    thumbStatus: null as string | null, thumbSourceKey: null as string | null, thumbS3Key: null as string | null,
    thumbAttempts: null as number | null, thumbLeaseUntil: null as Date | null, thumbUpdatedAt: null as Date | null,
  };
  const deps = () => {
    const signed: string[] = [];
    const queued: number[] = [];
    return {
      signed, queued,
      d: { enabled: () => true, sign: async (k: string) => { signed.push(k); return `https://s3/${k}?sig`; }, enqueue: (id: number) => { queued.push(id); } },
    };
  };

  it('prête et de la version courante → URL signée ; absente → génération demandée ; périmée → génération ; non éligible → rien', async () => {
    const x = deps();
    const now = new Date();
    const out = await recentDocumentPreviews([
      { ...base, id: 1, thumbStatus: 'READY', thumbSourceKey: 'accounts/1/a.pdf', thumbS3Key: 'derivatives/t1.webp', thumbAttempts: 1, thumbUpdatedAt: now },
      { ...base, id: 2 },
      { ...base, id: 3, thumbStatus: 'READY', thumbSourceKey: 'accounts/1/ANCIEN.pdf', thumbS3Key: 'derivatives/old.webp', thumbAttempts: 1, thumbUpdatedAt: now },
      { ...base, id: 4, mimeType: 'application/vnd.ms-excel', fileExtension: 'xls', originalFilename: 'b.xls' },
      { ...base, id: 5, isWebLink: true, s3Key: null },
      { ...base, id: 6, thumbStatus: 'UNSUPPORTED', thumbSourceKey: 'accounts/1/a.pdf', thumbAttempts: 1, thumbUpdatedAt: now },
    ], x.d);
    expect([...out.entries()]).toEqual([[1, 'https://s3/derivatives/t1.webp?sig']]);
    expect(x.signed).toEqual(['derivatives/t1.webp']); // jamais le dérivé périmé
    expect(x.queued.sort()).toEqual([2, 3]);
  });

  it('miniatures désactivées ou signature en échec : icône, sans erreur', async () => {
    const x = deps();
    const now = new Date();
    const prete = { ...base, id: 1, thumbStatus: 'READY', thumbSourceKey: 'accounts/1/a.pdf', thumbS3Key: 'd.webp', thumbAttempts: 1, thumbUpdatedAt: now };
    expect((await recentDocumentPreviews([prete], { ...x.d, enabled: () => false })).size).toBe(0);
    expect((await recentDocumentPreviews([prete], { ...x.d, sign: async () => { throw new Error('config'); } })).size).toBe(0);
    expect((await recentDocumentPreviews([prete], Promise.reject(new Error('import')))).size).toBe(0);
  });

  it('une seule lecture : la miniature est jointe dans la requête des documents récents (pas de N+1)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/home/HomeSummaryService.ts'), 'utf-8');
    expect(src).toMatch(/\.leftJoin\(assetFileThumbnails, and\(\s*eq\(assetFileThumbnails\.fileId, assetFiles\.id\),\s*eq\(assetFileThumbnails\.variant, THUMBNAIL_VARIANT\)/);
    expect(src).not.toMatch(/getThumbnailRow/);
  });
});

describe('signature mémorisée (AC16-4)', () => {
  beforeEach(() => resetThumbnailUrlMemo());

  it('une signature par dérivé et par heure ; même URL pour la route et l’accueil', async () => {
    const sign = vi.fn(async (o: { key: string; signingDate?: Date }) => `https://s3/${o.key}?date=${o.signingDate!.toISOString()}`);
    const key = documentThumbnailKey(1, 2, 'accounts/1/a.pdf');
    const t = Date.UTC(2026, 9, 6, 14, 10);
    const a = await signedThumbnailUrl(key, t, sign as never);
    const b = await signedThumbnailUrl(key, t + 20 * 60_000, sign as never);
    expect(b).toBe(a);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toMatchObject({ expiresIn: 7200, responseContentType: 'image/webp', responseCacheControl: 'private, max-age=3600' });
    expect(thumbnailUrlStats()).toMatchObject({ signed: 1, reused: 1 });
    const c = await signedThumbnailUrl(key, t + THUMBNAIL_SIGNING_WINDOW_MS, sign as never);
    expect(c).not.toBe(a);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('la route de Mes documents signe par le même module', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/files/[id]/thumbnail/route.ts'), 'utf-8');
    expect(route).toMatch(/signedThumbnailUrl\(decision\.s3Key\)/);
    expect(route).not.toMatch(/signGetUrl\(/);
  });

  it('rattrapage automatique des documents existants : tâche horaire interne (aucune commande)', () => {
    const sched = readFileSync(join(process.cwd(), 'src/services/scheduling/daily-maintenance-scheduler.ts'), 'utf-8');
    expect(sched).toMatch(/lock: 'hourly-thumbnails-backfill'/);
    expect(sched).toMatch(/runThumbnailBackfill\(\{ limit: 100 \}\)/);
    const confirm = readFileSync(join(process.cwd(), 'src/app/api/files/confirm/route.ts'), 'utf-8');
    expect(confirm).toMatch(/enqueueThumbnails\(/);
  });
});
