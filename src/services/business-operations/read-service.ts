/**
 * BusinessOperationReadService — lectures canoniques des Opérations
 * (CDC Opérations V1 C20.1, C21, C24 NFR-OP-009, B21).
 *
 *   · toujours bornées au compte (C25) : l'Opération d'un autre compte
 *     n'existe pas pour l'appelant ;
 *   · « active » = non invalidée (une Opération fusionnée est invalidée,
 *     contrainte SQL) : jamais renvoyée comme active (B21, INV-042) ;
 *   · lecture par un ancien identifiant : redirection vers l'Opération
 *     CANONIQUE (`merged_into_operation_id`, F-185, INV-043).
 *
 * Aucune écriture. Les consommateurs (T2, T4, TCO, exports, BO diagnostic)
 * seront branchés par les lots suivants.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import type { BusinessOperationStatus, BusinessOperationTypeCode, FinancialComponentKind, SourceKind, SourceRole } from './model';

type Row = Record<string, unknown>;
type Runner = Pick<typeof db, 'execute'>;
const rows = async <T = Row>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Longueur maximale d'une chaîne de redirection suivie (protection contre une donnée corrompue). */
export const MAX_MERGE_REDIRECTS = 10;

export interface BusinessOperationView {
  id: number;
  accountId: number;
  typeCode: BusinessOperationTypeCode | null;
  status: BusinessOperationStatus;
  technicalLabel: string | null;
  parentOperationId: number | null;
  provider: string | null;
  plannedDate: string | null;
  startDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
  closedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  mergedIntoOperationId: number | null;
  lastReconciledAt: string | null;
  version: number;
  active: boolean;
}

const COLUMNS = sql.raw(`id, account_id, type_code, status, technical_label, parent_operation_id, provider,
  planned_date::text AS planned_date, start_date::text AS start_date, realized_date::text AS realized_date,
  end_date::text AS end_date, closed_at::text AS closed_at, invalidated_at::text AS invalidated_at,
  invalidation_reason, merged_into_operation_id, last_reconciled_at::text AS last_reconciled_at, version`);

/** Mêmes colonnes, qualifiées par l'alias `o` (lectures avec jointures). */
const O_COLUMNS = sql.raw(`o.id, o.account_id, o.type_code, o.status, o.technical_label, o.parent_operation_id, o.provider,
  o.planned_date::text AS planned_date, o.start_date::text AS start_date, o.realized_date::text AS realized_date,
  o.end_date::text AS end_date, o.closed_at::text AS closed_at, o.invalidated_at::text AS invalidated_at,
  o.invalidation_reason, o.merged_into_operation_id, o.last_reconciled_at::text AS last_reconciled_at, o.version`);

function toView(r: Row): BusinessOperationView {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    typeCode: (r.type_code as BusinessOperationTypeCode | null) ?? null,
    status: r.status as BusinessOperationStatus,
    technicalLabel: (r.technical_label as string | null) ?? null,
    parentOperationId: num(r.parent_operation_id),
    provider: (r.provider as string | null) ?? null,
    plannedDate: (r.planned_date as string | null) ?? null,
    startDate: (r.start_date as string | null) ?? null,
    realizedDate: (r.realized_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
    closedAt: (r.closed_at as string | null) ?? null,
    invalidatedAt: (r.invalidated_at as string | null) ?? null,
    invalidationReason: (r.invalidation_reason as string | null) ?? null,
    mergedIntoOperationId: num(r.merged_into_operation_id),
    lastReconciledAt: (r.last_reconciled_at as string | null) ?? null,
    version: Number(r.version),
    active: r.invalidated_at === null || r.invalidated_at === undefined,
  };
}

export interface ResolvedOperation {
  operation: BusinessOperationView;
  /** Identifiant demandé, quand il a été redirigé vers la canonique. */
  redirectedFrom: number | null;
}

export interface OperationDetail extends BusinessOperationView {
  sources: Row[];
  assetLinks: Row[];
  equipmentLinks: Row[];
  financialComponents: Row[];
  references: Row[];
  children: number[];
  history: Row[];
}

/** Composante financière active, telle que consolidée par T3 (C12). */
export interface AssistantOperationComponent {
  id: number;
  kind: FinancialComponentKind;
  /** Unités mineures de `currency`, toujours positif (le signe est porté par `kind`). */
  amountMinor: number;
  currency: string;
  /** Contre-valeur EUR explicitement connue (C12.3), sinon null. */
  amountEurCents: number | null;
  economicDate: string | null;
  targetAssetId: number | null;
  label: string | null;
}

