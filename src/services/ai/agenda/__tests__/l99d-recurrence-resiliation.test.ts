/**
 * Lot 99D — ticket « [P1] Agenda — Corriger la détection abusive de fin de
 * récurrence à partir des clauses de résiliation » (L99D-U-RECURRENCE-END).
 *
 * Tableau §4 du ticket, du texte lu jusqu'aux décisions Agenda (aucune base,
 * T4 simulé) : `parseRecurrenceFr` (aucune fin sur un mot), fin QUALIFIÉE
 * par l'état contractuel (`resolveRecurrenceEnd`, via les candidats du
 * document), `computeOccurrences` (borne = date d'effet), moteur T4
 * (`processAgendaCandidates` : prévisions, retraits tracés). Scénario PG16 :
 * `src/test/e2e/scenarios/l99d-recurrence-resiliation.e2e.ts`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: vi.fn(async () => { throw new Error('pas de modèle'); }) } }));
import {
  parseRecurrenceFr, computeOccurrences, confirmedEndDate, effectiveSeriesBound, recurrenceEndForTrace, describeRecurrence,
  type RecurrenceEnd, type RecurrenceSpec,
} from '../rules/recurrence';
import { resolveRecurrenceEnd, legacyKeywordEndFlag } from '../rules/recurrence-end';
import { processAgendaCandidates } from '../agenda-intelligence.service';
import { buildAgendaCandidatesT4, buildAgendaCandidates } from '../../source-analysis/steps/build-agenda-candidates.step';
import type { ExtractedField } from '../../source-analysis/types';
import type { ExistingAgendaItem } from '../types';
import { t4Simule } from './support/t4-simule';
import { lifecycleSignalsOf } from '@/services/to-process/contract-lifecycle';
import * as ev from '@/services/to-process/document-field-evidence';

const TODAY = '2026-10-27';

/** Fait T1 (certain, lu dans le texte). */
const fait = (fieldKey: string, value: string, excerpt: string, confidence: ExtractedField['confidence'] = 'certain'): ExtractedField =>
  ({ fieldKey, value, confidence, excerpt });

/** Candidats T4 d'un document mono-bien (même constructeur que l'analyse et la reprise). */
const candidats = (fields: ExtractedField[], today = TODAY) => buildAgendaCandidatesT4(fields, {
  sourceFileId: 77, documentAssetId: 5, multiAsset: false, documentType: 'CONTRAT_ASSURANCE', today,
});
const recurrent = (fields: ExtractedField[], today = TODAY) => {
  const c = candidats(fields, today).find((x) => x.recurrence);
  expect(c, 'un candidat récurrent').toBeDefined();
  return c!;
};

// ══════════════════════════════════════════════════════════════════════════
// Tableau §4 — cas contractuels
// ══════════════════════════════════════════════════════════════════════════

/** Échéance annuelle d'assurance au 31/12/2026, avec la clause lue dans le même extrait. */
const assurance = (clause: string, autres: ExtractedField[] = []) => [
  fait('insuranceExpiry', '2026-12-31', `Échéance annuelle le 31/12/2026. ${clause}`),
  ...autres,
];

