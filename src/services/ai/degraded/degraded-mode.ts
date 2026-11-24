/**
 * Modes dégradés des protections anti-redondance IA — carte #811 (écart P1-C
 * du ticket #596).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE RISQUE TRAITÉ
 *
 * Quand la mémoire des décisions T3 (0856), le cache des réponses ou sa
 * réservation multi-instances (0857) sont absents, désactivés, illisibles ou
 * non inscriptibles, le traitement CONTINUE (bonne continuité métier) mais
 * chaque passage peut rappeler le fournisseur : des appels facturés, répétés,
 * que rien ne signalait.
 *
 * Désormais, chaque passage en mode dégradé :
 *   1. est TRACÉ (`noteDegraded`) : composant, raison technique, opération,
 *      traitement, compte, effet sur les appels — jamais de valeur métier,
 *      jamais de contenu de document, jamais de message d'erreur brut au-delà
 *      d'un code technique borné. Trace en mémoire (diagnostic de l'instance),
 *      journal applicatif borné (première occurrence puis une par minute) et
 *      compteur durable par jour (`ai_degraded_events`, migration 1861) ;
 *   2. déclenche une ALERTE de supervision (mécanisme existant
 *      `admin/anomaly.service`) quand la dégradation PERSISTE
 *      (`AI_DEGRADED_ALERT_MINUTES`, 30 min ; ou `AI_DEGRADED_ALERT_COUNT`
 *      occurrences, 20) ;
 *   3. est BORNÉ : un appel fournisseur émis sans sa protection consomme un
 *      budget par (traitement, opération, compte) et par heure
 *      (`AI_DEGRADED_CALLS_PER_HOUR`, 20 ; traitements concernés :
 *      `AI_DEGRADED_CAP_TREATMENTS`, « T3 »). Budget épuisé : l'appel est
 *      REFUSÉ avant tout contact (aucun coût) ; l'appelant prend son repli sûr
 *      sans IA (conflit prudent laissé à l'utilisateur, reprise au passage
 *      suivant). Jamais une boucle de facturation illimitée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CARTE #828 (écart A) — PORTÉE DE LA BORNE
 *
 * Le budget de la carte #811 était propre à chaque processus : N instances
 * admettaient N × budget. Désormais `admitDegradedCallShared` applique DEUX
 * bornes, dans cet ordre :
 *   1. la borne de l'INSTANCE (fenêtre glissante d'une heure, en mémoire) —
 *      elle fonctionne même quand la base ne répond plus ;
 *   2. la borne COMMUNE à toutes les instances (`ai_degraded_call_budget`,
 *      migration 1940 : un compteur par heure d'horloge et par portée,
 *      incrémenté de façon atomique ; deux instances ne peuvent pas admettre
 *      ensemble plus que le budget).
 * Borne commune injoignable (table absente, base indisponible, en lecture
 * seule ou trop lente : délai `AI_DEGRADED_BUDGET_TIMEOUT_MS`) : seule la
 * borne de l'instance s'applique, et c'est DIT (`sharedUnavailable`, constat
 * du diagnostic) — jamais présenté comme une borne globale.
 *
 * `AI_DEGRADED_CALLS_PER_HOUR=off` reste un CONTOURNEMENT D'URGENCE explicite :
 * chaque appel alors admis sans borne est tracé (composant `DEGRADED_CAP`),
 * une alerte part aussitôt, et le diagnostic refuse de dire « actives ».
 * Un refus par la borne déclenche lui aussi l'alerte sans attendre.
 * Ne lève jamais.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { pgClient } from '@/db';

export const DEGRADED_COMPONENTS = [
  'DECISION_MEMORY', 'RESPONSE_CACHE', 'CACHE_RESERVATION', 'CONFIG_SIGNATURE',
  // Carte #828 : la borne elle-même (levée par configuration) et le journal durable des événements d'usage.
  'DEGRADED_CAP', 'USAGE_JOURNAL',
] as const;
export type DegradedComponent = (typeof DEGRADED_COMPONENTS)[number];

export const DEGRADED_REASONS = [
  'DISABLED_BY_CONFIG', 'MIGRATION_MISSING', 'READ_FAILED', 'WRITE_FAILED', 'RESERVATION_FAILED',
  'LEASE_RENEWAL_FAILED', 'LEASE_LOST', 'SIGNATURE_UNRESOLVED',
] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

/** Effet sur les appels. */
export type DegradedImpact =
  /** Un appel fournisseur est émis sans la protection (mémoire, cache ou partage). */
  | 'CALL_WITHOUT_PROTECTION'
  /** L'appel a eu lieu mais son résultat n'a pas pu être conservé (rappel possible). */
  | 'RESULT_NOT_STORED'
  /** Budget dégradé épuisé : appel refusé avant contact, repli sûr sans IA. */
  | 'CALL_REFUSED'
  /** Aucun appel supplémentaire émis par cette instance. */
  | 'NO_EXTRA_CALL'
  /**
   * Carte #828 : cette instance n'émet rien de plus, mais elle ne peut PAS prouver qu'une autre instance n'appelle
   * pas pour la même demande (bail perdu, renouvellement en échec). Jamais présenté comme « aucun appel ».
   */
  | 'DUPLICATE_POSSIBLE'
  /** Carte #828 : événement d'usage non enregistré — les requêtes émises restent comptées par la mesure de l'exécution. */
  | 'USAGE_EVENT_LOST';

