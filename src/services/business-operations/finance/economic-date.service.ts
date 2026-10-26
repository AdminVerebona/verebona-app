/**
 * Lot 86F — service de la DATE ÉCONOMIQUE RETENUE des composantes (ticket P1
 * « TCO / Opérations : dates économiques injustifiées et leur
 * autoréparation »). Seul écrivain des colonnes 0744 (via
 * `BusinessOperationRepository.recordComponentEconomicDate`, verrou du compte,
 * journal `business_operation_history`).
 *
 * La date économique est résolue À LA LECTURE (`./economic-date`, preuves
 * `./economic-date-evidence`) : le TCO, T2 et les exports sont donc justes
 * dès ce lot, pour le stock comme pour les nouvelles données. Ce service
 * rend la correction du STOCK traçable et vérifiable :
 *   · `inspectOperationEconomicDates` (lecture seule) compare, composante par
 *     composante, la résolution courante à la trace persistée et à
 *     l'ancienne règle (date propre, sinon date de l'Opération) :
 *       UNJUSTIFIED_ECONOMIC_DATE  aucune trace, et l'ancienne règle affectait
 *                                  une autre année (ou une année alors
 *                                  qu'aucune date n'est établie) — la date
 *                                  injustifiée est corrigée, ou l'affectation
 *                                  retirée sans supprimer la dépense ;
 *       ECONOMIC_DATE_NOT_TRACED   aucune trace, même année : provenance à
 *                                  consigner ;
 *       ECONOMIC_DATE_STALE        trace d'une autre résolution (nouvelle
 *                                  preuve, preuve retirée, règle modifiée) ;
 *   · `applyOperationEconomicDates` consigne la résolution courante (avant /
 *     après journalisés) — idempotent : une trace identique n'est jamais
 *     réécrite. Les décisions « Ajouter / Retirer du TCO » (clés sans date)
 *     ne sont jamais touchées ; les dates d'agenda non plus.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { isIsoDate } from './engine';
import { economicDateSignature, resolveOperationEconomicDates, type EconomicDateResolution } from './economic-date';
import { readEconomicDateEvidence } from './economic-date-evidence';

interface Runner { execute: (q: SQL) => Promise<unknown> }
type Row = Record<string, unknown>;
const rows = async (r: Runner, q: SQL): Promise<Row[]> => (await r.execute(q)) as unknown as Row[];
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const asJson = (v: unknown): Record<string, unknown> | null => {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; } }
  return v as Record<string, unknown>;
};

type EconomicDateAnomaly = 'UNJUSTIFIED_ECONOMIC_DATE' | 'ECONOMIC_DATE_NOT_TRACED' | 'ECONOMIC_DATE_STALE';

interface ComponentEconomicDateState {
  componentId: number;
  operationId: number;
  resolution: EconomicDateResolution;
  signature: string;
  /** Trace persistée (null : jamais consignée). */
  persisted: { basis: string | null; date: string | null; signature: string | null } | null;
  /** Date que l'ancienne règle (avant 86F) affectait : date propre, sinon date de l'Opération. */
  legacyDate: string | null;
  anomaly: EconomicDateAnomaly | null;
}

const PREVUE = new Set(['ENVISAGED', 'PLANNED']);
const annee = (d: string | null) => (d ? d.slice(0, 4) : null);

/** Ancienne règle du moteur (avant 86F) — seulement pour qualifier l'écart du stock, jamais pour dater. */
function legacyDateOf(own: string | null, op: { status: string; realizedDate: string | null; startDate: string | null }): string | null {
  if (isIsoDate(own)) return own.slice(0, 10);
  if (PREVUE.has(op.status)) return null;
  const d = op.realizedDate ?? op.startDate;
  return isIsoDate(d) ? d.slice(0, 10) : null;
}

/**
 * État de la date économique des composantes ACTIVES des Opérations actives
 * demandées (lecture seule, sans IA). Opérations invalidées, fusionnées ou
 * d'un autre compte : absentes du résultat.
 */
