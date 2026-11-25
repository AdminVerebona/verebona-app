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
  /** `not_tested`, `qualified`, `retest_due`, `recent_rejection`, `retest_in_progress`, `retest_not_claimed`. */
  why: string;
  policyVersion: number;
  /** Lot 115 (#784, A3) : dernière version de modèle SERVIE connue pour ce couple ; `null` : jamais observée. */
  servedModelVersion?: string | null;
  /**
   * Carte #838 (A1, A3) : cet appel est l'essai de qualification RÉSERVÉ du
   * couple (bail partagé). Son issue rend le bail (`reportSchemaOutcome`).
   */
  qualification?: { kind: 'FIRST' | 'REQUALIFY'; token: string } | null;
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
 */
export type SchemaMemoryDegradedCause = 'shared_unreadable' | 'couple_unreadable' | 'claim_failed' | 'decision_failed';

// ── Mémoire locale (premier niveau) ─────────────────────────────────────────

const local = new Map<string, SchemaCoupleState>();
let shared: { at: number; byKey: Map<string, SchemaCoupleState>; truncated: boolean } | null = null;
let sharedLoading: Promise<void> | null = null;
const notedOnce = new Map<string, number>();
/** Couples lus par clé et ABSENTS de la base (bornée dans le temps et en taille). */
const misses = new Map<string, number>();
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
  shared = null;
  sharedLoading = null;
  notedOnce.clear();
  misses.clear();
  localClaims.clear();
  sharedHealth = { ok: true, cause: null, failedAt: null };
  sharedAbsent = false;
  degradedStats.decisions = 0; degradedStats.byCause = {}; degradedStats.lastCause = null; degradedStats.lastAt = null; degradedStats.lastLoggedAt = 0;
}

/**
 * Carte #838 (A2) — état du mode dégradé de CE processus : décisions prises
 * sans schéma faute de mémoire lisible, par cause ; santé de la mémoire
 * partagée. Lecture seule (supervision, recette).
 */
export function schemaMemoryDegradedStats(): {
  decisions: number; byCause: Record<string, number>; lastCause: string | null; lastAt: number | null;
  sharedHealthy: boolean; sharedCause: string | null;
} {
  return {
    decisions: degradedStats.decisions, byCause: { ...degradedStats.byCause }, lastCause: degradedStats.lastCause, lastAt: degradedStats.lastAt,
    sharedHealthy: sharedHealth.ok, sharedCause: sharedHealth.cause,
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

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => { const t = setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS); (t as { unref?: () => void }).unref?.(); }),
  ]);
}

/**
 * Carte #838 (A2) — lecture BORNÉE qui DISTINGUE le résultat (même `null` :
 * « absent ») d'un échec (erreur, délai). `withTimeout` confondait les deux.
 */
