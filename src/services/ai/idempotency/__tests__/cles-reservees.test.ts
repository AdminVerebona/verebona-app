/**
 * PUB-01 (lot 19) — la purge de `ai_operation_idempotency` ne supprime
 * jamais les clés réservées (`help-corpus:last-valid:<env>`).
 */
import { describe, it, expect, vi } from 'vitest';

const requetes: string[] = [];
vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async (q: string) => { requetes.push(q); return [1, 1]; }) } }));

const { purgeExpiredIdempotency, isReservedIdempotencyKey } = await import('../idempotency.service');

describe('clés réservées', () => {
  it('purge des expirés : clés réservées exclues', async () => {
    expect(await purgeExpiredIdempotency()).toBe(2);
    expect(requetes[0]).toMatch(/expires_at <= now\(\) AND key_hash NOT LIKE 'help-corpus:last-valid:%'/);
  });

  it('reconnaissance', () => {
    expect(isReservedIdempotencyKey('help-corpus:last-valid:preprod')).toBe(true);
    expect(isReservedIdempotencyKey('assistant:c12:abc')).toBe(false);
    expect(isReservedIdempotencyKey('0f3a…')).toBe(false);
  });
});
