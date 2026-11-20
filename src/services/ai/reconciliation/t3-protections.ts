/**
 * Diagnostic des protections anti-redondance T3 (ticket #596) — carte #811,
 * écart P1-C : « aucune présentation "#596 actif" si une dépendance est
 * absente ».
 *
 * Lu par le BO (File IA › Supervision T3) et journalisé une fois au démarrage
 * de l'instance. Vérifie ce qui est RÉELLEMENT en place, pas ce qui est
 * supposé l'être :
 *   · migrations effectives (0856 mémoire, 0857 cache et réservation, 0858
 *     compteurs, 0859 index du préfiltre, 1860 compteurs mesurés, 1861 trace
 *     des modes dégradés) ;
 *   · mémoire activée ET utilisable (lecture réelle) ;
 *   · cache et réservation utilisables (lecture réelle, réservation puis
 *     libération d'une clé de diagnostic) ;
 *   · préfiltre du balayage actif ;
 *   · signature de la configuration IA de `t3_value_conflict` résolue ;
 *   · réglages effectifs (noms de variables et valeurs non secrètes) ;
 *   · passages en mode dégradé des dernières 24 h (toutes instances) et état
 *     de l'instance qui répond.
 *
 * État global : ACTIVE (tout est en place, aucune dégradation récente),
 * DEGRADED (protection en place mais avertissement), INACTIVE (une dépendance
 * manque : la protection n'est PAS effective). Lecture seule, hormis la clé de
 * diagnostic du cache, écrite puis supprimée. Ne lève jamais.
 */
import { randomUUID } from 'crypto';
import {
  degradedInstanceState, readDegradedEvents, DEGRADED_COMPONENT_LABELS, DEGRADED_REASON_LABELS, DEGRADED_IMPACT_LABELS,
  degradedAlertCount, degradedAlertMinutes,
  type DegradedDurableRow, type DegradedInstanceState,
} from '../degraded/degraded-mode';

export type T3ProtectionLevel = 'ok' | 'warn' | 'error';
export interface T3ProtectionFinding { code: string; level: T3ProtectionLevel; message: string }
export type T3ProtectionStatus = 'ACTIVE' | 'DEGRADED' | 'INACTIVE';

export const T3_PROTECTION_STATUS_LABELS: Record<T3ProtectionStatus, string> = {
  ACTIVE: 'Protections anti-redondance actives',
  DEGRADED: 'Protections anti-redondance en place, avec avertissement',
  INACTIVE: 'Protections anti-redondance NON effectives : une dépendance manque',
};

export interface T3ProtectionFacts {
  /** `null` : non vérifiable (base illisible). */
  memoryTable: boolean | null;
  memoryEnabled: boolean;
  memoryReadable: boolean | null;
  cacheTable: boolean | null;
  cacheColumns0857: boolean | null;
  cacheDisabledByEnv: boolean;
  reservationUsable: boolean | null;
  reuseCounters0858: boolean | null;
  runCounters0858: boolean | null;
  sweepIndex0859: boolean | null;
  measuredCounters1860: boolean | null;
  degradedTrace1861: boolean | null;
  prefilterEnabled: boolean;
  /** Signature de configuration de `t3_value_conflict` ; `unresolved` : non résolue. */
  configSignature: string;
  degradedLast24h: DegradedDurableRow[];
  instance: DegradedInstanceState;
  /** Code technique borné d'une lecture en échec. */
  probeError: string | null;
}

export interface T3Protections {
  checkedAt: string;
  status: T3ProtectionStatus;
  statusLabel: string;
  findings: T3ProtectionFinding[];
  /** Réglages effectifs (noms de variables d'environnement, valeurs non secrètes). */
  settings: Array<{ name: string; value: string; note: string }>;
  degraded: { durableAvailable: boolean; last24h: DegradedDurableRow[]; instance: DegradedInstanceState };
}

