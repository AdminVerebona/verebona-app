/**
 * Lot 114 (carte #776, §4 et §5) — DÉCISION D'ENVOI DU SCHÉMA et mémoire des
 * incompatibilités, pour la passerelle.
 *
 * Remplace la mémoire locale de 6 heures (`noteSchemaRejected`, lot 33D) :
 *   · mémoire PARTAGÉE et DURABLE (`store.ts`, migration 1710) — un refus
 *     constaté par une instance est connu des autres (relecture bornée,
 *     `SHARED_TTL_MS`) et survit au redémarrage ;
 *   · mémoire LOCALE conservée comme premier niveau : effet immédiat dans le
 *     processus, et seul niveau quand la base n'est pas accessible (tests
 *     unitaires, migration absente, base lente) — comportement antérieur ;
 *   · réexamen BORNÉ : après l'échéance, UNE instance réserve l'essai avec
 *     schéma ; les autres continuent sans schéma jusqu'à son issue ;
 *   · clé par couple (`policy.ts`) : un autre modèle, contrat, schéma projeté
 *     ou adaptateur n'hérite d'aucun refus.
 *
 * AUCUNE lecture ni écriture ne fait échouer ou attendre un appel au-delà de
 * `LOOKUP_TIMEOUT_MS` : en cas de doute, la dernière décision connue
 * s'applique ; un réexamen non réservable n'a pas lieu (jamais de rafale).
 */
import {
  SCHEMA_COMPAT_POLICY, applySchemaOutcome, applyServedVersion, claimRetestOf, coupleKeyId, qualificationDueOf, schemaUseOf,
  type SchemaCompatState, type SchemaCoupleKey, type SchemaCoupleState, type SchemaOutcome,
} from './policy';

export * from './policy';

/** Relecture de la mémoire partagée (délai maximal de propagation d'un refus entre instances). */
export const SHARED_TTL_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 2_000;
/**
 * Carte #863 (A2) — TOLÉRANCE BORNÉE d'un cache PÉRIMÉ (lecture en échec) pour
 * une QUALIFICATION : au-delà de `SHARED_TTL_MS + QUALIFIED_STALE_TOLERANCE_MS`
 * depuis la dernière preuve durable (lecture réussie ou écriture confirmée),
 * une qualification n'est plus prouvable — appel en JSON sans schéma. Un refus
 * connu reste opposable sans limite. Le cache n'est JAMAIS rajeuni par une
 * lecture en échec (aucune prolongation sans preuve).
 */
export const QUALIFIED_STALE_TOLERANCE_MS = SHARED_TTL_MS;
/**
 * Carte #863 (A1) — écritures d'issue : reprise BORNÉE (tentatives, délais),
 * jamais de libération prématurée du bail après un échec d'écriture (le bail
 * expire de lui-même : aucune rafale d'essais).
 */
const WRITE_RETRY_DELAYS_MS = [50, 250] as const;
/**
 * Lot 115 (carte #784, §B1) — BORNES des mémoires de ce processus. Le cache
 * partagé ne porte que les couples les plus récemment actifs : au-delà, la
 * décision d'un couple absent est prise par une LECTURE PAR CLÉ, jamais par
 * une absence (un refus ancien ne doit pas être oublié parce qu'il est vieux).
 */
const LOCAL_MAX = 5_000;
/** Durée pendant laquelle « ce couple n'existe pas en base » est tenu pour acquis (évite une lecture par appel). */
const MISS_TTL_MS = SHARED_TTL_MS;

/** Décision d'envoi du schéma pour UN appel, tracée avec la requête fournisseur. */
export interface SchemaDecision {
  keyId: string;
  key: SchemaCoupleKey;
  /** Transmettre le schéma à cet appel. */
  send: boolean;
  /** Cet appel est le réexamen réservé d'un couple refusé. */
  retest: boolean;
  /** État du couple AVANT l'appel. */
  state: SchemaCompatState;
  /**
   * `not_tested`, `qualified`, `retest_due`, `recent_rejection`, `retest_in_progress`, `retest_not_claimed`,
   * `first_qualification`, `requalification_due`, `qualification_in_progress`, `memory_unavailable`,
   * carte #863 (A3) : `requalification_deferred` (report d'une requalification incertaine, sans schéma).
   */
  why: string;
  policyVersion: number;
  /** Lot 115 (#784, A3) : dernière version de modèle SERVIE connue pour ce couple ; `null` : jamais observée. */
  servedModelVersion?: string | null;
  /**
   * Carte #838 (A1, A3) : cet appel est l'essai de qualification RÉSERVÉ du
   * couple (bail partagé). Son issue rend le bail (`reportSchemaOutcome`).
   * Carte #863 (A1) : `until` — fin du bail (validité revérifiée avant l'envoi).
   */
  qualification?: { kind: 'FIRST' | 'REQUALIFY'; token: string; until?: number } | null;
  /**
   * Carte #863 (A1) — FENCING de l'issue : jeton du bail (qualification ou
   * réexamen réservé) et génération de l'état observée à la décision. L'issue
   * n'est écrite que si elle est encore opposable (`store.ts`).
   */
  fence?: { token: string | null; generation: number | null; until: number | null } | null;
  /**
   * Carte #838 (A2) : mode DÉGRADÉ — la mémoire partagée n'a pas pu être lue
   * (ou le bail n'a pas pu être demandé) et le statut du couple n'est pas
   * prouvable : JSON sans schéma fournisseur, validation locale inchangée.
   */
  degraded?: { cause: SchemaMemoryDegradedCause } | null;
}

