/**
 * Lot 109A — relation Opération ↔ fournisseur (ticket P1 « Relations métier »,
 * §2, §4, §5) : SEUL écrivain de `business_operation_suppliers` (migration
 * 1100) et de son historique.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE DE PREUVE (déterministe, données persistées du compte, aucune IA)
 *
 * Un fournisseur est partie d'une Opération quand un document MEMBRE de
 * l'Opération (source DOCUMENT active) :
 *   · a un rôle d'émission (facture, acompte, avoir, devis, commande,
 *     contrat, rapport — mêmes rôles que `provider-equivalence.ts` : jamais
 *     une preuve de paiement, émise par la banque) ;
 *   · est relié à la fiche de ce fournisseur par un lien FIABLE
 *     (`document_suppliers` confirmé, ou lu avec certitude par T1) ;
 *   · et le fournisseur est actif, du compte.
 * Rôle :
 *   PROVIDER         la désignation du prestataire portée par CE document
 *                    (candidat T1), ou le nom de la fiche, est celle — ou une
 *                    désignation ÉQUIVALENTE prouvée (lot 86C) — du
 *                    prestataire de l'Opération ;
 *   DOCUMENT_ISSUER  sinon : émetteur légal d'une pièce de l'Opération, qui
 *                    n'en devient pas le prestataire (aucun transfert
 *                    d'identité légale).
 * Jamais : un fournisseur déduit d'un nom trouvé dans un texte, d'une simple
 * appartenance au même bien, ni un lien incertain.
 *
 * ÉTATS ET DÉCISIONS (§4)
 *   ACTIVE    lien en vigueur (origine T3 ou USER) ;
 *   REMOVED   retrait AUTOMATIQUE (preuve disparue, fusion, intercomptes) —
 *             rétabli automatiquement si la preuve revient ;
 *   REJECTED  refus ou retrait de l'UTILISATEUR — jamais rétabli
 *             automatiquement, aucune preuve ne l'emporte.
 * Un lien USER n'est jamais modifié par T3. Toute évolution est tracée
 * (`business_operation_supplier_history` : motif, provenance, corrélation,
 * avant / après).
 *
 * IDEMPOTENCE (AC11) : le plan compare l'état voulu à l'état persisté ; un
 * second passage sans changement n'écrit RIEN (ni ligne, ni historique).
 * Appelé dans la transaction (et sous le verrou consultatif) du moteur de
 * consolidation T3 (`reconsolidateOperation`), de la fusion
 * (`reassignGroupingOnMerge`) et des réparations du contrôle de cohérence :
 * aucun appel IA, aucune boucle d'événements.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { normalizeProvider } from '@/services/business-operations/consolidation/model';
import { buildProviderEquivalence, canonicalProviderKey, type ProviderEquivalence } from '@/services/business-operations/consolidation/provider-equivalence';
import type { GroupingRunner } from '@/services/business-operations/grouping/runner';

/** Version de la règle de preuve (portée par la preuve de chaque lien). */
export const OPERATION_SUPPLIER_RULE_VERSION = 1;
export const OPERATION_SUPPLIER_RULE = 'ISSUER_DOCUMENT_RELIABLE_SUPPLIER';

/** Rôles d'un document ÉMIS par un tiers (identiques à `provider-equivalence.ts`). */
export const OPERATION_SUPPLIER_ISSUER_ROLES: readonly string[] = [
  'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'QUOTE', 'ORDER', 'CONTRACT_DOCUMENT', 'REPORT',
];
const ISSUER = new Set(OPERATION_SUPPLIER_ISSUER_ROLES);

/** Preuves lues au plus par compte pour les équivalences de désignations (même borne que T3, lot 86C). */
const EQUIVALENCE_EVIDENCE_LIMIT = 5_000;

export type OperationSupplierRole = 'PROVIDER' | 'DOCUMENT_ISSUER' | 'INTERVENER' | 'BRAND';
export type OperationSupplierOrigin = 'T3' | 'USER';
export type OperationSupplierStatus = 'ACTIVE' | 'REMOVED' | 'REJECTED';
export const USER_OPERATION_SUPPLIER_ROLES: readonly OperationSupplierRole[] = ['PROVIDER', 'DOCUMENT_ISSUER', 'INTERVENER', 'BRAND'];

/** Une preuve : document membre × fiche fournisseur fiable. */
export interface SupplierEvidenceRow {
  operationId: number;
  fileId: number;
  sourceId: number;
  sourceRole: string | null;
  /** Prestataire porté par le candidat T1 de la source (`payload.provider`). */
  candidateProvider: string | null;
  supplierId: number;
  supplierName: string | null;
  reliable: boolean;
}

export interface ExistingOperationSupplier {
  id: number;
  operationId: number;
  supplierId: number;
  role: OperationSupplierRole;
  origin: OperationSupplierOrigin;
  status: OperationSupplierStatus;
  evidence: Record<string, unknown>;
  reasonCode: string | null;
}

export interface DesiredOperationSupplier {
  supplierId: number;
  role: 'PROVIDER' | 'DOCUMENT_ISSUER';
  evidence: { rule: string; version: number; files: number[]; sources: number[] };
}

