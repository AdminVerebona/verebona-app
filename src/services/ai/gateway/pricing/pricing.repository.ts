/**
 * Catalogue tarifaire — lecture et écriture.
 *
 * Le calcul de coût est synchrone dans la gateway : les tarifs sont donc
 * maintenus dans un cache mémoire, chargé au démarrage et rafraîchi par le lot
 * planifié. Aucun accès base n'a lieu pendant un appel modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 109L — PRIORITÉ DES SOURCES, TOUTES LES INSTANCES, STALE
 *
 * PRIORITÉ EXPLICITE (`sourceRank`, testée) parmi les tarifs valides
 * (`effective_from <= maintenant`, jamais retirés) :
 *   0. saisie manuelle VÉRIFIÉE (sourcée : URL, date du document, opérateur) ;
 *   1. grille du compte VÉRIFIÉE (`billing_api`, seulement si validée pour la
 *      Gemini Developer API — désactivée par défaut, voir gemini-pricing.source) ;
 *   2. tarif public synchronisé depuis la page officielle (`public_catalog`) ;
 *   3. saisie manuelle non vérifiée ; 4. grille du compte non vérifiée.
 * À rang égal, le plus récent. Une synchronisation publique n'écrase donc
 * jamais une correction mieux vérifiée ; le BO signale l'écart éventuel.
 *
 * TOUTES LES INSTANCES : chaque écriture incrémente la clé partagée
 * `verebona_cache_versions` (périmètre `ai-pricing`) ; chaque instance la
 * relit (≤ 30 s, `refreshPricingCacheIfStale`) et recharge son cache ; au-delà
 * de `PRICING_CACHE_MAX_AGE_MS` sans relecture possible, rechargement forcé.
 * Un appel IA ne reste donc jamais indéfiniment sur un vieux prix.
 *
 * STALE : un tarif dont la dernière lecture de la page ne l'a pas confirmé
 * reste servi (dernier montant documenté) mais porte `stale: true`, figé dans
 * la référence tarifaire de la trace — jamais présenté comme certifié courant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { hostname } from 'node:os';
import { pgClient } from '@/db';
import type { ModelPrice } from './pricing-source.port';
import type { PriceTier } from './google-pricing-page.adapter';

export type PriceSource = 'billing_api' | 'public_catalog' | 'manual';

export interface CachedPrice extends ModelPrice {
  verified: boolean;
  fetchedAt: Date;
  source: PriceSource;
  /** Paliers (lot 35B, migration 0304) — ex. au-delà de 200 000 jetons d'invite. */
  tiers?: PriceTier[] | null;
  /** Lot 109L : identifiant de la ligne `ai_model_pricing` appliquée. */
  id?: number;
  /** Lot 109L : début de validité de la ligne. */
  effectiveFrom?: Date;
  /** Lot 109L : non confirmé par la dernière lecture de la source (STALE). */
  stale?: boolean;
  /**
   * Lot 114 (#770) : statut de la DERNIÈRE lecture validée de la page officielle pour ce modèle
   * (`ai_model_price_status`) ; absent : jamais évalué par la synchronisation. Sert à l'éligibilité tarifaire.
   */
  pageStatus?: 'KNOWN' | 'STALE' | 'UNKNOWN' | null;
  /** Depuis quand la page ne confirme plus ce tarif (`STALE`). */
  staleSince?: Date | null;
}

const cache = new Map<string, CachedPrice>();
let loadedAt: Date | null = null;
let degraded = false;
let lastError: string | null = null;
let loadedVersion: number | null = null;

/** PostgreSQL `undefined_table` — la migration 0111 n'est pas encore appliquée. */
const UNDEFINED_TABLE = '42P01';
/** Périmètre de la clé de version partagée (`verebona_cache_versions`, 0209). */
export const PRICING_CACHE_SCOPE = 'ai-pricing';
/** Relecture de la clé partagée au plus toutes les… */
export const PRICING_VERSION_CHECK_MS = 30_000;
/** Rechargement forcé au-delà de… (clé illisible, instance isolée). */
export const PRICING_CACHE_MAX_AGE_MS = 15 * 60_000;

