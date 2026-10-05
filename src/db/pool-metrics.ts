/**
 * Mesures du pool PostgreSQL — APP-PERF-01 §MESURES (lot 24, #10).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST MESURÉ, SÉPARÉMENT
 *
 *   · `pool_wait_ms` : de la demande d'exécution à la prise en charge par une
 *     connexion — attente d'une connexion libre (ou de son tour sur une
 *     connexion occupée) ET, pour une connexion fermée (inactivité, durée de
 *     vie), son ouverture ;
 *   · `sql_ms`       : de la prise en charge au résultat (exécution et transfert) ;
 *   · requêtes en cours, en attente d'une connexion, pics, erreurs.
 *
 * Agrégats seulement (compteurs, sommes, maxima, histogramme à seuils fixes
 * pour le p95) : aucune requête, aucun paramètre, aucune URL de connexion
 * n'est conservé ni journalisé.
 *
 * COMMENT (postgres.js 3.4) : le pilote n'expose pas d'événement « connexion
 * obtenue ». Il passe le champ `active` d'une requête à `true` quand elle
 * devient la requête en cours de sa connexion — y compris quand il l'a mise
 * en file (« pipeline ») derrière d'autres sur une connexion occupée : un
 * accesseur posé sur CETTE requête date cet instant. L'attente derrière une
 * requête de la même connexion compte donc comme attente de connexion, pas
 * comme temps SQL. Sans signal (version du pilote différente, requête annulée
 * avant envoi), la requête est comptée « non mesurée » — jamais une valeur
 * inventée. L'option `debug` du pilote n'est PAS utilisée : elle rendrait
 * requêtes et paramètres énumérables dans les erreurs (fuite dans les journaux).
 * Transactions (`begin`) : attente = jusqu'au démarrage du rappel ; les
 * requêtes internes à la transaction ne sont pas comptées une à une.
 *
 * ⚠️ COUVERTURE PARTIELLE — LES CHIFFRES SONT DES MINORANTS. Sont mesurées :
 * toutes les requêtes Drizzle (`unsafe`), les appels `pgClient.unsafe` et
 * l'attente des transactions. NE SONT PAS mesurées : les requêtes en gabarit
 * balisé directement sur le client (`pgClient\`…\``, `db.$client\`…\`` —
 * sauvegarde, quelques services IA), les requêtes internes aux transactions,
 * `reserve`/`listen`. Envelopper le client lui-même (fonction appelable)
 * changerait l'identité de `pgClient` partagée par tout le code : écarté.
 * Lire `poolWait` / `inFlight` comme une borne basse de la charge réelle.
 *
 * Exposition : journal agrégé périodique (`DB_POOL_METRICS_LOG_INTERVAL_S`,
 * défaut 300 s, 0 = jamais ; une ligne seulement s'il y a eu de l'activité)
 * et diagnostic protégé de `/api/health` (`x-health-token`).
 * État porté par `globalThis` : une seule vue par processus, même si plusieurs
 * couches (bundles) Next.js chargent leur copie de `@/db`.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Seuils (ms) de l'histogramme ; la dernière case est « au-delà ». */
export const BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000] as const;

interface Serie {
  count: number;
  sumMs: number;
  maxMs: number;
  buckets: number[];
}

const serie = (): Serie => ({ count: 0, sumMs: 0, maxMs: 0, buckets: new Array(BUCKETS_MS.length + 1).fill(0) });

function ajouter(s: Serie, ms: number): void {
  const v = Math.max(0, ms);
  s.count += 1;
  s.sumMs += v;
  if (v > s.maxMs) s.maxMs = v;
  let i = BUCKETS_MS.findIndex((b) => v <= b);
  if (i < 0) i = BUCKETS_MS.length;
  s.buckets[i] += 1;
}

/** Quantile approché : borne haute de la case qui le contient (`null` au-delà du dernier seuil). */
export function quantile(s: Serie, q: number): number | null {
  if (s.count === 0) return 0;
  const rang = Math.ceil(q * s.count);
  let cumul = 0;
  for (let i = 0; i < s.buckets.length; i++) {
    cumul += s.buckets[i];
    if (cumul >= rang) return i < BUCKETS_MS.length ? BUCKETS_MS[i] : null;
  }
  return null;
}

export interface SerieSnapshot {
  count: number;
  avgMs: number;
  maxMs: number;
  /** Borne haute de la case du p95 (`null` : au-delà de 10 s). */
  p95Ms: number | null;
}

export interface PoolMetricsSnapshot {
  /** Début de la fenêtre (ISO). */
  since: string;
  queries: number;
  errors: number;
  /** Requêtes dont la prise en charge n'a pas pu être datée. */
  unmeasured: number;
  poolWait: SerieSnapshot;
  sql: SerieSnapshot;
  transactionWait: SerieSnapshot;
  /** En cours (appelées, non terminées) / en attente d'une connexion, à l'instant. */
  inFlight: number;
  waiting: number;
  /** Pics sur la fenêtre. */
  maxInFlight: number;
  maxWaiting: number;
}

