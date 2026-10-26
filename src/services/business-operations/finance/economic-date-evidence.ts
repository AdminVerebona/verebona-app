/**
 * Lot 86F — PREUVES de date économique des composantes d'Opérations (lecture
 * seule, serveur). Règle : `./economic-date` (pure). Lu par le lecteur des
 * Opérations (`read-service.listForAssistant` : TCO, T2, exports), par le
 * contrôle COH-TCO-ECONOMIC-DATES et par son service de réparation — une seule
 * lecture, une seule règle.
 *
 * Lit, pour les composantes ACTIVES des Opérations demandées :
 *   · leurs justificatifs ACTIFS (sources DOCUMENT, rôle de la source, date
 *     du document) et les natures de leurs autres sources (origine de la
 *     date propre : fiche, agenda, saisie) ;
 *   · leur période couverte ;
 *   · les RÈGLEMENTS prouvés de l'Opération : indices T1 de rôle PAYMENT des
 *     candidats établis et actifs de ses justificatifs (date lue ; à défaut,
 *     date du document s'il s'agit d'une preuve de règlement).
 * Aucune écriture, aucune IA, aucune relecture de document.
 */
import { sql, type SQL } from 'drizzle-orm';
import { isIsoDate } from './engine';
import type { EconomicDateDocument, EconomicDateEvidence, EconomicDatePayment, OwnDateOrigin } from './economic-date';

interface Runner { execute: (q: SQL) => Promise<unknown> }
type Row = Record<string, unknown>;
const rows = async (r: Runner, q: SQL): Promise<Row[]> => (await r.execute(q)) as unknown as Row[];
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const PAGE = 500;

interface EconomicDateEvidenceRead {
  /** Preuves par Opération (justificatifs par composante, origines, règlements). */
  byOperation: Map<number, EconomicDateEvidence>;
  /** Période couverte de chaque composante active. */
  periods: Map<number, { periodStart: string | null; periodEnd: string | null }>;
}

function origine(kinds: ReadonlySet<string>): OwnDateOrigin {
  if (kinds.has('DOCUMENT')) return 'DOCUMENT_HINT';
  if (kinds.has('ASSET_DATA') || kinds.has('EQUIPMENT_DATA')) return 'STRUCTURED';
  if (kinds.has('AGENDA')) return 'AGENDA';
  return kinds.size ? 'USER' : 'UNKNOWN';
}

