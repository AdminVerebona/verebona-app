/**
 * COH-OPS-FACT-DATE-SYNC — date du MÊME FAIT reportée d'un affichage à l'autre
 * (carte Trello #831 § 1, écart E04 ; CDC « Opérations / Agenda V2.0 » § 11,
 * AC34 ; règles du report : `business-operations/graph/fact-date-sync.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE CONTRÔLE RÉPARE, ET POURQUOI IL EXISTE
 *
 * Un fait métier daté a DEUX affichages : l'opération et l'événement de
 * l'Agenda qui PORTE son fait (lien N↔N, `fact_key`). Quand l'utilisateur
 * corrige la date d'un côté, le report vers l'autre a lieu APRÈS la
 * validation de la première écriture, hors de sa transaction (la primitive de
 * l'Agenda réévalue ses rappels et ses cartes, et possède sa propre
 * transaction : une transaction commune transférerait ses effets d'après-
 * validation à l'appelant). Si ce report échoue — base indisponible, verrou,
 * redémarrage entre les deux écritures —, la première écriture reste, l'autre
 * affichage garde son ancienne date, et plus rien ne les rapproche : l'écart
 * devient durable. La carte #831 l'exige réparable, sans jamais rien écraser.
 *
 * CE CONTRÔLE RELIT L'ÉTAT, jamais le seul journal : pour chaque route
 * (opération + événement porteur), il compare la date de l'opération qui
 * correspond au fait porté (règle pure `syncedOperationDateField`, table C16)
 * à la date de l'événement.
 *
 *   · dates égales, ou aucun fait daté commun → CONSISTENT ;
 *   · dates différentes et l'autre affichage montre ENCORE la valeur d'avant
 *     du dernier changement journalisé (preuve que le report n'a pas eu lieu)
 *     → REPAIRABLE `FACT_DATE_SYNC_PENDING` : le report est REJOUÉ par le
 *     service qui fait autorité (`syncOperationDatesToAgenda` ou
 *     `syncAgendaDateToOperations`), avec ses propres gardes, sa provenance,
 *     sa version et son journal ; aucune écriture propre au contrôle ;
 *   · les DEUX côtés ont bougé → AMBIGUOUS `FACT_DATE_DIVERGENT` : rien n'est
 *     écrit (deux dates différentes voulues ne sont pas un même affichage) ;
 *     l'abstention déjà tracée par le report reste seule juge, et un écart
 *     déjà tracé n'est pas signalé une seconde fois ;
 *   · aucun changement journalisé n'explique l'écart (stock antérieur,
 *     journaux purgés) → FINDING `FACT_DATE_SYNC_UNEXPLAINED` : constat, aucune
 *     écriture — choisir une date sans preuve serait écraser celle de
 *     l'utilisateur.
 *
 * SOURCES DE PREUVE, toutes écrites DANS la transaction de l'écriture qu'elles
 * décrivent (donc jamais perdues par l'échec du report) :
 *   · côté opération : `business_operation_graph_history`, image avant / après
 *     de la commande de correction (`realizedDate`, `plannedDate`), et la trace
 *     `FACT_DATE_SYNC_FAILED` posée par le report quand il n'a pas pu aboutir ;
 *   · côté Agenda : `agenda_occurrence_events` (`USER_MODIFIED`,
 *     `USER_CONFIRMED`), avant / après de la date.
 *
 * INTERDITS : inventer une date, effacer une date, remplir un « Sans
 * échéance », trancher entre deux dates voulues, créer un événement ou un
 * rappel, synchroniser des faits différents (devis, début, fin, fin de
 * contrat), appeler l'IA, écrire ailleurs que par les deux services de report.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';
import {
  decideFactDateRepair, syncedOperationDateField, FACT_DATE_SYNC_DIVERGENT_REASON, FACT_DATE_SYNC_FAILED_REASON,
  type FactDateLastChange, type SyncedDateField,
} from '@/services/business-operations/graph/fact-date-sync';

const AGENDA_ITEM_UPDATED = 'AGENDA_ITEM_UPDATED';
const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';

const PENDING = 'FACT_DATE_SYNC_PENDING';
const DIVERGENT = 'FACT_DATE_DIVERGENT';
const UNEXPLAINED = 'FACT_DATE_SYNC_UNEXPLAINED';

/** Colonne de l'opération pour chaque date synchronisable. */
const COLONNE: Readonly<Record<SyncedDateField, string>> = { realizedDate: 'realized_date', plannedDate: 'planned_date' };

