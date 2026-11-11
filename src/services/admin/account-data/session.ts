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
 * Lot 113AG (#734) — ACCÈS SÉRIALISÉS ET ERREURS TRACÉES. Cause démontrée
 * (PostgreSQL 16 réel) du `25P02` en cascade du diagnostic BO : quatre
 * `savepoint()` lancés en `Promise.all` (T3) entrelaçaient SAVEPOINT 1..4,
 * puis RELEASE 1 — qui détruit 2..4 — et RELEASE 2 échouait (`3B001`) ;
 * l'échec de `ROLLBACK TO` était ignoré : transaction invalidée, erreurs
 * masquées en listes vides, toutes les lectures suivantes en `25P02`.
 * Désormais : (1) UNE instruction à la fois sur la connexion (garde « fil ») ;
 * (2) une file par portée : des points de reprise lancés en parallèle
 * s'exécutent l'un APRÈS l'autre (tout futur `Promise.all` reste sûr),
 * l'imbrication passe par la portée enfant ; (3) `savepoint()` ordonné
 * SAVEPOINT → lectures → RELEASE, ou ROLLBACK TO → RELEASE ; un échec de
 * restauration, ou une erreur hors point de reprise, est un incident FATAL :
 * transaction terminée, connexion libérée, plus aucune lecture
 * (`ReadSessionBrokenError`, code `VB_SESSION_BROKEN`, erreur d'origine et
 * échec de restauration conservés) ; (4) chaque erreur SQL est consignée
 * (`trace`) : ordre, horodatage, SQLSTATE, instruction, étape / fichier /
 * génération déclarés, fonction appelante, pile courte ; un `25P02` est
 * rattaché à son erreur d'origine, jamais présenté à sa place.
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
import { AsyncLocalStorage } from 'node:async_hooks';
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
  /** Lot 113AG : accès mis en attente par la file interne (lectures lancées en parallèle par un appelant). */
  serializedWaits?: number;
  /** Lot 113AG : instructions simultanément en cours sur la connexion (toujours ≤ 1). */
  maxInFlight?: number;
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
  /** Lot 113AG : journal des erreurs SQL (première erreur, conséquences, incident fatal). Facultatif (sessions simulées des tests). */
  trace?: SessionTrace;
}

// ── Lot 113AG : erreurs SQL tracées, incident fatal ─────────────────────────

/** Code de l'erreur levée par une session INTERROMPUE (incident fatal) : aucune requête n'est plus envoyée. */
export const SESSION_BROKEN_CODE = 'VB_SESSION_BROKEN';
/** Erreurs conservées en détail par session (au-delà : comptées). */
export const SESSION_INCIDENTS_MAX = 200;
const ABORTED = '25P02';

/**
 * ORIGIN : erreur SQL d'origine ; CONSEQUENCE : `25P02` (transaction déjà
 * invalidée par une erreur antérieure, rattachée à sa cause) ;
 * RELEASE_FAILED / ROLLBACK_FAILED : échec de libération / de restauration
 * d'un point de reprise.
 */
export type SqlIncidentKind = 'ORIGIN' | 'CONSEQUENCE' | 'RELEASE_FAILED' | 'ROLLBACK_FAILED';

export interface SqlIncident {
  /** Ordre chronologique dans la session (1, 2, …). */
  seq: number;
  /** Horodatage ISO (UTC) de la réponse en erreur — corrélable avec les journaux Scalingo. */
  at: string;
  /** SQLSTATE PostgreSQL (ou code de connexion du pilote). */
  sqlstate: string | null;
  message: string;
  kind: SqlIncidentKind;
  /** Début du texte SQL (aucun paramètre). */
  statement: string;
  /** Contexte déclaré par l'appelant : étape du diagnostic, fichier en production, génération. */
  phase: string | null;
  file: string | null;
  generationId: string | null;
  /** Première fonction applicative de la pile d'appel (meilleur effort ; code compilé : noms possiblement raccourcis). */
  caller: string | null;
  /** Pile courte (au plus 6 cadres applicatifs). */
  stack: string[];
  /** Point de reprise actif au moment de l'erreur (null : hors point de reprise). */
  savepoint: string | null;
  /** true : point de reprise restauré, session saine ; false : session interrompue ; null : en cours. */
  recovered: boolean | null;
  /** CONSEQUENCE : `seq` de l'erreur d'origine (null : cause non observée). */
  consequenceOf: number | null;
}

