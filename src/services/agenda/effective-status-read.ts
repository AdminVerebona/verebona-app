/**
 * Lot 112G — STATUT EFFECTIF COMMUN (lot 111R) lu par les lecteurs situés
 * HORS de l'Agenda et de la Timeline : rappels de la mascotte (T6), cartes
 * « À traiter » liées à l'Agenda, rappel d'échéance J-7 (push / e-mail),
 * accueil (« Prochaines échéances », prochaine date par bien).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN CALCUL PROPRE
 *
 * Le statut vient de `computeEffectiveStatus` (AgendaDomainService, lu tel
 * quel, jamais recopié) nourri de la preuve de réalisation VALIDE du lot 103D
 * (`completion-proof.ts`, même expression SQL que l'Agenda et la Timeline :
 * document du compte, non supprimé, toujours associé à l'événement —
 * revérifiée à chaque lecture). Un événement est CLOS pour les rappels et les
 * cartes quand ce statut est « réalisé » ou « annulé » ; sinon il est ouvert.
 * Conséquences voulues :
 *   · réalisé ET prouvé (preuve valide, date passée)  → ni rappel ni carte ;
 *   · document supprimé ou dissocié                    → la preuve tombe,
 *     l'événement redevient ouvert (« Statut à confirmer » / « Date échue ») ;
 *   · jamais « réalisé » sans preuve valide ni statut choisi à la main.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRÉ-FILTRE SQL (`settledByProofSql`) — PAS UN SECOND CALCUL
 *
 * Certaines lectures sont bornées (LIMIT) ou entièrement SQL (contrat de
 * publication des cartes « À traiter », lu par la page, la pastille, le
 * récapitulatif e-mail, la mascotte et l'assistant). Elles écartent en SQL
 * un SOUS-ENSEMBLE CERTAIN des événements que `computeEffectiveStatus`
 * déclare « réalisé » par preuve : preuve valide ET fin de l'événement
 * antérieure à la VEILLE de la date de référence. La marge d'un jour couvre
 * tout écart de fuseau (base, serveur, Europe/Paris) : ce filtre ne masque
 * JAMAIS un événement que le calcul commun dit ouvert (test de parité
 * L112G-U2). La veille et le jour même sont tranchés par
 * `computeEffectiveStatus` côté application quand la lecture le permet.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { computeEffectiveStatus, type EffectiveStatus } from './AgendaDomainService';
import { validCompletionProofSelect, validCompletionProofSql } from './completion-proof';
import { agendaCompletionColumnsReady, agendaFunctionalColumnsReady } from './agenda-columns';

export type { EffectiveStatus };

/** Données d'un élément utiles au statut effectif (formats de l'Agenda). */
export interface AgendaStatusRow {
  startDate: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
  manualStatus?: string | null;
  /** Preuve de réalisation VALIDE (`completion-proof.ts`). */
  completionProven?: boolean | null;
  eventNature?: string | null;
  businessType?: string | null;
  originFieldKey?: string | null;
}

/** Statut effectif commun d'une ligne (délègue à `computeEffectiveStatus`). Pure. */
export function effectiveStatusOf(row: AgendaStatusRow, now: Date = new Date()): EffectiveStatus {
  return computeEffectiveStatus({
    startDate: row.startDate ?? null,
    startTime: row.startTime ?? null,
    endDate: row.endDate ?? null,
    endTime: row.endTime ?? null,
    // Normalisé par `computeEffectiveStatus` (espaces, chaîne vide = aucun statut).
    manualStatus: (row.manualStatus ?? null) as 'realise' | 'annule' | null,
    completionProven: row.completionProven === true,
    eventNature: row.eventNature ?? null,
    businessType: row.businessType ?? null,
    originFieldKey: row.originFieldKey ?? null,
  }, now);
}

/** Statut qui clôt le sujet (réalisé, annulé) : aucun rappel, aucune carte. Pure. */
export function isSettledStatus(s: EffectiveStatus): boolean {
  return s === 'realise' || s === 'annule';
}

/** L'élément est-il clos selon le statut effectif commun ? Pure. */
export function isAgendaItemSettled(row: AgendaStatusRow, now: Date = new Date()): boolean {
  return isSettledStatus(effectiveStatusOf(row, now));
}

