/**
 * Lot 14 (volet C) — candidats T4, rattachement tardif, accueil — CDC 15
 * T4-01, T4-03, T4-05 (DOD-05), T4-06, D-14 ; base réelle.
 *   · DOD-05 : un document analysé SANS bien, persisté (document_facts),
 *     relu puis rattaché → mêmes candidats que s'il avait été rattaché au
 *     dépôt (récurrence comprise) ;
 *   · rattachement tardif : les candidats partent dans la file T4 ;
 *   · accueil : « Prochaines échéances » sans HISTORICAL (D-14), échéances
 *     automatiques lues (AI_T4_EFFECTS retiré au lot 16b-2).
 */
import { it, expect, afterEach } from 'vitest';
import { scenario } from '../scenario';
import { loadT1Fixture } from '@/services/ai/source-analysis/__fixtures__/t1/load';
import type { SourceAnalysisResult } from '@/services/ai/source-analysis/types';

const ENV = ['AI_T4_EFFECTS', 'AI_AGENDA_ENGINE'];
const avant: Record<string, string | undefined> = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

scenario('T4-L14', 'Candidats T4, rattachement tardif, accueil', ({ sql, make }) => {
  afterEach(() => { for (const k of ENV) { if (avant[k] === undefined) delete process.env[k]; else process.env[k] = avant[k]; } });

  /** Ticket draisienne projeté par le master, avec ou sans bien connu. */
  async function analyse(assetId: number | null) {
    const { T1AnalyzeDocumentOutput } = await import('@/services/ai/source-analysis/master/t1-contract');
    const { checkFactEvidence } = await import('@/services/ai/source-analysis/master/fact-evidence');
    const { projectDocumentFacts } = await import('@/services/ai/source-analysis/projection/document-projection');
    const { toSourceAnalysisResult } = await import('@/services/ai/source-analysis/master/to-source-analysis-result');
    const { emptyTrace } = await import('@/services/ai/source-analysis/trace');
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    const out = f.recording.output as { entities: { assets: unknown[] }; facts: Array<{ target: { entityId: number | null } }> };
    out.entities.assets = [];
    for (const x of out.facts) x.target.entityId = assetId;
    // Récurrence énoncée par la source (T4-06), sur un fait d'échéance.
    (f.recording.output.facts as unknown[]).push({
      canonicalKey: 'maintenanceDueDate', rawValue: '24/04/2027', normalizedValue: '2027-04-24', valueType: 'date',
      target: { type: 'ASSET', entityId: assetId }, provenance: 'TEXT_EXTRACTION', confidence: 'certain',
      evidence: { excerpt: 'Révision annuelle — prochaine le 24/04/2027' },
      recurrence: { frequency: 'yearly', interval: 1, excerpt: 'Révision annuelle' },
    });
    const parsed = T1AnalyzeDocumentOutput.parse(f.recording.output);
    const facts = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as unknown as { fact: never }).fact);
    const verified = new Set(assetId ? [assetId] : []);
    const projection = projectDocumentFacts({ ...parsed, facts }, {
      knownAssetId: assetId, documentAssetId: assetId, assetFamilies: new Map(assetId ? [[assetId, 'OBJECT' as const]] : []),
      verifiedIds: { ASSET: verified, EQUIPMENT: new Set(), ROOM: new Set(), SUPPLIER: new Set() },
    });
    const result: SourceAnalysisResult = toSourceAnalysisResult({
      input: { sourceType: 'file', sourceIds: [0], accountId: 0, userId: 0, mimeTypes: [], displayNames: [] },
      groupIndices: [0], analysis: parsed, tables: [], facts: projection.facts, projectionWarnings: projection.warnings,
      multiAsset: false, documentAssetId: assetId, assetCandidates: [], roomCandidates: [], equipmentCandidates: [],
      warnings: [], trace: emptyTrace(),
    });
    return result;
  }

  const contexte = (r: SourceAnalysisResult, fileId: number, assetId: number | null) => ({
    sourceFileId: fileId, documentAssetId: assetId, multiAsset: false,
    documentTitle: r.document.title?.value ?? null, documentDate: r.document.date?.value ?? null,
    documentType: r.document.type?.value ?? null, documentTypeCode: r.document.rubric?.documentTypeCode ?? null,
  });

  it('DOD-05 : analysé sans bien, persisté, rattaché plus tard → mêmes candidats (récurrence comprise)', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'OBJECT', name: 'Draisienne' });
    const fichier = await make.assetFile(compte);
    const { buildAgendaCandidatesT4 } = await import('@/services/ai/source-analysis/steps/build-agenda-candidates.step');
    const { buildKnowledgeFromSourceAnalysis } = await import('@/services/ai/knowledge/document-knowledge');
    const { persistDocumentKnowledge, getDocumentKnowledge, lateLinkAgendaCandidates, lateLinkAllowsReassignment } =
      await import('@/services/ai/knowledge/document-knowledge.service');

    // Référence : rattaché dès le dépôt.
    const direct = await analyse(bien.id);
    const attendus = buildAgendaCandidatesT4(direct.extractedFields, contexte(direct, fichier.id, bien.id));
    expect(attendus.map((c) => `${c.businessType}:${c.nature}`).sort()).toEqual(['maintenance:DEADLINE', 'purchase:HISTORICAL']);

    // Déposé sans bien : connaissance persistée, puis relue et rattachée.
    const seul = await analyse(null);
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis(seul, {
      accountId: compte.id, fileId: fichier.id, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file', multiAsset: false,
    }));
    const k = await getDocumentKnowledge(compte.id, fichier.id);
    expect(k).not.toBeNull();
    const apres = lateLinkAgendaCandidates({
      knowledge: k!, fileId: fichier.id, assetId: bien.id,
      allowReassign: lateLinkAllowsReassignment(k!.extraction, k!.facts, bien.id),
    });
    expect(apres).toEqual(attendus);
    expect(apres.find((c) => c.nature === 'DEADLINE')?.recurrence).toMatchObject({ mode: 'EXPLICIT_SOURCE', frequency: 'yearly' });
  });

  it('rattachement tardif : les candidats partent dans la file T4', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'OBJECT', name: 'Draisienne' });
    const fichier = await make.assetFile(compte);
    const { buildKnowledgeFromSourceAnalysis } = await import('@/services/ai/knowledge/document-knowledge');
    const { persistDocumentKnowledge, projectDocumentKnowledgeToAsset } = await import('@/services/ai/knowledge/document-knowledge.service');
    await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis(await analyse(null), {
      accountId: compte.id, fileId: fichier.id, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file', multiAsset: false,
    }));
    const jobs = async () => sql<{ payload: { candidates: Array<{ nature?: string; businessType?: string }> } }[]>`
      SELECT payload FROM ai_job_queue WHERE treatment = 'T4' AND account_id = ${compte.id}`;

    // Lot 16b-2 : rattachement tardif toujours suivi de la file T4 (plus de legacy).
    await projectDocumentKnowledgeToAsset({ accountId: compte.id, userId: compte.ownerUserId, fileId: fichier.id, assetId: bien.id });
    const j = await jobs();
    expect(j).toHaveLength(1);
    expect(j[0].payload.candidates.map((c) => `${c.businessType}:${c.nature}`).sort()).toEqual(['maintenance:DEADLINE', 'purchase:HISTORICAL']);
  });

  it('accueil : prochaines échéances sans HISTORICAL ; variable retirée sans effet', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { name: 'Clio' });
    const dans = (j: number) => new Date(Date.now() + j * 86_400_000).toISOString().slice(0, 10);
    const element = async (title: string, date: string, nature: string | null, automatic: boolean) => {
      const [i] = await sql<{ id: number }[]>`
        INSERT INTO agenda_items (account_id, title, start_date, is_automatic, home_category, event_nature)
        VALUES (${compte.id}, ${title}, ${date}, ${automatic}, 'action', ${nature}) RETURNING id`;
      await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${i.id}, ${bien.id})`;
    };
    await element('Achat — Clio', dans(3), 'HISTORICAL', true);
    await element('Contrôle technique — Clio', dans(10), 'DEADLINE', true);
    await element('Rendez-vous garage', dans(5), null, false);

    const { buildHomeSummary } = await import('@/services/home/HomeSummaryService');
    const t4 = (await buildHomeSummary(compte.id)).blocks.upcoming.items.map((i) => i.title);
    expect(t4).toEqual(['Rendez-vous garage', 'Contrôle technique — Clio']);

    process.env.AI_T4_EFFECTS = 'legacy';
    const reste = (await buildHomeSummary(compte.id)).blocks.upcoming.items.map((i) => i.title);
    expect(reste).toEqual(t4);
  });
});