/** Document source actif d'une Opération (document non supprimé). */
export interface AssistantOperationDocument {
  fileId: number;
  role: SourceRole | null;
  title: string;
  date: string | null;
  amountCents: number | null;
  documentTypeCode: string | null;
}

/** Opération active lue pour l'assistant (lot 45, `listForAssistant`). */
export interface AssistantOperationRead extends BusinessOperationView {
  contractReference: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  claimStatus: string | null;
  claimType: string | null;
  insurerClaimRef: string | null;
  declaredOn: string | null;
  /** Biens liés par un lien ACTIF (vide : cible non résolue, P08). */
  assetIds: number[];
  components: AssistantOperationComponent[];
  documents: AssistantOperationDocument[];
  /** Natures des sources actives (DOCUMENT, ASSET_DATA, CLAIM_FORM…). */
  sourceKinds: SourceKind[];
}

const pgIntArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const pgTextArray = (v: readonly string[]): string => `{${v.map((x) => `"${String(x).replace(/["\\]/g, '')}"`).join(',')}}`;

export class BusinessOperationReadService {
  constructor(private readonly runner: Runner = db) {}

  /** Opération du compte (redirigée vers la canonique si fusionnée), ou null. */
  async getOperation(accountId: number, id: number, opts: { followMerge?: boolean } = {}): Promise<ResolvedOperation | null> {
    const followMerge = opts.followMerge ?? true;
    let current = id;
    for (let i = 0; i <= MAX_MERGE_REDIRECTS; i++) {
      const [r] = await rows(this.runner, sql`SELECT ${COLUMNS} FROM business_operations WHERE id = ${current} AND account_id = ${accountId}`);
      if (!r) return null;
      const op = toView(r);
      if (!followMerge || op.mergedIntoOperationId === null) {
        return { operation: op, redirectedFrom: current === id ? null : id };
      }
      current = op.mergedIntoOperationId;
    }
    console.error(`[business-operations] chaîne de fusion trop longue depuis ${id} (compte ${accountId}).`);
    return null;
  }

  /** Identifiant canonique (redirection de fusion), ou null si l'Opération n'est pas du compte. */
  async resolveCanonicalId(accountId: number, id: number): Promise<number | null> {
    return (await this.getOperation(accountId, id))?.operation.id ?? null;
  }

  /** Opérations ACTIVES du compte (non invalidées, donc jamais absorbées). */
  async listActiveOperations(accountId: number, filters: {
    assetId?: number; typeCode?: BusinessOperationTypeCode | null; status?: BusinessOperationStatus; limit?: number;
  } = {}): Promise<BusinessOperationView[]> {
    const conds: SQL[] = [sql`o.account_id = ${accountId}`, sql`o.invalidated_at IS NULL`];
    if (filters.typeCode === null) conds.push(sql`o.type_code IS NULL`);
    else if (filters.typeCode) conds.push(sql`o.type_code = ${filters.typeCode}`);
    if (filters.status) conds.push(sql`o.status = ${filters.status}`);
    if (filters.assetId != null) {
      conds.push(sql`EXISTS (SELECT 1 FROM business_operation_asset_links l
                              WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.asset_id = ${filters.assetId} AND l.active)`);
    }
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
    const r = await rows(this.runner, sql`
      SELECT ${COLUMNS} FROM business_operations o WHERE ${sql.join(conds, sql` AND `)}
       ORDER BY COALESCE(o.realized_date, o.start_date, o.planned_date) DESC NULLS LAST, o.id DESC LIMIT ${limit}`);
    return r.map(toView);
  }

