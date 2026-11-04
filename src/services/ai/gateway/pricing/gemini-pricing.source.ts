/**
 * Relevé des tarifs Gemini depuis la grille du compte Google.
 *
 * S'appuie sur l'API Cloud Billing Catalog, qui expose les SKU et leurs tarifs
 * par palier pour un service donné. C'est la même grille que celle facturée au
 * compte : elle reflète donc le niveau payant exigé par le CDC §29.5, y compris
 * les tarifs négociés.
 *
 * ⚠️ POINT DE VALIDATION UNIQUE, À FAIRE UNE FOIS EN RECETTE
 * La correspondance entre un nom de modèle (`gemini-3.1-flash-lite`) et le
 * libellé de SKU côté Google n'est pas normalisée et évolue avec les
 * générations de modèles. `SKU_PATTERNS` ci-dessous encode cette correspondance
 * et doit être confrontée une fois à la sortie réelle de l'API. Tout modèle non
 * apparié est remonté dans `models_missing` du journal de rafraîchissement, et
 * devra être saisi manuellement en administration — jamais deviné.
 */
/*
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 109L (ticket P1 « Tarifs Gemini non reconnus », point B) — SOURCE
 * DÉSACTIVÉE PAR DÉFAUT
 *
 * L'audit du 04/11/2026 n'a pas démontré que ce chemin représente la facture
 * Gemini Developer API : l'API Cloud Billing Catalog (`services.skus`) publie
 * des prix de LISTE (pas les remises du compte), le rapprochement SKU ↔ modèle
 * est fait par expressions régulières (`3.5 flash` capturait aussi
 * `3.5 flash-lite`), le palier retenu était le DERNIER (`tieredRates.at(-1)`,
 * possiblement « > 200k ») et l'unité n'était pas contrôlée. Ses tarifs
 * étaient pourtant écrits `verified = true`, donc prioritaires.
 *
 * Elle n'est plus lue que si `AI_PRICING_BILLING_SOURCE=validated` est posé,
 * après validation EXPLICITE (même API, même mode de facturation, remises) —
 * jamais Vertex AI. Unité contrôlée (`baseUnit` en jetons), premier palier,
 * motifs exacts ; tout écart → modèle omis (jamais un montant deviné).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { PricingSource, ModelPrice } from './pricing-source.port';

const CATALOG_API = 'https://cloudbilling.googleapis.com/v1';
/** Identifiant du service « Generative Language API » au catalogue Google. */
const GENERATIVE_LANGUAGE_SERVICE = process.env.GOOGLE_BILLING_SERVICE_ID ?? '';

interface CatalogSku {
  name: string;
  skuId: string;
  description: string;
  pricingInfo?: Array<{
    pricingExpression?: {
      baseUnit?: string;
      tieredRates?: Array<{
        unitPrice?: { currencyCode?: string; units?: string; nanos?: number };
      }>;
    };
  }>;
}

/** Motifs de reconnaissance d'un SKU, par modèle et par sens (entrée/sortie). */
const SKU_PATTERNS: Array<{ model: string; input: RegExp; output: RegExp }> = [
  { model: 'gemini-2.5-flash-lite', input: /2\.5\s*flash[\s-]?lite\b.*input/i,  output: /2\.5\s*flash[\s-]?lite\b.*output/i },
  { model: 'gemini-2.5-flash',      input: /2\.5\s*flash(?![\s-]*lite).*input/i,  output: /2\.5\s*flash(?![\s-]*lite).*output/i },
  { model: 'gemini-2.5-pro',        input: /2\.5\s*pro\b.*input/i,                 output: /2\.5\s*pro\b.*output/i },
  { model: 'gemini-3.1-flash-lite', input: /3\.1\s*flash[\s-]?lite\b.*input/i,  output: /3\.1\s*flash[\s-]?lite\b.*output/i },
  // Lot 109L : `(?![\s-]*lite)` — « 3.5 Flash-Lite » n'est plus pris pour « 3.5 Flash ».
  { model: 'gemini-3.5-flash',      input: /3\.5\s*flash(?![\s-]*lite).*input/i,   output: /3\.5\s*flash(?![\s-]*lite).*output/i },
];