export interface OperationSupplierPlan {
  add: DesiredOperationSupplier[];
  /** Lien T3 actif dont le rôle ou la preuve a changé. */
  update: Array<DesiredOperationSupplier & { id: number }>;
  /** Lien retiré automatiquement dont la preuve est revenue. */
  restore: Array<DesiredOperationSupplier & { id: number }>;
  /** Lien T3 actif sans preuve. */
  remove: Array<{ id: number; supplierId: number; role: OperationSupplierRole }>;
  /** Preuve présente mais refus de l'utilisateur (jamais rétabli). */
  suppressed: number[];
}

export const emptyPlan = (): OperationSupplierPlan => ({ add: [], update: [], restore: [], remove: [], suppressed: [] });
export const planIsEmpty = (p: OperationSupplierPlan): boolean => !p.add.length && !p.update.length && !p.restore.length && !p.remove.length;

const sortNum = (v: Iterable<number>) => [...new Set(v)].sort((a, b) => a - b);

/**
 * Fournisseurs PROUVÉS d'une Opération (pure, déterministe, indépendante de
 * l'ordre des preuves). `eq` : équivalences de désignations du compte.
 */
export function desiredOperationSuppliers(
  op: { id: number; provider: string | null },
  evidence: readonly SupplierEvidenceRow[],
  eq: ProviderEquivalence | null,
): DesiredOperationSupplier[] {
  const opKey = canonicalProviderKey(normalizeProvider(op.provider), eq);
  const par = new Map<number, { provider: boolean; files: Set<number>; sources: Set<number> }>();
  for (const e of evidence) {
    if (e.operationId !== op.id || !e.reliable || !e.sourceRole || !ISSUER.has(e.sourceRole)) continue;
    const g = par.get(e.supplierId) ?? { provider: false, files: new Set<number>(), sources: new Set<number>() };
    const cand = canonicalProviderKey(normalizeProvider(e.candidateProvider), eq);
    const fiche = canonicalProviderKey(normalizeProvider(e.supplierName), eq);
    if (opKey !== null && (cand === opKey || fiche === opKey)) g.provider = true;
    g.files.add(e.fileId);
    g.sources.add(e.sourceId);
    par.set(e.supplierId, g);
  }
  return [...par.entries()].sort(([a], [b]) => a - b).map(([supplierId, g]) => ({
    supplierId,
    role: g.provider ? 'PROVIDER' : 'DOCUMENT_ISSUER',
    evidence: { rule: OPERATION_SUPPLIER_RULE, version: OPERATION_SUPPLIER_RULE_VERSION, files: sortNum(g.files), sources: sortNum(g.sources) },
  }));
}

const sameEvidence = (a: Record<string, unknown>, b: DesiredOperationSupplier['evidence']) =>
  JSON.stringify({ rule: a.rule ?? null, version: a.version ?? null, files: a.files ?? null, sources: a.sources ?? null })
  === JSON.stringify({ rule: b.rule, version: b.version, files: b.files, sources: b.sources });

/** Plan d'écriture (pure) : état voulu × état persisté, décisions de l'utilisateur respectées. */
export function planOperationSuppliers(desired: readonly DesiredOperationSupplier[], existing: readonly ExistingOperationSupplier[]): OperationSupplierPlan {
  const plan = emptyPlan();
  const parFournisseur = new Map(existing.map((x) => [x.supplierId, x]));
  const voulus = new Set(desired.map((d) => d.supplierId));
  for (const d of desired) {
    const x = parFournisseur.get(d.supplierId);
    if (!x) { plan.add.push(d); continue; }
    if (x.status === 'REJECTED') { plan.suppressed.push(d.supplierId); continue; }
    if (x.origin === 'USER') continue; // décision de l'utilisateur : jamais modifiée par T3
    if (x.status === 'REMOVED') { plan.restore.push({ ...d, id: x.id }); continue; }
    if (x.role !== d.role || !sameEvidence(x.evidence, d.evidence)) plan.update.push({ ...d, id: x.id });
  }
  for (const x of existing) {
    if (x.status === 'ACTIVE' && x.origin === 'T3' && !voulus.has(x.supplierId)) plan.remove.push({ id: x.id, supplierId: x.supplierId, role: x.role });
  }
  plan.suppressed.sort((a, b) => a - b);
  return plan;
}

// ── Lectures (lecture seule, bornées au compte) ─────────────────────────────

let tablePrete: boolean | null = null;
/** Migration 1100 appliquée ? (une base sans elle ne fait jamais échouer T3). */
export async function operationSuppliersReady(r: GroupingRunner): Promise<boolean> {
  if (tablePrete) return true;
  const [x] = await r.q<{ ok: boolean }>(`SELECT to_regclass('business_operation_suppliers') IS NOT NULL AND to_regclass('business_operation_supplier_history') IS NOT NULL AS ok`);
  tablePrete = x?.ok === true;
  return tablePrete;
}

