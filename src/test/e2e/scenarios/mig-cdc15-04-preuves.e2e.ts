/**
 * MIG-04 (CDC 15 §14 point 4) sur base réelle : preuves de deux extractions
 * successives d'une même source (ancien format, sans analyse datée).
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

scenario('MIG-04', 'Rattrapage CDC 15 — supersede des preuves', ({ sql, make }) => {
  it('ancienne extraction remplacée (trace conservée, sans suppression) ; relance sans effet', async () => {
    const { runCdc15Backfill } = await import('@/services/migration/cdc15');
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    const ins = async (key: string, v: string, at: string, trace: string) => (await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint,
                                  evidence_excerpt, extracted_at, operation_trace_id)
      VALUES (${compte.id}, ${bien.id}, ${key}, ${v}::jsonb, 'document', ${f.id}, 'certain', ${`fp-${key}-${at}-${bien.id}`}, 'x', ${at}::timestamptz, ${trace}::uuid)
      RETURNING id`)[0].id;
    const ancienne = await ins('mileage', '40000', '2024-01-01', '00000000-0000-4000-8000-000000000001');
    const recente = await ins('mileage', '45000', '2025-01-01', '00000000-0000-4000-8000-000000000002');
    const seule = await ins('vin', '"VF1"', '2024-01-01', '00000000-0000-4000-8000-000000000001');
    const etat = async (id: number) => (await sql`SELECT lifecycle_status, superseded_by_evidence_id, value_json FROM field_evidence WHERE id = ${id}`)[0];
    const run = (apply: boolean) => runCdc15Backfill({ sql, steps: ['MIG-04'], accountId: compte.id, apply });

    const dry = await run(false);
    expect(dry.results[0].counts.APPLIED).toBe(1);
    expect((await etat(ancienne)).lifecycle_status ?? 'ACTIVE').toBe('ACTIVE');

    await run(true);
    expect(await etat(ancienne)).toMatchObject({ lifecycle_status: 'SUPERSEDED', superseded_by_evidence_id: recente, value_json: 40000 });
    expect((await etat(recente)).lifecycle_status ?? 'ACTIVE').toBe('ACTIVE');
    expect((await etat(seule)).lifecycle_status ?? 'ACTIVE').toBe('ACTIVE');

    expect((await run(true)).results[0].counts.APPLIED).toBe(0);
  });
});
