/**
 * Lot 72C — ticket « [P1] À traiter — Corriger les écarts résiduels de
 * pertinence, de calcul et de réévaluation » : décisions PURES (sans base).
 * Les écritures, cartes et traces réellement persistées sont vérifiées sur
 * PostgreSQL 16 (`src/test/e2e/scenarios/l72c-a-traiter-ecarts.e2e.ts`).
 *
 *  ATP-FIX-01 à 04  calculs de durée (C1)
 *  ATP-FIX-05 / 06  ancienneté jamais preuve, fin effective prouvée (C2)
 *  ATP-FIX-09       configuration T4 : empreinte de contenu (C3)
 *  ATP-FIX-10 / 11  admissibilité agenda (C4) ; équipements, fournisseurs
 *  ATP-FIX-12 / 13  « Non applicable » : nouveau problème démontré (C5)
 *  ATP-FIX-15       campagne : issues multi-familles (C6)
 *  ATP-FIX-16       nature des décisions sans carte (C7)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const dv = await import('../document-derivations');
const ev = await import('../document-field-evidence');
const adm = await import('../admissibility');
const prod = await import('../producers.service');
const bridge = await import('../document-rule-bridge');
const camp = await import('../relevance-campaign.service');
const relevance = await import('@/services/coherence/registry/checks/to-process-relevance');
const iv = await import('../document-intervention');
const { getRule } = await import('../rules-catalog');

const spec = dv.derivationFor('contractEndDate')!;
const fait = (value: string, p: { confidence?: string; source?: string; key?: string | null; label?: string | null; excerpt?: string | null } = {}) =>
  ({ value, confidence: p.confidence ?? 'certain', source: p.source ?? 'FACTS', key: p.key ?? null, label: p.label ?? null, excerpt: p.excerpt ?? null });
const CONTRACT = getRule('DATA-CONTRACT-END')!;
const TODAY = '2026-10-19';
const V3 = { ref: 'repo:t4_output_v3', interventionCapable: true };
const base = { accountId: 1, fileId: 2, documentType: 'SERVICE_CONTRACT', today: TODAY, rule: CONTRACT };

describe('C1 — calculs déterministes', () => {
  it('ATP-FIX-01 — prêt de 240 mois avec 12 mois de différé inclus : 240 mois, jamais 252 (et autres contrats)', () => {
    expect(dv.analyzeDuration('240 mois, dont 12 mois de différé')).toMatchObject({ months: 240, reliable: true, status: 'TOTAL_WITH_INCLUDED' });
    expect(dv.analyzeDuration('Durée totale de 240 mois, différé de 12 mois inclus')).toMatchObject({ months: 240, reliable: true });
    expect(dv.parseDurationMonths('240 mois, dont 12 mois de différé')).toBe(240);
    // Crédit-bail, location : même mécanique, jamais une somme.
    expect(dv.parseDurationMonths('60 mois dont 6 mois de franchise de loyer')).toBe(60);
    expect(dv.parseDurationMonths('12 mois avec préavis de 2 mois')).toBe(12);
    expect(dv.parseDurationMonths('20 ans soit 240 mois')).toBe(240);
    const r = dv.computeDerivation(spec, [fait('2022-03-15', { label: 'Date d’effet' })], [fait('240 mois, dont 12 mois de différé')]);
    expect(r).toMatchObject({ status: 'CALCULATED_RELIABLE', value: dv.endFromStart('2022-03-15', 240), duration: { months: 240, status: 'TOTAL_WITH_INCLUDED' } });
    expect(r.value).not.toBe(dv.endFromStart('2022-03-15', 252));
  });

  it('ATP-FIX-01 — « 2 ans et 6 mois » reste 30 mois (une seule durée)', () => {
    expect(dv.analyzeDuration('2 ans et 6 mois')).toMatchObject({ months: 30, reliable: true, status: 'SIMPLE' });
    expect(dv.parseDurationMonths('un an')).toBe(12);
  });

  it('ATP-FIX-02 — contrat de 12 mois renouvelable : pas de durée de 24 mois présumée, aucun calcul fiable', () => {
    const a = dv.analyzeDuration('12 mois renouvelables pour 12 mois');
    expect(a).toMatchObject({ months: 12, reliable: false, status: 'INITIAL_TERM_RENEWABLE' });
    expect(dv.parseDurationMonths('12 mois renouvelables pour 12 mois')).toBeNull();
    expect(dv.analyzeDuration('abonnement d’un an reconductible tacitement')).toMatchObject({ months: 12, reliable: false, status: 'INITIAL_TERM_RENEWABLE' });
    expect(dv.analyzeDuration('12 mois, prolongeable de 6 mois')).toMatchObject({ months: 12, reliable: false, status: 'INITIAL_TERM_EXTENSIBLE' });
    const r = dv.computeDerivation(spec, [fait('2025-01-01')], [fait('12 mois renouvelables pour 12 mois')]);
    expect(r.status).toBe('CALCULATED_PROBABLE');
    expect(r.value).toBe('2025-12-31');
    expect(r.assumptions?.join(' ')).toMatch(/INITIALE/);
    // La CLAUSE qui révèle la reconduction rend une valeur simple non fiable.
    expect(dv.computeDerivation(spec, [fait('2025-01-01')], [fait('12 mois', { excerpt: 'Durée : 12 mois, renouvelable par tacite reconduction.' })]).status).toBe('CALCULATED_PROBABLE');
  });

  it('ATP-FIX-03 — durée composite ambiguë : aucune écriture fiable automatique', () => {
    for (const t of ['36 ou 48 mois', 'de 12 à 24 mois', '12 mois de différé puis 228 mois', '3 ans, puis 2 ans', '24 mois à compter de la livraison',
      '36 mois minimum', 'durée indéterminée', '240 mois et un différé de 12 mois']) {
      const a = dv.analyzeDuration(t);
      expect(a.reliable, t).toBe(false);
      const r = dv.computeDerivation(spec, [fait('2024-05-01')], [fait(t)]);
      expect(r.status, t).not.toBe('CALCULATED_RELIABLE');
    }
    // Conventions de fin contradictoires : jamais fiable ; convention lue : appliquée.
    expect(dv.computeDerivation(spec, [fait('2024-05-01')], [fait('12 mois de date à date', { excerpt: '12 mois de date à date, jusqu’au dernier jour du mois' })]).status).not.toBe('CALCULATED_RELIABLE');
    const anniv = dv.computeDerivation(spec, [fait('2024-05-01')], [fait('1 an de date à date')]);
    expect(anniv).toMatchObject({ status: 'CALCULATED_RELIABLE', convention: 'ANNIVERSARY', value: '2025-05-01' });
    expect(dv.endFromStart('2024-05-10', 12, 'END_OF_MONTH')).toBe('2025-05-31');
    expect(dv.computeDerivation(spec, [fait('2024-05-01')], [fait('12 mois')]).assumptions?.join(' ')).toMatch(/convention par défaut/);
  });

  it('ATP-FIX-04 — date d’édition / de signature / de première échéance + durée : pas de date de fin déduite', () => {
    // Clé canonique « début » posée par T1 sur une date d'édition : le libellé l'emporte.
    expect(dv.computeDerivation(spec, [fait('2024-02-01', { key: 'contractStartDate', label: 'Date d’édition' })], [fait('20 ans')]))
      .toMatchObject({ status: 'NOT_DERIVABLE', reason: 'start_is_not_effective', value: null });
    expect(dv.computeDerivation(spec, [fait('2024-02-01', { key: 'contractStartDate', label: 'Date de première échéance' })], [fait('20 ans')]).status).toBe('NOT_DERIVABLE');
    expect(dv.computeDerivation(spec, [fait('2024-02-01', { key: 'contractStartDate', excerpt: 'Signé le 01/02/2024' })], [fait('20 ans')]).status).toBe('NOT_DERIVABLE');
    // Début égal à la date d'édition lue ailleurs, sans libellé « date d'effet » : jamais fiable.
    expect(dv.computeDerivation(spec, [fait('2024-02-01', { key: 'contractStartDate' })], [fait('20 ans')], () => null, { nonStartDates: ['2024-02-01'] }))
      .toMatchObject({ status: 'CALCULATED_PROBABLE', reason: 'start_equals_document_date' });
    // Avec un libellé « date d'effet » explicite : la coïncidence n'empêche pas le calcul.
    expect(dv.computeDerivation(spec, [fait('2024-02-01', { key: 'contractStartDate', label: 'Date d’effet' })], [fait('20 ans')], () => null, { nonStartDates: ['2024-02-01'] }).status)
      .toBe('CALCULATED_RELIABLE');
  });
});

describe('C2 — ancienneté : indice, jamais preuve', () => {
  const ancien = [{ key: 'contractStartDate', iso: '2020-06-01', confidence: 'certain' }];
  const aucuneIntervention = async () => ({ outcome: 'ok', agendaDecision: 'accept', classification: { category: 'information' }, contractVersion: 3, reason: 's', traceId: 't',
    intervention: { needed: 'no', kind: null, action: null, justification: 'aucune démarche', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false } }) as never;

  it('ATP-FIX-05 — contrat signé il y a six ans, toujours reconductible : jamais NO_ACTION sur l’âge (ni par T4 sans preuve de fin)', async () => {
    const sansSignal = await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: ancien, config: V3, decide: aucuneIntervention });
    expect(sansSignal).toMatchObject({ outcome: 'DEFER', pertinence: 'UNDATED_HISTORICAL', aiCalled: false, card: null });
    expect(sansSignal.reevaluateAt).not.toBeNull();
    const reconductible = { renewal: true, terminated: false, residual: false, signals: [] };
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: ancien, config: V3, decide: aucuneIntervention, lifecycle: reconductible });
    expect(r.outcome).not.toBe('NO_ACTION');
    expect(r).toMatchObject({ outcome: 'DEFER', reason: expect.stringContaining('renewable_contract_requires_evidence'), aiCalled: true });
    // Version T4 sans contrat structuré : jamais écartée sur l'âge — lot 75I (D) : ni question par défaut, décision prudente signalée.
    expect(await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: ancien, config: { ref: 'bo:v2:t4_output_v2', interventionCapable: false }, lifecycle: reconductible }))
      .toMatchObject({ outcome: 'DEFER', pertinence: 'T4_INCOMPATIBLE', card: null });
    // Date contextuelle peu fiable : ne situe pas le document.
    const probable = await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: [{ key: 'documentDate', iso: '2015-01-01', confidence: 'probable' }], config: { ref: 'x', interventionCapable: false } });
    expect(probable.pertinence).not.toBe('UNDATED_HISTORICAL');
  });

  it('ATP-FIX-06 — contrat réellement clos, sans obligation : NO_ACTION (preuve), aucune carte ; obligation résiduelle → jamais NO_ACTION déterministe', async () => {
    const clos = await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: ancien, config: V3, lifecycle: { renewal: false, terminated: true, residual: false, signals: [] } });
    expect(clos).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'CONTRACT_TERMINATED', card: null, aiCalled: false });
    const residuel = await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: ancien, config: V3, lifecycle: { renewal: false, terminated: true, residual: true, signals: [] } });
    expect(residuel.outcome).not.toBe('NO_ACTION');
  });

  it('ATP-FIX-05 / 06 — signaux de cycle de vie lus dans les textes (vocabulaire générique)', () => {
    expect(ev.lifecycleSignalsOf(['Le contrat est reconduit tacitement par périodes d’un an.'])).toMatchObject({ renewal: true, terminated: false });
    expect(ev.lifecycleSignalsOf(['Contrat non renouvelable, il a pris fin le 31/12/2019.'])).toMatchObject({ renewal: false, terminated: true });
    expect(ev.lifecycleSignalsOf(['Résiliation effective au 30/06/2019. Le matériel doit être restitué.'])).toMatchObject({ terminated: true, residual: true });
    expect(ev.lifecycleSignalsOf(['Facture du mois de mars.'])).toMatchObject({ renewal: false, terminated: false, residual: false });
  });
});

describe('C3 — invalidation de la connaissance et de la configuration', () => {
  it('ATP-FIX-09 — empreinte de la configuration T4 : révision sauvegardée détectée, remise en forme sans incidence ignorée', () => {
    const master = { content: 'Tu es T4.\nClasse l’événement.', execution: { mode: 'STRUCTURED_CONTEXT', outputContractVersion: 't4_output_v3' } };
    const entry = { prompt: '', primaryModel: 'modele-a', reasoningPrimary: 'low', guardrails: [], triggers: [{ kind: 'event', code: 'x', active: true }] };
    const h = ev.t4ContentHash({ master, entry });
    expect(ev.t4ContentHash({ master: { ...master, content: 'Tu es T4.   Classe l’événement.' }, entry })).toBe(h);
    expect(ev.t4ContentHash({ master: { ...master, content: 'Tu es T4. Classe et justifie.' }, entry })).not.toBe(h);
    expect(ev.t4ContentHash({ master, entry: { ...entry, primaryModel: 'modele-b' } })).not.toBe(h);
    // Déclencheurs (planification) : sans incidence sur une décision.
    expect(ev.t4ContentHash({ master, entry: { ...entry, triggers: [] } })).toBe(h);
    // Décision prise sans l'IA : référence indépendante du texte et du modèle T4.
    expect(ev.deterministicConfigRef({ interventionCapable: true })).toBe('det:structured');
    expect(ev.deterministicConfigRef({ interventionCapable: false })).toBe('det:legacy');
  });
});

describe('C4 — contrôle d’admissibilité commun', () => {
  const evt = { homeCategory: null, originType: 'qualified_document', isAutomatic: true, isAutomaticModified: false, requiresQualification: false, createdAt: '2026-01-01', sourceDate: null };
  const now = new Date('2026-10-19T10:00:00Z');

  it('ATP-FIX-10 — événement informatif sans date : aucune complétion ; qualification en cours : différée', () => {
    expect(prod.agendaDateAdmissibility({ ...evt, homeCategory: 'information' }, now)).toMatchObject({ outcome: 'NO_ACTION', reason: 'INFORMATIONAL_EVENT', decisive: 'neededForUse' });
    // Événement saisi sans catégorie : rien ne prouve qu'il est facultatif → question conservée (variante prudente).
    expect(prod.agendaDateAdmissibility({ ...evt, originType: 'manual', isAutomatic: false }, now).outcome).toBe('CREATE_ACTION');
    // Qualification T4 en cours, récente : pas maintenant (aucune carte).
    expect(prod.agendaDateAdmissibility({ ...evt, requiresQualification: true, createdAt: '2026-10-18' }, now)).toMatchObject({ outcome: 'DEFER', reason: 'QUALIFICATION_PENDING' });
  });

  it('ATP-FIX-11 — événement nécessitant une date : carte si la résolution automatique est impossible ; date retrouvée → résolue', () => {
    // Lot 76 (C5, RES-13) : la nécessité d'une date est JUSTIFIÉE (catégorie « action »), jamais présumée.
    const action = { ...evt, homeCategory: 'action' };
    expect(prod.agendaDateAdmissibility(action, now)).toMatchObject({ outcome: 'CREATE_ACTION' });
    expect(prod.agendaDateAdmissibility(evt, now)).toMatchObject({ outcome: 'DEFER' });
    expect(prod.agendaDateAdmissibility({ ...evt, homeCategory: 'action', originType: 'manual', isAutomatic: false }, now)).toMatchObject({ outcome: 'CREATE_ACTION' });
    expect(prod.agendaDateAdmissibility({ ...evt, sourceDate: '2027-01-31' }, now)).toMatchObject({ outcome: 'AUTO_RESOLVED', reason: 'DATE_FOUND_AT_SOURCE' });
    // Événement modifié par l'utilisateur : jamais réécrit automatiquement → question.
    expect(prod.agendaDateAdmissibility({ ...action, sourceDate: '2027-01-31', isAutomaticModified: true }, now)).toMatchObject({ outcome: 'CREATE_ACTION' });
    // Qualification ancienne (jamais aboutie) : la question n'est plus retenue indéfiniment.
    expect(prod.agendaDateAdmissibility({ ...action, requiresQualification: true, createdAt: '2026-09-01' }, now).outcome).toBe('CREATE_ACTION');
  });

  it('C4 — équipements et fournisseurs : jamais une information connue ni une confirmation facultative sans proposition', () => {
    const eq = { status: 'EN_SERVICE', archivedAt: null, knownAssetId: null, liveAssets: 2 };
    expect(prod.equipmentLinkAdmissibility(eq).outcome).toBe('CREATE_ACTION');
    expect(prod.equipmentLinkAdmissibility({ ...eq, knownAssetId: 9 })).toMatchObject({ outcome: 'AUTO_RESOLVED', reason: 'ASSET_KNOWN_FROM_ROOM' });
    expect(prod.equipmentLinkAdmissibility({ ...eq, status: 'TRANSMIS' })).toMatchObject({ outcome: 'NO_ACTION', reason: 'EQUIPMENT_INACTIVE' });
    expect(prod.equipmentLinkAdmissibility({ ...eq, liveAssets: 0 })).toMatchObject({ outcome: 'DEFER', reason: 'NO_LIVE_ASSET_TO_ATTACH' });
    expect(prod.supplierIdentityAdmissibility({ detectedValue: null, currentValue: 'ACME' })).toMatchObject({ outcome: 'NO_ACTION', reason: 'NO_EXPLOITABLE_PROPOSAL' });
    expect(prod.supplierIdentityAdmissibility({ detectedValue: 'Acmé ', currentValue: 'ACME' })).toMatchObject({ outcome: 'NO_ACTION', reason: 'SAME_VALUE_AS_CURRENT' });
    expect(prod.supplierIdentityAdmissibility({ detectedValue: 'Acme Services', currentValue: 'ACME' }).outcome).toBe('CREATE_ACTION');
  });

  it('C4 — ordre des questions : erreur technique jamais une décision ; décision utilisateur avant tout', () => {
    const toutVrai = { realProblem: true, neededForUse: true, autoResolvable: false, userActionNeeded: true, timely: true, userDecided: false };
    expect(adm.decideAdmissibility({ ruleCode: 'X', checks: toutVrai }).outcome).toBe('CREATE_ACTION');
    expect(adm.decideAdmissibility({ ruleCode: 'X', checks: toutVrai, error: 'lecture' }).outcome).toBe('ERROR');
    expect(adm.decideAdmissibility({ ruleCode: 'X', checks: { ...toutVrai, userDecided: true, autoResolvable: true } })).toMatchObject({ outcome: 'NO_ACTION', decisive: 'userDecided' });
  });
});

describe('C5 — décisions « Non applicable » réévaluables', () => {
  const complete = { kind: 'UPSERT' as const, actionKind: 'COMPLETE' as const, proposals: [], reason: 'REQUIRED_DATA_MISSING' };
  const arbitrage = (v: string) => ({ kind: 'UPSERT' as const, actionKind: 'ARBITRATE' as const, proposals: [{ value: v, label: v, confidence: 0.6 }], reason: 'X' });

  it('ATP-FIX-12 — « Non applicable », aucune preuve nouvelle : aucune réouverture (même question, mêmes valeurs)', () => {
    expect(bridge.newProblemSinceNotApplicable(complete, { values: [] })).toBe(false);
    expect(bridge.newProblemSinceNotApplicable(arbitrage('2027-01-31'), { values: ['2027-01-31'] })).toBe(false);
    // Intervention : même nature, même échéance → décision respectée.
    expect(iv.sameIntervention({ kind: 'TERMINATE', actBy: '2026-12-01' }, { kind: 'TERMINATE', actBy: '2026-12-01' })).toBe(true);
  });

  it('ATP-FIX-13 — « Non applicable », nouvelle obligation prouvée : réévaluation contrôlée', () => {
    expect(bridge.newProblemSinceNotApplicable(arbitrage('2028-06-30'), { values: ['2027-01-31'] })).toBe(true);
    expect(bridge.newProblemSinceNotApplicable(arbitrage('2028-06-30'), null)).toBe(true);
    expect(iv.sameIntervention({ kind: 'TERMINATE', actBy: '2026-12-01' }, { kind: 'TERMINATE', actBy: '2027-12-01' })).toBe(false);
    expect(iv.sameIntervention({ kind: 'TERMINATE', actBy: null }, { kind: 'RETURN_OR_RESTITUTE', actBy: null })).toBe(false);
  });
});

describe('C6 / C7 — campagne et traçabilité', () => {
  it('ATP-FIX-15 (lot 83E) — familles de la réévaluation rétroactive : contrôle du registre (campagne retirée), familles lisibles dans l’historique', async () => {
    // Lot 83E (C-Q9) : issues de campagne retirées avec le moteur ; mêmes familles réévaluées par COH-TODO-RELEVANCE-CARDS.
    expect(await relevance.relevanceCardRuleCodes()).toEqual(expect.arrayContaining(['DOC-INTERVENTION', 'DATA-AGENDA-DATE', 'LINK-EQUIP-ASSET', 'SUPPLIER-IDENTITY']));
    expect(await relevance.documentFieldRuleCodes()).toEqual(expect.arrayContaining(['DATA-CONTRACT-END']));
    expect(camp.familyOfRule('DATA-AGENDA-DATE')).toBe('AGENDA_ITEM');
  });

  it('ATP-FIX-16 — nature d’une décision : absence d’information, de pertinence, report, résolution, refus utilisateur, échec technique', () => {
    const k = (p: Partial<Parameters<typeof ev.decisionKindOf>[0]>) => ev.decisionKindOf({ decision: 'NONE', reasonCode: 'X', outcome: null, errorKind: null, targetPresent: false, ...p });
    expect(k({ reasonCode: 'NO_ACTION_EXPECTED' })).toBe('MISSING_INFO_NOT_REQUIRED');
    expect(k({ reasonCode: 'NOT_RELEVANT', outcome: 'NO_ACTION' })).toBe('NOT_RELEVANT');
    expect(k({ reasonCode: 'DEFERRED', outcome: 'DEFER' })).toBe('DEFERRED');
    expect(k({ decision: 'WRITE', outcome: 'AUTO_RESOLVED' })).toBe('AUTO_RESOLVED');
    expect(k({ reasonCode: 'USER_NOT_APPLICABLE_UNCHANGED', outcome: 'NO_ACTION' })).toBe('USER_REFUSED');
    expect(k({ reasonCode: 'DEFERRED_TECHNICAL_FAILURE', outcome: 'DEFER' })).toBe('TECHNICAL_FAILURE');
    expect(k({ decision: 'ERROR', outcome: 'ERROR' })).toBe('TECHNICAL_FAILURE');
    expect(k({ reasonCode: 'ALREADY_SATISFIED', targetPresent: true })).toBe('ALREADY_KNOWN');
    expect(k({ decision: 'CREATE', outcome: 'CREATE_ACTION' })).toBe('CARD_CREATED');
    const d = adm.decideAdmissibility({ ruleCode: 'DATA-AGENDA-DATE', checks: { realProblem: true, neededForUse: false, autoResolvable: null, userActionNeeded: true, timely: true, userDecided: null }, motives: { neededForUse: 'INFORMATIONAL_EVENT' } });
    expect(adm.familyDecisionKind({ decision: d, effect: 'NONE' })).toBe('MISSING_INFO_NOT_REQUIRED');
    // Déduplication : même décision → même signature (aucune trace illimitée).
    const rec = { accountId: 1, targetType: 'AGENDA_ITEM', targetId: 3, ruleCode: 'DATA-AGENDA-DATE', dataKey: 'date', trigger: 'SWEEP' as const, decision: d, effect: 'NONE' as const };
    expect(adm.familyDecisionSignature(rec)).toBe(adm.familyDecisionSignature({ ...rec, trigger: 'BACKFILL', runRef: 'autre' }));
    expect(adm.familyDecisionSignature(rec)).not.toBe(adm.familyDecisionSignature({ ...rec, effect: 'CLOSED' }));
  });
});