/** Équivalences de désignations du compte (mêmes preuves que T3, lot 86C). */
export async function loadAccountProviderEquivalence(r: GroupingRunner, accountId: number): Promise<ProviderEquivalence> {
  const rows = await r.q<{ file_id: number; supplier_id: number; supplier_name: string | null; reliable: boolean; provider: string | null; role: string | null }>(
    `SELECT ds.document_id AS file_id, ds.supplier_id, s.name AS supplier_name,
            (ds.is_confirmed OR COALESCE(ds.confidence_score, 0) >= 1) AS reliable,
            c.payload->>'provider' AS provider, c.payload->>'sourceRoleHint' AS role
       FROM document_suppliers ds
       JOIN suppliers s ON s.id = ds.supplier_id AND s.account_id = $1 AND s.status = 'active'
       JOIN asset_files f ON f.id = ds.document_id AND f.account_id = $1 AND f.deleted_at IS NULL
       JOIN document_operation_candidates c ON c.file_id = ds.document_id AND c.account_id = $1
        AND c.status = 'ACTIVE' AND c.established AND NULLIF(btrim(c.payload->>'provider'), '') IS NOT NULL
      ORDER BY ds.document_id DESC
      LIMIT ${EQUIVALENCE_EVIDENCE_LIMIT}`, [accountId]);
  return buildProviderEquivalence(rows.map((x) => ({
    fileId: Number(x.file_id), supplierId: Number(x.supplier_id), supplierName: x.supplier_name ?? null,
    provider: x.provider ?? null, role: x.role ?? null, reliable: x.reliable === true,
  })));
}

interface OperationState { id: number; provider: string | null; active: boolean; mergedInto: number | null; exists: boolean }

async function loadOperations(r: GroupingRunner, accountId: number, ids: readonly number[]): Promise<Map<number, OperationState>> {
  const rows = await r.q<{ id: number; provider: string | null; invalidated: boolean; merged: number | null }>(
    `SELECT id, provider, invalidated_at IS NOT NULL AS invalidated, merged_into_operation_id AS merged
       FROM business_operations WHERE account_id = $1 AND id = ANY($2::bigint[])`, [accountId, `{${sortNum(ids).join(',')}}`]);
  const m = new Map<number, OperationState>();
  for (const x of rows) {
    m.set(Number(x.id), { id: Number(x.id), provider: x.provider ?? null, active: !x.invalidated && x.merged === null, mergedInto: x.merged === null ? null : Number(x.merged), exists: true });
  }
  return m;
}

async function loadEvidence(r: GroupingRunner, accountId: number, ids: readonly number[]): Promise<SupplierEvidenceRow[]> {
  if (!ids.length) return [];
  const rows = await r.q<Record<string, unknown>>(
    `SELECT s.operation_id, f.id AS file_id, s.id AS source_id,
            COALESCE(s.source_role, c.payload->>'sourceRoleHint') AS source_role,
            c.payload->>'provider' AS candidate_provider,
            ds.supplier_id, sp.name AS supplier_name,
            (ds.is_confirmed OR COALESCE(ds.confidence_score, 0) >= 1) AS reliable
       FROM business_operation_sources s
       JOIN asset_files f ON f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
        AND f.account_id = $1 AND f.deleted_at IS NULL
       JOIN document_suppliers ds ON ds.document_id = f.id
       JOIN suppliers sp ON sp.id = ds.supplier_id AND sp.account_id = $1 AND sp.status = 'active'
       LEFT JOIN document_operation_candidates c ON c.file_id = f.id AND c.account_id = $1 AND c.status = 'ACTIVE'
        AND c.candidate_key = s.locator->>'candidateKey'
      WHERE s.account_id = $1 AND s.operation_id = ANY($2::bigint[]) AND s.active AND s.source_kind = 'DOCUMENT'
      ORDER BY s.operation_id, f.id, ds.supplier_id, s.id`, [accountId, `{${sortNum(ids).join(',')}}`]);
  return rows.map((x) => ({
    operationId: Number(x.operation_id), fileId: Number(x.file_id), sourceId: Number(x.source_id),
    sourceRole: (x.source_role as string | null) ?? null, candidateProvider: (x.candidate_provider as string | null) ?? null,
    supplierId: Number(x.supplier_id), supplierName: (x.supplier_name as string | null) ?? null, reliable: x.reliable === true,
  }));
}

async function loadExisting(r: GroupingRunner, accountId: number, ids: readonly number[]): Promise<ExistingOperationSupplier[]> {
  if (!ids.length) return [];
  const rows = await r.q<Record<string, unknown>>(
    `SELECT id, operation_id, supplier_id, role, origin, status, evidence, reason_code
       FROM business_operation_suppliers WHERE account_id = $1 AND operation_id = ANY($2::bigint[]) ORDER BY operation_id, supplier_id`,
    [accountId, `{${sortNum(ids).join(',')}}`]);
  return rows.map((x) => ({
    id: Number(x.id), operationId: Number(x.operation_id), supplierId: Number(x.supplier_id),
    role: x.role as OperationSupplierRole, origin: x.origin as OperationSupplierOrigin, status: x.status as OperationSupplierStatus,
    evidence: (typeof x.evidence === 'string' ? JSON.parse(x.evidence) : x.evidence ?? {}) as Record<string, unknown>,
    reasonCode: (x.reason_code as string | null) ?? null,
  }));
}

