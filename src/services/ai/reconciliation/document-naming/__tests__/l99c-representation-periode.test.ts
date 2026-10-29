/**
 * Lot 99C — représentation temporelle des titres de documents (contrat
 * `t3-naming-period-v1`, branche T3 DOCUMENT_NAMING).
 *
 *  L99C-U01  cas A à F du ticket (décision T3 simulée → validation serveur → titre composé) ;
 *  L99C-U02  R1 (aucune période inventée), R6 (aucune date artificielle), péremption d'une décision ;
 *  L99C-U03  repli prudent sans contrat : mois écrit, sinon période exacte, sinon rien — jamais le mois majoritaire ;
 *  L99C-U04  contrat de sortie : ancien format accepté, nouveau format, jugement monde fermé / doublon / oubli ;
 *  L99C-U05  contrat d'entrée : période, preuves, mois écrit, type, fournisseur, contrat, événement, titres de la série ;
 *  L99C-U06  guide du PO (étape 9) : bloc applicable au texte livré, contrôles BO, marqueur, exemple JSON passé au validateur réel ;
 *  L99C-U07  corpus de qualification (rôle answer) A à E + garde R1/R6, rejoués par l'évaluateur réel.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const period = await import('@/lib/documents/document-title-period');
const { principalMonthFromAnalysis, billedPeriodFromAnalysis, canonicalTitleKey } = await import('@/lib/documents/document-title-convention');
const { planBusinessTitle, periodFactsOf, titleContextFingerprint } = await import('@/services/ai/source-analysis/document-title');
const { billingBasisFrom, titleBasisRecord, namingPeriodDecisionsEnabled } = await import('@/services/documents/document-title.service');
const { T3DocumentNamingOutput, namingOutputComplete } = await import('../../master/t3-contract');
const pr = await import('../period-representation');
const model = await import('../model');
const { inspectMasterTemplate, renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { listMasterTasks } = await import('@/services/ai/registry/operations');

type Basis = import('@/services/ai/source-analysis/document-title').BillingBasis;
type Decision = import('@/lib/documents/document-title-period').StoredPeriodDecision;
type Target = import('../period-representation').PeriodTarget;

const NOW = new Date('2026-10-27T10:00:00.000Z');
const basis = (p: Partial<Basis> = {}): Basis => ({ billedPeriod: null, principalMonth: null, invoiceReferences: [], issueDate: null, ...p });
const periode = (start: string, end: string, source: 'T1_INSTALLMENT' | 'T1_BILLING_PERIOD' = 'T1_INSTALLMENT') => ({ start, end, source });
const plan = (b: Basis, supplier = 'Homiris', extra: Record<string, unknown> = {}) =>
  planBusinessTitle('Facture', { typeCode: 'FACTURE', supplier, billing: b, selfId: 1, ...extra });
const t1 = (mois: string, basisCode: string, quote = 'Abonnement février 2026') => principalMonthFromAnalysis({
  document: { billingPeriod: { start: null, end: null, principalMonth: mois, principalMonthBasis: basisCode, confidence: 'certain', evidence: { quote, page: 1 } } },
});
const cible = (id: number, b: Basis, supplier = 'Homiris'): Target => ({
  id, title: `Facture ${supplier} — ${id}`, typeCode: 'FACTURE', nature: 'Facture', supplier, issueDate: b.issueDate, facts: periodFactsOf(b),
});
/** Décision T3 simulée → jugement serveur → décision persistée (comme la phase). */
function decider(t: Target, d: Record<string, unknown>): { verdict: ReturnType<typeof pr.judgePeriodRepresentations>[number]; stored: Decision | null } {
  const out = T3DocumentNamingOutput.parse({ task: 'DOCUMENT_NAMING', document_renames: [], period_representations: [{ document_id: t.id, basis: 'X', reason: 'r', confidence: 'certain', evidence: [], ...d }] });
  const [verdict] = pr.judgePeriodRepresentations(out, [t], { promptVersion: 'v-test', traceId: 'tr', now: NOW });
  return { verdict, stored: verdict.decision };
}
const ev = (...sources: string[]) => sources.map((source) => ({ source, document_id: 1, quote: 'citation' }));

// ── L99C-U01 — cas A à F ───────────────────────────────────────────────────

