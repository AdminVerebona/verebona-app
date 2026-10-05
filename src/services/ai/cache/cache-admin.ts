/**
 * Caches de l'assistant et de l'IA : inventaire, état, invalidation — CDC
 * Assistant §31.6, §31.7, §32.6 (« consulter l'état des caches », « invalider
 * un cache »), §32.7 / CA-30 (journalisation) ; lot 23.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVENTAIRE
 *
 * Chaque cache est décrit (nature : portée, stockage, durée) et porte une
 * VERSION partagée (`verebona_cache_versions`) : c'est elle qui rend une
 * invalidation effective sur toutes les instances.
 *
 *   · retrieval            mémoire par instance, clé incluant la version
 *                          `global` + `account:<id>` (0209) → incrément de
 *                          `global` : aucune instance n'atteint plus une
 *                          entrée antérieure ;
 *   · ai-config            configuration IA effective + version tracée
 *                          (CFG-01) → incrément de `ai-config` ;
 *   · assistant-settings   réglages administrés (lot 21) → incrément de
 *                          `assistant-settings` (relecture ≤ 5 s) ;
 *   · help-corpus, pricing, prompts
 *                          mémoire par instance, sans version propre →
 *                          `cache:<id>`, relu par chaque instance toutes les
 *                          5 s (`shared-cache-invalidation.ts`) ;
 *   · assistant-model-responses, t4-temporal, gateway-idempotency
 *                          lignes de `ai_operation_idempotency` (base
 *                          partagée) → suppression des lignes, effective
 *                          partout immédiatement ; `cache:<id>` est aussi
 *                          incrémenté pour dater l'invalidation. Les clés
 *                          RÉSERVÉES (dernier corpus d'aide valide, PUB-01)
 *                          ne sont JAMAIS supprimées.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVALIDATION
 *
 * Administrateurs du BO seulement (garde de la route) ; motif obligatoire ;
 * journal admin existant (`admin_audit_log`, `AI_CACHE_INVALIDATE` : auteur,
 * date, cache, motif, effet). Un échec est aussi journalisé (FAILURE) puis
 * remonté à l'écran.
 *
 * Aucun contenu de conversation ni donnée de compte n'est lu ici : des
 * compteurs, des dates et des versions.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  SharedCacheInvalidator, sharedCacheScope, type SharedCacheVersionStore,
} from './shared-cache-invalidation';

export const ADMIN_CACHE_IDS = [
  'retrieval', 'ai-config', 'assistant-settings', 'help-corpus', 'pricing', 'prompts',
  'assistant-model-responses', 't4-temporal', 'gateway-idempotency',
] as const;
export type AdminCacheId = (typeof ADMIN_CACHE_IDS)[number];

export function isAdminCacheId(v: unknown): v is AdminCacheId {
  return typeof v === 'string' && (ADMIN_CACHE_IDS as readonly string[]).includes(v);
}

export interface AdminCacheDescriptor {
  id: AdminCacheId;
  label: string;
  /** Portée · stockage · durée (§31.6). */
  nature: string;
  /** Effet d'une invalidation. */
  invalidation: string;
  /** Périmètre de version partagée. */
  versionScope: string;
}

/** Préfixes de `ai_operation_idempotency` (constants : index `text_pattern_ops`, 0209). */
const PREFIXE_REPONSES = 'assistant:';
const PREFIXE_T4 = 't4-temporal:';