const ouiNon = (v: boolean | null, oui: string, non: string, inconnu: string): { level: T3ProtectionLevel; message: string } =>
  (v === true ? { level: 'ok', message: oui } : v === false ? { level: 'error', message: non } : { level: 'error', message: inconnu });

/** Constats et état global (pur, testé). */
export function evaluateT3Protections(f: T3ProtectionFacts): { status: T3ProtectionStatus; findings: T3ProtectionFinding[] } {
  const out: T3ProtectionFinding[] = [];
  const add = (code: string, x: { level: T3ProtectionLevel; message: string }) => out.push({ code, ...x });

  add('MIGRATION_0856', ouiNon(f.memoryTable, 'Migration 0856 appliquée (mémoire durable des décisions T3).',
    'Migration 0856 ABSENTE : aucune mémoire des décisions — chaque passage repose la question au fournisseur.',
    'Migration 0856 non vérifiable (base illisible).'));
  add('MEMORY_ENABLED', f.memoryEnabled
    ? { level: 'ok', message: 'Mémoire des décisions activée (T3_DECISION_MEMORY_ENABLED ≠ 0).' }
    : { level: 'error', message: 'Mémoire des décisions DÉSACTIVÉE par configuration (T3_DECISION_MEMORY_ENABLED=0) : appels sans mémoire, tracés et bornés.' });
  if (f.memoryTable) {
    add('MEMORY_USABLE', ouiNon(f.memoryReadable, 'Mémoire des décisions lisible.',
      'Mémoire des décisions ILLISIBLE : appels sans mémoire, tracés et bornés.', 'Mémoire des décisions : lecture non vérifiable.'));
  }
  add('MIGRATION_0857', f.cacheTable === false
    ? { level: 'error', message: 'Table du cache des réponses ABSENTE : aucun cache, aucun partage.' }
    : ouiNon(f.cacheColumns0857, 'Migration 0857 appliquée (cache renouvelable, réservation multi-instances).',
      'Migration 0857 ABSENTE : cache par processus seulement, deux instances peuvent appeler pour la même demande.',
      'Migration 0857 non vérifiable (base illisible).'));
  add('CACHE_ENABLED', f.cacheDisabledByEnv
    ? { level: 'error', message: 'Cache des réponses DÉSACTIVÉ par configuration (AI_IDEMPOTENCY_DISABLED=true) : aucune réponse réutilisée, aucun partage.' }
    : { level: 'ok', message: 'Cache des réponses activé.' });
  if (!f.cacheDisabledByEnv && f.cacheColumns0857) {
    add('RESERVATION_USABLE', ouiNon(f.reservationUsable, 'Réservation du cache utilisable (réservation puis libération d’une clé de diagnostic).',
      'Réservation du cache INUTILISABLE (écriture en échec) : appels sans partage, tracés et bornés.',
      'Réservation du cache non vérifiée.'));
  }
  add('CONFIG_SIGNATURE', f.configSignature && f.configSignature !== 'unresolved'
    ? { level: 'ok', message: `Signature de la configuration IA de t3_value_conflict résolue (${f.configSignature}).` }
    : { level: 'error', message: 'Signature de la configuration IA NON RÉSOLUE : aucune décision mémorisée n’est réutilisée ni enregistrée tant qu’elle le reste.' });
  add('SWEEP_PREFILTER', f.prefilterEnabled
    ? { level: 'ok', message: 'Préfiltre du balayage actif (T3_SWEEP_PREFILTER ≠ 0).' }
    : { level: 'warn', message: 'Préfiltre du balayage DÉSACTIVÉ (T3_SWEEP_PREFILTER=0) : tout compte ayant un bien est repassé à chaque cycle (sans appel si rien n’a changé).' });
  const avert = (code: string, v: boolean | null, oui: string, non: string) =>
    add(code, v === true ? { level: 'ok', message: oui } : { level: 'warn', message: v === false ? non : `${non} (non vérifiable)` });
  avert('MIGRATION_0858', f.reuseCounters0858 === null || f.runCounters0858 === null ? null : f.reuseCounters0858 && f.runCounters0858,
    'Migration 0858 appliquée (compteurs de réutilisation, colonnes des passages).',
    'Migration 0858 absente ou partielle : réutilisations non comptées, compteurs des passages non écrits.');
  avert('MIGRATION_0859', f.sweepIndex0859, 'Migration 0859 appliquée (index du préfiltre).',
    'Index 0859 absent : préfiltre plus lent, jamais faux.');
  avert('MIGRATION_1860', f.measuredCounters1860, 'Migration 1860 appliquée (compteurs d’appels mesurés).',
    'Migration 1860 absente : les passages ne publient pas la mesure des appels réels (ancienne sémantique).');
  avert('MIGRATION_1861', f.degradedTrace1861, 'Migration 1861 appliquée (trace durable des modes dégradés).',
    'Migration 1861 absente : les modes dégradés ne sont tracés que dans le journal applicatif de chaque instance.');

  const recents = f.degradedLast24h.reduce((n, r) => n + r.count, 0);
  const refuses = f.degradedLast24h.filter((r) => r.impact === 'CALL_REFUSED').reduce((n, r) => n + r.count, 0);
  add('DEGRADED_24H', recents === 0 && f.instance.episodes.length === 0
    ? { level: 'ok', message: 'Aucun passage en mode dégradé sur les dernières 24 h.' }
    : { level: 'warn', message: `${recents || f.instance.episodes.reduce((n, e) => n + e.count, 0)} passage(s) en mode dégradé sur les dernières 24 h${refuses ? `, dont ${refuses} appel(s) refusé(s) par la borne` : ''} — détail ci-dessous.` });
  if (f.probeError) add('PROBE_ERROR', { level: 'warn', message: `Une vérification n’a pas pu être faite (code ${f.probeError}).` });

  const status: T3ProtectionStatus = out.some((x) => x.level === 'error') ? 'INACTIVE' : out.some((x) => x.level === 'warn') ? 'DEGRADED' : 'ACTIVE';
  return { status, findings: out };
}