/**
 * Carte #838 (A2) — causes d'une dégradation conservatrice (codes stables) :
 *   · `shared_unreadable`  relecture du cache partagé impossible (base en
 *                          panne, délai) et couple inconnu localement ;
 *   · `couple_unreadable`  lecture par clé impossible (cache tronqué) ;
 *   · `claim_failed`       bail de qualification non demandable (panne) ;
 *   · `decision_failed`    erreur imprévue de la décision.
 * Carte #863 (A2) :
 *   · `stale_cache`        cache PÉRIMÉ (lecture en échec) : une qualification
 *                          plus ancienne que la tolérance n'est plus prouvable ;
 *   · `migration_not_ready` colonnes du bail absentes (1980 non appliquée) :
 *                          aucun essai non réservé, JSON sans schéma ;
 *   · `retest_claim_failed` réservation d'un réexamen impossible (panne, délai).
 */
export type SchemaMemoryDegradedCause =
  | 'shared_unreadable' | 'couple_unreadable' | 'claim_failed' | 'decision_failed'
  | 'stale_cache' | 'migration_not_ready' | 'retest_claim_failed';

// ── Mémoire locale (premier niveau) ─────────────────────────────────────────

const local = new Map<string, SchemaCoupleState>();
/** Carte #863 (A2) : instant de la dernière PREUVE durable d'un état local (écriture confirmée, lecture par clé). */
const localAt = new Map<string, number>();
let shared: { at: number; byKey: Map<string, SchemaCoupleState>; truncated: boolean } | null = null;
let sharedLoading: Promise<void> | null = null;
const notedOnce = new Map<string, number>();
/** Couples lus par clé et ABSENTS de la base (bornée dans le temps et en taille). */
const misses = new Map<string, number>();
/** Carte #863 (A2) : lectures par clé en ÉCHEC — une nouvelle tentative au plus par `SHARED_TTL_MS` et par couple. */
const coupleReadFailures = new Map<string, number>();
/**
 * Carte #838 (A2) — SANTÉ de la mémoire partagée : une lecture en échec n'est
 * jamais confondue avec une absence. `failedAt` borne les relectures pendant
 * une panne (une tentative par `SHARED_TTL_MS` et par instance : pas de
 * tempête de lectures, aucune attente de `LOOKUP_TIMEOUT_MS` à chaque appel).
 */
let sharedHealth: { ok: boolean; cause: string | null; failedAt: number | null } = { ok: true, cause: null, failedAt: null };
/** Migration 1710 absente : la mémoire partagée n'existe pas (comportement antérieur : mémoire locale seule). */
let sharedAbsent = false;
/** Carte #838 (A1) : baux de qualification tenus par CE processus (évite une demande en base par requête concurrente). */
const localClaims = new Map<string, { token: string; until: number }>();
/** Carte #838 (A2) : compteurs du mode dégradé de ce processus (supervision, recette). */
const degradedStats = { decisions: 0, byCause: {} as Record<string, number>, lastCause: null as string | null, lastAt: null as number | null, lastLoggedAt: 0 };
/**
 * Carte #863 (A2) — compteurs DISTINCTS des décisions sans schéma de ce processus : mémoire indisponible
 * (par cause), bail détenu ailleurs, rejet connu, report de requalification, migration non prête ; et
 * lectures de la mémoire partagée réellement tentées (cache, clé), écritures d'issue (appliquées, écartées
 * par le fencing, en échec après reprise).
 */
const decisionStats = {
  byWhy: {} as Record<string, number>, sharedReads: 0, coupleReads: 0,
  writesApplied: 0, writesFenced: 0, writesFailed: 0, lateClaimsReleased: 0,
};

/** Mémoires de ce processus bornées : la plus anciennement vue sort d'abord. */
function bound<T>(m: Map<string, T>, max: number): void {
  while (m.size > max) {
    const first = m.keys().next();
    if (first.done) return;
    m.delete(first.value);
  }
}
let dbForcedInTests = false;
let storeOverride: Partial<typeof import('./store')> | null = null;

/** Les tests unitaires n'ouvrent aucune connexion (convention de `fallback-context.ts`). */
function dbAllowed(): boolean {
  return process.env.NODE_ENV !== 'test' || dbForcedInTests || storeOverride !== null;
}

/** Réservé aux e2e : active la mémoire partagée sous `NODE_ENV=test`. */
export function __enableSchemaCompatDbForTests(on: boolean): void {
  dbForcedInTests = on;
  __resetSchemaCompatProcessForTests();
}

/**
 * Réservé aux tests : magasin simulé (`null` : magasin réel). `keepProcessMemory`
 * (carte #838, A2) : conserve la mémoire du processus — injection d'une panne
 * de base À CACHE CHAUD, sans simuler de redémarrage.
 */
export function __setSchemaCompatStoreForTests(s: Partial<typeof import('./store')> | null, opts: { keepProcessMemory?: boolean } = {}): void {
  storeOverride = s;
  if (!opts.keepProcessMemory) __resetSchemaCompatProcessForTests();
}

/** Réservé aux tests : simule un REDÉMARRAGE du processus (mémoire locale et cache vidés, base intacte). */
export function __resetSchemaCompatProcessForTests(): void {
  local.clear();
  localAt.clear();
  shared = null;
  sharedLoading = null;
  notedOnce.clear();
  misses.clear();
  coupleReadFailures.clear();
  localClaims.clear();
  sharedHealth = { ok: true, cause: null, failedAt: null };
  sharedAbsent = false;
  degradedStats.decisions = 0; degradedStats.byCause = {}; degradedStats.lastCause = null; degradedStats.lastAt = null; degradedStats.lastLoggedAt = 0;
  decisionStats.byWhy = {}; decisionStats.sharedReads = 0; decisionStats.coupleReads = 0;
  decisionStats.writesApplied = 0; decisionStats.writesFenced = 0; decisionStats.writesFailed = 0; decisionStats.lateClaimsReleased = 0;
}

