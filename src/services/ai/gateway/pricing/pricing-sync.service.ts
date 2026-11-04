/**
 * Synchronisation du catalogue TARIFAIRE — lot 35B, ticket « Catalogue IA
 * dynamique Google » (migration 0304) ; lot 109L (ticket P1 « Tarifs Gemini
 * non reconnus », points A et B, migration 1150).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE, HISTORIQUE, JAMAIS D'INVENTION
 *
 *   1. lit la page officielle (`google-pricing-page.adapter.ts`) et CAPTURE la
 *      réponse : URL demandée, URL finale (redirection), statut HTTP, type de
 *      contenu, taille, empreinte SHA-256, format détecté, extrait — sans
 *      secret (page publique, aucune clé envoyée) ;
 *   2. VALIDATION GLOBALE de la source : page illisible, format inconnu, HTML,
 *      aucun prix, ou couverture des modèles déjà tarifés en chute brutale
 *      (`COVERAGE_DROP_RATIO`) → ÉCHEC de synchronisation : AUCUN tarif retiré,
 *      AUCUN montant écrit ; les modèles jusque-là KNOWN passent STALE
 *      (dernier montant documenté conservé, explicitement non confirmé) ;
 *   3. pour chaque modèle demandé : KNOWN (montants, paliers, devise, sortie
 *      raisonnement incluse) ; sinon STALE s'il avait un tarif documenté
 *      (motif structuré : absent, ambigu, forme non prise en charge…), UNKNOWN
 *      s'il n'en a jamais eu ;
 *   4. un changement est HISTORISÉ (`ai_model_price_changes`, empreinte de la
 *      page) et un nouveau tarif est inscrit à partir de maintenant ; les coûts
 *      passés ne sont jamais revalorisés ici (voir la régularisation) ;
 *   5. RETRAIT d'un tarif : jamais sur une lecture ambiguë ou une erreur
 *      technique. Seulement après vérification POSITIVE et ciblée
 *      (`confirmModelRetirement` : modèle absent d'au moins
 *      `RETIREMENT_MIN_ABSENT_READS` lectures saines successives, confirmé par
 *      un administrateur, motif tracé).
 *
 * Ne lève jamais : une panne de la source tarifaire ne bloque ni le démarrage,
 * ni la synchronisation des modèles, ni l'utilisation d'un modèle.
 *
 * Grille du compte (Cloud Billing) : désactivée par défaut — elle n'est pas
 * démontrée représentative de la facture Gemini Developer API (voir
 * `gemini-pricing.source.ts`). Aucune dépendance à Vertex AI.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  GOOGLE_PRICING_SOURCE, GOOGLE_PRICING_SOURCE_URL, detectPricingFormat, pageCoverage, pageFingerprint, pageSample,
  parseGooglePricingMarkdown, resolveModelPrice,
  type PageFormat, type PriceReasonCode, type PriceTier, type ResolvedPrice,
} from './google-pricing-page.adapter';
import { bumpPricingVersion, invalidatePublicPrices, loadPricingCache, upsertPrice } from './pricing.repository';
import type { PricingSource } from './pricing-source.port';

type Row = Record<string, unknown>;

export type PriceStatus = 'KNOWN' | 'UNKNOWN' | 'STALE';

interface PriceStatusRow {
  model: string;
  status: PriceStatus;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  tiers: PriceTier[] | null;
  currency: string | null;
  source: string;
  sourceUrl: string | null;
  reason: string | null;
  fetchedAt: string;
  lastChangedAt: string | null;
  /** Lot 109L. */
  reasonCode?: string | null;
  staleSince?: string | null;
  absentReads?: number;
  confirmedAt?: string | null;
  thinkingIncluded?: boolean | null;
}

/** Échec global de la source (lot 109L) : code stable. */
export type PricingFailureCode = 'FETCH_FAILED' | 'HTTP_ERROR' | PriceReasonCode | 'NO_PRICES' | 'COVERAGE_DROP';

