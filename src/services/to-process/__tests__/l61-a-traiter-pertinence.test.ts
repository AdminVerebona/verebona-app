/**
 * Lot 61 — tickets « BUG P1 — À traiter : écarts résiduels du lot 58B »
 * (ATR-R-xx) et « [P1] Fiabiliser la pertinence des cartes et résoudre
 * automatiquement les informations déductibles » (ATR-P-xx) : parties PURES
 * (décision centrale, contrat T4 v3 et son contrôle, calcul déterministe,
 * contrat de décision, campagne, cohérence T6, recette).
 *
 * Les mêmes critères sont prouvés sur PostgreSQL 16 réel par
 * `src/test/e2e/scenarios/l61-a-traiter-pertinence.e2e.ts`.
 *
 *  ATR-R-02  ACTION_REQUIRED : intervention réelle identifiée (jamais une question de date)
 *  ATR-R-03  date absente : contexte examiné avant toute question (historique, utilité)
 *  ATR-R-04  mémoire invalidée par les preuves, la situation et la configuration IA
 *  ATR-R-05  panne : décision différée, jamais une fermeture
 *  ATR-R-07  date du seul titre : indice, jamais « aucune intervention »
 *  ATR-R-08  sorties T4 valides, ambiguës, incohérentes et en erreur ; recette (runner)
 *  ATR-P-01  prêt : début effectif + durée → échéance théorique calculée
 *  ATR-P-02  prêt avec simple date d'édition : aucun début supposé
 *  ATR-P-04  échéance future : différée (lointaine) ou question utile (proche)
 *  ATR-P-05  contrat de décision interne versionné, sans texte libre décisif
 *  ATR-P-09  campagne rétroactive : issues
 *  ATR-P-10  T6 ne contredit pas les décisions « À traiter »
 *  ATR-P-11  catalogue : intervention distincte de la donnée, libellés autorisés
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const ev = await import('../document-field-evidence');
const dv = await import('../document-derivations');
const iv = await import('../document-intervention');
const { checkInterventionCoherence } = await import('../intervention-check');
const { getRule, checkRulesCatalog, documentBridgeRules, RULE_PRODUCERS } = await import('../rules-catalog');
const rec = await import('../relevance-recette');
const { T4ClassifyEventV3Output } = await import('@/services/ai/agenda/master/t4-contract');
const { translateEventDecision, classifyEventVariables } = await import('@/services/ai/agenda/master/classify-event');

const CONTRACT = getRule('DATA-CONTRACT-END')!;
const WARRANTY = getRule('DATA-WARRANTY-END')!;
const TODAY = '2026-10-15';
const V3 = { ref: 'repo:t4_output_v3', interventionCapable: true };
const V2 = { ref: 'bo:v7:t4_output_v2', interventionCapable: false };
const base = { accountId: 1, fileId: 2, documentType: 'SERVICE_CONTRACT', today: TODAY };

type Decide = NonNullable<Parameters<typeof ev.assessDeadlinePertinence>[0]['decide']>;
type IvOut = import('@/services/ai/agenda/master/t4-contract').T4InterventionAssessment;
/** T4 simulé : sortie v3 (avec `intervention`), v2 (sans), ou échec. */
const t4 = (o: { intervention?: IvOut | null; category?: 'action' | 'information'; v2?: boolean; failure?: boolean } = {}) => {
  const calls: Array<{ input: Parameters<Decide>[0]; ctx: Parameters<Decide>[1] }> = [];
  const decide: Decide = async (input, ctx) => {
    calls.push({ input, ctx });
    if (o.failure) {
      return { agendaDecision: 'abstain', recurrenceDecision: 'not_applicable', classification: { category: 'unknown', confidence: 'ambiguous', source: 'fallback', reason: 'x' },
        reason: 'échec', recurrenceReason: null, outcome: 'technical_failure', warnings: [], error: { code: 'PROVIDER_UNAVAILABLE', message: 'x' } };
    }
    const out = {
      task: 'CLASSIFY_EVENT' as const, agendaDecision: 'accept' as const, recurrenceDecision: 'not_applicable' as const,
      homeCategory: o.category ?? 'action', businessType: null, confidence: 'certain' as const, reason: 'simulé', recurrenceReason: null,
      ...(o.v2 ? {} : { intervention: o.intervention ?? null }),
    };
    return { ...translateEventDecision(out as never, false), traceId: 'trace-61' };
  };
  return { decide, calls };
};
const RESTITUER: IvOut = {
  needed: 'yes', kind: 'RETURN_OR_RESTITUTE', action: 'Restituer le matériel loué', justification: 'Obligation de restitution sous 30 jours.',
  consequence: 'Matériel facturé', evidence: 'doit restituer le matériel loué dans un délai de 30 jours', timing: 'NOW', actBy: '2026-11-04', dataNeeded: false,
};
const AUCUNE: IvOut = { needed: 'no', kind: null, action: null, justification: 'Historique.', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false };
const PREUVE = 'À la fin du contrat, le locataire doit restituer le matériel loué dans un délai de 30 jours.';

