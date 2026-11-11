/**
 * Lot 113AL (Trello #737) — arbitrage sémantique T3 des montants non qualifiés
 * du TCO : contrat (schéma, validation stricte, effets), application par le
 * moteur EXISTANT (`computeTco` : inclusion, règlement, représentation par un
 * fait compté, parts d'un total, multibiens, priorité de l'utilisateur, fait
 * disparu, extract sans ligne), cibles et empreinte, capacité. E2E base
 * réelle : `src/test/e2e/scenarios/l113al-tco-arbitrage-t3.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoResult } from '../../model';
import { tcoLineDecisionOptions, tcoLineKeys, type TcoUserDecision } from '../../user-decisions';
import type { EconomicDocumentInput } from '../../../finance/economic-lines';
import type { SemanticDocumentState, SemanticQualification } from '../../../finance/semantic-qualification';
import {
  buildQualificationInput, qualificationVariables, validateQualification, ECONOMIC_QUALIFICATION_CONTRACT_VERSION, ECONOMIC_QUALIFICATION_TASK,
  type QualificationEffect, type RawQualificationContext,
} from '../contract';
import { economicQualificationEnabled, qualificationCapabilityOf } from '../decider';
import { qualificationFingerprint, qualificationTargets } from '../targets';
import { qualificationEffectStatus } from '../corpus';

const BIEN = 32;
const TODAY = '2026-11-10';

const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
/** Document que T1 n'a pas qualifié (type générique, aucun indice financier) — même forme pour tous les cas. */
const doc = (fileId: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Courrier ${fileId}`, typeCode: 'OTHER', legacyType: null, date: '2025-09-01', supplier: null,
  amountCents: null, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [BIEN], multiAsset: false, candidates: [], operations: [], ...o,
});
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: BIEN, today: TODAY, operations: [], assetAcquisitionDate: '2019-06-01', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: prix(28_900_000),
  assetCategory: 'IMMOBILIER', ...o,
});
const effet = (o: Partial<SemanticQualification>): SemanticQualification => ({
  reviewId: 1, decidedAt: '2026-11-10T10:00:00.000Z', contractVersion: ECONOMIC_QUALIFICATION_CONTRACT_VERSION, promptVersion: 't3-v9', model: 'simulé',
  amountMinor: 134_000, currency: 'EUR', origin: 'LINE', outcome: 'INCLUDE', applied: true, role: 'REALIZED_COST', scope: 'TOTAL',
  economicDate: '2025-09-01', periodStart: null, periodEnd: null, allocation: 'THIS_ASSET', representedBy: null, exclusion: null,
  confidence: 'certain', reason: 'Avis de charge annuelle du bien.', evidence: [{ fileId: 355, excerpt: 'Montant à payer : 1 340,00 €' }], ...o,
});
const etat = (effects: SemanticQualification[], o: Partial<SemanticDocumentState> = {}): SemanticDocumentState => ({ effects, awaiting: false, ...o });
const ligne = (t: TcoResult, fileId: number) => t.lines.find((l) => l.source === 'DOCUMENT' && l.fileId === fileId)!;
const FICHE = `asset:${BIEN}:acquisitionPrice`;

// ── Contexte BRUT du cas « compte 10, Maison #32 » rendu générique (aucune règle par type ni par montant) ────
const contexte = (o: Partial<RawQualificationContext> = {}): RawQualificationContext => ({
  today: TODAY, asset: { id: BIEN, category: 'IMMOBILIER' }, targetFileId: 355,
  amounts: [{ fileId: 355, amountMinor: 134_000, currency: 'EUR', origin: 'LINE', lineId: 'doc:355', quote: null }],
  documents: [
    { id: 355, type: 'OTHER', title: 'Avis 2025', date: '2025-09-01', provider: 'Émetteur A', references: [{ kind: 'OTHER', value: 'REF-A1' }],
      excerpts: ['Montant à payer : 1 340,00 €', 'Échéance du paiement : 15/10/2025', 'Cotisation annuelle afférente au bien'],
      lines: [{ kind: null, amountMinor: 134_000, currency: 'EUR', status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN' }] },
    { id: 356, type: 'OTHER', title: 'Justificatif de paiement', date: '2025-10-14', provider: 'Banque', references: [], relation: 'SAME_ASSET',
      excerpts: ['Prélèvement de 1 340,00 € au profit de Émetteur A', 'Référence REF-A1'] },
  ],
  countedFacts: [
    { key: FICHE, lineId: FICHE, source: 'ASSET_DATA', label: 'Prix d’achat (fiche du bien)', kind: 'REALIZED_COST', amountMinor: 28_900_000, currency: 'EUR', date: '2019-06-01', fileId: null, operationId: null },
  ],
  ...o,
});
const sortie = (decisions: Array<Record<string, unknown>>) => ({ task: ECONOMIC_QUALIFICATION_TASK, decisions });
const inclure = (o: Record<string, unknown> = {}) => ({
  amount: 'M1', outcome: 'INCLUDE', role: 'REALIZED_COST', scope: 'TOTAL', economicDate: '2025-09-01', allocation: 'THIS_ASSET', confidence: 'certain',
  evidence: [{ document: 'D0', excerpt: 'Montant à payer : 1 340,00 €' }], reason: 'Cotisation annuelle du bien, montant dû.', ...o,
});

describe('L113AL-U-CONTRACT — contrat t3-economic-qualification-v1 : entrée bornée, validation stricte', () => {
  it('L113AL-U-CONTRACT-01 — entrée sans identifiant technique, six emplacements T3, rôles et portées du modèle existant', () => {
    const { input, scope } = buildQualificationInput(contexte());
    const vars = qualificationVariables(input);
    expect(Object.keys(vars).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    expect(JSON.stringify(vars)).not.toMatch(/"fileId"|"lineId"|355|356/);
    expect((vars.FIELD as { roles: string[] }).roles).toEqual(['FORECAST_COST', 'REALIZED_COST', 'REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED', 'PAYMENT', 'LOAN_PRINCIPAL']);
    expect(input.amounts).toEqual([expect.objectContaining({ ref: 'M1', document: 'D0', amount: '1340.00', currency: 'EUR' })]);
    expect(scope.documents).toEqual({ D0: 355, D1: 356 });
    expect(input.countedFacts[0]).toMatchObject({ ref: 'F1', source: 'ASSET_DATA', amount: '289000.00', document: null });
  });

  it('L113AL-U-CONTRACT-02 — inclusion certaine : effet appliqué, montant persisté (jamais rendu par l’IA)', () => {
    const v = validateQualification(sortie([inclure()]), buildQualificationInput(contexte()).scope);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.effects).toEqual([expect.objectContaining({ amountRef: 'M1', fileId: 355, amountMinor: 134_000, outcome: 'INCLUDE', applied: true, allocation: 'THIS_ASSET' })]);
  });

  it('L113AL-U-CONTRACT-03 — refus en bloc : extrait inventé, document inconnu, preuve hors D0, schéma', () => {
    const s = buildQualificationInput(contexte()).scope;
    const issues = (o: unknown) => { const v = validateQualification(o, s); return v.ok ? [] : [...new Set(v.problems.map((p) => p.issue))].sort(); };
    expect(issues(sortie([inclure({ evidence: [{ document: 'D0', excerpt: 'Taxe de 1 340 € payée' }] })]))).toEqual(['EXCERPT_NOT_FOUND']);
    expect(issues(sortie([inclure({ evidence: [{ document: 'D7', excerpt: 'x' }] })]))).toEqual(['TARGET_EVIDENCE_MISSING', 'UNKNOWN_DOCUMENT']);
    expect(issues(sortie([inclure({ evidence: [{ document: 'D1', excerpt: 'Référence REF-A1' }] })]))).toEqual(['TARGET_EVIDENCE_MISSING']);
    expect(issues(sortie([inclure({ role: null })]))).toEqual(['SCHEMA']);
    expect(issues(sortie([inclure({ amount: 'M9' })]))).toEqual(['UNKNOWN_AMOUNT']);
    expect(issues(sortie([inclure(), inclure()]))).toEqual(['DUPLICATE_AMOUNT']);
    expect(issues({ task: 'OTHER', decisions: [] })).toEqual(['SCHEMA']);
  });

  it('L113AL-U-CONTRACT-04 — représentation : rôle, devise, montant compatibles ; l’égalité de montant seule ne suffit jamais', () => {
    const ctx = contexte({ targetFileId: 361, amounts: [{ fileId: 361, amountMinor: 28_900_000, currency: 'EUR', origin: 'LINE', lineId: 'doc:361', quote: null }],
      documents: [{ id: 361, type: 'OTHER', title: 'Justificatif d’acquisition', date: '2019-06-01', provider: null, references: [],
        excerpts: ['Prix de vente : 289 000 €', 'Vente du bien situé à l’adresse de la maison', 'Acquéreur : le titulaire du compte'] }] });
    const s = buildQualificationInput(ctx).scope;
    const rep = (o: Record<string, unknown> = {}) => sortie([{ amount: 'M1', outcome: 'REPRESENTED', role: 'REALIZED_COST', representedBy: 'F1', confidence: 'certain',
      evidence: [{ document: 'D0', excerpt: 'Prix de vente : 289 000 €' }, { document: 'D0', excerpt: 'Vente du bien situé à l’adresse de la maison' }], reason: 'Acte du prix d’achat déjà repris par la fiche.', ...o }]);
    const v = validateQualification(rep(), s);
    expect(v.ok && v.effects[0]).toMatchObject({ outcome: 'REPRESENTED', applied: true, representedBy: { key: FICHE, source: 'ASSET_DATA' } });
    const issues = (o: Record<string, unknown>) => { const r = validateQualification(rep(o), s); return r.ok ? [] : r.problems.map((p) => p.issue); };
    expect(issues({ evidence: [{ document: 'D0', excerpt: 'Prix de vente : 289 000 €' }] })).toEqual(['SAME_AMOUNT_ONLY']);
    expect(issues({ role: 'INDEMNITY' })).toEqual(['ROLE_INCOMPATIBLE']);
    expect(issues({ representedBy: 'F9' })).toEqual(['UNKNOWN_FACT']);
    const plusGrand = buildQualificationInput({ ...ctx, amounts: [{ ...ctx.amounts[0], amountMinor: 30_000_000 }] }).scope;
    const r2 = validateQualification(rep(), plusGrand);
    expect(r2.ok ? [] : r2.problems.map((p) => p.issue)).toEqual(['AMOUNT_INCOMPATIBLE']);
    const usd = buildQualificationInput({ ...ctx, amounts: [{ ...ctx.amounts[0], currency: 'USD' }] }).scope;
    const r3 = validateQualification(rep(), usd);
    expect(r3.ok ? [] : r3.problems.map((p) => p.issue)).toEqual(['CURRENCY_INCOMPATIBLE']);
  });

  it('L113AL-U-CONTRACT-05 — confiance non certaine, abstention, montant sans décision : aucun effet ; multibiens : jamais réparti', () => {
    const s = buildQualificationInput(contexte()).scope;
    const p = validateQualification(sortie([inclure({ confidence: 'probable' })]), s);
    expect(p.ok && p.effects[0].applied).toBe(false);
    const a = validateQualification(sortie([{ amount: 'M1', outcome: 'ABSTAIN', confidence: 'ambiguous', reason: 'Nature non établie.' }]), s);
    expect(a.ok && a.effects[0]).toMatchObject({ outcome: 'ABSTAIN', applied: false });
    const ctx2 = contexte({ amounts: [...contexte().amounts, { fileId: 355, amountMinor: 5_000, currency: 'EUR', origin: 'EXTRACT', lineId: null, quote: 'Frais de 50,00 €' }] });
    const m = validateQualification(sortie([inclure()]), buildQualificationInput(ctx2).scope);
    expect(m.ok && m.effects.map((e) => [e.amountRef, e.outcome, e.applied])).toEqual([['M1', 'INCLUDE', true], ['M2', 'ABSTAIN', false]]);
    const partage = contexte({ documents: [{ ...contexte().documents[0], multiAsset: true }, contexte().documents[1]] });
    const sp = validateQualification(sortie([inclure()]), buildQualificationInput(partage).scope);
    expect(sp.ok && sp.effects[0]).toMatchObject({ applied: true, allocation: 'NOT_ALLOCATED', serverNote: expect.stringContaining('ventilation') });
  });
});

describe('L113AL-U-ENGINE — application par le moteur existant (computeTco), jamais une addition directe', () => {
  const base = (docs: EconomicDocumentInput[], o: Partial<TcoInput> = {}) => computeTco(entree({ documents: docs, ...o }));

  it('L113AL-U-ENGINE-01 (recette 1) — charge sans indice T1 : sans arbitrage « Nature à confirmer », avec : retenue par le moteur', () => {
    const avant = base([doc(355, { amountCents: 134_000 })]);
    expect(ligne(avant, 355)).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN', includedCents: 0 });
    const apres = base([doc(355, { amountCents: 134_000, semantic: etat([effet({})]) })]);
    expect(ligne(apres, 355)).toMatchObject({ status: 'RETAINED_DIRECT', provenance: 'T3', includedCents: 134_000, semantic: { state: 'APPLIED', reviewId: 1, confidence: 'certain' } });
    expect(apres.summary.cumulativeCostCents - avant.summary.cumulativeCostCents).toBe(134_000);
    expect(apres.reliability.warnings).not.toContain('DOCUMENTS_NOT_QUALIFIED');
  });

  it('L113AL-U-ENGINE-02 (recette 2) — règlement de la charge : une seule dépense, jamais un coût de plus', () => {
    const t = base([
      doc(355, { amountCents: 134_000, semantic: etat([effet({})]) }),
      doc(356, { amountCents: 134_000, title: 'Justificatif de paiement', semantic: etat([effet({ reviewId: 2, outcome: 'REPRESENTED', role: 'PAYMENT', representedBy: { key: 'f:355:REALIZED_COST:134000:EUR', lineId: 'doc:355', label: 'Avis', source: 'DOCUMENT', fileId: 355 } })]) }),
    ]);
    expect(ligne(t, 356)).toMatchObject({ status: 'PAYMENT', reason: 'PAYMENT_PROOF', includedCents: 0, duplicateOf: 'doc:355', relatedFileId: 355 });
    expect(t.lines.filter((l) => l.includedCents > 0 && l.source === 'DOCUMENT').map((l) => l.fileId)).toEqual([355]);
  });

  it('L113AL-U-ENGINE-03 (recette 3) — prix d’acquisition déjà compté : relié au vrai fait, aucune nouvelle somme, plus de THEME_UNKNOWN', () => {
    const avant = base([doc(361, { amountCents: 28_900_000, date: '2019-06-01' })]);
    expect(ligne(avant, 361).reason).toBe('THEME_UNKNOWN');
    const apres = base([doc(361, { amountCents: 28_900_000, date: '2019-06-01', semantic: etat([effet({ amountMinor: 28_900_000, outcome: 'REPRESENTED', role: 'REALIZED_COST', representedBy: { key: FICHE, lineId: FICHE, label: 'Prix', source: 'ASSET_DATA', fileId: null } })]) })]);
    expect(ligne(apres, 361)).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE', reason: 'SAME_AS_ASSET_PRICE', duplicateOf: FICHE, includedCents: 0 });
    expect(apres.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents);
  });

  it('L113AL-U-ENGINE-04 (recette 4) — deux dépenses distinctes de même montant : deux coûts, aucune fusion par égalité', () => {
    const t = base([
      doc(401, { amountCents: 50_000, date: '2025-03-01', semantic: etat([effet({ amountMinor: 50_000, economicDate: '2025-03-01' })]) }),
      doc(402, { amountCents: 50_000, date: '2025-09-01', semantic: etat([effet({ reviewId: 3, amountMinor: 50_000, economicDate: '2025-09-01' })]) }),
    ]);
    expect([ligne(t, 401).includedCents, ligne(t, 402).includedCents]).toEqual([50_000, 50_000]);
  });

  it('L113AL-U-ENGINE-05 (recette 5) — facture totale + acompte : un seul montant engagé, pièces conservées', () => {
    const t = base([
      doc(501, { amountCents: 300_000, semantic: etat([effet({ amountMinor: 300_000 })]) }),
      doc(502, { amountCents: 90_000, title: 'Acompte', semantic: etat([effet({ reviewId: 4, amountMinor: 90_000, outcome: 'REPRESENTED', role: 'REALIZED_COST', scope: 'DEPOSIT', representedBy: { key: 'f:501:REALIZED_COST:300000:EUR', lineId: 'doc:501', label: 'Facture', source: 'DOCUMENT', fileId: 501 } })]) }),
    ]);
    expect(ligne(t, 502)).toMatchObject({ status: 'INCLUDED_IN_TOTAL', reason: 'INCLUDED_IN_TOTAL_INVOICE', duplicateOf: 'doc:501', includedCents: 0 });
    expect(ligne(t, 501).includedCents).toBe(300_000);
  });

  it('L113AL-U-ENGINE-06 (recette 6) — document multibiens sans ventilation prouvée : non attribué, jamais réparti', () => {
    const t = base([doc(601, { amountCents: 80_000, linkedAssetIds: [BIEN, 33], semantic: etat([effet({ amountMinor: 80_000, allocation: 'NOT_ALLOCATED' })]) })]);
    expect(ligne(t, 601)).toMatchObject({ status: 'UNALLOCATED', includedCents: 0 });
  });

  it('L113AL-U-ENGINE-07 (recette 7) — décision de l’utilisateur prime ; une preuve nouvelle contraire est signalée, jamais effacée', () => {
    const d = doc(355, { amountCents: 134_000 });
    const cle = tcoLineKeys(ligne(base([d]), 355)).primary;
    const choix: TcoUserDecision = { key: cle, decision: 'CONFIRM_EXCLUSION', decidedAt: '2026-11-01T10:00:00.000Z', decidedByUserId: 7, basisStatus: 'NOT_QUALIFIED', basisReason: 'THEME_UNKNOWN' };
    const t = base([{ ...d, semantic: etat([effet({})]) }], { userDecisions: [choix] });
    expect(ligne(t, 355)).toMatchObject({ status: 'EXCLUDED', reason: 'USER_EXCLUDED', includedCents: 0, userDecision: { decision: 'CONFIRM_EXCLUSION', applied: true, contradicted: true } });
  });

  it('L113AL-U-ENGINE-08 — abstention : « Nature à confirmer » avec trace, gestes de l’utilisateur du lot 111V proposés', () => {
    const t = base([doc(355, { amountCents: 134_000, semantic: etat([effet({ outcome: 'ABSTAIN', applied: false, role: null, confidence: 'ambiguous', reason: 'Nature non établie.' })]) })]);
    const l = ligne(t, 355);
    expect(l).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN', semantic: { state: 'ABSTAINED', reason: 'Nature non établie.' } });
    // Gestes 111V inchangés : « Ajouter au TCO » / « Pas une dépense du bien » (seul ce reliquat demande l'utilisateur).
    expect(tcoLineDecisionOptions(l, t.lines).map((o) => o.action)).toEqual(['INCLUDE', 'CONFIRM_EXCLUSION']);
    const attente = base([doc(355, { amountCents: 134_000, semantic: etat([], { awaiting: true }) })]);
    expect(ligne(attente, 355).semantic?.state).toBe('AWAITING');
  });

  it('L113AL-U-ENGINE-09 — fait représentant disparu : la ligne est rouverte (STALE), jamais un montant perdu en silence', () => {
    const t = base([doc(361, { amountCents: 28_900_000, semantic: etat([effet({ amountMinor: 28_900_000, outcome: 'REPRESENTED', representedBy: { key: FICHE, lineId: FICHE, label: 'Prix', source: 'ASSET_DATA', fileId: null } })]) })], { assetPrice: null });
    expect(ligne(t, 361)).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN', semantic: { state: 'STALE' } });
  });

  it('L113AL-U-ENGINE-10 (recette 8) — document ancien sans montant ni indice : montant de l’extract arbitré, aucun champ inventé', () => {
    const sans = base([doc(801)]);
    expect(sans.lines.filter((l) => l.fileId === 801)).toEqual([]);
    const t = base([doc(801, { semantic: etat([effet({ origin: 'EXTRACT', amountMinor: 42_000 })]) })]);
    expect(ligne(t, 801)).toMatchObject({ id: 'doc:801:t3:0', status: 'RETAINED_DIRECT', amountMinor: 42_000, includedCents: 42_000, provenance: 'T3' });
    const abst = base([doc(801, { semantic: etat([effet({ origin: 'EXTRACT', amountMinor: 42_000, outcome: 'ABSTAIN', applied: false })]) })]);
    expect(ligne(abst, 801)).toMatchObject({ id: 'doc:801:t3:0', status: 'NOT_QUALIFIED', includedCents: 0 });
  });

  it.each(['IMMOBILIER', 'VEHICULE', 'OBJET'])('L113AL-U-ENGINE-11 (recette 11) — %s : même comportement, aucune branche métier', (cat) => {
    const t = base([doc(355, { amountCents: 134_000, semantic: etat([effet({})]) })], { assetCategory: cat });
    expect(ligne(t, 355)).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 134_000 });
  });

  it('L113AL-U-ENGINE-12 — exclusion motivée par T3 : motif existant du moteur, rien n’est compté', () => {
    const t = base([doc(901, { amountCents: 12_000, semantic: etat([effet({ amountMinor: 12_000, outcome: 'EXCLUDE', role: null, exclusion: 'NOT_AN_EXPENSE' })]) })]);
    expect(ligne(t, 901)).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_EXPENSE_DOCUMENT', includedCents: 0 });
  });
});

describe('L113AL-U-TARGETS — montants à arbitrer, empreinte, capacité', () => {
  it('L113AL-U-TARGETS-01 — cibles : ligne non qualifiée sans décision ; extract sans ligne ; ligne d’abstention de l’extract garde son origine', () => {
    const t = computeTco(entree({ documents: [doc(355, { amountCents: 134_000 }), doc(801, { semantic: etat([effet({ origin: 'EXTRACT', amountMinor: 42_000, outcome: 'ABSTAIN', applied: false })]) })] }));
    const c = qualificationTargets(t, [{ fileId: 900, amounts: [{ amountMinor: 1_000, currency: 'EUR', quote: 'Total 10,00 €' }] }]);
    expect(c.map((x) => [x.fileId, x.amounts.map((a) => [a.origin, a.amountMinor])])).toEqual([
      [355, [['LINE', 134_000]]], [801, [['EXTRACT', 42_000]]], [900, [['EXTRACT', 1_000]]],
    ]);
  });

  it('L113AL-U-TARGETS-02 — empreinte stable (ordre indifférent), changée par une preuve pertinente', () => {
    const a = [{ amountMinor: 1, currency: 'eur' }, { amountMinor: 2, currency: 'EUR' }];
    const k = [{ key: 'x', amountMinor: 3 }, { key: 'y', amountMinor: 4 }];
    const f = qualificationFingerprint({ fileId: 1, docVersion: 'v1', amounts: a, counted: k });
    expect(qualificationFingerprint({ fileId: 1, docVersion: 'v1', amounts: [...a].reverse(), counted: [...k].reverse() })).toBe(f);
    expect(qualificationFingerprint({ fileId: 1, docVersion: 'v2', amounts: a, counted: k })).not.toBe(f);
    expect(qualificationFingerprint({ fileId: 1, docVersion: 'v1', amounts: a, counted: [k[0]] })).not.toBe(f);
  });

  it('L113AL-U-TARGETS-03 — capacité : branche ET marqueur exigés ; coupure d’urgence', () => {
    expect(qualificationCapabilityOf({ text: `x ${ECONOMIC_QUALIFICATION_CONTRACT_VERSION}`, version: 'v', branches: ['ECONOMIC_QUALIFICATION'] })).toMatchObject({ available: true });
    expect(qualificationCapabilityOf({ text: 'x', version: 'v', branches: ['ECONOMIC_QUALIFICATION'] })).toMatchObject({ available: false, contractState: 'MARKER_MISSING' });
    expect(qualificationCapabilityOf({ text: ECONOMIC_QUALIFICATION_CONTRACT_VERSION, version: 'v', branches: [] })).toMatchObject({ available: false, contractState: 'BRANCH_MISSING' });
    expect(economicQualificationEnabled({})).toBe(true);
    expect(economicQualificationEnabled({ T3_ECONOMIC_QUALIFICATION_ENABLED: '0' })).toBe(false);
  });

  it('L113AL-U-TARGETS-04 — effet traité par le moteur (évaluateur du corpus)', () => {
    const e = (o: Partial<QualificationEffect>): QualificationEffect => ({ ...effet(o), amountRef: 'M1', fileId: 355, lineId: 'doc:355' } as QualificationEffect);
    expect(qualificationEffectStatus(contexte(), e({}))).toEqual({ status: 'ENGINE', reason: null });
    expect(qualificationEffectStatus(contexte(), e({ allocation: 'NOT_ALLOCATED' }))).toEqual({ status: 'UNALLOCATED', reason: null });
    expect(qualificationEffectStatus(contexte(), e({ outcome: 'REPRESENTED', role: 'PAYMENT' }))).toEqual({ status: 'PAYMENT', reason: 'PAYMENT_PROOF' });
    expect(qualificationEffectStatus(contexte(), e({ applied: false }))).toEqual({ status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN' });
  });
});