/** État examiné d'une Opération (contrôle de cohérence, rapport BO). */
export interface OperationSupplierInspection {
  exists: boolean;
  active: boolean;
  mergedInto: number | null;
  plan: OperationSupplierPlan;
  /** Liens (tous états) vers une fiche d'un autre compte ou supprimée. */
  crossAccount: number[];
  /** Liens encore actifs sur une Opération absorbée (héritage obsolète). */
  inheritedOnMerged: number[];
  linked: Array<{ supplierId: number; role: OperationSupplierRole; origin: OperationSupplierOrigin; status: OperationSupplierStatus }>;
}

/** Inspection en LECTURE SEULE d'un lot d'Opérations du compte. */
export async function inspectOperationSuppliers(r: GroupingRunner, accountId: number, operationIds: readonly number[]): Promise<Map<number, OperationSupplierInspection>> {
  const out = new Map<number, OperationSupplierInspection>();
  const ids = sortNum(operationIds);
  if (!ids.length) return out;
  const ops = await loadOperations(r, accountId, ids);
  const actives = ids.filter((id) => ops.get(id)?.active);
  // Séquentiel : l'exécuteur peut être une transaction (une seule connexion).
  const evidence = await loadEvidence(r, accountId, actives);
  const existing = await loadExisting(r, accountId, ids);
  const eq = actives.length && evidence.length ? await loadAccountProviderEquivalence(r, accountId) : null;
  const cross = await r.q<{ operation_id: number; supplier_id: number }>(
    `SELECT l.operation_id, l.supplier_id FROM business_operation_suppliers l LEFT JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.account_id = $1 AND l.operation_id = ANY($2::bigint[]) AND l.status <> 'REMOVED' AND s.account_id IS DISTINCT FROM $1`,
    [accountId, `{${ids.join(',')}}`]);
  for (const id of ids) {
    const op = ops.get(id);
    const liens = existing.filter((x) => x.operationId === id);
    const insp: OperationSupplierInspection = {
      exists: !!op, active: !!op?.active, mergedInto: op?.mergedInto ?? null, plan: emptyPlan(),
      crossAccount: cross.filter((c) => Number(c.operation_id) === id).map((c) => Number(c.supplier_id)),
      inheritedOnMerged: op && op.mergedInto !== null ? liens.filter((x) => x.status === 'ACTIVE').map((x) => x.supplierId) : [],
      linked: liens.map((x) => ({ supplierId: x.supplierId, role: x.role, origin: x.origin, status: x.status })),
    };
    if (op?.active) insp.plan = planOperationSuppliers(desiredOperationSuppliers(op, evidence, eq), liens);
    out.set(id, insp);
  }
  return out;
}

// ── Écritures (sous le verrou des Opérations du compte) ────────────────────

export interface OperationSupplierWriteContext {
  correlationId?: string | null;
  /** Motif tracé (T3_OPERATION_SUPPLIERS, COHERENCE_REPAIR…). */
  reasonCode?: string;
  actorUserId?: number | null;
}

export interface OperationSupplierSyncResult {
  operations: number;
  added: number;
  updated: number;
  restored: number;
  removed: number;
  transferred: number;
  suppressed: number;
  /** Nombre total d'écritures (0 : idempotent). */
  changed: number;
}

const emptyResult = (): OperationSupplierSyncResult => ({ operations: 0, added: 0, updated: 0, restored: 0, removed: 0, transferred: 0, suppressed: 0, changed: 0 });