describe('ATR-R-02 — action contractuelle ≠ date manquante', () => {
  it('ATR-R-02 — T4 v3 identifie l’intervention (preuve retrouvée) : carte d’INTERVENTION, jamais une question de date', async () => {
    const { decide, calls } = t4({ intervention: RESTITUER });
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-10-05', source: 'FACTS', excerpt: PREUVE }], decide, config: V3 });
    expect(r).toMatchObject({ outcome: 'CREATE_ACTION', card: 'INTERVENTION', pertinence: 'ACTION_REQUIRED', situation: 'PAST_DEADLINE' });
    expect(r.intervention).toMatchObject({ kind: 'RETURN_OR_RESTITUTE', action: 'Restituer le matériel loué', actBy: '2026-11-04', warnings: [] });
    // Demande transmise à T4 : situation, donnée, question, dates — contrat de décision versionné.
    expect(calls[0].ctx.toProcessAssessment).toMatchObject({ contractVersion: 'atr-decision-v1', situation: 'PAST_DEADLINE', dataKey: 'contractEndDate' });
    expect(iv.interventionQuestion(r.intervention!)).toBe('Restituer le matériel loué (avant le 04/11/2026)');
    expect(iv.interventionQuestion({ action: null, kind: 'TERMINATE', actBy: null })).toBe('Résilier ce contrat');
  });

  it('ATR-R-02 — aucune intervention identifiable (preuve absente ou introuvable) : aucune carte, décision différée', async () => {
    const sansPreuve = { ...RESTITUER, evidence: null };
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-10-05', source: 'FACTS', excerpt: PREUVE }], decide: t4({ intervention: sansPreuve }).decide, config: V3 });
    expect(r).toMatchObject({ outcome: 'DEFER', card: null, pertinence: 'UNDECIDED' });
    const inventee = { ...RESTITUER, evidence: 'une phrase qui ne figure pas dans le document' };
    const r2 = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-10-05', source: 'FACTS', excerpt: PREUVE }], decide: t4({ intervention: inventee }).decide, config: V3 });
    expect(r2).toMatchObject({ outcome: 'DEFER', card: null });
    expect(r2.intervention?.warnings).toContain('EVIDENCE_NOT_IN_CONTEXT');
  });

  it('ATR-R-02 — version T4 active v2 (« action » sans intervention structurée) : jamais une fausse question de date, décision différée et signalée', async () => {
    // Lot 76 (C3, RES-10) : contrat incompatible — plus aucun appel IA ni conclusion sur une
    // classification non structurée (ni fermeture « information », ni carte) : état prudent signalé.
    const { decide, calls } = t4({ v2: true, category: 'action' });
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-10-05', source: 'FACTS' }], decide, config: V2 });
    expect(r).toMatchObject({ outcome: 'DEFER', card: null, pertinence: 'T4_INCOMPATIBLE', incompatible: true, aiCalled: false });
    expect(r.reason).toMatch(/t4_contract_incompatible/);
    expect(calls).toHaveLength(0);
  });

  it('ATR-R-02 — intervention à mener PLUS TARD : différée jusqu’à l’approche de la date limite, sans carte active', async () => {
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-10-05', source: 'FACTS', excerpt: PREUVE }],
      decide: t4({ intervention: { ...RESTITUER, timing: 'LATER', actBy: '2027-03-01' } }).decide, config: V3 });
    expect(r).toMatchObject({ outcome: 'DEFER', card: null, reevaluateAt: '2027-01-30T00:00:00.000Z' });
  });
});

