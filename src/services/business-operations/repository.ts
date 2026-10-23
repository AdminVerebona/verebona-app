/**
 * BusinessOperationRepository — écritures transactionnelles des Opérations
 * (CDC Opérations V1 C20.1, C21, C24, C25, ch. 22).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRAT
 *
 *   · Construit UNIQUEMENT par `withBusinessOperationWrite` (ou sa variante
 *     dans une transaction existante) : la transaction est ouverte et le
 *     verrou du compte est DÉTENU (NFR-OP-001) ; chaque méthode le vérifie.
 *   · Lié à UN compte : toute Opération, source, bien, équipement, parent ou
 *     contrat visé doit appartenir à ce compte (F-169, F-170, C20.1). Un lien
 *     inter-comptes est une erreur technique (NFR-OP-008), jamais un
 *     « À traiter ».
 *   · Intégrité contrôlée AVANT d'écrire : parent ≠ soi, un parent, profondeur
 *     ≤ 3, pas de cycle, relations C8.1 / C13.1, transitions C8, type nul
 *     admis, OTHER jamais en repli (P18).
 *   · Historise les changements significatifs (10.7) — jamais un appel sans
 *     changement (NFR-OP-005, INV-040) — et accumule les événements C21.1,
 *     publiés APRÈS commit par l'appelant de la transaction.
 *   · Aucune suppression physique d'Opération (ch. 22) : invalidation,
 *     supersession. Une Opération fusionnée n'est plus écrite (redirection
 *     en lecture : `BusinessOperationReadService`).
 *
 * T3 est le seul appelant de `create` (P11) : consolidation des candidats T1
 * depuis le lot 41 (`consolidation/consolidator.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import { BusinessOperationIntegrityError } from './errors';
import { reassignGroupingOnMerge } from './grouping/merge';
import { drizzleRunner } from './grouping/runner';
import type { BusinessOperationEventBuffer } from './events';
import type { DbTx } from './lock';
import {
  ASSET_LINK_ROLES, AUTHORITIES, CLAIM_FILE_STATUSES, CONFIDENCES, CONTRACT_PERIODICITIES, EVIDENCE_ROLES,
  FINANCIAL_COMPONENT_KINDS, MATCH_METHODS, REFERENCE_KINDS, SOURCE_KEY_TABLE, SOURCE_KINDS, SOURCE_ROLES,
  checkHierarchy, checkParentRelation, checkStatusTransition, isBusinessOperationStatus, isIsoCurrency, isIsoDate,
  isMinorAmount, normalizeBusinessReference, resolveOperationTypeInput,
  type AssetLinkRole, type Authority, type BusinessOperationStatus, type BusinessOperationTypeCode, type ClaimFileStatus,
  type Confidence, type ContractPeriodicity, type EvidenceRole, type FinancialComponentKind, type HistoryEventType,
  type MatchMethod, type OperationTypeInput, type ReferenceKind, type SourceKind, type SourceRole, type StatusTransitionReason,
} from './model';

// ── Lignes ──────────────────────────────────────────────────────────────────

export interface OperationRow {
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
  version: number;
}

export interface WriteContext {
  correlationId: string;
  actorUserId: number | null;
}

// ── Entrées ─────────────────────────────────────────────────────────────────

export interface SourceInput {
  kind: SourceKind;
  /** Identifiant stable de l'objet source (convention : `SOURCE_KEY_TABLE`). */
  entityKey: string | number;
  version?: string | null;
  role?: SourceRole | null;
  locator?: Record<string, unknown>;
  authority: Authority;
  confidence?: Confidence | null;
  matchMethod?: MatchMethod | null;
  matchReason?: string | null;
}

export interface AssetLinkInput {
  assetId: number;
  role?: AssetLinkRole;
  authority: Authority;
  sourceId?: number | null;
}

export interface EquipmentLinkInput {
  equipmentId: number;
  authority: Authority;
  sourceId?: number | null;
}

export interface OperationDatesInput {
  plannedDate?: string | null;
  startDate?: string | null;
  realizedDate?: string | null;
  endDate?: string | null;
  provider?: string | null;
  technicalLabel?: string | null;
}

export interface CreateOperationInput extends OperationDatesInput {
  type: OperationTypeInput;
  status: BusinessOperationStatus;
  parentOperationId?: number | null;
  /** Première source, obligatoire : une Opération n'existe jamais sans source (INV-FINAL-006). */
  source: SourceInput;
  assets?: AssetLinkInput[];
  equipments?: EquipmentLinkInput[];
  reasonCode: string;
}

export interface FinancialComponentInput {
  kind: FinancialComponentKind;
  amountMinor: number;
  currency: string;
  amountEurCents?: number | null;
  economicDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  targetAssetId?: number | null;
  targetEquipmentId?: number | null;
  label?: string | null;
  fingerprint?: string | null;
  /** Au moins une source ACTIVE de la même Opération (anomalie dure sinon, C26.2). */
  sources: Array<{ sourceId: number; evidenceRole?: EvidenceRole; isPrimary?: boolean }>;
}

