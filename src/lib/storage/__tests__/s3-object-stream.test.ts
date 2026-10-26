/**
 * APP-PERF-13 — relais en flux borné (Range, annulation, erreurs typées).
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRangeHeader, streamS3Object, type S3GetFn, type S3GetInput } from '@/lib/storage/s3-object-stream';

function corpsCompte(chunks: number, taille = 1024) {
  const etat = { lus: 0, detruit: false };
  const r = new Readable({
    highWaterMark: taille, // une lecture amont ≈ un morceau
    read() {
      if (etat.lus >= chunks) { this.push(null); return; }
      etat.lus++;
      this.push(Buffer.alloc(taille, 0x61));
    },
    destroy(err, cb) { etat.detruit = true; cb(err); },
  });
  return { r, etat };
}

const req = (headers: Record<string, string> = {}, signal?: AbortSignal) => ({ headers: new Headers(headers), signal });

describe('parseRangeHeader', () => {
  it('plages simples relayées ; illisibles ou multiples ignorées', () => {
    expect(parseRangeHeader('bytes=0-99')).toMatchObject({ kind: 'range', header: 'bytes=0-99', start: 0, end: 99 });
    expect(parseRangeHeader('bytes=100-')).toMatchObject({ kind: 'range', start: 100, end: null });
    expect(parseRangeHeader('bytes=-500')).toMatchObject({ kind: 'range', start: null, end: 500 });
    expect(parseRangeHeader(null).kind).toBe('none');
    expect(parseRangeHeader('bytes=5-2').kind).toBe('none');
    expect(parseRangeHeader('bytes=0-1,4-5').kind).toBe('none');
    expect(parseRangeHeader('items=0-1').kind).toBe('none');
    expect(parseRangeHeader('bytes=-').kind).toBe('none');
  });
});

describe('streamS3Object', () => {
  it('CA-01 : réponse en flux, sans lire tout l’objet avant de répondre (contre-pression)', async () => {
    const { r, etat } = corpsCompte(200);
    const get: S3GetFn = async () => ({ Body: r, ContentLength: 200 * 1024, ETag: '"e1"', $metadata: { httpStatusCode: 200 } });
    const res = await streamS3Object({ bucket: 'b', key: 'k', request: req(), get, contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(200 * 1024));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('etag')).toBe('"e1"');
    await new Promise((ok) => setTimeout(ok, 20));
    // Rien n'a été consommé : l'amont n'a lu que son tampon initial.
    expect(etat.lus).toBeLessThan(10);
    const reader = res.body!.getReader();
    const premier = await reader.read();
    expect(premier.value?.length).toBe(1024);
    expect(etat.lus).toBeLessThan(10);
    // Client parti : flux annulé → corps S3 détruit.
    await reader.cancel();
    expect(etat.detruit).toBe(true);
    expect(etat.lus).toBeLessThan(200);
  });

  it('lecture complète : tous les octets, dans l’ordre', async () => {
    const { r } = corpsCompte(5, 10);
    const get: S3GetFn = async () => ({ Body: r, ContentLength: 50, $metadata: { httpStatusCode: 200 } });
    const res = await streamS3Object({ bucket: 'b', key: 'k', request: req(), get, contentType: 'image/png' });
    expect((await res.arrayBuffer()).byteLength).toBe(50);
  });

  it('T-02 : Range valide → Range relayé, 206 + Content-Range', async () => {
    const vus: S3GetInput[] = [];
    const get: S3GetFn = async (input) => {
      vus.push(input);
      return { Body: Readable.from([Buffer.alloc(100)]), ContentLength: 100, ContentRange: 'bytes 0-99/5000', $metadata: { httpStatusCode: 206 } };
    };
    const res = await streamS3Object({ bucket: 'b', key: 'k', request: req({ range: 'bytes=0-99' }), get, contentType: 'video/mp4' });
    expect(vus[0].Range).toBe('bytes=0-99');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/5000');
    expect(res.headers.get('content-length')).toBe('100');
  });

  it('T-02 : Range non satisfiable → 416 avec la taille ; illisible → 200 sans Range relayé', async () => {
    const get416: S3GetFn = async () => { throw Object.assign(new Error('x'), { name: 'InvalidRange', $metadata: { httpStatusCode: 416 } }); };
    const r416 = await streamS3Object({ bucket: 'b', key: 'k', request: req({ range: 'bytes=9000-' }), get: get416, contentType: 'x', knownSize: 5000 });
    expect(r416.status).toBe(416);
    expect(r416.headers.get('content-range')).toBe('bytes */5000');

    const vus: S3GetInput[] = [];
    const get: S3GetFn = async (input) => { vus.push(input); return { Body: Readable.from([Buffer.alloc(3)]), ContentLength: 3, $metadata: { httpStatusCode: 200 } }; };
    const r = await streamS3Object({ bucket: 'b', key: 'k', request: req({ range: 'bytes=abc' }), get, contentType: 'x' });
    expect(r.status).toBe(200);
    expect(vus[0].Range).toBeUndefined();
  });

  it('revalidation : If-None-Match relayé → 304', async () => {
    const get: S3GetFn = async (input) => {
      expect(input.IfNoneMatch).toBe('"e1"');
      throw Object.assign(new Error('not modified'), { name: '304', $metadata: { httpStatusCode: 304 } });
    };
    const res = await streamS3Object({ bucket: 'b', key: 'k', request: req({ 'if-none-match': '"e1"' }), get, contentType: 'x' });
    expect(res.status).toBe(304);
  });

  it('T-03 (stockage) : absent → 404, 403 → 502 typé, muet → 504, sans détail technique', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = (name: string, status?: number) => async () => { throw Object.assign(new Error(`https://s3/?X-Amz-Signature=zzz`), { name, $metadata: { httpStatusCode: status } }); };
    const r404 = await streamS3Object({ bucket: 'b', key: 'k', request: req(), get: err('NoSuchKey', 404), contentType: 'x' });
    expect(r404.status).toBe(404);
    const r403 = await streamS3Object({ bucket: 'b', key: 'k', request: req(), get: err('AccessDenied', 403), contentType: 'x' });
    expect(r403.status).toBe(502);
    const corps = await r403.text();
    expect(corps).toContain('STORAGE_ACCESS_DENIED');
    expect(corps).not.toContain('X-Amz-Signature');

    // Stockage muet : délai d'en-têtes dépassé → annulation propagée, 504.
    let signalRecu: AbortSignal | null = null;
    const muet: S3GetFn = (_i, signal) => new Promise((_, ko) => {
      signalRecu = signal;
      signal.addEventListener('abort', () => ko(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const r504 = await streamS3Object({ bucket: 'b', key: 'k', request: req(), get: muet, contentType: 'x', headersTimeoutMs: 30 });
    expect(r504.status).toBe(504);
    expect(signalRecu!.aborted).toBe(true);
  });

  it('client parti avant les en-têtes : requête S3 annulée', async () => {
    const ctrl = new AbortController();
    let signalRecu: AbortSignal | null = null;
    const get: S3GetFn = (_i, signal) => new Promise((_, ko) => {
      signalRecu = signal;
      signal.addEventListener('abort', () => ko(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const p = streamS3Object({ bucket: 'b', key: 'k', request: req({}, ctrl.signal), get, contentType: 'x' });
    ctrl.abort();
    const res = await p;
    expect(signalRecu!.aborted).toBe(true);
    expect(res.status).toBe(499);
  });

  it('CA-03 : erreur amont en cours de flux → flux en erreur (jamais annoncé complet)', async () => {
    let n = 0;
    const r = new Readable({ read() { n++; if (n === 1) this.push(Buffer.alloc(10)); else this.destroy(new Error('ECONNRESET')); } });
    const get: S3GetFn = async () => ({ Body: r, ContentLength: 1000, $metadata: { httpStatusCode: 200 } });
    const res = await streamS3Object({ bucket: 'b', key: 'k', request: req(), get, contentType: 'x' });
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});

describe('route proxy (source)', () => {
  const route = readFileSync(join(process.cwd(), 'src/app/api/files/[id]/proxy/route.ts'), 'utf-8');
  it('CA-01 : plus de Buffer.concat ni de jeton en paramètre d’URL ; garde commune', () => {
    expect(route).not.toMatch(/Buffer\.concat/);
    expect(route).not.toMatch(/searchParams\.get\('token'\)/);
    expect(route).toContain('loadReadableFile');
    expect(route).toContain('streamS3Object');
    expect(route).not.toMatch(/new S3Client/);
  });
});
