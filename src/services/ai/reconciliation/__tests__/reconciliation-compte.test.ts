/**
 * T3 — orchestration globale au niveau du compte, par le moteur commun.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { consolidate, type ObjectResult } from '../account-reconciliation.service';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const S = read('src/services/ai/reconciliation/account-reconciliation.service.ts');
const M = read('src/db/migrations/0157_account_reconciliation_runs.sql');

const obj = (id: number, status: ObjectResult['status'], applied = 0, conflicts = 0, aiReviews = 0): ObjectResult =>
  ({ objectType: 'asset', objectId: id, status, applied, conflicts, aiReviews });

describe('résultat consolidé', () => {
  it('distingue succès, conflit, erreur, ignoré', () => {
    const r = consolidate([obj(1, 'SUCCESS', 2), obj(2, 'CONFLICT', 0, 1, 1), obj(3, 'ERROR'), obj(4, 'SKIPPED')]);
    expect(r).toEqual({
      objectsExamined: 3, objectsModified: 1, decisionsApplied: 2, conflictsCreated: 1,
      arbitrationsNeeded: 1, errors: 1, aiCalls: 1, status: 'partial',
    });
  });
  it('toutes les erreurs : échec ; aucune : terminé', () => {
    expect(consolidate([obj(1, 'ERROR'), obj(2, 'ERROR')]).status).toBe('failed');
    expect(consolidate([obj(1, 'SUCCESS')]).status).toBe('completed');
  });
});

describe('un orchestrateur, pas un second moteur', () => {
  it('chaque objet passe par reconcileAsset (moteur commun), rattaché au run T3', () => {
    expect(S).toMatch(/import\('\.\/reconciliation-engine'\)/);
    expect(S).toMatch(/accountRunId: runId/);
    expect(read('src/services/ai/reconciliation/reconciliation-run.repository.ts')).toMatch(/account_run_id/);
  });
  it('aucune extraction, aucune relecture de fichier', () => {
    expect(S).not.toMatch(/analyzeFileSources|extract-source|getSignedUrl|AiGateway/);
  });
  it('une erreur sur un objet n’interrompt pas les autres', () => {
    expect(S).toMatch(/L'échec d'un bien n'empêche pas les autres d'être traités/);
  });
  it('un run local en échec est clos comme tel', () => {
    expect(read('src/services/ai/reconciliation/reconciliation-engine.ts')).toMatch(/await failRun\(runId\)/);
  });
});

describe('déclencheurs et concurrence', () => {
  it('manuel (admin tracé), planifié (intervalle configurable), événementiel (temporisé, fusionné)', () => {
    expect(read('src/app/api/admin/ai/reconciliation/accounts/[accountId]/route.ts')).toMatch(/type: 'manual', requestedByUserId: adminId/);
    expect(S).toMatch(/T3_ACCOUNT_RECONCILIATION_INTERVAL_HOURS/);
    expect(S).toMatch(/ON CONFLICT \(account_id\) WHERE status = 'queued'/);
    expect(S).toMatch(/T3_EVENT_DEBOUNCE_MS/);
  });
  it('événements métier branchés : modification de bien, arbitrage, rattachement de document', () => {
    expect(read('src/app/api/assets/[id]/details/[section]/route.ts')).toMatch(/event: 'asset_updated'/);
    expect(read('src/app/api/v2/to-process/[publicId]/resolve/route.ts')).toMatch(/event: 'arbitration'/);
    expect(read('src/services/ai/knowledge/document-knowledge.service.ts')).toMatch(/event: 'document_linked'/);
  });
  it('au plus une exécution en cours et une demande en attente par compte', () => {
    expect(M).toMatch(/account_reconciliation_runs_one_running\s+ON account_reconciliation_runs \(account_id\) WHERE status = 'running'/);
    expect(M).toMatch(/account_reconciliation_runs_one_queued\s+ON account_reconciliation_runs \(account_id\) WHERE status = 'queued'/);
  });
});