/** Libellés français simples (BO). */
export const DEGRADED_COMPONENT_LABELS: Record<DegradedComponent, string> = {
  DECISION_MEMORY: 'Mémoire durable des décisions T3',
  RESPONSE_CACHE: 'Cache temporaire des réponses',
  CACHE_RESERVATION: 'Réservation multi-instances du cache',
  CONFIG_SIGNATURE: 'Signature de la configuration IA',
  DEGRADED_CAP: 'Borne des appels sans protection',
  USAGE_JOURNAL: 'Journal durable des événements d’usage',
};
export const DEGRADED_REASON_LABELS: Record<DegradedReason, string> = {
  DISABLED_BY_CONFIG: 'désactivée par configuration',
  MIGRATION_MISSING: 'migration absente',
  READ_FAILED: 'lecture en échec',
  WRITE_FAILED: 'écriture en échec',
  RESERVATION_FAILED: 'réservation impossible',
  LEASE_RENEWAL_FAILED: 'renouvellement du bail en échec',
  LEASE_LOST: 'bail perdu pendant l’appel',
  SIGNATURE_UNRESOLVED: 'signature non résolue',
};
export const DEGRADED_IMPACT_LABELS: Record<DegradedImpact, string> = {
  CALL_WITHOUT_PROTECTION: 'appel émis sans la protection',
  RESULT_NOT_STORED: 'résultat non conservé (rappel possible)',
  CALL_REFUSED: 'appel refusé (budget dégradé épuisé), repli sans IA',
  NO_EXTRA_CALL: 'aucun appel supplémentaire émis par cette instance',
  DUPLICATE_POSSIBLE: 'appel simultané d’une autre instance possible (non prouvé absent)',
  USAGE_EVENT_LOST: 'événement d’usage non enregistré (requêtes émises comptées par la mesure du passage)',
};

export interface DegradedScope {
  treatment: string | null;
  operationCode: string | null;
  accountId: number | null;
  /**
   * Carte #828 : traitement du TRAVAIL en cours quand il diffère de celui de l'opération (T4 déclenché pendant
   * T3…). La borne s'applique si l'un des deux y est soumis ; la portée du budget reste celle de l'opération.
   */
  hostTreatment?: string | null;
}

export interface DegradedEvent extends DegradedScope {
  component: DegradedComponent;
  reason: DegradedReason;
  impact: DegradedImpact;
  /** Code technique BORNÉ (SQLSTATE, code d'erreur) — jamais un message brut, jamais une donnée. */
  technicalCode?: string | null;
}

const HEURE = 3_600_000;
const entier = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};

