/**
 * Lot 75L — `/api/files/[id]/proxy` (aperçu en cadre, repli de lecture) :
 * l'en-tête `inline` porte le nom affiché dans Verebona (UTF-8 + ASCII).
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const captured = vi.hoisted(() => ({ disposition: '' as string | undefined }));
vi.mock('@/services/documents/file-access', () => ({
  loadReadableFile: async () => ({
    ok: true, accountId: 1, userId: 1,
    file: {
      id: 9, accountId: 1, s3Bucket: 'b', s3Key: 'verebona/u_1/a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6c.pdf',
      mimeType: 'application/pdf', size: 10, originalFilename: 'FACT_2026_001.pdf',
      retainedTitle: 'Facture entretien chaudière', filename: 'a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6c.pdf',
      publicId: 'a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6c', isWebLink: false,
    },
  }),
}));
vi.mock('@/lib/storage/s3-object-stream', () => ({
  streamS3Object: async (opts: { disposition?: string }) => {
    captured.disposition = opts.disposition;
    return new Response('x', { headers: { 'Content-Disposition': opts.disposition ?? '' } });
  },
}));
vi.mock('@/lib/s3-config', () => ({ getS3Client: () => ({ send: async () => ({}) }) }));

describe('L75L — proxy', () => {
  it('L75L-AC7 inline nommé : titre + extension, filename* UTF-8', async () => {
    const { GET } = await import('../[id]/proxy/route');
    const res = await GET(new NextRequest('http://x/api/files/9/proxy'), { params: Promise.resolve({ id: '9' }) });
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toBe(`inline; filename="Facture entretien chaudiere.pdf"; filename*=UTF-8''Facture%20entretien%20chaudi%C3%A8re.pdf`);
    expect(cd).not.toMatch(/a7f82c91/);
  });
});
