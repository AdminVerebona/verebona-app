/**
 * Contexte du niveau M3 (lot 42, CDC Opérations V1 C6.1, C6.2) — construit
 * depuis les données PERSISTÉES seulement (candidat T1, document, Opérations
 * consolidées, résumés de leurs sources), jamais depuis le fichier brut.
 *
 * Le MÊME constructeur sert :
 *   · au consolidateur, dans sa transaction, pour calculer l'empreinte du
 *     contexte courant et n'appliquer un verdict enregistré que s'il porte
 *     cette empreinte ;
 *   · à la phase M3 (`m3.ts`), hors verrou, pour appeler le modèle.
 * Un contexte inchangé produit la même empreinte : le modèle n'est jamais
 * rappelé sans changement (NFR-OP-005).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '../lock';
import type { CandidateIdentity } from './model';
import {
  operationMatchFingerprint, operationMatchVariables,
  type OperationMatchCandidate, type OperationMatchSubject, type OperationMatchVerdict,
} from '@/services/ai/reconciliation/master/operation-match';

type Runner = Pick<DbTx, 'execute'>;
const rows = async <T = Record<string, unknown>>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;

/** Trace M3 conservée sur le candidat (`t3_detail.m3`) — diagnostic, jamais une donnée métier. */
export interface StoredM3 {
  status: 'DONE' | 'PROMPT_UNAVAILABLE' | 'DEFERRED' | 'ERROR' | 'TOO_MANY_CANDIDATES';
  /** Empreinte du contexte évalué. */
  fingerprint: string;
  /** Version du prompt maître T3 au moment de l'évaluation (`t3_master_v1@…`). */
  promptVersion?: string | null;
  verdict?: OperationMatchVerdict;
  /** Opérations soumises au modèle. */
  operationIds?: number[];
  at: string;
  /** DEFERRED / ERROR : pas de nouvel essai avant cette date. */
  retryAfter?: string;
  /** Motif d'un report ou d'une erreur. */
  detail?: string;
  warnings?: string[];
}

const montant = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;
const dates = (o: Record<string, string | null | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v)) as Record<string, string>;

/** Variables du modèle et empreinte pour UN candidat et ses Opérations candidates. */
export async function operationMatchContext(
  r: Runner, accountId: number, identity: CandidateIdentity, operationIds: readonly number[],
): Promise<{ variables: Record<string, unknown>; fingerprint: string; operationIds: number[] }> {
  const ids = [...new Set(operationIds)].sort((a, b) => a - b);
  const [doc] = await rows<{ title: string | null; document_type_code: string | null; document_date: string | null }>(r, sql`
    SELECT COALESCE(retained_title, original_filename, filename) AS title, document_type_code, document_date::text AS document_date
      FROM asset_files WHERE id = ${identity.fileId} AND account_id = ${accountId}`);
  const noms = new Map((await rows<{ id: number; name: string | null }>(r, sql`
    SELECT id, name FROM assets WHERE account_id = ${accountId}
       AND id = ANY(${intArray([...identity.assetIds])}::int[])`)).map((x) => [Number(x.id), x.name ?? `bien ${x.id}`]));

  const subject: OperationMatchSubject = {
    document: { title: doc?.title ?? null, documentType: doc?.document_type_code ?? null, documentDate: doc?.document_date ?? null },
    candidate: {
      type: identity.type,
      status: identity.status,
      sourceRole: identity.role,
      summary: identity.summary.slice(0, 300),
      provider: identity.provider,
      assets: identity.assetIds.map((a) => noms.get(a) ?? `bien ${a}`),
      references: identity.refs.map((x) => `${x.kind}:${x.value}`),
      dates: dates({ ...identity.dates }),
      amounts: identity.hints.map((h) => `${h.role}${h.amountScope ? `/${h.amountScope}` : ''} ${montant(h.amountMinor, h.currency)}`),
    },
  };

  const candidates: OperationMatchCandidate[] = [];
  if (ids.length) {
    const ops = await rows<Record<string, unknown>>(r, sql`
      SELECT o.id, o.type_code, o.status, o.provider, o.planned_date::text AS planned_date, o.start_date::text AS start_date,
             o.realized_date::text AS realized_date, o.end_date::text AS end_date,
             COALESCE((SELECT array_agg(COALESCE(a.name, 'bien ' || a.id) ORDER BY a.id) FROM business_operation_asset_links l
                        JOIN assets a ON a.id = l.asset_id WHERE l.operation_id = o.id AND l.active), '{}') AS assets,
             COALESCE((SELECT array_agg(r.reference_kind || ':' || r.reference_value ORDER BY r.reference_kind, r.normalized_value)
                         FROM business_operation_references r WHERE r.operation_id = o.id AND r.active), '{}') AS refs,
             COALESCE((SELECT array_agg(c.kind || ' ' || to_char(c.amount_minor / 100.0, 'FM999999999990.00') || ' ' || c.currency ORDER BY c.id)
                         FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.active), '{}') AS amounts
        FROM business_operations o
       WHERE o.account_id = ${accountId} AND o.id = ANY(${intArray(ids)}::bigint[])
       ORDER BY o.id`);
    const docs = await rows<{ operation_id: string; title: string | null; role: string | null; summary: string | null }>(r, sql`
      SELECT x.operation_id, x.title, x.role, x.summary FROM (
        SELECT s.operation_id, COALESCE(f.retained_title, f.original_filename, f.filename, 'Document') AS title, s.source_role AS role,
               c.summary, row_number() OVER (PARTITION BY s.operation_id ORDER BY s.id) AS n
          FROM business_operation_sources s
          JOIN asset_files f ON f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END) AND f.account_id = s.account_id
          LEFT JOIN document_operation_candidates c ON c.file_id = f.id AND c.status = 'ACTIVE' AND c.candidate_key = s.locator->>'candidateKey'
         WHERE s.account_id = ${accountId} AND s.active AND s.source_kind = 'DOCUMENT' AND s.operation_id = ANY(${intArray(ids)}::bigint[])
      ) x WHERE x.n <= 5 ORDER BY x.operation_id, x.n`);
    for (const o of ops) {
      const id = Number(o.id);
      candidates.push({
        candidateId: id,
        type: (o.type_code as string | null) ?? null,
        status: String(o.status),
        provider: (o.provider as string | null) ?? null,
        dates: dates({ plannedDate: o.planned_date as string | null, startDate: o.start_date as string | null, realizedDate: o.realized_date as string | null, endDate: o.end_date as string | null }),
        assets: ((o.assets as string[] | null) ?? []).map(String),
        references: ((o.refs as string[] | null) ?? []).map(String),
        amounts: ((o.amounts as string[] | null) ?? []).map(String),
        documents: docs.filter((d) => Number(d.operation_id) === id)
          .map((d) => ({ title: String(d.title ?? 'Document'), role: d.role ?? null, summary: d.summary ? String(d.summary).slice(0, 300) : null })),
      });
    }
  }
  const variables = operationMatchVariables(subject, candidates);
  return { variables, fingerprint: operationMatchFingerprint(variables), operationIds: candidates.map((c) => c.candidateId) };
}