/** Appels fournisseur admis par heure en mode dégradé, par (traitement, opération, compte) ; `off` : sans borne. */
export function degradedCallsPerHour(env: Record<string, string | undefined> = process.env): number | null {
  if ((env.AI_DEGRADED_CALLS_PER_HOUR ?? '').trim().toLowerCase() === 'off') return null;
  return entier(env.AI_DEGRADED_CALLS_PER_HOUR, 20, 0, 100_000);
}
/** Traitements soumis à la borne (défaut : T3). */
export function degradedCapTreatments(env: Record<string, string | undefined> = process.env): string[] {
  const v = env.AI_DEGRADED_CAP_TREATMENTS;
  return (v === undefined ? 'T3' : v).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
}
export function degradedAlertMinutes(env: Record<string, string | undefined> = process.env): number {
  return entier(env.AI_DEGRADED_ALERT_MINUTES, 30, 1, 7 * 24 * 60);
}
export function degradedAlertCount(env: Record<string, string | undefined> = process.env): number {
  return entier(env.AI_DEGRADED_ALERT_COUNT, 20, 1, 1_000_000);
}
/** Carte #828 : délai accordé à la borne commune (base lente) avant de retomber sur la borne de l'instance. */
export function degradedBudgetTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return entier(env.AI_DEGRADED_BUDGET_TIMEOUT_MS, 1500, 50, 10_000);
}
/** Carte #828 : la portée est-elle soumise à la borne (traitement de l'opération OU du travail qui l'héberge) ? */
export function degradedScopeCapped(scope: DegradedScope, env: Record<string, string | undefined> = process.env): boolean {
  const soumis = degradedCapTreatments(env);
  return [scope.treatment, scope.hostTreatment].some((t) => !!t && soumis.includes(t.toUpperCase()));
}

interface Agg {
  component: DegradedComponent; reason: DegradedReason; count: number; firstAt: number; lastAt: number; lastLogAt: number;
  byImpact: Partial<Record<DegradedImpact, number>>; lastScope: DegradedScope; lastTechnicalCode: string | null; alertedAt: number | null;
}

const etat = {
  aggs: new Map<string, Agg>(),
  /** Dernière dégradation par portée (traitement|opération|compte). */
  scopes: new Map<string, number>(),
  /** Horodatages des appels admis en mode dégradé, par portée. */
  calls: new Map<string, number[]>(),
  refused: 0,
  allowed: 0,
  /** Carte #828 : admissions validées par la borne commune / refusées par elle / admises sur la seule borne de l'instance. */
  sharedAdmitted: 0,
  sharedRefused: 0,
  sharedUnavailable: 0,
  sharedUnavailableCode: null as string | null,
  /** Carte #828 : appels admis SANS borne (`AI_DEGRADED_CALLS_PER_HOUR=off`). */
  unbounded: 0,
  /** Carte #828 : appels annoncés « sans protection » par un appelant amont, à admettre au moment de l'envoi. */
  pending: new Map<string, Array<{ at: number; component: DegradedComponent; reason: DegradedReason }>>(),
};

const cleScope = (s: DegradedScope) => `${s.treatment ?? ''}|${s.operationCode ?? ''}|${s.accountId ?? 0}`;
const codeBorne = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const c = String(v).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40);
  return c || null;
};

/** Code technique d'une erreur (SQLSTATE, code Node, nom) — jamais son message. */
export function technicalCodeOf(e: unknown): string | null {
  const x = e as { code?: unknown; name?: unknown; cause?: { code?: unknown } | null } | null;
  // Carte #828 : une erreur enveloppée (couche d'accès aux données) porte le code de la base dans sa cause.
  const code = typeof x?.code === 'string' ? x.code : typeof x?.cause?.code === 'string' ? x.cause.code : null;
  return codeBorne(code ?? (typeof x?.name === 'string' ? x.name : null));
}

type Persist = (e: DegradedEvent) => Promise<void>;
type Alert = (a: { component: DegradedComponent; reason: DegradedReason; count: number; firstAt: Date; lastAt: Date; last: DegradedEvent }) => Promise<void>;

