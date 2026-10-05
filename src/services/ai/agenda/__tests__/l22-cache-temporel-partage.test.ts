/**
 * Lot 22 (chantier B) — cache des arbitrages TEMPORAL_AMBIGUITY de T4 partagé
 * entre instances (`ai_operation_idempotency`, préfixe `t4-temporal:`).
 *
 *   · base configurée : lecture bornée à `expires_at > now()`, écriture qui
 *     conserve une entrée valide d'une autre instance et remplace une entrée
 *     expirée, TTL 24 h ; clé par compte ;
 *   · échec SQL : absence de cache, jamais d'exception ;
 *   · purge des entrées expirées par la purge quotidienne existante ;
 *   · sans base (tests unitaires) : repli mémoire du processus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ q: string; p: unknown[] }>,
  rows: [] as unknown[],
  fail: false,
}));
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: vi.fn(async (q: string, p: unknown[] = []) => {
      h.calls.push({ q, p });
      if (h.fail) throw new Error('connexion refusée');
      return /^\s*SELECT/.test(q) ? h.rows : [];
    }),
  },
}));

const cache = await import('../master/temporal-ambiguity-cache');
const { resoudreAmbiguiteTemporelle } = await import('../agenda-intelligence.service');

const choix = { chosen: { candidateId: 2, date: '2027-04-03', interpretation: 'lecture jour/mois' }, warning: null };

describe('cache partagé (base configurée)', () => {
  beforeEach(() => { vi.stubEnv('DATABASE_URL', 'postgres://test'); h.calls = []; h.rows = []; h.fail = false; });
  afterEach(() => vi.unstubAllEnvs());

  it('clé : préfixe constant, compte, empreinte', () => {
    expect(cache.temporalCacheKey(7, 'abc')).toBe('t4-temporal:a7:abc');
  });

  it('lecture : entrée non expirée seulement ; forme invalide ignorée', async () => {
    h.rows = [{ result_json: choix }];
    expect(await cache.readTemporalChoice('t4-temporal:a7:abc')).toEqual(choix);
    expect(h.calls[0].q).toContain('expires_at > now()');
    expect(h.calls[0].p).toEqual(['t4-temporal:a7:abc']);
    h.rows = [{ result_json: { n_importe: 'quoi' } }];
    expect(await cache.readTemporalChoice('t4-temporal:a7:abc')).toBeNull();
  });

  it('écriture : TTL 24 h, entrée valide d’une autre instance conservée, entrée expirée remplacée', async () => {
    await cache.writeTemporalChoice('t4-temporal:a7:abc', choix);
    const { q, p } = h.calls[0];
    expect(q).toContain('INSERT INTO ai_operation_idempotency');
    expect(q).toMatch(/ON CONFLICT \(key_hash\) DO UPDATE[\s\S]*WHERE ai_operation_idempotency\.expires_at <= now\(\)/);
    expect(p).toEqual(['t4-temporal:a7:abc', JSON.stringify(choix), String(24 * 3600)]);
  });

  it('échec SQL : ni exception ni cache', async () => {
    h.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await cache.readTemporalChoice('k')).toBeNull();
    await expect(cache.writeTemporalChoice('k', choix)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('T4 : deux « instances » (lecture en base) — le modèle n’est appelé qu’une fois, la clé porte le compte', async () => {
    const cand = { title: 'Prochain entretien', date: '2027-03-04', confidence: 'certain' as const, excerpt: 'Prochain entretien le 03/04/2027', originFieldKey: 'maintenanceDueDate' };
    const resolve = vi.fn(async () => choix);
    // 1re instance : rien en base → appel, puis écriture.
    const r1 = await resoudreAmbiguiteTemporelle(cand, { accountId: 7, userId: 2, sourceFileId: 55 }, { resolve: resolve as never });
    expect(r1).toMatchObject({ kind: 'keep', candidate: { date: '2027-04-03' } });
    const ecrite = h.calls.find((c) => c.q.includes('INSERT INTO ai_operation_idempotency'))!;
    expect(String(ecrite.p[0])).toMatch(/^t4-temporal:a7:[0-9a-f]{64}$/);
    // 2e instance : la ligne écrite par la première est lue → aucun appel.
    h.rows = [{ result_json: choix }];
    const r2 = await resoudreAmbiguiteTemporelle(cand, { accountId: 7, userId: 2, sourceFileId: 55 }, { resolve: resolve as never });
    expect(r2).toEqual(r1);
    expect(resolve).toHaveBeenCalledTimes(1);
    // Autre compte : autre clé.
    h.rows = [];
    await resoudreAmbiguiteTemporelle(cand, { accountId: 8, userId: 2, sourceFileId: 55 }, { resolve: resolve as never });
    const lues = h.calls.filter((c) => /^\s*SELECT/.test(c.q)).map((c) => String(c.p[0]));
    expect(lues[2]).toMatch(/^t4-temporal:a8:/);
    expect(lues[2].split(':')[2]).toBe(lues[0].split(':')[2]);
  });
});

describe('sans base (tests, outils) : repli mémoire du processus', () => {
  beforeEach(async () => { vi.stubEnv('DATABASE_URL', ''); h.calls = []; await cache.clearTemporalChoicesForTests(); });
  afterEach(() => vi.unstubAllEnvs());

  it('aucune requête ; l’entrée écrite est relue', async () => {
    await cache.writeTemporalChoice('k', choix);
    expect(await cache.readTemporalChoice('k')).toEqual(choix);
    expect(h.calls).toEqual([]);
  });
});

describe('purge des entrées expirées', () => {
  it('la purge quotidienne de l’assistant purge les résultats expirés (clés réservées épargnées)', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const job = readFileSync(join(process.cwd(), 'src/services/ai/assistant/retention/purge-assistant-logs.job.ts'), 'utf8');
    expect(job).toMatch(/purgeExpiredIdempotency\(\)/);
    const svc = readFileSync(join(process.cwd(), 'src/services/ai/idempotency/idempotency.service.ts'), 'utf8');
    expect(svc).toMatch(/WHERE expires_at <= now\(\) AND \$\{NOT_RESERVED_IDEMPOTENCY_KEY_SQL\}/);
  });
});
