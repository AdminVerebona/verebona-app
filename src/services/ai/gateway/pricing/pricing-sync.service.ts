/**
 * Synchronisation du catalogue TARIFAIRE — lot 35B, ticket « Catalogue IA
 * dynamique Google » (migration 0304).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE, HISTORIQUE, JAMAIS D'INVENTION
 *
 *   1. lit la page officielle (`google-pricing-page.adapter.ts`, export
 *      Markdown de https://ai.google.dev/gemini-api/docs/pricing) ;
 *   2. pour chaque modèle demandé : KNOWN (montants, paliers, devise) ou
 *      UNKNOWN (raison) — `ai_model_price_status` ;
 *   3. un changement (montant, palier, statut) est HISTORISÉ
 *      (`ai_model_price_changes` : ancienne valeur, nouvelle valeur, date) et
 *      un nouveau tarif est inscrit dans `ai_model_pricing` à partir de
 *      maintenant (`effective_from`) ; les coûts PASSÉS, figés dans chaque
 *      trace au moment de l'appel, ne sont jamais revalorisés ;
 *   4. un modèle devenu UNKNOWN voit ses tarifs publics RETIRÉS
 *      (`invalidated_at`) : un tarif dont la correspondance avec le modèle
 *      n'est plus certaine ne reste pas valide.
 *
 * ÉCHEC DE LECTURE (page injoignable, structure non reconnue) : rien n'est
 * écrit, l'état connu est conservé, l'échec est journalisé et signalé. Ne lève
 * jamais : une panne de la source tarifaire ne bloque ni le démarrage, ni la
 * synchronisation des modèles, ni l'utilisation d'un modèle.
 *
 * La grille du compte (Cloud Billing, `GOOGLE_BILLING_API_KEY`) reste une
 * surcouche facultative, prioritaire quand elle est configurée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  GOOGLE_PRICING_SOURCE, GOOGLE_PRICING_SOURCE_URL, parseGooglePricingMarkdown, resolveModelPrice,
  type PriceTier, type ResolvedPrice,
} from './google-pricing-page.adapter';
import { invalidatePublicPrices, loadPricingCache, getCachedPrice, upsertPrice } from './pricing.repository';
import type { PricingSource } from './pricing-source.port';

type Row = Record<string, unknown>;

export interface PriceStatusRow {
  model: string;
  status: 'KNOWN' | 'UNKNOWN';
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  tiers: PriceTier[] | null;
  currency: string | null;
  source: string;
  sourceUrl: string | null;
  reason: string | null;
  fetchedAt: string;
  lastChangedAt: string | null;
}

export interface PricingSyncResult {
  status: 'completed' | 'partial' | 'failed' | 'skipped';
  /** Page lue et reconnue. */
  sourceRead: boolean;
  known: string[];
  unknown: Array<{ model: string; reason: string }>;
  changed: Array<{ model: string; from: string; to: string }>;
  error?: string;
}

export interface PricingSyncDeps {
  /** Lecture de la page (injectable : fixtures en test, réseau en exploitation). */
  fetchPage?: () => Promise<string>;
  now?: () => Date;
  /** Grille du compte (facultative). */
  billing?: PricingSource | null;
}

