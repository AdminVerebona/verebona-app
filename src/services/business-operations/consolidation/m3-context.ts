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
  /** Lot 53 (D7) : date du report par un plafond d'appels (`at` = dernière tentative réelle, vide si aucune). */
  deferredAt?: string;
  /** Motif d'un report ou d'une erreur. */
  detail?: string;
  warnings?: string[];
}

/** Lot 56A : mode de rattachement d'un document déjà lié (historique des décisions, sans valeur métier). */
const LIEN: Readonly<Record<string, string>> = { M0: 'USER', M1: 'REFERENCE', M2: 'SAME_DOCUMENT', M3: 'AI' };

/** Lot 56A : bornes des extraits d'unités documentaires T1 transmis au modèle (par document). */
export const M3_EXCERPTS_PER_DOCUMENT = 12;
export const M3_EXCERPT_MAX_CHARS = 160;

/**
 * Lot 56A : extraits des unités documentaires T1 (`document_source_units`)
 * de documents du compte — libellé : valeur, champs, lignes de tableau,
 * blocs de texte ; unités comprises ou incertaines seulement (jamais une
 * unité en échec ou non informative) ; saillantes d'abord, puis ordre de
 * lecture. Bornés (`M3_EXCERPTS_PER_DOCUMENT` × `M3_EXCERPT_MAX_CHARS`).
 * Le modèle y trouve les indices que T1 n'a pas structurés (numéro
 * d'abonné, formule, adresse d'installation…) ; aucune règle serveur.
 */