async function attempt<T>(p: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; cause: string }> {
  return Promise.race([
    p().then((value) => ({ ok: true as const, value }), (e: unknown) => ({ ok: false as const, cause: String((e as Error)?.message ?? e).slice(0, 200) })),
    new Promise<{ ok: false; cause: string }>((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, cause: `délai de ${LOOKUP_TIMEOUT_MS} ms dépassé` }), LOOKUP_TIMEOUT_MS);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** Le magasin (réel, ou simulé par un test) sait-il réserver une qualification ? Un double partiel antérieur à #838 : non. */
function qualificationSupported(): boolean {
  return storeOverride === null || typeof storeOverride.claimQualification === 'function';
}

/** Recharge la mémoire partagée si elle est périmée (une lecture à la fois par instance). Ne lève jamais. */
async function refreshShared(now: number): Promise<void> {
  if (!dbAllowed()) return;
  if (shared && now - shared.at < SHARED_TTL_MS) return;
  // Carte #838 (A2) : pendant une panne, UNE relecture par période et par instance (pas de tempête).
  if (!sharedHealth.ok && sharedHealth.failedAt !== null && now - sharedHealth.failedAt < SHARED_TTL_MS) return;
  if (!sharedLoading) {
    sharedLoading = (async () => {
      try {
        const S = await store();
        const lu = await attempt(() => S.loadKnownCouples());
        // Illisible ou lente : dernier état connu conservé (un refus mémorisé n'est jamais levé par défaut de
        // lecture) — et la panne est MARQUÉE : une absence ne vaut plus « jamais testé » (carte #838, A2).
        if (!lu.ok) {
          sharedHealth = { ok: false, cause: lu.cause, failedAt: now };
          if (shared) shared.at = now;
          return;
        }
        const page = lu.value;
        // Table absente (migration 1710 non appliquée) : mémoire locale seule, comme avant le lot 114.
        if (page === null) { sharedAbsent = true; sharedHealth = { ok: true, cause: null, failedAt: null }; if (shared) shared.at = now; return; }
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
 * Un état connu (cache chaud, même périmé par une panne) décide ; une absence
 * ne décide que si la mémoire partagée a été LUE avec succès (cache complet et
 * sain, ou lecture par clé réussie). Sinon : `unreadable`, et l'appelant
 * dégrade (JSON sans schéma), jamais `send: true` par défaut.
 */
async function resolveCouple(keyId: string, now: number): Promise<Resolved> {
  const connu = known(keyId);
  if (connu) return { state: connu, unreadable: null };
  if (!dbAllowed() || sharedAbsent) return { state: null, unreadable: null };
  if (!sharedHealth.ok) return { state: null, unreadable: { cause: 'shared_unreadable', detail: sharedHealth.cause } };
  // Cache complet et à jour : l'absence est une information (le couple n'est ni refusé ni qualifié).
  if (shared && !shared.truncated) return { state: null, unreadable: null };
  const vu = misses.get(keyId);
  if (vu !== undefined && now - vu < MISS_TTL_MS) return { state: null, unreadable: null };
  const S = await store();
  const lu = await attempt(() => S.getCouple(keyId));
  if (!lu.ok) return { state: null, unreadable: { cause: 'couple_unreadable', detail: lu.cause } };
  const row = lu.value;
  if (!row) {
    misses.set(keyId, now);
    bound(misses, LOCAL_MAX);
    return { state: null, unreadable: null };
  }
  local.set(keyId, row);
  bound(local, LOCAL_MAX);
  shared?.byKey.set(keyId, row);
  return { state: row, unreadable: null };
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
 */
export async function decideSchemaUse(key: SchemaCoupleKey, now: number = Date.now()): Promise<SchemaDecision> {
  const keyId = coupleKeyId(key);
  const base = { keyId, key, policyVersion: SCHEMA_COMPAT_POLICY.version };
  const degrade = (cause: SchemaMemoryDegradedCause, detail: string | null, state: SchemaCompatState): SchemaDecision => {
    noteDegraded(cause, detail, now);
    return { ...base, send: false, retest: false, state, why: 'memory_unavailable', degraded: { cause } };
  };
  try {
    await refreshShared(now);
    const r = await resolveCouple(keyId, now);
    if (r.unreadable) return degrade(r.unreadable.cause, r.unreadable.detail, 'NOT_TESTED');
    const s = r.state;
    const use = schemaUseOf(s, now);
    const state: SchemaCompatState = s?.state ?? 'NOT_TESTED';
    const servedModelVersion = s?.servedModelVersion ?? null;
    if (!use.send) return { ...base, send: false, retest: false, state, why: use.why, servedModelVersion };
    if (!use.retest) {
      // Carte #838 (A1, A3) : essai de qualification dû → bail partagé avant tout envoi du schéma.
      const due = qualificationDueOf(s, now);
      if (due && dbAllowed() && !sharedAbsent && qualificationSupported()) {
        const mien = localClaims.get(keyId);
        if (mien && mien.until > now) return { ...base, send: false, retest: false, state, why: 'qualification_in_progress', servedModelVersion };
        const S = await store();
        const bail = await attempt(() => S.claimQualification(key, due, now));
        if (!bail.ok) return degrade('claim_failed', bail.cause, state);
        if (bail.value.status === 'claimed') {
          localClaims.set(keyId, { token: bail.value.token, until: bail.value.until });
          bound(localClaims, LOCAL_MAX);
          return {
            ...base, send: true, retest: false, state, why: due === 'FIRST' ? 'first_qualification' : 'requalification_due', servedModelVersion,
            qualification: { kind: due, token: bail.value.token },
          };
        }
        if (bail.value.status === 'busy') {
          // Une autre instance tient le bail (ou l'essai n'est plus dû : décision rejouée à la prochaine relecture).
          return { ...base, send: false, retest: false, state, why: 'qualification_in_progress', servedModelVersion };
        }
        // `unsupported` (migration 1980 absente, retour arrière) : comportement antérieur, sans bail.
      }
      return { ...base, send: use.send, retest: false, state, why: use.why, servedModelVersion };
    }
    // Réexamen dû : réservation locale d'abord (requêtes concurrentes du même processus)…
    const claimed = claimRetestOf(s!, now);
    if (!claimed) return { ...base, send: false, retest: false, state, why: 'retest_in_progress' };
    local.set(keyId, claimed);
    // … puis en base, entre instances.
    if (dbAllowed()) {
      const row = await withTimeout((await store()).claimRetest(keyId, now), null);
      if (!row) {
        // Non réservé (autre instance, base lente) : pas d'essai ici, et pas de nouvelle demande avant la prochaine relecture.
        if (shared !== null) {
          const attente = { ...s!, retestClaimedUntil: now + SHARED_TTL_MS };
          local.set(keyId, attente);
          shared.byKey.set(keyId, attente);
          return { ...base, send: false, retest: false, state, why: 'retest_not_claimed' };
        }
        // Mémoire partagée jamais lisible (migration absente) : la réservation locale suffit.
      } else {
        shared?.byKey.set(keyId, row);
      }
    }
    return { ...base, send: true, retest: true, state, why: 'retest_due', servedModelVersion };
  } catch (e) {
    // Carte #838 (A2) : erreur imprévue — seul un état QUALIFIÉ connu localement autorise encore le schéma.
    const l = local.get(keyId) ?? null;
    if (l?.state === 'QUALIFIED' && !isLocallyRejected(keyId, now)) {
      return { ...base, send: true, retest: false, state: 'QUALIFIED', why: 'memory_unavailable' };
    }
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
    console.warn('[schema-compat] alerte non mise à jour (non bloquant) :', String((e as Error)?.message ?? e).slice(0, 200));
  }
}

const pending = new Set<Promise<void>>();
/** Réservé aux tests : attend les écritures lancées sans attente. */
export async function __flushSchemaCompatWritesForTests(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * Issue d'un appel qui PORTAIT le schéma. Mémoire locale mise à jour
 * immédiatement ; écriture partagée lancée SANS attente (ne retarde ni ne
 * fait échouer l'appel). Une acceptation n'est réécrite en base qu'au
 * changement d'état ou une fois par heure et par couple (compteur indicatif :
 * les taux exacts viennent des traces d'appels, `supervision.ts`).
 */
export function reportSchemaOutcome(
  d: Pick<SchemaDecision, 'key' | 'keyId' | 'retest'> & Partial<Pick<SchemaDecision, 'qualification'>>,
  o: SchemaOutcome, ev: SchemaOutcomeEvidence = {}, now: number = Date.now(),
): void {
  const prev = known(d.keyId);
  const next = applySchemaOutcome(prev, d.key, o, now);
  const bail = d.qualification ?? null;
  // Carte #838 (A1) : l'issue d'un essai de qualification rend TOUJOURS le bail de ce processus.
  if (bail && localClaims.get(d.keyId)?.token === bail.token) localClaims.delete(d.keyId);
  if (o.kind === 'INCONCLUSIVE' && !d.retest) {
    // Essai de qualification sans conclusion : rien n'est déduit, le bail partagé est rendu (une
    // requalification est reportée, un premier essai redevient prenable — jamais à chaque requête).
    if (bail && dbAllowed()) releaseShared(d.keyId, bail.token, now, true);
    return;
  }
  local.set(d.keyId, next);
  bound(local, LOCAL_MAX);
  misses.delete(d.keyId);
  if (!dbAllowed()) return;
  // Une requalification acceptée est TOUJOURS écrite (elle renouvelle la fenêtre de validité, A3).
  if (o.kind === 'ACCEPTED' && prev?.state === 'QUALIFIED' && !bail) {
    const last = notedOnce.get(d.keyId) ?? 0;
    if (now - last < 3_600_000) return;
  }
  if (o.kind === 'ACCEPTED') notedOnce.set(d.keyId, now);
  const p: Promise<void> = (async () => {
    try {
      const S = await store();
      const appVersion = ev.appVersion ?? null;
      if (o.kind === 'ACCEPTED') {
        const r = await S.recordAcceptance(d.key, appVersion, now, o.servedModelVersion ?? null);
        if (!r) return;
        shared?.byKey.set(d.keyId, r.state);
        local.set(d.keyId, r.state);
        if (r.previous === 'REJECTED_CONFIRMED' || r.previous === 'NEEDS_RECHECK') {
          await onTransition({ key: d.key, keyId: d.keyId, to: 'QUALIFIED', from: r.previous, state: r.state });
        }
      } else if (o.kind === 'REJECTED') {
        const r = await S.recordRejection(d.key, {
          reason: o.reason, httpStatus: ev.httpStatus ?? null, providerCode: ev.providerCode ?? null, appVersion,
          servedModelVersion: o.servedModelVersion ?? null,
        }, now);
        if (!r) return;
        shared?.byKey.set(d.keyId, r.state);
        local.set(d.keyId, r.state);
        if (r.transition) await onTransition({ key: d.key, keyId: d.keyId, to: 'REJECTED_CONFIRMED', from: prev?.state ?? null, state: r.state });
      } else {
        await S.releaseRetest(d.keyId, now);
      }
    } catch (e) {
      console.warn('[schema-compat] mémoire partagée non écrite (non bloquant) :', String((e as Error)?.message ?? e).slice(0, 200));
    } finally {
      // Carte #838 (A1) : bail rendu APRÈS l'écriture de l'issue — les autres instances lisent l'état, pas un trou.
      if (bail && qualificationSupported()) {
        try { await (await store()).releaseQualification(d.keyId, bail.token, now, false); } catch { /* bail échu de lui-même */ }
      }
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Carte #838 (A1) : rend un bail de qualification sans attente (fencing par jeton). Ne lève jamais. */
function releaseShared(keyId: string, token: string, now: number, inconclusive: boolean): void {
  if (!qualificationSupported()) return;
  const p: Promise<void> = (async () => {
    try { await (await store()).releaseQualification(keyId, token, now, inconclusive); } catch { /* bail échu de lui-même (lease) */ }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
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
