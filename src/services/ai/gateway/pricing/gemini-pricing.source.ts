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
  { model: 'gemini-2.5-flash-lite', input: /2\.5\s*flash[\s-]?lite.*input/i,  output: /2\.5\s*flash[\s-]?lite.*output/i },
  { model: 'gemini-2.5-flash',      input: /2\.5\s*flash(?!\s*-?lite).*input/i,  output: /2\.5\s*flash(?!\s*-?lite).*output/i },
  { model: 'gemini-2.5-pro',        input: /2\.5\s*pro.*input/i,                 output: /2\.5\s*pro.*output/i },
  { model: 'gemini-3.1-flash-lite', input: /3\.1\s*flash[\s-]?lite.*input/i,  output: /3\.1\s*flash[\s-]?lite.*output/i },
  { model: 'gemini-3.5-flash',      input: /3\.5\s*flash.*input/i,               output: /3\.5\s*flash.*output/i },
];

export class GeminiPricingSource implements PricingSource {
  readonly provider = 'gemini';
  readonly name = 'google-cloud-billing-catalog';

  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_BILLING_API_KEY && GENERATIVE_LANGUAGE_SERVICE);
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

      const inputSku = skus.find((s) => input.test(s.description));
      const outputSku = skus.find((s) => output.test(s.description));
      if (!inputSku || !outputSku) continue;  // remonté comme manquant par le lot

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
  const rate = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.at(-1)?.unitPrice;
  if (!rate) return null;

  const units = Number(rate.units ?? 0);
  const nanos = Number(rate.nanos ?? 0);
  const perMillionTokens = units + nanos / 1e9;

  return {
    micros: (perMillionTokens * 1_000_000) / 1_000_000,
    currency: rate.currencyCode ?? 'USD',
  };
}