export const ADMIN_CACHES: readonly AdminCacheDescriptor[] = [
  {
    id: 'retrieval', label: 'Résultats de retrieval de l’assistant', versionScope: 'global',
    nature: 'Compte + utilisateur + requête · mémoire de chaque instance · ≤ 60 s (§31.6), clé versionnée par compte et globalement.',
    invalidation: 'Version globale incrémentée : plus aucune entrée antérieure n’est servie, sur aucune instance.',
  },
  {
    id: 'ai-config', label: 'Configuration IA effective (alias → modèles)', versionScope: 'ai-config',
    nature: 'Globale · mémoire de chaque instance · 30 s, clé de version partagée (CFG-01) ; résolution des alias de modèles (§31.6).',
    invalidation: 'Clé de version incrémentée : chaque instance recharge la configuration à l’appel suivant (≤ 1 s).',
  },
  {
    id: 'assistant-settings', label: 'Réglages administrés de l’assistant', versionScope: 'assistant-settings',
    nature: 'Globale · mémoire de chaque instance · relecture du compteur toutes les 5 s (lot 21).',
    invalidation: 'Compteur incrémenté : chaque instance relit les réglages en ≤ 5 s.',
  },
  {
    id: 'help-corpus', label: 'Corpus d’aide (articles publiés)', versionScope: sharedCacheScope('help-corpus'),
    nature: 'Globale par environnement · mémoire de chaque instance · 24 h (§31.6) ; dernier corpus valide conservé en base (PUB-01).',
    invalidation: 'Chaque instance relit le corpus publié au prochain accès (propagation ≤ 5 s). Le dernier corpus valide reste le repli.',
  },
  {
    id: 'pricing', label: 'Catalogue des prix des modèles', versionScope: sharedCacheScope('pricing'),
    nature: 'Globale · mémoire de chaque instance · chargé au démarrage (§15.9).',
    invalidation: 'Chaque instance recharge les tarifs depuis la base (propagation ≤ 5 s).',
  },
  {
    id: 'prompts', label: 'Prompts techniques du dépôt', versionScope: sharedCacheScope('prompts'),
    nature: 'Globale · mémoire de chaque instance · 60 s.',
    invalidation: 'Chaque instance relit les fichiers de prompts (propagation ≤ 5 s).',
  },
  {
    id: 'assistant-model-responses', label: 'Réponses modèle de l’assistant (même fil)', versionScope: sharedCacheScope('assistant-model-responses'),
    nature: 'Compte + conversation · base (`ai_operation_idempotency`, clés assistant:…) · retry technique immédiat (§31.6).',
    invalidation: 'Lignes supprimées en base : effectif partout immédiatement.',
  },
  {
    id: 't4-temporal', label: 'Arbitrages de dates ambiguës (T4)', versionScope: sharedCacheScope('t4-temporal'),
    nature: 'Compte + source · base (`ai_operation_idempotency`, clés t4-temporal:…) · 24 h (lot 22).',
    invalidation: 'Lignes supprimées en base : la prochaine ambiguïté rappelle le modèle.',
  },
  {
    id: 'gateway-idempotency', label: 'Résultats d’opérations IA (idempotence de la passerelle)', versionScope: sharedCacheScope('gateway-idempotency'),
    nature: 'Compte + objet + version de source + opération · base (`ai_operation_idempotency`) · 1 h par défaut (§5.7).',
    invalidation: 'Lignes supprimées en base, clés réservées exceptées (dernier corpus d’aide valide).',
  },
];

const PAR_ID = new Map(ADMIN_CACHES.map((c) => [c.id, c]));

// ── Invalidation partagée des caches mémoire sans version propre ────────────

/** Vidages locaux (chargements paresseux : aucun module lourd importé ici). */
export function registerLocalCaches(inv: SharedCacheInvalidator): SharedCacheInvalidator {
  return inv
    .register('help-corpus', async () => (await import('@/services/verebona-assistant/core/help-corpus.service')).invalidateHelpCorpusCache())
    .register('pricing', async () => { await (await import('@/services/ai/gateway/pricing/pricing.repository')).loadPricingCache(); })
    .register('prompts', async () => (await import('@/services/ai/prompts/prompt-loader')).invalidatePromptCache());
}

let instance: SharedCacheInvalidator | null = null;

/** Invalidation partagée de ce processus. */
export function sharedCacheInvalidator(): SharedCacheInvalidator {
  if (!instance) instance = registerLocalCaches(new SharedCacheInvalidator());
  return instance;
}

/** Réservé aux tests : remplace l'instance (`null` : défaut). */
export function setSharedCacheInvalidatorForTests(inv: SharedCacheInvalidator | null): void {
  instance?.stop();
  instance = inv;
}

