/**
 * Lot 46 — O7 : T4 / Agenda, projection des Opérations — règles pures et
 * déclenchement (CDC Opérations V1 ch. 17.1, P14, B16, C16, C16.1, C16.2,
 * C4, C22, F-138 à F-147).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  agendaChangeTriggersT3, decideProjection, matchExistingItem, parseProjectionFunctionalKey, planOperationProjection,
  presentableLabel, projectionFunctionalKey, projectionKeyOf,
  type AgendaItemSnapshot, type DesiredProjection, type OperationSnapshot,
} from '../model';

const AUJ = '2026-10-12';

function op(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: 10, accountId: 1, typeCode: 'INTERVENTION', status: 'REALIZED', technicalLabel: 'Remplacement chaudière', provider: 'Chauffage Martin',
    plannedDate: null, realizedDate: '2026-03-10', endDate: null, active: true, assetIds: [5], equipmentIds: [], documentFileIds: [77],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: 'SALE', ...over,
  };
}
function item(over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot {
  return {
    id: 100, title: 'Événement', date: '2026-03-10', manualStatus: null, isAutomatic: false, isAutomaticModified: false, projected: false,
    businessOperationId: null, linkedOperationActive: false, nature: null, businessType: null, homeCategory: null, functionalKey: null,
    originRefType: null, originRefId: null, assetIds: [5], equipmentIds: [], fileIds: [], ...over,
  };
}
const desired = (o: OperationSnapshot): DesiredProjection => {
  const d = decideProjection(o, AUJ);
  if (d.kind !== 'PROJECT') throw new Error(`pas de projection : ${d.reason}`);
  return d.desired;
};
const plan = (o: OperationSnapshot, p: { linked?: AgendaItemSnapshot[]; candidates?: AgendaItemSnapshot[]; suppressed?: string[]; cards?: number[] } = {}) =>
  planOperationProjection({
    op: o, decision: decideProjection(o, AUJ), linked: p.linked ?? [], suppressedKeys: new Set(p.suppressed ?? []),
    candidates: p.candidates ?? [], statusCardItems: new Set(p.cards ?? []),
  });

describe('O7-01 — tableau C16 : projection par type (decideProjection)', () => {
  it('F-138 / C16-01 — INTERVENTION ENVISAGED datée → événement planifié (DEADLINE, à venir, action)', () => {
    expect(desired(op({ status: 'ENVISAGED', plannedDate: '2026-11-20', realizedDate: null }))).toMatchObject({
      key: 'INTERVENTION', nature: 'DEADLINE', date: '2026-11-20', target: 'OPEN', creatable: true, category: 'action', title: 'Remplacement chaudière',
    });
  });
  it('C16-01b — INTERVENTION ENVISAGED sans date : aucune projection, liens conservés', () => {
    expect(decideProjection(op({ status: 'ENVISAGED', plannedDate: null, realizedDate: null }), AUJ)).toEqual({ kind: 'NONE', reason: 'NO_DATE', keepLinks: true });
  });
  it('F-139 / C16-02 — INTERVENTION REALIZED datée → historique (HISTORICAL, information)', () => {
    expect(desired(op())).toMatchObject({ key: 'INTERVENTION', nature: 'HISTORICAL', date: '2026-03-10', target: 'REALIZED', creatable: true, category: 'information' });
  });
  it('F-140 / C16-03 — INTERVENTION REALIZED sans date : aucune date inventée (rien n\'est créé)', () => {
    const d = desired(op({ realizedDate: null, plannedDate: '2026-02-01' }));
    expect(d).toMatchObject({ date: null, creatable: false, target: 'REALIZED' });
    expect(plan(op({ realizedDate: null }))).toEqual([{ kind: 'ABSTAIN', reason: 'NO_DATE' }]);
  });
  it('F-141 / C16-04 — CLAIM REALIZED daté → historique « sinistre »', () => {
    expect(desired(op({ typeCode: 'CLAIM', technicalLabel: 'Dégât des eaux · 12/03/2026', realizedDate: '2026-03-12' })))
      .toMatchObject({ key: 'CLAIM', nature: 'HISTORICAL', businessType: 'claim', date: '2026-03-12', title: 'Dégât des eaux · 12/03/2026' });
  });
  it('C16-04b — CLAIM ancré sur un événement de l\'historique (lot 44) : équivalent existant, rien n\'est créé', () => {
    expect(decideProjection(op({ typeCode: 'CLAIM', claimHistoryEventId: 9 }), AUJ)).toEqual({ kind: 'NONE', reason: 'EQUIVALENT_EXISTS', keepLinks: true });
  });
  it('F-142 / C16-05 — ACQUISITION datée → historique d\'entrée en possession « Achat »', () => {
    expect(desired(op({ typeCode: 'ACQUISITION', realizedDate: '2021-03-01' }))).toMatchObject({ key: 'ACQUISITION', nature: 'HISTORICAL', businessType: 'purchase', title: 'Achat' });
  });
  it('F-143 / C16-06 — DISPOSAL datée → historique de sortie (vente, ou transmission)', () => {
    expect(desired(op({ typeCode: 'DISPOSAL', realizedDate: '2026-05-02' }))).toMatchObject({ key: 'DISPOSAL', businessType: 'sale', title: 'Vente', nature: 'HISTORICAL' });
    expect(desired(op({ typeCode: 'DISPOSAL', realizedDate: '2026-05-02', disposalKind: 'TRANSMISSION' })).title).toBe('Transmission');
  });
  it('F-144 / C16-07 — CONTRACT : seulement l\'échéance explicite actionnable ; sans échéance, pas de copie', () => {
    expect(decideProjection(op({ typeCode: 'CONTRACT', status: 'REALIZED' }), AUJ)).toMatchObject({ kind: 'NONE', reason: 'NO_DATE' });
    expect(desired(op({ typeCode: 'CONTRACT', contractEffectiveTo: '2027-03-01' })))
      .toMatchObject({ key: 'CONTRACT:END:2027-03-01', nature: 'DEADLINE', businessType: 'contract', creatable: true, title: 'Fin de contrat — Chauffage Martin' });
    // Échéance passée : jamais créée (une projection déjà posée reste).
    expect(desired(op({ typeCode: 'CONTRACT', contractEffectiveTo: '2025-01-01' })).creatable).toBe(false);
  });
  it('C16-08 — FINANCING, OTHER, type nul : aucune projection, liens retirés', () => {
    for (const typeCode of ['FINANCING', 'OTHER', null] as const) {
      expect(decideProjection(op({ typeCode }), AUJ)).toEqual({ kind: 'NONE', reason: 'TYPE_NOT_PROJECTED', keepLinks: false });
    }
  });
  it('C16-09 — Opération invalidée / fusionnée, sans bien, annulée, non réalisée', () => {
    expect(decideProjection(op({ active: false }), AUJ)).toEqual({ kind: 'NONE', reason: 'INACTIVE', keepLinks: false });
    expect(decideProjection(op({ assetIds: [] }), AUJ)).toMatchObject({ kind: 'NONE', reason: 'NO_ASSET' });
    expect(decideProjection(op({ status: 'CANCELLED' }), AUJ)).toMatchObject({ kind: 'NONE', reason: 'CANCELLED' });
    expect(decideProjection(op({ typeCode: 'ACQUISITION', status: 'ENVISAGED' }), AUJ)).toMatchObject({ kind: 'NONE', reason: 'STATUS_NOT_PROJECTED' });
  });
  it('O7-02 — jamais le mot « Opération » dans un libellé produit (P09)', () => {
    expect(presentableLabel('Opération de maintenance')).toBeNull();
    expect(desired(op({ technicalLabel: 'Opération d\'entretien', provider: null })).title).toBe('Intervention');
    expect(presentableLabel('x'.repeat(81))).toBeNull();
  });
  it('O7-03 — clés : une Opération = un emplacement ; échéance de contrat dans la clé', () => {
    expect(projectionKeyOf({ typeCode: 'INTERVENTION', contractEffectiveTo: null, endDate: null })).toBe('INTERVENTION');
    expect(projectionKeyOf({ typeCode: 'FINANCING', contractEffectiveTo: null, endDate: null })).toBeNull();
    const fk = projectionFunctionalKey(42, 'CONTRACT:END:2027-03-01');
    expect(parseProjectionFunctionalKey(fk)).toEqual({ operationId: 42, key: 'CONTRACT:END:2027-03-01' });
    expect(parseProjectionFunctionalKey('ab12cd')).toBeNull();
  });
});

describe('O7-10 — rapprochement avant projection (C16.1, F-147)', () => {
  it('F-147 / C16-10 — événement saisi à la main avant l\'Opération : LIÉ, aucun doublon', () => {
    const manuel = item({ id: 3, title: 'Achat de la voiture', date: '2021-03-01' });
    const acq = op({ typeCode: 'ACQUISITION', realizedDate: '2021-03-01', documentFileIds: [] });
    expect(plan(acq, { candidates: [manuel] })).toEqual([{ kind: 'LINK', itemId: 3, reason: expect.stringContaining('même bien') }]);
    // Intervention : l'événement saisi est lié, sa réalisation proposée (jamais écrite).
    const rdv = item({ id: 4, title: 'Remplacement de la chaudière', date: '2026-03-11' });
    expect(plan(op(), { candidates: [rdv] })).toEqual([{ kind: 'LINK', itemId: 4, reason: expect.any(String) }, { kind: 'PROPOSE_DONE', itemId: 4 }]);
  });
  it('C16-11 — événement T4 du même document (constat de sinistre) : lié', () => {
    const t4 = item({ id: 4, title: 'Sinistre', isAutomatic: true, businessType: 'claim', nature: 'HISTORICAL', originRefType: 'asset_file', originRefId: 77 });
    const o = op({ typeCode: 'CLAIM', realizedDate: '2026-03-10' });
    expect(matchExistingItem(o, desired(o), [t4])).toMatchObject({ kind: 'certain', item: { id: 4 } });
  });
  it('C16-12 — type métier contradictoire : jamais lié (un contrôle technique n\'est pas un achat)', () => {
    const ct = item({ id: 5, title: 'Contrôle technique', businessType: 'inspection', isAutomatic: true });
    const o = op({ typeCode: 'ACQUISITION', realizedDate: '2026-03-10' });
    expect(matchExistingItem(o, desired(o), [ct])).toEqual({ kind: 'none' });
  });
  it('C16-13 — rapprochement seulement probable : la projection s\'abstient (ni lien, ni doublon)', () => {
    // Même document, mais à 10 jours : rapprochement probable seulement.
    const memeDoc = item({ id: 6, title: 'Note', date: '2026-03-20', fileIds: [77], assetIds: [] });
    expect(plan(op(), { candidates: [memeDoc] })).toEqual([{ kind: 'ABSTAIN', reason: expect.stringContaining('PROBABLE_EQUIVALENT'), itemId: 6 }]);
    // Deux événements aussi plausibles : aucun choix arbitraire.
    const deux = plan(op(), { candidates: [item({ id: 7, title: 'Entretien', date: '2026-03-10' }), item({ id: 8, title: 'Réparation', date: '2026-03-10' })] });
    expect(deux).toEqual([expect.objectContaining({ kind: 'ABSTAIN', reason: expect.stringContaining('PROBABLE_EQUIVALENT') })]);
  });
  it('C16-14 — élément lié à une AUTRE Opération active, ou projection d\'une autre : jamais pris', () => {
    const autre = item({ id: 9, title: 'Entretien', businessOperationId: 99, linkedOperationActive: true });
    const proj = item({ id: 10, title: 'Entretien', projected: true, isAutomatic: true });
    expect(plan(op(), { candidates: [autre, proj] })).toEqual([{ kind: 'CREATE', desired: desired(op()), functionalKey: 'bo:v1:10:INTERVENTION' }]);
  });
  it('C16-15 — planifié puis réalisé à quelques jours : l\'événement planifié de l\'utilisateur est lié et sa réalisation proposée', () => {
    const planifie = item({ id: 11, title: 'RDV chaudière', date: '2026-03-05', businessType: 'maintenance', nature: 'DEADLINE' });
    expect(plan(op(), { candidates: [planifie] })).toEqual([
      { kind: 'LINK', itemId: 11, reason: expect.any(String) },
      { kind: 'PROPOSE_DONE', itemId: 11 },
    ]);
  });
});

describe('O7-20 — plan : création, mise à jour, statut, idempotence', () => {
  it('F-139 / O7-20 — aucun événement équivalent : CRÉATION avec la clé de projection', () => {
    expect(plan(op())).toEqual([{ kind: 'CREATE', desired: desired(op()), functionalKey: 'bo:v1:10:INTERVENTION' }]);
  });
  it('O7-21 — ENVISAGED → REALIZED : l\'occurrence projetée intacte DEVIENT l\'historique (date, nature)', () => {
    const projete = item({
      id: 20, projected: true, isAutomatic: true, businessOperationId: 10, linkedOperationActive: true, title: 'Remplacement chaudière', date: '2026-02-01',
      nature: 'DEADLINE', businessType: 'maintenance', homeCategory: 'action', functionalKey: 'bo:v1:10:INTERVENTION', fileIds: [77],
    });
    expect(plan(op(), { linked: [projete] })).toEqual([{ kind: 'SYNC', itemId: 20, changes: { date: '2026-03-10', nature: 'HISTORICAL', homeCategory: 'information' } }]);
  });
  it('O7-22 — réalisé sans date : l\'occurrence projetée garde sa date et est marquée réalisée (F-140)', () => {
    const projete = item({ id: 21, projected: true, isAutomatic: true, businessOperationId: 10, title: 'Remplacement chaudière', date: '2026-02-01', nature: 'DEADLINE', businessType: 'maintenance', homeCategory: 'action', functionalKey: 'bo:v1:10:INTERVENTION', fileIds: [77] });
    expect(plan(op({ realizedDate: null }), { linked: [projete] })).toEqual([{ kind: 'SYNC', itemId: 21, changes: { manualStatus: 'realise' } }]);
  });
  it('O7-23 — élément T4 lié et intact : marqué réalisé ; élément saisi : réalisation PROPOSÉE une seule fois ; jamais réécrit', () => {
    const t4 = item({ id: 22, isAutomatic: true, businessOperationId: 10, nature: 'DEADLINE', title: 'Entretien chaudière' });
    expect(plan(op(), { linked: [t4] })).toEqual([{ kind: 'MARK_DONE', itemId: 22 }]);
    const manuel = item({ id: 23, businessOperationId: 10, title: 'Mon RDV' });
    expect(plan(op(), { linked: [manuel] })).toEqual([{ kind: 'PROPOSE_DONE', itemId: 23 }]);
    expect(plan(op(), { linked: [manuel], cards: [23] })).toEqual([]);
    expect(plan(op(), { linked: [{ ...manuel, manualStatus: 'realise' }] })).toEqual([]);
  });
  it('O7-24 — projection modifiée par l\'utilisateur : jamais réécrite (titre, date)', () => {
    const touche = item({ id: 24, projected: true, isAutomatic: true, isAutomaticModified: true, businessOperationId: 10, title: 'Mon titre', date: '2026-01-01', nature: 'HISTORICAL' });
    expect(plan(op(), { linked: [touche] })).toEqual([]);
  });
  it('O7-25 — idempotence : un agenda à jour donne un plan VIDE (no-op)', () => {
    const d = desired(op());
    const ajour = item({
      id: 25, projected: true, isAutomatic: true, businessOperationId: 10, title: d.title, date: d.date, nature: d.nature, businessType: d.businessType,
      homeCategory: d.category, functionalKey: 'bo:v1:10:INTERVENTION', assetIds: [5], fileIds: [77],
    });
    expect(plan(op(), { linked: [ajour] })).toEqual([]);
  });
  it('O7-26 — fusion / lien posé à côté d\'une projection : un seul événement (C22 « unifier »)', () => {
    const user = item({ id: 26, businessOperationId: 10, title: 'Sinistre cuisine', nature: 'HISTORICAL' });
    const proj = item({ id: 27, projected: true, isAutomatic: true, businessOperationId: 10, functionalKey: 'bo:v1:3:CLAIM' });
    expect(plan(op({ typeCode: 'CLAIM' }), { linked: [proj, user] })).toEqual([{ kind: 'REMOVE', itemId: 27, reason: 'DUPLICATE_PROJECTION' }]);
  });
  it('C22 — Opération invalidée : projection intacte retirée, touchée ou saisie détachée', () => {
    const proj = item({ id: 30, projected: true, isAutomatic: true, businessOperationId: 10 });
    const touche = item({ id: 31, projected: true, isAutomatic: true, isAutomaticModified: true, businessOperationId: 10 });
    const manuel = item({ id: 32, businessOperationId: 10 });
    expect(plan(op({ active: false }), { linked: [proj, touche, manuel] })).toEqual([
      { kind: 'REMOVE', itemId: 30, reason: 'INACTIVE' }, { kind: 'DETACH', itemId: 31, reason: 'INACTIVE' }, { kind: 'DETACH', itemId: 32, reason: 'INACTIVE' },
    ]);
    // Date retirée (F-140) : la projection intacte part, le lien utilisateur reste.
    expect(plan(op({ typeCode: 'CLAIM', realizedDate: null }), { linked: [proj, manuel] })).toEqual([{ kind: 'REMOVE', itemId: 30, reason: 'NO_DATE' }]);
  });
});

describe('O7-30 — suppression utilisateur mémorisée (C16.1, F-146)', () => {
  it('F-146 / O7-30 — clé supprimée : ni recréation, ni rapprochement', () => {
    const manuel = item({ id: 3, title: 'Entretien', date: '2026-03-10' });
    expect(plan(op(), { suppressed: ['INTERVENTION'], candidates: [manuel] })).toEqual([{ kind: 'SUPPRESSED', key: 'INTERVENTION' }]);
  });
  it('O7-31 — changement significatif (nouvelle échéance de contrat = nouvelle clé) : la projection reprend', () => {
    const c = op({ typeCode: 'CONTRACT', contractEffectiveTo: '2027-03-01' });
    expect(plan(c, { suppressed: ['CONTRACT:END:2026-03-01'] })[0]).toMatchObject({ kind: 'CREATE', functionalKey: 'bo:v1:10:CONTRACT:END:2027-03-01' });
    expect(plan(c, { suppressed: ['CONTRACT:END:2027-03-01'] })).toEqual([{ kind: 'SUPPRESSED', key: 'CONTRACT:END:2027-03-01' }]);
  });
});

describe('O7-40 — anti-boucle (C16.2, C4, F-145)', () => {
  it('F-145 / O7-40 — une écriture de projection ne déclenche jamais T3 ; un geste utilisateur sur un élément lié, oui', () => {
    expect(agendaChangeTriggersT3({ businessOperationId: 10, fromProjection: true, userFieldsChanged: false })).toBe(false);
    expect(agendaChangeTriggersT3({ businessOperationId: 10, fromProjection: true, userFieldsChanged: true })).toBe(false);
    expect(agendaChangeTriggersT3({ businessOperationId: 10, fromProjection: false, userFieldsChanged: false })).toBe(false);
    expect(agendaChangeTriggersT3({ businessOperationId: null, fromProjection: false, userFieldsChanged: true })).toBe(false);
    expect(agendaChangeTriggersT3({ businessOperationId: 10, fromProjection: false, userFieldsChanged: true })).toBe(true);
  });

  it('O7-41 — déclencheur C4 agenda_changed : connu de T3, catalogue existant (asset_updated)', async () => {
    const q = await import('../../consolidation/queue');
    expect(q.C4_TRIGGERS).toContain('agenda_changed');
    expect(q.C4_CATALOG_TRIGGER.agenda_changed).toBe('asset_updated');
  });
});

describe('O7-50 — déclenchement : bus Opérations → travail dédoublonné par compte', () => {
  it('O7-50 — un événement après commit met en file la projection du compte (append_events, délai de regroupement)', async () => {
    const { onBusinessOperationEventForAgenda, AGENDA_PROJECTION_KIND, T3_TARGET_AGENDA_PROJECTION } = await import('../queue');
    const enqueue = vi.fn(async () => ({ decision: 'enqueue' as const, jobId: 1 }));
    await onBusinessOperationEventForAgenda({
      type: 'BUSINESS_OPERATION_MERGED', accountId: 4, operationId: 7, canonicalOperationId: 8, correlationId: 'c-1', occurredAt: AUJ,
    }, { enqueue: enqueue as never });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]).toEqual([expect.objectContaining({
      treatment: 'T3', scope: { accountId: 4, targetType: T3_TARGET_AGENDA_PROJECTION, targetId: '4' },
      payloadOnDedupe: 'append_events', delaySeconds: 30,
      payload: expect.objectContaining({ kind: AGENDA_PROJECTION_KIND, events: [expect.objectContaining({ operationIds: [7, 8], correlationId: 'c-1' })] }),
    })]);
  });
  it('O7-51 — transfert de bien : le compte quitté est aussi repassé (projections orphelines)', async () => {
    const { onBusinessOperationEventForAgenda } = await import('../queue');
    const enqueue = vi.fn(async () => ({ decision: 'enqueue' as const, jobId: 1 }));
    await onBusinessOperationEventForAgenda({
      type: 'BUSINESS_OPERATION_TARGET_CHANGED', accountId: 4, previousAccountId: 3, operationId: 7, correlationId: 'c-2', occurredAt: AUJ,
    }, { enqueue: enqueue as never });
    expect(enqueue.mock.calls.map((c) => (c as unknown as [{ scope: { accountId: number }; payload: { events: unknown[] } }])[0])).toEqual([
      expect.objectContaining({ scope: expect.objectContaining({ accountId: 4 }) }),
      expect.objectContaining({ scope: expect.objectContaining({ accountId: 3 }), payload: expect.objectContaining({ events: [expect.objectContaining({ all: true })] }) }),
    ]);
  });
  it('O7-52 — un échec de mise en file ne lève jamais (l\'Opération est déjà validée, NFR-OP-006)', async () => {
    const { onBusinessOperationEventForAgenda } = await import('../queue');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(onBusinessOperationEventForAgenda({
      type: 'BUSINESS_OPERATION_CREATED', accountId: 4, operationId: 7, correlationId: 'c', occurredAt: AUJ,
    }, { enqueue: (async () => { throw new Error('file indisponible'); }) as never })).resolves.toBeUndefined();
    err.mockRestore();
  });
});
