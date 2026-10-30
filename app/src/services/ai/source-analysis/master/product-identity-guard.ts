/**
 * Garde-fou serveur sur l'IDENTITÉ PRODUIT des faits T1 — lot 101A (ticket
 * « série d'un équipement », points E, F, G). Fonction PURE, appliquée après
 * la projection et AVANT la persistance, quel que soit le prompt actif (le
 * modèle n'est pas une garantie : même règle avant et après le bloc
 * `t1-product-identity-v1` du guide du PO).
 *
 * Constat : une fiche Samsung rattachée au micro-onde (équipement 8) a
 * projeté sur lui MG23K3515AK (produit de la page) mais aussi MC32J7035AK
 * (produit recommandé, enregistré « certain ») et « Micro-Ondes Gril 23L »
 * comme `modelName`.
 *
 * Règles, pour les faits d'identité ciblés sur un objet (bien, équipement) :
 *   1. libellé GÉNÉRIQUE en série / modèle / référence → désignation
 *      commerciale (`productDesignation`), clé d'origine conservée en `rawKey` ;
 *   2. valeur d'une autre NATURE (prix, date, VIN, offre) → connaissance
 *      générique, jamais projetée sur l'objet ;
 *   3. page fournisseur dont le PRODUIT PRINCIPAL est connu (JSON-LD, titre,
 *      h1 — `web-link-source.adapter`) : un code d'un AUTRE produit est un
 *      produit CONNEXE — détaché de l'objet (cible GENERIC, sujet « Produit
 *      connexe »), conservé séparément, jamais rattaché ;
 *   4. plusieurs codes INCOMPATIBLES pour un même objet dans la même source,
 *      sans produit principal établi : tous passent en `conflictual` — jamais
 *      deux modèles différents « certains » sans conflit. Une variante
 *      d'écriture ou une valeur plus précise (MG23K3515** → MG23K3515AK) n'est
 *      pas un conflit.
 * Rien n'est perdu : valeur, preuve, provenance et clé d'origine restent.
 */
import {
  PRODUCT_CODE_KEYS, compareProductCodes, groupProductCodes, identityValueProblem, isProductIdentityKey,
  looksLikeGenericDesignation, normalizeProductCode, productCodesIn,
} from '@/services/canonical/product-identity';
import type { ProjectedFact } from './t1-contract';

/** Produit principal d'une page fournisseur (établi par l'adaptateur web, jamais par le modèle). */
export interface MainProductHint {
  /** Codes du produit principal (modèle, référence, SKU, MPN), normalisés. */
  codes: string[];
  name: string | null;
  brand: string | null;
}

export interface ProductIdentityGuardCounters {
  genericLabelsRekeyed: number;
  incompatibleValuesRequalified: number;
  secondaryProductsDetached: number;
  conflictsFlagged: number;
}

export interface ProductIdentityGuardResult {
  facts: ProjectedFact[];
  counters: ProductIdentityGuardCounters;
  /** Avertissements (codes existants), un par règle appliquée. */
  warnings: Array<{ code: 'FACT_REQUALIFIED_GENERIC' | 'FACT_REJECTED_BY_RULE'; message: string; target?: string }>;
}

const cibleObjet = (f: ProjectedFact) => (f.target.targetType === 'EQUIPMENT' || f.target.targetType === 'ASSET') && f.target.targetEntityId != null;
const cleCible = (f: ProjectedFact) => `${f.target.targetType}:${f.target.targetEntityId}`;
const valeur = (f: ProjectedFact) => (f.value === null || f.value === undefined ? '' : String(f.value));

/** Fait détaché de son objet : connaissance générique conservée, jamais projetée. */
function detacher(f: ProjectedFact, subject: string, ruleCode: string): ProjectedFact {
  return {
    ...f,
    rawKey: f.rawKey ?? f.canonicalKey,
    canonicalKey: null,
    subject,
    attribute: f.attribute ?? f.label ?? f.canonicalKey,
    target: { ...f.target, targetType: 'GENERIC', targetEntityId: null },
    ruleCode,
  };
}