describe('§4 — la récurrence est MAINTENUE (aucune fin établie)', () => {
  it.each([
    ['reconduction annuelle, résiliation possible avec deux mois de préavis', 'Contrat reconduit tacitement chaque année, résiliation possible avec deux mois de préavis.'],
    ['contrat résiliable à tout moment', 'Contrat résiliable à tout moment.'],
    ['renouvelé automatiquement sauf résiliation', 'Contrat renouvelé automatiquement sauf résiliation.'],
    ['aucune résiliation demandée', 'Aucune résiliation n’a été demandée.'],
    ['résiliation envisagée, sans effet confirmé', 'Le client envisage la résiliation du contrat.'],
    ['résiliation demandée, sans effet confirmé', 'Résiliation demandée par le client le 10/10/2026, en attente de confirmation.'],
    ['clause conditionnelle évoquant une fin de contrat', 'En cas de non-paiement, le contrat prendra fin de plein droit.'],
    ['texte ambigu ou incomplet', 'Fin du contrat : voir conditions générales. Dernière échéance.'],
    ['non-renouvellement au conditionnel', 'Le contrat ne sera pas renouvelé si le client le demande avant l’échéance.'],
  ])('%s → aucune fin, prochaine occurrence générée', (_cas, clause) => {
    const fields = assurance(clause);
    const spec = parseRecurrenceFr(fields[0].excerpt!)!;
    // parseRecurrenceFr : la clause est conservée, aucune fin n'est posée.
    expect(spec).toMatchObject({ frequency: 'yearly', interval: 1 });
    expect(spec.ended).toBeUndefined();
    expect(spec.end).toBeUndefined();
    expect(spec.excerpt).toContain(clause.slice(0, 20));
    const c = recurrent(fields);
    // Aucune fin CONFIRMÉE : la série n'est jamais bornée par cette clause.
    expect(confirmedEndDate(c.recurrence!)).toBeNull();
    expect(computeOccurrences(c.recurrence!, c.date, TODAY)).toEqual(['2027-12-31']);
  });

  it('non-renouvellement au conditionnel : signal tracé INCERTAIN (contradiction), jamais appliqué', () => {
    // « ne sera pas renouvelé SI… » : la non-reconduction est lue, mais le texte dit aussi « renouvel… » sous condition.
    const c = recurrent(assurance('Le contrat ne sera pas renouvelé si le client le demande avant l’échéance.', [
      fait('contractEndDate', '2026-12-31', 'Fin de la période en cours : 31/12/2026'),
    ]));
    expect(c.recurrence!.end?.status ?? 'AUCUNE').not.toBe('CONFIRMED');
  });

  it('date de fin lue sans information de reconduction → fin INCERTAINE tracée, aucune suppression', () => {
    const c = recurrent(assurance('Garanties détaillées en annexe.', [fait('contractEndDate', '2026-12-31', 'Date de fin : 31/12/2026')]));
    expect(c.recurrence!.end).toMatchObject({ status: 'UNCERTAIN', reason: 'END_DATE_RENEWAL_UNKNOWN', effectiveDate: '2026-12-31', source: { kind: 'T1_FACT', fieldKey: 'contractEndDate', sourceFileId: 77 } });
    expect(computeOccurrences(c.recurrence!, c.date, TODAY)).toEqual(['2027-12-31']);
  });

  it('contrat reconductible avec date de fin de période : aucune fin (la date est celle de la période en cours)', () => {
    const c = recurrent(assurance('Contrat reconduit tacitement chaque année.', [fait('contractEndDate', '2026-12-31', 'Date de fin : 31/12/2026')]));
    expect(c.recurrence!.end).toBeUndefined();
    expect(computeOccurrences(c.recurrence!, c.date, TODAY)).toEqual(['2027-12-31']);
  });

  it('constat de fin lu dans une preuve PEU FIABLE → indice incertain, aucune suppression', () => {
    const c = recurrent(assurance('Garanties en annexe.', [fait('contractNote', 'Le contrat a été résilié le 31/12/2025.', 'Le contrat a été résilié le 31/12/2025.', 'probable')]));
    expect(c.recurrence!.end).toMatchObject({ status: 'UNCERTAIN', reason: 'TERMINATION_UNPROVEN' });
    expect(computeOccurrences(c.recurrence!, c.date, TODAY)).toEqual(['2027-12-31']);
  });
});

