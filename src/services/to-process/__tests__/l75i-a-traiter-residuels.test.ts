/**
 * Lot 75I — ticket « [P1] À traiter — Corriger les écarts résiduels de
 * pertinence, fiabiliser le balayage et finaliser la recette T4 » : décisions
 * PURES (sans base). Les écritures, cartes, traces et bilans réellement
 * persistés sont vérifiés sur PostgreSQL 16
 * (`src/test/e2e/scenarios/l75i-a-traiter-residuels.e2e.ts`).
 *
 *  L75I-A-*  obligation évaluée même quand la date est connue
 *  L75I-B-*  statut fidèle des balayages
 *  L75I-D-*  aucune question par défaut quand T4 ne peut conclure
 *  L75I-F-*  recette T4 : cas ajoutés, classement des sorties IA
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const ev = await import('../document-field-evidence');
const scan = await import('../to-process-scan.job');
const recette = await import('../relevance-recette');
const { getRule } = await import('../rules-catalog');

const CONTRACT = getRule('DATA-CONTRACT-END')!;
const TODAY = '2026-10-20';
const V3 = { ref: 'repo:t4_output_v3', interventionCapable: true };
const V2 = { ref: 'bo:v7:t4_output_v2', interventionCapable: false };
const plus = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const base = { accountId: 1, fileId: 2, documentType: 'SERVICE_CONTRACT', today: TODAY, rule: CONTRACT };

const CLAUSE = 'À la fin du contrat, le locataire doit restituer le matériel loué dans un délai de 30 jours.';

const { translateEventDecision } = await import('@/services/ai/agenda/master/classify-event');

type Iv = { needed: 'yes' | 'no' | 'uncertain'; kind: string | null; action: string | null; evidence: string | null; timing: 'NOW' | 'LATER' | 'NONE'; actBy?: string | null; dataNeeded?: boolean | null };
type Decide = NonNullable<Parameters<typeof ev.assessDeadlinePertinence>[0]['decide']>;
/** T4 simulé générique (sortie v3 réelle via `translateEventDecision`) : rend l'intervention donnée, mémorise les demandes. */
function t4(iv: Iv | null, opts: { failure?: boolean } = {}) {
  const calls: Array<{ ctx: Record<string, any> }> = [];
  const decide: Decide = async (_input, ctx) => {
    calls.push({ ctx: ctx as Record<string, any> });
    if (opts.failure) {
      return { agendaDecision: 'abstain', recurrenceDecision: 'not_applicable', classification: { category: 'unknown', confidence: 'ambiguous', source: 'fallback', reason: 'x' },
        reason: 'échec', recurrenceReason: null, outcome: 'technical_failure', warnings: [], error: { code: 'PROVIDER_UNAVAILABLE', message: 'x' } } as never;
    }
    const out = {
      task: 'CLASSIFY_EVENT' as const, agendaDecision: 'accept' as const, recurrenceDecision: 'not_applicable' as const,
      homeCategory: iv?.needed === 'yes' ? 'action' : 'information', businessType: null, confidence: 'certain' as const, reason: 'simulé', recurrenceReason: null,
      intervention: iv ? { justification: 'simulé', consequence: null, actBy: null, dataNeeded: null, ...iv } : null,
    };
    return { ...translateEventDecision(out as never, false), traceId: 't-1' };
  };
  return { decide, calls };
}