async function history(
  r: GroupingRunner, accountId: number, operationId: number, supplierId: number,
  action: 'LINKED' | 'UPDATED' | 'REMOVED' | 'RESTORED' | 'REJECTED' | 'TRANSFERRED',
  p: { role: string | null; origin: string | null; reason: string; ctx: OperationSupplierWriteContext; before?: unknown; after?: unknown },
): Promise<void> {
  await r.q(
    `INSERT INTO business_operation_supplier_history
       (account_id, operation_id, supplier_id, action, role, origin, reason_code, actor_user_id, correlation_id, before_json, after_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
    [accountId, operationId, supplierId, action, p.role, p.origin, p.reason, p.ctx.actorUserId ?? null, p.ctx.correlationId ?? null,
      p.before === undefined ? null : JSON.stringify(p.before), p.after === undefined ? null : JSON.stringify(p.after)]);
}

/** Applique le plan d'UNE Opération. Rend le nombre d'écritures. */
async function applyPlan(r: GroupingRunner, accountId: number, operationId: number, plan: OperationSupplierPlan, ctx: OperationSupplierWriteContext, res: OperationSupplierSyncResult): Promise<void> {
  const reason = ctx.reasonCode ?? 'T3_OPERATION_SUPPLIERS';
  for (const a of plan.add) {
    const [x] = await r.q<{ id: number }>(
      `INSERT INTO business_operation_suppliers (account_id, operation_id, supplier_id, role, origin, status, evidence, reason_code, correlation_id)
       VALUES ($1, $2, $3, $4, 'T3', 'ACTIVE', $5::jsonb, $6, $7)
       ON CONFLICT (operation_id, supplier_id) DO NOTHING RETURNING id`,
      [accountId, operationId, a.supplierId, a.role, JSON.stringify(a.evidence), reason, ctx.correlationId ?? null]);
    if (!x) continue;
    await history(r, accountId, operationId, a.supplierId, 'LINKED', { role: a.role, origin: 'T3', reason, ctx, after: { role: a.role, evidence: a.evidence } });
    res.added++;
  }
  for (const u of [...plan.update, ...plan.restore]) {
    const restore = plan.restore.includes(u as never);
    const [avant] = await r.q<{ role: string; status: string; evidence: unknown }>(
      `SELECT role, status, evidence FROM business_operation_suppliers WHERE id = $1 AND account_id = $2 AND origin = 'T3' AND status <> 'REJECTED' FOR UPDATE`, [u.id, accountId]);
    if (!avant) continue;
    await r.q(
      `UPDATE business_operation_suppliers SET role = $3, status = 'ACTIVE', evidence = $4::jsonb, reason_code = $5, correlation_id = $6, updated_at = now()
        WHERE id = $1 AND account_id = $2`, [u.id, accountId, u.role, JSON.stringify(u.evidence), restore ? `${reason}_EVIDENCE_RESTORED` : reason, ctx.correlationId ?? null]);
    await history(r, accountId, operationId, u.supplierId, restore ? 'RESTORED' : 'UPDATED', {
      role: u.role, origin: 'T3', reason: restore ? `${reason}_EVIDENCE_RESTORED` : reason, ctx,
      before: { role: avant.role, status: avant.status, evidence: avant.evidence }, after: { role: u.role, status: 'ACTIVE', evidence: u.evidence },
    });
    if (restore) res.restored++; else res.updated++;
  }
  for (const x of plan.remove) {
    const done = await r.q(
      `UPDATE business_operation_suppliers SET status = 'REMOVED', reason_code = $3, correlation_id = $4, updated_at = now()
        WHERE id = $1 AND account_id = $2 AND origin = 'T3' AND status = 'ACTIVE' RETURNING id`,
      [x.id, accountId, 'EVIDENCE_WITHDRAWN', ctx.correlationId ?? null]);
    if (!done.length) continue;
    await history(r, accountId, operationId, x.supplierId, 'REMOVED', { role: x.role, origin: 'T3', reason: 'EVIDENCE_WITHDRAWN', ctx, before: { status: 'ACTIVE' }, after: { status: 'REMOVED' } });
    res.removed++;
  }
  res.suppressed += plan.suppressed.length;
}

/**
 * Synchronise les fournisseurs PROUVÉS des Opérations (actives) du compte.
 * À appeler DANS une transaction qui détient le verrou des Opérations du
 * compte (T3, fusion, réparation). Une Opération absorbée voit ses liens
 * rapatriés vers la canonique (héritage obsolète, §4) ; une Opération
 * invalidée est laissée telle quelle (lecture : jamais exposée).
 */
export async function syncOperationSuppliers(
  r: GroupingRunner, accountId: number, operationIds: readonly number[], ctx: OperationSupplierWriteContext = {},
): Promise<OperationSupplierSyncResult> {
  const res = emptyResult();
  if (!(await operationSuppliersReady(r))) return res;
  const insp = await inspectOperationSuppliers(r, accountId, operationIds);
  for (const [id, x] of insp) {
    if (!x.exists) continue;
    res.operations++;
    if (x.mergedInto !== null && x.inheritedOnMerged.length) {
      const canonique = await resolveCanonical(r, accountId, x.mergedInto);
      if (canonique !== null) res.transferred += await reassignOperationSuppliersOnMerge(r, accountId, id, canonique, ctx);
      continue;
    }
    if (!x.active) continue;
    await applyPlan(r, accountId, id, x.plan, ctx, res);
  }
  res.changed = res.added + res.updated + res.restored + res.removed + res.transferred;
  return res;
}

async function resolveCanonical(r: GroupingRunner, accountId: number, start: number): Promise<number | null> {
  let id = start;
  for (let i = 0; i < 20; i++) {
    const [o] = await r.q<{ merged: number | null }>(`SELECT merged_into_operation_id AS merged FROM business_operations WHERE id = $1 AND account_id = $2`, [id, accountId]);
    if (!o) return null;
    if (o.merged === null) return id;
    id = Number(o.merged);
  }
  return null;
}

/**
 * Fusion (§4) : les décisions de l'utilisateur (liens USER, refus) suivent
 * la canonique — sans écraser une décision de l'utilisateur déjà portée par
 * la canonique ; les liens T3 de l'absorbée sont retirés (la canonique les
 * recalcule depuis ses sources, dans la même transaction de consolidation).
 * Rend le nombre d'écritures. Aucun lien hérité ne reste actif.
 */
export async function reassignOperationSuppliersOnMerge(
  r: GroupingRunner, accountId: number, absorbedId: number, canonicalId: number, ctx: OperationSupplierWriteContext = {},
): Promise<number> {
  if (!(await operationSuppliersReady(r)) || absorbedId === canonicalId) return 0;
  const liens = await loadExisting(r, accountId, [absorbedId, canonicalId]);
  const cible = new Map(liens.filter((x) => x.operationId === canonicalId).map((x) => [x.supplierId, x]));
  let n = 0;
  for (const a of liens.filter((x) => x.operationId === absorbedId && x.status !== 'REMOVED')) {
    const c = cible.get(a.supplierId);
    if (a.origin === 'USER' || a.status === 'REJECTED') {
      if (!c) {
        await r.q(`UPDATE business_operation_suppliers SET operation_id = $3, reason_code = 'OPERATION_MERGED', correlation_id = $4, updated_at = now() WHERE id = $1 AND account_id = $2`,
          [a.id, accountId, canonicalId, ctx.correlationId ?? null]);
        await history(r, accountId, canonicalId, a.supplierId, 'TRANSFERRED', { role: a.role, origin: a.origin, reason: 'OPERATION_MERGED', ctx, before: { operationId: absorbedId }, after: { operationId: canonicalId, status: a.status } });
        n++;
        continue;
      }
      if (c.origin !== 'USER' && c.status !== 'REJECTED') {
        // La décision de l'utilisateur l'emporte sur un lien automatique de la canonique.
        await r.q(`UPDATE business_operation_suppliers SET role = $3, origin = $4, status = $5, reason_code = 'OPERATION_MERGED', correlation_id = $6, updated_at = now() WHERE id = $1 AND account_id = $2`,
          [c.id, accountId, a.role, a.origin, a.status, ctx.correlationId ?? null]);
        await history(r, accountId, canonicalId, a.supplierId, 'TRANSFERRED', { role: a.role, origin: a.origin, reason: 'OPERATION_MERGED', ctx, before: { role: c.role, origin: c.origin, status: c.status }, after: { role: a.role, origin: a.origin, status: a.status } });
        n++;
      }
    }
    // Reste sur l'absorbée : retirée (la ligne USER déplacée ci-dessus n'y est plus).
    const retire = await r.q(`UPDATE business_operation_suppliers SET status = 'REMOVED', reason_code = 'OPERATION_MERGED', correlation_id = $3, updated_at = now()
                                WHERE id = $1 AND account_id = $2 AND status <> 'REMOVED' RETURNING id`, [a.id, accountId, ctx.correlationId ?? null]);
    if (!retire.length) continue;
    n++;
    await history(r, accountId, absorbedId, a.supplierId, 'REMOVED', { role: a.role, origin: a.origin, reason: 'OPERATION_MERGED', ctx, before: { status: a.status }, after: { status: 'REMOVED', canonicalId } });
  }
  return n;
}

/**
 * Transfert d'un bien (Duo) : liens devenus intercomptes (Opération déplacée,
 * fiche restée dans l'ancien compte) retirés, tracés. Appelée dans la
 * transaction du transfert (`detachCrossAccountGroupingInTx`).
 */
export async function detachCrossAccountOperationSuppliers(r: GroupingRunner, accountIds: readonly number[]): Promise<number> {
  if (!(await operationSuppliersReady(r))) return 0;
  const x = await r.q<{ id: number; account_id: number; operation_id: number; supplier_id: number; role: string; origin: string }>(
    `UPDATE business_operation_suppliers l SET status = 'REMOVED', reason_code = 'CROSS_ACCOUNT_DETACHED', updated_at = now()
       FROM suppliers s
      WHERE s.id = l.supplier_id AND l.account_id = ANY($1::int[]) AND s.account_id <> l.account_id AND l.status <> 'REMOVED'
     RETURNING l.id, l.account_id, l.operation_id, l.supplier_id, l.role, l.origin`, [`{${sortNum(accountIds).join(',')}}`]);
  for (const y of x) {
    await history(r, Number(y.account_id), Number(y.operation_id), Number(y.supplier_id), 'REMOVED', { role: y.role, origin: y.origin, reason: 'CROSS_ACCOUNT_DETACHED', ctx: {} });
  }
  return x.length;
}

/**
 * Fusion de deux FICHES fournisseur (À traiter › doublon) : les liens de la
 * fiche absorbée sont reportés sur la fiche conservée (décision de
 * l'utilisateur la plus forte, aucun doublon), puis la consolidation
 * recalcule les liens T3 depuis les preuves (`document_suppliers` reportés).
 */
export async function mergeOperationSupplierRecords(
  r: GroupingRunner, p: { accountId: number; fromSupplierId: number; toSupplierId: number; actorUserId?: number | null; correlationId?: string | null },
): Promise<number> {
  if (!(await operationSuppliersReady(r)) || p.fromSupplierId === p.toSupplierId) return 0;
  const ctx: OperationSupplierWriteContext = { actorUserId: p.actorUserId ?? null, correlationId: p.correlationId ?? null };
  const liens = await r.q<{ id: number; operation_id: number; role: string; origin: string; status: string }>(
    `SELECT id, operation_id, role, origin, status FROM business_operation_suppliers WHERE account_id = $1 AND supplier_id = $2 AND status <> 'REMOVED' ORDER BY id`,
    [p.accountId, p.fromSupplierId]);
  let n = 0;
  for (const l of liens) {
    const [c] = await r.q<{ id: number; origin: string; status: string }>(
      `SELECT id, origin, status FROM business_operation_suppliers WHERE operation_id = $1 AND supplier_id = $2 AND account_id = $3`, [l.operation_id, p.toSupplierId, p.accountId]);
    if (!c) {
      await r.q(`UPDATE business_operation_suppliers SET supplier_id = $3, reason_code = 'SUPPLIER_MERGED', updated_at = now() WHERE id = $1 AND account_id = $2`, [l.id, p.accountId, p.toSupplierId]);
    } else {
      if (l.origin === 'USER' && c.origin !== 'USER') {
        await r.q(`UPDATE business_operation_suppliers SET role = $3, origin = 'USER', status = $4, reason_code = 'SUPPLIER_MERGED', updated_at = now() WHERE id = $1 AND account_id = $2`, [c.id, p.accountId, l.role, l.status]);
      }
      await r.q(`UPDATE business_operation_suppliers SET status = 'REMOVED', reason_code = 'SUPPLIER_MERGED', updated_at = now() WHERE id = $1 AND account_id = $2`, [l.id, p.accountId]);
    }
    await history(r, p.accountId, Number(l.operation_id), p.toSupplierId, 'TRANSFERRED', { role: l.role, origin: l.origin, reason: 'SUPPLIER_MERGED', ctx, before: { supplierId: p.fromSupplierId }, after: { supplierId: p.toSupplierId } });
    n++;
  }
  return n;
}

// ── Gestes de l'utilisateur (décisions durables) ───────────────────────────

/**
 * Décision de l'utilisateur sur le couple (Opération, fournisseur) :
 *   LINK    lien USER actif avec le rôle choisi (remplace un lien T3) ;
 *   REJECT  refus ou retrait mémorisé (jamais rétabli automatiquement).
 * `false` : Opération ou fournisseur absent du compte (rien n'est écrit).
 * À appeler sous le verrou des Opérations du compte.
 */
export async function decideOperationSupplierInTx(
  r: GroupingRunner, accountId: number,
  p: { operationId: number; supplierId: number; decision: 'LINK' | 'REJECT'; role?: OperationSupplierRole; userId: number | null; correlationId?: string | null },
): Promise<boolean> {
  if (!(await operationSuppliersReady(r))) return false;
  const [ok] = await r.q<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM business_operations WHERE id = $1 AND account_id = $3 AND invalidated_at IS NULL AND merged_into_operation_id IS NULL)
        AND EXISTS (SELECT 1 FROM suppliers WHERE id = $2 AND account_id = $3 AND status <> 'deleted') AS ok`, [p.operationId, p.supplierId, accountId]);
  if (!ok?.ok) return false;
  const role: OperationSupplierRole = p.role && USER_OPERATION_SUPPLIER_ROLES.includes(p.role) ? p.role : 'PROVIDER';
  const status: OperationSupplierStatus = p.decision === 'LINK' ? 'ACTIVE' : 'REJECTED';
  const [avant] = await r.q<{ role: string; origin: string; status: string }>(
    `SELECT role, origin, status FROM business_operation_suppliers WHERE operation_id = $1 AND supplier_id = $2 AND account_id = $3 FOR UPDATE`, [p.operationId, p.supplierId, accountId]);
  if (avant && avant.origin === 'USER' && avant.status === status && (status === 'REJECTED' || avant.role === role)) return true; // idempotent
  await r.q(
    `INSERT INTO business_operation_suppliers (account_id, operation_id, supplier_id, role, origin, status, reason_code, decided_by_user_id, decided_at, correlation_id)
     VALUES ($1, $2, $3, $4, 'USER', $5, $6, $7, now(), $8)
     ON CONFLICT (operation_id, supplier_id) DO UPDATE
        SET role = EXCLUDED.role, origin = 'USER', status = EXCLUDED.status, reason_code = EXCLUDED.reason_code,
            decided_by_user_id = EXCLUDED.decided_by_user_id, decided_at = now(), correlation_id = EXCLUDED.correlation_id, updated_at = now()`,
    [accountId, p.operationId, p.supplierId, avant && status === 'REJECTED' ? avant.role : role, status, p.decision === 'LINK' ? 'USER_LINKED' : 'USER_REJECTED', p.userId, p.correlationId ?? null]);
  await history(r, accountId, p.operationId, p.supplierId, p.decision === 'LINK' ? 'LINKED' : 'REJECTED', {
    role, origin: 'USER', reason: p.decision === 'LINK' ? 'USER_LINKED' : 'USER_REJECTED', ctx: { actorUserId: p.userId, correlationId: p.correlationId ?? null },
    before: avant ?? null, after: { role, origin: 'USER', status },
  });
  return true;
}

