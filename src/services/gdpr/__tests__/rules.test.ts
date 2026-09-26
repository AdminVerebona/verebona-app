/**
 * Règles des demandes RGPD — CDC Back-Office V1 GDP-003, GDP-007, GDP-008,
 * GDP-011 à GDP-017, REC-GDP-02 à REC-GDP-05.
 */
import { describe, it, expect } from 'vitest';
import {
  addOneMonth,
  canTransition,
  computeDueDate,
  computeDueDateFromInstant,
  daysRemaining,
  parseListQuery,
  planManualCreate,
  planManualUpdate,
  planReopen,
  type GdprRequestState,
} from '../rules';

const NOW = new Date('2026-09-26T10:00:00Z');

describe('échéance = réception + 1 mois (GDP-011, art. 12.3 RGPD)', () => {
  it.each([
    ['2026-01-15', '2026-02-15'],
    ['2026-01-31', '2026-02-28'], // février court
    ['2028-01-31', '2028-02-29'], // année bissextile
    ['2028-01-29', '2028-02-29'],
    ['2026-01-28', '2026-02-28'],
    ['2026-03-31', '2026-04-30'],
    ['2026-05-31', '2026-06-30'],
    ['2026-08-31', '2026-09-30'],
    ['2026-02-28', '2026-03-28'], // fin de mois courte : même quantième, pas « fin de mois »
    ['2026-04-30', '2026-05-30'],
    ['2026-12-31', '2027-01-31'], // changement d'année
    ['2026-12-15', '2027-01-15'],
  ])('%s → %s', (received, due) => {
    expect(addOneMonth(received)).toBe(due);
    expect(computeDueDate(received, 'access')).toBe(due);
  });

  it('refuse une date invalide', () => {
    expect(() => addOneMonth('2026-02-30')).toThrow(RangeError);
    expect(() => addOneMonth('31/01/2026')).toThrow(RangeError);
  });

  it('demande système : la date de réception est la date calendaire à Paris', () => {
    // 31 janvier 23:30 UTC = 1er février 00:30 à Paris.
    expect(computeDueDateFromInstant(new Date('2026-01-31T23:30:00Z'))).toBe('2026-03-01');
    // 31 janvier 22:30 UTC = 31 janvier 23:30 à Paris.
    expect(computeDueDateFromInstant(new Date('2026-01-31T22:30:00Z'))).toBe('2026-02-28');
    // Heure d'été : 31 mai 21:59 UTC = 31 mai 23:59 à Paris.
    expect(computeDueDateFromInstant(new Date('2026-05-31T21:59:00Z'))).toBe('2026-06-30');
  });
});

describe('jours restants (GDP-003)', () => {
  it('jours calendaires à Paris, négatif si dépassée', () => {
    expect(daysRemaining('2026-09-26', NOW)).toBe(0);
    expect(daysRemaining('2026-10-26', NOW)).toBe(30);
    expect(daysRemaining('2026-09-20', NOW)).toBe(-6);
    // 23:30 UTC le 26 = 27 à Paris.
    expect(daysRemaining('2026-09-28', new Date('2026-09-26T23:30:00Z'))).toBe(1);
  });
  it('franchit le changement d’heure sans erreur d’arrondi', () => {
    expect(daysRemaining('2026-11-01', new Date('2026-10-20T12:00:00Z'))).toBe(12);
  });
});

describe('transitions de statut (GDP-012, GDP-015)', () => {
  it('vers l’avant uniquement', () => {
    expect(canTransition('received', 'in_progress')).toBe(true);
    expect(canTransition('received', 'done')).toBe(true);
    expect(canTransition('in_progress', 'done')).toBe(true);
    expect(canTransition('in_progress', 'received')).toBe(false);
    expect(canTransition('done', 'in_progress')).toBe(false);
    expect(canTransition('done', 'received')).toBe(false);
  });
});

const manual: GdprRequestState = {
  origin: 'manual', status: 'received', rightType: 'access', channel: 'email',
  receivedDate: '2026-09-01', dueDate: '2026-10-01', internalComment: null, result: null,
  userId: 12, accountId: 3,
};

describe('création manuelle (GDP-010, GDP-011)', () => {
  const base = { userId: 12, rightType: 'erasure', channel: 'postal_mail', receivedDate: '2026-08-31' };

  it('calcule l’échéance côté serveur', () => {
    const p = planManualCreate(base, NOW);
    expect(p.ok && p.value.dueDate).toBe('2026-09-30');
    expect(p.ok && p.value.status).toBe('received');
  });
  it('refuse une échéance saisie', () => {
    expect(planManualCreate({ ...base, dueDate: '2026-12-31' }, NOW)).toMatchObject({ ok: false, error: 'DUE_DATE_NOT_ACCEPTED' });
  });
  it('exige un utilisateur ou un compte', () => {
    expect(planManualCreate({ ...base, userId: null }, NOW)).toMatchObject({ ok: false, error: 'SUBJECT_REQUIRED' });
    expect(planManualCreate({ ...base, userId: null, accountId: 4 }, NOW).ok).toBe(true);
  });
  it('refuse une réception future, un type ou un canal inconnu, un statut « rejetée »', () => {
    expect(planManualCreate({ ...base, receivedDate: '2026-09-27' }, NOW)).toMatchObject({ ok: false, error: 'RECEIVED_IN_FUTURE' });
    expect(planManualCreate({ ...base, rightType: 'deletion' }, NOW)).toMatchObject({ ok: false, field: 'rightType' });
    expect(planManualCreate({ ...base, channel: 'fax' }, NOW)).toMatchObject({ ok: false, field: 'channel' });
    expect(planManualCreate({ ...base, status: 'rejected' }, NOW)).toMatchObject({ ok: false, field: 'status' });
  });
});