async function persistDefault(e: DegradedEvent): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO ai_degraded_events (day, account_id, treatment, operation_code, component, reason, impact, count, technical_code, first_at, last_at)
     VALUES ((now() AT TIME ZONE 'Europe/Paris')::date, $1, $2, $3, $4, $5, $6, 1, $7, now(), now())
     ON CONFLICT (day, (COALESCE(account_id, 0)), treatment, operation_code, component, reason, impact)
     DO UPDATE SET count = ai_degraded_events.count + 1, last_at = now(),
                   technical_code = COALESCE(EXCLUDED.technical_code, ai_degraded_events.technical_code)`,
    [e.accountId ?? null, e.treatment ?? '', e.operationCode ?? '', e.component, e.reason, e.impact, codeBorne(e.technicalCode)] as never[],
  );
}

/** Titre de l'anomalie de supervision (pur). */
export function degradedAlertTitle(component: DegradedComponent, reason: DegradedReason): string {
  if (component === 'DEGRADED_CAP') return 'IA — borne des appels sans protection LEVÉE par configuration (contournement d’urgence)';
  if (component === 'USAGE_JOURNAL') return `IA — journal des événements d’usage : ${DEGRADED_REASON_LABELS[reason]} (compteurs durables incomplets)`;
  return `IA — protection anti-redondance dégradée : ${DEGRADED_COMPONENT_LABELS[component]} (${DEGRADED_REASON_LABELS[reason]})`;
}

async function alertDefault(a: Parameters<Alert>[0]): Promise<void> {
  const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
  await reportAnomaly({
    domain: 'ai', fingerprint: buildFingerprint('ai', 'ai-degraded-protection', a.component, a.reason),
    accountId: a.last.accountId ?? null,
    title: degradedAlertTitle(a.component, a.reason),
    detail: {
      code: 'AI_PROTECTION_DEGRADED', component: a.component, reason: a.reason, occurrences: a.count,
      since: a.firstAt.toISOString(), lastAt: a.lastAt.toISOString(), impact: a.last.impact,
      treatment: a.last.treatment, operationCode: a.last.operationCode, technicalCode: codeBorne(a.last.technicalCode),
    },
    // Même constat tant que la dégradation dure : une seule anomalie ouverte, pas une occurrence par appel.
    materialKey: `${a.component}:${a.reason}`,
  });
}

let persist: Persist = persistDefault;
let alert: Alert = alertDefault;
let tableAbsente = false;

/**
 * Trace un passage en mode dégradé. Synchrone pour l'état de l'instance et le
 * budget ; l'écriture durable et l'alerte partent sans être attendues. Ne
 * lève jamais.
 */
export function noteDegraded(e: DegradedEvent, now: number = Date.now()): void {
  try {
    const k = `${e.component}|${e.reason}`;
    let a = etat.aggs.get(k);
    // Une dégradation qui n'a plus été vue depuis une heure repart de zéro (nouvel épisode).
    if (!a || now - a.lastAt > HEURE) {
      a = { component: e.component, reason: e.reason, count: 0, firstAt: now, lastAt: now, lastLogAt: 0, byImpact: {}, lastScope: e, lastTechnicalCode: null, alertedAt: null };
      etat.aggs.set(k, a);
    }
    a.count += 1;
    a.lastAt = now;
    a.byImpact[e.impact] = (a.byImpact[e.impact] ?? 0) + 1;
    a.lastScope = { treatment: e.treatment, operationCode: e.operationCode, accountId: e.accountId };
    a.lastTechnicalCode = codeBorne(e.technicalCode) ?? a.lastTechnicalCode;
    etat.scopes.set(cleScope(e), now);
    if (now - a.lastLogAt >= 60_000) {
      a.lastLogAt = now;
      console.warn(`[ai-degraded] ${e.component} ${e.reason} — ${DEGRADED_IMPACT_LABELS[e.impact]} · traitement ${e.treatment ?? '—'} · opération ${e.operationCode ?? '—'}`
        + ` · compte ${e.accountId ?? '—'}${a.lastTechnicalCode ? ` · code ${a.lastTechnicalCode}` : ''} · ${a.count} occurrence(s) depuis ${new Date(a.firstAt).toISOString()}`);
    }
    if (!tableAbsente) {
      void persist(e).catch((err) => {
        if ((err as { code?: string })?.code === '42P01') {
          tableAbsente = true;
          console.warn('[ai-degraded] table ai_degraded_events absente (migration 1861) : dégradations tracées dans le journal applicatif seulement.');
        }
      });
    }
    // Carte #828 : un refus par la borne, une borne levée ou un événement d'usage perdu alertent SANS attendre
    // (la limite et l'alerte restent cohérentes quel que soit le réglage du seuil d'occurrences).
    const immediate = e.impact === 'CALL_REFUSED' || e.component === 'DEGRADED_CAP' || e.component === 'USAGE_JOURNAL';
    const persistante = immediate || now - a.firstAt >= degradedAlertMinutes() * 60_000 || a.count >= degradedAlertCount();
    if (persistante && (a.alertedAt === null || now - a.alertedAt >= HEURE)) {
      a.alertedAt = now;
      const agg = a;
      void alert({ component: agg.component, reason: agg.reason, count: agg.count, firstAt: new Date(agg.firstAt), lastAt: new Date(agg.lastAt), last: e })
        .catch(() => undefined);
    }
  } catch { /* la trace ne fait jamais échouer un traitement */ }
}

/** Cette portée a-t-elle connu une dégradation dans la dernière heure ? */
export function degradedRecently(scope: DegradedScope, now: number = Date.now()): boolean {
  const t = etat.scopes.get(cleScope(scope));
  return t !== undefined && now - t <= HEURE;
}

/**
 * Un appel fournisseur SANS protection peut-il partir ? Consomme le budget de
 * la portée. Traitement hors borne (interactif…) : toujours admis. Rend faux
 * quand le budget horaire est épuisé — l'appelant ne contacte PAS le
 * fournisseur. Ne lève jamais.
 */
export function admitDegradedCall(scope: DegradedScope, now: number = Date.now()): boolean {
  try {
    const parHeure = degradedCallsPerHour();
    if (parHeure === null || !degradedScopeCapped(scope)) return true;
    const k = cleScope(scope);
    const recents = (etat.calls.get(k) ?? []).filter((t) => now - t < HEURE);
    if (recents.length >= parHeure) {
      etat.calls.set(k, recents);
      etat.refused += 1;
      return false;
    }
    recents.push(now);
    etat.calls.set(k, recents);
    etat.allowed += 1;
    return true;
  } catch { return true; }
}

// ══════════════════════════════════════════════════════════════════════════
// Carte #828 (écart A) — borne COMMUNE à toutes les instances
// ══════════════════════════════════════════════════════════════════════════

/** Admission par la borne commune ; lève quand elle est injoignable (l'appelant retombe sur la borne de l'instance). */
export type DegradedSharedBudget = (scope: DegradedScope, limit: number, timeoutMs: number) => Promise<'ADMITTED' | 'REFUSED'>;
type SharedBudget = DegradedSharedBudget;

async function sharedBudgetDefault(scope: DegradedScope, limit: number, timeoutMs: number): Promise<'ADMITTED' | 'REFUSED'> {
  const ms = Math.max(50, Math.floor(timeoutMs));
  const cle = [scope.treatment ?? '', scope.operationCode ?? '', scope.accountId ?? 0];
  return await pgClient.begin(async (tx) => {
    // Base lente ou ligne verrouillée : PostgreSQL abandonne lui-même la requête (aucune connexion retenue).
    await tx.unsafe(`SET LOCAL statement_timeout = ${ms}`);
    await tx.unsafe(`SET LOCAL lock_timeout = ${ms}`);
    const rows = (await tx.unsafe(
      `INSERT INTO ai_degraded_call_budget (hour_start, treatment, operation_code, account_id, admitted, refused, first_at, last_at)
       VALUES (date_trunc('hour', now()), $1, $2, $3, 1, 0, now(), now())
       ON CONFLICT (hour_start, treatment, operation_code, account_id) DO UPDATE
         SET admitted = ai_degraded_call_budget.admitted + 1, last_at = now()
         WHERE ai_degraded_call_budget.admitted < $4
       RETURNING admitted`,
      [...cle, limit] as never[],
    )) as unknown as unknown[];
    if (rows.length > 0) return 'ADMITTED' as const;
    await tx.unsafe(
      `UPDATE ai_degraded_call_budget SET refused = refused + 1, last_at = now()
        WHERE hour_start = date_trunc('hour', now()) AND treatment = $1 AND operation_code = $2 AND account_id = $3`,
      cle as never[],
    );
    return 'REFUSED' as const;
  }) as 'ADMITTED' | 'REFUSED';
}

/**
 * Refus décidé par la borne de l'INSTANCE : compté lui aussi dans le budget commun (le volume des refus lu au BO
 * couvre toutes les instances). Écriture « au mieux », bornée par le même délai ; jamais attendue par l'appelant.
 */
type SharedRefusal = (scope: DegradedScope, timeoutMs: number) => Promise<void>;

async function sharedRefusalDefault(scope: DegradedScope, timeoutMs: number): Promise<void> {
  const ms = Math.max(50, Math.floor(timeoutMs));
  await pgClient.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${ms}`);
    await tx.unsafe(`SET LOCAL lock_timeout = ${ms}`);
    await tx.unsafe(
      `INSERT INTO ai_degraded_call_budget (hour_start, treatment, operation_code, account_id, admitted, refused, first_at, last_at)
       VALUES (date_trunc('hour', now()), $1, $2, $3, 0, 1, now(), now())
       ON CONFLICT (hour_start, treatment, operation_code, account_id) DO UPDATE
         SET refused = ai_degraded_call_budget.refused + 1, last_at = now()`,
      [scope.treatment ?? '', scope.operationCode ?? '', scope.accountId ?? 0] as never[],
    );
  });
}

