/**
 * Reprise des pièces `rooms` dans `substructures` — décision PO D-G (lot 20,
 * chantier B ; migration 0229). Script : `scripts/merge-rooms-into-substructures.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE FAIT UNE EXÉCUTION, PIÈCE PAR PIÈCE (une transaction par pièce)
 *
 *   1. sous-structure de la pièce : celle déjà reprise (`legacy_room_id`,
 *      relance), sinon l'UNIQUE sous-structure libre du même bien de même nom
 *      normalisé (MAPPED : colonnes vides complétées), sinon une sous-structure
 *      CRÉÉE (nom, type, surface, description, portée, fiche canonique) ;
 *   2. références repointées vers la sous-structure (REPOINTED) :
 *        · cibles LEGACY_ROOM (neutralisées par 0229) — et cibles ROOM écrites
 *          par l'ancien code pendant la fenêtre de déploiement (identifiant
 *          `rooms` du compte, pas une sous-structure : `cibleRoomSql`) —
 *          → ROOM + sous-structure :
 *          `field_evidence`, `document_facts`, `canonical_field_writes`,
 *          `to_process_actions` (une carte suspendue par 0229 est ROUVERTE —
 *          REOPENED — sauf si une carte active existe déjà : SUPERSEDED) ;
 *        · liens N-N `document_asset_links.room_id` (origines USER, AI,
 *          MIGRATION) → `substructure_id` ; un lien actif déjà présent vers la
 *          sous-structure l'emporte (le repris passe REMOVED : SUPERSEDED) ;
 *        · `asset_files` / `events` / `deadlines.linked_room_id` →
 *          `substructure_id` (APRÈS les liens : le déclencheur 0221/0229
 *          recalcule alors les liens LEGACY_COLUMN). Une `substructure_id`
 *          déjà renseignée vers une AUTRE pièce n'est jamais écrasée
 *          (CONFLICT, rapport, `linked_room_id` conservé) ;
 *   3. travaux T3 « room » annulés par 0229 : relancés sur la sous-structure
 *      (après validation de la transaction, `--apply` seulement).
 *
 * Chaque modification est JOURNALISÉE (`room_merge_changes`, 0229) dans la
 * MÊME transaction que la donnée : table, ligne, colonnes, valeurs avant /
 * après. Le journal sert de rapport et de restauration.
 *
 * SIMULATION (défaut) : exactement les mêmes instructions, transaction
 * ANNULÉE à la fin de chaque pièce ; seules les tables de rapport sont
 * écrites (`--no-db-report` : rien).
 *
 * Une pièce reprise SANS reste (hors conflits) n'est plus parcourue : `--limit`
 * avance d'une exécution à l'autre.
 *
 * RELANÇABLE sans doublon : la sous-structure d'une pièce est retrouvée par
 * `legacy_room_id` (index unique 0229_idx_1, vérifié avant toute exécution) ;
 * une référence déjà repointée ne porte plus l'identifiant de la pièce.
 *
 * RESTAURATION (`restoreRoomsMerge`) : chaque changement est défait si la
 * ligne n'a pas changé depuis (sinon CONFLICT signalé, rien d'écrasé), dans
 * l'ordre : liens N-N d'abord (le déclencheur ne doit pas recréer un lien
 * LEGACY_COLUMN sur la cible qu'un lien repris va retrouver), puis les autres
 * du plus récent au plus ancien, sous-structures créées en dernier
 * (supprimées seulement si plus rien ne les référence). Les liens
 * LEGACY_COLUMN, dérivés, sont recalculés par le déclencheur.
 *
 * Limites connues : la clé fonctionnelle d'un élément d'agenda automatique
 * ciblé sur une pièce (hash, `agenda-functional-key.ts`) contient l'ancien
 * identifiant — la prochaine réanalyse de sa source le remplace (retrait
 * tracé + création) ; les références d'anciennes conversations de
 * l'assistant ne sont pas réécrites.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { chooseSubstructure, fillFromRoom, pick, restoreOrder, sameJson, type SubstructureCandidate } from './plan';

export type MergeDecision = 'CREATED' | 'MAPPED' | 'REPOINTED' | 'REOPENED' | 'SUPERSEDED' | 'CONFLICT' | 'NO_CHANGE';

export interface MergeChange {
  roomId: number;
  accountId: number | null;
  assetId: number | null;
  decision: MergeDecision;
  table: string;
  rowId: string;
  /** Colonnes concernées, séparées par des virgules ; `*` : ligne créée. */
  column: string;
  oldValue: unknown;
  newValue: unknown;
  reason?: string | null;
}

export interface ReenqueueInput {
  accountId: number;
  userId: number;
  targets: Array<{ type: 'ROOM'; id: number }>;
}

