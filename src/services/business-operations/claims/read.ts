/**
 * Lecture des Sinistres (Opérations CLAIM) — lot 44, O5 (CDC Opérations V1
 * C14, C22, C25, NFR-OP-009/010).
 *
 * Seuls les sinistres ACTIFS (non invalidés, non fusionnés) d'un compte sont
 * lus, bornés par compte et par bien (liens actifs, index
 * `business_operation_asset_links_asset_idx`). Même lecture pour la fiche,
 * le dossier Assurance-sinistre, le miroir de compatibilité et la migration :
 * fonctionne dans une transaction (`tx`) ou hors transaction (`db`).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ClaimFileStatus } from '../model';
import type { ClaimListsInput } from '../repository';
import { claimCosts, type ClaimRecord } from './model';

type Row = Record<string, unknown>;
export interface SqlExecutor { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(x: SqlExecutor, q: SQL): Promise<T[]> => (await x.execute(q)) as unknown as T[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;

/** Montant EUR d'une composante : contre-valeur si connue, sinon montant en euros. */
const EUR_SQL = sql.raw(`COALESCE(c.amount_eur_cents, CASE WHEN c.currency = 'EUR' THEN c.amount_minor END, 0)`);

/**
 * Sinistres actifs du compte : ceux d'un bien (lien actif), ou des
 * identifiants précis (y compris sans bien). Ordre : survenue décroissante,
 * puis création décroissante.
 */
