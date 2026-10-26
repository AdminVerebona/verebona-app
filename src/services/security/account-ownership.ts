/**
 * Contrôles d'APPARTENANCE au compte — lot 49 (ticket SEC-P0, « contrôles
 * transversaux »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE
 *
 * Toute opération identifie le compte actif (session ou contexte serveur du
 * traitement), puis vérifie que l'objet principal ET chaque objet référencé
 * appartiennent à ce compte. Un seul identifiant étranger — ou inexistant —
 * fait refuser l'opération ENTIÈRE, avant toute écriture. Le message ne
 * distingue jamais « inexistant » de « appartient à un autre compte » : rien
 * n'est révélé sur les données d'autrui.
 *
 * Appartenance d'un objet (une seule définition, ici) :
 *   · bien          assets.account_id
 *   · document      asset_files.account_id
 *   · pièce         substructures → bien porteur (assets.account_id)
 *   · équipement    equipments → bien porteur (assets.account_id)
 *   · fournisseur   suppliers.account_id
 *   · événement     events.account_id (domaine historique)
 *   · échéance      deadlines.account_id (domaine historique)
 *   · agenda        agenda_items.account_id
 *   · Opération     business_operations.account_id (lot 54, SEC-05)
 *
 * Utilisable par les routes, les services de persistance et les traitements
 * asynchrones : chaque fonction accepte l'exécutant (base ou transaction
 * Drizzle) pour que la vérification soit faite DANS la transaction de
 * l'écriture (atomicité, AC04).
 *
 * Les écritures sensibles portent EN PLUS la condition de compte dans leur
 * propre SQL (`ownedSql`) : la vérification préalable n'est jamais la seule
 * barrière (une course entre la lecture et l'écriture ne crée rien).
 *
 * Coût : une requête par appel, par clé primaire (`= ANY`), quelle que soit
 * la liste ; aucun balayage.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';

/** Types d'objets contrôlés. */
export type OwnedKind =
  | 'asset' | 'file' | 'substructure' | 'equipment' | 'supplier' | 'event' | 'deadline' | 'agenda_item' | 'operation';

const OWNED_KINDS: readonly OwnedKind[] = [
  'asset', 'file', 'substructure', 'equipment', 'supplier', 'event', 'deadline', 'agenda_item', 'operation',
];

/** Références d'une opération, par type (listes ou identifiant seul). */
export type OwnershipRefs = Partial<Record<OwnedKind, ReadonlyArray<number | null | undefined> | number | null | undefined>>;

/** Exécutant SQL : `db` ou une transaction Drizzle. */
export interface SqlExecutor {
  execute: (query: SQL) => Promise<unknown>;
}

/** Référence refusée (étrangère ou introuvable). */
export interface RejectedRef {
  kind: OwnedKind;
  id: number;
  /** `foreign` : existe dans un autre compte ; `missing` : introuvable. */
  reason: 'foreign' | 'missing';
}

/**
 * Refus d'une opération : une référence n'appartient pas au compte actif.
 * Le message destiné à l'utilisateur ne cite aucune donnée d'un autre compte.
 */
export class CrossAccountReferenceError extends Error {
  readonly code = 'CROSS_ACCOUNT_REFERENCE';
  readonly status = 404;
  constructor(readonly accountId: number, readonly rejected: RejectedRef[]) {
    super(`Référence introuvable dans le compte (${rejected.map((r) => `${r.kind} ${r.id}`).join(', ')}).`);
    this.name = 'CrossAccountReferenceError';
  }
}

export function isCrossAccountReferenceError(e: unknown): e is CrossAccountReferenceError {
  return e instanceof CrossAccountReferenceError
    || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'CROSS_ACCOUNT_REFERENCE');
}

/** Entiers strictement positifs, dédoublonnés. */
export function cleanIds(v: ReadonlyArray<number | null | undefined> | number | null | undefined): number[] {
  const list = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v as number];
  return [...new Set(list.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0 && x <= 2_147_483_647))];
}

/** Tableau d'entiers en un seul paramètre (`'{1,2}'::int[]`). */
const intArray = (ids: readonly number[]) => sql`${`{${ids.join(',')}}`}::int[]`;

