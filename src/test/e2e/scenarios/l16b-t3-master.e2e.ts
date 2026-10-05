/**
 * Lot 16b-3b (retrait de l'ancien moteur IA : T3, D-H1, commutateurs) sur
 * base réelle.
 *
 *   · Migration 0234 : TOUTES les lignes de configuration IA (T1 à T6) passées
 *     en `master`, idempotente ; valeur par défaut de la colonne alignée ;
 *     une ligne stockée `steps` est lue `master` ; `steps` demandé pour T3
 *     est refusé.
 *   · Validation d'un document (`POST /api/documents/[id]/commit`, service
 *     `validateDocumentProposals`, remplace `commit-engine`) : propositions
 *     conservées, document « analysé », fiche du bien et agenda intacts.
 *   · Revue 3a : échec DÉFINITIF du master T1 (sortie invalide sur toute la
 *     chaîne) → compteur porté au plafond, la reprise serveur ne le relance
 *     plus ; un échec transitoire reste relancé.
 */
import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

// Revue 3a : issue du master T1 pilotée par le test (aucun appel modèle).
const master = vi.hoisted(() => ({ code: 'INVALID_OUTPUT' as string }));
vi.mock('@/services/ai/source-analysis/master/analyse-group-master', async () => {
  const { AiGatewayError } = await import('@/services/ai/gateway/errors');
  return {
    analyseGroupWithMaster: async () => {
      throw new AiGatewayError('ALL_MODELS_FAILED', 't1_analyze_document', 'Tous les modèles ont échoué (e2e).',
        { recoverable: true, lastFailureCode: master.code as never });
    },
  };
});
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));

