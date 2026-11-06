/**
 * Lot 112D — capital restant dû d'un financement (TCO) : calcul exact, preuves, résolution, saisie.
 *
 *   L112D-AMO-*  moteur d'amortissement exact (centimes, sans arrondi intermédiaire, différé, taux 0,
 *                remboursement anticipé, avenant, relevés, dates civiles Europe/Paris)
 *   L112D-EVI-*  lecture déterministe des faits / tableaux, contradictions, priorité USER / ADMIN
 *   L112D-OUT-*  résolution : établi (calculé, lu, saisi) ou « non établi » + ce qui manque ; synthèse
 *   L112D-API-*  validation du corps de la saisie
 */
import { describe, expect, it } from 'vitest';
import { addMonthsAnchored, computeAmortization, parseRatePct, type AmortizationTerms } from '../loan-amortization';
import { assembleLoanEvidence, parseEurAmountCents, readLoanFact, readLoanTable, type LoanFactInput, type LoanEvidence } from '../loan-evidence';
import { resolveOutstandingPrincipal, summarizeOutstanding, TCO_OUTSTANDING_NOT_ESTABLISHED } from '../outstanding-principal';
import { parseLoanTermsBody } from '../../financing/loan-terms-decisions';
import { civilDateParis } from '../../finance/engine';

const T = (o: Partial<AmortizationTerms> = {}): AmortizationTerms => ({
  principalCents: 100_000, ratePct: '12', periodicity: 'MONTHLY', durationMonths: 2, firstInstallmentDate: '2026-01-05', installmentCents: null, deferral: null, ...o,
});
const ok = (r: ReturnType<typeof computeAmortization>) => { if (!r.ok) throw new Error(`${r.code} ${r.detail}`); return r; };

/** Référence flottante indépendante (formule fermée) — contrôle à 1 centime près. */
function flottant(C: number, tauxAnnuelPct: number, n: number, k: number): number {
  const i = tauxAnnuelPct / 100 / 12;
  return (C * (Math.pow(1 + i, n) - Math.pow(1 + i, k))) / (Math.pow(1 + i, n) - 1);
}