/** Même geste, dans sa propre transaction (verrou des Opérations du compte). */
export async function decideOperationSupplier(
  accountId: number, p: Parameters<typeof decideOperationSupplierInTx>[2],
): Promise<boolean> {
  const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
  const { drizzleRunner } = await import('@/services/business-operations/grouping/runner');
  return withBusinessOperationWrite(accountId, async (_repo, session) => decideOperationSupplierInTx(drizzleRunner(session.tx), accountId, p), { correlationId: p.correlationId ?? undefined });
}

/**
 * Réparation / reprise : synchronisation dans sa propre transaction, sous le
 * verrou des Opérations du compte (même sérialisation que T3).
 */
export async function syncOperationSuppliersForAccount(
  accountId: number, operationIds: readonly number[], ctx: OperationSupplierWriteContext = {},
): Promise<OperationSupplierSyncResult> {
  if (!operationIds.length) return emptyResult();
  const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
  const { drizzleRunner } = await import('@/services/business-operations/grouping/runner');
  return withBusinessOperationWrite(accountId, async (_repo, session) =>
    syncOperationSuppliers(drizzleRunner(session.tx), accountId, operationIds, { ...ctx, correlationId: ctx.correlationId ?? session.correlationId }),
  { correlationId: ctx.correlationId ?? undefined });
}