let sharedBudget: SharedBudget = sharedBudgetDefault;
let sharedRefusal: SharedRefusal = sharedRefusalDefault;
/** Table 1940 absente : mémorisé pour l'instance, revérifié toutes les 5 minutes. */
let budgetAbsent: { at: number } | null = null;

/**
 * Carte #828 — un appel fournisseur SANS protection peut-il partir ? Borne de l'instance PUIS borne commune à
 * toutes les instances. Rend faux quand l'une des deux est atteinte : l'appelant ne contacte PAS le fournisseur.
 * Borne commune injoignable : la borne de l'instance décide seule, et c'est compté (`sharedUnavailable`).
 * Borne levée (`off`) : admis, tracé et alerté. Ne lève jamais.
 */
export async function admitDegradedCallShared(scope: DegradedScope, now: number = Date.now()): Promise<boolean> {
  try {
    if (!degradedScopeCapped(scope)) return true;
    const parHeure = degradedCallsPerHour();
    if (parHeure === null) {
      etat.unbounded += 1;
      noteDegraded({
        treatment: scope.treatment, operationCode: scope.operationCode, accountId: scope.accountId,
        component: 'DEGRADED_CAP', reason: 'DISABLED_BY_CONFIG', impact: 'CALL_WITHOUT_PROTECTION',
      }, now);
      return true;
    }
    if (!admitDegradedCall(scope, now)) {
      if (!budgetAbsent) void sharedRefusal(scope, degradedBudgetTimeoutMs()).catch(() => undefined);
      return false;
    }
    if (budgetAbsent && Date.now() - budgetAbsent.at < 300_000) { noterIndisponible('42P01'); return true; }
    const delai = degradedBudgetTimeoutMs();
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    try {
      const issue = await Promise.race([
        sharedBudget(scope, parHeure, delai),
        // Garde côté application (réseau figé) : au-delà du délai de la base, on n'attend plus.
        new Promise<never>((_, rej) => { minuteur = setTimeout(() => rej(Object.assign(new Error('délai'), { code: 'BUDGET_TIMEOUT' })), delai + 500); }),
      ]);
      budgetAbsent = null;
      if (issue === 'REFUSED') {
        // La place prise sur la borne de l'instance reste consommée (prudent) ; le refus est compté.
        etat.allowed = Math.max(0, etat.allowed - 1);
        etat.refused += 1;
        etat.sharedRefused += 1;
        return false;
      }
      etat.sharedAdmitted += 1;
      return true;
    } catch (e) {
      const code = technicalCodeOf(e) ?? 'ERREUR';
      if (code === '42P01') budgetAbsent = { at: Date.now() };
      noterIndisponible(code);
      return true;
    } finally { if (minuteur) clearTimeout(minuteur); }
  } catch { return true; }
}