const env = (n: string): string => {
  const v = process.env[n];
  return v === undefined || v.trim() === '' ? '(défaut)' : v.trim().slice(0, 40);
};

/** Réglages effectifs (pur vis-à-vis de la base). Noms de variables seulement — aucune valeur secrète n'existe ici. */
export function t3ProtectionSettings(): T3Protections['settings'] {
  return [
    { name: 'T3_DECISION_MEMORY_ENABLED', value: env('T3_DECISION_MEMORY_ENABLED'), note: 'mémoire durable des décisions (défaut : activée ; 0 = désactivée)' },
    { name: 'T3_DECISION_MEMORY_FAILURE_RETRY_MINUTES', value: env('T3_DECISION_MEMORY_FAILURE_RETRY_MINUTES'), note: 'délai avant nouvelle tentative après un échec IA mémorisé (défaut : 360)' },
    { name: 'T3_SWEEP_PREFILTER', value: env('T3_SWEEP_PREFILTER'), note: 'préfiltre du balayage (défaut : actif ; 0 = ancien périmètre)' },
    { name: 'T3_SWEEP_COVERAGE_HOURS', value: env('T3_SWEEP_COVERAGE_HOURS'), note: 'période de couverture exhaustive (défaut : 24 h)' },
    { name: 'T3_NAMING_VERIFY_HOURS', value: env('T3_NAMING_VERIFY_HOURS'), note: 'relecture de sécurité du nommage (défaut : 24 h)' },
    { name: 'T3_DOCUMENT_NAMING_ENABLED', value: env('T3_DOCUMENT_NAMING_ENABLED'), note: 'harmonisation documentaire (défaut : activée)' },
    { name: 'AI_IDEMPOTENCY_DISABLED', value: env('AI_IDEMPOTENCY_DISABLED'), note: 'coupure du cache des réponses (défaut : cache actif)' },
    { name: 'AI_IDEMPOTENCY_LEASE_SECONDS', value: env('AI_IDEMPOTENCY_LEASE_SECONDS'), note: 'bail d’une réservation, renouvelé pendant l’appel (défaut : 180 s)' },
    { name: 'AI_IDEMPOTENCY_LEASE_MAX_SECONDS', value: env('AI_IDEMPOTENCY_LEASE_MAX_SECONDS'), note: 'durée maximale de renouvellement du bail d’un même appel (défaut : 1800 s)' },
    { name: 'AI_DEGRADED_CALLS_PER_HOUR', value: env('AI_DEGRADED_CALLS_PER_HOUR'), note: 'appels sans protection admis par heure, par traitement / opération / compte et par instance (défaut : 20 ; off = sans borne)' },
    { name: 'AI_DEGRADED_CAP_TREATMENTS', value: env('AI_DEGRADED_CAP_TREATMENTS'), note: 'traitements soumis à la borne (défaut : T3)' },
    { name: 'AI_DEGRADED_ALERT_MINUTES', value: env('AI_DEGRADED_ALERT_MINUTES'), note: `alerte si la dégradation persiste (défaut : ${degradedAlertMinutes({})} min)` },
    { name: 'AI_DEGRADED_ALERT_COUNT', value: env('AI_DEGRADED_ALERT_COUNT'), note: `alerte à partir de ce nombre d’occurrences (défaut : ${degradedAlertCount({})})` },
  ];
}