export function guardProductIdentity(
  facts: readonly ProjectedFact[],
  opts: { mainProduct?: MainProductHint | null } = {},
): ProductIdentityGuardResult {
  const counters: ProductIdentityGuardCounters = { genericLabelsRekeyed: 0, incompatibleValuesRequalified: 0, secondaryProductsDetached: 0, conflictsFlagged: 0 };
  const warnings: ProductIdentityGuardResult['warnings'] = [];
  const principal = (opts.mainProduct?.codes ?? []).map(normalizeProductCode).filter(Boolean);

  // 1 à 3 : fait par fait.
  const out = facts.map((f): ProjectedFact => {
    if (!cibleObjet(f) || !isProductIdentityKey(f.canonicalKey)) return f;
    const key = f.canonicalKey;
    const v = valeur(f);
    if (!v) return f;
    const pb = identityValueProblem(key, v);
    if (pb && pb !== 'GENERIC_LABEL') {
      counters.incompatibleValuesRequalified += 1;
      warnings.push({ code: 'FACT_REQUALIFIED_GENERIC', message: `Valeur incompatible avec ${key} (${pb}) : connaissance générique.`, target: cleCible(f) });
      return detacher(f, f.subject ?? 'Valeur incompatible', 'PRODUCT_VALUE_INCOMPATIBLE');
    }
    if (PRODUCT_CODE_KEYS.has(key) && looksLikeGenericDesignation(v)) {
      counters.genericLabelsRekeyed += 1;
      warnings.push({ code: 'FACT_REQUALIFIED_GENERIC', message: `Libellé générique lu comme ${key} : classé en désignation commerciale (productDesignation).`, target: cleCible(f) });
      return { ...f, rawKey: f.rawKey ?? key, canonicalKey: 'productDesignation', ruleCode: 'PRODUCT_GENERIC_LABEL_TO_DESIGNATION' };
    }
    if (principal.length && PRODUCT_CODE_KEYS.has(key)) {
      const codes = productCodesIn(v);
      const duPrincipal = codes.length === 0 || codes.some((c) => principal.some((p) => compareProductCodes(p, c) !== 'INCOMPATIBLE'));
      if (!duPrincipal) {
        counters.secondaryProductsDetached += 1;
        warnings.push({ code: 'FACT_REJECTED_BY_RULE', message: `${key} d'un produit connexe de la page (autre que le produit principal) : non rattaché à l'objet.`, target: cleCible(f) });
        return detacher(f, 'Produit connexe de la page', 'PRODUCT_SECONDARY_ON_PAGE');
      }
    }
    return f;
  });

  // 4 : codes incompatibles d'un même objet dans la même source → conflit.
  const parObjet = new Map<string, number[]>();
  out.forEach((f, i) => {
    if (!cibleObjet(f) || !f.canonicalKey || !PRODUCT_CODE_KEYS.has(f.canonicalKey) || f.canonicalKey === 'productSeries') return;
    const k = cleCible(f);
    parObjet.set(k, [...(parObjet.get(k) ?? []), i]);
  });
  for (const [k, idx] of parObjet) {
    const valeurs = idx.map((i) => productCodesIn(valeur(out[i]))[0] ?? normalizeProductCode(valeur(out[i])));
    const groupes = groupProductCodes(valeurs);
    if (groupes.length <= 1) continue;
    for (const i of idx) {
      if (out[i].confidence === 'conflictual') continue;
      out[i] = { ...out[i], confidence: 'conflictual', ruleCode: out[i].ruleCode ?? 'PRODUCT_MODEL_CONFLICT' };
      counters.conflictsFlagged += 1;
    }
    warnings.push({ code: 'FACT_REJECTED_BY_RULE', message: `${groupes.length} modèles incompatibles pour le même objet dans la source : conflit, aucune valeur certaine.`, target: k });
  }
  return { facts: out, counters, warnings };
}