describe('ATR-R-03 — date absente : contexte examiné avant toute demande', () => {
  it('ATR-R-03 — document historique (toutes ses dates > 5 ans) : aucune question, aucun appel IA, contrat jamais déclaré terminé', async () => {
    const { decide, calls } = t4({});
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [], decide, config: V3, contextDates: [{ key: 'documentDate', iso: '2016-03-01' }] });
    // Lot 72 (C2, ATP-FIX-05) : l'ancienneté n'est qu'un indice — DEFER sans carte (jamais NO_ACTION sur l'âge).
    expect(r).toMatchObject({ outcome: 'DEFER', pertinence: 'UNDATED_HISTORICAL', aiCalled: false, card: null });
    expect(calls).toHaveLength(0);
  });

  it('ATR-R-03 — document récent sans date : T4 dit si la date est NÉCESSAIRE ; oui → question, non → aucune carte', async () => {
    const oui = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [], config: V3, contextDates: [{ key: 'contractStartDate', iso: '2026-08-01' }],
      decide: t4({ intervention: { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin du contrat', justification: 'Préavis de résiliation à suivre.', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true } }).decide });
    expect(oui).toMatchObject({ outcome: 'CREATE_ACTION', card: 'DATA_QUESTION', pertinence: 'UNDATED_NEEDED', situation: 'UNDATED' });
    const non = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [], config: V3, decide: t4({ intervention: AUCUNE }).decide });
    expect(non).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'UNDATED_NOT_NEEDED' });
  });

  it('ATR-R-03 — incertitude technique (évaluation non rendue) : jamais transformée en tâche utilisateur', async () => {
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [], config: V3, decide: t4({ intervention: null }).decide });
    expect(r).toMatchObject({ outcome: 'DEFER', card: null, pertinence: 'UNDECIDED' });
  });
});