  /** Vue complète (diagnostic) : redirigée vers la canonique. */
  async getOperationDetail(accountId: number, id: number): Promise<(OperationDetail & { redirectedFrom: number | null }) | null> {
    const resolved = await this.getOperation(accountId, id);
    if (!resolved) return null;
    const op = resolved.operation;
    const [sources, assetLinks, equipmentLinks, financialComponents, references, children, history] = await Promise.all([
      rows(this.runner, sql`SELECT * FROM business_operation_sources WHERE operation_id = ${op.id} AND account_id = ${accountId} ORDER BY id`),
      rows(this.runner, sql`SELECT * FROM business_operation_asset_links WHERE operation_id = ${op.id} AND account_id = ${accountId} ORDER BY id`),
      rows(this.runner, sql`SELECT * FROM business_operation_equipment_links WHERE operation_id = ${op.id} AND account_id = ${accountId} ORDER BY id`),
      rows(this.runner, sql`
        SELECT c.*, COALESCE((SELECT json_agg(json_build_object('sourceId', s.operation_source_id, 'evidenceRole', s.evidence_role, 'isPrimary', s.is_primary))
                                FROM business_operation_financial_component_sources s WHERE s.component_id = c.id), '[]'::json) AS component_sources
          FROM business_operation_financial_components c WHERE c.operation_id = ${op.id} AND c.account_id = ${accountId} ORDER BY c.id`),
      rows(this.runner, sql`SELECT * FROM business_operation_references WHERE operation_id = ${op.id} AND account_id = ${accountId} ORDER BY id`),
      rows<{ id: string }>(this.runner, sql`SELECT id FROM business_operations WHERE parent_operation_id = ${op.id} AND account_id = ${accountId} ORDER BY id`),
      rows(this.runner, sql`SELECT * FROM business_operation_history WHERE operation_id = ${op.id} AND account_id = ${accountId} ORDER BY id`),
    ]);
    return {
      ...op, redirectedFrom: resolved.redirectedFrom,
      sources, assetLinks, equipmentLinks, financialComponents, references, history,
      children: children.map((c) => Number(c.id)),
    };
  }