/** Preuves de date des composantes actives des Opérations (pages de 500 Opérations). */
export async function readEconomicDateEvidence(r: Runner, accountId: number, operationIds: readonly number[]): Promise<EconomicDateEvidenceRead> {
  const byOperation = new Map<number, EconomicDateEvidence>();
  const periods = new Map<number, { periodStart: string | null; periodEnd: string | null }>();
  const ids = [...new Set(operationIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  for (let i = 0; i < ids.length; i += PAGE) {
    const page = intArray(ids.slice(i, i + PAGE));
    const sources = await rows(r, sql`
      SELECT c.id AS component_id, c.operation_id, c.period_start::text AS period_start, c.period_end::text AS period_end,
             s.source_kind, s.source_role, f.id AS file_id, f.document_date::text AS document_date
        FROM business_operation_financial_components c
        LEFT JOIN business_operation_financial_component_sources cs ON cs.component_id = c.id
        LEFT JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id AND s.active
        LEFT JOIN asset_files f ON s.source_kind = 'DOCUMENT' AND f.account_id = c.account_id AND f.deleted_at IS NULL
                               AND f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
       WHERE c.account_id = ${accountId} AND c.active AND c.operation_id = ANY(${page}::bigint[])
       ORDER BY c.id, f.id`);
    const docs = new Map<number, Map<number, EconomicDateDocument[]>>();
    const kinds = new Map<number, Set<string>>();
    const compsOf = new Map<number, Set<number>>();
    for (const x of sources) {
      const comp = Number(x.component_id);
      const op = Number(x.operation_id);
      compsOf.set(op, (compsOf.get(op) ?? new Set<number>()).add(comp));
      periods.set(comp, { periodStart: txt(x.period_start), periodEnd: txt(x.period_end) });
      const k = kinds.get(comp) ?? new Set<string>();
      if (x.source_kind) k.add(String(x.source_kind));
      kinds.set(comp, k);
      if (x.file_id == null) continue;
      const parComp = docs.get(op) ?? new Map<number, EconomicDateDocument[]>();
      const liste = parComp.get(comp) ?? [];
      if (!liste.some((d) => d.fileId === Number(x.file_id))) liste.push({ fileId: Number(x.file_id), role: txt(x.source_role), date: txt(x.document_date) });
      parComp.set(comp, liste);
      docs.set(op, parComp);
    }
    const paiements = new Map<number, EconomicDatePayment[]>();
    for (const p of await rows(r, sql`
      SELECT s.operation_id, f.id AS file_id, f.document_date::text AS document_date, s.source_role, dc.payload->>'sourceRoleHint' AS role_hint,
             h->>'amountMinor' AS amount_minor, h->>'currency' AS currency, h->>'economicDate' AS economic_date,
             h->>'periodStart' AS period_start, h->>'periodEnd' AS period_end
        FROM business_operation_sources s
        JOIN asset_files f ON f.account_id = s.account_id AND f.deleted_at IS NULL
                          AND f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
        JOIN document_operation_candidates dc ON dc.file_id = f.id AND dc.account_id = f.account_id AND dc.status = 'ACTIVE' AND dc.established
                                             AND jsonb_typeof(dc.payload->'financialHints') = 'array' AND dc.payload->'financialHints' @> '[{"role":"PAYMENT"}]'::jsonb
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(dc.payload->'financialHints') = 'array'
                                                     THEN dc.payload->'financialHints' ELSE '[]'::jsonb END) h
       WHERE s.account_id = ${accountId} AND s.active AND s.source_kind = 'DOCUMENT' AND s.operation_id = ANY(${page}::bigint[])
         AND h->>'role' = 'PAYMENT' AND h->>'amountMinor' ~ '^[0-9]{1,15}$'
       ORDER BY s.operation_id, f.id`)) {
      const op = Number(p.operation_id);
      const preuve = String(p.source_role ?? '') === 'PAYMENT_PROOF' || String(p.role_hint ?? '') === 'PAYMENT_PROOF';
      const lue = txt(p.economic_date);
      const date = lue ?? (preuve && isIsoDate(txt(p.document_date)) ? txt(p.document_date) : null);
      const liste = paiements.get(op) ?? [];
      liste.push({
        fileId: Number(p.file_id), amountMinor: Number(p.amount_minor), currency: String(p.currency ?? 'EUR').trim().toUpperCase() || 'EUR', date,
        periodStart: txt(p.period_start), periodEnd: txt(p.period_end), origin: lue ? 'PAYMENT_HINT' : 'PAYMENT_PROOF_DATE',
      });
      paiements.set(op, liste);
    }
    for (const op of new Set([...compsOf.keys(), ...paiements.keys()])) {
      const comps = [...(compsOf.get(op) ?? [])];
      byOperation.set(op, {
        documents: docs.get(op) ?? new Map(),
        origins: new Map(comps.map((c) => [c, origine(kinds.get(c) ?? new Set())])),
        // Un même règlement cité par plusieurs candidats d'un justificatif : une seule preuve.
        payments: dedupe(paiements.get(op) ?? []),
      });
    }
  }
  return { byOperation, periods };
}

function dedupe(p: EconomicDatePayment[]): EconomicDatePayment[] {
  const vus = new Set<string>();
  return p.filter((x) => {
    const k = `${x.fileId}:${x.amountMinor}:${x.currency}:${x.date ?? ''}:${x.periodStart ?? ''}:${x.periodEnd ?? ''}`;
    if (vus.has(k)) return false;
    vus.add(k);
    return true;
  });
}