describe('A — obligation évaluée même quand la date est connue', () => {
  it('L75I-A-01 — date passée CERTAINE connue + clause de restitution ailleurs que l’extrait de la date : carte d’intervention, jamais une question de date', async () => {
    const { decide, calls } = t4({ needed: 'yes', kind: 'RETURN_OR_RESTITUTE', action: 'Restituer le matériel loué', evidence: CLAUSE, timing: 'NOW' });
    const r = await ev.assessKnownDeadlineObligation({
      ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, clauses: [CLAUSE], decide, config: V3, remembered: null,
      lifecycle: ev.lifecycleSignalsOf([CLAUSE]), evidenceFingerprint: 'fp',
    });
    expect(r).toMatchObject({ outcome: 'CREATE_ACTION', card: 'INTERVENTION', situation: 'KNOWN_DEADLINE', aiCalled: true, intervention: { kind: 'RETURN_OR_RESTITUTE' } });
    expect(r.card).not.toBe('DATA_QUESTION');
    // T4 reçoit la date connue ET la clause (même hors extrait de la date).
    const demande = calls[0].ctx.toProcessAssessment;
    expect(demande).toMatchObject({ situation: 'PAST_DEADLINE', knownDate: plus(-40), clauses: [CLAUSE] });
    expect(calls[0].ctx.excerpt).toContain('restituer');
  });

  it('L75I-A-01 — date connue : T4 qui demanderait la donnée (PROVIDE_INFORMATION) → aucune question (la date est connue)', async () => {
    const { decide } = t4({ needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin', evidence: null, timing: 'NOW', dataNeeded: true });
    const r = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, decide, config: V3 });
    expect(r.outcome).toBe('NO_ACTION');
    expect(r.card).toBeNull();
  });

  it('L75I-A-02 — date passée connue sans obligation : NO_ACTION (historique), sans carte ; aucune clause d’obligation : ni carte ni appel IA', async () => {
    const { decide, calls } = t4({ needed: 'no', kind: null, action: null, evidence: null, timing: 'NONE' });
    const r = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, clauses: ['Paiement mensuel par prélèvement.'], decide, config: V3 });
    expect(r).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'NO_ACTION_NEEDED', card: null, situation: 'KNOWN_DEADLINE', aiCalled: true });
    const sansClause = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, decide, config: V3 });
    expect(sansClause).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'NO_OBLIGATION_EVIDENCE', aiCalled: false, card: null });
    // L'obligation peut être portée par l'extrait de la date ou par le titre.
    await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, dateExcerpt: 'Matériel à restituer au plus tard le 20/09/2026', decide, config: V3 });
    expect(calls).toHaveLength(2);
  });

  it('L75I-A-02 — déterministe sans IA : fin effective prouvée → NO_ACTION ; échéance lointaine → DEFER jusqu’à l’approche ; ancienne sans signal → DEFER', async () => {
    const { decide, calls } = t4(null);
    const fini = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-400), source: 'KNOWN_VALUE' }, decide, config: V3,
      lifecycle: ev.lifecycleSignalsOf(['Le contrat a pris fin à son terme, sans reconduction.']) });
    expect(fini).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'CONTRACT_TERMINATED', aiCalled: false });
    const loin = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(400), source: 'KNOWN_VALUE' }, decide, config: V3 });
    expect(loin).toMatchObject({ outcome: 'DEFER', pertinence: 'FUTURE_DEFERRABLE', aiCalled: false, reevaluateAt: `${plus(280)}T00:00:00.000Z` });
    const ancien = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-3000), source: 'KNOWN_VALUE' }, decide, config: V3 });
    expect(ancien).toMatchObject({ outcome: 'DEFER', pertinence: 'KNOWN_HISTORICAL', aiCalled: false, card: null });
    expect(ancien.reevaluateAt).not.toBeNull();
    // Une obligation résiduelle lue rend la décision à T4, même pour une date ancienne.
    const residuel = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-3000), source: 'KNOWN_VALUE' }, decide, config: V3, lifecycle: ev.lifecycleSignalsOf([CLAUSE]) });
    expect(residuel.aiCalled).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('L75I-A-03 — connaissance inchangée : décision mémorisée réutilisée, aucun nouvel appel T4 ; clause changée : nouvel appel', async () => {
    const { decide, calls } = t4({ needed: 'no', kind: null, action: null, evidence: null, timing: 'NONE' });
    const p = { ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, clauses: [CLAUSE], decide, config: V3, evidenceFingerprint: 'fp' };
    const r1 = await ev.assessKnownDeadlineObligation({ ...p, remembered: null });
    const memo = { signature: r1.signature, pertinence: r1.pertinence, outcome: r1.outcome, card: r1.card, aiStatus: r1.aiStatus };
    const r2 = await ev.assessKnownDeadlineObligation({ ...p, remembered: memo as never });
    expect(r2).toMatchObject({ cached: true, aiCalled: false, outcome: 'NO_ACTION' });
    const r3 = await ev.assessKnownDeadlineObligation({ ...p, clauses: [`${CLAUSE} Pénalité de 200 €.`], remembered: memo as never });
    expect(r3.aiCalled).toBe(true);
    // Signature distincte d'une question sur une date inconnue (jamais de réutilisation croisée).
    expect(r1.signature).not.toBe(ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', [{ iso: plus(-40), source: 'FACTS' }], { situation: 'PAST_DEADLINE', evidence: 'fp', config: V3.ref }));
    expect(calls).toHaveLength(2);
  });

  it('L75I-A-04 — panne T4 sur une date connue : DEFER technique, jamais une décision', async () => {
    const r = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, clauses: [CLAUSE], decide: t4(null, { failure: true }).decide, config: V3 });
    expect(r).toMatchObject({ outcome: 'DEFER', technicalFailure: true, aiStatus: 'ERROR' });
  });

  it('L75I-A-05 — clauses d’obligation lues dans la connaissance (vocabulaire générique, bornées)', () => {
    const c = ev.lifecycleSignalsOf(['Date de fin : 20/06/2026', CLAUSE, 'Le contrat est reconduit tacitement.', 'Montant : 20 €']);
    expect(c.clauses).toEqual([CLAUSE, 'Le contrat est reconduit tacitement.']);
    expect(ev.lifecycleSignalsOf(Array.from({ length: 20 }, (_, i) => `${CLAUSE} ${i}`)).clauses).toHaveLength(5);
  });
});

