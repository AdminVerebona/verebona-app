/**
 * Lot 40 (volet B, décision PO) — un bien qui change de compte (Duo) emporte
 * ses données : documents rattachés à lui seul et tout ce qui en dérive,
 * agenda, « À traiter », preuves, fournisseurs ; un document multi-biens
 * reste dans l'ancien compte (lien retiré). Rattrapage automatique des
 * déplacements passés (tâche planifiée, BO simulation). Tests DUO-xx.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';
import type { Factories } from '../factories';

type Sql = Parameters<Parameters<typeof scenario>[2]>[0]['sql'];

async function monde(sql: Sql, make: Factories) {
  const titulaire = await make.user();
  const membre = await make.user();
  const duoCompte = await make.account({ owner: titulaire, plan: 'premium_duo' });
  const cible = await make.account({ owner: membre });
  const [duo] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id) VALUES (${titulaire.id}) RETURNING id`;
  const voiture = await make.asset(duoCompte, { category: 'VEHICULE', name: 'Voiture' });
  const maison = await make.asset(duoCompte, { category: 'IMMOBILIER', name: 'Maison' });
  const [equip] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${voiture.id}, 'Autoradio') RETURNING id`;
  // Documents : F1 (bien seul), F2 (équipement du bien), F3 (bien + maison : reste),
  // F4 (lien N-N seul vers le bien), F5 (maison + proposition vers le bien : reste),
  // F6 (source secondaire regroupée dans F1).
  const f1 = await make.assetFile(duoCompte, { assetId: voiture.id });
  const f2 = await make.assetFile(duoCompte, { assetId: null });
  await sql`UPDATE asset_files SET equipment_id = ${equip.id} WHERE id = ${f2.id}`;
  const f3 = await make.assetFile(duoCompte, { assetId: voiture.id });
  await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${duoCompte.id}, ${f3.id}, ${maison.id}, 'SECONDARY', 'USER', 'ACTIVE')`;
  const f4 = await make.assetFile(duoCompte, { assetId: null });
  await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${duoCompte.id}, ${f4.id}, ${voiture.id}, 'PRIMARY', 'USER', 'ACTIVE')`;
  const f5 = await make.assetFile(duoCompte, { assetId: maison.id });
  await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${duoCompte.id}, ${f5.id}, ${voiture.id}, 'SECONDARY', 'AI', 'PROPOSED')`;
  const f6 = await make.assetFile(duoCompte, { assetId: voiture.id });
  await sql`UPDATE asset_files SET grouped_into_file_id = ${f1.id}, deleted_at = now() WHERE id = ${f6.id}`;
  // Dérivés de F1 : extraction, fait, miniature, candidat Opération.
  const [ext] = await sql<{ id: number }[]>`
    INSERT INTO document_extractions (account_id, file_id, title) VALUES (${duoCompte.id}, ${f1.id}, 'Facture') RETURNING id`;
  await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, confidence, excerpt) VALUES (${duoCompte.id}, ${f1.id}, ${ext.id}, 'mileage', 'certain', '78 000 km')`;
  await sql`INSERT INTO asset_file_thumbnails (file_id, account_id, source_key, s3_key, status) VALUES (${f1.id}, ${duoCompte.id}, 'k', ${`derivatives/thumbnails/a_${duoCompte.id}/f_${f1.id}/list-x.webp`}, 'READY')`;
  await sql`INSERT INTO document_operation_candidates (account_id, file_id, extraction_id, candidate_key, established, confidence, summary)
            VALUES (${duoCompte.id}, ${f1.id}, ${ext.id}, 'op1', true, 'certain', 'Réparation')`;
  // Preuves sur le bien : depuis F1 (suit) et F3 (document resté : retirée).
  for (const [src, fp] of [[f1.id, 'a'], [f3.id, 'b']] as const) {
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, evidence_excerpt, confidence, fingerprint, lifecycle_status, evidence_origin)
              VALUES (${duoCompte.id}, ${voiture.id}, 'mileage', '78000', 'document', ${src}, '78 000 km', 'certain', ${`l40-${fp}-${voiture.id}`}, 'ACTIVE', 'TEXT_EXTRACTION')`;
  }
  // Agenda : G1 (bien seul), G2 (bien + maison), G3 (maison, lien vers F1).
  const g1 = await make.agendaItem(duoCompte, { assetIds: [voiture.id] });
  const g2 = await make.agendaItem(duoCompte, { assetIds: [voiture.id, maison.id] });
  const g3 = await make.agendaItem(duoCompte, { assetIds: [maison.id] });
  await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${g3.id}, ${f1.id})`;
  // « À traiter » : sur le bien et sur F1.
  for (const [type, id, key] of [['ASSET', voiture.id, 'mileage'], ['DOCUMENT', f1.id, 'documentDate']] as const) {
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
              VALUES (${duoCompte.id}, ${type}, ${id}, ${key}, 'COMPLETE', 'R', 'Q ?')`;
  }
  // Fournisseur du bien et de F1 (IBAN jamais recopié).
  const [fourn] = await sql<{ id: number }[]>`
    INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, siret, iban)
    VALUES (${duoCompte.id}, ${titulaire.id}, 'Garage Exemple', 'garage exemple', '12345678900011', 'FR7612345') RETURNING id`;
  await sql`INSERT INTO asset_suppliers (asset_id, supplier_id) VALUES (${voiture.id}, ${fourn.id})`;
  await sql`INSERT INTO document_suppliers (document_id, supplier_id, role) VALUES (${f1.id}, ${fourn.id}, 'ISSUER')`;
  // Données du bien : pièce historique, événement, transmission en attente.
  await sql`INSERT INTO rooms (asset_id, account_id, name, room_type) VALUES (${voiture.id}, ${duoCompte.id}, 'Coffre', 'other')`;
  await sql`INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement) VALUES (${duoCompte.id}, ${titulaire.id}, ${voiture.id}, 'ENTRETIEN', 'Vidange', now())`;
  await sql`INSERT INTO asset_transmissions (asset_id, account_id, initiator_user_id, recipient_email, token, status)
            VALUES (${voiture.id}, ${duoCompte.id}, ${titulaire.id}, 'x@test.invalid', ${`tok-${voiture.id}`}, 'pending')`;
  return { titulaire, membre, duoCompte, cible, duo, voiture, maison, equip, f1, f2, f3, f4, f5, f6, g1, g2, g3, fourn };
}

scenario('L40-DUO', 'Duo : les données suivent le bien qui change de compte', ({ sql, make }) => {
  const compteDe = async (table: string, id: number) =>
    (await sql.unsafe<{ a: number }[]>(`SELECT account_id AS a FROM ${table} WHERE id = $1`, [id]))[0]?.a;

  it('DUO-01 — déplacement accepté : documents du bien seul (et dérivés) suivent, multi-biens restent sans lien, agenda, « À traiter », preuves, fournisseur, pièce, événement, transmission', async () => {
    const w = await monde(sql, make);
    const [req] = await sql<{ id: number }[]>`
      INSERT INTO asset_move_requests (asset_id, duo_id, target_account_id, initiator_user_id, validator_user_id, asset_label_snapshot, target_user_snapshot, initiator_user_snapshot)
      VALUES (${w.voiture.id}, ${w.duo.id}, ${w.cible.id}, ${w.membre.id}, ${w.titulaire.id}, 'Voiture', 'Membre', 'Membre') RETURNING id`;
    const { DuoService } = await import('@/services/duo.service');
    await DuoService.respondToMoveRequest({ requestId: req.id, action: 'ACCEPT', resolvedByUserId: w.titulaire.id, resolvedByType: 'USER' });

    expect(await compteDe('assets', w.voiture.id)).toBe(w.cible.id);
    // Documents rattachés au seul bien (+ source secondaire) : nouveau compte.
    for (const f of [w.f1, w.f2, w.f4, w.f6]) expect({ f: f.id, a: await compteDe('asset_files', f.id) }).toEqual({ f: f.id, a: w.cible.id });
    // Multi-biens / simple proposition : restent, sans lien vers le bien.
    for (const f of [w.f3, w.f5]) expect({ f: f.id, a: await compteDe('asset_files', f.id) }).toEqual({ f: f.id, a: w.duoCompte.id });
    const [f3] = await sql<{ asset_id: number | null }[]>`SELECT asset_id FROM asset_files WHERE id = ${w.f3.id}`;
    expect(f3.asset_id).toBe(w.maison.id);
    const versBien = await sql`SELECT id FROM document_asset_links WHERE file_id IN (${w.f3.id}, ${w.f5.id}) AND asset_id = ${w.voiture.id} AND status IN ('ACTIVE', 'PROPOSED')`;
    expect(versBien).toHaveLength(0);
    // Liens et dérivés du document qui part : même compte que lui.
    for (const t of ['document_asset_links', 'document_extractions', 'document_facts', 'asset_file_thumbnails', 'document_operation_candidates']) {
      const r = await sql.unsafe<{ a: number }[]>(`SELECT DISTINCT account_id AS a FROM ${t} WHERE file_id = $1`, [w.f1.id]);
      expect({ t, comptes: r.map((x) => x.a) }).toEqual({ t, comptes: [w.cible.id] });
    }
    // Accès au fichier : refusé à l'ancien compte, accordé au nouveau.
    const { decideFileAccess } = await import('@/services/documents/file-access');
    const row = { id: w.f1.id, accountId: w.cible.id, s3Bucket: null, s3Key: 'k', mimeType: null, size: null, originalFilename: null, isWebLink: false, uploadStatus: null };
    expect(decideFileAccess(row, w.cible.id)).toEqual({ ok: true });
    expect(decideFileAccess(row, w.duoCompte.id)).toMatchObject({ ok: false, status: 404 });
    // Preuves : suivent le bien ; celle du document resté est retirée.
    const preuves = await sql<{ source_id: number; account_id: number; lifecycle_status: string }[]>`
      SELECT source_id, account_id, lifecycle_status FROM field_evidence WHERE asset_id = ${w.voiture.id} ORDER BY source_id`;
    expect(preuves).toEqual([
      { source_id: w.f1.id, account_id: w.cible.id, lifecycle_status: 'ACTIVE' },
      { source_id: w.f3.id, account_id: w.cible.id, lifecycle_status: 'WITHDRAWN' },
    ]);
    // Agenda : G1 suit ; G2 reste sans le bien ; G3 perd son lien vers F1 (inter-comptes).
    expect(await compteDe('agenda_items', w.g1.id)).toBe(w.cible.id);
    expect(await compteDe('agenda_items', w.g2.id)).toBe(w.duoCompte.id);
    expect((await sql<{ asset_id: number }[]>`SELECT asset_id FROM agenda_asset_links WHERE agenda_item_id = ${w.g2.id}`).map((r) => r.asset_id)).toEqual([w.maison.id]);
    expect(await sql`SELECT id FROM agenda_file_links WHERE agenda_item_id = ${w.g3.id}`).toHaveLength(0);
    // « À traiter » du bien et du document : nouveau compte.
    const actions = await sql<{ a: number }[]>`SELECT DISTINCT account_id AS a FROM to_process_actions WHERE (target_type = 'ASSET' AND target_id = ${w.voiture.id}) OR (target_type = 'DOCUMENT' AND target_id = ${w.f1.id})`;
    expect(actions.map((r) => r.a)).toEqual([w.cible.id]);
    // Fournisseur : copié dans le nouveau compte, sans IBAN ; l'original reste.
    const liens = await sql<{ account_id: number; iban: string | null; name: string }[]>`
      SELECT s.account_id, s.iban, s.name FROM asset_suppliers x JOIN suppliers s ON s.id = x.supplier_id WHERE x.asset_id = ${w.voiture.id}`;
    expect(liens).toEqual([{ account_id: w.cible.id, iban: null, name: 'Garage Exemple' }]);
    const [doc] = await sql<{ account_id: number }[]>`SELECT s.account_id FROM document_suppliers x JOIN suppliers s ON s.id = x.supplier_id WHERE x.document_id = ${w.f1.id}`;
    expect(doc.account_id).toBe(w.cible.id);
    expect(await compteDe('suppliers', w.fourn.id)).toBe(w.duoCompte.id);
    // Pièce, événement, transmission (en attente → annulée).
    expect((await sql<{ a: number }[]>`SELECT account_id AS a FROM rooms WHERE asset_id = ${w.voiture.id}`).map((r) => r.a)).toEqual([w.cible.id]);
    expect((await sql<{ a: number }[]>`SELECT account_id AS a FROM events WHERE asset_id = ${w.voiture.id}`).map((r) => r.a)).toEqual([w.cible.id]);
    expect(await sql`SELECT status, account_id FROM asset_transmissions WHERE asset_id = ${w.voiture.id}`).toEqual([{ status: 'cancelled', account_id: w.cible.id }]);
    // Quota de stockage (calculé à la lecture) : documents comptés dans le nouveau compte.
    const nb = async (a: number) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${a}`)[0].n;
    expect(await nb(w.cible.id)).toBe(4);
    expect(await nb(w.duoCompte.id)).toBe(2);
    // Plus aucune incohérence détectée.
    const { findMisplacedAssetData } = await import('@/services/assets/asset-account-backfill');
    expect((await findMisplacedAssetData(500)).filter((c) => c.assetId === w.voiture.id)).toEqual([]);
  });

  it('DUO-02 — départ d’un membre : la demande en attente est acceptée par le système, les données suivent le bien', async () => {
    const w = await monde(sql, make);
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status) VALUES (${w.duo.id}, ${w.titulaire.id}, 'ACTIVE'), (${w.duo.id}, ${w.membre.id}, 'ACTIVE')`;
    await sql`
      INSERT INTO asset_move_requests (asset_id, duo_id, target_account_id, initiator_user_id, validator_user_id, asset_label_snapshot, target_user_snapshot, initiator_user_snapshot)
      VALUES (${w.voiture.id}, ${w.duo.id}, ${w.cible.id}, ${w.membre.id}, ${w.titulaire.id}, 'Voiture', 'Membre', 'Membre')`;
    const { DuoService } = await import('@/services/duo.service');
    await DuoService.leaveDuo({ duoId: w.duo.id, userId: w.titulaire.id });
    expect(await compteDe('assets', w.voiture.id)).toBe(w.cible.id);
    expect(await compteDe('asset_files', w.f1.id)).toBe(w.cible.id);
    expect(await compteDe('asset_files', w.f3.id)).toBe(w.duoCompte.id);
    expect(await compteDe('agenda_items', w.g1.id)).toBe(w.cible.id);
  });

  it('DUO-03 — rattrapage des déplacements passés : détecté, simulation exacte sans écriture, application, idempotent ; tâche planifiée', async () => {
    const w = await monde(sql, make);
    // Déplacement « d'avant le lot 40 » : seul le bien a changé de compte, sur
    // demande de déplacement ACCEPTÉE (preuve exigée depuis le lot 54). L'état
    // historique est reconstitué hors gardes (0373 refuse désormais un
    // changement de propriétaire qui laisse des données derrière lui).
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE assets SET account_id = ${w.cible.id}, duo_id = NULL WHERE id = ${w.voiture.id}`;
    });
    await sql`
      INSERT INTO asset_move_requests (asset_id, duo_id, target_account_id, initiator_user_id, validator_user_id, status, resolved_at, resolved_by_type,
                                       asset_label_snapshot, target_user_snapshot, initiator_user_snapshot)
      VALUES (${w.voiture.id}, ${w.duo.id}, ${w.cible.id}, ${w.membre.id}, ${w.titulaire.id}, 'ACCEPTED', now(), 'USER', 'Voiture', 'Membre', 'Membre')`;
    const { findMisplacedAssetData, runAssetAccountBackfill } = await import('@/services/assets/asset-account-backfill');
    const mien = (l: Array<{ assetId: number }>) => l.filter((c) => c.assetId === w.voiture.id);
    expect(mien(await findMisplacedAssetData(500))).toEqual([{ assetId: w.voiture.id, toAccountId: w.cible.id, fromAccountId: w.duoCompte.id }]);

    const sim = await runAssetAccountBackfill({ apply: false, batchSize: 500 });
    const r = sim.results.find((x) => x.assetId === w.voiture.id)!;
    expect(r.movedFileIds).toEqual([w.f1.id, w.f2.id, w.f4.id, w.f6.id].sort((a, b) => a - b));
    expect(r.keptFileIds).toEqual([w.f3.id, w.f5.id].sort((a, b) => a - b));
    expect(r.movedAgendaItemIds).toEqual([w.g1.id]);
    expect(await compteDe('asset_files', w.f1.id)).toBe(w.duoCompte.id); // simulation : rien d'écrit
    // Rapport lisible (BO Exploitation).
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    expect(summarizeBackfill('asset-account', 'simulate', null, { result: sim }).headline).toMatch(/^Simulation : \d+ bien\(s\) à remettre/);

    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const res = await findTask('asset-account-backfill')!.run({ deadline: Date.now() + 60_000, trigger: 'startup' });
    expect(res && 'note' in res ? res.note : '').toMatch(/bien\(s\) remis en cohérence/);
    expect(await compteDe('asset_files', w.f1.id)).toBe(w.cible.id);
    expect(await compteDe('asset_files', w.f3.id)).toBe(w.duoCompte.id);
    expect(mien(await findMisplacedAssetData(500))).toEqual([]);
    // Rejoué : aucun effet.
    const again = await runAssetAccountBackfill({ apply: true, batchSize: 500 });
    expect(again.results.find((x) => x.assetId === w.voiture.id)).toBeUndefined();
  });

  it('DUO-04 — Opérations : une source restée dans un autre compte est désactivée, l’Opération sans preuve invalidée (C25, C8)', async () => {
    const w = await monde(sql, make);
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    // Opération multi-biens (reste dans l'ancien compte) prouvée par F1 (qui part) et par F3 (qui reste).
    const multiId = (await withBusinessOperationWrite(w.duoCompte.id, (r) => r.create({
      type: { code: 'INTERVENTION' }, status: 'REALIZED',
      source: { kind: 'DOCUMENT', entityKey: w.f1.id, authority: 'DOCUMENT', role: 'INVOICE', confidence: 'certain' },
      assets: [{ assetId: w.voiture.id, authority: 'DOCUMENT' }, { assetId: w.maison.id, authority: 'DOCUMENT' }],
      reasonCode: 'E2E',
    } as never))).id;
    await withBusinessOperationWrite(w.duoCompte.id, (r) => r.addSource(multiId, { kind: 'DOCUMENT', entityKey: w.f3.id, authority: 'DOCUMENT', role: 'INVOICE', confidence: 'certain' } as never));
    // Opération de la maison seule, prouvée uniquement par F1 (qui part).
    const seuleId = (await withBusinessOperationWrite(w.duoCompte.id, (r) => r.create({
      type: { code: 'INTERVENTION' }, status: 'REALIZED',
      source: { kind: 'DOCUMENT', entityKey: w.f1.id, authority: 'DOCUMENT', role: 'INVOICE', confidence: 'certain' },
      assets: [{ assetId: w.maison.id, authority: 'DOCUMENT' }], reasonCode: 'E2E',
    } as never))).id;
    const [req] = await sql<{ id: number }[]>`
      INSERT INTO asset_move_requests (asset_id, duo_id, target_account_id, initiator_user_id, validator_user_id, asset_label_snapshot, target_user_snapshot, initiator_user_snapshot)
      VALUES (${w.voiture.id}, ${w.duo.id}, ${w.cible.id}, ${w.membre.id}, ${w.titulaire.id}, 'Voiture', 'Membre', 'Membre') RETURNING id`;
    const { DuoService } = await import('@/services/duo.service');
    await DuoService.respondToMoveRequest({ requestId: req.id, action: 'ACCEPT', resolvedByUserId: w.titulaire.id, resolvedByType: 'USER' });

    const sources = await sql<{ operation_id: number; key: string; active: boolean }[]>`
      SELECT operation_id::int AS operation_id, source_entity_key AS key, active FROM business_operation_sources
       WHERE operation_id IN (${multiId}, ${seuleId}) ORDER BY operation_id, id`;
    expect(sources).toEqual([
      { operation_id: multiId, key: String(w.f1.id), active: false },
      { operation_id: multiId, key: String(w.f3.id), active: true },
      { operation_id: seuleId, key: String(w.f1.id), active: false },
    ]);
    const inval = await sql<{ id: number; invalidated: boolean }[]>`
      SELECT id::int AS id, invalidated_at IS NOT NULL AS invalidated FROM business_operations WHERE id IN (${multiId}, ${seuleId}) ORDER BY id`;
    expect(inval).toEqual([{ id: multiId, invalidated: false }, { id: seuleId, invalidated: true }].sort((a, b) => a.id - b.id));
  });

  it('DUO-06 — couverture : toute table portant un compte ET un bien ou un document est classée (suit le bien, suit le document, ou reste au compte — motif écrit)', async () => {
    const { FILE_SCOPED_TABLES, ASSET_SCOPED_TABLES, ACCOUNT_OWNED_TABLES } = await import('@/services/assets/asset-account-transfer.service');
    const tables = await sql<{ t: string }[]>`
      SELECT DISTINCT c.table_name AS t FROM information_schema.columns c
       WHERE c.table_schema = current_schema() AND c.column_name = 'account_id'
         AND EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = c.table_schema AND x.table_name = c.table_name
                      AND x.column_name IN ('asset_id', 'file_id', 'asset_file_id', 'document_id', 'linked_asset_id', 'source_file_id'))
       ORDER BY 1`;
    const classees = new Set([...FILE_SCOPED_TABLES.map(([t]) => t), ...ASSET_SCOPED_TABLES, ...Object.keys(ACCOUNT_OWNED_TABLES)]);
    expect(tables.map((r) => r.t).filter((t) => !classees.has(t))).toEqual([]);
  });

  it('DUO-05 — atomicité : un transfert interrompu ne déplace rien ; le bien doit déjà être dans le compte cible', async () => {
    const w = await monde(sql, make);
    const { transferAssetDataInTx } = await import('@/services/assets/asset-account-transfer.service');
    const { db } = await import('@/db');
    await expect(db.transaction((tx) => transferAssetDataInTx(tx, { assetId: w.voiture.id, fromAccountId: w.duoCompte.id, toAccountId: w.cible.id })))
      .rejects.toThrow(/ASSET_NOT_IN_TARGET_ACCOUNT/);
    await expect(db.transaction(async (tx) => {
      await tx.execute((await import('drizzle-orm')).sql`UPDATE assets SET account_id = ${w.cible.id} WHERE id = ${w.voiture.id}`);
      await transferAssetDataInTx(tx, { assetId: w.voiture.id, fromAccountId: w.duoCompte.id, toAccountId: w.cible.id });
      throw new Error('ROLLBACK');
    })).rejects.toThrow('ROLLBACK');
    expect(await compteDe('assets', w.voiture.id)).toBe(w.duoCompte.id);
    expect(await compteDe('asset_files', w.f1.id)).toBe(w.duoCompte.id);
    expect(await compteDe('agenda_items', w.g1.id)).toBe(w.duoCompte.id);
  });
});
