/**
 * Lot 20, décision PO D-M — une date TRANCHÉE par T4 corrige aussi la fiche,
 * sur PostgreSQL réel :
 *
 *  · T1 lit « 03/04/2027 » et retient la lecture mm/jj (2027-03-04) ; T3
 *    l'écrit sur la fiche (origine RECONCILIATION) ;
 *  · T4 (master, seul moteur depuis le lot 16b-2) tranche l'ambiguïté : 2027-04-03 ;
 *  · la preuve d'origine passe SUPERSEDED, une preuve RÉVISÉE (règle
 *    T4_TEMPORAL_RESOLUTION) la remplace ; T3 met la fiche à jour par la
 *    primitive canonique (motif T4_DATE_REVISED), miroir compris ;
 *  · une valeur saisie par l'utilisateur n'est jamais écrasée (conflit) ;
 *  · CANONICAL_WRITE_MODE=legacy : aucune preuve révisée.
 * Le choix du modèle (branche TEMPORAL_AMBIGUITY) est simulé : jamais de réseau.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// T4 en architecture master (configuration) ; choix du modèle simulé : lecture française.
vi.mock('@/services/ai/config/config-resolver', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/config/config-resolver')>()),
  getPromptArchitecture: async () => 'master',
}));
vi.mock('@/services/ai/agenda/master/temporal-ambiguity', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/agenda/master/temporal-ambiguity')>()),
  resolveTemporalAmbiguityMaster: async (_c: unknown, candidats: Array<{ candidateId: number; date: string; interpretation: string }>) =>
    ({ chosen: candidats.find((x) => x.date === '2027-04-03') ?? null, warning: null }),
}));

const trace = {
  traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'],
};
const EXTRAIT = 'Prochain contrôle technique avant le 03/04/2027';
const fait = (assetId: number): ProjectedFact => ({
  canonicalKey: 'nextInspection', rawKey: 'Prochain contrôle', label: null, subject: null, attribute: null,
  rawValue: '03/04/2027', value: '2027-03-04', valueType: 'date', canonicalUnit: null,
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: EXTRAIT, page: 1 },
  semanticEvent: { type: 'inspection', nature: 'DEADLINE' }, recurrence: null, periodStart: null, periodEnd: null,
  origin: 'MODEL_CANONICAL', ruleCode: null,
});

scenario('D-M-L20', 'Date tranchée par T4 : preuve révisée, fiche corrigée par T3', ({ sql, make }) => {
  const env = { ...process.env };
  let reconcileAsset: typeof import('@/services/ai/reconciliation/reconciliation-engine').reconcileAsset;
  let persistProjectedFacts: typeof import('@/services/ai/source-analysis/steps/persist-evidence.step').persistProjectedFacts;
  let processAgendaCandidates: typeof import('@/services/ai/agenda/agenda-intelligence.service').processAgendaCandidates;
  let facade: typeof import('@/services/asset-details-write.service');

  beforeAll(async () => {
    ({ reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine'));
    ({ persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step'));
    ({ processAgendaCandidates } = await import('@/services/ai/agenda/agenda-intelligence.service'));
    facade = await import('@/services/asset-details-write.service');
  });
  afterEach(() => {
    for (const k of ['CANONICAL_WRITE_MODE', 'T3_NEGATIVE_RECONCILIATION']) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
  });

  const kcDe = async (assetId: number) => {
    const [r] = await sql<{ kc: string | null }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${assetId}`;
    return JSON.parse(r.kc ?? '{}') as Record<string, unknown>;
  };
  const preuves = async (fileId: number) => sql<{ id: number; value: unknown; lifecycle: string | null; by: number | null; rule: string | null }[]>`
    SELECT id, value_json AS value, lifecycle_status AS lifecycle, superseded_by_evidence_id AS by, projection_rule AS rule
      FROM field_evidence WHERE source_id = ${fileId} AND field_key = 'nextInspection' ORDER BY id`;

  /** T1 + T3 : la lecture mm/jj est écrite sur la fiche ; puis T4 tranche. */
  const chaine = async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: bien.id, name: 'pv-controle.pdf' });
    const ecrites = await persistProjectedFacts({
      input: { sourceType: 'file', sourceIds: [doc.id], accountId: compte.id, userId: compte.ownerUserId, mimeTypes: [], displayNames: [] },
      leadSourceId: doc.id, trace, analysisRunId: 1, documentType: 'CONTROLE_TECHNIQUE', facts: [fait(bien.id)],
    });
    const evidenceId = ecrites.evidenceIds.get(`nextInspection@ASSET:${bien.id}`)!;
    expect(evidenceId).toBeGreaterThan(0);
    await reconcileAsset({ accountId: compte.id, userId: compte.ownerUserId, assetId: bien.id, triggeredBy: 'document_analyzed' });
    const t4 = () => processAgendaCandidates({
      accountId: compte.id, userId: compte.ownerUserId, assetId: bien.id, sourceFileId: doc.id, existing: [], today: '2026-10-02',
      candidates: [{
        title: 'Contrôle technique', date: '2027-03-04', confidence: 'certain', excerpt: EXTRAIT, originFieldKey: 'nextInspection',
        documentType: 'CONTROLE_TECHNIQUE', nature: 'DEADLINE', businessType: 'inspection',
        sources: [{ fileId: doc.id, role: 'SOURCE', evidenceId }],
      }] as never,
    });
    const t3 = () => reconcileAsset({ accountId: compte.id, userId: compte.ownerUserId, assetId: bien.id, triggeredBy: 'document_linked' });
    return { compte, bien, doc, evidenceId, t4, t3 };
  };

  it('enabled : preuve révisée, originale SUPERSEDED, fiche corrigée par T3 (RECONCILIATION, T4_DATE_REVISED)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const m = await chaine();
    expect(await kcDe(m.bien.id)).toMatchObject({ nextInspection: '2027-03-04', nextInspection__origin: 'RECONCILIATION' });

    const [decision] = await m.t4();
    expect(decision.date).toBe('2027-04-03');
    const lignes = await preuves(m.doc.id);
    const revisee = lignes.find((l) => l.rule === 'T4_TEMPORAL_RESOLUTION')!;
    expect(revisee).toMatchObject({ value: '2027-04-03', lifecycle: 'ACTIVE' });
    expect(lignes.find((l) => l.id === m.evidenceId)).toMatchObject({ lifecycle: 'SUPERSEDED', by: revisee.id });

    const run = await m.t3();
    expect(run.decisions.find((d) => d.fieldKey === 'nextInspection')).toMatchObject({ action: 'update', reasonCode: 'T4_DATE_REVISED' });
    expect(await kcDe(m.bien.id)).toMatchObject({ nextInspection: '2027-04-03', nextInspection__origin: 'RECONCILIATION' });
    const [journal] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM canonical_field_writes
       WHERE asset_id = ${m.bien.id} AND canonical_key = 'nextInspection' AND outcome = 'written' AND origin = 'RECONCILIATION'`;
    expect(journal.n).toBe(2);
  });

  it('valeur USER : jamais écrasée par la preuve révisée (conflit)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const m = await chaine();
    await facade.updateAssetDetails({
      assetId: m.bien.id, accountId: m.compte.id, section: 'vehicle_insurance', fields: { nextInspection: '2027-06-01' }, actorUserId: m.compte.ownerUserId,
    });
    expect(await kcDe(m.bien.id)).toMatchObject({ nextInspection: '2027-06-01', nextInspection__origin: 'USER' });
    await m.t4();
    expect((await preuves(m.doc.id)).some((l) => l.rule === 'T4_TEMPORAL_RESOLUTION')).toBe(true);
    const run = await m.t3();
    expect(run.decisions.find((d) => d.fieldKey === 'nextInspection')?.reasonCode).toBe('MANUAL_VALUE_CONTRADICTED');
    expect(await kcDe(m.bien.id)).toMatchObject({ nextInspection: '2027-06-01', nextInspection__origin: 'USER' });
  });

  it('CANONICAL_WRITE_MODE=legacy : la date de l’agenda est tranchée, aucune preuve révisée', async () => {
    process.env.CANONICAL_WRITE_MODE = 'legacy';
    const m = await chaine();
    const [decision] = await m.t4();
    expect(decision.date).toBe('2027-04-03');
    const lignes = await preuves(m.doc.id);
    expect(lignes.some((l) => l.rule === 'T4_TEMPORAL_RESOLUTION')).toBe(false);
    expect(lignes.find((l) => l.id === m.evidenceId)?.lifecycle ?? 'ACTIVE').toBe('ACTIVE');
  });
});
