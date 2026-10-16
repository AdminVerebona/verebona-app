/**
 * Lot 58B — ticket P1 « À traiter : questions inutiles sur des échéances
 * passées et données déjà connues » : parties PURES (normalisation des
 * dates, rapprochement par alias, candidats et pertinence d'une échéance).
 *
 * Les mêmes cas ECH-01 à ECH-14 sont rejoués sur PostgreSQL réel par
 * `src/test/e2e/scenarios/l58b-a-traiter-echeances.e2e.ts`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const ev = await import('../document-field-evidence');
const { proposalsFromAnalysis, pertinenceCandidates, rawValueOf, planDocumentRule } = await import('../document-rule-bridge');
const { documentSlotFor } = await import('../document-slots');
const { getRule } = await import('../rules-catalog');
const { normalizeDateValue } = await import('@/services/canonical/registry');

const CONTRACT = getRule('DATA-CONTRACT-END')!;
const WARRANTY = getRule('DATA-WARRANTY-END')!;
const SUPPLIER = getRule('DATA-SUPPLIER')!;
const slot = documentSlotFor('contractEndDate');
const obs = (facts: Parameters<typeof proposalsFromAnalysis>[2]['facts']) => ({ facts, assetCandidates: [], documentAssetId: null });

type Decide = NonNullable<Parameters<typeof ev.assessDeadlinePertinence>[0]['decide']>;
const t4 = (o: { decision?: 'accept' | 'reject' | 'abstain'; category?: 'action' | 'information' | 'unknown'; failure?: boolean }) => {
  const calls: Array<{ input: Parameters<Decide>[0]; ctx: Parameters<Decide>[1] }> = [];
  const decide: Decide = async (input, ctx) => {
    calls.push({ input, ctx });
    if (o.failure) {
      return { agendaDecision: 'abstain', recurrenceDecision: 'not_applicable', classification: { category: 'unknown', confidence: 'ambiguous', source: 'fallback', reason: 'x' },
        reason: 'échec', recurrenceReason: null, outcome: 'technical_failure', warnings: [], error: { code: 'T4_CALL_FAILED', message: 'x' } };
    }
    return { agendaDecision: o.decision ?? 'accept', recurrenceDecision: 'not_applicable',
      classification: { category: o.category ?? 'information', confidence: 'certain', source: 'model', reason: 'simulé' },
      reason: 'simulé', recurrenceReason: null, outcome: 'model_v2', warnings: [], traceId: 'trace-1' };
  };
  return { decide, calls };
};
const base = { accountId: 1, fileId: 2, documentType: 'SERVICE_CONTRACT', today: '2026-10-15' };

describe('ECH-04 — dates non ISO mais non ambiguës : normalisation correcte, ambiguës refusées', () => {
  it.each([
    ['20:06:2026', '2026-06-20'], ['20/06/2026', '2026-06-20'], ['20.06.2026', '2026-06-20'], ['20-06-2026', '2026-06-20'],
    ['20 juin 2026', '2026-06-20'], ['1er juin 2026', '2026-06-01'], ['2026/06/20', '2026-06-20'], ['2026-06-20', '2026-06-20'],
    ['2026-06-20T10:00:00Z', '2026-06-20'], ['20 Décembre 2026', '2026-12-20'],
  ])('ECH-04 — « %s » → %s', (raw, iso) => {
    expect(ev.parseDocumentDate(raw).iso).toBe(iso);
  });

  it.each([
    ['20/06/26', 'REFUSED_AMBIGUOUS'], ['20:06/2026', 'REFUSED_AMBIGUOUS'], ['31/02/2026', 'INVALID'], ['32 juin 2026', 'INVALID'],
    ['Orange', 'NOT_A_DATE'], ['12:30', 'NOT_A_DATE'],
  ])('ECH-04 — « %s » refusée (%s)', (raw, status) => {
    expect(ev.parseDocumentDate(raw)).toEqual({ iso: null, status });
  });

  it('ECH-04 — jour et mois ≤ 12 : lu à la française mais signalé ORDER_AMBIGUOUS (jamais certain)', () => {
    expect(ev.parseDocumentDate('06/07/2026')).toEqual({ iso: '2026-07-06', status: 'ORDER_AMBIGUOUS' });
    expect(ev.parseDocumentDate('07/07/2026').status).toBe('NORMALIZED');
    const p = proposalsFromAnalysis('contractEndDate', slot, obs([{ canonicalKey: 'contractEndDate', value: '06/07/2026', confidence: 'certain' }]));
    expect(p).toEqual([expect.objectContaining({ value: '2026-07-06' })]);
    expect(p[0].confidence).toBeLessThan(0.9);
  });

  it('ECH-04 — registre (projection T1) et slot : « 20:06:2026 » n’est plus requalifié générique ni écarté', () => {
    expect(normalizeDateValue('20:06:2026')).toBe('2026-06-20');
    expect(normalizeDateValue('20:06/2026')).toBeNull();
    expect(slot.normalize('20:06:2026')).toBe('2026-06-20');
    expect(slot.validate('20/06/26')).toBe(false);
    expect(rawValueOf('20:06:2026')).toBe('2026-06-20');
    expect(rawValueOf(' Orange ')).toBe('Orange');
  });

  it('ECH-04 — dates mentionnées dans un nom de fichier', () => {
    expect(ev.datesMentionedIn('Votre contrat de gardiennage de pneus arrive à échéance le 20:06:2026.pdf').map((d) => d.iso)).toEqual(['2026-06-20']);
    expect(ev.datesMentionedIn('Échéance au 20 juin 2026, renouvelé le 2027-01-05').map((d) => d.iso)).toEqual(['2026-06-20', '2027-01-05']);
    expect(ev.datesMentionedIn('Référence 123/45/67890')).toEqual([]);
  });
});

describe('ECH-03 — date extraite en brut, absente du champ canonique : rapprochement par le registre', () => {
  it('ECH-03 — fait sans clé canonique dont la clé lue est un alias : proposition certaine → écriture', () => {
    const p = proposalsFromAnalysis('contractEndDate', slot, obs([{ canonicalKey: null, rawKey: 'dateFinContrat', value: '20:06:2026', confidence: 'certain' }]));
    expect(p).toEqual([expect.objectContaining({ value: '2026-06-20', confidence: 1 })]);
    const plan = planDocumentRule({ rule: CONTRACT, state: { value: null, values: [], userValidated: false }, proposals: p, relevant: true, mode: 'analysis' });
    expect(plan).toMatchObject({ kind: 'WRITE', value: '2026-06-20' });
  });

  it('ECH-03 — une clé lue qui ne désigne PAS la donnée (bail) n’est jamais rapprochée', () => {
    expect(proposalsFromAnalysis('contractEndDate', slot, obs([{ canonicalKey: null, rawKey: 'leaseEndDate', value: '2026-06-20', confidence: 'certain' }]))).toEqual([]);
  });

  it('ECH-02 — date connue (présente) : aucune demande redondante', () => {
    const plan = planDocumentRule({ rule: CONTRACT, state: { value: '2027-06-30', values: [], userValidated: false }, proposals: [], relevant: true, mode: 'state', mayCreate: true });
    expect(plan).toEqual({ kind: 'NONE', reason: 'ALREADY_SATISFIED' });
  });
});

describe('ECH-05 / ECH-08 — titre : orienter sans prouver', () => {
  it('ECH-05 — une date du titre NON retrouvée dans le contenu n’est jamais une proposition (seulement un indice)', () => {
    const c = pertinenceCandidates([], { hasExtraction: true, facts: [], sources: {}, missing: [], errors: [], observations: [], titleHint: { dates: ['2026-06-20'], confirmed: [], excerpt: 't' } });
    expect(c).toEqual([{ iso: '2026-06-20', source: 'TITLE_ONLY', excerpt: 't' }]);
  });
});

describe('Pertinence d’une échéance (T4 CLASSIFY_EVENT, branche existante)', () => {
  it('ECH-02 — date future : AUCUN appel IA (contrat actif) ; lot 61 : question seulement si l’échéance est proche', async () => {
    const { decide, calls } = t4({});
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2027-01-01', source: 'FACTS' }], decide });
    expect(r).toMatchObject({ pertinence: 'FUTURE_SOON', outcome: 'CREATE_ACTION', aiCalled: false });
    const loin = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2028-01-01', source: 'FACTS' }], decide });
    expect(loin).toMatchObject({ pertinence: 'FUTURE_DEFERRABLE', outcome: 'DEFER', aiCalled: false });
    expect(calls).toHaveLength(0);
  });

  it('ECH-08 — aucune date candidate, version T4 sans évaluation structurée : question maintenue sans IA (contrat actif possible)', async () => {
    const { decide, calls } = t4({});
    expect((await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [], decide })).pertinence).toBe('FUTURE_OR_UNDATED');
    expect(calls).toHaveLength(0);
  });

  it('ECH-01 — échéance passée jugée informative par T4 : NO_ACTION_NEEDED (contexte transmis : date, type, nature, sans règle « gardiennage »)', async () => {
    const { decide, calls } = t4({ category: 'information' });
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-06-20', source: 'FACTS', excerpt: 'Contrat … échéance le 20:06:2026' }], decide });
    expect(r).toMatchObject({ pertinence: 'NO_ACTION_NEEDED', outcome: 'NO_ACTION', aiCalled: true, aiStatus: 'OK', aiTraceId: 'trace-1' });
    expect(calls[0].input).toMatchObject({ originFieldKey: 'contractEndDate', nature: 'DEADLINE', businessType: 'contract' });
    expect(calls[0].input.description).toMatch(/2026-10-15/);
    expect(calls[0].ctx).toMatchObject({ date: '2026-06-20', documentType: 'SERVICE_CONTRACT', recurrenceCandidate: null });
  });

  it('ECH-01 / lot 61 (écart 7) — date du SEUL titre : jamais « aucune intervention » sur ce seul indice, aucun appel sans évaluation structurée', async () => {
    const { decide, calls } = t4({ category: 'information' });
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-06-20', source: 'TITLE_ONLY', excerpt: 'Contrat … échéance le 20:06:2026' }], decide });
    expect(r).toMatchObject({ pertinence: 'TITLE_HINT_ONLY', outcome: 'DEFER', aiCalled: false });
    expect(calls).toHaveLength(0);
  });

  it('ECH-07 — échéance passée avec action attendue : ACTION_REQUIRED ; lot 61 (écart 2) : sans intervention identifiée (version T4 v2), jamais une question de date — décision différée', async () => {
    const { decide } = t4({ category: 'action' });
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-06-20', source: 'FACTS' }], decide });
    expect(r).toMatchObject({ pertinence: 'ACTION_REQUIRED', outcome: 'DEFER', card: null });
  });

  it('ECH-07 — abstention, refus de la date ou échec technique : variante prudente (UNDECIDED ; lot 61 : décision différée, jamais une carte arbitraire)', async () => {
    for (const o of [{ decision: 'abstain' as const, category: 'unknown' as const }, { decision: 'reject' as const, category: 'unknown' as const }, { failure: true }]) {
      const { decide } = t4(o);
      const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-06-20', source: 'FACTS' }], decide });
      expect(r).toMatchObject({ pertinence: 'UNDECIDED', outcome: 'DEFER' });
      if (o.failure) expect(r).toMatchObject({ aiStatus: 'ERROR', reason: 't4_failure:T4_CALL_FAILED', technicalFailure: true });
    }
  });

  it('ECH-10 — décision mémorisée pour les mêmes éléments : pas de nouvel appel IA ; élément nouveau : réévaluée', async () => {
    const { decide, calls } = t4({ category: 'information' });
    const cands = [{ iso: '2026-06-20', source: 'FACTS' }];
    // Lot 61 : la signature porte aussi la situation, l'empreinte des preuves et la configuration IA.
    const signature = ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', cands, { situation: 'PAST_DEADLINE', evidence: null, config: 'unknown' });
    const memo = { signature, pertinence: 'NO_ACTION_NEEDED', outcome: 'NO_ACTION' as const };
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: cands, decide, remembered: memo });
    expect(r).toMatchObject({ pertinence: 'NO_ACTION_NEEDED', cached: true, aiCalled: false });
    expect(calls).toHaveLength(0);
    await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [...cands, { iso: '2026-05-01', source: 'SOURCE_UNITS' }], decide, remembered: memo });
    expect(calls).toHaveLength(1);
  });

  it('ECH-12 — garanties : même traitement générique ; fournisseur (sans échéance) : jamais évalué', async () => {
    const { decide, calls } = t4({ category: 'information' });
    const g = await ev.assessDeadlinePertinence({ ...base, documentType: 'WARRANTY_CERTIFICATE', rule: WARRANTY, candidates: [{ iso: '2025-01-01', source: 'FACTS' }], decide });
    expect(g.pertinence).toBe('NO_ACTION_NEEDED');
    expect(calls[0].input).toMatchObject({ originFieldKey: 'warrantyEndDate', businessType: 'warranty' });
    const s = await ev.assessDeadlinePertinence({ ...base, rule: SUPPLIER, candidates: [{ iso: '2025-01-01', source: 'FACTS' }], decide });
    expect(s).toMatchObject({ pertinence: 'NOT_EVALUATED', aiCalled: false });
  });

  it('Diagnostic — signature stable hors déclencheur et référence d’exécution', () => {
    const r = { accountId: 1, fileId: 2, ruleCode: 'DATA-CONTRACT-END', fieldKey: 'contractEndDate', targetPresent: false, userValidated: false, decision: 'NONE' as const, reasonCode: 'NO_ACTION_NEEDED' };
    expect(ev.evaluationSignature({ ...r, trigger: 'SWEEP', runRef: 'a' })).toBe(ev.evaluationSignature({ ...r, trigger: 'T3', runRef: 'b' }));
    expect(ev.evaluationSignature({ ...r, trigger: 'SWEEP' })).not.toBe(ev.evaluationSignature({ ...r, trigger: 'SWEEP', decision: 'CREATE' }));
  });
});
