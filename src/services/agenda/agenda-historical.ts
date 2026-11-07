/**
 * Fait HISTORIQUE de l'agenda — règle UNIQUE de NATURE (lot 47B, point 2 ;
 * décision PO du 12/10 ; CDC 15 D-14). Lot 113P (#715) : la partie « statut »
 * (« en retard », « à confirmer ») de ce module est supprimée ; seule la
 * nature (fait passé / échéance) reste, utile à T4, à l'accueil et aux exports.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Historique : les lots 47B et 53 (D17) dérivaient de cette nature des
 * statuts « en retard » / « statut à confirmer ». Supprimés au lot 113P :
 * la nature sert seulement à distinguer un FAIT passé d'une ÉCHÉANCE (T4,
 * accueil, exports, assistant), jamais à qualifier une exécution.
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

/*
 * Lot 113P (#715, décision PO du 06/11/2026) : `isAgendaOverdue` (« en retard ») et
 * `isPastHistoricalUnconfirmed` (« statut à confirmer ») sont SUPPRIMÉS — un événement
 * n'a plus de statut ; une date passée n'est ni un retard ni une réalisation à confirmer.
 */