const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const txt = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/**
 * Colonnes SQL à ajouter à un SELECT sur `agenda_items` (alias `a`) pour
 * calculer le statut effectif (préfixe `es*`, sans collision). Colonnes 0223
 * ou 0945 absentes : NULL / false (la requête reste valide ; la preuve est
 * alors ignorée, comme dans l'Agenda).
 */
export async function effectiveStatusColumns(a = 'i'): Promise<string> {
  const [preuve, nature] = await Promise.all([validCompletionProofSelect(a), agendaFunctionalColumnsReady()]);
  return [
    `${a}.manual_status AS "esManualStatus"`,
    `to_char(${a}.start_date, 'YYYY-MM-DD') AS "esStartDate"`,
    `${a}.start_time::text AS "esStartTime"`,
    `to_char(${a}.end_date, 'YYYY-MM-DD') AS "esEndDate"`,
    `${a}.end_time::text AS "esEndTime"`,
    `${a}.origin_field_key AS "esOriginFieldKey"`,
    nature ? `${a}.event_nature AS "esEventNature"` : `NULL::text AS "esEventNature"`,
    nature ? `${a}.business_type AS "esBusinessType"` : `NULL::text AS "esBusinessType"`,
    `${preuve} AS "esCompletionProven"`,
  ].join(', ');
}

/** Ligne lue avec `effectiveStatusColumns` → données du statut. Pure. */
export function statusRowOfSelected(r: Record<string, unknown>): AgendaStatusRow {
  return {
    startDate: day(r.esStartDate),
    startTime: txt(r.esStartTime),
    endDate: day(r.esEndDate),
    endTime: txt(r.esEndTime),
    manualStatus: txt(r.esManualStatus),
    completionProven: r.esCompletionProven === true,
    eventNature: txt(r.esEventNature),
    businessType: txt(r.esBusinessType),
    originFieldKey: txt(r.esOriginFieldKey),
  };
}

/** Statut effectif d'une ligne lue avec `effectiveStatusColumns`. Pure. */
export function effectiveStatusOfSelected(r: Record<string, unknown>, now: Date = new Date()): EffectiveStatus {
  return effectiveStatusOf(statusRowOfSelected(r), now);
}

/**
 * Pré-filtre SQL : l'élément (alias `a`) est CERTAINEMENT « réalisé » par
 * preuve selon `computeEffectiveStatus` — preuve valide et fin (date de fin,
 * sinon de début) antérieure à la veille de `todayExpr` (expression SQL
 * d'une date : `CURRENT_DATE`, `$2::date`…). Exige les colonnes 0945.
 */
export function settledByProofSql(a = 'i', todayExpr = 'CURRENT_DATE'): string {
  return `(${validCompletionProofSql(a)} AND coalesce(${a}.end_date, ${a}.start_date) < ((${todayExpr})::date - 1))`;
}

/** Fragment ` AND NOT (…)` du pré-filtre, ou chaîne vide si les colonnes 0945 manquent. */
export async function notSettledByProofFilter(a = 'i', todayExpr = 'CURRENT_DATE'): Promise<string> {
  return (await agendaCompletionColumnsReady()) ? ` AND NOT ${settledByProofSql(a, todayExpr)}` : '';
}

type Unsafe = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/**
 * Statuts effectifs d'éléments DU COMPTE (identifiants absents : non rendus).
 * Une requête, lectures par clé.
 */
export async function loadEffectiveStatuses(
  accountId: number, ids: readonly number[], now: Date = new Date(), client?: Unsafe,
): Promise<Map<number, EffectiveStatus>> {
  const uniques = [...new Set(ids.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!uniques.length) return new Map();
  const sql = client ?? ((await import('@/db')).pgClient as unknown as Unsafe);
  const r = (await sql.unsafe(
    `SELECT i.id, ${await effectiveStatusColumns('i')} FROM agenda_items i WHERE i.account_id = $1 AND i.id = ANY($2::int[])`,
    [accountId, uniques] as never[],
  )) as Array<Record<string, unknown>>;
  return new Map(r.map((x) => [Number(x.id), effectiveStatusOfSelected(x, now)]));
}

/** Statut effectif d'un élément du compte, ou null s'il n'existe pas (dans ce compte). */
export async function loadEffectiveStatus(accountId: number, id: number, now: Date = new Date(), client?: Unsafe): Promise<EffectiveStatus | null> {
  return (await loadEffectiveStatuses(accountId, [id], now, client)).get(id) ?? null;
}