function key(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Rang de priorité d'une source (0 = la plus fiable). Pur, testé. */
export function sourceRank(source: string, verified: boolean): number {
  if (source === 'manual' && verified) return 0;
  if (source === 'billing_api' && verified) return 1;
  if (source === 'public_catalog') return 2;
  if (source === 'manual') return 3;
  return 4;
}

interface PriceRow {
  id?: number; provider: string; model: string; input_micros: unknown; output_micros: unknown; currency: unknown;
  source: unknown; source_reference: unknown; verified: unknown; fetched_at: unknown; effective_from?: unknown; tiers?: unknown;
  stale?: unknown; page_status?: unknown; stale_since?: unknown;
}

/** Choisit, par modèle, la ligne applicable selon la priorité des sources (pur). */
export function selectApplicablePrices(rows: readonly PriceRow[]): CachedPrice[] {
  const best = new Map<string, { rank: number; at: number; p: CachedPrice }>();
  for (const r of rows) {
    const p: CachedPrice = {
      provider: String(r.provider),
      model: String(r.model),
      inputMicros: Number(r.input_micros),
      outputMicros: Number(r.output_micros),
      currency: String(r.currency),
      source: r.source as PriceSource,
      sourceReference: r.source_reference ? String(r.source_reference) : undefined,
      verified: Boolean(r.verified),
      fetchedAt: new Date(String(r.fetched_at)),
      tiers: Array.isArray(r.tiers) ? (r.tiers as PriceTier[]) : null,
      ...(r.id != null ? { id: Number(r.id) } : {}),
      ...(r.effective_from != null ? { effectiveFrom: new Date(String(r.effective_from)) } : {}),
      ...(r.stale === true && r.source === 'public_catalog' ? { stale: true } : {}),
      ...(r.page_status === 'KNOWN' || r.page_status === 'STALE' || r.page_status === 'UNKNOWN' ? { pageStatus: r.page_status } : {}),
      ...(r.stale_since != null ? { staleSince: new Date(String(r.stale_since)) } : {}),
    };
    const rank = sourceRank(p.source, p.verified);
    const at = p.effectiveFrom?.getTime() ?? 0;
    const k = key(p.provider, p.model);
    const cur = best.get(k);
    if (!cur || rank < cur.rank || (rank === cur.rank && at > cur.at)) best.set(k, { rank, at, p });
  }
  return [...best.values()].map((x) => x.p);
}

/**
 * Charge le tarif applicable de chaque modèle. À appeler au démarrage.
 *
 * ⚠️ NE LÈVE JAMAIS. Le premier déploiement lit forcément cette table avant
 * qu'elle n'existe : `ensureMigrations()` et le chargement du cache sont dans le
 * même processus de démarrage, et une exception ici empêchait purement et
 * simplement l'application de démarrer.
 *
 * L'échec est donc absorbé, mais jamais silencieux : le cache passe en état
 * `degraded`, visible en administration et exploité par `assertPricingReady()`.
 * Un coût non mesurable reste préférable à un coût inventé — et très préférable
 * à une application qui ne démarre pas.
 *
 * @returns nombre de tarifs chargés (0 si la table est absente ou illisible).
 */
export async function loadPricingCache(): Promise<number> {
  let rows: unknown;
  const version = await readPricingVersion();
  try {
    try {
      // Lot 109L : toutes les lignes valides (la priorité est appliquée en JS),
      // statut STALE joint. Lot 35B (0304) : une ligne retirée n'est plus servie.
      rows = await pgClient.unsafe(
        `SELECT p.id, p.provider, p.model, p.input_micros, p.output_micros, p.currency,
                p.source, p.source_reference, p.verified, p.fetched_at, p.effective_from, p.tiers,
                (s.status = 'STALE') AS stale, s.status AS page_status, s.stale_since
           FROM ai_model_pricing p
           LEFT JOIN ai_model_price_status s ON s.provider = p.provider AND s.model = p.model
          WHERE p.effective_from <= NOW() AND p.invalidated_at IS NULL`,
      );
    } catch (e) {
      // 42703 / 42P01 : migration 0304 pas encore appliquée — lecture historique
      // (la table `ai_model_pricing` absente lève à nouveau : état dégradé).
      const code = (e as { code?: string }).code;
      if (code !== '42703' && code !== UNDEFINED_TABLE) throw e;
      rows = await pgClient.unsafe(
        `SELECT id, provider, model, input_micros, output_micros, currency,
                source, source_reference, verified, fetched_at, effective_from
           FROM ai_model_pricing
          WHERE effective_from <= NOW()`,
      );
    }
  } catch (e) {
    const err = e as { code?: string; message?: string };
    cache.clear();
    loadedAt = new Date();
    degraded = true;
    lastError = err.message ?? String(e);

    if (err.code === UNDEFINED_TABLE) {
      console.warn(
        '[ai-cost] Table `ai_model_pricing` absente — catalogue tarifaire vide. ' +
        'Appliquez la migration 0111, puis /api/cron/ai/refresh-model-pricing.',
      );
    } else {
      console.error(`[ai-cost] Catalogue tarifaire illisible : ${lastError}`);
    }
    void recordCacheInstance();
    return 0;
  }

  cache.clear();
  primed = false;
  for (const p of selectApplicablePrices(rows as PriceRow[])) cache.set(key(p.provider, p.model), p);

  loadedAt = new Date();
  degraded = false;
  lastError = null;
  loadedVersion = version;
  lastVersionCheckAt = Date.now();
  void recordCacheInstance();
  return cache.size;
}

/** Identifiant de cette instance (conteneur Scalingo `CONTAINER`, sinon hôte) et processus. */
export function pricingInstanceId(): string {
  let host = process.env.CONTAINER || process.env.HOSTNAME || '';
  if (!host) { try { host = hostname(); } catch { host = 'instance'; } }
  return `${host}#${process.pid}`.slice(0, 120);
}

/**
 * Lot 113O (migration 1522) : état du cache de CETTE instance (version
 * partagée chargée, heure, taille, dégradé) — comparé entre instances par le
 * rapport de réconciliation. Ne lève jamais.
 */
async function recordCacheInstance(): Promise<void> {
  if (process.env.NODE_ENV === 'test' && !process.env.E2E_DATABASE_URL) return;
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_pricing_cache_instances (instance_id, version, loaded_at, prices, degraded, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (instance_id) DO UPDATE SET version = EXCLUDED.version, loaded_at = EXCLUDED.loaded_at, prices = EXCLUDED.prices,
         degraded = EXCLUDED.degraded, last_error = EXCLUDED.last_error, updated_at = NOW()`,
      [pricingInstanceId(), loadedVersion, (loadedAt ?? new Date()).toISOString(), cache.size, degraded, lastError?.slice(0, 300) ?? null] as never[],
    );
  } catch { /* migration 1522 absente : sans effet */ }
}

/**
 * Amorce le cache sans passer par la base.
 *
 * Réservé aux tests et à un amorçage local. En production, le cache est
 * alimenté par `loadPricingCache()` depuis `ai_model_pricing`.
 */
export function primePricingCache(prices: CachedPrice[]): void {
  // Amorçage manuel : aucune relecture automatique ne doit l'écraser.
  primed = true;
  for (const p of prices) cache.set(key(p.provider, p.model), p);
  loadedAt = new Date();
  degraded = false;
  lastError = null;
}

export function clearPricingCache(): void {
  primed = false;
  cache.clear();
  loadedAt = null;
  degraded = false;
  lastError = null;
  loadedVersion = null;
  lastVersionCheckAt = 0;
}

export function getCachedPrice(provider: string, model: string): CachedPrice | null {
  return cache.get(key(provider, model)) ?? (verifiedTestPricesActive() ? testPrice(provider, model) : null);
}

// ── Lot 114 (Trello #770) : socle de TEST ───────────────────────────────────
// Depuis #770, aucun modèle n'est appelé sans tarif officiel vérifié. Les suites
// de tests sollicitent la passerelle avec un fournisseur simulé et des modèles
// fictifs : le socle de test peut déclarer que tout modèle SANS ligne au cache
// porte une preuve tarifaire de test (grille du compte, vérifiée, montant 0).
// Refusé ET ignoré hors `NODE_ENV=test` : ce n'est pas un contournement de la garde. L'état est porté par une clé
// globale (comme les autres réglages de test du dépôt) : il survit à `vi.resetModules()`.
const TEST_PRICES_KEY = Symbol.for('verebona.ai.verifiedTestPrices');
const testPrice = (provider: string, model: string): CachedPrice => ({
  provider, model, inputMicros: 0, outputMicros: 0, currency: 'USD', source: 'billing_api',
  sourceReference: 'test:tarif-verifie', verified: true, fetchedAt: new Date('2026-01-01T00:00:00Z'),
});
export function __setVerifiedTestPricesForTests(on: boolean): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('__setVerifiedTestPricesForTests : réservé aux tests');
  (globalThis as unknown as Record<symbol, boolean>)[TEST_PRICES_KEY] = on;
}

/** Socle de test actif (#770) — voir `__setVerifiedTestPricesForTests`. */
export function verifiedTestPricesActive(): boolean {
  return process.env.NODE_ENV === 'test' && (globalThis as unknown as Record<symbol, boolean>)[TEST_PRICES_KEY] === true;
}

/** État du référentiel vu par l'éligibilité tarifaire (#770) : jamais chargé ou illisible = refus. */
export function pricingReadState(): { degraded: boolean; loaded: boolean } {
  if (verifiedTestPricesActive()) return { degraded: false, loaded: true };
  return { degraded, loaded: loadedAt !== null };
}

interface PricingCacheState {
  size: number;
  loadedAt: Date | null;
  /** Le dernier chargement a échoué : les coûts ne sont pas mesurables. */
  degraded: boolean;
  lastError: string | null;
  /** Lot 109L : version partagée chargée (`null` : clé illisible). */
  version?: number | null;
}

export function getCacheState(): PricingCacheState {
  return { size: cache.size, loadedAt, degraded, lastError, version: loadedVersion };
}

// ── Lot 109L : clé de version partagée entre instances ─────────────────────

let lastVersionCheckAt = 0;
let refreshing: Promise<boolean> | null = null;
let primed = false;

/** Lecture de la clé partagée ; `null` si illisible. Ne lève jamais. */
export async function readPricingVersion(): Promise<number | null> {
  if (process.env.NODE_ENV === 'test' && !process.env.E2E_DATABASE_URL) return null;
  try {
    const rows = (await pgClient.unsafe(
      `SELECT version FROM verebona_cache_versions WHERE scope = $1`, [PRICING_CACHE_SCOPE] as never[],
    )) as unknown as Array<{ version: string | number }>;
    return rows[0] ? Number(rows[0].version) : 0;
  } catch { return null; }
}

/** Incrémente la clé partagée après toute écriture tarifaire. Ne lève jamais. */
export async function bumpPricingVersion(reason: string): Promise<void> {
  // Tests unitaires : aucune connexion (convention de `db/index.ts`).
  if (process.env.NODE_ENV === 'test' && !process.env.E2E_DATABASE_URL) return;
  try {
    await pgClient.unsafe(
      `INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at)
       VALUES ($1, 1, $2, now())
       ON CONFLICT (scope) DO UPDATE SET version = verebona_cache_versions.version + 1,
         last_reason = EXCLUDED.last_reason, updated_at = now()`,
      [PRICING_CACHE_SCOPE, reason.slice(0, 60)] as never[],
    );
  } catch (e) {
    console.warn('[ai-cost] clé de version tarifaire non incrémentée — les autres instances suivront à expiration :', (e as Error).message);
  }
}

/**
 * Recharge le cache si une autre instance a écrit un tarif (clé partagée), ou
 * s'il est plus vieux que `PRICING_CACHE_MAX_AGE_MS`. Lectures regroupées,
 * au plus une toutes les `PRICING_VERSION_CHECK_MS`. Ne lève jamais.
 * @returns vrai si le cache a été rechargé.
 */
export async function refreshPricingCacheIfStale(now: number = Date.now()): Promise<boolean> {
  if (refreshing) return refreshing;
  if (primed) return false;
  if (process.env.NODE_ENV === 'test' && !process.env.E2E_DATABASE_URL) return false;
  // Jamais chargé : c'est au démarrage (`assertPricingReady`) de le faire.
  if (loadedAt === null) return false;
  if (loadedAt !== null && now - lastVersionCheckAt < PRICING_VERSION_CHECK_MS) return false;
  refreshing = (async () => {
    try {
      lastVersionCheckAt = now;
      const tooOld = loadedAt === null || now - loadedAt.getTime() > PRICING_CACHE_MAX_AGE_MS;
      const v = await readPricingVersion();
      if (tooOld || (v !== null && v !== loadedVersion)) { await loadPricingCache(); return true; }
      return false;
    } catch { return false; } finally { refreshing = null; }
  })();
  return refreshing;
}

let watcher: ReturnType<typeof setInterval> | null = null;

/** Surveillance périodique (démarrage). Jamais en test unitaire. */
export function startPricingCacheWatcher(): void {
  if (watcher || process.env.NODE_ENV === 'test') return;
  watcher = setInterval(() => { void refreshPricingCacheIfStale(); }, PRICING_VERSION_CHECK_MS);
  watcher.unref?.();
}

// ── Écritures ───────────────────────────────────────────────────────────────

export interface PriceEvidence {
  /** URL du document source (obligatoire pour une saisie manuelle). */
  sourceUrl?: string;
  /** Date du document / du relevé (AAAA-MM-JJ). */
  documentDate?: string;
  note?: string;
  operatorUserId?: number | null;
  /** Mode payant, palier, modalité vérifiés par l'opérateur. */
  paidTier?: boolean;
  tier?: 'standard';
  modality?: 'text_image_pdf';
  thinkingIncluded?: boolean;
  pageFingerprint?: string;
}

/**
 * Enregistre un tarif. Une nouvelle ligne est créée à chaque relevé : un coût
 * passé doit rester explicable avec le tarif en vigueur au moment de l'appel.
 * Lot 109L : `effectiveFrom` (saisie manuelle documentée d'une validité passée)
 * et `evidence` (preuve) facultatifs ; la clé partagée est incrémentée.
 */
export async function upsertPrice(
  price: ModelPrice & { tiers?: PriceTier[] | null },
  source: PriceSource,
  verified: boolean,
  verifiedBy?: number,
  opts: { effectiveFrom?: Date; evidence?: PriceEvidence | null } = {},
): Promise<number | null> {
  const params = [
    price.provider, price.model, price.inputMicros, price.outputMicros,
    price.currency, source, price.sourceReference ?? null, verified,
    verifiedBy ?? null, opts.effectiveFrom ? opts.effectiveFrom.toISOString() : null,
  ];
  const withTiers = Boolean(price.tiers && price.tiers.length > 0);
  const extra = opts.evidence ? ', evidence' : '';
  const extraV = opts.evidence ? `, $${withTiers ? 12 : 11}::jsonb` : '';
  const all = [...params, ...(withTiers ? [JSON.stringify(price.tiers)] : []), ...(opts.evidence ? [JSON.stringify(opts.evidence)] : [])];
  const rows = await pgClient.unsafe(
    `INSERT INTO ai_model_pricing (
       provider, model, input_micros, output_micros, currency,
       source, source_reference, verified, verified_by, effective_from, fetched_at${withTiers ? ', tiers' : ''}${extra}
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, NOW()),NOW()${withTiers ? ',$11::jsonb' : ''}${extraV})
     ON CONFLICT (provider, model, effective_from) DO UPDATE SET
       input_micros = EXCLUDED.input_micros,
       output_micros = EXCLUDED.output_micros${withTiers ? ',\n       tiers = EXCLUDED.tiers' : ''},
       fetched_at = NOW()
     RETURNING id`,
    all as never[],
  );
  await bumpPricingVersion(`upsert ${source} ${price.model}`);
  return (rows as unknown as Array<{ id: number }> | undefined)?.[0]?.id ?? null;
}

/**
 * Retire les tarifs PUBLICS d'un modèle. Lot 109L : JAMAIS appelé par la
 * synchronisation sur une simple lecture ambiguë ou un format inconnu — seulement
 * après une vérification POSITIVE et ciblée (modèle absent de lectures saines
 * successives, retrait confirmé par un administrateur), motif tracé. Les lignes
 * restent (historique) ; les coûts déjà tracés ne sont pas touchés.
 */
export async function invalidatePublicPrices(provider: string, model: string, reason = 'retrait vérifié', byUserId: number | null = null): Promise<number> {
  let rows: unknown;
  try {
    rows = await pgClient.unsafe(
      `UPDATE ai_model_pricing SET invalidated_at = NOW(), invalidated_reason = $3, invalidated_by = $4
        WHERE provider = $1 AND model = $2 AND source = 'public_catalog' AND invalidated_at IS NULL
        RETURNING id`,
      [provider, model, reason.slice(0, 300), byUserId] as never[],
    );
  } catch (e) {
    if ((e as { code?: string }).code !== '42703') throw e;
    rows = await pgClient.unsafe(
      `UPDATE ai_model_pricing SET invalidated_at = NOW()
        WHERE provider = $1 AND model = $2 AND source = 'public_catalog' AND invalidated_at IS NULL
        RETURNING id`,
      [provider, model] as never[],
    );
  }
  await bumpPricingVersion(`invalidate ${model}`);
  return (rows as unknown as unknown[] | undefined)?.length ?? 0;
}
