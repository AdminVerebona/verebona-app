/**
 * Lot 26 — point 7 : ligne « Espace de stockage » de « Mon abonnement ».
 * Format lisible (Mo / Go, virgule française), même forme que les quotas de
 * biens et de documents (ratio en %, « X sur Y », alerte à 80 %).
 */
import { describe, expect, it } from 'vitest';
import { buildStorageQuotaUsage, formatStorageAmount } from '@/lib/storage-display';
import { BYTES_PER_GB } from '@/lib/storage-quota';

const MO = 1024 ** 2;
const GO = BYTES_PER_GB;

describe('lot 26 — AC7 : formatStorageAmount', () => {
  it('Mo sous 1 000 Mo, une décimale sous 10, virgule française', () => {
    expect(formatStorageAmount(0)).toBe('0 Mo');
    expect(formatStorageAmount(null)).toBe('0 Mo');
    expect(formatStorageAmount(10 * 1024)).toBe('< 0,1 Mo');
    expect(formatStorageAmount(0.3 * MO)).toBe('0,3 Mo');
    expect(formatStorageAmount(2.45 * MO)).toBe('2,5 Mo');
    expect(formatStorageAmount(820 * MO)).toBe('820 Mo');
    expect(formatStorageAmount(999.4 * MO)).toBe('999 Mo');
  });

  it('Go au-delà, jamais « 1 000 Mo »', () => {
    expect(formatStorageAmount(1000 * MO)).toBe('0,98 Go');
    expect(formatStorageAmount(GO)).toBe('1 Go');
    expect(formatStorageAmount(1.25 * GO)).toBe('1,3 Go');
    expect(formatStorageAmount(5 * GO)).toBe('5 Go');
    expect(formatStorageAmount(10 * GO)).toBe('10 Go');
  });
});

describe('lot 26 — AC7 : buildStorageQuotaUsage (« X sur Y »)', () => {
  it('libellé, ratio en pourcentage', () => {
    const q = buildStorageQuotaUsage(512 * MO, 5 * GO);
    expect(q.label).toBe('512 Mo sur 5 Go');
    expect(q.ratio).toBeCloseTo(10, 5);
    expect(q.shouldWarn).toBe(false);
    expect(q.isFull).toBe(false);
  });

  it('alerte à 80 %, plein à 100 %', () => {
    expect(buildStorageQuotaUsage(0.8 * GO, GO).shouldWarn).toBe(true);
    const plein = buildStorageQuotaUsage(GO, GO);
    expect(plein.isFull).toBe(true);
    expect(plein.label).toBe('1 Go sur 1 Go');
  });

  it('plafond nul ou valeurs invalides : jamais de division par zéro', () => {
    const q = buildStorageQuotaUsage(Number.NaN, 0);
    expect(q.ratio).toBe(0);
    expect(q.isFull).toBe(false);
    expect(q.label).toBe('0 Mo sur 0 Mo');
  });
});
