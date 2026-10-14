/**
 * Lot 49 — SEC-P0 §5, AC08 : contrôle « Relations intercomptes » (lecture
 * seule), alerte de Supervision et parité avec le SQL documenté dans
 * `docs/exploitation/relations-intercomptes.sql`. Le contrôle sur une base
 * réelle (relation incorrecte volontaire) est couvert par
 * `l49-sec-p0-intercomptes.e2e.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  aggregateSql, CROSS_ACCOUNT_CHECKS, detectCrossAccountRelations, renderCrossAccountSqlScript,
  type CrossAccountCheckResult, type DetectionExecutor,
} from '../cross-account/detection';
import {
  crossAccountFingerprint, planCrossAccountAlerts, runCrossAccountCheck, CROSS_ACCOUNT_BO_LINK,
} from '../cross-account/alerts';
import { findTask } from '@/services/scheduling/scheduled-tasks.catalog';
import { diagnosticLinkFor } from '@/services/admin/anomaly.service';

describe('lot 49 — AC08 : contrôle des relations intercomptes', () => {
  it('AC08 — les familles du ticket §5 sont toutes contrôlées', () => {
    const familles = new Set(CROSS_ACCOUNT_CHECKS.map((c) => c.family));
    expect([...familles].sort()).toEqual(['a_traiter', 'agenda', 'documents', 'evenements', 'fournisseurs', 'jobs', 'preuves']);
    const codes = CROSS_ACCOUNT_CHECKS.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of ['DOC_ASSET', 'DOC_SUBSTRUCTURE', 'DOC_EQUIPMENT', 'DOC_SUPPLIER', 'EQUIPMENT_SUPPLIER', 'EVENT_DOCUMENT',
      'AGENDA_ASSET', 'AGENDA_FILE', 'AGENDA_ROOM', 'AGENDA_EQUIPMENT', 'EVIDENCE_SOURCE', 'AI_JOB_PENDING']) {
      expect(codes).toContain(c);
    }
  });

  it('AC08 — lecture seule : aucun contrôle n’écrit (aucun INSERT / UPDATE / DELETE)', () => {
    for (const c of CROSS_ACCOUNT_CHECKS) {
      expect(c.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
      expect(aggregateSql(c)).toMatch(/^WITH r AS MATERIALIZED/);
    }
    const script = renderCrossAccountSqlScript();
    expect(script).toContain('BEGIN TRANSACTION READ ONLY;');
    expect(script.trimEnd().endsWith('ROLLBACK;')).toBe(true);
  });

  it('AC08 — le SQL documenté (docs/exploitation) est identique au catalogue exécuté', () => {
    const doc = readFileSync(resolve(__dirname, '../../../../docs/exploitation/relations-intercomptes.sql'), 'utf8');
    expect(doc).toBe(renderCrossAccountSqlScript());
  });

  it('AC08 — un contrôle en échec n’empêche pas les autres (SAVEPOINT) ; rapport par type, comptes, identifiants', async () => {
    const vus: string[] = [];
    const exec: DetectionExecutor = async (fn) => fn(async (sql) => {
      vus.push(sql);
      if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE') || sql.startsWith('ROLLBACK')) return [];
      if (sql.includes('FROM asset_files f JOIN assets a ON a.id = f.asset_id')) {
        return [{ n: 2, accounts: [10, 20], samples: JSON.stringify([{ accountId: 10, otherAccountId: 20, ref: 'asset_files#1 -> assets#2' }]) }];
      }
      if (sql.includes('event_documents')) throw new Error('relation absente');
      return [{ n: 0, accounts: [], samples: [] }];
    });
    const r = await detectCrossAccountRelations(exec);
    expect(r.readOnly).toBe(true);
    expect(r.total).toBe(2);
    expect(r.accountIds).toEqual([10, 20]);
    const doc = r.checks.find((c) => c.code === 'DOC_ASSET')!;
    expect(doc).toMatchObject({ count: 2, accountIds: [10, 20], samples: [{ accountId: 10, otherAccountId: 20, ref: 'asset_files#1 -> assets#2' }] });
    expect(r.checks.find((c) => c.code === 'EVENT_DOCUMENT')?.error).toContain('relation absente');
    expect(r.checks).toHaveLength(CROSS_ACCOUNT_CHECKS.length);
    expect(vus.some((s) => s.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  const res = (code: string, count: number, error?: string): CrossAccountCheckResult => ({
    code, family: 'documents', label: code, count, accountIds: count ? [1, 2] : [], samples: [], ...(error ? { error } : {}),
  });

  it('AC08 — alerte : un type non nul ouvre une anomalie ; revenu à 0 → résolue ; contrôle en échec → jamais résolu', () => {
    const plan = planCrossAccountAlerts(
      [res('DOC_ASSET', 3), res('AGENDA_FILE', 0), res('EVENT_DOCUMENT', 0, 'délai')],
      [crossAccountFingerprint('AGENDA_FILE'), crossAccountFingerprint('EVENT_DOCUMENT'), 'other:autre'],
    );
    expect(plan.toReport.map((c) => c.code)).toEqual(['DOC_ASSET']);
    expect(plan.toResolve).toEqual([crossAccountFingerprint('AGENDA_FILE')]);
  });

  it('AC08 — tâche quotidienne : anomalie de Supervision (nombre, comptes, identifiants, lien BO), jamais de correction', async () => {
    const report = vi.fn(async () => 1);
    const resolveF = vi.fn(async () => true);
    const r = await runCrossAccountCheck({
      detect: async () => ({ computedAt: 'x', total: 3, accountIds: [1, 2], readOnly: true, checks: [res('DOC_ASSET', 3), res('AGENDA_FILE', 0)] }),
      openFingerprints: async () => [crossAccountFingerprint('AGENDA_FILE')],
      report, resolve: resolveF,
    });
    expect(r).toMatchObject({ total: 3, reported: 1, resolved: 1 });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'other', fingerprint: 'other:cross-account:doc_asset',
      detail: expect.objectContaining({ count: 3, accountIds: '1, 2', boLink: CROSS_ACCOUNT_BO_LINK }),
    }));
    expect(diagnosticLinkFor('other', { boLink: CROSS_ACCOUNT_BO_LINK })?.href).toBe(CROSS_ACCOUNT_BO_LINK);
    expect(diagnosticLinkFor('other', { boLink: 'https://ailleurs.example' })).toBeNull();
  });

  it('AC08 — tâche planifiée interne inscrite au catalogue (aucune commande à lancer)', () => {
    const t = findTask('cross-account-relations-check');
    expect(t?.schedule).toMatchObject({ kind: 'daily', at: [7, 5] });
  });
});
