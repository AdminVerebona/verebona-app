/**
 * Lot 76C — ticket « [P1] À traiter — Corriger les défauts résiduels du lot
 * 72C et sécuriser la réévaluation » : décisions PURES (sans base). Les
 * valeurs, cartes, décisions, traces et campagnes réellement persistées sont
 * vérifiées sur PostgreSQL 16 (`src/test/e2e/scenarios/l76c-a-traiter-residuels.e2e.ts`).
 *
 *  RES-01 à RES-04  calculs de durée (C1)
 *  RES-05 à RES-09  preuve de fin effective du contrat (C2)
 *  RES-10           configuration T4 incompatible, absente, sortie invalide (C3)
 *  RES-13 à RES-15  admissibilité sans présomption (C5)
 *  RES-16 à RES-18  décisions de l'utilisateur et nouveau problème (C6)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const dv = await import('../document-derivations');
const ev = await import('../document-field-evidence');
const adm = await import('../admissibility');
const prod = await import('../producers.service');
const bridge = await import('../document-rule-bridge');
const iv = await import('../document-intervention');
const { getRule } = await import('../rules-catalog');
const { translateEventDecision } = await import('@/services/ai/agenda/master/classify-event');

const spec = dv.derivationFor('contractEndDate')!;
const fait = (value: string, p: { confidence?: string; excerpt?: string | null; label?: string | null } = {}) =>
  ({ value, confidence: p.confidence ?? 'certain', source: 'FACTS', key: null, label: p.label ?? null, excerpt: p.excerpt ?? null });
const CONTRACT = getRule('DATA-CONTRACT-END')!;
const TODAY = '2026-10-21';
const V3 = { ref: 'repo:t4_output_v3', interventionCapable: true };
const V2 = { ref: 'bo:v7:t4_output_v2', interventionCapable: false };
const base = { accountId: 1, fileId: 2, documentType: 'SERVICE_CONTRACT', today: TODAY, rule: CONTRACT };
const ANCIEN = [{ key: 'documentDate', iso: '2015-01-01', confidence: 'certain' }];

type Iv = { needed: 'yes' | 'no' | 'uncertain'; kind: string | null; action: string | null; evidence: string | null; timing: 'NOW' | 'LATER' | 'NONE'; actBy?: string | null; dataNeeded?: boolean | null };
type Decide = NonNullable<Parameters<typeof ev.assessDeadlinePertinence>[0]['decide']>;
/** T4 simulé générique (sortie v3 réelle via `translateEventDecision`). */
function t4(iv0: Iv | null, opts: { v2?: boolean; category?: string } = {}) {
  const calls: Array<{ ctx: Record<string, any> }> = [];
  const decide: Decide = async (_input, ctx) => {
    calls.push({ ctx: ctx as Record<string, any> });
    const out = {
      task: 'CLASSIFY_EVENT' as const, agendaDecision: 'accept' as const, recurrenceDecision: 'not_applicable' as const,
      homeCategory: opts.category ?? (iv0?.needed === 'yes' ? 'action' : 'information'), businessType: null, confidence: 'certain' as const, reason: 'simulé', recurrenceReason: null,
      ...(opts.v2 ? {} : { intervention: iv0 ? { justification: 'simulé', consequence: null, actBy: null, dataNeeded: null, ...iv0 } : null }),
    };
    return { ...translateEventDecision(out as never, false), traceId: 't-1' };
  };
  return { decide, calls };
}

// ══════════════════════════════════════════════════════════════════════════
// C1 — calculs faussement fiables
// ══════════════════════════════════════════════════════════════════════════