describe('ATR-R-04 — signature de pertinence et invalidation', () => {
  it('ATR-R-04 — la signature change avec les preuves, la situation et la configuration IA (pas avec l’ordre des candidats)', () => {
    const c = [{ iso: '2026-06-20', source: 'FACTS' }, { iso: '2026-05-01', source: 'SOURCE_UNITS' }];
    const s = ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', c, { situation: 'PAST_DEADLINE', evidence: 'a', config: 'bo:v3:t4_output_v3' });
    expect(ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', [...c].reverse(), { situation: 'PAST_DEADLINE', evidence: 'a', config: 'bo:v3:t4_output_v3' })).toBe(s);
    expect(ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', c, { situation: 'PAST_DEADLINE', evidence: 'b', config: 'bo:v3:t4_output_v3' })).not.toBe(s);
    expect(ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', c, { situation: 'PAST_DEADLINE', evidence: 'a', config: 'bo:v4:t4_output_v3' })).not.toBe(s);
    expect(ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', c, { situation: 'TITLE_ONLY', evidence: 'a', config: 'bo:v3:t4_output_v3' })).not.toBe(s);
  });

  it('ATR-R-04 — mémoire réutilisée pour les mêmes éléments (aucun appel) ; jamais une décision issue d’une panne', async () => {
    const cands = [{ iso: '2026-10-05', source: 'FACTS', excerpt: PREUVE }];
    const sig = ev.pertinenceSignature('contractEndDate', 'SERVICE_CONTRACT', cands, { situation: 'PAST_DEADLINE', evidence: 'fp', config: V3.ref });
    const { decide, calls } = t4({ intervention: AUCUNE });
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: cands, decide, config: V3, evidenceFingerprint: 'fp',
      remembered: { signature: sig, pertinence: 'NO_ACTION_NEEDED', outcome: 'NO_ACTION', aiStatus: 'OK' } });
    expect(r).toMatchObject({ cached: true, outcome: 'NO_ACTION', aiCalled: false });
    await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: cands, decide, config: V3, evidenceFingerprint: 'fp',
      remembered: { signature: sig, pertinence: 'UNDECIDED', outcome: 'DEFER', aiStatus: 'ERROR' } });
    expect(calls).toHaveLength(1);
  });

  it('ATR-R-04 — signature d’évaluation : issue, intervention, écriture, cartes, empreinte et configuration en font partie', () => {
    const r = { accountId: 1, fileId: 2, ruleCode: 'DATA-CONTRACT-END', fieldKey: 'contractEndDate', trigger: 'SWEEP' as const, targetPresent: false, userValidated: false, decision: 'NONE' as const, reasonCode: 'DEFERRED' };
    const s = ev.evaluationSignature({ ...r, outcome: 'DEFER' });
    expect(ev.evaluationSignature({ ...r, outcome: 'DEFER', reevaluateAt: '2027-01-01' })).toBe(s);
    expect(ev.evaluationSignature({ ...r, outcome: 'NO_ACTION' })).not.toBe(s);
    expect(ev.evaluationSignature({ ...r, outcome: 'DEFER', evidenceFingerprint: 'x' })).not.toBe(s);
    expect(ev.evaluationSignature({ ...r, outcome: 'DEFER', configRef: 'bo:v9' })).not.toBe(s);
  });
});

describe('ATR-R-05 — panne : aucune fausse résolution', () => {
  it('ATR-R-05 — échec technique T4 : DEFER court, `technicalFailure` (l’appelant ne ferme rien), erreur tracée', async () => {
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-10-05', source: 'FACTS' }], decide: t4({ failure: true }).decide, config: V3 });
    expect(r).toMatchObject({ outcome: 'DEFER', technicalFailure: true, aiStatus: 'ERROR', reason: 't4_failure:PROVIDER_UNAVAILABLE' });
    expect(Date.parse(r.reevaluateAt!) - Date.now()).toBeLessThanOrEqual(61 * 60_000);
  });
});

describe('ATR-R-07 — date du titre : indice, jamais preuve', () => {
  it('ATR-R-07 — titre seul, T4 v3 « aucune intervention » : DEFER (jamais NO_ACTION), titre transmis comme indice', async () => {
    const { decide, calls } = t4({ intervention: AUCUNE });
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-06-20', source: 'TITLE_ONLY', excerpt: 'Votre contrat arrive à échéance le 20:06:2026' }], decide, config: V3 });
    expect(r).toMatchObject({ outcome: 'DEFER', pertinence: 'TITLE_HINT_ONLY', situation: 'TITLE_ONLY' });
    expect(calls[0].ctx.toProcessAssessment).toMatchObject({ situation: 'TITLE_ONLY' });
    expect(calls[0].input.description).toMatch(/uniquement par le titre/);
  });

  it('ATR-R-07 — titre seul, version T4 v2 : aucun appel, aucune conclusion, décision différée', async () => {
    const { decide, calls } = t4({ v2: true, category: 'information' });
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-06-20', source: 'TITLE_ONLY' }], decide, config: V2 });
    expect(r).toMatchObject({ outcome: 'DEFER', aiCalled: false });
    expect(calls).toHaveLength(0);
  });
});

