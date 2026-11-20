/**
 * Lot 116C (carte Trello #806 §5 ; AC34) — règles PURES de la synchronisation
 * de la date d'un même fait : identité du fait (fait porté ↔ date de
 * l'opération), décision d'un report, branchements. Aucune base.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideFactDateSync, isFullDate, syncedOperationDateField } from '../fact-date-sync';
import { decideProjection, type OperationSnapshot } from '../../agenda-projection/model';
import { factKeyOf } from '../../grouping/model';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('L116C-D-U01 — identité du fait : quelle date de l’opération est le même fait que l’événement porteur', () => {
  it('table C16 : événements globaux réalisés → réalisation ; intervention envisagée → date prévue', () => {
    for (const t of ['ACQUISITION', 'DISPOSAL', 'CLAIM', 'INTERVENTION']) expect(syncedOperationDateField(t, 'REALIZED', t), t).toBe('realizedDate');
    expect(syncedOperationDateField('INTERVENTION', 'ENVISAGED', 'INTERVENTION')).toBe('plannedDate');
  });
  it('jamais entre faits différents : fait non porté, fait d’un autre type, fin de contrat, financement, état sans date du fait', () => {
    expect(syncedOperationDateField('INTERVENTION', 'REALIZED', null)).toBeNull();
    expect(syncedOperationDateField('INTERVENTION', 'REALIZED', 'UNQUALIFIED')).toBeNull();
    expect(syncedOperationDateField('INTERVENTION', 'REALIZED', 'CLAIM')).toBeNull();
    expect(syncedOperationDateField('CONTRACT', 'REALIZED', 'CONTRACT:END')).toBeNull();
    expect(syncedOperationDateField('FINANCING', 'REALIZED', 'FINANCING')).toBeNull();
    expect(syncedOperationDateField('OTHER', 'REALIZED', 'OTHER')).toBeNull();
    expect(syncedOperationDateField(null, 'REALIZED', 'UNQUALIFIED')).toBeNull();
    expect(syncedOperationDateField('INTERVENTION', 'CANCELLED', 'INTERVENTION')).toBeNull();
    for (const t of ['ACQUISITION', 'DISPOSAL', 'CLAIM']) expect(syncedOperationDateField(t, 'ENVISAGED', t), t).toBeNull();
  });
  it('cohérente avec la projection existante : la date synchronisée est celle que T4 projette pour ce fait', () => {
    const base: OperationSnapshot = {
      id: 1, accountId: 1, typeCode: 'INTERVENTION', status: 'REALIZED', technicalLabel: 'Travaux', provider: null,
      plannedDate: '2026-01-10', realizedDate: '2026-01-20', endDate: null, active: true, assetIds: [5], equipmentIds: [], documentFileIds: [],
      contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: 'SALE',
    } as OperationSnapshot;
    const cas: Array<[Partial<OperationSnapshot>, string]> = [
      [{}, '2026-01-20'], [{ status: 'ENVISAGED' }, '2026-01-10'], [{ typeCode: 'CLAIM' }, '2026-01-20'], [{ typeCode: 'ACQUISITION' }, '2026-01-20'], [{ typeCode: 'DISPOSAL' }, '2026-01-20'],
    ];
    for (const [over, attendue] of cas) {
      const op = { ...base, ...over } as OperationSnapshot;
      const d = decideProjection(op, '2026-10-12');
      expect(d.kind).toBe('PROJECT');
      if (d.kind !== 'PROJECT') continue;
      const field = syncedOperationDateField(op.typeCode, op.status, factKeyOf(d.desired.key));
      expect(field).not.toBeNull();
      expect(d.desired.date).toBe(attendue);
      expect(field === 'realizedDate' ? op.realizedDate : op.plannedDate).toBe(attendue);
    }
  });
});

describe('L116C-D-U02 — décision d’un report', () => {
  const d = (sourceBefore: string | null, sourceAfter: string | null, target: string | null, targetMayBeEmpty = true) =>
    decideFactDateSync({ sourceBefore, sourceAfter, target, targetMayBeEmpty });
  it('même date avant → report ; déjà égale → rien (aucune boucle) ; divergente → rien n’est écrasé', () => {
    expect(d('2026-01-20', '2026-01-22', '2026-01-20')).toBe('SYNC');
    expect(d('2026-01-20', '2026-01-22', '2026-01-22')).toBe('ALREADY_EQUAL');
    expect(d('2026-01-20', '2026-01-22', '2026-01-18')).toBe('DIVERGENT');
  });
  it('aucune date inventée ni effacée : date retirée ou partielle → rien ; cible vide complétée seulement si cela est permis', () => {
    expect(d('2026-01-20', null, '2026-01-20')).toBe('NOTHING');
    expect(d('2026-01-20', '2026-01', '2026-01-20')).toBe('NOTHING');
    expect(d('2026-01-20', '2026-02-30', '2026-01-20')).toBe('NOTHING');
    expect(d(null, '2026-01-22', null, true)).toBe('SYNC');
    expect(d(null, '2026-01-22', null, false)).toBe('DIVERGENT');
    expect(isFullDate('2026-01-22')).toBe(true);
    expect(isFullDate('2026')).toBe(false);
  });
});

describe('L116C-D-U03 — branchements : une seule synchronisation, deux points d’entrée utilisateur, aucun traitement automatique', () => {
  it('Agenda → opération : seulement dans l’écriture UTILISATEUR de l’Agenda ; opération → Agenda : seulement après les corrections de la façade', () => {
    const agenda = lire('src/services/agenda/AgendaWriteService.ts');
    expect(agenda.match(/syncAgendaDateToOperations\(/g)).toHaveLength(1);
    expect(agenda).toMatch(/if \(input\.startDate !== undefined && full\.startDate !== existing\.startDate\)/);
    const facade = lire('src/services/business-operations/operation-write.facade.ts');
    expect(facade.match(/\.then\(\(result\) => syncFactDatesAfterCommit\(ctx, result, dates\)\);/g)).toHaveLength(2);
    expect(facade).toMatch(/result\.status !== 'APPLIED' \|\| !result\.changed \|\| result\.replayed/);
    // Ni T3, ni T4, ni la projection, ni le contrôle de cohérence n'appellent la synchronisation.
    for (const f of [
      'src/services/business-operations/consolidation/consolidator.ts', 'src/services/business-operations/agenda-projection/service.ts',
      'src/services/business-operations/agenda-projection/model.ts', 'src/services/agenda/write-agenda-item.ts', 'src/services/coherence/engine.ts',
    ]) expect(lire(f), f).not.toMatch(/fact-date-sync|syncAgendaDateToOperations|syncOperationDatesToAgenda/);
  });
  it('la synchronisation n’écrit l’Agenda que par sa primitive, ne crée aucun événement, ne touche que les deux dates du fait', () => {
    const src = lire('src/services/business-operations/graph/fact-date-sync.ts');
    expect(src).not.toMatch(/INSERT INTO agenda_items|UPDATE agenda_items|notification_outbox|start_date\s*=|end_date\s*=|effective_/);
    expect(src.match(/writeAgendaItem\(/g)).toHaveLength(1);
    expect(src).toMatch(/itemId: agendaItemId, values: \{ startDate: nouvelle/);
    expect(src).not.toMatch(/gateway|prompt/i);
  });
});
