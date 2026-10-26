/**
 * Fait HISTORIQUE de l'agenda et « en retard » — règle UNIQUE (lot 47B,
 * point 2 ; décision PO du 12/10 ; CDC 15 D-14).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN FAIT PASSÉ N'EST JAMAIS « EN RETARD »
 *
 * Un élément de nature HISTORICAL (achat, sinistre, cession, intervention,
 * historique lu par T4 dans un document) n'est jamais « en retard ».
 *
 * Lot 53 (retour PO D17, cohérence D4 / D15 / D17) : UNE DATE PASSÉE NE
 * PROUVE PAS LA RÉALISATION. Daté dans le passé et sans statut, un fait
 * historique n'est plus affiché « réalisé » ni masqué du suivi : il est
 * « statut à confirmer » (`a_confirmer`) — partout (vues agenda desktop et
 * mobile, fiche du bien, suivi, équipement, document, assistant). Seul un
 * statut ÉTABLI le rend « réalisé » : `manual_status = 'realise'`, posé par
 * l'utilisateur ou par la consolidation sur preuve de réalisation
 * (COMPLETION_PROVEN). Rien n'est écrit en base (calcul de lecture). Une
 * ÉCHÉANCE passée non faite reste « date échue » (`en_retard`), comme avant.
 *
 * Nature d'un élément (même précédence que `resolveEventSemantics`) :
 *   1. colonne `event_nature` (0223) quand elle est renseignée ;
 *   2. sinon effet agenda du champ d'origine du registre (`origin_field_key`) ;
 *   3. sinon type métier du catalogue qui n'admet qu'une nature (achat,
 *      réparation, sinistre, vente → HISTORICAL).
 * `HISTORICAL_SQL` en est le jumeau SQL (mêmes règles, testées en parité).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { CANONICAL_FIELDS, EVENT_CATALOG } from '@/services/canonical/registry';
import { resolveEventSemantics } from './agenda-functional-key';

/** Indices de nature d'un élément d'agenda (colonnes 0223 et champ d'origine). */
export interface AgendaNatureSignals {
  eventNature?: string | null;
  businessType?: string | null;
  originFieldKey?: string | null;
}

/** L'élément est-il un fait passé (HISTORICAL) ? Pure. */
export function isHistoricalAgendaEvent(i: AgendaNatureSignals): boolean {
  if (i.eventNature === 'HISTORICAL') return true;
  if (i.eventNature === 'DEADLINE') return false;
  return resolveEventSemantics({ originFieldKey: i.originFieldKey ?? null, businessType: i.businessType ?? null }).nature === 'HISTORICAL';
}

/** Champs du registre dont l'effet agenda est un fait passé. */
export const HISTORICAL_FIELD_KEYS: readonly string[] = CANONICAL_FIELDS
  .filter((d) => d.agendaEffect?.nature === 'HISTORICAL').map((d) => d.key);
/** Champs du registre dont l'effet agenda est une échéance (priment sur le type métier). */
const DEADLINE_FIELD_KEYS: readonly string[] = CANONICAL_FIELDS
  .filter((d) => d.agendaEffect?.nature === 'DEADLINE').map((d) => d.key);
/** Types métier du catalogue qui n'admettent que la nature HISTORICAL. */
export const HISTORICAL_ONLY_BUSINESS_TYPES: readonly string[] = EVENT_CATALOG
  .filter((e) => e.natures.length === 1 && e.natures[0] === 'HISTORICAL').map((e) => e.businessType);

const litteraux = (v: readonly string[]) => (v.length ? v.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ') : 'NULL');

/**
 * Expression SQL vraie si l'élément (alias `a`) est HISTORICAL — jumeau de
 * `isHistoricalAgendaEvent`. `functionalColumns` : colonnes 0223 présentes.
 * `historicalKeysParam` (ex. `$5`) : paramètre portant `HISTORICAL_FIELD_KEYS`
 * (requêtes existantes qui le transmettent déjà) ; sinon liste littérale.
 */
export function historicalSql(a = 'i', functionalColumns = true, historicalKeysParam?: string): string {
  const nature = functionalColumns ? `${a}.event_nature` : 'NULL::text';
  const type = functionalColumns ? `${a}.business_type` : 'NULL::text';
  const cles = historicalKeysParam ? `= ANY(${historicalKeysParam}::text[])` : `IN (${litteraux(HISTORICAL_FIELD_KEYS)})`;
  return `(coalesce(${nature},
      CASE WHEN ${a}.origin_field_key ${cles} THEN 'HISTORICAL'
           WHEN ${a}.origin_field_key IN (${litteraux(DEADLINE_FIELD_KEYS)}) THEN 'DEADLINE' END,
      CASE WHEN ${type} IN (${litteraux(HISTORICAL_ONLY_BUSINESS_TYPES)}) THEN 'HISTORICAL' END, '') = 'HISTORICAL')`;
}

/** Fin d'un élément (date de fin, sinon de début ; heure, sinon fin de journée) : passée ? */
export function agendaDatePassed(
  item: { startDate: string | null; startTime?: string | null; endDate?: string | null; endTime?: string | null },
  now: Date = new Date(),
): boolean | null {
  const date = item.endDate ?? item.startDate;
  if (!date) return null;
  const time = item.endDate ? item.endTime : item.startTime;
  return new Date(`${date}T${time || '23:59:59'}`).getTime() < now.getTime();
}

/**
 * Un élément est-il EN RETARD ? Ouvert (aucun statut posé), date passée, et
 * jamais un fait HISTORICAL (décision PO du 12/10). Pure — LA règle partagée.
 */
export function isAgendaOverdue(
  item: { startDate: string | null; startTime?: string | null; endDate?: string | null; endTime?: string | null; manualStatus?: string | null } & AgendaNatureSignals,
  now: Date = new Date(),
): boolean {
  if (item.manualStatus && item.manualStatus.trim() !== '') return false;
  if (agendaDatePassed(item, now) !== true) return false;
  return !isHistoricalAgendaEvent(item);
}

/**
 * Fait historique passé, sans statut : « statut à confirmer » (D17) — jamais
 * « réalisé » sur la seule foi de la date, jamais masqué ; rien n'est écrit.
 */
export function isPastHistoricalUnconfirmed(
  item: { startDate: string | null; startTime?: string | null; endDate?: string | null; endTime?: string | null; manualStatus?: string | null } & AgendaNatureSignals,
  now: Date = new Date(),
): boolean {
  if (item.manualStatus && item.manualStatus.trim() !== '') return false;
  return agendaDatePassed(item, now) === true && isHistoricalAgendaEvent(item);
}