/** Lot 109L : source lue seulement après validation explicite (voir l'en-tête). */
export function billingSourceValidated(env: Record<string, string | undefined> = process.env): boolean {
  return env.AI_PRICING_BILLING_SOURCE === 'validated';
}

export class GeminiPricingSource implements PricingSource {
  readonly provider = 'gemini';
  readonly name = 'google-cloud-billing-catalog';

  isConfigured(): boolean {
    return billingSourceValidated() && Boolean(process.env.GOOGLE_BILLING_API_KEY && GENERATIVE_LANGUAGE_SERVICE);
  }

  async fetchPrices(models: string[]): Promise<ModelPrice[]> {
    if (!this.isConfigured()) {
      throw new Error(
        '[pricing] GOOGLE_BILLING_API_KEY ou GOOGLE_BILLING_SERVICE_ID absente — ' +
        'les tarifs doivent alors être saisis en administration.',
      );
    }

    const skus = await this.listAllSkus();
    const prices: ModelPrice[] = [];

    for (const { model, input, output } of SKU_PATTERNS) {
      if (!models.includes(model)) continue;

      const inputSkus = skus.filter((s) => input.test(s.description));
      const outputSkus = skus.filter((s) => output.test(s.description));
      // Lot 109L : un seul SKU par sens, sinon ambigu (Batch, long contexte…) — omis.
      if (inputSkus.length !== 1 || outputSkus.length !== 1) continue;  // remonté comme manquant par le lot
      const [inputSku] = inputSkus;
      const [outputSku] = outputSkus;

      const inputPrice = extractMicrosPerToken(inputSku);
      const outputPrice = extractMicrosPerToken(outputSku);
      if (inputPrice === null || outputPrice === null) continue;

      prices.push({
        provider: this.provider,
        model,
        inputMicros: inputPrice.micros,
        outputMicros: outputPrice.micros,
        currency: inputPrice.currency,
        sourceReference: `${inputSku.skuId}|${outputSku.skuId}`,
      });
    }

    return prices;
  }

  private async listAllSkus(): Promise<CatalogSku[]> {
    const key = process.env.GOOGLE_BILLING_API_KEY!;
    const all: CatalogSku[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${CATALOG_API}/services/${GENERATIVE_LANGUAGE_SERVICE}/skus`);
      url.searchParams.set('key', key);
      url.searchParams.set('pageSize', '200');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`[pricing] Catalogue Google : HTTP ${res.status}`);

      const json = (await res.json()) as { skus?: CatalogSku[]; nextPageToken?: string };
      all.push(...(json.skus ?? []));
      pageToken = json.nextPageToken;
    } while (pageToken);

    return all;
  }
}

/**
 * Convertit un tarif de SKU en micro-unités par token.
 *
 * Google exprime ces tarifs par million de tokens (`baseUnit` en tokens, prix
 * pour 1 000 000). La division est faite ici, une fois, plutôt que dispersée
 * dans le calcul de coût.
 */
function extractMicrosPerToken(sku: CatalogSku): { micros: number; currency: string } | null {
  const expr = sku.pricingInfo?.[0]?.pricingExpression;
  // Lot 109L : un seul palier (jamais le dernier par défaut) et unité contrôlée.
  if (!expr?.tieredRates || expr.tieredRates.length !== 1) return null;
  if (!/token/i.test(expr.baseUnit ?? '')) return null;
  const rate = expr.tieredRates[0]?.unitPrice;
  if (!rate) return null;

  const units = Number(rate.units ?? 0);
  const nanos = Number(rate.nanos ?? 0);
  const perMillionTokens = units + nanos / 1e9;

  return {
    micros: (perMillionTokens * 1_000_000) / 1_000_000,
    currency: rate.currencyCode ?? 'USD',
  };
}
