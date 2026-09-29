/**
 * P-T1-02 / P-T1-04 — prompt maître T1 sur base réelle (CDC 15 §30, T1-02,
 * T1-04, T1-05 ; D-08 : sorties modèle SYNTHÉTIQUES enregistrées, D-17 :
 * aucun réseau).
 *
 * Chaîne exercée : passerelle réelle (master `t1_master_v1` du dépôt, TASK
 * imposée) → contrôle de preuve et identifiants revérifiés EN BASE →
 * projection déterministe → `persistProjectedFacts` → `field_evidence`.
 *
 * Les fixtures (`source-analysis/__fixtures__/t1`) citent des identifiants
 * fictifs (184, 12, 13) : ils sont remplacés par ceux des biens créés.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';
import { loadT1Fixture, type T1Fixture } from '@/services/ai/source-analysis/__fixtures__/t1/load';
import type { AnalysisContext, SourceInput } from '@/services/ai/source-analysis/types';

/** Sortie enregistrée avec les identifiants du compte E2E. */
function recording(f: T1Fixture, ids: Record<number, number>) {
  let json = JSON.stringify(f.recording.output);
  for (const [fictif, reel] of Object.entries(ids)) {
    json = json.replace(new RegExp(`("entityId":)${fictif}\\b`, 'g'), `$1${reel}`);
  }
  return { operationCode: f.recording.operationCode, task: f.recording.task, output: JSON.parse(json) as unknown };
}

scenario('P-T1-MASTER', 'Prompt maître T1 : projection et preuves ciblées', ({ sql, make, useRecordings }) => {
  it('P-T1-02 : ticket de la draisienne → acquisitionDate et acquisitionPrice (EUR) en preuves du bien', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'OBJECT', name: 'Draisienne' });
    const fichier = await make.assetFile(compte, { assetId: bien.id, name: 'ticket.jpg', mimeType: 'image/jpeg' });
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    const replay = await useRecordings([recording(f, { 184: bien.id })]);

    const { analyseGroupWithMaster } = await import('@/services/ai/source-analysis/master/analyse-group-master');
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const { emptyTrace } = await import('@/services/ai/source-analysis/trace');

    const input: SourceInput = {
      sourceType: 'file', sourceIds: [fichier.id], accountId: compte.id, userId: compte.ownerUserId,
      mimeTypes: ['image/jpeg'], displayNames: ['ticket.jpg'], linkedAssetId: bien.id,
    };
    const ctx: AnalysisContext = {
      accountId: compte.id, userId: compte.ownerUserId, linkedAssetId: bien.id, existingTitles: [],
      assets: [{ id: bien.id, name: 'Draisienne', category: 'OBJECT', subtype: null }], rooms: [], equipments: [],
    };
    const m = await analyseGroupWithMaster(input, [0], ctx, emptyTrace());
    expect(replay.calls[0].task).toBe('ANALYZE_DOCUMENT');

    await persistProjectedFacts({
      input, leadSourceId: fichier.id, facts: m.facts,
      documentType: m.result.document.type?.value, documentDate: m.result.document.date?.value,
      trace: m.result.operationTrace,
    });

    const preuves = await sql<{ field_key: string; value_json: unknown; canonical_key: string | null; projection_rule: string | null; target_entity_id: number | null }[]>`
      SELECT field_key, value_json, canonical_key, projection_rule, target_entity_id
        FROM field_evidence WHERE asset_id = ${bien.id} ORDER BY field_key`;
    expect(preuves.map((p) => [p.canonical_key, p.projection_rule, p.target_entity_id])).toEqual([
      ['acquisitionDate', 'PURCHASE_RECEIPT_ACQUISITION_DATE', bien.id],
      ['acquisitionPrice', 'PURCHASE_RECEIPT_ACQUISITION_PRICE', bien.id],
    ]);
    // T1-03 : euros dans la preuve de fiche (jamais ×100).
    expect(Number(preuves[1].value_json)).toBe(129);
  });

  it('P-T1-04 : facture deux véhicules → chaque preuve sur son bien, aucune fuite croisée', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const tesla = await make.asset(compte, { category: 'VEHICULE', name: 'Tesla Model 3' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const f = loadT1Fixture('p-t1-04-facture-deux-vehicules.json');
    await useRecordings([recording(f, { 12: clio.id, 13: tesla.id })]);

    const { analyseGroupWithMaster } = await import('@/services/ai/source-analysis/master/analyse-group-master');
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const { emptyTrace } = await import('@/services/ai/source-analysis/trace');

    const input: SourceInput = {
      sourceType: 'file', sourceIds: [fichier.id], accountId: compte.id, userId: compte.ownerUserId,
      mimeTypes: ['application/pdf'], displayNames: ['facture.pdf'], linkedAssetId: clio.id,
    };
    const ctx: AnalysisContext = {
      accountId: compte.id, userId: compte.ownerUserId, linkedAssetId: clio.id, existingTitles: [],
      assets: [
        { id: clio.id, name: 'Clio', category: 'VEHICULE', subtype: null },
        { id: tesla.id, name: 'Tesla Model 3', category: 'VEHICULE', subtype: null },
      ],
      rooms: [], equipments: [],
    };
    const m = await analyseGroupWithMaster(input, [0], ctx, emptyTrace());
    await persistProjectedFacts({ input, leadSourceId: fichier.id, facts: m.facts, trace: m.result.operationTrace });

    const kmDe = async (assetId: number) => (await sql<{ value_json: unknown }[]>`
      SELECT value_json FROM field_evidence WHERE asset_id = ${assetId} AND canonical_key = 'mileage'`).map((r) => Number(r.value_json));
    expect(await kmDe(clio.id)).toEqual([78000]);
    expect(await kmDe(tesla.id)).toEqual([42000]);
    // Le fait ambigu (« véhicule de prêt ») n'est écrit sur aucun des deux biens.
    const immat = await sql`SELECT id FROM field_evidence WHERE asset_id IN (${clio.id}, ${tesla.id}) AND canonical_key = 'registrationNumber'`;
    expect(immat).toHaveLength(0);
  });
});
