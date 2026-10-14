/**
 * Lot 40 (O2) — candidats Opération dans T1 : contrat v4, adaptateur v3 → v4,
 * lecture tolérante, ancrage des preuves, fusion des lots, barrière serveur,
 * payload persisté (CDC Opérations V1 ch. 7, B3, B10, C2.1, C3, C3.1, C12.3).
 * Tests nommés C3-xx / F-xxx.
 */
import { describe, it, expect } from 'vitest';
import {
  T1AnalyzeDocumentOutput, T1_OPERATION_TYPES, T1_OPERATION_STATUSES, T1_SOURCE_ROLES, T1_REFERENCE_KINDS,
  T1_FINANCIAL_ROLES, T1_ANALYZE_DOCUMENT_CONTRACT_VERSION, type T1FactWithRef,
} from '../../master/t1-contract';
import { T1AnalyzeDocumentTolerantOutput, splitNormalisation } from '../../master/tolerant-output';
import { applyOverflow, mergeChunkOutput, factFingerprint } from '../../source-units/merge';
import { applyCompatAdapters, outputSchemaRef } from '../../../gateway/output-resolution/contracts';
import {
  BUSINESS_OPERATION_TYPE_CODES, BUSINESS_OPERATION_STATUSES, SOURCE_ROLES, REFERENCE_KINDS, FINANCIAL_COMPONENT_KINDS,
} from '@/services/business-operations/model';
import {
  anchorOperationCandidates, gateOperationCandidates, mergeOperationCandidates,
  type AnchoredOperationCandidate, type CandidateGateContext,
} from '../prepare';
import { candidatePayload } from '../persist';
import { listT1Fixtures, loadT1Fixture } from '../../__fixtures__/t1/load';
import { MASTER_CORPUS_EVALUATORS } from '../../../governance/master-corpus/evaluators';