async function fetchOfficialPage(): Promise<string> {
  const res = await fetch(GOOGLE_PRICING_SOURCE_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`page tarifaire : HTTP ${res.status}`);
  return res.text();
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fmt = (s: { status: string; inputPerMillion: number | null; outputPerMillion: number | null }) =>
  s.status === 'KNOWN' ? `${s.inputPerMillion} $ / ${s.outputPerMillion} $` : 'UNKNOWN';

/** État courant (écran BO, contrôles). Table absente : vide. */
export async function loadPriceStatuses(): Promise<Map<string, PriceStatusRow>> {
  const out = new Map<string, PriceStatusRow>();
  try {
    const rows = (await pgClient.unsafe(
      `SELECT model, status, input_per_million, output_per_million, tiers, currency, source, source_url, reason,
              fetched_at, last_changed_at
         FROM ai_model_price_status WHERE provider = 'gemini'`,
    )) as unknown as Row[];
    for (const r of rows) {
      out.set(String(r.model), {
        model: String(r.model),
        status: r.status === 'KNOWN' ? 'KNOWN' : 'UNKNOWN',
        inputPerMillion: num(r.input_per_million),
        outputPerMillion: num(r.output_per_million),
        tiers: Array.isArray(r.tiers) ? (r.tiers as PriceTier[]) : null,
        currency: r.currency == null ? null : String(r.currency),
        source: String(r.source),
        sourceUrl: r.source_url == null ? null : String(r.source_url),
        reason: r.reason == null ? null : String(r.reason),
        fetchedAt: new Date(String(r.fetched_at)).toISOString(),
        lastChangedAt: r.last_changed_at == null ? null : new Date(String(r.last_changed_at)).toISOString(),
      });
    }
  } catch { /* migration 0304 absente */ }
  return out;
}

/** Le tarif résolu diffère-t-il de l'état enregistré ? (pur) */
export function priceChanged(prev: PriceStatusRow | undefined, next: ResolvedPrice): boolean {
  if (!prev) return true;
  if (prev.status !== next.status) return true;
  if (next.status === 'UNKNOWN') return false;
  return prev.inputPerMillion !== next.inputPerMillion
    || prev.outputPerMillion !== next.outputPerMillion
    || JSON.stringify(prev.tiers ?? []) !== JSON.stringify(next.tiers ?? []);
}

async function openLog(): Promise<number | null> {
  try {
    const rows = await pgClient.unsafe(`INSERT INTO ai_model_pricing_refresh_log (status) VALUES ('running') RETURNING id`);
    return (rows as unknown as Array<{ id: number }>)[0]?.id ?? null;
  } catch { return null; }
}

async function closeLog(id: number | null, r: PricingSyncResult): Promise<void> {
  if (id === null) return;
  await pgClient.unsafe(
    `UPDATE ai_model_pricing_refresh_log
        SET status = $2, finished_at = NOW(), models_found = $3, models_updated = $4,
            models_missing = $5::jsonb, error_message = $6
      WHERE id = $1`,
    [id, r.status === 'skipped' ? 'failed' : r.status, r.known.length, r.changed.length,
      JSON.stringify(r.unknown.map((u) => u.model)), r.error ?? null] as never[],
  ).catch(() => undefined);
}

/**
 * Synchronise les tarifs des modèles demandés (catalogue découvert + modèles
 * des configurations et du référentiel). Ne lève jamais.
 */
export async function syncPricingCatalog(models: readonly string[], deps: PricingSyncDeps = {}): Promise<PricingSyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: PricingSyncResult = { status: 'completed', sourceRead: false, known: [], unknown: [], changed: [] };
  const logId = await openLog();
  const wanted = [...new Set(models.filter((m) => typeof m === 'string' && m.trim() !== ''))].sort();

  let page;
  try {
    const md = await (deps.fetchPage ?? fetchOfficialPage)();
    page = parseGooglePricingMarkdown(md);
  } catch (e) {
    page = { ok: false as const, reason: `page tarifaire injoignable : ${(e as Error).message.slice(0, 200)}` };
  }

  if (!page.ok) {
    result.status = 'failed';
    result.error = page.reason;
    console.warn(`[pricing-sync] lecture impossible (${page.reason}) — tarifs connus conservés.`);
    await raisePricingAlert(page.reason, now);
  } else {
    result.sourceRead = true;
    const { getCacheState } = await import('./pricing.repository');
    if (getCacheState().loadedAt === null) await loadPricingCache().catch(() => 0);
    const prev = await loadPriceStatuses();
    const ref = `${GOOGLE_PRICING_SOURCE}:${now.toISOString().slice(0, 10)}`;
    for (const model of wanted) {
      const r = resolveModelPrice(page, model, now);
      if (r.status === 'KNOWN') result.known.push(model); else result.unknown.push({ model, reason: r.reason });
      const avant = prev.get(model);
      try {
        if (priceChanged(avant, r)) {
          await recordChange(model, avant, r, now);
          result.changed.push({ model, from: avant ? fmt(avant) : 'aucun', to: fmt(r.status === 'KNOWN' ? r : { status: 'UNKNOWN', inputPerMillion: null, outputPerMillion: null }) });
          if (r.status === 'KNOWN') {
            await upsertPrice({
              provider: 'gemini', model,
              // $/million de jetons ≡ micro-dollars/jeton : la conversion est l'identité.
              inputMicros: r.inputPerMillion, outputMicros: r.outputPerMillion,
              currency: r.currency, sourceReference: ref, tiers: r.tiers,
            }, 'public_catalog', false);
          } else {
            await invalidatePublicPrices('gemini', model);
          }
        } else {
          await pgClient.unsafe(
            `UPDATE ai_model_price_status SET fetched_at = $2, reason = $3 WHERE provider = 'gemini' AND model = $1`,
            [model, now.toISOString(), r.status === 'UNKNOWN' ? r.reason : null] as never[],
          );
          // Tarif KNOWN inchangé mais absent du calcul (amorçage, ligne
          // retirée) : il y est réinscrit, à la même valeur.
          if (r.status === 'UNKNOWN' && getCachedPrice('gemini', model)?.source === 'public_catalog') {
            await invalidatePublicPrices('gemini', model);
          }
          if (r.status === 'KNOWN' && !getCachedPrice('gemini', model)) {
            await upsertPrice({
              provider: 'gemini', model, inputMicros: r.inputPerMillion, outputMicros: r.outputPerMillion,
              currency: r.currency, sourceReference: ref, tiers: r.tiers,
            }, 'public_catalog', false);
          }
        }
      } catch (e) {
        result.status = 'partial';
        result.error = `écriture du tarif de ${model} impossible : ${(e as Error).message.slice(0, 200)}`;
      }
    }
    if (result.status === 'completed' && result.unknown.length > 0) result.status = 'partial';
  }

  // Grille du compte (facultative, prioritaire) : écrite seulement si elle
  // diffère du tarif servi — pas une ligne d'historique par passage.
  const billing = deps.billing === undefined ? await defaultBilling() : deps.billing;
  if (billing?.isConfigured()) {
    try {
      for (const p of await billing.fetchPrices(wanted)) {
        const c = getCachedPrice(p.provider, p.model);
        if (c && c.source === 'billing_api' && c.inputMicros === p.inputMicros && c.outputMicros === p.outputMicros) continue;
        await upsertPrice(p, 'billing_api', true);
      }
    } catch (e) {
      console.warn('[pricing-sync] grille du compte indisponible :', (e as Error).message);
    }
  }

  await loadPricingCache().catch(() => 0);
  await closeLog(logId, result);
  return result;
}

