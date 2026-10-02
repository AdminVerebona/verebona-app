/**
 * Parité de la refonte (CDC 15 T4-09, lot 14) : les deux chemins écrivent les
 * mêmes valeurs de base qu'avant la primitive (objets littéraux recopiés du
 * code du tag lot13b). Règles D-13 et D-14. Lot 16b-2 : AI_T4_EFFECTS retiré,
 * la primitive est le seul chemin d'écriture de T4.
 */
import { describe, it, expect, vi } from 'vitest';

const colonnes = vi.hoisted(() => ({ pretes: true }));
vi.mock('../agenda-columns', () => ({
  agendaFunctionalColumnsReady: async () => colonnes.pretes,
  agendaSourcesColumnsReady: async () => colonnes.pretes,
}));

import { manualInsertValues } from '../AgendaWriteService';
import { t4UpsertInput } from '../agenda-persistence';
import { agendaItemValues } from '../agenda-write-primitive';
import { purchaseSyncAllowed } from '../write-agenda-item';
import { isUpcomingDeadlineCandidate, upcomingDeadlinesSqlFilter } from '../AgendaQueryService';

describe('parité des valeurs écrites', () => {
  it('agenda manuel : mêmes colonnes qu’avant (createAgendaItem)', () => {
    expect(manualInsertValues({ title: 'Achat vélo', startDate: '2026-01-02', assetIds: [1] }, 7, 'information')).toEqual({
      createdByUserId: 7, title: 'Achat vélo', description: null, startDate: '2026-01-02', startTime: null, endDate: null,
      endTime: null, manualStatus: null, isAutomatic: false, isAutomaticModified: false, requiresQualification: false,
      originType: 'manual', originRefType: null, originRefId: null, originFieldKey: null, homeCategory: 'information',
    });
  });

  it('T4 : mêmes colonnes qu’avant (createItem)', () => {
    const decision = {
      action: 'create', title: 'Contrôle technique', date: '2026-11-15', category: 'action', confidence: 'certain',
      reasonCode: 'X', deterministic: true, sourceFileId: 9, originFieldKey: 'nextInspection',
    } as never;
    expect(agendaItemValues(t4UpsertInput(decision, 0, null, true, null))).toEqual({
      title: 'Contrôle technique', startDate: '2026-11-15', homeCategory: 'action', isAutomatic: true, isAutomaticModified: false,
      requiresQualification: true, originType: 'asset_field', originFieldKey: 'nextInspection', originRefType: 'asset_file',
      originRefId: 9, occurrenceNature: 'CONFIRMED', dateSource: 'EXPLICIT_DATE', seriesKey: null, recurrenceJson: null,
    });
  });
});

describe('D-13 — recopie « achat »', () => {
  const achat = { title: 'Achat draisienne', startDate: '2026-01-02', isAutomatic: false, manualStatus: null };
  it('événement manuel réalisé (statut, ou date passée) : oui', () => {
    expect(purchaseSyncAllowed(achat, null, '2026-02-01')).toBe(true);
    expect(purchaseSyncAllowed({ ...achat, startDate: '2026-05-01', manualStatus: 'realise' }, null, '2026-02-01')).toBe(true);
    expect(purchaseSyncAllowed({ ...achat, title: 'Draisienne' }, 'purchase', '2026-02-01')).toBe(true);
  });
  it('automatique, futur non réalisé, annulé, autre type : non', () => {
    expect(purchaseSyncAllowed({ ...achat, isAutomatic: true }, 'purchase', '2026-02-01')).toBe(false);
    expect(purchaseSyncAllowed({ ...achat, startDate: '2026-05-01' }, null, '2026-02-01')).toBe(false);
    expect(purchaseSyncAllowed({ ...achat, manualStatus: 'annule' }, null, '2026-02-01')).toBe(false);
    expect(purchaseSyncAllowed({ ...achat, title: 'Révision' }, 'maintenance', '2026-02-01')).toBe(false);
  });
});

describe('D-14 — prochaines échéances', () => {
  it('un élément HISTORICAL n’est jamais une échéance ; sans nature : échéance', () => {
    expect(isUpcomingDeadlineCandidate({ eventNature: 'HISTORICAL' })).toBe(false);
    expect(isUpcomingDeadlineCandidate({ eventNature: 'DEADLINE' })).toBe(true);
    expect(isUpcomingDeadlineCandidate({})).toBe(true);
    expect(isUpcomingDeadlineCandidate({ manualStatus: 'realise' })).toBe(false);
  });
  it('fragment SQL : HISTORICAL exclu dès que la 0223 est appliquée ; vide sinon', async () => {
    colonnes.pretes = true;
    expect(await upcomingDeadlinesSqlFilter('i')).toBe(" AND (i.event_nature IS DISTINCT FROM 'HISTORICAL')");
    colonnes.pretes = false;
    expect(await upcomingDeadlinesSqlFilter('i')).toBe('');
    colonnes.pretes = true;
  });
});
