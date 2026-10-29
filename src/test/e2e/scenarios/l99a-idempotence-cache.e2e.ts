/**
 * Lot 99A (ticket P1 « T3 — Supprimer les appels IA redondants », point B) —
 * cache TEMPORAIRE des réponses modèle sur PostgreSQL réel.
 *
 *   L99A-B01  entrée valide conservée : servie sans appel, `hit_count` + compteur PROVIDER_CACHE_HIT
 *   L99A-B02  entrée EXPIRÉE encore présente : remplacée (fin du « ON CONFLICT DO NOTHING » bloquant),
 *             `renewed_count` + compteur CACHE_RENEWED ; puis servie sans appel
 *   L99A-B03  deux demandes identiques simultanées depuis DEUX instances : un seul appel fournisseur,
 *             la seconde reçoit la réponse partagée (compteur CONCURRENT_SHARED)
 *   L99A-B04  échec de l'appel : réservation libérée, la demande suivante appelle (jamais un blocage)
 *   L99A-B05  réservation d'une instance arrêtée (bail échu) : reprise
 *   L99A-B06  clés réservées (dernier corpus d'aide) jamais touchées
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

scenario('L99A-B', 'Cache des réponses modèle : renouvellement et concurrence multi-instances', ({ sql, make }) => {
  const avant = process.env.AI_IDEMPOTENCY_DISABLED;
  let svc: typeof import('@/services/ai/idempotency/idempotency.service');
  beforeAll(async () => {
    process.env.AI_IDEMPOTENCY_DISABLED = 'false';
    svc = await import('@/services/ai/idempotency/idempotency.service');
  });
  afterAll(() => { process.env.AI_IDEMPOTENCY_DISABLED = avant; });

  const ligne = async (key: string) => (await sql<Array<{ state: string; hit_count: number; renewed_count: number; result_json: unknown; expired: boolean }>>`
    SELECT state, hit_count, renewed_count, result_json, expires_at <= now() AS expired FROM ai_operation_idempotency WHERE key_hash = ${key}`)[0];
  const compteur = async (accountId: number, kind: string) => Number((await sql<Array<{ n: string | null }>>`
    SELECT sum(count) AS n FROM ai_reuse_counters WHERE account_id = ${accountId} AND kind = ${kind}`)[0]?.n ?? 0);
  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('L99A-B01/B02 : entrée valide conservée ; entrée expirée renouvelée puis resservie', async () => {
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_value_conflict' };
    const key = `l99a:b02:${c.id}`;
    const fn = vi.fn(async () => ({ v: 1, fromCache: false }));
    const r1 = await svc.withIdempotency(key, fn, 3600, meta);
    expect(r1).toEqual({ v: 1, fromCache: false });
    expect(await ligne(key)).toMatchObject({ state: 'READY', hit_count: 0, renewed_count: 0, expired: false });

    const r2 = await svc.withIdempotency(key, fn, 3600, meta);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ v: 1, fromCache: true, cacheOutcome: 'CACHE_HIT' });
    await attendre(50);
    expect((await ligne(key)).hit_count).toBe(1);
    expect(await compteur(c.id, 'PROVIDER_CACHE_HIT')).toBe(1);

    // Expiration (le passage horaire suivant arrive après la fin du TTL) : l'ancienne ligne est encore là.
    await sql`UPDATE ai_operation_idempotency SET expires_at = now() - interval '1 second' WHERE key_hash = ${key}`;
    const fn2 = vi.fn(async () => ({ v: 2, fromCache: false }));
    const r3 = await svc.withIdempotency(key, fn2, 3600, meta);
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(r3).toEqual({ v: 2, fromCache: false });
    expect(await ligne(key)).toMatchObject({ state: 'READY', renewed_count: 1, expired: false, result_json: { v: 2, fromCache: false } });
    await attendre(50);
    expect(await compteur(c.id, 'CACHE_RENEWED')).toBe(1);

    const r4 = await svc.withIdempotency(key, fn2, 3600, meta);
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(r4).toMatchObject({ v: 2, fromCache: true });
  });

  it('L99A-B03 : deux instances, même demande au même instant → UN SEUL appel fournisseur', async () => {
    const c = await make.account();
    const meta = { accountId: c.id, treatment: 'T3', operationCode: 't3_value_conflict' };
    const key = `l99a:b03:${c.id}`;
    // Deux « instances » : deux copies du module (dédoublonnage mémoire distinct), même base.
    const instanceA = svc;
    vi.resetModules();
    const instanceB = await import('@/services/ai/idempotency/idempotency.service');
    expect(instanceB).not.toBe(instanceA);
    let appels = 0;
    const fournisseur = async () => { appels++; await attendre(600); return { v: 'unique', fromCache: false }; };
    const [a, b] = await Promise.all([
      instanceA.withIdempotency(key, fournisseur, 3600, meta),
      (async () => { await attendre(30); return instanceB.withIdempotency(key, fournisseur, 3600, meta); })(),
    ]);
    expect(appels).toBe(1);
    expect(a).toEqual({ v: 'unique', fromCache: false });
    expect(b).toMatchObject({ v: 'unique', fromCache: true, cacheOutcome: 'SHARED' });
    await attendre(50);
    expect(await compteur(c.id, 'CONCURRENT_SHARED')).toBe(1);
    expect((await ligne(key)).state).toBe('READY');
    const { pgClient } = await import('@/db');
    if (pgClient !== sql) await pgClient.end({ timeout: 5 }).catch(() => undefined);
  });

  it('L99A-B04/B05 : échec → réservation libérée ; bail d’une instance arrêtée → repris', async () => {
    const key = 'l99a:b04';
    await expect(svc.withIdempotency(key, async () => { throw new Error('fournisseur indisponible'); })).rejects.toThrow('fournisseur indisponible');
    expect(await ligne(key)).toBeUndefined();
    const ok = vi.fn(async () => ({ v: 'ok', fromCache: false }));
    expect(await svc.withIdempotency(key, ok)).toEqual({ v: 'ok', fromCache: false });
    expect(ok).toHaveBeenCalledTimes(1);

    // Instance arrêtée pendant l'appel : réservation PENDING au bail échu.
    const k2 = 'l99a:b05';
    await sql`INSERT INTO ai_operation_idempotency (key_hash, result_json, expires_at, state, owner_token)
              VALUES (${k2}, '{}'::jsonb, now() - interval '1 second', 'PENDING', 'instance-arretee')`;
    const repris = vi.fn(async () => ({ v: 'repris', fromCache: false }));
    expect(await svc.withIdempotency(k2, repris)).toEqual({ v: 'repris', fromCache: false });
    expect(repris).toHaveBeenCalledTimes(1);
    expect(await ligne(k2)).toMatchObject({ state: 'READY', renewed_count: 0 });
  });

  it('L99A-B06 : la purge des expirés épargne les clés réservées ; une réservation vivante n’est jamais servie', async () => {
    await sql`INSERT INTO ai_operation_idempotency (key_hash, result_json, expires_at) VALUES ('help-corpus:last-valid:l99a', '{"ok":true}'::jsonb, now() - interval '1 day')
              ON CONFLICT (key_hash) DO NOTHING`;
    await svc.purgeExpiredIdempotency();
    expect(await ligne('help-corpus:last-valid:l99a')).toBeDefined();
    await sql`INSERT INTO ai_operation_idempotency (key_hash, result_json, expires_at, state, owner_token)
              VALUES ('l99a:b06', '{}'::jsonb, now() + interval '1 second', 'PENDING', 'autre')`;
    let appels = 0;
    const r = await svc.withIdempotency('l99a:b06', async () => { appels++; return { v: 'apres-bail', fromCache: false }; });
    // Attente du bail (≈ 1 s) puis reprise : un seul appel, jamais la réponse vide de la réservation.
    expect(appels).toBe(1);
    expect(r).toEqual({ v: 'apres-bail', fromCache: false });
  });
});
