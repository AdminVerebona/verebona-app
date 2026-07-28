/**
 * Exécution des contrôles avant activation — CDC §4.5.5.
 *
 * Orchestration : exécute le corpus sur la version candidate, puis sur la
 * version active pour comparaison, et applique les neuf contrôles.
 *
 * Un contrôle bloquant en échec fait passer la demande en `TEST_FAILED` : il
 * n'existe aucun chemin permettant d'activer une version dont les tests
 * échouent (critère d'acceptation n°18).
 */
import { pgClient } from '@/db';
import { runAllChecks } from './checks';
import { isCorpusComplete } from './corpus/corpus-registry';
import type { CorpusRunResult } from './corpus/corpus-registry';
import type { CheckResult, TestRunReport } from './types';

export interface TestRunInput {
  changeRequestId: number;
  candidate: CorpusRunResult;
  baseline: CorpusRunResult | null;
}

export async function runTests(input: TestRunInput): Promise<TestRunReport> {
  const startedAt = Date.now();
  const checks: CheckResult[] = runAllChecks({ candidate: input.candidate, baseline: input.baseline });

  // Contrôle préalable sur le corpus lui-même : un corpus incomplet ne permet
  // pas d'affirmer la non-régression, même si tous les contrôles passent.
  const corpus = isCorpusComplete();
  checks.unshift({
    checkCode: 'corpus_coverage',
    label: 'Couverture du corpus de référence',
    passed: corpus.complete,
    blocking: true,
    detail: corpus.complete
      ? 'les treize catégories du §11.1 sont représentées'
      : `catégories sans cas : ${corpus.missing.join(', ')}`,
  });

  const blockingFailures = checks
    .filter((c) => c.blocking && !c.passed)
    .map((c) => c.checkCode);

  const report: TestRunReport = {
    runId: await persistRun(input.changeRequestId, checks, blockingFailures.length === 0),
    changeRequestId: input.changeRequestId,
    checks,
    passed: blockingFailures.length === 0,
    blockingFailures,
    durationMs: Date.now() - startedAt,
  };

  return report;
}

async function persistRun(
  changeRequestId: number,
  checks: CheckResult[],
  passed: boolean,
): Promise<number> {
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_prompt_test_runs (change_request_id, passed, checks_json, finished_at)
     VALUES ($1, $2, $3::jsonb, NOW()) RETURNING id`,
    [changeRequestId, passed, JSON.stringify(checks)] as never[],
  );
  return (rows as unknown as Array<{ id: number }>)[0].id;
}
