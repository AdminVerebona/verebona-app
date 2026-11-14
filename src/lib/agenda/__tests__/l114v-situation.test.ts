/**
 * Lot 114V (Trello #742) — « Situation de l'événement » : règles PURES
 * (libellés, défaut, validation serveur du couple situation / date,
 * regroupement des éléments sans date). Aucune dépendance à la date du jour :
 * `today` est injecté.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENDA_SITUATIONS, DEFAULT_NEW_SITUATION, PLAN_ACTION_LABEL, SITUATION_FIELD_LABEL, SITUATION_FUTURE_DATE_ERROR,
  SITUATION_INVALID_ERROR, SITUATION_LABELS, SITUATION_NO_DEADLINE_ERROR, SITUATION_QUESTION, UNKNOWN_DATE_LABEL,
  groupUndated, isAgendaSituation, isUpcomingBySituation, resolveSituationWrite, situationLabel, situationOf,
  undatedGroupOf, undatedMatchesPeriod,
} from '../situation';
import { undatedLabel } from '../no-deadline';

const TODAY = '2026-11-14';
const creation = (p: Partial<Parameters<typeof resolveSituationWrite>[0]> = {}) =>
  resolveSituationWrite({ effectiveStartDate: null, requestedNoDeadline: false, defaultForManualCreation: true, coupleTouched: true, today: TODAY, ...p });
const modification = (existing: 'A_PREVOIR' | 'A_EU_LIEU' | null, p: Partial<Parameters<typeof resolveSituationWrite>[0]> = {}) =>
  resolveSituationWrite({ effectiveStartDate: null, requestedNoDeadline: false, existing, coupleTouched: false, today: TODAY, ...p });

describe('L114V-S — libellés et ordre du sélecteur (textes exacts de la carte #742)', () => {
  it('L114V-S1 — gauche « A eu lieu », droite « À prévoir » ; défaut « À prévoir »', () => {
    expect(AGENDA_SITUATIONS).toEqual(['A_EU_LIEU', 'A_PREVOIR']);
    expect(AGENDA_SITUATIONS.map((s) => SITUATION_LABELS[s]).join(' | ')).toBe('A eu lieu | À prévoir');
    expect(DEFAULT_NEW_SITUATION).toBe('A_PREVOIR');
    expect(SITUATION_FIELD_LABEL).toBe('Situation de l’événement');
    expect(PLAN_ACTION_LABEL).toBe('Planifier');
    expect(UNKNOWN_DATE_LABEL).toBe('Date inconnue');
  });

  it('L114V-S2 — question de qualification NEUTRE, texte exact, sans présupposé', () => {
    expect(SITUATION_QUESTION).toBe('Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?');
    expect(SITUATION_QUESTION).not.toMatch(/quelle date/i);
  });

  it('L114V-S3 — lecture d’une valeur persistée : seules les deux valeurs existent ; le reste est « non qualifié »', () => {
    expect(isAgendaSituation('A_PREVOIR')).toBe(true);
    expect(isAgendaSituation('realise')).toBe(false);
    expect(isAgendaSituation('annule')).toBe(false);
    expect(situationOf(null)).toBeNull();
    expect(situationOf('ANNULE')).toBeNull();
    expect(situationLabel('A_EU_LIEU')).toBe('A eu lieu');
    expect(situationLabel(null)).toBeNull();
  });
});

describe('L114V-V — validation serveur (création)', () => {
  it('L114V-V1 — création manuelle sans situation transmise (ancien client, Assistant) : « À prévoir », provenance DEFAULT', () => {
    expect(creation()).toEqual({ ok: true, situation: 'A_PREVOIR', source: 'DEFAULT', effective: 'A_PREVOIR' });
    // `null` d'un ancien client : comme absent.
    expect(creation({ situation: null })).toMatchObject({ ok: true, situation: 'A_PREVOIR', source: 'DEFAULT' });
  });

  it('L114V-V2 — choix transmis : écrit tel quel, provenance USER ; date facultative dans les deux cas', () => {
    expect(creation({ situation: 'A_EU_LIEU' })).toEqual({ ok: true, situation: 'A_EU_LIEU', source: 'USER', effective: 'A_EU_LIEU' });
    expect(creation({ situation: 'A_PREVOIR' })).toEqual({ ok: true, situation: 'A_PREVOIR', source: 'USER', effective: 'A_PREVOIR' });
    expect(creation({ situation: 'A_EU_LIEU', effectiveStartDate: '2026-03-02' })).toMatchObject({ ok: true, situation: 'A_EU_LIEU' });
    expect(creation({ situation: 'A_PREVOIR', effectiveStartDate: '2027-03-02' })).toMatchObject({ ok: true, situation: 'A_PREVOIR' });
  });

  it('L114V-V3 — « À prévoir » avec une date PASSÉE : accepté, jamais converti en « A eu lieu »', () => {
    expect(creation({ situation: 'A_PREVOIR', effectiveStartDate: '2020-01-01' })).toEqual({ ok: true, situation: 'A_PREVOIR', source: 'USER', effective: 'A_PREVOIR' });
    expect(creation({ effectiveStartDate: '2020-01-01' })).toMatchObject({ ok: true, situation: 'A_PREVOIR', source: 'DEFAULT' });
  });

  it('L114V-V4 — « A eu lieu » + date FUTURE : refus explicite ; le jour même est accepté', () => {
    expect(creation({ situation: 'A_EU_LIEU', effectiveStartDate: '2026-11-15' })).toEqual({ ok: false, error: SITUATION_FUTURE_DATE_ERROR });
    expect(creation({ situation: 'A_EU_LIEU', effectiveStartDate: TODAY })).toMatchObject({ ok: true, situation: 'A_EU_LIEU' });
    expect(SITUATION_FUTURE_DATE_ERROR).toMatch(/^Validation : /);
  });

  it('L114V-V5 — valeur inconnue (dont les anciens statuts) : refus ; « A eu lieu » + « Sans échéance » : refus', () => {
    for (const v of ['realise', 'annule', 'OUI', 1, true, {}]) expect(creation({ situation: v })).toEqual({ ok: false, error: SITUATION_INVALID_ERROR });
    expect(creation({ situation: 'A_EU_LIEU', requestedNoDeadline: true })).toEqual({ ok: false, error: SITUATION_NO_DEADLINE_ERROR });
    expect(creation({ situation: 'A_PREVOIR', requestedNoDeadline: true })).toMatchObject({ ok: true });
  });

  it('L114V-V6 — élément créé par un traitement (pas de défaut manuel) : reste NON qualifié', () => {
    expect(creation({ defaultForManualCreation: false })).toEqual({ ok: true, situation: undefined, source: undefined, effective: null });
  });
});

describe('L114V-V — validation serveur (modification)', () => {
  it('L114V-V7 — sans situation transmise : inchangée ; un élément hérité non qualifié n’est JAMAIS reclassé d’office', () => {
    expect(modification(null)).toEqual({ ok: true, situation: undefined, source: undefined, effective: null });
    expect(modification(null, { effectiveStartDate: '2020-01-01', coupleTouched: true })).toMatchObject({ situation: undefined, effective: null });
    expect(modification('A_EU_LIEU')).toMatchObject({ ok: true, situation: undefined, effective: 'A_EU_LIEU' });
  });

  it('L114V-V8 — changement « À prévoir » ↔ « A eu lieu » : écrit, provenance USER ; même valeur : rien à réécrire', () => {
    expect(modification('A_PREVOIR', { situation: 'A_EU_LIEU' })).toEqual({ ok: true, situation: 'A_EU_LIEU', source: 'USER', effective: 'A_EU_LIEU' });
    expect(modification('A_EU_LIEU', { situation: 'A_PREVOIR' })).toEqual({ ok: true, situation: 'A_PREVOIR', source: 'USER', effective: 'A_PREVOIR' });
    expect(modification(null, { situation: 'A_PREVOIR' })).toMatchObject({ situation: 'A_PREVOIR', source: 'USER' });
    expect(modification('A_PREVOIR', { situation: 'A_PREVOIR' })).toEqual({ ok: true, situation: undefined, source: undefined, effective: 'A_PREVOIR' });
  });

  it('L114V-V9 — contradiction contrôlée sur le COUPLE après écriture : date future posée sur « A eu lieu », ou « A eu lieu » posé sur une date future', () => {
    expect(modification('A_EU_LIEU', { effectiveStartDate: '2027-01-01', coupleTouched: true })).toEqual({ ok: false, error: SITUATION_FUTURE_DATE_ERROR });
    expect(modification('A_PREVOIR', { situation: 'A_EU_LIEU', effectiveStartDate: '2027-01-01' })).toEqual({ ok: false, error: SITUATION_FUTURE_DATE_ERROR });
    // Retirer la date d'un événement qui a eu lieu : il le reste (date inconnue).
    expect(modification('A_EU_LIEU', { effectiveStartDate: null, coupleTouched: true })).toMatchObject({ ok: true, situation: undefined, effective: 'A_EU_LIEU' });
    // Une modification sans rapport (titre) n'est jamais bloquée.
    expect(modification('A_EU_LIEU', { effectiveStartDate: '2027-01-01', coupleTouched: false })).toMatchObject({ ok: true });
  });
});

describe('L114V-G — éléments sans date : groupes, périodes, libellés', () => {
  const items = [
    { id: 1, situation: 'A_EU_LIEU' }, { id: 2, situation: null }, { id: 3, situation: 'A_PREVOIR' },
    { id: 4, situation: 'A_PREVOIR' }, { id: 5 },
  ];

  it('L114V-G1 — trois groupes distincts, « À prévoir » d’abord, ordre d’entrée conservé, aucun élément compté deux fois', () => {
    const groupes = groupUndated(items);
    expect(groupes.map((g) => [g.group, g.label, g.items.map((i) => i.id)])).toEqual([
      ['A_PREVOIR', 'À prévoir', [3, 4]],
      ['NON_QUALIFIE', 'Sans date', [2, 5]],
      ['DATE_INCONNUE', 'Date inconnue', [1]],
    ]);
    expect(groupes.flatMap((g) => g.items)).toHaveLength(items.length);
    expect(groupUndated([{ situation: 'A_PREVOIR' }]).map((g) => g.group)).toEqual(['A_PREVOIR']);
    expect(groupUndated([])).toEqual([]);
    expect(undatedGroupOf({ situation: 'annule' })).toBe('NON_QUALIFIE');
  });

  it('L114V-G2 — périodes : « A eu lieu » sans date jamais dans l’à-venir ni aujourd’hui ; « À prévoir » sans date jamais dans le passé', () => {
    expect(undatedMatchesPeriod({ situation: 'A_EU_LIEU' }, 'upcoming')).toBe(false);
    expect(undatedMatchesPeriod({ situation: 'A_EU_LIEU' }, 'today')).toBe(false);
    expect(undatedMatchesPeriod({ situation: 'A_EU_LIEU' }, 'past')).toBe(true);
    expect(undatedMatchesPeriod({ situation: 'A_PREVOIR' }, 'upcoming')).toBe(true);
    expect(undatedMatchesPeriod({ situation: 'A_PREVOIR' }, 'past')).toBe(false);
    for (const p of ['upcoming', 'today', 'past']) expect(undatedMatchesPeriod({ situation: null }, p)).toBe(true);
  });

  it('L114V-G3 — un événement qui a eu lieu n’est jamais une échéance à venir ; non qualifié et « À prévoir » : inchangés', () => {
    expect(isUpcomingBySituation({ situation: 'A_EU_LIEU' })).toBe(false);
    expect(isUpcomingBySituation({ situation: 'A_PREVOIR' })).toBe(true);
    expect(isUpcomingBySituation({})).toBe(true);
  });

  it('L114V-G4 — libellé d’un élément sans date : « À prévoir », « Date inconnue », « Sans échéance » (lot 77A conservé), sinon « Sans date »', () => {
    expect(undatedLabel({ situation: 'A_PREVOIR' })).toBe('À prévoir');
    expect(undatedLabel({ situation: 'A_EU_LIEU' })).toBe('Date inconnue');
    expect(undatedLabel({ situation: 'A_PREVOIR', noDeadline: true })).toBe('Sans échéance');
    expect(undatedLabel({ noDeadline: false })).toBe('Sans date');
    expect(undatedLabel({})).toBe('Sans date');
  });
});