scenario('L16B-3B', 'T3 en master seul (migration 0234), validation de document sans moteur historique', ({ sql, make }) => {
  const TRAITEMENTS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];

  it('migration 0234 : T1 à T6 en master, idempotente, défaut de colonne master ; lecture et refus de `steps`', async () => {
    const [v] = await sql<{ id: number }[]>`
      INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'e2e 0234') RETURNING id`;
    for (const t of TRAITEMENTS) {
      await sql`INSERT INTO ai_config_entries (version_id, treatment, prompt, prompt_architecture)
                VALUES (${v.id}, ${t}, '', 'steps')`;
    }
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0234_ai_config_t3_master_only.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const lignes = await sql<{ treatment: string; prompt_architecture: string }[]>`
      SELECT treatment, prompt_architecture FROM ai_config_entries WHERE version_id = ${v.id} ORDER BY treatment`;
    expect(lignes.map((l) => [l.treatment, l.prompt_architecture])).toEqual(TRAITEMENTS.map((t) => [t, 'master']));
    const [defaut] = await sql<{ d: string | null }[]>`
      SELECT column_default AS d FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'ai_config_entries' AND column_name = 'prompt_architecture'`;
    expect(defaut.d).toMatch(/'master'/);
    // Plus aucune ligne `steps` dans la base de recette (contrôle STORED_STEPS du garde).
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ai_config_entries WHERE prompt_architecture IS DISTINCT FROM 'master'`;
    expect(n).toBe(0);

    // Une ligne réécrite `steps` (ancien code) est de toute façon LUE `master`.
    await sql`UPDATE ai_config_entries SET prompt_architecture = 'steps' WHERE version_id = ${v.id} AND treatment = 'T3'`;
    const repo = await import('@/services/ai/config/config-version.repository');
    const lue = await repo.getVersion(v.id);
    expect(lue?.entries.find((e) => e.treatment === 'T3')?.promptArchitecture).toBe('master');

    // `steps` explicitement demandé pour T3 : refusé, rien n'est écrit.
    const user = await make.user();
    const { saveTreatmentConfig } = await import('@/services/ai/config/config-version.service');
    const t3 = lue!.entries.find((e) => e.treatment === 'T3')!;
    await expect(saveTreatmentConfig(v.id, { ...t3, promptArchitecture: 'steps' as never }, user.id))
      .rejects.toMatchObject({ code: expect.any(String) });
    await sql`UPDATE ai_config_entries SET prompt_architecture = 'master' WHERE version_id = ${v.id}`;
  });

  it('validation d’un document : propositions conservées, état ANALYZED, fiche et agenda intacts', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', keyCharacteristics: { mileage: 1000 } });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET analysis_state = 'VALIDATION_REQUIRED' WHERE id = ${doc.id}`;
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id)
      VALUES (${doc.id}, 'h', 't1_master_v1@file', 'replay', 'm', 'completed', true, ${compte.id}) RETURNING id`;
    // Clés historiques que l'ancien moteur appliquait directement (asset_files, fiche).
    for (const [type, cle, valeur] of [['link', 'matchedAssetId', bien.id], ['field', 'retainedTitle', 'Facture garage']] as const) {
      await sql`INSERT INTO document_analysis_proposals (run_id, asset_file_id, proposal_type, target_key, proposed_value_json, account_id)
                VALUES (${run.id}, ${doc.id}, ${type}, ${cle}, ${JSON.stringify(valeur)}, ${compte.id})`;
    }
    const avant = await sql<{ kc: string; updated_at: string }[]>`SELECT key_characteristics AS kc, updated_at::text FROM assets WHERE id = ${bien.id}`;
    const [{ n: agendaAvant }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`;

    const { validateDocumentProposals } = await import('@/services/documents/document-validation.service');
    expect(await validateDocumentProposals(doc.id, compte.id)).toEqual({ committed: true, appliedFields: [], agendaEffectsProcessed: 0 });

    const props = await sql<{ status: string; proposed: string; final: string | null }[]>`
      SELECT status, proposed_value_json AS proposed, final_value_json AS final FROM document_analysis_proposals WHERE run_id = ${run.id} ORDER BY id`;
    expect(props.every((p) => p.status === 'kept' && p.final === p.proposed)).toBe(true);
    const [f] = await sql<{ analysis_state: string; retained_title: string | null }[]>`
      SELECT analysis_state, retained_title FROM asset_files WHERE id = ${doc.id}`;
    expect(f.analysis_state).toBe('ANALYZED');
    expect(f.retained_title).toBeNull(); // jamais écrit hors primitive
    expect(await sql`SELECT key_characteristics AS kc, updated_at::text FROM assets WHERE id = ${bien.id}`).toEqual(avant);
    const [{ n: agendaApres }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`;
    expect(agendaApres).toBe(agendaAvant);

    // Autre compte : refusé (aucun run de référence visible).
    const autre = await make.account();
    await expect(validateDocumentProposals(doc.id, autre.id)).rejects.toThrow(/No current reference run/);
  });

  it('revue 3a : échec définitif au plafond, jamais relancé par la reprise serveur ; échec transitoire relancé', async () => {
    // Client S3 : URL signée calculée localement, aucun appel réseau (comme `chain.ts`).
    process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
    process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
    process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
    process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
    const compte = await make.account();
    const fichier = async () => {
      const f = await make.assetFile(compte);
      await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
      return f.id;
    };
    // Point d'entrée applicatif (critère 24), sans remise en file : seul le
    // compteur écrit par le pipeline est observé ici.
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const lancer = (id: number) => analyzeFileSources([id], compte.id, { userId: compte.ownerUserId, origin: 'e2e', retryOnFailure: false });

    master.code = 'INVALID_OUTPUT';
    const definitif = await fichier();
    expect(await lancer(definitif)).toMatchObject({ failedSourceIds: [definitif], definitiveFailedSourceIds: [definitif] });
    master.code = 'PROVIDER_UNAVAILABLE';
    const transitoire = await fichier();
    expect(await lancer(transitoire)).toMatchObject({ failedSourceIds: [transitoire], definitiveFailedSourceIds: [] });

    const etats = await sql<{ id: number; analysis_state: string; analysis_retry_count: number }[]>`
      SELECT id, analysis_state, analysis_retry_count FROM asset_files WHERE id IN (${definitif}, ${transitoire}) ORDER BY id`;
    expect(etats.map((e) => [e.id, e.analysis_state, e.analysis_retry_count])).toEqual([
      [definitif, 'ANALYSIS_FAILED', 10], [transitoire, 'ANALYSIS_FAILED', 1],
    ]);

    const { runAnalysisRecovery } = await import('@/services/document-ai/analysis-recovery.service');
    await runAnalysisRecovery(compte.id);
    const jobs = await sql<{ target_id: string }[]>`
      SELECT target_id FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file'
         AND status IN ('PENDING', 'RUNNING') AND target_id IN (${String(definitif)}, ${String(transitoire)})`;
    expect(jobs.map((j) => Number(j.target_id))).toEqual([transitoire]);
    // Rien ne doit rester en file pour les autres scénarios.
    await sql`UPDATE ai_job_queue SET status = 'DONE', finished_at = now() WHERE treatment = 'T1' AND target_id = ${String(transitoire)} AND status IN ('PENDING', 'RUNNING')`;
  });
});