describe('L99C-U01 — cas de recette A à F', () => {
  it('A — mensualité Homiris du 05/02 au 04/03 : décision T3 MONTH → « Facture Homiris — Février 2026 »', () => {
    const b = basis({ billedPeriod: periode('2026-02-05', '2026-03-04'), principalMonth: t1('2026-02', 'MAJORITY_OF_PERIOD', 'Période du 05/02/2026 au 04/03/2026'), issueDate: '2026-03-06' });
    const { verdict, stored } = decider(cible(1, b), { representation: 'MONTH', month: '2026-02', basis: 'MONTHLY_INSTALLMENT', evidence: ev('BILLED_PERIOD', 'CONTRACT', 'SERIES_TITLES') });
    expect(verdict.status).toBe('ACCEPTED');
    const p = plan({ ...b, periodDecision: stored });
    expect(p.title).toBe('Facture Homiris — Février 2026');
    expect(p.periodChoice).toMatchObject({ source: 'T3_DECISION', representation: 'MONTH', month: '2026-02', basis: 'MONTHLY_INSTALLMENT' });
    // Sans décision : le mois majoritaire n'impose rien (période exacte).
    expect(plan(b).title).toBe('Facture Homiris — 5 février au 4 mars 2026');
  });
  it('B — période du 18/01 au 17/03 sans mois écrit : jamais « Février 2026 » imposé ; une plage est retenue', () => {
    const b = basis({ billedPeriod: periode('2026-01-18', '2026-03-17'), principalMonth: t1('2026-02', 'MAJORITY_OF_PERIOD', 'du 18/01 au 17/03'), issueDate: '2026-03-20' });
    expect(plan(b, 'Jardins du Val').title).toBe('Facture Jardins du Val — 18 janvier au 17 mars 2026');
    const plage = decider(cible(2, b, 'Jardins du Val'), { representation: 'DATE_RANGE', start: '2026-01-18', end: '2026-03-17', basis: 'EXACT_PERIOD', evidence: ev('BILLED_PERIOD') });
    expect(plan({ ...b, periodDecision: plage.stored }, 'Jardins du Val').title).toBe('Facture Jardins du Val — 18 janvier au 17 mars 2026');
    const mois = decider(cible(2, b, 'Jardins du Val'), { representation: 'MULTI_MONTH', from_month: '2026-01', to_month: '2026-03', basis: 'MULTI_MONTH_SPAN', evidence: ev('BILLED_PERIOD') });
    expect(plan({ ...b, periodDecision: mois.stored }, 'Jardins du Val').title).toBe('Facture Jardins du Val — Janvier à mars 2026');
  });
  it('C — semestre du 01/01 au 30/06 : représentation multi-mois « Janvier à juin 2026 » (décision T3 ou repli exact)', () => {
    const b = basis({ billedPeriod: periode('2026-01-01', '2026-06-30'), issueDate: '2025-12-15' });
    const d = decider(cible(3, b, 'Assur Habitat'), { representation: 'MULTI_MONTH', from_month: '2026-01', to_month: '2026-06', basis: 'MULTI_MONTH_SPAN', evidence: ev('BILLED_PERIOD') });
    expect(plan({ ...b, periodDecision: d.stored }, 'Assur Habitat').title).toBe('Facture Assur Habitat — Janvier à juin 2026');
    expect(plan(b, 'Assur Habitat').title).toBe('Facture Assur Habitat — Janvier à juin 2026');
    expect(plan(b, 'Assur Habitat').periodChoice).toMatchObject({ source: 'EXACT_PERIOD', representation: 'MULTI_MONTH' });
  });
  it('D — « Abonnement février 2026 », période du 05/02 au 04/03 : février privilégié (avec ou sans décision T3)', () => {
    const b = basis({ billedPeriod: periode('2026-02-05', '2026-03-04'), principalMonth: t1('2026-02', 'STATED_ON_DOCUMENT') });
    expect(plan(b).title).toBe('Facture Homiris — Février 2026');
    expect(plan(b).periodChoice).toMatchObject({ source: 'STATED_MONTH', evidence: [{ source: 'STATED_MONTH', quote: 'Abonnement février 2026' }] });
    const d = decider(cible(4, b), { representation: 'MONTH', month: '2026-02', basis: 'STATED_ON_DOCUMENT', evidence: ev('STATED_MONTH') });
    expect(plan({ ...b, periodDecision: d.stored }).title).toBe('Facture Homiris — Février 2026');
  });
  it('E — série mensuelle du 5 au 4 : titres homogènes par mois métier (Janvier, Février, Mars 2026), groupes canoniques distincts', () => {
    const mois = [['2026-01-05', '2026-02-04', '2026-01', 'Janvier 2026'], ['2026-02-05', '2026-03-04', '2026-02', 'Février 2026'], ['2026-03-05', '2026-04-04', '2026-03', 'Mars 2026']];
    const titres = mois.map(([s, e, m], i) => {
      const b = basis({ billedPeriod: periode(s, e), invoiceReferences: [`F-${i}`] });
      const d = decider(cible(10 + i, b), { representation: 'MONTH', month: m, basis: 'SERIES_CONSISTENCY', evidence: ev('BILLED_PERIOD', 'SERIES_TITLES') });
      return plan({ ...b, periodDecision: d.stored }, 'Homiris', { selfId: 10 + i });
    });
    expect(titres.map((t) => t.title)).toEqual(mois.map(([, , , l]) => `Facture Homiris — ${l}`));
    expect(new Set(titres.map((t) => t.canonicalKey)).size).toBe(3);
    expect(titres[1].canonicalKey).toBe(canonicalTitleKey('Facture', 'Homiris', 'Février 2026'));
  });
  it('F — titre corrigé par l’utilisateur : aucune décision prise ni écrite (R7, sélection et compare-and-set SYSTEM seulement)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/ai/reconciliation/document-naming/period-repres' + 'entation.ts'), 'utf-8');
    // Sélection des documents à décider et écriture : titre SYSTÈME, marque historique absente.
    expect(src.match(/title_source = 'SYSTEM'/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src).toContain("COALESCE((f.user_edited_fields ->> 'retainedTitle') = 'true', false) = false");
    // Le service de nommage ne touche jamais un titre USER (lot 33C/87D) : vérifié par l'e2e L99C-E2E-F.
  });
  it('NONE — la période n’aide pas : « Facture Homiris » (convention conservée, désambiguïsation possible)', () => {
    const b = basis({ billedPeriod: periode('2026-02-05', '2026-03-04') });
    const d = decider(cible(5, b), { representation: 'NONE', basis: 'NOT_DISCRIMINANT' });
    const p = plan({ ...b, periodDecision: d.stored });
    expect(p.title).toBe('Facture Homiris');
    expect(p.convention).toBe('PERIODIC');
    expect(p.periodChoice).toMatchObject({ source: 'T3_DECISION', representation: 'NONE', label: null });
  });
});

