/**
 * MIG-07 (CDC 15 §14 point 7, D-10) sur base réelle : colonnes historiques
 * et fiche d'un jeu ancien format.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

scenario('MIG-07', 'Rattrapage CDC 15 — colonnes historiques ↔ fiche', ({ sql, make }) => {
  it('fiche humaine fait foi, colonne vide remplie, fiche remplie depuis la colonne ; automatique ≠ colonne → carte', async () => {
    const { runCdc15Backfill } = await import('@/services/migration/cdc15');
    const compte = await make.account();
    const a = await make.asset(compte, { category: 'VEHICULE', registrationNumber: 'ZZ-999-ZZ', purchaseDate: '2019-01-01',
      keyCharacteristics: { registrationNumber: 'AB-123-CD', registrationNumber__origin: 'USER', mileage: 45000 } });
    const b = await make.asset(compte, { category: 'VEHICULE', registrationNumber: 'ZZ-999-ZZ',
      keyCharacteristics: { registrationNumber: 'AB-123-CD', registrationNumber__origin: 'DOCUMENT_EXTRACTION' } });
    // Origine USER seulement PRÉSUMÉE (posée par MIG-03 faute de preuve IA) : colonne jamais écrasée.
    const c = await make.asset(compte, { category: 'VEHICULE', registrationNumber: 'YY-888-YY',
      keyCharacteristics: { registrationNumber: 'CD-456-EF', registrationNumber__origin: 'USER', registrationNumber__originBasis: 'NO_AI_PROOF_PROTECTED' } });
    const lire = async (id: number) => (await sql<{ k: string; r: string | null; m: number | null; d: string | null }[]>`
      SELECT key_characteristics AS k, registration_number AS r, mileage_or_hours AS m, purchase_date::text AS d FROM assets WHERE id = ${id}`)[0];
    const run = (apply: boolean) => runCdc15Backfill({ sql, steps: ['MIG-07'], accountId: compte.id, apply });

    const dry = await run(false);
    expect(dry.results[0].counts).toMatchObject({ APPLIED: 3, AMBIGUOUS: 2 });
    expect((await lire(a.id)).r).toBe('ZZ-999-ZZ');

    const app = await run(true);
    const la = await lire(a.id);
    expect(la).toMatchObject({ r: 'AB-123-CD', m: 45000, d: '2019-01-01' });
    expect(JSON.parse(la.k)).toMatchObject({ acquisitionDate: '2019-01-01', acquisitionDate__origin: 'USER' });
    expect((await lire(b.id)).r).toBe('ZZ-999-ZZ'); // jamais écrasée sans l'utilisateur
    expect((await lire(c.id)).r).toBe('YY-888-YY');
    const cartes = await sql`SELECT target_id, relation_key, proposals_json FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'MIG-REVIEW' ORDER BY target_id`;
    expect(cartes.map((x) => [x.target_id, x.relation_key])).toEqual([[b.id, 'mig:MIG-07:registrationNumber'], [c.id, 'mig:MIG-07:registrationNumber']]);
    expect((cartes[0].proposals_json as Array<{ value: string }>).map((p) => p.value).sort()).toEqual(['AB-123-CD', 'ZZ-999-ZZ']);
    // Copie restaurable en clair, hors rapport ; le rapport ne contient pas la table des copies.
    const copies = await sql`SELECT target_type, name, old_value, new_value FROM cdc15_migration_backups WHERE run_id = ${app.runId} AND target_type = 'asset_column' ORDER BY id`;
    expect(copies.map((x) => [x.name, x.old_value, x.new_value])).toEqual([
      ['registration_number', { v: 'ZZ-999-ZZ' }, { v: 'AB-123-CD' }], ['mileage_or_hours', { v: null }, { v: '45000' }],
    ]);
    const kcCopies = await sql`SELECT name FROM cdc15_migration_backups WHERE run_id = ${app.runId} AND target_type = 'asset_kc' ORDER BY name`;
    expect(kcCopies.map((x) => x.name)).toEqual(['acquisitionDate', 'acquisitionDate__origin']);

    const again = await run(true);
    expect(again.results[0].counts.APPLIED).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'MIG-REVIEW'`)[0].n).toBe(2);

    // --restore : colonnes remises ; une colonne modifiée depuis n'est pas touchée ; relance sans effet.
    const { restoreCdc15Run } = await import('@/services/migration/cdc15');
    await sql`UPDATE assets SET mileage_or_hours = 50000 WHERE id = ${a.id}`;
    const r1 = await restoreCdc15Run(sql, app.runId);
    expect(r1).toEqual({ restored: 3, conflicts: [{ targetType: 'asset_column', targetId: a.id, name: 'mileage_or_hours' }] });
    const ra = await lire(a.id);
    expect(ra).toMatchObject({ r: 'ZZ-999-ZZ', m: 50000 });
    expect(JSON.parse(ra.k)).not.toHaveProperty('acquisitionDate');
    expect(await restoreCdc15Run(sql, app.runId)).toEqual({ restored: 0, conflicts: [{ targetType: 'asset_column', targetId: a.id, name: 'mileage_or_hours' }] });
  });
});