/**
 * Carte #838 (A2) — état du mode dégradé de CE processus : décisions prises
 * sans schéma faute de mémoire lisible, par cause ; santé de la mémoire
 * partagée. Lecture seule (supervision, recette).
 * Carte #863 (A2) : compteurs distincts des décisions par motif, lectures
 * tentées et écritures d'issue (appliquées, écartées, en échec).
 */
export function schemaMemoryDegradedStats(): {
  decisions: number; byCause: Record<string, number>; lastCause: string | null; lastAt: number | null;
  sharedHealthy: boolean; sharedCause: string | null;
  byWhy: Record<string, number>; sharedReads: number; coupleReads: number;
  writesApplied: number; writesFenced: number; writesFailed: number; lateClaimsReleased: number;
} {
  return {
    decisions: degradedStats.decisions, byCause: { ...degradedStats.byCause }, lastCause: degradedStats.lastCause, lastAt: degradedStats.lastAt,
    sharedHealthy: sharedHealth.ok, sharedCause: sharedHealth.cause,
    byWhy: { ...decisionStats.byWhy }, sharedReads: decisionStats.sharedReads, coupleReads: decisionStats.coupleReads,
    writesApplied: decisionStats.writesApplied, writesFenced: decisionStats.writesFenced, writesFailed: decisionStats.writesFailed,
    lateClaimsReleased: decisionStats.lateClaimsReleased,
  };
}

/** Journal du mode dégradé : compté à chaque décision, écrit au plus une fois par minute (pas d'inondation). */
function noteDegraded(cause: SchemaMemoryDegradedCause, detail: string | null, now: number): void {
  degradedStats.decisions++;
  degradedStats.byCause[cause] = (degradedStats.byCause[cause] ?? 0) + 1;
  degradedStats.lastCause = cause;
  degradedStats.lastAt = now;
  if (now - degradedStats.lastLoggedAt < 60_000) return;
  degradedStats.lastLoggedAt = now;
  console.warn(`[schema-compat] MODE DÉGRADÉ (${cause}) : statut du couple non prouvable — appel en JSON sans schéma fournisseur, `
    + `validation locale inchangée, aucune qualification ni levée d'alerte déduite.${detail ? ` Cause : ${detail.slice(0, 160)}` : ''} `
    + `(${degradedStats.decisions} décision(s) dégradée(s) depuis le démarrage)`);
}

/** Réservé aux tests (nom historique, lot 33D) : oublie les refus mémorisés localement. */
export function clearSchemaRejections(): void {
  __resetSchemaCompatProcessForTests();
}

async function store(): Promise<typeof import('./store')> {
  const real = await import('./store');
  return storeOverride ? { ...real, ...storeOverride } : real;
}

/**
 * Carte #838 (A2) — lecture BORNÉE qui DISTINGUE le résultat (même `null` :
 * « absent ») d'un échec (erreur, délai).
 * Carte #863 (A1) : `onLate` — le résultat d'une instruction qui aboutit
 * APRÈS le délai (réservation arrivée tardivement) n'est pas perdu : il est
 * remis à l'appelant, qui le défait (bail rendu) au lieu de le laisser
 * bloquer le couple.
 */