export interface MergeOptions {
  sql: postgres.Sql;
  apply: boolean;
  accountId?: number | null;
  /** Nombre maximal de pièces traitées (exécution partielle, relançable). */
  limit?: number | null;
  batchSize?: number;
  /** Écrire `room_merge_runs` / `room_merge_changes` en simulation (défaut : oui). */
  dbReport?: boolean;
  log?: (m: string) => void;
  /** Relance d'un travail T3 sur la sous-structure (défaut : `enqueueT3ForEntities`). */
  reenqueue?: (input: ReenqueueInput) => Promise<unknown>;
}

export interface MergeResult {
  runId: string;
  mode: 'dry_run' | 'apply';
  counts: Record<string, number>;
  /** Changements (bornés à 2 000 en mémoire ; complets en base). */
  changes: MergeChange[];
  warnings: string[];
}

export class MissingRequirementsError extends Error {
  constructor(message: string) { super(message); this.name = 'MissingRequirementsError'; }
}
export class ConcurrentRunError extends Error {
  constructor(message: string) { super(message); this.name = 'ConcurrentRunError'; }
}

type Tx = postgres.TransactionSql | postgres.Sql;
type Row = Record<string, unknown>;

/* ── Prérequis ───────────────────────────────────────────────────────────── */

const COLONNES_REQUISES: ReadonlyArray<[string, string, string]> = [
  ['substructures', 'legacy_room_id', '0229'], ['substructures', 'room_type', '0229'], ['substructures', 'area', '0229'],
  ['substructures', 'description', '0229'], ['substructures', 'key_characteristics', '0229'],
  ['document_asset_links', 'substructure_id', '0229'], ['rooms', 'key_characteristics', '0227'],
];

/** Tables à cible (type, id) repointées si présentes. */
const CIBLES: ReadonlyArray<{ table: string; type: string; id: string }> = [
  { table: 'field_evidence', type: 'target_type', id: 'target_entity_id' },
  { table: 'document_facts', type: 'target_type', id: 'target_entity_id' },
  { table: 'canonical_field_writes', type: 'target_type', id: 'target_id' },
];
const COLONNE_PIECE = ['asset_files', 'events', 'deadlines'] as const;

interface Schema {
  cibles: typeof CIBLES[number][];
  toProcess: boolean;
  colonnePiece: string[];
  jobs: boolean;
  /** Tables référençant une sous-structure (contrôle avant suppression). */
  refsSub: string[];
}