/** Événements de l'Agenda qui PORTENT le fait d'une opération active (objets du contrôle). */
const PORTEURS_SQL = `
  SELECT DISTINCT l.agenda_item_id AS id
    FROM business_operation_agenda_links l
    JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
    JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id
         AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
   WHERE l.account_id = $1 AND l.state = 'ACTIVE' AND l.fact_key IS NOT NULL`;

const texte = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nombre = (v: unknown): number => Number(v);

/** Routes (opération + fait porté) de ces événements, avec les deux dates en présence. */
async function routes(sql: Parameters<typeof rows>[0], accountId: number, ids: readonly number[]): Promise<Row[]> {
  return rows(sql, `
    SELECT l.agenda_item_id, l.operation_id, l.fact_key, o.type_code, o.status,
           o.realized_date::text AS realized_date, o.planned_date::text AS planned_date,
           i.start_date::text AS start_date, i.no_deadline
      FROM business_operation_agenda_links l
      JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
      JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id
           AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
     WHERE l.account_id = $1 AND l.agenda_item_id = ANY($2::int[]) AND l.state = 'ACTIVE' AND l.fact_key IS NOT NULL
     ORDER BY l.agenda_item_id, l.operation_id`, [accountId, intArray(ids)]);
}

/**
 * Dernier changement de la date de l'opération pour ce champ, tel qu'il a été
 * journalisé DANS la transaction de la commande (image avant / après), ou tel
 * que le report l'a consigné en échouant. Le plus récent des deux.
 */
async function changementOperation(
  sql: Parameters<typeof rows>[0], accountId: number, operationId: number, field: SyncedDateField,
): Promise<FactDateLastChange | null> {
  const r = await rows(sql, `
    SELECT avant, apres, at FROM (
      SELECT h.before_json->>$3 AS avant, h.after_json->>$3 AS apres, h.created_at AS at, h.id AS rang
        FROM business_operation_graph_history h
       WHERE h.account_id = $1 AND h.operation_id = $2 AND h.after_json->>$3 IS NOT NULL
      UNION ALL
      SELECT h.before_json->>'sourceBefore' AS avant, h.after_json->>'sourceAfter' AS apres, h.created_at AS at, h.id AS rang
        FROM business_operation_graph_history h
       WHERE h.account_id = $1 AND h.operation_id = $2 AND h.reason_code = $4
         AND h.after_json->>'field' = $3 AND h.after_json->>'direction' = 'OPERATION_TO_AGENDA'
    ) x
     ORDER BY at DESC, rang DESC LIMIT 1`, [accountId, operationId, field, FACT_DATE_SYNC_FAILED_REASON]);
  if (!r.length) return null;
  const at = r[0].at instanceof Date ? r[0].at.toISOString() : String(r[0].at ?? '');
  return { before: texte(r[0].avant), after: texte(r[0].apres), at };
}

/** Dernier changement de date de l'événement, tracé par l'Agenda dans la transaction de son écriture. */
async function changementAgenda(
  sql: Parameters<typeof rows>[0], accountId: number, agendaItemId: number,
): Promise<FactDateLastChange | null> {
  const r = await rows(sql, `
    SELECT e.detail_json->'before'->>'date' AS avant, e.detail_json->'after'->>'date' AS apres, e.created_at AS at
      FROM agenda_occurrence_events e
     WHERE e.account_id = $1 AND e.agenda_item_id = $2
       AND e.event_type IN ('USER_MODIFIED', 'USER_CONFIRMED')
       AND e.detail_json->'after'->>'date' IS NOT NULL
     ORDER BY e.created_at DESC, e.id DESC LIMIT 1`, [accountId, agendaItemId]);
  if (!r.length) return null;
  const at = r[0].at instanceof Date ? r[0].at.toISOString() : String(r[0].at ?? '');
  return { before: texte(r[0].avant), after: texte(r[0].apres), at };
}

/** Un écart déjà tracé comme abstention (deux dates voulues) n'est pas signalé une seconde fois. */
async function abstentionDejaTracee(
  sql: Parameters<typeof rows>[0], accountId: number, operationId: number, factKey: string, field: SyncedDateField,
  agendaDate: string | null, operationDate: string | null,
): Promise<boolean> {
  const empreintes = [
    `fact-date:${factKey}:${field}:${operationDate ?? ''}:${agendaDate ?? ''}`,
    `fact-date:${factKey}:${field}:${agendaDate ?? ''}:${operationDate ?? ''}`,
  ];
  const r = await rows(sql, `
    SELECT 1 FROM business_operation_graph_history
     WHERE account_id = $1 AND operation_id = $2 AND reason_code = $3 AND input_hash = ANY($4::text[]) LIMIT 1`,
  [accountId, operationId, FACT_DATE_SYNC_DIVERGENT_REASON, empreintes]);
  return r.length > 0;
}