describe('§4 — fins ÉTABLIES et datées : la date d’effet est respectée', () => {
  it('contrat effectivement résilié au 31/12/2025 → aucune occurrence postérieure ; historique conservé', () => {
    const fields = [
      fait('insuranceExpiry', '2025-06-30', 'Cotisation annuelle, échéance le 30/06/2025.'),
      fait('contractNote', 'Le contrat a été résilié avec effet au 31/12/2025.', 'Le contrat a été résilié avec effet au 31/12/2025.'),
    ];
    const c = recurrent(fields);
    expect(c.recurrence!.end).toMatchObject({
      status: 'CONFIRMED', reason: 'TERMINATION_EFFECTIVE', effectiveDate: '2025-12-31',
      source: { kind: 'T1_FACT', fieldKey: 'contractNote', confidence: 'certain', excerpt: 'Le contrat a été résilié avec effet au 31/12/2025.' },
    });
    // Récurrence ouverte : la prochaine (30/06/2027) est postérieure à la fin → rien.
    expect(computeOccurrences(c.recurrence!, c.date, TODAY)).toEqual([]);
    // Échéancier borné : les occurrences ANTÉRIEURES à la fin restent, rien après.
    const mensuel: RecurrenceSpec = { ...parseRecurrenceFr('Prélèvement mensuel du 15/01/2025 au 15/12/2026')!, end: c.recurrence!.end };
    const dates = computeOccurrences(mensuel, '2025-01-15', TODAY);
    expect(dates[0]).toBe('2025-01-15');
    expect(dates.at(-1)).toBe('2025-12-15');
    expect(dates).toHaveLength(12);
    // Dates listées : celles d'après la fin ne sont plus produites.
    expect(computeOccurrences({ ...mensuel, dates: ['2025-11-15', '2026-01-15'] }, '2025-11-15', TODAY)).toEqual(['2025-11-15']);
  });

  it('non-renouvellement confirmé à une échéance future → occurrences conservées jusqu’à la date d’effet', () => {
    const fields = [
      fait('contractNote', 'Le contrat ne sera pas renouvelé à son échéance.', 'Le contrat ne sera pas renouvelé à son échéance.'),
      fait('contractEndDate', '2027-03-31', 'Date de fin du contrat : 31/03/2027'),
      fait('maintenanceDueDate', '2026-11-15', 'Prélèvement mensuel du 15/01/2026 au 15/12/2027.'),
    ];
    const c = recurrent(fields);
    expect(c.recurrence!.end).toMatchObject({ status: 'CONFIRMED', reason: 'NO_RENEWAL', effectiveDate: '2027-03-31', source: { fieldKey: 'contractNote', dateFieldKey: 'contractEndDate' } });
    const dates = computeOccurrences(c.recurrence!, c.date, TODAY);
    expect(dates[0]).toBe('2026-01-15');
    expect(dates.at(-1)).toBe('2027-03-15');
    expect(effectiveSeriesBound(c.recurrence!)).toBe('2027-03-31');
    expect(describeRecurrence(c.recurrence!)).toBe('chaque mois jusqu’au 2027-03-31');
  });

  it('résiliation constatée à effet FUTUR → bornée à sa date d’effet', () => {
    const c = recurrent(assurance('Garanties en annexe.', [
      fait('contractNote', 'Le contrat a été résilié avec effet au 31/03/2027.', 'Le contrat a été résilié avec effet au 31/03/2027.'),
    ]));
    expect(c.recurrence!.end).toMatchObject({ status: 'CONFIRMED', reason: 'TERMINATION_SCHEDULED', effectiveDate: '2027-03-31' });
    expect(computeOccurrences(c.recurrence!, c.date, TODAY)).toEqual([]);
    // Une occurrence avant la date d'effet reste due.
    const m = recurrent([fait('insuranceExpiry', '2026-12-15', 'Prélèvement mensuel, échéance le 15/12/2026.'), fait('contractNote', 'x', 'Le contrat a été résilié avec effet au 31/03/2027.')]);
    expect(computeOccurrences(m.recurrence!, m.date, TODAY)).toEqual(['2027-01-15']);
  });

  it('contrat à durée déterminée sans reconduction → date de fin contractuelle respectée', () => {
    const fields = [
      fait('leaseEndDate', '2027-06-30', 'Fin de la location : 30/06/2027'),
      fait('leaseMonthlyPayment', '350', 'Contrat de location d’une durée de 3 ans, sans tacite reconduction. Loyer mensuel de 350 €.'),
      fait('maintenanceDueDate', '2026-12-01', 'Entretien du véhicule tous les 6 mois, prochain le 01/12/2026.'),
    ];
    const c = recurrent(fields);
    expect(c.recurrence!.end).toMatchObject({ status: 'CONFIRMED', reason: 'NO_RENEWAL', effectiveDate: '2027-06-30' });
    // Prochaine occurrence (01/06/2027) avant la fin : due ; la suivante (01/12/2027) ne l'est plus.
    expect(computeOccurrences(c.recurrence!, c.date, TODAY)).toEqual(['2027-06-01']);
    expect(computeOccurrences(c.recurrence!, '2027-06-01', '2027-06-02')).toEqual([]);
  });

  it('constat de fin sans date : date de fin structurée si établie, sinon fin INCERTAINE', () => {
    const avec = recurrent(assurance('Garanties en annexe.', [
      fait('contractNote', 'x', 'Résiliation effective.'), fait('contractEndDate', '2025-12-31', 'Date de fin : 31/12/2025'),
    ]));
    expect(avec.recurrence!.end).toMatchObject({ status: 'CONFIRMED', reason: 'TERMINATION_EFFECTIVE', effectiveDate: '2025-12-31', source: { dateFieldKey: 'contractEndDate' } });
    const sans = recurrent(assurance('Garanties en annexe.', [fait('contractNote', 'x', 'Résiliation effective.')]));
    expect(sans.recurrence!.end).toMatchObject({ status: 'UNCERTAIN', reason: 'TERMINATION_UNDATED', effectiveDate: null });
    expect(computeOccurrences(sans.recurrence!, sans.date, TODAY)).toEqual(['2027-12-31']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Garde-fous du modèle
// ══════════════════════════════════════════════════════════════════════════

describe('modèle de fin qualifiée', () => {
  it('l’ancien booléen `ended` (travail ancien) est IGNORÉ et tracé LEGACY_KEYWORD_FLAG', () => {
    const vieux = { ...parseRecurrenceFr('Entretien annuel')!, ended: true };
    expect(computeOccurrences(vieux, '2026-11-15', TODAY)).toEqual(['2027-11-15']);
    expect(recurrenceEndForTrace(vieux)).toMatchObject({ status: 'UNCERTAIN', reason: 'LEGACY_KEYWORD_FLAG' });
  });
  it('une fin CONFIRMED sans date valide n’a aucun effet', () => {
    const e = { status: 'CONFIRMED', reason: 'TERMINATION_EFFECTIVE', effectiveDate: null, source: { kind: 'T1_FACT' } } as RecurrenceEnd;
    expect(computeOccurrences({ ...parseRecurrenceFr('Entretien annuel')!, end: e }, '2026-11-15', TODAY)).toEqual(['2027-11-15']);
  });
  it('échéancier énoncé ET fin confirmée : la borne la plus proche', () => {
    const e: RecurrenceEnd = { status: 'CONFIRMED', reason: 'NO_RENEWAL', effectiveDate: '2027-02-28', source: { kind: 'T1_FACT' } };
    expect(effectiveSeriesBound({ endDate: '2027-06-15', end: e })).toBe('2027-02-28');
    expect(effectiveSeriesBound({ endDate: '2027-01-15', end: e })).toBe('2027-01-15');
  });
  it('document multi-biens : aucune fin déduite (la clause peut viser un autre contrat)', () => {
    const fields = assurance('Garanties.', [fait('contractNote', 'x', 'Le contrat a été résilié le 31/12/2025.')]);
    const c = buildAgendaCandidatesT4(fields, { sourceFileId: 77, documentAssetId: null, multiAsset: true, documentType: 'CONTRAT_ASSURANCE', today: TODAY });
    expect(c.every((x) => !x.recurrence?.end)).toBe(true);
  });
  it('chemin historique `buildAgendaCandidates` : même qualification', () => {
    const c = buildAgendaCandidates([
      fait('maintenanceDueDate', '2025-06-30', 'Entretien annuel, prévu le 30/06/2025.'),
      fait('contractNote', 'x', 'Le contrat a été résilié le 31/12/2025.'),
    ], undefined, TODAY);
    expect(c[0].recurrence?.end).toMatchObject({ status: 'CONFIRMED', reason: 'TERMINATION_EFFECTIVE', effectiveDate: '2025-12-31' });
  });
  it('détecteur de l’ancienne règle : empreinte seulement (reprise), jamais une décision', () => {
    expect(legacyKeywordEndFlag('résiliation possible avec deux mois de préavis')).toBe(true);
    expect(legacyKeywordEndFlag('Entretien annuel')).toBe(false);
    expect(resolveRecurrenceEnd({ texts: [{ text: 'résiliation possible avec deux mois de préavis', confidence: 'certain', fieldKey: 'k' }], endDates: [] }, { today: TODAY })).toBeNull();
  });
  it('qualification du cycle de vie : sorties datées additionnelles, ré-export inchangé', () => {
    expect(lifecycleSignalsOf(['Le contrat a été résilié le 31/12/2025.'], TODAY)).toMatchObject({ terminated: true, terminatedDates: ['2025-12-31'] });
    expect(lifecycleSignalsOf(['Le contrat a été résilié avec effet au 31/03/2027.'], TODAY)).toMatchObject({ terminated: false, confirmedFutureEndDates: ['2027-03-31'] });
    expect(lifecycleSignalsOf(['Le contrat prendra fin le 31/03/2027.'], TODAY).confirmedFutureEndDates).toBeUndefined();
    expect(lifecycleSignalsOf(['Facture du mois de mars.'], TODAY)).not.toHaveProperty('terminatedDates');
    expect(ev.lifecycleSignalsOf).toBe(lifecycleSignalsOf);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Moteur T4 → décisions Agenda (intégration sans base)
// ══════════════════════════════════════════════════════════════════════════

describe('jusqu’aux décisions Agenda (T4 simulé)', () => {
  const run = (fields: ExtractedField[], existing: ExistingAgendaItem[] = []) => processAgendaCandidates({
    accountId: 1, assetId: 5, sourceFileId: 77, today: TODAY, existing, decide: t4Simule,
    candidates: candidats(fields).filter((c) => c.recurrence),
  });

  it('contrat actif avec clause de résiliation : prévision créée (régression du ticket)', async () => {
    const d = await run(assurance('Contrat reconduit tacitement chaque année, résiliation possible avec deux mois de préavis.'));
    const f = d.find((x) => x.date === '2027-12-31')!;
    expect(f).toMatchObject({ action: 'create', occurrence: { nature: 'FORECAST', dateSource: 'PREDICTED_FROM_RECURRENCE' } });
    expect(f.occurrence!.recurrence!.end).toBeUndefined();
    expect(d.some((x) => x.action === 'retire_forecast')).toBe(false);
  });

  it('fin incertaine : prévision créée, fin TRACÉE dans la récurrence de la série et la trace T4', async () => {
    const d = await run(assurance('Garanties détaillées.', [fait('contractEndDate', '2026-12-31', 'Date de fin : 31/12/2026')]));
    const f = d.find((x) => x.date === '2027-12-31')!;
    expect(f.action).toBe('create');
    expect(f.occurrence!.recurrence!.end).toMatchObject({ status: 'UNCERTAIN', reason: 'END_DATE_RENEWAL_UNKNOWN' });
    const base = d.find((x) => x.date === '2026-12-31')!;
    expect(base.t4!.recurrenceCandidate!.end).toEqual({ status: 'UNCERTAIN', reason: 'END_DATE_RENEWAL_UNKNOWN', effectiveDate: '2026-12-31', sourceKind: 'T1_FACT', fieldKey: 'contractEndDate' });
  });

  it('fin passée confirmée : aucune prévision ; prévision automatique postérieure retirée avec raison, date et source ; occurrences réelles intactes', async () => {
    const existing: ExistingAgendaItem[] = [
      { id: 10, title: 'Échéance de l’assurance', date: '2024-12-31', category: 'action', status: null, manual: false, originFieldKey: 'insuranceExpiry', nature: 'CONFIRMED' },
      { id: 11, title: 'Échéance de l’assurance', date: '2025-12-31', category: 'action', status: null, manual: false, originFieldKey: 'insuranceExpiry', nature: 'CONFIRMED' },
      { id: 12, title: 'Échéance de l’assurance', date: '2026-12-31', category: 'action', status: null, manual: false, originFieldKey: 'insuranceExpiry', nature: 'FORECAST' },
      { id: 13, title: 'Échéance de l’assurance', date: '2027-12-31', category: 'action', status: null, manual: true, originFieldKey: 'insuranceExpiry', nature: 'FORECAST' },
    ];
    const d = await run([
      fait('insuranceExpiry', '2025-12-31', 'Échéance annuelle le 31/12/2025.'),
      fait('contractNote', 'x', 'Le contrat a été résilié avec effet au 31/12/2025.'),
    ], existing);
    expect(d.filter((x) => x.action === 'create' && x.occurrence?.nature === 'FORECAST')).toEqual([]);
    const retraits = d.filter((x) => x.action === 'retire_forecast');
    // Seule la prévision automatique intacte postérieure ; jamais une occurrence confirmée ni une prévision touchée.
    expect(retraits.map((x) => x.existingItemId)).toEqual([12]);
    expect(retraits[0].recurrenceEnd).toMatchObject({
      bound: '2025-12-31', end: { status: 'CONFIRMED', reason: 'TERMINATION_EFFECTIVE', effectiveDate: '2025-12-31', source: { kind: 'T1_FACT', fieldKey: 'contractNote' } },
    });
  });

  it('fin future confirmée : occurrences conservées jusqu’à la date d’effet, rien après', async () => {
    const d = await run([
      fait('contractNote', 'x', 'Le contrat ne sera pas renouvelé à son échéance.'),
      fait('contractEndDate', '2027-03-31', 'Date de fin du contrat : 31/03/2027'),
      fait('maintenanceDueDate', '2026-11-15', 'Prélèvement mensuel du 15/01/2026 au 15/12/2027.'),
    ]);
    const prev = d.filter((x) => x.occurrence?.nature === 'FORECAST' && x.action === 'create').map((x) => x.date);
    expect(prev.at(-1)).toBe('2027-03-15');
    expect(prev.every((x) => x <= '2027-03-31')).toBe(true);
    expect(d.find((x) => x.date === '2027-03-15')!.occurrence!.recurrence).toMatchObject({ rule: 'chaque mois jusqu’au 2027-03-31', end: { reason: 'NO_RENEWAL' } });
  });
});
