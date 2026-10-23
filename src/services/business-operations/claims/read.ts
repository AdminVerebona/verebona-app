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
import { componentEurMinor } from '../finance/engine';

type Row = Record<string, unknown>;
export interface SqlExecutor { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(x: SqlExecutor, q: SQL): Promise<T[]> => (await x.execute(q)) as unknown as T[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;

// Lot 54D (E09) : plus de `COALESCE(…, 0)` — une devise sans contre-valeur EUR
// n'est JAMAIS 0 € ; conversion par le moteur partagé (`finance/engine`).

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
           d.operation_id AS has_details, d.claim_type, d.declared_on::text AS declared_on, d.insurer_claim_ref,
           -- Lot 54 (SEC-04) : référence vers une Opération / un événement d'un AUTRE compte neutralisée (jamais restituée).
           (SELECT k.id FROM business_operations k WHERE k.id = d.insurance_contract_operation_id AND k.account_id = o.account_id) AS insurance_contract_operation_id,
           d.policy_reference_text, d.status AS file_status, d.status_detail, d.circumstances, d.consequences, d.measures_summary,
           d.exchanges_summary, d.estimated_damage_minor,
           (SELECT ev.id FROM events ev WHERE ev.id = d.history_event_id AND ev.account_id = o.account_id) AS history_event_id,
           (SELECT ai.id FROM agenda_items ai WHERE ai.business_operation_id = o.id AND ai.account_id = o.account_id ORDER BY (ai.operation_role IS NOT DISTINCT FROM 'PRINCIPAL') DESC, (ai.projection_origin IS NULL) DESC, ai.id LIMIT 1) AS agenda_item_id,
           (SELECT NULLIF(concat_ws(' · ', k.provider, CASE WHEN cd.contract_reference IS NOT NULL THEN 'n° ' || cd.contract_reference END), '')
              FROM business_operations k LEFT JOIN business_operation_contract_details cd ON cd.operation_id = k.id
             WHERE k.id = d.insurance_contract_operation_id AND k.account_id = o.account_id) AS contract_label
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
  // Lot 54 (SEC-04) : toute référence secondaire (bien, document, photo,
  // Opération enfant) est restituée SEULEMENT si elle appartient au compte ;
  // une relation incorrecte déjà en base n'expose rien (ni identifiant).
  const links = await rows(x, sql`SELECT l.operation_id, l.asset_id, l.link_role FROM business_operation_asset_links l
                 JOIN assets a ON a.id = l.asset_id AND a.account_id = ${accountId}
                 WHERE l.operation_id = ANY(${liste}::bigint[]) AND l.active ORDER BY (l.link_role = 'PRIMARY') DESC, l.asset_id`);
  const sources = await rows(x, sql`SELECT operation_id, source_kind, count(*)::int AS n FROM business_operation_sources
                 WHERE operation_id = ANY(${liste}::bigint[]) AND active GROUP BY operation_id, source_kind`);
  // Composantes du sinistre ET de ses interventions enfants (coût brut, Q4).
  const comps = await rows(x, sql`
      SELECT COALESCE(CASE WHEN o.type_code = 'CLAIM' THEN o.id END, o.parent_operation_id) AS claim_id, c.kind,
             c.amount_minor, trim(c.currency) AS currency, c.amount_eur_cents
        FROM business_operation_financial_components c
        JOIN business_operations o ON o.id = c.operation_id
       WHERE c.active AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL AND o.account_id = ${accountId}
         AND (o.id = ANY(${liste}::bigint[]) OR (o.parent_operation_id = ANY(${liste}::bigint[]) AND o.type_code = 'INTERVENTION'))`);
  const damages = await rows(x, sql`
      SELECT d.operation_id, d.item_key, d.zone, d.element, d.finding, d.estimated_amount_minor,
             COALESCE((SELECT array_agg(dd.file_id ORDER BY dd.file_id) FROM business_operation_claim_damage_documents dd
                        JOIN asset_files f ON f.id = dd.file_id AND f.account_id = ${accountId} WHERE dd.damage_id = d.id), '{}') AS files,
             COALESCE((SELECT array_agg(dp.photo_id ORDER BY dp.photo_id) FROM business_operation_claim_damage_photos dp
                        JOIN asset_photos p ON p.id = dp.photo_id JOIN assets pa ON pa.id = p.asset_id AND pa.account_id = ${accountId}
                        JOIN asset_files pf ON pf.id = p.file_id AND pf.account_id = ${accountId}
                       WHERE dp.damage_id = d.id), '{}') AS photos
        FROM business_operation_claim_damages d WHERE d.operation_id = ANY(${liste}::bigint[]) ORDER BY d.operation_id, d.sort_order, d.id`);
  const actions = await rows(x, sql`
      SELECT a.operation_id, a.item_key, a.date::text AS date, a.end_date::text AS end_date, a.status, a.title, a.detail, a.performed_by,
             (SELECT f.id FROM asset_files f WHERE f.id = a.invoice_file_id AND f.account_id = ${accountId}) AS invoice_file_id,
             (SELECT k.id FROM business_operations k WHERE k.id = a.child_operation_id AND k.account_id = ${accountId}) AS child_operation_id
        FROM business_operation_claim_actions a WHERE a.operation_id = ANY(${liste}::bigint[]) ORDER BY a.operation_id, a.sort_order, a.id`);
  const exchanges = await rows(x, sql`
      SELECT e.operation_id, e.item_key, e.date::text AS date, e.party, e.channel, e.direction, e.summary,
             (SELECT f.id FROM asset_files f WHERE f.id = e.document_file_id AND f.account_id = ${accountId}) AS document_file_id
        FROM business_operation_claim_exchanges e WHERE e.operation_id = ANY(${liste}::bigint[]) ORDER BY e.operation_id, e.sort_order, e.id`);

  return ops.map((o): ClaimRecord => {
    const id = Number(o.id);
    const mine = (r: Row) => Number(r.operation_id) === id;
    const srcCount = (k: string) => sources.filter((s) => mine(s) && s.source_kind === k).reduce((n, s) => n + Number(s.n), 0);
    const cs = comps.filter((c) => Number(c.claim_id) === id).map((c) => {
      const amountMinor = Number(c.amount_minor);
      const currency = String(c.currency ?? '');
      return { kind: String(c.kind), amountMinor, currency, amountCents: componentEurMinor({ amountMinor, currency, amountEurCents: num(c.amount_eur_cents) }) };
    });
    // Indemnité saisie / connue en euros ; une indemnité non convertible n'est jamais « 0 € » (E09).
    const ownIndemnity = cs.filter((c) => c.kind === 'INDEMNITY' && c.amountCents !== null);
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
      indemnityCents: ownIndemnity.length ? ownIndemnity.reduce((n, c) => n + (c.amountCents ?? 0), 0) : null,
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
