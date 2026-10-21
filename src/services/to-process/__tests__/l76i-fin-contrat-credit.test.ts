/**
 * Lot 76I — ticket « [P2] À traiter — Calcul automatique des dates de fin de
 * contrat et suppression des sollicitations inutiles » : calculs calendaires
 * et décisions PURES (sans base). Cycle complet (persistance, cartes,
 * réévaluation, campagne) : `src/test/e2e/scenarios/l76i-fin-contrat-credit.e2e.ts`.
 *
 *  FCC-CAL  calculs calendaires (fins de mois, années bissextiles, périodicités)
 *  FCC-01…12  mêmes identifiants que le tableau du ticket (§4), côté décision pure
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const dv = await import('../document-derivations');
const ev = await import('../document-field-evidence');
const { getRule } = await import('../rules-catalog');
const { translateEventDecision } = await import('@/services/ai/agenda/master/classify-event');

const SPEC = dv.scheduleDerivationFor('contractEndDate')!;
const CLASSIC = dv.derivationFor('contractEndDate')!;
const fait = (value: string, p: { confidence?: string; source?: string; label?: string | null; key?: string | null; excerpt?: string | null } = {}) =>
  ({ value, confidence: p.confidence ?? 'certain', source: p.source ?? 'FACTS', key: p.key ?? null, label: p.label ?? null, excerpt: p.excerpt ?? null });
const vide = (): Parameters<typeof dv.computeScheduleDerivation>[0] => ({ firstInstalment: [], lastInstalment: [], count: [], periodicity: [], disbursement: [], repayment: [] });
const CONTRACT = getRule('DATA-CONTRACT-END')!;
const TODAY = '2026-10-21';
const V3 = { ref: 'repo:t4_output_v3', interventionCapable: true };
const base = { accountId: 1, fileId: 2, documentType: 'FINANCING_CONTRACT', today: TODAY, rule: CONTRACT, config: V3 };
type Decide = NonNullable<Parameters<typeof ev.assessDeadlinePertinence>[0]['decide']>;
/** T4 défavorable : demande TOUJOURS la date (pire cas). */
function t4Demande() {
  let appels = 0;
  const decide: Decide = async () => {
    appels += 1;
    const out = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'action', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null,
      intervention: { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin', justification: 'simulé', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true } };
    return { ...translateEventDecision(out as never, false), traceId: 't-1' };
  };
  return { decide, appels: () => appels };
}

describe('FCC-CAL — calculs calendaires', () => {
  it('240 mensualités : dernière échéance = première + 239 mois, même quantième', () => {
    expect(dv.lastInstalmentFrom('2021-03-05', 240, 1)).toEqual({ value: '2041-02-05', dayAmbiguous: false });
    expect(dv.lastInstalmentFrom('2021-03-05', 1, 1)).toEqual({ value: '2021-03-05', dayAmbiguous: false });
  });
  it('fins de mois : quantième borné (31/01 → 28/02 ou 29/02), années bissextiles', () => {
    expect(dv.addMonthsClamped('2023-01-31', 1)).toBe('2023-02-28');
    expect(dv.addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
    expect(dv.addMonthsClamped('2024-02-29', 12)).toBe('2025-02-28');
    expect(dv.addMonthsClamped('2024-02-29', 48)).toBe('2028-02-29');
    expect(dv.lastInstalmentFrom('2024-01-31', 2, 1).value).toBe('2024-02-29');
    expect(dv.lastInstalmentFrom('2023-12-31', 3, 1).value).toBe('2024-02-29');
  });
  it('périodicités trimestrielle, semestrielle, annuelle', () => {
    expect(dv.lastInstalmentFrom('2020-01-15', 80, 3).value).toBe('2039-10-15');
    expect(dv.lastInstalmentFrom('2020-06-15', 4, 6).value).toBe('2021-12-15');
    expect(dv.lastInstalmentFrom('2020-02-29', 5, 12).value).toBe('2024-02-29');
    expect(dv.lastInstalmentFrom('2020-02-29', 4, 12).value).toBe('2023-02-28');
  });
  it('quantième incertain (première échéance au dernier jour d’un mois court) : signalé, sauf convention « fin de mois » lue', () => {
    expect(dv.lastInstalmentFrom('2021-02-28', 2, 1)).toEqual({ value: '2021-03-28', dayAmbiguous: true });
    expect(dv.lastInstalmentFrom('2021-02-28', 2, 1, true)).toEqual({ value: '2021-03-31', dayAmbiguous: false });
    expect(dv.lastInstalmentFrom('2021-04-30', 11, 1)).toEqual({ value: '2022-02-28', dayAmbiguous: false });
  });
  it('périodicité et nombre d’échéances lus (jamais présumés)', () => {
    expect(dv.parsePeriodicity('Mensuelle')).toEqual({ months: 1, reason: 'read' });
    expect(dv.parsePeriodicity('Trimestrielle')).toMatchObject({ months: 3 });
    expect(dv.parsePeriodicity('tous les 6 mois')).toMatchObject({ months: 6 });
    expect(dv.parsePeriodicity('Annuelle')).toMatchObject({ months: 12 });
    expect(dv.parsePeriodicity('Hebdomadaire')).toMatchObject({ months: null, reason: 'unsupported_periodicity' });
    expect(dv.parsePeriodicity('mensuelle ou trimestrielle')).toMatchObject({ months: null, reason: 'several_periodicities' });
    expect(dv.parsePeriodicity('selon convention')).toMatchObject({ months: null });
    expect(dv.parseInstalmentCount('240')).toMatchObject({ count: 240, impliedPeriod: null, status: 'OK' });
    expect(dv.parseInstalmentCount('240', 'Nombre de mensualités')).toMatchObject({ count: 240, impliedPeriod: 1 });
    expect(dv.parseInstalmentCount('240 mensualités de 850,00 €')).toMatchObject({ count: 240, impliedPeriod: 1, status: 'OK' });
    expect(dv.parseInstalmentCount('240 (deux cent quarante) échéances')).toMatchObject({ count: 240 });
    expect(dv.parseInstalmentCount('240 (deux cent trente) échéances')).toMatchObject({ count: null, status: 'AMBIGUOUS' });
    expect(dv.parseInstalmentCount('80 échéances trimestrielles')).toMatchObject({ count: 80, impliedPeriod: 3 });
    expect(dv.parseInstalmentCount('12 échéances de différé puis 228 échéances')).toMatchObject({ count: null, status: 'AMBIGUOUS' });
    expect(dv.parseInstalmentCount('240 ou 300')).toMatchObject({ count: null, status: 'AMBIGUOUS' });
    expect(dv.parseInstalmentCount('240,5')).toMatchObject({ count: null, status: 'REFUSED' });
    expect(dv.parseInstalmentCount('à définir')).toMatchObject({ count: null, status: 'REFUSED' });
  });
  it('rôles lus dans l’échéancier : libellés génériques, jamais une date de signature ou d’émission', () => {
    expect(dv.scheduleRoleOf(SPEC, { label: 'Date de première échéance' })).toBe('firstInstalment');
    expect(dv.scheduleRoleOf(SPEC, { label: 'Date de 1ère échéance' })).toBe('firstInstalment');
    expect(dv.scheduleRoleOf(SPEC, { label: 'Date de dernière échéance' })).toBe('lastInstalment');
    expect(dv.scheduleRoleOf(SPEC, { label: 'Nombre d’échéances' })).toBe('count');
    expect(dv.scheduleRoleOf(SPEC, { label: 'Périodicité des échéances' })).toBe('periodicity');
    expect(dv.scheduleRoleOf(SPEC, { label: 'Durée du prêt' })).toBe('repayment');
    expect(dv.scheduleRoleOf(SPEC, { raw: 'datePremiereEcheance' })).toBe('firstInstalment');
    expect(dv.scheduleRoleOf(SPEC, { label: 'Date de signature de l’offre' })).toBeNull();
    expect(dv.scheduleRoleOf(SPEC, { label: 'Date d’émission de l’offre' })).toBeNull();
    expect(dv.scheduleRoleOf(SPEC, { label: 'Date d’échéance' })).toBeNull();
  });
});

describe('Calcul de la fin par l’échéancier (§3.2)', () => {
  it('FCC-02 — dernière échéance lue (fait certain) : fiable, méthode SCHEDULE_LAST_INSTALMENT', () => {
    const r = dv.computeScheduleDerivation({ ...vide(), lastInstalment: [fait('2041-02-05')] });
    expect(r).toMatchObject({ status: 'CALCULATED_RELIABLE', value: '2041-02-05', method: 'SCHEDULE_LAST_INSTALMENT', evidenced: true });
    // Lue seulement dans une unité source (non structurée) : candidat, jamais écrite.
    expect(dv.computeScheduleDerivation({ ...vide(), lastInstalment: [fait('2041-02-05', { confidence: 'probable', source: 'SOURCE_UNITS' })] }).status).toBe('CALCULATED_PROBABLE');
  });
  it('FCC-03 — première échéance + 240 mensualités fiables : calculée correctement ; périodicité lue, portée par le nombre ou déduite de la durée', () => {
    const lu = dv.computeScheduleDerivation({ ...vide(), firstInstalment: [fait('2021-03-05')], count: [fait('240')], periodicity: [fait('Mensuelle')] });
    expect(lu).toMatchObject({ status: 'CALCULATED_RELIABLE', value: '2041-02-05', method: 'FIRST_INSTALMENT_PLUS_COUNT', sources: { periodicity: { months: 1, origin: 'READ' }, count: { count: 240 } } });
    const porte = dv.computeScheduleDerivation({ ...vide(), firstInstalment: [fait('2021-03-05')], count: [fait('240', { label: 'Nombre de mensualités' })] });
    expect(porte).toMatchObject({ status: 'CALCULATED_RELIABLE', value: '2041-02-05', sources: { periodicity: { origin: 'IMPLIED_BY_COUNT' } } });
    const deduite = dv.computeScheduleDerivation({ ...vide(), firstInstalment: [fait('2021-03-05')], count: [fait('80')] }, { durationMonths: 240 });
    expect(deduite).toMatchObject({ status: 'CALCULATED_RELIABLE', value: '2040-12-05', sources: { periodicity: { months: 3, origin: 'INFERRED_FROM_DURATION' } } });
    expect(deduite.assumptions.join(' ')).toContain('périodicité déduite');
    // Ni périodicité ni durée : aucune présomption « mensuelle ».
    expect(dv.computeScheduleDerivation({ ...vide(), firstInstalment: [fait('2021-03-05')], count: [fait('240')] })).toMatchObject({ status: 'NOT_DERIVABLE', reason: 'no_periodicity', value: null });
  });
  it('FCC-04 — déblocage des fonds (ou signature) jamais assimilé à la première échéance : au mieux une estimation non fiable', () => {
    const r = dv.computeScheduleDerivation({ ...vide(), disbursement: [fait('2021-02-15')], count: [fait('240')], periodicity: [fait('Mensuelle')] });
    expect(r).toMatchObject({ status: 'CALCULATED_PROBABLE', method: 'DISBURSEMENT_PLUS_COUNT', reason: 'disbursement_is_not_first_instalment' });
    // Méthode « début + durée » : la date de signature n'est jamais un début effectif.
    const c = dv.computeDerivation(CLASSIC, [fait('2021-02-15', { label: 'Date de signature' })], [fait('240 mois')], () => 'dureePret');
    expect(c.status).toBe('NOT_DERIVABLE');
    expect(dv.combineDerivations(c, dv.computeScheduleDerivation({ ...vide(), repayment: [fait('240 mois')] }))).toMatchObject({ status: 'NOT_DERIVABLE', value: null });
  });
  it('FCC-05 — informations insuffisantes : aucune date inventée, motif précis', () => {
    expect(dv.computeScheduleDerivation({ ...vide(), count: [fait('240')], periodicity: [fait('Mensuelle')] })).toMatchObject({ status: 'NOT_DERIVABLE', reason: 'no_first_instalment', evidenced: true });
    expect(dv.computeScheduleDerivation({ ...vide(), firstInstalment: [fait('2021-03-05')] })).toMatchObject({ status: 'NOT_DERIVABLE', reason: 'no_instalment_count' });
    expect(dv.computeScheduleDerivation(vide())).toMatchObject({ status: 'NOT_DERIVABLE', reason: 'no_schedule', evidenced: false });
  });
  it('FCC-06 — données contradictoires ou ambiguës : jamais de valeur', () => {
    const f = [fait('2021-03-05')];
    const cas: Array<[Parameters<typeof dv.computeScheduleDerivation>[0], Parameters<typeof dv.computeScheduleDerivation>[1], string]> = [
      [{ ...vide(), firstInstalment: f, count: [fait('240')], periodicity: [fait('Mensuelle')], lastInstalment: [fait('2042-02-05')] }, {}, 'last_instalment_contradicts_schedule'],
      [{ ...vide(), firstInstalment: f, count: [fait('240')], periodicity: [fait('Mensuelle')] }, { durationMonths: 300 }, 'schedule_inconsistent_with_duration'],
      [{ ...vide(), lastInstalment: [fait('2041-02-05'), fait('2041-03-05')] }, {}, 'several_last_instalment_dates'],
      [{ ...vide(), firstInstalment: [fait('2021-03-05'), fait('2021-04-05')], count: [fait('240')], periodicity: [fait('Mensuelle')] }, {}, 'several_first_instalment_dates'],
      [{ ...vide(), firstInstalment: f, count: [fait('240'), fait('300')], periodicity: [fait('Mensuelle')] }, {}, 'several_counts'],
      [{ ...vide(), firstInstalment: f, count: [fait('240')], periodicity: [fait('Mensuelle'), fait('Trimestrielle')] }, {}, 'several_periodicities'],
      [{ ...vide(), firstInstalment: f, count: [fait('240', { label: 'Nombre de mensualités' })], periodicity: [fait('Trimestrielle')] }, {}, 'count_contradicts_periodicity'],
      [{ ...vide(), firstInstalment: f, count: [fait('12 échéances de différé puis 228')], periodicity: [fait('Mensuelle')] }, {}, 'count_deferral_or_steps_in_count'],
      [{ ...vide(), firstInstalment: f, count: [fait('240')], periodicity: [fait('Selon accord')] }, {}, 'periodicity_periodicity_not_interpreted'],
    ];
    for (const [faits, opts, motif] of cas) {
      const r = dv.computeScheduleDerivation(faits, opts);
      expect(r, motif).toMatchObject({ status: 'AMBIGUOUS', value: null, reason: motif });
      // Contradiction de l'échéancier : jamais de repli sur une autre méthode.
      const classique = dv.computeDerivation(CLASSIC, [fait('2021-02-01', { label: 'Date d’effet' })], [fait('240 mois')], () => 'dureePret');
      expect(classique.status).toBe('CALCULATED_RELIABLE');
      expect(dv.combineDerivations(classique, r), motif).toMatchObject({ status: 'AMBIGUOUS', value: null, reason: `schedule:${motif}` });
    }
    // Durée « 240 mois dont 12 mois de différé » : part incluse admise (228 échéances d'amortissement).
    expect(dv.computeScheduleDerivation({ ...vide(), firstInstalment: f, count: [fait('228')], periodicity: [fait('Mensuelle')] }, { durationMonths: 240, durationIncludedMonths: [12] }).status).toBe('CALCULATED_RELIABLE');
    // Quantième incertain : candidat seulement.
    expect(dv.computeScheduleDerivation({ ...vide(), firstInstalment: [fait('2021-02-28')], count: [fait('2')], periodicity: [fait('Mensuelle')] })).toMatchObject({ status: 'CALCULATED_PROBABLE', reason: 'instalment_day_ambiguous' });
  });
  it('FCC-10 — modification connue (avenant, réaménagement, report accordé) : aucune valeur fiable ; simple faculté ignorée', () => {
    expect(dv.knownScheduleChange(['Avenant n°1 : réaménagement du prêt signé le 01/02/2025'])).toContain('Avenant');
    expect(dv.knownScheduleChange(['Report d’échéances accordé du 01/03/2024 au 01/06/2024.'])).not.toBeNull();
    expect(dv.knownScheduleChange(['L’emprunteur pourra demander un report d’échéances.', 'Possibilité de modulation des échéances.', 'En cas de renégociation, un avenant sera établi.'])).toBeNull();
    const r = dv.computeScheduleDerivation({ ...vide(), firstInstalment: [fait('2021-03-05')], count: [fait('240')], periodicity: [fait('Mensuelle')] }, { change: 'Avenant n°1' });
    expect(r).toMatchObject({ status: 'CALCULATED_PROBABLE', reason: 'known_schedule_change' });
  });
  it('§3.2 — l’échéancier prime sur « début + durée » ; l’alternative reste tracée', () => {
    const classique = dv.computeDerivation(CLASSIC, [fait('2021-02-01', { label: 'Date d’effet' })], [fait('240 mois')], () => 'dureePret');
    const ech = dv.computeScheduleDerivation({ ...vide(), firstInstalment: [fait('2021-03-05')], count: [fait('240')], periodicity: [fait('Mensuelle')] });
    expect(dv.combineDerivations(classique, ech)).toMatchObject({ status: 'CALCULATED_RELIABLE', value: '2041-02-05', method: 'FIRST_INSTALMENT_PLUS_COUNT', convention: 'LAST_INSTALMENT',
      alternative: { method: 'START_PLUS_DURATION', status: 'CALCULATED_RELIABLE', value: '2041-01-31' } });
    // Aucun échéancier calculable : « début + durée » inchangé (non-régression lot 61).
    expect(dv.combineDerivations(classique, dv.computeScheduleDerivation(vide()))).toMatchObject({ status: 'CALCULATED_RELIABLE', value: '2041-01-31', method: 'START_PLUS_DURATION' });
  });
});

describe('Pertinence d’une question sur la date de fin (§3.4)', () => {
  const credit = dv.endDateNeed({ repaymentSchedule: true, textes: ['Durée du prêt : 240 mois', 'Remboursement anticipé possible sans indemnité', 'Le prêt peut être exigible en cas de défaut'] });
  it('FCC-05 / FCC-04 — remboursement par échéances sans démarche de fin : aucune carte, aucun appel IA (même si T4 demanderait la date)', async () => {
    expect(credit).toMatchObject({ repaymentSchedule: true, endActions: [], notNeeded: true });
    const t4 = t4Demande();
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: [], decide: t4.decide, endDateNeed: credit });
    expect(r).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'UNDATED_NOT_NEEDED', reason: 'repayment_schedule_without_end_action', card: null, aiCalled: false });
    expect(t4.appels()).toBe(0);
    // Estimation (déblocage) seulement : même décision.
    const e = await ev.assessDeadlinePertinence({ ...base, candidates: [{ iso: '2041-03-15', source: 'CALCULATED_PROBABLE' }], decide: t4.decide, endDateNeed: credit });
    expect(e).toMatchObject({ outcome: 'NO_ACTION', card: null });
  });
  it('FCC-07 — date indispensable (reconduction tacite, préavis, restitution, option) : la règle commune s’applique (sollicitation possible)', async () => {
    for (const clause of ['Le contrat est reconduit tacitement sauf dénonciation avec un préavis de 2 mois.', 'Le locataire doit restituer le véhicule à la fin du contrat.',
      'Option d’achat à lever à l’issue de la location.']) {
      const besoin = dv.endDateNeed({ repaymentSchedule: true, textes: [clause] });
      expect(besoin.notNeeded, clause).toBe(false);
      const t4 = t4Demande();
      const r = await ev.assessDeadlinePertinence({ ...base, candidates: [], decide: t4.decide, endDateNeed: besoin });
      expect(r, clause).toMatchObject({ outcome: 'CREATE_ACTION', card: 'DATA_QUESTION' });
      expect(t4.appels()).toBe(1);
    }
    // Démarche NIÉE (« sans tacite reconduction ») : n'en est pas une.
    expect(dv.endDateNeed({ repaymentSchedule: true, textes: ['Contrat sans tacite reconduction.'] }).notNeeded).toBe(true);
    // Aucun échéancier lu : jamais présumé facultatif (règle non généralisée à toutes les dates).
    expect(dv.endDateNeed({ repaymentSchedule: false, textes: [] }).notNeeded).toBe(false);
    const t4 = t4Demande();
    expect(await ev.assessDeadlinePertinence({ ...base, candidates: [], decide: t4.decide, endDateNeed: null })).toMatchObject({ outcome: 'CREATE_ACTION' });
  });
  it('FCC-06 — date LUE (même incertaine ou contradictoire) : règle commune inchangée (arbitrage possible)', async () => {
    const r = await ev.assessDeadlinePertinence({ ...base, candidates: [{ iso: '2026-11-30', source: 'FACTS' }, { iso: '2026-12-31', source: 'FACTS' }], contradictory: true, endDateNeed: credit });
    expect(r).toMatchObject({ outcome: 'CREATE_ACTION', pertinence: 'CONTRADICTION' });
  });
  it('FCC-11 — version du moteur incrémentée : les décisions antérieures sont reprises par la campagne existante', () => {
    expect(ev.DOCUMENT_RULE_ENGINE_VERSION).toBe('l76-2');
  });
});