describe('ATR-R-08 — sorties T4 : valides, ambiguës, incohérentes, en erreur', () => {
  const sortie = (intervention: unknown) => ({
    task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'action', businessType: null,
    confidence: 'certain', reason: 'r', recurrenceReason: null, intervention,
  });
  it('ATR-R-08 — contrat t4_output_v3 : sortie valide acceptée ; v2 (sans bloc) toujours lisible ; incohérences de structure refusées', () => {
    expect(T4ClassifyEventV3Output.safeParse(sortie(RESTITUER)).success).toBe(true);
    expect(T4ClassifyEventV3Output.safeParse(sortie(null)).success).toBe(true);
    const { intervention: _x, ...v2 } = sortie(null);
    expect(T4ClassifyEventV3Output.safeParse(v2).success).toBe(true);
    expect(T4ClassifyEventV3Output.safeParse(sortie({ ...RESTITUER, kind: null })).success).toBe(false);
    expect(T4ClassifyEventV3Output.safeParse(sortie({ ...AUCUNE, timing: 'NOW' })).success).toBe(false);
    expect(T4ClassifyEventV3Output.safeParse(sortie({ ...RESTITUER, kind: 'INVENTED' })).success).toBe(false);
    expect(T4ClassifyEventV3Output.safeParse(sortie({ ...RESTITUER, actBy: '04/11/2026' })).success).toBe(false);
    const d = translateEventDecision(sortie(RESTITUER) as never, false);
    expect(d).toMatchObject({ contractVersion: 3, outcome: 'model_v2', intervention: { kind: 'RETURN_OR_RESTITUTE' } });
    expect(translateEventDecision(v2 as never, false).contractVersion).toBe(2);
  });

  it('ATR-R-08 — contrôle serveur : non demandée → ignorée ; libellé au vocabulaire interdit → remplacé ; date limite invalide → écartée', () => {
    expect(checkInterventionCoherence(RESTITUER, { requested: false, providedText: PREUVE })).toBeNull();
    const c = checkInterventionCoherence({ ...RESTITUER, action: 'Suivre la recommandation du modèle IA' }, { requested: true, providedText: PREUVE });
    expect(c).toMatchObject({ needed: 'yes', action: null });
    expect(c!.warnings).toContain('ACTION_LABEL_REPLACED');
    expect(iv.interventionQuestion(c!)).toBe('Restituer ce qui est prévu par ce document (avant le 04/11/2026)');
    expect(checkInterventionCoherence({ ...RESTITUER, actBy: '2026-02-31' }, { requested: true, providedText: PREUVE })!.actBy).toBeNull();
  });

  it('ATR-R-08 — ambiguë (uncertain) : décision différée ; demande d’évaluation transmise dans le contexte T4 (variables)', async () => {
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-10-05', source: 'FACTS' }], config: V3,
      decide: t4({ intervention: { ...AUCUNE, needed: 'uncertain', timing: 'NONE' } }).decide });
    expect(r).toMatchObject({ outcome: 'DEFER', pertinence: 'UNDECIDED' });
    const vars = classifyEventVariables({ title: 'Fin de contrat', originType: 'qualified_document' } as never,
      { accountId: 1, toProcessAssessment: { contractVersion: 'atr-decision-v1', situation: 'UNDATED', dataKey: 'contractEndDate', question: 'q', today: TODAY, candidates: [], documentDates: [], documentTitle: null } });
    expect((vars.EVENT_CONTEXT as Record<string, unknown>).toProcessAssessment).toMatchObject({ situation: 'UNDATED' });
    expect((classifyEventVariables({ title: 'X', originType: 'manual' } as never, { accountId: 1 }).EVENT_CONTEXT as Record<string, unknown>).toProcessAssessment).toBeUndefined();
  });

  it('ATR-R-08 — recette (runner) : corpus complet, attentes cohérentes ; cas déterministes sans appel IA ; T4 simulé générique', async () => {
    const { decide, calls } = t4({});
    // T4 simulé GÉNÉRIQUE : lit seulement l'extrait transmis (jamais une règle par cas).
    const simule: Decide = async (input, ctx) => {
      calls.push({ input, ctx });
      const x = `${ctx.excerpt ?? ''} ${input.description ?? ''}`;
      const restituer = /restituer/i.test(x);
      const reconduit = /reconduit/i.test(x);
      const out = restituer
        ? { ...RESTITUER, evidence: 'doit restituer le matériel loué dans un délai de 30 jours' }
        : reconduit ? { needed: 'yes', kind: 'RENEW_OR_DECIDE', action: 'Décider de la reconduction du contrat', justification: 'Reconduction tacite.', consequence: null, evidence: 'reconduit tacitement', timing: 'NOW', actBy: null, dataNeeded: false }
          : /télésurveillance/i.test(x) ? { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin', justification: 'Engagement en cours.', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true }
            : AUCUNE;
      return { ...translateEventDecision({ task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'information', businessType: null, confidence: 'certain', reason: 's', recurrenceReason: null, intervention: out } as never, false), traceId: 't' };
    };
    void decide;
    const res = [];
    for (const c of rec.RELEVANCE_RECETTE_CASES) res.push(await rec.runRecetteCase(c, { accountId: 1, today: TODAY, config: V3, decide: simule }));
    expect(res.filter((r) => !r.ok).map((r) => `${r.caseId}: ${r.problems.join(', ')}`)).toEqual([]);
    expect(res.filter((r) => rec.RELEVANCE_RECETTE_CASES.find((c) => c.id === r.caseId)!.deterministic).every((r) => !r.aiCalled)).toBe(true);
    expect(rec.RELEVANCE_RECETTE_CASES.length).toBeGreaterThanOrEqual(12);
    // Une sortie contraire est détectée (ex. NO_ACTION sur le seul titre).
    const titre = rec.RELEVANCE_RECETTE_CASES.find((c) => c.id === 'ATR-REC-11')!;
    expect(rec.checkRecetteResult(titre, { outcome: 'NO_ACTION', card: null, kind: null, aiCalled: true })).toContain('issue interdite : NO_ACTION');
  });
});

