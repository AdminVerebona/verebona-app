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
 *
 * Lot 113O (carte #713) :
 *   · ALIAS (`*-latest`…) : sans tarif pour l'identifiant demandé, le modèle
 *     RÉELLEMENT SERVI renvoyé par l'API (`providerMeta.modelVersion`, preuve
 *     de la résolution) est chiffré s'il a un tarif exact — jamais par
 *     ressemblance de nom ; la trace garde les deux (`pricedModel`,
 *     `pricingBasis: 'served_model'`). Sans preuve : coût inconnu ;
 *   · PRIX PAR MODALITÉ : chiffrés avec la consommation par modalité mesurée
 *     (`providerMeta.tokensByModality`) ; sinon coût inconnu, statut
 *     `insufficient_usage`, motif `MODALITY_USAGE_UNMEASURED` ;
 *   · alerte « appels non chiffrés » : UNE par modèle tant que la condition
 *     dure (`pricing-supervision.ts`), résolue quand elle disparaît.
 */
import { pricingStatusOf, type PricingStatus } from './cost-status';
import { cachedSchemaProbe } from './trace-schema';

export interface TracePricing {
  costMicros: number | null;
  exactMicros: number | null;
  status: PricingStatus;
  usage: { input: number; output: number; thoughts: number | null; thinkingCounted: boolean };
  recomputed: boolean;
  /** Lot 113O : identifiant dont le tarif a été appliqué (`null` : aucun). */
  pricedModel?: string | null;
  /** Lot 113O : `served_model` quand le tarif est celui du modèle servi (alias résolu par l'API). */
  pricingBasis?: 'requested_model' | 'served_model' | null;
  /** Lot 113O : motif précis d'un coût non calculable malgré un tarif connu. */
  reasonCode?: string | null;
}

type PriceCallFn = (p: {
  provider: string; model: string; inputTokens: number; outputTokens: number; thoughtsTokens?: number | null; at?: Date;
  modality?: { input?: Record<string, number> | null; output?: Record<string, number> | null } | null;
}) => { costMicros: number | null; exactMicros: number | null; price: unknown | null; unknownCode?: string; unknownReason?: string };

/**
 * Modèle réellement servi (pur, lot 113O) : `modelVersion` renvoyé par l'API,
 * préfixe `models/` retiré, s'il DIFFÈRE de l'identifiant demandé. Jamais
 * déduit du nom.
 */
export function servedModelOf(providerMeta: Record<string, unknown> | undefined, model: string): string | null {
  const v = providerMeta?.modelVersion;
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^models\//, '');
  return m && m !== model && /^[a-z0-9][a-z0-9.\-]{1,120}$/i.test(m) ? m : null;
}

/** Consommation par modalité relevée par la passerelle (pure, lot 113O). */
export function modalityUsageOf(providerMeta: Record<string, unknown> | undefined): { input?: Record<string, number>; output?: Record<string, number> } | null {
  const t = providerMeta?.tokensByModality;
  if (!t || typeof t !== 'object') return null;
  const lire = (x: unknown) => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) as Record<string, number> : undefined);
  const input = lire((t as Record<string, unknown>).input);
  const output = lire((t as Record<string, unknown>).output);
  return input || output ? { ...(input ? { input } : {}), ...(output ? { output } : {}) } : null;
}

