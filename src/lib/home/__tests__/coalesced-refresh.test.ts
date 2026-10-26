/**
 * APP-PERF-09 — rafraîchissements regroupés, réponses anciennes écartées.
 * Recette T-01 à T-03 sur le coordinateur, minuteurs simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedRefresh } from '../coalesced-refresh';

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('coordinateur de rafraîchissement', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  async function tick(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('T-01 : une action émettant plusieurs événements rapprochés ne coûte qu’une lecture', async () => {
    const pending: Deferred<string>[] = [];
    const applied: string[] = [];
    const c = createCoalescedRefresh<string>({
      windowMs: 300,
      load: () => { const d = deferred<string>(); pending.push(d); return d.promise; },
      apply: (v) => applied.push(v),
    });

    // Dépôt : document-added, refresh-a-traiter, agenda-mutated, fin d'analyse.
    c.invalidate(); c.invalidate(); c.invalidate();
    await tick(100);
    c.invalidate();
    expect(pending).toHaveLength(0);
    await tick(300);
    expect(pending).toHaveLength(1);
    pending[0].resolve('état final');
    await tick(0);
    expect(applied).toEqual(['état final']);
    expect(c.stats()).toMatchObject({ invalidations: 4, loads: 1 });
  });

  it('T-03 : une modification pendant une lecture programme UNE lecture de plus, sans boucle', async () => {
    const pending: Deferred<number>[] = [];
    const applied: number[] = [];
    const c = createCoalescedRefresh<number>({
      windowMs: 300,
      load: () => { const d = deferred<number>(); pending.push(d); return d.promise; },
      apply: (v) => applied.push(v),
    });
    c.refreshNow();
    expect(pending).toHaveLength(1);
    // Rafale pendant la lecture (autre appareil Duo, événements locaux).
    for (let i = 0; i < 5; i++) { c.invalidate(); await tick(400); }
    expect(pending).toHaveLength(1);
    pending[0].resolve(1);
    await tick(0);
    expect(pending).toHaveLength(2);
    pending[1].resolve(2);
    await tick(1_000);
    expect(pending).toHaveLength(2);
    expect(applied).toEqual([1, 2]);
    expect(c.isBusy()).toBe(false);
  });

  it('T-02 : en relecture directe, une réponse retardée n’écrase jamais la plus récente', async () => {
    const pending: Deferred<string>[] = [];
    const applied: string[] = [];
    const c = createCoalescedRefresh<string>({
      direct: true,
      load: () => { const d = deferred<string>(); pending.push(d); return d.promise; },
      apply: (v) => applied.push(v),
    });
    c.invalidate(); // A
    c.invalidate(); // B
    expect(pending).toHaveLength(2);
    pending[1].resolve('B (récent)');
    await tick(0);
    pending[0].resolve('A (ancien)');
    await tick(0);
    expect(applied).toEqual(['B (récent)']);
    expect(c.stats().staleDiscarded).toBe(1);
  });

  it('une erreur d’une lecture plus ancienne que l’état accepté est ignorée', async () => {
    const pending: Deferred<string>[] = [];
    const onError = vi.fn();
    const c = createCoalescedRefresh<string>({
      direct: true,
      load: () => { const d = deferred<string>(); pending.push(d); return d.promise; },
      apply: () => undefined,
      onError,
    });
    c.invalidate(); c.invalidate();
    pending[1].resolve('ok');
    await tick(0);
    pending[0].reject(new Error('panne'));
    await tick(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('une valeur reçue autrement rend obsolète la lecture en vol (supersede)', async () => {
    const d = deferred<number>();
    const apply = vi.fn();
    const c = createCoalescedRefresh<number>({ load: () => d.promise, apply });
    c.refreshNow();
    c.supersede();
    d.resolve(42);
    await tick(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('dispose : annule la lecture en vol et la fenêtre programmée, plus aucune écriture', async () => {
    const signals: AbortSignal[] = [];
    const apply = vi.fn();
    const c = createCoalescedRefresh<number>({
      load: ({ signal }) => { signals.push(signal); return new Promise<number>(() => undefined); },
      apply,
    });
    c.refreshNow();
    c.invalidate();
    c.dispose();
    await tick(1_000);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it('une erreur est remontée (l’appelant garde ses données) ; un abandon ne l’est pas', async () => {
    const onError = vi.fn();
    let n = 0;
    const c = createCoalescedRefresh<number>({
      load: () => {
        n += 1;
        return n === 1
          ? Promise.reject(Object.assign(new Error('abort'), { code: 'REQUEST_ABORTED' }))
          : Promise.reject(new Error('500'));
      },
      apply: () => undefined,
      onError,
    });
    c.refreshNow();
    await tick(0);
    c.refreshNow();
    await tick(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