describe('ATR-P-01 / ATR-P-02 — calcul déterministe (étape A)', () => {
  const spec = dv.derivationFor('contractEndDate')!;
  const f = (value: string, confidence = 'certain', source = 'FACTS', key: string | null = null) => ({ value, confidence, source, key });

  it('ATR-P-01 — durées lues : mois, années, années et mois ; formes refusées', () => {
    expect(dv.parseDurationMonths('240 mois')).toBe(240);
    expect(dv.parseDurationMonths('20 ans')).toBe(240);
    expect(dv.parseDurationMonths('25 années')).toBe(300);
    expect(dv.parseDurationMonths('2 ans et 6 mois')).toBe(30);
    expect(dv.parseDurationMonths('36', 'dureeMois')).toBe(36);
    expect(dv.parseDurationMonths('36')).toBeNull();
    expect(dv.parseDurationMonths('durée indéterminée')).toBeNull();
    expect(dv.parseDurationMonths('90 jours')).toBeNull();
  });

  it('ATR-P-01 — prêt : début effectif + durée fiables → échéance THÉORIQUE (fin incluse), provenance complète', () => {
    expect(dv.endFromStart('2020-01-01', 12)).toBe('2020-12-31');
    expect(dv.endFromStart('2022-03-15', 240)).toBe('2042-03-14');
    const r = dv.computeDerivation(spec, [f('2022-03-15')], [f('240 mois')]);
    expect(r).toMatchObject({ status: 'CALCULATED_RELIABLE', value: '2042-03-14', method: 'START_PLUS_DURATION', convention: 'END_INCLUSIVE',
      start: { value: '2022-03-15', source: 'FACTS' }, duration: { months: 240 } });
  });

  it('ATR-P-01 — sources incertaines : candidat seulement (jamais écrit) ; contradictoires : ambigu', () => {
    expect(dv.computeDerivation(spec, [f('2022-03-15', 'probable', 'SOURCE_UNITS')], [f('240 mois')]).status).toBe('CALCULATED_PROBABLE');
    expect(dv.computeDerivation(spec, [f('2022-03-15'), f('2022-04-01')], [f('240 mois')]).status).toBe('AMBIGUOUS');
  });

  it('ATR-P-02 — prêt avec simple date d’édition : jamais un début effectif (libellés et clés écartés)', () => {
    expect(dv.labelIsEffectiveStart('Date d’édition', spec)).toBe(false);
    expect(dv.labelIsEffectiveStart('Date de signature du contrat', spec)).toBe(false);
    expect(dv.labelIsEffectiveStart('Date d’effet du contrat', spec)).toBe(true);
    expect(dv.labelIsEffectiveStart('Date de début du prêt', spec)).toBe(true);
    expect(spec.start.keys).not.toContain('documentDate');
    expect(dv.computeDerivation(spec, [], [f('20 ans')])).toMatchObject({ status: 'NOT_DERIVABLE', reason: 'no_effective_start', value: null });
  });

  it('ATR-P-01 — déclaré par DONNÉE (fin de contrat, fin de garantie), jamais par type de document', () => {
    expect(dv.DERIVATIONS.map((d) => d.target).sort()).toEqual(['contractEndDate', 'warrantyEndDate']);
    expect(JSON.stringify(dv.DERIVATIONS)).not.toMatch(/pneu|gardiennage|FINANCING_CONTRACT/i);
    expect(dv.derivationFor(WARRANTY.fieldKey!)).not.toBeNull();
  });
});

