/**
 * Rattrapages CDC 15 sur une base PEUPLÉE (jeu ancien format, lot 10) :
 * `--step all` en simulation puis en application PAR LE SCRIPT RÉEL
 * (`scripts/cdc15-backfill.ts`, processus séparé sur la base E2E), puis
 * RESTAURATION COMPLÈTE (`--restore`) : fiches, colonnes, faits et preuves
 * reviennent EXACTEMENT à leur état d'avant. Verrou global, exécution
 * orpheline signalée.
 */
import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
import { scenario } from '../scenario';

const script = (args: string[]) => execFileSync('npx', ['tsx', 'scripts/cdc15-backfill.ts', ...args], {
  cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', timeout: 120_000,
});

scenario('MIG-ALL', 'Rattrapages CDC 15 — base peuplée, script réel, restauration complète', ({ sql, make }) => {
  it('--step all : simulation = application, relance sans effet, --restore remet tout', async () => {
    const compte = await make.account();
    // Véhicule : alias, ancien drapeau d'origine, colonnes divergentes, montant ×100 prouvé.
    await make.asset(compte, { category: 'VEHICULE', name: 'Clio', registrationNumber: 'ZZ-999-ZZ', purchaseDate: '2019-01-01',
      keyCharacteristics: { kilometrage: 45000, kilometrage_origin: 'manual', registrationNumber: 'AB-123-CD', registrationNumber__origin: 'USER',
        purchasePriceCents: 1250000, purchasePriceCents__origin: 'RECONCILIATION', make: 'Renault' } });
    // Objet : montant lu ×100 (preuve exacte, provenance établie), adresse hors sujet.
    const canape = await make.asset(compte, { category: 'OBJET', name: 'Canapé', keyCharacteristics: { acquisitionPrice: 1250000, acquisitionPrice__origin: 'RECONCILIATION' } });
    // Immobilier : ville / code postal (masqués au rapport), fiche vide, colonnes seules.
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { ville: 'Lyon' } });
    await sql`UPDATE assets SET address = '12 rue des Lilas', postal_code = '69001' WHERE id = ${maison.id}`;
    const f = await make.assetFile(compte, { assetId: canape.id });
    const [ext] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars) VALUES (${compte.id}, ${f.id}, '', 0) RETURNING id`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_text, confidence, excerpt)
              VALUES (${compte.id}, ${f.id}, ${ext.id}, 'prixAchat', '12500', 'certain', '12 500 €')`;
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt,
                                  prompt_version, extracted_at, operation_trace_id)
      VALUES (${compte.id}, ${canape.id}, 'acquisitionPrice', '12500', 'document', ${f.id}, 'certain', ${`fp-all-${canape.id}`}, '12 500 €',
              'extract_source_v4', '2025-01-01', '00000000-0000-4000-8000-0000000000a1') RETURNING id`;
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt,
                                          prompt_version, extracted_at, operation_trace_id)
              VALUES (${compte.id}, ${canape.id}, 'acquisitionPrice', '12000', 'document', ${f.id}, 'certain', ${`fp-all-old-${canape.id}`}, '12 000 €',
                      'extract_source_v3', '2024-01-01', '00000000-0000-4000-8000-0000000000a0')`;
    await sql`INSERT INTO ai_field_updates (account_id, asset_id, asset_file_id, field_key, old_value, new_value, evidence_id)
              VALUES (${compte.id}, ${canape.id}, ${f.id}, 'acquisitionPrice', NULL, '1250000', ${p.id})`;

    const etat = async () => ({
      // Fiche comparée par CONTENU (l'ordre des clés JSON n'a pas de sens).
      assets: (await sql`SELECT id, key_characteristics, registration_number, purchase_date::text, purchase_price_cents, mileage_or_hours, address, city, postal_code
                          FROM assets WHERE account_id = ${compte.id} ORDER BY id`)
        .map((a) => ({ ...a, id: Number(a.id), key_characteristics: JSON.parse(String(a.key_characteristics ?? '{}')) as Record<string, unknown> })),
      faits: await sql`SELECT id, canonical_key, raw_key, raw_value FROM document_facts WHERE account_id = ${compte.id} ORDER BY id`,
      preuves: await sql`SELECT id, canonical_key, raw_value, lifecycle_status, superseded_at, superseded_by_evidence_id FROM field_evidence WHERE account_id = ${compte.id} ORDER BY id`,
    });
    const initial = await etat();
    const runIdDe = (out: string) => /exécution ([0-9a-f-]{36})/.exec(out)![1];
    const compte_ = (runId: string) => sql<{ step: string; decision: string; n: number }[]>`
      SELECT step, decision, count(*)::int AS n FROM cdc15_migration_report WHERE run_id = ${runId} GROUP BY 1, 2 ORDER BY 1, 2`;

    // 1. Simulation (script réel) : rien d'écrit hors rapport.
    const dryOut = script(['--step', 'all', '--account', String(compte.id), '--batch', '2']);
    const dry = runIdDe(dryOut);
    expect(await etat()).toEqual(initial);
    expect((await sql`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id}`)[0].n).toBe(0);

    // 2. Application (script réel) : même rapport que la simulation (MIG-01 et MIG-03 simulés en mémoire).
    const app = runIdDe(script(['--step', 'all', '--account', String(compte.id), '--apply', '--batch', '2']));
    // (MIG-07 excepté : la correction de MIG-02 n'est pas simulée pour lui — avertissement du résumé.)
    const sansMig07 = async (id: string) => (await compte_(id)).filter((r) => r.step !== 'MIG-07');
    expect(await sansMig07(app)).toEqual(await sansMig07(dry));
    expect(dryOut).toMatch(/Simulation : les corrections de MIG-02/);
    const apres = await etat();
    expect(apres).not.toEqual(initial);
    const kcCanape = apres.assets.find((a) => a.id === canape.id)!.key_characteristics as Record<string, unknown>;
    expect(kcCanape.acquisitionPrice).toBe(12500);
    expect(apres.preuves.find((x) => x.id !== p.id)!.lifecycle_status).toBe('SUPERSEDED');
    // Rapport : ville et code postal masqués.
    const rapport = JSON.stringify(await sql`SELECT before_value, after_value FROM cdc15_migration_report WHERE run_id = ${app}`);
    expect(rapport).not.toMatch(/Lyon|69001|Lilas/);
    // Consultation du rapport par le script.
    expect(script(['--report', app])).toContain('APPLIQUÉE');

    // 3. Relance : sans effet.
    const encore = runIdDe(script(['--step', 'all', '--account', String(compte.id), '--apply']));
    expect((await compte_(encore)).filter((r) => r.decision === 'APPLIED')).toEqual([]);
    expect(await etat()).toEqual(apres);

    // 4. Restauration complète (script réel) : état initial EXACT.
    expect(script(['--restore', app])).toMatch(/0 modifiée\(s\) depuis/);
    expect(await etat()).toEqual(initial);
    expect(script(['--restore', app])).toMatch(/0 valeur\(s\) restaurée\(s\)/);
  });

  it('verrou global : deux --apply simultanés refusés ; exécution RUNNING orpheline signalée', async () => {
    const { runCdc15Backfill, acquireBackfillLock, ConcurrentRunError } = await import('@/services/migration/cdc15');
    const compte = await make.account();
    const verrou = await acquireBackfillLock(sql);
    try {
      await expect(runCdc15Backfill({ sql, steps: ['MIG-01'], accountId: compte.id, apply: true })).rejects.toBeInstanceOf(ConcurrentRunError);
      // La simulation n'est pas bloquée.
      expect((await runCdc15Backfill({ sql, steps: ['MIG-01'], accountId: compte.id })).mode).toBe('dry_run');
    } finally {
      await verrou.liberer();
    }
    const orphelin = '00000000-0000-4000-8000-00000000beef';
    await sql`INSERT INTO cdc15_migration_runs (run_id, run_mode, steps, account_id, status) VALUES (${orphelin}, 'apply', '{MIG-01}', ${compte.id}, 'RUNNING')
              ON CONFLICT (run_id) DO UPDATE SET status = 'RUNNING'`;
    const r = await runCdc15Backfill({ sql, steps: ['MIG-01'], accountId: compte.id, apply: true });
    expect(r.warnings.join(' ')).toContain(orphelin);
    const repris = await runCdc15Backfill({ sql, steps: ['MIG-01'], resumeRunId: orphelin });
    expect(repris.warnings.join(' ')).toMatch(/interrompue sans fin propre/);
    expect((await sql`SELECT status FROM cdc15_migration_runs WHERE run_id = ${orphelin}`)[0].status).toBe('DONE');
  });
});