  /**
   * Lecture T2 (lot 45, O6 — CDC C15, C15.1, B15) : Opérations ACTIVES d'un
   * périmètre, avec leurs liens biens actifs, composantes financières
   * actives, sources DOCUMENT actives (documents non supprimés) et le détail
   * contrat / sinistre utile à une réponse. Aucun calcul : les montants sont
   * ceux CONSOLIDÉS par T3 (P11, P12, 16.3) ; T2 les additionne selon C17.1.
   *
   *   · `assetIds` : Opérations liées (lien actif) à l'un de ces biens ;
   *     absent : tout le compte ;
   *   · `includeUntargeted` : ajoute les Opérations sans aucun lien bien actif
   *     (question « compte global », F-137 ; exclues d'une question limitée
   *     à un bien, F-136) ;
   *   · bornée (`limit` ≤ 500) et indexée : `business_operations_account_active_idx`,
   *     `business_operation_asset_links_asset_idx`, index `operation_id` des
   *     liens, composantes et sources.
   */
  async listForAssistant(accountId: number, filters: {
    assetIds?: readonly number[] | null;
    /** Identifiants précis (actifs, du compte). */
    ids?: readonly number[];
    typeCodes?: readonly BusinessOperationTypeCode[];
    includeUntargeted?: boolean;
    /** Lot 53D (D12) : seulement les Opérations sans aucun lien bien actif (dépenses hors répartition du compte). */
    untargetedOnly?: boolean;
    limit?: number;
    /** Lot 54D (E02) : pagination par curseur stable (identifiant croissant). */
    afterId?: number;
  } = {}): Promise<AssistantOperationRead[]> {
    const ids = (filters.assetIds ?? []).filter((x) => Number.isSafeInteger(x) && x > 0);
    const conds: SQL[] = [sql`o.account_id = ${accountId}`, sql`o.invalidated_at IS NULL`, sql`o.merged_into_operation_id IS NULL`];
    if (filters.typeCodes?.length) conds.push(sql`o.type_code = ANY(${pgTextArray(filters.typeCodes)}::text[])`);
    if (filters.ids) conds.push(sql`o.id = ANY(${pgIntArray(filters.ids)}::bigint[])`);
    const sansCible = sql`NOT EXISTS (SELECT 1 FROM business_operation_asset_links l0 WHERE l0.operation_id = o.id AND l0.active)`;
    if (filters.untargetedOnly) conds.push(sansCible);
    if (ids.length) {
      const lie = sql`EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active
                               AND l.asset_id = ANY(${pgIntArray(ids)}::int[]))`;
      conds.push(filters.includeUntargeted ? sql`(${lie} OR ${sansCible})` : lie);
    }
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
    const parCurseur = filters.afterId !== undefined;
    if (parCurseur) conds.push(sql`o.id > ${Math.max(0, Math.floor(filters.afterId ?? 0))}`);
    const ordre = parCurseur ? sql`o.id` : sql`COALESCE(o.realized_date, o.start_date, o.planned_date) DESC NULLS LAST, o.id DESC`;
    const ops = await rows(this.runner, sql`
      SELECT ${O_COLUMNS}, cd.contract_reference, cd.effective_from::text AS effective_from, cd.effective_to::text AS effective_to,
             cl.status AS claim_status, cl.insurer_claim_ref, cl.declared_on::text AS declared_on, cl.claim_type
        FROM business_operations o
        LEFT JOIN business_operation_contract_details cd ON cd.operation_id = o.id
        LEFT JOIN business_operation_claim_details cl ON cl.operation_id = o.id
       WHERE ${sql.join(conds, sql` AND `)}
       ORDER BY ${ordre}
       LIMIT ${limit}`);
    if (!ops.length) return [];
    const liste = pgIntArray(ops.map((o) => Number(o.id)));
    // Séquentiel : lecture possible dans une transaction (une connexion).
    const links = await rows(this.runner, sql`
      SELECT operation_id, asset_id FROM business_operation_asset_links
       WHERE operation_id = ANY(${liste}::bigint[]) AND account_id = ${accountId} AND active ORDER BY asset_id`);
    const comps = await rows(this.runner, sql`
      SELECT id, operation_id, kind, amount_minor, currency, amount_eur_cents, economic_date::text AS economic_date,
             target_asset_id, label
        FROM business_operation_financial_components
       WHERE operation_id = ANY(${liste}::bigint[]) AND account_id = ${accountId} AND active ORDER BY id`);
    const docs = await rows(this.runner, sql`
      SELECT s.operation_id, s.source_role, f.id AS file_id, f.amount_cents, f.document_type_code,
             f.document_date::text AS document_date,
             coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title
        FROM business_operation_sources s
        JOIN asset_files f ON f.account_id = s.account_id AND f.id::text = s.source_entity_key AND f.deleted_at IS NULL
       WHERE s.operation_id = ANY(${liste}::bigint[]) AND s.account_id = ${accountId} AND s.active AND s.source_kind = 'DOCUMENT'
       ORDER BY s.id`);
    const kinds = await rows(this.runner, sql`
      SELECT operation_id, array_agg(DISTINCT source_kind ORDER BY source_kind) AS kinds FROM business_operation_sources
       WHERE operation_id = ANY(${liste}::bigint[]) AND account_id = ${accountId} AND active GROUP BY operation_id`);
    return ops.map((o): AssistantOperationRead => {
      const id = Number(o.id);
      const mine = (r: Row) => Number(r.operation_id) === id;
      return {
        ...toView(o),
        contractReference: (o.contract_reference as string | null) ?? null,
        effectiveFrom: (o.effective_from as string | null) ?? null,
        effectiveTo: (o.effective_to as string | null) ?? null,
        claimStatus: (o.claim_status as string | null) ?? null,
        claimType: (o.claim_type as string | null) ?? null,
        insurerClaimRef: (o.insurer_claim_ref as string | null) ?? null,
        declaredOn: (o.declared_on as string | null) ?? null,
        assetIds: links.filter(mine).map((l) => Number(l.asset_id)),
        components: comps.filter(mine).map((c) => ({
          id: Number(c.id),
          kind: String(c.kind) as FinancialComponentKind,
          amountMinor: Number(c.amount_minor),
          currency: String(c.currency).trim().toUpperCase(),
          amountEurCents: num(c.amount_eur_cents),
          economicDate: (c.economic_date as string | null) ?? null,
          targetAssetId: num(c.target_asset_id),
          label: (c.label as string | null) ?? null,
        })),
        documents: docs.filter(mine).map((d) => ({
          fileId: Number(d.file_id),
          role: (d.source_role as SourceRole | null) ?? null,
          title: String(d.title),
          date: (d.document_date as string | null) ?? null,
          amountCents: num(d.amount_cents),
          documentTypeCode: (d.document_type_code as string | null) ?? null,
        })),
        sourceKinds: ((kinds.find(mine)?.kinds as string[] | null) ?? []).map(String) as SourceKind[],
      };
    });
  }