export interface PricingSyncResult {
  status: 'completed' | 'partial' | 'failed' | 'skipped';
  /** Page lue et reconnue. */
  sourceRead: boolean;
  known: string[];
  unknown: Array<{ model: string; reason: string; code?: string }>;
  changed: Array<{ model: string; from: string; to: string }>;
  /** Lot 109L : tarifs conservés mais non confirmés par cette lecture. */
  stale?: Array<{ model: string; reason: string; code?: string }>;
  error?: string;
  failureCode?: PricingFailureCode;
  /** Lot 109L : capture de la réponse lue (sans secret). */
  capture?: PageCapture;
}

export interface PageCapture {
  requestedUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  bytes: number;
  fingerprint: string | null;
  format: PageFormat;
  sample: string;
  coverage: { sections: number; modelIds: number; known: number };
}

/** Page lue : texte seul (tests) ou réponse capturée. */
export interface FetchedPage { text: string; finalUrl?: string | null; status?: number | null; contentType?: string | null }

export interface PricingSyncDeps {
  /** Lecture de la page (injectable : fixtures en test, réseau en exploitation). */
  fetchPage?: () => Promise<string | FetchedPage>;
  now?: () => Date;
  /** Grille du compte (facultative). */
  billing?: PricingSource | null;
  /** Lot 109L : alerte d'exploitation, injectable en test. */
  raiseAlert?: (a: import('../../alerts/alerts.repository').AlertInput) => Promise<boolean>;
  trigger?: string;
}

/** Part des modèles tarifés perdue en une lecture au-delà de laquelle la source est jugée non fiable. */
export const COVERAGE_DROP_RATIO = 0.5;
/** Nombre minimal de modèles tarifés pour appliquer le contrôle de chute de couverture. */
export const COVERAGE_DROP_MIN_MODELS = 3;
/** Lectures saines successives sans le modèle avant de pouvoir confirmer son retrait. */
export const RETIREMENT_MIN_ABSENT_READS = 2;

class HttpError extends Error { constructor(readonly status: number, readonly finalUrl: string | null, readonly contentType: string | null) { super(`page tarifaire : HTTP ${status}`); } }

