/**
 * Lot 13 — écriture T3 et cycle de vie des preuves, sur PostgreSQL réel
 * (CDC 15 T3-01, T3-02, T3-03, T3-04).
 *
 *  · T3-01 : même valeur par la fiche et par T3 → même état (miroirs compris), hors origine ;
 *  · T3-02 : l'IA remplit A, l'utilisateur corrige en B, un nouveau document propose A → B reste ;
 *  · T3-03 : réanalyse d'une date puis déplacement A → B : une seule preuve active, rien sur A ;
 *  · T3-04 : suppression du seul document preuve → le champ automatique disparaît, le champ USER reste.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const trace = {
  traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'],
};
const fait = (assetId: number, value: string, over: Partial<ProjectedFact> = {}): ProjectedFact => ({
  canonicalKey: 'acquisitionDate', rawKey: 'Date d’achat', label: null, subject: null, attribute: null,
  rawValue: value, value, valueType: 'date', canonicalUnit: null,
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: `Date d’achat : ${value}`, page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
  ...over,
});

scenario('T3-L13', 'Écriture T3 et cycle de vie des preuves', ({ sql, make }) => {
  const env = { ...process.env };
  let reconcileAsset: typeof import('@/services/ai/reconciliation/reconciliation-engine').reconcileAsset;
  let persistProjectedFacts: typeof import('@/services/ai/source-analysis/steps/persist-evidence.step').persistProjectedFacts;
  let lifecycle: typeof import('@/services/ai/evidence/document-evidence-lifecycle');
  let facade: typeof import('@/services/asset-details-write.service');

  beforeAll(async () => {
    ({ reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine'));
    ({ persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step'));
    lifecycle = await import('@/services/ai/evidence/document-evidence-lifecycle');
    facade = await import('@/services/asset-details-write.service');
  });
  afterEach(() => {
    for (const k of ['CANONICAL_WRITE_MODE', 'T3_NEGATIVE_RECONCILIATION']) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
  });

  const kcDe = async (assetId: number) => {
    const [r] = await sql<{ kc: string | null; purchase_date: string | null }[]>`
      SELECT key_characteristics AS kc, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date FROM assets WHERE id = ${assetId}`;
    return { kc: JSON.parse(r.kc ?? '{}') as Record<string, unknown>, purchaseDate: r.purchase_date };
  };
  const input = (accountId: number, userId: number, fileId: number) => ({
    sourceType: 'file' as const, sourceIds: [fileId], accountId, userId, mimeTypes: [], displayNames: [],
  });
  const t3 = (accountId: number, userId: number, assetId: number) =>
    reconcileAsset({ accountId, userId, assetId, triggeredBy: 'document_linked' });

  for (const mode of ['legacy', 'enabled'] as const) {
    it(`T3-02 (CANONICAL_WRITE_MODE=${mode}) : l’IA remplit A, l’utilisateur corrige B, un nouveau document propose A → B reste`, async () => {
      process.env.CANONICAL_WRITE_MODE = mode;
      const compte = await make.account();
      const bien = await make.asset(compte, { category: 'VEHICULE' });
      const doc1 = await make.assetFile(compte, { assetId: bien.id });
      await persistProjectedFacts({ input: input(compte.id, compte.ownerUserId, doc1.id), leadSourceId: doc1.id, trace, analysisRunId: 1, documentType: 'FACTURE', facts: [fait(bien.id, '2024-01-02')] });
      await t3(compte.id, compte.ownerUserId, bien.id);
      expect((await kcDe(bien.id)).kc.acquisitionDate).toBe('2024-01-02');

      await facade.updateAssetDetails({ assetId: bien.id, accountId: compte.id, section: 'common', fields: { acquisitionDate: '2023-06-15' }, actorUserId: compte.ownerUserId });
      const apresUser = (await kcDe(bien.id)).kc;
      expect(apresUser.acquisitionDate).toBe('2023-06-15');
      expect(apresUser.acquisitionDate__origin).toBe('USER');
      expect(typeof apresUser.acquisitionDate__updatedAt).toBe('string');

      const doc2 = await make.assetFile(compte, { assetId: bien.id });
      await persistProjectedFacts({ input: input(compte.id, compte.ownerUserId, doc2.id), leadSourceId: doc2.id, trace, analysisRunId: 2, documentType: 'ACTE_NOTARIE', facts: [fait(bien.id, '2024-01-02')] });
      const run = await t3(compte.id, compte.ownerUserId, bien.id);
      expect((await kcDe(bien.id)).kc.acquisitionDate).toBe('2023-06-15');
      expect(run.decisions.find((d) => d.fieldKey === 'acquisitionDate')?.reasonCode).toBe('MANUAL_VALUE_CONTRADICTED');
    });
  }

  it('T3-01 : même valeur par la fiche et par T3 → même état (miroir compris), hors origine', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const compte = await make.account();
    const parUi = await make.asset(compte, { category: 'VEHICULE' });
    const parT3 = await make.asset(compte, { category: 'VEHICULE' });
    await facade.updateAssetDetails({ assetId: parUi.id, accountId: compte.id, section: 'common', fields: { acquisitionDate: '2024-01-02' }, actorUserId: compte.ownerUserId });
    const doc = await make.assetFile(compte, { assetId: parT3.id });
    await persistProjectedFacts({ input: input(compte.id, compte.ownerUserId, doc.id), leadSourceId: doc.id, trace, analysisRunId: 3, documentType: 'FACTURE', facts: [fait(parT3.id, '2024-01-02')] });
    await t3(compte.id, compte.ownerUserId, parT3.id);
    const a = await kcDe(parUi.id);
    const b = await kcDe(parT3.id);
    expect(a.kc.acquisitionDate).toBe('2024-01-02');
    expect(b.kc.acquisitionDate).toBe('2024-01-02');
    expect([a.purchaseDate, b.purchaseDate]).toEqual(['2024-01-02', '2024-01-02']);
    expect([a.kc.acquisitionDate__origin, b.kc.acquisitionDate__origin]).toEqual(['USER', 'RECONCILIATION']);
  });

  it('T3-03 : réanalyse d’une date puis déplacement A → B — une seule preuve active, aucune influence résiduelle sur A', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    const compte = await make.account();
    const A = await make.asset(compte, { category: 'VEHICULE' });
    const B = await make.asset(compte, { category: 'VEHICULE' });
    const doc = await make.assetFile(compte, { assetId: A.id });
    const ent = input(compte.id, compte.ownerUserId, doc.id);

    await persistProjectedFacts({ input: ent, leadSourceId: doc.id, trace, analysisRunId: 10, documentType: 'FACTURE', facts: [fait(A.id, '2024-01-02')] });
    await t3(compte.id, compte.ownerUserId, A.id);
    // Réanalyse : la date lue change.
    await persistProjectedFacts({ input: ent, leadSourceId: doc.id, trace, analysisRunId: 11, documentType: 'FACTURE', facts: [fait(A.id, '2024-03-04')] });
    await t3(compte.id, compte.ownerUserId, A.id);
    expect((await kcDe(A.id)).kc.acquisitionDate).toBe('2024-03-04');

    // Déplacement A → B : retrait sur A, réconciliation de A, reprojection sur B.
    await sql`UPDATE asset_files SET asset_id = ${B.id} WHERE id = ${doc.id}`;
    const out = await lifecycle.onDocumentAssetChanged({ accountId: compte.id, userId: compte.ownerUserId, fileId: doc.id, fromAssetId: A.id, toAssetId: B.id });
    expect(out).toMatchObject({ mode: 'enabled', withdrawn: 1 });
    await t3(compte.id, compte.ownerUserId, A.id); // travail mis en file, exécuté ici
    await persistProjectedFacts({ input: ent, leadSourceId: doc.id, trace, analysisRunId: 12, documentType: 'FACTURE', facts: [fait(B.id, '2024-03-04')] });
    await t3(compte.id, compte.ownerUserId, B.id);

    const actives = await sql<{ asset_id: number; value: string }[]>`
      SELECT asset_id, value_json #>> '{}' AS value FROM field_evidence
       WHERE source_id = ${doc.id} AND lifecycle_status = 'ACTIVE'`;
    expect(actives).toEqual([{ asset_id: B.id, value: '2024-03-04' }]);
    const a = await kcDe(A.id);
    expect(a.kc.acquisitionDate).toBeUndefined();
    expect(a.purchaseDate).toBeNull();
    expect((await kcDe(B.id)).kc.acquisitionDate).toBe('2024-03-04');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM field_evidence WHERE source_id = ${doc.id} AND status <> 'active'`;
    expect(n).toBe(0); // le cycle de vie ne touche jamais la décision T3
  });

  it('T3-04 : suppression du seul document preuve — le champ automatique disparaît, le champ USER reste', async () => {
    process.env.CANONICAL_WRITE_MODE = 'legacy';
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await facade.updateAssetDetails({ assetId: bien.id, accountId: compte.id, section: 'vehicle_identification', fields: { registrationNumber: 'AB-123-CD' }, actorUserId: compte.ownerUserId });
    await persistProjectedFacts({
      input: input(compte.id, compte.ownerUserId, doc.id), leadSourceId: doc.id, trace, analysisRunId: 20, documentType: 'FACTURE',
      facts: [fait(bien.id, '2024-01-02'), fait(bien.id, 'AB-123-CD', { canonicalKey: 'registrationNumber', valueType: 'string' })],
    });
    await t3(compte.id, compte.ownerUserId, bien.id);
    const avant = await kcDe(bien.id);
    expect(avant.kc.acquisitionDate).toBe('2024-01-02');
    expect(avant.purchaseDate).toBe(null); // legacy : la colonne miroir n'était pas recopiée par T3

    // Mode shadow : rien n'est retiré, seulement observé.
    process.env.T3_NEGATIVE_RECONCILIATION = 'shadow';
    const obs = await lifecycle.onDocumentsDeleted({ accountId: compte.id, userId: compte.ownerUserId, fileIds: [doc.id] });
    expect(obs).toMatchObject({ mode: 'shadow', withdrawn: 2, dryRun: true });
    const [{ n: actives0 }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM field_evidence WHERE source_id = ${doc.id} AND lifecycle_status = 'ACTIVE'`;
    expect(actives0).toBe(2);

    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${doc.id}`;
    await lifecycle.onDocumentsDeleted({ accountId: compte.id, userId: compte.ownerUserId, fileIds: [doc.id] });
    const run = await t3(compte.id, compte.ownerUserId, bien.id);
    expect(run.decisions.map((d) => [d.fieldKey, d.reasonCode])).toContainEqual(['acquisitionDate', 'NO_REMAINING_EVIDENCE']);

    const apres = await kcDe(bien.id);
    expect(apres.kc.acquisitionDate).toBeUndefined();
    expect(apres.kc.registrationNumber).toBe('AB-123-CD');
    expect(apres.kc.registrationNumber__origin).toBe('USER');
    const [hist] = await sql<{ old_value: string; new_value: string; reason_code: string }[]>`
      SELECT old_value, new_value, reason_code FROM ai_field_updates WHERE asset_id = ${bien.id} AND field_key = 'acquisitionDate' ORDER BY id DESC LIMIT 1`;
    expect(hist).toMatchObject({ old_value: '2024-01-02', new_value: '', reason_code: 'NO_REMAINING_EVIDENCE' });
    const [journal] = await sql<{ outcome: string; origin: string }[]>`
      SELECT outcome, origin FROM canonical_field_writes WHERE asset_id = ${bien.id} AND canonical_key = 'acquisitionDate' AND dry_run = false ORDER BY id DESC LIMIT 1`;
    expect(journal).toMatchObject({ outcome: 'written', origin: 'RECONCILIATION' });
  });

  it('T3-03 mode « étapes » : réanalyse remplacée sous verrou ; déplacement : liens N-N AI/USER vers A retirés', async () => {
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    const compte = await make.account();
    const A = await make.asset(compte, { category: 'VEHICULE' });
    const B = await make.asset(compte, { category: 'VEHICULE' });
    const doc = await make.assetFile(compte, { assetId: A.id });
    const { persistEvidence } = await import('@/services/ai/source-analysis/steps/persist-evidence.step');
    const champ = (v: string) => [{ fieldKey: 'acquisitionDate', value: v, confidence: 'certain' as const, excerpt: `Date : ${v}` }];
    const base = { input: input(compte.id, compte.ownerUserId, doc.id), leadSourceId: doc.id, assetId: A.id, trace, documentType: 'FACTURE' };
    await persistEvidence({ ...base, fields: champ('2024-01-02'), supersede: { mode: 'enabled' } });
    await persistEvidence({ ...base, fields: champ('2024-03-04'), supersede: { mode: 'enabled' } });
    const actives = await sql<{ value: string }[]>`
      SELECT value_json #>> '{}' AS value FROM field_evidence WHERE source_id = ${doc.id} AND lifecycle_status = 'ACTIVE'`;
    expect(actives).toEqual([{ value: '2024-03-04' }]);

    const { linkDocumentToAsset, listDocumentAssets } = await import('@/services/documents/document-asset-links');
    // Le lien au bien A lui-même est LEGACY_COLUMN (déclencheur) : lien AI sur une pièce de A.
    const [piece] = await sql<{ id: number }[]>`
      INSERT INTO rooms (asset_id, account_id, name, room_type) VALUES (${A.id}, ${compte.id}, 'Garage', 'GARAGE') RETURNING id`;
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { roomId: piece.id }, role: 'SECONDARY', origin: 'AI' });
    await sql`UPDATE asset_files SET asset_id = ${B.id} WHERE id = ${doc.id}`;
    const r = await lifecycle.onDocumentAssetChanged({ accountId: compte.id, userId: compte.ownerUserId, fileId: doc.id, fromAssetId: A.id, toAssetId: B.id });
    expect(r.unlinked).toBe(1);
    const liens = await listDocumentAssets(compte.id, doc.id);
    expect(liens.some((l) => l.assetId === A.id)).toBe(false);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM field_evidence WHERE source_id = ${doc.id} AND lifecycle_status = 'ACTIVE'`;
    expect(n).toBe(0);
  });
});