export interface SessionFatal {
  at: string;
  reason: string;
  /** Erreur d'origine (celle qui a invalidé la transaction). */
  origin: SqlIncident | null;
  /** Échec de la restauration (ROLLBACK TO SAVEPOINT), s'il y a lieu. */
  rollback: SqlIncident | null;
}

export interface SessionHealth {
  state: 'HEALTHY' | 'BROKEN';
  /** Première erreur d'ORIGINE (jamais un 25P02 secondaire). */
  firstError: SqlIncident | null;
  fatal: SessionFatal | null;
  incidents: SqlIncident[];
  total: number;
  origins: number;
  consequences: number;
  /** Erreurs comptées mais non détaillées (au-delà de SESSION_INCIDENTS_MAX). */
  omitted: number;
}

export interface SessionTrace {
  /** Contexte rattaché aux erreurs suivantes (étape, fichier, génération). */
  setContext(c: { phase?: string | null; file?: string | null; generationId?: string | null }): void;
  /** Numéro de la dernière erreur enregistrée (repère pour `since`). */
  mark(): number;
  /** Erreurs enregistrées depuis `mark` : nombre, première erreur d'origine. */
  since(mark: number): { count: number; firstOrigin: SqlIncident | null; consequences: number };
  health(): SessionHealth;
}

/** Session interrompue : erreur d'origine et échec de restauration conservés. */
export class ReadSessionBrokenError extends Error {
  readonly code = SESSION_BROKEN_CODE;
  constructor(readonly fatal: SessionFatal) {
    super(`session de lecture interrompue (incident fatal) : ${fatal.reason}${fatal.origin ? ` — erreur d’origine n°${fatal.origin.seq} ${fatal.origin.sqlstate ?? 'code inconnu'} « ${fatal.origin.message.slice(0, 160)} »` : ''}${fatal.rollback ? ` — restauration n°${fatal.rollback.seq} ${fatal.rollback.sqlstate ?? 'code inconnu'} « ${fatal.rollback.message.slice(0, 120)} »` : ''}`);
    this.name = 'ReadSessionBrokenError';
  }
}

/** L'erreur vient-elle d'une session interrompue (incident fatal) ? */
export const isReadSessionBroken = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === SESSION_BROKEN_CODE;

/** Résumé d'une erreur pour un message (pur). */
export function incidentLabel(i: Pick<SqlIncident, 'seq' | 'sqlstate' | 'message' | 'file' | 'caller' | 'at'>): string {
  return `n°${i.seq} ${i.sqlstate ?? 'code inconnu'} « ${i.message.slice(0, 200)} »${i.file ? ` (fichier ${i.file})` : ''}${i.caller ? ` [${i.caller}]` : ''} à ${i.at}`;
}

/** L'erreur invalide-t-elle la transaction côté serveur ? (SQLSTATE ou coupure de connexion ; une erreur JS locale non.) */
function abortsTransaction(e: unknown): boolean {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && (/^[0-9A-Z]{5}$/.test(c) || /^CONNECT(ION)?_/.test(c));
}