describe('ATR-P-04 / ATR-P-05 — temporalité et contrat de décision', () => {
  it('ATR-P-04 — échéance future lointaine : DEFER jusqu’à 120 jours avant ; proche : question utile ; aucun appel IA', async () => {
    const { decide, calls } = t4({});
    const loin = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2027-12-01', source: 'SOURCE_UNITS' }], decide, config: V3 });
    expect(loin).toMatchObject({ outcome: 'DEFER', reevaluateAt: '2027-08-03T00:00:00.000Z' });
    const proche = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-12-01', source: 'SOURCE_UNITS' }], decide, config: V3 });
    expect(proche).toMatchObject({ outcome: 'CREATE_ACTION', card: 'DATA_QUESTION' });
    expect(calls).toHaveLength(0);
  });

  it('ATR-P-05 — contrat de décision interne : entité, problème, intervention, conséquence, insuffisance de l’automatique, temporalité, fiabilité, décision, motif', async () => {
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: [{ iso: '2026-10-05', source: 'FACTS', excerpt: PREUVE }], decide: t4({ intervention: RESTITUER }).decide, config: V3 });
    expect(r.contract).toMatchObject({
      version: 'atr-decision-v1', ruleCode: 'DATA-CONTRACT-END', dataKey: 'contractEndDate', fileId: 2, documentType: 'SERVICE_CONTRACT',
      problem: 'DEADLINE_INTERVENTION', intervention: { kind: 'RETURN_OR_RESTITUTE', actBy: '2026-11-04' }, consequence: 'Matériel facturé',
      temporal: { situation: 'PAST_DEADLINE', today: TODAY, candidates: ['2026-10-05'] }, reliability: { level: 'HIGH', sources: ['FACTS'] },
      decision: 'CREATE_ACTION',
    });
    expect(r.contract!.autoResolution).toMatch(/incertaines/);
  });
});

// ATR-P-09 (issue de chaque carte dans la campagne rétroactive) : RETIRÉ au lot 83E avec le moteur de campagne
// (C-Q9) — la réévaluation est un contrôle du registre de cohérence (L83E-U-RELEVANCE, L83E-E2E-03).

