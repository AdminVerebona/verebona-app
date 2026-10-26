/**
 * Lot 81C — session de LECTURE COHÉRENTE des extractions du back-office
 * (« Données du compte », diagnostics techniques). Serveur uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN INSTANTANÉ, DES LOTS, AUCUN PLAFOND
 *
 *   · une connexion RÉSERVÉE du pool, une transaction
 *     `REPEATABLE READ, READ ONLY` : toutes les lectures d'une extraction
 *     voient le même instantané PostgreSQL — une écriture concurrente ne
 *     provoque ni doublon, ni omission, ni incohérence entre lots ; une
 *     écriture tentée est refusée par PostgreSQL (25006) ;
 *   · lecture par CURSEUR (portail du protocole étendu, `EXPORT_BATCH_ROWS`
 *     lignes par lot) : la requête s'exécute UNE fois, l'ordre est celui de
 *     son `ORDER BY` (identifiant en départage), le parcours va jusqu'à
 *     l'épuisement réel du résultat, la mémoire reste bornée à un lot ;
 *   · le décompte attendu (`count(*)`) est lu DANS le même instantané : la
 *     comparaison attendu / exporté est donc exacte ;
 *   · points de reprise (`SAVEPOINT`) : une section en erreur est annulée
 *     seule, les sections indépendantes restent lisibles ;
 *   · instant de référence (`now()` = début de la transaction) et instantané
 *     (`pg_current_snapshot()`) rendus pour le manifeste ;
 *   · `statement_timeout` par requête, `idle_in_transaction_session_timeout`
 *     pour libérer la connexion si le client cesse de lire.
 *
 * Règle d'emploi : pendant le parcours d'un curseur, aucune autre requête
 * n'est émise sur la session (une seule connexion) — les lignes sont
 * masquées et sérialisées en mémoire, lot par lot.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DIAG_STATEMENT_TIMEOUT_MS, type DiagQuery } from '@/services/business-operations/diagnostics/service';

type Row = Record<string, unknown>;

/** Taille d'un lot de lecture (pagination TECHNIQUE, jamais un plafond). */
export const EXPORT_BATCH_ROWS = 500;
/** Connexion libérée par PostgreSQL si le client cesse de lire pendant ce délai. */
const IDLE_IN_TRANSACTION_MS = 10 * 60_000;
const SNAPSHOT_ISOLATION = 'REPEATABLE READ, READ ONLY';

/** Parcours par lots d'une requête (curseur). */
type RowCursor = (sql: string, params: unknown[], batch?: number) => AsyncIterable<Row[]>;

interface SnapshotInfo {
  isolation: string;
  /** Instant de référence : début de la transaction (`now()`), ISO. */
  at: string;
  /** `pg_current_snapshot()` : xmin:xmax:xip (vérification de cohérence). */
  snapshot: string | null;
}

export interface ReadSession {
  q: DiagQuery;
  cursor: RowCursor;
  /** Exécute `fn` dans un point de reprise : une erreur l'annule seul (et est relancée). */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
  info: SnapshotInfo;
}

/** Interception (tests de panne) : requêtes et/ou curseurs. */
export interface SessionWrap {
  q?: (q: DiagQuery) => DiagQuery;
  cursor?: (c: RowCursor) => RowCursor;
}

/** Ligne JSON PostgreSQL (`row_to_json`) — objet déjà décodé ou texte. */
export function decodeJsonRow(v: unknown): Row {
  return (typeof v === 'string' ? JSON.parse(v) : v) as Row;
}

interface Reserved {
  unsafe: (sql: string, params?: never[]) => Promise<Row[]> & { cursor: (n: number) => AsyncIterable<Row[]> };
  release: () => void;
}

/** Ouvre une session de lecture cohérente ; `close()` termine la transaction et rend la connexion. */
export async function openReadSession(wrap: SessionWrap = {}): Promise<ReadSession & { close(): Promise<void> }> {
  const { pgClient } = await import('@/db');
  const conn = (await (pgClient as unknown as { reserve: () => Promise<Reserved> }).reserve());
  let open = true;
  const close = async () => {
    if (!open) return;
    open = false;
    try { await conn.unsafe('ROLLBACK'); } catch { /* transaction déjà terminée (connexion coupée) */ }
    conn.release();
  };
  try {
    await conn.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await conn.unsafe(`SET LOCAL statement_timeout = ${DIAG_STATEMENT_TIMEOUT_MS}`);
    await conn.unsafe(`SET LOCAL idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_MS}`);
    const [i] = await conn.unsafe(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, pg_current_snapshot()::text AS snap`);
    const baseQ: DiagQuery = async (sql, params = []) => (await conn.unsafe(sql, params as never[])) as Row[];
    const baseCursor: RowCursor = (sql, params, batch = EXPORT_BATCH_ROWS) => conn.unsafe(sql, params as never[]).cursor(batch);
    const q = wrap.q ? wrap.q(baseQ) : baseQ;
    const cursor = wrap.cursor ? wrap.cursor(baseCursor) : baseCursor;
    let n = 0;
    const savepoint = async <T>(fn: () => Promise<T>): Promise<T> => {
      const name = `vb_sp_${++n}`;
      await baseQ(`SAVEPOINT ${name}`);
      try {
        const out = await fn();
        await baseQ(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (e) {
        await baseQ(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
        throw e;
      }
    };
    return { q, cursor, savepoint, info: { isolation: SNAPSHOT_ISOLATION, at: String(i?.at ?? new Date().toISOString()), snapshot: i?.snap == null ? null : String(i.snap) }, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Exécute `fn` dans une session de lecture cohérente (fermée à la sortie). */
export async function withReadSession<T>(fn: (s: ReadSession) => Promise<T>, wrap: SessionWrap = {}): Promise<T> {
  const s = await openReadSession(wrap);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

/** Lignes JSON d'une requête, lot par lot (`row_to_json` : dates ISO, numeric fidèles). */
export async function* jsonBatches(s: Pick<ReadSession, 'cursor'>, sql: string, params: unknown[], batch = EXPORT_BATCH_ROWS): AsyncGenerator<Row[]> {
  for await (const lot of s.cursor(`SELECT row_to_json(t) AS r FROM (${sql}) t`, params, batch)) {
    yield lot.map((x) => decodeJsonRow(x.r));
  }
}

/** Décompte d'une requête dans l'instantané de la session. */
export async function countRows(q: DiagQuery, sql: string, params: unknown[]): Promise<number> {
  const [c] = await q(`SELECT count(*)::bigint AS n FROM (${sql}) c`, params);
  return Number(c?.n ?? 0);
}

/**
 * Requête à paramètres NOMMÉS `{{nom}}` → `$n` (numérotés dans l'ordre
 * d'apparition, seuls les paramètres utilisés sont transmis) : permet de
 * composer des requêtes (sous-requêtes, unions) sans renuméroter.
 */
export function named(text: string, values: Record<string, unknown>): { sql: string; params: unknown[] } {
  const order: string[] = [];
  const sql = text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in values)) throw new Error(`paramètre nommé inconnu : ${k}`);
    let i = order.indexOf(k);
    if (i < 0) { order.push(k); i = order.length - 1; }
    return `$${i + 1}`;
  });
  return { sql, params: order.map((k) => values[k]) };
}