/** Tarification d'une trace (pure si `price` est fourni). */
export function computeTracePricing(t: {
  provider: string; model: string; status: 'success' | 'error'; inputTokens: number; outputTokens: number;
  costMicros: number | null; providerMeta?: Record<string, unknown> | undefined;
}, deps: { priceCall: PriceCallFn }): TracePricing {
  const raw = t.providerMeta?.thoughtsTokens;
  let thoughts = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  // Jamais de double comptage : si la passerelle a déjà inclus le raisonnement
  // dans les jetons de sortie (marqueur explicite, ou total = entrée + sortie),
  // il n'est pas ajouté une seconde fois.
  const total = t.providerMeta?.totalTokens;
  if (thoughts !== null && (t.providerMeta?.outputIncludesThoughts === true
    || (typeof total === 'number' && total < t.inputTokens + t.outputTokens + thoughts))) thoughts = null;
  const modality = modalityUsageOf(t.providerMeta);
  let costMicros = t.costMicros;
  let exactMicros: number | null = null;
  let recomputed = false;
  let priced = false;
  let pricedModel: string | null = null;
  let pricingBasis: TracePricing['pricingBasis'] = null;
  let reasonCode: string | null = null;
  try {
    const demande = { provider: t.provider, inputTokens: t.inputTokens, outputTokens: t.outputTokens, thoughtsTokens: thoughts, ...(modality ? { modality } : {}) };
    let p = deps.priceCall({ ...demande, model: t.model });
    if (p.price !== null) { pricedModel = t.model; pricingBasis = 'requested_model'; }
    // Lot 113O : alias résolu par l'API — tarif EXACT du modèle servi.
    const servi = p.price === null ? servedModelOf(t.providerMeta, t.model) : null;
    if (servi) {
      const ps = deps.priceCall({ ...demande, model: servi });
      if (ps.price !== null) { p = ps; pricedModel = servi; pricingBasis = 'served_model'; }
    }
    priced = p.price !== null;
    const tokens = t.inputTokens + t.outputTokens + (thoughts ?? 0);
    if (priced && tokens > 0) {
      if (p.costMicros === null) {
        // Tarif connu, coût non calculable (consommation par modalité non mesurée…).
        costMicros = null; reasonCode = p.unknownCode ?? 'COST_NOT_COMPUTABLE';
      } else if (t.costMicros === null) {
        // La passerelle n'avait pas de coût (alias, tarif par modalité) : chiffré ici.
        costMicros = p.costMicros; exactMicros = p.exactMicros; recomputed = true;
      } else {
        exactMicros = p.exactMicros;
        if ((thoughts || modality || pricingBasis === 'served_model') && p.costMicros !== t.costMicros) { costMicros = p.costMicros; recomputed = true; }
      }
    }
  } catch { /* cache illisible : coût transmis conservé */ }
  // Un coût fourni par l'appelant sans tarif en cache (double de test, coût
  // déjà calculé ailleurs) reste « appliqué » s'il est positif.
  let status = pricingStatusOf({ status: t.status, inputTokens: t.inputTokens, outputTokens: t.outputTokens + (thoughts ?? 0), costMicros, priced: priced || (costMicros !== null && costMicros > 0) });
  // Tarif connu mais consommation par modalité manquante : « consommation non mesurée ».
  if (reasonCode && status === 'missing') status = 'insufficient_usage';
  return {
    costMicros, exactMicros, status,
    usage: { input: t.inputTokens, output: t.outputTokens, thoughts, thinkingCounted: thoughts === null ? false : priced && costMicros !== null },
    recomputed,
    pricedModel, pricingBasis, reasonCode,
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

/**
 * Appels non chiffrés d'un modèle : UNE alerte par modèle tant que la condition
 * dure (lot 113O, `pricing-supervision.ts` : résolue automatiquement quand le
 * tarif redevient applicable ou que les appels sont régularisés). Une tentative
 * par processus, modèle et jour. Ne lève jamais.
 */
export async function alertMissingPrice(provider: string, model: string, now: Date = new Date()): Promise<void> {
  const jour = now.toISOString().slice(0, 10);
  const k = `${provider}/${model}/${jour}`;
  if (alerted.has(k)) return;
  alerted.add(k);
  try {
    const { noteUnpricedCalls } = await import('../gateway/pricing/pricing-supervision');
    await noteUnpricedCalls(provider, model, now);
  } catch { /* alerte best effort */ }
}

/** Réservé aux tests. */
export function __resetTracePricingForTests(ready: boolean | null = null): void {
  pricingColumnsProbe.reset(ready);
  alerted.clear();
}