export async function inspectOperationEconomicDates(accountId: number, operationIds: readonly number[], r: Runner = db): Promise<Map<number, ComponentEconomicDateState[]>> {
  const out = new Map<number, ComponentEconomicDateState[]>();
  const ids = [...new Set(operationIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!ids.length) return out;
  const ops = await rows(r, sql`
    SELECT id, type_code, status, realized_date::text AS realized_date, start_date::text AS start_date, planned_date::text AS planned_date
      FROM business_operations
     WHERE account_id = ${accountId} AND id = ANY(${intArray(ids)}::bigint[]) AND invalidated_at IS NULL AND merged_into_operation_id IS NULL
     ORDER BY id`);
  if (!ops.length) return out;
  const vivants = ops.map((o) => Number(o.id));
  const comps = await rows(r, sql`
    SELECT id, operation_id, kind, amount_minor, currency, economic_date::text AS economic_date,
           economic_date_basis, resolved_economic_date::text AS resolved_economic_date, economic_date_trace
      FROM business_operation_financial_components
     WHERE account_id = ${accountId} AND active AND operation_id = ANY(${intArray(vivants)}::bigint[])
     ORDER BY id`);
  const preuves = await readEconomicDateEvidence(r, accountId, vivants);
  for (const o of ops) {
    const id = Number(o.id);
    const miennes = comps.filter((c) => Number(c.operation_id) === id);
    if (!miennes.length) continue;
    const op = {
      typeCode: txt(o.type_code), status: String(o.status), realizedDate: txt(o.realized_date), startDate: txt(o.start_date), plannedDate: txt(o.planned_date),
    };
    const dates = resolveOperationEconomicDates({
      ...op,
      components: miennes.map((c) => ({
        id: Number(c.id), kind: String(c.kind), amountMinor: Number(c.amount_minor), currency: String(c.currency).trim().toUpperCase(),
        economicDate: txt(c.economic_date),
        periodStart: preuves.periods.get(Number(c.id))?.periodStart ?? null, periodEnd: preuves.periods.get(Number(c.id))?.periodEnd ?? null,
      })),
    }, preuves.byOperation.get(id) ?? {});
    out.set(id, miennes.map((c): ComponentEconomicDateState => {
      const resolution = dates.get(Number(c.id))!;
      const signature = economicDateSignature(resolution);
      const trace = asJson(c.economic_date_trace);
      const persisted = c.economic_date_basis == null && !trace ? null
        : { basis: txt(c.economic_date_basis), date: txt(c.resolved_economic_date), signature: txt(trace?.signature) };
      const legacyDate = legacyDateOf(txt(c.economic_date), op);
      let anomaly: EconomicDateAnomaly | null = null;
      if (!persisted) anomaly = annee(legacyDate) !== annee(resolution.date) ? 'UNJUSTIFIED_ECONOMIC_DATE' : 'ECONOMIC_DATE_NOT_TRACED';
      else if (persisted.signature !== signature) anomaly = 'ECONOMIC_DATE_STALE';
      return { componentId: Number(c.id), operationId: id, resolution, signature, persisted, legacyDate, anomaly };
    }));
  }
  return out;
}

interface ApplyEconomicDatesResult {
  /** Traces consignées (composantes corrigées ou provenance ajoutée). */
  recorded: number;
  /** Dont affectations annuelles injustifiées corrigées ou retirées. */
  unjustifiedFixed: number;
  unchanged: number;
  components: Array<{ componentId: number; operationId: number; anomaly: EconomicDateAnomaly; before: string | null; after: string | null; basis: string }>;
}

/**
 * Consigne la date économique retenue des composantes en écart (sous le verrou
 * Opération du compte, résolution recalculée DANS la transaction) —
 * idempotent : une seconde exécution sans nouvelle preuve ne change rien.
 */
export async function applyOperationEconomicDates(accountId: number, operationIds: readonly number[], opts: { correlationId?: string } = {}): Promise<ApplyEconomicDatesResult> {
  const { withBusinessOperationWrite } = await import('../write');
  return withBusinessOperationWrite(accountId, async (repo, session) => {
    const res: ApplyEconomicDatesResult = { recorded: 0, unjustifiedFixed: 0, unchanged: 0, components: [] };
    const etats = await inspectOperationEconomicDates(accountId, operationIds, session.tx as unknown as Runner);
    for (const liste of etats.values()) {
      for (const e of liste) {
        if (!e.anomaly) { res.unchanged++; continue; }
        const r = e.resolution;
        const basis = r.status === 'UNDETERMINED' ? 'UNDETERMINED' : (r.basis as string);
        const before = e.persisted
          ? { component_id: e.componentId, economic_date_basis: e.persisted.basis, resolved_economic_date: e.persisted.date, signature: e.persisted.signature }
          : { component_id: e.componentId, economic_date_basis: 'LEGACY_OPERATION_FALLBACK', resolved_economic_date: e.legacyDate };
        const ok = await repo.recordComponentEconomicDate(e.componentId, {
          basis, date: r.date, signature: e.signature, before,
          trace: {
            version: r.version, status: r.status, date: r.date, basis: r.basis, reason: r.reason, provenance: r.provenance,
            justification: r.justification, candidates: r.candidates, anomaly: e.anomaly, legacyDate: e.legacyDate,
          },
        });
        if (!ok) { res.unchanged++; continue; }
        res.recorded++;
        if (e.anomaly === 'UNJUSTIFIED_ECONOMIC_DATE' || annee(e.persisted?.date ?? e.legacyDate) !== annee(r.date)) res.unjustifiedFixed++;
        res.components.push({ componentId: e.componentId, operationId: e.operationId, anomaly: e.anomaly, before: e.persisted ? e.persisted.date : e.legacyDate, after: r.date, basis });
      }
    }
    return res;
  }, { correlationId: opts.correlationId });
}
