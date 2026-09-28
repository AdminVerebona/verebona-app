/**
 * Plafond de stockage — CDC Back-Office V1 §13.1, STO-001 / STO-003.
 */
import { describe, it, expect } from 'vitest';
import {
  BYTES_PER_GB,
  DEFAULT_STORAGE_LIMIT_BYTES,
  checkStorageQuota,
  formatStorageSize,
  storageQuotaExceededResponse,
} from '@/lib/storage-quota';
import { SUBSCRIPTION_LIMITS } from '@/lib/subscription-limits';

describe('plafonds par offre (§13.1)', () => {
  it('2 Go Standard, 10 Go Premium, 15 Go Premium Duo', () => {
    expect(DEFAULT_STORAGE_LIMIT_BYTES.standard).toBe(2 * BYTES_PER_GB);
    expect(DEFAULT_STORAGE_LIMIT_BYTES.premium).toBe(10 * BYTES_PER_GB);
    expect(DEFAULT_STORAGE_LIMIT_BYTES.premium_duo).toBe(15 * BYTES_PER_GB);
  });

  it('`subscription-limits.ts` est aligné', () => {
    expect(SUBSCRIPTION_LIMITS.STANDARD.maxStorageGb).toBe(2);
    expect(SUBSCRIPTION_LIMITS.PREMIUM.maxStorageGb).toBe(10);
    expect(SUBSCRIPTION_LIMITS.PREMIUM_DUO.maxStorageGb).toBe(15);
  });
});

describe('checkStorageQuota (volume cumulé)', () => {
  const limit = 2 * BYTES_PER_GB;

  it('accepte un dépôt sous le plafond', () => {
    const d = checkStorageQuota({ usedBytes: limit - 100, incomingBytes: 50, limitBytes: limit });
    expect(d.allowed).toBe(true);
    expect(d.remainingBytes).toBe(100);
  });

  it('accepte d’atteindre exactement le plafond', () => {
    expect(checkStorageQuota({ usedBytes: limit - 100, incomingBytes: 100, limitBytes: limit }).allowed).toBe(true);
  });

  it('refuse le dépôt qui ferait dépasser le plafond', () => {
    expect(checkStorageQuota({ usedBytes: limit - 100, incomingBytes: 101, limitBytes: limit }).allowed).toBe(false);
  });

  it('à 100 % : tout nouveau dépôt est refusé, même d’un octet (STO-003)', () => {
    const d = checkStorageQuota({ usedBytes: limit, incomingBytes: 1, limitBytes: limit });
    expect(d.allowed).toBe(false);
    expect(d.remainingBytes).toBe(0);
  });

  it('borne les valeurs négatives', () => {
    const d = checkStorageQuota({ usedBytes: -5, incomingBytes: -1, limitBytes: 10 });
    expect(d).toMatchObject({ allowed: true, usedBytes: 0, incomingBytes: 0 });
  });
});

describe('réponse de refus', () => {
  it('413 STORAGE_QUOTA_EXCEEDED, message français', async () => {
    const res = storageQuotaExceededResponse(
      checkStorageQuota({ usedBytes: 2 * BYTES_PER_GB, incomingBytes: 10, limitBytes: 2 * BYTES_PER_GB }),
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(body.message).toContain('Espace de stockage insuffisant');
    expect(body.message).toContain('2 Go');
  });

  it('formatStorageSize', () => {
    expect(formatStorageSize(0)).toBe('0 octets');
    expect(formatStorageSize(1536)).toBe('1,5 Ko');
    expect(formatStorageSize(15 * BYTES_PER_GB)).toBe('15 Go');
  });
});