describe('D — aucune question par défaut quand T4 ne peut conclure', () => {
  it('L75I-D-01 — date inconnue, contrat T4 incompatible : aucune question, état prudent, incompatibilité signalée, sans IA', async () => {
    const { decide, calls } = t4(null);
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: [], decide, config: V2 });
    expect(r).toMatchObject({ outcome: 'DEFER', pertinence: 'T4_INCOMPATIBLE', card: null, incompatible: true, technicalFailure: false });
    expect(r.reason).toMatch(/t4_contract_incompatible/);
    expect(calls).toHaveLength(0);
    // Sans configuration lisible : même prudence.
    expect((await ev.assessDeadlinePertinence({ ...base, candidates: [], decide })).outcome).not.toBe('CREATE_ACTION');
  });

  it('L75I-D-01 — date connue, contrat T4 incompatible : aucune intervention arbitraire, incompatibilité signalée', async () => {
    const { decide, calls } = t4(null);
    const r = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, clauses: [CLAUSE], decide, config: V2 });
    expect(r).toMatchObject({ outcome: 'DEFER', pertinence: 'T4_INCOMPATIBLE', incompatible: true, card: null });
    expect(calls).toHaveLength(0);
  });

  it('L75I-D-02 — sortie T4 hors contrat (bloc intervention absent) : prudence, jamais une carte', async () => {
    const r = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: plus(-40), source: 'KNOWN_VALUE' }, clauses: [CLAUSE], decide: t4(null).decide, config: V3 });
    expect(r).toMatchObject({ outcome: 'DEFER', card: null, technicalFailure: true });
  });
});

