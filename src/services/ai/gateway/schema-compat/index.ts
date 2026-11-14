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
  SCHEMA_COMPAT_POLICY, applySchemaOutcome, claimRetestOf, coupleKeyId, schemaUseOf,
  type SchemaCompatState, type SchemaCoupleKey, type SchemaCoupleState, type SchemaOutcome,
} from './policy';

export * from './policy';

/** Relecture de la mémoire partagée (délai maximal de propagation d'un refus entre instances). */
export const SHARED_TTL_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 2_000;

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
}

// ── Mémoire locale (premier niveau) ─────────────────────────────────────────

const local = new Map<string, SchemaCoupleState>();
let shared: { at: number; byKey: Map<string, SchemaCoupleState> } | null = null;
let sharedLoading: Promise<void> | null = null;
const notedOnce = new Map<string, number>();
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

/** Réservé aux tests : magasin simulé (`null` : magasin réel). */
export function __setSchemaCompatStoreForTests(s: Partial<typeof import('./store')> | null): void {
  storeOverride = s;
  __resetSchemaCompatProcessForTests();
}

/** Réservé aux tests : simule un REDÉMARRAGE du processus (mémoire locale et cache vidés, base intacte). */
export function __resetSchemaCompatProcessForTests(): void {
  local.clear();
  shared = null;
  sharedLoading = null;
  notedOnce.clear();
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

/** Recharge la mémoire partagée si elle est périmée (une lecture à la fois par instance). Ne lève jamais. */
async function refreshShared(now: number): Promise<void> {
  if (!dbAllowed()) return;
  if (shared && now - shared.at < SHARED_TTL_MS) return;
  if (!sharedLoading) {
    sharedLoading = (async () => {
      try {
        const rows = await withTimeout((await store()).loadKnownCouples(), null);
        // Illisible ou lente : dernier état connu conservé (un refus mémorisé n'est jamais levé par défaut de lecture).
        if (rows === null) { if (shared) shared.at = now; return; }
        shared = { at: now, byKey: new Map<string, SchemaCoupleState>(rows.map((r): [string, SchemaCoupleState] => [r.keyId, r])) };
        // Un couple que la base ne tient plus pour refusé (accepté ailleurs) n'est plus refusé ici.
        for (const [k, s] of local) {
          if ((s.state === 'REJECTED_CONFIRMED' || s.state === 'NEEDS_RECHECK') && !shared.byKey.has(k) && (s.lastRejectedAt ?? 0) < now - SHARED_TTL_MS) local.delete(k);
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
 * Faut-il transmettre le schéma à ce couple ? Lit la mémoire (partagée si
 * accessible) ; un réexamen dû est RÉSERVÉ avant d'être tenté (en base :
 * atomique entre instances). Ne lève jamais.
 */
export async function decideSchemaUse(key: SchemaCoupleKey, now: number = Date.now()): Promise<SchemaDecision> {
  const keyId = coupleKeyId(key);
  const base = { keyId, key, policyVersion: SCHEMA_COMPAT_POLICY.version };
  try {
    await refreshShared(now);
    const s = known(keyId);
    const use = schemaUseOf(s, now);
    const state: SchemaCompatState = s?.state ?? 'NOT_TESTED';
    if (!use.retest) return { ...base, send: use.send, retest: false, state, why: use.why };
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
    return { ...base, send: true, retest: true, state, why: 'retest_due' };
  } catch {
    return { ...base, send: !isLocallyRejected(keyId, now), retest: false, state: local.get(keyId)?.state ?? 'NOT_TESTED', why: 'memory_unavailable' };
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
export function reportSchemaOutcome(d: Pick<SchemaDecision, 'key' | 'keyId' | 'retest'>, o: SchemaOutcome, ev: SchemaOutcomeEvidence = {}, now: number = Date.now()): void {
  const prev = known(d.keyId);
  const next = applySchemaOutcome(prev, d.key, o, now);
  if (o.kind === 'INCONCLUSIVE' && !d.retest) return;
  local.set(d.keyId, next);
  if (!dbAllowed()) return;
  if (o.kind === 'ACCEPTED' && prev?.state === 'QUALIFIED') {
    const last = notedOnce.get(d.keyId) ?? 0;
    if (now - last < 3_600_000) return;
  }
  if (o.kind === 'ACCEPTED') notedOnce.set(d.keyId, now);
  const p: Promise<void> = (async () => {
    try {
      const S = await store();
      const appVersion = ev.appVersion ?? null;
      if (o.kind === 'ACCEPTED') {
        const r = await S.recordAcceptance(d.key, appVersion, now);
        if (!r) return;
        shared?.byKey.set(d.keyId, r.state);
        local.set(d.keyId, r.state);
        if (r.previous === 'REJECTED_CONFIRMED' || r.previous === 'NEEDS_RECHECK') {
          await onTransition({ key: d.key, keyId: d.keyId, to: 'QUALIFIED', from: r.previous, state: r.state });
        }
      } else if (o.kind === 'REJECTED') {
        const r = await S.recordRejection(d.key, { reason: o.reason, httpStatus: ev.httpStatus ?? null, providerCode: ev.providerCode ?? null, appVersion }, now);
        if (!r) return;
        shared?.byKey.set(d.keyId, r.state);
        local.set(d.keyId, r.state);
        if (r.transition) await onTransition({ key: d.key, keyId: d.keyId, to: 'REJECTED_CONFIRMED', from: prev?.state ?? null, state: r.state });
      } else {
        await S.releaseRetest(d.keyId, now);
      }
    } catch (e) {
      console.warn('[schema-compat] mémoire partagée non écrite (non bloquant) :', String((e as Error)?.message ?? e).slice(0, 200));
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