const fait = (excerpt: string, over: Record<string, unknown> = {}) => ({
  canonicalKey: null, rawKey: 'k', label: 'L', normalizedValue: excerpt, target: { type: 'ASSET', entityId: 12 },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt }, ...over,
});
const candidat = (over: Record<string, unknown> = {}) => ({
  candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
  summary: 'Réparation', sourceRoleHint: 'INVOICE', evidenceFactIndexes: [0],
  financialHints: [{ role: 'REALIZED_COST', amountMinor: 74900, currency: 'EUR', factIndex: 1 }], ...over,
});
const lire = (brut: Record<string, unknown>) => {
  const { output, report } = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse({ task: 'ANALYZE_DOCUMENT', ...brut }));
  return { ...applyOverflow(output, report), report };
};
const ctxBase = (over: Partial<CandidateGateContext> = {}): CandidateGateContext => ({
  hasExploitableContent: true, documentTypeCode: 'REPAIR_INVOICE',
  verifiedIds: { ASSET: new Set([12]), EQUIPMENT: new Set(), ROOM: new Set() },
  capabilities: { rooms: true, equipments: true }, keptFactRefs: new Set(), ...over,
});
const ancre = (over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate => ({
  candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
  summary: 'Réparation', sourceRoleHint: 'INVOICE', provider: null, targetHints: [], businessReferences: [],
  temporalHints: {}, financialHints: [{ role: 'REALIZED_COST', amountMinor: 100, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef: 'f2' }],
  evidenceFactRefs: ['f1'], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
});

describe('C3-01 — contrat v4 : vocabulaire fermé aligné sur le modèle des Opérations', () => {
  it('types, statuts, rôles de source, références identiques ; rôles financiers = composantes + PAYMENT', () => {
    expect([...T1_OPERATION_TYPES]).toEqual([...BUSINESS_OPERATION_TYPE_CODES]);
    expect([...T1_OPERATION_STATUSES]).toEqual([...BUSINESS_OPERATION_STATUSES]);
    expect([...T1_SOURCE_ROLES]).toEqual([...SOURCE_ROLES]);
    expect([...T1_REFERENCE_KINDS]).toEqual([...REFERENCE_KINDS]);
    // Lot 53D (PO-Q16) : capital emprunté = rôle propre, jamais une composante.
    expect([...T1_FINANCIAL_ROLES]).toEqual([...FINANCIAL_COMPONENT_KINDS, 'PAYMENT', 'LOAN_PRINCIPAL']);
  });
  it('version 5 affichée par le registre des contrats (lot 53D)', () => {
    expect(T1_ANALYZE_DOCUMENT_CONTRACT_VERSION).toBe(5);
    expect(outputSchemaRef('T1AnalyzeDocumentOutput', T1AnalyzeDocumentOutput, 't1_analyze_document').version).toBe('t1_analyze_document@v5');
  });
});

describe('C3-02 — compatibilité : une sortie v3 reste valide (aucun candidat)', () => {
  it('sortie sans tableau : validée, candidats vides, aucune adaptation consignée', () => {
    const v3 = { task: 'ANALYZE_DOCUMENT', document: {}, facts: [fait('x')] };
    const report: never[] = [];
    expect(applyCompatAdapters(v3, 'T1AnalyzeDocumentOutput', report)).toBe(v3);
    expect(report).toEqual([]);
    expect(T1AnalyzeDocumentOutput.parse(v3).businessOperationCandidates).toEqual([]);
    expect(lire(v3).output.businessOperationCandidates).toEqual([]);
  });
  it('toutes les fixtures T1 antérieures au lot 40 restent valides et sans candidat', () => {
    for (const f of listT1Fixtures().filter((x) => !x.startsWith('t1-40-'))) {
      const fx = loadT1Fixture(f);
      if (fx.recording.task !== 'ANALYZE_DOCUMENT') continue;
      expect('businessOperationCandidates' in fx.recording.output, f).toBe(false);
      // Les cas 33D exigent la normalisation de la passerelle (nulls) : seule
      // l'absence de candidat est contrôlée pour eux.
      const r = T1AnalyzeDocumentTolerantOutput.safeParse(fx.recording.output);
      if (!f.startsWith('t1-33d-')) expect(r.success, f).toBe(true);
      if (r.success) expect(r.data.businessOperationCandidates, f).toEqual([]);
    }
  });
});

describe('C3-03 — adaptateur t1_v3_to_v4 (formes antérieures du bloc candidat)', () => {
  it('bloc unique du CDC §7.1 → tableau C3.1 (uncertain lu probable), consigné', () => {
    const report: Array<{ rule: string }> = [];
    const v = applyCompatAdapters({
      task: 'ANALYZE_DOCUMENT', document: {}, facts: [fait('a')],
      businessOperationCandidate: { established: true, typeHint: 'CONTRACT', confidence: 'uncertain', summary: 'Assurance', evidence: [0] },
    }, 'T1AnalyzeDocumentOutput', report as never) as Record<string, unknown>;
    expect(report.map((r) => r.rule)).toEqual(['t1_v3_to_v4']);
    expect(v.businessOperationCandidate).toBeUndefined();
    const out = T1AnalyzeDocumentOutput.parse(v);
    expect(out.businessOperationCandidates[0]).toMatchObject({ candidateKey: 'op1', established: true, typeHint: 'CONTRACT', confidence: 'probable', evidenceFactIndexes: [0] });
  });
  it('vocabulaire B3 (exists, certainty, proposed_type, evidence_refs) → C3.1', () => {
    const v = applyCompatAdapters({
      task: 'ANALYZE_DOCUMENT', document: {}, facts: [fait('a'), fait('b')],
      operationCandidates: [{ candidate_key: 'c1', exists: true, certainty: 'SUFFICIENT', proposed_type: 'INTERVENTION', status_hint: 'REALIZED', technical_label: 'Vidange', evidence_refs: [{ factIndex: 1 }], external_reference: 'FA-1' }],
    }, 'T1AnalyzeDocumentOutput', []) as Record<string, unknown>;
    expect(T1AnalyzeDocumentOutput.parse(v).businessOperationCandidates[0]).toMatchObject({
      candidateKey: 'c1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED', summary: 'Vidange',
      evidenceFactIndexes: [1], businessReferences: [{ kind: 'OTHER', value: 'FA-1' }],
    });
  });
});

describe('C3-04 — lecture tolérante des candidats', () => {
  it('un candidat invalide est écarté SEUL ; vocabulaire inconnu → null (jamais OTHER) ; « uncertain » → probable', () => {
    const { output, report } = lire({
      facts: [fait('a'), fait('b')],
      businessOperationCandidates: [
        candidat({ typeHint: 'reparation', statusHint: 'done', sourceRoleHint: 'facture', confidence: 'uncertain' }),
        { candidateKey: 'op2', established: true }, // sans synthèse : invalide
      ],
    });
    expect(output.businessOperationCandidates).toHaveLength(1);
    expect(output.businessOperationCandidates[0]).toMatchObject({ typeHint: null, statusHint: null, sourceRoleHint: null, confidence: 'probable' });
    expect(report?.droppedCandidates).toBe(1);
    // Un candidat n'est pas un fait : jamais dans les éléments conservés pour reprise.
    expect(report?.dropped ?? []).toEqual([]);
  });
  it('clés locales manquantes ou en double rendues uniques', () => {
    const { output } = lire({ facts: [fait('a'), fait('b')], businessOperationCandidates: [candidat({ candidateKey: '' }), candidat({ candidateKey: 'op1' }), candidat({ candidateKey: 'op1' })] });
    expect(output.businessOperationCandidates.map((c) => c.candidateKey)).toEqual(['op1', 'op1~2', 'op1~3']);
  });
  it('C12.3 — devise lue normalisée (« chf », « € ») ; illisible (« $ ») → « XXX », montant conservé (PO-D2) ; montant non entier → indice retiré ; date normalisée', () => {
    const { output } = lire({
      facts: [fait('a'), fait('b')],
      businessOperationCandidates: [candidat({ temporalHints: { realizedDate: '14.08.2026' }, financialHints: [
        { role: 'realized_cost', amountMinor: 449000, currency: 'chf', factIndex: 1 },
        { role: 'REALIZED_COST', amountMinor: 100, currency: '€', factIndex: 1 },
        { role: 'REALIZED_COST', amountMinor: 100, currency: '$', factIndex: 1 },
        { role: 'REALIZED_COST', amountMinor: 12.5, currency: 'EUR', factIndex: 1 },
      ] })],
    });
    const c = output.businessOperationCandidates[0];
    expect(c.financialHints.map((h) => [h.role, h.currency, h.amountMinor])).toEqual([['REALIZED_COST', 'CHF', 449000], ['REALIZED_COST', 'EUR', 100], ['REALIZED_COST', 'XXX', 100]]);
    expect(c.temporalHints.realizedDate).toBe('2026-08-14');
  });
  it('T1-OP-008 / F-199 — au plus 20 candidats, le surplus est signalé', () => {
    const { output, report } = lire({ facts: [fait('a'), fait('b')], businessOperationCandidates: Array.from({ length: 23 }, (_x, i) => candidat({ candidateKey: `op${i}` })) });
    expect(output.businessOperationCandidates).toHaveLength(20);
    expect(report?.truncatedCandidates).toBe(3);
  });
  it('index de faits recalés : fait invalide écarté → les suivants sont décalés, la référence au fait écarté est retirée', () => {
    const { output, report } = lire({
      facts: [fait('a', { target: { type: 'BATIMENT' } }), fait('b'), fait('c')],
      businessOperationCandidates: [candidat({ evidenceFactIndexes: [0, 2], financialHints: [{ role: 'REALIZED_COST', amountMinor: 1, currency: 'EUR', factIndex: 1 }] })],
    });
    const c = output.businessOperationCandidates[0];
    expect(output.facts.map((f) => f.evidence.excerpt)).toEqual(['b', 'c']);
    expect(c.evidenceFactIndexes).toEqual([1]); // « c »
    expect(c.financialHints[0].factIndex).toBe(0); // « b »
    expect(report?.unresolvedCandidateEvidence).toBe(1);
  });
  it('lot de débordement (> 300 faits) : un fait au-delà du lot principal reste désigné après réintégration', () => {
    const facts = Array.from({ length: 302 }, (_x, i) => fait(`f${i}`));
    const { output } = lire({ facts, businessOperationCandidates: [candidat({ evidenceFactIndexes: [301], financialHints: [] })] });
    expect(output.facts).toHaveLength(302);
    expect(output.facts[output.businessOperationCandidates[0].evidenceFactIndexes[0]].evidence.excerpt).toBe('f301');
  });
});

describe('C3-05 — ancrage des preuves (index → empreinte du fait)', () => {
  it('empreinte posée sur chaque fait ; preuves et montants convertis en empreintes', () => {
    const { output } = lire({ facts: [fait('Remplacement embrayage'), fait('Total TTC : 749,00 €')], businessOperationCandidates: [candidat()] });
    const [c] = anchorOperationCandidates(output, 'PASS_1');
    const refs = (output.facts as T1FactWithRef[]).map((f) => f.t1FactRef);
    expect(refs).toEqual(output.facts.map((f) => factFingerprint(f)));
    expect(c.evidenceFactRefs).toEqual([refs[0]]);
    expect(c.financialHints[0].factRef).toBe(refs[1]);
    expect(c.visualOnlyEvidence).toBe(false);
  });
  it('lot de pages : un fait déjà connu (dédoublonné par empreinte) reste désigné ; candidat identique fusionné, nouveau ajouté avec une clé unique', () => {
    const base = lire({ facts: [fait('Total TTC : 749,00 €')], businessOperationCandidates: [candidat({ evidenceFactIndexes: [0], financialHints: [] })] }).output;
    const a = anchorOperationCandidates(base, 'PASS_1');
    const lot = lire({
      facts: [fait('Ligne page 3'), fait('Total TTC : 749,00 €')],
      businessOperationCandidates: [
        candidat({ evidenceFactIndexes: [0, 1], financialHints: [] }),
        candidat({ typeHint: 'CONTRACT', summary: 'Contrat d’entretien', evidenceFactIndexes: [0], financialHints: [] }),
      ],
    }).output;
    const b = anchorOperationCandidates(lot, 'CHUNK');
    const fusion = mergeChunkOutput(base, lot).output;
    expect(fusion.facts).toHaveLength(2); // le total n'est pas dupliqué
    const merged = mergeOperationCandidates(a, b);
    expect(merged.map((c) => c.candidateKey)).toEqual(['op1', 'op1~2']);
    const refsFusion = new Set((fusion.facts as T1FactWithRef[]).map((f) => f.t1FactRef));
    expect(merged[0].evidenceFactRefs).toHaveLength(2);
    for (const r of merged.flatMap((c) => c.evidenceFactRefs)) expect(refsFusion.has(r)).toBe(true);
  });
});

describe('C3-06 — barrière serveur (règles fermées, indépendantes du prompt actif)', () => {
  const ctx = ctxBase({ keptFactRefs: new Set(['f1', 'f2']) });
  it('candidat conforme : conservé tel quel', () => {
    const r = gateOperationCandidates([ancre()], ctx);
    expect(r.candidates[0]).toMatchObject({ established: true, confidence: 'certain', adjustments: [] });
  });
  it('NO_EXPLOITABLE_CONTENT : aucun candidat', () => {
    expect(gateOperationCandidates([ancre()], { ...ctx, hasExploitableContent: false }).candidates).toEqual([]);
  });
  it('F-004 / F-005 / F-007 — type documentaire non métier (notice, photo, valorisation) → non établi', () => {
    for (const t of ['USER_MANUAL', 'PHOTO', 'VALUE_APPRAISAL', 'WARRANTY_CERTIFICATE']) {
      const [c] = gateOperationCandidates([ancre()], { ...ctx, documentTypeCode: t }).candidates;
      expect(c).toMatchObject({ established: false, exclusionReason: 'DOCUMENT_TYPE_NOT_BUSINESS' });
    }
  });
  it('T1-OP-006 — établi sans preuve conservée → non établi (NO_EVIDENCE) ; montant sans fait conservé retiré', () => {
    const [c] = gateOperationCandidates([ancre({ evidenceFactRefs: ['inconnu'] , financialHints: [{ ...ancre().financialHints[0], factRef: 'inconnu' }] })], ctx).candidates;
    expect(c).toMatchObject({ established: false, exclusionReason: 'NO_EVIDENCE', financialHints: [] });
    expect(c.adjustments).toEqual(expect.arrayContaining(['EVIDENCE_FACT_NOT_KEPT', 'FINANCIAL_HINT_WITHOUT_FACT', 'NO_EVIDENCE']));
  });
  it('F-005 — preuves uniquement visuelles → non établi (VISUAL_ONLY)', () => {
    const [c] = gateOperationCandidates([ancre({ visualOnlyEvidence: true })], ctx).candidates;
    expect(c).toMatchObject({ established: false, exclusionReason: 'VISUAL_ONLY' });
  });
  it('INV-FINAL-015 — preuve de paiement : jamais un coût, jamais certaine seule ; imposée par le type V2', () => {
    const [c] = gateOperationCandidates([ancre()], { ...ctx, transactionNature: 'PAYMENT_PROOF' }).candidates;
    expect(c).toMatchObject({ sourceRoleHint: 'PAYMENT_PROOF', confidence: 'probable' });
    expect(c.financialHints.map((h) => h.role)).toEqual(['PAYMENT']);
  });
  it('C2.1 — devis : coût prévu seulement, jamais REALIZED ; avoir : réduction ; acompte : portée DEPOSIT', () => {
    const [devis] = gateOperationCandidates([ancre({ sourceRoleHint: 'QUOTE' })], ctx).candidates;
    expect(devis).toMatchObject({ statusHint: 'ENVISAGED' });
    expect(devis.financialHints[0].role).toBe('FORECAST_COST');
    const [avoir] = gateOperationCandidates([ancre({ sourceRoleHint: 'CREDIT_NOTE' })], ctx).candidates;
    expect(avoir.financialHints[0].role).toBe('REDUCTION');
    const [acompte] = gateOperationCandidates([ancre({ sourceRoleHint: 'DEPOSIT_INVOICE' })], ctx).candidates;
    expect(acompte.financialHints[0].amountScope).toBe('DEPOSIT');
  });
  it('U9 / U7 — cible non vérifiée neutralisée ; pièce / équipement hors capacités retiré', () => {
    const [c] = gateOperationCandidates([ancre({ targetHints: [
      { type: 'ASSET', entityId: 12, rawLabel: 'Clio', confidence: 'certain' },
      { type: 'ASSET', entityId: 99, rawLabel: 'Inconnu', confidence: 'probable' },
      { type: 'EQUIPMENT', entityId: null, rawLabel: 'Chaudière', confidence: 'probable' },
    ] })], { ...ctx, capabilities: { rooms: false, equipments: false } }).candidates;
    expect(c.targetHints.map((t) => [t.type, t.entityId])).toEqual([['ASSET', 12], ['ASSET', null]]);
    expect(c.adjustments).toEqual(expect.arrayContaining(['TARGET_UNVERIFIED', 'TARGET_TYPE_NOT_ALLOWED']));
  });
  it('T1-OP-002 — non établi sans motif omis ; avec motif conservé (trace)', () => {
    const r = gateOperationCandidates([ancre({ established: false }), ancre({ candidateKey: 'op2', established: false, exclusionReason: 'VALUATION_ONLY' })], ctx);
    expect(r.candidates.map((c) => c.candidateKey)).toEqual(['op2']);
    expect(r.omitted).toBe(1);
  });
  it('n’altère jamais l’entrée', () => {
    const entree = ancre({ sourceRoleHint: 'QUOTE' });
    gateOperationCandidates([entree], ctx);
    expect(entree.financialHints[0].role).toBe('REALIZED_COST');
    expect(entree.adjustments).toEqual([]);
  });
});

describe('C3-07 — corpus lot 40 rejoué à travers la barrière (F-001 … F-030)', () => {
  const evaluer = MASTER_CORPUS_EVALUATORS.t1_analyze_document;
  for (const f of listT1Fixtures().filter((x) => x.startsWith('t1-40-'))) {
    it(`${loadT1Fixture(f).case} — ${f}`, async () => {
      const fx = loadT1Fixture(f);
      const out = T1AnalyzeDocumentOutput.parse(fx.recording.output);
      const ecarts = await evaluer({ id: fx.case, description: fx.description, file: f, operationCode: 't1_analyze_document', masterPromptCode: 't1_master_v1',
        task: 'ANALYZE_DOCUMENT', taskField: 'task', outputSchema: 'T1AnalyzeDocumentOutput', context: fx.context as never, output: out,
        expected: (fx as unknown as { expected: Record<string, unknown> }).expected }, out, { masterText: () => '' });
      expect(ecarts).toEqual([]);
    });
  }
});

describe('C3-08 — payload persisté : preuves ancrées sur le fait persisté', () => {
  it('empreinte → identifiant du fait et unités de la source ; fait non persisté compté', () => {
    const p = candidatePayload(ancre({ evidenceFactRefs: ['f1', 'absent'] }), new Map([
      ['f1', [{ factId: 501, sourceUnitIds: ['page:1:block:2'] }]], ['f2', [{ factId: 502, sourceUnitIds: [] }]],
    ]));
    expect(p.evidence).toEqual([
      { factId: 501, fingerprint: 'f1', sourceUnitIds: ['page:1:block:2'] },
      { factId: null, fingerprint: 'absent', sourceUnitIds: [] },
    ]);
    expect(p.evidenceFactIds).toEqual([501]);
    expect(p.unresolvedEvidence).toBe(1);
    expect((p.financialHints as Array<{ evidence: { factId: number } }>)[0].evidence.factId).toBe(502);
    expect(p).toMatchObject({ contract: 't1_analyze_document@v5', sourceRoleHint: 'INVOICE' });
  });
});