export async function loadClaimRecords(x: SqlExecutor, accountId: number, by: { assetId?: number; ids?: readonly number[] }): Promise<ClaimRecord[]> {
  const filtre = by.ids
    ? sql`o.id = ANY(${intArray(by.ids)}::bigint[])`
    : sql`EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active AND l.asset_id = ${by.assetId ?? 0})`;
  const ops = await rows(x, sql`
    SELECT o.id, o.account_id, o.version, o.status, o.realized_date::text AS realized_date, o.closed_at::text AS closed_at,
           o.created_at::text AS created_at, o.updated_at::text AS updated_at,
           d.operation_id AS has_details, d.claim_type, d.declared_on::text AS declared_on, d.insurer_claim_ref, d.insurance_contract_operation_id,
           d.policy_reference_text, d.status AS file_status, d.status_detail, d.circumstances, d.consequences, d.measures_summary,
           d.exchanges_summary, d.estimated_damage_minor, d.history_event_id,
           (SELECT ai.id FROM agenda_items ai WHERE ai.business_operation_id = o.id AND ai.account_id = o.account_id ORDER BY (ai.projection_origin IS NULL) DESC, ai.id LIMIT 1) AS agenda_item_id,
           (SELECT NULLIF(concat_ws(' · ', k.provider, CASE WHEN cd.contract_reference IS NOT NULL THEN 'n° ' || cd.contract_reference END), '')
              FROM business_operations k LEFT JOIN business_operation_contract_details cd ON cd.operation_id = k.id
             WHERE k.id = d.insurance_contract_operation_id) AS contract_label
      FROM business_operations o
      LEFT JOIN business_operation_claim_details d ON d.operation_id = o.id
     WHERE o.account_id = ${accountId} AND o.type_code = 'CLAIM' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       AND ${filtre}
     ORDER BY COALESCE(o.realized_date, o.created_at::date) DESC, o.id DESC
     LIMIT 200`);
  if (!ops.length) return [];
  const opIds = ops.map((o) => Number(o.id));
  const liste = intArray(opIds);

  // Séquentiel : lecture possible dans la transaction d'écriture (une connexion).
  const links = await rows(x, sql`SELECT operation_id, asset_id, link_role FROM business_operation_asset_links
                 WHERE operation_id = ANY(${liste}::bigint[]) AND active ORDER BY (link_role = 'PRIMARY') DESC, asset_id`);
  const sources = await rows(x, sql`SELECT operation_id, source_kind, count(*)::int AS n FROM business_operation_sources
                 WHERE operation_id = ANY(${liste}::bigint[]) AND active GROUP BY operation_id, source_kind`);
  // Composantes du sinistre ET de ses interventions enfants (coût brut, Q4).
  const comps = await rows(x, sql`
      SELECT COALESCE(CASE WHEN o.type_code = 'CLAIM' THEN o.id END, o.parent_operation_id) AS claim_id, c.kind, ${EUR_SQL} AS eur
        FROM business_operation_financial_components c
        JOIN business_operations o ON o.id = c.operation_id
       WHERE c.active AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         AND (o.id = ANY(${liste}::bigint[]) OR (o.parent_operation_id = ANY(${liste}::bigint[]) AND o.type_code = 'INTERVENTION'))`);
  const damages = await rows(x, sql`
      SELECT d.operation_id, d.item_key, d.zone, d.element, d.finding, d.estimated_amount_minor,
             COALESCE((SELECT array_agg(dd.file_id ORDER BY dd.file_id) FROM business_operation_claim_damage_documents dd WHERE dd.damage_id = d.id), '{}') AS files,
             COALESCE((SELECT array_agg(dp.photo_id ORDER BY dp.photo_id) FROM business_operation_claim_damage_photos dp WHERE dp.damage_id = d.id), '{}') AS photos
        FROM business_operation_claim_damages d WHERE d.operation_id = ANY(${liste}::bigint[]) ORDER BY d.operation_id, d.sort_order, d.id`);
  const actions = await rows(x, sql`
      SELECT operation_id, item_key, date::text AS date, end_date::text AS end_date, status, title, detail, performed_by, invoice_file_id, child_operation_id
        FROM business_operation_claim_actions WHERE operation_id = ANY(${liste}::bigint[]) ORDER BY operation_id, sort_order, id`);
  const exchanges = await rows(x, sql`
      SELECT operation_id, item_key, date::text AS date, party, channel, direction, summary, document_file_id
        FROM business_operation_claim_exchanges WHERE operation_id = ANY(${liste}::bigint[]) ORDER BY operation_id, sort_order, id`);

  return ops.map((o): ClaimRecord => {
    const id = Number(o.id);
    const mine = (r: Row) => Number(r.operation_id) === id;
    const srcCount = (k: string) => sources.filter((s) => mine(s) && s.source_kind === k).reduce((n, s) => n + Number(s.n), 0);
    const cs = comps.filter((c) => Number(c.claim_id) === id).map((c) => ({ kind: String(c.kind), amountCents: Number(c.eur) }));
    const ownIndemnity = cs.filter((c) => c.kind === 'INDEMNITY');
    const lists: ClaimListsInput = {
      damages: damages.filter(mine).map((d) => ({
        itemKey: txt(d.item_key), zone: String(d.zone), element: txt(d.element), finding: txt(d.finding),
        estimatedAmountMinor: num(d.estimated_amount_minor),
        fileIds: ((d.files as number[] | null) ?? []).map(Number), photoIds: ((d.photos as number[] | null) ?? []).map(Number),
      })),
      actions: actions.filter(mine).map((a) => ({
        itemKey: txt(a.item_key), date: txt(a.date), endDate: txt(a.end_date), status: txt(a.status) as ClaimListsInput['actions'][number]['status'],
        title: String(a.title), detail: txt(a.detail), performedBy: txt(a.performed_by), invoiceFileId: num(a.invoice_file_id), childOperationId: num(a.child_operation_id),
      })),
      exchanges: exchanges.filter(mine).map((e) => ({
        itemKey: txt(e.item_key), date: txt(e.date), party: txt(e.party) as ClaimListsInput['exchanges'][number]['party'],
        channel: txt(e.channel) as ClaimListsInput['exchanges'][number]['channel'], direction: txt(e.direction) as ClaimListsInput['exchanges'][number]['direction'],
        summary: String(e.summary), documentFileId: num(e.document_file_id),
      })),
    };
    return {
      id,
      accountId: Number(o.account_id),
      version: Number(o.version),
      status: o.status as ClaimRecord['status'],
      realizedDate: txt(o.realized_date),
      closedAt: txt(o.closed_at),
      createdAt: String(o.created_at),
      updatedAt: String(o.updated_at),
      assets: links.filter(mine).map((l) => ({ assetId: Number(l.asset_id), role: l.link_role === 'PRIMARY' ? 'PRIMARY' : 'CONCERNED' })),
      details: o.has_details === null || o.has_details === undefined ? null : {
        claimType: txt(o.claim_type),
        declaredOn: txt(o.declared_on),
        insurerClaimRef: txt(o.insurer_claim_ref),
        insuranceContractOperationId: num(o.insurance_contract_operation_id),
        policyReferenceText: txt(o.policy_reference_text),
        status: txt(o.file_status) as ClaimFileStatus | null,
        statusDetail: txt(o.status_detail),
        circumstances: txt(o.circumstances),
        consequences: txt(o.consequences),
        measuresSummary: txt(o.measures_summary),
        exchangesSummary: txt(o.exchanges_summary),
        estimatedDamageMinor: num(o.estimated_damage_minor),
        historyEventId: num(o.history_event_id),
      },
      lists,
      indemnityCents: ownIndemnity.length ? ownIndemnity.reduce((n, c) => n + c.amountCents, 0) : null,
      costs: claimCosts(cs),
      agendaItemId: num(o.agenda_item_id),
      contractLabel: txt(o.contract_label),
      origin: { form: srcCount('CLAIM_FORM') > 0, migration: srcCount('MIGRATION') > 0, documents: srcCount('DOCUMENT') },
    };
  });
}

/** Noms des biens du compte (libellés « concerne aussi … »). */
export async function loadAssetNames(x: SqlExecutor, accountId: number, assetIds: readonly number[]): Promise<Map<number, string>> {
  if (!assetIds.length) return new Map();
  const r = await rows<{ id: number; name: string }>(x, sql`
    SELECT id, name FROM assets WHERE account_id = ${accountId} AND id = ANY(${intArray([...new Set(assetIds)])}::int[]) AND deleted_at IS NULL`);
  return new Map(r.map((a) => [Number(a.id), String(a.name)]));
}
