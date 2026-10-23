/**
 * Écrivain de la DATE d'un élément d'agenda depuis la carte « À traiter »
 * existante DATA-AGENDA-DATE — lot 83A (CDC « Opérations, Agenda, Timeline,
 * Sinistres v5 » §11.8, AC20).
 *
 * Quand T3 trouve des dates de survenue contradictoires pour l'événement
 * principal d'une Opération, la projection laisse la date VIDE et la carte de
 * date devient un arbitrage entre ces dates (`produceAgendaActions`). Le choix
 * de l'utilisateur est appliqué ici, dans la transaction de résolution
 * (`resolveArbitration`, liste blanche §13.5) :
 *   · date écrite par la primitive (`writeAgendaItem`, canal MANUAL) ;
 *   · origine UTILISATEUR (`date_source = 'USER'`, élément automatique marqué
 *     modifié) : la projection ne la réécrira jamais (§10, P8) ;
 *   · « Sans échéance » non posée (une date existe) ;
 *   · trace d'occurrence (USER_MODIFIED, via « À traiter »).
 * Annulation : la date précédente — « aucune » — est restaurée (nullable).
 * Après validation : l'Opération liée est signalée à T3 (déclencheur Agenda
 * C4, comme une modification dans l'agenda).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { agendaItems, agendaOccurrenceEvents } from '@/db/schema';
import type { FieldWriter } from './resolve-action.service';

export const AGENDA_DATE_FIELD = 'date';
/** Trace d'occurrence (`agenda_occurrence_events`, même type que l'édition dans l'agenda) — pas une notification. */
const OCCURRENCE_USER_MODIFIED = 'USER_MODIFIED';

/** Date calendaire AAAA-MM-JJ valide. */
export function isAgendaDateValue(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

export const AGENDA_DATE_WRITER: FieldWriter = {
  targetType: 'AGENDA_ITEM',
  fieldKey: AGENDA_DATE_FIELD,
  nullable: true,
  validate: (v) => isAgendaDateValue(v),
  check: async (client, itemId, accountId) => {
    const [row] = await client.select({ id: agendaItems.id }).from(agendaItems)
      .where(and(eq(agendaItems.id, itemId), eq(agendaItems.accountId, accountId))).limit(1);
    return !!row;
  },
  read: async (client, itemId, accountId) => {
    const [row] = await client.select({ v: agendaItems.startDate }).from(agendaItems)
      .where(and(eq(agendaItems.id, itemId), eq(agendaItems.accountId, accountId))).limit(1);
    return row?.v ?? null;
  },
  write: async (client, itemId, accountId, value) => {
    const date = isAgendaDateValue(value) ? value : null;
    const [row] = await client.select({ auto: agendaItems.isAutomatic }).from(agendaItems)
      .where(and(eq(agendaItems.id, itemId), eq(agendaItems.accountId, accountId))).limit(1);
    const { writeAgendaItem } = await import('@/services/agenda/write-agenda-item');
    await writeAgendaItem({
      itemId,
      values: {
        startDate: date, dateSource: date ? 'USER' : null, noDeadline: false, updatedAt: new Date(),
        ...(row?.auto ? { isAutomaticModified: true } : {}),
      },
    }, { accountId, channel: 'MANUAL', validate: false, client: client as unknown as { transaction: typeof db.transaction } });
    await client.insert(agendaOccurrenceEvents).values({
      agendaItemId: itemId, accountId, eventType: OCCURRENCE_USER_MODIFIED,
      detailJson: { after: { date }, origin: 'USER', via: 'to_process' },
    });
  },
  afterCommit: async ({ accountId, targetId }) => {
    try {
      const [lie] = await db.select({ op: agendaItems.businessOperationId }).from(agendaItems)
        .where(and(eq(agendaItems.id, targetId), eq(agendaItems.accountId, accountId))).limit(1);
      if (lie?.op != null) {
        const { notifyAgendaChangedForOperations } = await import('@/services/business-operations/agenda-projection/queue');
        notifyAgendaChangedForOperations(accountId, { itemId: targetId, businessOperationId: Number(lie.op), userFieldsChanged: true });
      }
    } catch (e) {
      console.error(`[agenda] déclencheur Agenda de l'élément ${targetId} :`, (e as Error).message);
    }
  },
};