/** Lecture « identifiant → compte propriétaire » d'un type d'objet. */
function ownerQuery(kind: OwnedKind, ids: readonly number[]): SQL {
  const a = intArray(ids);
  switch (kind) {
    case 'asset': return sql`SELECT 'asset' AS kind, id, account_id FROM assets WHERE id = ANY(${a})`;
    case 'file': return sql`SELECT 'file' AS kind, id, account_id FROM asset_files WHERE id = ANY(${a})`;
    case 'substructure': return sql`SELECT 'substructure' AS kind, s.id, b.account_id FROM substructures s JOIN assets b ON b.id = s.asset_id WHERE s.id = ANY(${a})`;
    case 'equipment': return sql`SELECT 'equipment' AS kind, e.id, b.account_id FROM equipments e JOIN assets b ON b.id = e.asset_id WHERE e.id = ANY(${a})`;
    case 'supplier': return sql`SELECT 'supplier' AS kind, id, account_id FROM suppliers WHERE id = ANY(${a})`;
    case 'event': return sql`SELECT 'event' AS kind, id, account_id FROM events WHERE id = ANY(${a})`;
    case 'deadline': return sql`SELECT 'deadline' AS kind, id, account_id FROM deadlines WHERE id = ANY(${a})`;
    case 'agenda_item': return sql`SELECT 'agenda_item' AS kind, id, account_id FROM agenda_items WHERE id = ANY(${a})`;
    case 'operation': return sql`SELECT 'operation' AS kind, id::int AS id, account_id FROM business_operations WHERE id = ANY(${a})`;
  }
}

/** Requêtes groupées en UNE instruction (UNION ALL). */
async function readOwners(exec: SqlExecutor, refs: OwnershipRefs): Promise<{ wanted: Map<OwnedKind, number[]>; owners: Map<string, number | null> }> {
  const wanted = new Map<OwnedKind, number[]>();
  for (const k of OWNED_KINDS) {
    const ids = cleanIds(refs[k]);
    if (ids.length) wanted.set(k, ids);
  }
  const owners = new Map<string, number | null>();
  if (wanted.size === 0) return { wanted, owners };
  const parts = [...wanted.entries()].map(([k, ids]) => ownerQuery(k, ids));
  const rows = (await exec.execute(sql.join(parts, sql` UNION ALL `))) as unknown as Array<{ kind: string; id: number; account_id: number | null }>;
  for (const r of rows) owners.set(`${r.kind}:${Number(r.id)}`, r.account_id === null || r.account_id === undefined ? null : Number(r.account_id));
  return { wanted, owners };
}

async function defaultExecutor(): Promise<SqlExecutor> {
  const { db } = await import('@/db');
  return db as unknown as SqlExecutor;
}

/**
 * Références refusées pour `accountId` : étrangères ET introuvables (une
 * référence introuvable ne peut pas être écrite non plus). Rend `[]` si tout
 * appartient au compte.
 */
export async function findRejectedRefs(accountId: number, refs: OwnershipRefs, exec?: SqlExecutor): Promise<RejectedRef[]> {
  const { wanted, owners } = await readOwners(exec ?? await defaultExecutor(), refs);
  const out: RejectedRef[] = [];
  for (const [kind, ids] of wanted) {
    for (const id of ids) {
      const k = `${kind}:${id}`;
      if (!owners.has(k)) out.push({ kind, id, reason: 'missing' });
      else if (owners.get(k) !== accountId) out.push({ kind, id, reason: 'foreign' });
    }
  }
  return out;
}

/**
 * Références qui EXISTENT dans un AUTRE compte (les introuvables sont
 * ignorées : un objet supprimé entre-temps relève du traitement appelant —
 * TARGET_GONE d'un job, par exemple).
 */
export async function findForeignRefs(accountId: number, refs: OwnershipRefs, exec?: SqlExecutor): Promise<RejectedRef[]> {
  return (await findRejectedRefs(accountId, refs, exec)).filter((r) => r.reason === 'foreign');
}

/** Lève `CrossAccountReferenceError` si une référence n'appartient pas au compte. */
export async function assertRefsInAccount(accountId: number, refs: OwnershipRefs, exec?: SqlExecutor): Promise<void> {
  const rejected = await findRejectedRefs(accountId, refs, exec);
  if (rejected.length) throw new CrossAccountReferenceError(accountId, rejected);
}

/** Variante booléenne (lectures : 404 sans exception). */
export async function refsInAccount(accountId: number, refs: OwnershipRefs, exec?: SqlExecutor): Promise<boolean> {
  return (await findRejectedRefs(accountId, refs, exec)).length === 0;
}

/**
 * Bien « déjà connu » d'un traitement (KNOWN_TARGET de T1, bien d'un job) :
 * `assetId` s'il appartient au compte, sinon `null` — refus journalisé. Un
 * rattachement persisté vers un autre compte n'est donc jamais exploité.
 */
export async function knownAssetOfAccount(
  accountId: number, assetId: number | null | undefined, context: string, exec?: SqlExecutor,
): Promise<number | null> {
  if (assetId === null || assetId === undefined) return null;
  const rejected = await findRejectedRefs(accountId, { asset: assetId }, exec);
  if (rejected.length === 0) return assetId;
  logCrossAccountRefusal(context, { accountId, rejected });
  return null;
}

// ── Raccourcis par type (routes) ─────────────────────────────────────────────

export const equipmentInAccount = (accountId: number, id: number, exec?: SqlExecutor) => refsInAccount(accountId, { equipment: id }, exec);
export const agendaItemInAccount = (accountId: number, id: number, exec?: SqlExecutor) => refsInAccount(accountId, { agenda_item: id }, exec);