/**
 * Lien document ↔ fournisseur posé, corrigé, retiré ou reporté (fusion de
 * fiches) : demande la reconsolidation T3 DURABLE des Opérations dont ces
 * documents sont membres (file existante, déclencheur C4 `document_linked`,
 * dédoublonnée par compte) — jamais d'appel T3 à l'ouverture d'une fiche.
 * Rien n'est demandé pour un document hors Opération. Ne lève jamais.
 */
export async function requestOperationSupplierResync(accountId: number, fileIds: readonly number[]): Promise<number> {
  try {
    const ids = sortNum(fileIds.filter((f) => Number.isSafeInteger(f) && f > 0));
    if (!ids.length) return 0;
    const { pgClient } = await import('@/db');
    const membres = (await pgClient.unsafe(
      `SELECT DISTINCT (source_entity_key)::int AS f FROM business_operation_sources
        WHERE account_id = $1 AND active AND source_kind = 'DOCUMENT' AND source_entity_key = ANY($2::text[]) ORDER BY 1`,
      [accountId, `{${ids.join(',')}}`] as never[],
    )) as unknown as Array<{ f: number }>;
    if (!membres.length) return 0;
    // Séquentiel : les demandes du compte fusionnent dans UN travail dédoublonné (`append_events`) ;
    // des insertions concurrentes se disputeraient la clé de déduplication.
    const { requestOperationsConsolidation } = await import('@/services/business-operations/consolidation/queue');
    for (const m of membres) await requestOperationsConsolidation(accountId, { trigger: 'document_linked', fileId: Number(m.f) });
    return membres.length;
  } catch (e) {
    console.error(`[relations] demande de réévaluation des fournisseurs (compte ${accountId}) :`, (e as Error).message);
    return 0;
  }
}

