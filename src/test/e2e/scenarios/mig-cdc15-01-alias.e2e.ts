/**
 * MIG-01 (CDC 15 §14 point 1) sur base réelle, jeu de données ancien format
 * (lot 10) : alias dans `keyCharacteristics`, faits et preuves sans clé
 * canonique. Simulation (rien d'écrit hors rapport), application, relance
 * sans effet ; conflit → rapport + carte MIG-REVIEW idempotente, tranchée
 * par l'utilisateur.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

scenario('MIG-01', 'Rattrapage CDC 15 — canonicalisation des alias', ({ sql, make }) => {
  it('dry-run, --apply, relance sans effet ; conflit en carte, tranché par l’utilisateur', async () => {
    const { runCdc15Backfill } = await import('@/services/migration/cdc15');
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio', keyCharacteristics: {
      purchasePriceCents: 1250000, purchasePriceCents_origin: 'auto', kilometrage: 45000,
    } });
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo', keyCharacteristics: { mileage: 45000, kilometrage: 46000 } });
    const f = await make.assetFile(compte, { assetId: clio.id });
    const orphelin = await make.assetFile(compte, { assetId: null });
    const [ext] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars) VALUES (${compte.id}, ${f.id}, '', 0) RETURNING id`;
    const [ext2] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars) VALUES (${compte.id}, ${orphelin.id}, '', 0) RETURNING id`;
    const [fait] = await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_number, confidence, excerpt)
      VALUES (${compte.id}, ${f.id}, ${ext.id}, 'kilometrage', 45000, 'certain', '45 000 km') RETURNING id::int AS id`;
    const [marque] = await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_text, confidence, excerpt)
      VALUES (${compte.id}, ${orphelin.id}, ${ext2.id}, 'marque', 'Renault', 'certain', 'Renault') RETURNING id::int AS id`;
    // Deux alias d'une même extraction, valeurs différentes : conflit (après résolution des alias), carte.
    const f2 = await make.assetFile(compte, { assetId: clio.id });
    const [ext3] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars) VALUES (${compte.id}, ${f2.id}, '', 0) RETURNING id`;
    const conflits = await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_number, confidence, excerpt)
      VALUES (${compte.id}, ${f2.id}, ${ext3.id}, 'compteur', 52000, 'certain', '52 000'),
             (${compte.id}, ${f2.id}, ${ext3.id}, 'odometer', 53000, 'certain', '53 000') RETURNING id::int AS id`;
    const [preuve] = await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt)
      VALUES (${compte.id}, ${clio.id}, 'kilometrage', '45000', 'document', ${f.id}, 'certain', ${`fp-mig01-${clio.id}`}, '45 000 km') RETURNING id`;
    const kc = async (id: number) => JSON.parse((await sql<{ k: string }[]>`SELECT key_characteristics AS k FROM assets WHERE id = ${id}`)[0].k);
    const cartes = async () => sql<{ id: number; target_id: number; relation_key: string; resolved_at: Date | null; resolution_reason: string | null; public_id: string }[]>`
      SELECT id, target_id, relation_key, resolved_at, resolution_reason, public_id FROM to_process_actions
       WHERE account_id = ${compte.id} AND rule_code = 'MIG-REVIEW' AND target_id = ${polo.id} ORDER BY id`;
    const run = (apply: boolean) => runCdc15Backfill({ sql, steps: ['MIG-01'], accountId: compte.id, apply });

    // 1. Simulation : rapport, aucune donnée ni carte.
    const avant = await kc(clio.id);
    const dry = await run(false);
    expect(await kc(clio.id)).toEqual(avant);
    expect((await sql`SELECT canonical_key FROM document_facts WHERE id = ${fait.id}`)[0].canonical_key).toBeNull();
    expect(await cartes()).toHaveLength(0);
    const rapport = await sql<{ decision: string; reason: string; run_mode: string }[]>`
      SELECT decision, reason, run_mode FROM cdc15_migration_report WHERE run_id = ${dry.runId}`;
    expect(rapport.every((r) => r.run_mode === 'dry_run')).toBe(true);
    expect(rapport.map((r) => r.reason)).toEqual(expect.arrayContaining(['ALIAS_CANONICALIZED', 'ALIAS_CONFLICT', 'FACT_ALIAS_CANONICALIZED', 'ALIAS_FAMILY_UNKNOWN', 'EVIDENCE_ALIAS_CANONICALIZED']));

    // 2. Application.
    const app = await run(true);
    expect(app.results[0].counts.APPLIED).toBeGreaterThanOrEqual(4);
    expect(await kc(clio.id)).toMatchObject({ acquisitionPrice: 12500, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION', purchasePriceCents: 1250000, mileage: 45000, kilometrage: 45000 });
    expect((await sql`SELECT canonical_key, raw_key, raw_value FROM document_facts WHERE id = ${fait.id}`)[0])
      .toMatchObject({ canonical_key: 'mileage', raw_key: 'kilometrage', raw_value: '45000' });
    expect((await sql`SELECT canonical_key FROM document_facts WHERE id = ${marque.id}`)[0].canonical_key).toBeNull();
    // Alias en conflit : aucune canonicalisation, une carte sur la Clio (valeur en place + valeurs du document).
    expect((await sql`SELECT count(*)::int AS n FROM document_facts WHERE id IN (${conflits[0].id}, ${conflits[1].id}) AND canonical_key IS NOT NULL`)[0].n).toBe(0);
    const carteClio = await sql`SELECT relation_key, proposals_json FROM to_process_actions WHERE account_id = ${compte.id} AND target_id = ${clio.id} AND rule_code = 'MIG-REVIEW'`;
    expect(carteClio).toHaveLength(1);
    expect(carteClio[0].relation_key).toBe('mig:MIG-01:mileage');
    expect((carteClio[0].proposals_json as Array<{ value: number }>).map((p) => p.value).sort()).toEqual([45000, 52000, 53000]);
    expect((await sql`SELECT canonical_key, field_key FROM field_evidence WHERE id = ${preuve.id}`)[0]).toMatchObject({ canonical_key: 'mileage', field_key: 'kilometrage' });
    expect(await kc(polo.id)).toEqual({ mileage: 45000, kilometrage: 46000 }); // rien tranché
    const [carte] = await cartes();
    expect(carte).toMatchObject({ relation_key: 'mig:MIG-01:mileage', resolved_at: null });

    // 3. Relance : sans effet, aucune carte de plus.
    const again = await run(true);
    expect(again.results[0].counts.APPLIED).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'MIG-REVIEW'`)[0].n).toBe(2);
    expect(await cartes()).toHaveLength(1);

    // 4. L'utilisateur tranche : valeur écrite (USER), alias alignés ; la relance ne rouvre rien.
    const { resolveArbitration, undoArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(compte.id, carte.public_id, 46000, { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    expect(await kc(polo.id)).toMatchObject({ mileage: 46000, mileage__origin: 'USER', kilometrage: 46000 });

    // 5. Annulation (contrôle optimiste) : valeur d'avant rétablie, même carte rouverte.
    expect(await undoArbitration(compte.id, carte.public_id, null)).toMatchObject({ ok: true });
    expect((await kc(polo.id)).mileage).toBe(45000);
    expect((await cartes())[0]).toMatchObject({ id: carte.id, resolved_at: null });

    // 6. Valeur modifiée depuis l'ouverture de la carte : périmée, rien d'écrit.
    const k = await kc(polo.id);
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ ...k, mileage: 47000 })} WHERE id = ${polo.id}`;
    expect(await resolveArbitration(compte.id, carte.public_id, 46000, { userId: compte.ownerUserId })).toMatchObject({ ok: false, error: 'STALE' });
    expect((await kc(polo.id)).mileage).toBe(47000);
    expect((await cartes())[0]).toMatchObject({ resolution_reason: 'OBSOLETE' });

    // 7. Carte fermée par la saisie de la valeur (clé canonique OU alias : même mécanisme que la fiche).
    await run(true);
    const ouverte = (await cartes()).find((c) => !c.resolved_at)!;
    expect(ouverte.relation_key).toBe('mig:MIG-01:mileage');
    const { resolveActionsForData } = await import('@/services/to-process/to-process-action.service');
    expect(await resolveActionsForData(compte.id, 'ASSET', polo.id, 'kilometrage', 'USER_COMPLETED')).toBe(1);
    expect((await cartes()).filter((c) => !c.resolved_at)).toHaveLength(0);
  });
});
