/**
 * Lot 16b-2 (retrait de l'ancien moteur IA pour T2 et T4) sur base réelle.
 *
 *   · Migration 0232 : lignes T2/T4 de la configuration IA passées en
 *     `master`, idempotente ; T1/T3 intactes ; lecture et brouillons en
 *     `master` pour T2/T4.
 *   · Agenda manuel sans `AgendaClassificationService` : un cas tranché par
 *     les règles est classé sans appel modèle ; un cas ambigu passe par la
 *     branche CLASSIFY_EVENT du master T4 et, si le modèle échoue, prend la
 *     catégorie prudente « action » — la création n'échoue jamais.
 *   · Variables retirées encore posées (`AI_T4_EFFECTS=legacy`,
 *     `AI_AGENDA_ENGINE=legacy`) : sans effet.
 */
import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

scenario('L16B-2', 'T2 et T4 en master seul (migration 0232), agenda manuel sans classifieur historique', ({ sql, make, replay }) => {
  const env = { ...process.env };
  afterEach(() => {
    for (const k of ['AI_T4_EFFECTS', 'AI_AGENDA_ENGINE']) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
  });

  it('migration 0232 : T2/T4 en master, idempotente, T1/T3 intactes ; lecture et brouillon en master', async () => {
    const [v] = await sql<{ id: number }[]>`
      INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'e2e 0232') RETURNING id`;
    for (const t of ['T1', 'T2', 'T3', 'T4']) {
      await sql`INSERT INTO ai_config_entries (version_id, treatment, prompt, prompt_architecture)
                VALUES (${v.id}, ${t}, '', 'steps')`;
    }
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0232_ai_config_t2_t4_master_only.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const lignes = await sql<{ treatment: string; prompt_architecture: string }[]>`
      SELECT treatment, prompt_architecture FROM ai_config_entries WHERE version_id = ${v.id} ORDER BY treatment`;
    expect(lignes.map((l) => [l.treatment, l.prompt_architecture])).toEqual([['T1', 'steps'], ['T2', 'master'], ['T3', 'steps'], ['T4', 'master']]);

    // Une ligne stockée `steps` (avant la migration) est de toute façon LUE `master`.
    await sql`UPDATE ai_config_entries SET prompt_architecture = 'steps' WHERE version_id = ${v.id} AND treatment = 'T4'`;
    const repo = await import('@/services/ai/config/config-version.repository');
    const lue = await repo.getVersion(v.id);
    expect(lue?.entries.find((e) => e.treatment === 'T4')?.promptArchitecture).toBe('master');

    // Nouveau brouillon : T2/T4 écrits en `master`.
    const user = await make.user();
    const draft = await repo.createDraft(user.id, 'e2e 0232 brouillon', 'local');
    const stockees = await sql<{ treatment: string; prompt_architecture: string }[]>`
      SELECT treatment, prompt_architecture FROM ai_config_entries
       WHERE version_id = ${draft.id} AND treatment IN ('T2', 'T4') ORDER BY treatment`;
    expect(stockees.map((l) => l.prompt_architecture)).toEqual(['master', 'master']);
  });

  it('agenda manuel : règles d’abord (aucun appel), master T4 en échec → « action » prudente, création réussie', async () => {
    process.env.AI_T4_EFFECTS = 'legacy';
    process.env.AI_AGENDA_ENGINE = 'legacy';
    const write = await import('@/services/agenda/AgendaWriteService');
    const compte = await make.account();
    const bien = await make.asset(compte);
    const avant = replay.calls.length;

    // Tranché par le registre (champ « prochain contrôle ») : aucun appel modèle.
    const ct = await write.createAgendaItem({
      title: 'Contrôle technique', startDate: '2099-03-01', assetIds: [bien.id], originFieldKey: 'nextInspection',
    }, compte.id, compte.ownerUserId);
    expect(replay.calls.length).toBe(avant);

    // Ambigu : branche CLASSIFY_EVENT du master T4, sans sortie enregistrée
    // (échec du modèle) → catégorie prudente, jamais d'erreur.
    const rdv = await write.createAgendaItem({
      title: 'Point avec M. Durand', startDate: '2099-04-01', assetIds: [bien.id],
    }, compte.id, compte.ownerUserId);
    const appels = replay.calls.slice(avant);
    // Modèle principal puis replis de la passerelle : tous sur la branche T4.
    expect(appels.length).toBeGreaterThan(0);
    expect(new Set(appels.map((c) => c.operationCode))).toEqual(new Set(['t4_classify_event']));

    const cats = await sql<{ id: number; home_category: string }[]>`
      SELECT id, home_category FROM agenda_items WHERE id IN (${ct.id}, ${rdv.id}) ORDER BY id`;
    expect(cats.map((c) => c.home_category)).toEqual(['action', 'action']);
  });
});