// ── L99C-U02 — R1, R6, péremption ─────────────────────────────────────────

describe('L99C-U02 — validation serveur (R1, R6) et péremption', () => {
  const b = basis({ billedPeriod: periode('2026-02-05', '2026-03-04'), issueDate: '2026-04-02' });
  const f = periodFactsOf(b);
  it('R1 — mois, plage ou mois de début / fin absents des données : PERIOD_INVENTED', () => {
    expect(period.validatePeriodChoice({ representation: 'MONTH', month: '2026-06', evidence: ev('BILLED_PERIOD') }, f)).toMatchObject({ ok: false, code: 'PERIOD_INVENTED' });
    expect(period.validatePeriodChoice({ representation: 'DATE_RANGE', start: '2026-02-01', end: '2026-02-28', evidence: ev('BILLED_PERIOD') }, f)).toMatchObject({ ok: false, code: 'PERIOD_INVENTED' });
    expect(period.validatePeriodChoice({ representation: 'MULTI_MONTH', fromMonth: '2026-01', toMonth: '2026-03', evidence: ev('BILLED_PERIOD') }, f)).toMatchObject({ ok: false, code: 'PERIOD_INVENTED' });
    expect(period.validatePeriodChoice({ representation: 'MULTI_MONTH', fromMonth: '2026-03', toMonth: '2026-02', evidence: ev('BILLED_PERIOD') }, f)).toMatchObject({ ok: false, code: 'NOT_A_RANGE' });
    expect(period.validatePeriodChoice({ representation: 'MONTH', month: '2026-02', evidence: ev('SERIES_TITLES') }, f)).toMatchObject({ ok: false, code: 'NO_EVIDENCE' });
    expect(period.validatePeriodChoice({ representation: 'MONTH', month: '2026-02', evidence: ev('BILLED_PERIOD') }, periodFactsOf(basis()))).toMatchObject({ ok: false, code: 'NOT_A_PERIODIC_DOCUMENT' });
  });
  it('R6 — date d’émission, d’import, du jour, d’échéance : ARTIFICIAL_DATE (fondement, preuve, ou mois venu de l’émission)', () => {
    for (const s of ['ISSUE_DATE', 'IMPORT_DATE', 'TODAY', 'DUE_DATE']) {
      expect(period.validatePeriodChoice({ representation: 'MONTH', month: '2026-02', evidence: ev('BILLED_PERIOD', s) }, f), s).toMatchObject({ ok: false, code: 'ARTIFICIAL_DATE' });
    }
    expect(period.validatePeriodChoice({ representation: 'MONTH', month: '2026-02', basis: 'ISSUE_DATE', evidence: ev('BILLED_PERIOD') }, f)).toMatchObject({ ok: false, code: 'ARTIFICIAL_DATE' });
    expect(period.validatePeriodChoice({ representation: 'MONTH', month: '2026-04', evidence: ev('BILLED_PERIOD') }, f)).toMatchObject({ ok: false, code: 'ARTIFICIAL_DATE' });
    expect(period.validatePeriodChoice({ representation: 'MONTH', month: '2026-02', evidence: ev('INVENTÉE') }, f)).toMatchObject({ ok: false, code: 'INVALID_EVIDENCE' });
    expect(period.validatePeriodChoice({ representation: 'MONTH', month: '2026-02', confidence: 'conflictual', evidence: ev('BILLED_PERIOD') }, f)).toMatchObject({ ok: false, code: 'LOW_CONFIDENCE' });
  });
  it('décision prise sur d’autres faits (nouvelle analyse) : ignorée, repli prudent, motif tracé', () => {
    const d = decider(cible(6, b), { representation: 'MONTH', month: '2026-02', basis: 'MONTHLY_INSTALLMENT', evidence: ev('BILLED_PERIOD') }).stored!;
    const autre = basis({ billedPeriod: periode('2026-02-06', '2026-03-05'), periodDecision: d });
    expect(plan(autre).title).toBe('Facture Homiris — 6 février au 5 mars 2026');
    expect(plan(autre).periodChoice).toMatchObject({ source: 'EXACT_PERIOD', decisionIgnored: 'STALE_INPUTS' });
    // Faits relus d'un JSONB : ordre des clés quelconque, décision toujours valable pour les mêmes faits.
    const relu = { ...d, inputs: { statedMonth: null, end: '2026-03-04', start: '2026-02-05' } } as Decision;
    expect(plan({ ...b, periodDecision: relu }).periodChoice).toMatchObject({ source: 'T3_DECISION' });
  });
  it('décision refusée persistée : jamais appliquée', () => {
    const { verdict, stored } = decider(cible(7, b), { representation: 'MONTH', month: '2026-04', basis: 'MONTHLY_INSTALLMENT', evidence: ev('BILLED_PERIOD') });
    expect(verdict).toMatchObject({ status: 'REFUSED', code: 'ARTIFICIAL_DATE' });
    expect(stored).toMatchObject({ status: 'REFUSED', refusal: 'ARTIFICIAL_DATE', inputs: { start: '2026-02-05', end: '2026-03-04', statedMonth: null } });
    expect(plan({ ...b, periodDecision: stored }).periodChoice).toMatchObject({ source: 'EXACT_PERIOD', decisionIgnored: 'REFUSED ARTIFICIAL_DATE' });
  });
  it('coupure d’urgence `T3_NAMING_PERIOD_ENABLED=0`', () => {
    expect(namingPeriodDecisionsEnabled({})).toBe(true);
    expect(namingPeriodDecisionsEnabled({ T3_NAMING_PERIOD_ENABLED: '0' })).toBe(false);
  });
});

