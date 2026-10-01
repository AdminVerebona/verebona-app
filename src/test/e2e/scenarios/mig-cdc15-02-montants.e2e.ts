/**
 * MIG-02 (CDC 15 §14 point 2, D-16) sur base réelle : montants ×100 d'un
 * jeu ancien format (prompt extract_source_v4). Correction seulement sur
 * preuve exacte (même bien, même champ, origine automatique, aucune écriture
 * humaine depuis) ; montant documentaire seul → AMBIGUOUS + carte ; valeur
 * humaine → SKIPPED_USER. Simulation, application, relance sans effet.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

scenario('MIG-02', 'Rattrapage CDC 15 — montants ×100', ({ sql, make }) => {
  it('dry-run, --apply (writeCanonicalAssetField), relance sans effet', async () => {
    const { runCdc15Backfill } = await import('@/services/migration/cdc15');
    const compte = await make.account();
    const prouve = await make.asset(compte, { category: 'OBJET', name: 'Canapé', purchasePriceCents: 125_000_000,
      keyCharacteristics: { acquisitionPrice: 1250000, acquisitionPrice__origin: 'RECONCILIATION' } });
    const doc = await make.asset(compte, { category: 'OBJET', name: 'Lampe', keyCharacteristics: { acquisitionPrice: 89900, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION' } });
    const humain = await make.asset(compte, { category: 'OBJET', name: 'Table', keyCharacteristics: { acquisitionPrice: 500000, acquisitionPrice__origin: 'USER' } });
    const presume = await make.asset(compte, { category: 'OBJET', name: 'Chaise', keyCharacteristics: { acquisitionPrice: 700000 } });
    const importe = await make.asset(compte, { category: 'OBJET', name: 'Buffet', keyCharacteristics: { acquisitionPrice: 150000, acquisitionPrice__origin: 'IMPORT' } });
    const f = await make.assetFile(compte, { assetId: prouve.id });
    const facture = await make.assetFile(compte, { assetId: doc.id });
    await sql`UPDATE asset_files SET amount_cents = 89900 WHERE id = ${facture.id}`;
    const preuve = async (assetId: number, v: string, fp: string) => (await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, canonical_key, value_json, source_type, source_id, confidence, fingerprint,
                                  evidence_excerpt, prompt_version)
      VALUES (${compte.id}, ${assetId}, 'acquisitionPrice', 'acquisitionPrice', ${v}::jsonb, 'document', ${f.id}, 'certain', ${fp}, 'Total 12 500,00 €', 'extract_source_v4')
      RETURNING id`)[0].id;
    const pA = await preuve(prouve.id, '12500', `fp-mig02-a-${prouve.id}`);
    await preuve(humain.id, '5000', `fp-mig02-h-${humain.id}`);
    await preuve(presume.id, '7000', `fp-mig02-p-${presume.id}`);
    const pI = await preuve(importe.id, '1500', `fp-mig02-i-${importe.id}`);
    // Provenance établie pour le Canapé : la dernière écriture du champ vient de cette preuve (evidence_id).
    await sql`INSERT INTO ai_field_updates (account_id, asset_id, asset_file_id, field_key, old_value, new_value, evidence_id)
              VALUES (${compte.id}, ${prouve.id}, ${f.id}, 'acquisitionPrice', NULL, '1250000', ${pA})`;
    // Buffet : même provenance, mais origine IMPORT — jamais corrigé automatiquement (relecteur).
    await sql`INSERT INTO ai_field_updates (account_id, asset_id, asset_file_id, field_key, old_value, new_value, evidence_id)
              VALUES (${compte.id}, ${importe.id}, ${f.id}, 'acquisitionPrice', NULL, '150000', ${pI})`;
    const lire = async (id: number) => (await sql<{ k: string; c: number | null }[]>`
      SELECT key_characteristics AS k, purchase_price_cents::int AS c FROM assets WHERE id = ${id}`)[0];
    const run = (apply: boolean) => runCdc15Backfill({ sql, steps: ['MIG-02'], accountId: compte.id, apply });

    const dry = await run(false);
    expect(dry.results[0].counts).toMatchObject({ APPLIED: 1, AMBIGUOUS: 3, SKIPPED_USER: 1 });
    expect(JSON.parse((await lire(prouve.id)).k).acquisitionPrice).toBe(1250000);
    expect((await sql`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id}`)[0].n).toBe(0);

    const app = await run(true);
    expect(app.results[0].counts).toMatchObject({ APPLIED: 1, AMBIGUOUS: 3, SKIPPED_USER: 1 });
    const a = await lire(prouve.id);
    expect(JSON.parse(a.k)).toMatchObject({ acquisitionPrice: 12500, acquisitionPrice__origin: 'RECONCILIATION' });
    expect(a.c).toBe(1_250_000); // colonne miroir recopiée par la primitive
    const [journal] = await sql`SELECT origin, source_type, source_id, old_value, new_value FROM canonical_field_writes
      WHERE asset_id = ${prouve.id} AND canonical_key = 'acquisitionPrice' ORDER BY id DESC LIMIT 1`;
    expect(journal).toMatchObject({ origin: 'RECONCILIATION', source_type: 'migration', source_id: 'MIG-02', old_value: 1250000, new_value: 12500 });
    expect(JSON.parse((await lire(doc.id)).k).acquisitionPrice).toBe(89900);
    expect(JSON.parse((await lire(humain.id)).k).acquisitionPrice).toBe(500000);
    expect(JSON.parse((await lire(importe.id)).k).acquisitionPrice).toBe(150000);
    const cartes = await sql<{ target_id: number; relation_key: string; proposals_json: Array<{ value: number }> }[]>`
      SELECT target_id, relation_key, proposals_json FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'MIG-REVIEW' ORDER BY target_id`;
    expect(cartes.map((c) => c.target_id).sort((x, y) => x - y)).toEqual([doc.id, presume.id, importe.id].sort((x, y) => x - y));
    const carteDoc = cartes.find((c) => c.target_id === doc.id)!;
    expect(carteDoc.relation_key).toBe('mig:MIG-02:acquisitionPrice');
    expect(carteDoc.proposals_json.map((p) => p.value).sort((x, y) => x - y)).toEqual([899, 89900]);
    const motifs = await sql<{ asset_id: number; reason: string }[]>`SELECT asset_id, reason FROM cdc15_migration_report WHERE run_id = ${app.runId} AND decision = 'AMBIGUOUS'`;
    expect(Object.fromEntries(motifs.map((m) => [m.asset_id, m.reason]))).toEqual({
      [doc.id]: 'DOCUMENT_AMOUNT_X100_NOT_FIELD_ATTRIBUTABLE', [presume.id]: 'HUMAN_ORIGIN_PRESUMED', [importe.id]: 'AUTOMATIC_ORIGIN_NOT_DOCUMENTARY',
    });
    const rapport = await sql`SELECT before_value, after_value, reason FROM cdc15_migration_report WHERE run_id = ${app.runId} AND decision = 'APPLIED'`;
    expect(rapport[0]).toMatchObject({ before_value: 1250000, after_value: 12500, reason: 'EXACT_EVIDENCE_X100' });

    const again = await run(true);
    expect(again.results[0].counts.APPLIED).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'MIG-REVIEW'`)[0].n).toBe(3);

    // MIG-02 et MIG-07 sur le MÊME champ : deux cartes distinctes, stables à la relance (relecture lot 17).
    await sql`UPDATE assets SET purchase_price_cents = 50000 WHERE id = ${doc.id}`;
    const deux = () => runCdc15Backfill({ sql, steps: ['MIG-02', 'MIG-07'], accountId: compte.id, apply: true });
    await deux();
    const lire2 = async () => sql<{ relation_key: string; proposals_json: Array<{ value: number }>; resolved_at: Date | null }[]>`
      SELECT relation_key, proposals_json, resolved_at FROM to_process_actions WHERE target_id = ${doc.id} AND rule_code = 'MIG-REVIEW' ORDER BY relation_key`;
    const c1 = await lire2();
    expect(c1.map((c) => c.relation_key)).toEqual(['mig:MIG-02:acquisitionPrice', 'mig:MIG-07:acquisitionPrice']);
    expect(c1[0].proposals_json.map((p) => p.value).sort((x, y) => x - y)).toEqual([899, 89900]);
    expect(c1[1].proposals_json.map((p) => p.value).sort((x, y) => x - y)).toEqual([500, 89900]);
    await deux();
    expect(await lire2()).toEqual(c1);
  });
});