/**
 * Lot 113G — même report, dans la transaction EXISTANTE de la fusion de fiches
 * (`supplier-merge.ts`, « Oui » sur « S'agit-il du même fournisseur ? ») : ce
 * module reste le SEUL à ouvrir l'écriture Opération (INV-FINAL-009). Les
 * événements rendus sont publiés par l'appelant APRÈS le commit.
 */
export async function mergeOperationSupplierRecordsInTx(
  tx: unknown, p: { accountId: number; fromSupplierId: number; toSupplierId: number; actorUserId?: number | null },
): Promise<{ merged: number; events: unknown[] }> {
  const { drizzleRunner } = await import('@/services/business-operations/grouping/runner');
  const { withBusinessOperationWriteInTx } = await import('@/services/business-operations/write');
  const { result, events } = await withBusinessOperationWriteInTx(tx as never, [p.accountId], async (s) => mergeOperationSupplierRecords(drizzleRunner(s.tx), {
    accountId: p.accountId, fromSupplierId: p.fromSupplierId, toSupplierId: p.toSupplierId, actorUserId: p.actorUserId ?? null, correlationId: s.correlationId,
  }));
  return { merged: Number(result) || 0, events };
}

/**
 * Intégration lot 109 — fusion de deux fiches fournisseur (décision de
 * l'utilisateur dans « À traiter ») : liens Opération ↔ fournisseur reportés
 * sur la fiche conservée, sous le verrou d'écriture des Opérations du compte,
 * puis réévaluation T3 durable des Opérations des documents reportés. Point
 * d'entrée SERVICE : les routes n'ouvrent jamais elles-mêmes une écriture
 * Opération (garde ACC-018 / P09).
 */
export async function mergeOperationSuppliersAfterSupplierMerge(p: {
  accountId: number; fromSupplierId: number; toSupplierId: number; actorUserId?: number | null; documentIds: readonly number[];
}): Promise<{ merged: number; resyncRequested: number }> {
  const { drizzleRunner } = await import('@/services/business-operations/grouping/runner');
  const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
  const merged = await withBusinessOperationWrite(p.accountId, async (_repo, s) => mergeOperationSupplierRecords(drizzleRunner(s.tx), {
    accountId: p.accountId, fromSupplierId: p.fromSupplierId, toSupplierId: p.toSupplierId, actorUserId: p.actorUserId ?? null, correlationId: s.correlationId,
  }));
  const resyncRequested = await requestOperationSupplierResync(p.accountId, p.documentIds);
  return { merged: Number(merged) || 0, resyncRequested };
}
