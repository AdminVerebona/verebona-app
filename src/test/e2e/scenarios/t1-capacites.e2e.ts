/**
 * T1 — Pièces et Équipements selon les capacités du compte (E2E-T1-CAP-01..04).
 *
 * Chaîne réelle (`chain.ts`) : point d'entrée de production, prompt maître T1
 * par la passerelle (sortie SYNTHÉTIQUE rejouée), garde-fou de capacités,
 * projection, preuves, T3 / T4 en file durable. La sortie rejouée est celle
 * d'un modèle qui IGNORE la consigne (cible EQUIPMENT / ROOM sur un compte
 * Standard) : c'est le serveur qui doit tenir la règle.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { analyserDocument, fiche, sortieT1, useTargetState, withIds } from '../chain';
import { loadT1Fixture } from '@/services/ai/source-analysis/__fixtures__/t1/load';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('T1-CAP', 'T1 — Pièces et Équipements selon les capacités du compte', ({ sql, make, useRecordings }) => {
  useTargetState();

  const analyser = (compte: { id: number; ownerUserId: number }, fileId: number, linkedAssetId: number | null, output: Record<string, unknown>) =>
    analyserDocument(sql, useRecordings, { accountId: compte.id, userId: compte.ownerUserId, fileId, linkedAssetId, output });

  /** Appartement + chaudière existante (créée avant un éventuel changement d'offre). */
  async function maison(plan: 'standard' | 'premium' | 'premium_duo') {
    const compte = await make.account({ plan });
    const appart = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Lyon' });
    const [eq] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, type) VALUES (${appart.id}, 'Chaudière Frisquet', 'BOILER') RETURNING id`;
    const fichier = await make.assetFile(compte, { assetId: appart.id });
    return { compte, appart, equipementId: Number(eq.id), fichier };
  }
  const chaudiere = (appartId: number, equipementId: number) =>
    withIds(loadT1Fixture('t1-04-equipement-chaudiere.json').recording.output, { 30: appartId, 501: equipementId });

  const preuvesSource = (fileId: number) => sql<{ key: string; target_type: string; target_entity_id: number | null }[]>`
    SELECT coalesce(canonical_key, field_key) AS key, target_type, target_entity_id FROM field_evidence
     WHERE source_id = ${fileId} AND status = 'active' ORDER BY 1`;
  const faitsDocument = (fileId: number) => sql<{ subject: string | null; attribute: string | null; target_type: string | null; value_text: string | null; normalized_value: string | null }[]>`
    SELECT subject, attribute, target_type, value_text, normalized_value FROM document_facts WHERE file_id = ${fileId}`;
  const liensEquipement = (compteId: number) => sql`
    SELECT l.equipment_id FROM agenda_items i JOIN agenda_equipment_links l ON l.agenda_item_id = i.id WHERE i.account_id = ${compteId}`
    .catch(() => [] as unknown[]);

  it('E2E-T1-CAP-01 — facture chaudière, compte Standard : faits conservés, aucun équipement, fiche intacte, aucun agenda équipement', async () => {
    const m = await maison('standard');
    const r = await analyser(m.compte, m.fichier.id, m.appart.id, chaudiere(m.appart.id, m.equipementId));
    expect(r.analysedCount).toBe(1);

    // Aucune preuve ciblée sur l'équipement, aucune valeur reportée sur le bien.
    const p = await preuvesSource(m.fichier.id);
    expect(p.filter((x) => x.target_type === 'EQUIPMENT' || x.target_type === 'ROOM')).toEqual([]);
    const fi = await fiche(sql, m.appart.id);
    expect(fi.serialNumber).toBeUndefined();
    expect(fi.warrantyEndDate).toBeUndefined();

    // Rien n'est perdu : connaissance générique du document (lue par T2).
    const faits = await faitsDocument(m.fichier.id);
    const valeurs = faits.map((f) => f.normalized_value ?? f.value_text);
    expect(valeurs).toEqual(expect.arrayContaining(['FR-2026-001', '2028-12-31']));
    expect(faits.every((f) => f.target_type !== 'EQUIPMENT' && f.target_type !== 'ROOM')).toBe(true);
    expect(faits.some((f) => f.subject === 'Chaudière')).toBe(true);

    // Ni échéance d'équipement, ni échéance réattribuée au bien.
    expect(await liensEquipement(m.compte.id)).toEqual([]);
    const agenda = await sql`SELECT id FROM agenda_items WHERE account_id = ${m.compte.id}`;
    expect(agenda).toHaveLength(0);
  });

  it.each(['premium', 'premium_duo'] as const)('E2E-T1-CAP-02 — même document, compte %s : équipement ciblé, échéance liée', async (plan) => {
    const m = await maison(plan);
    await analyser(m.compte, m.fichier.id, m.appart.id, chaudiere(m.appart.id, m.equipementId));
    const p = (await preuvesSource(m.fichier.id)).filter((x) => x.target_type === 'EQUIPMENT');
    expect(p.map((x) => x.key).sort()).toEqual(['serialNumber', 'warrantyEndDate']);
    expect(p.every((x) => Number(x.target_entity_id) === m.equipementId)).toBe(true);
    expect((await liensEquipement(m.compte.id)).length).toBe(1);
  });

  it('E2E-T1-CAP-03 — document immobilier citant une chambre, Standard : aucune pièce ; le nombre de pièces du logement reste un champ du bien', async () => {
    const compte = await make.account({ plan: 'standard' });
    const appart = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Lyon' });
    const [chambre] = await sql<{ id: number }[]>`INSERT INTO rooms (asset_id, account_id, name, room_type) VALUES (${appart.id}, ${compte.id}, 'Chambre', 'BEDROOM') RETURNING id`;
    const fichier = await make.assetFile(compte, { assetId: appart.id });
    const sortie = sortieT1({
      title: 'Diagnostic surfaces Appartement Lyon', date: '2026-03-02', documentTypeCode: 'DIAGNOSTIC',
      assets: [{ id: appart.id, label: 'Appartement Lyon' }],
      facts: [
        { canonicalKey: 'roomCount', value: 3, valueType: 'number', excerpt: 'Nombre de pièces principales : 3', assetId: appart.id },
        { canonicalKey: 'roomArea', value: 12.5, valueType: 'number', unit: 'm2', excerpt: 'Chambre : 12,5 m²', assetId: null, targetType: 'ROOM' },
      ],
    });
    // Le modèle désigne la pièce existante (cible ROOM, entité détectée) malgré la consigne.
    const faits = sortie.facts as Array<{ target: { type: string; entityId: number | null } }>;
    faits[1].target.entityId = Number(chambre.id);
    (sortie.entities as { rooms: unknown[] }).rooms = [{ entityId: Number(chambre.id), rawLabel: 'Chambre', score: 0.9, confidence: 'certain', evidenceSignals: ['Chambre'] }];
    await analyser(compte, fichier.id, appart.id, sortie);

    const p = await preuvesSource(fichier.id);
    expect(p.filter((x) => x.target_type === 'ROOM')).toEqual([]);
    expect(p.find((x) => x.key === 'roomCount')).toMatchObject({ target_type: 'ASSET' });
    const area = await sql`SELECT area FROM rooms WHERE id = ${chambre.id}`.catch(() => [{ area: null }]);
    expect(area[0]?.area ?? null).toBeNull();
    // La surface de la chambre n'est pas perdue : connaissance générique du document.
    const surface = (await faitsDocument(fichier.id)).find((f) => Number(f.normalized_value ?? f.value_text) === 12.5);
    expect(surface?.target_type).toBe('GENERIC');
  });

  it('E2E-T1-CAP-04 — passage Standard → Premium : la nouvelle analyse exploite l’équipement', async () => {
    const m = await maison('standard');
    await analyser(m.compte, m.fichier.id, m.appart.id, chaudiere(m.appart.id, m.equipementId));
    expect((await preuvesSource(m.fichier.id)).filter((x) => x.target_type === 'EQUIPMENT')).toEqual([]);

    await sql`UPDATE account_subscriptions SET plan_code = 'premium' WHERE account_id = ${m.compte.id}`;
    await analyser(m.compte, m.fichier.id, m.appart.id, chaudiere(m.appart.id, m.equipementId));
    const p = (await preuvesSource(m.fichier.id)).filter((x) => x.target_type === 'EQUIPMENT');
    expect(p.map((x) => x.key).sort()).toEqual(['serialNumber', 'warrantyEndDate']);
  });
});