describe('B — statut fidèle des balayages', () => {
  it('L75I-B-01 — ok seulement sans erreur ; partial si une partie a échoué ou si le passage est incomplet ; error sans résultat exploitable', () => {
    expect(scan.scanRunStatus({ accounts: 3, failedAccounts: 0, accountsWithErrors: 0, partial: false })).toBe('ok');
    expect(scan.scanRunStatus({ accounts: 3, failedAccounts: 0, accountsWithErrors: 1, partial: false })).toBe('partial');
    expect(scan.scanRunStatus({ accounts: 1, failedAccounts: 0, accountsWithErrors: 1, partial: false })).toBe('partial');
    expect(scan.scanRunStatus({ accounts: 3, failedAccounts: 1, accountsWithErrors: 1, partial: false })).toBe('partial');
    expect(scan.scanRunStatus({ accounts: 3, failedAccounts: 0, accountsWithErrors: 0, partial: true })).toBe('partial');
    expect(scan.scanRunStatus({ accounts: 2, failedAccounts: 2, accountsWithErrors: 2, partial: false })).toBe('error');
    expect(scan.scanRunStatus({ accounts: 0, failedAccounts: 0, accountsWithErrors: 0, partial: false, fatal: true })).toBe('error');
  });
});

describe('F — recette T4 réelle', () => {
  it('L75I-F-01 — corpus : date connue + restitution, date connue sans obligation, contrat incompatible', () => {
    const ids = recette.RELEVANCE_RECETTE_CASES.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['ATR-REC-19', 'ATR-REC-20', 'ATR-REC-21', 'ATR-REC-22', 'ATR-REC-23', 'ATR-REC-24', 'ATR-REC-25']));
    const r19 = recette.RELEVANCE_RECETTE_CASES.find((c) => c.id === 'ATR-REC-19')!;
    expect(r19.known).toBeTruthy();
    expect(r19.expected.never).toContain('DATA_QUESTION');
  });

  it('L75I-F-02 — chaque sortie IA est classée : valide, ambiguë, incohérente, en erreur', async () => {
    const c19 = recette.RELEVANCE_RECETTE_CASES.find((c) => c.id === 'ATR-REC-19')!;
    const ok = await recette.runRecetteCase(c19, { accountId: 1, today: TODAY, config: V3,
      decide: t4({ needed: 'yes', kind: 'RETURN_OR_RESTITUTE', action: 'Restituer le matériel', evidence: c19.clauses![0], timing: 'NOW' }).decide });
    expect(ok).toMatchObject({ ok: true, aiOutput: 'VALID', obtained: { outcome: 'CREATE_ACTION', card: 'INTERVENTION' } });
    const incoherent = await recette.runRecetteCase(c19, { accountId: 1, today: TODAY, config: V3,
      decide: t4({ needed: 'yes', kind: 'RETURN_OR_RESTITUTE', action: 'Restituer', evidence: 'passage inventé', timing: 'NOW' }).decide });
    expect(incoherent.aiOutput).toBe('INCOHERENT');
    expect(incoherent.ok).toBe(false);
    const ambigu = await recette.runRecetteCase(c19, { accountId: 1, today: TODAY, config: V3,
      decide: t4({ needed: 'uncertain', kind: null, action: null, evidence: null, timing: 'NONE' }).decide });
    expect(ambigu.aiOutput).toBe('AMBIGUOUS');
    const panne = await recette.runRecetteCase(c19, { accountId: 1, today: TODAY, config: V3, decide: t4(null, { failure: true }).decide });
    expect(panne).toMatchObject({ aiOutput: 'ERROR', ok: false });
    // Contrat T4 incompatible imposé : déterministe, aucune action arbitraire.
    const c23 = recette.RELEVANCE_RECETTE_CASES.find((c) => c.id === 'ATR-REC-23')!;
    const inc = await recette.runRecetteCase(c23, { accountId: 1, today: TODAY, config: V3, decide: t4(null).decide });
    expect(inc).toMatchObject({ ok: true, aiCalled: false, obtained: { outcome: 'DEFER', pertinence: 'T4_INCOMPATIBLE' } });
  });
});
