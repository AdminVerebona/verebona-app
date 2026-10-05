/**
 * Lot 24 — #10 (APP-PERF-01 §MESURES) : mesures du pool PostgreSQL sur un
 * vrai pilote postgres.js et une vraie base.
 *
 *   · pool saturé (max 1) : la 2e requête ATTEND la connexion — `pool_wait`
 *     ≈ durée de la 1re, `sql` ≈ sa propre durée (mesures séparées) ;
 *   · un fragment `unsafe` (api/deadlines : `WHERE ${sql.unsafe(…)}`) n'est
 *     JAMAIS exécuté seul par l'instrumentation ;
 *   · transaction : attente de réservation comptée ; erreurs comptées ;
 *   · compteurs revenus à zéro (aucune fuite « en cours »).
 */
import { it, expect } from 'vitest';
import postgres from 'postgres';
import { scenario } from '../scenario';
import { PoolMetrics, instrumentPgClient } from '@/db/pool-metrics';

scenario('L24-POOL', 'Mesures du pool PostgreSQL (attente / SQL)', () => {
  it('pool saturé : attente d’acquisition et temps SQL séparés ; fragment jamais exécuté seul', async () => {
    const m = new PoolMetrics();
    const sql = instrumentPgClient(postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => undefined }), m);
    try {
      await sql.unsafe('SELECT 1'); // connexion ouverte
      const a = sql.unsafe('SELECT pg_sleep(0.4)');
      const b = sql.unsafe('SELECT pg_sleep(0.1)');
      await Promise.all([a, b]);

      const s = m.snapshot();
      expect(s.queries).toBe(3);
      expect(s.unmeasured).toBe(0);
      expect(s.inFlight).toBe(0);
      expect(s.waiting).toBe(0);
      expect(s.maxWaiting).toBeGreaterThanOrEqual(1);
      // La 2e requête a attendu la fin de la 1re (≈ 400 ms) pour obtenir la connexion.
      expect(s.poolWait.maxMs).toBeGreaterThanOrEqual(300);
      // Le temps SQL, lui, reste celui de la requête la plus longue (≈ 400 ms), pas 500.
      expect(s.sql.maxMs).toBeGreaterThanOrEqual(350);
      expect(s.sql.maxMs).toBeLessThan(480);

      // Fragment : construit, utilisé dans une requête balisée, jamais lancé seul.
      const avant = m.snapshot().queries;
      const r = await sql`SELECT 1 AS un WHERE ${sql.unsafe('1 = 1')}`;
      expect(r[0].un).toBe(1);
      await new Promise((res) => setTimeout(res, 50));
      expect(m.snapshot().queries).toBe(avant);
      expect(m.snapshot().inFlight).toBe(0);

      // Erreur SQL comptée ; transaction : attente de réservation comptée.
      await expect(sql.unsafe('SELECT * FROM table_absente_l24')).rejects.toThrow();
      await sql.begin(async (tx) => { await tx.unsafe('SELECT 1'); });
      const fin = m.snapshot();
      expect(fin.errors).toBe(1);
      expect(fin.transactionWait.count).toBe(1);
      expect(fin.inFlight).toBe(0);
      expect(fin.waiting).toBe(0);
      // Aucune donnée de requête dans l'agrégat.
      expect(JSON.stringify(fin)).not.toMatch(/pg_sleep|table_absente|SELECT/);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
