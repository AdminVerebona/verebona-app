/**
 * Lot 112D — capital restant dû : LECTURE des preuves d'un prêt (aucune écriture, aucune IA).
 *
 * `readLoanEvidence` (appelée par `readAssetTco`) : pour chaque Opération
 * FINANCING du bien, faits T1 actifs (confiance « certain ») et tableaux T1
 * actifs non douteux de SES justificatifs (documents non supprimés du
 * compte), capital consolidé (`business_operation_financing_details`) et
 * saisies USER / ADMIN (colonnes 1415) — assemblés par `assembleLoanEvidence`
 * (pure).
 *
 * Le TCO reste CONSOMMATEUR (INV-FINAL-009 / INV-FINAL-013) : la saisie des
 * conditions (décision utilisateur, écriture) vit dans le domaine financement,
 * `src/services/business-operations/financing/loan-terms-decisions.ts`.
 */
import { sql, type SQL } from 'drizzle-orm';
import { LOAN_PERIODICITIES, parseRatePct, type LoanPeriodicity } from './loan-amortization';
import {
  assembleLoanEvidence, LOAN_TERM_FIELDS, type LoanEvidence, type LoanFactInput, type LoanManualEvent, type LoanManualInput,
  type LoanTableInput, type LoanTermValues,
} from './loan-evidence';
import type { TcoFinancingDetails } from './financing';

type Row = Record<string, unknown>;
interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const int = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isSafeInteger(Number(v)) ? null : Number(v));

/** Bornes de lecture (un prêt documenté reste loin de ces volumes). */
const FACTS_MAX = 2000;
const TABLES_MAX = 50;
const CELLS_MAX = 60000;
/** Pré-filtre SQL des faits (le classement exact est fait par `readLoanFact`). */
const FACT_FILTER = "(taux|dur[ée]e|[ée]ch[ée]ance|mensualit|trimestrialit|annuit|restant|crd|encours|diff[ée]r|assurance|p[ée]riodicit|fr[ée]quence|remboursement|loan\\.)";

/** Conditions saisies d'un prêt (colonnes 1415) → entrée manuelle. */
export function manualFromRow(d: Row): LoanManualInput | null {
  const origins = (d.loan_terms_origin && typeof d.loan_terms_origin === 'object' ? d.loan_terms_origin : {}) as LoanManualInput['origins'];
  const events = Array.isArray(d.loan_events) ? (d.loan_events as LoanManualEvent[]) : [];
  const per = txt(d.loan_periodicity) as LoanPeriodicity | null;
  const rate = d.loan_nominal_rate_pct == null ? null : parseRatePct(String(d.loan_nominal_rate_pct))?.text ?? null;
  const dm = int(d.loan_deferral_months); const dk = txt(d.loan_deferral_kind);
  const values: LoanManualInput['values'] = {
    principalCents: int(d.loan_principal_minor), ratePct: rate, periodicity: per && LOAN_PERIODICITIES.includes(per) ? per : null,
    durationMonths: int(d.loan_duration_months), firstInstallmentDate: txt(d.loan_first_installment_date),
    installmentCents: int(d.loan_installment_minor), insuranceCents: int(d.loan_insurance_minor),
    deferral: dm != null && dk ? { months: dm, kind: dk as LoanTermValues['deferral']['kind'] } : null,
  };
  const vide = LOAN_TERM_FIELDS.every((f) => values[f] == null) && !events.length;
  return vide ? null : { values, origins, events };
}

/**
 * Preuves du capital restant dû des prêts du bien (lecture seule, compte vérifié).
 */
