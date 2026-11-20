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
 * Le budget est par INSTANCE (il doit fonctionner quand la base ne répond
 * plus) : la borne globale est « instances × budget ». Ne lève jamais.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { pgClient } from '@/db';

export const DEGRADED_COMPONENTS = ['DECISION_MEMORY', 'RESPONSE_CACHE', 'CACHE_RESERVATION', 'CONFIG_SIGNATURE'] as const;
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
  /** Aucun appel supplémentaire (partage multi-instances seul perdu, bail perdu…). */
  | 'NO_EXTRA_CALL';

/** Libellés français simples (BO). */
export const DEGRADED_COMPONENT_LABELS: Record<DegradedComponent, string> = {
  DECISION_MEMORY: 'Mémoire durable des décisions T3',
  RESPONSE_CACHE: 'Cache temporaire des réponses',
  CACHE_RESERVATION: 'Réservation multi-instances du cache',
  CONFIG_SIGNATURE: 'Signature de la configuration IA',
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
  NO_EXTRA_CALL: 'aucun appel supplémentaire',
};

export interface DegradedScope {
  treatment: string | null;
  operationCode: string | null;
  accountId: number | null;
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
};

const cleScope = (s: DegradedScope) => `${s.treatment ?? ''}|${s.operationCode ?? ''}|${s.accountId ?? 0}`;
const codeBorne = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const c = String(v).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40);
  return c || null;
};

/** Code technique d'une erreur (SQLSTATE, code Node, nom) — jamais son message. */
export function technicalCodeOf(e: unknown): string | null {
  const x = e as { code?: unknown; name?: unknown } | null;
  return codeBorne(typeof x?.code === 'string' ? x.code : typeof x?.name === 'string' ? x.name : null);
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

async function alertDefault(a: Parameters<Alert>[0]): Promise<void> {
  const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
  await reportAnomaly({
    domain: 'ai', fingerprint: buildFingerprint('ai', 'ai-degraded-protection', a.component, a.reason),
    accountId: a.last.accountId ?? null,
    title: `IA — protection anti-redondance dégradée : ${DEGRADED_COMPONENT_LABELS[a.component]} (${DEGRADED_REASON_LABELS[a.reason]})`,
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
    const persistante = now - a.firstAt >= degradedAlertMinutes() * 60_000 || a.count >= degradedAlertCount();
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
    if (parHeure === null || !scope.treatment || !degradedCapTreatments().includes(scope.treatment.toUpperCase())) return true;
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
export function __resetDegradedModeForTests(p: { persist?: Persist | null; alert?: Alert | null } = {}): void {
  etat.aggs.clear(); etat.scopes.clear(); etat.calls.clear(); etat.refused = 0; etat.allowed = 0;
  tableAbsente = false;
  if (p.persist !== undefined) persist = p.persist ?? persistDefault;
  if (p.alert !== undefined) alert = p.alert ?? alertDefault;
}
