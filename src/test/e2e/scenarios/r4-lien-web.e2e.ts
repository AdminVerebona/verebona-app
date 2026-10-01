/**
 * Reliquat R4 (CDC 15, DOD-06) — preuves d'un LIEN WEB au fil de sa vie.
 *
 * Un lien web est une ligne `asset_files` (`is_web_link`), analysée par le
 * point d'entrée de production `analyzeWebLinkSource` avec
 * `sourceIds: [asset_files.id]` : ses preuves sont `source_type = 'web_link'`
 * dans le MÊME espace d'identifiants que les documents. Suppression,
 * détachement et déplacement passent par les mêmes routes que les documents
 * (`DELETE /api/files/[id]`, `PUT /api/documents/[id]`) → mêmes transitions,
 * sous `T3_NEGATIVE_RECONCILIATION`.
 *
 * La page est servie par un `fetch` simulé (aucun réseau) ; la sortie T1 est
 * rejouée par la vraie passerelle.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, fiche, preuves, sortieT1, useTargetState, type FaitT1 } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const PAGE = `<html><head><title>Facture entretien Clio</title></head><body>
<h1>Facture entretien Clio</h1><p>2026-09-03</p><p>Garage Martin</p>
<p>Kilométrage : 45 000 km</p><p>Prochaine révision : 03/09/2027</p><p>TOTAL TTC 300,00 €</p></body></html>`;

scenario('R4-LIEN-WEB', 'Preuves d’un lien web : suppression, détachement, déplacement', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const sortie = (assetId: number | null) => sortieT1({
    title: 'Facture entretien Clio', date: '2026-09-03', documentTypeCode: 'MAINTENANCE_INVOICE', amountCents: 30000, supplier: 'Garage Martin',
    assets: assetId ? [{ id: assetId, label: 'Clio' }] : [],
    facts: [
      { canonicalKey: 'mileage', value: 45000, valueType: 'number', unit: 'km', excerpt: 'Kilométrage : 45 000 km', assetId },
      { canonicalKey: 'maintenanceDueDate', value: '2027-09-03', valueType: 'date', excerpt: 'Prochaine révision : 03/09/2027', assetId,
        semanticEvent: { type: 'maintenance', nature: 'DEADLINE' } },
    ] as FaitT1[],
  });

  /** Lien web du compte, analysé par le point d'entrée de production. */
  const lienAnalyse = async (compte: { id: number; ownerUserId: number }, assetId: number | null) => {
    const f = await make.assetFile(compte as never, { assetId });
    await sql`UPDATE asset_files SET is_web_link = true, web_link_url = 'https://garage-martin.example/facture-clio',
              web_link_title = 'Facture entretien Clio', mime_type = 'text/html', analysis_state = NULL WHERE id = ${f.id}`;
    await analyser(compte, f.id, assetId);
    return f.id;
  };
  const analyser = async (compte: { id: number; ownerUserId: number }, fileId: number, assetId: number | null) => {
    // Seule la page du lien est servie ; le reste reste interdit (setup E2E).
    const fetchAvant = globalThis.fetch;
    globalThis.fetch = (async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch;
    try {
      await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortie(assetId) }]);
      const { analyzeWebLinkSource } = await import('@/services/ai/source-analysis/entrypoint');
      const r = await analyzeWebLinkSource(fileId, compte.id, { userId: compte.ownerUserId });
      expect(r.skippedReason ?? null).toBeNull();
    } finally {
      globalThis.fetch = fetchAvant;
    }
    await drainQueues();
  };
  const typesActifs = async (fileId: number) => (await sql<{ asset_id: number; source_type: string }[]>`
    SELECT DISTINCT asset_id, source_type FROM field_evidence
     WHERE source_id = ${fileId} AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE' ORDER BY asset_id`)
    .map((r) => [Number(r.asset_id), r.source_type]);

  it('R4 (enabled) — analyse : preuves `web_link` sur l’identifiant asset_files du lien', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const lien = await lienAnalyse(compte, clio.id);
    expect(await typesActifs(lien)).toEqual([[clio.id, 'web_link']]);
    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 45000, maintenanceDueDate: '2027-09-03' });
  });

  it('R4 (enabled) — suppression du lien : preuves retirées, fiche recalculée ; une preuve `document` de même id n’existe pas', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const lien = await lienAnalyse(compte, clio.id);

    // Comme `DELETE /api/files/[id]`.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${lien}`;
    const { onDocumentsDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    const r = await onDocumentsDeleted({ accountId: compte.id, userId: compte.ownerUserId, fileIds: [lien] });
    await drainQueues();

    expect(r).toMatchObject({ mode: 'enabled', dryRun: false });
    expect(r.withdrawn).toBeGreaterThan(0);
    expect(await typesActifs(lien)).toEqual([]);
    expect(await preuves(sql, clio.id)).toEqual([]);
    const fi = await fiche(sql, clio.id);
    expect(fi.mileage).toBeUndefined();
    expect(fi.maintenanceDueDate).toBeUndefined();
  });

  it('R4 (enabled) — détachement puis déplacement A → B : rien ne reste sur A ; B reçoit des preuves `web_link`', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const lien = await lienAnalyse(compte, clio.id);
    const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');

    // Comme `PUT /api/documents/[id]` : A → B.
    await sql`UPDATE asset_files SET asset_id = ${polo.id} WHERE id = ${lien}`;
    await onDocumentAssetChanged({ accountId: compte.id, userId: compte.ownerUserId, fileId: lien, fromAssetId: clio.id, toAssetId: polo.id });
    const { projectDocumentKnowledgeToAsset } = await import('@/services/ai/knowledge/document-knowledge.service');
    const n = await projectDocumentKnowledgeToAsset({ accountId: compte.id, userId: compte.ownerUserId, fileId: lien, assetId: polo.id });
    await drainQueues();
    // Faits ciblés sur l'ancien bien : la route se replie sur la réanalyse.
    if (n === 0) await analyser(compte, lien, polo.id);

    expect(await typesActifs(lien)).toEqual([[polo.id, 'web_link']]);
    expect(await preuves(sql, clio.id)).toEqual([]);
    expect((await fiche(sql, clio.id)).mileage).toBeUndefined();
    expect(await fiche(sql, polo.id)).toMatchObject({ mileage: 45000 });

    // Détachement (B → aucun bien) : retrait sur B.
    await sql`UPDATE asset_files SET asset_id = NULL WHERE id = ${lien}`;
    await onDocumentAssetChanged({ accountId: compte.id, userId: compte.ownerUserId, fileId: lien, fromAssetId: polo.id, toAssetId: null });
    await drainQueues();
    expect(await typesActifs(lien)).toEqual([]);
    expect((await fiche(sql, polo.id)).mileage).toBeUndefined();
  });

  it('R4 (enabled) — lien sans bien puis rattaché : la reprojection garde le type `web_link`', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const lien = await lienAnalyse(compte, null);
    expect(await typesActifs(lien)).toEqual([]);
    await sql`UPDATE asset_files SET asset_id = ${clio.id} WHERE id = ${lien}`;
    const { projectDocumentKnowledgeToAsset } = await import('@/services/ai/knowledge/document-knowledge.service');
    expect(await projectDocumentKnowledgeToAsset({ accountId: compte.id, userId: compte.ownerUserId, fileId: lien, assetId: clio.id })).toBeGreaterThan(0);
    await drainQueues();
    expect(await typesActifs(lien)).toEqual([[clio.id, 'web_link']]);
    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 45000 });
  });

  it('R4 (legacy) — T3_NEGATIVE_RECONCILIATION=legacy : comportement historique, rien n’est retiré (comme pour un document)', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const lien = await lienAnalyse(compte, clio.id);
    process.env.T3_NEGATIVE_RECONCILIATION = 'legacy';
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${lien}`;
    const { onDocumentsDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    expect(await onDocumentsDeleted({ accountId: compte.id, userId: compte.ownerUserId, fileIds: [lien] })).toMatchObject({ mode: 'legacy', withdrawn: 0 });
    expect(await typesActifs(lien)).toEqual([[clio.id, 'web_link']]);
  });
});