export const operationsFactDateSyncCheck: CoherenceCheck = {
  id: 'COH-OPS-FACT-DATE-SYNC',
  version: 1,
  status: 'ACTIVE',
  title: 'Opérations / Agenda : la date du même fait est la même des deux côtés, ou son écart est voulu et tracé',
  domain: 'operations',
  level: 'N2',
  objectType: 'agenda_item',
  scope: 'Événements de l’Agenda qui PORTENT le fait d’une opération active (lien N↔N, `fact_key`)',
  sources: ['business_operation_agenda_links', 'business_operations', 'agenda_items', 'business_operation_graph_history', 'agenda_occurrence_events'],
  applicability: 'compte éligible (actif et modifiable) ; fait porté dont une date de l’opération correspond (table C16 : acquisition, sortie, sinistre, intervention réalisée ou envisagée)',
  invariant: 'deux affichages du même fait daté montrent la même date ; sinon l’écart est un choix de l’utilisateur, tracé comme abstention, et jamais une date n’est inventée, effacée ni arbitrée par le contrôle',
  anomalies: [PENDING, DIVERGENT, UNEXPLAINED],
  autoRepairWhen: 'le dernier changement journalisé d’un côté est encore absent de l’autre, qui montre toujours la valeur d’avant : le report est rejoué par le service qui fait autorité',
  forbiddenRepairs: [
    'inventer une date', 'effacer une date', 'donner une date à un événement « Sans échéance »',
    'trancher entre deux dates voulues par l’utilisateur', 'écraser la date la plus récente',
    'synchroniser des faits différents (devis, date de début, date de fin, fin de contrat)',
    'créer un événement d’agenda ou un rappel', 'appeler l’IA depuis le contrôle',
    'écrire hors des deux services de report (`syncOperationDatesToAgenda`, `syncAgendaDateToOperations`)',
  ],
  services: [
    'business-operations/graph/fact-date-sync#syncOperationDatesToAgenda',
    'business-operations/graph/fact-date-sync#syncAgendaDateToOperations',
  ],
  chain: ['PERSISTENCE', 'LINK', 'PROJECTION'],
  triggers: [AGENDA_ITEM_UPDATED, OPERATION_CHANGED],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque écriture d’un événement porteur ou de son opération',
  criticality: 'HIGH',
  tests: ['C831-U-01', 'C831-U-02', 'C831-U-03', 'C831-U-04'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `${PORTEURS_SQL} AND l.agenda_item_id > $2 ORDER BY id`, [accountId, afterId])).slice(0, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === AGENDA_ITEM_UPDATED) {
      return idsOf(await rows(ctx.sql, `${PORTEURS_SQL} AND l.agenda_item_id = $2 ORDER BY id`, [accountId, e.entityId]));
    }
    if (e.type === OPERATION_CHANGED) {
      return idsOf(await rows(ctx.sql, `${PORTEURS_SQL} AND l.operation_id = $2 ORDER BY id`, [accountId, e.entityId]));
    }
    return [];
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const lignes = await routes(ctx.sql, accountId, ids);
    /**
     * Un événement peut porter le fait de plusieurs opérations : le verdict
     * retenu est le plus actionnable de ses routes — une route réparable
     * d'abord (le report rejoué règle l'écart), puis une ambiguïté, puis un
     * constat, et « conforme » seulement si toutes ses routes le sont.
     */
    const RANG: Record<string, number> = { REPAIRABLE: 0, AMBIGUOUS: 1, FINDING: 2, GONE: 3, CONSISTENT: 4 };
    const retenir = (id: number, i: Inspection) => {
      const actuel = out.get(id);
      if (!actuel || RANG[i.verdict] < RANG[actuel.verdict]) out.set(id, i);
    };
    for (const x of lignes) {
      const agendaItemId = nombre(x.agenda_item_id);
      const operationId = nombre(x.operation_id);
      const factKey = String(x.fact_key);
      const field = syncedOperationDateField(texte(x.type_code), texte(x.status), factKey);
      if (!field) { retenir(agendaItemId, { verdict: 'CONSISTENT' }); continue; }
      const operationDate = texte(x[COLONNE[field]]);
      const agendaDate = texte(x.start_date);
      if (operationDate === agendaDate) { retenir(agendaItemId, { verdict: 'CONSISTENT' }); continue; }

      const [operationChange, agendaChange] = await Promise.all([
        changementOperation(ctx.sql, accountId, operationId, field),
        changementAgenda(ctx.sql, accountId, agendaItemId),
      ]);
      const d = decideFactDateRepair({ agendaDate, operationDate, operationChange, agendaChange });
      const commun = {
        faultyLink: 'PERSISTENCE' as const,
        observed: { operationDate, agendaDate },
        detail: { operationId, factKey, field, noDeadline: x.no_deadline === true },
      };
      if (d.kind === 'CONSISTENT') { retenir(agendaItemId, { verdict: 'CONSISTENT' }); continue; }
      if (d.kind === 'REPLAY') {
        retenir(agendaItemId, {
          verdict: 'REPAIRABLE', anomaly: PENDING, ...commun,
          expected: { operationDate: d.after, agendaDate: d.after },
          detail: {
            ...commun.detail, direction: d.direction, sourceBefore: d.before, sourceAfter: d.after,
            repairChain: d.direction === 'OPERATION_TO_AGENDA'
              ? 'report de la date de l’opération vers l’événement porteur (`syncOperationDatesToAgenda`), gardes et journal du service'
              : 'report de la date de l’événement vers l’opération (`syncAgendaDateToOperations`), gardes et journal du service',
          },
          inputHash: hashOf({ agendaItemId, operationId, field, d }),
        });
        continue;
      }
      if (d.kind === 'DIVERGENT') {
        if (await abstentionDejaTracee(ctx.sql, accountId, operationId, factKey, field, agendaDate, operationDate)) {
          // Écart voulu, déjà tracé une fois : absence d'exploitation justifiée.
          retenir(agendaItemId, { verdict: 'CONSISTENT', detail: { ...commun.detail, abstention: true } });
          continue;
        }
        retenir(agendaItemId, {
          verdict: 'AMBIGUOUS', anomaly: DIVERGENT, ...commun,
          detail: { ...commun.detail, operationChange, agendaChange, why: 'LES_DEUX_COTES_ONT_CHANGE' },
          inputHash: hashOf({ agendaItemId, operationId, field, operationDate, agendaDate }),
        });
        continue;
      }
      retenir(agendaItemId, {
        verdict: 'FINDING', anomaly: UNEXPLAINED, ...commun,
        detail: { ...commun.detail, why: 'AUCUN_CHANGEMENT_JOURNALISE_EXPLOITABLE' },
        inputHash: hashOf({ agendaItemId, operationId, field, operationDate, agendaDate }),
      });
    }
    for (const id of ids) if (!out.has(id)) out.set(id, { verdict: 'GONE' });
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { syncOperationDatesToAgenda, syncAgendaDateToOperations } = await import('@/services/business-operations/graph/fact-date-sync');
    for (const { id, inspection } of items) {
      const d = inspection.detail as { operationId?: unknown; field?: unknown; direction?: unknown; sourceBefore?: unknown; sourceAfter?: unknown } | undefined;
      const operationId = Number(d?.operationId);
      const field = String(d?.field) as SyncedDateField;
      const after = typeof d?.sourceAfter === 'string' ? d.sourceAfter : null;
      const before = typeof d?.sourceBefore === 'string' ? d.sourceBefore : null;
      if (!Number.isSafeInteger(operationId) || !after || !(field in COLONNE)) {
        throw new Error(`report de date : constat incomplet pour l’événement ${id}`);
      }
      // Les deux services portent les règles : même valeur avant exigée, aucune date inventée
      // ni effacée, provenance et version avancées, journal du graphe écrit. Le contrôle
      // n'écrit rien lui-même et ne choisit jamais la date.
      if (d?.direction === 'OPERATION_TO_AGENDA') {
        const avant = field === 'realizedDate' ? { realizedDate: before } : { plannedDate: before };
        const apres = field === 'realizedDate' ? { realizedDate: after } : { plannedDate: after };
        const lignes = await syncOperationDatesToAgenda({ accountId, operationId, before: avant, after: apres, actorUserId: null });
        const ligne = lignes.find((l) => l.agendaItemId === id) ?? lignes[0] ?? null;
        out.set(id, {
          called: true, service: 'syncOperationDatesToAgenda', aiCalls: 0,
          result: { operationId, field, after, outcome: ligne?.outcome ?? 'NO_CARRIER', lines: lignes.length },
          rollbackRef: `business_operation_graph_history:operation_id=${operationId}`,
        });
        continue;
      }
      const lignes = await syncAgendaDateToOperations({
        accountId, agendaItemId: id, previousDate: before, newDate: after, actorUserId: null,
      });
      const ligne = lignes.find((l) => l.operationId === operationId) ?? lignes[0] ?? null;
      out.set(id, {
        called: true, service: 'syncAgendaDateToOperations', aiCalls: 0,
        result: { operationId, field, after, outcome: ligne?.outcome ?? 'NO_CARRIER', lines: lignes.length },
        rollbackRef: `business_operation_graph_history:operation_id=${operationId}`,
      });
    }
    return out;
  },
};
