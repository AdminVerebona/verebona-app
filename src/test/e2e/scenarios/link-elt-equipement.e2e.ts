/**
 * LINK-ELT — rattachement ambigu document → équipement sur base réelle
 * (CDC 15 T3-07, lot 13) : proposition idempotente, résolution (colonne,
 * trace, lien N-N actif), refus d'un équipement d'un autre bien ou compte,
 * annulation.
 */
import { it, expect, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {} }));

scenario('LINK-ELT', 'Document → équipement arbitré par l’utilisateur', ({ sql, make }) => {
  it('proposition, idempotence, refus, résolution et annulation', async () => {
    const compte = await make.account();
    const autre = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    const autreBien = await make.asset(compte, { category: 'IMMOBILIER' });
    const bienEtranger = await make.asset(autre, { category: 'IMMOBILIER' });
    const eq = async (assetId: number, name: string) =>
      (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`)[0].id;
    const chaudiere = await eq(bien.id, 'Chaudière');
    const pac = await eq(bien.id, 'Pompe à chaleur');
    const ailleurs = await eq(autreBien.id, 'Chauffe-eau');
    const etranger = await eq(bienEtranger.id, 'Chaudière voisine');
    const doc = await make.assetFile(compte, { assetId: bien.id });

    const { proposeDocumentEquipmentLink } = await import('@/services/to-process/document-equipment-link');
    const candidats = [
      { equipmentId: chaudiere, score: 0.64, reason: 'modèle cité' },
      { equipmentId: pac, score: 0.61, reason: 'marque citée' },
      { equipmentId: ailleurs, score: 0.9, reason: 'autre bien' },
      { equipmentId: etranger, score: 0.9, reason: 'autre compte' },
    ];
    const r1 = await proposeDocumentEquipmentLink({ accountId: compte.id, fileId: doc.id, assetId: bien.id, candidates: candidats });
    expect(r1).toMatchObject({ status: 'CREATED' });
    expect(r1.rejected.sort()).toEqual([ailleurs, etranger].sort());
    const r2 = await proposeDocumentEquipmentLink({ accountId: compte.id, fileId: doc.id, assetId: bien.id, candidates: [...candidats].reverse() });
    expect(r2).toMatchObject({ status: 'UPDATED', actionId: r1.actionId });
    const [{ n, hashes }] = await sql<{ n: number; hashes: number }[]>`
      SELECT count(*)::int AS n, count(DISTINCT trigger_context_hash)::int AS hashes FROM to_process_actions
       WHERE account_id = ${compte.id} AND target_type = 'DOCUMENT' AND target_id = ${doc.id} AND relation_key = 'elementId'`;
    expect({ n, hashes }).toEqual({ n: 1, hashes: 1 });

    const [{ public_id: publicId }] = await sql<{ public_id: string }[]>`SELECT public_id FROM to_process_actions WHERE id = ${r1.actionId!}`;
    const { resolveArbitration, undoArbitration } = await import('@/services/to-process/resolve-action.service');

    // Refus : équipement d'un autre bien du compte, ou d'un autre compte.
    expect(await resolveArbitration(compte.id, publicId, ailleurs)).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect(await resolveArbitration(compte.id, publicId, etranger)).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    const [{ equipment_id: avant }] = await sql<{ equipment_id: number | null }[]>`SELECT equipment_id FROM asset_files WHERE id = ${doc.id}`;
    expect(avant).toBeNull();

    // Résolution.
    const res = await resolveArbitration(compte.id, publicId, pac, { userId: compte.ownerUserId });
    expect(res).toEqual({ ok: true, previousValue: null });
    const [etat] = await sql<{ equipment_id: number; resolved: boolean; reason: string }[]>`
      SELECT f.equipment_id, a.resolved_at IS NOT NULL AS resolved, a.resolution_reason AS reason
        FROM asset_files f, to_process_actions a WHERE f.id = ${doc.id} AND a.id = ${r1.actionId!}`;
    expect(etat).toEqual({ equipment_id: pac, resolved: true, reason: 'USER_ARBITRATED' });
    const [trace] = await sql<{ field_key: string; new_value: unknown }[]>`
      SELECT field_key, new_value FROM to_process_action_events WHERE action_id = ${r1.actionId!} AND event = 'RESOLVED_ARBITRATION'`;
    expect(trace).toMatchObject({ field_key: 'elementId', new_value: pac });
    // Lien N-N actif vers l'équipement : le déclencheur 0221 l'a posé depuis
    // `equipment_id` (LEGACY_COLUMN) dans la transaction ; le lien USER du
    // service de C ne peut coexister (un seul lien actif par cible) — il n'est
    // posé que si le déclencheur ne l'a pas fait.
    const liens = await sql<{ origin: string }[]>`
      SELECT origin FROM document_asset_links WHERE file_id = ${doc.id} AND equipment_id = ${pac} AND status = 'ACTIVE'`;
    expect(liens).toHaveLength(1);
    expect(['LEGACY_COLUMN', 'USER']).toContain(liens[0].origin);

    // Annulation : valeur précédente (aucun équipement), carte rouverte, lien USER retiré.
    expect(await undoArbitration(compte.id, publicId, res.previousValue)).toMatchObject({ ok: true });
    const [apres] = await sql<{ equipment_id: number | null; resolved: boolean }[]>`
      SELECT f.equipment_id, a.resolved_at IS NOT NULL AS resolved FROM asset_files f, to_process_actions a
       WHERE f.id = ${doc.id} AND a.id = ${r1.actionId!}`;
    expect(apres).toEqual({ equipment_id: null, resolved: false });
    const liensApres = await sql<{ origin: string }[]>`
      SELECT origin FROM document_asset_links WHERE file_id = ${doc.id} AND equipment_id = ${pac} AND status = 'ACTIVE'`;
    expect(liensApres).toEqual([]);
  });
});
