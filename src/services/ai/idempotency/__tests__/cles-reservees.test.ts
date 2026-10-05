/**
 * PUB-01 (lot 19) — la purge de `ai_operation_idempotency` ne supprime
 * jamais les clés réservées (`help-corpus:last-valid:<env>`).
 */
import { describe, it, expect, vi } from 'vitest';

const requetes: string[] = [];
const comptes: number[] = [];
vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async (q: string) => { requetes.push(q); return Object.assign([], { count: comptes.shift() ?? 0 }); }) } }));

const { purgeExpiredIdempotency, isReservedIdempotencyKey } = await import('../idempotency.service');

describe('clés réservées', () => {
  it('purge des expirés : clés réservées exclues', async () => {
    requetes.length = 0;
    comptes.push(2);
    expect(await purgeExpiredIdempotency()).toBe(2);
    expect(requetes[0]).toMatch(/expires_at <= now\(\) AND key_hash NOT LIKE 'help-corpus:last-valid:%'/);
  });

  it('lot 22 : par lots (ctid … LIMIT), sans RETURNING, jusqu’à un lot incomplet', async () => {
    requetes.length = 0;
    comptes.push(3, 3, 1);
    expect(await purgeExpiredIdempotency({ batchSize: 3 })).toBe(7);
    expect(requetes).toHaveLength(3);
    expect(requetes[0]).toMatch(/WHERE ctid IN \(SELECT ctid FROM ai_operation_idempotency[\s\S]*LIMIT 3\)/);
    expect(requetes[0]).not.toMatch(/RETURNING/);
  });

  it('lot 22 : borne de temps — arrêt après le lot en cours', async () => {
    requetes.length = 0;
    comptes.push(3, 3, 3);
    expect(await purgeExpiredIdempotency({ batchSize: 3, maxDurationMs: 0 })).toBe(3);
    expect(requetes).toHaveLength(1);
    comptes.length = 0;
  });

  it('reconnaissance', () => {
    expect(isReservedIdempotencyKey('help-corpus:last-valid:preprod')).toBe(true);
    expect(isReservedIdempotencyKey('assistant:c12:abc')).toBe(false);
    expect(isReservedIdempotencyKey('0f3a…')).toBe(false);
  });
});
