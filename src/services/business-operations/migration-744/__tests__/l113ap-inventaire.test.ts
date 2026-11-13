/**
 * Lot 113AP (#744) — inventaire de migration en lecture seule : gardes
 * statiques (SELECT seul, borné au compte) et lecture pure du rapport.
 * Exécution réelle sur PostgreSQL : `src/test/e2e/scenarios/l113ap-operations-agenda.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { INVENTORY_MEASURES, inventoryFindings, simulateAccountInventory, type InventoryReport } from '../inventory';

describe('L113AP — inventaire de migration (lecture seule)', () => {
  it('chaque mesure est un SELECT unique, sans écriture ni DDL, bornée au compte ($1)', () => {
    expect(INVENTORY_MEASURES.length).toBeGreaterThanOrEqual(9);
    const keys = new Set<string>();
    for (const m of INVENTORY_MEASURES) {
      expect(keys.has(m.key), m.key).toBe(false);
      keys.add(m.key);
      expect(m.sql.trim(), m.key).toMatch(/^SELECT\b/);
      expect(m.sql, m.key).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY|LOCK)\b/i);
      expect(m.sql, m.key).not.toMatch(/;/);
      expect(m.sql, m.key).toMatch(/\$1\b/);
      expect(m.sql, m.key).not.toMatch(/\$[2-9]\b/);
    }
  });

  it('identifiant de compte invalide : refusé avant toute requête', async () => {
    let appels = 0;
    const q = async () => { appels++; return [{}]; };
    await expect(simulateAccountInventory(0, q)).rejects.toThrow('INVALID_ACCOUNT_ID');
    await expect(simulateAccountInventory(Number.NaN, q)).rejects.toThrow('INVALID_ACCOUNT_ID');
    expect(appels).toBe(0);
  });

  it('exécuteur fourni : une requête par mesure, paramètre = compte, compteurs normalisés', async () => {
    const vus: unknown[][] = [];
    const r = await simulateAccountInventory(42, async (_sql, params) => { vus.push(params); return [{ a: '3', somme_eur_cents: '1234567890123' }]; });
    expect(vus).toHaveLength(INVENTORY_MEASURES.length);
    for (const p of vus) expect(p).toEqual([42]);
    expect(r.operations).toEqual({ a: 3, somme_eur_cents: '1234567890123' });
  });

  it('lecture du rapport : intercompte BLOQUANT, décisions utilisateur À PRÉSERVER, zéro = aucun constat', () => {
    expect(inventoryFindings({})).toEqual([]);
    const r: InventoryReport = {
      evenementsOrphelins: { intercompte: 1, operation_absente: 0, operation_inactive: 2 },
      principal: { principal_user: 2, principal_presume_technique: 5 },
      decisions: { principal_retire: 1, refus: 4, projections_supprimees: 0 },
      liens: { liens_doc_uniquement_principal: 3 },
      notifications: { en_attente_sur_principal: 1 },
      operationsSansEvenement: { sans_evenement: 6, sans_principal: 7 },
    };
    const f = inventoryFindings(r);
    const par = Object.fromEntries(f.map((x) => [x.code, x]));
    expect(par.CROSS_ACCOUNT_EVENT).toMatchObject({ severity: 'BLOQUANT', count: 1 });
    expect(par.USER_PRINCIPAL).toMatchObject({ severity: 'A_PRESERVER', count: 2 });
    expect(par.PRINCIPAL_REFUSALS).toMatchObject({ severity: 'A_PRESERVER', count: 1 });
    expect(par.USER_REFUSALS).toMatchObject({ severity: 'A_PRESERVER', count: 4 });
    expect(par.PRINCIPAL_ONLY_DOC_LINKS).toMatchObject({ severity: 'A_PRESERVER', count: 3 });
    expect(par.PENDING_NOTIF_ON_PRINCIPAL).toMatchObject({ severity: 'A_PRESERVER', count: 1 });
    expect(par.PRESUMED_TECHNICAL_PRINCIPAL).toMatchObject({ severity: 'INFO', count: 5 });
    expect(par.ORPHAN_OPERATION_REF).toMatchObject({ count: 2 });
    expect(par.PROJECTION_SUPPRESSIONS).toBeUndefined();
  });
});