// ── Cohérence d'une cible fine (bien / pièce / équipement) ───────────────────

/**
 * Cible d'un document ou d'un événement : bien, pièce et équipement du
 * compte, ET pièce / équipement portés par le bien indiqué (s'il l'est), ET
 * pièce et équipement du même bien. Lève `CrossAccountReferenceError`
 * (appartenance) ou `TargetCoherenceError` (cohérence) — rien n'est écrit.
 */
export class TargetCoherenceError extends Error {
  readonly code = 'TARGET_INCOHERENT';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'TargetCoherenceError';
  }
}

export async function assertTargetInAccount(
  accountId: number,
  t: { assetId?: number | null; substructureId?: number | null; equipmentId?: number | null },
  exec?: SqlExecutor,
): Promise<void> {
  const e = exec ?? await defaultExecutor();
  await assertRefsInAccount(accountId, { asset: t.assetId, substructure: t.substructureId, equipment: t.equipmentId }, e);
  if (!t.substructureId && !t.equipmentId) return;
  const rows = (await e.execute(sql`
    SELECT 'substructure' AS kind, asset_id FROM substructures WHERE id = ${t.substructureId ?? null}::int
    UNION ALL
    SELECT 'equipment' AS kind, asset_id FROM equipments WHERE id = ${t.equipmentId ?? null}::int`)) as unknown as Array<{ kind: string; asset_id: number }>;
  const parents = new Set(rows.map((r) => Number(r.asset_id)));
  if (parents.size > 1) throw new TargetCoherenceError('La pièce et l’équipement appartiennent à des biens différents.');
  if (t.assetId && parents.size === 1 && !parents.has(Number(t.assetId))) {
    throw new TargetCoherenceError('La pièce ou l’équipement n’appartient pas au bien indiqué.');
  }
}

// Lot 85D : `lockTargetInAccount` (verrou FOR SHARE des cibles dans la
// transaction d'écriture, lot 54 SEC-03) et `isCrossAccountDbRefusal` sont
// retirés avec leur seul appelant, `POST /api/events`. La garde différée en
// base (0373) reste le filet de toute écriture.

// ── Condition de compte DANS le SQL d'une écriture ──────────────────────────

/**
 * Fragment `EXISTS (…)` vrai si l'objet `idExpr` appartient au compte
 * `accountId` — à placer dans le WHERE d'un UPDATE / DELETE ou d'un
 * INSERT … SELECT … WHERE, pour que l'écriture elle-même soit bornée.
 */
export function ownedSql(kind: OwnedKind, idExpr: SQL | number, accountId: SQL | number): SQL {
  const id = typeof idExpr === 'number' ? sql`${idExpr}::int` : idExpr;
  const acc = typeof accountId === 'number' ? sql`${accountId}::int` : accountId;
  switch (kind) {
    case 'asset': return sql`EXISTS (SELECT 1 FROM assets o WHERE o.id = ${id} AND o.account_id = ${acc})`;
    case 'file': return sql`EXISTS (SELECT 1 FROM asset_files o WHERE o.id = ${id} AND o.account_id = ${acc})`;
    case 'substructure': return sql`EXISTS (SELECT 1 FROM substructures o JOIN assets b ON b.id = o.asset_id WHERE o.id = ${id} AND b.account_id = ${acc})`;
    case 'equipment': return sql`EXISTS (SELECT 1 FROM equipments o JOIN assets b ON b.id = o.asset_id WHERE o.id = ${id} AND b.account_id = ${acc})`;
    case 'supplier': return sql`EXISTS (SELECT 1 FROM suppliers o WHERE o.id = ${id} AND o.account_id = ${acc})`;
    case 'event': return sql`EXISTS (SELECT 1 FROM events o WHERE o.id = ${id} AND o.account_id = ${acc})`;
    case 'deadline': return sql`EXISTS (SELECT 1 FROM deadlines o WHERE o.id = ${id} AND o.account_id = ${acc})`;
    case 'agenda_item': return sql`EXISTS (SELECT 1 FROM agenda_items o WHERE o.id = ${id} AND o.account_id = ${acc})`;
    case 'operation': return sql`EXISTS (SELECT 1 FROM business_operations o WHERE o.id = ${id} AND o.account_id = ${acc})`;
  }
}

/** Journal structuré d'un refus (supervision, jamais de donnée métier). */
export function logCrossAccountRefusal(context: string, err: CrossAccountReferenceError | { accountId: number; rejected: RejectedRef[] }): void {
  console.warn(JSON.stringify({
    event: 'security.cross_account_refused', context, accountId: err.accountId,
    refs: err.rejected.map((r) => `${r.kind}:${r.id}:${r.reason}`).slice(0, 20),
  }));
}
