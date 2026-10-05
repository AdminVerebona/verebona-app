/**
 * APP-PERF-07 — rendus PDF navigateur : cache borné, concurrence bornée,
 * rendus partagés et annulés, purge au changement de contexte.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AbortError, LruCache, Semaphore, SharedTasks } from '../pdf-render-pool';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LruCache', () => {
  it('T-03 : éviction par nombre et par volume, du moins récemment utilisé', () => {
    const c = new LruCache<string>(3, 10, (v) => v.length);
    c.set('a', '111'); c.set('b', '222'); c.set('c', '333');
    c.get('a'); // a redevient récent
    c.set('d', '4');
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
    expect(c.stats).toEqual({ entries: 3, size: 7 });
    c.set('e', '55555'); // volume 12 > 10 → éviction de c (puis a si besoin)
    expect(c.stats.size).toBeLessThanOrEqual(10);
    expect(c.has('e')).toBe(true);
    c.set('trop', 'x'.repeat(11)); // plus gros que le cache : ignoré
    expect(c.has('trop')).toBe(false);
  });

  it('T-03 : purge complète', () => {
    const c = new LruCache<string>(10, 100, (v) => v.length);
    c.set('a', 'x');
    c.clear();
    expect(c.stats).toEqual({ entries: 0, size: 0 });
  });
});

describe('Semaphore', () => {
  it('CA-02 : au plus N rendus actifs ; une attente annulée libère sa place dans la file', async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    let troisieme = false;
    const p3 = s.acquire().then((r) => { troisieme = true; return r; });
    const ctrl = new AbortController();
    const p4 = s.acquire(ctrl.signal);
    await tick();
    expect(s.running).toBe(2);
    expect(s.waiting).toBe(2);
    ctrl.abort();
    await expect(p4).rejects.toBeInstanceOf(AbortError);
    expect(s.waiting).toBe(1);
    r1();
    r1(); // libération idempotente
    const r3 = await p3;
    expect(troisieme).toBe(true);
    expect(s.running).toBe(2);
    r2(); r3();
    expect(s.running).toBe(0);
  });
});

describe('SharedTasks', () => {
  it('T-02 : deux demandes concurrentes du même document → une seule génération', async () => {
    const t = new SharedTasks<string>();
    let demarrages = 0;
    let fin!: (v: string) => void;
    const start = () => { demarrages++; return new Promise<string>((ok) => { fin = ok; }); };
    const a = t.run('f1', start);
    const b = t.run('f1', start);
    expect(demarrages).toBe(1);
    fin('img');
    expect(await a).toBe('img');
    expect(await b).toBe('img');
    expect(t.size).toBe(0);
  });

  it('CA-01 / T-01 : le rendu n’est annulé que quand le DERNIER demandeur se retire', async () => {
    const t = new SharedTasks<string>();
    let signalTache!: AbortSignal;
    const start = (s: AbortSignal) => { signalTache = s; return new Promise<string>(() => undefined); };
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = t.run('f1', start, c1.signal);
    const p2 = t.run('f1', start, c2.signal);
    c1.abort();
    await expect(p1).rejects.toBeInstanceOf(AbortError);
    expect(signalTache.aborted).toBe(false);
    c2.abort();
    await expect(p2).rejects.toBeInstanceOf(AbortError);
    expect(signalTache.aborted).toBe(true);
    expect(t.size).toBe(0);
  });

  it('T-03 : changement de contexte → toutes les tâches annulées', () => {
    const t = new SharedTasks<string>();
    const signaux: AbortSignal[] = [];
    const start = (s: AbortSignal) => { signaux.push(s); return new Promise<string>(() => undefined); };
    void t.run('a', start).catch(() => undefined);
    void t.run('b', start).catch(() => undefined);
    t.abortAll();
    expect(signaux.every((s) => s.aborted)).toBe(true);
    expect(t.size).toBe(0);
  });

  it('erreur partagée par tous les demandeurs, tâche retirée', async () => {
    const t = new SharedTasks<string>();
    const start = async () => { throw new Error('PDF protégé'); };
    await expect(t.run('x', start)).rejects.toThrow('PDF protégé');
    expect(t.size).toBe(0);
  });
});

describe('PdfThumbnail (source)', () => {
  const C = readFileSync(join(process.cwd(), 'src/components/ui/pdf-thumbnail.tsx'), 'utf-8');
  it('miniature serveur d’abord, repli navigateur borné', () => {
    expect(C).toMatch(/src=\{`\/api\/files\/\$\{fileId\}\/thumbnail`\}/);
    expect(C).toContain('thumbnail?status=1');
    expect(C).toContain('IntersectionObserver');
  });
  it('CA-01 : chargement détruit dans un finally, rendu annulable, canvas libéré', () => {
    const fin = C.slice(C.indexOf('} finally {', C.indexOf('async function rendrePremierePage')));
    expect(fin).toMatch(/loadingTask\.destroy\(\)/);
    expect(fin).toMatch(/canvas\.width = 0/);
    expect(C).toMatch(/renderTask\?\.cancel\(\)/);
    expect(C).toContain('new Semaphore(2)');
    expect(C).toContain('new SharedTasks<string>()');
    expect(C).toMatch(/new LruCache<string>\(60,/);
    expect(C).toContain('export function purgePdfThumbnailCache');
  });
});
