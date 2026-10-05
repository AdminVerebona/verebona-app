/**
 * Lot 16b-3a (retrait de l'ancien moteur IA pour T1) sur base réelle.
 *
 *   · Migration 0233 : lignes T1 de la configuration IA passées en `master`,
 *     idempotente ; T3 intacte ; une ligne stockée `steps` est lue `master`.
 *   · Échec du master T1 (plus de repli « étapes ») : sous la file durable,
 *     le job ÉCHOUE et est repris avec backoff, le fichier repasse « en file »
 *     (jamais perdu), aucun crédit n'est consommé ; la reprise réussie
 *     consomme UN crédit ; au dernier essai, l'échec motivé reste affiché.
 *   · Échec d'une analyse directe (hors file) : la source repart en file
 *     durable, différée, avec la facturation de la demande initiale.
 *   · Variables retirées encore posées (`AI_UNIFIED_SOURCE_ANALYSIS=legacy`,
 *     `AI_T1_ANALYSIS_MODE=legacy`) : sans effet.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { sortieT1, useTargetState } from '../chain';

// Quota et crédits observés : le compte de test n'a pas d'offre réelle.
const credits = vi.hoisted(() => ({ consume: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: (...a: unknown[]) => credits.consume(...a),
}));

scenario('L16B-3', 'T1 en master seul (migration 0233), échec du master repris par la file durable', ({ sql, make, useRecordings }) => {
  useTargetState({ AI_UNIFIED_SOURCE_ANALYSIS: 'legacy', AI_T1_ANALYSIS_MODE: 'legacy' });

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

  /** Fichier analysable par l'adaptateur de production (objet S3 fictif, URL signée locale). */
  const fichierAnalysable = async (compteId: Parameters<typeof make.assetFile>[0]) => {
    const f = await make.assetFile(compteId);
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f;
  };
  const etat = async (id: number) => (await sql<{ analysis_state: string | null; analysis_fail_reason: string | null; analysis_retry_count: number }[]>`
    SELECT analysis_state, analysis_fail_reason, analysis_retry_count FROM asset_files WHERE id = ${id}`)[0];
  const jobDe = async (id: number) => (await sql<{ id: number; status: string; attempts: number; available_at: Date; last_error: string | null; payload: Record<string, unknown> }[]>`
    SELECT id, status, attempts, available_at, last_error, payload FROM ai_job_queue
     WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(id)} ORDER BY id DESC LIMIT 1`)[0];

  it('migration 0233 : T1 en master, idempotente, T3 intacte ; lecture et brouillon en master', async () => {
    const [v] = await sql<{ id: number }[]>`
      INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'e2e 0233') RETURNING id`;
    for (const t of ['T1', 'T3']) {
      await sql`INSERT INTO ai_config_entries (version_id, treatment, prompt, prompt_architecture)
                VALUES (${v.id}, ${t}, '', 'steps')`;
    }
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0233_ai_config_t1_master_only.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const lignes = await sql<{ treatment: string; prompt_architecture: string }[]>`
      SELECT treatment, prompt_architecture FROM ai_config_entries WHERE version_id = ${v.id} ORDER BY treatment`;
    expect(lignes.map((l) => [l.treatment, l.prompt_architecture])).toEqual([['T1', 'master'], ['T3', 'steps']]);

    // Une ligne stockée `steps` (avant la migration) est de toute façon LUE `master`.
    await sql`UPDATE ai_config_entries SET prompt_architecture = 'steps' WHERE version_id = ${v.id} AND treatment = 'T1'`;
    const repo = await import('@/services/ai/config/config-version.repository');
    const lue = await repo.getVersion(v.id);
    expect(lue?.entries.find((e) => e.treatment === 'T1')?.promptArchitecture).toBe('master');

    const user = await make.user();
    const draft = await repo.createDraft(user.id, 'e2e 0233 brouillon', 'local');
    const [stockee] = await sql<{ prompt_architecture: string }[]>`
      SELECT prompt_architecture FROM ai_config_entries WHERE version_id = ${draft.id} AND treatment = 'T1'`;
    expect(stockee.prompt_architecture).toBe('master');
  });

  it('file durable : échec du master → job repris (backoff), fichier « en file », aucun crédit ; reprise réussie → un crédit', async () => {
    await ecarterLesAutresJobsT1();
    credits.consume.mockClear();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    registerSourceAnalysisHandler();

    // Dépôt (facturable). Aucune sortie enregistrée : toute la chaîne de modèles échoue.
    await useRecordings([]);
    expect(await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId })).toEqual([f.id]);
    expect(await runOne('T1')).toBe(true);

    const apresEchec = await jobDe(f.id);
    expect(apresEchec).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(apresEchec.last_error).toMatch(/en échec/);
    expect(new Date(apresEchec.available_at).getTime()).toBeGreaterThan(Date.now()); // backoff
    // Jamais perdu : « en file » (un job l'attend), motif précis conservé, essai compté.
    expect(await etat(f.id)).toMatchObject({ analysis_state: 'UPLOADED', analysis_retry_count: 1 });
    expect((await etat(f.id)).analysis_fail_reason).toMatch(/prompt maître T1/);
    expect(credits.consume).not.toHaveBeenCalled();
    // Bandeau (E-06) : « en file », avec l'heure de la prochaine tentative.
    const { getT1QueueStatus } = await import('@/services/ai/source-analysis/queue/t1-status');
    const bandeau = (await getT1QueueStatus(compte.id)).files.find((x) => x.fileId === f.id);
    expect(bandeau).toMatchObject({ state: 'queued', nextAttemptAt: expect.any(String) });

    // Le modèle répond à nouveau : la reprise aboutit et consomme UN crédit.
    await useRecordings([{
      operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT',
      output: sortieT1({ title: 'Facture entretien', date: '2026-03-14', documentTypeCode: 'MAINTENANCE_INVOICE', assets: [], facts: [] }),
    }]);
    await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${apresEchec.id}`;
    expect(await runOne('T1')).toBe(true);
    expect((await jobDe(f.id)).status).toBe('DONE');
    expect((await etat(f.id)).analysis_state).toMatch(/^(ANALYZED|VALIDATION_REQUIRED)$/);
    expect(credits.consume).toHaveBeenCalledTimes(1);
    expect(credits.consume).toHaveBeenCalledWith(compte.id, 1);
  });

  it('dernier essai en échec : ANALYSIS_FAILED motivé, visible (bandeau), jamais « en file » sans job', async () => {
    await ecarterLesAutresJobsT1();
    credits.consume.mockClear();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    const { enqueueFileAnalyses, registerSourceAnalysisHandler } = await import('@/services/ai/source-analysis/queue/t1-handler');
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    const { MAX_ATTEMPTS } = await import('@/services/ai/queue/queue-policy');
    registerSourceAnalysisHandler();
    await useRecordings([]);

    await enqueueFileAnalyses([f.id], compte.id, { origin: 'documents/analyze-batch', userId: compte.ownerUserId });
    const job = await jobDe(f.id);
    // Avant-dernier essai consommé : le prochain échec est définitif.
    await sql`UPDATE ai_job_queue SET attempts = ${MAX_ATTEMPTS - 1} WHERE id = ${job.id}`;
    expect(await runOne('T1')).toBe(true);

    expect((await jobDe(f.id)).status).toBe('FAILED');
    const e = await etat(f.id);
    expect(e.analysis_state).toBe('ANALYSIS_FAILED');
    expect(e.analysis_fail_reason).toMatch(/Analyse impossible \(prompt maître T1\)/);
    expect(credits.consume).not.toHaveBeenCalled();

    // Bandeau (E-06) : l'échec est lu, rien n'est relancé.
    const { getT1QueueStatus } = await import('@/services/ai/source-analysis/queue/t1-status');
    const s = await getT1QueueStatus(compte.id);
    expect(s.files.find((x) => x.fileId === f.id)).toBeUndefined(); // plus « en file »
  });

  it('analyse directe (hors file) en échec : source remise en file durable, différée, même facturation', async () => {
    await ecarterLesAutresJobsT1();
    credits.consume.mockClear();
    const compte = await make.account();
    const f = await fichierAnalysable(compte);
    await useRecordings([]);

    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([f.id], compte.id, { userId: compte.ownerUserId, origin: 'documents/analyze' });
    expect(r).toMatchObject({ analysedCount: 0, failedSourceIds: [f.id] });
    expect(credits.consume).not.toHaveBeenCalled();

    const job = await jobDe(f.id);
    expect(job).toMatchObject({ status: 'PENDING', payload: { fileId: f.id, origin: 'documents/analyze:reprise' } });
    expect(job.payload).not.toHaveProperty('billable');
    expect(new Date(job.available_at).getTime()).toBeGreaterThan(Date.now());
    expect((await etat(f.id)).analysis_state).toBe('UPLOADED');
    // Lot d'analyse ouvert puis clos en échec partiel (traçabilité du dépôt).
    const [lot] = await sql<{ status: string }[]>`
      SELECT l.status FROM document_lots l JOIN document_lot_items i ON i.lot_id = l.id
       WHERE i.asset_file_id = ${f.id} ORDER BY l.id DESC LIMIT 1`;
    expect(lot.status).toBe('partially_failed');
  });
});
