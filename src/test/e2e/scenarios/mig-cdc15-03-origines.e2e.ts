/**
 * MIG-03 (CDC 15 §14 point 3, T3-02) sur base réelle : origines d'une fiche
 * ancien format (`_origin = auto`, aucune origine), historique
 * `ai_field_updates` et journal 0216. Simulation, application, relance.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

scenario('MIG-03', 'Rattrapage CDC 15 — origines', ({ sql, make }) => {
  it('USER prouvé ou par défaut, IA prouvée, humain jamais rétrogradé ; relance sans effet', async () => {
    const { runCdc15Backfill } = await import('@/services/migration/cdc15');
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Clio', keyCharacteristics: {
      mileage: 45000, mileage_origin: 'auto',
      vin: 'VF1ABC', vin_origin: 'auto',
      registrationNumber: 'AB-123-CD',
      make: 'Renault', make__origin: 'USER',
      model: 'Clio', model__origin: 'RECONCILIATION',
    } });
    await sql`INSERT INTO ai_field_updates (account_id, asset_id, field_key, old_value, new_value) VALUES (${compte.id}, ${bien.id}, 'mileage', NULL, '45000')`;
    await sql`INSERT INTO ai_field_updates (account_id, asset_id, field_key, old_value, new_value) VALUES (${compte.id}, ${bien.id}, 'vin', NULL, 'VF1XXX')`;
    await sql`INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, outcome, dry_run)
              VALUES (${compte.id}, ${bien.id}, 'model', '"Megane"'::jsonb, '"Clio"'::jsonb, 'USER', 'asset_details', 'written', false)`;
    const kc = async () => JSON.parse((await sql<{ k: string }[]>`SELECT key_characteristics AS k FROM assets WHERE id = ${bien.id}`)[0].k);
    const run = (apply: boolean) => runCdc15Backfill({ sql, steps: ['MIG-03'], accountId: compte.id, apply });

    const avant = await kc();
    const dry = await run(false);
    expect(await kc()).toEqual(avant);
    expect(dry.results[0].counts.APPLIED).toBe(4);

    await run(true);
    const k = await kc();
    expect(k).toMatchObject({
      mileage: 45000, mileage__origin: 'RECONCILIATION', // IA prouvée pour la valeur en place
      vin__origin: 'USER', // drapeau « auto », mais la dernière écriture IA porte une autre valeur : protégé
      registrationNumber__origin: 'USER', // aucune information : protégé
      make__origin: 'USER', // humain : intact
      model__origin: 'USER', // écriture humaine prouvée
    });
    expect(k).not.toHaveProperty('mileage_origin');
    const raisons = await sql<{ field_key: string; reason: string }[]>`
      SELECT field_key, reason FROM cdc15_migration_report WHERE account_id = ${compte.id} AND step = 'MIG-03' AND run_mode = 'apply' ORDER BY field_key`;
    expect(Object.fromEntries(raisons.map((r) => [r.field_key, r.reason]))).toEqual({
      mileage: 'AI_WRITE_PROVEN', model: 'HUMAN_WRITE_PROVEN', registrationNumber: 'NO_AI_PROOF_PROTECTED', vin: 'NO_AI_PROOF_PROTECTED',
    });

    const again = await run(true);
    expect(again.results[0].counts.APPLIED).toBe(0);
    expect(await kc()).toEqual(k);
  });
});