export async function readLoanEvidence(
  r: Runner, accountId: number,
  loans: ReadonlyArray<{ id: number; fileIds: readonly number[] }>,
  details: ReadonlyMap<number, TcoFinancingDetails>,
): Promise<Map<number, LoanEvidence>> {
  const out = new Map<number, LoanEvidence>();
  if (!loans.length) return out;
  const ids = loans.map((l) => l.id);
  const manuel = new Map<number, LoanManualInput | null>();
  for (const d of await rows(r, sql`
    SELECT d.operation_id, d.loan_principal_minor, d.loan_nominal_rate_pct::text AS loan_nominal_rate_pct, d.loan_periodicity, d.loan_duration_months,
           d.loan_first_installment_date::text AS loan_first_installment_date, d.loan_installment_minor, d.loan_insurance_minor,
           d.loan_deferral_months, d.loan_deferral_kind, d.loan_terms_origin, d.loan_events
      FROM business_operation_financing_details d JOIN business_operations o ON o.id = d.operation_id
     WHERE o.account_id = ${accountId} AND d.operation_id = ANY(${intArray(ids)}::bigint[])`)) {
    manuel.set(Number(d.operation_id), manualFromRow(d));
  }
  const fichiers = [...new Set(loans.flatMap((l) => l.fileIds))];
  const faits = new Map<number, LoanFactInput[]>();
  const tableaux = new Map<number, LoanTableInput[]>();
  if (fichiers.length) {
    for (const f of await rows(r, sql`
      SELECT f.file_id, f.fact_key, f.raw_key, f.label, f.subject, f.attribute, f.value_text, f.value_number::text AS value_number, f.value_unit,
             f.normalized_value, f.value_type, f.period_start::text AS period_start, f.period_end::text AS period_end, f.excerpt, f.confidence
        FROM document_facts f JOIN asset_files af ON af.id = f.file_id AND af.account_id = ${accountId} AND af.deleted_at IS NULL
       WHERE f.account_id = ${accountId} AND f.status = 'active' AND f.file_id = ANY(${intArray(fichiers)}::int[])
         AND (coalesce(f.raw_key, '') || ' ' || f.fact_key || ' ' || coalesce(f.label, '') || ' ' || coalesce(f.attribute, '') || ' ' || coalesce(f.subject, '')) ~* ${FACT_FILTER}
       ORDER BY f.file_id, f.id LIMIT ${FACTS_MAX}`)) {
      const fileId = Number(f.file_id);
      const l = faits.get(fileId) ?? [];
      l.push({
        fileId, factKey: txt(f.fact_key), rawKey: txt(f.raw_key), label: txt(f.label), subject: txt(f.subject), attribute: txt(f.attribute),
        valueText: txt(f.value_text), valueNumber: txt(f.value_number), valueUnit: txt(f.value_unit), normalizedValue: txt(f.normalized_value),
        valueType: txt(f.value_type), periodStart: txt(f.period_start), periodEnd: txt(f.period_end), excerpt: txt(f.excerpt), confidence: txt(f.confidence),
      });
      faits.set(fileId, l);
    }
    const tabs = await rows<{ id: string; file_id: number; columns: unknown; uncertain: boolean }>(r, sql`
      SELECT t.id, t.file_id, t.columns, t.uncertain
        FROM document_tables t JOIN asset_files af ON af.id = t.file_id AND af.account_id = ${accountId} AND af.deleted_at IS NULL
       WHERE t.account_id = ${accountId} AND t.status = 'active' AND NOT t.uncertain AND t.file_id = ANY(${intArray(fichiers)}::int[])
         AND unaccent(lower(t.columns::text)) ~ '(restant|crd|encours)'
       ORDER BY t.file_id, t.table_index LIMIT ${TABLES_MAX}`);
    if (tabs.length) {
      const cellules = await rows<{ table_id: string; row_index: number; column_index: number; value_text: string | null; normalized_value: string | null; confidence: string | null }>(r, sql`
        SELECT table_id, row_index, column_index, value_text, normalized_value, confidence
          FROM document_table_cells WHERE account_id = ${accountId} AND table_id = ANY(${`{${tabs.map((t) => String(t.id)).join(',')}}`}::bigint[])
         ORDER BY table_id, row_index, column_index LIMIT ${CELLS_MAX}`);
      for (const t of tabs) {
        const cols = Array.isArray(t.columns) ? (t.columns as Array<{ header?: unknown }>).map((c) => String(c?.header ?? '')) : [];
        const fileId = Number(t.file_id);
        const l = tableaux.get(fileId) ?? [];
        l.push({
          fileId, tableId: Number(t.id), uncertain: !!t.uncertain, columns: cols,
          cells: cellules.filter((c) => String(c.table_id) === String(t.id)).map((c) => ({ row: c.row_index, column: c.column_index, value: c.value_text, normalized: c.normalized_value, confidence: c.confidence })),
        });
        tableaux.set(fileId, l);
      }
    }
  }
  for (const l of loans) {
    const d = details.get(l.id);
    out.set(l.id, assembleLoanEvidence({
      principal: { cents: d?.principalAmountMinor ?? null, currency: d?.principalCurrency ?? null },
      facts: l.fileIds.flatMap((f) => faits.get(f) ?? []),
      tables: l.fileIds.flatMap((f) => tableaux.get(f) ?? []),
      manual: manuel.get(l.id) ?? null,
    }));
  }
  return out;
}
