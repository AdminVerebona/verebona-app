/**
 * Lot 16b-1 (retrait de l'ancien moteur IA) sur base réelle.
 *
 *   · File T1 DURABLE SEULE (file mémoire, `AI_DURABLE_QUEUE` et
 *     `/api/analysis/check-pending` retirés) : mise en file persistée et
 *     dédupliquée, état du fichier lisible par le bandeau, reprise d'une
 *     exécution abandonnée (redémarrage), prélèvement concurrent sans double
 *     prise (plusieurs instances, `SKIP LOCKED`), état du fichier aligné sur
 *     l'issue du job.
 *   · Migration 0231 : lignes T5/T6 de la configuration IA passées en
 *     `master`, idempotente ; T1–T4 intactes ; lecture et brouillons en
 *     `master` pour T5/T6.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

scenario('L16B-1', 'File T1 durable seule ; T5/T6 en master (migration 0231)', ({ sql, make }) => {
  // Les autres scénarios peuvent laisser des jobs T1 en attente dans la base
  // partagée : ils sont mis hors d'atteinte le temps de ce scénario.
  const ecartes: number[] = [];
  const ecarterLesAutresJobsT1 = async () => {
    const rows = await sql<{ id: number }[]>`
      UPDATE ai_job_queue SET available_at = now() + interval '1 day'
       WHERE treatment = 'T1' AND status = 'PENDING' AND available_at <= now() RETURNING id`;
    ecartes.push(...rows.map((r) => Number(r.id)));
  };
  beforeAll(ecarterLesAutresJobsT1);
  afterAll(async () => {
    if (ecartes.length) await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ANY(${ecartes})`;
  });

  it('mise en file durable : job persisté, fichier « en file », doublon écarté, état lu par le bandeau', async () => {
    const acc = await make.account();
    const f = await make.assetFile(acc);
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');

    expect(await enqueueFileAnalyses([f.id], acc.id, { origin: 'documents/analyze-batch', userId: acc.ownerUserId })).toEqual([f.id]);
    // WF-10 : un second dépôt du même fichier n'ajoute rien.
    expect(await enqueueFileAnalyses([f.id], acc.id, { origin: 'documents/analyze-batch' })).toEqual([]);

    const jobs = await sql<{ status: string; payload: { fileId: number; origin: string } }[]>`
      SELECT status, payload FROM ai_job_queue
       WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(f.id)}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'PENDING', payload: { fileId: f.id, origin: 'documents/analyze-batch' } });
    const [etat] = await sql<{ analysis_state: string }[]>`SELECT analysis_state FROM asset_files WHERE id = ${f.id}`;
    expect(etat.analysis_state).toBe('UPLOADED');

    // Bandeau (E-06) : lecture de l'état persistant, sans rien relancer.
    const { getT1QueueStatus } = await import('@/services/ai/source-analysis/queue/t1-status');
    const s = await getT1QueueStatus(acc.id);
    expect(s.mode).toBe('durable');
    expect(s.files).toEqual([expect.objectContaining({ fileId: f.id, state: 'queued' })]);
  });

  it('redémarrage : une exécution au bail expiré est reprise en tête ; prélèvement concurrent sans double prise', async () => {
    await ecarterLesAutresJobsT1();
    const acc = await make.account();
    const f = await make.assetFile(acc);
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const repo = await import('@/services/ai/queue/job-queue.repository');
    expect(await enqueueFileAnalyses([f.id], acc.id, { origin: 'analysis-recovery', billable: false })).toEqual([f.id]);

    // Deux instances prélèvent en même temps : une seule obtient le job.
    const [a, b] = await Promise.all([repo.claimNext('T1', 'instance-a', 60), repo.claimNext('T1', 'instance-b', 60)]);
    const pris = [a, b].filter((j) => j !== null);
    expect(pris).toHaveLength(1);
    const job = pris[0]!;
    expect(Number(job.targetId)).toBe(f.id);
    expect(job.status).toBe('RUNNING');

    // Processus arrêté brutalement : le bail n'est plus renouvelé.
    await sql`UPDATE ai_job_queue SET lease_expires_at = now() - interval '1 second' WHERE id = ${job.id}`;
    const repris = await repo.recoverAbandonedJobs();
    expect(repris).toEqual(expect.arrayContaining([{ id: job.id, status: 'PENDING' }]));
    const [apres] = await sql<{ status: string; head_priority: boolean; execution_id: string | null }[]>`
      SELECT status, head_priority, execution_id FROM ai_job_queue WHERE id = ${job.id}`;
    expect(apres).toMatchObject({ status: 'PENDING', head_priority: true, execution_id: null });

    // Reprise sur une autre instance ; l'ancienne exécution n'est plus titulaire.
    const again = await repo.claimNext('T1', 'instance-b', 60);
    expect(again?.id).toBe(job.id);
    expect(await repo.renewLease(job.id, job.executionId!, 60)).toBe(false);

    // Échec définitif : le fichier passe en échec motivé (plus jamais « en file » sans job vivant).
    const { onT1JobSettled } = await import('@/services/ai/source-analysis/queue/t1-handler');
    await onT1JobSettled(again!, { kind: 'failed', permanent: true, timedOut: true } as never);
    const [fichier] = await sql<{ analysis_state: string; analysis_fail_reason: string }[]>`
      SELECT analysis_state, analysis_fail_reason FROM asset_files WHERE id = ${f.id}`;
    expect(fichier).toMatchObject({ analysis_state: 'ANALYSIS_FAILED', analysis_fail_reason: 'Analyse interrompue : délai maximal dépassé.' });
  });

  it('§5.7 : un fichier déjà ANALYZING (analyse directe en cours) n’est pas relancé par le boucleur', async () => {
    await ecarterLesAutresJobsT1();
    const acc = await make.account();
    const f = await make.assetFile(acc);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    expect(await enqueueFileAnalyses([f.id], acc.id, { origin: 'documents/analyze-batch' })).toEqual([f.id]);
    // Analyse directe (`/api/documents/[id]/analyze`…) lancée entre-temps.
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZING', updated_at = now() WHERE id = ${f.id}`;

    registerSourceAnalysisHandler();
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    expect(await runOne('T1')).toBe(true);

    const [job] = await sql<{ status: string }[]>`
      SELECT status FROM ai_job_queue WHERE treatment = 'T1' AND target_id = ${String(f.id)} ORDER BY id DESC LIMIT 1`;
    expect(job.status).toBe('DONE');
    // L'état de l'analyse en cours n'est pas touché, aucun lot d'analyse ouvert par la file.
    const [etat] = await sql<{ analysis_state: string }[]>`SELECT analysis_state FROM asset_files WHERE id = ${f.id}`;
    expect(etat.analysis_state).toBe('ANALYZING');
  });

  it('migration 0231 : T5/T6 en master, idempotente, T1–T4 intactes ; lecture et brouillon en master', async () => {
    const [v] = await sql<{ id: number }[]>`
      INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'e2e 0231') RETURNING id`;
    for (const t of ['T1', 'T5', 'T6']) {
      await sql`INSERT INTO ai_config_entries (version_id, treatment, prompt, prompt_architecture)
                VALUES (${v.id}, ${t}, '', 'steps')`;
    }
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0231_ai_config_t5_t6_master_only.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const lignes = await sql<{ treatment: string; prompt_architecture: string }[]>`
      SELECT treatment, prompt_architecture FROM ai_config_entries WHERE version_id = ${v.id} ORDER BY treatment`;
    expect(lignes.map((l) => [l.treatment, l.prompt_architecture])).toEqual([['T1', 'steps'], ['T5', 'master'], ['T6', 'master']]);

    // Une ligne stockée `steps` (avant la migration) est de toute façon LUE `master`.
    await sql`UPDATE ai_config_entries SET prompt_architecture = 'steps' WHERE version_id = ${v.id} AND treatment = 'T6'`;
    const repo = await import('@/services/ai/config/config-version.repository');
    const lue = await repo.getVersion(v.id);
    expect(lue?.entries.find((e) => e.treatment === 'T6')?.promptArchitecture).toBe('master');

    // Nouveau brouillon : T5/T6 écrits en `master`.
    const user = await make.user();
    const draft = await repo.createDraft(user.id, 'e2e 0231 brouillon', 'local');
    const stockees = await sql<{ treatment: string; prompt_architecture: string }[]>`
      SELECT treatment, prompt_architecture FROM ai_config_entries WHERE version_id = ${draft.id} AND treatment IN ('T5', 'T6')`;
    expect(stockees.map((l) => l.prompt_architecture)).toEqual(['master', 'master']);
  });
});