export async function sourceUnitExcerpts(r: Runner, accountId: number, fileIds: readonly number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const ids = [...new Set(fileIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!ids.length) return out;
  const u = await rows<{ file_id: number; label: string | null; value_text: string | null; content_text: string | null }>(r, sql`
    SELECT x.file_id, x.label, x.value_text, x.content_text FROM (
      SELECT u.file_id, u.label, u.value_text, u.content_text,
             row_number() OVER (PARTITION BY u.file_id ORDER BY u.salient DESC, u.page NULLS LAST, u.ordinal, u.id) AS n
        FROM document_source_units u
       WHERE u.account_id = ${accountId} AND u.file_id = ANY(${intArray(ids)}::int[])
         AND u.coverage_status IN ('COVERED', 'UNCERTAIN', 'UNRESOLVED')
         AND u.kind IN ('LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW', 'TEXT_BLOCK')
         AND (COALESCE(btrim(u.content_text), '') <> '' OR COALESCE(btrim(u.value_text), '') <> '')
    ) x WHERE x.n <= ${M3_EXCERPTS_PER_DOCUMENT} ORDER BY x.file_id, x.n`);
  for (const x of u) {
    const lv = [x.label, x.value_text].filter((v) => v && String(v).trim()).join(' : ');
    const brut = x.value_text && x.value_text.trim() ? lv : (x.content_text && x.content_text.trim() ? x.content_text : lv);
    const t = brut.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const k = Number(x.file_id);
    out.set(k, [...(out.get(k) ?? []), t.length > M3_EXCERPT_MAX_CHARS ? `${t.slice(0, M3_EXCERPT_MAX_CHARS - 1)}…` : t]);
  }
  return out;
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
  // Lot 55B (B) : équipements nommés (bornés au compte par le bien parent).
  const equipements = identity.equipmentIds.length ? (await rows<{ id: number; name: string | null }>(r, sql`
    SELECT e.id, e.name FROM equipments e JOIN assets a ON a.id = e.asset_id
     WHERE a.account_id = ${accountId} AND e.id = ANY(${intArray(identity.equipmentIds)}::int[]) ORDER BY e.id`))
    .map((x) => x.name ?? `équipement ${x.id}`) : [];
  // Lot 55B (B) : périodes économiques des montants (échéances d'un contrat).
  const periodes = identity.hints
    .filter((h) => h.periodStart || h.periodEnd || h.amountScope === 'INSTALLMENT')
    .map((h) => `${h.periodStart ?? '?'}→${h.periodEnd ?? '?'} ${h.amountScope ?? h.role} ${montant(h.amountMinor, h.currency)}${h.economicDate ? ` (date ${h.economicDate})` : ''}`);

  // Lot 56A : extraits des unités documentaires T1 (document_source_units) du document source.
  const extraitsSujet = (await sourceUnitExcerpts(r, accountId, [identity.fileId])).get(identity.fileId) ?? [];
  const subject: OperationMatchSubject = {
    document: {
      title: doc?.title ?? null, documentType: doc?.document_type_code ?? null, documentDate: doc?.document_date ?? null,
      ...(extraitsSujet.length ? { excerpts: extraitsSujet } : {}),
    },
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
      ...(periodes.length ? { periods: periodes } : {}),
      ...(equipements.length ? { equipments: equipements } : {}),
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
                         FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.active), '{}') AS amounts,
             -- Lot 55B (B) : périodes facturées, équipements, détail du contrat.
             COALESCE((SELECT array_agg(COALESCE(c.period_start::text, '?') || '→' || COALESCE(c.period_end::text, '?') || ' '
                                        || to_char(c.amount_minor / 100.0, 'FM999999999990.00') || ' ' || btrim(c.currency) ORDER BY c.period_start, c.id)
                         FROM business_operation_financial_components c
                        WHERE c.operation_id = o.id AND c.active AND (c.period_start IS NOT NULL OR c.period_end IS NOT NULL)), '{}') AS periods,
             COALESCE((SELECT array_agg(COALESCE(e.name, 'équipement ' || e.id) ORDER BY e.id) FROM business_operation_equipment_links l
                        JOIN equipments e ON e.id = l.equipment_id WHERE l.operation_id = o.id AND l.active), '{}') AS equipments,
             (SELECT json_build_object('reference', d.contract_reference, 'periodicity', d.periodicity,
                                       'effectiveFrom', d.effective_from::text, 'effectiveTo', d.effective_to::text)
                FROM business_operation_contract_details d WHERE d.operation_id = o.id) AS contract
        FROM business_operations o
       WHERE o.account_id = ${accountId} AND o.id = ANY(${intArray(ids)}::bigint[])
       ORDER BY o.id`);
    const docs = await rows<{ operation_id: string; title: string | null; role: string | null; summary: string | null; method: string | null }>(r, sql`
      SELECT x.operation_id, x.title, x.role, x.summary, x.method FROM (
        SELECT s.operation_id, COALESCE(f.retained_title, f.original_filename, f.filename, 'Document') AS title, s.source_role AS role,
               c.summary, s.match_method AS method, row_number() OVER (PARTITION BY s.operation_id ORDER BY s.id) AS n
          FROM business_operation_sources s
          JOIN asset_files f ON f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END) AND f.account_id = s.account_id
          LEFT JOIN document_operation_candidates c ON c.file_id = f.id AND c.status = 'ACTIVE' AND c.candidate_key = s.locator->>'candidateKey'
         WHERE s.account_id = ${accountId} AND s.active AND s.source_kind = 'DOCUMENT' AND s.operation_id = ANY(${intArray(ids)}::bigint[])
      ) x WHERE x.n <= 5 ORDER BY x.operation_id, x.n`);
    // Lot 56A : document le plus récent de chaque Opération → ses extraits T1.
    const derniers = await rows<{ operation_id: string; file_id: number }>(r, sql`
      SELECT DISTINCT ON (s.operation_id) s.operation_id, f.id AS file_id
        FROM business_operation_sources s
        JOIN asset_files f ON f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END) AND f.account_id = s.account_id
       WHERE s.account_id = ${accountId} AND s.active AND s.source_kind = 'DOCUMENT' AND s.operation_id = ANY(${intArray(ids)}::bigint[])
         AND f.id <> ${identity.fileId}
       ORDER BY s.operation_id, s.id DESC`);
    const extraits = await sourceUnitExcerpts(r, accountId, derniers.map((x) => Number(x.file_id)));
    const dernierDe = new Map(derniers.map((x) => [Number(x.operation_id), Number(x.file_id)]));
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
          .map((d) => ({
            title: String(d.title ?? 'Document'), role: d.role ?? null, summary: d.summary ? String(d.summary).slice(0, 300) : null,
            ...(d.method && LIEN[d.method] ? { linkedBy: LIEN[d.method] } : {}),
          })),
        ...((extraits.get(dernierDe.get(id) ?? -1) ?? []).length ? { excerpts: extraits.get(dernierDe.get(id)!)! } : {}),
        ...(((o.periods as string[] | null) ?? []).length ? { periods: (o.periods as string[]).map(String) } : {}),
        ...(((o.equipments as string[] | null) ?? []).length ? { equipments: (o.equipments as string[]).map(String) } : {}),
        ...(o.contract ? { contract: o.contract as OperationMatchCandidate['contract'] } : {}),
      });
    }
  }
  const variables = operationMatchVariables(subject, candidates);
  return { variables, fingerprint: operationMatchFingerprint(variables), operationIds: candidates.map((c) => c.candidateId) };
}