type Sql = { unsafe(q: string, p?: never[]): Promise<unknown> };

/** Lecture des faits en base (exportée pour les tests PostgreSQL). Ne lève jamais. */
export async function readT3ProtectionFacts(sql?: Sql): Promise<T3ProtectionFacts> {
  const db = sql ?? ((await import('@/db')).pgClient as unknown as Sql);
  const codeDe = (e: unknown) => String((e as { code?: unknown })?.code ?? (e as { name?: unknown })?.name ?? 'ERREUR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 30);
  let probeError: string | null = null;
  const lire = async <T>(q: string, p: unknown[] = []): Promise<T[] | null> => {
    try { return (await db.unsafe(q, p as never[])) as T[]; } catch (e) { probeError = probeError ?? codeDe(e); return null; }
  };
  const [s] = (await lire<Record<string, boolean>>(
    `SELECT to_regclass('t3_decision_memory') IS NOT NULL AS memoire,
            to_regclass('ai_operation_idempotency') IS NOT NULL AS cache,
            to_regclass('ai_reuse_counters') IS NOT NULL AS reuse,
            to_regclass('ai_degraded_events') IS NOT NULL AS degrade,
            to_regclass('account_reconciliation_runs_done_idx') IS NOT NULL AS idx0859,
            (SELECT count(*) = 4 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ai_operation_idempotency'
               AND column_name IN ('state', 'owner_token', 'hit_count', 'renewed_count')) AS cols0857,
            (SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'account_reconciliation_runs'
               AND column_name IN ('provider_calls', 'ai_cache_hits', 'decisions_reused')) AS cols0858,
            (SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'account_reconciliation_runs'
               AND column_name IN ('ai_counters_semantics', 'ai_requests_declared', 'ai_activity')) AS cols1860`)) ?? [];
  const b = (k: string): boolean | null => (s ? s[k] === true : null);
  let memoryReadable: boolean | null = null;
  if (b('memoire')) memoryReadable = (await lire(`SELECT 1 FROM t3_decision_memory LIMIT 1`)) !== null;
  const cacheDisabledByEnv = process.env.AI_IDEMPOTENCY_DISABLED === 'true';
  let reservationUsable: boolean | null = null;
  if (b('cache') && b('cols0857')) {
    // Réservation réelle d'une clé de diagnostic, aussitôt libérée (jamais une clé métier, jamais une clé réservée).
    const cle = `diag:t3-protections:${randomUUID()}`;
    const ins = await lire(
      `INSERT INTO ai_operation_idempotency (key_hash, result_json, created_at, expires_at, state, owner_token)
       VALUES ($1, '{}'::jsonb, now(), now() + interval '5 seconds', 'PENDING', 'diagnostic') RETURNING 1 AS ok`, [cle]);
    const del = ins ? await lire(`DELETE FROM ai_operation_idempotency WHERE key_hash = $1 AND owner_token = 'diagnostic' RETURNING 1 AS ok`, [cle]) : null;
    reservationUsable = !!ins && ins.length === 1 && !!del && del.length === 1;
  }
  let configSignature = 'unresolved';
  try { configSignature = await (await import('../gateway/ai-gateway')).AiGateway.effectiveConfigSignature('t3_value_conflict'); } catch { configSignature = 'unresolved'; }
  let durables: DegradedDurableRow[] = [];
  try { durables = (await readDegradedEvents(24)).rows; } catch (e) { probeError = probeError ?? codeDe(e); }
  const [{ decisionMemoryDisabled }, { t3SweepPrefilterEnabled }] = await Promise.all([import('./decision-memory/store'), import('./t3-queue')]);
  return {
    memoryTable: b('memoire'), memoryEnabled: !decisionMemoryDisabled(), memoryReadable, cacheTable: b('cache'), cacheColumns0857: b('cols0857'),
    cacheDisabledByEnv, reservationUsable, reuseCounters0858: b('reuse'), runCounters0858: b('cols0858'), sweepIndex0859: b('idx0859'),
    measuredCounters1860: b('cols1860'), degradedTrace1861: b('degrade'), prefilterEnabled: t3SweepPrefilterEnabled(), configSignature,
    degradedLast24h: durables, instance: degradedInstanceState(), probeError,
  };
}

/** Diagnostic complet (BO). Ne lève jamais. */
export async function getT3Protections(now: Date = new Date()): Promise<T3Protections> {
  const f = await readT3ProtectionFacts();
  const { status, findings } = evaluateT3Protections(f);
  return {
    checkedAt: now.toISOString(), status, statusLabel: T3_PROTECTION_STATUS_LABELS[status], findings, settings: t3ProtectionSettings(),
    degraded: { durableAvailable: f.degradedTrace1861 === true, last24h: f.degradedLast24h, instance: f.instance },
  };
}

/** Ligne lisible d'une dégradation (pure, BO). */
export function degradedRowLabel(r: Pick<DegradedDurableRow, 'component' | 'reason' | 'impact' | 'treatment' | 'operationCode' | 'accounts' | 'count' | 'technicalCode'>): string {
  const c = (DEGRADED_COMPONENT_LABELS as Record<string, string>)[r.component] ?? r.component;
  const m = (DEGRADED_REASON_LABELS as Record<string, string>)[r.reason] ?? r.reason;
  const i = (DEGRADED_IMPACT_LABELS as Record<string, string>)[r.impact] ?? r.impact;
  return `${c} — ${m} : ${i} · ${r.count} fois · ${r.treatment || '—'} / ${r.operationCode || '—'} · ${r.accounts} compte(s)${r.technicalCode ? ` · code ${r.technicalCode}` : ''}`;
}

/**
 * Contrôle au DÉMARRAGE de l'instance : une ligne de journal avec l'état des
 * protections et chaque dépendance manquante. Jamais bloquant, ne lève jamais.
 */
export async function logT3ProtectionsAtStartup(): Promise<T3ProtectionStatus | null> {
  try {
    const p = await getT3Protections();
    const ko = p.findings.filter((x) => x.level !== 'ok');
    const ligne = `[t3-protections] ${p.statusLabel}${ko.length ? ` — ${ko.map((x) => `${x.code} : ${x.message}`).join(' | ')}` : ''}`;
    if (p.status === 'ACTIVE') console.info(ligne); else console.warn(ligne);
    return p.status;
  } catch (e) {
    console.warn('[t3-protections] contrôle de démarrage impossible :', String((e as Error)?.message ?? e).slice(0, 200));
    return null;
  }
}