// ── L99C-U03 — repli prudent ──────────────────────────────────────────────

describe('L99C-U03 — repli prudent (prompt T3 sans le contrat) : aucune règle « mois majoritaire »', () => {
  it('mois seulement s’il est écrit (preuve citée) ; un mois « écrit » sans citation n’est pas une preuve', () => {
    expect(periodFactsOf(basis({ principalMonth: t1('2026-02', 'STATED_ON_DOCUMENT') })).statedMonth).toEqual({ value: '2026-02', quote: 'Abonnement février 2026' });
    expect(periodFactsOf(basis({ principalMonth: t1('2026-02', 'STATED_ON_DOCUMENT', '') })).statedMonth).toBeNull();
    expect(periodFactsOf(basis({ principalMonth: t1('2026-02', 'MAJORITY_OF_PERIOD') }))).toMatchObject({ statedMonth: null, monthHint: { value: '2026-02', basis: 'MAJORITY_OF_PERIOD' } });
  });
  it('mois majoritaire (même très majoritaire) : période exacte ; aucune période : pas de convention', () => {
    const b = basis({ billedPeriod: periode('2026-02-01', '2026-03-02'), principalMonth: t1('2026-02', 'MAJORITY_OF_PERIOD') });
    expect(plan(b).title).toBe('Facture Homiris — 1er février au 2 mars 2026');
    expect(plan(basis({ principalMonth: t1('2026-02', 'MAJORITY_OF_PERIOD') })).convention).toBeNull();
    expect(plan(basis({ issueDate: '2026-02-06' })).convention).toBeNull();
  });
  it('aucun calcul de jours par mois dans le nommage (ni règle « > 50 % »)', () => {
    for (const f of ['src/lib/documents/document-title-period.ts', 'src/services/ai/source-analysis/document-title.ts', 'src/lib/documents/document-title-convention.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf-8');
      expect(src, f).not.toMatch(/0\.5\b|50\s*%\s*des jours|joursParMois|daysInMonth\(/);
    }
  });
  it('T1 conserve l’extraction de la période facturée : `billingPeriod.start/end` lus, à défaut de toute autre période', () => {
    const run = { document: { billingPeriod: { start: '2026-01-01', end: '2026-06-30', principalMonth: null, principalMonthBasis: null, confidence: 'probable', evidence: { quote: 'Du 1er janvier au 30 juin 2026', page: 1 } } } };
    expect(billedPeriodFromAnalysis(run)).toEqual({ start: '2026-01-01', end: '2026-06-30', quote: 'Du 1er janvier au 30 juin 2026' });
    expect(billingBasisFrom({ candidatePayloads: [], factPeriods: [], analysisResult: run, issueDate: null }).billedPeriod).toEqual({ start: '2026-01-01', end: '2026-06-30', source: 'T1_BILLING_PERIOD' });
    // Ambiguïté entre échéances : jamais tranchée par la période T1.
    const deux = [{ financialHints: [{ amountScope: 'INSTALLMENT', periodStart: '2026-01-01', periodEnd: '2026-01-31' }, { amountScope: 'INSTALLMENT', periodStart: '2026-02-01', periodEnd: '2026-02-28' }] }];
    expect(billingBasisFrom({ candidatePayloads: deux, factPeriods: [], analysisResult: run, issueDate: null }).billedPeriod).toBeNull();
    expect(billedPeriodFromAnalysis({ document: { billingPeriod: { ...run.document.billingPeriod, confidence: 'conflictual' } } })).toBeNull();
  });
  it('données de nommage (diagnostic) : représentation retenue, source, preuves ; empreinte inchangée hors décision T3', () => {
    const b = basis({ billedPeriod: periode('2026-02-05', '2026-03-04'), principalMonth: t1('2026-02', 'STATED_ON_DOCUMENT') });
    const r = titleBasisRecord(plan(b), b, 'Homiris');
    expect(r).toMatchObject({ v: 2, statedMonth: '2026-02', periodRepresentation: { representation: 'MONTH', source: 'STATED_MONTH', decidedBy: 'RULE', label: 'Février 2026' } });
    const d = decider(cible(8, b), { representation: 'MONTH', month: '2026-02', basis: 'STATED_ON_DOCUMENT', evidence: ev('STATED_MONTH') }).stored!;
    const avecT3 = titleBasisRecord(plan({ ...b, periodDecision: d }), { ...b, periodDecision: d }, 'Homiris');
    expect(avecT3).toMatchObject({ periodRepresentation: { source: 'T3_DECISION', decidedBy: 'T3', promptVersion: 'v-test', traceId: 'tr', evidence: [{ source: 'STATED_MONTH' }] } });
    // Même titre, mais décision T3 : empreinte distincte (traçabilité) ; sans décision : formule 87D inchangée.
    expect(titleContextFingerprint(plan({ ...b, periodDecision: d }))).not.toBe(titleContextFingerprint(plan(b)));
  });
});

// ── L99C-U04 — contrat de sortie et jugement ──────────────────────────────

describe('L99C-U04 — contrat de sortie DOCUMENT_NAMING étendu', () => {
  it('ancien format accepté tel quel ; nouveau format accepté ; section facultative', () => {
    const ancien = T3DocumentNamingOutput.parse({ task: 'DOCUMENT_NAMING', families: [], document_renames: [] });
    expect(ancien.period_representations).toBeUndefined();
    expect(namingOutputComplete(ancien)).toBe(true);
    const neuf = T3DocumentNamingOutput.parse({ task: 'DOCUMENT_NAMING', document_renames: [], period_representations: [{ document_id: 1, representation: 'MONTH', month: '2026-02', basis: 'MONTHLY_INSTALLMENT', reason: 'r', confidence: 'certain' }] });
    expect(neuf.period_representations?.[0].evidence).toEqual([]);
    expect(() => T3DocumentNamingOutput.parse({ task: 'DOCUMENT_NAMING', period_representations: [{ document_id: 1, representation: 'WEEK', basis: 'x', reason: 'r', confidence: 'certain' }] })).toThrow();
    expect(() => T3DocumentNamingOutput.parse({ task: 'DOCUMENT_NAMING', period_representations: [{ document_id: 1, representation: 'MONTH', month: '02/2026', basis: 'x', reason: 'r', confidence: 'certain' }] })).toThrow();
  });
  it('monde fermé, doublon, document oublié : refus explicites ; seuls les documents fournis sont mémorisés', () => {
    const b = basis({ billedPeriod: periode('2026-02-05', '2026-03-04') });
    const out = T3DocumentNamingOutput.parse({ task: 'DOCUMENT_NAMING', document_renames: [], period_representations: [
      { document_id: 1, representation: 'MONTH', month: '2026-02', basis: 'MONTHLY_INSTALLMENT', evidence: ev('BILLED_PERIOD'), reason: 'r', confidence: 'certain' },
      { document_id: 1, representation: 'NONE', basis: 'NOT_DISCRIMINANT', reason: 'r', confidence: 'certain' },
      { document_id: 99, representation: 'NONE', basis: 'NOT_DISCRIMINANT', reason: 'r', confidence: 'certain' },
    ] });
    const v = pr.judgePeriodRepresentations(out, [cible(1, b), cible(2, b)], { promptVersion: 'v', traceId: null, now: NOW });
    expect(v.map((x) => [x.documentId, x.status === 'ACCEPTED' ? 'ACCEPTED' : x.code])).toEqual([[1, 'ACCEPTED'], [1, 'DUPLICATE_DECISION'], [99, 'UNKNOWN_DOCUMENT'], [2, 'NO_DECISION']]);
    expect(v.filter((x) => x.decision).map((x) => x.documentId)).toEqual([1, 2]);
  });
  it('marqueur du prompt et déclaration du contrat (point de raccord du registre)', () => {
    expect(model.promptCarriesNamingPeriod('… t3-naming-period-v1 …')).toBe(true);
    expect(model.promptCarriesNamingPeriod('BRANCHE TASK = DOCUMENT_NAMING')).toBe(false);
    expect(model.T3_NAMING_PERIOD_PROMPT_CONTRACT).toMatchObject({ marker: 't3-naming-period-v1', guide: { blockId: 't3-naming-period-v1', step: 9 }, operationCode: 't3_document_naming', task: 'DOCUMENT_NAMING' });
  });
});

// ── L99C-U05 — contrat d'entrée ───────────────────────────────────────────

describe('L99C-U05 — contrat d’entrée (variables de production)', () => {
  const b = basis({ billedPeriod: periode('2026-02-05', '2026-03-04'), principalMonth: t1('2026-02', 'MAJORITY_OF_PERIOD', 'du 05/02 au 04/03'), issueDate: '2026-03-06' });
  const vars = pr.periodRepresentationVariables({
    series: { nature: 'Facture', supplier: 'Homiris', members: [
      { id: 40, title: 'Facture Homiris — Janvier 2026', titleOrigin: 'USER', billedPeriod: { start: '2026-01-05', end: '2026-02-04' }, statedMonth: null, representation: null },
    ] },
    targets: [cible(41, b)],
    details: new Map([[41, { facts: [{ key: 'contractNumber', value: 'HOM-778' }], excerpt: 'Abonnement télésurveillance', operations: [{ id: 7, type: 'SUBSCRIPTION', status: 'ACTIVE', contractReference: 'HOM-778' }], history: [], contracts: [{ reference: 'HOM778', source: 'T1_FACT' }] }]]),
  });
  it('six emplacements T3 ; mode, contrat, titres comparables de la série, contraintes R1/R5/R6/R7', () => {
    expect(Object.keys(vars).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    const s = JSON.parse(String(vars.SUBJECT_CONTEXT));
    expect(s).toMatchObject({ mode: 'PERIOD_REPRESENTATION', contract: 't3-naming-period-v1', series: { supplier: 'Homiris', comparableTitles: [{ documentId: 40, title: 'Facture Homiris — Janvier 2026', titleOrigin: 'USER' }] } });
    expect(s.constraints).toMatchObject({ majorityMonthIsOnlyAHint: true, userTitlesAreNeverRenamed: true });
    expect(s.constraints.forbiddenPeriodSources).toEqual(expect.arrayContaining(['ISSUE_DATE', 'IMPORT_DATE', 'TODAY', 'DUE_DATE']));
  });
  it('par facture : période facturée et provenance, mois écrit, indice, type, fournisseur, contrat, événement de référence', () => {
    const [c] = vars.CANDIDATES as Array<Record<string, unknown>>;
    expect(c).toMatchObject({
      documentId: 41, role: 'TO_EXAMINE', documentType: 'FACTURE', supplier: 'Homiris', issueDate: '2026-03-06',
      billingPeriod: { start: '2026-02-05', end: '2026-03-04', source: 'T1_INSTALLMENT' }, statedMonth: null, monthHint: { value: '2026-02', basis: 'MAJORITY_OF_PERIOD' },
      contracts: [{ reference: 'HOM778' }], operations: [{ id: 7, contractReference: 'HOM-778' }],
    });
    expect(String(vars.RELATION_TYPE)).toContain('PERIOD_REPRESENTATION');
  });
});

// ── L99C-U06 — guide du PO, étape 9 ───────────────────────────────────────

const RACINE = process.cwd();
const GUIDE = readFileSync(join(RACINE, 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'), 'utf-8');
const T3_LIVRE = readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'reconciliation', 't3_master_v1.txt'), 'utf-8');
const bloc9 = (() => {
  const m = /<!-- l89c:bloc ([^>]*?id="t3-naming-period-v1"[^>]*?) -->\s*\n```text\n([\s\S]*?)\n```/.exec(GUIDE);
  if (!m) throw new Error('bloc 9 absent du guide');
  const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
  return { attrs, text: m[2] };
})();
const occurrences = (t: string, m: string) => t.split(m).length - 1;
function jsonsDe(texte: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const lignes = texte.split('\n');
  for (let k = 0; k < lignes.length; k++) {
    if (!lignes[k].startsWith('{')) continue;
    const reste = lignes.slice(k).join('\n');
    let prof = 0; let chaine = false; let echap = false; let fin = -1;
    for (let c = 0; c < reste.length; c++) {
      const ch = reste[c];
      if (chaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') chaine = false; continue; }
      if (ch === '"') chaine = true; else if (ch === '{') prof += 1; else if (ch === '}') { prof -= 1; if (prof === 0) { fin = c; break; } }
    }
    const brut = reste.slice(0, fin + 1);
    out.push(JSON.parse(brut));
    k += brut.split('\n').length - 1;
  }
  return out;
}

describe('L99C-U06 — guide du PO : étape 9 (bloc T3 `t3-naming-period-v1`)', () => {
  expect(bloc9.attrs).toMatchObject({ prompt: 't3', action: 'insert-before', anchor: 'SORTIE DOCUMENT_NAMING' });
  expect(occurrences(T3_LIVRE, bloc9.attrs.anchor)).toBe(1);
  const T3_ETAPE9 = T3_LIVRE.replace(bloc9.attrs.anchor, `${bloc9.text}\n\n${bloc9.attrs.anchor}`);
  it('marqueur lu dans le texte modifié, absent du texte livré ; aucun emplacement, aucune branche ajoutée ; ligne repère toujours unique', () => {
    expect(model.promptCarriesNamingPeriod(T3_ETAPE9)).toBe(true);
    expect(model.promptCarriesNamingPeriod(T3_LIVRE)).toBe(false);
    expect(inspectMasterTemplate(bloc9.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(T3_ETAPE9).branches).toEqual(inspectMasterTemplate(T3_LIVRE).branches);
    expect(occurrences(T3_ETAPE9, bloc9.attrs.anchor)).toBe(1);
    // Le bloc reste DANS la section DOCUMENT_NAMING (entre son titre et sa sortie).
    const i = T3_ETAPE9.indexOf('BRANCHE TASK = DOCUMENT_NAMING');
    expect(T3_ETAPE9.indexOf('REPRÉSENTATION TEMPORELLE DES TITRES')).toBeGreaterThan(i);
    expect(T3_ETAPE9.indexOf('REPRÉSENTATION TEMPORELLE DES TITRES')).toBeLessThan(T3_ETAPE9.indexOf('SORTIE DOCUMENT_NAMING'));
  });
  it('contrôles d’activation du BO : aucun bloquant, aucun avertissement nouveau', () => {
    expect(checkMasterPromptContent('T3', T3_ETAPE9).blocking).toEqual([]);
    expect(checkMasterPromptContent('T3', T3_ETAPE9).warnings.map((w) => w.code)).toEqual(checkMasterPromptContent('T3', T3_LIVRE).warnings.map((w) => w.code));
  });
  it('rendu réel de la branche DOCUMENT_NAMING avec les variables de production du mode PERIOD_REPRESENTATION', () => {
    const b = basis({ billedPeriod: periode('2026-02-05', '2026-03-04') });
    const variables = pr.periodRepresentationVariables({ series: { nature: 'Facture', supplier: 'Homiris', members: [] }, targets: [cible(41, b)] });
    const rendu = renderMasterPrompt(T3_ETAPE9, { masterPromptCode: 't3_master_v1', task: 'DOCUMENT_NAMING', variables, allowedTasks: listMasterTasks('t3_master_v1') });
    expect(rendu).toContain('t3-naming-period-v1');
    expect(rendu).toContain('"mode":"PERIOD_REPRESENTATION"');
  });
  it('exemple JSON : schéma réel, puis validation serveur réelle — trois décisions acceptées, titres composés', () => {
    const [exemple] = jsonsDe(bloc9.text);
    const out = T3DocumentNamingOutput.parse(exemple);
    const cibles = [
      cible(41, basis({ billedPeriod: periode('2026-02-05', '2026-03-04'), issueDate: '2026-03-06' })),
      cible(42, basis({ billedPeriod: periode('2026-01-18', '2026-03-17'), issueDate: '2026-03-20' }), 'Jardins du Val'),
      cible(43, basis({ billedPeriod: periode('2026-01-01', '2026-06-30'), issueDate: '2025-12-15' }), 'Assur Habitat'),
    ];
    const v = pr.judgePeriodRepresentations(out, cibles, { promptVersion: 'v', traceId: null, now: NOW });
    expect(v.map((x) => x.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    const titres = v.map((x, i) => plan({ ...basis({ billedPeriod: cibles[i].facts.billedPeriod as never }), periodDecision: x.decision }, cibles[i].supplier).title);
    expect(titres).toEqual(['Facture Homiris — Février 2026', 'Facture Jardins du Val — 18 janvier au 17 mars 2026', 'Facture Assur Habitat — Janvier à juin 2026']);
  });
  it('le guide cite le marqueur, la coupure d’urgence, la migration, les cas de recette et le diagnostic', () => {
    for (const m of [period.T3_NAMING_PERIOD_CONTRACT, 'T3_NAMING_PERIOD_ENABLED', 'T3_NAMING_PERIOD_MAX_CALLS_PER_PASS', 'title_period_decision', 'periodRepresentation', 'P-T3-18', 'P-T3-22', '| 9 | 99C']) expect(GUIDE, m).toContain(m);
  });
});

// ── L99C-U07 — corpus de qualification ────────────────────────────────────

describe('L99C-U07 — corpus DOCUMENT_NAMING (rôle answer A à E, garde R1/R6) rejoué par l’évaluateur réel', async () => {
  const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
  const { evaluateCorpusOutput } = await import('@/services/ai/governance/master-corpus/runner');
  const { liveVariablesFor } = await import('@/services/ai/governance/master-corpus/live');
  const cas = loadMasterCorpusCases(readMasterFileFromRepo).filter((c) => /^P-T3-(1[89]|2[0-3])$/.test(c.id));
  it('six cas : A à E en rôle answer (attendus), la garde en rôle guard', () => {
    expect(cas.map((c) => [c.id, c.qualificationRole])).toEqual([
      ['P-T3-18', 'answer'], ['P-T3-19', 'answer'], ['P-T3-20', 'answer'], ['P-T3-21', 'answer'], ['P-T3-22', 'answer'], ['P-T3-23', 'guard'],
    ]);
  });
  it('sorties enregistrées : vertes (schéma + validation serveur) ; variables réelles constructibles', async () => {
    for (const c of cas) {
      const r = await evaluateCorpusOutput(c, c.output, readMasterFileFromRepo(c.masterPromptCode), readMasterFileFromRepo);
      expect(r.errors, c.id).toEqual([]);
      const v = await liveVariablesFor(c);
      expect(JSON.parse(String(v?.SUBJECT_CONTEXT)).mode, c.id).toBe('PERIOD_REPRESENTATION');
    }
  });
  it('une réponse fautive est détectée : mois imposé à la plage (B), mois de l’émission (A), section absente avec le marqueur', async () => {
    const b = cas.find((c) => c.id === 'P-T3-19')!;
    const fauteB = { task: 'DOCUMENT_NAMING', document_renames: [], period_representations: [{ document_id: 1901, representation: 'MONTH', month: '2026-02', basis: 'MONTHLY_INSTALLMENT', evidence: [{ source: 'MONTH_HINT' }, { source: 'BILLED_PERIOD' }], reason: 'majorité', confidence: 'certain' }] };
    expect((await evaluateCorpusOutput(b, fauteB, readMasterFileFromRepo('t3_master_v1'), readMasterFileFromRepo)).errors.join(' ')).toMatch(/MONTH ∉ DATE_RANGE \| MULTI_MONTH|libellé interdit/);
    const a = cas.find((c) => c.id === 'P-T3-18')!;
    const fauteA = { task: 'DOCUMENT_NAMING', document_renames: [], period_representations: [{ document_id: 1802, representation: 'MONTH', month: '2026-03', basis: 'X', evidence: [{ source: 'ISSUE_DATE' }], reason: 'émise en mars', confidence: 'certain' }] };
    expect((await evaluateCorpusOutput(a, fauteA, readMasterFileFromRepo('t3_master_v1'), readMasterFileFromRepo)).errors.join(' ')).toMatch(/ARTIFICIAL_DATE/);
    const vide = { task: 'DOCUMENT_NAMING', document_renames: [] };
    expect((await evaluateCorpusOutput(a, vide, 'BRANCHE TASK = DOCUMENT_NAMING t3-naming-period-v1', readMasterFileFromRepo)).errors.join(' ')).toMatch(/period_representations absente/);
    // Prompt sans le contrat : jamais appelé dans ce mode — l'absence de section n'est pas un écart.
    expect((await evaluateCorpusOutput(a, vide, readMasterFileFromRepo('t3_master_v1'), readMasterFileFromRepo)).errors).toEqual([]);
  });
});