function noterIndisponible(code: string): void {
  etat.sharedUnavailable += 1;
  etat.sharedUnavailableCode = code;
  if (etat.sharedUnavailable === 1 || etat.sharedUnavailable % 100 === 0) {
    console.warn(`[ai-degraded] borne commune des appels sans protection injoignable (code ${code}) : seule la borne de cette instance s'applique.`);
  }
}

const PENDING_TTL = 10 * 60_000;

/**
 * Carte #828 — un appelant amont (signature de configuration non résolue du rattachement…) annonce que SA
 * protection durable ne couvrira pas le prochain appel de cette portée : l'admission par la borne se fera au
 * moment de l'envoi (cache des réponses), seulement si une requête part réellement. Trace comprise.
 */
export function announceUnprotectedCall(e: Omit<DegradedEvent, 'impact'>, now: number = Date.now()): void {
  noteDegraded({ ...e, impact: 'CALL_WITHOUT_PROTECTION' }, now);
  try {
    const k = cleScope(e);
    const file = (etat.pending.get(k) ?? []).filter((x) => now - x.at < PENDING_TTL);
    if (file.length < 1000) file.push({ at: now, component: e.component, reason: e.reason });
    etat.pending.set(k, file);
  } catch { /* jamais bloquant */ }
}

/** Retire UNE annonce en attente pour la portée (appelé au moment de l'envoi) ; `null` : aucune. */
export function takeAnnouncedUnprotectedCall(scope: DegradedScope, now: number = Date.now()): { component: DegradedComponent; reason: DegradedReason } | null {
  try {
    const k = cleScope(scope);
    const file = (etat.pending.get(k) ?? []).filter((x) => now - x.at < PENDING_TTL);
    const x = file.shift() ?? null;
    if (file.length) etat.pending.set(k, file); else etat.pending.delete(k);
    return x ? { component: x.component, reason: x.reason } : null;
  } catch { return null; }
}