async function colonnes(sql: Tx): Promise<Set<string>> {
  const rows = (await sql.unsafe(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()`,
  )) as unknown as Array<{ t: string; c: string }>;
  return new Set(rows.map((r) => `${r.t}.${r.c}`));
}

/** Prérequis (lève `MissingRequirementsError`) et tables facultatives présentes. */
export async function checkRequirements(sql: postgres.Sql, needReport: boolean): Promise<Schema> {
  const cols = await colonnes(sql);
  const manque: string[] = [];
  for (const [t, c, m] of COLONNES_REQUISES) if (!cols.has(`${t}.${c}`)) manque.push(`colonne ${t}.${c} (migration ${m})`);
  if (needReport) {
    for (const t of ['room_merge_runs', 'room_merge_changes']) if (!cols.has(`${t}.run_id`)) manque.push(`table ${t} (migration 0229)`);
  }
  const [idx] = (await sql.unsafe(
    `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'substructures_legacy_room_uidx' AND c.relnamespace = current_schema()::regnamespace`,
  )) as unknown as Array<{ valid: boolean }>;
  if (!idx?.valid) manque.push('index unique VALIDE substructures_legacy_room_uidx (migration 0229_rooms_to_substructures_idx_1)');
  const [fn] = (await sql.unsafe(`SELECT to_regproc('document_asset_links_sync_file') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
  if (!fn?.ok) manque.push('fonction document_asset_links_sync_file (migration 0229)');
  if (manque.length) {
    throw new MissingRequirementsError([
      'Prérequis absents — rien n’a été exécuté :', ...manque.map((m) => `  · ${m}`),
      'Appliquez les migrations (démarrage de l’application). Ce script n’appelle jamais ensureMigrations.',
    ].join('\n'));
  }
  const colonnePiece = COLONNE_PIECE.filter((t) => cols.has(`${t}.linked_room_id`) && cols.has(`${t}.substructure_id`));
  return {
    cibles: CIBLES.filter((c) => cols.has(`${c.table}.${c.type}`) && cols.has(`${c.table}.${c.id}`)),
    toProcess: cols.has('to_process_actions.target_type'),
    colonnePiece,
    jobs: cols.has('ai_job_queue.payload'),
    refsSub: ['equipments', 'asset_files', 'agenda_room_links', 'document_asset_links', 'events', 'deadlines']
      .filter((t) => cols.has(`${t}.substructure_id`)),
  };
}

/* ── Lignes à reprendre pour une pièce ─────────────────────────────────── */

/**
 * Condition SQL « la ligne `x` cible encore la pièce `rooms` » :
 *   · LEGACY_ROOM (neutralisée par 0229) ;
 *   · ROOM écrite par l'ANCIEN code pendant la fenêtre de déploiement (après
 *     0229, avant le nouveau code) : identifiant qui n'est PAS une
 *     sous-structure du compte de la ligne mais une pièce `rooms` de ce compte
 *     (revue lot 20). Un identifiant qui est à la fois une sous-structure et
 *     une pièce du compte est lu comme une sous-structure (nouveau code).
 * `$room` / `$compte` : expressions SQL de la pièce et de son compte.
 */
export function cibleRoomSql(c: { type: string; id: string }, x: string, room: string, compte: string): string {
  return `${x}.${ident(c.id)} = ${room} AND (${x}.${ident(c.type)} = 'LEGACY_ROOM'
    OR (${x}.${ident(c.type)} = 'ROOM' AND ${x}.account_id = ${compte}
        AND NOT EXISTS (SELECT 1 FROM substructures s0 JOIN assets a0 ON a0.id = s0.asset_id
                         WHERE s0.id = ${x}.${ident(c.id)} AND a0.account_id = ${x}.account_id)))`;
}

/**
 * Condition SQL « la pièce `r` (compte `compte`, sous-structure reprise `ms`)
 * a encore des références à reprendre » — une pièce reprise SANS reste est
 * exclue des exécutions suivantes (`--limit` progresse d'une exécution à
 * l'autre). Les CONFLITS (colonne déjà rattachée à une autre pièce) ne
 * comptent pas : ils restent au rapport, jamais retraités en boucle.
 */
function resteSql(s: Schema, r: string, compte: string, ms: string): string {
  const parts = s.cibles.map((c) => `EXISTS (SELECT 1 FROM ${ident(c.table)} x WHERE ${cibleRoomSql(c, 'x', r, compte)})`);
  if (s.toProcess) parts.push(`EXISTS (SELECT 1 FROM to_process_actions x WHERE ${cibleRoomSql({ type: 'target_type', id: 'target_id' }, 'x', r, compte)})`);
  parts.push(`EXISTS (SELECT 1 FROM document_asset_links l WHERE l.room_id = ${r} AND l.origin <> 'LEGACY_COLUMN')`);
  for (const t of s.colonnePiece) {
    parts.push(`EXISTS (SELECT 1 FROM ${ident(t)} f WHERE f.linked_room_id = ${r} AND (f.substructure_id IS NULL OR f.substructure_id = ${ms}))`);
  }
  if (s.jobs) {
    parts.push(`EXISTS (SELECT 1 FROM ai_job_queue j WHERE j.target_type = 'room' AND j.target_id = ${r}::text AND j.status = 'CANCELLED'
      AND j.last_error LIKE 'D-G :%' AND j.last_error NOT LIKE '%[relancée%')`);
  }
  return parts.join(' OR ');
}

/* ── Verrou ──────────────────────────────────────────────────────────────── */

export const ROOMS_MERGE_LOCK_KEY = 'rooms_merge_d_g';

async function verrou(sql: postgres.Sql): Promise<() => Promise<void>> {
  const cnx = await sql.reserve();
  const [{ ok }] = await cnx<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${ROOMS_MERGE_LOCK_KEY})) AS ok`;
  if (!ok) {
    cnx.release();
    throw new ConcurrentRunError('Une autre exécution --apply (ou --restore) de la reprise des pièces est en cours : rien n’a été fait.');
  }
  return async () => {
    try { await cnx`SELECT pg_advisory_unlock(hashtext(${ROOMS_MERGE_LOCK_KEY}))`; } finally { cnx.release(); }
  };
}

/* ── Écriture journalisée d'une ligne ────────────────────────────────────── */

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(n: string): string {
  if (!IDENT.test(n)) throw new Error(`identifiant SQL refusé : ${n}`);
  return n;
}
const objet = (cols: readonly string[], alias: string) =>
  `jsonb_build_object(${cols.map((c) => `'${ident(c)}', ${alias}.${c}`).join(', ')})`;

/** Valeurs actuelles de colonnes d'une ligne (null : ligne absente). */
async function lire(tx: Tx, table: string, id: string, cols: readonly string[], lock = false): Promise<Row | null> {
  const [r] = (await tx.unsafe(
    `SELECT ${objet(cols, 'x')} AS v FROM ${ident(table)} x WHERE x.id = $1${lock ? ' FOR UPDATE' : ''}`, [id] as never[],
  )) as unknown as Array<{ v: Row }>;
  return r ? r.v : null;
}

/** Écrit des colonnes (types convertis par `jsonb_populate_record`) ; rend avant / après. */
async function ecrire(tx: Tx, table: string, id: string, set: Row): Promise<{ before: Row; after: Row } | null> {
  const cols = Object.keys(set);
  const before = await lire(tx, table, id, cols, true);
  if (!before) return null;
  const t = ident(table);
  const [a] = (await tx.unsafe(
    `UPDATE ${t} x SET ${cols.map((c) => `${ident(c)} = p.${c}`).join(', ')}
       FROM jsonb_populate_record(NULL::${t}, $2::jsonb) p
      WHERE x.id = $1 RETURNING ${objet(cols, 'x')} AS v`,
    [id, JSON.stringify(set)] as never[],
  )) as unknown as Array<{ v: Row }>;
  return { before: pick(before, cols), after: pick(a.v, cols) };
}

/* ── Une pièce ───────────────────────────────────────────────────────────── */

interface RoomRow {
  id: number; asset_id: number; account_id: number; name: string; room_type: string | null; area: string | null;
  description: string | null; scope: string | null; key_characteristics: unknown; created_at: string | null;
}

interface RoomOutcome {
  substructureId: number;
  changes: MergeChange[];
  jobs: Array<{ jobId: number; accountId: number; userId: number }>;
}

class SimulationRollback extends Error {
  constructor(readonly outcome: RoomOutcome) { super('simulation'); }
}

async function mergeRoom(tx: Tx, roomId: number, s: Schema): Promise<RoomOutcome | null> {
  const [room] = (await tx.unsafe(
    `SELECT r.id, r.asset_id, a.account_id, r.name, r.room_type, r.area, r.description, r.scope,
            r.key_characteristics, r.created_at
       FROM rooms r JOIN assets a ON a.id = r.asset_id WHERE r.id = $1 FOR UPDATE OF r`,
    [roomId] as never[],
  )) as unknown as RoomRow[];
  if (!room) return null;
  const changes: MergeChange[] = [];
  const add = (c: Omit<MergeChange, 'roomId' | 'accountId' | 'assetId'>) =>
    changes.push({ roomId: room.id, accountId: room.account_id, assetId: room.asset_id, ...c });

  // 1. Sous-structure.
  const cands = (await tx.unsafe(
    `SELECT id, name, legacy_room_id AS "legacyRoomId" FROM substructures
      WHERE asset_id = $1 OR legacy_room_id = $2 ORDER BY id FOR UPDATE`,
    [room.asset_id, room.id] as never[],
  )) as unknown as SubstructureCandidate[];
  const choix = chooseSubstructure(room, cands);
  let sub: number;
  if (choix.kind === 'existing') {
    sub = choix.substructureId;
  } else if (choix.kind === 'map') {
    sub = choix.substructureId;
    const [actuel] = (await tx.unsafe(
      `SELECT room_type, area, description, key_characteristics FROM substructures WHERE id = $1`, [sub] as never[],
    )) as unknown as Row[];
    const set = { legacy_room_id: room.id, ...fillFromRoom(actuel as never, room as never) };
    const w = await ecrire(tx, 'substructures', String(sub), set);
    add({ decision: 'MAPPED', table: 'substructures', rowId: String(sub), column: Object.keys(set).join(','),
      oldValue: w!.before, newValue: w!.after, reason: 'SAME_NAME' });
  } else {
    const [c] = (await tx.unsafe(
      `INSERT INTO substructures (asset_id, name, order_index, scope, public_id, legacy_room_id, room_type, area, description,
                                  key_characteristics, created_at, updated_at)
       SELECT $1, $2, COALESCE((SELECT MAX(order_index) + 1 FROM substructures WHERE asset_id = $1), 0), $3, gen_random_uuid(),
              $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb), COALESCE($9::timestamptz, now()), now()
       RETURNING id, ${objet(['asset_id', 'name', 'order_index', 'scope', 'legacy_room_id', 'room_type', 'area', 'description', 'key_characteristics'], 'substructures')} AS v`,
      [room.asset_id, room.name, room.scope ?? 'personal', room.id, room.room_type, room.area, room.description,
        room.key_characteristics == null ? null : JSON.stringify(room.key_characteristics), room.created_at] as never[],
    )) as unknown as Array<{ id: number; v: Row }>;
    sub = Number(c.id);
    add({ decision: 'CREATED', table: 'substructures', rowId: String(sub), column: '*', oldValue: null, newValue: c.v,
      reason: choix.ambiguous ? `AMBIGUOUS_NAME:${choix.candidates.join('|')}` : null });
  }

  // 2a. Cibles LEGACY_ROOM (et ROOM de la fenêtre de déploiement) → ROOM (sous-structure).
  for (const c of s.cibles) {
    const ids = (await tx.unsafe(
      `SELECT x.id::text AS id FROM ${ident(c.table)} x WHERE ${cibleRoomSql(c, 'x', '$1', '$2')} ORDER BY x.id FOR UPDATE OF x`,
      [room.id, room.account_id] as never[],
    )) as unknown as Array<{ id: string }>;
    for (const { id } of ids) {
      const w = await ecrire(tx, c.table, id, { [c.type]: 'ROOM', [c.id]: sub });
      if (w) add({ decision: 'REPOINTED', table: c.table, rowId: id, column: `${c.type},${c.id}`, oldValue: w.before, newValue: w.after });
    }
  }
  if (s.toProcess) {
    const cartes = (await tx.unsafe(
      `SELECT x.id::text AS id, x.account_id, x.field_key, x.relation_key, x.resolved_at, x.trigger_context
         FROM to_process_actions x WHERE ${cibleRoomSql({ type: 'target_type', id: 'target_id' }, 'x', '$1', '$2')}
        ORDER BY x.id FOR UPDATE OF x`,
      [room.id, room.account_id] as never[],
    )) as unknown as Array<{ id: string; account_id: number; field_key: string | null; relation_key: string | null;
      resolved_at: string | null; trigger_context: Row | null }>;
    for (const a of cartes) {
      const set: Row = { target_type: 'ROOM', target_id: sub };
      let decision: MergeDecision = 'REPOINTED';
      let reason: string | null = null;
      const ctx = a.trigger_context ?? null;
      if (ctx && ctx.dgSuspended === true) {
        const { dgSuspended: _x, ...reste } = ctx;
        set.trigger_context = reste;
        const [actif] = (await tx.unsafe(
          `SELECT 1 FROM to_process_actions WHERE account_id = $1 AND target_type = 'ROOM' AND target_id = $2
              AND COALESCE(field_key, relation_key) = COALESCE($3, $4) AND resolved_at IS NULL AND id <> $5::int LIMIT 1`,
          [a.account_id, sub, a.field_key, a.relation_key, a.id] as never[],
        )) as unknown as Row[];
        if (actif) { decision = 'SUPERSEDED'; reason = 'ACTIVE_CARD_EXISTS'; } else {
          decision = 'REOPENED';
          set.resolved_at = null;
          set.resolution_reason = null;
        }
      }
      const w = await ecrire(tx, 'to_process_actions', a.id, set);
      if (w) add({ decision, table: 'to_process_actions', rowId: a.id, column: Object.keys(set).join(','), oldValue: w.before, newValue: w.after, reason });
    }
  }

  // 2b. Liens N-N (avant les colonnes : voir l'en-tête).
  const liens = (await tx.unsafe(
    `SELECT id::text AS id, file_id, asset_id, equipment_id, status FROM document_asset_links
      WHERE room_id = $1 AND origin <> 'LEGACY_COLUMN' ORDER BY id FOR UPDATE`,
    [room.id] as never[],
  )) as unknown as Array<{ id: string; file_id: number; asset_id: number | null; equipment_id: number | null; status: string }>;
  for (const l of liens) {
    const set: Row = { room_id: null, substructure_id: sub };
    let decision: MergeDecision = 'REPOINTED';
    let reason: string | null = null;
    if (l.status === 'ACTIVE') {
      const [doublon] = (await tx.unsafe(
        `SELECT 1 FROM document_asset_links WHERE file_id = $1 AND status = 'ACTIVE' AND id <> $2::bigint
            AND COALESCE(asset_id, 0) = COALESCE($3::int, 0) AND room_id IS NULL
            AND COALESCE(equipment_id, 0) = COALESCE($4::int, 0) AND substructure_id = $5 LIMIT 1`,
        [l.file_id, l.id, l.asset_id, l.equipment_id, sub] as never[],
      )) as unknown as Row[];
      if (doublon) {
        decision = 'SUPERSEDED';
        reason = 'ACTIVE_LINK_EXISTS';
        set.status = 'REMOVED';
        set.removed_at = new Date().toISOString();
      }
    }
    const w = await ecrire(tx, 'document_asset_links', l.id, set);
    if (w) add({ decision, table: 'document_asset_links', rowId: l.id, column: Object.keys(set).join(','), oldValue: w.before, newValue: w.after, reason });
  }

  // 2c. Colonnes `linked_room_id` → `substructure_id`.
  for (const t of s.colonnePiece) {
    const lignes = (await tx.unsafe(
      `SELECT id::text AS id, substructure_id FROM ${ident(t)} WHERE linked_room_id = $1 ORDER BY id FOR UPDATE`,
      [room.id] as never[],
    )) as unknown as Array<{ id: string; substructure_id: number | null }>;
    for (const l of lignes) {
      if (l.substructure_id != null && Number(l.substructure_id) !== sub) {
        add({ decision: 'CONFLICT', table: t, rowId: l.id, column: 'substructure_id',
          oldValue: { substructure_id: l.substructure_id, linked_room_id: room.id }, newValue: null, reason: 'SUBSTRUCTURE_ALREADY_SET' });
        continue;
      }
      const set: Row = l.substructure_id == null ? { substructure_id: sub, linked_room_id: null } : { linked_room_id: null };
      const w = await ecrire(tx, t, l.id, set);
      if (w) add({ decision: 'REPOINTED', table: t, rowId: l.id, column: Object.keys(set).join(','), oldValue: w.before, newValue: w.after });
    }
  }

  // 3. Travaux T3 annulés par 0229 (relancés après validation).
  const jobs = s.jobs ? (await tx.unsafe(
    `SELECT id, account_id, (payload->>'userId')::int AS user_id FROM ai_job_queue
      WHERE target_type = 'room' AND target_id = $1 AND status = 'CANCELLED'
        AND last_error LIKE 'D-G :%' AND last_error NOT LIKE '%[relancée%'`,
    [String(room.id)] as never[],
  )) as unknown as Array<{ id: number; account_id: number | null; user_id: number | null }> : [];

  return {
    substructureId: sub,
    changes,
    jobs: jobs.filter((j) => j.account_id != null && j.user_id != null)
      .map((j) => ({ jobId: Number(j.id), accountId: Number(j.account_id), userId: Number(j.user_id) })),
  };
}

/* ── Journal ─────────────────────────────────────────────────────────────── */

async function journaliser(tx: Tx, runId: string, mode: 'dry_run' | 'apply', changes: MergeChange[]): Promise<void> {
  for (let i = 0; i < changes.length; i += 200) {
    const lot = changes.slice(i, i + 200);
    const params: unknown[] = [];
    const tuples = lot.map((c) => {
      const v = [runId, mode, c.roomId, c.accountId, c.assetId, c.decision, c.table, c.rowId, c.column,
        c.oldValue === null || c.oldValue === undefined ? null : JSON.stringify(c.oldValue),
        c.newValue === null || c.newValue === undefined ? null : JSON.stringify(c.newValue), c.reason ?? null];
      const casts = ['::uuid', '', '', '', '', '', '', '', '', '::jsonb', '::jsonb', ''];
      return `(${v.map((x, k) => { params.push(x); return `$${params.length}${casts[k]}`; }).join(', ')})`;
    });
    await tx.unsafe(
      `INSERT INTO room_merge_changes (run_id, run_mode, room_id, account_id, asset_id, decision, table_name, row_id,
                                       column_name, old_value, new_value, reason)
       VALUES ${tuples.join(', ')}`,
      params as never[],
    );
  }
}

function compter(counts: Record<string, number>, changes: MergeChange[]): void {
  for (const c of changes) {
    const k = c.decision === 'REPOINTED' ? `repointed.${c.table}` : c.decision.toLowerCase();
    counts[k] = (counts[k] ?? 0) + 1;
  }
}

async function reenqueueDefaut(input: ReenqueueInput): Promise<unknown> {
  const { enqueueT3ForEntities } = await import('@/services/ai/reconciliation/t3-queue');
  return enqueueT3ForEntities({ ...input, reason: 'D-G : reprise des pièces' });
}

/* ── Exécution ───────────────────────────────────────────────────────────── */

export async function runRoomsMerge(o: MergeOptions): Promise<MergeResult> {
  const log = o.log ?? (() => {});
  const mode: 'dry_run' | 'apply' = o.apply ? 'apply' : 'dry_run';
  const dbReport = o.apply || o.dbReport !== false;
  const schema = await checkRequirements(o.sql, dbReport);
  const liberer = o.apply ? await verrou(o.sql) : null;
  const runId = randomUUID();
  const counts: Record<string, number> = { rooms: 0, failed: 0, existing: 0 };
  const memoire: MergeChange[] = [];
  const warnings: string[] = [];
  try {
    if (dbReport) {
      await o.sql.unsafe(
        `INSERT INTO room_merge_runs (run_id, run_mode, account_id, options) VALUES ($1::uuid, $2, $3, $4::jsonb)`,
        [runId, mode, o.accountId ?? null, JSON.stringify({ limit: o.limit ?? null, batchSize: o.batchSize ?? 100 })] as never[],
      );
    }
    const lotTaille = Math.max(1, o.batchSize ?? 100);
    let curseur = 0;
    for (;;) {
      const reste = o.limit == null ? lotTaille : Math.min(lotTaille, o.limit - counts.rooms);
      if (reste <= 0) break;
      const ids = (await o.sql.unsafe(
        `SELECT r.id FROM rooms r JOIN assets a ON a.id = r.asset_id
          WHERE r.id > $1 AND ($2::int IS NULL OR a.account_id = $2)
            -- Pièce reprise sans reste : exclue (--limit progresse d'une exécution à l'autre).
            AND NOT EXISTS (SELECT 1 FROM substructures ms WHERE ms.legacy_room_id = r.id
                             AND NOT (${resteSql(schema, 'r.id', 'a.account_id', 'ms.id')}))
          ORDER BY r.id LIMIT $3`,
        [curseur, o.accountId ?? null, reste] as never[],
      )) as unknown as Array<{ id: number }>;
      if (ids.length === 0) break;
      for (const { id } of ids) {
        curseur = Number(id);
        counts.rooms += 1;
        let outcome: RoomOutcome | null = null;
        try {
          if (o.apply) {
            outcome = await o.sql.begin(async (tx) => {
              const r = await mergeRoom(tx, Number(id), schema);
              if (r && r.changes.length) await journaliser(tx, runId, 'apply', r.changes);
              return r;
            }) as RoomOutcome | null;
          } else {
            try {
              await o.sql.begin(async (tx) => {
                const r = await mergeRoom(tx, Number(id), schema);
                throw new SimulationRollback(r ?? { substructureId: 0, changes: [], jobs: [] });
              });
            } catch (e) {
              if (!(e instanceof SimulationRollback)) throw e;
              outcome = e.outcome;
            }
            if (dbReport && outcome?.changes.length) await journaliser(o.sql, runId, 'dry_run', outcome.changes);
          }
        } catch (e) {
          counts.failed += 1;
          warnings.push(`pièce ${id} : ${(e as Error).message}`);
          log(`ÉCHEC pièce ${id} : ${(e as Error).message}`);
          continue;
        }
        if (!outcome) continue;
        if (!outcome.changes.some((c) => c.decision === 'CREATED' || c.decision === 'MAPPED')) counts.existing += 1;
        compter(counts, outcome.changes);
        for (const c of outcome.changes) if (memoire.length < 2000) memoire.push(c);
        if (o.apply && outcome.jobs.length) {
          for (const j of outcome.jobs) {
            try {
              await (o.reenqueue ?? reenqueueDefaut)({ accountId: j.accountId, userId: j.userId, targets: [{ type: 'ROOM', id: outcome.substructureId }] });
              await o.sql.unsafe(
                `UPDATE ai_job_queue SET last_error = last_error || $2 WHERE id = $1`,
                [j.jobId, ` [relancée : sous-structure ${outcome.substructureId}]`] as never[],
              );
              counts.reenqueued = (counts.reenqueued ?? 0) + 1;
            } catch (e) {
              warnings.push(`relance T3 (travail ${j.jobId}) : ${(e as Error).message}`);
            }
          }
        }
      }
    }
    if (dbReport) {
      await o.sql.unsafe(
        `UPDATE room_merge_runs SET counts = $2::jsonb, status = $3, finished_at = now() WHERE run_id = $1::uuid`,
        [runId, JSON.stringify(counts), counts.failed ? 'FAILED' : 'DONE'] as never[],
      );
    }
    log(`${mode === 'apply' ? 'appliqué' : 'simulation'} — ${counts.rooms} pièce(s) : ${JSON.stringify(counts)}`);
    return { runId, mode, counts, changes: memoire, warnings };
  } catch (e) {
    if (dbReport) {
      await o.sql.unsafe(
        `UPDATE room_merge_runs SET counts = $2::jsonb, status = 'FAILED', finished_at = now() WHERE run_id = $1::uuid`,
        [runId, JSON.stringify(counts)] as never[],
      ).catch(() => undefined);
    }
    throw e;
  } finally {
    if (liberer) await liberer();
  }
}

/* ── Restauration ────────────────────────────────────────────────────────── */

export interface RestoreResult {
  restored: number;
  deletedSubstructures: number;
  conflicts: Array<{ table: string; rowId: string; reason: string }>;
}

interface ChangeRow {
  id: string; decision: MergeDecision; table_name: string; row_id: string; column_name: string;
  old_value: Row | null; new_value: Row | null;
}

/** Une sous-structure créée est-elle encore référencée (hors journal restauré) ? */
async function referencee(tx: Tx, s: Schema, sub: string): Promise<boolean> {
  // Liens N-N : seuls les liens ACTIFS comptent (un lien retiré n'est qu'un historique, emporté par la cascade).
  const parts = s.refsSub.map((t) => `SELECT 1 FROM ${ident(t)} WHERE substructure_id = $1${t === 'document_asset_links' ? ` AND status = 'ACTIVE'` : ''}`);
  for (const c of s.cibles) parts.push(`SELECT 1 FROM ${ident(c.table)} WHERE ${c.type} = 'ROOM' AND ${c.id} = $1`);
  if (s.toProcess) parts.push(`SELECT 1 FROM to_process_actions WHERE target_type = 'ROOM' AND target_id = $1`);
  const [r] = (await tx.unsafe(`SELECT EXISTS (${parts.join(' UNION ALL ')}) AS ok`, [Number(sub)] as never[])) as unknown as Array<{ ok: boolean }>;
  return r?.ok === true;
}

export async function restoreRoomsMerge(sql: postgres.Sql, runId: string, log: (m: string) => void = () => {}): Promise<RestoreResult> {
  const schema = await checkRequirements(sql, true);
  const [run] = (await sql.unsafe(`SELECT run_mode, status FROM room_merge_runs WHERE run_id = $1::uuid`, [runId] as never[])) as unknown as Row[];
  if (!run) throw new Error(`Exécution ${runId} introuvable.`);
  if (run.run_mode !== 'apply') throw new Error(`Exécution ${runId} : simulation, rien à restaurer.`);
  const liberer = await verrou(sql);
  try {
    return await sql.begin(async (tx) => {
      const changes = (await tx.unsafe(
        `SELECT id::text AS id, decision, table_name, row_id, column_name, old_value, new_value FROM room_merge_changes
          WHERE run_id = $1::uuid AND run_mode = 'apply' AND restored_at IS NULL
            AND decision IN ('CREATED', 'MAPPED', 'REPOINTED', 'REOPENED', 'SUPERSEDED')`,
        [runId] as never[],
      )) as unknown as ChangeRow[];
      const out: RestoreResult = { restored: 0, deletedSubstructures: 0, conflicts: [] };
      const fait: string[] = [];
      for (const c of restoreOrder(changes)) {
        if (c.decision === 'CREATED') {
          if (await referencee(tx, schema, c.row_id)) {
            out.conflicts.push({ table: c.table_name, rowId: c.row_id, reason: 'SUBSTRUCTURE_REFERENCED' });
            continue;
          }
          await tx.unsafe(`DELETE FROM substructures WHERE id = $1`, [Number(c.row_id)] as never[]);
          out.deletedSubstructures += 1;
          fait.push(c.id);
          continue;
        }
        const cols = c.column_name.split(',');
        const actuel = await lire(tx, c.table_name, c.row_id, cols, true);
        if (!actuel) { out.conflicts.push({ table: c.table_name, rowId: c.row_id, reason: 'ROW_GONE' }); continue; }
        if (!sameJson(pick(actuel, cols), c.new_value)) {
          out.conflicts.push({ table: c.table_name, rowId: c.row_id, reason: 'CHANGED_SINCE' });
          continue;
        }
        await ecrire(tx, c.table_name, c.row_id, pick(c.old_value ?? {}, cols));
        out.restored += 1;
        fait.push(c.id);
      }
      if (fait.length) {
        await tx.unsafe(`UPDATE room_merge_changes SET restored_at = now() WHERE id = ANY($1::bigint[])`, [fait] as never[]);
      }
      await tx.unsafe(`UPDATE room_merge_runs SET status = 'RESTORED', restored_at = now() WHERE run_id = $1::uuid`, [runId] as never[]);
      log(`restauration ${runId} : ${out.restored} valeur(s), ${out.deletedSubstructures} sous-structure(s) supprimée(s), ${out.conflicts.length} conflit(s)`);
      return out;
    }) as RestoreResult;
  } finally {
    await liberer();
  }
}

/* ── Rapport ─────────────────────────────────────────────────────────────── */

export interface MergeSummary {
  run: Row;
  byDecision: Array<{ decision: string; table: string; n: number }>;
  samples: Row[];
}

export async function summarizeRoomsMerge(sql: postgres.Sql, runId: string, samples = 20): Promise<MergeSummary | null> {
  const [run] = (await sql.unsafe(`SELECT * FROM room_merge_runs WHERE run_id = $1::uuid`, [runId] as never[])) as unknown as Row[];
  if (!run) return null;
  const byDecision = (await sql.unsafe(
    `SELECT decision, table_name AS table, COUNT(*)::int AS n FROM room_merge_changes WHERE run_id = $1::uuid
      GROUP BY 1, 2 ORDER BY 1, 2`, [runId] as never[],
  )) as unknown as Array<{ decision: string; table: string; n: number }>;
  const ex = (await sql.unsafe(
    `SELECT room_id, decision, table_name, row_id, reason, old_value, new_value FROM room_merge_changes
      WHERE run_id = $1::uuid AND (decision IN ('CONFLICT', 'SUPERSEDED') OR reason IS NOT NULL) ORDER BY id LIMIT $2`,
    [runId, samples] as never[],
  )) as unknown as Row[];
  return { run, byDecision, samples: ex };
}

export function formatRoomsMergeSummary(s: MergeSummary): string {
  const r = s.run;
  return [
    `Exécution ${String(r.run_id)} — ${String(r.run_mode)} — ${String(r.status)}${r.restored_at ? ' (restaurée)' : ''}`,
    `Compteurs : ${JSON.stringify(r.counts)}`,
    'Décisions :',
    ...s.byDecision.map((d) => `  ${d.decision.padEnd(11)} ${d.table.padEnd(24)} ${d.n}`),
    ...(s.samples.length ? ['À vérifier :', ...s.samples.map((x) =>
      `  pièce ${String(x.room_id)} ${String(x.decision)} ${String(x.table_name)}#${String(x.row_id)} ${String(x.reason ?? '')}`)] : []),
  ].join('\n');
}
