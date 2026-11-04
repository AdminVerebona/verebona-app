/**
 * Tarification FIGÉE à la création d'une trace IA — lot 109L (ticket P1
 * « Tarifs Gemini non reconnus », point C ; migration 1150).
 *
 * Appelé par `recordCallTrace` (changement localisé, signalé au chantier 109J
 * qui modifie la passerelle Gemini) :
 *   · jetons de raisonnement : Gemini les compte À PART
 *     (`usageMetadata.thoughtsTokenCount`, hors `candidatesTokenCount`), mais
 *     les FACTURE au tarif de sortie (« Output price (including thinking
 *     tokens) »). Quand la passerelle les a relevés (`providerMeta.thoughtsTokens`)
 *     et qu'un tarif est connu, le coût est recalculé en les incluant ; sinon
 *     le coût transmis est conservé et la trace dit que le raisonnement n'est
 *     pas compté (`thinkingCounted: false`) ;
 *   · coût EXACT non arrondi conservé (`cost_exact_micros`) : un coût connu
 *     arrondi à 0 n'est plus pris pour un tarif absent ;
 *   · statut tarifaire explicite (`cost-status.ts`) écrit en colonne ;
 *   · alerte dédupliquée quand un modèle appelé n'a pas de tarif (une par
 *     modèle et par jour, une tentative par processus — jamais une par appel).
 * Ne lève jamais : la télémétrie ne fait jamais échouer un traitement.
 */
import { pricingStatusOf, type PricingStatus } from './cost-status';
import { cachedSchemaProbe } from './trace-schema';

export interface TracePricing {
  costMicros: number | null;
  exactMicros: number | null;
  status: PricingStatus;
  usage: { input: number; output: number; thoughts: number | null; thinkingCounted: boolean };
  recomputed: boolean;
}

/** Tarification d'une trace (pure si `price` est fourni). */
export function computeTracePricing(t: {
  provider: string; model: string; status: 'success' | 'error'; inputTokens: number; outputTokens: number;
  costMicros: number | null; providerMeta?: Record<string, unknown> | undefined;
}, deps: {
  priceCall: (p: { provider: string; model: string; inputTokens: number; outputTokens: number; thoughtsTokens?: number | null; at?: Date }) => { costMicros: number | null; exactMicros: number | null; price: unknown | null };
}): TracePricing {
  const raw = t.providerMeta?.thoughtsTokens;
  let thoughts = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  // Jamais de double comptage : si la passerelle a déjà inclus le raisonnement
  // dans les jetons de sortie (marqueur explicite, ou total = entrée + sortie),
  // il n'est pas ajouté une seconde fois.
  const total = t.providerMeta?.totalTokens;
  if (thoughts !== null && (t.providerMeta?.outputIncludesThoughts === true
    || (typeof total === 'number' && total < t.inputTokens + t.outputTokens + thoughts))) thoughts = null;
  let costMicros = t.costMicros;
  let exactMicros: number | null = null;
  let recomputed = false;
  let priced = false;
  try {
    const p = deps.priceCall({ provider: t.provider, model: t.model, inputTokens: t.inputTokens, outputTokens: t.outputTokens, thoughtsTokens: thoughts });
    priced = p.price !== null;
    const tokens = t.inputTokens + t.outputTokens + (thoughts ?? 0);
    if (priced && tokens > 0 && t.costMicros !== null) {
      exactMicros = p.exactMicros;
      if (thoughts && p.costMicros !== null && p.costMicros !== t.costMicros) { costMicros = p.costMicros; recomputed = true; }
    }
  } catch { /* cache illisible : coût transmis conservé */ }
  // Un coût fourni par l'appelant sans tarif en cache (double de test, coût
  // déjà calculé ailleurs) reste « appliqué » s'il est positif.
  const status = pricingStatusOf({ status: t.status, inputTokens: t.inputTokens, outputTokens: t.outputTokens + (thoughts ?? 0), costMicros, priced: priced || (costMicros !== null && costMicros > 0) });
  return {
    costMicros, exactMicros, status,
    usage: { input: t.inputTokens, output: t.outputTokens, thoughts, thinkingCounted: thoughts === null ? false : priced && t.costMicros !== null },
    recomputed,
  };
}

const pricingColumnsProbe = cachedSchemaProbe(async () => {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'ai_usage_event'
        AND column_name IN ('pricing_status', 'cost_exact_micros')`,
  )) as unknown as Array<{ n: number }>;
  const found = Number(rows?.[0]?.n ?? 0);
  return { ready: found === 2, found };
}, {
  scope: '[ai-trace]', migration: '1150',
  expected: ['ai_usage_event.pricing_status', 'ai_usage_event.cost_exact_micros'],
  consequence: 'Les traces IA continuent SANS statut tarifaire écrit (statut déduit à la lecture) ; appliquer src/db/migrations/1150_*.sql.',
});

/** Écrit statut et coût exact (colonnes 1150) ; absentes : rien. Ne lève jamais. */
export async function writeTracePricing(usageEventId: number | null, p: TracePricing): Promise<void> {
  if (!usageEventId) return;
  try {
    if (!(await pricingColumnsProbe())) return;
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `UPDATE ai_usage_event SET pricing_status = $2, cost_exact_micros = $3 WHERE id = $1`,
      [usageEventId, p.status, p.exactMicros] as never[],
    );
  } catch (e) {
    console.error('[ai-trace] statut tarifaire non écrit (non bloquant) :', (e as Error).message);
  }
}

const alerted = new Set<string>();

/** Alerte « modèle appelé sans tarif » : une tentative par processus et par jour. Ne lève jamais. */
export async function alertMissingPrice(provider: string, model: string, now: Date = new Date()): Promise<void> {
  const jour = now.toISOString().slice(0, 10);
  const k = `${provider}/${model}/${jour}`;
  if (alerted.has(k)) return;
  alerted.add(k);
  try {
    const { raiseAlert } = await import('../alerts/alerts.repository');
    await raiseAlert({
      kind: 'anomaly', code: 'ai_pricing_model_unpriced', severity: 'warning',
      message: `Appels IA non chiffrés : aucun tarif applicable pour ${provider}/${model} (coût non calculable, jamais estimé).`,
      details: { provider, model, source: 'trace' },
      drilldownHref: `/admin/ai-costs?unpriced=1&model=${encodeURIComponent(model)}`,
      dedupeKey: `ai:pricing-model:${model}:UNKNOWN:${jour}`,
    });
  } catch { /* alerte best effort */ }
}

/** Réservé aux tests. */
export function __resetTracePricingForTests(ready: boolean | null = null): void {
  pricingColumnsProbe.reset(ready);
  alerted.clear();
}
