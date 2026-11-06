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
 *
 * Lot 113Q (#714) — LOTS BORNÉS EN OCTETS. Une borne en LIGNES ne suffit pas
 * (textes et résultats IA de plusieurs centaines de Ko par ligne : 500 lignes
 * peuvent peser des centaines de Mo). Le curseur est désormais un curseur SQL
 * (`DECLARE … NO SCROLL CURSOR` dans la transaction de l'instantané, `FETCH n`)
 * dont le nombre de lignes lues à chaque aller-retour s'ADAPTE à la taille
 * mesurée des lignes : au plus `EXPORT_BATCH_BYTES` (8 Mio, variable
 * DIAG_EXPORT_BATCH_BYTES) par lot, jamais plus de `batch` lignes ; une ligne
 * plus grosse que la borne est lue SEULE (jamais tronquée) et comptée
 * (`stats.oversizedRows`, `stats.maxRowBytes`). Mêmes lignes, même ordre,
 * même instantané : seule la taille des allers-retours change. Mesures de la
 * session (`stats`) : requêtes, durée cumulée, allers-retours, lignes, octets.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DIAG_STATEMENT_TIMEOUT_MS, type DiagQuery } from '@/services/business-operations/diagnostics/service';

type Row = Record<string, unknown>;

/** Taille d'un lot de lecture (pagination TECHNIQUE, jamais un plafond). */
export const EXPORT_BATCH_ROWS = 500;
/** Lot 113Q : borne en OCTETS d'un lot (pagination technique : une ligne plus grosse est lue seule, jamais tronquée). */
export const EXPORT_BATCH_BYTES = 8 * 1024 * 1024;
/** Lot 113Q : lignes du premier aller-retour d'un curseur (sonde de la taille des lignes). */
const PROBE_ROWS = 32;

/** Lot 113Q : borne en octets d'un lot (DIAG_EXPORT_BATCH_BYTES, 256 Kio à 256 Mio ; défaut 8 Mio). */
export function exportBatchBytes(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.DIAG_EXPORT_BATCH_BYTES);
  return Number.isFinite(v) && v >= 256 * 1024 && v <= 256 * 1024 * 1024 ? Math.floor(v) : EXPORT_BATCH_BYTES;
}

/** Lot 113Q : taille estimée d'une ligne lue (textes : longueur exacte ; JSON déjà décodé : estimation fixe). */
export function rowBytes(r: Row): number {
  let n = 0;
  for (const v of Object.values(r)) {
    if (typeof v === 'string') n += v.length;
    else if (v instanceof Uint8Array) n += v.byteLength;
    else if (v !== null && typeof v === 'object') n += 256;
    else n += 8;
  }
  return n;
}

/**
 * Lot 113Q : prochain nombre de lignes à lire (pur) — de quoi remplir
 * `maxBytes` à la taille moyenne observée, entre 1 et `batch`.
 */
export function nextFetchRows(batch: number, maxBytes: number, seenRows: number, seenBytes: number): number {
  if (seenRows <= 0) return Math.max(1, Math.min(batch, PROBE_ROWS));
  const avg = Math.max(1, seenBytes / seenRows);
  return Math.max(1, Math.min(batch, Math.floor(maxBytes / avg)));
}