  /**
   * Lot 54D (E02, E07) : TOUTES les Opérations d'un périmètre, par pages de
   * 500 sur un curseur stable (identifiant croissant) jusqu'à épuisement —
   * aucun total calculé sur une lecture tronquée en silence. Garde-fou
   * mémoire `maxRows` (200 000 par défaut) : au-delà, `complete` est faux et
   * l'appelant DOIT signaler une lecture partielle.
   */
  async listAllForAssistant(accountId: number, filters: Omit<NonNullable<Parameters<BusinessOperationReadService['listForAssistant']>[1]>, 'limit' | 'afterId'> = {},
    opts: { pageSize?: number; maxRows?: number } = {}): Promise<{ operations: AssistantOperationRead[]; complete: boolean; pages: number }> {
    const page = Math.min(Math.max(opts.pageSize ?? 500, 1), 500);
    const max = Math.max(opts.maxRows ?? 200_000, 1);
    const out: AssistantOperationRead[] = [];
    let curseur = 0;
    let pages = 0;
    for (;;) {
      const lot = await this.listForAssistant(accountId, { ...filters, limit: page, afterId: curseur });
      pages++;
      out.push(...lot);
      if (lot.length < page) return { operations: out, complete: true, pages };
      if (out.length >= max) return { operations: out, complete: false, pages };
      curseur = lot[lot.length - 1].id;
    }
  }

  /**
   * Lot 53D (D9) : montants CONNUS hors total des Opérations (frais annexes
   * d'un achat, prix documentaire écarté par la saisie) — 0351. Titre du
   * document qui porte le montant (première source DOCUMENT active). Table
   * absente : liste vide (code tolérant).
   */
  async sideAmounts(accountId: number, operationIds: readonly number[]): Promise<Array<{
    operationId: number; nature: string; kind: string; amountMinor: number; currency: string; amountEurCents: number | null; fileId: number | null; title: string | null;
  }>> {
    const ids = operationIds.filter((x) => Number.isSafeInteger(x) && x > 0);
    if (!ids.length) return [];
    const [t] = await rows<{ ok: boolean }>(this.runner, sql`SELECT to_regclass('business_operation_side_amounts') IS NOT NULL AS ok`);
    if (!t?.ok) return [];
    const r = await rows(this.runner, sql`
      SELECT a.operation_id, a.nature, a.kind, a.amount_minor, a.currency, a.amount_eur_cents, f.id AS file_id,
             coalesce(nullif(f.retained_title, ''), f.original_filename) AS title
        FROM business_operation_side_amounts a
        LEFT JOIN LATERAL (
          SELECT f.id, f.retained_title, f.original_filename FROM business_operation_sources s
            JOIN asset_files f ON f.account_id = s.account_id AND f.id::text = s.source_entity_key AND f.deleted_at IS NULL
           WHERE s.id = ANY(a.source_ids) AND s.account_id = a.account_id AND s.active AND s.source_kind = 'DOCUMENT'
           ORDER BY s.id LIMIT 1) f ON TRUE
       WHERE a.account_id = ${accountId} AND a.operation_id = ANY(${pgIntArray(ids)}::bigint[])
       ORDER BY a.operation_id, a.nature, a.id`);
    return r.map((x) => ({
      operationId: Number(x.operation_id), nature: String(x.nature), kind: String(x.kind), amountMinor: Number(x.amount_minor),
      currency: String(x.currency).trim(), amountEurCents: num(x.amount_eur_cents), fileId: num(x.file_id), title: (x.title as string | null) ?? null,
    }));
  }