async function recordChange(model: string, avant: PriceStatusRow | undefined, r: ResolvedPrice, now: Date): Promise<void> {
  const k = r.status === 'KNOWN';
  await pgClient.unsafe(
    `INSERT INTO ai_model_price_changes
       (provider, model, old_status, new_status, old_input, old_output, old_tiers, new_input, new_output, new_tiers,
        currency, source, reason, detected_at)
     VALUES ('gemini', $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13)`,
    [
      model, avant?.status ?? null, r.status, avant?.inputPerMillion ?? null, avant?.outputPerMillion ?? null,
      avant?.tiers ? JSON.stringify(avant.tiers) : null,
      k ? r.inputPerMillion : null, k ? r.outputPerMillion : null, k ? JSON.stringify(r.tiers) : null,
      k ? r.currency : null, GOOGLE_PRICING_SOURCE, k ? null : r.reason, now.toISOString(),
    ] as never[],
  );
  await pgClient.unsafe(
    `INSERT INTO ai_model_price_status
       (provider, model, status, input_per_million, output_per_million, tiers, currency, source, source_url, reason, fetched_at, last_changed_at)
     VALUES ('gemini', $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $10)
     ON CONFLICT (provider, model) DO UPDATE SET status = EXCLUDED.status,
       input_per_million = EXCLUDED.input_per_million, output_per_million = EXCLUDED.output_per_million,
       tiers = EXCLUDED.tiers, currency = EXCLUDED.currency, source = EXCLUDED.source,
       source_url = EXCLUDED.source_url, reason = EXCLUDED.reason, fetched_at = EXCLUDED.fetched_at,
       last_changed_at = EXCLUDED.last_changed_at`,
    [
      model, r.status, k ? r.inputPerMillion : null, k ? r.outputPerMillion : null, k ? JSON.stringify(r.tiers) : null,
      k ? r.currency : null, GOOGLE_PRICING_SOURCE, GOOGLE_PRICING_SOURCE_URL, k ? null : r.reason, now.toISOString(),
    ] as never[],
  );
}

async function defaultBilling(): Promise<PricingSource | null> {
  try {
    const { GeminiPricingSource } = await import('./gemini-pricing.source');
    return new GeminiPricingSource();
  } catch { return null; }
}

/** Alerte d'exploitation (une par jour) : source tarifaire illisible. */
async function raisePricingAlert(reason: string, now: Date): Promise<void> {
  try {
    const { raiseAlert } = await import('../../alerts/alerts.repository');
    await raiseAlert({
      kind: 'anomaly', code: 'ai_pricing_source_unreadable', severity: 'warning',
      message: `Tarifs IA : page officielle Google illisible (${reason.slice(0, 200)}) — tarifs connus conservés, nouveaux modèles en tarif inconnu.`,
      details: { reason, source: GOOGLE_PRICING_SOURCE_URL },
      drilldownHref: '/admin/ai-provider',
      dedupeKey: `ai:pricing-source:${now.toISOString().slice(0, 10)}`,
    });
  } catch { /* alerte best effort */ }
}