/** Lot 113Q : mesures d'une session (journal et profilage du diagnostic). */
export interface SessionStats {
  queries: number;
  queryMs: number;
  fetches: number;
  rows: number;
  bytes: number;
  oversizedRows: number;
  maxRowBytes: number;
  /** Requêtes les plus longues (début du texte SQL, ms) — au plus 10. */
  slowest: Array<{ sql: string; ms: number }>;
}
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
  /** Lot 113Q : mesures (requêtes, durée, lots, octets, grosses lignes). Facultatif (sessions simulées des tests). */
  stats?: SessionStats;
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
export async function openReadSession(wrap: SessionWrap = {}, opts: { statementTimeoutMs?: number; batchBytes?: number } = {}): Promise<ReadSession & { close(): Promise<void> }> {
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
    // Lot 107G : un diagnostic DURABLE (worker, hors requête HTTP) peut demander un délai par requête plus long.
    const timeout = opts.statementTimeoutMs && opts.statementTimeoutMs > 0 ? Math.floor(opts.statementTimeoutMs) : DIAG_STATEMENT_TIMEOUT_MS;
    await conn.unsafe(`SET LOCAL statement_timeout = ${timeout}`);
    await conn.unsafe(`SET LOCAL idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_MS}`);
    const [i] = await conn.unsafe(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, pg_current_snapshot()::text AS snap`);
    const stats: SessionStats = { queries: 0, queryMs: 0, fetches: 0, rows: 0, bytes: 0, oversizedRows: 0, maxRowBytes: 0, slowest: [] };
    const timed = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      try { return await run(); } finally {
        const ms = performance.now() - t0;
        stats.queries++;
        stats.queryMs += ms;
        if (ms >= 50 && (stats.slowest.length < 10 || ms > stats.slowest[stats.slowest.length - 1].ms)) {
          stats.slowest.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 120), ms: Math.round(ms) });
          stats.slowest.sort((a, b) => b.ms - a.ms);
          if (stats.slowest.length > 10) stats.slowest.length = 10;
        }
      }
    };
    const rawQ = async (sql: string, params: unknown[] = []) => (await conn.unsafe(sql, params as never[])) as Row[];
    const baseQ: DiagQuery = (sql, params = []) => timed(sql, () => rawQ(sql, params));
    const maxBytes = opts.batchBytes && opts.batchBytes > 0 ? Math.floor(opts.batchBytes) : exportBatchBytes();
    let cursors = 0;
    // Lot 113Q : curseur SQL à allers-retours ADAPTÉS à la taille des lignes (borne en octets ET en lignes).
    const baseCursor: RowCursor = (sql, params, batch = EXPORT_BATCH_ROWS) => (async function* () {
      const name = `vb_cur_${++cursors}`;
      await timed(sql, () => rawQ(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, params));
      let open = true;
      let seenRows = 0;
      let seenBytes = 0;
      let lot: Row[] = [];
      let lotBytes = 0;
      try {
        for (;;) {
          const n = nextFetchRows(batch, maxBytes, seenRows, seenBytes);
          const rows = await timed(`FETCH ${name}`, () => rawQ(`FETCH ${n} FROM ${name}`));
          stats.fetches++;
          for (const r of rows) {
            const b = rowBytes(r);
            seenRows++;
            seenBytes += b;
            stats.rows++;
            stats.bytes += b;
            if (b > stats.maxRowBytes) stats.maxRowBytes = b;
            if (b > maxBytes) stats.oversizedRows++;
            // Lot plein (lignes ou octets) : rendu avant d'ajouter la ligne suivante.
            if (lot.length && (lot.length >= batch || lotBytes + b > maxBytes)) { yield lot; lot = []; lotBytes = 0; }
            lot.push(r);
            lotBytes += b;
          }
          if (rows.length < n) break;
        }
        if (lot.length) yield lot;
        lot = [];
        await rawQ(`CLOSE ${name}`);
        open = false;
      } finally {
        // Parcours interrompu (erreur du consommateur, annulation) : curseur fermé si la transaction le permet.
        if (open) await rawQ(`CLOSE ${name}`).catch(() => undefined);
      }
    })();
    const q = wrap.q ? wrap.q(baseQ) : baseQ;
    const cursor = wrap.cursor ? wrap.cursor(baseCursor) : baseCursor;
    let n = 0;
    const savepoint = async <T>(fn: () => Promise<T>): Promise<T> => {
      const name = `vb_sp_${++n}`;
      await rawQ(`SAVEPOINT ${name}`);
      try {
        const out = await fn();
        await rawQ(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (e) {
        await rawQ(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
        throw e;
      }
    };
    return { q, cursor, savepoint, stats, info: { isolation: SNAPSHOT_ISOLATION, at: String(i?.at ?? new Date().toISOString()), snapshot: i?.snap == null ? null : String(i.snap) }, close };
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

/**
 * Lignes JSON d'une requête, lot par lot (`row_to_json` : dates ISO, numeric
 * fidèles). Lot 113Q : lues en TEXTE (`::text`) pour que la taille de chaque
 * ligne soit mesurée exactement (borne en octets des lots), puis décodées.
 */
export async function* jsonBatches(s: Pick<ReadSession, 'cursor'>, sql: string, params: unknown[], batch = EXPORT_BATCH_ROWS): AsyncGenerator<Row[]> {
  for await (const lot of s.cursor(`SELECT row_to_json(t)::text AS r FROM (${sql}) t`, params, batch)) {
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
