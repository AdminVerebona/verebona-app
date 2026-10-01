/**
 * MIG-05, MIG-06, MIG-08 (CDC 15 §14 points 5, 6, 8) : orchestration des
 * rattrapages existants par `runCdc15Backfill`, sur base réelle — plus les
 * garde-fous du script : filtre par compte, table manquante signalée sans
 * rien exécuter, consultation d'une exécution, reprise, `--limit`.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

scenario('MIG-05-06-08', 'Rattrapage CDC 15 — orchestration et garde-fous', ({ sql, make }) => {
  it('MIG-08, MIG-05, MIG-06 : dry-run sans écriture, --apply, relance sans effet', async () => {
    const { runCdc15Backfill } = await import('@/services/migration/cdc15');
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE' });
    // MIG-08 : document antérieur au déclencheur (aucun lien).
    const f = await make.assetFile(compte, { assetId: bien.id });
    await sql`DELETE FROM document_asset_links WHERE file_id = ${f.id}`;
    // MIG-05 : élément automatique d'une source, sans lien agenda ↔ document.
    const item = await make.agendaItem(compte, { title: 'Contrôle technique', startDate: '2027-03-01', assetIds: [bien.id] });
    await sql`UPDATE agenda_items SET is_automatic = true, origin_ref_type = 'asset_file', origin_ref_id = ${f.id}, origin_field_key = 'nextInspection'
               WHERE id = ${item.id}`;
    // MIG-06 : doublon automatique du même élément.
    const doublon = await make.agendaItem(compte, { title: 'Contrôle technique', startDate: '2027-03-01', assetIds: [bien.id] });
    await sql`UPDATE agenda_items SET is_automatic = true, origin_ref_type = 'asset_file', origin_ref_id = ${f.id}, origin_field_key = 'nextInspection'
               WHERE id = ${doublon.id}`;
    const liens = async () => (await sql`SELECT count(*)::int AS n FROM document_asset_links WHERE file_id = ${f.id} AND status = 'ACTIVE'`)[0].n;
    const lienAgenda = async () => (await sql`SELECT count(*)::int AS n FROM agenda_file_links WHERE agenda_item_id = ${item.id}`)[0].n;
    const existe = async (id: number) => (await sql`SELECT count(*)::int AS n FROM agenda_items WHERE id = ${id}`)[0].n;
    const run = (apply: boolean) => runCdc15Backfill({ sql, steps: ['MIG-08', 'MIG-05', 'MIG-06'], apply, batchSize: 1000 });

    const dry = await run(false);
    expect(await liens()).toBe(0);
    expect(await lienAgenda()).toBe(0);
    expect(await existe(doublon.id)).toBe(1);
    const estim = await sql`SELECT after_value FROM cdc15_migration_report WHERE run_id = ${dry.runId} AND step = 'MIG-08' AND entity_type = 'summary'`;
    expect((estim[0].after_value as { filesWithMissingColumnLinks: number }).filesWithMissingColumnLinks).toBeGreaterThanOrEqual(1);

    const app = await run(true);
    expect(await liens()).toBe(1);
    expect(await lienAgenda()).toBe(1);
    expect(await existe(doublon.id) + await existe(item.id)).toBe(1);
    const retires = await sql`SELECT entity_id FROM cdc15_migration_report WHERE run_id = ${app.runId} AND step = 'MIG-06' AND decision = 'APPLIED'`;
    expect(retires.map((r) => Number(r.entity_id))).toContain(doublon.id);
    expect((await sql`SELECT count(*)::int AS n FROM agenda_item_removals WHERE agenda_item_id = ${doublon.id}`)[0].n).toBe(1);

    const again = await run(true);
    for (const r of again.results) expect(r.counts.APPLIED, r.step).toBe(0);
  });

  it('--account : étapes globales ignorées ; table manquante : signalée, rien exécuté ; rapport consultable ; --limit et reprise', async () => {
    const { runCdc15Backfill, summarizeRun, formatRunSummary, MissingRequirementsError } = await import('@/services/migration/cdc15');
    const compte = await make.account();
    const biens = [];
    for (const n of [1, 2, 3]) biens.push(await make.asset(compte, { category: 'VEHICULE', name: `V${n}`, keyCharacteristics: { kilometrage: 1000 * n } }));

    const g = await runCdc15Backfill({ sql, steps: ['MIG-05', 'MIG-06', 'MIG-08'], accountId: compte.id });
    expect(g.results.map((r) => r.skipped)).toEqual(['ACCOUNT_FILTER_UNSUPPORTED', 'ACCOUNT_FILTER_UNSUPPORTED', 'ACCOUNT_FILTER_UNSUPPORTED']);

    // Table manquante : connexion dont le schéma courant ne contient rien.
    const cnx = await sql.reserve();
    const schema = `vide_${Date.now().toString(36)}`;
    try {
      await cnx.unsafe(`CREATE SCHEMA ${schema}`);
      await cnx.unsafe(`SET search_path TO ${schema}`);
      const e = await runCdc15Backfill({ sql: cnx as never, steps: ['MIG-01'], apply: true }).catch((x) => x);
      expect(e).toBeInstanceOf(MissingRequirementsError);
      expect(String(e.message)).toContain('cdc15_migration_report');
      expect(String(e.message)).toContain('ensureMigrations');
    } finally {
      await cnx.unsafe(`SET search_path TO public`);
      await cnx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      cnx.release();
    }

    // --limit : exécution partielle, puis reprise jusqu'au bout.
    const p = await runCdc15Backfill({ sql, steps: ['MIG-01'], accountId: compte.id, apply: true, limit: 2, batchSize: 1 });
    expect(p.results[0].counts.APPLIED).toBe(2);
    expect((await sql`SELECT status FROM cdc15_migration_runs WHERE run_id = ${p.runId}`)[0].status).toBe('PARTIAL');
    const r = await runCdc15Backfill({ sql, steps: ['MIG-01'], resumeRunId: p.runId, batchSize: 1 });
    expect(r.runId).toBe(p.runId);
    expect(r.results[0].counts.APPLIED).toBe(1);
    const kc = await sql<{ k: string }[]>`SELECT key_characteristics AS k FROM assets WHERE account_id = ${compte.id} ORDER BY id`;
    expect(kc.map((x) => JSON.parse(x.k).mileage)).toEqual([1000, 2000, 3000]);

    const s = await summarizeRun(sql, p.runId);
    expect(s?.run).toMatchObject({ status: 'DONE', runMode: 'apply' });
    const texte = formatRunSummary(s!);
    expect(texte).toContain('MIG-01  APPLIED');
    expect(texte).toContain('ALIAS_CANONICALIZED');
  });
});
