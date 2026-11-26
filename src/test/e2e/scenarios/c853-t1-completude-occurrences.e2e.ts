/**
 * Carte Trello #853 (P1-01 de #835) — SUPPRIMER LES FAUX COVERED : complétude T1 par OCCURRENCE — PostgreSQL RÉEL.
 *
 *   C853-E01  AC02 / AC11 / AC12 : bloc « Plaquettes 120 € ; Vidange 120 € ; Main-d'œuvre 80 € » COVERED/fact,
 *             faits persistés 120 (plaquettes) + 80 → réconciliation enregistrée : UNE occurrence non résolue,
 *             provenance PAR OCCURRENCE relue en base, document plus annoncé complet ; rejeu : inchangé ;
 *             troisième fait persisté → COVERED, COMPLETE ; fait INACTIF jamais une preuve ;
 *   C853-E02  AC09 / AC10 / AC11 : décision STRUCTURED persistée sur l'une de deux occurrences identiques → l'autre
 *             reste non couverte ; décision INVALID ou d'un autre compte : aucun effet ;
 *   C853-E03  AC06 : tableau persisté — franchise sans rôle → ligne ET tableau NON RÉSOLUS ; cellules avec rôle →
 *             COVERED sans fait par cellule ;
 *   C853-E04  AC12 / AC14 : rattrapage #837 version 4 — faux COVERED historique d'un document COMPLETE requalifié
 *             sans IA ni purge, vrai COVERED préservé, deux campagnes idempotentes, isolation de deux comptes ;
 *   C853-E05  AC15 : BO — totaux et détail par occurrence, sans valeur du document ;
 *   C853-E06  AC12 : deux réconciliations CONCURRENTES — un seul état écrit, aucune duplication.
 *
 * Aucun appel à un fournisseur d'IA (vérifié : `replay.calls` vide).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import type { AccountRow } from '../factories';
import type { CoveredSourceUnit, SourceLayer } from '@/services/ai/source-analysis/source-units/types';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const VERIFIE = { status: 'VERIFIED' as const, reason: null, pagesExpected: 1, verified: [1], missing: [], unverified: [], scanned: [] };
const PRESTATIONS = 'Plaquettes 120,00 EUR ; Vidange 120,00 EUR ; Main-d oeuvre 80,00 EUR';
const bloc = (n: number, text: string, over: Partial<CoveredSourceUnit> = {}): CoveredSourceUnit => ({
  sourceUnitId: `page:1:block:${n}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null, text, payload: {}, location: { page: 1, segment: 0 },
  origin: 'PASS_1', salient: true, status: 'COVERED', reason: 'fact', factCount: 1, repairAttempts: 0, repairState: null, ...over,
});

scenario('C853', 'T1 — complétude par valeur et occurrence : faux COVERED supprimés (#853)', ({ sql, make, replay }) => {
  useTargetState({}, { masters: ['T1'] });

  const document = async (compte: AccountRow) => {
    const f = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    return { fileId: f.id, extractionId: x.id };
  };
  const ecrire = async (compte: AccountRow, d: { fileId: number; extractionId: number }, units: CoveredSourceUnit[]) => {
    const { buildCompletenessReport } = await import('@/services/ai/source-analysis/source-units/coverage');
    const { withResidualPolicies } = await import('@/services/ai/source-analysis/source-units/coverage-reconciliation');
    const { writeSourceLayer } = await import('@/services/ai/source-analysis/source-units/repository');
    const { SOURCE_LAYER_VERSION } = await import('@/services/ai/source-analysis/source-units/types');
    const u = withResidualPolicies(units);
    const layer: SourceLayer = {
      layerVersion: SOURCE_LAYER_VERSION, units: u, unresolvedFacts: [], retryable: false,
      report: buildCompletenessReport(u, {
        factsCount: 2, unresolvedFacts: [], truncatedSectionsCount: 0, batchedSectionsCount: 0, repairPassCount: 0, chunkCount: 0,
        warningCodes: [], retryAllowed: false, verification: VERIFIE,
      }),
    };
    await sql.begin(async (tx) => { await writeSourceLayer(tx as never, { accountId: compte.id, fileId: d.fileId, extractionId: d.extractionId, layer }); });
  };
  const fait = async (compte: AccountRow, d: { fileId: number; extractionId: number }, label: string, valeur: string, unitIds: string[], excerpt = PRESTATIONS, status = 'active') => {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, source_unit_ids, status)
      VALUES (${compte.id}, ${d.fileId}, ${d.extractionId}, ${label}, ${label}, ${valeur}, 'certain', ${excerpt}, ${unitIds}::text[], ${status}) RETURNING id::int AS id`;
    return r.id;
  };
  const unite = async (fileId: number, id: string) => (await sql<Json[]>`
    SELECT coverage_status AS status, coverage_reason AS reason, coverage_provenance AS prov, residual_policy AS policy
      FROM document_source_units WHERE file_id = ${fileId} AND source_unit_id = ${id}`)[0];
  const couverture = async (fileId: number) => (await sql<Json[]>`
    SELECT quality_state AS quality, covered_units, unresolved_units, uncertain_units, verification, updated_at
      FROM document_extraction_coverage WHERE file_id = ${fileId}`)[0];
  const reconcilier = async (compte: AccountRow, fileId: number, apply = true) => {
    const { reconcileStoredDocumentCoverage } = await import('@/services/ai/source-analysis/source-units/stored-reconciliation');
    return reconcileStoredDocumentCoverage({ accountId: compte.id, fileId, apply, origin: 'e2e/c853' });
  };

  it('C853-E01 — AC02/AC11 : deux prestations à 120 € et un seul fait 120 € → une occurrence NON RÉSOLUE, relue en base ; rejeu inchangé ; preuve complète → COVERED', async () => {
    const c = await make.account();
    const d = await document(c);
    await ecrire(c, d, [bloc(1, PRESTATIONS)]);
    expect((await couverture(d.fileId)).quality).toBe('COMPLETE');
    await fait(c, d, 'plaquettes', '120.00', ['page:1:block:1']);
    await fait(c, d, 'main_oeuvre', '80.00', ['page:1:block:1']);
    // Fait INACTIF portant la vidange : jamais une preuve (référence inactive).
    await fait(c, d, 'vidange', '120.00', ['page:1:block:1'], PRESTATIONS, 'superseded');

    const r = await reconcilier(c, d.fileId);
    expect(r.outcome).toBe('APPLIED');
    expect(r.requalified).toEqual([expect.objectContaining({ unitId: 'page:1:block:1', from: { status: 'COVERED', reason: 'fact' },
      to: { status: 'UNRESOLVED', reason: 'values_partially_structured' }, rule: 'covered_unit_values_partially_structured' })]);
    // Relecture EN BASE : état, provenance par occurrence (identité, issue, preuve exacte), document plus « complet ».
    const u = await unite(d.fileId, 'page:1:block:1');
    expect(u).toMatchObject({ status: 'UNRESOLVED', reason: 'values_partially_structured' });
    expect(u.prov.occurrences).toMatchObject({ total: 3, structured: 2, unresolved: 1 });
    const vidange = `page:1:block:1@${PRESTATIONS.indexOf('120,00', PRESTATIONS.indexOf('Vidange'))}`;
    expect(u.prov.details.find((x: Json) => x.id === vidange)).toMatchObject({ outcome: 'UNRESOLVED', proof: null, reason: 'no_proof' });
    expect(u.prov.details.filter((x: Json) => x.outcome === 'STRUCTURED').map((x: Json) => x.proof.source)).toEqual(['FACT', 'FACT']);
    const cov = await couverture(d.fileId);
    expect(cov.quality).toBe('COMPLETE_WITH_UNRESOLVED');
    expect(cov.verification.reconciliation.occurrences).toMatchObject({ total: 3, structured: 2, unresolved: 1, units: 1 });
    // Rejeu sans preuve nouvelle : rien ne change, rien n'est réécrit.
    expect((await reconcilier(c, d.fileId)).outcome).toBe('UNCHANGED');
    expect((await couverture(d.fileId)).updated_at).toEqual(cov.updated_at);
    // Preuve propre de la vidange (fait ACTIF) : les trois occurrences sont prouvées → COVERED, COMPLETE.
    await fait(c, d, 'vidange', '120.00', ['page:1:block:1']);
    expect((await reconcilier(c, d.fileId)).outcome).toBe('APPLIED');
    expect(await unite(d.fileId, 'page:1:block:1')).toMatchObject({ status: 'COVERED', reason: 'fact' });
    expect((await couverture(d.fileId)).quality).toBe('COMPLETE');
    expect(replay.calls).toHaveLength(0);
  });

  it('C853-E02 — AC09/AC10 : décision persistée sur une seule de deux occurrences identiques ; décision INVALID ou d’un autre compte sans effet', async () => {
    const c = await make.account();
    const autre = await make.account();
    const d = await document(c);
    const T = 'Vidange 120,00 EUR ; Plaquettes 120,00 EUR';
    await ecrire(c, d, [bloc(1, T, { status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0 })]);
    const decision = async (compte: AccountRow, validity: string, fp: string) => sql`
      INSERT INTO document_value_decisions (account_id, file_id, origin, contract_version, source_unit_id, value_kind, raw_value, normalized_value, decision, reason, validity, invalid_reason, decision_fp)
      VALUES (${compte.id}, ${d.fileId}, 'ANALYSIS', 't1-value-decisions-v1', 'page:1:block:1', 'AMOUNT', '120,00 EUR', '12000', 'STRUCTURED', 'Vidange reprise dans le fait de vidange',
              ${validity}, ${validity === 'VALID' ? null : 'LINK_MISSING'}, ${fp})`;
    await decision(c, 'INVALID', 'c853-invalide');
    await decision(autre, 'VALID', 'c853-autre-compte');
    expect((await reconcilier(c, d.fileId, false)).outcome).toBe('UNCHANGED');
    await decision(c, 'VALID', 'c853-valide');
    const r = await reconcilier(c, d.fileId);
    expect(r.outcome).toBe('APPLIED');
    const u = await unite(d.fileId, 'page:1:block:1');
    // Avant : décision indexée par forme → les deux occurrences « décidées » → COVERED/value_decision.
    expect(u).toMatchObject({ status: 'UNRESOLVED', reason: 'values_partially_structured' });
    expect(u.prov.occurrences).toMatchObject({ total: 2, structured: 1, unresolved: 1 });
    expect(u.prov.details.filter((x: Json) => x.outcome === 'STRUCTURED')[0].proof.source).toBe('VALUE_DECISION');
    expect(replay.calls).toHaveLength(0);
  });

  it('C853-E03 — AC06 : tableau persisté — franchise sans rôle : ligne ET tableau non résolus ; cellules avec rôle : couvertes sans fait', async () => {
    const c = await make.account();
    const d = await document(c);
    const cellule = (column: number, header: string | null, value: string) => ({ column, header, value, normalized: null, page: 1 });
    const ligne = (row: number, cells: ReturnType<typeof cellule>[]): CoveredSourceUnit => ({
      sourceUnitId: `page:1:table:1:row:${row}`, kind: 'TABLE_ROW', page: 1, ordinal: 10 + row, parentUnitId: 'page:1:table:1',
      text: cells.map((x) => `${x.header ? `${x.header} : ` : ''}${x.value}`).join(' | '), payload: { tableIndex: 0, row: row - 1, rowHeader: null, cells },
      location: { tableIndex: 0, row: row - 1 }, origin: 'PASS_1', salient: true, status: 'COVERED', reason: 'table', factCount: 0, repairAttempts: 0, repairState: null,
    });
    await ecrire(c, d, [
      { sourceUnitId: 'page:1:table:1', kind: 'TABLE', page: 1, ordinal: 10, parentUnitId: null, text: 'Garantie | Plafond | Franchise',
        payload: { tableIndex: 0, rowCount: 2, uncertain: false, pageEnd: 1 }, location: { page: 1, tableIndex: 0 }, origin: 'PASS_1', salient: false,
        status: 'COVERED', reason: 'table', factCount: 0, repairAttempts: 0, repairState: null },
      ligne(1, [cellule(0, 'Garantie', 'Vol'), cellule(1, 'Plafond', '5 000,00 EUR'), cellule(2, 'Franchise', '250,00 EUR')]),
      ligne(2, [cellule(0, 'Garantie', 'Degat des eaux'), cellule(1, 'Plafond', '10 000,00 EUR'), cellule(2, null, '150,00 EUR')]),
    ]);
    expect((await reconcilier(c, d.fileId)).outcome).toBe('APPLIED');
    expect(await unite(d.fileId, 'page:1:table:1:row:1')).toMatchObject({ status: 'COVERED', reason: 'table', prov: null });
    const l2 = await unite(d.fileId, 'page:1:table:1:row:2');
    expect(l2).toMatchObject({ status: 'UNRESOLVED', reason: 'values_partially_structured' });
    expect(l2.prov).toMatchObject({ rule: 'table_row_cells_unproven', occurrences: { total: 3, preserved: 2, unresolved: 1 } });
    expect(l2.prov.details.find((x: Json) => x.id === 'page:1:table:1:row:2:cell:3')).toMatchObject({ outcome: 'UNRESOLVED' });
    expect(await unite(d.fileId, 'page:1:table:1')).toMatchObject({ status: 'UNRESOLVED', reason: 'table_rows_unresolved' });
    // Fait persisté rattaché à CETTE cellule : la ligne et le tableau redeviennent couverts (rembobinage de l'état produit).
    await fait(c, d, 'franchise_degat_des_eaux', '150.00', ['page:1:table:1:row:2:cell:3'], '150,00 EUR');
    expect((await reconcilier(c, d.fileId)).outcome).toBe('APPLIED');
    expect(await unite(d.fileId, 'page:1:table:1:row:2')).toMatchObject({ status: 'COVERED', reason: 'table' });
    expect(await unite(d.fileId, 'page:1:table:1')).toMatchObject({ status: 'COVERED', reason: 'table' });
    expect(replay.calls).toHaveLength(0);
  });

  it('C853-E04 — AC14 : rattrapage v4 — faux COVERED d’un document COMPLETE requalifié sans IA, vrai COVERED préservé, idempotent, comptes isolés', async () => {
    const { runCoverageReassessment, T1_COVERAGE_RULES_VERSION } = await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    expect(T1_COVERAGE_RULES_VERSION).toBe(4);
    const a = await make.account();
    const b = await make.account();
    const faux = await document(a);
    const vrai = await document(a);
    const autre = await document(b);
    for (const [compte, d] of [[a, faux], [a, vrai], [b, autre]] as const) {
      await ecrire(compte, d, [bloc(1, PRESTATIONS)]);
      await fait(compte, d, 'plaquettes', '120.00', ['page:1:block:1']);
      await fait(compte, d, 'main_oeuvre', '80.00', ['page:1:block:1']);
    }
    await fait(a, vrai, 'vidange', '120.00', ['page:1:block:1']);
    const facts = async () => (await sql<Json[]>`SELECT count(*)::int AS n FROM document_facts WHERE file_id IN (${faux.fileId}, ${vrai.fileId}, ${autre.fileId})`)[0].n;
    const avant = await facts();

    const p1 = await runCoverageReassessment({ accountId: a.id });
    expect(p1.aiCalls ?? 0).toBe(0);
    const journal = async (fileId: number) => sql<Json[]>`SELECT outcome FROM t1_coverage_reassessments WHERE file_id = ${fileId} AND rules_version = 4`;
    expect((await journal(faux.fileId)).map((j) => j.outcome)).toEqual(['RECONCILED']);
    expect((await journal(vrai.fileId)).map((j) => j.outcome)).toEqual(['UNCHANGED']);
    expect((await couverture(faux.fileId)).quality).toBe('COMPLETE_WITH_UNRESOLVED');
    expect(await unite(faux.fileId, 'page:1:block:1')).toMatchObject({ status: 'UNRESOLVED', reason: 'values_partially_structured' });
    expect((await couverture(vrai.fileId)).quality).toBe('COMPLETE');
    // Autre compte : jamais touché par la campagne du compte A.
    expect((await couverture(autre.fileId)).quality).toBe('COMPLETE');
    expect(await journal(autre.fileId)).toEqual([]);
    // Aucune purge ni création : faits intacts. Seconde campagne : rien de plus.
    expect(await facts()).toBe(avant);
    const majFaux = (await couverture(faux.fileId)).updated_at;
    await runCoverageReassessment({ accountId: a.id });
    expect((await couverture(faux.fileId)).updated_at).toEqual(majFaux);
    expect((await journal(faux.fileId))).toHaveLength(1);
    expect(replay.calls).toHaveLength(0);
  });

  it('C853-E05 — AC15 : BO — totaux par occurrence (unités ≠ occurrences) et détail, sans valeur du document', async () => {
    const c = await make.account();
    const d = await document(c);
    await ecrire(c, d, [bloc(1, PRESTATIONS), bloc(2, 'Merci de votre visite', { status: 'UNRESOLVED', reason: 'not_structured', salient: false, factCount: 0 })]);
    await fait(c, d, 'plaquettes', '120.00', ['page:1:block:1']);
    const { loadCompletenessDetail } = await import('@/services/ai/source-analysis/source-units/completeness-detail');
    const detail = await loadCompletenessDetail(d.fileId, { all: true });
    expect(detail!.occurrenceTotals).toMatchObject({ total: 3, structured: 1, unresolved: 2 });
    expect(detail!.totals.total).toBe(2);
    const row = detail!.units.find((u) => u.unitId === 'page:1:block:1')!;
    expect(row.occurrences).toMatchObject({ mode: 'COVERED_CHECK', counts: { total: 3, structured: 1, unresolved: 2 } });
    // Simulation : rien n'est écrit par le BO.
    expect((await unite(d.fileId, 'page:1:block:1')).status).toBe('COVERED');
    expect(JSON.stringify(row.occurrences)).not.toMatch(/Plaquettes|Vidange|120,00|80,00/);
  });

  it('C853-E06 — AC12 : deux réconciliations concurrentes — un seul état écrit, aucune duplication', async () => {
    const c = await make.account();
    const d = await document(c);
    await ecrire(c, d, [bloc(1, PRESTATIONS)]);
    await fait(c, d, 'plaquettes', '120.00', ['page:1:block:1']);
    const issues = await Promise.all([reconcilier(c, d.fileId), reconcilier(c, d.fileId)]);
    expect(issues.filter((x) => x.outcome === 'APPLIED').length).toBeGreaterThanOrEqual(1);
    for (const x of issues) expect(['APPLIED', 'UNCHANGED', 'CONFLICT_DEFERRED']).toContain(x.outcome);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM document_source_units WHERE file_id = ${d.fileId}`)[0].n).toBe(1);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM document_extraction_coverage WHERE file_id = ${d.fileId}`)[0].n).toBe(1);
    const u = await unite(d.fileId, 'page:1:block:1');
    expect(u.prov.occurrences).toMatchObject({ total: 3, structured: 1, unresolved: 2 });
    expect((await reconcilier(c, d.fileId)).outcome).toBe('UNCHANGED');
    expect(replay.calls).toHaveLength(0);
  });
});