interface Fenetre {
  since: number;
  queries: number;
  errors: number;
  unmeasured: number;
  poolWait: Serie;
  sql: Serie;
  transactionWait: Serie;
  maxInFlight: number;
  maxWaiting: number;
}

const fenetre = (now: number): Fenetre => ({
  since: now, queries: 0, errors: 0, unmeasured: 0,
  poolWait: serie(), sql: serie(), transactionWait: serie(), maxInFlight: 0, maxWaiting: 0,
});

const vue = (s: Serie): SerieSnapshot => ({
  count: s.count,
  avgMs: s.count ? Math.round((s.sumMs / s.count) * 10) / 10 : 0,
  maxMs: Math.round(s.maxMs * 10) / 10,
  p95Ms: quantile(s, 0.95),
});

export class PoolMetrics {
  private total: Fenetre;
  private periode: Fenetre;
  inFlight = 0;
  waiting = 0;

  constructor(private readonly now: () => number = () => performance.now(), private readonly wall: () => number = Date.now) {
    this.total = fenetre(this.wall());
    this.periode = fenetre(this.wall());
  }

  private pour(fn: (f: Fenetre) => void): void {
    fn(this.total);
    fn(this.periode);
  }

  /** Exécution demandée au pilote. Rend ses jalons. */
  debut(): { prise: () => void; fin: (erreur: boolean) => void; abandon: () => void } {
    const t0 = this.now();
    let t1: number | null = null;
    let fini = false;
    this.inFlight += 1;
    this.waiting += 1;
    this.pour((f) => {
      f.maxInFlight = Math.max(f.maxInFlight, this.inFlight);
      f.maxWaiting = Math.max(f.maxWaiting, this.waiting);
    });
    return {
      prise: () => {
        if (t1 !== null || fini) return;
        t1 = this.now();
        this.waiting -= 1;
        const attente = t1 - t0;
        this.pour((f) => ajouter(f.poolWait, attente));
      },
      fin: (erreur) => {
        if (fini) return;
        fini = true;
        this.inFlight -= 1;
        const t2 = this.now();
        if (t1 === null) {
          this.waiting -= 1;
          this.pour((f) => { f.unmeasured += 1; });
        } else {
          const duree = t2 - t1;
          this.pour((f) => ajouter(f.sql, duree));
        }
        this.pour((f) => { f.queries += 1; if (erreur) f.errors += 1; });
      },
      // Requête sortie du suivi (curseur) : retirée des compteurs, sans mesure.
      abandon: () => {
        if (fini) return;
        fini = true;
        this.inFlight -= 1;
        if (t1 === null) this.waiting -= 1;
      },
    };
  }

  /** Attente d'une connexion réservée pour une transaction. */
  transaction(attenteMs: number): void {
    this.pour((f) => ajouter(f.transactionWait, attenteMs));
  }

  private photo(f: Fenetre): PoolMetricsSnapshot {
    return {
      since: new Date(f.since).toISOString(),
      queries: f.queries,
      errors: f.errors,
      unmeasured: f.unmeasured,
      poolWait: vue(f.poolWait),
      sql: vue(f.sql),
      transactionWait: vue(f.transactionWait),
      inFlight: this.inFlight,
      waiting: this.waiting,
      maxInFlight: f.maxInFlight,
      maxWaiting: f.maxWaiting,
    };
  }

  /** Depuis le démarrage du processus. */
  snapshot(): PoolMetricsSnapshot {
    return this.photo(this.total);
  }

  /** Fenêtre écoulée depuis le dernier appel, puis nouvelle fenêtre. */
  rotate(): PoolMetricsSnapshot {
    const p = this.photo(this.periode);
    this.periode = fenetre(this.wall());
    this.periode.maxInFlight = this.inFlight;
    this.periode.maxWaiting = this.waiting;
    return p;
  }
}

const CLE = Symbol.for('verebona.db.poolMetrics');
type Global = { [CLE]?: PoolMetrics };

/** Mesures du processus (partagées entre les copies de `@/db`). */
export function getPoolMetrics(): PoolMetrics {
  const g = globalThis as Global;
  return (g[CLE] ??= new PoolMetrics());
}

// ── Instrumentation du client postgres.js ──────────────────────────────────

// Client postgres.js : seules ces deux méthodes sont enveloppées.
interface ClientInstrumentable {
  unsafe: (...args: never[]) => unknown;
  begin: (...args: never[]) => unknown;
}

/**
 * Pose un accesseur sur `active` : le pilote le passe à `true` quand la
 * requête devient LA requête en cours de sa connexion (tout de suite sur une
 * connexion libre ; après les précédentes si elle a été mise en file derrière
 * elles sur une connexion occupée). Cet instant date la prise en charge.
 */