async function fetchOfficialPage(): Promise<FetchedPage> {
  const res = await fetch(GOOGLE_PRICING_SOURCE_URL, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  const finalUrl = res.url || null;
  const contentType = res.headers.get('content-type');
  if (!res.ok) throw new HttpError(res.status, finalUrl, contentType);
  return { text: await res.text(), finalUrl, status: res.status, contentType };
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fmt = (s: { status: string; inputPerMillion: number | null; outputPerMillion: number | null }) =>
  s.status === 'UNKNOWN' || s.inputPerMillion == null ? s.status : `${s.inputPerMillion} $ / ${s.outputPerMillion} $${s.status === 'STALE' ? ' (STALE)' : ''}`;

/** État courant (écran BO, contrôles). Table absente : vide. */
export async function loadPriceStatuses(): Promise<Map<string, PriceStatusRow>> {
  const out = new Map<string, PriceStatusRow>();
  let rows: Row[] = [];
  try {
    try {
      rows = (await pgClient.unsafe(
        `SELECT model, status, input_per_million, output_per_million, tiers, currency, source, source_url, reason,
                fetched_at, last_changed_at, reason_code, stale_since, absent_reads, confirmed_at, thinking_included
           FROM ai_model_price_status WHERE provider = 'gemini'`,
      )) as unknown as Row[];
    } catch (e) {
      if ((e as { code?: string }).code !== '42703') throw e;
      rows = (await pgClient.unsafe(
        `SELECT model, status, input_per_million, output_per_million, tiers, currency, source, source_url, reason,
                fetched_at, last_changed_at
           FROM ai_model_price_status WHERE provider = 'gemini'`,
      )) as unknown as Row[];
    }
  } catch { /* migration 0304 absente */ }
  for (const r of rows ?? []) {
    const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
    out.set(String(r.model), {
      model: String(r.model),
      status: r.status === 'KNOWN' ? 'KNOWN' : r.status === 'STALE' ? 'STALE' : 'UNKNOWN',
      inputPerMillion: num(r.input_per_million),
      outputPerMillion: num(r.output_per_million),
      tiers: Array.isArray(r.tiers) ? (r.tiers as PriceTier[]) : null,
      currency: r.currency == null ? null : String(r.currency),
      source: String(r.source),
      sourceUrl: r.source_url == null ? null : String(r.source_url),
      reason: r.reason == null ? null : String(r.reason),
      fetchedAt: new Date(String(r.fetched_at)).toISOString(),
      lastChangedAt: iso(r.last_changed_at),
      reasonCode: r.reason_code == null ? null : String(r.reason_code),
      staleSince: iso(r.stale_since),
      absentReads: r.absent_reads == null ? 0 : Number(r.absent_reads),
      confirmedAt: iso(r.confirmed_at),
      thinkingIncluded: r.thinking_included == null ? null : Boolean(r.thinking_included),
    });
  }
  return out;
}

/** Sérialisation canonique (clés triées) : `jsonb` réordonne les clés. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
}

/** Montants identiques (pur). */
function sameAmounts(prev: { inputPerMillion: number | null; outputPerMillion: number | null; tiers: PriceTier[] | null }, next: Extract<ResolvedPrice, { status: 'KNOWN' }>): boolean {
  return prev.inputPerMillion === next.inputPerMillion && prev.outputPerMillion === next.outputPerMillion
    && canon(prev.tiers ?? []) === canon(next.tiers ?? []);
}

/**
 * Contrôle GLOBAL de la source (pur, lot 109L) : `null` si la page est
 * exploitable, sinon le code et le motif de l'échec.
 */
export function validatePricingSource(
  page: ReturnType<typeof parseGooglePricingMarkdown>,
  previouslyKnown: readonly string[],
  asOf: Date,
): { code: PricingFailureCode; reason: string } | null {
  if (!page.ok) return { code: page.code ?? 'PAGE_UNRECOGNIZED', reason: page.reason };
  const cov = pageCoverage(page, asOf);
  if (cov.known === 0) return { code: 'NO_PRICES', reason: 'aucun prix lisible sur la page (format modifié ?)' };
  if (previouslyKnown.length >= COVERAGE_DROP_MIN_MODELS) {
    const perdus = previouslyKnown.filter((m) => resolveModelPrice(page, m, asOf).status !== 'KNOWN');
    if (perdus.length / previouslyKnown.length > COVERAGE_DROP_RATIO) {
      return {
        code: 'COVERAGE_DROP',
        reason: `couverture en chute brutale : ${perdus.length} des ${previouslyKnown.length} modèles tarifés ne sont plus lisibles (${perdus.slice(0, 6).join(', ')}) — source jugée non fiable`,
      };
    }
  }
  return null;
}

async function openLog(trigger: string | undefined): Promise<number | null> {
  try {
    const rows = await pgClient.unsafe(`INSERT INTO ai_model_pricing_refresh_log (status) VALUES ('running') RETURNING id`);
    const id = (rows as unknown as Array<{ id: number }>)[0]?.id ?? null;
    if (id !== null && trigger) await pgClient.unsafe(`UPDATE ai_model_pricing_refresh_log SET trigger_code = $2 WHERE id = $1`, [id, trigger.slice(0, 40)] as never[]).catch(() => undefined);
    return id;
  } catch { return null; }
}

async function closeLog(id: number | null, r: PricingSyncResult): Promise<void> {
  if (id === null) return;
  const status = r.status === 'skipped' ? 'failed' : r.status;
  await pgClient.unsafe(
    `UPDATE ai_model_pricing_refresh_log
        SET status = $2, finished_at = NOW(), models_found = $3, models_updated = $4,
            models_missing = $5::jsonb, error_message = $6
      WHERE id = $1`,
    [id, status, r.known.length, r.changed.length,
      JSON.stringify(r.unknown.map((u) => u.model)), r.error ?? null] as never[],
  ).catch(() => undefined);
  const c = r.capture;
  await pgClient.unsafe(
    `UPDATE ai_model_pricing_refresh_log
        SET source_url = $2, final_url = $3, http_status = $4, content_type = $5, page_bytes = $6,
            page_fingerprint = $7, page_format = $8, page_sample = $9, models_stale = $10::jsonb,
            causes = $11::jsonb, failure_code = $12
      WHERE id = $1`,
    [id, c?.requestedUrl ?? GOOGLE_PRICING_SOURCE_URL, c?.finalUrl ?? null, c?.httpStatus ?? null, c?.contentType?.slice(0, 120) ?? null,
      c?.bytes ?? null, c?.fingerprint ?? null, c?.format ?? null, c?.sample ?? null,
      JSON.stringify((r.stale ?? []).map((s) => s.model)),
      JSON.stringify([...r.unknown, ...(r.stale ?? [])].map((u) => ({ model: u.model, code: u.code ?? null, reason: u.reason }))),
      r.failureCode ?? null] as never[],
  ).catch(() => undefined);
}

/** Une ligne publique valide existe-t-elle pour ce modèle (aux mêmes montants) ? */
async function validPublicRow(model: string): Promise<{ input: number; output: number; tiers: unknown } | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT input_micros, output_micros, tiers FROM ai_model_pricing
        WHERE provider = 'gemini' AND model = $1 AND source = 'public_catalog' AND invalidated_at IS NULL AND effective_from <= NOW()
        ORDER BY effective_from DESC LIMIT 1`,
      [model] as never[],
    )) as unknown as Row[];
    const r = rows?.[0];
    return r ? { input: Number(r.input_micros), output: Number(r.output_micros), tiers: r.tiers ?? null } : null;
  } catch { return null; }
}

/**
 * Synchronise les tarifs des modèles demandés (catalogue découvert + modèles
 * des configurations, du référentiel et réellement appelés). Ne lève jamais.
 */
export async function syncPricingCatalog(models: readonly string[], deps: PricingSyncDeps = {}): Promise<PricingSyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: PricingSyncResult = { status: 'completed', sourceRead: false, known: [], unknown: [], changed: [], stale: [] };
  const logId = await openLog(deps.trigger);
  const wanted = [...new Set(models.filter((m) => typeof m === 'string' && m.trim() !== ''))].sort();
  let ecrit = false;

  let page: ReturnType<typeof parseGooglePricingMarkdown>;
  const capture: PageCapture = {
    requestedUrl: GOOGLE_PRICING_SOURCE_URL, finalUrl: null, httpStatus: null, contentType: null, bytes: 0,
    fingerprint: null, format: 'empty', sample: '', coverage: { sections: 0, modelIds: 0, known: 0 },
  };
  let fetchFailure: { code: PricingFailureCode; reason: string } | null = null;
  try {
    const got = await (deps.fetchPage ?? fetchOfficialPage)();
    const fp: FetchedPage = typeof got === 'string' ? { text: got } : got;
    capture.finalUrl = fp.finalUrl ?? null;
    capture.httpStatus = fp.status ?? null;
    capture.contentType = fp.contentType ?? null;
    capture.bytes = Buffer.byteLength(fp.text ?? '', 'utf8');
    capture.fingerprint = pageFingerprint(fp.text ?? '');
    capture.format = detectPricingFormat(fp.text ?? '');
    capture.sample = pageSample(fp.text ?? '');
    page = parseGooglePricingMarkdown(fp.text ?? '');
    capture.coverage = pageCoverage(page, now);
  } catch (e) {
    const http = e instanceof HttpError ? e : null;
    if (http) { capture.httpStatus = http.status; capture.finalUrl = http.finalUrl; capture.contentType = http.contentType; }
    fetchFailure = { code: http ? 'HTTP_ERROR' : 'FETCH_FAILED', reason: `page tarifaire injoignable : ${(e as Error).message.slice(0, 200)}` };
    page = { ok: false, reason: fetchFailure.reason };
  }
  result.capture = capture;

  const prev = await loadPriceStatuses();
  const previouslyKnown = wanted.filter((m) => prev.get(m)?.status === 'KNOWN');
  const failure = fetchFailure ?? validatePricingSource(page, previouslyKnown, now);

  if (failure) {
    // ── Échec GLOBAL : rien n'est retiré, rien n'est écrit ; KNOWN → STALE ──
    result.status = 'failed';
    result.error = failure.reason;
    result.failureCode = failure.code;
    result.sourceRead = page.ok;
    console.warn(`[pricing-sync] source tarifaire rejetée (${failure.code} : ${failure.reason}) — tarifs connus conservés en STALE, aucun retrait.`);
    for (const model of wanted) {
      const avant = prev.get(model);
      if (avant && avant.inputPerMillion != null) {
        result.stale!.push({ model, reason: failure.reason, code: failure.code });
        if (avant.status === 'KNOWN') {
          await markStale(model, avant, failure.reason, failure.code, now, capture.fingerprint, false).catch(() => undefined);
          ecrit = true;
        }
      } else {
        result.unknown.push({ model, reason: avant?.reason ?? failure.reason, code: avant?.reasonCode ?? failure.code });
      }
    }
    await raisePricingAlert(`ai:pricing-source:${now.toISOString().slice(0, 10)}`, 'ai_pricing_source_unreadable',
      `Tarifs IA : source officielle Google rejetée (${failure.code} — ${failure.reason.slice(0, 200)}) — tarifs connus conservés (non confirmés), aucun retrait.`,
      { reason: failure.reason, code: failure.code, source: GOOGLE_PRICING_SOURCE_URL, fingerprint: capture.fingerprint, format: capture.format }, deps);
  } else {
    result.sourceRead = true;
    for (const model of wanted) {
      const r = resolveModelPrice(page, model, now);
      const avant = prev.get(model);
      try {
        if (r.status === 'KNOWN') {
          result.known.push(model);
          const change = !avant || avant.status !== 'KNOWN' || !sameAmounts(avant, r);
          if (change) {
            await recordChange(model, avant, r, now, capture.fingerprint);
            result.changed.push({ model, from: avant ? fmt(avant) : 'aucun', to: fmt(r) });
          } else {
            await confirmKnown(model, r, now, capture.fingerprint);
          }
          // Tarif public écrit s'il change, ou s'il n'est plus servi (amorçage,
          // ligne retirée) : à la même valeur, avec ses paliers.
          const row = await validPublicRow(model);
          // Une simple reconfirmation (STALE → KNOWN au même montant) n'ajoute pas de ligne.
          if (!row || row.input !== r.inputPerMillion || row.output !== r.outputPerMillion
            || canon(row.tiers ?? []) !== canon(r.tiers ?? [])) {
            await upsertPrice({
              provider: 'gemini', model,
              // $/million de jetons ≡ micro-dollars/jeton : la conversion est l'identité.
              inputMicros: r.inputPerMillion, outputMicros: r.outputPerMillion,
              currency: r.currency, sourceReference: `${GOOGLE_PRICING_SOURCE}:${now.toISOString().slice(0, 10)}${capture.fingerprint ? `:${capture.fingerprint.slice(0, 12)}` : ''}`, tiers: r.tiers,
            }, 'public_catalog', false, undefined, { evidence: { sourceUrl: capture.finalUrl ?? GOOGLE_PRICING_SOURCE_URL, documentDate: now.toISOString().slice(0, 10), pageFingerprint: capture.fingerprint ?? undefined, paidTier: true, tier: 'standard', thinkingIncluded: r.thinkingIncluded ?? false } });
          }
          ecrit = true;
        } else {
          const aUnTarif = (avant && avant.inputPerMillion != null) || (await validPublicRow(model)) !== null;
          if (aUnTarif) {
            result.stale!.push({ model, reason: r.reason, code: r.code });
            await markStale(model, avant, r.reason, r.code ?? 'UNSUPPORTED_CELL', now, capture.fingerprint, r.code === 'ABSENT');
          } else {
            result.unknown.push({ model, reason: r.reason, code: r.code });
            if (!avant || avant.status !== 'UNKNOWN' || avant.reason !== r.reason) {
              await recordChange(model, avant, r, now, capture.fingerprint);
              if (!avant || avant.status !== 'UNKNOWN') result.changed.push({ model, from: avant ? fmt(avant) : 'aucun', to: 'UNKNOWN' });
            } else {
              await pgClient.unsafe(
                `UPDATE ai_model_price_status SET fetched_at = $2 WHERE provider = 'gemini' AND model = $1`,
                [model, now.toISOString()] as never[],
              );
            }
          }
          ecrit = true;
        }
      } catch (e) {
        result.status = 'partial';
        result.error = `écriture du tarif de ${model} impossible : ${(e as Error).message.slice(0, 200)}`;
      }
    }
    if (result.status === 'completed' && (result.unknown.length > 0 || result.stale!.length > 0)) result.status = 'partial';
  }

  // Grille du compte (facultative, prioritaire quand VÉRIFIÉE et validée) :
  // écrite seulement si elle diffère — pas une ligne d'historique par passage.
  const billing = deps.billing === undefined ? await defaultBilling() : deps.billing;
  if (billing?.isConfigured()) {
    try {
      const { getCachedPrice } = await import('./pricing.repository');
      for (const p of await billing.fetchPrices(wanted)) {
        const c = getCachedPrice(p.provider, p.model);
        if (c && c.source === 'billing_api' && c.inputMicros === p.inputMicros && c.outputMicros === p.outputMicros) continue;
        await upsertPrice(p, 'billing_api', true);
      }
    } catch (e) {
      console.warn('[pricing-sync] grille du compte indisponible :', (e as Error).message);
    }
  }

  if (ecrit) await bumpPricingVersion('pricing-sync');
  await loadPricingCache().catch(() => 0);
  await closeLog(logId, result);
  await alertUnpricedModelsInUse(result, now, deps);
  return result;
}

async function recordChange(model: string, avant: PriceStatusRow | undefined, r: ResolvedPrice, now: Date, fingerprint: string | null): Promise<void> {
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
  await tagLastChange(model, k ? null : r.code ?? null, fingerprint);
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
  await pgClient.unsafe(
    `UPDATE ai_model_price_status SET reason_code = $2, stale_since = NULL, absent_reads = 0,
            confirmed_at = $3, thinking_included = $4, page_fingerprint = $5
      WHERE provider = 'gemini' AND model = $1`,
    [model, k ? null : r.code ?? null, k ? now.toISOString() : null, k ? Boolean(r.thinkingIncluded) : null, fingerprint] as never[],
  ).catch(() => undefined);
}

/** Lot 109L : code / empreinte sur la dernière ligne d'historique (colonnes 1150). */
async function tagLastChange(model: string, code: string | null, fingerprint: string | null, actor: number | null = null, evidence: unknown = null): Promise<void> {
  await pgClient.unsafe(
    `UPDATE ai_model_price_changes SET reason_code = $2, page_fingerprint = $3, actor_user_id = $4, evidence = $5::jsonb
      WHERE id = (SELECT max(id) FROM ai_model_price_changes WHERE provider = 'gemini' AND model = $1)`,
    [model, code, fingerprint, actor, evidence ? JSON.stringify(evidence) : null] as never[],
  ).catch(() => undefined);
}

async function confirmKnown(model: string, r: Extract<ResolvedPrice, { status: 'KNOWN' }>, now: Date, fingerprint: string | null): Promise<void> {
  await pgClient.unsafe(
    `UPDATE ai_model_price_status SET fetched_at = $2, reason = NULL WHERE provider = 'gemini' AND model = $1`,
    [model, now.toISOString()] as never[],
  );
  await pgClient.unsafe(
    `UPDATE ai_model_price_status SET reason_code = NULL, stale_since = NULL, absent_reads = 0, confirmed_at = $2,
            thinking_included = $3, page_fingerprint = $4
      WHERE provider = 'gemini' AND model = $1`,
    [model, now.toISOString(), Boolean(r.thinkingIncluded), fingerprint] as never[],
  ).catch(() => undefined);
}

/**
 * STALE (lot 109L) : dernier montant documenté CONSERVÉ (jamais retiré), motif
 * structuré, date depuis laquelle il n'est plus confirmé. Historisé à la
 * transition seulement (pas une ligne par passage).
 */
async function markStale(model: string, avant: PriceStatusRow | undefined, reason: string, code: string, now: Date, fingerprint: string | null, absent: boolean): Promise<void> {
  if (!avant || avant.status !== 'STALE') {
    await pgClient.unsafe(
      `INSERT INTO ai_model_price_changes
         (provider, model, old_status, new_status, old_input, old_output, old_tiers, new_input, new_output, new_tiers, currency, source, reason, detected_at)
       VALUES ('gemini', $1, $2, 'STALE', $3, $4, $5::jsonb, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
      [model, avant?.status ?? null, avant?.inputPerMillion ?? null, avant?.outputPerMillion ?? null,
        avant?.tiers ? JSON.stringify(avant.tiers) : null, avant?.currency ?? null, GOOGLE_PRICING_SOURCE, reason.slice(0, 500), now.toISOString()] as never[],
    );
    await tagLastChange(model, code, fingerprint);
  }
  await pgClient.unsafe(
    `INSERT INTO ai_model_price_status
       (provider, model, status, input_per_million, output_per_million, tiers, currency, source, source_url, reason, fetched_at, last_changed_at)
     VALUES ('gemini', $1, 'STALE', $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (provider, model) DO UPDATE SET status = 'STALE', reason = EXCLUDED.reason, fetched_at = EXCLUDED.fetched_at,
       last_changed_at = CASE WHEN ai_model_price_status.status = 'STALE' THEN ai_model_price_status.last_changed_at ELSE EXCLUDED.last_changed_at END`,
    [model, avant?.inputPerMillion ?? null, avant?.outputPerMillion ?? null, avant?.tiers ? JSON.stringify(avant.tiers) : null,
      avant?.currency ?? null, GOOGLE_PRICING_SOURCE, GOOGLE_PRICING_SOURCE_URL, reason.slice(0, 500), now.toISOString()] as never[],
  );
  await pgClient.unsafe(
    `UPDATE ai_model_price_status SET reason_code = $2, stale_since = COALESCE(stale_since, $3::timestamptz),
            absent_reads = CASE WHEN $4 THEN absent_reads + 1 ELSE 0 END, page_fingerprint = $5
      WHERE provider = 'gemini' AND model = $1`,
    [model, code, now.toISOString(), absent, fingerprint] as never[],
  ).catch(() => undefined);
}

