/**
 * Lot 77A — option « Sans échéance » des événements d'agenda (décision PO du
 * 21/10/2026, suite lot 76C : conflit RES-14 / décision 72C). Tests purs :
 * règle d'admissibilité DATA-AGENDA-DATE, validation serveur, état du
 * formulaire (desktop et mobile : mêmes tiroirs), valeurs écrites.
 * Le parcours base de données (création, édition, fermeture / réouverture
 * de la carte, isolation) est couvert par
 * `src/test/e2e/scenarios/l77a-agenda-sans-echeance.e2e.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const prod = await import('../producers.service');
const nd = await import('@/lib/agenda/no-deadline');
const { agendaItemValues } = await import('@/services/agenda/agenda-write-primitive');
const { manualUpsertInput } = await import('@/services/agenda/AgendaWriteService');

const evt = (p: Partial<import('../producers.service').AgendaDateFacts>) => ({
  homeCategory: null, originType: 'manual', isAutomatic: false, isAutomaticModified: false, requiresQualification: false,
  createdAt: '2026-01-01T00:00:00Z', sourceDate: null, ...p,
});

describe('L77A-R — règle « À traiter » DATA-AGENDA-DATE (critère « date nécessaire » du 76C)', () => {
  it('L77A-R1 — cochée : date justifiée NON nécessaire → aucune carte (NO_ACTION, motif NO_DEADLINE_BY_USER)', () => {
    const d = prod.agendaDateAdmissibility(evt({ noDeadline: true }));
    expect(d).toMatchObject({ outcome: 'NO_ACTION', decisive: 'neededForUse', reason: 'NO_DEADLINE_BY_USER' });
    expect(d.checks.neededForUse).toBe(false);
    expect(prod.NO_DEADLINE_REASON).toBe('NO_DEADLINE_BY_USER');
  });

  it('L77A-R2 — non cochée et sans date : comportement actuel conservé (décision PO 72C, carte justifiée)', () => {
    const d = prod.agendaDateAdmissibility(evt({ noDeadline: false }));
    expect(d).toMatchObject({ outcome: 'CREATE_ACTION' });
    expect(d.justification).toMatch(/USER_CREATED_EVENT_PO_72C/);
    expect(prod.agendaDateAdmissibility(evt({}))).toMatchObject({ outcome: 'CREATE_ACTION' });
  });

  it('L77A-R3 — l’option prime sur la catégorie « action » et sur une date retrouvée à la source (aucune écriture automatique)', () => {
    expect(prod.agendaDateAdmissibility(evt({ noDeadline: true, homeCategory: 'action' }))).toMatchObject({ outcome: 'NO_ACTION', reason: 'NO_DEADLINE_BY_USER' });
    // Événement automatique édité par l'utilisateur, date lisible à la source : jamais réécrite.
    const auto = prod.agendaDateAdmissibility(evt({ noDeadline: true, originType: 'qualified_document', isAutomatic: true, isAutomaticModified: true, sourceDate: '2027-01-01' }));
    expect(auto.outcome).toBe('NO_ACTION');
    // Qualification T4 récente : la décision reste NO_ACTION (jamais DEFER qui maintiendrait une carte).
    expect(prod.agendaDateAdmissibility(evt({ noDeadline: true, requiresQualification: true, createdAt: new Date().toISOString() })).outcome).toBe('NO_ACTION');
  });

  it('L77A-R4 — événements automatiques sans l’option : règles 76C inchangées', () => {
    expect(prod.agendaDateAdmissibility(evt({ originType: 'qualified_document', isAutomatic: true })).outcome).toBe('DEFER');
    expect(prod.agendaDateAdmissibility(evt({ originType: 'qualified_document', isAutomatic: true, homeCategory: 'information' })).outcome).toBe('NO_ACTION');
  });
});

describe('L77A-V — validation serveur de l’écriture', () => {
  it('L77A-V1 — cochée sans date : dates et heures neutralisées', () => {
    expect(nd.resolveNoDeadlineWrite({ noDeadline: true, startDate: null })).toEqual({ ok: true, noDeadline: true, clearDates: true });
    expect(nd.resolveNoDeadlineWrite({ noDeadline: true, startDate: '' })).toEqual({ ok: true, noDeadline: true, clearDates: true });
  });

  it('L77A-V2 — cochée AVEC une date dans la même demande : refus explicite (jamais un choix silencieux)', () => {
    for (const r of [nd.resolveNoDeadlineWrite({ noDeadline: true, startDate: '2027-01-01' }), nd.resolveNoDeadlineWrite({ noDeadline: true, endDate: '2027-01-01' })]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^Validation/);
    }
  });

  it('L77A-V3 — valeur non booléenne : refus ; absente : inchangée, sauf date saisie (décoche)', () => {
    expect(nd.resolveNoDeadlineWrite({ noDeadline: 'oui' }).ok).toBe(false);
    expect(nd.resolveNoDeadlineWrite({ noDeadline: 1 }).ok).toBe(false);
    expect(nd.resolveNoDeadlineWrite({})).toEqual({ ok: true, noDeadline: undefined, clearDates: false });
    expect(nd.resolveNoDeadlineWrite({ startDate: '2027-01-01' })).toEqual({ ok: true, noDeadline: false, clearDates: false });
    expect(nd.resolveNoDeadlineWrite({ noDeadline: false, startDate: null })).toEqual({ ok: true, noDeadline: false, clearDates: false });
    expect(nd.resolveNoDeadlineWrite({ noDeadline: null })).toEqual({ ok: true, noDeadline: undefined, clearDates: false });
  });
});

describe('L77A-F — formulaire (création ET modification, desktop ET mobile)', () => {
  const vide = { startDate: '', startTime: '', endDate: '', endTime: '', noDeadline: false };
  const date = { ...vide, startDate: '2027-03-01', startTime: '09:00', endDate: '2027-03-02', endTime: '10:00' };

  it('L77A-F1 — cocher vide date ET heures ; confirmation seulement si une date existait', () => {
    expect(nd.toggleNoDeadline(date, true)).toEqual({ ...vide, noDeadline: true });
    expect(nd.needsNoDeadlineConfirm(date, true)).toBe(true);
    expect(nd.needsNoDeadlineConfirm(vide, true)).toBe(false);
    expect(nd.needsNoDeadlineConfirm({ ...vide, startTime: '09:00' }, true)).toBe(false);
    expect(nd.needsNoDeadlineConfirm(date, false)).toBe(false);
  });

  it('L77A-F2 — saisir une date décoche ; une heure seule ou un effacement ne décochent pas', () => {
    const coche = { ...vide, noDeadline: true };
    expect(nd.withDateEntry(coche, { startDate: '2027-01-01' })).toMatchObject({ startDate: '2027-01-01', noDeadline: false });
    expect(nd.withDateEntry(coche, { endDate: '2027-01-01' }).noDeadline).toBe(false);
    expect(nd.withDateEntry(coche, { startTime: '08:00' }).noDeadline).toBe(true);
    expect(nd.withDateEntry(coche, { startDate: '' }).noDeadline).toBe(true);
    expect(nd.toggleNoDeadline(coche, false)).toEqual(vide);
  });

  it('L77A-F3 — libellés : option, aide courte, mention « Sans échéance » vs « Sans date »', () => {
    expect(nd.NO_DEADLINE_LABEL).toBe('Sans échéance');
    expect(nd.NO_DEADLINE_HELP).toBe('Cette tâche n’a pas de date à respecter.');
    expect(nd.undatedLabel({ noDeadline: true })).toBe('Sans échéance');
    expect(nd.undatedLabel({ noDeadline: false })).toBe('Sans date');
    expect(nd.undatedLabel({})).toBe('Sans date');
  });
});

describe('L77A-W — valeurs écrites (chemin manuel seulement)', () => {
  it('L77A-W1 — création manuelle cochée : no_deadline écrite ; non cochée : valeurs historiques inchangées (parité)', () => {
    const coche = agendaItemValues(manualUpsertInput({ title: 'Ranger la cave', noDeadline: true }, 1, 2, null));
    expect(coche).toMatchObject({ noDeadline: true, startDate: null, isAutomatic: false });
    const sans = agendaItemValues(manualUpsertInput({ title: 'Ranger la cave' }, 1, 2, null));
    expect(sans).not.toHaveProperty('noDeadline');
  });

  it('L77A-W2 — jamais par un traitement automatique (T4 / projection) : l’option est ignorée', () => {
    const auto = agendaItemValues({ itemId: 5, accountId: 1, assetId: null, origin: 'AUTOMATIC', details: { noDeadline: true } });
    expect(auto).not.toHaveProperty('noDeadline');
    const creationAuto = agendaItemValues({ accountId: 1, assetId: null, origin: 'AUTOMATIC', title: 'CT', details: { noDeadline: true } });
    expect(creationAuto).not.toHaveProperty('noDeadline');
    const maj = agendaItemValues({ itemId: 5, accountId: 1, assetId: null, origin: 'MANUAL', details: { noDeadline: false } });
    expect(maj).toMatchObject({ noDeadline: false });
  });
});