async function attempt<T>(p: () => Promise<T>, onLate?: (v: T) => void): Promise<{ ok: true; value: T } | { ok: false; cause: string }> {
  let expire = false;
  const run = p();
  return Promise.race([
    run.then((value) => {
      if (expire) { try { onLate?.(value); } catch { /* sans effet */ } }
      return { ok: true as const, value };
    }, (e: unknown) => ({ ok: false as const, cause: String((e as Error)?.message ?? e).slice(0, 200) })),
    new Promise<{ ok: false; cause: string }>((resolve) => {
      const t = setTimeout(() => { expire = true; resolve({ ok: false, cause: `délai de ${LOOKUP_TIMEOUT_MS} ms dépassé` }); }, LOOKUP_TIMEOUT_MS);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** Le magasin (réel, ou simulé par un test) sait-il réserver une qualification ? Un double partiel antérieur à #838 : non. */
function qualificationSupported(): boolean {
  return storeOverride === null || typeof storeOverride.claimQualification === 'function';
}

/**
 * Le magasin fournit-il cette fonction ? Magasin réel : oui. Double de test : seulement s'il la définit
 * (`onlyOverride` : la définit LUI-MÊME) — un double partiel ne déclenche jamais d'écriture réelle.
 */
function provides(name: keyof typeof import('./store'), onlyOverride = false): boolean {
  if (storeOverride === null) return !onlyOverride;
  return typeof storeOverride[name] === 'function';
}

/** Écriture lancée sans attente, suivie (tests : `__flushSchemaCompatWritesForTests`). */
function track(p: Promise<void>): void {
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/**
 * Recharge la mémoire partagée si elle est périmée (une lecture à la fois par instance). Ne lève jamais.
 * Carte #863 (A2) : une lecture en ÉCHEC ne rajeunit JAMAIS le cache (`shared.at` reste l'instant de la
 * dernière lecture réussie) ; la relecture est bornée par `sharedHealth.failedAt`.
 */
async function refreshShared(now: number): Promise<void> {
  if (!dbAllowed()) return;
  if (shared && sharedHealth.ok && now - shared.at < SHARED_TTL_MS) return;
  if (sharedAbsent && sharedHealth.ok && sharedHealth.failedAt !== null && now - sharedHealth.failedAt < SHARED_TTL_MS) return;
  // Carte #838 (A2) : pendant une panne, UNE relecture par période et par instance (pas de tempête).
  if (!sharedHealth.ok && sharedHealth.failedAt !== null && now - sharedHealth.failedAt < SHARED_TTL_MS) return;
  if (!sharedLoading) {
    sharedLoading = (async () => {
      try {
        const S = await store();
        decisionStats.sharedReads++;
        const lu = await attempt(() => S.loadKnownCouples());
        // Illisible ou lente : dernier état connu conservé (un refus mémorisé n'est jamais levé par défaut de
        // lecture) — et la panne est MARQUÉE : une absence ne vaut plus « jamais testé » (carte #838, A2).
        if (!lu.ok) {
          sharedHealth = { ok: false, cause: lu.cause, failedAt: now };
          return;
        }
        const page = lu.value;
        // Table absente (migration 1710 non appliquée) : mémoire locale seule, comme avant le lot 114.
        if (page === null) { sharedAbsent = true; sharedHealth = { ok: true, cause: null, failedAt: now }; return; }
        sharedAbsent = false;
        sharedHealth = { ok: true, cause: null, failedAt: null };
        shared = {
          at: now, truncated: page.truncated,
          byKey: new Map<string, SchemaCoupleState>(page.rows.map((r): [string, SchemaCoupleState] => [r.keyId, r])),
        };
        // Un couple que la base ne tient plus pour refusé (accepté ailleurs) n'est plus refusé ici. Jamais
        // lorsque le cache est TRONQUÉ : une absence ne voudrait alors rien dire (lot 115, #784, B1).
        if (!page.truncated) {
          for (const [k, s] of local) {
            if ((s.state === 'REJECTED_CONFIRMED' || s.state === 'NEEDS_RECHECK') && !shared.byKey.has(k) && (s.lastRejectedAt ?? 0) < now - SHARED_TTL_MS) local.delete(k);
          }
        }
        // Carte #863 (A1, A2) : la base fait foi — un état local plus ancien que la lecture est remplacé.
        for (const [k, s] of shared.byKey) {
          const l = local.get(k);
          if (l && (localAt.get(k) ?? 0) <= now) { local.set(k, s); localAt.set(k, now); }
        }
      } finally { sharedLoading = null; }
    })();
  }
  await sharedLoading;
}

/** État connu d'un couple : la mémoire partagée fait foi, la locale complète (écriture non encore relue). */
function known(keyId: string): SchemaCoupleState | null {
  const s = shared?.byKey.get(keyId) ?? null;
  const l = local.get(keyId) ?? null;
  if (!s) return l;
  if (!l) return s;
  return lastEventOf(l) > lastEventOf(s) ? l : s;
}

/** Dernier constat (refus ou acceptation) porté par un état. */
function lastEventOf(s: SchemaCoupleState): number {
  return Math.max(s.lastRejectedAt ?? 0, s.lastAcceptedAt ?? 0);
}

/** Carte #863 (A2) : instant de la dernière preuve DURABLE d'un état (lecture réussie, écriture confirmée). */
function lastProofOf(keyId: string): number {
  return Math.max(shared?.byKey.has(keyId) ? shared.at : 0, localAt.get(keyId) ?? 0);
}

/** Mise à jour des mémoires de ce processus avec un état PROUVÉ (lu ou écrit en base). */
function remember(keyId: string, s: SchemaCoupleState, now: number): void {
  local.set(keyId, s);
  localAt.set(keyId, now);
  bound(local, LOCAL_MAX);
  bound(localAt, LOCAL_MAX);
  shared?.byKey.set(keyId, s);
  misses.delete(keyId);
}

/**
 * Lot 115 (carte #784, §B1) — ÉTAT RÉEL d'un couple pour la DÉCISION.
 *
 * Le cache partagé est borné : un couple actif mais ancien peut en être
 * absent. Une absence ne vaut donc pas « jamais testé » : quand le cache est
 * tronqué (ou n'a jamais été lisible), le couple est lu PAR SA CLÉ avant de
 * décider. Le résultat alimente les mémoires de ce processus ; une absence
 * confirmée est retenue brièvement (`MISS_TTL_MS`) pour ne pas relire la base
 * à chaque appel d'un couple réellement nouveau. Ne lève jamais.
 */
type Resolved = { state: SchemaCoupleState | null; unreadable: null } | { state: null; unreadable: { cause: SchemaMemoryDegradedCause; detail: string | null } };

/**
 * Carte #838 (A2) — « couple réellement inconnu » ≠ « lecture impossible ».
 * Carte #863 (A2) — cinq situations DISTINCTES :
 *   · lecture FRAÎCHE (cache sain et à jour, ou lecture par clé réussie) :
 *     l'état (ou l'absence vérifiée) décide ;
 *   · cache ANCIEN (dernière lecture en échec) : un REFUS connu reste
 *     opposable ; une QUALIFICATION n'est retenue que dans la tolérance bornée
 *     (`QUALIFIED_STALE_TOLERANCE_MS`) depuis sa dernière preuve — au-delà,
 *     `stale_cache` (JSON sans schéma) : B a pu refuser le schéma depuis ;
 *   · panne / délai sans état connu : `shared_unreadable` / `couple_unreadable` ;
 *   · migration manquante : traitée par l'appelant (`migration_not_ready`).
 */
async function resolveCouple(keyId: string, now: number): Promise<Resolved> {
  const connu = known(keyId);
  if (!dbAllowed() || sharedAbsent) return { state: connu, unreadable: null };
  if (connu) {
    if (sharedHealth.ok) return { state: connu, unreadable: null };
    if (connu.state === 'REJECTED_CONFIRMED' || connu.state === 'NEEDS_RECHECK') return { state: connu, unreadable: null };
    if (connu.state === 'QUALIFIED' && now - lastProofOf(keyId) <= SHARED_TTL_MS + QUALIFIED_STALE_TOLERANCE_MS) return { state: connu, unreadable: null };
    return { state: null, unreadable: { cause: 'stale_cache', detail: sharedHealth.cause } };
  }
  if (!sharedHealth.ok) return { state: null, unreadable: { cause: 'shared_unreadable', detail: sharedHealth.cause } };
  // Cache complet et à jour : l'absence est une information (le couple n'est ni refusé ni qualifié).
  if (shared && !shared.truncated) return { state: null, unreadable: null };
  const vu = misses.get(keyId);
  if (vu !== undefined && now - vu < MISS_TTL_MS) return { state: null, unreadable: null };
  // Carte #863 (A2) : lecture par clé en échec récent → pas de nouvelle tentative (aucun retry en cascade).
  const echec = coupleReadFailures.get(keyId);
  if (echec !== undefined && now - echec < SHARED_TTL_MS) return { state: null, unreadable: { cause: 'couple_unreadable', detail: 'lecture par clé en échec récent' } };
  const S = await store();
  decisionStats.coupleReads++;
  const lu = await attempt(() => S.getCouple(keyId));
  if (!lu.ok) {
    coupleReadFailures.set(keyId, now);
    bound(coupleReadFailures, LOCAL_MAX);
    return { state: null, unreadable: { cause: 'couple_unreadable', detail: lu.cause } };
  }
  coupleReadFailures.delete(keyId);
  const row = lu.value;
  if (!row) {
    misses.set(keyId, now);
    bound(misses, LOCAL_MAX);
    return { state: null, unreadable: null };
  }
  remember(keyId, row, now);
  return { state: row, unreadable: null };
}

/** Compte une décision par motif (supervision). */
function noteWhy(why: string): void {
  decisionStats.byWhy[why] = (decisionStats.byWhy[why] ?? 0) + 1;
}

/**
 * Carte #863 (A1) — durée de bail pour un essai dont l'appel dure au plus
 * `callBudgetMs` (requête avec schéma + éventuel nouvel essai) : bornée par
 * le bail de la politique au minimum, plus une marge pour écrire l'issue.
 */
export function qualificationLeaseFor(callBudgetMs: number | null | undefined): number {
  const budget = Math.max(0, Math.floor(callBudgetMs ?? 0));
  return Math.max(SCHEMA_COMPAT_POLICY.qualificationLeaseMs, budget + 60_000);
}

/**
 * Carte #863 (A1) — le bail de cet essai est-il ENCORE valide pour un envoi
 * qui peut durer `budgetMs` ? À vérifier juste avant l'envoi : un bail échu
 * (décision lente, horloge) ne doit jamais laisser partir un schéma non
 * qualifié en parallèle du nouveau détenteur.
 */
export function qualificationStillValid(d: Pick<SchemaDecision, 'fence' | 'qualification'> | null | undefined, budgetMs: number, now: number = Date.now()): boolean {
  const until = d?.fence?.until ?? d?.qualification?.until ?? null;
  if (until === null || until === undefined) return true;
  return until - now > Math.max(0, budgetMs);
}

/**
 * Faut-il transmettre le schéma à ce couple ? Lit la mémoire (partagée si
 * accessible) ; un réexamen dû est RÉSERVÉ avant d'être tenté (en base :
 * atomique entre instances). Ne lève jamais.
 *
 * Carte #838 :
 *   · A1/A3 — le PREMIER essai d'un couple jamais testé, et la
 *     requalification d'une qualification échue, sont eux aussi RÉSERVÉS
 *     (bail partagé `claimQualification`, à l'échelle de la clé exacte) : une
 *     seule instance envoie le schéma non qualifié ; les autres partent tout de
 *     suite en JSON sans schéma fournisseur (`qualification_in_progress`),
 *     validation Zod locale inchangée, sans attendre ;
 *   · A2 — mémoire partagée illisible et statut non prouvable : dégradation
 *     CONSERVATRICE (`memory_unavailable`, JSON sans schéma), journalisée avec
 *     sa cause ; jamais `send: true` par défaut d'une lecture en échec.
 * Carte #863 :
 *   · A1 — la décision porte le FENCING de son issue (jeton du bail ou du
 *     réexamen, génération de l'état) ; bail dimensionné sur le délai TOTAL
 *     de l'appel (`opts.callBudgetMs`) ; réservation arrivée après le délai
 *     SQL : rendue aussitôt ;
 *   · A2 — migration du bail absente, réservation de réexamen impossible,
 *     erreur imprévue : JSON sans schéma (plus aucun essai non réservé, plus
 *     aucune exception pour un QUALIFIED local en cas d'erreur) ;
 *   · A3 — requalification REPORTÉE : JSON sans schéma jusqu'à l'échéance.
 */
export async function decideSchemaUse(
  key: SchemaCoupleKey, now: number = Date.now(), opts: { callBudgetMs?: number | null } = {},
): Promise<SchemaDecision> {
  const keyId = coupleKeyId(key);
  const base = { keyId, key, policyVersion: SCHEMA_COMPAT_POLICY.version };
  const degrade = (cause: SchemaMemoryDegradedCause, detail: string | null, state: SchemaCompatState): SchemaDecision => {
    noteDegraded(cause, detail, now);
    noteWhy(cause === 'migration_not_ready' ? 'migration_not_ready' : 'memory_unavailable');
    return { ...base, send: false, retest: false, state, why: 'memory_unavailable', degraded: { cause } };
  };
  const sans = (why: string, state: SchemaCompatState, extra: Partial<SchemaDecision> = {}): SchemaDecision => {
    noteWhy(why);
    return { ...base, send: false, retest: false, state, why, ...extra };
  };
  try {
    await refreshShared(now);
    const r = await resolveCouple(keyId, now);
    if (r.unreadable) return degrade(r.unreadable.cause, r.unreadable.detail, 'NOT_TESTED');
    const s = r.state;
    const use = schemaUseOf(s, now);
    const state: SchemaCompatState = s?.state ?? 'NOT_TESTED';
    const servedModelVersion = s?.servedModelVersion ?? null;
    const generation = s?.generation ?? null;
    if (!use.send) return sans(use.why === 'recent_rejection' ? 'recent_rejection' : use.why, state, { servedModelVersion });
    if (!use.retest) {
      // Carte #838 (A1, A3) : essai de qualification dû → bail partagé avant tout envoi du schéma.
      const due = qualificationDueOf(s, now);
      if (due && dbAllowed() && qualificationSupported()) {
        // Carte #863 (A2) : sans mémoire partagée (1710 absente), aucun essai non réservé n'est possible.
        if (sharedAbsent) return degrade('migration_not_ready', 'mémoire partagée absente (migration 1710)', state);
        const mien = localClaims.get(keyId);
        if (mien && mien.until > now) return sans('qualification_in_progress', state, { servedModelVersion });
        const S = await store();
        const leaseMs = qualificationLeaseFor(opts.callBudgetMs);
        // Carte #863 (A1) : réservation aboutie APRÈS le délai SQL — rendue aussitôt (aucun bail orphelin).
        const bail = await attempt(() => S.claimQualification(key, due, now, { leaseMs }), (tard) => {
          if (tard.status !== 'claimed') return;
          decisionStats.lateClaimsReleased++;
          track((async () => { try { await (await store()).releaseQualification(keyId, tard.token, Date.now(), false); } catch { /* bail échu de lui-même */ } })());
        });
        if (!bail.ok) return degrade('claim_failed', bail.cause, state);
        if (bail.value.status === 'claimed') {
          localClaims.set(keyId, { token: bail.value.token, until: bail.value.until });
          bound(localClaims, LOCAL_MAX);
          noteWhy(due === 'FIRST' ? 'first_qualification' : 'requalification_due');
          return {
            ...base, send: true, retest: false, state, why: due === 'FIRST' ? 'first_qualification' : 'requalification_due', servedModelVersion,
            qualification: { kind: due, token: bail.value.token, until: bail.value.until },
            fence: { token: bail.value.token, generation, until: bail.value.until },
          };
        }
        if (bail.value.status === 'busy') {
          // Une autre instance tient le bail (ou l'essai n'est plus dû : décision rejouée à la prochaine relecture).
          return sans('qualification_in_progress', state, { servedModelVersion });
        }
        // Carte #863 (A2) : `unsupported` (migration 1980 absente) — plus de retour à l'essai non réservé.
        return degrade('migration_not_ready', 'colonnes du bail de qualification absentes (migration 1980)', state);
      }
      noteWhy(use.why);
      return { ...base, send: true, retest: false, state, why: use.why, servedModelVersion, fence: dbAllowed() ? { token: null, generation, until: null } : null };
    }
    // Réexamen dû : réservation locale d'abord (requêtes concurrentes du même processus)…
    const claimed = claimRetestOf(s!, now);
    if (!claimed) return sans('retest_in_progress', state);
    // … puis en base, entre instances (carte #863 : avec un JETON, pour fencer son issue).
    if (dbAllowed() && !sharedAbsent) {
      const S = await store();
      const jeton = (await import('crypto')).randomUUID();
      const lu = await attempt(() => S.claimRetest(keyId, now, jeton), (tard) => {
        // Réservation aboutie après le délai : rendue comme un réexamen sans conclusion (court report, aucune rafale).
        if (!tard) return;
        decisionStats.lateClaimsReleased++;
        track((async () => { try { await (await store()).releaseRetest(keyId, Date.now(), jeton); } catch { /* bail échu de lui-même */ } })());
      });
      if (!lu.ok) return degrade('retest_claim_failed', lu.cause, state);
      const row = lu.value;
      if (!row) {
        // Non réservé (autre instance) : pas d'essai ici, et pas de nouvelle demande avant la prochaine relecture.
        const attente = { ...s!, retestClaimedUntil: now + SHARED_TTL_MS };
        local.set(keyId, attente);
        shared?.byKey.set(keyId, attente);
        return sans('retest_not_claimed', state);
      }
      local.set(keyId, row);
      shared?.byKey.set(keyId, row);
      const until = row.retestClaimedUntil ?? now + SCHEMA_COMPAT_POLICY.retestLeaseMs;
      noteWhy('retest_due');
      return { ...base, send: true, retest: true, state, why: 'retest_due', servedModelVersion, fence: { token: jeton, generation: row.generation ?? null, until } };
    }
    local.set(keyId, claimed);
    noteWhy('retest_due');
    return { ...base, send: true, retest: true, state, why: 'retest_due', servedModelVersion };
  } catch (e) {
    // Carte #863 (A2) : erreur imprévue — JSON sans schéma, quelle que soit la mémoire locale (aucune exception
    // « QUALIFIED connu localement » : la qualification n'est pas prouvable à cet instant).
    const l = local.get(keyId) ?? null;
    return degrade('decision_failed', String((e as Error)?.message ?? e), l?.state ?? 'NOT_TESTED');
  }
}

function isLocallyRejected(keyId: string, now: number): boolean {
  const use = schemaUseOf(known(keyId), now);
  return !use.send || use.retest;
}

/**
 * Lecture SANS réservation (passe de réparation, lot 33D) : le schéma est-il
 * tenu pour refusé par ce couple ? Un réexamen dû n'est jamais tenté ici.
 */
export function schemaHeldRejected(key: SchemaCoupleKey, now: number = Date.now()): boolean {
  return isLocallyRejected(coupleKeyId(key), now);
}

/**
 * Nom historique (lot 33D / 52B) — un refus est-il mémorisé pour ce modèle
 * et ce contrat (empreinte canonique), quelle que soit l'opération ?
 */
export function schemaRejectedRecently(model: string, schemaHash: string, now: number = Date.now()): boolean {
  for (const m of [local, shared?.byKey ?? new Map<string, SchemaCoupleState>()]) {
    for (const s of m.values()) {
      if (s.key.model !== model || s.key.schemaHash !== schemaHash) continue;
      if (isLocallyRejected(s.keyId, now)) return true;
    }
  }
  return false;
}

export interface SchemaOutcomeEvidence { httpStatus?: number | null; providerCode?: string | null; appVersion?: string | null }

/** Suites d'une transition (alertes) — branchées par `alerts.ts`, sans dépendance directe (ne lève jamais). */
type TransitionHook = (t: { key: SchemaCoupleKey; keyId: string; to: 'REJECTED_CONFIRMED' | 'QUALIFIED'; from: SchemaCompatState | null; state: SchemaCoupleState }) => Promise<void>;
let transitionHook: TransitionHook | null = null;
export function __setSchemaCompatTransitionHookForTests(h: TransitionHook | null): void { transitionHook = h; }

async function onTransition(t: Parameters<TransitionHook>[0]): Promise<void> {
  try {
    if (transitionHook) return await transitionHook(t);
    const A = await import('./alerts');
    if (t.to === 'REJECTED_CONFIRMED') await A.raiseSchemaIncompatibilityAlert(t.state);
    else await A.resolveSchemaIncompatibilityAlert(t.keyId, 'SCHEMA_ACCEPTED_AGAIN');
  } catch (e) {
    // Non bloquant : une alerte non écrite est reprise par la réévaluation suivante (carte #863, D1).
    console.warn('[schema-compat] alerte non mise à jour (reprise par la réévaluation) :', String((e as Error)?.message ?? e).slice(0, 200));
  }
}

const pending = new Set<Promise<void>>();
/** Réservé aux tests : attend les écritures lancées sans attente. */
export async function __flushSchemaCompatWritesForTests(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Carte #863 (A1) — reprise BORNÉE d'une écriture (panne passagère) ; lève la dernière erreur. */
async function withWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  let derniere: unknown = null;
  for (let i = 0; i <= WRITE_RETRY_DELAYS_MS.length; i++) {
    try { return await run(); } catch (e) {
      derniere = e;
      if (i < WRITE_RETRY_DELAYS_MS.length) await new Promise((r) => setTimeout(r, WRITE_RETRY_DELAYS_MS[i]));
    }
  }
  throw derniere;
}

/**
 * Issue d'un appel qui PORTAIT le schéma. Écriture partagée lancée SANS
 * attente (ne retarde ni ne fait échouer l'appel). Une acceptation n'est
 * réécrite en base qu'au changement d'état ou une fois par heure et par
 * couple (compteur indicatif : les taux exacts viennent des traces d'appels,
 * `supervision.ts`).
 *
 * Carte #863 (A1) — mémoire partagée accessible :
 *   · l'issue est FENCÉE (jeton du bail ou génération, `d.fence`) : un ancien
 *     détenteur, ou un constat tardif, ne modifie ni l'état, ni le cache, ni
 *     les alertes — l'observation est seulement journalisée ;
 *   · une QUALIFICATION n'est publiée dans le cache de ce processus qu'APRÈS
 *     sa confirmation durable (un refus est retenu localement tout de suite :
 *     c'est la mesure conservatrice, remplacée par l'état écrit) ;
 *   · écriture en échec : reprise bornée ; bail NON rendu (il expire de
 *     lui-même — aucune rafale d'essais déclenchée par une libération
 *     prématurée) ; le bail n'est rendu qu'APRÈS l'écriture de l'issue.
 */
export function reportSchemaOutcome(
  d: Pick<SchemaDecision, 'key' | 'keyId' | 'retest'> & Partial<Pick<SchemaDecision, 'qualification' | 'fence'>>,
  o: SchemaOutcome, ev: SchemaOutcomeEvidence = {}, now: number = Date.now(),
): void {
  const prev = known(d.keyId);
  const bail = d.qualification ?? null;
  const fence = d.fence ?? (bail ? { token: bail.token, generation: null, until: bail.until ?? null } : null);
  const jeton = fence?.token ?? null;
  const kind = bail?.kind ?? (d.retest ? 'RETEST' : null);
  const next = applySchemaOutcome(prev, d.key, o, now, { qualification: bail?.kind ?? null });
  if (!dbAllowed()) {
    // Mémoire locale seule (tests unitaires) : comportement antérieur, effet immédiat.
    if (bail && localClaims.get(d.keyId)?.token === bail.token) localClaims.delete(d.keyId);
    if (o.kind === 'INCONCLUSIVE' && !d.retest && !bail) return;
    local.set(d.keyId, next);
    bound(local, LOCAL_MAX);
    misses.delete(d.keyId);
    return;
  }
  // Issue sans conclusion d'un appel ordinaire : rien à écrire.
  if (o.kind === 'INCONCLUSIVE' && !d.retest && !bail) return;
  // Refus : mesure conservatrice IMMÉDIATE dans ce processus (aucun nouvel envoi du schéma refusé avant l'écriture).
  if (o.kind === 'REJECTED') { local.set(d.keyId, next); bound(local, LOCAL_MAX); misses.delete(d.keyId); }
  // Une acceptation ordinaire (couple déjà qualifié, sans bail) n'est réécrite qu'une fois par heure ; une
  // requalification acceptée est TOUJOURS écrite (elle renouvelle la fenêtre de validité, A3).
  if (o.kind === 'ACCEPTED' && prev?.state === 'QUALIFIED' && !jeton) {
    const last = notedOnce.get(d.keyId) ?? 0;
    if (now - last < 3_600_000) return;
  }
  if (o.kind === 'ACCEPTED') notedOnce.set(d.keyId, now);
  const fenceStore = fence ? { token: jeton, generation: fence.generation ?? null, qualificationKind: kind } : null;
  track((async () => {
    let ecrit = false;
    try {
      const S = await store();
      const appVersion = ev.appVersion ?? null;
      if (o.kind === 'INCONCLUSIVE') {
        if (bail && jeton && qualificationSupported()) {
          // Essai de qualification sans conclusion : rien n'est déduit ; bail rendu — une requalification est
          // REPORTÉE et le cache SYNCHRONISÉ avec le report écrit (carte #863, A3).
          const r = await withWriteRetry(() => (provides('releaseQualificationState') || !provides('releaseQualification', true)
            ? S.releaseQualificationState(d.keyId, jeton, now, true)
            : S.releaseQualification(d.keyId, jeton, now, true).then((released) => ({ released, state: null }))));
          if (r.state) remember(d.keyId, r.state, now);
          else if (r.released && bail.kind === 'REQUALIFY' && prev) remember(d.keyId, next, now);
          ecrit = true;
        } else if (d.retest) {
          const released = await withWriteRetry(() => S.releaseRetest(d.keyId, now, jeton));
          if (released) remember(d.keyId, next, now);
          ecrit = true;
        }
        if (provides('recordObservation')) {
          await S.recordObservation({ keyId: d.keyId, outcome: 'INCONCLUSIVE', qualificationKind: kind, opposable: true, generation: fence?.generation ?? null, appVersion, now }).catch(() => false);
        }
        return;
      }
      if (o.kind === 'ACCEPTED') {
        const r = await withWriteRetry(() => S.recordAcceptance(d.key, appVersion, now, o.servedModelVersion ?? null, fenceStore));
        ecrit = true;
        if (!r) return;
        if (r.applied === false) {
          decisionStats.writesFenced++;
          if (r.state) remember(d.keyId, r.state, now);
          return;
        }
        decisionStats.writesApplied++;
        remember(d.keyId, r.state, now);
        if (r.previous === 'REJECTED_CONFIRMED' || r.previous === 'NEEDS_RECHECK') {
          await onTransition({ key: d.key, keyId: d.keyId, to: 'QUALIFIED', from: r.previous, state: r.state });
        }
      } else {
        const r = await withWriteRetry(() => S.recordRejection(d.key, {
          reason: o.reason, httpStatus: ev.httpStatus ?? null, providerCode: ev.providerCode ?? null, appVersion,
          servedModelVersion: o.servedModelVersion ?? null,
        }, now, fenceStore));
        ecrit = true;
        if (!r) return;
        if (r.applied === false) {
          // Constat NON opposable : l'état courant (écrit par une autre instance) fait foi, rien d'autre ne change.
          decisionStats.writesFenced++;
          if (r.state) remember(d.keyId, r.state, now); else local.delete(d.keyId);
          return;
        }
        decisionStats.writesApplied++;
        remember(d.keyId, r.state, now);
        if (r.transition) await onTransition({ key: d.key, keyId: d.keyId, to: 'REJECTED_CONFIRMED', from: prev?.state ?? null, state: r.state });
      }
    } catch (e) {
      decisionStats.writesFailed++;
      console.warn('[schema-compat] mémoire partagée non écrite après reprise (bail conservé jusqu\'à son échéance) :', String((e as Error)?.message ?? e).slice(0, 200));
    } finally {
      // Carte #838 (A1) : bail rendu APRÈS l'écriture de l'issue — les autres instances lisent l'état, pas un trou.
      // Carte #863 (A1) : JAMAIS après un échec d'écriture (libération prématurée → rafale d'essais).
      if (ecrit && jeton && o.kind !== 'INCONCLUSIVE' && qualificationSupported()) {
        try { await (await store()).releaseQualification(d.keyId, jeton, now, false); } catch { /* bail échu de lui-même */ }
      }
      if (bail && localClaims.get(d.keyId)?.token === bail.token) localClaims.delete(d.keyId);
    }
  })());
}

/**
 * Lot 115 (carte #784, §A3) — VERSION DE MODÈLE RÉELLEMENT SERVIE, relevée
 * après la réponse du fournisseur (que le schéma ait été transmis ou non : un
 * appel en mode JSON renseigne la version tout autant).
 *
 *   · version absente → incertitude MARQUÉE, rien n'est déduit ni inventé ;
 *   · version différente de celle du refus mémorisé → ce refus a été constaté
 *     sur une autre version servie : le prochain essai avec schéma devient dû
 *     (UN seul, réservé — aucune rafale, aucune cascade vers d'autres
 *     modèles). L'état reste « refusé » : rien n'est déclaré compatible.
 *
 * Écriture lancée SANS attente, jamais bloquante pour l'appel. Un couple
 * inconnu n'est pas créé.
 */
export function reportServedModelVersion(key: SchemaCoupleKey, servedModelVersion: string | null, now: number = Date.now()): void {
  const keyId = coupleKeyId(key);
  const prev = known(keyId);
  if (!prev) return;
  const next = applyServedVersion(prev, servedModelVersion, now);
  if (!next) return;
  local.set(keyId, next);
  bound(local, LOCAL_MAX);
  shared?.byKey.set(keyId, next);
  if (!dbAllowed()) return;
  const p: Promise<void> = (async () => {
    try {
      const row = await (await store()).noteServedModelVersion(keyId, servedModelVersion, now);
      if (row) { local.set(keyId, row); shared?.byKey.set(keyId, row); }
    } catch (e) {
      console.warn('[schema-compat] version servie non mémorisée (non bloquant) :', String((e as Error)?.message ?? e).slice(0, 200));
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/**
 * Schéma non transmissible (contrôle statique) : tracé UNE fois par couple et
 * par processus dans la matrice (`UNSUPPORTED_BY_CONTRACT`). Sans attente.
 */
export function noteSchemaUnsupported(key: SchemaCoupleKey, staticReason: string, appVersion: string | null = null, now: number = Date.now()): void {
  const keyId = coupleKeyId(key);
  if (!dbAllowed() || notedOnce.has(`u:${keyId}`)) return;
  notedOnce.set(`u:${keyId}`, now);
  const p: Promise<void> = (async () => {
    try { await (await store()).recordUnsupported(key, staticReason, appVersion, now); } catch { /* matrice non renseignée : non bloquant */ }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}
