/**
 * Catalogue de prix des modèles — CDC assistant §15.9, refonte §5.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES TARIFS VIENNENT DE LA GRILLE OFFICIELLE, PLUS D'UNE CONSTANTE
 *
 * Ce fichier portait deux tarifs codés en dur, dont un avec la mention
 * « TODO : revérifier au catalogue Gemini avant prod ». Un prix inventé ne se
 * signale jamais : il produit des coûts plausibles et faux.
 *
 * Le lot de tarification a construit `ai_model_pricing`, alimentée depuis le
 * catalogue public, datée et contrôlée chaque semaine. C'est elle qui fait foi.
 *
 * ── UN TARIF ABSENT N'EST PAS UN TARIF NUL ────────────────────────────────
 *
 * L'ancienne estimation rendait `0` quand le modèle était inconnu. Un appel
 * gratuit, en somme — et un quota qui ne se décrémente pas.
 *
 * `estimateCostMicros` rend désormais `null` dans ce cas. L'appelant doit
 * décider quoi en faire, et ne peut plus confondre « gratuit » avec
 * « inconnu ».
 *
 * ── POURQUOI GARDER DES VALEURS DE SECOURS ────────────────────────────────
 *
 * Le cache de tarifs se charge au démarrage et peut être vide — migration non
 * appliquée, base injoignable. Sans repli, l'assistant cesserait d'estimer ses
 * coûts. Les valeurs de secours sont donc conservées, mais MARQUÉES comme
 * telles : `origin: 'fallback'` distingue une estimation fiable d'une
 * approximation.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getCachedPrice } from '@/services/ai/gateway/pricing/pricing.repository';

export const PRICING_CATALOG_VERSION = 'pricing-catalog-v2.0' as const;

export interface ModelPrice {
  modelId: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  effectiveFrom: string;
}

/**
 * Valeurs de secours, employées uniquement si la grille officielle est
 * indisponible. Elles ne doivent jamais être la source normale.
 *
 * Le modèle `gemini-3.1-flash-lite` en a été RETIRÉ : son tarif portait la
 * mention « à revérifier » et n'a jamais été confirmé. Mieux vaut aucune
 * estimation qu'une estimation inventée.
 */
const SECOURS: Record<string, ModelPrice> = {
  'gemini-2.5-flash-lite': {
    modelId: 'gemini-2.5-flash-lite',
    inputPerMTokUsd: 0.10,
    outputPerMTokUsd: 0.40,
    effectiveFrom: '2026-07-16',
  },
};

export type PriceOrigin = 'official' | 'fallback' | 'unknown';

export interface CostEstimate {
  /** Coût en micro-USD, ou `null` si aucun tarif n'est connu. */
  micros: number | null;
  origin: PriceOrigin;
  /** Vrai quand le tarif vient de la grille vérifiée. */
  reliable: boolean;
}

/**
 * Estime le coût d'un appel.
 *
 * @param provider fournisseur déclaré au registre — `google` pour Gemini.
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  provider = 'google',
): CostEstimate {
  const officiel = getCachedPrice(provider, modelId);

  if (officiel) {
    // ⚠️ DEUX UNITÉS DIFFÉRENTES, À NE PAS CONFONDRE.
    //
    // La grille officielle exprime `inputMicros` en micro-unités de devise
    // PAR TOKEN. Les valeurs de secours, héritées du catalogue public,
    // s'expriment en dollars PAR MILLION de tokens.
    //
    // Appliquer une formule à l'autre décalerait le coût d'un facteur d'un
    // million — assez pour rendre un appel gratuit ou ruineux sans que rien
    // ne paraisse anormal.
    return {
      micros: Math.round(
        inputTokens * officiel.inputMicros + outputTokens * officiel.outputMicros,
      ),
      origin: 'official',
      // Un tarif non vérifié reste utilisable, mais l'appelant doit le savoir.
      reliable: officiel.verified,
    };
  }

  const secours = SECOURS[modelId];
  if (secours) {
    // Dollars par million de tokens → micro-dollars : les deux facteurs
    // 10⁻⁶ et 10⁶ s'annulent, d'où la forme directe.
    const micros =
      inputTokens * secours.inputPerMTokUsd + outputTokens * secours.outputPerMTokUsd;
    return { micros: Math.round(micros), origin: 'fallback', reliable: false };
  }

  // Ni grille, ni secours : on ne prétend pas connaître le coût.
  return { micros: null, origin: 'unknown', reliable: false };
}

/**
 * Estimation en micro-USD.
 *
 * ⚠️ Rend `null` quand le tarif est inconnu, là où l'ancienne version rendait
 * `0`. Un appel dont le coût est inconnu n'est pas un appel gratuit : le
 * confondre laisse les quotas intacts et les dépenses invisibles.
 */
export function estimateCostMicros(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  return estimateCost(modelId, inputTokens, outputTokens).micros;
}