describe('modification (GDP-007, GDP-008, GDP-014, GDP-015)', () => {
  it('refuse toute modification d’une demande système (REC-GDP-05)', () => {
    const system = { ...manual, origin: 'system' as const, rightType: 'erasure' as const };
    expect(planManualUpdate(system, { status: 'done' }, NOW)).toMatchObject({ ok: false, error: 'SYSTEM_REQUEST_READ_ONLY' });
    expect(planManualUpdate(system, { internalComment: 'x' }, NOW)).toMatchObject({ ok: false, error: 'SYSTEM_REQUEST_READ_ONLY' });
    expect(planReopen({ ...system, status: 'done' })).toMatchObject({ ok: false, error: 'SYSTEM_REQUEST_READ_ONLY' });
  });

  it('refuse la modification d’une demande traitée', () => {
    expect(planManualUpdate({ ...manual, status: 'done' }, { result: 'x' }, NOW))
      .toMatchObject({ ok: false, error: 'REQUEST_DONE_FROZEN' });
  });

  it('recalcule l’échéance quand la date de réception change', () => {
    const p = planManualUpdate(manual, { receivedDate: '2026-01-31' }, NOW);
    expect(p).toMatchObject({ ok: true, value: { dueDateRecomputed: true, changes: { receivedDate: '2026-01-31', dueDate: '2026-02-28' } } });
  });

  it('ne recalcule pas sans changement de donnée de calcul', () => {
    const p = planManualUpdate(manual, { internalComment: 'Pièce d’identité reçue', channel: 'phone' }, NOW);
    expect(p.ok && p.value.dueDateRecomputed).toBe(false);
    expect(p.ok && p.value.changes).toEqual({ internalComment: 'Pièce d’identité reçue', channel: 'phone' });
  });

  it('refuse une échéance fournie et un retour en arrière', () => {
    expect(planManualUpdate(manual, { dueAt: '2026-12-01' }, NOW)).toMatchObject({ ok: false, error: 'DUE_DATE_NOT_ACCEPTED' });
    expect(planManualUpdate({ ...manual, status: 'in_progress' }, { status: 'received' }, NOW))
      .toMatchObject({ ok: false, error: 'INVALID_TRANSITION' });
  });

  it('passage à « Traitée » signalé pour horodatage', () => {
    const p = planManualUpdate({ ...manual, status: 'in_progress' }, { status: 'done', result: 'Données transmises.' }, NOW);
    expect(p).toMatchObject({ ok: true, value: { becomesDone: true } });
  });

  it('aucune modification effective', () => {
    expect(planManualUpdate(manual, { channel: 'email', internalComment: '' }, NOW))
      .toMatchObject({ ok: false, error: 'NOTHING_TO_UPDATE' });
  });

  it('ne permet pas de retirer à la fois l’utilisateur et le compte', () => {
    expect(planManualUpdate(manual, { userId: null, accountId: null }, NOW)).toMatchObject({ ok: false, error: 'SUBJECT_REQUIRED' });
  });
});

describe('réouverture (GDP-015 à GDP-017)', () => {
  it('seule une demande manuelle traitée se rouvre, sans motif, vers « En cours »', () => {
    expect(planReopen({ origin: 'manual', status: 'done' })).toEqual({ ok: true, value: { status: 'in_progress' } });
    expect(planReopen({ origin: 'manual', status: 'in_progress' })).toMatchObject({ ok: false, error: 'NOT_DONE' });
  });
  it('le plan de réouverture ne porte aucune échéance (conservée, REC-GDP-04)', () => {
    const p = planReopen({ origin: 'manual', status: 'done' });
    expect(p.ok && Object.keys(p.value)).toEqual(['status']);
  });
});

describe('paramètres de liste (GDP-001, GDP-005, GDP-006)', () => {
  it('vue ouverte triée par échéance croissante par défaut', () => {
    const q = parseListQuery(new URLSearchParams(), NOW);
    expect(q).toMatchObject({ view: 'open', sort: 'due', dir: 'asc', page: 1, pageSize: 25, to: '2026-09-26', from: '2026-08-28' });
  });
  it('historique trié par date de traitement décroissante ; tri inconnu ignoré', () => {
    const q = parseListQuery(new URLSearchParams('view=history&sort=drop table&page=-3'), NOW);
    expect(q).toMatchObject({ view: 'history', sort: 'processed', dir: 'desc', page: 1 });
  });
  it('bornes de période remises dans l’ordre', () => {
    const q = parseListQuery(new URLSearchParams('from=2026-09-10&to=2026-09-01'), NOW);
    expect(q).toMatchObject({ from: '2026-09-01', to: '2026-09-10' });
  });
});
