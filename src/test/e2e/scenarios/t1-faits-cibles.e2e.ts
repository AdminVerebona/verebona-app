/**
 * T1-04 / T1-05 / §14.4 — faits ciblés et cycle de vie des preuves, vérifiés
 * sur une base réelle (migrations 0218 et 0219 appliquées par le harnais).
 *
 *  · document à deux véhicules + chaudière : chaque preuve sur SA cible ;
 *  · fait sans cible vérifiée : aucune preuve, fait conservé (U8, DOD-01) ;
 *  · réanalyse de la même source : anciennes preuves SUPERSEDED avec lien,
 *    jamais supprimées ; seule la nouvelle est lue par la réconciliation ;
 *  · récurrence persistée dans document_facts et restaurée (T4-06) ;
 *  · supersede CONCURRENT : deux analyses de la même source, la plus récente
 *    gagne toujours (verrou consultatif, `analysis_run_id`) ; `status` intact ;
 *  · P-T1-04 : rattachement tardif d'un document multi-biens sans fuite.
 */
import { it, expect } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact, PersistedFactTarget } from '@/services/ai/source-analysis/master/t1-contract';

const trace = {
  traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'],
};
const cible = (targetType: PersistedFactTarget['targetType'], targetEntityId: number | null): PersistedFactTarget =>
  ({ targetType, targetEntityId, targetEntityLabel: null, targetConfidence: 'certain' });
const fait = (over: Partial<ProjectedFact>): ProjectedFact => ({
  canonicalKey: 'mileage', rawKey: 'Kilométrage', label: null, subject: null, attribute: null,
  rawValue: null, value: 1, valueType: 'number', canonicalUnit: 'km', target: cible('ASSET', null),
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'extrait', page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null,
  origin: 'MODEL_CANONICAL', ruleCode: null, ...over,
});