describe('C1 — aucune valeur partiellement interprétée ou contredite déclarée fiable', () => {
  it('RES-01 — « 1,5 ans » et « 1.5 ans » : 18 mois exacts, jamais 60 mois fiables', () => {
    for (const brut of ['1,5 ans', '1.5 ans', '1,5 an', 'Durée : 1.5 années']) {
      const a = dv.analyzeDuration(brut);
      expect(a.months, brut).toBe(18);
      expect(a.reliable, brut).toBe(true);
      expect(a.months).not.toBe(60);
    }
    const r = dv.computeDerivation(spec, [fait('2025-01-01', { label: 'Date d’effet' })], [fait('1,5 ans')]);
    expect(r).toMatchObject({ status: 'CALCULATED_RELIABLE', value: dv.endFromStart('2025-01-01', 18), duration: { months: 18 } });
  });

  it('RES-01 — décimale non interprétable exactement : refus motivé, jamais un calcul', () => {
    expect(dv.analyzeDuration('1,3 ans')).toMatchObject({ months: null, reliable: false, reason: 'inexact_decimal_duration' });
    expect(dv.analyzeDuration('2,5 mois')).toMatchObject({ months: null, reliable: false, reason: 'inexact_decimal_duration' });
    expect(dv.parseDurationMonths('1,3 ans')).toBeNull();
    // Une date dans la clause n'est jamais lue comme une décimale.
    expect(dv.analyzeDuration('12 mois à compter du 01.02.2024')).toMatchObject({ months: 12, reliable: true });
  });

  it('RES-02 — « 12 mois et quinze jours » : composante non interprétée, jamais 12 mois fiables', () => {
    for (const brut of ['12 mois et quinze jours', '12 mois et 15 jours', '2 ans et demi', '1 an et trois semaines', '24 mois et un trimestre']) {
      const a = dv.analyzeDuration(brut);
      expect(a.reliable, brut).toBe(false);
      expect(a.months, brut).toBeNull();
    }
    expect(dv.analyzeDuration('12 mois et quinze jours').reason).toBe('uninterpreted_component');
    const r = dv.computeDerivation(spec, [fait('2025-01-01', { label: 'Date d’effet' })], [fait('12 mois et quinze jours')]);
    expect(r.status).not.toBe('CALCULATED_RELIABLE');
    expect(r.refusals?.[0]).toMatchObject({ value: '12 mois et quinze jours', reason: 'uninterpreted_component' });
  });

  it('RES-03 — faits concurrents « 12 mois » et « 36 ou 48 mois » : aucun calcul fiable, motif tracé', () => {
    const r = dv.computeDerivation(spec, [fait('2025-01-01', { label: 'Date d’effet' })], [fait('12 mois'), fait('36 ou 48 mois')]);
    expect(r.status).not.toBe('CALCULATED_RELIABLE');
    expect(r.reason).toMatch(/competing_duration_facts/);
    expect(r.refusals?.some((x) => x.value === '36 ou 48 mois')).toBe(true);
    // Clause d'un AUTRE fait (valeur lisible, clause ambiguë) : examinée aussi.
    const r2 = dv.computeDerivation(spec, [fait('2025-01-01', { label: 'Date d’effet' })],
      [fait('12 mois'), fait('12 mois', { excerpt: 'Durée : 12 mois, ou 24 mois en cas d’option' })]);
    expect(r2.status).not.toBe('CALCULATED_RELIABLE');
    // Fait concurrent sans durée (texte) : sans incidence.
    const r3 = dv.computeDerivation(spec, [fait('2025-01-01', { label: 'Date d’effet' })], [fait('12 mois'), fait('selon conditions générales')]);
    expect(r3.status).toBe('CALCULATED_RELIABLE');
  });

  it('RES-04 — corrections déjà opérationnelles maintenues (durée incluse, reconduction, 2 ans et 6 mois, date à date)', () => {
    expect(dv.analyzeDuration('240 mois, dont 12 mois de différé')).toMatchObject({ months: 240, reliable: true, status: 'TOTAL_WITH_INCLUDED' });
    expect(dv.analyzeDuration('12 mois renouvelables pour 12 mois')).toMatchObject({ months: 12, reliable: false, status: 'INITIAL_TERM_RENEWABLE' });
    expect(dv.analyzeDuration('2 ans et 6 mois')).toMatchObject({ months: 30, reliable: true });
    expect(dv.analyzeDuration('1 an de date à date')).toMatchObject({ months: 12, reliable: true, convention: 'ANNIVERSARY' });
    expect(dv.analyzeDuration('36 ou 48 mois')).toMatchObject({ reliable: false, status: 'AMBIGUOUS' });
    expect(dv.parseDurationMonths('un an')).toBe(12);
    expect(dv.parseDurationMonths('240')).toBeNull();
    expect(dv.parseDurationMonths(36, 'dureeMois')).toBe(36);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C2 — preuve de fin effective
// ══════════════════════════════════════════════════════════════════════════

describe('C2 — fin effective exigée avant toute conclusion « terminé »', () => {
  const cycle = (t: string) => ev.lifecycleSignalsOf([t], TODAY);

  it('RES-05 — « Contrat non renouvelable » : non-renouvellement, jamais une fin effective', () => {
    const c = cycle('Contrat non renouvelable');
    expect(c).toMatchObject({ terminated: false, nonRenewal: true, renewal: false });
    expect(cycle('Contrat conclu sans tacite reconduction').terminated).toBe(false);
  });

  it('RES-06 — fin prévue à une date future : fin prévue, pas de fin effective', () => {
    const c = cycle('Le contrat prend fin le 31/12/2030.');
    expect(c.terminated).toBe(false);
    expect(c.scheduledEnd).toContain('2030-12-31');
    expect(cycle('Le contrat expirera le 31 décembre 2030').terminated).toBe(false);
    // Fin prévue PASSÉE : indice d'une fin, jamais une preuve déterministe.
    const passee = cycle('Le contrat prend fin le 31/12/2019.');
    expect(passee).toMatchObject({ terminated: false, terminationHint: true });
  });

  it('RES-07 — « Le contrat n’est pas résilié » : négation, aucun signal de résiliation effective', () => {
    for (const t of ['Le contrat n’est pas résilié.', 'Le contrat n\'a pas été résilié', 'Aucune résiliation n’est intervenue.', 'Contrat non résilié à ce jour']) {
      expect(cycle(t).terminated, t).toBe(false);
      expect(cycle(t).terminationHint, t).toBe(false);
    }
  });

  it('RES-08 — clause conditionnelle ou générique de résiliation : jamais une fin effective', () => {
    for (const t of ['Le contrat peut être résilié en cas de non-paiement.', 'En cas de résiliation, le matériel est restitué.',
      'Le contrat sera résilié si le loyer n’est pas réglé.', 'Résiliation : préavis de deux mois.', 'Paiement à terme échu.',
      'Le solde restant dû est payable à la livraison.', 'Le présent contrat remplace le contrat n° 1234 résilié le 01/02/2020.']) {
      expect(cycle(t).terminated, t).toBe(false);
    }
  });

  it('RES-05/06/07/08 — fin effective PROUVÉE seulement par un constat sans négation ni condition, daté au plus aujourd’hui', () => {
    expect(cycle('Le contrat a été résilié le 15/03/2020.').terminated).toBe(true);
    expect(cycle('Le contrat a pris fin le 31/12/2019.').terminated).toBe(true);
    expect(cycle('Résiliation effective au 01/01/2021.').terminated).toBe(true);
    expect(cycle('Le prêt est intégralement soldé.').terminated).toBe(true);
    // Constat daté dans le futur : jamais effectif.
    expect(cycle('Résiliation effective au 01/01/2031.').terminated).toBe(false);
    // Preuve peu fiable (fait probable) : indice seulement.
    expect(ev.lifecycleSignalsOf([{ text: 'Le contrat a été résilié le 15/03/2020.', confidence: 'probable', source: 'FACTS' }], TODAY))
      .toMatchObject({ terminated: false, terminationHint: true });
  });

  it('RES-05/06 — décision : non-renouvellement ou fin future d’un document ancien → jamais CONTRACT_TERMINATED ni NO_ACTION', async () => {
    for (const t of ['Contrat non renouvelable', 'Le contrat prend fin le 31/12/2030.', 'Le contrat n’est pas résilié.', 'Le contrat peut être résilié en cas de non-paiement.']) {
      const r = await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: ANCIEN, config: V3, lifecycle: cycle(t) });
      expect(r.pertinence, t).not.toBe('CONTRACT_TERMINATED');
      expect(r.outcome, t).not.toBe('NO_ACTION');
      expect(r.card, t).toBeNull();
    }
    // Fin seulement PROBABLE : différée, motivée, réévaluation programmée, aucune question.
    const p = await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: ANCIEN, config: V3, lifecycle: cycle('Le contrat prend fin le 31/12/2019.') });
    expect(p).toMatchObject({ outcome: 'DEFER', card: null, aiCalled: false, reason: expect.stringContaining('termination_not_proven') });
    expect(p.reevaluateAt).not.toBeNull();
    // Échéance CONNUE passée : même exigence.
    const k = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: '2026-09-01', source: 'KNOWN_VALUE' }, config: V3, lifecycle: cycle('Contrat non renouvelable'),
      decide: t4({ needed: 'no', kind: null, action: null, evidence: null, timing: 'NONE' }).decide });
    expect(k.pertinence).not.toBe('CONTRACT_TERMINATED');
  });

  it('RES-09 — fin effective prouvée + obligation résiduelle : l’obligation est préservée (T4 interrogé, carte d’intervention)', async () => {
    const texte = 'Le contrat a pris fin le 31/12/2019. Le locataire doit restituer le matériel loué.';
    const c = cycle(texte);
    expect(c).toMatchObject({ terminated: true, residual: true });
    const { decide, calls } = t4({ needed: 'yes', kind: 'RETURN_OR_RESTITUTE', action: 'Restituer le matériel loué', evidence: 'Le locataire doit restituer le matériel loué', timing: 'NOW' });
    const r = await ev.assessKnownDeadlineObligation({ ...base, known: { iso: '2019-12-31', source: 'KNOWN_VALUE' }, config: V3, lifecycle: c, clauses: c.clauses, decide });
    expect(r).toMatchObject({ outcome: 'CREATE_ACTION', card: 'INTERVENTION' });
    expect(calls).toHaveLength(1);
    const u = await ev.assessDeadlinePertinence({ ...base, candidates: [], contextDates: ANCIEN, config: V3, lifecycle: c, decide });
    expect(u.outcome).not.toBe('NO_ACTION');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C3 — configuration T4 incompatible
// ══════════════════════════════════════════════════════════════════════════

describe('C3 — configuration T4 incompatible, absente ou sortie invalide', () => {
  it('RES-10 — contrat T4 ancien : ni question, ni appel IA, ni fermeture — échéance passée comprise ; état et reprise tracés', async () => {
    const { decide, calls } = t4(null, { v2: true, category: 'information' });
    const passee = await ev.assessDeadlinePertinence({ ...base, candidates: [{ iso: '2026-09-01', source: 'FACTS' }], config: V2, decide });
    expect(passee).toMatchObject({ outcome: 'DEFER', pertinence: 'T4_INCOMPATIBLE', card: null, aiCalled: false, incompatible: true, t4State: 'INCOMPATIBLE' });
    const sansDate = await ev.assessDeadlinePertinence({ ...base, candidates: [], config: V2, decide });
    expect(sansDate).toMatchObject({ outcome: 'DEFER', card: null, aiCalled: false, t4State: 'INCOMPATIBLE' });
    expect(calls).toHaveLength(0);
    expect(passee.contract?.t4).toMatchObject({ state: 'INCOMPATIBLE', configRef: 'bo:v7:t4_output_v2', resume: expect.stringContaining('t4_output_v3') });
    // Décision déterministe suffisante : toujours permise (date future proche).
    const proche = await ev.assessDeadlinePertinence({ ...base, candidates: [{ iso: '2026-11-15', source: 'FACTS' }], config: V2 });
    expect(proche).toMatchObject({ outcome: 'CREATE_ACTION', card: 'DATA_QUESTION' });
  });

  it('RES-10 — configuration T4 illisible (indisponibilité) : échec technique distinct, reprise rapide, aucune carte', async () => {
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: [], config: { ref: 'unknown', interventionCapable: false, unavailable: true } });
    expect(r).toMatchObject({ outcome: 'DEFER', card: null, technicalFailure: true, t4State: 'UNAVAILABLE', aiCalled: false });
    expect(r.incompatible).toBeFalsy();
  });

  it('RES-10 — sortie T4 invalide (bloc d’évaluation absent) : distincte de l’incompatibilité, aucune carte', async () => {
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: [], config: V3, decide: t4(null).decide });
    expect(r).toMatchObject({ outcome: 'DEFER', card: null, technicalFailure: true, t4State: 'INVALID_OUTPUT' });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C5 — admissibilité sans présomption
// ══════════════════════════════════════════════════════════════════════════

describe('C5 — une valeur inconnue n’est jamais une validation', () => {
  it('C5 — contrôle commun : critère nécessaire inconnu → jamais CREATE_ACTION', () => {
    const checks = { realProblem: true, neededForUse: null, autoResolvable: false, userActionNeeded: true, timely: true, userDecided: false };
    const d = adm.decideAdmissibility({ ruleCode: 'X', checks });
    expect(d.outcome).toBe('DEFER');
    expect(d.reason).toMatch(/^UNKNOWN_CRITERIA:neededForUse/);
    // Critère SANS incidence pour la règle (déclaré) : ne bloque pas.
    expect(adm.decideAdmissibility({ ruleCode: 'X', checks, notApplicable: ['neededForUse'] }).outcome).toBe('CREATE_ACTION');
    // Inconnu sur un critère d'exclusion (déjà tranché ? résoluble ?) : bloquant aussi.
    expect(adm.decideAdmissibility({ ruleCode: 'X', checks: { ...checks, neededForUse: true, autoResolvable: null } }).outcome).toBe('DEFER');
  });

  const evt = (p: Partial<import('../producers.service').AgendaDateFacts>) => ({
    homeCategory: null, originType: 'qualified_document', isAutomatic: true, isAutomaticModified: false, requiresQualification: false,
    createdAt: '2026-01-01T00:00:00Z', sourceDate: null, ...p,
  });

  it('RES-13 — événement sans catégorie et sans date : aucune nécessité de date présumée (aucune carte)', () => {
    const d = prod.agendaDateAdmissibility(evt({}), new Date('2026-10-21T00:00:00Z'));
    expect(d.outcome).not.toBe('CREATE_ACTION');
    expect(d.outcome).toBe('DEFER');
    expect(d.reason).toMatch(/CATEGORY_UNKNOWN|UNKNOWN_CRITERIA/);
  });

  it('RES-14 — tâche sans échéance obligatoire (« à savoir ») : aucune complétion', () => {
    expect(prod.agendaDateAdmissibility(evt({ homeCategory: 'information' })).outcome).toBe('NO_ACTION');
  });

  it('RES-15 — événement qui nécessite une date, non résoluble automatiquement : carte justifiée (justification positive)', () => {
    const d = prod.agendaDateAdmissibility(evt({ homeCategory: 'action' }));
    expect(d).toMatchObject({ outcome: 'CREATE_ACTION' });
    expect(d.checks).toMatchObject({ realProblem: true, neededForUse: true, userActionNeeded: true, autoResolvable: false });
    // Décision PO lot 72C conservée : événement SAISI par l'utilisateur, sans catégorie → sa question reste.
    expect(prod.agendaDateAdmissibility(evt({ originType: 'manual', isAutomatic: false }))).toMatchObject({ outcome: 'CREATE_ACTION' });
    expect(prod.agendaDateAdmissibility(evt({ originType: 'manual', isAutomatic: false })).justification).toMatch(/USER_CREATED_EVENT/);
  });

  it('C5 — équipements et fournisseurs : critères sans objet déclarés, cas bloquants préservés', () => {
    expect(prod.equipmentLinkAdmissibility({ status: null, archivedAt: null, knownAssetId: null, liveAssets: 2 }).outcome).toBe('CREATE_ACTION');
    expect(prod.supplierIdentityAdmissibility({ detectedValue: 'ACME', currentValue: 'Autre' }).outcome).toBe('CREATE_ACTION');
    expect(prod.supplierIdentityAdmissibility({ detectedValue: null, currentValue: 'Autre' }).outcome).toBe('NO_ACTION');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C6 — décisions de l'utilisateur
// ══════════════════════════════════════════════════════════════════════════

describe('C6 — refus respectés pour la même situation, obligation distincte réévaluée', () => {
  const complete = { kind: 'UPSERT' as const, actionKind: 'COMPLETE' as const, proposals: [], reason: 'REQUIRED_DATA_MISSING' };

  it('RES-16 — « Non applicable », même situation : aucune réouverture', () => {
    const na = { values: [], problem: { problem: 'MISSING_DATA', situation: 'UNDATED', proof: null } };
    expect(bridge.newProblemSinceNotApplicable(complete, na, { problem: 'MISSING_DATA', situation: 'UNDATED', proof: null })).toBe(false);
    // Même preuve, reformulée par le modèle : même clé de preuve → aucune réouverture.
    const p1 = bridge.problemProofKey({ evidence: 'Le locataire doit restituer le matériel', clauses: ['Article 8 : le locataire doit restituer le matériel loué.'] });
    const p2 = bridge.problemProofKey({ evidence: 'le locataire doit restituer le matériel', clauses: ['Article 8 : le locataire doit restituer le matériel loué.'] });
    expect(p1).toBe(p2);
    expect(bridge.newProblemSinceNotApplicable(complete, { values: [], problem: { problem: 'MISSING_DATA', situation: 'UNDATED', proof: p1 } },
      { problem: 'MISSING_DATA', situation: 'UNDATED', proof: p2 })).toBe(false);
  });

  it('RES-17 — « Non applicable », nouvelle obligation PROUVÉE sans proposition de valeur : réévaluation permise', () => {
    const na = { values: [], problem: { problem: 'MISSING_DATA', situation: 'UNDATED', proof: null } };
    const preuve = bridge.problemProofKey({ evidence: 'Le préavis de résiliation doit être envoyé trois mois avant l’échéance', clauses: ['Le préavis de résiliation doit être envoyé trois mois avant l’échéance.'] });
    expect(preuve).not.toBeNull();
    expect(bridge.newProblemSinceNotApplicable(complete, na, { problem: 'MISSING_DATA', situation: 'UNDATED', proof: preuve })).toBe(true);
    // Sans preuve démontrée (aucun passage cité retrouvé) : jamais.
    expect(bridge.problemProofKey({ evidence: 'phrase inventée', clauses: ['Autre clause.'] })).toBeNull();
    expect(bridge.newProblemSinceNotApplicable(complete, na, { problem: 'MISSING_DATA', situation: 'UNDATED', proof: null })).toBe(false);
    // Nouvelle valeur proposée : comportement antérieur conservé.
    expect(bridge.newProblemSinceNotApplicable({ ...complete, actionKind: 'ARBITRATE', proposals: [{ value: '2027-01-01', label: 'x', confidence: 0.6 }] }, na)).toBe(true);
  });

  it('RES-18 — deux obligations distinctes de même nature sans date : jamais assimilées', () => {
    const a = { kind: 'RETURN_OR_RESTITUTE', actBy: null, proof: 'p-decodeur', evidence: 'Restituer le décodeur' };
    expect(iv.sameIntervention(a, { kind: 'RETURN_OR_RESTITUTE', actBy: null, proof: 'p-cles', evidence: 'Remettre les clés' })).toBe(false);
    expect(iv.sameIntervention(a, { kind: 'RETURN_OR_RESTITUTE', actBy: null, proof: 'p-decodeur', evidence: 'restituer le décodeur' })).toBe(true);
    // Carte antérieure sans clé de preuve : rapprochée par la preuve citée, jamais par la seule nature.
    expect(iv.sameIntervention({ kind: 'RETURN_OR_RESTITUTE', actBy: null, evidence: 'Restituer le décodeur' }, { kind: 'RETURN_OR_RESTITUTE', actBy: null, proof: 'p', evidence: 'Remettre les clés de l’appartement' })).toBe(false);
    expect(iv.sameIntervention({ kind: 'RETURN_OR_RESTITUTE', actBy: null, evidence: 'Restituer le décodeur TV' }, { kind: 'RETURN_OR_RESTITUTE', actBy: null, proof: 'p', evidence: 'restituer le décodeur tv' })).toBe(true);
    // Carte très ancienne sans aucune preuve conservée : aucun nouveau problème démontrable → décision respectée.
    expect(iv.sameIntervention({ kind: 'RETURN_OR_RESTITUTE', actBy: null }, { kind: 'RETURN_OR_RESTITUTE', actBy: null, proof: 'p', evidence: 'x' })).toBe(true);
    // Autre nature ou autre échéance d'action : jamais la même.
    expect(iv.sameIntervention(a, { kind: 'PAY', actBy: null, proof: 'p-decodeur' })).toBe(false);
  });
});
