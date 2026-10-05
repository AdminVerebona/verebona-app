/**
 * Lot 24 (revue) — variable présente mais VIDE : valeur par défaut, jamais 0.
 * `AI_QUEUE_INTERVAL_MS=` donnait une boucle sans pause, `AI_QUEUE_LEASE_SECONDS=` un bail de 0 s.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envNumber } from '../env-number';

describe('envNumber', () => {
  it('absente, vide, espaces, non numérique → défaut', () => {
    expect(envNumber('X', 15_000, {}, {})).toBe(15_000);
    expect(envNumber('X', 15_000, {}, { X: '' })).toBe(15_000);
    expect(envNumber('X', 15_000, {}, { X: '  ' })).toBe(15_000);
    expect(envNumber('X', 15_000, {}, { X: 'abc' })).toBe(15_000);
  });

  it('valeur valide retenue ; sous le minimum → défaut', () => {
    expect(envNumber('X', 15_000, { min: 1_000 }, { X: '5000' })).toBe(5_000);
    expect(envNumber('X', 15_000, { min: 1_000 }, { X: '0' })).toBe(15_000);
    expect(envNumber('X', 300, { min: 1 }, { X: '0' })).toBe(300);
    expect(envNumber('X', 600_000, { min: 0 }, { X: '0' })).toBe(0);
  });

  it('les lecteurs signalés passent par envNumber ; plus de `Number(process.env.X ?? …)`', () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
    for (const [f, v] of [
      ['src/services/ai/queue/queue-worker.ts', 'AI_QUEUE_INTERVAL_MS'],
      ['src/services/ai/queue/job-queue.repository.ts', 'AI_QUEUE_LEASE_SECONDS'],
      ['src/services/ai/queue/job-queue.repository.ts', 'AI_QUEUE_LEGACY_STALE_SECONDS'],
      ['src/services/ai/reconciliation/account-reconciliation.service.ts', 'T3_EVENT_DEBOUNCE_MS'],
      ['src/services/ai/reconciliation/t3-queue.ts', 'T3_EVENT_DEBOUNCE_MS'],
    ] as const) {
      expect(read(f)).toContain(`envNumber('${v}'`);
      expect(read(f)).not.toMatch(new RegExp(`Number\\(process\\.env\\.${v} \\?\\?`));
    }
    expect(read('scripts/check-legacy-ai.mjs')).toMatch(/AI_MIGRATION_PHASE\?\.trim\(\) \|\| '1'/);
  });

  it('.env.example : aucune de ces variables posée vide', () => {
    const env = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    for (const v of ['AI_QUEUE_INTERVAL_MS', 'AI_QUEUE_LEASE_SECONDS', 'AI_QUEUE_LEGACY_STALE_SECONDS', 'T3_EVENT_DEBOUNCE_MS', 'AI_MIGRATION_PHASE']) {
      expect(env).not.toMatch(new RegExp(`^${v}=\\s*$`, 'm'));
    }
  });
});