export interface DegradedBudgetRow { hourStart: string; treatment: string; operationCode: string; accountId: number; admitted: number; refused: number }

/** Carte #828 — budget commun consommé sur les dernières `hours` heures, toutes instances (lecture seule). */
export async function readDegradedBudget(hours = 24): Promise<{ available: boolean; admitted: number; refused: number; rows: DegradedBudgetRow[] }> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT hour_start, treatment, operation_code, account_id, admitted, refused
         FROM ai_degraded_call_budget WHERE hour_start >= now() - ($1 || ' hours')::interval
        ORDER BY hour_start DESC, admitted + refused DESC LIMIT 100`,
      [String(Math.max(1, Math.floor(hours)))] as never[],
    )) as unknown as Array<{ hour_start: Date | string; treatment: string; operation_code: string; account_id: number; admitted: number; refused: number }>;
    const out = rows.map((r) => ({
      hourStart: new Date(r.hour_start).toISOString(), treatment: r.treatment, operationCode: r.operation_code,
      accountId: Number(r.account_id) || 0, admitted: Number(r.admitted) || 0, refused: Number(r.refused) || 0,
    }));
    return { available: true, admitted: out.reduce((n, r) => n + r.admitted, 0), refused: out.reduce((n, r) => n + r.refused, 0), rows: out };
  } catch (e) {
    if ((e as { code?: string })?.code === '42P01') return { available: false, admitted: 0, refused: 0, rows: [] };
    throw e;
  }
}

export interface DegradedInstanceState {
  episodes: Array<{
    component: DegradedComponent; reason: DegradedReason; count: number; firstAt: string; lastAt: string;
    byImpact: Partial<Record<DegradedImpact, number>>; lastTreatment: string | null; lastOperationCode: string | null;
    lastAccountId: number | null; technicalCode: string | null; alerted: boolean;
  }>;
  callsAllowed: number;
  callsRefused: number;
  callsPerHour: number | null;
  cappedTreatments: string[];
  /** Carte #828 : admissions validées / refusées par la borne commune ; admissions sur la seule borne de l'instance. */
  sharedAdmitted?: number;
  sharedRefused?: number;
  sharedUnavailable?: number;
  sharedUnavailableCode?: string | null;
  /** Carte #828 : appels admis sans borne (`AI_DEGRADED_CALLS_PER_HOUR=off`). */
  unbounded?: number;
}

/** État de CETTE instance (diagnostic BO). */
export function degradedInstanceState(now: number = Date.now()): DegradedInstanceState {
  return {
    episodes: [...etat.aggs.values()].filter((a) => now - a.lastAt <= 24 * HEURE).map((a) => ({
      component: a.component, reason: a.reason, count: a.count, firstAt: new Date(a.firstAt).toISOString(), lastAt: new Date(a.lastAt).toISOString(),
      byImpact: { ...a.byImpact }, lastTreatment: a.lastScope.treatment, lastOperationCode: a.lastScope.operationCode,
      lastAccountId: a.lastScope.accountId, technicalCode: a.lastTechnicalCode, alerted: a.alertedAt !== null,
    })),
    callsAllowed: etat.allowed, callsRefused: etat.refused, callsPerHour: degradedCallsPerHour(), cappedTreatments: degradedCapTreatments(),
    sharedAdmitted: etat.sharedAdmitted, sharedRefused: etat.sharedRefused, sharedUnavailable: etat.sharedUnavailable,
    sharedUnavailableCode: etat.sharedUnavailableCode, unbounded: etat.unbounded,
  };
}

export interface DegradedDurableRow {
  component: string; reason: string; impact: string; treatment: string; operationCode: string; accounts: number; count: number;
  firstAt: string | null; lastAt: string | null; technicalCode: string | null;
}

/**
 * Dégradations durables des dernières `hours` heures, TOUTES instances
 * (lecture seule). `available: false` : table 1861 absente.
 */
export async function readDegradedEvents(hours = 24): Promise<{ available: boolean; rows: DegradedDurableRow[] }> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT component, reason, impact, treatment, operation_code, count(DISTINCT COALESCE(account_id, 0))::int AS accounts,
              sum(count)::bigint AS n, min(first_at) AS first_at, max(last_at) AS last_at, max(technical_code) AS technical_code
         FROM ai_degraded_events WHERE last_at >= now() - ($1 || ' hours')::interval
        GROUP BY component, reason, impact, treatment, operation_code ORDER BY max(last_at) DESC LIMIT 100`,
      [String(Math.max(1, Math.floor(hours)))] as never[],
    )) as unknown as Array<{ component: string; reason: string; impact: string; treatment: string; operation_code: string; accounts: number; n: string; first_at: Date | string | null; last_at: Date | string | null; technical_code: string | null }>;
    const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
    return {
      available: true,
      rows: rows.map((r) => ({
        component: r.component, reason: r.reason, impact: r.impact, treatment: r.treatment, operationCode: r.operation_code,
        accounts: Number(r.accounts) || 0, count: Number(r.n) || 0, firstAt: iso(r.first_at), lastAt: iso(r.last_at), technicalCode: r.technical_code,
      })),
    };
  } catch (e) {
    if ((e as { code?: string })?.code === '42P01') return { available: false, rows: [] };
    throw e;
  }
}

/** Réservé aux tests : remet l'état de l'instance à zéro et remplace l'écriture durable / l'alerte (`null` : réelles). */
export function __resetDegradedModeForTests(p: { persist?: Persist | null; alert?: Alert | null; sharedBudget?: SharedBudget | null } = {}): void {
  etat.aggs.clear(); etat.scopes.clear(); etat.calls.clear(); etat.refused = 0; etat.allowed = 0;
  etat.sharedAdmitted = 0; etat.sharedRefused = 0; etat.sharedUnavailable = 0; etat.sharedUnavailableCode = null; etat.unbounded = 0;
  etat.pending.clear();
  tableAbsente = false;
  budgetAbsent = null;
  if (p.sharedBudget !== undefined) {
    sharedBudget = p.sharedBudget ?? sharedBudgetDefault;
    // Borne commune simulée : aucune écriture réelle du refus.
    sharedRefusal = p.sharedBudget ? async () => undefined : sharedRefusalDefault;
  }
  if (p.persist !== undefined) persist = p.persist ?? persistDefault;
  if (p.alert !== undefined) alert = p.alert ?? alertDefault;
}