/** Pile courte, cadres applicatifs seulement (hors session, pilote, Node). */
function shortStack(site: { stack?: string }): string[] {
  const lines = String(site.stack ?? '').split('\n').slice(1).map((l) => l.trim().replace(/^at /, ''));
  const cwd = typeof process !== 'undefined' ? process.cwd() : '';
  return lines
    .filter((l) => l && !/account-data[/\\]session\.|node_modules|node:internal|<anonymous>|^new Promise|^Promise\.|AsyncLocalStorage/.test(l))
    .map((l) => (cwd ? l.split(cwd).join('') : l))
    .slice(0, 6);
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

/** Options d'ouverture d'une session. */
export interface ReadSessionOptions {
  statementTimeoutMs?: number;
  batchBytes?: number;
  /** Lot 113AG : appelé à chaque erreur SQL (journal corrélé du worker). */
  onIncident?: (i: SqlIncident) => void;
  /** Lot 113AG : appelé une fois si la session est interrompue (incident fatal). */
  onFatal?: (f: SessionFatal) => void;
  /** Lot 113AG (tests) : chaque instruction envoyée, dans l'ordre réel d'envoi. */
  onStatement?: (sql: string) => void;
  /**
   * Lot 113AG (TESTS DE PANNE seulement) : la restauration du point de reprise
   * `name` vise un point de reprise inexistant — échec RÉEL de `ROLLBACK TO
   * SAVEPOINT` côté PostgreSQL (3B001).
   */
  testFailRollbackTo?: (name: string) => boolean;
}

/** Portée d'exécution : une file par niveau (frères sérialisés), les appels imbriqués passent par la portée enfant. */
interface Scope { tail: Promise<void>; closed: boolean; parent: Scope | null; pending: number }

/** Ouvre une session de lecture cohérente ; `close()` termine la transaction et rend la connexion. */
export async function openReadSession(wrap: SessionWrap = {}, opts: ReadSessionOptions = {}): Promise<ReadSession & { close(): Promise<void> }> {
  const { pgClient } = await import('@/db');
  const conn = (await (pgClient as unknown as { reserve: () => Promise<Reserved> }).reserve());
  let open = true;
  let released = false;
  const releaseConn = async () => {
    if (released) return;
    released = true;
    try { await conn.unsafe('ROLLBACK'); } catch { /* transaction déjà terminée (connexion coupée) */ }
    conn.release();
  };
  const close = async () => {
    if (!open) return;
    open = false;
    await releaseConn();
  };
  try {
    await conn.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Lot 107G : un diagnostic DURABLE (worker, hors requête HTTP) peut demander un délai par requête plus long.
    const timeout = opts.statementTimeoutMs && opts.statementTimeoutMs > 0 ? Math.floor(opts.statementTimeoutMs) : DIAG_STATEMENT_TIMEOUT_MS;
    await conn.unsafe(`SET LOCAL statement_timeout = ${timeout}`);
    await conn.unsafe(`SET LOCAL idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_MS}`);
    const [i] = await conn.unsafe(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, pg_current_snapshot()::text AS snap`);
    const stats: SessionStats = { queries: 0, queryMs: 0, fetches: 0, rows: 0, bytes: 0, oversizedRows: 0, maxRowBytes: 0, slowest: [], serializedWaits: 0, maxInFlight: 0 };
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

    // ── Lot 113AG : journal des erreurs SQL ─────────────────────────────────
    const ctx: { phase: string | null; file: string | null; generationId: string | null } = { phase: null, file: null, generationId: null };
    const incidents: SqlIncident[] = [];
    let seq = 0;
    let origins = 0;
    let consequences = 0;
    let firstError: SqlIncident | null = null;
    let lastOrigin: SqlIncident | null = null;
    let fatal: SessionFatal | null = null;
    /** Points de reprise ouverts (état RÉEL de la transaction : les accès sont sérialisés). */
    const spStack: Array<{ name: string; startSeq: number; abortedBy: SqlIncident | null }> = [];
    const record = (e: unknown, sql: string, site: { stack?: string }, kind: SqlIncidentKind): SqlIncident => {
      const code = (e as { code?: unknown } | null)?.code;
      const sqlstate = typeof code === 'string' ? code : null;
      const top = spStack[spStack.length - 1] ?? null;
      const isConsequence = kind === 'ORIGIN' && sqlstate === ABORTED;
      const stack = shortStack(site);
      const inc: SqlIncident = {
        seq: ++seq, at: new Date().toISOString(), sqlstate, message: String((e as Error)?.message ?? e).slice(0, 500),
        kind: isConsequence ? 'CONSEQUENCE' : kind, statement: sql.replace(/\s+/g, ' ').trim().slice(0, 160),
        phase: ctx.phase, file: ctx.file, generationId: ctx.generationId, caller: stack[0] ?? null, stack,
        savepoint: top?.name ?? null, recovered: null, consequenceOf: isConsequence ? (top?.abortedBy ?? lastOrigin)?.seq ?? null : null,
      };
      if (isConsequence) consequences++;
      else { origins++; lastOrigin = inc; if (!firstError) firstError = inc; }
      if (incidents.length < SESSION_INCIDENTS_MAX) incidents.push(inc);
      try { opts.onIncident?.(inc); } catch { /* journal : jamais bloquant */ }
      return inc;
    };
    const breakSession = async (reason: string, origin: SqlIncident | null, rollback: SqlIncident | null): Promise<ReadSessionBrokenError> => {
      if (!fatal) {
        fatal = { at: new Date().toISOString(), reason, origin, rollback };
        for (const x of incidents) if (x.recovered === null) x.recovered = false;
        spStack.length = 0;
        // Transaction terminée, connexion rendue : plus aucune lecture (aucun mélange d'instantanés).
        await releaseConn();
        try { opts.onFatal?.(fatal); } catch { /* journal : jamais bloquant */ }
      }
      return new ReadSessionBrokenError(fatal);
    };
    const usable = () => {
      if (fatal) throw new ReadSessionBrokenError(fatal);
      if (!open || released) throw Object.assign(new Error('session de lecture fermée'), { code: SESSION_BROKEN_CODE, name: 'ReadSessionClosedError' });
    };

    // ── Lot 113AG : UNE instruction à la fois sur la connexion réservée ─────
    // Garde « fil » : chaque instruction attend la fin de la précédente (jamais de pipeline,
    // même si un appelant lance des lectures en parallèle — Promise.all compris).
    let wire: Promise<unknown> = Promise.resolve();
    let inFlight = 0;
    const exec = (sql: string, params: unknown[], kind: SqlIncidentKind = 'ORIGIN'): Promise<Row[]> => {
      const site: { stack?: string } = {};
      Error.captureStackTrace(site, exec);
      const run = async (): Promise<Row[]> => {
        usable();
        inFlight++;
        if (inFlight > stats.maxInFlight!) stats.maxInFlight = inFlight;
        try {
          opts.onStatement?.(sql);
          return (await conn.unsafe(sql, params as never[])) as Row[];
        } catch (e) {
          if (!abortsTransaction(e)) throw e;
          const inc = record(e, sql, site, kind);
          (e as { vbIncident?: number }).vbIncident = inc.seq;
          const top = spStack[spStack.length - 1];
          if (!top) {
            // Hors point de reprise : la transaction de l'instantané est invalidée — incident FATAL (session
            // fermée, connexion libérée). L'erreur d'origine est relancée telle quelle (code conservé) ;
            // toute lecture suivante lève ReadSessionBrokenError sans rien envoyer.
            await breakSession(`erreur SQL hors point de reprise (${inc.sqlstate ?? 'code inconnu'})`, inc.kind === 'CONSEQUENCE' ? (firstError ?? inc) : inc, null);
            (e as { vbSessionBroken?: boolean }).vbSessionBroken = true;
            throw e;
          }
          if (!top.abortedBy && kind === 'ORIGIN') top.abortedBy = inc.kind === 'CONSEQUENCE' ? (lastOrigin ?? inc) : inc;
          throw e;
        } finally { inFlight--; }
      };
      const p = wire.then(run, run);
      wire = p.then(() => undefined, () => undefined);
      return p;
    };

    // ── Lot 113AG : file interne par portée (frères sérialisés, imbrication permise) ─
    // Un point de reprise occupe sa portée jusqu'à RELEASE / ROLLBACK TO : deux points de
    // reprise « parallèles » ne s'entrelacent jamais ; ce qui s'exécute DANS un point de
    // reprise passe par la portée enfant (aucun interblocage), elle-même sérialisée.
    const als = new AsyncLocalStorage<Scope>();
    const root: Scope = { tail: Promise.resolve(), closed: false, parent: null, pending: 0 };
    const op = async <T>(run: () => Promise<T>): Promise<T> => {
      let level = als.getStore() ?? root;
      while (level.closed && level.parent) level = level.parent;
      const prev = level.tail;
      let done!: () => void;
      level.tail = new Promise<void>((r) => { done = r; });
      // Un frère occupe déjà la portée : cet accès attend son tour (mesuré).
      if (level.pending++ > 0) stats.serializedWaits = (stats.serializedWaits ?? 0) + 1;
      await prev;
      const child: Scope = { tail: Promise.resolve(), closed: false, parent: level, pending: 0 };
      try { return await als.run(child, run); } finally { child.closed = true; level.pending--; done(); }
    };

    const rawQ = (sql: string, params: unknown[] = [], kind: SqlIncidentKind = 'ORIGIN') => exec(sql, params, kind);
    const baseQ: DiagQuery = (sql, params = []) => op(() => timed(sql, () => rawQ(sql, params)));
    const maxBytes = opts.batchBytes && opts.batchBytes > 0 ? Math.floor(opts.batchBytes) : exportBatchBytes();
    let cursors = 0;
    // Lot 113Q : curseur SQL à allers-retours ADAPTÉS à la taille des lignes (borne en octets ET en lignes).
    // Lot 113AG : DECLARE / FETCH / CLOSE passent par la file (jamais en même temps qu'une autre instruction).
    const baseCursor: RowCursor = (sql, params, batch = EXPORT_BATCH_ROWS) => (async function* () {
      const name = `vb_cur_${++cursors}`;
      await op(() => timed(sql, () => rawQ(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, params)));
      let open = true;
      let seenRows = 0;
      let seenBytes = 0;
      let lot: Row[] = [];
      let lotBytes = 0;
      try {
        for (;;) {
          const n = nextFetchRows(batch, maxBytes, seenRows, seenBytes);
          const rows = await op(() => timed(`FETCH ${name}`, () => rawQ(`FETCH ${n} FROM ${name}`)));
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
        await op(() => rawQ(`CLOSE ${name}`));
        open = false;
      } finally {
        // Parcours interrompu (erreur du consommateur, annulation) : curseur fermé si la transaction le permet
        // (échec consigné au journal de la session ; session interrompue : rien n'est plus envoyé).
        if (open && !fatal) await op(() => rawQ(`CLOSE ${name}`)).catch(() => undefined);
      }
    })();
    const q = wrap.q ? wrap.q(baseQ) : baseQ;
    const cursor = wrap.cursor ? wrap.cursor(baseCursor) : baseCursor;
    let n = 0;
    /**
     * Lot 113AG — point de reprise SÛR : SAVEPOINT → lectures → RELEASE, ou
     * en cas d'erreur ROLLBACK TO puis RELEASE (session saine, erreur d'origine
     * relancée). Échec de la restauration : incident FATAL — transaction
     * terminée, connexion libérée, plus aucune lecture ; l'erreur levée garde
     * l'erreur d'origine ET l'échec de restauration.
     */
    const restore = async (frame: { name: string; startSeq: number; abortedBy: SqlIncident | null }, cause: unknown): Promise<void> => {
      try {
        await rawQ(`ROLLBACK TO SAVEPOINT ${opts.testFailRollbackTo?.(frame.name) ? `${frame.name}_absent` : frame.name}`, [], 'ROLLBACK_FAILED');
        await rawQ(`RELEASE SAVEPOINT ${frame.name}`, [], 'ROLLBACK_FAILED');
      } catch (rb) {
        if (isReadSessionBroken(rb)) throw rb;
        const rbSeq = (rb as { vbIncident?: number }).vbIncident;
        const rbInc = incidents.find((x) => x.seq === rbSeq) ?? null;
        const causeSeq = (cause as { vbIncident?: number } | null)?.vbIncident;
        const origin = frame.abortedBy ?? incidents.find((x) => x.seq === causeSeq) ?? null;
        throw await breakSession(`échec de la restauration du point de reprise ${frame.name}`, origin, rbInc);
      }
      const k = spStack.indexOf(frame);
      if (k >= 0) spStack.length = k;
      for (const x of incidents) if (x.seq > frame.startSeq && x.recovered === null) x.recovered = true;
    };
    const maskedError = (o: SqlIncident) => Object.assign(
      new Error(`lecture SQL en échec dans le point de reprise (erreur interceptée par l’appelant) : ${o.sqlstate ?? 'code inconnu'} — ${o.message}`),
      { code: o.sqlstate ?? undefined, vbIncident: o.seq },
    );
    const savepoint = <T>(fn: () => Promise<T>): Promise<T> => op(async () => {
      usable();
      const name = `vb_sp_${++n}`;
      await rawQ(`SAVEPOINT ${name}`);
      const frame = { name, startSeq: seq, abortedBy: null as SqlIncident | null };
      spStack.push(frame);
      let out: T;
      try {
        out = await fn();
      } catch (e) {
        if (isReadSessionBroken(e) || fatal) throw fatal ? new ReadSessionBrokenError(fatal) : e;
        await restore(frame, e);
        // Un 25P02 n'est jamais présenté à la place de sa cause : l'erreur d'origine du point de reprise est relancée.
        if ((e as { code?: unknown } | null)?.code === ABORTED && frame.abortedBy && frame.abortedBy.sqlstate !== ABORTED) throw maskedError(frame.abortedBy);
        throw e;
      }
      if (fatal) throw new ReadSessionBrokenError(fatal);
      if (frame.abortedBy) {
        // Erreur interceptée par l'appelant DANS le point de reprise : jamais un résultat présenté comme lu.
        const o = frame.abortedBy;
        await restore(frame, null);
        throw maskedError(o);
      }
      try {
        await rawQ(`RELEASE SAVEPOINT ${name}`, [], 'RELEASE_FAILED');
      } catch (e) {
        if (isReadSessionBroken(e)) throw e;
        await restore(frame, e);
        throw e;
      }
      const k = spStack.indexOf(frame);
      if (k >= 0) spStack.length = k;
      return out;
    });
    const trace: SessionTrace = {
      setContext: (c) => {
        if (c.phase !== undefined) ctx.phase = c.phase;
        if (c.file !== undefined) ctx.file = c.file;
        if (c.generationId !== undefined) ctx.generationId = c.generationId;
      },
      mark: () => seq,
      since: (m) => {
        const after = incidents.filter((x) => x.seq > m);
        return { count: seq - m, firstOrigin: after.find((x) => x.kind !== 'CONSEQUENCE') ?? null, consequences: after.filter((x) => x.kind === 'CONSEQUENCE').length };
      },
      health: () => ({
        state: fatal ? 'BROKEN' : 'HEALTHY', firstError, fatal, incidents: [...incidents], total: seq, origins, consequences, omitted: Math.max(0, seq - incidents.length),
      }),
    };
    return { q, cursor, savepoint, stats, trace, info: { isolation: SNAPSHOT_ISOLATION, at: String(i?.at ?? new Date().toISOString()), snapshot: i?.snap == null ? null : String(i.snap) }, close };
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