/**
 * Retrait VÉRIFIÉ d'un tarif public (lot 109L, point A) : refusé tant que le
 * modèle n'a pas été constaté absent d'au moins `RETIREMENT_MIN_ABSENT_READS`
 * lectures SAINES successives (une erreur de lecture n'est jamais une preuve).
 * Confirmé par un administrateur, motif et preuve tracés.
 */
export async function confirmModelRetirement(model: string, adminUserId: number, note: string): Promise<{ ok: true; invalidated: number } | { ok: false; code: 'NOT_STALE' | 'NOT_ENOUGH_EVIDENCE'; message: string }> {
  const st = (await loadPriceStatuses()).get(model);
  if (!st || st.status !== 'STALE') return { ok: false, code: 'NOT_STALE', message: 'Seul un tarif non confirmé (STALE) peut être retiré.' };
  if (st.reasonCode !== 'ABSENT' || (st.absentReads ?? 0) < RETIREMENT_MIN_ABSENT_READS) {
    return { ok: false, code: 'NOT_ENOUGH_EVIDENCE', message: `Retrait refusé : le modèle doit être absent d'au moins ${RETIREMENT_MIN_ABSENT_READS} lectures saines successives de la page (constaté : ${st.absentReads ?? 0}, motif ${st.reasonCode ?? '—'}).` };
  }
  const n = await invalidatePublicPrices('gemini', model, `retrait vérifié : ${note}`.slice(0, 300), adminUserId);
  const now = new Date();
  await pgClient.unsafe(
    `INSERT INTO ai_model_price_changes (provider, model, old_status, new_status, old_input, old_output, source, reason, detected_at)
     VALUES ('gemini', $1, 'STALE', 'UNKNOWN', $2, $3, 'admin', $4, $5)`,
    [model, st.inputPerMillion, st.outputPerMillion, `retrait vérifié par un administrateur : ${note}`.slice(0, 500), now.toISOString()] as never[],
  );
  await tagLastChange(model, 'RETIRED_VERIFIED', null, adminUserId, { absentReads: st.absentReads, staleSince: st.staleSince });
  await pgClient.unsafe(
    `UPDATE ai_model_price_status SET status = 'UNKNOWN', input_per_million = NULL, output_per_million = NULL, tiers = NULL,
            reason = $2, reason_code = 'RETIRED_VERIFIED', last_changed_at = NOW() WHERE provider = 'gemini' AND model = $1`,
    [model, 'tarif retiré après vérification (absent de la page officielle)'] as never[],
  );
  await loadPricingCache().catch(() => 0);
  return { ok: true, invalidated: n };
}