  /**
   * Documents (parmi `fileIds`) déjà REPRÉSENTÉS par une Opération active du
   * compte (source DOCUMENT active), avec ces Opérations — C15.1 §29-31 :
   * le repli documentaire ne les recompte jamais (F-135), même quand
   * l'Opération ne porte pas encore de montant. Index
   * `business_operation_sources_entity_idx`.
   */
  async representedDocuments(accountId: number, fileIds: readonly number[]): Promise<Map<number, number[]>> {
    const ids = [...new Set(fileIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
    const out = new Map<number, number[]>();
    if (!ids.length) return out;
    const r = await rows<{ key: string; operation_id: string }>(this.runner, sql`
      SELECT s.source_entity_key AS key, s.operation_id
        FROM business_operation_sources s
        JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
       WHERE s.account_id = ${accountId} AND s.source_kind = 'DOCUMENT' AND s.active
         AND s.source_entity_key = ANY(${pgTextArray(ids.map(String))}::text[])
         AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`);
    for (const x of r) {
      const f = Number(x.key);
      out.set(f, [...(out.get(f) ?? []), Number(x.operation_id)]);
    }
    return out;
  }

  /**
   * Pont Opération → documents (lot 45, B15 « Retrouve la facture de… »,
   * F-130) : documents sources actifs des Opérations actives dont le libellé
   * ou le prestataire contient des termes de la question. Borné au compte
   * (et au bien), 20 résultats au plus.
   */
  async findSourceDocumentsByText(accountId: number, terms: readonly string[], opts: { assetId?: number | null } = {}): Promise<Array<{
    fileId: number; operationId: number; typeCode: BusinessOperationTypeCode | null; technicalLabel: string | null; matched: number;
  }>> {
    const mots = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3))].slice(0, 6);
    if (!mots.length) return [];
    const texte = sql`unaccent(lower(coalesce(o.technical_label, '') || ' ' || coalesce(o.provider, '')))`;
    const score = sql.join(mots.map((m) => sql`(CASE WHEN ${texte} LIKE unaccent(${`%${m}%`}) THEN 1 ELSE 0 END)`), sql` + `);
    const bien = opts.assetId != null
      ? sql`AND EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active AND l.asset_id = ${opts.assetId})`
      : sql``;
    const r = await rows(this.runner, sql`
      SELECT * FROM (
        SELECT f.id AS file_id, o.id AS operation_id, o.type_code, o.technical_label, (${score}) AS matched
          FROM business_operations o
          JOIN business_operation_sources s ON s.operation_id = o.id AND s.account_id = o.account_id AND s.active AND s.source_kind = 'DOCUMENT'
          JOIN asset_files f ON f.account_id = o.account_id AND f.id::text = s.source_entity_key AND f.deleted_at IS NULL
         WHERE o.account_id = ${accountId} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL ${bien}
      ) x WHERE x.matched > 0
      ORDER BY x.matched DESC, x.file_id DESC LIMIT 20`);
    return r.map((x) => ({
      fileId: Number(x.file_id), operationId: Number(x.operation_id), typeCode: (x.type_code as BusinessOperationTypeCode | null) ?? null,
      technicalLabel: (x.technical_label as string | null) ?? null, matched: Number(x.matched),
    }));
  }

  /**
   * Opérations actives dont le libellé ou le prestataire contient des termes
   * (« la réparation du TOIT », F-127) — bornées au compte et, si donnés,
   * aux biens ; meilleures correspondances d'abord, 20 au plus.
   */
  async findByText(accountId: number, terms: readonly string[], opts: { assetIds?: readonly number[] | null } = {}): Promise<Array<{ id: number; matched: number }>> {
    const mots = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3))].slice(0, 6);
    if (!mots.length) return [];
    const texte = sql`unaccent(lower(coalesce(o.technical_label, '') || ' ' || coalesce(o.provider, '')))`;
    const score = sql.join(mots.map((m) => sql`(CASE WHEN ${texte} LIKE unaccent(${`%${m}%`}) THEN 1 ELSE 0 END)`), sql` + `);
    const ids = (opts.assetIds ?? []).filter((x) => Number.isSafeInteger(x) && x > 0);
    const bien = ids.length
      ? sql`AND EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active AND l.asset_id = ANY(${pgIntArray(ids)}::int[]))`
      : sql``;
    const r = await rows<{ id: string; matched: number }>(this.runner, sql`
      SELECT * FROM (
        SELECT o.id, (${score}) AS matched FROM business_operations o
         WHERE o.account_id = ${accountId} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL ${bien}
      ) x WHERE x.matched > 0 ORDER BY x.matched DESC, x.id DESC LIMIT 20`);
    return r.map((x) => ({ id: Number(x.id), matched: Number(x.matched) }));
  }

  /** Nombre d'Opérations par type, tous comptes (référentiel BO, C27). */
  async countByType(): Promise<Map<string, number>> {
    const r = await rows<{ code: string; n: number }>(this.runner, sql`
      SELECT type_code AS code, count(*)::int AS n FROM business_operations WHERE type_code IS NOT NULL GROUP BY type_code`);
    return new Map(r.map((x) => [x.code, Number(x.n)]));
  }
}