/** Démarrage (instrumentation) : relecture périodique des versions `cache:%`. */
export function startSharedCacheInvalidation(): void {
  if (process.env.NODE_ENV === 'test') return;
  sharedCacheInvalidator().start();
}

// ── Accès base (injectable) ─────────────────────────────────────────────────

type Row = Record<string, unknown>;

export interface CacheAdminDb {
  /** Lecture en transaction `read only`, `statement_timeout` court. */
  read(sql: string, params?: unknown[]): Promise<Row[]>;
  /**
   * Écriture (suppression des lignes d'un cache) : nombre de lignes et
   * `partial` si la borne de temps a interrompu la suppression.
   */
  deleteRows(whereSql: string, params?: unknown[]): Promise<{ rows: number; partial: boolean }>;
}

const LECTURE_TIMEOUT_MS = 3_000;
const SUPPRESSION_LOT = 5_000;
const SUPPRESSION_MAX_MS = 60_000;

export const dbCacheAdmin: CacheAdminDb = {
  async read(sql, params = []) {
    const { pgClient } = await import('@/db');
    return (await pgClient.begin('read only', async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${LECTURE_TIMEOUT_MS}`);
      return tx.unsafe(sql, params as never[]);
    })) as unknown as Row[];
  },
  async deleteRows(whereSql, params = []) {
    const { pgClient } = await import('@/db');
    // Par lots (même principe que `purgeExpiredIdempotency`) : ni transaction
    // longue ni résultat massif en mémoire.
    const fin = Date.now() + SUPPRESSION_MAX_MS;
    let total = 0;
    for (;;) {
      const r = (await pgClient.unsafe(
        `DELETE FROM ai_operation_idempotency
          WHERE ctid IN (SELECT ctid FROM ai_operation_idempotency WHERE ${whereSql} LIMIT ${SUPPRESSION_LOT})`,
        params as never[],
      )) as unknown as { count?: number };
      const n = r.count ?? 0;
      total += n;
      if (n < SUPPRESSION_LOT) return { rows: total, partial: false };
      if (Date.now() >= fin) return { rows: total, partial: true };
    }
  },
};

let dbAdmin: CacheAdminDb = dbCacheAdmin;

/** Réservé aux tests (`null` : la base). */
export function setCacheAdminDbForTests(d: CacheAdminDb | null): void {
  dbAdmin = d ?? dbCacheAdmin;
}

/** Filtres SQL des familles de `ai_operation_idempotency` (constantes, sans paramètre). */
export async function idempotencyFamilySql(id: 'assistant-model-responses' | 't4-temporal' | 'gateway-idempotency'): Promise<string> {
  const { NOT_RESERVED_IDEMPOTENCY_KEY_SQL } = await import('@/services/ai/idempotency/idempotency.service');
  if (id === 'assistant-model-responses') return `key_hash LIKE '${PREFIXE_REPONSES}%'`;
  if (id === 't4-temporal') return `key_hash LIKE '${PREFIXE_T4}%'`;
  return `key_hash NOT LIKE '${PREFIXE_REPONSES}%' AND key_hash NOT LIKE '${PREFIXE_T4}%' AND ${NOT_RESERVED_IDEMPOTENCY_KEY_SQL}`;
}

// ── État ────────────────────────────────────────────────────────────────────

export interface AdminCacheState extends AdminCacheDescriptor {
  version: number | null;
  versionUpdatedAt: string | null;
  versionReason: string | null;
  /** Volumes mesurables (libellé → valeur ; `null` : non mesurable). */
  volume: Array<{ label: string; value: number | null }>;
  /** Âge de l'entrée la plus ancienne, ou du dernier chargement (secondes). */
  ageSeconds: number | null;
  /** Précisions (instance qui répond, repli…). */
  details: string[];
  lastInvalidation: { at: string; admin: string; reason: string | null } | null;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const age = (at: string | null, now: number): number | null =>
  at ? Math.max(0, Math.round((now - new Date(at).getTime()) / 1000)) : null;

async function lire(sql: string, params: unknown[], notes: string[], quoi: string): Promise<Row[] | null> {
  try {
    return await dbAdmin.read(sql, params);
  } catch (e) {
    notes.push(`${quoi} : lecture impossible (${(e as Error).message.slice(0, 120)}).`);
    return null;
  }
}

export interface CachesReport {
  instance: string;
  generatedAt: string;
  caches: AdminCacheState[];
  notes: string[];
}

/** État de tous les caches (versions partagées + mesures de l'instance qui répond). */
export async function getCachesState(now: Date = new Date()): Promise<CachesReport> {
  const notes: string[] = [];
  const t = now.getTime();
  const scopes = ADMIN_CACHES.map((c) => c.versionScope);
  const [versions, comptes, familles, corpusDb, reglages, journal] = await Promise.all([
    lire(`SELECT scope, version, last_reason, updated_at FROM verebona_cache_versions WHERE scope = ANY($1::text[])`, [scopes], notes, 'Versions partagées'),
    lire(`SELECT COUNT(*)::int AS n FROM verebona_cache_versions WHERE scope LIKE 'account:%'`, [], notes, 'Versions par compte'),
    (async () => {
      const [rep, t4, gw] = await Promise.all([
        idempotencyFamilySql('assistant-model-responses'), idempotencyFamilySql('t4-temporal'), idempotencyFamilySql('gateway-idempotency'),
      ]);
      return lire(
        `SELECT CASE WHEN ${rep} THEN 'assistant-model-responses' WHEN ${t4} THEN 't4-temporal'
                     WHEN ${gw} THEN 'gateway-idempotency' ELSE 'reserved' END AS famille,
                COUNT(*)::int AS n, COUNT(*) FILTER (WHERE expires_at <= now())::int AS expirees,
                MIN(created_at) AS plus_ancienne
           FROM ai_operation_idempotency GROUP BY 1`,
        [], notes, 'Entrées d’idempotence',
      );
    })(),
    lire(
      `SELECT key_hash, result_json->>'version' AS version, created_at FROM ai_operation_idempotency
        WHERE key_hash LIKE 'help-corpus:last-valid:%' ORDER BY created_at DESC LIMIT 5`,
      [], notes, 'Dernier corpus d’aide valide',
    ),
    lire(`SELECT COUNT(*)::int AS n, MAX(updated_at) AS dernier FROM verebona_assistant_settings`, [], notes, 'Réglages administrés'),
    lire(
      `SELECT DISTINCT ON (new_value->>'cache') new_value->>'cache' AS cache, timestamp, admin_email, new_value->>'reason' AS reason
         FROM admin_audit_log WHERE action_type = 'AI_CACHE_INVALIDATE' AND result = 'SUCCESS'
        ORDER BY new_value->>'cache', timestamp DESC`,
      [], notes, 'Journal des invalidations',
    ),
  ]);

  const v = new Map((versions ?? []).map((r) => [String(r.scope), r]));
  const fam = new Map((familles ?? []).map((r) => [String(r.famille), r]));
  const dernier = new Map((journal ?? []).map((r) => [String(r.cache), r]));

  const [retrieval, help, pricing, prompts, cfg] = await Promise.all([
    import('@/services/verebona-assistant/core/retrieval-cache'),
    import('@/services/verebona-assistant/core/help-corpus.service'),
    import('@/services/ai/gateway/pricing/pricing.repository'),
    import('@/services/ai/prompts/prompt-loader'),
    import('@/services/verebona-assistant/config/assistant-config'),
  ]);
  const config = cfg.getAssistantConfig();
  const sante = help.helpCorpusHealth();
  const prix = pricing.getCacheState();

  const caches = ADMIN_CACHES.map((c): AdminCacheState => {
    const ver = v.get(c.versionScope);
    const j = dernier.get(c.id);
    const base: AdminCacheState = {
      ...c,
      version: ver ? num(ver.version) : versions ? 0 : null,
      versionUpdatedAt: ver ? iso(ver.updated_at) : null,
      versionReason: ver?.last_reason == null ? null : String(ver.last_reason),
      volume: [], ageSeconds: null, details: [],
      lastInvalidation: j ? { at: iso(j.timestamp)!, admin: String(j.admin_email), reason: j.reason == null ? null : String(j.reason) } : null,
    };
    switch (c.id) {
      case 'retrieval':
        base.volume = [
          { label: 'entrées (cette instance)', value: retrieval.retrievalCacheSize() },
          { label: 'comptes versionnés', value: comptes ? num(comptes[0]?.n) : null },
        ];
        base.ageSeconds = age(base.versionUpdatedAt, t);
        base.details = [`Durée configurée : ${Math.min(config.retrievalCacheTtlSeconds, retrieval.RETRIEVAL_CACHE_MAX_TTL_SECONDS)} s.`];
        break;
      case 'ai-config':
      case 'pricing':
      case 'prompts':
        if (c.id === 'pricing') {
          base.volume = [{ label: 'tarifs chargés (cette instance)', value: prix.size }];
          base.ageSeconds = age(iso(prix.loadedAt), t);
          if (prix.degraded) base.details.push(`Dernier chargement en échec : ${prix.lastError ?? 'erreur inconnue'}.`);
        } else if (c.id === 'prompts') {
          base.volume = [{ label: 'prompts en cache (cette instance)', value: prompts.promptCacheSize() }];
        } else {
          base.ageSeconds = age(base.versionUpdatedAt, t);
        }
        break;
      case 'assistant-settings': {
        const r = reglages?.[0];
        base.volume = [{ label: 'réglages administrés', value: reglages ? num(r?.n) : null }];
        base.ageSeconds = age(r ? iso(r.dernier) : null, t);
        break;
      }
      case 'help-corpus': {
        base.volume = [{ label: 'copies « dernier valide » en base', value: corpusDb ? corpusDb.length : null }];
        base.ageSeconds = sante.lastValidAgeSeconds;
        base.details = [
          `Cette instance : ${sante.source === 'live' ? 'corpus publié' : sante.source === 'none' ? 'aucun corpus' : 'dernier corpus valide'}`
            + `${sante.version ? `, version ${sante.version}` : ''}${sante.alert ? ` — ${sante.alert.message}` : ''}.`,
          ...(corpusDb ?? []).map((r) => `En base : ${String(r.key_hash).replace('help-corpus:last-valid:', '')} · version ${String(r.version ?? '—')} · ${iso(r.created_at)}.`),
        ];
        break;
      }
      default: {
        const f = fam.get(c.id);
        base.volume = [
          { label: 'lignes', value: familles ? num(f?.n) ?? 0 : null },
          { label: 'expirées (purge quotidienne)', value: familles ? num(f?.expirees) ?? 0 : null },
        ];
        base.ageSeconds = age(f ? iso(f.plus_ancienne) : null, t);
      }
    }
    return base;
  });

  return {
    instance: (process.env.CONTAINER || process.env.HOSTNAME || 'instance').slice(0, 40),
    generatedAt: now.toISOString(),
    caches,
    notes: [
      'Volumes « cette instance » : mémoire de l’instance qui répond ; les autres instances ont leurs propres compteurs.',
      ...notes,
    ],
  };
}

// ── Invalidation ────────────────────────────────────────────────────────────

export class CacheInvalidationRefused extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'CacheInvalidationRefused';
  }
}

export const REASON_MIN = 5;
export const REASON_MAX = 500;

export interface InvalidationResult {
  cache: AdminCacheId;
  /** Effet constaté (lignes supprimées, périmètre incrémenté). */
  effect: { scope: string; rowsDeleted?: number; partial?: boolean };
}

export interface InvalidationDeps {
  /** Stockage des versions `cache:%` (défaut : l'instance du processus). */
  invalidator?: SharedCacheInvalidator;
  /** Journal admin (défaut : `logAdminAction`). */
  audit?: (e: import('@/lib/admin-audit').AdminActionEntry) => Promise<void>;
}

async function journal(deps: InvalidationDeps, e: import('@/lib/admin-audit').AdminActionEntry): Promise<void> {
  if (deps.audit) return deps.audit(e);
  const { logAdminAction } = await import('@/lib/admin-audit');
  return logAdminAction(e);
}

/**
 * Invalide un cache sur toutes les instances, journalise auteur, date, cache
 * et motif. Lève `CacheInvalidationRefused` (cache inconnu, motif absent) ou
 * l'erreur technique (journalisée FAILURE).
 */
export async function invalidateAdminCache(
  p: { cacheId: unknown; reason: unknown; adminId: number; adminEmail?: string },
  deps: InvalidationDeps = {},
): Promise<InvalidationResult> {
  if (!isAdminCacheId(p.cacheId)) {
    throw new CacheInvalidationRefused('UNKNOWN_CACHE', `Cache inconnu « ${String(p.cacheId).slice(0, 60)} ».`);
  }
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  if (reason.length < REASON_MIN) {
    throw new CacheInvalidationRefused('REASON_REQUIRED', `Motif obligatoire (${REASON_MIN} caractères au moins).`);
  }
  if (reason.length > REASON_MAX) {
    throw new CacheInvalidationRefused('REASON_TOO_LONG', `Motif trop long (${REASON_MAX} caractères au plus).`);
  }
  const c = PAR_ID.get(p.cacheId)!;
  const inv = deps.invalidator ?? sharedCacheInvalidator();
  const marque = `admin:${p.adminId}`;
  const entree = {
    adminId: p.adminId, adminEmail: p.adminEmail, action: 'AI_CACHE_INVALIDATE' as const, targetType: 'AI_CACHE' as const,
    targetId: null,
  };
  try {
    const effect: InvalidationResult['effect'] = { scope: c.versionScope };
    switch (c.id) {
      case 'retrieval': {
        const { bumpRetrievalCacheVersion, clearRetrievalCache } = await import('@/services/verebona-assistant/core/retrieval-cache');
        await bumpRetrievalCacheVersion(null, marque);
        clearRetrievalCache();
        break;
      }
      case 'ai-config': {
        const [{ bumpConfigVersionCounter }, { invalidateConfigCache }, { invalidateConfigVersionCache }] = await Promise.all([
          import('@/services/ai/config/config-cache-version'), import('@/services/ai/config/config-resolver'),
          import('@/services/ai/telemetry/execution-context'),
        ]);
        invalidateConfigCache();
        invalidateConfigVersionCache();
        if (!(await bumpConfigVersionCounter(marque))) throw new Error('clé de version de la configuration IA non incrémentée');
        break;
      }
      case 'assistant-settings': {
        const { ASSISTANT_SETTINGS_CACHE_SCOPE, refreshAssistantSettings } = await import('@/services/verebona-assistant/config/assistant-settings');
        await inv.bumpScope(ASSISTANT_SETTINGS_CACHE_SCOPE, marque);
        await refreshAssistantSettings(true);
        break;
      }
      case 'help-corpus':
      case 'pricing':
      case 'prompts':
        await inv.invalidate(c.id, marque);
        break;
      default: {
        const d = await dbAdmin.deleteRows(await idempotencyFamilySql(c.id));
        effect.rowsDeleted = d.rows;
        // M-2 : suppression interrompue par la borne de temps — dit au journal et à l'écran.
        if (d.partial) effect.partial = true;
        await inv.invalidate(c.id, marque);
      }
    }
    await journal(deps, { ...entree, result: 'SUCCESS', after: { cache: c.id, reason }, details: { label: c.label, ...effect } });
    return { cache: c.id, effect };
  } catch (e) {
    await journal(deps, {
      ...entree, result: 'FAILURE', after: { cache: c.id, reason }, details: { label: c.label, error: (e as Error).message.slice(0, 200) },
    }).catch(() => undefined);
    throw e;
  }
}

export type { SharedCacheVersionStore };
