/**
 * Lecture des Sinistres (Opérations CLAIM consolidées) — lot 44, O5 ;
 * refonte lot 83D (CDC v5 §16, AC37, AC38 ; arbitrage V-Q8).
 *
 * Seuls les sinistres ACTIFS (non invalidés, non fusionnés) d'un compte sont
 * lus, bornés par compte et par bien (liens actifs). Même lecture pour le
 * dossier Assurance-sinistre, le catalogue des dossiers et l'assistant :
 * fonctionne dans une transaction (`tx`) ou hors transaction (`db`).
 *
 * Contenu (§16) : détails d'assurance, dommages détaillés (photos et
 * justificatifs RELIÉS), TOUS les documents actifs de l'Opération, Pièces et
 * équipements concernés (82D), chronologie (éléments d'Agenda : principal
 * puis étapes), coûts et indemnité. Lot 54 (SEC-04) : toute référence
 * secondaire est restituée SEULEMENT si elle appartient au compte.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ClaimFileStatus } from '../model';
import { claimCosts, type ClaimRecord } from './model';
import { componentEurMinor } from '../finance/engine';

type Row = Record<string, unknown>;
export interface SqlExecutor { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(x: SqlExecutor, q: SQL): Promise<T[]> => (await x.execute(q)) as unknown as T[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const ints = (v: unknown): number[] => ((v as unknown[] | null) ?? []).map(Number).filter((n) => Number.isSafeInteger(n));

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
           (SELECT k.id FROM business_operations k WHERE k.id = d.insurance_contract_operation_id AND k.account_id = o.account_id) AS insurance_contract_operation_id,
           d.policy_reference_text, d.status AS file_status, d.status_detail, d.circumstances, d.consequences, d.measures_summary,
           d.exchanges_summary, d.estimated_damage_minor,
           (SELECT ev.id FROM events ev WHERE ev.id = d.history_event_id AND ev.account_id = o.account_id) AS history_event_id,
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
  const liste = intArray(ops.map((o) => Number(o.id)));

  // Séquentiel : lecture possible dans la transaction d'écriture (une connexion).
  const links = await rows(x, sql`SELECT l.operation_id, l.asset_id, l.link_role FROM business_operation_asset_links l
                 JOIN assets a ON a.id = l.asset_id AND a.account_id = ${accountId}
                 WHERE l.operation_id = ANY(${liste}::bigint[]) AND l.active ORDER BY (l.link_role = 'PRIMARY') DESC, l.asset_id`);
  const sources = await rows(x, sql`SELECT operation_id, source_kind, count(*)::int AS n FROM business_operation_sources
                 WHERE operation_id = ANY(${liste}::bigint[]) AND active GROUP BY operation_id, source_kind`);
  // Lot 83D (AC39) : plus d'intervention enfant — seules les composantes du sinistre lui-même.
  const comps = await rows(x, sql`
      SELECT c.operation_id, c.kind, c.amount_minor, trim(c.currency) AS currency, c.amount_eur_cents
        FROM business_operation_financial_components c
       WHERE c.active AND c.operation_id = ANY(${liste}::bigint[])`);
  const damages = await rows(x, sql`
      SELECT d.operation_id, d.item_key, d.zone, d.element, d.finding, d.estimated_amount_minor,
             COALESCE((SELECT array_agg(dd.file_id ORDER BY dd.file_id) FROM business_operation_claim_damage_documents dd
                        JOIN asset_files f ON f.id = dd.file_id AND f.account_id = ${accountId} AND f.deleted_at IS NULL WHERE dd.damage_id = d.id), '{}') AS files,
             COALESCE((SELECT array_agg(dp.photo_id ORDER BY dp.photo_id) FROM business_operation_claim_damage_photos dp
                        JOIN asset_photos p ON p.id = dp.photo_id JOIN assets pa ON pa.id = p.asset_id AND pa.account_id = ${accountId}
                        JOIN asset_files pf ON pf.id = p.file_id AND pf.account_id = ${accountId}
                       WHERE dp.damage_id = d.id), '{}') AS photos
        FROM business_operation_claim_damages d WHERE d.operation_id = ANY(${liste}::bigint[]) ORDER BY d.operation_id, d.sort_order, d.id`);
  const documents = await rows(x, sql`
      SELECT m.operation_id, m.file_id FROM business_operation_documents m
        JOIN asset_files f ON f.id = m.file_id AND f.account_id = ${accountId} AND f.deleted_at IS NULL
       WHERE m.operation_id = ANY(${liste}::bigint[]) AND m.active ORDER BY m.operation_id, m.file_id`);
  const rooms = await rows(x, sql`
      SELECT r.operation_id, s.id, s.name, s.asset_id FROM business_operation_room_links r
        JOIN substructures s ON s.id = r.substructure_id JOIN assets a ON a.id = s.asset_id AND a.account_id = ${accountId}
       WHERE r.operation_id = ANY(${liste}::bigint[]) AND r.active ORDER BY r.operation_id, s.order_index, s.name, s.id`);
  const equipments = await rows(x, sql`
      SELECT l.operation_id, e.id, e.name, e.asset_id FROM business_operation_equipment_links l
        JOIN equipments e ON e.id = l.equipment_id JOIN assets a ON a.id = e.asset_id AND a.account_id = ${accountId}
       WHERE l.operation_id = ANY(${liste}::bigint[]) AND l.active ORDER BY l.operation_id, e.name, e.id`);
  const agenda = await rows(x, sql`
      SELECT ai.business_operation_id AS operation_id, ai.id, ai.title, ai.start_date::text AS date, ai.operation_role AS role
        FROM agenda_items ai
       WHERE ai.business_operation_id = ANY(${liste}::bigint[]) AND ai.account_id = ${accountId}
         AND COALESCE(ai.manual_status, '') <> 'annule'
       ORDER BY ai.business_operation_id, (ai.operation_role IS NOT DISTINCT FROM 'PRINCIPAL') DESC, ai.start_date NULLS LAST, ai.id`);

  return ops.map((o): ClaimRecord => {
    const id = Number(o.id);
    const mine = (r: Row) => Number(r.operation_id) === id;
    const srcCount = (k: string) => sources.filter((s) => mine(s) && s.source_kind === k).reduce((n, s) => n + Number(s.n), 0);
    const cs = comps.filter(mine).map((c) => {
      const amountMinor = Number(c.amount_minor);
      const currency = String(c.currency ?? '');
      return { kind: String(c.kind), amountMinor, currency, amountCents: componentEurMinor({ amountMinor, currency, amountEurCents: num(c.amount_eur_cents) }) };
    });
    // Indemnité connue en euros ; une indemnité non convertible n'est jamais « 0 € » (E09).
    const ownIndemnity = cs.filter((c) => c.kind === 'INDEMNITY' && c.amountCents !== null);
    const chrono = agenda.filter(mine).map((a) => ({ id: Number(a.id), title: String(a.title), date: txt(a.date), role: a.role === 'PRINCIPAL' ? 'PRINCIPAL' as const : 'RELATED' as const }));
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
      damages: damages.filter(mine).map((d) => ({
        itemKey: txt(d.item_key), zone: String(d.zone), element: txt(d.element), finding: txt(d.finding),
        estimatedAmountMinor: num(d.estimated_amount_minor), fileIds: ints(d.files), photoIds: ints(d.photos),
      })),
      documentIds: documents.filter(mine).map((d) => Number(d.file_id)),
      rooms: rooms.filter(mine).map((r) => ({ id: Number(r.id), name: String(r.name), assetId: Number(r.asset_id) })),
      equipments: equipments.filter(mine).map((e) => ({ id: Number(e.id), name: String(e.name), assetId: Number(e.asset_id) })),
      agenda: chrono,
      indemnityCents: ownIndemnity.length ? ownIndemnity.reduce((n, c) => n + (c.amountCents ?? 0), 0) : null,
      costs: claimCosts(cs),
      agendaItemId: chrono[0]?.id ?? null,
      contractLabel: txt(o.contract_label),
      origin: { form: srcCount('CLAIM_FORM') > 0, migration: srcCount('MIGRATION') > 0, documents: srcCount('DOCUMENT') },
    };
  });
}