function daterPriseEnCharge(q: object, prise: () => void): void {
  const d = Object.getOwnPropertyDescriptor(q, 'active');
  if (!d || !('value' in d) || !d.configurable) return;
  let valeur = d.value as unknown;
  Object.defineProperty(q, 'active', {
    configurable: true,
    enumerable: d.enumerable,
    get: () => valeur,
    set: (v: unknown) => { valeur = v; if (v === true) prise(); },
  });
}

type RequetePg = Promise<unknown> & { handle?: () => unknown; cursor?: (...a: unknown[]) => unknown };

/**
 * Suit UNE requête sans jamais en déclencher l'exécution : une requête
 * `unsafe` peut servir de FRAGMENT d'une autre (`WHERE ${sql.unsafe(…)}`,
 * api/deadlines) et ne doit alors jamais partir seule. Le suivi commence
 * quand le pilote est sollicité (`handle`, appelé par `then`/`catch`/
 * `finally`/`execute`/`forEach`) ; la fin est observée par
 * `Promise.prototype.then`, qui ne sollicite pas le pilote. Un curseur sort
 * du suivi (sa promesse sous-jacente ne se résout pas).
 */
function suivre(q: RequetePg, metrics: PoolMetrics): void {
  const handle = q.handle;
  if (typeof handle !== 'function') return;
  let jalons: ReturnType<PoolMetrics['debut']> | null = null;
  let exclu = false;
  q.handle = function suivi(this: RequetePg) {
    if (!jalons && !exclu) {
      jalons = metrics.debut();
      daterPriseEnCharge(q, jalons.prise);
      const j = jalons;
      Promise.prototype.then.call(q, () => j.fin(false), () => j.fin(true));
    }
    return handle.call(this);
  };
  const cursor = q.cursor;
  if (typeof cursor === 'function') {
    q.cursor = function curseur(this: RequetePg, ...a: unknown[]) {
      exclu = true;
      jalons?.abandon();
      return cursor.apply(this, a);
    };
  }
}

/**
 * Enveloppe `unsafe` (toutes les requêtes Drizzle et les appels directs) et
 * `begin` (transactions). Comportement du pilote inchangé : la requête rendue
 * est la même instance, exécutée au même moment. Idempotent.
 */
export function instrumentPgClient<C extends ClientInstrumentable>(client: C, metrics: PoolMetrics = getPoolMetrics()): C {
  const marque = client as C & { __verebonaInstrumented?: boolean };
  if (marque.__verebonaInstrumented) return client;
  marque.__verebonaInstrumented = true;

  const unsafe = client.unsafe.bind(client) as (...a: unknown[]) => unknown;
  (client as { unsafe: unknown }).unsafe = (...args: unknown[]) => {
    const q = unsafe(...args);
    if (q instanceof Promise) {
      try { suivre(q as RequetePg, metrics); } catch { /* mesure seulement : jamais bloquante */ }
    }
    return q;
  };

  const begin = client.begin.bind(client) as (...a: unknown[]) => unknown;
  (client as { begin: unknown }).begin = (...args: unknown[]) => {
    const i = args.findIndex((a) => typeof a === 'function');
    if (i < 0) return begin(...args);
    const fn = args[i] as (...x: unknown[]) => unknown;
    const t0 = performance.now();
    let mesure = false;
    const copie = [...args];
    copie[i] = (...x: unknown[]) => {
      if (!mesure) { mesure = true; metrics.transaction(performance.now() - t0); }
      return fn(...x);
    };
    return begin(...copie);
  };
  return client;
}

// ── Journal périodique ─────────────────────────────────────────────────────

/** Intervalle du journal agrégé (s) : `DB_POOL_METRICS_LOG_INTERVAL_S`, défaut 300, 0 = jamais. */
export function poolMetricsLogIntervalS(env: NodeJS.ProcessEnv = process.env): number {
  const brut = (env.DB_POOL_METRICS_LOG_INTERVAL_S ?? '').trim();
  if (!brut) return 300;
  const n = Number(brut);
  return Number.isInteger(n) && n >= 0 ? n : 300;
}

const CLE_JOURNAL = Symbol.for('verebona.db.poolMetricsLog');

/** Une ligne JSON par fenêtre active (aucune ligne sans requête). Une seule minuterie par processus. */
export function startPoolMetricsLog(role: string, max: number, env: NodeJS.ProcessEnv = process.env): void {
  const g = globalThis as { [CLE_JOURNAL]?: boolean };
  const s = poolMetricsLogIntervalS(env);
  if (s === 0 || g[CLE_JOURNAL]) return;
  g[CLE_JOURNAL] = true;
  const metrics = getPoolMetrics();
  const t = setInterval(() => {
    const p = metrics.rotate();
    if (p.queries === 0 && p.transactionWait.count === 0 && p.inFlight === 0) return;
    console.info(`[db] pool ${JSON.stringify({ role, max, ...p })}`);
  }, s * 1000);
  t.unref?.();
}