describe('ATR-P-11 — catalogue et présentation', () => {
  it('ATR-P-11 — intervention : règle distincte de la donnée, producteur dédié, jamais parcourue comme une donnée du pont', () => {
    expect(checkRulesCatalog()).toEqual([]);
    expect(getRule('DOC-INTERVENTION')).toMatchObject({ producer: 'DOCUMENT_INTERVENTION', completePriority: null, allowNotApplicable: true });
    expect(RULE_PRODUCERS.DOCUMENT_INTERVENTION.module).toBe('src/services/to-process/document-intervention.ts');
    expect(documentBridgeRules().map((r) => r.code)).not.toContain('DOC-INTERVENTION');
    expect(iv.interventionKey('contractEndDate')).toBe('intervention:contractEndDate');
    expect(iv.INTERVENTION_CHOICES.map((c) => c.value)).toEqual(['DONE', 'NOT_NEEDED']);
  });
});

describe('ATR-P-10 — T6 : jamais une relance qui contredit une décision « À traiter »', () => {
  it('ATR-P-10 — échéance passée réglée par « À traiter » : sujet clos pour T6 (SUBJECT_CLOSED), hors décompte des dépassées ; une échéance future réglée (intervention tranchée) n’est plus relancée (lot 72, ATP-FIX-17)', async () => {
    const { t6Candidates } = await import('@/services/home/mascot/t6-interpellation.service');
    const { decideT6Interpellation } = await import('@/services/home/mascot/t6-interpellation');
    const { openOverdueCount } = await import('@/services/home/mascot/signals');
    const ligne = (id: number, date: string) => ({ id, title: 'Fin de contrat', date, forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison' });
    const raw = {
      accountId: 1, today: TODAY, processing: null, onboarding: null, toProcess: [], acknowledgments: [],
      agenda: [ligne(10, '2026-09-20'), ligne(11, '2026-12-20'), ligne(12, '2026-09-25')],
      overdueAgenda: [{ id: 10, date: '2026-09-20' }, { id: 12, date: '2026-09-25' }],
      toProcessSettledAgendaIds: [10, 11],
    } as never;
    const c = t6Candidates(raw);
    expect(c.find((x) => x.candidate.agendaItemId === 10)!.candidate.state).toBe('RESOLVED');
    // Lot 72 (ATP-FIX-17) : la lecture commune ne renvoie une échéance future
    // que si l'utilisateur a tranché son intervention — T6 ne la relance plus.
    expect(c.find((x) => x.candidate.agendaItemId === 11)!.candidate.state).toBe('RESOLVED');
    expect(c.find((x) => x.candidate.agendaItemId === 12)!.candidate.state).toBe('ACTIVE');
    const d = decideT6Interpellation({ candidate: c.find((x) => x.candidate.agendaItemId === 10)!.candidate, today: TODAY, thresholdDays: 60, aiCapable: true, assessment: null, preferences: [] });
    expect(d).toMatchObject({ decision: 'SUPPRESS', code: 'SUBJECT_CLOSED' });
    expect(openOverdueCount(raw)).toBe(1);
  });
});

describe('ATR-P-07 — contradiction entre valeurs fiables', () => {
  it('ATR-P-07 — deux dates FIABLES contradictoires : arbitrage justifié même lointain (jamais différé, jamais écrasé) ; sans contradiction : différé', async () => {
    const c = [{ iso: '2027-06-30', source: 'FACTS' }, { iso: '2028-06-30', source: 'FACTS' }];
    const r = await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: c, config: V3, contradictory: true });
    expect(r).toMatchObject({ outcome: 'CREATE_ACTION', card: 'DATA_QUESTION', pertinence: 'CONTRADICTION', aiCalled: false });
    expect((await ev.assessDeadlinePertinence({ ...base, rule: CONTRACT, candidates: c, config: V3 })).outcome).toBe('DEFER');
  });
});