async function defaultBilling(): Promise<PricingSource | null> {
  try {
    const { GeminiPricingSource } = await import('./gemini-pricing.source');
    return new GeminiPricingSource();
  } catch { return null; }
}

async function raisePricingAlert(dedupeKey: string, code: string, message: string, details: Record<string, unknown>, deps: PricingSyncDeps): Promise<void> {
  try {
    const raise = deps.raiseAlert ?? (await import('../../alerts/alerts.repository')).raiseAlert;
    await raise({ kind: 'anomaly', code, severity: 'warning', message, details, drilldownHref: '/admin/ai-provider#tarifs', dedupeKey });
  } catch { /* alerte best effort */ }
}

/**
 * Lot 109L (point E) : modèle RÉELLEMENT utilisé (appelé sur 7 jours, ou dans
 * une chaîne active) devenu non tarifé ou non confirmé — UNE alerte par modèle,
 * par état et par jour (clé de déduplication), jamais une par appel.
 */
async function alertUnpricedModelsInUse(r: PricingSyncResult, now: Date, deps: PricingSyncDeps): Promise<void> {
  const concernes = [...r.unknown.map((u) => ({ ...u, etat: 'UNKNOWN' })), ...(r.stale ?? []).map((u) => ({ ...u, etat: 'STALE' }))];
  if (concernes.length === 0) return;
  const utilises = await modelsActuallyUsed(7).catch(() => new Set<string>());
  try {
    const { loadActiveChains } = await import('../../provider/active-model-anomalies');
    for (const c of await loadActiveChains()) utilises.add(c.model);
  } catch { /* chaînes illisibles */ }
  const jour = now.toISOString().slice(0, 10);
  for (const c of concernes.filter((x) => utilises.has(x.model))) {
    await raisePricingAlert(`ai:pricing-model:${c.model}:${c.etat}:${jour}`, 'ai_pricing_model_unpriced',
      c.etat === 'UNKNOWN'
        ? `Tarif IA inconnu pour ${c.model}, modèle utilisé : ses appels sont non chiffrés (${c.code ?? '—'} — ${c.reason.slice(0, 160)}).`
        : `Tarif IA non confirmé (STALE) pour ${c.model}, modèle utilisé : dernier montant documenté appliqué (${c.code ?? '—'} — ${c.reason.slice(0, 160)}).`,
      { model: c.model, status: c.etat, code: c.code ?? null, reason: c.reason }, deps);
  }
}

/** Modèles réellement appelés (provider gemini) sur `days` jours. Lecture seule. */
export async function modelsActuallyUsed(days: number): Promise<Set<string>> {
  const rows = (await pgClient.unsafe(
    `SELECT DISTINCT model FROM ai_usage_event
      WHERE provider = 'gemini' AND model IS NOT NULL AND created_at >= NOW() - ($1 || ' days')::interval`,
    [String(days)] as never[],
  )) as unknown as Array<{ model: string }>;
  return new Set((rows ?? []).map((x) => String(x.model)));
}