describe('L112D-AMO — calcul exact', () => {
  it('L112D-AMO-01 — 1 000 € à 12 %/an sur 2 mois : CRD après la 1re échéance = 502,49 € exactement (un seul arrondi), soldé à la dernière', () => {
    expect(ok(computeAmortization(T(), [], '2026-01-04'))).toMatchObject({ cents: 100_000, asOf: null, installmentsElapsed: 0 });
    const r1 = ok(computeAmortization(T(), [], '2026-01-05'));
    expect(r1).toMatchObject({ cents: 50_249, asOf: '2026-01-05', installmentsElapsed: 1, installmentsTotal: 2, repaid: false, theoreticalInstallmentCents: 50_751, installmentSource: 'THEORETICAL' });
    expect(ok(computeAmortization(T(), [], '2026-02-05'))).toMatchObject({ cents: 0, repaid: true });
  });

  it('L112D-AMO-02 — prêt immobilier 200 000 € / 3 % / 240 mois : concorde à 1 centime avec la formule fermée, sans dérive sur 60 échéances', () => {
    const r = ok(computeAmortization(T({ principalCents: 20_000_000, ratePct: '3', durationMonths: 240, firstInstallmentDate: '2021-12-05' }), [], '2026-11-06'));
    expect(r.installmentsElapsed).toBe(60);
    expect(Math.abs(r.cents - flottant(20_000_000, 3, 240, 60))).toBeLessThanOrEqual(1);
    expect(r.theoreticalInstallmentCents).toBe(110_920); // 1 109,20 € (standard)
  });

  it('L112D-AMO-03 — échéance hors assurance lue : contrôlée (±1 centime) puis utilisée ; incohérente → INSTALLMENT_MISMATCH (jamais de valeur moyenne)', () => {
    expect(ok(computeAmortization(T({ installmentCents: 50_751 }), [], '2026-01-05'))).toMatchObject({ installmentSource: 'READ', installmentUsedCents: 50_751, cents: 50_249 });
    const ko = computeAmortization(T({ installmentCents: 50_000 }), [], '2026-01-05');
    expect(ko).toMatchObject({ ok: false, code: 'INSTALLMENT_MISMATCH', expectedInstallmentCents: 50_751 });
  });

  it('L112D-AMO-04 — taux 0 : échéance = capital / n ; 1 200 € sur 12 mois → 700 € après 5 échéances', () => {
    const r = ok(computeAmortization(T({ principalCents: 120_000, ratePct: '0', durationMonths: 12 }), [], '2026-05-05'));
    expect(r).toMatchObject({ cents: 70_000, installmentsElapsed: 5, theoreticalInstallmentCents: 10_000 });
    expect(ok(computeAmortization(T({ principalCents: 100_000, ratePct: '0,000', durationMonths: 3 }), [], '2026-01-05')).cents).toBe(66_667); // 666,666… → 666,67
  });

  it('L112D-AMO-05 — différé partiel (intérêts seuls) puis amortissement ; différé total (intérêts capitalisés)', () => {
    const partiel = T({ durationMonths: 4, deferral: { months: 2, kind: 'PARTIAL' } });
    expect(ok(computeAmortization(partiel, [], '2026-02-05')).cents).toBe(100_000);
    expect(ok(computeAmortization(partiel, [], '2026-03-05')).cents).toBe(50_249);
    expect(ok(computeAmortization(partiel, [], '2026-04-05'))).toMatchObject({ cents: 0, repaid: true });
    const total = T({ durationMonths: 4, deferral: { months: 2, kind: 'TOTAL' } });
    expect(ok(computeAmortization(total, [], '2026-02-05')).cents).toBe(102_010);
    expect(ok(computeAmortization(total, [], '2026-03-05')).cents).toBe(51_259);
    expect(computeAmortization(T({ durationMonths: 2, deferral: { months: 2, kind: 'PARTIAL' } }), [], '2026-03-05')).toMatchObject({ ok: false, code: 'DEFERRAL_TOO_LONG' });
  });

  it('L112D-AMO-06 — remboursement anticipé : durée réduite, nouvelle échéance, total ; mode inconnu → non établi', () => {
    const base = T({ principalCents: 120_000, ratePct: '0', durationMonths: 12 });
    const ra = (mode: 'REDUCED_DURATION' | 'NEW_INSTALLMENT' | null, cents = 30_000, newInstallmentCents: number | null = null) =>
      [{ kind: 'EARLY_REPAYMENT' as const, date: '2026-03-10', cents, mode, newInstallmentCents, ref: 'ra' }];
    expect(ok(computeAmortization(base, ra('REDUCED_DURATION'), '2026-05-05')).cents).toBe(40_000);
    expect(ok(computeAmortization(base, ra('NEW_INSTALLMENT', 30_000, 5_000), '2026-05-05'))).toMatchObject({ cents: 50_000, installmentUsedCents: 5_000 });
    expect(ok(computeAmortization(base, ra(null, 95_000), '2026-05-05'))).toMatchObject({ cents: 0, repaid: true, asOf: '2026-03-10' });
    expect(computeAmortization(base, ra(null), '2026-05-05')).toMatchObject({ ok: false, code: 'EARLY_REPAYMENT_MODE_UNKNOWN', at: '2026-03-10' });
    // Remboursement anticipé futur : sans effet aujourd'hui.
    expect(ok(computeAmortization(base, ra(null), '2026-03-09')).cents).toBe(90_000);
  });

  it('L112D-AMO-07 — avenant sans nouvelles conditions : calcul arrêté à sa date d\'effet (jamais prolongé)', () => {
    const base = T({ principalCents: 120_000, ratePct: '0', durationMonths: 12 });
    const av = [{ kind: 'SCHEDULE_CHANGE' as const, date: '2026-04-05', ref: 'av' }];
    expect(ok(computeAmortization(base, av, '2026-04-04')).cents).toBe(90_000);
    expect(computeAmortization(base, av, '2026-04-05')).toMatchObject({ ok: false, code: 'SCHEDULE_CHANGED', at: '2026-04-05' });
  });

  it('L112D-AMO-08 — relevé lu : concordant → le calcul repart de lui ; non concordant → BALANCE_MISMATCH', () => {
    const base = T({ principalCents: 120_000, ratePct: '0', durationMonths: 12 });
    const r = ok(computeAmortization(base, [{ kind: 'BALANCE', date: '2026-03-05', cents: 90_001, ref: 'b' }], '2026-04-05'));
    expect(r).toMatchObject({ cents: 80_001, lastBalanceRef: 'b' });
    expect(computeAmortization(base, [{ kind: 'BALANCE', date: '2026-03-05', cents: 60_000, ref: 'b' }], '2026-04-05')).toMatchObject({ ok: false, code: 'BALANCE_MISMATCH' });
  });

  it('L112D-AMO-09 — dates : échéance du jour échue ; 31 → dernier jour du mois (29/02 bissextile) ; jour civil Europe/Paris', () => {
    expect(addMonthsAnchored('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsAnchored('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsAnchored('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonthsAnchored('2026-11-30', 3)).toBe('2027-02-28');
    // 05/11/2026 23 h 30 UTC = 06/11/2026 00 h 30 à Paris : l'échéance du 06/11 est échue.
    const paris = civilDateParis(new Date('2026-11-05T23:30:00Z'));
    expect(paris).toBe('2026-11-06');
    const base = T({ principalCents: 120_000, ratePct: '0', durationMonths: 12, firstInstallmentDate: '2026-01-06' });
    expect(ok(computeAmortization(base, [], paris)).installmentsElapsed).toBe(11);
    expect(ok(computeAmortization(base, [], '2026-11-05')).installmentsElapsed).toBe(10);
    // Été (UTC+2) : 30/06 22 h 30 UTC = 01/07 à Paris.
    expect(civilDateParis(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01');
  });

  it('L112D-AMO-10 — conditions invalides : durée non multiple de la périodicité, taux hors bornes', () => {
    expect(computeAmortization(T({ periodicity: 'QUARTERLY', durationMonths: 10 }), [], '2026-06-01')).toMatchObject({ ok: false, code: 'DURATION_PERIODICITY' });
    expect(computeAmortization(T({ ratePct: '150' }), [], '2026-06-01')).toMatchObject({ ok: false, code: 'INVALID_TERMS' });
    expect(parseRatePct('3,250')?.text).toBe('3.25');
    expect(parseRatePct('1.5%')).toBeNull();
  });

  it('L112D-AMO-11 — trimestriel : taux proportionnel (taux / 4)', () => {
    // 1 000 € à 8 %/an trimestriel sur 6 mois (2 échéances, i = 2 %) : CRD après 1 = 1000·(1,0404 − 1,02)/(0,0404) = 504,95…
    const r = ok(computeAmortization(T({ ratePct: '8', periodicity: 'QUARTERLY', durationMonths: 6 }), [], '2026-01-05'));
    expect(r.cents).toBe(50_495);
  });
});

const fait = (o: Partial<LoanFactInput>): LoanFactInput => ({
  fileId: 7, factKey: 'x', rawKey: null, label: null, subject: null, attribute: null, valueText: null, valueNumber: null, valueUnit: null,
  normalizedValue: null, valueType: null, periodStart: null, periodEnd: null, excerpt: null, confidence: 'certain', ...o,
});

describe('L112D-EVI — preuves', () => {
  it('L112D-EVI-01 — montants français exacts ; devise étrangère et formes ambiguës refusées', () => {
    expect(parseEurAmountCents('182 345,67 €')).toBe(18_234_567);
    expect(parseEurAmountCents('182.345,67')).toBe(18_234_567);
    expect(parseEurAmountCents('1 234')).toBe(123_400);
    expect(parseEurAmountCents('12,5')).toBe(1_250);
    expect(parseEurAmountCents('1.234')).toBe(123_400);
    expect(parseEurAmountCents('100 USD')).toBeNull();
    expect(parseEurAmountCents('12,345,6')).toBeNull();
  });

  it('L112D-EVI-02 — faits : taux nominal lu, TAEG / taux d\'assurance / probable ignorés ; capital restant dû daté « au … »', () => {
    expect(readLoanFact(fait({ label: 'Taux nominal annuel fixe', valueText: '3,25 %' }))).toEqual([{ field: 'ratePct', value: '3.25' }]);
    expect(readLoanFact(fait({ label: 'TAEG', valueText: '3,90 %' }))).toEqual([]);
    expect(readLoanFact(fait({ label: 'Taux de l’assurance', valueText: '0,30 %' }))).toEqual([]);
    expect(readLoanFact(fait({ label: 'Taux nominal', valueText: '3,25 %', confidence: 'probable' }))).toEqual([]);
    expect(readLoanFact(fait({ label: 'Taux nominal', valueNumber: '0.0325' }))).toEqual([]); // sans « % » : ambigu
    expect(readLoanFact(fait({ label: 'Capital restant dû au 31/12/2025', valueText: '182 000,00 €' }))).toEqual([{ field: 'statement', date: '2025-12-31', cents: 18_200_000 }]);
    expect(readLoanFact(fait({ label: 'Capital restant dû', valueText: '182 000,00 €' }))).toEqual([]); // aucune date écrite : jamais la date du document
    expect(readLoanFact(fait({ label: 'Durée du prêt', valueText: '20 ans' }))).toEqual([{ field: 'durationMonths', value: 240 }]);
    expect(readLoanFact(fait({ label: 'Date de la première échéance', valueText: '05/12/2021' }))).toEqual([{ field: 'firstInstallmentDate', value: '2021-12-05' }]);
    expect(readLoanFact(fait({ label: 'Mensualité hors assurance', valueText: '1 109,20 €' }))).toEqual([{ field: 'periodicity', value: 'MONTHLY' }, { field: 'installmentCents', value: 110_920 }]);
    expect(readLoanFact(fait({ label: 'Mensualité', valueText: '1 159,20 €' }))).toEqual([{ field: 'periodicity', value: 'MONTHLY' }]);
    expect(readLoanFact(fait({ label: 'Différé d’amortissement' , valueText: 'oui' }))).toEqual([{ field: 'deferralMention' }]);
    expect(readLoanFact(fait({ label: 'Taux révisable', valueText: '2,1 %' }))).toEqual([{ field: 'variableRate' }]);
  });

  it('L112D-EVI-03 — clés stables du bloc PO (étape 21)', () => {
    expect(readLoanFact(fait({ rawKey: 'loan.nominal_rate_pct', valueNumber: '3.25' }))).toEqual([{ field: 'ratePct', value: '3.25' }]);
    expect(readLoanFact(fait({ rawKey: 'loan.duration_months', valueNumber: '240' }))).toEqual([{ field: 'durationMonths', value: 240 }]);
    expect(readLoanFact(fait({ rawKey: 'loan.outstanding_principal', valueType: 'money_cents', normalizedValue: '18200000', periodEnd: '2025-12-31' })))
      .toEqual([{ field: 'statement', date: '2025-12-31', cents: 18_200_000 }]);
    expect(readLoanFact(fait({ rawKey: 'loan.periodicity', valueText: 'MONTHLY' }))).toEqual([{ field: 'periodicity', value: 'MONTHLY' }]);
  });

  it('L112D-EVI-04 — tableau d\'amortissement : colonne CRD + dates ; tableau douteux ignoré', () => {
    const cells = [
      ['05/01/2026', '1 109,20', '182 000,00'], ['05/02/2026', '1 109,20', '181 345,12'],
    ].flatMap((r, row) => r.map((value, column) => ({ row, column, value, normalized: null, confidence: 'certain' })));
    const t = { fileId: 9, tableId: 3, uncertain: false, columns: ['Date d’échéance', 'Échéance', 'Capital restant dû'], cells };
    expect(readLoanTable(t)).toEqual([{ date: '2026-01-05', cents: 18_200_000, row: 0 }, { date: '2026-02-05', cents: 18_134_512, row: 1 }]);
    expect(readLoanTable({ ...t, uncertain: true })).toEqual([]);
    expect(readLoanTable({ ...t, columns: ['Date', 'Échéance', 'Intérêts'] })).toEqual([]);
  });

  it('L112D-EVI-05 — deux documents contradictoires : champ non établi ; saisie USER prioritaire ; échéance TTC − assurance', () => {
    const ev = assembleLoanEvidence({
      principal: { cents: 20_000_000, currency: 'EUR' },
      facts: [
        fait({ fileId: 1, label: 'Taux nominal', valueText: '3 %' }), fait({ fileId: 2, label: 'Taux nominal', valueText: '3,1 %' }),
        fait({ fileId: 1, label: 'Mensualité assurance comprise', valueText: '1 159,20 €' }), fait({ fileId: 1, label: 'Cotisation assurance mensuelle', valueText: '50,00 €' }),
      ],
      tables: [], manual: null,
    });
    expect(ev.terms.ratePct).toBeUndefined();
    expect(ev.conflicts.ratePct).toEqual(['3', '3.1']);
    expect(ev.terms.installmentCents).toMatchObject({ value: 110_920, origin: 'DOCUMENT' });
    expect(ev.terms.insuranceCents).toMatchObject({ value: 5_000 });
    const avecSaisie = assembleLoanEvidence({
      principal: { cents: 20_000_000, currency: 'EUR' }, facts: [fait({ fileId: 1, label: 'Taux nominal', valueText: '3 %' }), fait({ fileId: 2, label: 'Taux nominal', valueText: '3,1 %' })], tables: [],
      manual: { values: { ratePct: '3' }, origins: { ratePct: { origin: 'USER', at: null, userId: 1 } }, events: [] },
    });
    expect(avecSaisie.terms.ratePct).toEqual({ value: '3', origin: 'USER', fileIds: [] });
    expect(avecSaisie.conflicts.ratePct).toBeUndefined();
    // Capital en devise étrangère : jamais converti ici.
    expect(assembleLoanEvidence({ principal: { cents: 100, currency: 'CHF' }, facts: [], tables: [], manual: null }).terms.principalCents).toBeUndefined();
  });

  it('L112D-EVI-06 — relevés : à date égale une saisie prime ; deux documents en désaccord → ignorés', () => {
    const ev = assembleLoanEvidence({
      principal: { cents: null, currency: null },
      facts: [fait({ fileId: 1, label: 'Capital restant dû au 31/12/2025', valueText: '182 000 €' }), fait({ fileId: 2, label: 'Capital restant dû au 31/12/2025', valueText: '181 000 €' }),
        fait({ fileId: 1, label: 'Capital restant dû au 31/12/2024', valueText: '190 000 €' })],
      tables: [],
      manual: { values: {}, origins: {}, events: [{ id: 'a', kind: 'BALANCE', date: '2024-12-31', amountCents: 19_000_100, origin: 'ADMIN', at: null, userId: null }] },
    });
    expect(ev.statementConflicts).toEqual(['2025-12-31']);
    expect(ev.statements).toEqual([expect.objectContaining({ date: '2024-12-31', cents: 19_000_100, origin: 'ADMIN', source: 'MANUAL' })]);
  });
});

const docs = new Map([[1, { title: 'Tableau d’amortissement', date: '2021-11-20' }], [2, { title: 'Avenant', date: '2025-06-01' }]]);
const evid = (o: Partial<LoanEvidence> = {}): LoanEvidence => ({
  terms: {}, conflicts: {}, deferralMentioned: false, variableRateMentioned: false, statements: [], statementConflicts: [], earlyRepayments: [], ...o,
});
const conditions = (o: Partial<LoanEvidence['terms']> = {}): LoanEvidence['terms'] => ({
  principalCents: { value: 120_000, origin: 'DOCUMENT', fileIds: [] }, ratePct: { value: '0', origin: 'DOCUMENT', fileIds: [1] },
  periodicity: { value: 'MONTHLY', origin: 'DOCUMENT', fileIds: [1] }, durationMonths: { value: 12, origin: 'DOCUMENT', fileIds: [1] },
  firstInstallmentDate: { value: '2026-01-05', origin: 'DOCUMENT', fileIds: [1] }, ...o,
});

describe('L112D-OUT — résolution', () => {
  it('L112D-OUT-01 — rien d\'établi : « Capital restant dû non établi » + ce qui manque, aucune valeur', () => {
    const r = resolveOutstandingPrincipal({ evidence: evid({ terms: { principalCents: { value: 120_000, origin: 'DOCUMENT', fileIds: [] } } }), scheduleChanges: [], documents: docs, today: '2026-06-01' });
    expect(r).toMatchObject({ status: 'NOT_ESTABLISHED', cents: null, method: null });
    expect(r.missing).toEqual(['le taux nominal', 'la périodicité des échéances', 'la durée du prêt', 'la date de la première échéance']);
    expect(r.label).toMatch(new RegExp(`^${TCO_OUTSTANDING_NOT_ESTABLISHED} : il manque le taux nominal, .* et la date de la première échéance\\. Ajoutez le tableau d’amortissement`));
  });

  it('L112D-OUT-02 — conditions complètes : calculé exactement, assurance distincte', () => {
    const r = resolveOutstandingPrincipal({ evidence: evid({ terms: conditions({ insuranceCents: { value: 1_500, origin: 'DOCUMENT', fileIds: [1] } }) }), scheduleChanges: [], documents: docs, today: '2026-05-20' });
    expect(r).toMatchObject({ status: 'ESTABLISHED', cents: 70_000, asOf: '2026-05-05', method: 'COMPUTED', installment: { cents: 10_000, source: 'THEORETICAL', insuranceCents: 1_500 } });
    expect(r.label).toMatch(/^Calculé selon les conditions du prêt .* après l’échéance du 05\/05\/2026 ; échéances passées présumées honorées\.$/);
  });

  it('L112D-OUT-03 — conditions incomplètes mais tableau lu : dernier capital restant dû au plus tard aujourd\'hui, avec sa date et sa source', () => {
    const r = resolveOutstandingPrincipal({
      evidence: evid({ statements: [
        { date: '2026-04-05', cents: 80_000, origin: 'DOCUMENT', fileId: 1, source: 'TABLE', ref: 't1' },
        { date: '2026-07-05', cents: 50_000, origin: 'DOCUMENT', fileId: 1, source: 'TABLE', ref: 't2' },
      ] }), scheduleChanges: [], documents: docs, today: '2026-06-01',
    });
    expect(r).toMatchObject({ status: 'ESTABLISHED', cents: 80_000, asOf: '2026-04-05', method: 'DOCUMENT', sourceFileId: 1 });
    expect(r.label).toBe('Lu sur « Tableau d’amortissement » au 05/04/2026.');
  });

  it('L112D-OUT-04 — avenant : lignes de l\'ancien tableau au-delà de sa date d\'effet ignorées ; nouveau tableau lu', () => {
    const statements = [
      { date: '2025-06-05', cents: 60_000, origin: 'DOCUMENT' as const, fileId: 1, source: 'TABLE' as const, ref: 'old-1' },
      { date: '2025-08-05', cents: 70_000, origin: 'DOCUMENT' as const, fileId: 1, source: 'TABLE' as const, ref: 'old-2' },
      { date: '2025-07-05', cents: 40_000, origin: 'DOCUMENT' as const, fileId: 2, source: 'TABLE' as const, ref: 'new-1' },
    ];
    const r = resolveOutstandingPrincipal({ evidence: evid({ statements }), scheduleChanges: [{ date: '2025-07-05', byFileId: 2 }], documents: docs, today: '2025-09-01' });
    expect(r).toMatchObject({ cents: 40_000, asOf: '2025-07-05', sourceFileId: 2 });
    // Conditions initiales connues : le calcul s'arrête à l'avenant, la valeur lue après lui est retenue.
    const r2 = resolveOutstandingPrincipal({ evidence: evid({ terms: conditions({ firstInstallmentDate: { value: '2025-01-05', origin: 'DOCUMENT', fileIds: [1] } }), statements }), scheduleChanges: [{ date: '2025-07-05', byFileId: 2 }], documents: docs, today: '2025-09-01' });
    expect(r2).toMatchObject({ cents: 40_000, method: 'DOCUMENT', computeIssue: 'SCHEDULE_CHANGED' });
  });

  it('L112D-OUT-05 — avant la première échéance : montant emprunté ; différé mentionné sans paramètres → non établi', () => {
    const t = { principalCents: { value: 120_000, origin: 'DOCUMENT' as const, fileIds: [] }, firstInstallmentDate: { value: '2027-01-05', origin: 'DOCUMENT' as const, fileIds: [1] } };
    expect(resolveOutstandingPrincipal({ evidence: evid({ terms: t }), scheduleChanges: [], documents: docs, today: '2026-11-06' }))
      .toMatchObject({ status: 'ESTABLISHED', cents: 120_000, method: 'NO_INSTALLMENT_DUE' });
    const r = resolveOutstandingPrincipal({ evidence: evid({ terms: conditions(), deferralMentioned: true }), scheduleChanges: [], documents: docs, today: '2026-06-01' });
    expect(r.status).toBe('NOT_ESTABLISHED');
    expect(r.missing).toEqual(['la durée et la nature du différé']);
  });

  it('L112D-OUT-06 — échéance lue incohérente et aucun relevé : non établi avec le motif (aucune estimation)', () => {
    const r = resolveOutstandingPrincipal({ evidence: evid({ terms: conditions({ installmentCents: { value: 9_000, origin: 'DOCUMENT', fileIds: [1] } }) }), scheduleChanges: [], documents: docs, today: '2026-06-01' });
    expect(r).toMatchObject({ status: 'NOT_ESTABLISHED', cents: null, computeIssue: 'INSTALLMENT_MISMATCH' });
    expect(r.label).toMatch(/l’échéance hors assurance ne correspond pas/);
    expect(r.notes.join(' ')).toMatch(/échéance attendue 100,00/);
  });

  it('L112D-OUT-07 — relevé saisi du jour d\'une échéance concordant : affiché comme saisi ; remboursement anticipé saisi appliqué', () => {
    const r = resolveOutstandingPrincipal({
      evidence: evid({ terms: conditions(), statements: [{ date: '2026-05-05', cents: 70_000, origin: 'USER', fileId: null, source: 'MANUAL', ref: 'saisie:a' }] }),
      scheduleChanges: [], documents: docs, today: '2026-05-20',
    });
    expect(r).toMatchObject({ cents: 70_000, method: 'USER' });
    const ra = resolveOutstandingPrincipal({
      evidence: evid({ terms: conditions(), earlyRepayments: [{ id: 'r', kind: 'EARLY_REPAYMENT', date: '2026-03-10', amountCents: 30_000, mode: 'REDUCED_DURATION', origin: 'USER', at: null, userId: 1 }] }),
      scheduleChanges: [], documents: docs, today: '2026-05-20',
    });
    expect(ra).toMatchObject({ cents: 40_000, method: 'COMPUTED' });
  });

  it('L112D-OUT-08 — synthèse : total seulement si tous les prêts sont établis ; jamais un coût', () => {
    const e = (cents: number) => resolveOutstandingPrincipal({ evidence: evid({ statements: [{ date: '2026-01-05', cents, origin: 'DOCUMENT', fileId: 1, source: 'TABLE', ref: String(cents) }] }), scheduleChanges: [], documents: docs, today: '2026-02-01' });
    const n = resolveOutstandingPrincipal({ evidence: evid(), scheduleChanges: [], documents: docs, today: '2026-02-01' });
    expect(summarizeOutstanding([e(100), e(200)])).toMatchObject({ status: 'ESTABLISHED', cents: 300 });
    expect(summarizeOutstanding([e(100), n])).toMatchObject({ status: 'PARTIAL', cents: null });
    expect(summarizeOutstanding([n])).toMatchObject({ status: 'NOT_ESTABLISHED', cents: null });
    expect(summarizeOutstanding([e(100)]).text).toMatch(/jamais un coût/);
  });
});

describe('L112D-API — saisie', () => {
  it('L112D-API-01 — corps valide, effacement par null, refus des valeurs invalides', () => {
    expect(parseLoanTermsBody({ terms: { ratePct: '3,25', periodicity: 'MONTHLY', durationMonths: 240, firstInstallmentDate: '2021-12-05', deferral: { months: 0, kind: 'NONE' } } }))
      .toEqual({ ok: true, value: { terms: { ratePct: '3.25', periodicity: 'MONTHLY', durationMonths: 240, firstInstallmentDate: '2021-12-05', deferral: { months: 0, kind: 'NONE' } }, events: undefined } });
    expect(parseLoanTermsBody({ terms: { ratePct: null } })).toMatchObject({ ok: true, value: { terms: { ratePct: null } } });
    expect(parseLoanTermsBody({ terms: { ratePct: '120' } })).toMatchObject({ ok: false });
    expect(parseLoanTermsBody({ terms: { durationMonths: 0 } })).toMatchObject({ ok: false });
    expect(parseLoanTermsBody({ terms: { firstInstallmentDate: '2021-02-30' } })).toMatchObject({ ok: false });
    expect(parseLoanTermsBody({ terms: { deferral: { months: 6, kind: 'NONE' } } })).toMatchObject({ ok: false });
    expect(parseLoanTermsBody({ terms: { inconnu: 1 } })).toMatchObject({ ok: false });
    expect(parseLoanTermsBody({})).toMatchObject({ ok: false });
    expect(parseLoanTermsBody({ events: [{ kind: 'EARLY_REPAYMENT', date: '2026-03-10', amountCents: 100, mode: 'NEW_INSTALLMENT' }] })).toMatchObject({ ok: false });
    expect(parseLoanTermsBody({ events: [{ kind: 'BALANCE', date: '2026-03-10', amountCents: 0 }] })).toMatchObject({ ok: true });
  });
});