export interface ContractDetailsInput {
  contractReference?: string | null;
  periodicity?: ContractPeriodicity | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface FinancingDetailsInput {
  financingReference?: string | null;
  lender?: string | null;
  principalAmountMinor?: number | null;
  principalCurrency?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface ClaimDetailsInput {
  claimType?: string | null;
  declaredOn?: string | null;
  insurerClaimRef?: string | null;
  insuranceContractOperationId?: number | null;
  policyReferenceText?: string | null;
  status?: ClaimFileStatus | null;
  statusDetail?: string | null;
  circumstances?: string | null;
  consequences?: string | null;
  measuresSummary?: string | null;
  exchangesSummary?: string | null;
  estimatedDamageMinor?: number | null;
  /** Lot 44 : événement de l'HISTORIQUE (`events.id`) choisi comme ancre ; un élément d'agenda est lié par `agenda_items.business_operation_id`. */
  historyEventId?: number | null;
}

/** Lot 44 — listes structurées du Sinistre (C14) : une ligne n'est jamais une Opération. */
export interface ClaimDamageInput {
  itemKey: string | null;
  zone: string;
  element: string | null;
  finding: string | null;
  estimatedAmountMinor: number | null;
  fileIds: number[];
  photoIds: number[];
}

export interface ClaimActionInput {
  itemKey: string | null;
  date: string | null;
  endDate: string | null;
  status: 'REALISEE' | 'EN_COURS' | 'A_REALISER' | null;
  title: string;
  detail: string | null;
  performedBy: string | null;
  invoiceFileId: number | null;
  /** INTERVENTION enfant rapprochée par la facture (C14.2). */
  childOperationId: number | null;
}

export interface ClaimExchangeInput {
  itemKey: string | null;
  date: string | null;
  party: 'ASSUREUR' | 'EXPERT' | 'AUTRE' | null;
  channel: 'EMAIL' | 'COURRIER' | 'TELEPHONE' | 'ESPACE_CLIENT' | 'RENDEZ_VOUS' | 'AUTRE' | null;
  direction: 'RECU' | 'ENVOYE' | null;
  summary: string;
  documentFileId: number | null;
}

export interface ClaimListsInput {
  damages: ClaimDamageInput[];
  actions: ClaimActionInput[];
  exchanges: ClaimExchangeInput[];
}

// ── Outils ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

async function rows<T = Row>(tx: DbTx, q: SQL): Promise<T[]> {
  return (await tx.execute(q)) as unknown as T[];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const OPERATION_COLUMNS = sql.raw(`id, account_id, type_code, status, technical_label, parent_operation_id, provider,
  planned_date::text AS planned_date, start_date::text AS start_date, realized_date::text AS realized_date,
  end_date::text AS end_date, closed_at::text AS closed_at, invalidated_at::text AS invalidated_at,
  invalidation_reason, merged_into_operation_id, version`);

function toOperation(r: Row): OperationRow {
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
    version: Number(r.version),
  };
}

function oneOf<T extends string>(list: readonly T[], v: unknown, code: 'INVALID_SOURCE' | 'INVALID_DETAILS' | 'INVALID_REFERENCE', label: string): T {
  if (typeof v === 'string' && (list as readonly string[]).includes(v)) return v as T;
  throw new BusinessOperationIntegrityError(code, `${label} invalide : ${String(v)}.`);
}

function optionalDate(v: string | null | undefined, label: string): string | null {
  if (v === undefined || v === null) return null;
  if (!isIsoDate(v)) throw new BusinessOperationIntegrityError('INVALID_DATE', `${label} invalide : ${v} (AAAA-MM-JJ).`);
  return v;
}

function positiveKey(v: string, label: string): number {
  if (!/^[1-9]\d*$/.test(v)) throw new BusinessOperationIntegrityError('INVALID_SOURCE', `${label} : identifiant numérique attendu (« ${v} »).`);
  return Number(v);
}

const DATE_FIELDS = [
  ['plannedDate', 'planned_date'], ['startDate', 'start_date'], ['realizedDate', 'realized_date'], ['endDate', 'end_date'],
] as const;
const TEXT_FIELDS = [['provider', 'provider'], ['technicalLabel', 'technical_label']] as const;

// ═══════════════════════════════════════════════════════════════════════════

export class BusinessOperationRepository {
  constructor(
    private readonly tx: DbTx,
    readonly accountId: number,
    private readonly lockedAccounts: ReadonlySet<number>,
    private readonly events: BusinessOperationEventBuffer,
    private readonly ctx: WriteContext,
  ) {
    if (!lockedAccounts.has(accountId)) {
      throw new BusinessOperationIntegrityError('LOCK_NOT_HELD', `Verrou du compte ${accountId} non détenu (NFR-OP-001).`);
    }
  }

  // ── Lecture interne (sous verrou) ────────────────────────────────────────

  /** Opération du compte, verrouillée en écriture. */
  async load(id: number, opts: { allowInactive?: boolean; allowMerged?: boolean } = {}): Promise<OperationRow> {
    const [r] = await rows(this.tx, sql`SELECT ${OPERATION_COLUMNS} FROM business_operations WHERE id = ${id} FOR UPDATE`);
    if (!r) throw new BusinessOperationIntegrityError('OPERATION_NOT_FOUND', `Opération ${id} introuvable.`);
    const op = toOperation(r);
    if (op.accountId !== this.accountId) {
      throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Opération ${id} d'un autre compte (compte courant ${this.accountId}).`);
    }
    if (op.mergedIntoOperationId !== null && !opts.allowMerged) {
      throw new BusinessOperationIntegrityError('OPERATION_MERGED', `Opération ${id} fusionnée dans ${op.mergedIntoOperationId} : écrire sur la canonique.`);
    }
    if (op.invalidatedAt !== null && !opts.allowInactive && op.mergedIntoOperationId === null) {
      throw new BusinessOperationIntegrityError('OPERATION_INACTIVE', `Opération ${id} invalidée : la réactiver d'abord.`);
    }
    return op;
  }

  /** Opérations ACTIVES du compte prouvées par une source active (trouver avant de créer, P04). */
  async findActiveBySource(kind: SourceKind, entityKey: string | number): Promise<number[]> {
    const r = await rows<{ id: string }>(this.tx, sql`
      SELECT DISTINCT o.id FROM business_operation_sources s
        JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
       WHERE s.account_id = ${this.accountId} AND s.active AND s.source_kind = ${kind}
         AND s.source_entity_key = ${String(entityKey)} AND o.invalidated_at IS NULL
       ORDER BY o.id`);
    return r.map((x) => Number(x.id));
  }

  // ── Création (NFR-OP-002 : Opération + première source + cibles atomiques) ──

  async create(input: CreateOperationInput): Promise<{ id: number; sourceId: number }> {
    const typeCode = resolveOperationTypeInput(input.type);
    if (!isBusinessOperationStatus(input.status)) {
      throw new BusinessOperationIntegrityError('INVALID_STATUS', `Statut invalide : ${String(input.status)}.`);
    }
    if (!input.source) throw new BusinessOperationIntegrityError('SOURCE_REQUIRED', 'Une Opération n\'existe jamais sans source (INV-FINAL-006).');
    const dates = Object.fromEntries(DATE_FIELDS.map(([k]) => [k, optionalDate(input[k], k)])) as Record<(typeof DATE_FIELDS)[number][0], string | null>;

    let parent: OperationRow | null = null;
    if (input.parentOperationId != null) {
      parent = await this.loadParent(input.parentOperationId);
      checkParentRelation(typeCode, parent.typeCode);
      checkHierarchy(-1, await this.ancestors(parent.id), 1);
    }

    const [ins] = await rows<{ id: string }>(this.tx, sql`
      INSERT INTO business_operations
        (account_id, type_code, status, technical_label, parent_operation_id, provider,
         planned_date, start_date, realized_date, end_date)
      VALUES (${this.accountId}, ${typeCode}, ${input.status}, ${input.technicalLabel ?? null}, ${parent?.id ?? null},
              ${input.provider ?? null}, ${dates.plannedDate}::date, ${dates.startDate}::date,
              ${dates.realizedDate}::date, ${dates.endDate}::date)
      RETURNING id`);
    const id = Number(ins.id);
    const sourceId = await this.insertSource(id, input.source);
    // Une cible sans provenance explicite est apportée par la première source (C10, provenance).
    for (const a of input.assets ?? []) await this.linkAssetInternal(id, { ...a, sourceId: a.sourceId ?? sourceId }, { history: false });
    for (const e of input.equipments ?? []) await this.linkEquipmentInternal(id, { ...e, sourceId: e.sourceId ?? sourceId }, { history: false });

    await this.history(id, 'CREATED', input.reasonCode, null, {
      type_code: typeCode, status: input.status, parent_operation_id: parent?.id ?? null,
      planned_date: dates.plannedDate, start_date: dates.startDate, realized_date: dates.realizedDate, end_date: dates.endDate,
      provider: input.provider ?? null, technical_label: input.technicalLabel ?? null,
      assets: (input.assets ?? []).map((a) => a.assetId), equipments: (input.equipments ?? []).map((e) => e.equipmentId),
    }, sourceId);
    this.emit('BUSINESS_OPERATION_CREATED', id, input.reasonCode);
    return { id, sourceId };
  }

  // ── Qualification et cycle de vie ────────────────────────────────────────

  /** Type : null admis ; OTHER seulement qualifié (P18) ; relations parent / enfant revérifiées. */
  async setType(id: number, type: OperationTypeInput, reasonCode: string): Promise<boolean> {
    const op = await this.load(id);
    const next = resolveOperationTypeInput(type);
    if (next === op.typeCode) return false;
    if (op.parentOperationId !== null) {
      const parent = await this.load(op.parentOperationId, { allowInactive: true });
      checkParentRelation(next, parent.typeCode);
    }
    const children = await rows<{ type_code: BusinessOperationTypeCode | null }>(this.tx, sql`
      SELECT type_code FROM business_operations
       WHERE parent_operation_id = ${id} AND account_id = ${this.accountId} AND merged_into_operation_id IS NULL`);
    for (const c of children) checkParentRelation(c.type_code, next);
    for (const [kind, table] of [['CONTRACT', 'business_operation_contract_details'], ['FINANCING', 'business_operation_financing_details'], ['CLAIM', 'business_operation_claim_details']] as const) {
      if (next === kind) continue;
      const [d] = await rows(this.tx, sql`SELECT 1 FROM ${sql.identifier(table)} WHERE operation_id = ${id}`);
      if (d) throw new BusinessOperationIntegrityError('DETAILS_TYPE_MISMATCH', `Détails ${kind} présents : les retirer avant de requalifier en ${next ?? 'type nul'}.`);
    }
    await this.tx.execute(sql`UPDATE business_operations SET type_code = ${next}, version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'TYPE_CHANGED', reasonCode, { type_code: op.typeCode }, { type_code: next });
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  /**
   * Statut (C8) : ENVISAGED / REALIZED / CANCELLED. Aucune propagation aux
   * enfants (PARENT-007, PARENT-009) ; `closed_at` et `invalidated_at`
   * restent orthogonaux.
   */
  async setStatus(id: number, status: BusinessOperationStatus, opts: { reasonCode: string; transition?: StatusTransitionReason; sourceId?: number | null }): Promise<boolean> {
    if (!isBusinessOperationStatus(status)) throw new BusinessOperationIntegrityError('INVALID_STATUS', `Statut invalide : ${String(status)}.`);
    const op = await this.load(id);
    if (checkStatusTransition(op.status, status, opts.transition) === 'NOOP') return false;
    if (opts.sourceId != null) await this.loadSource(id, opts.sourceId);
    await this.tx.execute(sql`UPDATE business_operations SET status = ${status}, version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'STATUS_CHANGED', opts.reasonCode, { status: op.status }, { status }, opts.sourceId ?? null);
    this.emit('BUSINESS_OPERATION_UPDATED', id, opts.reasonCode);
    return true;
  }

  /** Dates métier, prestataire, libellé technique : seuls les champs fournis et réellement changés. */
  async updateAttributes(id: number, input: OperationDatesInput, reasonCode: string): Promise<boolean> {
    const op = await this.load(id);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const sets: SQL[] = [];
    for (const [k, col] of DATE_FIELDS) {
      if (!(k in input)) continue;
      const v = optionalDate(input[k], k);
      if (v === op[k]) continue;
      before[col] = op[k];
      after[col] = v;
      sets.push(sql`${sql.identifier(col)} = ${v}::date`);
    }
    for (const [k, col] of TEXT_FIELDS) {
      if (!(k in input)) continue;
      const v = input[k] ?? null;
      if (v === op[k]) continue;
      before[col] = op[k];
      after[col] = v;
      sets.push(sql`${sql.identifier(col)} = ${v}`);
    }
    if (sets.length === 0) return false;
    await this.tx.execute(sql`UPDATE business_operations SET ${sql.join(sets, sql`, `)}, version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'UPDATED', reasonCode, before, after);
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  /** Clôture de traitement (dossier, relation) — distincte du statut (5, C14.1). */
  async close(id: number, reasonCode: string, at: Date = new Date()): Promise<boolean> {
    const op = await this.load(id);
    if (op.closedAt !== null) return false;
    await this.tx.execute(sql`UPDATE business_operations SET closed_at = ${at.toISOString()}::timestamptz, version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'UPDATED', reasonCode, { closed_at: null }, { closed_at: at.toISOString() });
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  async reopen(id: number, reasonCode: string): Promise<boolean> {
    const op = await this.load(id);
    if (op.closedAt === null) return false;
    await this.tx.execute(sql`UPDATE business_operations SET closed_at = NULL, version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'UPDATED', reasonCode, { closed_at: op.closedAt }, { closed_at: null });
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  /** Invalidation logique (≠ CANCELLED, C8) : l'Opération n'est plus consommée. */
  async invalidate(id: number, reasonCode: string): Promise<boolean> {
    const op = await this.load(id, { allowInactive: true });
    if (op.invalidatedAt !== null) return false;
    await this.tx.execute(sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = ${reasonCode}, version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'INVALIDATED', reasonCode, { invalidated_at: null }, { invalidation_reason: reasonCode });
    this.emit('BUSINESS_OPERATION_INVALIDATED', id, reasonCode);
    return true;
  }

  /** Réactivation (même identité redevenue prouvée, C8) : exige une source active. */
  async reactivate(id: number, reasonCode: string): Promise<boolean> {
    const op = await this.load(id, { allowInactive: true });
    if (op.invalidatedAt === null) return false;
    if (!(await this.hasSupportingSource(id))) {
      throw new BusinessOperationIntegrityError('SOURCE_REQUIRED', `Opération ${id} : aucune source active, réactivation impossible (INV-FINAL-006).`);
    }
    await this.tx.execute(sql`UPDATE business_operations SET invalidated_at = NULL, invalidation_reason = NULL, version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'REACTIVATED', reasonCode, { invalidation_reason: op.invalidationReason }, { invalidated_at: null });
    this.emit('BUSINESS_OPERATION_REACTIVATED', id, reasonCode);
    return true;
  }

  /** Invalide une Opération active qui n'a plus aucune source active (C8, INV-FINAL-006). */
  async invalidateIfUnsupported(id: number, reasonCode: string): Promise<boolean> {
    const op = await this.load(id, { allowInactive: true, allowMerged: true });
    if (op.invalidatedAt !== null) return false;
    if (await this.hasSupportingSource(id)) return false;
    return this.invalidate(id, reasonCode);
  }

  /** Dernier passage T3 effectif : ni historique, ni version (NFR-OP-005). */
  async markReconciled(id: number): Promise<void> {
    await this.load(id, { allowInactive: true });
    await this.tx.execute(sql`UPDATE business_operations SET last_reconciled_at = now() WHERE id = ${id}`);
  }

  // ── Parent / enfant (C8.1) ───────────────────────────────────────────────

  async setParent(id: number, parentId: number | null, reasonCode: string): Promise<boolean> {
    const op = await this.load(id);
    if (parentId === op.parentOperationId) return false;
    if (parentId !== null) {
      if (parentId === id) throw new BusinessOperationIntegrityError('PARENT_SELF', 'Une Opération ne peut pas être son propre parent (C20.1).');
      const parent = await this.loadParent(parentId);
      checkParentRelation(op.typeCode, parent.typeCode);
      checkHierarchy(id, await this.ancestors(parent.id), await this.subtreeHeight(id));
    }
    await this.tx.execute(sql`UPDATE business_operations SET parent_operation_id = ${parentId}, version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'PARENT_CHANGED', reasonCode, { parent_operation_id: op.parentOperationId }, { parent_operation_id: parentId });
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  private async loadParent(parentId: number): Promise<OperationRow> {
    const parent = await this.load(parentId, { allowInactive: true, allowMerged: true }).catch((e: unknown) => {
      if (e instanceof BusinessOperationIntegrityError && e.code === 'OPERATION_NOT_FOUND') {
        throw new BusinessOperationIntegrityError('OPERATION_NOT_FOUND', `Parent ${parentId} introuvable.`);
      }
      throw e;
    });
    if (parent.mergedIntoOperationId !== null) {
      throw new BusinessOperationIntegrityError('OPERATION_MERGED', `Parent ${parentId} fusionné dans ${parent.mergedIntoOperationId}.`);
    }
    if (parent.invalidatedAt !== null) throw new BusinessOperationIntegrityError('PARENT_INACTIVE', `Parent ${parentId} invalidé.`);
    return parent;
  }

  /** Chaîne parent → racine (parent compris), bornée : un cycle préexistant ne boucle pas. */
  private async ancestors(parentId: number): Promise<number[]> {
    const r = await rows<{ id: string }>(this.tx, sql`
      WITH RECURSIVE chaine(id, parent, n) AS (
        SELECT id, parent_operation_id, 1 FROM business_operations WHERE id = ${parentId} AND account_id = ${this.accountId}
        UNION ALL
        SELECT o.id, o.parent_operation_id, c.n + 1 FROM business_operations o
          JOIN chaine c ON o.id = c.parent WHERE c.n < 10 AND o.account_id = ${this.accountId}
      ) SELECT id FROM chaine ORDER BY n`);
    return r.map((x) => Number(x.id));
  }

  /** Niveaux du sous-arbre (Opération comprise, ≥ 1). */
  private async subtreeHeight(id: number): Promise<number> {
    const [r] = await rows<{ h: number }>(this.tx, sql`
      WITH RECURSIVE sous(id, n) AS (
        SELECT ${id}::bigint, 1
        UNION ALL
        SELECT o.id, s.n + 1 FROM business_operations o
          JOIN sous s ON o.parent_operation_id = s.id
         WHERE s.n < 10 AND o.account_id = ${this.accountId} AND o.merged_into_operation_id IS NULL
      ) SELECT max(n)::int AS h FROM sous`);
    return Number(r?.h ?? 1);
  }

  // ── Sources (C2, C9) ─────────────────────────────────────────────────────

  /** Ajoute une source (idempotent : la même source active n'est jamais dupliquée). */
  async addSource(id: number, input: SourceInput, reasonCode = 'SOURCE_ADDED'): Promise<number> {
    const op = await this.load(id, { allowInactive: true });
    const existing = await this.findSameActiveSource(op.id, input);
    if (existing !== null) return existing;
    const sourceId = await this.insertSource(op.id, input);
    await this.history(op.id, 'SOURCE_ADDED', reasonCode, null, { source_kind: input.kind, source_entity_key: String(input.entityKey), source_role: input.role ?? null }, sourceId);
    this.emit('BUSINESS_OPERATION_UPDATED', op.id, reasonCode);
    return sourceId;
  }

  /** Retire une contribution (supersession) ; l'Opération n'est pas invalidée ici (voir `invalidateIfUnsupported`). */
  async deactivateSource(sourceId: number, reasonCode: string): Promise<boolean> {
    const [s] = await rows<{ operation_id: string; account_id: number; active: boolean; source_kind: string; source_entity_key: string }>(this.tx, sql`
      SELECT operation_id, account_id, active, source_kind, source_entity_key FROM business_operation_sources WHERE id = ${sourceId}`);
    if (!s) throw new BusinessOperationIntegrityError('SOURCE_NOT_FOUND', `Source ${sourceId} introuvable.`);
    if (Number(s.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Source ${sourceId} d'un autre compte.`);
    if (!s.active) return false;
    const opId = Number(s.operation_id);
    await this.load(opId, { allowInactive: true, allowMerged: true });
    await this.tx.execute(sql`UPDATE business_operation_sources SET active = false, superseded_at = now() WHERE id = ${sourceId}`);
    await this.history(opId, 'SOURCE_REMOVED', reasonCode, { source_kind: s.source_kind, source_entity_key: s.source_entity_key }, null, sourceId);
    this.emit('BUSINESS_OPERATION_UPDATED', opId, reasonCode);
    return true;
  }

  private async hasActiveSource(id: number): Promise<boolean> {
    const [r] = await rows(this.tx, sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${id} AND account_id = ${this.accountId} AND active LIMIT 1`);
    return !!r;
  }

  /**
   * Source active qui JUSTIFIE l'existence (lot 42) : une décision utilisateur
   * de rattachement (parent Sinistre, montant retenu — `USER_ARBITRATION`
   * avec `locator.decision`) éclaire l'Opération mais ne la prouve pas.
   */
  private async hasSupportingSource(id: number): Promise<boolean> {
    const [r] = await rows(this.tx, sql`
      SELECT 1 FROM business_operation_sources WHERE operation_id = ${id} AND account_id = ${this.accountId} AND active
         AND NOT (source_kind = 'USER_ARBITRATION' AND locator ? 'decision') LIMIT 1`);
    return !!r;
  }

  private validateSource(input: SourceInput): { key: string; locator: Record<string, unknown> } {
    oneOf(SOURCE_KINDS, input.kind, 'INVALID_SOURCE', 'Nature de source');
    oneOf(AUTHORITIES, input.authority, 'INVALID_SOURCE', 'Autorité');
    if (input.role != null) oneOf(SOURCE_ROLES, input.role, 'INVALID_SOURCE', 'Rôle de source');
    if (input.confidence != null) oneOf(CONFIDENCES, input.confidence, 'INVALID_SOURCE', 'Confiance');
    if (input.matchMethod != null) oneOf(MATCH_METHODS, input.matchMethod, 'INVALID_SOURCE', 'Méthode de rapprochement');
    const key = String(input.entityKey ?? '').trim();
    if (!key) throw new BusinessOperationIntegrityError('INVALID_SOURCE', 'Identifiant de source vide.');
    const locator = input.locator ?? {};
    if (typeof locator !== 'object' || Array.isArray(locator)) throw new BusinessOperationIntegrityError('INVALID_SOURCE', 'Locator : objet attendu.');
    return { key, locator };
  }

  /** L'objet source existe et appartient au compte (C25 : « source du même compte »). */
  private async checkSourceTarget(kind: SourceKind, key: string): Promise<void> {
    const table = SOURCE_KEY_TABLE[kind];
    if (table === null) return;
    const id = positiveKey(key, `Source ${kind}`);
    let r: Array<{ account_id: number | null; gone: boolean }>;
    switch (kind) {
      case 'DOCUMENT':
        r = await rows(this.tx, sql`SELECT account_id, deleted_at IS NOT NULL AS gone FROM asset_files WHERE id = ${id}`);
        break;
      case 'ASSET_DATA':
      case 'CLAIM_FORM':
        r = await rows(this.tx, sql`SELECT account_id, deleted_at IS NOT NULL AS gone FROM assets WHERE id = ${id}`);
        break;
      case 'EQUIPMENT_DATA':
        r = await rows(this.tx, sql`SELECT a.account_id, a.deleted_at IS NOT NULL AS gone FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE e.id = ${id}`);
        break;
      default:
        r = await rows(this.tx, sql`SELECT account_id, false AS gone FROM ${sql.identifier(table)} WHERE id = ${id}`);
    }
    const t = r[0];
    if (!t || t.gone) throw new BusinessOperationIntegrityError('SOURCE_TARGET_NOT_FOUND', `Source ${kind} ${key} introuvable.`);
    if (Number(t.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Source ${kind} ${key} d'un autre compte.`);
  }

  private async findSameActiveSource(opId: number, input: SourceInput): Promise<number | null> {
    const { key, locator } = this.validateSource(input);
    const [r] = await rows<{ id: string }>(this.tx, sql`
      SELECT id FROM business_operation_sources
       WHERE operation_id = ${opId} AND active AND source_kind = ${input.kind} AND source_entity_key = ${key}
         AND COALESCE(source_role, '') = ${input.role ?? ''} AND md5(locator::text) = md5((${JSON.stringify(locator)}::jsonb)::text)
       LIMIT 1`);
    return r ? Number(r.id) : null;
  }

  private async insertSource(opId: number, input: SourceInput): Promise<number> {
    const { key, locator } = this.validateSource(input);
    await this.checkSourceTarget(input.kind, key);
    const [r] = await rows<{ id: string }>(this.tx, sql`
      INSERT INTO business_operation_sources
        (account_id, operation_id, source_kind, source_entity_key, source_version, source_role, locator,
         authority, confidence, match_method, match_reason)
      VALUES (${this.accountId}, ${opId}, ${input.kind}, ${key}, ${input.version ?? null}, ${input.role ?? null},
              ${JSON.stringify(locator)}::jsonb, ${input.authority}, ${input.confidence ?? null},
              ${input.matchMethod ?? null}, ${input.matchReason ?? null})
      RETURNING id`);
    return Number(r.id);
  }

  private async loadSource(opId: number, sourceId: number): Promise<void> {
    const [s] = await rows<{ operation_id: string; account_id: number; active: boolean }>(this.tx, sql`
      SELECT operation_id, account_id, active FROM business_operation_sources WHERE id = ${sourceId}`);
    if (!s) throw new BusinessOperationIntegrityError('SOURCE_NOT_FOUND', `Source ${sourceId} introuvable.`);
    if (Number(s.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Source ${sourceId} d'un autre compte.`);
    if (Number(s.operation_id) !== opId || !s.active) {
      throw new BusinessOperationIntegrityError('INVALID_SOURCE', `Source ${sourceId} : pas une source active de l'Opération ${opId}.`);
    }
  }

  // ── Biens et équipements (C10) ───────────────────────────────────────────

  async linkAsset(id: number, input: AssetLinkInput, reasonCode = 'ASSET_LINKED'): Promise<boolean> {
    await this.load(id);
    return this.linkAssetInternal(id, input, { history: true, reasonCode });
  }

  private async linkAssetInternal(id: number, input: AssetLinkInput, opts: { history: boolean; reasonCode?: string }): Promise<boolean> {
    const role = oneOf(ASSET_LINK_ROLES, input.role ?? 'CONCERNED', 'INVALID_SOURCE', 'Rôle du bien');
    oneOf(AUTHORITIES, input.authority, 'INVALID_SOURCE', 'Autorité');
    const [a] = await rows<{ account_id: number | null; gone: boolean }>(this.tx, sql`
      SELECT account_id, deleted_at IS NOT NULL AS gone FROM assets WHERE id = ${input.assetId}`);
    if (!a || a.gone) throw new BusinessOperationIntegrityError('ASSET_NOT_FOUND', `Bien ${input.assetId} introuvable.`);
    if (Number(a.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Bien ${input.assetId} d'un autre compte.`);
    if (input.sourceId != null) await this.loadSource(id, input.sourceId);

    const [cur] = await rows<{ id: string; active: boolean; link_role: string }>(this.tx, sql`
      SELECT id, active, link_role FROM business_operation_asset_links WHERE operation_id = ${id} AND asset_id = ${input.assetId}`);
    if (cur && cur.active && cur.link_role === role) return false;
    if (role === 'PRIMARY') {
      await this.tx.execute(sql`
        UPDATE business_operation_asset_links SET link_role = 'CONCERNED', updated_at = now()
         WHERE operation_id = ${id} AND active AND link_role = 'PRIMARY' AND asset_id <> ${input.assetId}`);
    }
    if (cur) {
      await this.tx.execute(sql`
        UPDATE business_operation_asset_links
           SET active = true, link_role = ${role}, authority = ${input.authority},
               source_operation_source_id = COALESCE(${input.sourceId ?? null}::bigint, source_operation_source_id), updated_at = now()
         WHERE id = ${Number(cur.id)}`);
    } else {
      await this.tx.execute(sql`
        INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, source_operation_source_id)
        VALUES (${this.accountId}, ${id}, ${input.assetId}, ${role}, ${input.authority}, ${input.sourceId ?? null})`);
    }
    if (opts.history) {
      await this.history(id, 'TARGET_CHANGED', opts.reasonCode ?? 'ASSET_LINKED',
        cur ? { asset_id: input.assetId, active: cur.active, link_role: cur.link_role } : null,
        { asset_id: input.assetId, active: true, link_role: role }, input.sourceId ?? null);
      this.emit('BUSINESS_OPERATION_TARGET_CHANGED', id, opts.reasonCode ?? 'ASSET_LINKED');
    }
    return true;
  }

  /** Retire un bien (et ses équipements, et les attributions de composantes qui le visent). */
  async unlinkAsset(id: number, assetId: number, reasonCode: string): Promise<boolean> {
    await this.load(id, { allowInactive: true });
    return this.detachAsset(id, assetId, reasonCode);
  }

  /**
   * Détache un bien d'une Opération du compte : liens bien et équipements du
   * bien désactivés, attributions de composantes au bien ou à ses équipements
   * retirées (la part redevient globale, C10 : jamais de ventilation
   * inventée). Historisé. Utilisé par le transfert et la suppression du bien.
   */
  async detachAsset(id: number, assetId: number, reasonCode: string): Promise<boolean> {
    let changed = false;
    const links = await rows<{ id: string; link_role: string }>(this.tx, sql`
      UPDATE business_operation_asset_links SET active = false, updated_at = now()
       WHERE operation_id = ${id} AND account_id = ${this.accountId} AND asset_id = ${assetId} AND active
      RETURNING id, link_role`);
    const equip = await rows<{ equipment_id: number }>(this.tx, sql`
      UPDATE business_operation_equipment_links SET active = false, updated_at = now()
       WHERE operation_id = ${id} AND account_id = ${this.accountId} AND asset_id = ${assetId} AND active
      RETURNING equipment_id`);
    // Lot 82D (0655) : les Pièces du bien quittent l'Opération avec lui.
    const pieces = await rows<{ substructure_id: number }>(this.tx, sql`
      UPDATE business_operation_room_links SET active = false, updated_at = now()
       WHERE operation_id = ${id} AND account_id = ${this.accountId} AND asset_id = ${assetId} AND active
      RETURNING substructure_id`);
    if (links.length || equip.length || pieces.length) {
      changed = true;
      await this.history(id, 'TARGET_CHANGED', reasonCode,
        { asset_id: assetId, active: true, equipments: equip.map((e) => e.equipment_id), ...(pieces.length ? { rooms: pieces.map((p) => p.substructure_id) } : {}) },
        { asset_id: assetId, active: false });
      this.emit('BUSINESS_OPERATION_TARGET_CHANGED', id, reasonCode);
    }
    const comps = await rows<{ id: string; target_asset_id: number | null; target_equipment_id: number | null }>(this.tx, sql`
      WITH avant AS (
        SELECT c.id, c.target_asset_id, c.target_equipment_id FROM business_operation_financial_components c
         WHERE c.operation_id = ${id} AND c.account_id = ${this.accountId}
           AND (c.target_asset_id = ${assetId}
                OR c.target_equipment_id IN (SELECT e.id FROM equipments e WHERE e.asset_id = ${assetId}))
         FOR UPDATE
      )
      UPDATE business_operation_financial_components c
         SET target_asset_id = CASE WHEN c.target_asset_id = ${assetId} THEN NULL ELSE c.target_asset_id END,
             target_equipment_id = CASE WHEN c.target_equipment_id IN (SELECT e.id FROM equipments e WHERE e.asset_id = ${assetId}) THEN NULL ELSE c.target_equipment_id END,
             updated_at = now()
        FROM avant WHERE c.id = avant.id
      RETURNING c.id, avant.target_asset_id, avant.target_equipment_id`);
    if (comps.length) {
      changed = true;
      await this.history(id, 'FINANCIAL_CHANGED', reasonCode,
        { components: comps.map((c) => ({ id: Number(c.id), target_asset_id: c.target_asset_id, target_equipment_id: c.target_equipment_id })) },
        { components: comps.map((c) => ({ id: Number(c.id), target_asset_id: null })) });
      this.emit('BUSINESS_OPERATION_FINANCIAL_CHANGED', id, reasonCode);
    }
    if (changed) await this.tx.execute(sql`UPDATE business_operations SET version = version + 1, updated_at = now() WHERE id = ${id}`);
    return changed;
  }

  async linkEquipment(id: number, input: EquipmentLinkInput, reasonCode = 'EQUIPMENT_LINKED'): Promise<boolean> {
    await this.load(id);
    return this.linkEquipmentInternal(id, input, { history: true, reasonCode });
  }

  private async linkEquipmentInternal(id: number, input: EquipmentLinkInput, opts: { history: boolean; reasonCode?: string }): Promise<boolean> {
    oneOf(AUTHORITIES, input.authority, 'INVALID_SOURCE', 'Autorité');
    const [e] = await rows<{ asset_id: number; account_id: number | null; gone: boolean }>(this.tx, sql`
      SELECT e.asset_id, a.account_id, a.deleted_at IS NOT NULL AS gone FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE e.id = ${input.equipmentId}`);
    if (!e || e.gone) throw new BusinessOperationIntegrityError('EQUIPMENT_NOT_FOUND', `Équipement ${input.equipmentId} introuvable.`);
    if (Number(e.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Équipement ${input.equipmentId} d'un autre compte.`);
    if (input.sourceId != null) await this.loadSource(id, input.sourceId);
    const [cur] = await rows<{ id: string; active: boolean }>(this.tx, sql`
      SELECT id, active FROM business_operation_equipment_links WHERE operation_id = ${id} AND equipment_id = ${input.equipmentId}`);
    if (cur?.active) return false;
    if (cur) {
      await this.tx.execute(sql`
        UPDATE business_operation_equipment_links SET active = true, asset_id = ${e.asset_id}, authority = ${input.authority}, updated_at = now()
         WHERE id = ${Number(cur.id)}`);
    } else {
      await this.tx.execute(sql`
        INSERT INTO business_operation_equipment_links (account_id, operation_id, equipment_id, asset_id, authority, source_operation_source_id)
        VALUES (${this.accountId}, ${id}, ${input.equipmentId}, ${e.asset_id}, ${input.authority}, ${input.sourceId ?? null})`);
    }
    if (opts.history) {
      await this.history(id, 'TARGET_CHANGED', opts.reasonCode ?? 'EQUIPMENT_LINKED', null, { equipment_id: input.equipmentId, asset_id: e.asset_id, active: true }, input.sourceId ?? null);
      this.emit('BUSINESS_OPERATION_TARGET_CHANGED', id, opts.reasonCode ?? 'EQUIPMENT_LINKED');
    }
    return true;
  }

  async unlinkEquipment(id: number, equipmentId: number, reasonCode: string): Promise<boolean> {
    await this.load(id, { allowInactive: true });
    const r = await rows(this.tx, sql`
      UPDATE business_operation_equipment_links SET active = false, updated_at = now()
       WHERE operation_id = ${id} AND equipment_id = ${equipmentId} AND active RETURNING id`);
    if (!r.length) return false;
    await this.history(id, 'TARGET_CHANGED', reasonCode, { equipment_id: equipmentId, active: true }, { equipment_id: equipmentId, active: false });
    this.emit('BUSINESS_OPERATION_TARGET_CHANGED', id, reasonCode);
    return true;
  }

  // ── Composantes financières (C12) ────────────────────────────────────────

  /**
   * Ajoute un fait économique consolidé. Montant ≥ 0 en unités mineures, signe
   * porté par `kind`. Empreinte identique active : valeurs inchangées → aucun
   * effet ; valeurs différentes → l'ancienne est SUPERSÉDÉE, jamais
   * additionnée (C12.1).
   */
  async addFinancialComponent(id: number, input: FinancialComponentInput, reasonCode = 'COMPONENT_ADDED'): Promise<number> {
    await this.load(id);
    const kind = oneOf(FINANCIAL_COMPONENT_KINDS, input.kind, 'INVALID_SOURCE', 'Rôle économique');
    if (!isMinorAmount(input.amountMinor)) throw new BusinessOperationIntegrityError('INVALID_AMOUNT', `Montant invalide : ${String(input.amountMinor)} (entier ≥ 0 en unités mineures, C12).`);
    if (input.amountEurCents != null && !isMinorAmount(input.amountEurCents)) throw new BusinessOperationIntegrityError('INVALID_AMOUNT', `Contre-valeur EUR invalide : ${String(input.amountEurCents)}.`);
    if (!isIsoCurrency(input.currency)) throw new BusinessOperationIntegrityError('INVALID_CURRENCY', `Devise ISO 4217 attendue : ${String(input.currency)}.`);
    const economicDate = optionalDate(input.economicDate, 'economicDate');
    const periodStart = optionalDate(input.periodStart, 'periodStart');
    const periodEnd = optionalDate(input.periodEnd, 'periodEnd');
    if (periodStart && periodEnd && periodEnd < periodStart) throw new BusinessOperationIntegrityError('INVALID_DATE', 'Fin de période antérieure au début.');
    if (!input.sources?.length) throw new BusinessOperationIntegrityError('SOURCE_REQUIRED', 'Une composante a au moins une source active (C26.2).');
    for (const s of input.sources) {
      await this.loadSource(id, s.sourceId);
      if (s.evidenceRole) oneOf(EVIDENCE_ROLES, s.evidenceRole, 'INVALID_SOURCE', 'Rôle de preuve');
    }
    if (input.targetAssetId != null) {
      const [l] = await rows(this.tx, sql`SELECT 1 FROM business_operation_asset_links WHERE operation_id = ${id} AND asset_id = ${input.targetAssetId} AND active`);
      if (!l) throw new BusinessOperationIntegrityError('TARGET_NOT_LINKED', `Bien ${input.targetAssetId} non rattaché à l'Opération ${id}.`);
    }
    if (input.targetEquipmentId != null) {
      const [l] = await rows(this.tx, sql`SELECT 1 FROM business_operation_equipment_links WHERE operation_id = ${id} AND equipment_id = ${input.targetEquipmentId} AND active`);
      if (!l) throw new BusinessOperationIntegrityError('TARGET_NOT_LINKED', `Équipement ${input.targetEquipmentId} non rattaché à l'Opération ${id}.`);
    }

    const values = {
      kind, amount_minor: input.amountMinor, currency: input.currency, amount_eur_cents: input.amountEurCents ?? null,
      economic_date: economicDate, period_start: periodStart, period_end: periodEnd,
      target_asset_id: input.targetAssetId ?? null, target_equipment_id: input.targetEquipmentId ?? null, label: input.label ?? null,
    };
    let previous: Row | null = null;
    if (input.fingerprint) {
      const [p] = await rows(this.tx, sql`
        SELECT id, kind, amount_minor, currency, amount_eur_cents, economic_date::text AS economic_date,
               period_start::text AS period_start, period_end::text AS period_end, target_asset_id, target_equipment_id, label
          FROM business_operation_financial_components
         WHERE operation_id = ${id} AND fingerprint = ${input.fingerprint} AND active FOR UPDATE`);
      if (p) {
        const same = (Object.keys(values) as Array<keyof typeof values>).every((k) => (p[k] === null ? null : String(p[k]).trim()) === (values[k] === null ? null : String(values[k])));
        if (same) return Number(p.id);
        previous = p;
        await this.tx.execute(sql`UPDATE business_operation_financial_components SET active = false, superseded_at = now(), updated_at = now() WHERE id = ${Number(p.id)}`);
      }
    }
    const [c] = await rows<{ id: string }>(this.tx, sql`
      INSERT INTO business_operation_financial_components
        (account_id, operation_id, kind, amount_minor, currency, amount_eur_cents, economic_date, period_start, period_end,
         target_asset_id, target_equipment_id, label, fingerprint)
      VALUES (${this.accountId}, ${id}, ${kind}, ${input.amountMinor}, ${input.currency}, ${input.amountEurCents ?? null},
              ${economicDate}::date, ${periodStart}::date, ${periodEnd}::date, ${input.targetAssetId ?? null},
              ${input.targetEquipmentId ?? null}, ${input.label ?? null}, ${input.fingerprint ?? null})
      RETURNING id`);
    const componentId = Number(c.id);
    for (const s of input.sources) {
      await this.tx.execute(sql`
        INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, evidence_role, is_primary)
        VALUES (${componentId}, ${s.sourceId}, ${s.evidenceRole ?? 'SUPPORTS'}, ${s.isPrimary ?? false})
        ON CONFLICT DO NOTHING`);
    }
    await this.tx.execute(sql`UPDATE business_operations SET version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'FINANCIAL_CHANGED', reasonCode,
      previous ? { component_id: Number(previous.id), kind: previous.kind, amount_minor: Number(previous.amount_minor), currency: previous.currency } : null,
      { component_id: componentId, kind, amount_minor: input.amountMinor, currency: input.currency }, input.sources[0].sourceId);
    this.emit('BUSINESS_OPERATION_FINANCIAL_CHANGED', id, reasonCode);
    return componentId;
  }

  /**
   * Ajoute une source active de la même Opération comme preuve d'une
   * composante existante (C12.1 : plusieurs documents prouvent un même fait
   * économique). Aucune valeur ne change : ni historique ni événement.
   */
  async attachComponentSource(componentId: number, sourceId: number, evidenceRole: EvidenceRole = 'SUPPORTS'): Promise<boolean> {
    const opId = await this.componentOperation(componentId);
    await this.loadSource(opId, sourceId);
    oneOf(EVIDENCE_ROLES, evidenceRole, 'INVALID_SOURCE', 'Rôle de preuve');
    const r = await rows(this.tx, sql`
      INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, evidence_role, is_primary)
      VALUES (${componentId}, ${sourceId}, ${evidenceRole}, false)
      ON CONFLICT DO NOTHING RETURNING component_id`);
    return r.length > 0;
  }

  /**
   * Retire une source des preuves d'une composante (sa contribution n'existe
   * plus). Rend le nombre de sources ACTIVES qui la prouvent encore : à zéro,
   * l'appelant la supersède (C9.1 : jamais de suppression physique).
   */
  async detachComponentSource(componentId: number, sourceId: number): Promise<number> {
    await this.componentOperation(componentId);
    await this.tx.execute(sql`
      DELETE FROM business_operation_financial_component_sources WHERE component_id = ${componentId} AND operation_source_id = ${sourceId}`);
    const [r] = await rows<{ n: number }>(this.tx, sql`
      SELECT count(*)::int AS n FROM business_operation_financial_component_sources cs
        JOIN business_operation_sources s ON s.id = cs.operation_source_id
       WHERE cs.component_id = ${componentId} AND s.active`);
    return Number(r?.n ?? 0);
  }

  private async componentOperation(componentId: number): Promise<number> {
    const [c] = await rows<{ operation_id: string; account_id: number }>(this.tx, sql`
      SELECT operation_id, account_id FROM business_operation_financial_components WHERE id = ${componentId}`);
    if (!c) throw new BusinessOperationIntegrityError('SOURCE_NOT_FOUND', `Composante ${componentId} introuvable.`);
    if (Number(c.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Composante ${componentId} d'un autre compte.`);
    await this.load(Number(c.operation_id), { allowInactive: true });
    return Number(c.operation_id);
  }

  async supersedeFinancialComponent(componentId: number, reasonCode: string): Promise<boolean> {
    const [c] = await rows<{ operation_id: string; account_id: number; active: boolean; kind: string; amount_minor: string; currency: string }>(this.tx, sql`
      SELECT operation_id, account_id, active, kind, amount_minor, currency FROM business_operation_financial_components WHERE id = ${componentId}`);
    if (!c) throw new BusinessOperationIntegrityError('SOURCE_NOT_FOUND', `Composante ${componentId} introuvable.`);
    if (Number(c.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Composante ${componentId} d'un autre compte.`);
    if (!c.active) return false;
    const opId = Number(c.operation_id);
    await this.load(opId, { allowInactive: true });
    await this.tx.execute(sql`UPDATE business_operation_financial_components SET active = false, superseded_at = now(), updated_at = now() WHERE id = ${componentId}`);
    await this.tx.execute(sql`UPDATE business_operations SET version = version + 1, updated_at = now() WHERE id = ${opId}`);
    await this.history(opId, 'FINANCIAL_CHANGED', reasonCode, { component_id: componentId, kind: c.kind, amount_minor: Number(c.amount_minor), currency: c.currency }, null);
    this.emit('BUSINESS_OPERATION_FINANCIAL_CHANGED', opId, reasonCode);
    return true;
  }

  // ── Références métier (M1) ───────────────────────────────────────────────

  async addReference(id: number, input: { kind: ReferenceKind; value: string; sourceId?: number | null }, reasonCode = 'REFERENCE_ADDED'): Promise<boolean> {
    await this.load(id, { allowInactive: true });
    const kind = oneOf(REFERENCE_KINDS, input.kind, 'INVALID_REFERENCE', 'Nature de référence');
    const value = String(input.value ?? '').trim();
    const normalized = normalizeBusinessReference(value);
    if (!normalized) throw new BusinessOperationIntegrityError('INVALID_REFERENCE', `Référence vide après normalisation : « ${value} ».`);
    if (input.sourceId != null) await this.loadSource(id, input.sourceId);
    const r = await rows(this.tx, sql`
      INSERT INTO business_operation_references (account_id, operation_id, reference_kind, reference_value, normalized_value, source_id)
      VALUES (${this.accountId}, ${id}, ${kind}, ${value}, ${normalized}, ${input.sourceId ?? null})
      ON CONFLICT (operation_id, reference_kind, normalized_value) DO UPDATE
         SET active = true, superseded_at = NULL, reference_value = EXCLUDED.reference_value,
             source_id = COALESCE(EXCLUDED.source_id, business_operation_references.source_id)
       WHERE NOT business_operation_references.active
      RETURNING id`);
    if (!r.length) return false;
    await this.history(id, 'UPDATED', reasonCode, null, { reference_kind: kind, reference_value: value }, input.sourceId ?? null);
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  /** Retire une référence qui n'est plus soutenue par aucune source active (C9.1). */
  async deactivateReference(referenceId: number, reasonCode: string): Promise<boolean> {
    const [r] = await rows<{ operation_id: string; account_id: number; active: boolean; reference_kind: string; reference_value: string; source_id: string | null }>(this.tx, sql`
      SELECT operation_id, account_id, active, reference_kind, reference_value, source_id FROM business_operation_references WHERE id = ${referenceId}`);
    if (!r) throw new BusinessOperationIntegrityError('INVALID_REFERENCE', `Référence ${referenceId} introuvable.`);
    if (Number(r.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Référence ${referenceId} d'un autre compte.`);
    if (!r.active) return false;
    const opId = Number(r.operation_id);
    await this.load(opId, { allowInactive: true, allowMerged: true });
    await this.tx.execute(sql`UPDATE business_operation_references SET active = false, superseded_at = now() WHERE id = ${referenceId}`);
    await this.history(opId, 'UPDATED', reasonCode, { reference_kind: r.reference_kind, reference_value: r.reference_value }, null, num(r.source_id));
    this.emit('BUSINESS_OPERATION_UPDATED', opId, reasonCode);
    return true;
  }

  /** Rattache une référence active à une autre source active qui la porte (provenance ; ni historique ni événement). */
  async repointReference(referenceId: number, sourceId: number): Promise<boolean> {
    const [r] = await rows<{ operation_id: string; account_id: number }>(this.tx, sql`
      SELECT operation_id, account_id FROM business_operation_references WHERE id = ${referenceId} AND active`);
    if (!r) return false;
    if (Number(r.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Référence ${referenceId} d'un autre compte.`);
    await this.loadSource(Number(r.operation_id), sourceId);
    const u = await rows(this.tx, sql`
      UPDATE business_operation_references SET source_id = ${sourceId}
       WHERE id = ${referenceId} AND source_id IS DISTINCT FROM ${sourceId}::bigint RETURNING id`);
    return u.length > 0;
  }

  /**
   * Version technique d'une source active (empreinte de la contribution, ex.
   * candidat T1 courant) — sans historique ni événement : le résultat métier
   * ne change pas (NFR-OP-005, C9 « réanalyse identique = no-op »).
   */
  async refreshSourceVersion(sourceId: number, version: string | null): Promise<boolean> {
    const [s] = await rows<{ account_id: number }>(this.tx, sql`SELECT account_id FROM business_operation_sources WHERE id = ${sourceId}`);
    if (!s) throw new BusinessOperationIntegrityError('SOURCE_NOT_FOUND', `Source ${sourceId} introuvable.`);
    if (Number(s.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Source ${sourceId} d'un autre compte.`);
    const u = await rows(this.tx, sql`
      UPDATE business_operation_sources SET source_version = ${version}
       WHERE id = ${sourceId} AND active AND source_version IS DISTINCT FROM ${version} RETURNING id`);
    return u.length > 0;
  }

  // ── Détails par type (C13, C14) ──────────────────────────────────────────

  async upsertContractDetails(id: number, input: ContractDetailsInput, reasonCode = 'DETAILS_UPDATED'): Promise<boolean> {
    await this.requireType(id, 'CONTRACT');
    const v = {
      contract_reference: input.contractReference ?? null,
      periodicity: input.periodicity == null ? null : oneOf(CONTRACT_PERIODICITIES, input.periodicity, 'INVALID_DETAILS', 'Périodicité'),
      effective_from: optionalDate(input.effectiveFrom, 'effectiveFrom'),
      effective_to: optionalDate(input.effectiveTo, 'effectiveTo'),
    };
    return this.upsertDetails(id, 'business_operation_contract_details', v, reasonCode);
  }

  async upsertFinancingDetails(id: number, input: FinancingDetailsInput, reasonCode = 'DETAILS_UPDATED'): Promise<boolean> {
    await this.requireType(id, 'FINANCING');
    if (input.principalAmountMinor != null && !isMinorAmount(input.principalAmountMinor)) throw new BusinessOperationIntegrityError('INVALID_AMOUNT', 'Principal invalide (entier ≥ 0).');
    if (input.principalCurrency != null && !isIsoCurrency(input.principalCurrency)) throw new BusinessOperationIntegrityError('INVALID_CURRENCY', 'Devise du principal invalide.');
    if (input.principalAmountMinor != null && input.principalCurrency == null) throw new BusinessOperationIntegrityError('INVALID_CURRENCY', 'Un principal exige sa devise.');
    const v = {
      financing_reference: input.financingReference ?? null,
      lender: input.lender ?? null,
      principal_amount_minor: input.principalAmountMinor ?? null,
      principal_currency: input.principalCurrency ?? null,
      effective_from: optionalDate(input.effectiveFrom, 'effectiveFrom'),
      effective_to: optionalDate(input.effectiveTo, 'effectiveTo'),
    };
    return this.upsertDetails(id, 'business_operation_financing_details', v, reasonCode);
  }

  async upsertClaimDetails(id: number, input: ClaimDetailsInput, reasonCode = 'DETAILS_UPDATED'): Promise<boolean> {
    await this.requireType(id, 'CLAIM');
    if (input.estimatedDamageMinor != null && !isMinorAmount(input.estimatedDamageMinor)) throw new BusinessOperationIntegrityError('INVALID_AMOUNT', 'Estimation des dommages invalide (entier ≥ 0).');
    if (input.insuranceContractOperationId != null) {
      if (input.insuranceContractOperationId === id) throw new BusinessOperationIntegrityError('INVALID_DETAILS', 'Un sinistre ne se référence pas lui-même.');
      const contract = await this.load(input.insuranceContractOperationId, { allowInactive: true });
      if (contract.typeCode !== 'CONTRACT') {
        throw new BusinessOperationIntegrityError('DETAILS_TYPE_MISMATCH', `Opération ${contract.id} : CONTRACT attendu pour le contrat d'assurance (C13.1).`);
      }
    }
    const v = {
      claim_type: input.claimType ?? null,
      declared_on: optionalDate(input.declaredOn, 'declaredOn'),
      insurer_claim_ref: input.insurerClaimRef ?? null,
      insurance_contract_operation_id: input.insuranceContractOperationId ?? null,
      policy_reference_text: input.policyReferenceText ?? null,
      status: input.status == null ? null : oneOf(CLAIM_FILE_STATUSES, input.status, 'INVALID_DETAILS', 'Statut du dossier'),
      status_detail: input.statusDetail ?? null,
      circumstances: input.circumstances ?? null,
      consequences: input.consequences ?? null,
      measures_summary: input.measuresSummary ?? null,
      exchanges_summary: input.exchangesSummary ?? null,
      estimated_damage_minor: input.estimatedDamageMinor ?? null,
      ...(input.historyEventId !== undefined ? { history_event_id: await this.checkHistoryEvent(input.historyEventId ?? null) } : {}),
    };
    return this.upsertDetails(id, 'business_operation_claim_details', v, reasonCode);
  }

  /** Événement de l'historique du compte (lot 44) ; null admis. */
  private async checkHistoryEvent(eventId: number | null): Promise<number | null> {
    if (eventId === null) return null;
    const [e] = await rows<{ account_id: number }>(this.tx, sql`SELECT account_id FROM events WHERE id = ${eventId}`);
    if (!e) throw new BusinessOperationIntegrityError('INVALID_DETAILS', `Événement ${eventId} introuvable.`);
    if (Number(e.account_id) !== this.accountId) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Événement ${eventId} d'un autre compte.`);
    return eventId;
  }

  /**
   * Listes structurées du Sinistre (lot 44, C14) REMPLACÉES en bloc — même
   * sémantique que le formulaire historique (lot 34). Comparées d'abord :
   * aucune écriture, aucun historique si rien ne change (NFR-OP-005). Pièces,
   * photos, factures et INTERVENTION enfant : du même compte (C25).
   */
  async replaceClaimLists(id: number, input: ClaimListsInput, reasonCode = 'CLAIM_LISTS_UPDATED'): Promise<boolean> {
    await this.requireType(id, 'CLAIM');
    const cur = await this.readClaimListsInternal(id);
    const srt = (v: number[]) => [...new Set(v)].sort((a, b) => a - b);
    const norm = (l: ClaimListsInput) => JSON.stringify([
      l.damages.map((d) => [d.itemKey, d.zone, d.element, d.finding, d.estimatedAmountMinor, srt(d.fileIds), srt(d.photoIds)]),
      l.actions.map((a) => [a.itemKey, a.date, a.endDate, a.status, a.title, a.detail, a.performedBy, a.invoiceFileId, a.childOperationId]),
      l.exchanges.map((x) => [x.itemKey, x.date, x.party, x.channel, x.direction, x.summary, x.documentFileId]),
    ]);
    if (norm(cur) === norm(input)) return false;

    const fileIds = [...new Set([
      ...input.damages.flatMap((d) => d.fileIds), ...input.actions.map((a) => a.invoiceFileId), ...input.exchanges.map((x) => x.documentFileId),
    ].filter((f): f is number => f !== null))];
    if (fileIds.length) {
      const ok = await rows<{ id: number }>(this.tx, sql`
        SELECT id FROM asset_files WHERE id = ANY(${`{${fileIds.join(',')}}`}::int[]) AND account_id = ${this.accountId}`);
      const okSet = new Set(ok.map((x) => Number(x.id)));
      const bad = fileIds.find((f) => !okSet.has(f));
      if (bad !== undefined) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Pièce ${bad} introuvable dans le compte.`);
    }
    const photoIds = [...new Set(input.damages.flatMap((d) => d.photoIds))];
    if (photoIds.length) {
      const ok = await rows<{ id: number }>(this.tx, sql`
        SELECT p.id FROM asset_photos p JOIN assets a ON a.id = p.asset_id
         WHERE p.id = ANY(${`{${photoIds.join(',')}}`}::int[]) AND a.account_id = ${this.accountId}`);
      const okSet = new Set(ok.map((x) => Number(x.id)));
      const bad = photoIds.find((f) => !okSet.has(f));
      if (bad !== undefined) throw new BusinessOperationIntegrityError('CROSS_ACCOUNT', `Photo ${bad} introuvable dans le compte.`);
    }
    for (const childId of new Set(input.actions.map((a) => a.childOperationId).filter((c): c is number => c !== null))) {
      if (childId === id) throw new BusinessOperationIntegrityError('INVALID_DETAILS', 'Une action ne désigne pas le sinistre lui-même.');
      const child = await this.load(childId, { allowInactive: true });
      if (child.typeCode !== 'INTERVENTION') throw new BusinessOperationIntegrityError('DETAILS_TYPE_MISMATCH', `Opération ${childId} : INTERVENTION attendue (C14.2).`);
    }
    for (const a of input.actions) {
      if (a.date !== null) optionalDate(a.date, 'action.date');
      if (a.endDate !== null) optionalDate(a.endDate, 'action.endDate');
    }
    for (const x of input.exchanges) if (x.date !== null) optionalDate(x.date, 'exchange.date');
    for (const d of input.damages) {
      if (d.estimatedAmountMinor !== null && !isMinorAmount(d.estimatedAmountMinor)) throw new BusinessOperationIntegrityError('INVALID_AMOUNT', 'Montant estimé d\'un dommage invalide.');
    }

    await this.tx.execute(sql`DELETE FROM business_operation_claim_damages WHERE operation_id = ${id}`);
    await this.tx.execute(sql`DELETE FROM business_operation_claim_actions WHERE operation_id = ${id}`);
    await this.tx.execute(sql`DELETE FROM business_operation_claim_exchanges WHERE operation_id = ${id}`);
    for (const [i, d] of input.damages.entries()) {
      const [r] = await rows<{ id: string }>(this.tx, sql`
        INSERT INTO business_operation_claim_damages (operation_id, zone, element, finding, estimated_amount_minor, sort_order, item_key)
        VALUES (${id}, ${d.zone}, ${d.element}, ${d.finding}, ${d.estimatedAmountMinor}, ${i}, ${d.itemKey})
        RETURNING id`);
      for (const f of new Set(d.fileIds)) {
        await this.tx.execute(sql`INSERT INTO business_operation_claim_damage_documents (damage_id, file_id) VALUES (${Number(r.id)}, ${f}) ON CONFLICT DO NOTHING`);
      }
      for (const ph of new Set(d.photoIds)) {
        await this.tx.execute(sql`INSERT INTO business_operation_claim_damage_photos (damage_id, photo_id) VALUES (${Number(r.id)}, ${ph}) ON CONFLICT DO NOTHING`);
      }
    }
    for (const [i, a] of input.actions.entries()) {
      await this.tx.execute(sql`
        INSERT INTO business_operation_claim_actions
          (operation_id, date, end_date, status, title, detail, performed_by, invoice_file_id, child_operation_id, sort_order, item_key)
        VALUES (${id}, ${a.date}::date, ${a.endDate}::date, ${a.status}, ${a.title}, ${a.detail}, ${a.performedBy}, ${a.invoiceFileId},
                ${a.childOperationId}, ${i}, ${a.itemKey})`);
    }
    for (const [i, x] of input.exchanges.entries()) {
      await this.tx.execute(sql`
        INSERT INTO business_operation_claim_exchanges
          (operation_id, date, party, channel, direction, summary, document_file_id, sort_order, item_key)
        VALUES (${id}, ${x.date}::date, ${x.party}, ${x.channel}, ${x.direction}, ${x.summary}, ${x.documentFileId}, ${i}, ${x.itemKey})`);
    }
    await this.tx.execute(sql`UPDATE business_operations SET version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'UPDATED', reasonCode,
      { damages: cur.damages.length, actions: cur.actions.length, exchanges: cur.exchanges.length },
      { damages: input.damages.length, actions: input.actions.length, exchanges: input.exchanges.length });
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  /** Listes du Sinistre telles qu'en base, sous la forme de `ClaimListsInput` (ordre d'affichage). */
  async readClaimListsInternal(id: number): Promise<ClaimListsInput> {
    const damages = await rows<Row>(this.tx, sql`
      SELECT d.id, d.item_key, d.zone, d.element, d.finding, d.estimated_amount_minor,
             COALESCE((SELECT array_agg(dd.file_id ORDER BY dd.file_id) FROM business_operation_claim_damage_documents dd WHERE dd.damage_id = d.id), '{}') AS files,
             COALESCE((SELECT array_agg(dp.photo_id ORDER BY dp.photo_id) FROM business_operation_claim_damage_photos dp WHERE dp.damage_id = d.id), '{}') AS photos
        FROM business_operation_claim_damages d WHERE d.operation_id = ${id} ORDER BY d.sort_order, d.id`);
    const actions = await rows<Row>(this.tx, sql`
      SELECT item_key, date::text AS date, end_date::text AS end_date, status, title, detail, performed_by, invoice_file_id, child_operation_id
        FROM business_operation_claim_actions WHERE operation_id = ${id} ORDER BY sort_order, id`);
    const exchanges = await rows<Row>(this.tx, sql`
      SELECT item_key, date::text AS date, party, channel, direction, summary, document_file_id
        FROM business_operation_claim_exchanges WHERE operation_id = ${id} ORDER BY sort_order, id`);
    const t = (v: unknown) => (v === null || v === undefined ? null : String(v));
    return {
      damages: damages.map((d) => ({
        itemKey: t(d.item_key), zone: String(d.zone), element: t(d.element), finding: t(d.finding), estimatedAmountMinor: num(d.estimated_amount_minor),
        fileIds: ((d.files as number[] | null) ?? []).map(Number), photoIds: ((d.photos as number[] | null) ?? []).map(Number),
      })),
      actions: actions.map((a) => ({
        itemKey: t(a.item_key), date: t(a.date), endDate: t(a.end_date), status: (t(a.status) as ClaimActionInput['status']), title: String(a.title),
        detail: t(a.detail), performedBy: t(a.performed_by), invoiceFileId: num(a.invoice_file_id), childOperationId: num(a.child_operation_id),
      })),
      exchanges: exchanges.map((x) => ({
        itemKey: t(x.item_key), date: t(x.date), party: t(x.party) as ClaimExchangeInput['party'], channel: t(x.channel) as ClaimExchangeInput['channel'],
        direction: t(x.direction) as ClaimExchangeInput['direction'], summary: String(x.summary), documentFileId: num(x.document_file_id),
      })),
    };
  }

  /** Retire les détails d'un type (préalable à une requalification). */
  async removeDetails(id: number, kind: 'contract' | 'financing' | 'claim', reasonCode: string): Promise<boolean> {
    await this.load(id, { allowInactive: true });
    const table = `business_operation_${kind}_details`;
    const r = await rows(this.tx, sql`DELETE FROM ${sql.identifier(table)} WHERE operation_id = ${id} RETURNING operation_id`);
    if (!r.length) return false;
    await this.history(id, 'UPDATED', reasonCode, { details: kind }, null);
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  private async requireType(id: number, type: BusinessOperationTypeCode): Promise<OperationRow> {
    const op = await this.load(id, { allowInactive: true });
    if (op.typeCode !== type) {
      throw new BusinessOperationIntegrityError('DETAILS_TYPE_MISMATCH', `Détails ${type} sur une Opération ${op.typeCode ?? 'non qualifiée'} (C13).`);
    }
    return op;
  }

  private async upsertDetails(id: number, table: string, values: Record<string, string | number | null>, reasonCode: string): Promise<boolean> {
    const cols = Object.keys(values);
    const [cur] = await rows(this.tx, sql`SELECT ${sql.join(cols.map((c) => sql`${sql.identifier(c)}::text AS ${sql.identifier(c)}`), sql`, `)} FROM ${sql.identifier(table)} WHERE operation_id = ${id} FOR UPDATE`);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const c of cols) {
      const a = values[c] === null ? null : String(values[c]);
      const b = cur ? ((cur[c] as string | null) ?? null) : null;
      if (a !== b) { before[c] = b; after[c] = values[c]; }
    }
    if (cur && Object.keys(after).length === 0) return false;
    const colsSql = sql.join(cols.map((c) => sql.identifier(c)), sql`, `);
    const valsSql = sql.join(cols.map((c) => sql`${values[c]}`), sql`, `);
    const setSql = sql.join(cols.map((c) => sql`${sql.identifier(c)} = EXCLUDED.${sql.identifier(c)}`), sql`, `);
    await this.tx.execute(sql`
      INSERT INTO ${sql.identifier(table)} (operation_id, ${colsSql}) VALUES (${id}, ${valsSql})
      ON CONFLICT (operation_id) DO UPDATE SET ${setSql}, updated_at = now()`);
    await this.tx.execute(sql`UPDATE business_operations SET version = version + 1, updated_at = now() WHERE id = ${id}`);
    await this.history(id, 'UPDATED', reasonCode, cur ? before : null, after);
    this.emit('BUSINESS_OPERATION_UPDATED', id, reasonCode);
    return true;
  }

  // ── Historique et événements ─────────────────────────────────────────────

  private async history(
    operationId: number, eventType: HistoryEventType, reasonCode: string,
    before: Record<string, unknown> | null, after: Record<string, unknown> | null, sourceId: number | null = null,
  ): Promise<void> {
    await this.tx.execute(sql`
      INSERT INTO business_operation_history
        (account_id, operation_id, event_type, reason_code, source_id, actor_user_id, before_json, after_json, correlation_id)
      VALUES (${this.accountId}, ${operationId}, ${eventType}, ${reasonCode || eventType}, ${sourceId}, ${this.ctx.actorUserId},
              ${before === null ? null : JSON.stringify(before)}::jsonb, ${after === null ? null : JSON.stringify(after)}::jsonb,
              ${this.ctx.correlationId})`);
  }

  private emit(type: Parameters<BusinessOperationEventBuffer['push']>[0]['type'], operationId: number, reasonCode: string, canonicalOperationId?: number): void {
    this.events.push({ type, accountId: this.accountId, operationId, reasonCode, ...(canonicalOperationId ? { canonicalOperationId } : {}) });
  }

  // ── Mémoire des décisions de rapprochement (C6.3, lot 42) ────────────────

  /**
   * Décision durable source → Opération (CONFIRMED / REJECTED). Une seule
   * décision ACTIVE par (Opération, source, version) : la précédente est
   * désactivée, jamais effacée (l'historique du rejet reste, C6.3). Rend
   * l'identifiant de la décision.
   */
  async recordMatchDecision(input: {
    sourceKind: SourceKind; entityKey: string | number; sourceVersion: string | null; operationId: number;
    decision: 'CONFIRMED' | 'REJECTED'; origin: 'USER_ARBITRATION' | 'SYSTEM_EXPLICIT_REFERENCE' | 'ADMIN_REVIEW'; reasonCode: string;
  }): Promise<number> {
    oneOf(SOURCE_KINDS, input.sourceKind, 'INVALID_SOURCE', 'Nature de source');
    await this.load(input.operationId, { allowInactive: true });
    const key = String(input.entityKey);
    const [cur] = await rows<{ id: string; decision: string; reason_code: string }>(this.tx, sql`
      SELECT id, decision, reason_code FROM business_operation_match_decisions
       WHERE account_id = ${this.accountId} AND candidate_operation_id = ${input.operationId} AND source_kind = ${input.sourceKind}
         AND source_entity_key = ${key} AND COALESCE(source_version, '') = ${input.sourceVersion ?? ''} AND active FOR UPDATE`);
    if (cur && cur.decision === input.decision && cur.reason_code === input.reasonCode) return Number(cur.id);
    if (cur) {
      await this.tx.execute(sql`UPDATE business_operation_match_decisions SET active = false, updated_at = now() WHERE id = ${Number(cur.id)}`);
    }
    const [r] = await rows<{ id: string }>(this.tx, sql`
      INSERT INTO business_operation_match_decisions
        (account_id, source_kind, source_entity_key, source_version, candidate_operation_id, decision, origin, reason_code)
      VALUES (${this.accountId}, ${input.sourceKind}, ${key}, ${input.sourceVersion}, ${input.operationId}, ${input.decision},
              ${input.origin}, ${input.reasonCode})
      RETURNING id`);
    return Number(r.id);
  }

  /** Désactive des décisions (annulation d'un arbitrage) ; rend le nombre désactivé. */
  async deactivateMatchDecisions(ids: readonly number[]): Promise<number> {
    const ok = ids.filter((x) => Number.isSafeInteger(x));
    if (!ok.length) return 0;
    const r = await rows(this.tx, sql`
      UPDATE business_operation_match_decisions SET active = false, updated_at = now()
       WHERE account_id = ${this.accountId} AND active AND id = ANY(${`{${ok.join(',')}}`}::bigint[]) RETURNING id`);
    return r.length;
  }

  // ── Fusion V1 (B8, ch. 8.4, NFR-OP-003, INV-041) ─────────────────────────

  /**
   * Fusionne `absorbedId` dans `canonicalId`, dans la transaction COURANTE
   * (atomique : une erreur annule tout, aucun état « moitié fusionné »
   * visible, F-168). Rapatrie sur la canonique, sans perte ni double compte :
   *   · sources (actives et historiques) — une source identique déjà active
   *     sur la canonique n'est pas dupliquée (celle de l'absorbée est
   *     désactivée et ses preuves rattachées à l'équivalente) ;
   *   · composantes — même empreinte active sur la canonique : l'absorbée est
   *     supersédée (ses preuves rejoignent celle de la canonique), jamais
   *     additionnée ; sinon déplacée ;
   *   · liens biens / équipements, références (relations identiques
   *     dédoublonnées), détails par type absents de la canonique, listes du
   *     Sinistre, suppressions de projection ; éléments d'agenda, principal
   *     unique, appartenance USER des documents et Pièces par le service de
   *     regroupement (`grouping/merge.ts`, lot 82D : aucune absorption) ;
   *   · enfants (re-parentés, C8.1 revérifié) et parent si la canonique n'en
   *     a pas ; références croisées (contrat d'assurance d'un Sinistre,
   *     sous-Opération d'une action Sinistre) ;
   *   · décisions de rapprochement remappées (F-051) ;
   * puis absorbée invalidée avec `merged_into_operation_id` (B7), historique
   * MERGED des deux côtés, événement BUSINESS_OPERATION_MERGED (après commit).
   * L'état consolidé de la canonique est recalculé par l'appelant (T3).
   * `onStep` : point d'injection de diagnostic (tests de rollback).
   */
  async mergeOperations(absorbedId: number, canonicalId: number, reasonCode: string, opts: { onStep?: (step: string) => void | Promise<void> } = {}): Promise<boolean> {
    if (absorbedId === canonicalId) throw new BusinessOperationIntegrityError('MERGE_SELF', 'Une Opération ne fusionne pas avec elle-même.');
    const absorbed = await this.load(absorbedId, { allowInactive: true, allowMerged: true });
    if (absorbed.mergedIntoOperationId !== null) return false;
    const canonical = await this.load(canonicalId, { allowInactive: true });
    if (absorbed.typeCode !== null && canonical.typeCode !== null && absorbed.typeCode !== canonical.typeCode) {
      throw new BusinessOperationIntegrityError('MERGE_TYPE_MISMATCH', `Fusion refusée : ${absorbed.typeCode} ≠ ${canonical.typeCode}.`);
    }
    const step = async (name: string) => { await opts.onStep?.(name); };
    const A = absorbedId;
    const C = canonicalId;
    const acct = this.accountId;

    // 1. Sources : doublons actifs → équivalent canonique ; sinon déplacées.
    const doublons = await rows<{ a: string; c: string }>(this.tx, sql`
      SELECT sa.id AS a, sc.id AS c FROM business_operation_sources sa
        JOIN business_operation_sources sc ON sc.operation_id = ${C} AND sc.active AND sc.source_kind = sa.source_kind
         AND sc.source_entity_key = sa.source_entity_key AND COALESCE(sc.source_role, '') = COALESCE(sa.source_role, '')
         AND md5(sc.locator::text) = md5(sa.locator::text)
       WHERE sa.operation_id = ${A} AND sa.account_id = ${acct} AND sa.active`);
    const equivalent = new Map(doublons.map((d) => [Number(d.a), Number(d.c)]));
    for (const [a, c] of equivalent) {
      await this.tx.execute(sql`
        INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, evidence_role, is_primary)
        SELECT component_id, ${c}, evidence_role, false FROM business_operation_financial_component_sources WHERE operation_source_id = ${a}
        ON CONFLICT DO NOTHING`);
      await this.tx.execute(sql`UPDATE business_operation_sources SET active = false, superseded_at = now() WHERE id = ${a}`);
    }
    await this.tx.execute(sql`UPDATE business_operation_sources SET operation_id = ${C} WHERE operation_id = ${A} AND account_id = ${acct}
       AND NOT (id = ANY(${`{${[...equivalent.keys()].join(',')}}`}::bigint[]))`);
    await step('sources');

    // 2. Composantes : même empreinte active → supersédée (preuves rapatriées), sinon déplacée.
    const memes = await rows<{ a: string; c: string }>(this.tx, sql`
      SELECT ca.id AS a, cc.id AS c FROM business_operation_financial_components ca
        JOIN business_operation_financial_components cc ON cc.operation_id = ${C} AND cc.active AND cc.fingerprint = ca.fingerprint
       WHERE ca.operation_id = ${A} AND ca.account_id = ${acct} AND ca.active AND ca.fingerprint IS NOT NULL`);
    for (const m of memes) {
      await this.tx.execute(sql`
        INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, evidence_role, is_primary)
        SELECT ${Number(m.c)}, cs.operation_source_id, cs.evidence_role, false
          FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id
         WHERE cs.component_id = ${Number(m.a)} AND s.operation_id = ${C}
        ON CONFLICT DO NOTHING`);
      await this.tx.execute(sql`UPDATE business_operation_financial_components SET active = false, superseded_at = now(), updated_at = now() WHERE id = ${Number(m.a)}`);
    }
    await this.tx.execute(sql`
      UPDATE business_operation_financial_components SET operation_id = ${C}, updated_at = now()
       WHERE operation_id = ${A} AND account_id = ${acct} AND NOT (id = ANY(${`{${memes.map((m) => Number(m.a)).join(',')}}`}::bigint[]))`);
    await step('components');

    // 3. Liens biens : couple déjà présent → la canonique garde le sien (réactivé si besoin).
    await this.tx.execute(sql`
      UPDATE business_operation_asset_links c SET active = true, updated_at = now()
        FROM business_operation_asset_links a
       WHERE a.operation_id = ${A} AND a.active AND c.operation_id = ${C} AND c.asset_id = a.asset_id AND NOT c.active`);
    await this.tx.execute(sql`
      UPDATE business_operation_asset_links a SET active = false, updated_at = now()
       WHERE a.operation_id = ${A} AND EXISTS (SELECT 1 FROM business_operation_asset_links c WHERE c.operation_id = ${C} AND c.asset_id = a.asset_id)`);
    await this.tx.execute(sql`
      UPDATE business_operation_asset_links a
         SET operation_id = ${C}, updated_at = now(),
             link_role = CASE WHEN a.link_role = 'PRIMARY' AND EXISTS (
               SELECT 1 FROM business_operation_asset_links c WHERE c.operation_id = ${C} AND c.active AND c.link_role = 'PRIMARY') THEN 'CONCERNED' ELSE a.link_role END
       WHERE a.operation_id = ${A} AND NOT EXISTS (SELECT 1 FROM business_operation_asset_links c WHERE c.operation_id = ${C} AND c.asset_id = a.asset_id)`);
    // Équipements, références : même principe.
    await this.tx.execute(sql`
      UPDATE business_operation_equipment_links c SET active = true, updated_at = now()
        FROM business_operation_equipment_links a
       WHERE a.operation_id = ${A} AND a.active AND c.operation_id = ${C} AND c.equipment_id = a.equipment_id AND NOT c.active`);
    await this.tx.execute(sql`
      UPDATE business_operation_equipment_links a SET active = false, updated_at = now()
       WHERE a.operation_id = ${A} AND EXISTS (SELECT 1 FROM business_operation_equipment_links c WHERE c.operation_id = ${C} AND c.equipment_id = a.equipment_id)`);
    await this.tx.execute(sql`
      UPDATE business_operation_equipment_links a SET operation_id = ${C}, updated_at = now()
       WHERE a.operation_id = ${A} AND NOT EXISTS (SELECT 1 FROM business_operation_equipment_links c WHERE c.operation_id = ${C} AND c.equipment_id = a.equipment_id)`);
    await this.tx.execute(sql`
      UPDATE business_operation_references c SET active = true, superseded_at = NULL
        FROM business_operation_references a
       WHERE a.operation_id = ${A} AND a.active AND c.operation_id = ${C} AND c.reference_kind = a.reference_kind
         AND c.normalized_value = a.normalized_value AND NOT c.active`);
    await this.tx.execute(sql`
      UPDATE business_operation_references a SET active = false, superseded_at = COALESCE(a.superseded_at, now())
       WHERE a.operation_id = ${A} AND EXISTS (SELECT 1 FROM business_operation_references c WHERE c.operation_id = ${C}
         AND c.reference_kind = a.reference_kind AND c.normalized_value = a.normalized_value)`);
    await this.tx.execute(sql`
      UPDATE business_operation_references a SET operation_id = ${C}
       WHERE a.operation_id = ${A} AND NOT EXISTS (SELECT 1 FROM business_operation_references c WHERE c.operation_id = ${C}
         AND c.reference_kind = a.reference_kind AND c.normalized_value = a.normalized_value)`);
    await step('links');

    // 4. Détails par type (absents de la canonique), listes du Sinistre, projections, Agenda.
    for (const table of ['business_operation_contract_details', 'business_operation_financing_details', 'business_operation_claim_details'] as const) {
      await this.tx.execute(sql`
        UPDATE ${sql.identifier(table)} SET operation_id = ${C}
         WHERE operation_id = ${A} AND NOT EXISTS (SELECT 1 FROM ${sql.identifier(table)} WHERE operation_id = ${C})`);
    }
    for (const table of ['business_operation_claim_damages', 'business_operation_claim_actions', 'business_operation_claim_exchanges'] as const) {
      await this.tx.execute(sql`UPDATE ${sql.identifier(table)} SET operation_id = ${C} WHERE operation_id = ${A}`);
    }
    await this.tx.execute(sql`
      UPDATE business_operation_claim_actions SET child_operation_id = CASE WHEN operation_id = ${C} THEN NULL ELSE ${C}::bigint END
       WHERE child_operation_id = ${A}`);
    await this.tx.execute(sql`
      UPDATE business_operation_claim_details SET insurance_contract_operation_id = CASE WHEN operation_id = ${C} THEN NULL ELSE ${C}::bigint END
       WHERE insurance_contract_operation_id = ${A}`);
    await this.tx.execute(sql`
      INSERT INTO business_operation_projection_suppressions (account_id, operation_id, projection_kind, projection_key, user_id, created_at)
      SELECT account_id, ${C}, projection_kind, projection_key, user_id, created_at FROM business_operation_projection_suppressions
       WHERE operation_id = ${A} ON CONFLICT DO NOTHING`);
    // Lot 82D (CDC v5 O-1) : éléments d'agenda, principal unique, appartenance USER
    // des documents et Pièces par le service unique de regroupement (aucune absorption).
    await reassignGroupingOnMerge(drizzleRunner(this.tx), acct, A, C);
    await this.tx.execute(sql`UPDATE document_operation_candidates SET t3_operation_id = ${C} WHERE t3_operation_id = ${A} AND account_id = ${acct}`);
    await step('details');

    // 5. Décisions de rapprochement remappées (F-051) — sans doublon actif.
    await this.tx.execute(sql`
      UPDATE business_operation_match_decisions a SET active = false, updated_at = now()
       WHERE a.candidate_operation_id = ${A} AND a.active AND EXISTS (
         SELECT 1 FROM business_operation_match_decisions c WHERE c.candidate_operation_id = ${C} AND c.active
            AND c.source_kind = a.source_kind AND c.source_entity_key = a.source_entity_key
            AND COALESCE(c.source_version, '') = COALESCE(a.source_version, ''))`);
    await this.tx.execute(sql`
      UPDATE business_operation_match_decisions SET candidate_operation_id = ${C}, updated_at = now()
       WHERE candidate_operation_id = ${A} AND account_id = ${acct} AND active`);
    await step('decisions');

    // 6. Hiérarchie : enfants re-parentés (C8.1 revérifié), parent repris si la canonique n'en a pas.
    const enfants = await rows<{ id: string; invalidated: boolean }>(this.tx, sql`
      SELECT id, invalidated_at IS NOT NULL AS invalidated FROM business_operations
       WHERE parent_operation_id = ${A} AND account_id = ${acct} AND merged_into_operation_id IS NULL ORDER BY id`);
    for (const e of enfants) {
      if (Number(e.id) === C) {
        await this.tx.execute(sql`UPDATE business_operations SET parent_operation_id = NULL, version = version + 1, updated_at = now() WHERE id = ${C}`);
        continue;
      }
      if (!e.invalidated) await this.setParent(Number(e.id), C, reasonCode);
      else await this.tx.execute(sql`UPDATE business_operations SET parent_operation_id = ${C}, version = version + 1, updated_at = now() WHERE id = ${Number(e.id)}`);
    }
    if (absorbed.parentOperationId !== null && canonical.parentOperationId === null && absorbed.parentOperationId !== C && canonical.invalidatedAt === null) {
      await this.setParent(C, absorbed.parentOperationId, reasonCode);
    }
    if (absorbed.parentOperationId !== null) {
      await this.tx.execute(sql`UPDATE business_operations SET parent_operation_id = NULL WHERE id = ${A}`);
    }
    await step('hierarchy');

    // 7. Absorbée : invalidée, redirigée, historisée des deux côtés.
    await this.tx.execute(sql`
      UPDATE business_operations
         SET merged_into_operation_id = ${C}, invalidated_at = COALESCE(invalidated_at, now()), invalidation_reason = 'MERGED',
             version = version + 1, updated_at = now()
       WHERE id = ${A}`);
    await this.tx.execute(sql`UPDATE business_operations SET version = version + 1, updated_at = now() WHERE id = ${C}`);
    await this.history(A, 'MERGED', reasonCode, { merged_into_operation_id: null, invalidation_reason: absorbed.invalidationReason }, { merged_into_operation_id: C });
    await this.history(C, 'MERGED', reasonCode, null, { absorbed_operation_id: A });
    this.emit('BUSINESS_OPERATION_MERGED', A, reasonCode, C);
    this.emit('BUSINESS_OPERATION_UPDATED', C, reasonCode);
    await step('done');
    return true;
  }
}