scenario('T1-04', 'Faits ciblés et cycle de vie des preuves', ({ sql, make }) => {
  it('multi-biens, équipement, non rattaché, puis réanalyse', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v1 = await make.asset(compte, { category: 'VEHICULE' });
    const v2 = await make.asset(compte, { category: 'VEHICULE' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const [chaudiere] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Chaudière') RETURNING id`;
    const fichier = await make.assetFile(compte, { assetId: null });

    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const { getActiveEvidence } = await import('@/services/ai/evidence/field-evidence.service');
    const input = {
      sourceType: 'file' as const, sourceIds: [fichier.id], accountId: compte.id, userId: compte.ownerUserId,
      mimeTypes: [], displayNames: [],
    };

    const r1 = await persistProjectedFacts({
      input, leadSourceId: fichier.id, trace, analysisRunId: 1, documentType: 'FACTURE',
      facts: [
        fait({ value: 78000, target: cible('ASSET', v1.id) }),
        fait({ value: 12000, target: cible('ASSET', v2.id) }),
        fait({ canonicalKey: 'serialNumber', value: 'SN-1', valueType: 'string', canonicalUnit: null, target: cible('EQUIPMENT', chaudiere.id) }),
        fait({ value: 5, target: cible('ASSET', null) }),
      ],
    });
    expect(r1.skipped.map((s) => s.reason)).toEqual(['UNATTACHED']);

    const lignes = await sql<{ asset_id: number; field_key: string; target_type: string; target_entity_id: number; lifecycle_status: string }[]>`
      SELECT asset_id, field_key, target_type, target_entity_id, lifecycle_status
        FROM field_evidence WHERE source_id = ${fichier.id} ORDER BY id`;
    expect(lignes).toEqual([
      { asset_id: v1.id, field_key: 'mileage', target_type: 'ASSET', target_entity_id: v1.id, lifecycle_status: 'ACTIVE' },
      { asset_id: v2.id, field_key: 'mileage', target_type: 'ASSET', target_entity_id: v2.id, lifecycle_status: 'ACTIVE' },
      { asset_id: maison.id, field_key: 'serialNumber', target_type: 'EQUIPMENT', target_entity_id: chaudiere.id, lifecycle_status: 'ACTIVE' },
    ]);
    // Le numéro de série de la chaudière n'est pas celui de la maison.
    expect(await getActiveEvidence(compte.id, maison.id, 'serialNumber')).toEqual([]);
    expect(await getActiveEvidence(compte.id, maison.id, 'serialNumber', { target: { type: 'EQUIPMENT', entityId: chaudiere.id } })).toHaveLength(1);

    // Réanalyse : v1 lu 79 000 ; v2 n'apparaît plus.
    const r2 = await persistProjectedFacts({
      input, leadSourceId: fichier.id, trace, analysisRunId: 2, documentType: 'FACTURE',
      facts: [fait({ value: 79000, target: cible('ASSET', v1.id) })],
    });
    expect(r2.superseded).toEqual({ count: 3, linked: 1 });
    const apres = await sql<{ id: number; lifecycle_status: string; status: string; superseded_by_evidence_id: number | null }[]>`
      SELECT id, lifecycle_status, status, superseded_by_evidence_id FROM field_evidence WHERE source_id = ${fichier.id} ORDER BY id`;
    expect(apres).toHaveLength(4); // jamais de DELETE
    const nouvelle = apres[3];
    expect(apres.slice(0, 3).map((l) => l.lifecycle_status)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'SUPERSEDED']);
    // `status` porte la décision T3 : jamais modifié par le cycle de vie.
    expect(apres.map((l) => l.status)).toEqual(['active', 'active', 'active', 'active']);
    expect(apres[0].superseded_by_evidence_id).toBe(nouvelle.id);
    const actives = await getActiveEvidence(compte.id, v1.id, 'mileage');
    expect(actives.map((e) => e.value)).toEqual([79000]);
    expect(await getActiveEvidence(compte.id, v2.id, 'mileage')).toEqual([]);
  });

  it('récurrence persistée dans document_facts et restaurée (T4-06)', async () => {
    const compte = await make.account();
    const fichier = await make.assetFile(compte, { assetId: null });
    const { buildKnowledgeFromSourceAnalysis, factsToExtractedFields } = await import('@/services/ai/knowledge/document-knowledge');
    const { persistDocumentKnowledge, getDocumentKnowledge } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { projectedFactToExtractedField } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const recurrence = { frequency: 'monthly' as const, interval: 12, excerpt: 'tous les 12 mois' };
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis({
      sourceGroup: { sourceIds: [fichier.id], leadSourceId: fichier.id }, document: {},
      assetCandidates: [], roomCandidates: [], equipmentCandidates: [], agendaCandidates: [], warnings: [],
      extractedFields: [projectedFactToExtractedField(fait({
        canonicalKey: 'maintenanceDueDate', value: '2025-06-01', valueType: 'date', canonicalUnit: null,
        semanticEvent: { type: 'maintenance', nature: 'DEADLINE' }, recurrence,
      }))],
      operationTrace: trace,
    }, { accountId: compte.id, fileId: fichier.id, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file' }));
    const k = await getDocumentKnowledge(compte.id, fichier.id);
    const [champ] = factsToExtractedFields(k!.facts);
    expect(champ).toMatchObject({ canonicalKey: 'maintenanceDueDate', recurrence, semanticEvent: { type: 'maintenance', nature: 'DEADLINE' } });
    expect(champ.target).toMatchObject({ targetType: 'ASSET', targetEntityId: null });
  });

  it('supersede concurrent : la plus récente analyse gagne, dans les deux ordres', async () => {
    const compte = await make.account();
    const v1 = await make.asset(compte, { category: 'VEHICULE' });
    const fichier = await make.assetFile(compte, { assetId: v1.id });
    const { persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const input = {
      sourceType: 'file' as const, sourceIds: [fichier.id], accountId: compte.id, userId: compte.ownerUserId,
      mimeTypes: [], displayNames: [],
    };
    const analyse = (run: number, km: number) => persistProjectedFacts({
      input, leadSourceId: fichier.id, trace, analysisRunId: run,
      facts: [fait({ value: km, target: cible('ASSET', v1.id) }), fait({ canonicalKey: 'registrationNumber', value: `AA-00${run}-AA`, valueType: 'string', canonicalUnit: null, target: cible('ASSET', v1.id) })],
    });
    const actives = () => sql<{ analysis_run_id: number; field_key: string }[]>`
      SELECT analysis_run_id, field_key FROM field_evidence
       WHERE source_id = ${fichier.id} AND lifecycle_status = 'ACTIVE' ORDER BY field_key`;

    // En parallèle, dix fois : jamais deux analyses actives ensemble.
    for (let i = 0; i < 10; i += 1) {
      const base = 10 * (i + 1);
      await Promise.all([analyse(base + 1, 1000 + i), analyse(base + 2, 2000 + i)]);
      expect(await actives()).toEqual([
        { analysis_run_id: base + 2, field_key: 'mileage' },
        { analysis_run_id: base + 2, field_key: 'registrationNumber' },
      ]);
    }
    // Analyse PÉRIMÉE terminant après la plus récente : ses preuves cèdent aussitôt.
    await analyse(500, 5000);
    await analyse(499, 4990);
    expect((await actives()).map((l) => l.analysis_run_id)).toEqual([500, 500]);
    const [perimee] = await sql<{ superseded_by_evidence_id: number | null }[]>`
      SELECT superseded_by_evidence_id FROM field_evidence
       WHERE source_id = ${fichier.id} AND analysis_run_id = 499 AND field_key = 'mileage'`;
    expect(perimee.superseded_by_evidence_id).not.toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM field_evidence WHERE source_id = ${fichier.id} AND status <> 'active'`;
    expect(n).toBe(0);

    // Réanalyse dédupliquée (MÊME run) : le fait non reproduit ne reste pas actif.
    await analyse(600, 6000);
    await persistProjectedFacts({ input, leadSourceId: fichier.id, trace, analysisRunId: 600, facts: [fait({ value: 6000, target: cible('ASSET', v1.id) })] });
    expect(await actives()).toEqual([{ analysis_run_id: 600, field_key: 'mileage' }]);
  });

  it('P-T1-04 : rattachement tardif — multi-biens sans réattribution, mono-bien attribué', async () => {
    const compte = await make.account();
    const cible1 = await make.asset(compte, { category: 'VEHICULE' });
    const { buildKnowledgeFromSourceAnalysis } = await import('@/services/ai/knowledge/document-knowledge');
    const { persistDocumentKnowledge, projectDocumentKnowledgeToAsset } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { projectedFactToExtractedField } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const deposer = async (warnings: Array<{ code: 'MULTI_ASSET_DOCUMENT'; message: string }>, multiAsset?: boolean) => {
      const fichier = await make.assetFile(compte, { assetId: null });
      await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis({
        sourceGroup: { sourceIds: [fichier.id], leadSourceId: fichier.id }, document: {},
        assetCandidates: [], roomCandidates: [], equipmentCandidates: [], agendaCandidates: [], warnings,
        extractedFields: [projectedFactToExtractedField(fait({ value: 42000, target: cible('ASSET', null) }))],
        operationTrace: trace,
      }, { accountId: compte.id, fileId: fichier.id, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file', multiAsset }));
      return fichier;
    };
    // Branche maître : indicateur persisté.
    const multi = await deposer([{ code: 'MULTI_ASSET_DOCUMENT', message: 'deux véhicules' }], true);
    // Moteur « étapes » : indicateur inconnu (NULL), repli sur metadata.
    const legacy = await deposer([{ code: 'MULTI_ASSET_DOCUMENT', message: 'deux véhicules' }]);
    const ext = await sql<{ file_id: number; multi_asset: boolean | null }[]>`
      SELECT file_id, multi_asset FROM document_extractions WHERE file_id IN (${multi.id}, ${legacy.id}) ORDER BY file_id`;
    expect(ext.map((e) => e.multi_asset)).toEqual([true, null]);
    for (const f of [multi, legacy]) {
      expect(await projectDocumentKnowledgeToAsset({ accountId: compte.id, userId: compte.ownerUserId, fileId: f.id, assetId: cible1.id })).toBe(0);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM field_evidence WHERE source_id = ${f.id}`;
      expect(n).toBe(0);
    }

    const mono = await deposer([]);
    expect(await projectDocumentKnowledgeToAsset({ accountId: compte.id, userId: compte.ownerUserId, fileId: mono.id, assetId: cible1.id })).toBe(1);
    const lignes = await sql<{ asset_id: number; target_type: string; target_entity_id: number }[]>`
      SELECT asset_id, target_type, target_entity_id FROM field_evidence WHERE source_id = ${mono.id}`;
    expect(lignes).toEqual([{ asset_id: cible1.id, target_type: 'ASSET', target_entity_id: cible1.id }]);
  });
});
